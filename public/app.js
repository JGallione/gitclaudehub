// gitclaudehub web client — plain DOM, no build step.
//   /                  the lobby: your rooms, and a form to create one
//   /r/<id>            a room (join with #invite=<code>)
//   /r/<id>/own        owner sign-in (#key=<owner key>)

const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'value') n.value = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null) n.append(kid);
  return n;
};

const route = (() => {
  const m = location.pathname.match(/^\/r\/([a-z0-9]{4,32})(\/own)?\/?$/);
  return m ? { roomId: m[1], own: !!m[2] } : { roomId: null, own: false };
})();
const hashParams = new URLSearchParams(location.hash.slice(1));

const state = {
  me: null, // my name in this room
  myId: null,
  role: 'member',
  room: { settings: {} },
  host: { online: false },
  index: { sessions: [] },
  runner: { current: null, queue: [], permissions: [] },
  online: [],
  previewUrl: null,
  install: null, // how to get the gitclaudehub command, e.g. "npm install -g github:owner/repo"
  view: null, // session id, or null for a new-session draft
  pendingNewJob: null, // job id of a new session I started, to follow it
  liveText: null,
  toolEls: new Map(),
  es: null,
  leaving: false,
};
const isOwner = () => state.role === 'owner';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const isJson = res.headers.get('content-type')?.includes('json');
  const data = isJson ? await res.json() : await res.text();
  if (!res.ok) throw Object.assign(new Error(data?.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}
const rapi = (path, opts) => api(`/rooms/${route.roomId}${path}`, opts);
const post = (path, body = {}) => rapi(path, { method: 'POST', body });

function toast(text, kind = '') {
  const t = el('div', { class: `toast ${kind}`, text });
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 5000);
}

function hue(name) {
  let h = 0;
  for (const ch of name || '') h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}
function avatar(name) {
  const initials = (name || '?').split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase();
  return el('span', { class: 'avatar', title: name, style: `background: hsl(${hue(name)} 55% 45%)`, text: initials });
}

function ago(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}

function markdown(text) {
  const html = window.marked ? window.marked.parse(text, { breaks: false, gfm: true }) : text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  return window.DOMPurify ? window.DOMPurify.sanitize(html) : '';
}

function localStorageGet(k) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function localStorageSet(k, v) {
  try {
    localStorage.setItem(k, v);
  } catch {}
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied');
  } catch {
    toast('Copy failed. Select the text instead.', 'error');
  }
}
function copyField(label, value, hint) {
  return el('div', { class: 'secret' },
    el('span', { class: 'secret-label', text: label }),
    el('div', { class: 'secret-row' },
      el('input', { readonly: true, value, spellcheck: 'false', onfocus: (e) => e.target.select() }),
      el('button', { class: 'btn btn-sm', type: 'button', text: 'Copy', onclick: () => copy(value) })
    ),
    hint ? el('span', { class: 'hint', text: hint }) : null
  );
}
function copyBlock(text) {
  return el('div', { class: 'code-copy' },
    el('pre', {}, el('code', { text })),
    el('button', { class: 'btn btn-sm', type: 'button', text: 'Copy', onclick: () => copy(text) })
  );
}

function installHint() {
  if (!state.install) return null;
  return [
    el('p', { class: 'hint', text: "Don't have the gitclaudehub command on that computer yet? With Node 18.17+ and git, install it with:" }),
    copyBlock(state.install),
  ];
}

function tokenHint() {
  return el('p', { class: 'hint' },
    'Private repo? Add ', el('code', { text: '--token' }),
    ' and paste a GitHub personal access token when it asks: fine-grained, only this repo, Contents "Read and write". It stays on your computer; this site never sees it.'
  );
}

const inviteLink = (invite) => `${location.origin}/r/${route.roomId}#invite=${invite}`;
const ownerLink = (key) => `${location.origin}/r/${route.roomId}/own#key=${key}`;
const hostCommand = (extra = '') => `gitclaudehub host --hub ${location.origin} --room ${route.roomId}${extra}`;

function openSheet(title, nodes) {
  $('#sheet-title').textContent = title;
  $('#sheet-body').replaceChildren(...nodes);
  if (!$('#sheet').open) $('#sheet').showModal();
  $('#sheet-body').scrollTop = 0;
}
$('#sheet-close').addEventListener('click', () => $('#sheet').close());

// ---------------------------------------------------------------------------
// lobby
// ---------------------------------------------------------------------------

