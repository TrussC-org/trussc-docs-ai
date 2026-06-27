// HTTP server for the TrussC docs-chat RAG pipeline.
//   node server.mjs   → http://localhost:8788
// Endpoints:
//   GET  /health   → { ok, chunks }                         (widget appearance gate)
//   GET  /         → demo.html                              (dev harness only)
//   POST /chat     → SSE stream (events: sources, links, token, done, error)  (widget)
//   POST /ask      → JSON { answer, links, sources }        (one-shot; CLI / tchat)
//   POST /search   → JSON { results:[{id,title,source,score,link,text}] }     (agents: retrieval only)
// POST bodies: { question, history?:[{role,content}], k? }.
// CORS is restricted to ALLOW_ORIGIN (default '*'; set to https://trussc.org in prod).
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { ask, retrieve, chunks, refLink } from './rag.mjs';

const PORT = process.env.PORT || 8788;
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';
const DEMO = new URL('./demo.html', import.meta.url).pathname;

chunks(); // warm-load the embeddings once at startup

// Tiny per-IP sliding-window rate limit (app-level defense; Cloudflare adds edge
// limiting on top). Behind a tunnel the real client IP is in cf-connecting-ip.
const RATE_MAX = Number(process.env.RATE_MAX || 30);
const RATE_WIN = Number(process.env.RATE_WIN || 60000);
const hits = new Map();
function rateLimited(ip) {
    const now = Date.now();
    const arr = (hits.get(ip) || []).filter((t) => now - t < RATE_WIN);
    arr.push(now);
    hits.set(ip, arr);
    return arr.length > RATE_MAX;
}

function readJson(req) {
    return new Promise((resolve) => {
        let b = '';
        req.on('data', (d) => (b += d));
        req.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve({}); } });
    });
}
async function collect(stream) { let s = ''; for await (const d of stream) s += d; return s; }
const sources = (retrieved) => retrieved.map((c) => ({ title: c.title, source: c.source, score: c.score, link: refLink(c) }));

const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGIN);
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

    if (url.pathname === '/health') return json(200, { ok: true, chunks: chunks().length });

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/demo.html')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(readFileSync(DEMO));
    }

    if (req.method === 'POST') {
        const ip = (req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '').toString();
        if (rateLimited(ip)) return json(429, { error: 'rate limited' });

        const body = await readJson(req);
        const question = (body.question || '').trim();
        const history = Array.isArray(body.history) ? body.history.slice(-6) : [];
        if (!question) return json(400, { error: 'no question' });

        // Agents: raw retrieval, no generation (fast; let the caller reason).
        if (url.pathname === '/search') {
            const k = Number(body.k || 8);
            const results = (await retrieve(question, k)).map((c) =>
                ({ id: c.id, title: c.title, source: c.source, score: c.score, link: refLink(c), text: c.text }));
            return json(200, { results });
        }

        // One-shot answer (CLI / tchat).
        if (url.pathname === '/ask') {
            const { retrieved, links, stream } = await ask(question, history);
            const answer = await collect(stream);
            return json(200, { answer, links, sources: sources(retrieved) });
        }

        // Streaming answer (widget).
        if (url.pathname === '/chat') {
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
            const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            try {
                const { retrieved, links, stream } = await ask(question, history);
                send('sources', sources(retrieved));
                send('links', links);
                for await (const delta of stream) send('token', delta);
                send('done', {});
            } catch (e) {
                send('error', String((e && e.message) || e));
            }
            return res.end();
        }
    }

    json(404, { error: 'not found' });
});

server.listen(PORT, () => console.log(`docs-chat → http://localhost:${PORT}  (${chunks().length} chunks, origin=${ALLOW_ORIGIN})`));
