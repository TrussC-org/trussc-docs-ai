// Zero-dep stdio MCP server exposing the TrussC docs corpus as a grounding tool.
// Runs locally and proxies retrieval to the HTTP /search endpoint (bge-m3, NO
// generation) — for offline/localhost use or clients that prefer stdio. For a
// fully remote setup with NO local file, point your client at api.trussc.org/mcp
// instead (see MCP.md). Protocol lives in mcp-core.mjs (shared with server.mjs).
//
//   claude mcp add trussc-docs -- node /ABS/PATH/trussc-docs-ai/mcp.mjs
//   env TRUSSC_DOCS_API  (default https://api.trussc.org)
import { createInterface } from 'node:readline';
import { dispatch } from './mcp-core.mjs';

const API = (process.env.TRUSSC_DOCS_API || 'https://api.trussc.org').replace(/\/+$/, '');

async function httpSearch(query, k) {
    const r = await fetch(`${API}/search`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: query, k }),
    });
    if (!r.ok) throw new Error(`search ${r.status}: ${await r.text()}`);
    return (await r.json()).results || [];
}

const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
    line = line.trim();
    if (!line) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const resp = await dispatch(msg, httpSearch);
    if (resp) process.stdout.write(JSON.stringify(resp) + '\n');
});
