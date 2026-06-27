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
# Ollama
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen3:8b
ollama pull bge-m3
```

### 2. App + corpus
```bash
sudo mkdir -p /opt/trussc-docs-ai && sudo chown trussc:trussc /opt/trussc-docs-ai
# copy the project (config/build/embed/rag/server/ask/eval .mjs, demo.html, package.json)
rsync -a --exclude node_modules ~/Nextcloud/Make/TrussC/trussc-docs-ai/ trussc@SERVER:/opt/trussc-docs-ai/
```
The corpus (`chunks.embedded.json`) is needed at runtime. Either copy it over (same
`bge-m3` model → embeddings are valid) **or** rebuild on the box:
```bash
cd /opt/trussc-docs-ai && node build-chunks.mjs && node embed.mjs   # needs the TrussC + trussc.org repos present, see config.mjs paths
```
> Note: `config.mjs` points at local repo paths for the SOURCES (FOR_AI, reference-data.json,
> examples). For build-on-server, clone those repos and adjust the paths, or just copy
> `chunks.embedded.json` from your Mac and skip building on the server.

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
