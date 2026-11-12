import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitclaudehub-test-'));
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
const { exportSession, importSession, localSessionDir, redactSecrets, ROOT_TOKEN, readEntries } = await import('../lib/sessions.js');
const { toDisplayItems, deriveTitle } = await import('../lib/display.js');

const ID = '11111111-2222-3333-4444-555555555555';
const alice = path.join(tmp, 'alice', 'proj');
const bob = path.join(tmp, 'bob', 'code', 'proj');
const fakeKey = 'sk-ant-api03-' + 'x'.repeat(40);

function writeSession() {
  const lines = [
    { type: 'user', uuid: 'u1', parentUuid: null, sessionId: ID, cwd: alice, message: { role: 'user', content: `Build a todo app. My key is ${fakeKey}` } },
    { type: 'assistant', uuid: 'a0', parentUuid: 'u1', sessionId: ID, cwd: alice, message: { role: 'assistant', content: [{ type: 'thinking', thinking: `user pasted ${fakeKey}`, signature: 'sig0' }] } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'a0', sessionId: ID, cwd: alice, message: { role: 'assistant', content: [{ type: 'thinking', thinking: `look in ${alice}/src`, signature: 'sig1' }, { type: 'tool_use', id: 't1', name: 'Write', input: { file_path: `${alice}/src/app.js`, content: 'x' } }] } },
    { type: 'user', uuid: 'u2', parentUuid: 'a1', sessionId: ID, cwd: alice, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: `Wrote ${alice}/src/app.js. Not ${alice}2/other` }] } },
    { type: 'assistant', uuid: 'a2', parentUuid: 'u2', sessionId: ID, cwd: alice, message: { role: 'assistant', content: [{ type: 'text', text: 'Done! Set OPENAI_API_KEY=abcd1234efgh5678 in .env' }] } },
    { type: 'artifact-autoreact-ledger', accountUuid: 'acct', sessionId: ID },
  ];
  const dir = localSessionDir(alice);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${ID}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.mkdirSync(path.join(dir, ID, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(dir, ID, 'subagents', 'agent-1.jsonl'), JSON.stringify({ type: 'user', uuid: 's1', cwd: alice, message: { role: 'user', content: 'sub' } }) + '\n');
}

test('redactSecrets catches common token shapes and leaves code alone', () => {
  assert.equal(redactSecrets(`key ${fakeKey} end`).text, 'key [REDACTED] end');
  assert.equal(redactSecrets('GITHUB_TOKEN=ghp_' + 'a'.repeat(36)).count, 1);
  assert.equal(redactSecrets('DB_PASSWORD="hunter2hunter2"').text, 'DB_PASSWORD="[REDACTED]"');
  assert.equal(redactSecrets('const API_KEY = process.env.API_KEY').count, 0);
  assert.equal(redactSecrets('nothing to see').count, 0);
});

test('export rewrites paths, redacts secrets, keeps thinking intact, relinks dropped entries', async () => {
  writeSession();
  const repo = path.join(tmp, 'repo');
  const { file, redactions } = await exportSession({ id: ID, projectRoot: alice, repoRoot: repo });
  const raw = fs.readFileSync(file, 'utf8');
  // Only the signed thinking block may still hold the original path.
  assert.equal(raw.split(alice + '/').length - 1, 1, 'absolute project path removed outside thinking');
  assert.ok(raw.includes(`${ROOT_TOKEN}/src/app.js`));
  assert.ok(raw.includes(`${alice}2/other`), 'sibling path with same prefix untouched');
  assert.ok(!raw.includes(fakeKey), 'secret removed');
  assert.ok(!raw.includes('abcd1234efgh5678'), 'env secret removed');
  assert.ok(!raw.includes('accountUuid'), 'account entry dropped');
  assert.ok(redactions >= 3);

  const entries = readEntries(file);
  assert.equal(entries.find((e) => e.uuid === 'a0'), undefined, 'thinking-only entry with a secret dropped');
  assert.equal(entries.find((e) => e.uuid === 'a1').parentUuid, 'u1', 'child relinked to grandparent');
  const think = entries.find((e) => e.uuid === 'a1').message.content[0];
  assert.equal(think.thinking, `look in ${alice}/src`, 'thinking text not modified (signature stays valid)');
  assert.equal(think.signature, 'sig1');
  assert.ok(fs.existsSync(path.join(repo, '.gitclaudehub/sessions', ID, 'subagents', 'agent-1.jsonl')));
});

test('import puts the session under the new project path', async () => {
  const repo = path.join(tmp, 'repo');
  const dest = await importSession({ id: ID, projectRoot: bob, repoRoot: repo });
  assert.equal(path.dirname(dest), localSessionDir(bob));
  const raw = fs.readFileSync(dest, 'utf8');
  assert.ok(raw.includes(`${bob}/src/app.js`));
  assert.ok(!raw.includes(ROOT_TOKEN));
  assert.equal(readEntries(dest)[0].cwd, bob);
});

test('export tags only new prompts with the pusher, leaving tool results and old turns alone', async () => {
  const repo = path.join(tmp, 'repo-tag');
  await exportSession({ id: ID, projectRoot: alice, repoRoot: repo, author: 'Alice' });
  const file = path.join(repo, '.gitclaudehub/sessions', `${ID}.jsonl`);
  let entries = readEntries(file);
  assert.match(entries.find((e) => e.uuid === 'u1').message.content, /^\[Alice\] Build a todo app/);
  assert.equal(entries.find((e) => e.uuid === 'u2').message.content[0].type, 'tool_result');

  // Bob continues the session locally and pushes: only his new prompt gets his name.
  const local = path.join(localSessionDir(alice), `${ID}.jsonl`);
  fs.appendFileSync(local, JSON.stringify({ type: 'user', uuid: 'u3', parentUuid: 'a2', sessionId: ID, message: { role: 'user', content: [{ type: 'text', text: 'add a footer' }] } }) + '\n');
  await exportSession({ id: ID, projectRoot: alice, repoRoot: repo, author: 'Bob' });
  entries = readEntries(file);
  assert.match(entries.find((e) => e.uuid === 'u1').message.content, /^\[Alice\] /);
  assert.equal(entries.find((e) => e.uuid === 'u3').message.content[0].text, '[Bob] add a footer');
});

test('display items: prompts with authors, tool cards, results, titles', () => {
  const entries = [
    { type: 'user', uuid: 'x1', message: { role: 'user', content: '[Sam] add dark mode' } },
    { type: 'user', uuid: 'x2', message: { role: 'user', content: '<command-name>/clear</command-name>' } },
    { type: 'assistant', uuid: 'x3', message: { content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'user', uuid: 'x4', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'ok' }] }] } },
    { type: 'user', uuid: 'x5', isSidechain: true, message: { content: 'hidden' } },
  ];
  const items = toDisplayItems(entries, { owner: 'Joe' });
  assert.deepEqual(items.map((i) => i.kind), ['prompt', 'note', 'tool', 'result']);
  assert.equal(items[0].author, 'Sam');
  assert.equal(items[0].text, 'add dark mode');
  assert.equal(items[2].summary, 'npm test');
  assert.equal(items[3].text, 'ok');
  assert.equal(deriveTitle(entries), 'add dark mode');
  assert.equal(toDisplayItems([{ type: 'user', message: { content: 'hi' } }], { owner: 'Joe' })[0].author, 'Joe');
});
