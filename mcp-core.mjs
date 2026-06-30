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
        'working example code, and addon usage. Returns the most relevant chunks ' +
        '(reference / doc / example / addon) ranked by semantic (bge-m3) similarity. ' +
        'Use a specific natural-language query, e.g. "draw a filled circle in a color", ' +
        '"load and play a sound file", "follow the mouse with a node", "send OSC".',
    inputSchema: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'Natural-language description of what you want to do in TrussC.' },
            k: { type: 'number', description: 'How many chunks to return (default 8).' },
        },
        required: ['query'],
    },
}];

// Full chunk text, never truncated — this is a grounding tool, and example chunks
// are whole multi-file sources the caller needs intact to write correct code. The
// result size is the CALLER's context budget (not the box's cost), so lower `k` for
// a leaner result rather than cutting chunks here.
export function formatResults(results, query) {
    if (!results || !results.length) return `No TrussC matches for "${query}".`;
    return results.map((c) =>
        `### [${c.source}] ${c.title}${c.link ? `  ·  ${c.link}` : ''}  (score ${Number(c.score).toFixed(3)})\n${c.text || ''}`
    ).join('\n\n---\n\n');
}

export async function dispatch(msg, searchFn) {
    const { id, method, params } = msg || {};
    if (id === undefined || id === null) return null;   // notification: no reply
    const ok = (result) => ({ jsonrpc: '2.0', id, result });
    const err = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
    try {
        if (method === 'initialize') return ok({
            protocolVersion: (params && params.protocolVersion) || '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'trussc-docs', version: '0.1.0' },
        });
        if (method === 'tools/list') return ok({ tools: TOOLS });
        if (method === 'ping') return ok({});
        if (method === 'tools/call') {
            if (!params || params.name !== 'trussc_search') return err(-32602, `unknown tool: ${params && params.name}`);
            const args = params.arguments || {};
            const query = String(args.query || '').trim();
            if (!query) return ok({ content: [{ type: 'text', text: 'error: empty query' }], isError: true });
            const k = Math.max(1, Math.min(20, Number(args.k) || 8));
            try {
                const results = await searchFn(query, k);
                return ok({ content: [{ type: 'text', text: formatResults(results, query) }] });
            } catch (e) {
                return ok({ content: [{ type: 'text', text: `error: ${String((e && e.message) || e)}` }], isError: true });
            }
        }
        return err(-32601, `method not found: ${method}`);
    } catch (e) {
        return err(-32603, String((e && e.message) || e));
    }
}