async function bootLobby() {
  document.title = 'gitclaudehub';
  $('#lobby').hidden = false;
  const form = $('#create-form');
  form.yourName.value = localStorageGet('gitclaudehub:name') || '';
  try {
    const [hub, mine] = await Promise.all([api('/hub'), api('/my-rooms')]);
    state.install = hub.install;
    $('#create-code-row').hidden = !hub.createNeedsCode;
    form.code.required = hub.createNeedsCode;
    if (hub.install) $('#install-line').replaceChildren('Get the command with ', el('code', { text: hub.install }), ' (needs Node 18.17+ and git).');
    $('#install-line').hidden = !hub.install;
    renderMyRooms(mine.rooms);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderMyRooms(rooms) {
  $('#my-rooms-section').hidden = !rooms.length;
  $('#my-rooms').replaceChildren(
    ...rooms.map((r) =>
      el('li', {},
        el('a', { class: 'room-card', href: `/r/${r.id}` },
          el('span', { class: 'room-card-name', text: r.name }),
          el('span', { class: 'room-card-meta' },
            el('span', { class: `dot${r.hostOnline ? ' on' : ''}`, title: r.hostOnline ? 'Host online' : 'Host offline' }),
            `${r.repo || 'No repo'} · ${r.sessions} session${r.sessions === 1 ? '' : 's'} · ${r.role === 'owner' ? 'you own it' : `you're ${r.me}`}`
          )
        )
      )
    )
  );
}

$('#create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const btn = form.querySelector('button[type=submit]');
  $('#create-error').textContent = '';
  btn.disabled = true;
  try {
    const body = Object.fromEntries(new FormData(form));
    const r = await api('/rooms', { method: 'POST', body });
    localStorageSet('gitclaudehub:name', body.yourName.trim());
    history.pushState(null, '', `/r/${r.id}`);
    route.roomId = r.id;
    $('#lobby').hidden = true;
    await enterApp();
    showCreated(r);
  } catch (err) {
    $('#create-error').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

function showCreated(r) {
  openSheet('Your room is ready', [
    el('p', { class: 'lede', text: "Save these now. The owner link and the host key are only shown this once. If you lose them, you can make new ones in Settings." }),
    el('section', { class: 'sheet-section' },
      el('h3', { text: '1. Start the host on your computer' }),
      el('p', { text: 'Turns run on the computer where you run this, using its Claude login (or ANTHROPIC_API_KEY if set). Paste the host key when it asks.' }),
      installHint(),
      copyBlock(hostCommand()),
      tokenHint(),
      copyField('Host key', r.hostKey),
      el('p', { class: 'hint', text: 'To use a local model instead, add --ollama and a model name, for example --ollama qwen3:8b (needs Ollama 0.14.3 or newer).' })
    ),
    el('section', { class: 'sheet-section' },
      el('h3', { text: '2. Invite friends' }),
      copyField('Invite link', inviteLink(r.invite), 'Send it with the room password.')
    ),
    el('section', { class: 'sheet-section' },
      el('h3', { text: '3. Keep your owner link' }),
      copyField('Owner link (keep it private)', ownerLink(r.ownerKey), 'With your owner password, it lets you manage this room from any browser.')
    ),
  ]);
}

// ---------------------------------------------------------------------------
// join (invite link) and owner sign-in
// ---------------------------------------------------------------------------

let joinMode = null; // 'invite' | 'owner' | 'claim' (a carried-over room choosing its first owner password)

async function bootRoom() {
  try {
    await enterApp();
    return;
  } catch (err) {
    if (err.status === 404) return showJoinMessage('This room is gone', err.message);
    if (err.status !== 401) return showJoinMessage('Something went wrong', err.message);
  }
  let intro;
  try {
    intro = await post('/intro', { invite: hashParams.get('invite') || undefined, ownerKey: route.own ? hashParams.get('key') || undefined : undefined });
  } catch (err) {
    return showJoinMessage(err.status === 404 ? 'This room is gone' : 'Something went wrong', err.message);
  }
  if (route.own && intro.ownerKeyOk) {
    joinMode = intro.ownerHasPassword ? 'owner' : 'claim';
    if (joinMode === 'owner') showJoinForm(intro.name, 'Sign in as the owner of this room.', 'Owner password', 'Sign in');
    else showJoinForm(intro.name, 'Choose an owner password. With this owner link, it lets you manage the room from any browser. Use a different one from the room password.', 'New owner password', 'Set password and sign in');
  } else if (!route.own && intro.inviteOk) {
    joinMode = 'invite';
    showJoinForm(intro.name, `You're invited to build ${intro.repo || 'a project'} together with Claude. Everyone here sees each turn live.`, 'Room password', 'Join the room');
  } else if (route.own) {
    showJoinMessage("This owner link doesn't work", 'It may have been replaced by a newer one. Use the newest owner link for this room.');
  } else {
    showJoinMessage('You need an invite', 'Ask the room owner for the invite link and the room password.');
  }
}

function showJoinMessage(title, text) {
  document.title = 'gitclaudehub';
  $('#app').hidden = true;
  $('#join').hidden = false;
  $('#join-title').textContent = title;
  $('#join-lede').textContent = text;
  $('#join-fields').hidden = true;
}

function showJoinForm(roomName, lede, passwordLabel, submitText) {
  document.title = `${roomName} · gitclaudehub`;
  $('#join').hidden = false;
  $('#join-fields').hidden = false;
  $('#join-title').textContent = roomName;
  $('#join-lede').textContent = lede;
  $('#join-password-label').textContent = passwordLabel;
  $('#join-password').autocomplete = joinMode === 'claim' ? 'new-password' : 'current-password';
  $('#join-password2-row').hidden = joinMode !== 'claim';
  $('#join-password2').required = joinMode === 'claim';
  $('#join-submit').textContent = submitText;
  $('#join-name').value = localStorageGet('gitclaudehub:name') || '';
  ($('#join-name').value ? $('#join-password') : $('#join-name')).focus();
}

$('#join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#join-error').textContent = '';
  const name = $('#join-name').value;
  const password = $('#join-password').value;
  try {
    if (joinMode === 'claim' && password !== $('#join-password2').value) throw new Error("The two passwords don't match.");
    if (joinMode === 'invite') await post('/join', { invite: hashParams.get('invite'), name, password });
    else await post('/owner', { ownerKey: hashParams.get('key'), name, ...(joinMode === 'claim' ? { newPassword: password } : { password }) });
    localStorageSet('gitclaudehub:name', name.trim());
    // Take the invite code or owner key out of the address bar (and out of history).
    history.replaceState(null, '', `/r/${route.roomId}`);
    route.own = false;
    $('#join').hidden = true;
    await enterApp();
  } catch (err) {
    $('#join-error').textContent = err.message;
  }
});

$('#leave').addEventListener('click', async () => {
  const msg = isOwner()
    ? 'Leave this room in this browser? You can come back with your owner link and owner password.'
    : 'Leave this room? To come back you need the invite link and the room password again.';
  if (!confirm(msg)) return;
  state.leaving = true;
  await post('/leave').catch(() => {});
  location.href = '/';
});

// ---------------------------------------------------------------------------
// the room
// ---------------------------------------------------------------------------

function sessionMeta(id) {
  return state.index.sessions.find((s) => s.id === id);
}

// The running turn, if it belongs to what's on screen.
function currentTurnInView() {
  const cur = state.runner.current;
  if (!cur) return false;
  if (state.view == null) return cur.sessionId == null && (state.pendingNewJob === cur.id || cur.author === state.me);
  return cur.liveSessionId === state.view || cur.sessionId === state.view;
}

async function enterApp() {
  const s = await rapi('/state');
  applyState(s);
  if (!state.install) api('/hub').then((h) => (state.install = h.install)).catch(() => {});
  $('#app').hidden = false;
  if (window.innerWidth < 1100) $('#app').classList.add('panel-closed');
  else refreshPanel();
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('s');
  const first = fromHash && sessionMeta(fromHash) ? fromHash : state.index.sessions[0]?.id ?? null;
  renderSessions();
  renderOnline();
  await openSession(first);
  connectEvents();
}

function applyState(s) {
  state.me = s.me.name;
  state.myId = s.me.id;
  state.role = s.me.role;
  state.room = s.room;
  state.host = s.host;
  state.index = s.index;
  state.runner = s.runner;
  state.online = s.online;
  state.previewUrl = s.previewUrl;
  renderRoom();
  renderHost();
}

function renderRoom() {
  document.title = `${state.room.name} · gitclaudehub`;
  $('#room-name').textContent = state.room.name;
  $('#me-name').textContent = state.me + (isOwner() ? ' · owner' : '');
  $('#open-settings').hidden = !isOwner();
  renderRepoLink();
  renderComposer();
  renderBanner();
  renderPermissions();
}

function renderRepoLink() {
  const link = $('#repo-link');
  link.hidden = !state.room.webUrl;
  if (state.room.webUrl) {
    link.href = state.room.webUrl;
    link.textContent = state.room.repo + (state.host.branch ? ` · ${state.host.branch}` : '');
  }
}

function renderHost() {
  const h = state.host;
  const chip = $('#host-chip');
  chip.className = `chip ${h.online ? 'on' : 'off'}`;
  chip.replaceChildren(
    el('span', { class: `dot${h.online ? ' on' : ''}` }),
    el('span', { class: 'chip-text', text: h.online ? h.backend || 'Host online' : h.connecting ? 'Host connecting…' : 'Host offline' })
  );
  chip.title = h.online
    ? `Turns run on the owner's computer with ${h.backend}. Approvals: ${h.approvalMode}.`
    : `The owner's computer isn't connected${h.lastSeen ? ` (last seen ${ago(h.lastSeen)})` : ''}. Messages wait in the queue.`;
  $('#preview-tab').hidden = !state.previewUrl;
  if (state.previewUrl) $('#preview-open').href = state.previewUrl;
  renderRepoLink();
  renderBanner();
}

function renderBanner() {
  const msgs = [];
  if (!state.host.online) {
    msgs.push(isOwner()
      ? "Your computer isn't hosting this room, so messages wait in the queue. Settings → Your computer shows the command to start it."
      : "The owner's computer is offline, so messages wait in the queue until it's back.");
  }
  if (state.room.settings?.locked) msgs.push(isOwner() ? 'The room is locked: only you can send messages.' : 'The owner has locked the room, so only they can send messages right now.');
  const b = $('#room-banner');
  b.hidden = !msgs.length;
  b.replaceChildren(...msgs.map((t) => el('p', { text: t })));
}

function renderComposer() {
  const blocked = !!state.room.settings?.locked && !isOwner();
  $('#prompt').disabled = blocked;
  $('#send').disabled = blocked;
  $('#prompt').placeholder = blocked ? 'Only the owner can send messages right now' : 'Ask Claude to build something…';
}

// ---------------------------------------------------------------------------
// sessions list
// ---------------------------------------------------------------------------

function renderSessions() {
  const list = $('#session-list');
  list.replaceChildren();
  const live = state.runner.current;
  for (const s of state.index.sessions) {
    const isLive = live && (live.liveSessionId === s.id || live.sessionId === s.id);
    const people = (s.contributors || []).join(', ');
    list.append(
      el('li', {},
        el('button', { class: `session-item${s.id === state.view ? ' active' : ''}`, onclick: () => openSession(s.id) },
          el('span', { class: 'session-title' }, isLive ? el('span', { class: 'live-dot', title: 'Claude is working here' }) : null, el('span', { text: s.title || 'Untitled session' })),
          el('span', { class: 'session-meta', text: `${s.prompts ?? 0} messages · ${people || s.owner} · ${ago(s.updatedAt)}` })
        )
      )
    );
  }
  $('#no-sessions').hidden = state.index.sessions.length > 0;
}

function renderOnline() {
  const box = $('#online');
  box.replaceChildren(...state.online.slice(0, 6).map(avatar));
  box.title = `In the room: ${state.online.join(', ')}`;
}

$('#new-session').addEventListener('click', () => openSession(null));

async function openSession(id) {
  state.view = id;
  state.toolEls.clear();
  state.liveText = null;
  lastKind = null;
  $('#app').classList.remove('sidebar-open');
  history.replaceState(null, '', id ? `#s=${id}` : location.pathname);
  renderSessions();
  renderHeader();
  const box = $('#messages');
  box.replaceChildren();

  if (!id) {
    if (state.pendingNewJob && state.runner.current?.id === state.pendingNewJob) {
      const cur = state.runner.current;
      appendItems([{ kind: 'prompt', author: cur.author, text: cur.prompt }]);
    } else {
      box.append(
        el('div', { class: 'empty-chat' },
          el('h2', { text: 'Start a new shared session' }),
          el('p', { text: 'Describe what you want to build. The AI works in the project repo, everyone here watches it happen, and the result is committed to GitHub.' })
        )
      );
    }
  } else {
    box.append(el('p', { class: 'note', text: 'Loading conversation…' }));
    try {
      const data = await rapi(`/sessions/${id}`);
      if (state.view !== id) return;
      box.replaceChildren();
      if (data.stale) box.append(el('p', { class: 'note', text: "The owner's computer is offline, so this is the last copy this site saw." }));
      appendItems(data.items);
    } catch (err) {
      box.replaceChildren(el('p', { class: 'note', text: err.message }));
    }
  }
  renderPermissions();
  renderActivity();
  scrollToBottom(true);
  if (!$('#prompt').disabled) $('#prompt').focus();
}

function renderHeader() {
  const meta = state.view && sessionMeta(state.view);
  $('#chat-title').textContent = meta ? meta.title || 'Untitled session' : 'New session';
  $('#chat-sub').textContent = meta
    ? `Started by ${meta.owner} · with ${(meta.contributors || []).join(', ') || meta.owner} · updated ${ago(meta.updatedAt)}`
    : 'Not shared yet. It will be saved to the repo after the first turn.';
  $('#resume-hint').hidden = !meta;
  $('#resume-box').hidden = true;
  if (meta) $('#resume-cmd').textContent = `gitclaudehub pull ${meta.id}\nclaude --resume ${meta.id}`;
}

$('#resume-hint').addEventListener('click', () => ($('#resume-box').hidden = !$('#resume-box').hidden));
$('#copy-resume').addEventListener('click', () => copy($('#resume-cmd').textContent));

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------

let lastKind = null;

function nearBottom() {
  const m = $('#messages');
  return m.scrollHeight - m.scrollTop - m.clientHeight < 120;
}
function scrollToBottom(force) {
  const m = $('#messages');
  if (force || nearBottom()) requestAnimationFrame(() => (m.scrollTop = m.scrollHeight));
}

function claudeMark() {
  return el('div', { class: 'claude-mark' }, el('span', { class: 'avatar', text: 'C' }), el('span', { text: 'Claude' }));
}

function appendItems(items) {
  const box = $('#messages');
  const stick = nearBottom();
  box.querySelector('.empty-chat')?.remove();
  for (const it of items) {
    if (it.kind === 'result') {
      const card = state.toolEls.get(it.id);
      if (card) fillResult(card, it);
      continue;
    }
    if (it.kind === 'text') dropLiveText();
    if ((it.kind === 'text' || it.kind === 'tool' || it.kind === 'thinking') && lastKind !== 'claude') {
      box.append(claudeMark());
      lastKind = 'claude';
    }
    const node = renderItem(it);
    if (node) box.append(node);
    if (it.kind === 'prompt') lastKind = 'prompt';
    else if (it.kind === 'note' && !it.inline) lastKind = 'note';
  }
  if (stick) scrollToBottom(true);
}

function renderItem(it) {
  switch (it.kind) {
    case 'prompt':
      return el('div', { class: 'msg-prompt' },
        el('div', { class: 'who' }, avatar(it.author), el('strong', { text: it.author }), it.ts ? el('span', { text: ago(it.ts) }) : null),
        el('div', { class: 'prompt-body', text: it.text })
      );
    case 'text': {
      const d = el('div', { class: 'msg-text' });
      d.innerHTML = markdown(it.text);
      for (const a of d.querySelectorAll('a')) {
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      }
      return d;
    }
    case 'thinking':
      return el('details', { class: 'thinking' },
        el('summary', {}, el('span', { text: 'Thinking' })),
        el('div', { class: 'tool-detail', text: it.text })
      );
    case 'tool': {
      const status = el('span', { class: 'tool-status pending' });
      const detail = el('div', { class: 'tool-detail' }, el('h4', { text: 'Input' }), el('pre', { text: it.input }));
      const card = el('details', { class: 'tool' },
        el('summary', {}, status, el('span', { class: 'tool-name', text: it.name }), el('span', { class: 'tool-summary', text: it.summary || '' })),
        detail
      );
      card._status = status;
      card._detail = detail;
      state.toolEls.set(it.id, card);
      return card;
    }
    case 'note':
      return el('p', { class: 'note', text: it.text });
    default:
      return null;
  }
}

function fillResult(card, it) {
  card._status.className = `tool-status ${it.isError ? 'err' : 'ok'}`;
  if (it.text) card._detail.append(el('h4', { text: it.isError ? 'Error' : 'Result' }), el('pre', { class: it.isError ? 'err' : '', text: it.text }));
}

function appendLiveText(text) {
  if (!state.liveText) {
    if (lastKind !== 'claude') {
      $('#messages').append(claudeMark());
      lastKind = 'claude';
    }
    state.liveText = { buf: '', node: el('div', { class: 'msg-text live' }) };
    $('#messages').append(state.liveText.node);
  }
  state.liveText.buf += text;
  state.liveText.node.innerHTML = markdown(state.liveText.buf.replace(/^\[[^\]\n]{1,40}\]\s+/, ''));
  scrollToBottom();
}
function dropLiveText() {
  state.liveText?.node.remove();
  state.liveText = null;
}

// ---------------------------------------------------------------------------
// activity, queue, permissions
// ---------------------------------------------------------------------------

function renderActivity() {
  const cur = state.runner.current;
  const act = $('#activity');
  if (!cur) {
    act.hidden = true;
  } else {
    act.hidden = false;
    const where = currentTurnInView() ? '' : ` in “${sessionMeta(cur.liveSessionId || cur.sessionId)?.title || 'a new session'}”`;
    const phase = { syncing: 'Pulling the latest code', saving: 'Saving to GitHub', running: 'Working' }[cur.phase] || 'Starting';
    $('#activity-text').textContent = `${phase} for ${cur.author}${where}…`;
  }
  const q = $('#queue');
  q.replaceChildren(
    ...state.runner.queue.map((j, i) =>
      el('li', {},
        el('span', { text: `${state.host.online ? 'Up next' : 'Waiting for the host'}${i ? ` (#${i + 1})` : ''}: ${j.author} — “${j.prompt}”` }),
        j.author === state.me || isOwner()
          ? el('button', { class: 'link-btn', text: 'Cancel', onclick: () => post(`/queue/${j.id}/cancel`).catch((e) => toast(e.message, 'error')) })
          : null
      )
    )
  );
  $('#send').textContent = cur || state.runner.queue.length ? 'Queue' : 'Send';
}

$('#stop').addEventListener('click', () => post('/stop').catch((e) => toast(e.message, 'error')));

function renderPermissions() {
  const canApprove = !state.room.settings?.ownerApprovals || isOwner();
  const box = $('#permissions');
  box.replaceChildren(
    ...state.runner.permissions.map((p) => {
      const answer = (allow, allowRest) => post(`/permissions/${p.id}`, { allow, allowRest }).catch((e) => toast(e.message, 'error'));
      return el('div', { class: 'perm', role: 'alert' },
        el('div', { class: 'perm-head', text: `Claude wants to use ${p.tool} (for ${p.requestedBy}’s request)` }),
        el('pre', { text: p.summary || p.input }),
        p.reason ? el('div', { class: 'chat-sub', text: p.reason }) : null,
        canApprove
          ? el('div', { class: 'perm-actions' },
              el('button', { class: 'btn btn-ok btn-sm', text: 'Allow', onclick: () => answer(true) }),
              el('button', { class: 'btn btn-sm', text: 'Allow everything this turn', onclick: () => answer(true, true) }),
              el('button', { class: 'btn btn-sm', text: 'Deny', onclick: () => answer(false) })
            )
          : el('div', { class: 'chat-sub', text: 'Waiting for the room owner to approve or deny this.' })
      );
    })
  );
  if (state.runner.permissions.length) scrollToBottom();
}

// ---------------------------------------------------------------------------
// composer
// ---------------------------------------------------------------------------

const prompt = $('#prompt');
prompt.addEventListener('input', () => {
  prompt.style.height = 'auto';
  prompt.style.height = Math.min(prompt.scrollHeight, 220) + 'px';
});
prompt.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('#composer').requestSubmit();
  }
});

$('#composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = prompt.value.trim();
  if (!text || prompt.disabled) return;
  $('#send').disabled = true;
  try {
    const r = await post('/prompt', { prompt: text, sessionId: state.view });
    if (!state.view) state.pendingNewJob = r.jobId;
    if (!r.hostOnline) toast("The owner's computer is offline. Your message will run when it's back.");
    prompt.value = '';
    prompt.dispatchEvent(new Event('input'));
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    renderComposer();
  }
});

