// Rooms on the site: who owns them, who's in them, and what's waiting in their queue.
// Stored in data/hub/rooms.json. Passwords are scrypt-hashed; owner and host keys are SHA-256 hashed
// (they're long random strings, so a fast hash is enough). The invite code is kept as-is so the
// owner can copy the invite link again later.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

function randomId(n = 10) {
  const bytes = crypto.randomBytes(n);
  return [...bytes].map((b) => ID_ALPHABET[b % ID_ALPHABET.length]).join('');
}
export const newKey = () => crypto.randomBytes(24).toString('base64url');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.scryptSync(String(pw), salt, 32).toString('hex') };
}
function checkPassword(stored, pw) {
  if (!stored) return false;
  const got = crypto.scryptSync(String(pw ?? ''), stored.salt, 32);
  return crypto.timingSafeEqual(got, Buffer.from(stored.hash, 'hex'));
}
function sameHash(hash, value) {
  if (!hash || typeof value !== 'string' || !value) return false;
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(sha(value), 'hex'));
}

export function cleanName(n) {
  return String(n ?? '')
    .replace(/[\[\]\n\r\t<>]/g, '')
    .trim()
    .slice(0, 32);
}
export function cleanRepo(r) {
  const s = String(r ?? '')
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
  if (!s) return '';
  if (!/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(s)) throw new Error('GitHub repo should look like owner/name.');
  return s;
}

export const MIN_PASSWORD = 6;
function checkNewPassword(pw, what) {
  if (String(pw ?? '').length < MIN_PASSWORD) throw new Error(`The ${what} needs at least ${MIN_PASSWORD} characters.`);
}

export class RoomStore {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'rooms.json');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.rooms = new Map();
    if (fs.existsSync(this.file)) {
      for (const r of JSON.parse(fs.readFileSync(this.file, 'utf8')).rooms || []) this.rooms.set(r.id, r);
    }
  }

  save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, rooms: [...this.rooms.values()] }, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  get(id) {
    return typeof id === 'string' ? this.rooms.get(id) || null : null;
  }

  get size() {
    return this.rooms.size;
  }

  /** Make a room. Returns the secrets, which are only ever shown this once (apart from the invite). */
  create({ name, repo, ownerName, ownerPassword, roomPassword, legacy = false }) {
    name = String(name ?? '').trim().slice(0, 80);
    if (!name) throw new Error('Give the room a name.');
    repo = cleanRepo(repo);
    ownerName = cleanName(ownerName);
    if (!legacy) {
      // A room carried over from the old one-room setup keeps its password and gets an owner password on first visit.
      if (!ownerName) throw new Error('Pick a name so friends know who you are.');
      checkNewPassword(ownerPassword, 'owner password');
      checkNewPassword(roomPassword, 'room password');
    } else if (!roomPassword) throw new Error('The room needs a password.');
    if (ownerPassword && ownerPassword === roomPassword) throw new Error('Use a different password for yourself than the one you give friends.');

    let id;
    do id = randomId(); while (this.rooms.has(id));
    const ownerKey = newKey();
    const hostKey = newKey();
    const room = {
      id,
      name,
      repo,
      createdAt: new Date().toISOString(),
      legacy: legacy || undefined,
      ownerKeyHash: sha(ownerKey),
      ownerPassword: ownerPassword ? hashPassword(ownerPassword) : null,
      roomPassword: hashPassword(roomPassword),
      invite: newKey(),
      hostKeyHash: sha(hostKey),
      settings: { locked: false, ownerApprovals: false },
      members: [],
      queue: [],
      index: { version: 1, sessions: [] },
      host: null, // last host seen: { backend, approvalMode, lastSeen }
    };
    this.rooms.set(id, room);
    let owner = null;
    if (ownerName) owner = this.addMember(room, { name: ownerName, role: 'owner' });
    else this.save();
    return { room, ownerKey, hostKey, owner };
  }

  delete(id) {
    const ok = this.rooms.delete(id);
    if (ok) {
      this.save();
      fs.rmSync(this.cacheDir(id), { recursive: true, force: true });
    }
    return ok;
  }

  cacheDir(id) {
    return path.join(this.dir, 'cache', id);
  }

  // --- who may come in -------------------------------------------------------

  checkInvite(room, invite) {
    return typeof invite === 'string' && invite.length === room.invite.length && crypto.timingSafeEqual(Buffer.from(invite), Buffer.from(room.invite));
  }
  checkRoomPassword(room, pw) {
    return checkPassword(room.roomPassword, pw);
  }
  checkOwnerKey(room, key) {
    return sameHash(room.ownerKeyHash, key);
  }
  checkOwnerPassword(room, pw) {
    return checkPassword(room.ownerPassword, pw);
  }
  checkHostKey(room, key) {
    return sameHash(room.hostKeyHash, key);
  }

  // --- members ---------------------------------------------------------------

  member(room, memberId) {
    return room.members.find((m) => m.id === memberId) || null;
  }

  /**
   * Owners and members each keep one record per name, so rejoining from another browser
   * doesn't pile up duplicates. A member can't take a name the owner uses.
   */
  addMember(room, { name, role }) {
    name = cleanName(name);
    if (!name) throw new Error('Pick a name so friends know who is talking.');
    const same = room.members.filter((m) => m.name.toLowerCase() === name.toLowerCase());
    if (role === 'member' && same.some((m) => m.role === 'owner')) throw new Error('That name belongs to the room owner. Pick another.');
    let m = same.find((x) => x.role === role);
    if (!m) {
      m = { id: randomId(12), name, role, joinedAt: new Date().toISOString() };
      room.members.push(m);
    }
    m.lastSeen = new Date().toISOString();
    this.save();
    return m;
  }

  kick(room, memberId) {
    const m = this.member(room, memberId);
    if (!m) throw new Error('That person already left.');
    if (m.role === 'owner') throw new Error("Owners can't be kicked.");
    room.members = room.members.filter((x) => x.id !== memberId);
    room.queue = room.queue.filter((j) => j.memberId !== memberId);
    this.save();
    return m;
  }

  // --- owner controls --------------------------------------------------------

  rename(room, name) {
    name = String(name ?? '').trim().slice(0, 80);
    if (!name) throw new Error('Give the room a name.');
    room.name = name;
    this.save();
  }
  setRepo(room, repo) {
    room.repo = cleanRepo(repo);
    this.save();
  }
  setSettings(room, { locked, ownerApprovals }) {
    if (typeof locked === 'boolean') room.settings.locked = locked;
    if (typeof ownerApprovals === 'boolean') room.settings.ownerApprovals = ownerApprovals;
    this.save();
  }
  setRoomPassword(room, pw) {
    checkNewPassword(pw, 'room password');
    if (this.checkOwnerPassword(room, pw)) throw new Error('Use a different password for friends than your owner password.');
    room.roomPassword = hashPassword(pw);
    this.save();
  }
  setOwnerPassword(room, pw) {
    checkNewPassword(pw, 'owner password');
    if (this.checkRoomPassword(room, pw)) throw new Error('Use a different password for yourself than the one you give friends.');
    room.ownerPassword = hashPassword(pw);
    this.save();
  }
  resetInvite(room) {
    room.invite = newKey();
    this.save();
    return room.invite;
  }
  resetOwnerKey(room) {
    const key = newKey();
    room.ownerKeyHash = sha(key);
    this.save();
    return key;
  }
  resetHostKey(room) {
    const key = newKey();
    room.hostKeyHash = sha(key);
    this.save();
    return key;
  }
}
