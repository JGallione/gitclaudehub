// The host's own checkout of a room's repo: clone, sync, commit, push, browse.
// It lives on the room owner's computer and is kept apart from their working copy.

import fs from 'node:fs';
import path from 'node:path';
import { git, stagedSecretFiles } from '../lib/share.js';

export class Workspace {
  /** @param {{dir: string, repoUrl?: string, token?: string, branch?: string, autoPush?: boolean}} opts */
  constructor({ dir, repoUrl, token, branch, autoPush = true }) {
    this.dir = path.resolve(dir);
    this.repoUrl = repoUrl;
    this.token = token || '';
    this.branch = branch || '';
    this.autoPush = autoPush;
  }

  run(args, opts = {}) {
    return git(args, { cwd: this.dir, token: this.token, ...opts });
  }

  async init() {
    if (!fs.existsSync(path.join(this.dir, '.git'))) {
      if (fs.existsSync(this.dir) && fs.readdirSync(this.dir).length) {
        throw new Error(`${this.dir} has files in it but isn't a git checkout. Pick an empty folder or an existing clone.`);
      }
      if (!this.repoUrl) throw new Error('This room has no GitHub repo set, so there is nothing to clone. Pass --dir with an existing checkout.');
      fs.mkdirSync(path.dirname(this.dir), { recursive: true });
      const args = ['clone', this.repoUrl, this.dir];
      if (this.branch) args.splice(1, 0, '--branch', this.branch);
      await git(args, { token: this.token });
    }
    // The committer identity for this checkout. Each turn's *author* is the person who asked.
    // (.invalid is a reserved domain, so these never match a real GitHub account.)
    if (!(await this.run(['config', '--local', 'user.name'], { allowFail: true })).stdout.trim()) {
      await this.run(['config', 'user.name', process.env.GIT_COMMITTER_NAME || 'gitclaudehub']);
      await this.run(['config', 'user.email', process.env.GIT_COMMITTER_EMAIL || 'gitclaudehub@gitclaudehub.invalid']);
    }
    this.hasHead = (await this.run(['rev-parse', '--verify', 'HEAD'], { allowFail: true })).ok;
  }

  async hasUpstream() {
    return (await this.run(['rev-parse', '--abbrev-ref', '@{u}'], { allowFail: true })).ok;
  }

  /** Save stray changes, then bring in whatever friends pushed. One sync at a time. */
  sync() {
    const run = (this.syncing || Promise.resolve()).catch(() => {}).then(() => this.syncNow());
    this.syncing = run;
    return run;
  }

  async syncNow() {
    await this.commitAll('gitclaudehub: save uncommitted changes');
    if (!(await this.hasUpstream())) {
      // Empty repo just cloned: nothing to pull yet.
      return;
    }
    const r = await this.run(['pull', '--rebase', '--autostash'], { allowFail: true });
    if (!r.ok) {
      await this.run(['rebase', '--abort'], { allowFail: true });
      throw new Error(`Couldn't pull the latest changes from GitHub: ${r.stderr.trim()}`);
    }
  }

  /** Stage everything (minus likely secret files) and commit. Returns the new sha or null. */
  async commitAll(subject, body, author) {
    await this.run(['add', '-A']);
    const risky = await stagedSecretFiles(this.dir);
    if (risky.length) await this.run(['reset', '-q', '--', ...risky]);
    const clean = (await this.run(['diff', '--cached', '--quiet'], { allowFail: true })).ok;
    if (clean) return null;
    const args = ['commit', '-q', '-m', subject];
    if (body) args.push('-m', body);
    if (author) {
      const slug = author.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'friend';
      args.push(`--author=${author} <${slug}@gitclaudehub.invalid>`);
    }
    await this.run(args);
    this.hasHead = true;
    return (await this.run(['rev-parse', 'HEAD'])).stdout.trim();
  }

