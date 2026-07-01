# rerank-server — bge-reranker-v2-m3 as a local HTTP service

Cross-encoder rerank stage for the RAG pipeline. The main app (rag.mjs) retrieves a
broad candidate set with hybrid RRF, then — when `RERANK=1` — POSTs the top
`RERANK_CANDIDATES` here to be re-scored by a model that reads query+doc together.
This removes lexical noise (e.g. `Path::draw` riding the word "draw") that the
bi-encoder + BM25 let through.

Same pattern as Ollama: a local GPU HTTP service the Node app talks to. No sudo, no
Docker (the box has no nvidia-container-toolkit) — a Python venv on the GPU.

## Install (on the box, in this dir)

```bash
cd ~/trussc-docs-ai/rerank-server
python3 -m venv .venv && source .venv/bin/activate
pip install torch                 # default CUDA wheel; fine with recent drivers (580/CUDA13)
pip install -r requirements.txt   # pins transformers==4.45.2 (see below)
```

> **transformers is pinned to 4.45.2.** Newer transformers removed `prepare_for_model`
> from the slow XLM-R tokenizer, which FlagEmbedding's reranker calls, giving
> `AttributeError: XLMRobertaTokenizer has no attribute prepare_for_model`. If you hit
> that, `pip install "transformers==4.45.2" sentencepiece` and restart.

First run downloads the model (~2.3 GB) from HuggingFace into `~/.cache/huggingface`.

## Run

```bash
source .venv/bin/activate
uvicorn server:app --host 127.0.0.1 --port 8790
# smoke test:
curl -s localhost:8790/health
curl -s localhost:8790/rerank -H 'content-type: application/json' \
  -d '{"query":"draw a circle","texts":["drawCircle draws a circle","Path::draw renders a path","drawSphere draws a 3D sphere"]}'
```

## Run as a service (systemd --user, no sudo)

```bash
mkdir -p ~/.config/systemd/user
cp trussc-rerank.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now trussc-rerank
loginctl enable-linger $USER      # so it runs without an active login session
systemctl --user status trussc-rerank
```

## Enable it in the API

Add to the trussc-docs-ai systemd unit's environment, then restart it:

```
Environment=RERANK=1
Environment=RERANK_URL=http://127.0.0.1:8790
```

VRAM: ~2.3 GB (fp16) — fits alongside bge-m3 (~0.7 GB) on the 8 GB A1000. If the
reranker is down, the app silently falls back to RRF order (never breaks retrieval).
