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
import { logStat, hashIp, suggested, pipelineStat, requestClient, clientName, queryLanguage } from './stats.mjs';

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
        const t0 = Date.now();
        const endpoint = url.pathname.slice(1);
        const tracked = ['chat', 'ask', 'search', 'get', 'mcp'].includes(endpoint);
        // The stdio proxy still hits /search and /get. Its product UA identifies
        // those tool requests without adding headers, destinations or server env.
        const proxy = ['search', 'get'].includes(endpoint) && clientName(req.headers['user-agent']) === 'trussc-mcp-stdio';
        let body = {};
        const record = (fields = {}) => {
            if (!tracked) return;
            const query = ['chat', 'ask', 'search'].includes(endpoint) && typeof body.question === 'string' ? body.question.trim() : null;
            logStat({ ep: proxy ? 'mcp' : endpoint,
                tool: proxy ? (endpoint === 'search' ? 'trussc_search' : 'trussc_get') : null,
                client: requestClient(proxy ? 'mcp' : endpoint, req.headers, body),
                ip: hashIp(ip), ms: Date.now() - t0,
                qLen: query === null ? null : query.length, qLang: query === null ? null : queryLanguage(query), ...fields });
        };
        if (rateLimited(ip)) {
            record({ errorReason: 'rate', errorClass: 'Error' });
            return json(429, { error: 'rate limited' });
        }

        try { body = await readJson(req); }
        catch (error) {
            const tooLarge = error.reason === 'body';
            record({ errorReason: tooLarge ? 'body' : 'body-read', errorClass: 'Error' });
            const message = tooLarge ? 'request too large' : 'request read error';
            return json(tooLarge ? 413 : 400, url.pathname === '/mcp'
                ? { jsonrpc: '2.0', id: null, error: { code: -32000, message } }
                : { error: message });
        }

        // Remote MCP gateway (Streamable HTTP, stateless): body is a JSON-RPC message.
        // Retrieval runs locally (mcpSearch); notifications get a 202 with no body.
        if (url.pathname === '/mcp') {
            let pipeline = {}, failure = {}, queryText;
            const capture = fn => async (...args) => {
                try { return await fn(...args); }
                catch (error) {
                    failure = { ...pipelineStat(error), errorReason: error?.errorReason || 'request', errorClass: error?.errorClass || 'Error' };
                    throw error;
                }
            };
            const resp = await mcpDispatch(body, {
                search: capture(async (query, k, full, lang) => {
                    queryText = query;
                    const retrieved = await retrieve(query, k, { lang, ip });
                    pipeline = pipelineStat({ ...retrievalInfo(retrieved), rounds: 1, queries: [query] });
                    return searchResponse(retrieved, retrieved.map(c => toResult(c, full)));
                }),
                get: capture(getByIds),
            });
            const tool = body.method === 'tools/call' && ['trussc_search', 'trussc_get'].includes(body.params?.name) ? body.params.name : null;
            // Stateless: initialize metadata belongs to this row only. Never
            // associate a later call with another request's clientInfo.
            const clientInfo = body.method === 'initialize' ? {
                name: typeof body.params?.clientInfo?.name === 'string' ? body.params.clientInfo.name : null,
                version: typeof body.params?.clientInfo?.version === 'string' ? body.params.clientInfo.version : null,
            } : null;
            const failed = resp?.error || resp?.result?.isError;
            // Use the dispatcher's validated query; never coerce arbitrary JSON
            // again during logging (an object may have an invalid toString).
            const query = tool === 'trussc_search' ? queryText ??
                (typeof body.params?.arguments?.query === 'string' ? body.params.arguments.query.trim() : null) : null;
            record({ method: typeof body.method === 'string' ? body.method : null, tool,
                ...(clientInfo ? { clientInfo } : {}),
                ...(query !== null ? { qLen: query.length, qLang: queryLanguage(query) } : {}),
                ...(queryText !== undefined && !failed ? { q: queryText } : {}),
                ...pipeline, ...(failed ? { errorReason: 'mcp', errorClass: 'Error' } : {}), ...failure });
            if (!resp) { res.writeHead(202); return res.end(); }
            return json(200, resp);
        }

        // Fetch full chunks by id (retrieval-only, no question). Powers trussc_get.
        if (url.pathname === '/get') {
            const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === 'string').slice(0, 20) : [];
            try {
                const results = getByIds(ids);
                record();
                return json(200, { results });
            } catch (error) {
                record({ ...pipelineStat(error), errorReason: error?.errorReason || 'request', errorClass: error?.errorClass || 'Error' });
                return json(500, { error: String(error?.message || error) });
            }
        }

        const rawQuestion = typeof body.question === 'string' ? body.question : '';
        // Bound (security): retain six recent history turns. Overflow drops older turns and is not counted.
        const history = Array.isArray(body.history) ? body.history.slice(-6).filter(h =>
            h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string') : [];
        // Bound (security): question and each retained history entry allow 8000 UTF-16 code units. Overflow rejects with 400 and is counted.
        if (rawQuestion.length > 8000 || history.some(h => h.content.length > 8000)) {
            record({ errorReason: 'input-fields', errorClass: 'Error' });
            return json(400, { error: 'question or history too long' });
        }
        const question = rawQuestion.trim();
        const page = typeof body.page === 'string' ? body.page.slice(0, 64) : null;  // symbol the user is viewing
        // Carried-over "important" chunk ids the model curated on earlier turns
        // (recent-first). Bounded so a malicious client can't blow up the prompt.
        // Bound (security): retain at most forty pinned ids. Overflow drops later ids and is not counted.
        const pinned = Array.isArray(body.pinned) ? body.pinned.filter((x) => typeof x === 'string').slice(0, 40) : [];
        if (!question) {
            record({ errorReason: 'input', errorClass: 'Error' });
            return json(400, { error: 'no question' });
        }

        // Per-request stats context (pseudonymized IP + client hints + timer).
        const debug = body.debug === true && (url.pathname === '/ask' || url.pathname === '/chat');
        const stat = {
            ...(debug ? { debug: true } : {}),
            cid: (typeof body.convId === 'string' ? body.convId.slice(0, 64) : null), // groups rows into a thread
            turns: history.length / 2 | 0,
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
            record({ ...pipelineStat({ ...retrievalInfo(retrieved), rounds: 1, queries: [question] }), ...stat, q: question, n: retrieved.length, top: retrieved[0]?.score ?? null, sym: suggested(retrieved) });
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
            record({ ...pipelineStat(result), ...stat, q: question, a: text || '', corrected, n: retrieved.length, top: retrieved[0]?.score ?? null, links: links.map((l) => ({ label: l.label, source: l.source })), sym: suggested(retrieved) });
            const response = { answer: text, links, sources: sources(retrieved), corrected, usedIds, rounds, queries };
            if (debug) response.debug = publicDebug(result.traces);
            return json(200, response);
        }
        } catch (e) {
            record({ ...pipelineStat(e), ...stat, q: question, error: String((e && e.message) || e), errorReason: e?.errorReason || 'request', errorClass: e?.errorClass || 'Error' });
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
                record({ ...finalStats, ...stat, q: question, a: answerText, corrected, n: retrieved.length, top: retrieved[0]?.score ?? null, links: links.map((l) => ({ label: l.label, source: l.source })), sym: suggested(retrieved) });
            } catch (e) {
                send('error', String((e && e.message) || e));
                record({ ...pipelineStat(e), ...stat, q: question, error: String((e && e.message) || e), errorReason: e?.errorReason || 'request', errorClass: e?.errorClass || 'Error' });
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
