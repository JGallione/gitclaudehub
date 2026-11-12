#!/usr/bin/env node
// gitclaudehub — share a Claude Code session (and the code it built) through the project's git repo.
//
//   gitclaudehub push [session-id]   share your latest (or a chosen) session + commit + push
//   gitclaudehub pull [session-id]   pull, then install shared sessions so `claude --resume` works here
//   gitclaudehub list                list shared sessions
//   gitclaudehub local               list your local Claude Code sessions for this folder
//   gitclaudehub host                run your room's turns on this computer (see host/host.js)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadEnv } from '../lib/env.js';
import { savedHosts, savedHost, saveHost, forgetHost } from '../host/saved.js';
import {
  SHARE_DIR,
  listLocalSessions,
  findLocalSessionFile,
  exportSession,
  importSession,
  sharedSessionDir,
  readEntries,
  localSessionDir,
} from '../lib/sessions.js';
import { readIndex, upsertSession, ensureShareReadme, git, repoRootOf, stagedSecretFiles } from '../lib/share.js';
import { deriveTitle } from '../lib/display.js';

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};

const HELP = `${c.bold('gitclaudehub')} — share Claude Code sessions through your project's git repo

${c.bold('Usage')}
  gitclaudehub push [session-id]   Share your latest Claude Code session for this folder (or the one you name),
                              commit it with your code, and push.
  gitclaudehub pull [session-id]   git pull, then install the shared sessions so you can run
                              claude --resume <id> here.
  gitclaudehub list                Show the sessions shared in this repo.
  gitclaudehub local               Show your local Claude Code sessions for this folder.
  gitclaudehub host                Run your room's turns on this computer, with your own AI.
                              Your room's settings on the site show the exact command.

${c.bold('Options')}
  --title <text>      Title for the shared session (push)
  --name <you>        Your name as shown to friends (default: git user.name)
  --session-only      Commit only the .gitclaudehub folder, not your other changes (push)
  --no-git            Don't commit, push or pull — just copy files
  --force             Push over a session someone else extended, or pull over unshared local turns
  -h, --help          Show this help

${c.bold('Host options')} (remembered per room in ~/.gitclaudehub/hosts/)
  --hub <url>         The gitclaudehub site the room lives on
  --room <id>         The room to host
  --all               Host every room you've hosted before (optionally only those on --hub)
  --ollama <model>    Use a local Ollama model (needs Ollama 0.14.3+), e.g. --ollama qwen3:8b
  --claude            Go back to Claude (this computer's Claude login, or ANTHROPIC_API_KEY)
  --model <name>      Which Claude model to use
  --approvals <mode>  ask-bash (default): shell commands wait for someone to approve
                      ask-all: edits wait too · auto: nothing waits (only in a container)
  --budget <usd>      Stop a Claude turn that costs more than this (an estimate at API prices)
  --preview <dir>     Serve this folder of the repo in the room's Preview tab ("." for plain HTML)
  --dir <path>        Where the room's clone lives (default ~/.gitclaudehub/rooms/<id>/repo)
  --context <tokens>  The local model's context window, to warn before a session outgrows it (32768)
  Private repos over https use GITHUB_TOKEN if it's set; otherwise git's own credentials.
`;

function fail(msg) {
  console.error(c.red('✖ ') + msg);
  process.exit(1);
}

function lastUuid(entries) {
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i].uuid) return entries[i].uuid;
  return null;
}

async function hasUpstream(root) {
  return (await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { cwd: root, allowFail: true })).ok;
}

async function hasRemote(root) {
  return (await git(['remote'], { cwd: root })).stdout.trim().length > 0;
}

async function pullIfTracking(root) {
  if (!(await hasUpstream(root))) return;
  process.stdout.write(c.dim('Pulling latest changes… '));
  await git(['pull', '--rebase', '--autostash'], { cwd: root });
  console.log(c.dim('done'));
}

async function defaultName(root) {
  const r = await git(['config', 'user.name'], { cwd: root, allowFail: true });
  return r.stdout.trim() || os.userInfo().username;
}

