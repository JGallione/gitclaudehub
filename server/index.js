// The gitclaudehub site. Anyone can create a room for their own GitHub project. The room's AI runs
// on its owner's computer: `gitclaudehub host` connects out to this site over a WebSocket and
// runs the turns there. This site keeps the rooms, the queue and who's in them, and relays
// everything else. It never holds a GitHub token or an AI key.

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import { WebSocketServer } from 'ws';
import { config, APP_ROOT } from './config.js';
import { RoomStore } from './rooms.js';
import { migrateLegacyRoom } from './legacy.js';

const PKG = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8'));
const VERSION = PKG.version;
// How room owners get the `gitclaudehub` command: from this app's own GitHub repo (package.json "repository").
const APP_REPO = String(PKG.repository?.url || PKG.repository || '').match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/)?.[1];
const INSTALL = APP_REPO ? `npm install -g github:${APP_REPO}` : null;
const store = new RoomStore(config.hubDir);
const now = () => new Date().toISOString();
const clip = (s, n) => String(s ?? '').slice(0, n);

function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function sign(value) {
  return crypto.createHmac('sha256', config.cookieSecret).update(value).digest('base64url');
}
function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// ---------------------------------------------------------------------------
// Live state per room (not saved): who's watching, the connected host, the running turn.
// ---------------------------------------------------------------------------

const live = new Map();
function L(roomId) {
  let l = live.get(roomId);
  if (!l) {
    l = { viewers: new Map(), host: null, current: null, permissions: new Map(), rpc: new Map() };
    live.set(roomId, l);
  }
  return l;
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function broadcast(roomId, event, data) {
  for (const v of L(roomId).viewers.values()) sse(v.res, event, data);
}
function presence(roomId) {
  return [...new Set([...L(roomId).viewers.values()].map((v) => v.name))].sort();
}

function publicJob(j) {
  return { id: j.id, sessionId: j.sessionId, liveSessionId: j.liveSessionId, author: j.author, prompt: j.prompt, queuedAt: j.queuedAt, startedAt: j.startedAt, phase: j.phase };
}
function runnerState(room) {
  const l = L(room.id);
  return { current: l.current && publicJob(l.current), queue: room.queue.map(publicJob), permissions: [...l.permissions.values()] };
}
function hostState(room) {
  const h = L(room.id).host;
  if (h?.ready) return { online: true, backend: h.backend, approvalMode: h.approvalMode, branch: h.branch, preview: h.preview, since: h.since };
  return { online: false, connecting: !!h, backend: room.host?.backend || null, lastSeen: room.host?.lastSeen || null };
}
function roomInfo(room) {
  return { id: room.id, name: room.name, repo: room.repo, webUrl: room.repo ? `https://github.com/${room.repo}` : null, settings: room.settings };
}
const broadcastQueue = (room) => broadcast(room.id, 'queue', runnerState(room));
const broadcastHost = (room) => broadcast(room.id, 'host', hostState(room));

function hostSend(room, msg) {
  const h = L(room.id).host;
  if (h?.ws.readyState !== 1) return false;
  h.ws.send(JSON.stringify(msg));
  return true;
}

/** Hand the next queued job to the host, if it's connected and idle. */
function drain(room) {
  const l = L(room.id);
  if (!l.host?.ready || l.current || !room.queue.length) return;
  const job = room.queue.shift();
  store.save();
  l.current = { ...job, phase: 'starting', liveSessionId: job.sessionId };
  hostSend(room, { type: 'job', job: { id: job.id, sessionId: job.sessionId, author: job.author, prompt: job.prompt } });
  broadcastQueue(room);
}

function endCurrent(room, message) {
  const l = L(room.id);
  if (!l.current) return;
  if (message) broadcast(room.id, 'turn_error', { jobId: l.current.id, sessionId: l.current.liveSessionId || l.current.sessionId, message });
  for (const id of l.permissions.keys()) broadcast(room.id, 'permission_resolved', { id, allow: false, by: 'gitclaudehub' });
  l.permissions.clear();
  l.current = null;
  broadcastQueue(room);
}

/** Ask the room's host for something only it has (files, transcripts, the preview). */
function rpc(room, method, params = {}, timeoutMs = 20_000) {
  const l = L(room.id);
  if (!l.host?.ready) return Promise.reject(httpError(503, "The room owner's computer is offline right now."));
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      l.rpc.delete(id);
      reject(httpError(504, "The room owner's computer didn't answer in time."));
    }, timeoutMs);
    l.rpc.set(id, { resolve, reject, timer });
    hostSend(room, { type: 'rpc', id, method, params });
  });
}

