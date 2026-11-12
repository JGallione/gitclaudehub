// The .gitclaudehub/index.json catalogue and small git helpers shared by the CLI and server.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { SHARE_DIR, sharedSessionDir, readEntries } from './sessions.js';
import { deriveTitle, countPrompts } from './display.js';

export function indexPath(repoRoot) {
  return path.join(repoRoot, SHARE_DIR, 'index.json');
}

export function readIndex(repoRoot) {
  try {
    const idx = JSON.parse(fs.readFileSync(indexPath(repoRoot), 'utf8'));
    return { version: 1, sessions: [], ...idx };
  } catch {
    return { version: 1, sessions: [] };
  }
}

export function writeIndex(repoRoot, index) {
  index.sessions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  fs.mkdirSync(path.dirname(indexPath(repoRoot)), { recursive: true });
  fs.writeFileSync(indexPath(repoRoot), JSON.stringify(index, null, 2) + '\n');
}

/**
 * Refresh one session's catalogue entry from its shared transcript.
 * `replaces` handles a resume that came back under a new session id.
 */
export function upsertSession(repoRoot, { id, owner, contributor, title, source, replaces }) {
  const index = readIndex(repoRoot);
  const entries = readEntries(path.join(sharedSessionDir(repoRoot), `${id}.jsonl`));
  let s = index.sessions.find((x) => x.id === id || (replaces && x.id === replaces));
  const now = new Date().toISOString();
  if (!s) {
    s = { id, title: '', owner: owner || contributor || 'unknown', contributors: [], createdAt: now, source: source || 'cli' };
    index.sessions.push(s);
  }
  if (replaces && s.id === replaces && replaces !== id) {
    s.previousIds = [...new Set([...(s.previousIds || []), replaces])];
    for (const old of [`${replaces}.jsonl`, replaces]) {
      fs.rmSync(path.join(sharedSessionDir(repoRoot), old), { recursive: true, force: true });
    }
  }
  s.id = id;
  if (title) s.title = title;
  else if (!s.title || s.title === 'Untitled session') s.title = deriveTitle(entries);
  if (contributor && !s.contributors.includes(contributor)) s.contributors.push(contributor);
  s.prompts = countPrompts(entries);
  s.updatedAt = now;
  writeIndex(repoRoot, index);
  return s;
}

export function ensureShareReadme(repoRoot) {
  const p = path.join(repoRoot, SHARE_DIR, 'README.md');
  if (fs.existsSync(p)) return;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(
    p,
    `# Shared Claude Code sessions

This folder holds Claude Code session transcripts for this project, shared with gitclaudehub.

- \`index.json\` lists the sessions.
- \`sessions/<id>.jsonl\` is each transcript. Project paths are stored as \`{{GITCLAUDEHUB_ROOT}}\`
  and likely secrets are replaced with \`[REDACTED]\` before they are committed.

To continue a session in your own terminal, install the \`gitclaudehub\` command
(\`npm install -g github:JGallione/gitclaudehub\`, needs Node 18.17+ and git), then:

\`\`\`bash
gitclaudehub pull              # installs the shared sessions for this checkout
claude --resume <id>
gitclaudehub push <id>         # shares your new turns (and code) back
\`\`\`
`
  );
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

/** Extra -c flags so a token authenticates https GitHub calls without being saved in .git/config. */
export function gitAuthArgs(token) {
  if (!token) return [];
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return ['-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}`];
}

export function git(args, { cwd, token, allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...gitAuthArgs(token), ...args],
      { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout, stderr) => {
        if (err && !allowFail) {
          const msg = (stderr || err.message).toString().replace(/AUTHORIZATION: basic \S+/g, 'AUTHORIZATION: ***');
          reject(new Error(`git ${args[0]} failed: ${msg.trim()}`));
        } else resolve({ ok: !err, stdout: stdout.toString(), stderr: stderr.toString() });
      }
    );
  });
}

export async function repoRootOf(cwd) {
  const r = await git(['rev-parse', '--show-toplevel'], { cwd, allowFail: true });
  return r.ok ? r.stdout.trim() : null;
}

/** Paths that look like they hold secrets and are about to be committed. */
export async function stagedSecretFiles(cwd) {
  const r = await git(['diff', '--cached', '--name-only'], { cwd });
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .filter((f) => /(^|\/)(\.env(\..*)?|.*\.pem|.*\.key|id_rsa.*|credentials\.json|\.npmrc)$/i.test(f) && !/\.example$|\.sample$|\.template$/i.test(f));
}
