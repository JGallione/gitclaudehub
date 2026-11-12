import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { APP_ROOT, loadEnv } from '../lib/env.js';

export { APP_ROOT };
loadEnv();

const env = process.env;
const dataDir = path.resolve(APP_ROOT, env.DATA_DIR || 'data');
const hubDir = path.join(dataDir, 'hub');
const port = Number(env.PORT || 3000);

/** Signs cookies. Kept in data/hub/secret so logins survive restarts. */
function cookieSecret() {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  fs.mkdirSync(hubDir, { recursive: true, mode: 0o700 });
  const file = path.join(hubDir, 'secret');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return fs.readFileSync(file, 'utf8').trim();
}

export const config = {
  port,
  // Tunnels and proxies reach the site on this computer, so it only listens locally unless HOST says otherwise.
  host: env.HOST || '127.0.0.1',
  dataDir,
  hubDir,
  cookieSecret: cookieSecret(),
  // If set, people need this code to create a room on this site.
  createRoomCode: env.CREATE_ROOM_CODE || '',
  maxRooms: Number(env.MAX_ROOMS || 100),
  previewPort: Number(env.PREVIEW_PORT || port + 1),
  previewUrl: (env.PREVIEW_URL || '').replace(/\/$/, ''),
  publicUrl: (env.PUBLIC_URL || '').replace(/\/$/, ''),
  // The one room this app used to run from .env becomes the first room on the site (see server/legacy.js).
  legacy:
    env.GITHUB_REPO && env.ROOM_PASSWORD
      ? {
          repo: env.GITHUB_REPO.replace(/\.git$/, ''),
          roomPassword: env.ROOM_PASSWORD,
          name: env.ROOM_NAME || '',
          repoDir: env.REPO_DIR ? path.resolve(env.REPO_DIR) : path.join(dataDir, 'repo'),
          preview: env.PREVIEW_DIR || '',
          budget: env.MAX_BUDGET_USD ? Number(env.MAX_BUDGET_USD) : undefined,
          model: env.CLAUDE_MODEL || undefined,
          approvals: env.APPROVAL_MODE || undefined,
        }
      : null,
};