// Conversations are cached here so a room's history still opens while its owner's computer is off.
function cacheFile(roomId, sid) {
  return path.join(store.cacheDir(roomId), 'sessions', `${sid}.json`);
}
function writeCache(roomId, sid, data) {
  try {
    fs.mkdirSync(path.dirname(cacheFile(roomId, sid)), { recursive: true });
    fs.writeFileSync(cacheFile(roomId, sid), JSON.stringify(data));
  } catch (err) {
    console.warn(`[gitclaudehub] couldn't cache a conversation: ${err.message}`);
  }
}
function readCache(roomId, sid) {
  try {
    return JSON.parse(fs.readFileSync(cacheFile(roomId, sid), 'utf8'));
  } catch {
    return null;
  }
}

function deleteRoom(room) {
  const l = L(room.id);
  for (const v of l.viewers.values()) {
    sse(v.res, 'room_deleted', {});
    v.res.end();
  }
  if (l.host) {
    hostSend(room, { type: 'deleted' });
    l.host.ws.close(4404, 'The owner deleted this room.');
  }
  for (const p of l.rpc.values()) {
    clearTimeout(p.timer);
    p.reject(httpError(410, 'This room was deleted.'));
  }
  live.delete(room.id);
  store.delete(room.id);
  console.log(`[gitclaudehub] Room ${room.id} (“${room.name}”) was deleted by its owner.`);
}

// ---------------------------------------------------------------------------
// Cookies and limits
// ---------------------------------------------------------------------------

const cookieName = (roomId) => `gch_${roomId}`;

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

