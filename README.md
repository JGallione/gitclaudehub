# gitclaudehub

Build a project together with friends and an AI. Anyone can make a **room** for their own GitHub project, run the room's AI on their own computer, and invite people in.

- **Rooms.** Create one on the site for your repo, and you own it. Friends join with an invite link and the room password. Everyone can send messages, watch each turn live, and approve shell commands. After every turn, the code changes and the updated conversation are committed and pushed.
- **Your AI, your computer.** `gitclaudehub host` runs on the owner's computer and does the work there. It can use that computer's Claude Code login, an `ANTHROPIC_API_KEY`, or a local model through Ollama. The site only relays. It never sees a GitHub token or an AI key, and the owner needs no tunnel, because the host connects out to the site.
- **Moderation.** Owners can lock the room so only they can send messages, approve commands themselves, remove people, reset the invite link, and delete the room.
- **Terminal round-trip.** `gitclaudehub push` shares a Claude Code session from your terminal into the repo. `gitclaudehub pull` + `claude --resume <id>` continues one in your terminal.

```
 friends' browsers            the gitclaudehub site                  owner's computer
 ─────────────────            ─────────────────────                  ────────────────
 chat, watch, approve  ◄─SSE─  rooms, queue, members  ◄─WebSocket──  gitclaudehub host
                       ─POST─► invite + owner links    ── jobs ────►  Claude Code (Agent SDK)
                                cached history         ◄─ events ──   Claude login / API key / Ollama
                                                                      clone ── commit + push ──► GitHub
```

## How it works

Claude Code saves every session as a transcript at `~/.claude/projects/<project-folder>/<session-id>.jsonl`. gitclaudehub moves those transcripts in and out of the repo's `.gitclaudehub/` folder:

- **Paths are made portable.** Your project folder becomes `{{GITCLAUDEHUB_ROOT}}` on the way into the repo, and the reader's own folder on the way out. Your home folder is handled the same way. So a session started in `/Users/you/app` resumes in `/home/sam/code/app`.
- **Likely secrets are redacted** before they're committed: API keys, GitHub/Slack/AWS/Stripe tokens, private keys, and `NAME_TOKEN=…` style lines. Thinking blocks are never edited, because that would break their signatures. A thinking block that contains a secret is dropped. `.env` and key files are left out of commits.
- **One turn at a time per room.** The site queues messages, and the host runs them in order. Each message is sent as `[Name] message`, so the AI knows who's talking. Messages sent while the owner's computer is off wait in the queue.
- **Commits are credited.** Each turn is committed as `Sam: make the toggle remember the choice`, with Sam as the author.
- **Diverged sessions are caught.** If you extended a session in your terminal while friends extended it in a room, `gitclaudehub push` refuses to overwrite their turns, and `gitclaudehub pull` refuses to overwrite yours. Use `--force` on either to pick a side.

## 1. Install

Needs Node 18.17+ and git. Everyone who hosts a room, or continues sessions in their terminal, needs the `gitclaudehub` command:

```bash
npm install -g github:JGallione/gitclaudehub
```

To run the site, or to work on gitclaudehub itself:

```bash
git clone https://github.com/JGallione/gitclaudehub.git && cd gitclaudehub
npm install
npm link            # puts this copy's `gitclaudehub` command on your PATH
```

If you fork it, change `repository` in `package.json`. The site shows that repo's install command to new room owners.

## 2. Run the site

```bash
cp .env.example .env
./start-room.sh       # the site + free Cloudflare links (brew install cloudflared); prints the link to share
# or: npm start       # http://localhost:3000, this computer only
```

`start-room.sh` also hosts any rooms this computer has hosted before. The Cloudflare links change every time it starts. For a fixed address, run the site behind your own domain or on a small server:

```bash
docker build -t gitclaudehub .
docker run -p 3000:3000 -p 3001:3001 -v gitclaudehub-data:/app/data -e PUBLIC_URL=https://rooms.example.com gitclaudehub
```

Set `CREATE_ROOM_CODE` if only people with a code should be able to create rooms.

## 3. Create and host a room

1. Open the site, fill in **Create a room** (name, `owner/repo`, your name, an owner password, and a room password for friends).
2. Save what the site shows you once: the **host key**, the **invite link**, and your private **owner link**.
3. On the computer that should do the work, run the host command from the room (also under **Settings → Your computer**):

   ```bash
   gitclaudehub host --hub https://your-site --room <id>                     # Claude: this computer's login, or ANTHROPIC_API_KEY
   gitclaudehub host --hub https://your-site --room <id> --ollama qwen3:8b   # a local model
   ```

   It asks for the host key once and remembers it (and your other choices) in `~/.gitclaudehub/hosts/`. It clones the repo into `~/.gitclaudehub/rooms/<id>/repo` with git's own credentials, or with `GITHUB_TOKEN` for private repos over https. Later, `gitclaudehub host --room <id>` is enough, and `gitclaudehub host --all` hosts every room you've hosted. Run `gitclaudehub --help` for every option (`--approvals`, `--budget`, `--preview <dir>`, `--model`, `--dir`).

4. Send friends the invite link and the room password.

### Local models (Ollama)

