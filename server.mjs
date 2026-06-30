// HTTP server for the TrussC docs-chat RAG pipeline.
//   node server.mjs   → http://localhost:8788
// Endpoints:
//   GET  /health   → { ok, chunks }                         (widget appearance gate)
//   GET  /         → demo.html                              (dev harness only)
//   POST /chat     → SSE stream (events: sources, links, token, done, error)  (widget)
//   POST /ask      → JSON { answer, links, sources }        (one-shot; CLI / tchat)
//   POST /search   → JSON { results:[{id,title,source,score,link,text}] }     (agents: retrieval only)
//   POST /mcp      → JSON-RPC 2.0 (Streamable HTTP MCP; tool: trussc_search)  (remote MCP gateway)
// POST bodies: { question, history?:[{role,content}], k? }.
// CORS is restricted to ALLOW_ORIGIN (default '*'; set to https://trussc.org in prod).
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { answer, answerStream, retrieve, chunks, refLink } from './rag.mjs';
import { dispatch as mcpDispatch } from './mcp-core.mjs';
import { WIDGET_FILE } from './config.mjs';
import { logStat, hashIp, suggested } from './stats.mjs';

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
const sources = (retrieved) => retrieved.map((c) => ({ title: c.title, source: c.source, score: c.score, link: refLink(c) }));

// Local retrieval for the MCP tool — same shape as /search results, but no HTTP
// round-trip (the box already has the corpus + bge).
async function mcpSearch(query, k) {
    const retrieved = await retrieve(query, k);
    return retrieved.map((c) => ({ id: c.id, title: c.title, source: c.source, score: c.score, link: refLink(c), text: c.text }));
}

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

    // Dev convenience: serve the canonical widget (a trussc.org asset) for the demo.
    // Optional — the deployed API box may not have the site repo checked out.
    if (req.method === 'GET' && url.pathname === '/chat-widget.js') {
        if (!existsSync(WIDGET_FILE)) return json(404, { error: 'widget not found (site repo absent)' });
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' });
        return res.end(readFileSync(WIDGET_FILE));
    }

    // Remote MCP clients may probe GET for a server→client SSE stream; we don't push,
    // so tell them to POST (they fall back to request/response, which is all we need).
    if (req.method === 'GET' && url.pathname === '/mcp') { res.writeHead(405, { allow: 'POST' }); return res.end(); }

    if (req.method === 'POST') {
        const ip = (req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '').toString();
        if (rateLimited(ip)) return json(429, { error: 'rate limited' });

        const body = await readJson(req);

        // Remote MCP gateway (Streamable HTTP, stateless): body is a JSON-RPC message.
        // Retrieval runs locally (mcpSearch); notifications get a 202 with no body.
        if (url.pathname === '/mcp') {
            const resp = await mcpDispatch(body, mcpSearch);
            if (!resp) { res.writeHead(202); return res.end(); }
            return json(200, resp);
        }

        const question = (body.question || '').trim();
        const history = Array.isArray(body.history) ? body.history.slice(-6) : [];
        const page = typeof body.page === 'string' ? body.page.slice(0, 64) : null;  // symbol the user is viewing
        // Carried-over "important" chunk ids the model curated on earlier turns
        // (recent-first). Bounded so a malicious client can't blow up the prompt.
        const pinned = Array.isArray(body.pinned) ? body.pinned.filter((x) => typeof x === 'string').slice(0, 40) : [];
        if (!question) return json(400, { error: 'no question' });

        // Per-request stats context (pseudonymized IP + client hints + timer).
        const t0 = Date.now();
        const stat = {
            cid: (typeof body.convId === 'string' ? body.convId.slice(0, 64) : null), // groups rows into a thread
            ip: hashIp(ip),
            ua: (req.headers['user-agent'] || '').slice(0, 200) || null,
            ref: (req.headers['referer'] || req.headers['origin'] || null),
            turns: history.length / 2 | 0,
            qlen: question.length,
        };

        // /search + /ask are awaited inline — wrap so an Ollama/LLM error returns
        // 500 instead of an unhandled rejection that would kill the whole daemon.
        try {
        // Agents: raw retrieval, no generation (fast; let the caller reason).
        if (url.pathname === '/search') {
            const k = Number(body.k || 8);
            const retrieved = await retrieve(question, k);
            const results = retrieved.map((c) =>
                ({ id: c.id, title: c.title, source: c.source, score: c.score, link: refLink(c), text: c.text }));
            logStat({ ep: 'search', ms: Date.now() - t0, ...stat, q: question, n: retrieved.length, top: retrieved[0]?.score ?? null, sym: suggested(retrieved) });
            return json(200, { results });
        }

        // One-shot answer (CLI / tchat). Includes the draft→verify→correct flow.
        if (url.pathname === '/ask') {
            const { retrieved, links, text, corrected, usedIds } = await answer(question, history, page, pinned);
            logStat({ ep: 'ask', ms: Date.now() - t0, ...stat, q: question, corrected, n: retrieved.length, top: retrieved[0]?.score ?? null, links: links.map((l) => ({ label: l.label, source: l.source })), sym: suggested(retrieved) });
            return json(200, { answer: text, links, sources: sources(retrieved), corrected, usedIds });
        }
        } catch (e) {
            logStat({ ep: url.pathname.slice(1), ms: Date.now() - t0, ...stat, q: question, error: String((e && e.message) || e) });
            return json(500, { error: String((e && e.message) || e) });
        }

        // Widget (streaming): tokens stream live as 'token' deltas; on the rare
        // verify-pass correction, a 'replace' event carries the whole corrected text.
        if (url.pathname === '/chat') {
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
            const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            try {
                let retrieved = [], links = [], corrected = false;
                for await (const ev of answerStream(question, history, page, pinned)) {
                    if (ev.type === 'meta') {
                        retrieved = ev.retrieved; links = ev.links;
                        send('sources', sources(retrieved));
                        send('links', links);
                    } else if (ev.type === 'delta') {
                        send('token', ev.text);            // append on the client
                    } else if (ev.type === 'replace') {
                        send('replace', ev.text);          // verify pass rewrote it → swap whole bubble
                    } else if (ev.type === 'final') {
                        corrected = ev.corrected;
                        send('done', { corrected, usedIds: ev.usedIds || [] });   // client folds usedIds into its pin ledger
                    }
                }
                logStat({ ep: 'chat', ms: Date.now() - t0, ...stat, q: question, corrected, n: retrieved.length, top: retrieved[0]?.score ?? null, links: links.map((l) => ({ label: l.label, source: l.source })), sym: suggested(retrieved) });
            } catch (e) {
                send('error', String((e && e.message) || e));
                logStat({ ep: 'chat', ms: Date.now() - t0, ...stat, q: question, error: String((e && e.message) || e) });
            }
            return res.end();
        }
    }

    json(404, { error: 'not found' });
});

server.listen(PORT, () => console.log(`docs-chat → http://localhost:${PORT}  (${chunks().length} chunks, origin=${ALLOW_ORIGIN})`));
