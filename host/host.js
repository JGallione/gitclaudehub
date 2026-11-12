// The host: runs on a room owner's computer, connects out to the gitclaudehub site, and runs the
// room's turns here, with the owner's own AI (Claude login, API key, or Ollama) and git access.
// The site only relays: it never sees a GitHub token or an AI key, and the owner needs no tunnel.

import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { Workspace } from './workspace.js';
import { Runner } from './runner.js';
import { resolveBackend } from './backends.js';
import { defaultCloneDir } from './saved.js';
import { readIndex } from '../lib/share.js';
import { sharedSessionDir, readEntries } from '../lib/sessions.js';
import { toDisplayItems } from '../lib/display.js';
import { APP_ROOT } from '../lib/env.js';

const VERSION = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version;

function wsUrl(hub) {
  const u = new URL('/host', hub);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.href;
}

/**
 * Host one room until it's deleted, the key is rejected, or stop() is called.
 * @param {object} cfg  {hub, roomId, key, dir?, repoUrl?, token?, approvals?, budget?, preview?, ollama?, ollamaUrl?, model?, context?, autoPush?}
 * @returns {Promise<{done: Promise<{ok: boolean, code: string, reason: string}>, stop: () => void, backend: object}>}
 */
export async function hostRoom(cfg, { log = console.log, onReady } = {}) {
  const backend = await resolveBackend(cfg);
  const approvals = cfg.approvals || 'ask-bash';
  let workspace = null;
  let runner = null;
  let sock = null;
  let attempts = 0;
  let stopped = false;
  let lastIndex = '';
  let heartbeat = null;
  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));

  const out = (msg) => {
    if (sock?.readyState === WebSocket.OPEN) sock.send(JSON.stringify(msg));
  };
  const send = (event, data) => {
    if (event === 'sessions') lastIndex = JSON.stringify(data);
    out({ type: 'event', event, data });
  };

  async function finish(code, reason, ok = false) {
    if (stopped) return;
    stopped = true;
    clearInterval(syncTimer);
    clearTimeout(heartbeat);
    // Let a running turn stop and save its work (commit + push) before reporting back.
    if (runner?.current) {
      runner.interrupt('gitclaudehub (the host stopped)');
      for (let waited = 0; runner.current && waited < 60_000; waited += 200) await new Promise((r) => setTimeout(r, 200));
    }
    sock?.close(1000);
    resolveDone({ ok, code, reason });
  }

  async function welcome(room) {
    if (!workspace) {
      const repoUrl = cfg.repoUrl || (room.repo ? `https://github.com/${room.repo}.git` : '');
      workspace = new Workspace({ dir: cfg.dir || defaultCloneDir(room.id), repoUrl, token: cfg.token, autoPush: cfg.autoPush !== false });
      log(`Preparing the room's clone at ${workspace.dir} …`);
      await workspace.init();
      await workspace.sync();
      runner = new Runner({ workspace, send, backend, approvalMode: approvals, maxBudgetUsd: cfg.budget });
    }
    out({ type: 'ready', branch: await workspace.currentBranch(), preview: !!cfg.preview });
    send('sessions', readIndex(workspace.dir));
    log(`Hosting “${room.name}” with ${backend.label}. Keep this running while friends use the room.`);
    onReady?.({ room, dir: workspace.dir });
  }

  async function rpc({ id, method, params = {} }) {
    try {
      if (!workspace) throw new Error('The host is still starting.');
      let result;
      switch (method) {
        case 'session': {
          const sid = String(params.id || '');
          if (!/^[A-Za-z0-9-]{8,64}$/.test(sid)) throw new Error('Bad session id');
          const file = path.join(sharedSessionDir(workspace.dir), `${sid}.jsonl`);
          if (!fs.existsSync(file)) throw new Error('Session not found');
          const meta = readIndex(workspace.dir).sessions.find((s) => s.id === sid) || { id: sid };
          result = { meta, items: toDisplayItems(readEntries(file), { owner: meta.owner }) };
          break;
        }
        case 'files':
          result = { files: await workspace.files() };
          break;
        case 'file':
          result = await workspace.readFile(String(params.path || ''));
          break;
        case 'commits':
          result = { commits: await workspace.log(40) };
          break;
        case 'commit':
          result = { text: await workspace.show(String(params.sha || '')) };
          break;
        case 'preview':
          result = cfg.preview ? workspace.previewFile(cfg.preview, String(params.path || '/')) : { status: 404 };
          break;
        default:
          throw new Error(`Unknown request "${method}"`);
      }
      out({ type: 'rpc_result', id, ok: true, result });
    } catch (err) {
      out({ type: 'rpc_result', id, ok: false, error: err.message });
    }
  }

  async function onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.type) {
      case 'welcome':
        attempts = 0;
        try {
          await welcome(msg.room);
        } catch (err) {
          out({ type: 'fatal', message: err.message });
          finish('setup_failed', err.message);
        }
        break;
      case 'job':
        if (runner) runner.run(msg.job);
        else {
          send('turn_error', { jobId: msg.job.id, message: 'The host is still starting.' });
          send('job_done', { jobId: msg.job.id });
        }
        break;
      case 'interrupt':
        runner?.interrupt(msg.by);
        break;
      case 'permission_answer':
        runner?.answerPermission(msg.id, { allow: !!msg.allow, allowRest: !!msg.allowRest, by: msg.by });
        break;
      case 'rpc':
        rpc(msg);
        break;
      case 'deleted':
        finish('deleted', 'The owner deleted this room on the site. The clone and the GitHub repo are untouched.', true);
        break;
    }
  }

  // The site pings every 25s; if the pings stop, the connection is dead even if the socket hasn't noticed.
  const alive = () => {
    clearTimeout(heartbeat);
    heartbeat = setTimeout(() => sock?.terminate(), 75_000);
  };

  function connect() {
    if (stopped) return;
    sock = new WebSocket(wsUrl(cfg.hub), { maxPayload: 64 * 1024 * 1024, handshakeTimeout: 15_000 });
    sock.on('open', () => {
      alive();
      out({ type: 'hello', roomId: cfg.roomId, key: cfg.key, backend: backend.label, approvalMode: approvals, version: VERSION });
    });
    sock.on('ping', alive);
    sock.on('message', (data) => onMessage(data.toString()));
    sock.on('error', (err) => !stopped && attempts < 2 && log(`Connection problem: ${err.message}`));
    sock.on('close', (code, reason) => {
      clearTimeout(heartbeat);
      if (runner?.current) runner.interrupt('gitclaudehub (the connection to the site dropped)');
      if (stopped) return;
      const why = reason.toString();
      if (code === 4401) return finish('bad_key', why || 'The site rejected the host key.');
      if (code === 4404) return finish('gone', why || 'This room no longer exists on the site.');
      if (code === 4409) return finish('replaced', 'Another host connected to this room, so this one stopped.');
      const wait = Math.min(30, 2 ** Math.min(attempts++, 5));
      log(`Lost the connection to the site${why ? ` (${why})` : ''}. Trying again in ${wait}s …`);
      setTimeout(connect, wait * 1000);
    });
  }

  // While the room is idle, pick up sessions and code that people pushed from their terminals.
  const syncTimer = setInterval(async () => {
    if (!workspace || runner?.current || sock?.readyState !== WebSocket.OPEN) return;
    try {
      await workspace.sync();
    } catch (err) {
      return log(`Background pull failed: ${err.message}`);
    }
    const index = readIndex(workspace.dir);
    if (JSON.stringify(index) !== lastIndex) send('sessions', index);
  }, (Number(cfg.syncSeconds) || 30) * 1000);

  connect();
  return { done, stop: () => finish('stopped', 'Stopped.', true), backend };
}
