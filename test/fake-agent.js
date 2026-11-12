// A stand-in for the Agent SDK's query(), used to test gitclaudehub without API calls.
// Start the server with GITCLAUDEHUB_AGENT_MODULE=./test/fake-agent.js to use it.
// It mimics the real thing closely enough to exercise the whole pipeline:
// streamed text, a Bash call that needs approval, a file write, and a transcript
// written where Claude Code keeps it (so resume, export and commit all run for real).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { localSessionDir } from '../lib/sessions.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function query({ prompt, options }) {
  const { cwd, resume, canUseTool } = options;
  let interrupted = false;
  const sessionId = resume || crypto.randomUUID();
  const file = path.join(localSessionDir(cwd), `${sessionId}.jsonl`);

  let last = null;
  const write = (entry) => {
    const e = { parentUuid: last, isSidechain: false, userType: 'external', cwd, sessionId, version: 'fake', uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), ...entry };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(e) + '\n');
    last = e.uuid;
    return e;
  };

  async function* run() {
    if (resume) {
      if (!fs.existsSync(file)) {
        yield { type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sessionId, errors: [`No conversation found with session ID: ${sessionId}`] };
        return;
      }
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
      last = JSON.parse(lines.at(-1)).uuid ?? null;
    }
    yield { type: 'system', subtype: 'init', session_id: sessionId, cwd };
    write({ type: 'user', message: { role: 'user', content: prompt } });

    const intro = 'Sure, let me look at the project first.';
    for (const word of intro.split(/(?<= )/)) {
      if (interrupted) break;
      yield { type: 'stream_event', session_id: sessionId, parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: word } } };
      await sleep(40);
    }
    const a1 = write({ type: 'assistant', message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: intro }] } });
    yield { ...a1, session_id: sessionId, parent_tool_use_id: null };

    // A shell command that needs someone in the room to approve it.
    const toolId = 'toolu_' + crypto.randomBytes(6).toString('hex');
    const a2 = write({ type: 'assistant', message: { id: 'msg_2', role: 'assistant', content: [{ type: 'tool_use', id: toolId, name: 'Bash', input: { command: 'ls -1', description: 'List files' } }] } });
    yield { ...a2, session_id: sessionId, parent_tool_use_id: null };
    const ac = new AbortController();
    const decision = canUseTool ? await canUseTool('Bash', { command: 'ls -1', description: 'List files' }, { signal: ac.signal }) : { behavior: 'allow' };
    const out = decision.behavior === 'allow' ? fs.readdirSync(cwd).filter((f) => f !== '.git').join('\n') : decision.message;
    const u1 = write({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: out, is_error: decision.behavior !== 'allow' }] } });
    yield { ...u1, session_id: sessionId, parent_tool_use_id: null };
    if (interrupted) return yield { type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sessionId };

    // An edit (auto-approved in the default mode).
    const writeId = 'toolu_' + crypto.randomBytes(6).toString('hex');
    const notes = path.join(cwd, 'NOTES.md');
    const a3 = write({ type: 'assistant', message: { id: 'msg_3', role: 'assistant', content: [{ type: 'tool_use', id: writeId, name: 'Edit', input: { file_path: notes, old_string: '', new_string: `- ${prompt}` } }] } });
    yield { ...a3, session_id: sessionId, parent_tool_use_id: null };
    fs.appendFileSync(notes, `- ${prompt.replace(/^\[[^\]]+\]\s*/, '')}\n`);
    const u2 = write({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: writeId, content: `The file ${notes} has been updated.` }] } });
    yield { ...u2, session_id: sessionId, parent_tool_use_id: null };

    const done = `Done. I added your request to **NOTES.md**.\n\n| Step | Result |\n|---|---|\n| Listed files | ${decision.behavior === 'allow' ? 'yes' : 'denied'} |\n| Updated notes | yes |`;
    const a4 = write({ type: 'assistant', message: { id: 'msg_4', role: 'assistant', content: [{ type: 'text', text: done }] } });
    yield { ...a4, session_id: sessionId, parent_tool_use_id: null };
    yield { type: 'result', subtype: 'success', is_error: false, session_id: sessionId, total_cost_usd: 0, duration_ms: 1500, result: done };
  }

  const gen = run();
  gen.interrupt = async () => {
    interrupted = true;
  };
  return gen;
}
