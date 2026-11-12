// Moves Claude Code session transcripts between the local Claude config folder
// (~/.claude/projects/<project-key>/<id>.jsonl) and a shared git repo
// (.gitclaudehub/sessions/<id>.jsonl).
//
// On export: absolute project paths become a placeholder, secrets are redacted,
// and account-specific entries are dropped. On import: the placeholder becomes
// the importer's own project path, so `claude --resume <id>` works on their machine.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const SHARE_DIR = '.gitclaudehub';
export const ROOT_TOKEN = '{{GITCLAUDEHUB_ROOT}}';
export const HOME_TOKEN = '{{GITCLAUDEHUB_HOME}}';

// Entry types that only make sense for the original account / app instance.
const DROP_TYPES = new Set([
  'artifact-autoreact-ledger',
  'artifact-comment-monitor',
  'frame-link',
  'atis-latch',
]);
const DROP_KEYS = new Set(['accountUuid', 'serverClassifierContext', 'serverClassifierRequest']);

export function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/**
 * Claude Code names each project's session folder after its path: non-alphanumerics
 * become '-', and names over 200 characters are cut and suffixed with a hash of the path.
 */
export function projectKey(cwd) {
  const full = path.resolve(cwd);
  const key = full.replace(/[^a-zA-Z0-9]/g, '-');
  if (key.length <= 200) return key;
  let h = 0;
  for (let i = 0; i < full.length; i++) h = ((h << 5) - h + full.charCodeAt(i)) | 0;
  return `${key.slice(0, 200)}-${Math.abs(h).toString(36)}`;
}

export function localSessionDir(cwd) {
  return path.join(claudeConfigDir(), 'projects', projectKey(cwd));
}

export function sharedSessionDir(repoRoot) {
  return path.join(repoRoot, SHARE_DIR, 'sessions');
}

/** Find a session transcript locally: the project's own folder first, then any project folder. */
export function findLocalSessionFile(id, cwd) {
  const direct = path.join(localSessionDir(cwd), `${id}.jsonl`);
  if (fs.existsSync(direct)) return direct;
  const projects = path.join(claudeConfigDir(), 'projects');
  if (!fs.existsSync(projects)) return null;
  for (const d of fs.readdirSync(projects)) {
    const p = path.join(projects, d, `${id}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Local sessions for a project folder, newest first. */
export function listLocalSessions(cwd) {
  const dir = localSessionDir(cwd);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => {
      const file = path.join(dir, f);
      return { id: f.slice(0, -6), file, mtime: fs.statSync(file).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

// ---------------------------------------------------------------------------
// Secret redaction
// ---------------------------------------------------------------------------

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bhf_[A-Za-z]{34}\b/g,
  /\bsb_secret_[A-Za-z0-9_-]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
];
// KEY=value lines as they appear in .env files and shell exports.
const ENV_ASSIGNMENT =
  /\b([A-Z][A-Z0-9_]*(?:API_KEY|APIKEY|SECRET|SECRET_KEY|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|ACCESS_KEY))(\s*=\s*)(["']?)([^\s"'$`]{8,})\3/g;

/** Returns { text, count } with secrets replaced by [REDACTED]. */
export function redactSecrets(text) {
  let count = 0;
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, () => {
      count++;
      return '[REDACTED]';
    });
  }
  out = out.replace(ENV_ASSIGNMENT, (m, name, eq, q, value) => {
    if (value === '[REDACTED]' || /^(process\.|os\.|env\.|\$\{)/.test(value) || value.includes('(')) return m;
    count++;
    return `${name}${eq}${q}[REDACTED]${q}`;
  });
  return { text: out, count };
}

function containsSecret(text) {
  return redactSecrets(text).count > 0;
}

// ---------------------------------------------------------------------------
// Path rewriting
// ---------------------------------------------------------------------------

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Replace `from` only where it is a whole path prefix (not /proj inside /project2). */
function pathReplacer(from, to) {
  if (!from || from === to) return (s) => s;
  const re = new RegExp(escapeRe(from) + '(?![A-Za-z0-9_.-])', 'g');
  return (s) => (s.includes(from) ? s.replace(re, () => to) : s);
}

