// Runs one Claude Code turn at a time on the room owner's computer, reports it to the
// gitclaudehub site as it happens, then saves the transcript + code back to the repo.
// The site keeps the queue; it hands the host one job at a time.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { exportSession, importSession, sharedSessionDir, findLocalSessionFile } from '../lib/sessions.js';
import { upsertSession, readIndex, ensureShareReadme } from '../lib/share.js';
import { toDisplayItems, toolSummary } from '../lib/display.js';
import { contextTokens } from './backends.js';

const PERMISSION_TIMEOUT_MS = 10 * 60 * 1000;

// GITCLAUDEHUB_AGENT_MODULE swaps in a stand-in agent for tests (see test/fake-agent.js).
const { query } = process.env.GITCLAUDEHUB_AGENT_MODULE
  ? await import(pathToFileURL(path.resolve(process.env.GITCLAUDEHUB_AGENT_MODULE)).href)
  : await import('@anthropic-ai/claude-agent-sdk');

const COLLAB_PROMPT = `You are working in a shared session: several people take turns talking to you about this project through a web app called gitclaudehub.
Each user message starts with the sender's name in square brackets, like "[Sam] add a dark mode". That tag is added by the app; never start your own replies with a bracketed name. Address people by name when it helps, and keep in mind that requests may come from different people with different context.
Your file changes are committed and pushed to the project's GitHub repo after every turn, so keep the project in a working state at the end of each turn.
You can't ask multiple-choice questions here; if you need input, ask in plain text and end your turn.
Some tool calls (such as shell commands) wait for someone in the room to approve them.`;

export class Runner {
  /**
   * @param {object} o
   * @param {import('./workspace.js').Workspace} o.workspace
   * @param {(event: string, data: object) => void} o.send  reports to the site
   * @param {{kind: string, model?: string, env?: object, context?: number}} o.backend
   * @param {'ask-bash'|'ask-all'|'auto'} o.approvalMode
   * @param {number} [o.maxBudgetUsd]
   */
  constructor({ workspace, send, backend, approvalMode, maxBudgetUsd }) {
    this.ws = workspace;
    this.send = send;
    this.backend = backend;
    this.approvalMode = approvalMode;
    this.maxBudgetUsd = maxBudgetUsd;
    this.current = null;
    this.permissions = new Map();
  }

  /** Run one job to the end. Never throws; failures are reported to the room. */
  async run(job) {
    if (this.current) {
      this.send('turn_error', { jobId: job.id, sessionId: job.sessionId, message: 'The host is still busy with another turn.' });
      return this.send('job_done', { jobId: job.id });
    }
    this.current = job;
    job.startedAt = new Date().toISOString();
    try {
      await this.runJob(job);
    } catch (err) {
      console.error('[gitclaudehub] turn failed:', err.message);
      this.send('turn_error', { jobId: job.id, sessionId: job.liveSessionId || job.sessionId, message: err.message });
    } finally {
      for (const p of this.permissions.values()) p.resolve({ allow: false, by: 'gitclaudehub', reason: 'turn ended' });
      this.current = null;
      this.send('job_done', { jobId: job.id });
    }
  }

  async interrupt(by) {
    const job = this.current;
    if (!job) return false;
    job.stoppedBy = by;
    for (const p of this.permissions.values()) p.resolve({ allow: false, by, reason: 'stopped' });
    try {
      await job.q?.interrupt();
    } catch {
      job.abort?.abort();
    }
    return true;
  }

  answerPermission(id, { allow, by, allowRest }) {
    const p = this.permissions.get(id);
    if (!p) return false;
    if (allow && allowRest && this.current) this.current.allowAll = true;
    p.resolve({ allow, by });
    return true;
  }

  setPhase(job, phase) {
    job.phase = phase;
    this.send('phase', { jobId: job.id, phase });
  }

