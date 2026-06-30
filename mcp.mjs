// Zero-dep stdio MCP server exposing the TrussC docs corpus as a grounding tool.
// It is a thin proxy over the /search endpoint (bge-m3 retrieval, NO generation),
// so any MCP client (Claude Code, Claude Desktop, Cursor…) can ground itself in
// real TrussC APIs without paying for hosted generation — the caller's own model
// does the writing. Speak JSON-RPC 2.0 over stdio, newline-delimited.
//
//   Add to Claude Code:
//     claude mcp add trussc-docs -- node /ABS/PATH/trussc-docs-ai/mcp.mjs
//   Point elsewhere with env TRUSSC_DOCS_API (default https://api.trussc.org).
import { createInterface } from 'node:readline';

const API = (process.env.TRUSSC_DOCS_API || 'https://api.trussc.org').replace(/\/+$/, '');

const TOOLS = [{
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

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyErr(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function runSearch(args) {
    const query = (args && args.query || '').trim();
    if (!query) return { content: [{ type: 'text', text: 'error: empty query' }], isError: true };
    const r = await fetch(`${API}/search`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: query, k: Math.max(1, Math.min(20, Number(args.k) || 8)) }),
    });
    if (!r.ok) return { content: [{ type: 'text', text: `error: search ${r.status}: ${await r.text()}` }], isError: true };
    const { results = [] } = await r.json();
    if (!results.length) return { content: [{ type: 'text', text: `No TrussC matches for "${query}".` }] };
    // Cap each chunk: reference/doc/addon fit easily; full-source example chunks are
    // huge, so trim to a head excerpt and point to the link for the rest. Keeps a
    // k=8 result lean (~16KB) instead of 100KB+ of example source.
    const CAP = 2000;
    const body = (c) => {
        const t = c.text || '';
        if (t.length <= CAP) return t;
        return t.slice(0, CAP) + `\n… (truncated${c.link ? `; full at ${c.link}` : ''})`;
    };
    const text = results.map((c) =>
        `### [${c.source}] ${c.title}${c.link ? `  ·  ${c.link}` : ''}  (score ${Number(c.score).toFixed(3)})\n${body(c)}`
    ).join('\n\n---\n\n');
    return { content: [{ type: 'text', text }] };
}

const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
    line = line.trim();
    if (!line) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const { id, method, params } = msg;
    // Notifications carry no id and expect no response.
    if (id === undefined || id === null) return;
    try {
        if (method === 'initialize') {
            reply(id, {
                protocolVersion: (params && params.protocolVersion) || '2024-11-05',
                capabilities: { tools: {} },
                serverInfo: { name: 'trussc-docs', version: '0.1.0' },
            });
        } else if (method === 'tools/list') {
            reply(id, { tools: TOOLS });
        } else if (method === 'tools/call') {
            if (params && params.name === 'trussc_search') reply(id, await runSearch(params.arguments || {}));
            else replyErr(id, -32602, `unknown tool: ${params && params.name}`);
        } else if (method === 'ping') {
            reply(id, {});
        } else {
            replyErr(id, -32601, `method not found: ${method}`);
        }
    } catch (e) {
        replyErr(id, -32603, String((e && e.message) || e));
    }
});
