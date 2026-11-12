// Turns Claude Code transcript entries (from a .jsonl file or live Agent SDK
// messages — they share a shape) into a compact list of items for the web UI.

import { ROOT_TOKEN, HOME_TOKEN } from './sessions.js';

const MAX_RESULT = 6000;
const MAX_INPUT = 4000;
const AUTHOR_PREFIX = /^\[([^\]\n]{1,40})\]\s+/;

function clip(s, n) {
  if (typeof s !== 'string') s = s == null ? '' : String(s);
  return s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more characters)` : s;
}

function tidyPath(p, root) {
  if (typeof p !== 'string') return '';
  let s = p.split(ROOT_TOKEN + '/').join('').split(ROOT_TOKEN).join('.');
  s = s.split(HOME_TOKEN).join('~');
  if (root) s = s.split(root + '/').join('');
  return s;
}

function stripReminders(text) {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
    .trim();
}

export function toolSummary(name, input = {}, root) {
  const i = input || {};
  switch (name) {
    case 'Bash':
      return i.command || '';
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return tidyPath(i.file_path || i.notebook_path, root);
    case 'Glob':
      return i.pattern || '';
    case 'Grep':
      return `${i.pattern || ''}${i.path ? ` in ${tidyPath(i.path, root)}` : ''}`;
    case 'WebFetch':
      return i.url || '';
    case 'WebSearch':
      return i.query || '';
    case 'Task':
    case 'Agent':
      return i.description || '';
    case 'TodoWrite':
      return `${(i.todos || []).length} to-dos`;
    default: {
      const first = Object.values(i).find((v) => typeof v === 'string');
      return first ? clip(first, 120) : '';
    }
  }
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
  return content
    .map((b) => (b?.type === 'text' ? b.text : b?.type === 'image' ? '[image]' : JSON.stringify(b)))
    .join('\n');
}

function promptItem(base, text, owner) {
  const m = text.match(AUTHOR_PREFIX);
  return { ...base, kind: 'prompt', author: m ? m[1] : owner || 'owner', text: m ? text.slice(m[0].length) : text };
}

/**
 * @param {object[]} entries transcript entries or SDK messages
 * @param {{owner?: string, root?: string}} opts owner = who to credit for un-tagged prompts
 */
export function toDisplayItems(entries, { owner, root } = {}) {
  const items = [];
  for (const e of entries) {
    if (!e || e.isSidechain || e.parent_tool_use_id) continue;
    const base = { uuid: e.uuid, ts: e.timestamp };

    if (e.type === 'system' && (e.subtype === 'compact_boundary' || e.compactMetadata)) {
      items.push({ ...base, kind: 'note', text: 'Earlier conversation was compacted to save context.' });
      continue;
    }
    if (e.type !== 'user' && e.type !== 'assistant') continue;
    if (e.isMeta || e.isVisibleInTranscriptOnly) continue;
    const content = e.message?.content;

    if (e.type === 'user') {
      if (e.isCompactSummary) {
        items.push({ ...base, kind: 'note', text: 'Session resumed from a compacted summary.' });
        continue;
      }
      const texts = [];
      const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content || [];
      for (const b of blocks) {
        if (b?.type === 'tool_result') {
          items.push({
            ...base,
            kind: 'result',
            id: b.tool_use_id,
            isError: !!b.is_error,
            text: clip(tidyPath(resultText(b.content), root), MAX_RESULT),
          });
        } else if (b?.type === 'text') texts.push(b.text);
        else if (b?.type === 'image') texts.push('[image]');
      }
      const raw = texts.join('\n');
      if (!raw) continue;
      const cmd = raw.match(/<command-name>([^<]*)<\/command-name>/);
      if (cmd) {
        const args = raw.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim();
        items.push({ ...base, kind: 'note', text: `${cmd[1].startsWith('/') ? '' : '/'}${cmd[1]}${args ? ' ' + args : ''}` });
        continue;
      }
      if (/^<(local-command-stdout|local-command-stderr|bash-stdout|bash-stderr)>/.test(raw)) continue;
      const text = stripReminders(raw);
      if (text) items.push(promptItem(base, text, owner));
      continue;
    }

    // assistant
    for (const b of Array.isArray(content) ? content : []) {
      // Claude sometimes copies the "[Name] " tag the app puts on user messages; drop it.
      if (b?.type === 'text' && b.text?.trim()) items.push({ ...base, kind: 'text', text: tidyPath(b.text.replace(AUTHOR_PREFIX, ''), root) });
      else if (b?.type === 'thinking' && b.thinking?.trim()) items.push({ ...base, kind: 'thinking', text: clip(b.thinking, MAX_RESULT) });
      else if (b?.type === 'tool_use') {
        items.push({
          ...base,
          kind: 'tool',
          id: b.id,
          name: b.name,
          summary: clip(toolSummary(b.name, b.input, root), 300),
          input: clip(tidyPath(JSON.stringify(b.input, null, 2), root), MAX_INPUT),
        });
      }
    }
  }
  return items;
}

/** Title for a session: its custom title, a summary entry, or its first prompt. */
export function deriveTitle(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === 'custom-title' && e.customTitle) return e.customTitle;
  }
  const summary = entries.find((e) => e.type === 'summary' && e.summary);
  if (summary) return summary.summary;
  const first = toDisplayItems(entries).find((i) => i.kind === 'prompt');
  if (!first) return 'Untitled session';
  const t = first.text.replace(/\s+/g, ' ').trim();
  return t.length > 70 ? t.slice(0, 67) + '…' : t;
}

export function countPrompts(entries) {
  return toDisplayItems(entries).filter((i) => i.kind === 'prompt').length;
}
