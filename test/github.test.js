// The host's pre-flight check against GitHub, run against a stand-in for api.github.com.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { githubAccess, accessMessage, looksLikeAuthError } from '../host/github.js';

const REPOS = {
  'me/private': { private: true, tokens: { good: { push: true }, readonly: { push: false } } },
  'me/public': { private: false, tokens: { good: { push: true } } },
};

const server = http.createServer((req, res) => {
  const repo = req.url.replace(/^\/repos\//, '');
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (token === 'expired') return send(401, { message: 'Bad credentials' });
  if (token === 'limited') return send(403, { message: 'rate limited' });
  const r = REPOS[repo];
  if (!r || (r.private && !r.tokens[token])) return send(404, { message: 'Not Found' });
  send(200, { full_name: repo, private: r.private, ...(token ? { permissions: { push: !!r.tokens[token]?.push } } : {}) });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.GITHUB_API_URL = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

test('githubAccess explains what a token can and cannot do', async () => {
  assert.deepEqual(await githubAccess('me/private', 'good'), { ok: true, private: true, canPush: true });
  assert.deepEqual(await githubAccess('me/private', ''), { ok: false, why: 'private' });
  assert.deepEqual(await githubAccess('me/private', 'someone-elses'), { ok: false, why: 'no_access' });
  assert.deepEqual(await githubAccess('me/private', 'readonly'), { ok: false, why: 'read_only' });
  assert.deepEqual(await githubAccess('me/private', 'expired'), { ok: false, why: 'bad_token' });
  assert.equal((await githubAccess('me/public', '')).ok, true, 'public repos need no token to read');
  assert.equal((await githubAccess('me/public', 'limited')).unchecked, true, 'a rate limit lets git decide');

  process.env.GITHUB_API_URL = 'http://127.0.0.1:1'; // nothing listens: offline
  assert.equal((await githubAccess('me/private', '')).unchecked, true, 'offline lets git decide');
  process.env.GITHUB_API_URL = `http://127.0.0.1:${server.address().port}`;
});

test('messages tell people what to do', () => {
  assert.match(accessMessage('private', 'me/private'), /--token/);
  assert.match(accessMessage('private', 'me/private'), /Contents to "Read and write"/);
  assert.match(accessMessage('read_only', 'me/private'), /not push/);
  assert.ok(looksLikeAuthError("fatal: could not read Username for 'https://github.com': terminal prompts disabled"));
  assert.ok(looksLikeAuthError('remote: Repository not found.'));
  assert.ok(!looksLikeAuthError('Could not resolve host: github.com'), 'no network is not a token problem');
});
