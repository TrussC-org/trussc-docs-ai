#!/usr/bin/env bash
# Flow test for update-corpus.sh with every slow or privileged step stubbed:
# fetch/build/embed, the fair eval gate, the service restart and the health check.
# Runs in a temp dir; never touches this checkout's corpus, sudo or the network.
#   bash test-update-corpus.sh
set -uo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)/update-corpus.sh"
fails=0
ROOT=$(mktemp -d); trap 'rm -rf "$ROOT"' EXIT

setup() {   # setup <live: none|bad|COUNT>
  T=$(mktemp -d -p "$ROOT"); mkdir -p "$T/eval/fair"; cp "$SRC" "$T/"
  echo '' > "$T/fetch-releases.mjs"; echo '' > "$T/fetch-issues.mjs"; echo '' > "$T/build-chunks.mjs"
  cat > "$T/embed.mjs" <<'JS'
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.EMBEDDED_NEXT || 'chunks.embedded.next.json', JSON.stringify(Array.from({ length: Number(process.env.STUB_COUNT) }, () => ({ v: 'new' }))));
JS
  cat > "$T/eval/fair/gate.py" <<'PY'
import hashlib, os, sys, time
if sys.argv[1] == 'check' and os.environ.get('STUB_PAUSE'):
    open('paused', 'w').close()
    while not os.path.exists('resume'): time.sleep(0.05)
open('log', 'a').write(f"{sys.argv[1]} {sys.argv[2]} {hashlib.sha256(open(sys.argv[2], 'rb').read()).hexdigest()[:12]}\n")
sys.exit(int(os.environ.get('STUB_GATE', '0')) if sys.argv[1] == 'check' else 0)
PY
  case "$1" in
    none) ;;
    bad) echo '{not json' > "$T/chunks.embedded.json" ;;
    *) node -e 'require("fs").writeFileSync("'"$T"'/chunks.embedded.json", JSON.stringify(Array.from({length:'"$1"'}, () => ({v:"old"}))))' ;;
  esac
  : > "$T/log"
}

run() {   # run <args…>; env STUB_COUNT/STUB_GATE/STUB_HEALTH/STUB_RESTART set by the caller
  ( cd "$T" && TRUSSC_HEALTH_WAIT=0 \
      TRUSSC_RESTART_CMD='echo restart >> log; if [ "${STUB_RESTART:-ok}" = term ] && [ "$(grep -c ^restart log)" = 1 ]; then kill -TERM $PPID; fi; [ "${STUB_RESTART:-ok}" != bad ]' \
      TRUSSC_HEALTH_CMD='[ "${STUB_HEALTH:-ok}" = ok ] && node -e "const a=JSON.parse(require(\"fs\").readFileSync(\"chunks.embedded.json\"));console.log(JSON.stringify({ok:true,chunks:a.length}))"' \
      bash ./update-corpus.sh "$@" > out 2>&1 ); echo $?
}

live() { [ -e "$T/chunks.embedded.json" ] && node -e 'try{const a=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log(a[0].v+a.length)}catch{console.log("bad")}' "$T/chunks.embedded.json" || echo none; }
prev() { [ -e "$T/chunks.embedded.prev.json" ] && node -e 'const a=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log(a[0].v+a.length)' "$T/chunks.embedded.prev.json" || echo none; }
next() { [ -e "$T/chunks.embedded.next.json" ] && echo yes || echo no; }
n() { grep -c "^$1" "$T/log"; }

expect() {   # expect <name> <got> <want>
  if [ "$2" = "$3" ]; then echo "  ok   $1"; else echo "  FAIL $1: got '$2', want '$3'"; sed 's/^/       | /' "$T/out"; fails=$((fails+1)); fi
}

echo "success (--local)"
setup 100; code=$(STUB_COUNT=100 run --local)
expect exit "$code" 0; expect live "$(live)" new100; expect prev "$(prev)" old100; expect next "$(next)" no
expect restarts "$(n restart)" 1; expect checks "$(n check)" 1; expect accepts "$(n accept)" 1
expect "accept is the checked corpus" "$(grep ^accept "$T/log" | cut -d' ' -f3)" "$(grep ^check "$T/log" | cut -d' ' -f3)"

echo "count guard blocks a >5% shrink"
setup 100; code=$(STUB_COUNT=94 run --local)
expect exit "$code" 1; expect live "$(live)" old100; expect next "$(next)" yes
expect restarts "$(n restart)" 0; expect checks "$(n check)" 0; expect accepts "$(n accept)" 0

echo "count guard allows a 5% shrink"
setup 100; code=$(STUB_COUNT=95 run --local)
expect exit "$code" 0; expect live "$(live)" new95

