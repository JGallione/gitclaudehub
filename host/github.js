// Before cloning, ask GitHub whether this computer can read and push the room's repo, so a missing
// or wrong personal access token gets a clear answer instead of a git error halfway through.

const API = () => (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');

export const TOKEN_HELP =
  'Make one at github.com → Settings → Developer settings → Fine-grained tokens: under Repository access pick "Only select repositories" and this repo, and under Permissions set Contents to "Read and write".';

/**
 * @returns {Promise<{ok: true, private?: boolean, canPush?: boolean, unchecked?: boolean} | {ok: false, why: 'private'|'bad_token'|'no_access'|'read_only'}>}
 */
export async function githubAccess(repo, token) {
  let res;
  try {
    res = await fetch(`${API()}/repos/${repo}`, {
      headers: { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: true, unchecked: true }; // offline or GitHub is slow: let git try
  }
  if (res.status === 401) return { ok: false, why: 'bad_token' };
  if (res.status === 404) return { ok: false, why: token ? 'no_access' : 'private' };
  if (!res.ok) return { ok: true, unchecked: true }; // e.g. 403 rate limit: let git try
  const r = await res.json();
  if (token && r.permissions && !r.permissions.push) return { ok: false, why: 'read_only' };
  return { ok: true, private: !!r.private, canPush: r.permissions?.push };
}

export function accessMessage(why, repo) {
  switch (why) {
    case 'private':
      return `${repo} is private (or doesn't exist), and this computer has no GitHub token for it. Run the host again with --token and paste a personal access token. ${TOKEN_HELP}`;
    case 'bad_token':
      return `GitHub rejected the token for ${repo}: it's expired, revoked or mistyped. Run the host again with --token to paste a new one. ${TOKEN_HELP}`;
    case 'no_access':
      return `The token can't see ${repo}. Add that repo to the token's repository access on GitHub, or run the host again with --token to paste one that can. ${TOKEN_HELP}`;
    case 'read_only':
      return `The token can read ${repo} but not push to it. Set its Contents permission to "Read and write", or run the host again with --token to paste one that can.`;
    default:
      return `This computer can't reach ${repo} on GitHub.`;
  }
}

/** Does a git error look like GitHub refusing access (rather than, say, no network)? */
export function looksLikeAuthError(message) {
  return /could not read Username|Authentication failed|Repository not found|returned error: 40[13]|Invalid username or password|Permission to .* denied/i.test(String(message));
}