/** A member cookie is `<memberId>.<signature>`. Kicking someone deletes their member record, which voids it. */
function readMember(req, room) {
  const raw = cookies(req)[cookieName(room.id)];
  const [memberId, sig] = (raw || '').split('.');
  if (!memberId || !sig || !safeEqual(sig, sign(`${room.id}.${memberId}`))) return null;
  return store.member(room, memberId);
}
function setMemberCookie(req, res, room, member) {
  const value = `${member.id}.${sign(`${room.id}.${member.id}`)}`;
  res.append('Set-Cookie', `${cookieName(room.id)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 90}${req.secure ? '; Secure' : ''}`);
}
function clearMemberCookie(res, roomId) {
  res.append('Set-Cookie', `${cookieName(roomId)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

const attempts = new Map();
function limited(key, max, windowMs) {
  const t = Date.now();
  const list = (attempts.get(key) || []).filter((x) => t - x < windowMs);
  attempts.set(key, list);
  return list.length >= max;
}
function hit(key) {
  if (!attempts.has(key)) attempts.set(key, []);
  attempts.get(key).push(Date.now());
}
setInterval(() => {
  const t = Date.now();
  for (const [k, list] of attempts) if (!list.some((x) => t - x < 3600_000)) attempts.delete(k);
}, 600_000).unref();

// ---------------------------------------------------------------------------
// The web app
// ---------------------------------------------------------------------------

const app = express();
app.set('trust proxy', 'loopback');
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

// Block cross-site form/fetch posts: every write must be same-origin JSON.
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const origin = req.get('origin');
  let sameOrigin = true;
  if (origin) {
    try {
      sameOrigin = new URL(origin).host === (req.get('x-forwarded-host') || req.get('host'));
    } catch {
      sameOrigin = false;
    }
  }
  if (!sameOrigin || !req.is('application/json')) return res.status(403).json({ error: 'Cross-site request blocked' });
  next();
});

app.get('/api/hub', (req, res) => res.json({ createNeedsCode: !!config.createRoomCode, version: VERSION, install: INSTALL }));

/** The rooms this browser is in (one cookie per room). */
app.get('/api/my-rooms', (req, res) => {
  const rooms = [];
  for (const name of Object.keys(cookies(req))) {
    const room = name.startsWith('gch_') && store.get(name.slice(4));
    const m = room && readMember(req, room);
    if (m) rooms.push({ ...roomInfo(room), role: m.role, me: m.name, hostOnline: hostState(room).online, sessions: room.index.sessions.length });
  }
  res.json({ rooms });
});

app.post('/api/rooms', (req, res) => {
  const b = req.body || {};
  if (limited(`create:${req.ip}`, 5, 3600_000)) return res.status(429).json({ error: "You've made several rooms in the last hour. Try again later." });
  if (config.createRoomCode) {
    if (limited(`create-code:${req.ip}`, 10, 600_000)) return res.status(429).json({ error: 'Too many wrong codes. Try again in a few minutes.' });
    if (!safeEqual(b.code, config.createRoomCode)) {
      hit(`create-code:${req.ip}`);
      return res.status(403).json({ error: 'That room-creation code is wrong. Ask whoever runs this site for it.' });
    }
  }
  if (store.size >= config.maxRooms) return res.status(403).json({ error: 'This site has as many rooms as it can hold. Ask whoever runs it to make space.' });
  try {
    const { room, ownerKey, hostKey, owner } = store.create({ name: b.name, repo: b.repo, ownerName: b.yourName, ownerPassword: b.ownerPassword, roomPassword: b.roomPassword });
    hit(`create:${req.ip}`);
    setMemberCookie(req, res, room, owner);
    console.log(`[gitclaudehub] ${owner.name} created room ${room.id} (“${room.name}”).`);
    res.json({ id: room.id, ownerKey, hostKey, invite: room.invite });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// One room
// ---------------------------------------------------------------------------

const roomApi = express.Router({ mergeParams: true });

roomApi.use((req, res, next) => {
  const room = store.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: "This room doesn't exist. Its owner may have deleted it." });
  req.room = room;
  req.member = readMember(req, room);
  next();
});

/** What the join and owner screens need. The room's name is only shown to someone with a valid link. */
roomApi.post('/intro', (req, res) => {
  const { room, member } = req;
  if (limited(`intro:${req.ip}`, 60, 600_000)) return res.status(429).json({ error: 'Too many tries. Wait a few minutes.' });
  const inviteOk = store.checkInvite(room, req.body?.invite);
  const ownerKeyOk = store.checkOwnerKey(room, req.body?.ownerKey);
  if (!inviteOk && !ownerKeyOk) hit(`intro:${req.ip}`);
  const known = member || inviteOk || ownerKeyOk;
  res.json({
    name: known ? room.name : null,
    repo: known ? room.repo : null,
    member: member && { name: member.name, role: member.role },
    inviteOk,
    ownerKeyOk,
    ownerHasPassword: ownerKeyOk ? !!room.ownerPassword : undefined,
  });
});

roomApi.post('/join', (req, res) => {
  const { room } = req;
  const key = `join:${req.ip}:${room.id}`;
  if (limited(key, 10, 600_000)) return res.status(429).json({ error: 'Too many wrong passwords. Try again in a few minutes.' });
  if (!store.checkInvite(room, req.body?.invite)) return res.status(403).json({ error: "This invite link isn't valid anymore. Ask the room owner for the current one." });
  if (!store.checkRoomPassword(room, req.body?.password)) {
    hit(key);
    return res.status(401).json({ error: 'That room password is wrong.' });
  }
  try {
    const m = store.addMember(room, { name: req.body?.name, role: 'member' });
    setMemberCookie(req, res, room, m);
    res.json({ name: m.name, role: m.role });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

roomApi.post('/owner', (req, res) => {
  const { room } = req;
  const b = req.body || {};
  const key = `owner:${req.ip}:${room.id}`;
  if (limited(key, 10, 600_000)) return res.status(429).json({ error: 'Too many wrong tries. Try again in a few minutes.' });
  if (!store.checkOwnerKey(room, b.ownerKey)) {
    hit(key);
    return res.status(403).json({ error: "This owner link isn't valid. If you reset it, use the newest one." });
  }
  try {
    if (!room.ownerPassword) store.setOwnerPassword(room, b.newPassword); // first visit to a room carried over from the old setup
    else if (!store.checkOwnerPassword(room, b.password)) {
      hit(key);
      return res.status(401).json({ error: 'That owner password is wrong.' });
    }
    const m = store.addMember(room, { name: b.name, role: 'owner' });
    setMemberCookie(req, res, room, m);
    res.json({ name: m.name, role: m.role });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

roomApi.post('/leave', (req, res) => {
  clearMemberCookie(res, req.room.id);
  res.json({ ok: true });
});

// Everything below needs a member cookie.
roomApi.use((req, res, next) => {
  if (!req.member) return res.status(401).json({ error: 'Join the room first.' });
  next();
});
const ownerOnly = (req, res, next) => (req.member.role === 'owner' ? next() : res.status(403).json({ error: 'Only the room owner can do that.' }));

// Previews of every room share one origin (on PREVIEW_PORT), separate from this app's.
// The cookie names one room at a time; resetting the invite link changes the key.
const PREVIEW_COOKIE = 'gch_preview';
const previewKey = (room) => sign(`preview:${room.id}:${room.invite}`);
function previewLink(req, room) {
  if (!hostState(room).preview) return null;
  const base = config.previewUrl || `${req.protocol}://${req.hostname}:${config.previewPort}`;
  return `${base}/?gch_room=${room.id}&gch_key=${previewKey(room)}`;
}

roomApi.get('/state', (req, res) => {
  const { room, member } = req;
  res.json({
    me: { id: member.id, name: member.name, role: member.role },
    room: roomInfo(room),
    host: hostState(room),
    index: room.index,
    runner: runnerState(room),
    online: presence(room.id),
    previewUrl: previewLink(req, room),
  });
});

roomApi.get('/sessions/:sid', async (req, res) => {
  const sid = req.params.sid;
  if (!/^[A-Za-z0-9-]{8,64}$/.test(sid)) return res.status(400).json({ error: 'Bad session id' });
  try {
    const data = await rpc(req.room, 'session', { id: sid }, 60_000);
    writeCache(req.room.id, sid, data);
    res.json(data);
  } catch (err) {
    const cached = err.status >= 500 && readCache(req.room.id, sid);
    if (cached) return res.json({ ...cached, stale: true });
    res.status(err.status || 400).json({ error: err.message });
  }
});

roomApi.post('/prompt', (req, res) => {
  const { room, member } = req;
  if (room.settings.locked && member.role !== 'owner') return res.status(403).json({ error: 'The owner has locked this room, so only they can send messages right now.' });
  const prompt = String(req.body?.prompt || '').trim();
  if (!prompt) return res.status(400).json({ error: 'Write something first.' });
  if (prompt.length > 20000) return res.status(400).json({ error: 'That message is too long.' });
  const sessionId = req.body?.sessionId || null;
  if (sessionId && !room.index.sessions.some((s) => s.id === sessionId)) return res.status(404).json({ error: 'That session is not shared in this repo.' });
  if (room.queue.length >= 20) return res.status(429).json({ error: 'The queue is full. Wait for a few turns to finish.' });
  const job = { id: crypto.randomUUID(), sessionId, author: member.name, memberId: member.id, prompt, queuedAt: now() };
  room.queue.push(job);
  store.save();
  broadcastQueue(room);
  drain(room);
  res.json({ jobId: job.id, hostOnline: hostState(room).online });
});

roomApi.post('/queue/:jobId/cancel', (req, res) => {
  const { room, member } = req;
  const job = room.queue.find((j) => j.id === req.params.jobId);
  if (!job) return res.json({ ok: false });
  if (job.memberId !== member.id && member.role !== 'owner') return res.status(403).json({ error: 'Only the person who sent it, or the owner, can cancel that.' });
  room.queue = room.queue.filter((j) => j !== job);
  store.save();
  broadcastQueue(room);
  res.json({ ok: true });
});

roomApi.post('/stop', (req, res) => {
  const { room, member } = req;
  if (!L(room.id).current) return res.json({ ok: false });
  const ok = hostSend(room, { type: 'interrupt', by: member.name });
  if (ok) broadcast(room.id, 'notice', { text: `${member.name} stopped the current turn.` });
  res.json({ ok });
});

roomApi.post('/permissions/:pid', (req, res) => {
  const { room, member } = req;
  if (room.settings.ownerApprovals && member.role !== 'owner') return res.status(403).json({ error: 'In this room only the owner approves commands.' });
  if (!L(room.id).permissions.has(req.params.pid)) return res.status(404).json({ ok: false });
  const ok = hostSend(room, { type: 'permission_answer', id: req.params.pid, allow: !!req.body?.allow, allowRest: !!req.body?.allowRest, by: member.name });
  res.status(ok ? 200 : 503).json({ ok });
});

const fromHost = (method, params, pick = (r) => r) => async (req, res) => {
  try {
    res.json(pick(await rpc(req.room, method, params(req))));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
};
roomApi.get('/files', fromHost('files', () => ({})));
roomApi.get('/file', fromHost('file', (req) => ({ path: String(req.query.path || '') })));
roomApi.get('/commits', fromHost('commits', () => ({})));
roomApi.get('/commits/:sha', fromHost('commit', (req) => ({ sha: req.params.sha })));

roomApi.get('/events', (req, res) => {
  const { room, member } = req;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const id = crypto.randomUUID();
  const l = L(room.id);
  l.viewers.set(id, { res, name: member.name, memberId: member.id });
  sse(res, 'hello', { runner: runnerState(room), online: presence(room.id), host: hostState(room) });
  broadcast(room.id, 'presence', presence(room.id));
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    if (!live.has(room.id)) return; // the room was deleted
    l.viewers.delete(id);
    broadcast(room.id, 'presence', presence(room.id));
  });
});

