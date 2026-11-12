#!/bin/bash
# Start the gitclaudehub site on this computer, give it internet links through free Cloudflare quick
# tunnels, and host the rooms this computer runs (any room you've run `gitclaudehub host` for here).
# The links change every time you run this. Stop everything with Ctrl-C.

cd "$(dirname "$0")" || exit 1
PORT=$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2); PORT=${PORT:-3000}
PREVIEW_PORT=$((PORT + 1))
LOGS=$(mktemp -d)

# Tunnels start inside $(…) subshells, so they aren't jobs of this shell: track every PID in files.
cleanup() { kill $(cat "$LOGS"/*.pid 2>/dev/null) 2>/dev/null; rm -rf "$LOGS"; }
trap cleanup EXIT INT TERM

tunnel() { # port logfile → prints the https link once Cloudflare hands it out (3 tries)
  for attempt in 1 2 3; do
    cloudflared tunnel --no-autoupdate --url "http://localhost:$1" >"$2" 2>&1 &
    local pid=$!
    echo $pid >"$2.pid"
    for _ in $(seq 1 60); do
      # The log also mentions https://api.trycloudflare.com (the service itself); that's not a link.
      url=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$2" | grep -v '^https://api\.' | head -1)
      [ -n "$url" ] && { echo "$url"; return 0; }
      kill -0 $pid 2>/dev/null || break # cloudflared gave up (Cloudflare didn't answer)
      sleep 1
    done
    kill $pid 2>/dev/null
    # Cloudflare rate-limits quick tunnels, so back off instead of hammering it.
    [ $attempt -lt 3 ] && { echo "Cloudflare didn't hand out a link; trying again in $((attempt * attempt * 20))s…" >&2; sleep $((attempt * attempt * 20)); }
  done
  echo "Cloudflare's free links are busy or rate-limited right now. Wait a few minutes and run this again." >&2
  return 1
}

command -v cloudflared >/dev/null || { echo "cloudflared is not installed (brew install cloudflared)"; exit 1; }

echo "Opening Cloudflare links…"
APP_URL=$(tunnel "$PORT" "$LOGS/app.log") || { echo "Couldn't open the site link:"; cat "$LOGS/app.log"; exit 1; }
PREVIEW_URL=$(tunnel "$PREVIEW_PORT" "$LOGS/preview.log") || { echo "Couldn't open the preview link:"; cat "$LOGS/preview.log"; exit 1; }
export PUBLIC_URL="$APP_URL" PREVIEW_URL PREVIEW_PORT

echo
echo "  Site link:          $APP_URL"
echo "  Owners host with:   gitclaudehub host --hub $APP_URL --room <room id>"
echo

node server/index.js &
echo $! >"$LOGS/site.pid"

# Once the site answers, host this computer's rooms on it.
for _ in $(seq 1 40); do curl -sf "http://localhost:$PORT/api/hub" >/dev/null && break; sleep 0.25; done
if ls "${GITCLAUDEHUB_HOME:-$HOME/.gitclaudehub}"/hosts/*.json >/dev/null 2>&1; then
  node cli/gitclaudehub.js host --all --hub "http://localhost:$PORT" &
  echo $! >"$LOGS/hosts.pid"
fi

wait "$(cat "$LOGS/site.pid")"
