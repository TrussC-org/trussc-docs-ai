# bge-reranker-v2-m3 rerank service (cross-encoder). Reads query+doc together and
# scores true relevance — used as the final stage after RRF to kill lexical noise.
#   POST /rerank {query, texts:[...]} -> {results:[{index, score}]}  (sorted desc)
#   GET  /health
# Run (see README.md): uvicorn server:app --host 127.0.0.1 --port 8790
import json
import os
import re
from fastapi import FastAPI, HTTPException, Request
from starlette.concurrency import run_in_threadpool
from FlagEmbedding import FlagReranker

MODEL = os.environ.get("RERANK_MODEL", "BAAI/bge-reranker-v2-m3")
# use_fp16 halves VRAM (~2.3GB) with negligible quality loss; uses GPU if torch sees one.
reranker = FlagReranker(MODEL, use_fp16=True)

# Bound (cache): one request. docs-ai sends RERANK_CANDIDATES (default 30) texts of about
# 800 chars at most; its query is the question (<= 8000 chars) joined with up to three
# re-search queries (<= 200 chars each), about 8600 chars. vault-search sends 12 x 300 chars.
# Overflow is refused with 413 (body) or 400 (fields), never truncated.
MAX_TEXTS = 64
MAX_TEXT_CHARS = 4000
MAX_QUERY_CHARS = 16384
MAX_BODY_BYTES = 2 * 1024 * 1024   # JSON escapes can take 6 bytes per char

app = FastAPI()


async def read_body(request: Request) -> bytes:
    declared = request.headers.get("content-length")
    if declared is not None and (not re.fullmatch(r"[0-9]{1,12}", declared) or int(declared) > MAX_BODY_BYTES):
        raise HTTPException(413, "request body too large")
    body = bytearray()
    async for part in request.stream():
        body += part
        if len(body) > MAX_BODY_BYTES:
            raise HTTPException(413, "request body too large")
    return bytes(body)


def parse(body: bytes):
    try:
        req = json.loads(body)
    except (ValueError, RecursionError):   # RecursionError: nesting too deep for the parser
        raise HTTPException(400, "body must be JSON")
    if not isinstance(req, dict):
        raise HTTPException(400, "body must be a JSON object")
    query, texts = req.get("query"), req.get("texts")
    if not isinstance(query, str) or len(query) > MAX_QUERY_CHARS:
        raise HTTPException(400, f"query must be a string of at most {MAX_QUERY_CHARS} chars")
    if not isinstance(texts, list) or len(texts) > MAX_TEXTS:
        raise HTTPException(400, f"texts must be a list of at most {MAX_TEXTS} strings")
    if not all(isinstance(t, str) and len(t) <= MAX_TEXT_CHARS for t in texts):
        raise HTTPException(400, f"each text must be a string of at most {MAX_TEXT_CHARS} chars")
    return query, texts


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL}


# The handler reads the raw body to bound it, so the request schema is declared here.
REQUEST_SCHEMA = {
    "type": "object", "required": ["query", "texts"],
    "properties": {
        "query": {"type": "string", "maxLength": MAX_QUERY_CHARS},
        "texts": {"type": "array", "maxItems": MAX_TEXTS, "items": {"type": "string", "maxLength": MAX_TEXT_CHARS}},
    },
}


@app.post("/rerank", openapi_extra={
    "requestBody": {"required": True, "content": {"application/json": {"schema": REQUEST_SCHEMA}}},
    "responses": {"400": {"description": "invalid fields"}, "413": {"description": "request body too large"}},
})
async def rerank(request: Request):
    query, texts = parse(await read_body(request))
    if not texts:
        return {"results": []}
    pairs = [[query, t] for t in texts]
    # Off the event loop, as the old sync handler was.
    scores = await run_in_threadpool(reranker.compute_score, pairs, normalize=True)   # sigmoid → 0..1
    if not isinstance(scores, list):
        scores = [scores]
    results = sorted(
        ({"index": i, "score": float(s)} for i, s in enumerate(scores)),
        key=lambda x: x["score"], reverse=True,
    )
    return {"results": results}