// --- owner controls --------------------------------------------------------

roomApi.get('/admin', ownerOnly, (req, res) => {
  const { room } = req;
  const online = new Set([...L(room.id).viewers.values()].map((v) => v.memberId));
  res.json({
    invite: room.invite,
    settings: room.settings,
    host: hostState(room),
    members: room.members.map((m) => ({ id: m.id, name: m.name, role: m.role, joinedAt: m.joinedAt, online: online.has(m.id) })),
  });
});

roomApi.post('/admin/settings', ownerOnly, (req, res) => {
  const { room } = req;
  const b = req.body || {};
  try {
    if (b.name !== undefined) store.rename(room, b.name);
    if (b.repo !== undefined) store.setRepo(room, b.repo);
    store.setSettings(room, b);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  broadcast(room.id, 'room', roomInfo(room));
  res.json(roomInfo(room));
});

roomApi.post('/admin/room-password', ownerOnly, (req, res) => {
  try {
    store.setRoomPassword(req.room, req.body?.password);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

roomApi.post('/admin/owner-password', ownerOnly, (req, res) => {
  const { room } = req;
  if (room.ownerPassword && !store.checkOwnerPassword(room, req.body?.current)) return res.status(401).json({ error: 'Your current owner password is wrong.' });
  try {
    store.setOwnerPassword(room, req.body?.password);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

roomApi.post('/admin/reset-invite', ownerOnly, (req, res) => {
  const invite = store.resetInvite(req.room);
  res.json({ invite, previewUrl: previewLink(req, req.room) });
});

roomApi.post('/admin/reset-owner-link', ownerOnly, (req, res) => res.json({ ownerKey: store.resetOwnerKey(req.room) }));

roomApi.post('/admin/reset-host-key', ownerOnly, (req, res) => {
  const { room } = req;
  const hostKey = store.resetHostKey(room);
  L(room.id).host?.ws.close(4401, 'The owner reset the host key.');
  res.json({ hostKey });
});

roomApi.post('/admin/kick', ownerOnly, (req, res) => {
  const { room } = req;
  let m;
  try {
    m = store.kick(room, String(req.body?.memberId || ''));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const l = L(room.id);
  for (const [id, v] of l.viewers) {
    if (v.memberId !== m.id) continue;
    sse(v.res, 'kicked', {});
    v.res.end();
    l.viewers.delete(id);
  }
  broadcast(room.id, 'notice', { text: `${req.member.name} removed ${m.name} from the room.` });
  broadcast(room.id, 'presence', presence(room.id));
  broadcastQueue(room);
  res.json({ ok: true });
});

roomApi.post('/admin/delete', ownerOnly, (req, res) => {
  const { room } = req;
  if (String(req.body?.confirm ?? '').trim() !== room.name) return res.status(400).json({ error: "Type the room's name exactly to delete it." });
  deleteRoom(room);
  clearMemberCookie(res, room.id);
  res.json({ ok: true });
});

app.use('/api/rooms/:roomId', roomApi);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// --- pages -----------------------------------------------------------------

app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-src 'self' http: https:; frame-ancestors 'none'"
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
const nm = path.join(APP_ROOT, 'node_modules');
app.get('/vendor/marked.js', (req, res) => res.sendFile(path.join(nm, 'marked/lib/marked.umd.js')));
app.get('/vendor/purify.js', (req, res) => res.sendFile(path.join(nm, 'dompurify/dist/purify.min.js')));
app.get(['/r/:roomId', '/r/:roomId/own'], (req, res) => res.sendFile(path.join(APP_ROOT, 'public/index.html')));
app.use(express.static(path.join(APP_ROOT, 'public')));

// ---------------------------------------------------------------------------
// Hosts: `gitclaudehub host` on each owner's computer connects to /host
// ---------------------------------------------------------------------------

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, 'http://x').pathname !== '/host') return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => onHostSocket(ws));
});

function onHostSocket(ws) {
  let room = null;
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  const helloTimer = setTimeout(() => ws.close(4400, 'Say hello first.'), 10_000);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return ws.close(4400, 'Bad message');
    }
    if (room) return onHostMessage(room, ws, msg);

    if (msg.type !== 'hello') return ws.close(4400, 'Say hello first.');
    clearTimeout(helloTimer);
    const r = store.get(msg.roomId);
    if (!r) return ws.close(4404, 'This room no longer exists on the site.');
    if (limited(`host:${r.id}`, 20, 600_000)) return ws.close(4429, 'Too many wrong host keys. Wait a few minutes.');
    if (!store.checkHostKey(r, msg.key)) {
      hit(`host:${r.id}`);
      return ws.close(4401, 'The site rejected this host key. The owner may have reset it.');
    }
    room = r;
    const l = L(room.id);
    if (l.host) {
      const old = l.host;
      hostGone(room, old);
      old.ws.close(4409, 'Another host connected to this room.');
    }
    const approvalMode = ['ask-bash', 'ask-all', 'auto'].includes(msg.approvalMode) ? msg.approvalMode : 'ask-bash';
    l.host = { ws, backend: clip(msg.backend, 80), approvalMode, since: now(), ready: false };
    room.host = { backend: l.host.backend, approvalMode, lastSeen: now() };
    store.save();
    ws.send(JSON.stringify({ type: 'welcome', room: { id: room.id, name: room.name, repo: room.repo } }));
    broadcastHost(room);
    console.log(`[gitclaudehub] Host connected to room ${room.id} (${l.host.backend}).`);
  });

  ws.on('close', () => {
    clearTimeout(helloTimer);
    if (!room || !store.get(room.id)) return;
    const h = L(room.id).host;
    if (h?.ws === ws) hostGone(room, h);
  });
}

