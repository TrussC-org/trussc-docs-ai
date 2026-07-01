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

async function post(path, payload) {
    const r = await fetch(`${API}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error(`${path} ${r.status}: ${await r.text()}`);
    return (await r.json()).results || [];
}
const handlers = {
    search: (query, k, full) => post('/search', { question: query, k, full }),
    get: (ids) => post('/get', { ids }),
};

const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
    line = line.trim();
    if (!line) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const resp = await dispatch(msg, handlers);
    if (resp) process.stdout.write(JSON.stringify(resp) + '\n');
});