async function cmdPush(id, opts) {
  const cwd = process.cwd();
  const root = await repoRootOf(cwd);
  if (!root) fail('This folder is not inside a git repository. Run `git init` and add a GitHub remote first.');

  const sessions = listLocalSessions(cwd);
  if (!id) {
    if (!sessions.length) fail(`No Claude Code sessions found for this folder.\n  Looked in ${localSessionDir(cwd)}`);
    id = sessions[0].id;
  }
  const localFile = findLocalSessionFile(id, cwd);
  if (!localFile) fail(`Couldn't find session ${id} on this computer.`);

  if (!opts['no-git']) await pullIfTracking(root);

  // Refuse to overwrite turns a friend added that you don't have yet.
  const sharedFile = path.join(sharedSessionDir(root), `${id}.jsonl`);
  if (fs.existsSync(sharedFile) && !opts.force) {
    const theirs = lastUuid(readEntries(sharedFile));
    const mine = new Set(readEntries(localFile).map((e) => e.uuid));
    if (theirs && !mine.has(theirs)) {
      fail(
        `Someone added to this session since you last pulled it.\n` +
          `  Run ${c.bold('gitclaudehub pull ' + id)} and ${c.bold('claude --resume ' + id)} to continue from the shared version,\n` +
          `  or run push again with --force to replace it with yours.`
      );
    }
  }

  const name = opts.name || (await defaultName(root));
  const { redactions } = await exportSession({ id, projectRoot: cwd, repoRoot: root, sourceFile: localFile, author: name.replace(/[[\]\n\r]/g, '').slice(0, 32) });
  ensureShareReadme(root);
  const meta = upsertSession(root, { id, owner: name, contributor: name, title: opts.title, source: 'cli' });

  console.log(`${c.green('✔')} Copied session ${c.bold(meta.title)} ${c.dim(`(${id})`)} into ${SHARE_DIR}/sessions`);
  if (redactions) console.log(c.yellow(`  Redacted ${redactions} likely secret${redactions === 1 ? '' : 's'} from the transcript.`));
  if (opts['no-git']) return;

  await git(['add', SHARE_DIR], { cwd: root });
  if (!opts['session-only']) await git(['add', '-A'], { cwd: root });
  const risky = await stagedSecretFiles(root);
  if (risky.length && !opts.force) {
    await git(['reset', '-q', '--', ...risky], { cwd: root });
    console.log(c.yellow(`  Left these out of the commit because they may hold secrets: ${risky.join(', ')}`));
    console.log(c.yellow('  Add them to .gitignore, or push with --force to include them.'));
  }
  const staged = await git(['diff', '--cached', '--quiet'], { cwd: root, allowFail: true });
  if (staged.ok) {
    console.log(c.dim('  Nothing new to commit.'));
  } else {
    await git(['commit', '-q', '-m', `Share Claude session: ${meta.title}`, '-m', `Session ${id}, shared by ${name} with gitclaudehub.`], { cwd: root });
    console.log(`${c.green('✔')} Committed`);
  }
  if (!(await hasRemote(root))) {
    console.log(c.yellow('  No git remote yet. Add your GitHub repo with: git remote add origin <url>, then run push again.'));
    return;
  }
  const upstream = await hasUpstream(root);
  await git(upstream ? ['push', '-q'] : ['push', '-q', '-u', 'origin', 'HEAD'], { cwd: root });
  console.log(`${c.green('✔')} Pushed. Friends can now open it in the gitclaudehub web app, or run ${c.bold('gitclaudehub pull')}.`);
}

