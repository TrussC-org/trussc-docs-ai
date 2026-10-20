#!/usr/bin/env bash
# Rebuild the RAG corpus from the current sources, then (optionally) deploy it.
#
# Run this after the API reference is re-emitted (trussc.org/generated/trussc-api.js)
# or any corpus source changes (FOR_AI_ASSISTANT.md, examples, of-mapping…).
#
# Steps:
#   0. fetch-*.mjs        refresh the GitHub caches (releases.json, issues.json)
#   1. build-chunks.mjs   sources → chunks.jsonl
#   2. embed.mjs          chunks.jsonl → chunks.embedded.json   (bge-m3, ~couple min)
#   2b. guards            stop if the chunk count shrank >5% vs the committed corpus,
#                         or if eval/fair/gate.py sees a real score drop (hidden questions)
#   3. scp                copy the corpus + runtime code to the server
#   4. restart            so the service reloads it, then accept the score as the baseline
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
# One rebuild per checkout at a time (lock this script itself): the guards compare
# against shared baselines and a second run would overwrite the corpus mid-check.
exec 9<"$(basename "$0")"   # after the cd above, so relative invocations work
flock -n 9 || { echo "✘ another update-corpus.sh is running in this checkout"; exit 1; }

HOST="${TRUSSC_DEPLOY_HOST:-${1:-}}"
DIR="${TRUSSC_DEPLOY_DIR:-trussc-docs-ai}"
SVC="${TRUSSC_SERVICE:-trussc-docs-ai}"
PORT="${PORT:-8788}"

echo "▶ 0/3  fetch release notes (GitHub)…"
node fetch-releases.mjs || echo "  (fetch failed — using the cached releases.json)"
echo "▶ 0/3  fetch open bug issues (GitHub)…"
node fetch-issues.mjs || echo "  (fetch failed — using the cached issues.json)"
echo "▶ 1/3  build-chunks…"
# addon examples are part of the standard corpus (override with ADDON_EXAMPLES='')
ADDON_EXAMPLES="${ADDON_EXAMPLES-all}" node build-chunks.mjs
echo "▶ 2/3  embed (bge-m3 — this takes a couple of minutes)…"
node embed.mjs
COUNT=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("chunks.embedded.json")).length)')
echo "✔ corpus rebuilt: ${COUNT} chunks"
# Count guard: losing many chunks usually means a source repo was missing or stale.
# CORPUS_MAX_SHRINK=1 allows any drop (e.g. a deliberate cleanup).
# No committed corpus yet = nothing to compare; an unreadable one blocks.
if ! TREE=$(git ls-tree HEAD -- chunks.embedded.json); then
  PREV=bad                      # cannot read HEAD: don't treat that as "no corpus"
elif [ -n "$TREE" ]; then
  PREV=$( { git show HEAD:chunks.embedded.json || echo '<unreadable>'; } | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const a=JSON.parse(s);console.log(Array.isArray(a)?a.length:"bad")}catch{console.log("bad")}})')
else
  PREV=none
fi
# Bound (cache): a rebuild may lose at most 5% of the committed chunks. Overflow stops the deploy with the count-guard line.
if ! node -e 'const [n,p,m]=process.argv.slice(1); const N=Number(n), P=Number(p), M=Number(m); const valid=Number.isInteger(N)&&N>=0&&Number.isFinite(M)&&M>=0&&M<=1&&(p==="none"||(Number.isInteger(P)&&P>0)); const ok=valid&&(p==="none"||N>=P*(1-M)); console.log(valid?`count guard: ${N} chunks, committed ${p}, allowed shrink ${M*100}% -> ${ok?"ok":"BLOCKED"}`:`count guard: cannot compare (new ${n}, committed ${p}, CORPUS_MAX_SHRINK ${m}) -> BLOCKED`); process.exit(ok?0:1)' "$COUNT" "$PREV" "${CORPUS_MAX_SHRINK:-0.05}"; then
  echo "✘ stopped: the chunk count dropped too far (see the line above). Nothing was deployed."
  exit 1
fi
echo "▶ 2b/3 fair retrieval eval (hidden questions, cheap judge — a few minutes)…"
if ! python3 eval/fair/gate.py check chunks.embedded.json; then
  echo "✘ stopped: the fair eval gate did not pass (see the line above). Nothing was deployed."
  exit 1
fi

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
[ "${FAIR_EVAL_SKIP:-0}" = 1 ] || python3 eval/fair/gate.py accept chunks.embedded.json