  /** Push; if GitHub moved on and can't be rebased cleanly, park the work on its own branch. */
  async push() {
    if (!this.autoPush) return { pushed: false };
    const remotes = (await this.run(['remote'])).stdout.trim();
    if (!remotes) return { pushed: false, warning: 'This repo has no remote, so nothing was pushed.' };
    if (await this.hasUpstream()) {
      const pull = await this.run(['pull', '--rebase', '--autostash'], { allowFail: true });
      if (!pull.ok) {
        await this.run(['rebase', '--abort'], { allowFail: true });
        const branch = `gitclaudehub/conflict-${Date.now()}`;
        await this.run(['push', '-q', 'origin', `HEAD:refs/heads/${branch}`]);
        return { pushed: true, branch, warning: `Someone else pushed conflicting changes, so this turn went to branch ${branch}.` };
      }
      await this.run(['push', '-q']);
    } else {
      await this.run(['push', '-q', '-u', 'origin', 'HEAD']);
    }
    return { pushed: true };
  }

  async currentBranch() {
    return (await this.run(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true })).stdout.trim() || 'main';
  }

  async files() {
    const [tracked, untracked] = await Promise.all([
      this.run(['ls-files', '-z']),
      this.run(['ls-files', '-z', '--others', '--exclude-standard']),
    ]);
    const all = new Set([...tracked.stdout.split('\0'), ...untracked.stdout.split('\0')].filter(Boolean));
    return [...all].filter((f) => fs.existsSync(path.join(this.dir, f))).sort();
  }

  resolveInside(rel) {
    const full = path.resolve(this.dir, rel);
    if (full !== this.dir && !full.startsWith(this.dir + path.sep)) throw new Error('Path is outside the project');
    if (full.split(path.sep).includes('.git')) throw new Error('Path is inside .git');
    return full;
  }

  async readFile(rel) {
    const full = this.resolveInside(rel);
    const stat = fs.statSync(full);
    if (!stat.isFile()) throw new Error('Not a file');
    const LIMIT = 512 * 1024;
    const buf = fs.readFileSync(full).subarray(0, LIMIT);
    if (buf.includes(0)) return { binary: true, size: stat.size };
    return { text: buf.toString('utf8'), truncated: stat.size > LIMIT, size: stat.size };
  }

  /** One file of the built site under `previewDir`, for the room's Preview tab. Dotfiles and anything outside stay hidden. */
  previewFile(previewDir, urlPath) {
    let rel;
    try {
      rel = decodeURIComponent(String(urlPath).split('?')[0]).replace(/^\/+/, '');
    } catch {
      return { status: 400 };
    }
    if (rel.split('/').some((seg) => seg.startsWith('.'))) return { status: 404 };
    const root = fs.realpathSync(this.resolveInside(previewDir || '.'));
    let full = path.resolve(root, rel);
    if (!fs.existsSync(full)) return { status: 404 };
    full = fs.realpathSync(full); // a symlink can't lead outside the preview folder
    if (full !== root && !full.startsWith(root + path.sep)) return { status: 404 };
    if (fs.statSync(full).isDirectory()) full = path.join(full, 'index.html');
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return { status: 404 };
    if (fs.statSync(full).size > 15 * 1024 * 1024) return { status: 413 };
    return { status: 200, ext: path.extname(full), body: fs.readFileSync(full).toString('base64') };
  }

  async log(n = 40) {
    if (!this.hasHead) return [];
    const r = await this.run(['log', `-n${n}`, '--pretty=format:%H%x1f%an%x1f%aI%x1f%s']);
    return r.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [sha, author, date, subject] = l.split('\x1f');
        return { sha, author, date, subject };
      });
  }

  async show(sha) {
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) throw new Error('Bad commit id');
    const r = await this.run(['show', '--stat', '--patch', '--format=%H%n%an <%ae>%n%aI%n%n%B', sha, '--', '.', ':(exclude).gitclaudehub']);
    const LIMIT = 300 * 1024;
    return r.stdout.length > LIMIT ? r.stdout.slice(0, LIMIT) + '\n… (diff truncated)' : r.stdout;
  }
}