async function cmdPull(id, opts) {
  const cwd = process.cwd();
  const root = await repoRootOf(cwd);
  if (!root) fail('This folder is not inside a git repository.');
  if (!opts['no-git']) await pullIfTracking(root);

  const index = readIndex(root);
  const ids = id ? [id] : index.sessions.map((s) => s.id);
  if (!ids.length) fail(`No shared sessions in ${SHARE_DIR}/ yet. Someone needs to run ${c.bold('gitclaudehub push')} first.`);

  for (const sid of ids) {
    const meta = index.sessions.find((s) => s.id === sid);
    const sharedFile = path.join(sharedSessionDir(root), `${sid}.jsonl`);
    const local = findLocalSessionFile(sid, cwd);
    if (local && !opts.force) {
      const mineLast = lastUuid(readEntries(local));
      const shared = new Set(readEntries(sharedFile).map((e) => e.uuid));
      if (mineLast && !shared.has(mineLast)) {
        console.log(c.yellow(`• Skipped ${sid}: you have turns that aren't shared yet. Run gitclaudehub push ${sid} (or pull --force to discard them).`));
        continue;
      }
    }
    await importSession({ id: sid, projectRoot: cwd, repoRoot: root });
    const title = meta?.title || deriveTitle(readEntries(sharedFile));
    console.log(`${c.green('✔')} ${c.bold(title)}  ${c.dim(meta?.contributors?.join(', ') || '')}`);
    console.log(`    claude --resume ${sid}`);
  }
}

async function cmdList() {
  const root = (await repoRootOf(process.cwd())) || fail('Not inside a git repository.');
  const index = readIndex(root);
  if (!index.sessions.length) return console.log('No shared sessions yet.');
  for (const s of index.sessions) {
    console.log(`${c.bold(s.title)}  ${c.dim(s.id)}`);
    console.log(c.dim(`    ${s.prompts ?? '?'} prompt${s.prompts === 1 ? '' : 's'} ·${(s.contributors || []).join(', ')} · updated ${s.updatedAt}`));
  }
}

function cmdLocal() {
  const sessions = listLocalSessions(process.cwd());
  if (!sessions.length) return console.log(`No local sessions for this folder (looked in ${localSessionDir(process.cwd())}).`);
  for (const s of sessions.slice(0, 20)) {
    console.log(`${c.bold(deriveTitle(readEntries(s.file)))}  ${c.dim(s.id)}  ${c.dim(new Date(s.mtime).toLocaleString())}`);
  }
}

// ---------------------------------------------------------------------------
// host
// ---------------------------------------------------------------------------