// ---------------------------------------------------------------------------
// Structural walk — never touches thinking blocks or signatures, since the API
// rejects a thinking block whose text no longer matches its signature.
// ---------------------------------------------------------------------------

function isThinkingBlock(v) {
  return v && typeof v === 'object' && (v.type === 'thinking' || v.type === 'redacted_thinking');
}

function mapStrings(value, fn) {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((v) => (isThinkingBlock(v) ? v : mapStrings(v, fn)));
  if (value && typeof value === 'object') {
    if (isThinkingBlock(value)) return value;
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (DROP_KEYS.has(k)) continue;
      out[k] = k === 'signature' ? v : mapStrings(v, fn);
    }
    return out;
  }
  return value;
}

/** Drop thinking blocks that contain secrets (they can't be edited without breaking the signature). */
function dropSecretThinking(entry) {
  const content = entry?.message?.content;
  if (!Array.isArray(content)) return { entry, dropped: 0, empty: false };
  let dropped = 0;
  const kept = content.filter((b) => {
    if (b?.type === 'thinking' && typeof b.thinking === 'string' && containsSecret(b.thinking)) {
      dropped++;
      return false;
    }
    return true;
  });
  if (!dropped) return { entry, dropped: 0, empty: false };
  return {
    entry: { ...entry, message: { ...entry.message, content: kept } },
    dropped,
    empty: kept.length === 0,
  };
}

/**
 * Transform JSONL text line by line. Lines that can't be parsed are kept verbatim
 * (after a text-level redaction). Entries removed from the chain get their children
 * re-linked to the removed entry's parent so the conversation stays connected.
 */
const NAME_TAG = /^\[[^\]\n]{1,40}\]\s/;

/** Put "[Name] " in front of a prompt someone typed, the way the web app does. */
function tagPrompt(entry, author) {
  if (entry?.type !== 'user' || entry.isMeta || entry.isCompactSummary || entry.isSidechain) return entry;
  const content = entry.message?.content;
  if (typeof content === 'string') {
    if (!content.trim() || content.startsWith('<') || NAME_TAG.test(content)) return entry;
    return { ...entry, message: { ...entry.message, content: `[${author}] ${content}` } };
  }
  if (!Array.isArray(content) || content.some((b) => b?.type === 'tool_result')) return entry;
  const i = content.findIndex((b) => b?.type === 'text');
  if (i === -1 || content[i].text.startsWith('<') || NAME_TAG.test(content[i].text)) return entry;
  const blocks = content.slice();
  blocks[i] = { ...blocks[i], text: `[${author}] ${blocks[i].text}` };
  return { ...entry, message: { ...entry.message, content: blocks } };
}

function transformJsonl(text, { mapString, redact, author, knownUuids }) {
  const relink = new Map();
  let redactions = 0;
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      const r = redact ? redactSecrets(mapString(line)) : { text: mapString(line), count: 0 };
      redactions += r.count;
      out.push(r.text);
      continue;
    }
    if (entry && DROP_TYPES.has(entry.type)) continue;

    if (redact) {
      const d = dropSecretThinking(entry);
      redactions += d.dropped;
      if (d.empty && entry.uuid) {
        relink.set(entry.uuid, relink.get(entry.parentUuid) ?? entry.parentUuid ?? null);
        continue;
      }
      entry = d.entry;
    }
    if (entry.parentUuid && relink.has(entry.parentUuid)) entry.parentUuid = relink.get(entry.parentUuid);
    if (author && entry.uuid) {
      // Prompts already shared keep whoever they were credited to; new ones get the pusher.
      const who = knownUuids?.has(entry.uuid) ? knownUuids.get(entry.uuid) : author;
      if (who) entry = tagPrompt(entry, who);
    }

    entry = mapStrings(entry, (s) => {
      let v = mapString(s);
      if (redact) {
        const r = redactSecrets(v);
        redactions += r.count;
        v = r.text;
      }
      return v;
    });
    out.push(JSON.stringify(entry));
  }
  return { text: out.join('\n') + '\n', redactions };
}

