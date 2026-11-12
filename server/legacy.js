// Before rooms existed, this app ran one room from .env (GITHUB_REPO, ROOM_PASSWORD, data/repo).
// On first start of the site, that room becomes an ordinary room. It keeps its password and its
// clone, and it gets a host on this computer. Its owner picks an owner password on the first
// visit to the owner link.

import fs from 'node:fs';
import path from 'node:path';
import { readIndex } from '../lib/share.js';
import { saveHost } from '../host/saved.js';

export function migrateLegacyRoom(store, config) {
  const L = config.legacy;
  if (!L || [...store.rooms.values()].some((r) => r.legacy)) return null;

  const index = fs.existsSync(L.repoDir) ? readIndex(L.repoDir) : { version: 1, sessions: [] };
  // Name it after the project: ROOM_NAME, else the README's title, else the oldest session, else the repo.
  let heading = '';
  try {
    heading = fs.readFileSync(path.join(L.repoDir, 'README.md'), 'utf8').match(/^#\s+(.+)$/m)?.[1].trim() || '';
  } catch {}
  const oldest = [...index.sessions].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
  const name = (L.name || heading || oldest?.title || L.repo.split('/')[1]).slice(0, 80);
  const { room, ownerKey, hostKey } = store.create({ name, repo: L.repo, roomPassword: L.roomPassword, legacy: true });
  room.index = index;
  store.save();

  saveHost({
    hub: `http://localhost:${config.port}`,
    roomId: room.id,
    key: hostKey,
    dir: L.repoDir,
    preview: L.preview,
    budget: L.budget,
    model: L.model,
    approvals: L.approvals,
  });

  const base = config.publicUrl || `http://localhost:${config.port}`;
  const file = path.join(config.hubDir, 'owner-links.txt');
  fs.writeFileSync(
    file,
    `gitclaudehub: links for your room “${name}”

Owner link (keep it private). Open it and choose an owner password; together they make you the owner:
${base}/r/${room.id}/own#key=${ownerKey}

Invite link for friends (they also need the room password, which is still ROOM_PASSWORD from .env):
${base}/r/${room.id}#invite=${room.invite}

The part before /r/ changes whenever start-room.sh opens a new Cloudflare link. Keep everything
from /r/ on and put the current room link in front of it. Owners can copy a fresh invite link
from the room's settings at any time.
`,
    { mode: 0o600 }
  );
  console.log(`[gitclaudehub] Your existing room is now the room “${name}”. Its owner link and invite link are in ${file}`);
  return room;
}
