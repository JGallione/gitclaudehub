// Saved host settings, one file per room: ~/.gitclaudehub/hosts/<room>.json.
// They hold the room's host key, so the folder is 0700 and the files 0600.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME_DIR = process.env.GITCLAUDEHUB_HOME || path.join(os.homedir(), '.gitclaudehub');
export const HOSTS_DIR = path.join(HOME_DIR, 'hosts');

export function savedHosts() {
  if (!fs.existsSync(HOSTS_DIR)) return [];
  return fs
    .readdirSync(HOSTS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(HOSTS_DIR, f), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter((c) => c?.roomId);
}

export function savedHost(roomId) {
  return savedHosts().find((c) => c.roomId === roomId) || null;
}

export function saveHost(cfg) {
  fs.mkdirSync(HOSTS_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(HOSTS_DIR, `${cfg.roomId}.json`);
  const clean = Object.fromEntries(Object.entries(cfg).filter(([, v]) => v !== undefined && v !== ''));
  fs.writeFileSync(file, JSON.stringify(clean, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

export function forgetHost(roomId) {
  fs.rmSync(path.join(HOSTS_DIR, `${roomId}.json`), { force: true });
}

export function defaultCloneDir(roomId) {
  return path.join(HOME_DIR, 'rooms', roomId, 'repo');
}
