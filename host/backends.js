// Which AI a room's turns run on. Every backend drives Claude Code itself (through the Agent SDK),
// so tools, approvals, transcripts and `claude --resume` work the same way for all of them:
//   claude  — this computer's Claude Code login, or ANTHROPIC_API_KEY if it's set
//   ollama  — a local model; Ollama 0.14.3+ speaks the Anthropic Messages API Claude Code uses

import fs from 'node:fs';

const MIN_OLLAMA = '0.14.3';

function olderThan(version, min) {
  const a = String(version).split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== b[i]) return (a[i] || 0) < b[i];
  return false;
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

/**
 * @param {{ollama?: string, ollamaUrl?: string, model?: string, context?: number}} o
 * @returns {Promise<{kind: 'claude'|'ollama', label: string, model?: string, env?: object, context?: number}>}
 */
export async function resolveBackend({ ollama, ollamaUrl, model, context } = {}) {
  if (!ollama) {
    const how = process.env.ANTHROPIC_API_KEY ? 'API key' : 'login';
    return { kind: 'claude', model: model || undefined, label: `Claude${model ? ` ${model}` : ''} · owner's ${how}` };
  }

  const base = (ollamaUrl || 'http://localhost:11434').replace(/\/+$/, '');
  let version;
  try {
    ({ version } = await getJson(`${base}/api/version`));
  } catch {
    throw new Error(`Can't reach Ollama at ${base}. Open the Ollama app (or run "ollama serve") and try again.`);
  }
  if (olderThan(version, MIN_OLLAMA)) {
    throw new Error(`Ollama ${version} is too old. gitclaudehub needs ${MIN_OLLAMA} or newer, the first versions that can run Claude Code's tools. Update Ollama and try again.`);
  }
  const { models = [] } = await getJson(`${base}/api/tags`);
  const names = models.map((m) => m.name);
  if (!names.includes(ollama) && !names.includes(`${ollama}:latest`)) {
    throw new Error(`Ollama doesn't have "${ollama}" yet. Run: ollama pull ${ollama}`);
  }

  // Point Claude Code at Ollama, and make every model it might ask for (including the small
  // one it uses for background chores like titles) the local one.
  const env = {
    ...process.env,
    ANTHROPIC_BASE_URL: base,
    ANTHROPIC_AUTH_TOKEN: 'ollama',
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_MODEL: ollama,
    ANTHROPIC_DEFAULT_OPUS_MODEL: ollama,
    ANTHROPIC_DEFAULT_SONNET_MODEL: ollama,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: ollama,
    ANTHROPIC_SMALL_FAST_MODEL: ollama,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
  return { kind: 'ollama', model: ollama, env, context: Number(context) || 32768, label: `Ollama · ${ollama}`, version };
}

/** Roughly how many tokens a resumed session sends with each request: the last turn's input + output. */
export function contextTokens(file) {
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  try {
    const len = Math.min(size, 4 * 1024 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"usage"')) continue;
      try {
        const u = JSON.parse(lines[i]).message?.usage;
        if (u) return (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0);
      } catch {
        // a line cut in half at the start of the window
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  return Math.round(size / 6); // no usage recorded: a rough guess from the transcript's size
}
