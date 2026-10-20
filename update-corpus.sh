#!/usr/bin/env bash
# Rebuild the RAG corpus from the current sources, check it, then (with --local) deploy it
# on this server. The corpus is generated at deploy time; it is not kept in git.
#
# Run this after the API reference is re-emitted (trussc.org/generated/trussc-api.js)
# or any corpus source changes (FOR_AI_ASSISTANT.md, examples, of-mapping…).
#
# Steps:
#   0. fast-forward sources, then fetch-*.mjs refresh the GitHub caches
#   1. build-chunks.mjs   sources → chunks.jsonl
#   2. embed.mjs          chunks.jsonl → chunks.embedded.next.json   (bge-m3, ~couple min;
#                         the live chunks.embedded.json is only read as a vector cache)
#   2b. guards            stop if the chunk count shrank >5% vs the live corpus, or if
#                         eval/fair/gate.py sees a real score drop (hidden questions)
#   --local only:
#   3. swap               live → chunks.embedded.prev.json, next → live (atomic rename)
#   4. restart + health   the service must come back with the new chunk count
#   5. accept             the fair eval gate takes the deployed corpus as its baseline
# A failed guard leaves the live corpus untouched. A failed restart or health check, or an
# interruption after the swap, puts the previous corpus back and restarts again.
# Roll back by hand to the corpus before the last swap:
#   mv chunks.embedded.prev.json chunks.embedded.json && systemctl restart trussc-docs-ai
#
# The corpus is built, checked and served from the same checkout, so the runtime code
# (rag.mjs, server.mjs…) the service restarts with always matches the corpus format.
#
#   ./update-corpus.sh                  # rebuild + check only (leaves chunks.embedded.next.json)
#   ./update-corpus.sh --local          # this checkout IS the server: also swap, restart, health-check
# Add --first-deploy when there is no live corpus yet (fresh clone): the count guard then
# has nothing to compare against and says so, instead of passing silently.
# Settings come from env:
#   TRUSSC_SERVICE       systemd service name        (default: trussc-docs-ai)
#   TRUSSC_RESTART_CMD / TRUSSC_HEALTH_CMD   override the restart / health check
#                        (test-update-corpus.sh stubs them)
set -euo pipefail
cd "$(dirname "$0")"
# One rebuild per checkout at a time: the guards compare against shared baselines and a
# second run would overwrite .next/.prev mid-check. Lock the checkout directory itself,
# which a git checkout/pull never replaces (unlike this script's own file).
exec 9<.
flock -n 9 || { echo "✘ another update-corpus.sh is running in this checkout"; exit 1; }

LOCAL=0; FIRST=0; NO_PULL=0
for arg in "$@"; do
  case "$arg" in
    --local) LOCAL=1 ;;
    --first-deploy) FIRST=1 ;;
    --no-pull) NO_PULL=1 ;;
    *) echo "✘ unknown argument: $arg"
       echo "  (deploying to another host is not supported: run ./update-corpus.sh --local on the server)"
       exit 2 ;;
  esac
done
if [ -n "${TRUSSC_DEPLOY_HOST:-}" ]; then
  echo "✘ TRUSSC_DEPLOY_HOST is set, but deploying to another host is not supported:"
  echo "  run ./update-corpus.sh --local on the server (the corpus is checked where it is served)"
  exit 2
fi
SVC="${TRUSSC_SERVICE:-trussc-docs-ai}"
PORT="${PORT:-8788}"
LIVE=chunks.embedded.json NEXT=chunks.embedded.next.json PREV=chunks.embedded.prev.json
# Pin embed.mjs's cache and output to these files: a caller's EMBEDDED/EMBEDDED_NEXT must
# never make the embedder write over the live corpus before the guards have run.
export EMBEDDED="$PWD/$LIVE" EMBEDDED_NEXT="$PWD/$NEXT"
RESTART="${TRUSSC_RESTART_CMD:-systemctl restart $SVC}"
HEALTH="${TRUSSC_HEALTH_CMD:-curl -fsS --max-time 5 http://127.0.0.1:$PORT/health}"
# Capture stderr in memory; preserve it and never retry with sudo automatically.
restart_service() {
  local restart_stderr status
  if restart_stderr=$(exec sh -c "$RESTART" 2>&1 >&3 3>&-); then
    [ -z "$restart_stderr" ] || printf '%s\n' "$restart_stderr" >&2
    return 0
  else
    status=$?
  fi
  printf '%s\n' "$restart_stderr" >&2
  if [[ "$restart_stderr" =~ [Aa]ccess[[:space:]]denied|[Ii]nteractive[[:space:]]authentication[[:space:]]required|[Aa]uthentication[[:space:]](is[[:space:]])?required|[Aa]uthorization[[:space:]](failed|required) ]]; then
    echo "  Hint: rerun with TRUSSC_RESTART_CMD='sudo systemctl restart $SVC'" >&2
  fi
  return "$status"
} 3>&1
count() { node -e 'try{const a=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log(Array.isArray(a)?a.length:"bad")}catch{console.log("bad")}' "$1"; }