Ollama 0.14.3 and newer speak the API Claude Code uses, so a local model runs the same tools, approvals and transcripts as Claude. You need:

- **A model that handles tool calls.** For example `qwen3:8b`, `gpt-oss:20b` or `qwen3-coder`. Run `ollama pull <model>` first.
- **A big context window.** Claude Code's instructions and tools alone are large. Set Ollama's context length to 32K or more, in Ollama's settings or with `OLLAMA_CONTEXT_LENGTH=32768 ollama serve`. The host refuses to resume a session that has grown past the model's window (`--context`, default 32768), so start new sessions in local-model rooms.

Small local models are much weaker than Claude at multi-step coding. They're a good fit for small, well-described changes.

### Owner controls (Settings)

- **Invite link**: copy it, or reset it so the old one stops working. People already in the room stay in.
- **Room password**: change it.
- **Only I can send messages**: locks the room. Everyone can still watch.
- **Only I can approve commands**: shell commands wait for the owner instead of anyone in the room.
- **People**: see who's in the room and remove someone. A removed person can only come back while they still have the invite link and the room password, so reset the invite link if needed.
- **Host key**: make a new one if the old one leaked. The running host stops and asks for the new key.
- **Owner link and password**: get a new owner link, or change the owner password.
- **Delete room**: removes it from the site for everyone and stops its host. The GitHub repo and the host's clone stay as they are.

### Approvals

By default (`--approvals ask-bash`), the AI edits files freely. Shell commands, web fetches and similar tools wait until someone in the room clicks **Allow**, **Allow everything this turn**, or **Deny**. If the owner turned on owner-only approvals, only the owner can answer. Claude Code still runs commands it knows are read-only, like `ls` or `git status`, without asking. Unanswered requests are denied after 10 minutes. `--approvals ask-all` also asks before edits. `--approvals auto` asks for nothing, which lets anyone in the room run anything on the host's computer, so use it only in a container.

### Live preview

Start the host with `--preview <dir>` to show that folder of the repo under **Project → Preview**: `.` for plain HTML, `dist` for most builds. The site fetches each file from the host and serves it on `PREVIEW_PORT`, a separate origin, so the project's scripts can't act as the viewer inside gitclaudehub.

## 4. From your terminal

```bash
gitclaudehub push                 # share your most recent Claude Code session for this repo, commit, push
gitclaudehub push <session-id>    # a specific one (see `gitclaudehub local`)
gitclaudehub push --session-only  # commit only the .gitclaudehub folder, not your other changes
gitclaudehub pull                 # git pull + install the shared sessions here
claude --resume <session-id>
```

A room's host picks up sessions and code pushed from terminals within about 30 seconds.

## Things to know

- **Use a private repo.** Transcripts hold everything people and the AI said, plus file contents the AI read. Redaction only catches common secret formats, so read `.gitclaudehub/sessions/` before making a repo public.
- **Room owners trust the site.** The site relays prompts and approvals to the host. Whoever runs the site could send commands for approval, so only host rooms on a site you trust. Use `--approvals ask-bash` or `ask-all`.
- **Previews share one origin.** All rooms' previews are served from `PREVIEW_PORT`, and a browser holds one room's preview at a time.
- **If the host's connection drops during a turn**, the turn stops and whatever it had done is committed. The host reconnects on its own.
- **The transcript format belongs to Claude Code** and may change between versions. gitclaudehub copies it as-is, apart from the path, secret and account-field rewrites above. If a resume fails after a Claude Code update, update `@anthropic-ai/claude-agent-sdk` here too.
- **Long project paths.** Claude Code shortens project-folder names over 200 characters with a hash, and the hash can differ between the Node and native builds. Keep `--dir` and your project folders at reasonable lengths.

## Development

```bash
npm test                                                  # transcripts, redaction, display, and a full room end to end
GITCLAUDEHUB_AGENT_MODULE=test/fake-agent.js gitclaudehub host …   # a host with a stand-in agent, no API calls
```

The stand-in agent streams text, asks to run `ls` (so you can try the approval buttons), appends to `NOTES.md`, and writes a real transcript. `--repo-url /path/to/repo.git` points a host at a local bare repo, so everything can be tested without GitHub.

| Path | What it does |
|---|---|
| `server/index.js` | The site: lobby, rooms API, live events (SSE), host WebSocket, preview proxy |
| `server/rooms.js` | Rooms, members, passwords, invite/owner/host keys (`data/hub/rooms.json`) |
| `server/legacy.js` | Turns the old one-room `.env` setup into a room on first start |
| `host/host.js` | `gitclaudehub host`: connects to the site, runs jobs, answers file/preview requests |
| `host/runner.js` | One turn: Agent SDK call, approvals, save + commit + push |
| `host/backends.js` | Claude (login or API key) or Ollama |
| `host/workspace.js` | The host's clone: sync, commit, push, file, diff and preview reads |
| `lib/sessions.js` | Find, export (paths → placeholder, redaction) and import Claude Code transcripts |
| `lib/display.js` | Turn transcript entries / SDK messages into chat items |
| `lib/share.js` | `.gitclaudehub/index.json` and git helpers |
| `cli/gitclaudehub.js` | `gitclaudehub push / pull / list / local / host` |
| `public/` | The web client (no build step) |
