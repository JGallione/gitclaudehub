# Runs the gitclaudehub site. Rooms' turns run on their owners' computers (`gitclaudehub host`),
# so the site itself needs no AI key and no GitHub token.
#
# The same image can also run a host, which is the safest place for --approvals auto:
#   docker run -it -v gch-host:/home/jam/.gitclaudehub -e ANTHROPIC_API_KEY=… -e GITHUB_TOKEN=… \
#     <image> node cli/gitclaudehub.js host --hub https://your-site --room <id>
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates python3 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .

# Claude Code won't skip permission checks as root, and Claude shouldn't run as root anyway.
RUN useradd --create-home jam && mkdir -p /app/data && chown -R jam /app/data
USER jam

ENV DATA_DIR=/app/data HOST=0.0.0.0
EXPOSE 3000 3001
VOLUME ["/app/data"]
CMD ["node", "server/index.js"]