  async canUseTool(job, toolName, input, { signal, decisionReason }) {
    if (job.allowAll) return { behavior: 'allow', updatedInput: input };
    const id = crypto.randomUUID();
    const decision = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ allow: false, by: 'gitclaudehub', reason: 'nobody answered in 10 minutes' }), PERMISSION_TIMEOUT_MS);
      const done = (d) => {
        clearTimeout(timer);
        this.permissions.delete(id);
        resolve(d);
      };
      signal?.addEventListener('abort', () => done({ allow: false, by: 'gitclaudehub', reason: 'cancelled' }), { once: true });
      const pub = {
        id,
        jobId: job.id,
        sessionId: job.liveSessionId || job.sessionId,
        tool: toolName,
        summary: toolSummary(toolName, input, this.ws.dir),
        input: JSON.stringify(input, null, 2).slice(0, 4000),
        reason: decisionReason || '',
        requestedBy: job.author,
        at: new Date().toISOString(),
      };
      this.permissions.set(id, { resolve: done, public: pub });
      this.send('permission_request', pub);
    });
    this.send('permission_resolved', { id, allow: decision.allow, by: decision.by, reason: decision.reason });
    if (decision.allow) return { behavior: 'allow', updatedInput: input };
    const why = decision.reason ? ` (${decision.reason})` : '';
    return { behavior: 'deny', message: `${decision.by} declined this${why}. Try another approach or ask the room.` };
  }

  async runJob(job) {
    const { ws, backend } = this;
    this.setPhase(job, 'syncing');
    await ws.sync();

    const room = { jobId: job.id, author: job.author };
    if (job.sessionId) {
      if (!fs.existsSync(path.join(sharedSessionDir(ws.dir), `${job.sessionId}.jsonl`))) {
        throw new Error('That session is no longer in the repo. Someone may have removed it.');
      }
      const installed = await importSession({ id: job.sessionId, projectRoot: ws.dir });
      job.baselineSize = fs.statSync(installed).size;
      // A local model can't take a conversation longer than its context window; say so instead of failing oddly.
      if (backend.context) {
        const used = contextTokens(installed);
        if (used > backend.context * 0.8) {
          throw new Error(
            `This session is about ${Math.round(used / 1000)}K tokens long, more than ${backend.model} can read at once (${Math.round(backend.context / 1000)}K). Start a new session in this room instead.`
          );
        }
      }
    }
    job.liveSessionId = job.sessionId;
    this.send('turn_start', { ...room, sessionId: job.sessionId, prompt: job.prompt, at: job.startedAt });

    const mode = this.approvalMode;
    job.abort = new AbortController();
    const options = {
      cwd: ws.dir,
      abortController: job.abort,
      resume: job.sessionId || undefined,
      model: backend.model,
      env: backend.env,
      maxBudgetUsd: backend.kind === 'claude' ? this.maxBudgetUsd : undefined,
      includePartialMessages: true,
      settingSources: ['project'],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: COLLAB_PROMPT },
      disallowedTools: ['AskUserQuestion'],
      permissionMode: mode === 'auto' ? 'bypassPermissions' : mode === 'ask-all' ? 'default' : 'acceptEdits',
      allowDangerouslySkipPermissions: mode === 'auto',
      canUseTool: mode === 'auto' ? undefined : (name, input, opts) => this.canUseTool(job, name, input, opts),
      stderr: (d) => process.env.GITCLAUDEHUB_DEBUG && process.stderr.write(d),
    };

    this.setPhase(job, 'running');
    const prompt = `[${job.author}] ${job.prompt}`;
    let result = null;
    let runError = null;
    try {
      job.q = query({ prompt, options });
      for await (const msg of job.q) {
        if (msg.session_id && msg.session_id !== job.liveSessionId) {
          job.liveSessionId = msg.session_id;
          this.send('session_id', { ...room, previous: job.sessionId, sessionId: msg.session_id });
        }
        if (msg.type === 'stream_event') {
          const ev = msg.event;
          if (!msg.parent_tool_use_id && ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
            this.send('delta', { ...room, sessionId: job.liveSessionId, text: ev.delta.text });
          }
        } else if (msg.type === 'assistant' || msg.type === 'user') {
          const items = toDisplayItems([msg], { root: ws.dir });
          if (items.length) this.send('items', { ...room, sessionId: job.liveSessionId, items });
        } else if (msg.type === 'result') {
          result = msg;
        }
      }
    } catch (err) {
      runError = err;
    }

    // Save whatever happened — even a stopped or failed turn may have changed files.
    this.setPhase(job, 'saving');
    const id = job.liveSessionId;
    let meta = null;
    const localFile = id && findLocalSessionFile(id, ws.dir);
    // A turn that failed before Claude wrote anything leaves the transcript as it was.
    const transcriptChanged = localFile && (id !== job.sessionId || fs.statSync(localFile).size !== job.baselineSize);
    if (transcriptChanged) {
      await exportSession({ id, projectRoot: ws.dir });
      ensureShareReadme(ws.dir);
      meta = upsertSession(ws.dir, {
        id,
        owner: job.author,
        contributor: job.author,
        source: 'web',
        replaces: job.sessionId && job.sessionId !== id ? job.sessionId : undefined,
      });
    }
    const subject = `${job.author}: ${job.prompt.replace(/\s+/g, ' ').slice(0, 64)}${job.prompt.length > 64 ? '…' : ''}`;
    const sha = await ws.commitAll(subject, `Claude Code turn in shared session ${id || '(none)'}, via gitclaudehub.`, job.author);
    let push = { pushed: false };
    try {
      push = await ws.push();
    } catch (err) {
      push = { pushed: false, warning: `Saved locally but couldn't push to GitHub: ${err.message}` };
    }

    const stopped = !!job.stoppedBy;
    this.send('turn_end', {
      ...room,
      sessionId: id,
      previous: job.sessionId,
      session: meta,
      commit: sha,
      pushed: push.pushed,
      warning: push.warning,
      stoppedBy: job.stoppedBy,
      error: runError && !stopped ? runError.message : result?.is_error ? result.subtype : null,
      // Local models are free; the SDK's estimate would be priced as if they were Claude.
      costUsd: backend.kind === 'claude' ? result?.total_cost_usd : undefined,
      durationMs: result?.duration_ms,
    });
    this.send('sessions', readIndex(ws.dir));
  }
}