// ---------------------------------------------------------------------------
// live events
// ---------------------------------------------------------------------------

function leaveTo(title, text) {
  state.es?.close();
  if ($('#sheet').open) $('#sheet').close();
  showJoinMessage(title, text);
}

function refreshState() {
  return rapi('/state')
    .then((s) => {
      applyState(s);
      renderSessions();
      renderActivity();
    })
    .catch(() => {});
}

function connectEvents() {
  const es = new EventSource(`/api/rooms/${route.roomId}/events`);
  state.es = es;
  const on = (name, fn) => es.addEventListener(name, (e) => fn(JSON.parse(e.data)));

  on('hello', (d) => {
    state.runner = d.runner;
    state.online = d.online;
    state.host = d.host;
    renderOnline();
    renderHost();
    renderActivity();
    renderPermissions();
  });
  on('presence', (names) => {
    state.online = names;
    renderOnline();
  });
  on('host', (d) => {
    const changed = d.online !== state.host.online;
    state.host = d;
    renderHost();
    renderActivity();
    // Coming online brings a fresh session list, the project's files, and maybe a preview.
    if (changed) {
      refreshState();
      if (!$('#app').classList.contains('panel-closed')) refreshPanel();
    }
  });
  on('room', (r) => {
    state.room = r;
    renderRoom();
  });
  on('queue', (r) => {
    state.runner = r;
    renderActivity();
    renderPermissions();
    renderSessions();
  });
  on('turn_start', (d) => {
    const mine = d.sessionId ? d.sessionId === state.view : state.view == null && (d.jobId === state.pendingNewJob || d.author === state.me);
    if (mine && !d.sessionId) state.pendingNewJob = d.jobId;
    if (mine) appendItems([{ kind: 'prompt', author: d.author, text: d.prompt, ts: d.at }]);
    else if (d.author !== state.me) toast(`${d.author} started a turn${d.sessionId ? ` in “${sessionMeta(d.sessionId)?.title || 'a session'}”` : ' in a new session'}`);
  });
  on('session_id', (d) => {
    // A new session got its id, or a resumed one was saved under a new id.
    if (state.runner.current?.id === d.jobId) state.runner.current.liveSessionId = d.sessionId;
    if (d.previous && state.view === d.previous) {
      state.view = d.sessionId;
      history.replaceState(null, '', `#s=${d.sessionId}`);
    }
    renderSessions();
  });
  on('delta', (d) => {
    if (currentTurnInView()) appendLiveText(d.text);
  });
  on('items', (d) => {
    if (currentTurnInView()) appendItems(d.items);
  });
  on('permission_request', (p) => {
    if (!state.runner.permissions.some((x) => x.id === p.id)) state.runner.permissions.push(p);
    renderPermissions();
    if (!currentTurnInView()) toast(`Claude is waiting for approval to use ${p.tool}`);
  });
  on('permission_resolved', (p) => {
    state.runner.permissions = state.runner.permissions.filter((x) => x.id !== p.id);
    renderPermissions();
    if (currentTurnInView() && p.by && p.by !== 'gitclaudehub') {
      appendItems([{ kind: 'note', inline: true, text: `${p.by} ${p.allow ? 'allowed' : 'denied'} a tool call` }]);
    }
  });
  on('turn_end', (d) => {
    const watching = currentTurnInView() || (d.previous && d.previous === state.view);
    dropLiveText();
    if (state.view == null && d.jobId === state.pendingNewJob && d.sessionId) {
      state.pendingNewJob = null;
      state.view = d.sessionId;
    }
    if (watching || state.view === d.sessionId) {
      const bits = [];
      if (d.stoppedBy) bits.push(el('span', { text: `Stopped by ${d.stoppedBy}` }));
      if (d.error) bits.push(el('span', { class: 'warn', text: `Error: ${d.error}` }));
      if (d.commit && /^[0-9a-f]{7,40}$/.test(d.commit)) {
        const short = d.commit.slice(0, 7);
        bits.push(state.room.webUrl ? el('a', { href: `${state.room.webUrl}/commit/${d.commit}`, target: '_blank', rel: 'noopener', text: short }) : el('code', { text: short }));
        bits.push(el('span', { text: d.pushed ? 'pushed to GitHub' : 'committed' }));
      } else bits.push(el('span', { text: 'No file changes' }));
      if (typeof d.costUsd === 'number') bits.push(el('span', { text: `$${d.costUsd.toFixed(3)}` }));
      if (d.durationMs) bits.push(el('span', { text: `${Math.round(d.durationMs / 1000)}s` }));
      $('#messages').append(el('div', { class: 'turn-end' }, ...bits));
      lastKind = 'note';
      scrollToBottom();
    }
    if (d.warning) toast(d.warning, 'error');
    if (d.session) {
      const i = state.index.sessions.findIndex((s) => s.id === d.session.id || s.id === d.previous);
      if (i >= 0) state.index.sessions[i] = d.session;
      else state.index.sessions.unshift(d.session);
    }
    if (state.view === d.sessionId) {
      history.replaceState(null, '', `#s=${d.sessionId}`);
      renderHeader();
    }
    renderSessions();
    if (!$('#app').classList.contains('panel-closed')) refreshPanel();
  });
  on('turn_error', (d) => {
    dropLiveText();
    toast(`Turn failed: ${d.message}`, 'error');
  });
  on('sessions', (index) => {
    const before = state.view && sessionMeta(state.view)?.updatedAt;
    state.index = index;
    renderSessions();
    renderHeader();
    // Someone pushed new turns from their terminal: reload the conversation on screen.
    const after = state.view && sessionMeta(state.view)?.updatedAt;
    if (before && after && before !== after && !currentTurnInView()) openSession(state.view);
  });
  on('notice', (n) => toast(n.text));
  on('kicked', () => leaveTo('You were removed from this room', 'The owner removed you. You can only come back with a current invite link and the room password.'));
  on('room_deleted', () => {
    if (!state.leaving) leaveTo('This room was deleted', 'The owner deleted it. The project itself is still in its GitHub repo.');
  });
  es.onerror = () => {
    // EventSource reconnects on its own; catch up once it does.
    es.addEventListener('open', refreshState, { once: true });
  };
}