/** Ask for a secret without echoing it. */
function askHidden(question) {
  if (!process.stdin.isTTY) return Promise.resolve('');
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          return resolve(buf.trim());
        }
        if (ch === '\u0003') {
          process.stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

const sameHub = (a, b) => String(a).replace(/\/+$/, '') === String(b).replace(/\/+$/, '');

async function cmdHost(opts) {
  loadEnv(); // GITHUB_TOKEN and friends, when run from the app's own folder
  let configs;
  if (opts.all) {
    configs = savedHosts().filter((cfg) => !opts.hub || sameHub(cfg.hub, opts.hub));
    if (!configs.length) fail(`No rooms to host yet. Run ${c.bold('gitclaudehub host --hub <site> --room <id>')} once first.`);
  } else {
    let roomId = opts.room;
    if (!roomId) {
      const all = savedHosts();
      if (all.length === 1) roomId = all[0].roomId;
      else fail(`Which room? Pass --room <id>. The room's settings on the site show the full command.`);
    }
    const cfg = { ...(savedHost(roomId) || {}), roomId };
    const flags = { hub: 'hub', dir: 'dir', ollama: 'ollama', 'ollama-url': 'ollamaUrl', model: 'model', approvals: 'approvals', preview: 'preview', 'repo-url': 'repoUrl' };
    for (const [flag, field] of Object.entries(flags)) if (opts[flag] !== undefined) cfg[field] = opts[flag];
    if (opts.budget !== undefined) cfg.budget = Number(opts.budget);
    if (opts.context !== undefined) cfg.context = Number(opts.context);
    if (opts.claude) delete cfg.ollama;
    if (opts['no-preview']) delete cfg.preview;
    if (cfg.dir) cfg.dir = path.resolve(cfg.dir);
    if (opts.key || process.env.GITCLAUDEHUB_HOST_KEY) cfg.key = opts.key || process.env.GITCLAUDEHUB_HOST_KEY;
    if (!cfg.hub) fail('Pass --hub <the site address>, for example --hub https://something.trycloudflare.com');
    configs = [cfg];
  }
  for (const cfg of configs) {
    if (cfg.approvals && !['ask-bash', 'ask-all', 'auto'].includes(cfg.approvals)) fail('--approvals must be ask-bash, ask-all or auto.');
    if (cfg.approvals === 'auto') console.log(c.yellow('! --approvals auto lets anyone in the room run any command on this computer. Use it only in a container.'));
  }

  const { hostRoom } = await import('../host/host.js');
  const token = process.env.GITHUB_TOKEN || '';
  const single = configs.length === 1;
  const running = new Map();

  async function host(cfg) {
    const tag = single ? '' : c.dim(`[${cfg.roomId}] `);
    const log = (m) => console.log(tag + m);
    for (;;) {
      if (!cfg.key) {
        cfg.key = await askHidden('Paste the host key from the room settings: ');
        if (!cfg.key) return log(c.red('✖ ') + 'No host key. Pass --key <key> or set GITCLAUDEHUB_HOST_KEY.');
      }
      let h;
      try {
        h = await hostRoom({ ...cfg, token }, { log, onReady: () => saveHost(cfg) });
      } catch (err) {
        process.exitCode = 1;
        return log(c.red('✖ ') + err.message);
      }
      if (h.backend.kind === 'ollama') {
        log(c.dim("Local models need a big context window for Claude Code's tools: set Ollama's context length to 32K or more (Ollama settings, or OLLAMA_CONTEXT_LENGTH=32768 ollama serve)."));
      }
      running.set(cfg.roomId, h);
      const r = await h.done;
      running.delete(cfg.roomId);
      if (r.code === 'bad_key' && single && process.stdin.isTTY) {
        log(c.yellow('! ') + `${r.reason} Paste the current host key (room settings → Reset host key gives you a new one).`);
        cfg.key = '';
        continue;
      }
      if (r.code === 'gone' || r.code === 'deleted') forgetHost(cfg.roomId);
      if (!r.ok) process.exitCode = 1;
      return log((r.ok ? c.green('✓ ') : c.red('✖ ')) + r.reason);
    }
  }

  let stopping = false;
  const stop = async () => {
    stopping = true;
    console.log(c.dim('\nStopping. A running turn gets to save its work first (Ctrl-C again to quit now) …'));
    await Promise.all([...running.values()].map((h) => h.stop()));
  };
  // A second Ctrl-C quits at once. start-room.sh sends SIGTERM right after Ctrl-C; that one just waits.
  process.on('SIGINT', () => (stopping ? process.exit(130) : stop()));
  process.on('SIGTERM', () => !stopping && stop());
  await Promise.all(configs.map(host));
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    title: { type: 'string' },
    name: { type: 'string' },
    'session-only': { type: 'boolean' },
    'no-git': { type: 'boolean' },
    force: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
    // host
    hub: { type: 'string' },
    room: { type: 'string' },
    key: { type: 'string' },
    all: { type: 'boolean' },
    dir: { type: 'string' },
    ollama: { type: 'string' },
    'ollama-url': { type: 'string' },
    claude: { type: 'boolean' },
    model: { type: 'string' },
    approvals: { type: 'string' },
    budget: { type: 'string' },
    preview: { type: 'string' },
    'no-preview': { type: 'boolean' },
    context: { type: 'string' },
    'repo-url': { type: 'string' },
  },
});

const [cmd, id] = positionals;
try {
  if (values.help || !cmd) console.log(HELP);
  else if (cmd === 'push') await cmdPush(id, values);
  else if (cmd === 'pull') await cmdPull(id, values);
  else if (cmd === 'list' || cmd === 'ls') await cmdList();
  else if (cmd === 'local') cmdLocal();
  else if (cmd === 'host') await cmdHost(values);
  else fail(`Unknown command "${cmd}". Run gitclaudehub --help.`);
} catch (err) {
  fail(err.message);
}
