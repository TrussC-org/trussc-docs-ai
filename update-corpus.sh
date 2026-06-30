#!/usr/bin/env bash
# Rebuild the RAG corpus from the current sources, then (optionally) deploy it.
#
# Run this after the API reference is re-emitted (trussc.org/generated/trussc-api.js)
# or any corpus source changes (FOR_AI_ASSISTANT.md, examples, of-mapping…).
#
# Steps:
#   1. build-chunks.mjs   sources → chunks.jsonl
#   2. embed.mjs          chunks.jsonl → chunks.embedded.json   (bge-m3, ~couple min)
#   3. scp                copy the corpus + runtime code to the server
#   4. restart            so the service reloads it
#
# NOTE: the corpus format is coupled to the runtime code (e.g. per-chunk vector
# bundles in chunks.embedded.json need the matching rag.mjs). So we ship the runtime
# files (rag.mjs, server.mjs, config.mjs) together with the corpus — never the corpus
# alone, or a format change would break a server running older code.
#
# Deploy target comes from env (kept out of the repo — no host baked in):
#   TRUSSC_DEPLOY_HOST   ssh host/alias of the server (or pass as $1)
#   TRUSSC_DEPLOY_DIR    install dir on the server   (default: trussc-docs-ai, rel. to ~)
#   TRUSSC_SERVICE       systemd service name        (default: trussc-docs-ai)
# If no host is given, it rebuilds locally only and prints the deploy commands.
#
#   ./update-corpus.sh                 # rebuild only
#   ./update-corpus.sh myserver        # rebuild + deploy to ssh host "myserver"
#   TRUSSC_DEPLOY_HOST=myserver ./update-corpus.sh
set -euo pipefail
cd "$(dirname "$0")"

HOST="${TRUSSC_DEPLOY_HOST:-${1:-}}"
DIR="${TRUSSC_DEPLOY_DIR:-trussc-docs-ai}"
SVC="${TRUSSC_SERVICE:-trussc-docs-ai}"
PORT="${PORT:-8788}"

echo "▶ 1/2  build-chunks…"
node build-chunks.mjs
echo "▶ 2/2  embed (bge-m3 — this takes a couple of minutes)…"
node embed.mjs
COUNT=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("chunks.embedded.json")).length)')
echo "✔ corpus rebuilt: ${COUNT} chunks"

# Runtime files shipped alongside the corpus (kept in lockstep with the format).
RUNTIME_FILES="chunks.embedded.json rag.mjs server.mjs config.mjs mcp-core.mjs mcp.mjs"

if [ -z "$HOST" ]; then
  echo
  echo "No deploy host (set TRUSSC_DEPLOY_HOST or pass it as an arg). Rebuilt locally only."
  echo "To deploy manually:"
  echo "  scp ${RUNTIME_FILES} <host>:${DIR}/"
  echo "  ssh -t <host> 'sudo systemctl restart ${SVC}'"
  exit 0
fi

echo "▶ scp corpus + runtime code → ${HOST}:${DIR}/"
scp -o BatchMode=yes ${RUNTIME_FILES} "${HOST}:${DIR}/"
echo "▶ restart ${SVC} on ${HOST} (sudo — you may be prompted)…"
ssh -t "${HOST}" "sudo systemctl restart ${SVC} && sleep 3 && curl -s localhost:${PORT}/health && echo"
echo "✔ deployed."
