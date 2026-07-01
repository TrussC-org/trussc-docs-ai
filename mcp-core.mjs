// Shared MCP (JSON-RPC 2.0) protocol core for the TrussC docs grounding tool.
// One source of truth used by BOTH transports:
//   - mcp.mjs    : stdio, retrieval over HTTP /search (run locally / offline)
//   - server.mjs : POST /mcp, retrieval via local retrieve()  (api.trussc.org gateway)
// `dispatch(msg, searchFn)` handles one JSON-RPC message; searchFn(query,k) returns
// the chunk results array ({id,title,source,score,link,text}); returns the response
// object, or null for notifications (nothing to send back).

export const TOOLS = [{
    name: 'trussc_search',
    description:
        'Search the TrussC creative-coding framework: API reference, hand-written docs, ' +
        'runnable examples, and official addons. TrussC is a niche openFrameworks-like C++ ' +
        'framework (namespace `tc`, built on sokol) that model training data barely covers, ' +
        'so its priors are unreliable. Call this BEFORE writing, reviewing, or answering ' +
        'anything about TrussC C++ code to get the REAL API signatures, conventions ' +
        '(TAU not PI, colors are 0–1 floats, `using namespace tc`, include <TrussC.h>), ' +
        'working example code, and addon usage. Results are ranked by hybrid retrieval ' +
        '(BM25 over names + bge-m3 semantic, fused). Example chunks come back TRIMMED by ' +
        'default (header + start of source); pass full:true, or call trussc_get with the ' +
        'chunk id, to get the whole multi-file source. Use a specific natural-language ' +
        'query, e.g. "draw a filled circle in a color", "load and play a sound file".',
    inputSchema: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'Natural-language description of what you want to do in TrussC.' },
            k: { type: 'number', description: 'Max total results to return (default 8).' },
            full: { type: 'boolean', description: 'Return full untrimmed text for every result (default false; examples are trimmed). Prefer trussc_get for a specific chunk.' },
        },
        required: ['query'],
    },
}, {
    name: 'trussc_get',
    description:
        'Fetch the FULL text of specific TrussC corpus chunks by id — use after ' +
        'trussc_search to expand a trimmed example (or any chunk) to its complete ' +
        'multi-file source. Pass ids exactly as shown in results / the [#id] tags: ' +
        'API symbols are "symbol:drawCircle" / "symbol:Fbo::begin", plus ' +
        '"example:shaderExample", "addon:tcxOsc", "doc:...", "concept:...".',
    inputSchema: {
        type: 'object',
        properties: {
            ids: { type: 'array', items: { type: 'string' }, description: 'Chunk ids to fetch in full.' },
        },
        required: ['ids'],
    },
}];

// Render results. Score line shows the fused rank (rrf) alongside the raw cosine so
// the ordering is legible ("why is a 0.52 above a 0.55?" → different bm25 rank).
function scoreLine(c) {
    const cos = c.score == null ? null : `cos ${Number(c.score).toFixed(3)}`;
    const rrf = c.rrf == null ? null : `rrf ${Number(c.rrf).toFixed(4)}`;
    const rr = c.rerank == null ? null : `rr ${Number(c.rerank).toFixed(3)}`;
    const parts = [cos, rrf, rr].filter(Boolean).join(' · ');
    return parts ? `  (${parts})` : '';
}
export function formatResults(results, query) {
    if (!results || !results.length) return `No TrussC matches for "${query}".`;
    return results.map((c) =>
        `### [${c.source}] ${c.title}${c.link ? `  ·  ${c.link}` : ''}${scoreLine(c)}\n${c.text || ''}`
    ).join('\n\n---\n\n');
}

// handlers: { search(query, k, full) -> results[], get(ids) -> results[] }.
export async function dispatch(msg, handlers) {
    const { id, method, params } = msg || {};
    if (id === undefined || id === null) return null;   // notification: no reply
    const ok = (result) => ({ jsonrpc: '2.0', id, result });
    const err = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
    const toolText = (text, isError) => ok({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });
    try {
        if (method === 'initialize') return ok({
            protocolVersion: (params && params.protocolVersion) || '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'trussc-docs', version: '0.1.0' },
        });
        if (method === 'tools/list') return ok({ tools: TOOLS });
        if (method === 'ping') return ok({});
        if (method === 'tools/call') {
            const name = params && params.name;
            const args = (params && params.arguments) || {};
            try {
                if (name === 'trussc_search') {
                    const query = String(args.query || '').trim();
                    if (!query) return toolText('error: empty query', true);
                    const k = Math.max(1, Math.min(20, Number(args.k) || 8));
                    const results = (await handlers.search(query, k, !!args.full)).slice(0, k);
                    return toolText(formatResults(results, query));
                }
                if (name === 'trussc_get') {
                    const ids = Array.isArray(args.ids) ? args.ids.filter((x) => typeof x === 'string').slice(0, 20) : [];
                    if (!ids.length) return toolText('error: no ids', true);
                    const results = await handlers.get(ids);
                    if (!results.length) return toolText(`No chunks found for: ${ids.join(', ')}`);
                    return toolText(formatResults(results, ids.join(', ')));
                }
                return err(-32602, `unknown tool: ${name}`);
            } catch (e) {
                return toolText(`error: ${String((e && e.message) || e)}`, true);
            }
        }
        return err(-32601, `method not found: ${method}`);
    } catch (e) {
        return err(-32603, String((e && e.message) || e));
    }
}