function hostGone(room, h) {
  const l = L(room.id);
  if (l.host === h) l.host = null;
  for (const p of l.rpc.values()) {
    clearTimeout(p.timer);
    p.reject(httpError(503, "The room owner's computer went offline."));
  }
  l.rpc.clear();
  endCurrent(room, "The room owner's computer disconnected during this turn. Anything it saved before that is in the repo.");
  room.host = { ...room.host, lastSeen: now() };
  store.save();
  broadcastHost(room);
  console.log(`[gitclaudehub] Host left room ${room.id}.`);
}

const RELAYED = new Set(['turn_start', 'session_id', 'delta', 'items', 'permission_request', 'permission_resolved', 'turn_end', 'turn_error', 'notice']);

function onHostMessage(room, ws, msg) {
  const l = L(room.id);
  if (l.host?.ws !== ws) return;
  switch (msg.type) {
    case 'ready':
      l.host.ready = true;
      l.host.branch = clip(msg.branch, 100);
      l.host.preview = !!msg.preview;
      broadcastHost(room);
      drain(room);
      return;
    case 'fatal':
      console.warn(`[gitclaudehub] Host for room ${room.id} couldn't start: ${clip(msg.message, 500)}`);
      return;
    case 'rpc_result': {
      const p = l.rpc.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      l.rpc.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(httpError(400, clip(msg.error || 'The host could not do that.', 500)));
      return;
    }
    case 'event':
      return onHostEvent(room, String(msg.event), msg.data && typeof msg.data === 'object' ? msg.data : {});
  }
}

