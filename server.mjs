// HTTP server for the TrussC docs-chat RAG pipeline.
//   node server.mjs   → http://localhost:8788
// Endpoints:
//   GET  /health   → { ok, chunks }                         (widget appearance gate)
//   GET  /         → demo.html                              (dev harness only)
//   POST /chat     → SSE stream (events: sources, links, research, token, replace, done, error)  (widget)
//   POST /ask      → JSON { answer, links, sources }        (one-shot; CLI / tchat)
//   POST /search   → JSON { results:[{id,title,source,score,rrf,link,text}] }  (agents: retrieval only; body.full for whole text)
//   POST /get      → JSON { results:[...] } by body.ids (full text)            (fetch specific chunks)
//   POST /mcp      → JSON-RPC 2.0 (Streamable HTTP MCP; trussc_search/trussc_get)  (remote MCP gateway)
// POST bodies: { question, history?:[{role,content}], k? }.
// CORS is restricted to ALLOW_ORIGIN (default '*'; set to https://trussc.org in prod).
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { answer, answerStream, retrieve, chunks, refLink, leanText, getByIds, retrievalInfo } from './rag.mjs';
import { dispatch as mcpDispatch, searchResponse } from './mcp-core.mjs';
import { WIDGET_FILE, MAX_BODY_BYTES } from './config.mjs';
import { publicDebug } from './debug.mjs';
import { logStat, hashIp, suggested, pipelineStat } from './stats.mjs';

const PORT = process.env.PORT || 8788;
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';
const DEMO = fileURLToPath(new URL('./demo.html', import.meta.url));

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
    return new Promise((resolve, reject) => {
        let buffer = null, bytes = 0;
        const cleanup = () => {
            req.removeListener('data', data);
            req.removeListener('end', end);
            req.removeListener('aborted', aborted);
            req.removeListener('error', failed);
        };
        const failed = () => { cleanup(); buffer = null; reject(new Error('request read error')); };
        const aborted = failed;
        const data = (chunk) => {
            // Bound (security): cap ingress bytes; a contiguous accumulator retains at most about 2 x MAX_BODY_BYTES during growth. Overflow drains the request, returns 413 and is counted.
            const length = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
            const needed = bytes + length;
            if (needed > MAX_BODY_BYTES) {
                cleanup(); buffer = null;
                // Drain without a data listener so the response can reach the client.
                req.on('error', () => {});
                req.resume();
                const error = new Error('request too large'); error.reason = 'body';
                reject(error); return;
            }
            if (needed > (buffer?.length ?? 0)) {
                const capacity = Math.min(MAX_BODY_BYTES, Math.max(needed, buffer ? buffer.length * 2 : 16384));
                const grown = Buffer.allocUnsafe(capacity);
                if (buffer) buffer.copy(grown, 0, 0, bytes);
                buffer = grown;
            }
            if (length) {
                if (Buffer.isBuffer(chunk)) chunk.copy(buffer, bytes);
                else buffer.write(chunk, bytes, length, 'utf8');
            }
            bytes = needed;
        };
        const end = () => {
            cleanup();
            try { resolve(JSON.parse(buffer ? buffer.toString('utf8', 0, bytes) : '') ?? {}); }
            catch { resolve({}); }
            buffer = null;
        };
        req.on('data', data); req.on('end', end);
        req.on('error', failed); req.on('aborted', aborted);
    });
}
const sources = (retrieved) => retrieved.map((c) => ({ title: c.title, source: c.source, score: c.score, link: refLink(c) }));

// A retrieved chunk → the /search result shape. `full` keeps whole text; otherwise
// examples are trimmed to a head excerpt (leanText).
const toResult = (c, full) => {
    const link = refLink(c);
    return { id: c.id, title: c.title, source: c.source, score: c.score, ...(typeof c.p === 'number' ? { p: c.p } : {}), rrf: c.rrf ?? null, rerank: c.rerank ?? null, link, text: full ? (c.text || '') : leanText({ ...c, link }) };
};
// Handlers for the MCP tools — local (no HTTP round-trip; the box has corpus + bge).
const mcpHandlers = (ip) => ({
    search: async (query, k, full, lang) => {
        const retrieved = await retrieve(query, k, { lang, ip });
        logStat({ ep: 'mcp', ip: hashIp(ip), q: query, ...pipelineStat({ ...retrievalInfo(retrieved), rounds: 1, queries: [query] }) });
        return searchResponse(retrieved, retrieved.map((c) => toResult(c, full)));
    },
    get: async (ids) => getByIds(ids),   // getByIds already returns full text
});

