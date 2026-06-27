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
# Node (v18+; nvm or distro package)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
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
vars with sensible defaults, so the running server needs no edits. It serves the
committed `chunks.embedded.json`; nothing else is required to run.

**Rebuilding the corpus (optional).** Only needed if the docs changed and you want
to regenerate `chunks.embedded.json`. It reads the TrussC core + trussc.org site
repos. By default `config.mjs` expects them as siblings of this repo
(`../TrussC`, `../trussc.org`); otherwise point `TRUSSC_REPO` / `SITE_REPO` at them
(or override the individual `FOR_AI` / `TRUSSC_API` / … vars):
```bash
cd "$DEST"
TRUSSC_REPO=/path/to/TrussC SITE_REPO=/path/to/trussc.org node build-chunks.mjs && node embed.mjs
```
> Easiest path: just copy `chunks.embedded.json` over (it's committed) and skip the
> rebuild — same `bge-m3` model → the embeddings are valid anywhere.

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
- **Updating the corpus**: rebuild (`build-chunks` + `embed`) and
  `sudo systemctl restart trussc-docs-ai`.
- **Model swap**: change `GEN_MODEL` / `EMBED_MODEL` in the unit, `ollama pull` it,
  restart. (Changing the embed model requires re-running `embed.mjs`.)
- **Endpoints for clients**: widget → `POST /chat` (SSE); CLI/`tchat` → `POST /ask`;
  agents → `POST /search` (raw chunks).
