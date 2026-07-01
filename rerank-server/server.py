# bge-reranker-v2-m3 rerank service (cross-encoder). Reads query+doc together and
# scores true relevance — used as the final stage after RRF to kill lexical noise.
#   POST /rerank {query, texts:[...]} -> {results:[{index, score}]}  (sorted desc)
#   GET  /health
# Run (see README.md): uvicorn server:app --host 127.0.0.1 --port 8790
import os
from fastapi import FastAPI
from pydantic import BaseModel
from FlagEmbedding import FlagReranker

MODEL = os.environ.get("RERANK_MODEL", "BAAI/bge-reranker-v2-m3")
# use_fp16 halves VRAM (~2.3GB) with negligible quality loss; uses GPU if torch sees one.
reranker = FlagReranker(MODEL, use_fp16=True)

app = FastAPI()


class RerankReq(BaseModel):
    query: str
    texts: list[str]


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL}


@app.post("/rerank")
def rerank(req: RerankReq):
    if not req.texts:
        return {"results": []}
    pairs = [[req.query, t] for t in req.texts]
    scores = reranker.compute_score(pairs, normalize=True)   # sigmoid → 0..1
    if not isinstance(scores, list):
        scores = [scores]
    results = sorted(
        ({"index": i, "score": float(s)} for i, s in enumerate(scores)),
        key=lambda x: x["score"], reverse=True,
    )
    return {"results": results}
