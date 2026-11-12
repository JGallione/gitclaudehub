// End to end: a real site and a real host (with the stand-in agent and a local bare repo), driven
// over HTTP the way the browser does. Covers creating, joining, a turn with an approval, owner
// controls (lock, owner-only approvals, kick, new keys) and deleting the room.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { localSessionDir } from '../lib/sessions.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gch-test-')));
const PORT = 3200 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const env = {
  ...process.env,
  PORT: String(PORT),
  PREVIEW_PORT: String(PORT + 1),
  HOST: '127.0.0.1',
  DATA_DIR: path.join(tmp, 'data'),
  GITCLAUDEHUB_HOME: path.join(tmp, 'home'),
  GITCLAUDEHUB_AGENT_MODULE: path.join(ROOT, 'test/fake-agent.js'),
  // Defined-but-empty values keep the app's own .env from leaking into the test.
  GITHUB_REPO: '',
  ROOM_PASSWORD: '',
  GITHUB_TOKEN: '',
  CREATE_ROOM_CODE: '',
  PUBLIC_URL: '',
  PREVIEW_URL: '',
};
const children = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

after(() => {
  for (const c of children) c.kill('SIGKILL');
  const clone = path.join(tmp, 'clone');
  fs.rmSync(localSessionDir(clone), { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
});

function git(...args) {
  return execFileSync('git', ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.invalid', ...args], { encoding: 'utf8' });
}

function start(args, name) {
  const p = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  p.output = '';
  p.stdout.on('data', (d) => (p.output += d));
  p.stderr.on('data', (d) => (p.output += d));
  p.exited = new Promise((r) => p.on('exit', r));
  p.name = name;
  children.push(p);
  return p;
}

async function until(fn, what, timeout = 15_000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(100);
  }
}

class Browser {
  cookies = {};
  async req(method, p, body, base = BASE) {
    const res = await fetch(base + p, {
      method,
      redirect: 'manual',
      headers: { 'Content-Type': 'application/json', cookie: Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ') },
      body: body ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const kv = c.split(';')[0];
      const i = kv.indexOf('=');
      const [k, v] = [kv.slice(0, i), kv.slice(i + 1)];
      if (v) this.cookies[k] = v;
      else delete this.cookies[k];
    }
    const text = await res.text();
    let data = text;
    try {
      data = JSON.parse(text);
    } catch {}
    return { status: res.status, data, headers: res.headers };
  }
  get(p) {
    return this.req('GET', p);
  }
  post(p, body = {}) {
    return this.req('POST', p, body);
  }
  /** Listen to a room's live events. */
  async events(roomId) {
    const ctrl = new AbortController();
    const res = await fetch(`${BASE}/api/rooms/${roomId}/events`, { signal: ctrl.signal, headers: { cookie: Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ') } });
    const seen = [];
    (async () => {
      const dec = new TextDecoder();
      let buf = '';
      try {
        for await (const chunk of res.body) {
          buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const name = block.match(/^event: (.*)$/m)?.[1];
            const data = block.match(/^data: (.*)$/m)?.[1];
            if (name) seen.push({ name, data: JSON.parse(data) });
          }
        }
      } catch {}
    })();
    return {
      seen,
      wait: (name, pred = () => true, timeout) => until(() => seen.find((e) => e.name === name && pred(e.data))?.data, `event ${name}`, timeout),
      close: () => ctrl.abort(),
    };
  }
}

test('rooms: create, host, join, run a turn, moderate, delete', async () => {
  // A project repo with a static page to preview.
  const bare = path.join(tmp, 'project.git');
  git('init', '-q', '--bare', '-b', 'main', bare);
  const seed = path.join(tmp, 'seed');
  git('clone', '-q', bare, seed);
  fs.writeFileSync(path.join(seed, 'index.html'), '<h1>Hello from the project</h1>\n');
  fs.writeFileSync(path.join(seed, '.secret-note'), 'hidden\n');
  git('-C', seed, 'add', '-A');
  git('-C', seed, 'commit', '-q', '-m', 'Start');
  git('-C', seed, 'push', '-q', 'origin', 'main');

  const site = start(['server/index.js'], 'site');
  await until(() => site.output.includes('Site is open'), 'the site to start');

  // --- create -----------------------------------------------------------------
  const owner = new Browser();
  let r = await owner.post('/api/rooms', { name: 'Test room', repo: 'someone/project', yourName: 'Ana', ownerPassword: 'owner-pass', roomPassword: 'owner-pass' });
  assert.equal(r.status, 400, 'owner and room passwords must differ');
  r = await owner.post('/api/rooms', { name: 'Test room', repo: 'not a repo', yourName: 'Ana', ownerPassword: 'owner-pass', roomPassword: 'room-pass' });
  assert.equal(r.status, 400, 'repo must look like owner/name');
  r = await owner.post('/api/rooms', { name: 'Test room', repo: 'someone/project', yourName: 'Ana', ownerPassword: 'owner-pass', roomPassword: 'room-pass' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const { id, ownerKey, hostKey, invite } = r.data;
  r = await owner.get(`/api/rooms/${id}/state`);
  assert.equal(r.data.me.role, 'owner');
  assert.equal(r.data.host.online, false);
  assert.equal((await owner.get('/api/my-rooms')).data.rooms[0].id, id);

  // Nothing is visible without a link.
  const stranger = new Browser();
  assert.equal((await stranger.get(`/api/rooms/${id}/state`)).status, 401);
  assert.equal((await stranger.post(`/api/rooms/${id}/intro`, {})).data.name, null);

  // --- host -------------------------------------------------------------------
  const badHost = start(['cli/gitclaudehub.js', 'host', '--hub', BASE, '--room', id, '--key', 'wrong', '--repo-url', bare], 'bad host');
  await badHost.exited;
  assert.match(badHost.output, /rejected this host key/);

  const clone = path.join(tmp, 'clone');
  let host = start(['cli/gitclaudehub.js', 'host', '--hub', BASE, '--room', id, '--key', hostKey, '--repo-url', bare, '--dir', clone, '--preview', '.'], 'host');
  await until(async () => (await owner.get(`/api/rooms/${id}/state`)).data.host.online, 'the host to come online');
  const saved = path.join(tmp, 'home', 'hosts', `${id}.json`);
  assert.ok(fs.existsSync(saved), 'host settings are saved once the key is accepted');
  assert.equal(fs.statSync(saved).mode & 0o777, 0o600);

  // --- join -------------------------------------------------------------------
  const sam = new Browser();
  r = await sam.post(`/api/rooms/${id}/intro`, { invite });
  assert.equal(r.data.name, 'Test room');
  assert.equal((await sam.post(`/api/rooms/${id}/join`, { invite: 'nope', name: 'Sam', password: 'room-pass' })).status, 403);
  assert.equal((await sam.post(`/api/rooms/${id}/join`, { invite, name: 'Sam', password: 'wrong-pass' })).status, 401);
  assert.equal((await sam.post(`/api/rooms/${id}/join`, { invite, name: 'Ana', password: 'room-pass' })).status, 400, "can't take the owner's name");
  assert.equal((await sam.post(`/api/rooms/${id}/join`, { invite, name: 'Sam', password: 'room-pass' })).status, 200);
  assert.equal((await sam.get(`/api/rooms/${id}/admin`)).status, 403, 'members get no owner controls');

  // --- a turn, with an approval ----------------------------------------------
  const ev = await sam.events(id);
  r = await sam.post(`/api/rooms/${id}/prompt`, { prompt: 'write it down' });
  assert.equal(r.status, 200);
  const perm = await ev.wait('permission_request');
  assert.equal(perm.tool, 'Bash');
  assert.equal((await sam.post(`/api/rooms/${id}/permissions/${perm.id}`, { allow: true })).status, 200);
  const end = await ev.wait('turn_end');
  assert.equal(end.error, null);
  assert.ok(end.commit && end.pushed, 'the turn is committed and pushed');
  const log = git('--git-dir', bare, 'log', '-1', '--format=%an|%s');
  assert.equal(log.trim(), 'Sam|Sam: write it down');
  assert.match(git('--git-dir', bare, 'show', 'HEAD:NOTES.md'), /write it down/);
  const sid = end.sessionId;
  await until(async () => (await sam.get(`/api/rooms/${id}/state`)).data.index.sessions.some((s) => s.id === sid), 'the session list to update');
  r = await sam.get(`/api/rooms/${id}/sessions/${sid}`);
  assert.ok(r.data.items.some((it) => it.kind === 'prompt' && it.text === 'write it down'));

  // Files, diffs and the preview come from the host.
  assert.ok((await sam.get(`/api/rooms/${id}/files`)).data.files.includes('NOTES.md'));
  assert.match((await sam.get(`/api/rooms/${id}/commits/${end.commit}`)).data.text, /NOTES\.md/);
  const previewUrl = (await sam.get(`/api/rooms/${id}/state`)).data.previewUrl;
  assert.ok(previewUrl, 'the host offers a preview');
  const pv = new Browser();
  const u = new URL(previewUrl);
  const PREVIEW = `http://127.0.0.1:${PORT + 1}`;
  assert.equal((await pv.req('GET', '/', null, PREVIEW)).status, 401);
  assert.equal((await pv.req('GET', u.pathname + u.search, null, PREVIEW)).status, 302);
  r = await pv.req('GET', '/', null, PREVIEW);
  assert.match(r.data, /Hello from the project/);
  assert.match(r.headers.get('content-type'), /html/);
  assert.equal((await pv.req('GET', '/.secret-note', null, PREVIEW)).status, 404, 'dotfiles stay hidden');
  assert.equal((await pv.req('GET', '/../../etc/passwd', null, PREVIEW)).status, 404);

  // --- owner controls ----------------------------------------------------------
  r = await owner.post(`/api/rooms/${id}/admin/settings`, { locked: true });
  assert.equal(r.data.settings.locked, true);
  assert.equal((await sam.post(`/api/rooms/${id}/prompt`, { prompt: 'again' })).status, 403, 'a locked room only takes the owner');
  await owner.post(`/api/rooms/${id}/admin/settings`, { locked: false, ownerApprovals: true });

  r = await sam.post(`/api/rooms/${id}/prompt`, { prompt: 'second', sessionId: sid });
  assert.equal(r.status, 200);
  const perm2 = await ev.wait('permission_request', (p) => p.id !== perm.id);
  assert.equal((await sam.post(`/api/rooms/${id}/permissions/${perm2.id}`, { allow: true })).status, 403, 'only the owner approves now');
  assert.equal((await owner.post(`/api/rooms/${id}/permissions/${perm2.id}`, { allow: false })).status, 200);
  const end2 = await ev.wait('turn_end', (e) => e.jobId === r.data.jobId);
  assert.equal(end2.sessionId, sid, 'the turn continued the same session');

  // Kick: Sam's cookie stops working and their live stream ends.
  const samId = (await owner.get(`/api/rooms/${id}/admin`)).data.members.find((m) => m.name === 'Sam').id;
  assert.equal((await owner.post(`/api/rooms/${id}/admin/kick`, { memberId: samId })).status, 200);
  await ev.wait('kicked');
  assert.equal((await sam.get(`/api/rooms/${id}/state`)).status, 401);
  ev.close();

  // A new invite link: the old one stops working.
  const { invite: invite2 } = (await owner.post(`/api/rooms/${id}/admin/reset-invite`)).data;
  assert.equal((await sam.post(`/api/rooms/${id}/join`, { invite, name: 'Sam', password: 'room-pass' })).status, 403);
  assert.equal((await sam.post(`/api/rooms/${id}/join`, { invite: invite2, name: 'Sam', password: 'room-pass' })).status, 200);

  // Owner sign-in from another browser: owner link + owner password.
  const laptop = new Browser();
  assert.equal((await laptop.post(`/api/rooms/${id}/owner`, { ownerKey, name: 'Ana', password: 'room-pass' })).status, 401);
  assert.equal((await laptop.post(`/api/rooms/${id}/owner`, { ownerKey: 'nope', name: 'Ana', password: 'owner-pass' })).status, 403);
  assert.equal((await laptop.post(`/api/rooms/${id}/owner`, { ownerKey, name: 'Ana', password: 'owner-pass' })).status, 200);
  const { ownerKey: ownerKey2 } = (await laptop.post(`/api/rooms/${id}/admin/reset-owner-link`)).data;
  assert.equal((await new Browser().post(`/api/rooms/${id}/owner`, { ownerKey, name: 'Ana', password: 'owner-pass' })).status, 403, 'the old owner link stops working');
  assert.equal((await new Browser().post(`/api/rooms/${id}/owner`, { ownerKey: ownerKey2, name: 'Ana', password: 'owner-pass' })).status, 200);

  // A new host key disconnects the running host.
  await owner.post(`/api/rooms/${id}/admin/reset-host-key`);
  await host.exited;
  assert.match(host.output, /reset the host key/);
  assert.equal((await owner.get(`/api/rooms/${id}/state`)).data.host.online, false);

  // While the host is away: messages queue up, and history still opens from the site's copy.
  r = await sam.post(`/api/rooms/${id}/prompt`, { prompt: 'while away' });
  assert.equal(r.data.hostOnline, false);
  r = await sam.get(`/api/rooms/${id}/sessions/${sid}`);
  assert.equal(r.data.stale, true);

  // --- delete -----------------------------------------------------------------
  const { hostKey: hostKey2 } = (await owner.post(`/api/rooms/${id}/admin/reset-host-key`)).data;
  const ownerEv = await owner.events(id);
  host = start(['cli/gitclaudehub.js', 'host', '--room', id, '--key', hostKey2], 'host again');
  await until(async () => (await owner.get(`/api/rooms/${id}/state`)).data.host.online, 'the host to reconnect with saved settings');
  // The queued message runs once the host is back.
  const perm3 = await ownerEv.wait('permission_request', (p) => p.id !== perm2.id);
  await owner.post(`/api/rooms/${id}/permissions/${perm3.id}`, { allow: true });
  await until(() => git('--git-dir', bare, 'log', '-1', '--format=%s').includes('while away'), 'the queued turn to run', 20_000);
  ownerEv.close();
  assert.equal((await owner.post(`/api/rooms/${id}/admin/delete`, { confirm: 'wrong name' })).status, 400);
  assert.equal((await owner.post(`/api/rooms/${id}/admin/delete`, { confirm: 'Test room' })).status, 200);
  await host.exited;
  assert.match(host.output, /deleted this room/);
  assert.ok(!fs.existsSync(saved), "a deleted room's host settings are forgotten");
  assert.equal((await owner.get(`/api/rooms/${id}/state`)).status, 404);
  assert.ok(fs.existsSync(path.join(clone, 'NOTES.md')), 'the clone is left alone');
});