export const server = createServer(async (req, res) => {
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

        let body;
        try { body = await readJson(req); }
        catch (error) {
            const tooLarge = error.reason === 'body';
            logStat({ ep: url.pathname.slice(1), errorReason: tooLarge ? 'body' : 'body-read' });
            const message = tooLarge ? 'request too large' : 'request read error';
            return json(tooLarge ? 413 : 400, url.pathname === '/mcp'
                ? { jsonrpc: '2.0', id: null, error: { code: -32000, message } }
                : { error: message });
        }

        // Remote MCP gateway (Streamable HTTP, stateless): body is a JSON-RPC message.
        // Retrieval runs locally (mcpSearch); notifications get a 202 with no body.
        if (url.pathname === '/mcp') {
            const resp = await mcpDispatch(body, mcpHandlers(ip));
            if (!resp) { res.writeHead(202); return res.end(); }
            return json(200, resp);
        }

        // Fetch full chunks by id (retrieval-only, no question). Powers trussc_get.
        if (url.pathname === '/get') {
            const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === 'string').slice(0, 20) : [];
            return json(200, { results: getByIds(ids) });
        }

        const rawQuestion = typeof body.question === 'string' ? body.question : '';
        // Bound (security): retain six recent history turns. Overflow drops older turns and is not counted.
        const history = Array.isArray(body.history) ? body.history.slice(-6).filter(h =>
            h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string') : [];
        // Bound (security): question and each retained history entry allow 8000 UTF-16 code units. Overflow rejects with 400 and is counted.
        if (rawQuestion.length > 8000 || history.some(h => h.content.length > 8000)) {
            logStat({ ep: url.pathname.slice(1), errorReason: 'input-fields' });
            return json(400, { error: 'question or history too long' });
        }
        const question = rawQuestion.trim();
        const page = typeof body.page === 'string' ? body.page.slice(0, 64) : null;  // symbol the user is viewing
        // Carried-over "important" chunk ids the model curated on earlier turns
        // (recent-first). Bounded so a malicious client can't blow up the prompt.
        // Bound (security): retain at most forty pinned ids. Overflow drops later ids and is not counted.
        const pinned = Array.isArray(body.pinned) ? body.pinned.filter((x) => typeof x === 'string').slice(0, 40) : [];
        if (!question) return json(400, { error: 'no question' });

        // Per-request stats context (pseudonymized IP + client hints + timer).
        const t0 = Date.now();
        const debug = body.debug === true && (url.pathname === '/ask' || url.pathname === '/chat');
        const stat = {
            ...(debug ? { debug: true } : {}),
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
        // Agents: raw retrieval, no generation (fast; let the caller reason). Examples
        // are trimmed unless full:true; each result carries cosine + fused rrf.
        if (url.pathname === '/search') {
            const k = Number(body.k || 8);
            const retrieved = await retrieve(question, k, { lang: body.lang, ip });   // body.lang:'lua' for TrussSketch; else C++ (default)
            const results = retrieved.map((c) => toResult(c, !!body.full));
            logStat({ ...pipelineStat({ ...retrievalInfo(retrieved), rounds: 1, queries: [question] }), ep: 'search', ms: Date.now() - t0, ...stat, q: question, n: retrieved.length, top: retrieved[0]?.score ?? null, sym: suggested(retrieved) });
            const info = retrievalInfo(retrieved);
            return json(200, { ...searchResponse(retrieved, results), rounds: 1, queries: [question], jevMs: info.jevMs, haikuMs: 0, jevEstimatedTokens: info.jevEstimatedTokens });
        }

        // Generation opts are allowlisted as { ip } here and in /chat below.
        // Never spread body, history metadata, headers or query params into opts;
        // fillerTokens/thinkingBudget belong only to in-process offline callers.
        // One-shot answer (CLI / tchat). Includes the draft→verify→correct flow.
        if (url.pathname === '/ask') {
            const result = await answer(question, history, page, pinned, undefined, { ip });
            const { retrieved, links, text, corrected, usedIds, rounds, queries } = result;
            logStat({ ...pipelineStat(result), ep: 'ask', ms: Date.now() - t0, ...stat, q: question, a: (text || '').slice(0, 4000), corrected, n: retrieved.length, top: retrieved[0]?.score ?? null, links: links.map((l) => ({ label: l.label, source: l.source })), sym: suggested(retrieved) });
            const response = { answer: text, links, sources: sources(retrieved), corrected, usedIds, rounds, queries };
            if (debug) response.debug = publicDebug(result.traces);
            return json(200, response);
        }
        } catch (e) {
            logStat({ ep: url.pathname.slice(1), ms: Date.now() - t0, ...stat, q: question, error: String((e && e.message) || e), errorReason: e?.errorReason, errorClass: e?.errorClass, haikuCalls: e?.haikuCalls ?? 0, idOnlyCards: e?.idOnlyCards ?? [], idOnlyCardsTotal: e?.idOnlyCardsTotal ?? 0, estInputTokens: e?.estInputTokens ?? [] });
            return json(500, { error: String((e && e.message) || e) });
        }

        // Widget (streaming): tokens stream live as 'token' deltas; on the rare
        // verify-pass correction, a 'replace' event carries the whole corrected text.
        if (url.pathname === '/chat') {
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
            const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            try {
                let retrieved = [], links = [], corrected = false, answerText = '', finalStats = {};
                for await (const ev of answerStream(question, history, page, pinned, undefined, { ip })) {
                    if (ev.type === 'meta') {
                        retrieved = ev.retrieved; links = ev.links;
                        send('sources', sources(retrieved));
                        send('links', links);
                    } else if (ev.type === 'research') {
                        send('research', { round: ev.round, message: ev.message, queries: ev.queries });
                    } else if (ev.type === 'delta') {
                        send('token', ev.text);            // append on the client
                        answerText += ev.text;
                    } else if (ev.type === 'replace') {
                        send('replace', ev.text);          // verify pass rewrote it → swap whole bubble
                        answerText = ev.text;
                    } else if (ev.type === 'final') {
                        corrected = ev.corrected;
                        finalStats = pipelineStat(ev);
                        if (debug) send('debug', publicDebug(ev.traces));
                        send('done', { corrected, usedIds: ev.usedIds || [], rounds: ev.rounds, queries: ev.queries });   // client folds usedIds into its pin ledger
                    }
                }
                logStat({ ...finalStats, ep: 'chat', ms: Date.now() - t0, ...stat, q: question, a: answerText.slice(0, 4000), corrected, n: retrieved.length, top: retrieved[0]?.score ?? null, links: links.map((l) => ({ label: l.label, source: l.source })), sym: suggested(retrieved) });
            } catch (e) {
                send('error', String((e && e.message) || e));
                logStat({ ep: 'chat', ms: Date.now() - t0, ...stat, q: question, error: String((e && e.message) || e), errorReason: e?.errorReason, errorClass: e?.errorClass, haikuCalls: e?.haikuCalls ?? 0, idOnlyCards: e?.idOnlyCards ?? [], idOnlyCardsTotal: e?.idOnlyCardsTotal ?? 0, estInputTokens: e?.estInputTokens ?? [] });
            }
            return res.end();
        }
    }

    json(404, { error: 'not found' });
});

function isEntryPoint() {
    try { return !!process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]); }
    catch { return false; }
}
if (isEntryPoint()) server.listen(PORT, () => console.log(`docs-chat → http://localhost:${PORT}  (${chunks().length} chunks, origin=${ALLOW_ORIGIN})`));