echo "gate failure leaves the live corpus"
setup 100; code=$(STUB_COUNT=100 STUB_GATE=1 run --local)
expect exit "$code" 1; expect live "$(live)" old100; expect prev "$(prev)" none
expect restarts "$(n restart)" 0; expect accepts "$(n accept)" 0

echo "health failure restores .prev and restarts again"
setup 100; code=$(STUB_COUNT=100 STUB_HEALTH=bad run --local)
expect exit "$code" 1; expect live "$(live)" old100; expect restarts "$(n restart)" 2; expect accepts "$(n accept)" 0

echo "restart failure restores .prev"
setup 100; code=$(STUB_COUNT=100 STUB_RESTART=bad run --local)
expect exit "$code" 1; expect live "$(live)" old100; expect restarts "$(n restart)" 2; expect accepts "$(n accept)" 0

echo "no live corpus blocks without --first-deploy"
setup none; code=$(STUB_COUNT=100 run --local)
expect exit "$code" 1; expect live "$(live)" none; expect checks "$(n check)" 0; expect restarts "$(n restart)" 0

echo "--first-deploy with no live corpus"
setup none; code=$(STUB_COUNT=100 run --local --first-deploy)
expect exit "$code" 0; expect live "$(live)" new100; expect prev "$(prev)" none; expect accepts "$(n accept)" 1

echo "unreadable live corpus blocks"
setup bad; code=$(STUB_COUNT=100 run --local --first-deploy)
expect exit "$code" 1; expect live "$(live)" bad; expect checks "$(n check)" 0

echo "empty new corpus blocks"
setup none; code=$(STUB_COUNT=0 run --local --first-deploy)
expect exit "$code" 1; expect live "$(live)" none

echo "SIGTERM after the swap rolls back"
setup 100; code=$(STUB_COUNT=100 STUB_RESTART=term run --local)
expect exit "$code" 143; expect live "$(live)" old100; expect restarts "$(n restart)" 2; expect accepts "$(n accept)" 0

echo "failed first deploy removes the new corpus"
setup none; code=$(STUB_COUNT=100 STUB_HEALTH=bad run --local --first-deploy)
expect exit "$code" 1; expect live "$(live)" none; expect restarts "$(n restart)" 2; expect accepts "$(n accept)" 0

echo "lock holds while the script file is replaced (as a git pull would)"
setup 100
( cd "$T" && STUB_COUNT=100 STUB_PAUSE=1 TRUSSC_HEALTH_WAIT=0 TRUSSC_RESTART_CMD=true \
    TRUSSC_HEALTH_CMD='node -e "console.log(JSON.stringify({ok:true,chunks:100}))"' bash ./update-corpus.sh --local > out1 2>&1; echo $? > code1 ) &
for _ in $(seq 100); do [ -e "$T/paused" ] && break; sleep 0.05; done
cp "$T/update-corpus.sh" "$T/u.tmp" && mv "$T/u.tmp" "$T/update-corpus.sh"
code=$(STUB_COUNT=100 run --local)
expect "second run refused" "$code" 1; expect "says locked" "$(grep -c 'another update-corpus.sh' "$T/out")" 1
touch "$T/resume"; wait
expect "first run finished" "$(cat "$T/code1")" 0; expect live "$(live)" new100; expect prev "$(prev)" old100

echo "a caller's EMBEDDED_NEXT cannot redirect the embedder onto the live corpus"
setup 100; code=$(STUB_COUNT=100 STUB_GATE=1 EMBEDDED_NEXT="$T/chunks.embedded.json" run --local)
expect exit "$code" 1; expect live "$(live)" old100; expect checks "$(n check)" 1

echo "the new corpus keeps the live corpus's mode under a strict umask"
setup 100; chmod 644 "$T/chunks.embedded.json"; code=$(umask 077; STUB_COUNT=100 run --local)
expect exit "$code" 0; expect live "$(live)" new100; expect mode "$(stat -c %a "$T/chunks.embedded.json")" 644
setup none; code=$(umask 077; STUB_COUNT=100 run --local --first-deploy)
expect "first deploy mode" "$(stat -c %a "$T/chunks.embedded.json")" 644

echo "check only (no --local)"
setup 100; code=$(STUB_COUNT=100 run)
expect exit "$code" 0; expect live "$(live)" old100; expect next "$(next)" yes
expect restarts "$(n restart)" 0; expect accepts "$(n accept)" 0

echo "a deploy host is refused"
setup 100; code=$(STUB_COUNT=100 run somehost)
expect exit "$code" 2; expect checks "$(n check)" 0
setup 100; code=$(STUB_COUNT=100 TRUSSC_DEPLOY_HOST=somehost run --local)
expect "env host exit" "$code" 2; expect checks "$(n check)" 0

[ "$fails" = 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }
