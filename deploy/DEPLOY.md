# Deploy: api.trussc.org on the home Ubuntu server (Cloudflare Tunnel)

Two layers: **(A) the service** (Ollama + Node + this app) and **(B) exposure**
(Cloudflare Tunnel → `api.trussc.org`). Installing Ollama alone is NOT enough —
Ollama is just the LLM engine; the chat logic lives in this app.

## 0. Prerequisite
`trussc.org` must be a **Cloudflare zone** (its nameservers on Cloudflare) so the
tunnel can create the `api.trussc.org` DNS record. (DNS only — the static site can
stay on GitHub Pages; only the `api` subdomain routes to the tunnel.)
The home server needs **no port-forward and no inbound firewall rule** — the tunnel
dials out.

## A. The service

### 1. Node + Ollama
```bash
# Node (v24 LTS; nvm or distro package)
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt install -y nodejs
# Ollama (needs a recent version; qwen3.5:4b requires Ollama ≥ 0.30)
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen3.5:4b   # GEN_MODEL in the systemd unit — must match
ollama pull bge-m3
```

### 2. App + corpus
Pick an install dir and a service user (examples below use `/opt/trussc-docs-ai`
and a `trussc` user — adjust both to taste, e.g. your own user + home dir).
```bash
DEST=/opt/trussc-docs-ai          # where the app will live
SVCUSER=trussc                    # the user the service runs as
sudo mkdir -p "$DEST" && sudo chown "$SVCUSER:$SVCUSER" "$DEST"
# copy the project from your clone (run from the repo root, or git clone on the box)
git clone https://github.com/TrussC-org/trussc-docs-ai "$DEST"   # OR: rsync -a --exclude node_modules ./ user@SERVER:"$DEST"/
```
No machine-specific paths are baked in — `config.mjs` resolves everything from env
vars with sensible defaults, so the running server needs no edits. It serves
`chunks.embedded.json`, which is not in git: build it on the box (below) or copy one
built elsewhere (same `bge-m3` model → the embeddings are valid anywhere).

**Building the corpus.** It reads the TrussC core + trussc.org site
repos. By default `config.mjs` expects them as siblings of this repo
(`../TrussC`, `../trussc.org`); otherwise point `TRUSSC_REPO` / `SITE_REPO` at them
(or override the individual `FOR_AI` / `TRUSSC_API` / … vars):
```bash
cd "$DEST"
export TRUSSC_REPO=/path/to/TrussC SITE_REPO=/path/to/trussc.org
# build + check, and install the corpus only if every check passed
./update-corpus.sh --first-deploy && mv chunks.embedded.next.json chunks.embedded.json
```
After the smoke test (step 3) passes, make this corpus the fair eval gate's baseline:
`python3 eval/fair/gate.py accept chunks.embedded.json`. Once the service runs (step 4),
update it with `./update-corpus.sh --local` (see the README's Deploy section: guards,
swap, restart, health check, rollback).

### 3. Smoke test on the box
```bash
cd /opt/trussc-docs-ai && node server.mjs &
curl -s localhost:8788/health
curl -s localhost:8788/ask -d '{"question":"serialの使い方は？"}' | jq
kill %1
```

### 4. Run as a service
```bash
sudo cp deploy/trussc-docs-ai.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now trussc-docs-ai
systemctl status trussc-docs-ai
```

**The files in `deploy/` are templates.** They carry placeholders, not any real
box's paths or secrets, so editing them in place makes a diff that is only ever
noise for the next person. Keep a machine's own copy alongside them instead:

```bash
cp deploy/trussc-docs-ai.service deploy/trussc-docs-ai.service.local
cp deploy/cloudflared-config.yml deploy/cloudflared-config.local.yml
```

`deploy/*.local` and `deploy/*.local.*` are gitignored, so those hold the real
`User=`, `WorkingDirectory=` and node path for the box without ever being
committed.

**Secrets are the exception: keep them out of the repo directory entirely.**
`TYPESAFE_API_KEY`, `ANTHROPIC_API_KEY` and `STATS_SALT` belong only in the installed unit under
`/etc/systemd/system/`, and that file should be root-only — systemd does not
need it world-readable, and the default `cp` leaves it at 644:

```bash
sudo chmod 640 /etc/systemd/system/trussc-docs-ai.service
```

## B. Exposure — Cloudflare Tunnel

### 5. Install + auth
```bash
# install cloudflared (see Cloudflare docs for the apt repo), then:
cloudflared tunnel login                       # browser → pick the trussc.org zone
cloudflared tunnel create trussc-docs-ai     # prints <TUNNEL_ID> + creds json path
```

### 6. Config + DNS route
```bash
cp deploy/cloudflared-config.yml ~/.cloudflared/config.yml
# edit it: put in <TUNNEL_ID> and the creds path printed above
cloudflared tunnel route dns trussc-docs-ai api.trussc.org   # creates the CNAME automatically
```

### 7. Run the tunnel as a service
```bash
sudo cloudflared service install     # installs + starts cloudflared as systemd
# (or for a quick test: cloudflared tunnel run trussc-docs-ai)
```

### 8. Verify end-to-end
```bash
curl -s https://api.trussc.org/health
curl -s https://api.trussc.org/ask -d '{"question":"drawRectの使い方は？"}' | jq
```

## Notes
- **CORS**: the service sends `Access-Control-Allow-Origin: https://trussc.org`
  (via `ALLOW_ORIGIN` in the systemd unit). Add other origins (e.g. a staging site)
  there if needed.
- **Rate limit**: app-level (30 req/min/IP, tune via `RATE_MAX`/`RATE_WIN`). Add a
  Cloudflare WAF rate-limit rule on `api.trussc.org` for an edge layer too.
- **Updating the corpus**: `./update-corpus.sh --local` on the box (rebuild, guards,
  swap, restart, health check; see the README). `build-chunks` + `embed` alone only
  write `chunks.embedded.next.json` and change nothing the service serves.
- **Model swap**: change `GEN_MODEL` / `EMBED_MODEL` in the unit, `ollama pull` it,
  `sudo systemctl daemon-reload`, restart. Changing the embed model also needs a new
  corpus embedded with it, published together with the restart:
  `EMBED_MODEL=<new> ./update-corpus.sh --local` (the same model as the unit; the
  guards check the new corpus with it, and the swap restarts the service onto it).
- **Endpoints for clients**: widget → `POST /chat` (SSE); CLI/`tchat` → `POST /ask`;
  agents → `POST /search` (raw chunks).

Jev retrieval is enabled by default. The owner must add `TYPESAFE_API_KEY` to the
installed service environment and provide it to the operator's corpus-check process.
The fair retrieval script refuses missing credentials or fallback results. Keep
`RERANK=1` and the reranker available for fallback; use `RETRIEVAL=rerank` for the
operator kill switch. Set `GEN_BACKEND=anthropic` for native Haiku search rounds
(`MAX_SEARCH_ROUNDS=3` by default); Ollama answers remain single stage.

For owner one-time setup, follow the ordered list in README.md: configure the
installed unit's `Environment=` / `EnvironmentFile=`, pull, restart, check `/health`
and confirm `ask-cli --json` reports `debug.rounds[].path: "jev"`.
The service user can run `systemctl restart trussc-docs-ai` via polkit.
`update-corpus.sh` defaults to that command and uses it for rollback too. If stderr
reports an authorization failure, it prints a hint to rerun with
`TRUSSC_RESTART_CMD='sudo systemctl restart trussc-docs-ai'`; it never escalates
silently. Installing/editing a system unit and daemon-reload still require sudo.
The gate reads the operator shell environment, not the service environment:
export `TYPESAFE_API_KEY` in that shell using README.md's hidden `read -r -s`
prompt, and unset it afterwards. Do not put the value in history or the repository.

## Monthly stats deployment

The API writes directly to `STATS_DIR/YYYY-MM.jsonl`, using each row's `ts` UTC
month. `STATS_DIR` is defined in `config.mjs`; its default is the worktree's sibling
`../docs-ai-stats/` (`/home/toru/TrussC-dev/docs-ai-stats` in deployment).
`STATS_LOG` is removed. The directory holds stats only: nothing in it is executed
or sourced. The operator creates it before the switch with mode `0700`; new
monthly files use mode `0600`. Missing directories and failed appends drop stats
with one warning per process and do not fail requests. No rotation timer was
installed; the former script and unit templates are removed.

**Apply the pull and service unit drop-in together.** The sandbox change is
approved by secaudit, which prepares the drop-in and rollback script separately.
The drop-in replaces the legacy `stats.jsonl` bind with
`BindPaths=-/home/toru/TrussC-dev/docs-ai-stats` and adds
`ReadWritePaths=/home/toru/TrussC-dev/docs-ai-stats`, `UMask=0077` and
`LimitFSIZE=1G`. `ProtectHome=tmpfs` stays. The only new capability is creating
`YYYY-MM.jsonl` in `STATS_DIR`; no other read/write access, destination or service
environment variable is added. The repository does not provide the drop-in or
rollback script.

Right after the switch, ask runs a one-time migration outside the service:
split the legacy `stats.jsonl` lines by each row's `ts` UTC month and append them
to the matching monthly files (mode `0600`). Preserve the existing query/answer
text. Rename the legacy file to `stats.jsonl.migrated` when migration completes,
and delete that renamed file after one week. The report reads the legacy file
while it exists; finish the migration and rename before reporting to avoid
counting both the source and its monthly copies. No migration is run by the API.

```bash
node report.mjs 7
STATS_DIR=/path/to/monthly node report.mjs
node report.mjs --stats-dir /path/to/monthly --live /path/to/stats.jsonl
```

Run reporting outside the API sandbox. `--archive-dir` remains an alias for
`--stats-dir`. Monthly files and a missing legacy file are supported. Reporting
streams selected months and applies row filters before aggregation. Oversized
lines are skipped/counted, and bounded dimensions fold excess keys into `other`;
overflow diagnostics explain incomplete distinct counts or unavailable latency
percentiles. See [STATS.md](../STATS.md) for the schema and exact limits.