// ---------------------------------------------------------------------------
// owner settings
// ---------------------------------------------------------------------------

$('#open-settings').addEventListener('click', openSettings);

async function openSettings() {
  let a;
  try {
    a = await rapi('/admin');
  } catch (err) {
    return toast(err.message, 'error');
  }
  const settings = state.room.settings || {};
  const section = (title, ...kids) => el('section', { class: 'sheet-section' }, el('h3', { text: title }), ...kids);
  const toggle = (label, key, hint) => {
    const input = el('input', { type: 'checkbox' });
    input.checked = !!settings[key];
    input.addEventListener('change', async () => {
      try {
        state.room = await post('/admin/settings', { [key]: input.checked });
        renderRoom();
      } catch (err) {
        input.checked = !input.checked;
        toast(err.message, 'error');
      }
    });
    return el('label', { class: 'check' }, input, el('span', {}, el('strong', { text: label }), el('span', { class: 'hint', text: hint })));
  };
  const form = (onsubmit, ...kids) =>
    el('form', {
      class: 'row',
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await onsubmit();
        } catch (err) {
          toast(err.message, 'error');
        }
      },
    }, ...kids);

  const roomPw = el('input', { type: 'password', minlength: '6', required: true, autocomplete: 'new-password', placeholder: 'New room password' });
  const nameInput = el('input', { maxlength: '80', required: true, value: state.room.name });
  const repoInput = el('input', { value: state.room.repo || '', placeholder: 'owner/name', spellcheck: 'false' });
  const confirmInput = el('input', { autocomplete: 'off', placeholder: state.room.name });
  const h = a.host;

  openSheet('Room settings', [
    section('Invite friends',
      copyField('Invite link', inviteLink(a.invite), 'Send it with the room password.'),
      el('div', { class: 'row' }, el('button', { class: 'btn btn-sm', type: 'button', text: 'Reset invite link', onclick: resetInvite })),
      form(async () => {
        await post('/admin/room-password', { password: roomPw.value });
        roomPw.value = '';
        toast('Room password changed. People already in the room stay in.');
      }, roomPw, el('button', { class: 'btn btn-sm', text: 'Change room password' }))
    ),
    section('Who can do what',
      toggle('Only I can send messages', 'locked', 'Locks the room. Everyone can still watch.'),
      toggle('Only I can approve commands', 'ownerApprovals', 'Shell commands and other tools wait for you instead of anyone in the room.')
    ),
    section(`People (${a.members.length})`,
      el('ul', { class: 'people' },
        ...a.members.map((m) =>
          el('li', {},
            el('span', { class: `dot${m.online ? ' on' : ''}`, title: m.online ? 'Here now' : 'Not here now' }),
            avatar(m.name),
            el('span', { class: 'people-name', text: m.name }),
            el('span', { class: 'hint', text: `joined ${ago(m.joinedAt)}` }),
            m.role === 'owner' ? el('span', { class: 'tag', text: 'owner' }) : el('button', { class: 'link-btn danger', type: 'button', text: 'Remove', onclick: () => kick(m) })
          )
        )
      )
    ),
    section('Your computer (the host)',
      el('p', { text: h.online ? `Connected. Turns run with ${h.backend}. Approvals: ${h.approvalMode}.` : `Not connected${h.lastSeen ? `, last seen ${ago(h.lastSeen)}` : ''}. Messages wait in the queue until it is.` }),
      el('p', { class: 'hint', text: 'Run this on the computer that should do the work. It needs the gitclaudehub command and git access to the repo, and asks for the host key the first time.' }),
      installHint(),
      copyBlock(hostCommand()),
      tokenHint(),
      el('p', { class: 'hint', text: 'With a local model instead (Ollama 0.14.3 or newer):' }),
      copyBlock(hostCommand(' --ollama qwen3:8b')),
      el('div', { class: 'row' }, el('button', { class: 'btn btn-sm', type: 'button', text: 'Make a new host key', onclick: resetHostKey }))
    ),
    section('Room',
      el('form', {
        class: 'stack',
        onsubmit: async (e) => {
          e.preventDefault();
          try {
            state.room = await post('/admin/settings', { name: nameInput.value, repo: repoInput.value });
            renderRoom();
            toast('Saved');
          } catch (err) {
            toast(err.message, 'error');
          }
        },
      },
        el('label', {}, 'Name', nameInput),
        el('label', {}, 'GitHub repo', repoInput, el('span', { class: 'hint', text: 'Used for links, and for the first clone on a new host computer.' })),
        el('div', { class: 'row' }, el('button', { class: 'btn btn-sm', text: 'Save' }))
      )
    ),
    section('Owner access',
      el('p', { class: 'hint', text: 'Your owner link and owner password let you manage this room from any browser.' }),
      el('div', { class: 'row' },
        el('button', { class: 'btn btn-sm', type: 'button', text: 'Make a new owner link', onclick: resetOwnerLink }),
        el('button', { class: 'btn btn-sm', type: 'button', text: 'Change owner password', onclick: changeOwnerPassword })
      )
    ),
    section('Delete room',
      el('p', { class: 'hint', text: 'Removes the room from this site for everyone and stops its host. Your GitHub repo and the clone on your computer stay as they are.' }),
      el('form', {
        class: 'row',
        onsubmit: async (e) => {
          e.preventDefault();
          state.leaving = true;
          try {
            await post('/admin/delete', { confirm: confirmInput.value });
            state.es?.close();
            location.href = '/';
          } catch (err) {
            state.leaving = false;
            toast(err.message, 'error');
          }
        },
      },
        el('label', { class: 'grow' }, `Type “${state.room.name}” to confirm`, confirmInput),
        el('button', { class: 'btn btn-danger btn-sm', text: 'Delete room' })
      )
    ),
  ]);
}

