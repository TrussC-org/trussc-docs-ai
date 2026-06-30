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

// Cap each chunk: reference/doc/addon fit; full-source example chunks are huge, so
// trim to a head excerpt and point to the link. Keeps a k=8 result lean (~18KB).
const CAP = 2000;
export function formatResults(results, query) {
    if (!results || !results.length) return `No TrussC matches for "${query}".`;
    const body = (c) => {
        const t = c.text || '';
        return t.length <= CAP ? t : t.slice(0, CAP) + `\n… (truncated${c.link ? `; full at ${c.link}` : ''})`;
    };
    return results.map((c) =>
        `### [${c.source}] ${c.title}${c.link ? `  ·  ${c.link}` : ''}  (score ${Number(c.score).toFixed(3)})\n${body(c)}`
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