function onHostEvent(room, event, data) {
  const l = L(room.id);
  const cur = l.current;
  switch (event) {
    case 'phase':
      if (cur?.id === data.jobId) {
        cur.phase = clip(data.phase, 20);
        broadcastQueue(room);
      }
      return;
    case 'job_done':
      if (cur?.id === data.jobId) {
        l.current = null;
        l.permissions.clear();
        broadcastQueue(room);
        setImmediate(() => drain(room));
      }
      return;
    case 'sessions':
      if (!Array.isArray(data.sessions)) return;
      room.index = { version: 1, sessions: data.sessions.slice(0, 500) };
      store.save();
      broadcast(room.id, 'sessions', room.index);
      return;
    case 'turn_start':
      if (cur?.id === data.jobId) cur.startedAt = data.at;
      break;
    case 'session_id':
      if (cur?.id === data.jobId) cur.liveSessionId = data.sessionId;
      break;
    case 'permission_request':
      if (cur?.id !== data.jobId) return;
      l.permissions.set(String(data.id), data);
      break;
    case 'permission_resolved':
      l.permissions.delete(String(data.id));
      break;
  }
  if (RELAYED.has(event)) broadcast(room.id, event, data);
}

// Ping hosts so dead connections (a closed laptop, a dropped tunnel) are noticed within a minute.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 25_000).unref();