# Operator-shell work only: the service never fetches sources or accesses the cache.
# These defaults match config.mjs; resolve overrides after cd, just as the builder does.
export TRUSSC_REPO="${TRUSSC_REPO:-$PWD/../TrussC}" SITE_REPO="${SITE_REPO:-$PWD/../trussc.org}"
source_error() { echo "✘ source $1: $2. Stopped; the live corpus is unchanged." >&2; exit 1; }
preflight_source() {
  local label=$1 repo=$2 status
  [ "$(git -C "$repo" rev-parse --is-inside-work-tree 2>/dev/null)" = true ] || source_error "$label" "not a git checkout ($repo)"
  git -C "$repo" symbolic-ref -q HEAD >/dev/null || source_error "$label" 'detached HEAD; a branch is required'
  git -C "$repo" rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1 || source_error "$label" 'branch has no upstream'
  status=$(git -C "$repo" status --porcelain --untracked-files=no) || source_error "$label" 'cannot inspect tracked changes'
  [ -z "$status" ] || source_error "$label" 'tracked local changes; commit or remove them before rebuilding'
}
preflight_source TrussC "$TRUSSC_REPO"
preflight_source trussc.org "$SITE_REPO"
if [ "$NO_PULL" = 0 ]; then
  for repo in "$TRUSSC_REPO" "$SITE_REPO"; do
    echo "▶ fast-forward source: $repo"
    git -C "$repo" fetch || source_error "$repo" 'git fetch failed'
    git -C "$repo" merge --ff-only '@{u}' || source_error "$repo" 'upstream is not fast-forwardable (git merge --ff-only failed)'
  done
else
  echo '▶ --no-pull: using local source commits (no fetch or merge)'
fi
TRUSSC_COMMIT=$(git -C "$TRUSSC_REPO" rev-parse --verify HEAD) || source_error TrussC 'cannot resolve HEAD'
SITE_COMMIT=$(git -C "$SITE_REPO" rev-parse --verify HEAD) || source_error trussc.org 'cannot resolve HEAD'
export CORPUS_SOURCES="TrussC=$TRUSSC_COMMIT trussc.org=$SITE_COMMIT"
echo "▶ corpus sources: $CORPUS_SOURCES"

echo "▶ 0/3  fetch release notes (GitHub)…"
node fetch-releases.mjs || echo "  (fetch failed — using the existing releases.json, if any)"
echo "▶ 0/3  fetch open bug issues (GitHub)…"
node fetch-issues.mjs || echo "  (fetch failed — using the existing issues.json, if any)"
echo "▶ 0/3  fetch addon registry and external addon sources…"
node fetch-addons.mjs || echo "  (fetch failed — using the existing addon registry/cache, if any)"
echo "▶ 1/3  build-chunks…"
# addon examples are part of the standard corpus (override with ADDON_EXAMPLES='')
ADDON_EXAMPLES="${ADDON_EXAMPLES-all}" node build-chunks.mjs
echo "▶ 2/3  embed (bge-m3 — this takes a couple of minutes)…"
rm -f "$NEXT"
node embed.mjs
COUNT=$(count "$NEXT")
echo "✔ corpus rebuilt: ${COUNT} chunks → ${NEXT}"

# Count guard against the LIVE (deployed) corpus: losing many chunks usually means a
# source repo was missing or stale. CORPUS_MAX_SHRINK=1 allows any drop (a deliberate cleanup).
# No live corpus blocks unless --first-deploy says so; an unreadable one blocks.
if [ -e "$LIVE" ]; then
  LIVECOUNT=$(count "$LIVE")
elif [ "$FIRST" = 1 ]; then
  LIVECOUNT=none
else
  echo "✘ stopped: there is no live ${LIVE} to compare the new corpus against."
  echo "  On a fresh clone, rerun with --first-deploy."
  exit 1
