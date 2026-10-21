#!/usr/bin/env bash
# External operator job; the API never reads the archive or runs this script.
# Usage: bash deploy/rotate-stats.sh [LIVE_STATS_JSONL [ARCHIVE_DIR]]
# Archive by the UTC month of the day before the rotation, not each row's ts
# month. The timer runs at 00:05 UTC, so that is the month of the rotated rows.
set -euo pipefail
umask 077
if (( $# > 2 )); then echo 'usage: rotate-stats.sh [stats.jsonl [archive-dir]]' >&2; exit 2; fi
live=${1:-"$(cd -- "$(dirname -- "$0")/.." && pwd)/stats.jsonl"}
archive=${2:-"$HOME/TrussC-dev/docs-ai-stats"}
if [[ $(basename -- "$live") != stats.jsonl || -L $live ]]; then
    echo 'live file must be a non-symlink stats.jsonl' >&2; exit 2
fi
mkdir -p -- "$archive"
chmod 700 -- "$archive"
# The persistent lock inode must not be removed/replaced after unlocking.
if [[ -L $archive/.rotate.lock ]]; then echo 'symlink lock refused' >&2; exit 2; fi
exec 9>>"$archive/.rotate.lock"
chmod 600 -- "$archive/.rotate.lock"
if ! flock -n 9; then echo 'another stats rotation holds the lock' >&2; exit 1; fi
# Repair modes on monthly archives from earlier invocations, even with no live data.
for existing in "$archive"/[0-9][0-9][0-9][0-9]-[0-9][0-9].jsonl; do
    [[ -e $existing || -L $existing ]] || continue
    if [[ -L $existing || ! -f $existing ]]; then echo 'non-regular archive refused' >&2; exit 2; fi
    chmod 600 -- "$existing"
done
[[ -e $live ]] || exit 0
[[ -f $live ]] || { echo 'stats.jsonl is not a regular file' >&2; exit 2; }
[[ -s $live ]] || exit 0
monthly="$archive/$(date -u -d yesterday +%Y-%m).jsonl"
if [[ -L $monthly ]]; then echo 'symlink archive refused' >&2; exit 2; fi
# Snapshot the byte count so a growing file cannot prolong the copy indefinitely.
# Copytruncate: a few concurrent appends between the snapshot and truncate can
# be lost (including a partial boundary line). This is accepted for usage stats.
bytes=$(stat -c %s -- "$live")
: >> "$monthly"
chmod 600 -- "$monthly"
head -c "$bytes" -- "$live" >> "$monthly"
truncate -s 0 -- "$live"