async function resetInvite() {
  if (!confirm('Make a new invite link? The old one stops working for anyone who hasn’t joined yet. People already in the room stay in.')) return;
  try {
    const r = await post('/admin/reset-invite');
    state.previewUrl = r.previewUrl;
    $('#preview-frame').removeAttribute('src');
    renderHost();
    openSettings();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function resetHostKey() {
  if (!confirm('Make a new host key? The computer hosting this room disconnects until it gets the new key.')) return;
  try {
    const { hostKey } = await post('/admin/reset-host-key');
    openSheet('New host key', [
      el('p', { class: 'lede', text: 'Only shown this once. If the host is still running, it asks for the new key; otherwise start it again and paste this when it asks.' }),
      copyField('Host key', hostKey),
      copyBlock(hostCommand()),
    ]);
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function resetOwnerLink() {
  if (!confirm('Make a new owner link? The old one stops working.')) return;
  try {
    const { ownerKey } = await post('/admin/reset-owner-link');
    openSheet('New owner link', [
      el('p', { class: 'lede', text: 'Only shown this once. Keep it private: with your owner password, it lets anyone manage this room.' }),
      copyField('Owner link', ownerLink(ownerKey)),
    ]);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function changeOwnerPassword() {
  const current = el('input', { type: 'password', required: true, autocomplete: 'current-password' });
  const next = el('input', { type: 'password', minlength: '6', required: true, autocomplete: 'new-password' });
  const again = el('input', { type: 'password', minlength: '6', required: true, autocomplete: 'new-password' });
  openSheet('Change owner password', [
    el('form', {
      class: 'stack',
      onsubmit: async (e) => {
        e.preventDefault();
        if (next.value !== again.value) return toast("The two new passwords don't match.", 'error');
        try {
          await post('/admin/owner-password', { current: current.value, password: next.value });
          toast('Owner password changed.');
          openSettings();
        } catch (err) {
          toast(err.message, 'error');
        }
      },
    },
      el('label', {}, 'Current owner password', current),
      el('label', {}, 'New owner password', next),
      el('label', {}, 'New owner password again', again),
      el('div', { class: 'row' }, el('button', { class: 'btn btn-primary btn-sm', text: 'Change password' }), el('button', { class: 'btn btn-sm', type: 'button', text: 'Back', onclick: openSettings }))
    ),
  ]);
}

async function kick(m) {
  if (!confirm(`Remove ${m.name}? They can come back only while they still have the invite link and room password. Reset the invite link to stop that.`)) return;
  try {
    await post('/admin/kick', { memberId: m.id });
    openSettings();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// project panel
// ---------------------------------------------------------------------------

$('#toggle-panel').addEventListener('click', () => {
  $('#app').classList.toggle('panel-closed');
  if (!$('#app').classList.contains('panel-closed')) refreshPanel();
});
$('#close-panel').addEventListener('click', () => $('#app').classList.add('panel-closed'));
$('#toggle-sidebar').addEventListener('click', () => $('#app').classList.toggle('sidebar-open'));

let activeTab = 'files';
for (const t of document.querySelectorAll('.tab')) {
  t.addEventListener('click', () => {
    activeTab = t.dataset.tab;
    for (const x of document.querySelectorAll('.tab')) x.classList.toggle('active', x === t);
    for (const b of document.querySelectorAll('.tab-body')) b.hidden = b.dataset.body !== activeTab;
    refreshPanel();
  });
}

let allFiles = [];
async function refreshPanel() {
  try {
    if (activeTab === 'files') {
      allFiles = (await rapi('/files')).files;
      renderFiles();
    } else if (activeTab === 'changes') {
      const { commits } = await rapi('/commits');
      $('#commit-list').replaceChildren(
        ...(commits.length ? commits : [{ empty: true }]).map((c) =>
          c.empty
            ? el('li', { class: 'side-empty', text: 'No commits yet.' })
            : el('li', {},
                el('button', { onclick: () => openCommit(c) },
                  el('span', { class: 'commit-subject', text: c.subject }),
                  el('span', { class: 'commit-meta' }, el('code', { text: c.sha.slice(0, 7) }), ` · ${c.author} · ${ago(c.date)}`)
                )
              )
        )
      );
    } else if (activeTab === 'preview') {
      const f = $('#preview-frame');
      if (!f.getAttribute('src') && state.previewUrl) f.src = state.previewUrl;
    }
  } catch (err) {
    const msg = el('li', { class: 'side-empty', text: err.message });
    if (activeTab === 'files') $('#file-list').replaceChildren(msg);
    else if (activeTab === 'changes') $('#commit-list').replaceChildren(msg);
  }
}
$('#reload-preview').addEventListener('click', () => {
  if (state.previewUrl) $('#preview-frame').src = `${state.previewUrl}&t=${Date.now()}`;
});

function renderFiles() {
  const q = $('#file-filter').value.toLowerCase();
  const shown = allFiles.filter((f) => !f.startsWith('.gitclaudehub/') && f.toLowerCase().includes(q)).slice(0, 800);
  $('#file-list').replaceChildren(
    ...(shown.length ? shown : [null]).map((f) => {
      if (!f) return el('li', { class: 'side-empty', text: allFiles.length ? 'No matches.' : 'The repo is empty so far.' });
      const i = f.lastIndexOf('/');
      return el('li', {},
        el('button', { title: f, onclick: () => openFile(f) },
          i >= 0 ? el('span', { class: 'file-dir', text: f.slice(0, i + 1) }) : null,
          el('span', { class: 'file-base', text: f.slice(i + 1) })
        )
      );
    })
  );
}
$('#file-filter').addEventListener('input', renderFiles);

function openViewer(title, ghUrl) {
  $('#viewer-title').textContent = title;
  const gh = $('#viewer-gh');
  gh.hidden = !ghUrl;
  if (ghUrl) gh.href = ghUrl;
  $('#viewer-body').replaceChildren(el('span', { text: 'Loading…' }));
  $('#viewer').showModal();
}
$('#viewer-close').addEventListener('click', () => $('#viewer').close());
$('#viewer').addEventListener('click', (e) => {
  if (e.target === $('#viewer')) $('#viewer').close();
});

async function openFile(f) {
  const branch = state.host.branch || 'HEAD';
  openViewer(f, state.room.webUrl ? `${state.room.webUrl}/blob/${branch}/${f.split('/').map(encodeURIComponent).join('/')}` : null);
  try {
    const r = await rapi(`/file?path=${encodeURIComponent(f)}`);
    $('#viewer-body').textContent = r.binary ? `(binary file, ${r.size.toLocaleString()} bytes)` : r.text + (r.truncated ? '\n… (file truncated)' : '');
  } catch (err) {
    $('#viewer-body').textContent = err.message;
  }
}

async function openCommit(c) {
  openViewer(`${c.sha.slice(0, 7)} ${c.subject}`, state.room.webUrl ? `${state.room.webUrl}/commit/${c.sha}` : null);
  try {
    const { text } = await rapi(`/commits/${c.sha}`);
    const body = $('#viewer-body');
    body.replaceChildren();
    for (const line of text.split('\n')) {
      const cls = line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') ? 'file' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('@@') ? 'hunk' : '';
      body.append(el('span', { class: cls, text: line }), '\n');
    }
  } catch (err) {
    $('#viewer-body').textContent = err.message;
  }
}

// ---------------------------------------------------------------------------

setInterval(() => !$('#app').hidden && renderSessions(), 60_000);
// Opening an invite or owner link while already on this page only changes the hash; start over with it.
window.addEventListener('hashchange', () => {
  if (/(^|&)(invite|key)=/.test(location.hash.slice(1))) location.reload();
});
if (route.roomId) bootRoom();
else bootLobby();