fi
# Bound (cache): a rebuild may lose at most 5% of the live chunks. Overflow stops the deploy with the count-guard line.
if ! node -e 'const [n,p,m]=process.argv.slice(1); const N=Number(n), P=Number(p), M=Number(m); const valid=Number.isInteger(N)&&N>0&&Number.isFinite(M)&&M>=0&&M<=1&&(p==="none"||(Number.isInteger(P)&&P>0)); const ok=valid&&(p==="none"||N>=P*(1-M)); console.log(!valid?`count guard: cannot compare (new ${n}, live ${p}, CORPUS_MAX_SHRINK ${m}) -> BLOCKED`:p==="none"?`count guard: ${N} chunks, no live corpus (--first-deploy) -> ok`:`count guard: ${N} chunks, live ${P}, allowed shrink ${M*100}% -> ${ok?"ok":"BLOCKED"}`); process.exit(ok?0:1)' "$COUNT" "$LIVECOUNT" "${CORPUS_MAX_SHRINK:-0.05}"; then
  echo "✘ stopped: the chunk count check failed (see the line above). The live corpus is unchanged."
  exit 1
fi
echo "▶ 2b/3 fair retrieval eval (hidden questions — a couple of minutes)…"
if ! python3 eval/fair/gate.py check "$NEXT"; then
  echo "✘ stopped: the fair eval gate did not pass (see the line above). The live corpus is unchanged."
  exit 1
fi

if [ "$LOCAL" = 0 ]; then
  echo
  echo "Checks passed; nothing deployed (no --local). The new corpus is ${NEXT}."
  echo "  deploy it on this server:  ./update-corpus.sh --local   (rebuilds and checks again)"
  exit 0
fi

# From the swap until the health check passes, any exit (a failed step, Ctrl-C, SIGTERM)
# puts the previous state back: the old corpus, or no corpus on a first deploy.
SWAPPED=0; HADLIVE=0
rollback() {
  if [ "$HADLIVE" = 1 ]; then mv -f "$PREV" "$LIVE"; echo "↩ restored the previous corpus from ${PREV}"
  else rm -f "$LIVE"; echo "↩ removed the new corpus (first deploy: there was none before)"; fi
  restart_service || echo "  (the restart after the rollback failed too; check the service by hand)"
}
on_exit() {
  local code=$?
  trap - EXIT INT TERM HUP
  if [ "$SWAPPED" = 1 ]; then
    echo "✘ the deploy did not finish: rolling back"
    rollback
    [ "$code" = 0 ] && code=1
  fi
  exit "$code"
}
trap on_exit EXIT
trap 'exit 130' INT; trap 'exit 143' TERM; trap 'exit 129' HUP

# The new file inherits the live corpus's permissions (the service user may differ from
# the deployer, whose umask created it); a first deploy makes it world-readable (0644).
node -e 'const fs=require("fs"); const [n,l]=process.argv.slice(1); fs.chmodSync(n, fs.existsSync(l) ? fs.statSync(l).mode & 0o7777 : 0o644)' "$NEXT" "$LIVE"
# Swap: keep the live corpus as .prev (hard link), then rename next over live (atomic).
rm -f "$PREV"
if [ -e "$LIVE" ]; then ln "$LIVE" "$PREV"; HADLIVE=1; fi
SWAPPED=1
mv -f "$NEXT" "$LIVE"
echo "✔ swapped in the new corpus (the previous one is kept as ${PREV})"

echo "▶ restart ${SVC}…"
if ! restart_service; then echo "✘ restart failed"; exit 1; fi
ok=0
# Bound (realtime): wait at most ten health probes (about 30 s) for the restarted service. Overflow rolls back to the previous corpus and exits non-zero.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  sleep "${TRUSSC_HEALTH_WAIT:-3}"
  if body=$(sh -c "$HEALTH" 2>/dev/null) &&
     node -e 'const b=JSON.parse(process.argv[1]); process.exit(b.ok===true&&b.chunks===Number(process.argv[2])?0:1)' "$body" "$COUNT" 2>/dev/null; then
    ok=1; break
  fi
done
if [ "$ok" != 1 ]; then echo "✘ health check failed after the restart (want ok and ${COUNT} chunks)"; exit 1; fi
SWAPPED=0
echo "✔ deployed: ${SVC} is healthy and serves ${COUNT} chunks."
[ "${FAIR_EVAL_SKIP:-0}" = 1 ] || python3 eval/fair/gate.py accept "$LIVE"