// ---------------------------------------------------------------------------
// Preview: each room's built site, fetched from its host and served on PREVIEW_PORT, a different
// origin from this app, so a project's scripts can't act as the viewer inside gitclaudehub.
// ---------------------------------------------------------------------------

function startPreviewServer() {
  const preview = express();
  preview.set('trust proxy', 'loopback');
  preview.disable('x-powered-by');
  preview.use(async (req, res) => {
    if (req.query.gch_room) {
      const room = store.get(String(req.query.gch_room));
      if (!room || !safeEqual(req.query.gch_key, previewKey(room))) return res.status(401).type('text').send('This preview link is out of date. Open the preview from the room again.');
      res.setHeader('Set-Cookie', `${PREVIEW_COOKIE}=${room.id}.${previewKey(room)}; Path=/; HttpOnly; SameSite=Lax${req.secure ? '; Secure' : ''}`);
      const url = new URL(req.originalUrl, 'http://x');
      url.searchParams.delete('gch_room');
      url.searchParams.delete('gch_key');
      return res.redirect(url.pathname + url.search);
    }
    const [roomId, key] = (cookies(req)[PREVIEW_COOKIE] || '').split('.');
    const room = store.get(roomId);
    if (!room || !safeEqual(key, previewKey(room))) return res.status(401).type('text').send('Open the preview from gitclaudehub (Project → Preview).');
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).type('text').send('Previews are read-only.');
    try {
      const r = await rpc(room, 'preview', { path: req.path }, 30_000);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (r.status !== 200) return res.status(r.status).type('text').send(r.status === 404 ? 'Not found' : 'Unavailable');
      res.type(r.ext || 'bin').send(Buffer.from(r.body, 'base64'));
    } catch (err) {
      res.status(err.status || 502).type('text').send(err.message);
    }
  });
  preview.listen(config.previewPort, config.host, () => console.log(`[gitclaudehub] Previews on port ${config.previewPort}`));
}

// ---------------------------------------------------------------------------

// One site per data folder. Two would each keep their own copy of the rooms in memory and
// overwrite each other's rooms.json.
function takeDataLock() {
  const file = path.join(config.hubDir, 'site.pid');
  try {
    const pid = Number(fs.readFileSync(file, 'utf8'));
    if (pid && pid !== process.pid) {
      process.kill(pid, 0); // throws if that process is gone
      console.error(`\n[gitclaudehub] Another gitclaudehub site (process ${pid}) is already using ${config.dataDir}.`);
      console.error('[gitclaudehub] Stop that one first, or give this one its own DATA_DIR.\n');
      process.exit(1);
    }
  } catch (err) {
    if (err.code === 'EPERM') {
      console.error(`\n[gitclaudehub] Another gitclaudehub site is already using ${config.dataDir}. Stop it first.\n`);
      process.exit(1);
    }
    // No lock, or a stale one from a site that has stopped.
  }
  fs.writeFileSync(file, String(process.pid), { mode: 0o600 });
  const release = () => {
    try {
      if (fs.readFileSync(file, 'utf8') === String(process.pid)) fs.rmSync(file);
    } catch {}
  };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0));
}

takeDataLock();
migrateLegacyRoom(store, config);
startPreviewServer();
server.listen(config.port, config.host, () => {
  const where = config.host === '0.0.0.0' ? `http://localhost:${config.port} (and your network address)` : `http://${config.host}:${config.port}`;
  console.log(`[gitclaudehub] Site is open at ${where} with ${store.size} room${store.size === 1 ? '' : 's'}.`);
  if (config.createRoomCode) console.log('[gitclaudehub] Creating a room needs CREATE_ROOM_CODE.');
});
