# Run with .venv/bin/python test_server.py; the model is stubbed, no GPU or download.
import asyncio
import json
import sys
import types

stub = types.ModuleType("FlagEmbedding")


class FakeReranker:
    def __init__(self, *args, **kwargs):
        pass

    def compute_score(self, pairs, normalize=True):
        return [1.0 / (i + 1) for i in range(len(pairs))]


stub.FlagReranker = FakeReranker
sys.modules["FlagEmbedding"] = stub

from fastapi import HTTPException  # noqa: E402
from starlette.requests import Request  # noqa: E402
import server  # noqa: E402


def call(body, headers=None, chunks=None):
    """Run the /rerank handler on raw bytes; returns (status, payload)."""
    parts = chunks if chunks is not None else [body]
    queue = [{"type": "http.request", "body": p, "more_body": i < len(parts) - 1} for i, p in enumerate(parts)]

    async def receive():
        return queue.pop(0)

    if headers is None:
        headers = [(b"content-length", str(len(body)).encode())]
    request = Request({"type": "http", "method": "POST", "path": "/rerank", "headers": headers}, receive)
    try:
        return 200, asyncio.run(server.rerank(request))
    except HTTPException as e:
        return e.status_code, e.detail


def ok(query="q", texts=("a", "b")):
    return json.dumps({"query": query, "texts": list(texts)}).encode()


status, out = call(ok(texts=["a"] * 30))
assert status == 200 and len(out["results"]) == 30, (status, out)
assert call(ok(texts=["x" * 800] * 60))[0] == 200
assert call(ok(texts=[]))[1] == {"results": []}
assert call(ok(texts=["a"] * 65))[0] == 400
assert call(ok(texts=["x" * 4001]))[0] == 400
assert call(ok(texts=[1]))[0] == 400
assert call(b"{not json")[0] == 400
assert call(b"[]")[0] == 400
assert call(json.dumps({"texts": ["a"]}).encode())[0] == 400
big = b"x" * (server.MAX_BODY_BYTES + 1)
assert call(big)[0] == 413                                         # declared length
assert call(big, headers=[], chunks=[big[:1000], big[1000:]])[0] == 413   # streamed, no length
assert call(b"{}", headers=[(b"content-length", b"abc")])[0] == 413
assert call(ok(query="q" * 8603))[0] == 200                          # question + three re-search queries
assert call(ok(query="q" * 16385))[0] == 400
deep = b'{"query":' + b"[" * 20000 + b"0" + b"]" * 20000 + b',"texts":[]}'
assert call(deep)[0] == 400
small = ok()
assert call(small, headers=[(b"content-length", b"0" * 5000 + str(len(small)).encode())])[0] == 413
assert call(small, headers=[(b"content-length", "²".encode("latin-1", "replace"))])[0] == 413
body = server.app.openapi()["paths"]["/rerank"]["post"]["requestBody"]
assert body["content"]["application/json"]["schema"]["required"] == ["query", "texts"]
print("PASS rerank server request limits")