function exportStringMapper(projectRoot) {
  const root = pathReplacer(path.resolve(projectRoot), ROOT_TOKEN);
  const home = pathReplacer(os.homedir(), HOME_TOKEN);
  return (s) => home(root(s));
}

function importStringMapper(projectRoot) {
  const root = pathReplacer(ROOT_TOKEN, path.resolve(projectRoot));
  const home = pathReplacer(HOME_TOKEN, os.homedir());
  return (s) => home(root(s));
}

async function walkFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await walkFiles(p)));
    else out.push(p);
  }
  return out;
}

async function copyTransformed(srcFile, destFile, mapper) {
  await fsp.mkdir(path.dirname(destFile), { recursive: true });
  if (srcFile.endsWith('.jsonl')) {
    const { text, redactions } = transformJsonl(await fsp.readFile(srcFile, 'utf8'), mapper);
    await fsp.writeFile(destFile, text);
    return redactions;
  }
  if (/\.(json|txt|md|log)$/i.test(srcFile)) {
    const raw = await fsp.readFile(srcFile, 'utf8');
    const mapped = mapper.mapString(raw);
    const r = mapper.redact ? redactSecrets(mapped) : { text: mapped, count: 0 };
    await fsp.writeFile(destFile, r.text);
    return r.count;
  }
  await fsp.copyFile(srcFile, destFile);
  return 0;
}

/**
 * Copy a local session (and its sidecar folder) into the repo's .gitclaudehub/sessions.
 * With `author`, prompts that aren't in the shared copy yet are tagged "[author] ".
 */
export async function exportSession({ id, projectRoot, repoRoot = projectRoot, sourceFile, author }) {
  const src = sourceFile || findLocalSessionFile(id, projectRoot);
  if (!src) throw new Error(`No local transcript found for session ${id}`);
  const destDir = sharedSessionDir(repoRoot);
  const dest = path.join(destDir, `${id}.jsonl`);
  const knownUuids = author ? sharedPromptAuthors(dest) : undefined;
  let redactions = await copyTransformed(src, dest, { mapString: exportStringMapper(projectRoot), redact: true, author, knownUuids });
  const mapper = { mapString: exportStringMapper(projectRoot), redact: true };
  const sidecar = src.slice(0, -'.jsonl'.length);
  for (const f of await walkFiles(sidecar)) {
    redactions += await copyTransformed(f, path.join(destDir, id, path.relative(sidecar, f)), mapper);
  }
  return { file: path.join(destDir, `${id}.jsonl`), redactions };
}

/** Install a shared session from the repo into the local Claude config so it can be resumed here. */
export async function importSession({ id, projectRoot, repoRoot = projectRoot }) {
  const srcDir = sharedSessionDir(repoRoot);
  const src = path.join(srcDir, `${id}.jsonl`);
  if (!fs.existsSync(src)) throw new Error(`Session ${id} is not in ${path.relative(process.cwd(), srcDir) || srcDir}`);
  const destDir = localSessionDir(projectRoot);
  const mapper = { mapString: importStringMapper(projectRoot), redact: false };
  await copyTransformed(src, path.join(destDir, `${id}.jsonl`), mapper);
  for (const f of await walkFiles(path.join(srcDir, id))) {
    await copyTransformed(f, path.join(destDir, id, path.relative(path.join(srcDir, id), f)), mapper);
  }
  return path.join(destDir, `${id}.jsonl`);
}

/** Session ids present in a JSONL file's entries (a resumed session may be written under a new id). */
export function readEntries(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

/** uuid → the name a shared entry's prompt is tagged with (null when untagged or not a prompt). */
function sharedPromptAuthors(file) {
  const out = new Map();
  for (const e of readEntries(file)) {
    if (!e.uuid) continue;
    const c = e.message?.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.find((b) => b?.type === 'text')?.text : null;
    const m = e.type === 'user' && typeof text === 'string' ? text.match(/^\[([^\]\n]{1,40})\]\s/) : null;
    out.set(e.uuid, m ? m[1] : null);
  }
  return out;
}

/** Message uuids in a transcript — used to detect two people extending the same session. */
export function entryUuids(file) {
  return new Set(readEntries(file).map((e) => e.uuid).filter(Boolean));
}
