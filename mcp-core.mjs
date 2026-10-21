// Shared MCP (JSON-RPC 2.0) protocol core for the TrussC docs grounding tool.
// One source of truth used by BOTH transports:
//   - mcp.mjs    : stdio, retrieval over HTTP /search (run locally / offline)
//   - server.mjs : POST /mcp, retrieval via local retrieve()  (api.trussc.org gateway)
// `dispatch(msg, searchFn)` handles one JSON-RPC message; searchFn(query,k) returns
// {results, path, exists, missingSymbols, candidates} (legacy arrays also work); returns the response
// object, or null for notifications (nothing to send back).

export const TOOLS = [{
    name: 'trussc_search',
    description:
        'Search the TrussC creative-coding framework: API reference, hand-written docs, ' +
        'runnable examples, official addons, release notes, and known open bugs (GitHub issues). TrussC is a niche openFrameworks-like C++ ' +
        'framework (namespace `tc`, built on sokol) that model training data barely covers, ' +
        'so its priors are unreliable. Call this BEFORE writing, reviewing, or answering ' +
        'anything about TrussC C++ code to get the REAL API signatures, conventions ' +
        '(TAU not PI, colors are 0–1 floats, `using namespace tc`, include <TrussC.h>), ' +
        'working example code, and addon usage. Example chunks come back TRIMMED by ' +
        'default (header + start of source); pass full:true, or call trussc_get with the ' +
        'chunk id, to get the whole multi-file source. Use a specific natural-language ' +
        'query, e.g. "draw a filled circle in a color", "load and play a sound file". ' +
        'Set lang:"lua" for TrussSketch (the in-browser Lua playground) to get Lua-flavored ' +
        'cards (colon methods, Type.new, end_fbo/end_shader/end_cam) instead of the C++ API. ' +
        'Results may include a line saying a name does not appear in the documentation, ' +
        'near names, or a notice that the results probably do not answer the query. ' +
        'These results are labelled as closest matches. Cards show ids, followed by ' +
        'Other possibly related titles and ids for follow-up with trussc_get.',
    inputSchema: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'Natural-language description of what you want to do in TrussC.' },
            k: { type: 'number', description: 'Max total results to return (default 8).' },
            full: { type: 'boolean', description: 'Return full untrimmed text for every result (default false; examples are trimmed). Prefer trussc_get for a specific chunk.' },
            lang: { type: 'string', enum: ['cpp', 'lua'], description: 'API flavor: "cpp" (default, the C++ framework) or "lua" (TrussSketch playground — prefers the Lua twin of each symbol, hides nothing else).' },
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
        '"example:shaderExample", "addon:tcxOsc", "release:v0.6.2", "issue:257", "doc:...", "concept:...".',
    inputSchema: {
        type: 'object',
        properties: {
            ids: { type: 'array', items: { type: 'string' }, description: 'Chunk ids to fetch in full.' },
        },
        required: ['ids'],
    },
}];

// Conservative query heuristic: judge only the leading owner of :: names, or
// bare words with an internal lower-to-upper transition (drawCircle / CudaGraph).
// Dot/colon spellings, filenames and operators abstain. Sentence-case English,
// acronyms and short bare words are ignored. Members cannot be enumerated reliably.
const NON_API_WORDS = new Set(['TrussC', 'TrussSketch', 'openFrameworks', 'OpenFrameworks', 'OpenGL', 'OpenAL', 'OpenCV', 'WebGL', 'WebGPU', 'GitHub', 'JavaScript', 'TypeScript', 'macOS', 'iOS', 'std', 'chrono', 'filesystem', 'this_thread', 'ranges']);
const normalizeSymbol = name => name.replace(/^(?:tc|tcx)::/i, '');
// Bound (lexical work/allocation): spans longer than 96 code units are skipped
// BEFORE slicing, normalizing or regex matching. Only that span is skipped;
// unrelated names remain checkable. The character pass is linear.
const symbolPattern = /^[A-Za-z_][A-Za-z0-9_]*(?:(?:::|[.:])[A-Za-z_][A-Za-z0-9_]*)*$/;
const lexical = code => code >= 65 && code <= 90 || code >= 97 && code <= 122 ||
    code >= 48 && code <= 57 || code === 95 || code === 46 || code === 58;
const separator = ch => ch === '.' || ch === ':';
function scanIdentifiers(input, visit, limit = input.length, spaced = false) {
    for (let i = 0; i < limit;) {
        if (!lexical(input.charCodeAt(i))) { i++; continue; }
        const start = i;
        while (i < limit) {
            if (lexical(input.charCodeAt(i))) { i++; continue; }
            if (!spaced || !/\s/.test(input[i])) break;
            const gap = i;
            while (i < limit && /\s/.test(input[i])) i++;
            // A separator binds the whole expression even across whitespace.
            // Scan before allocating so oversized expressions skip only themselves.
            if (i < limit && lexical(input.charCodeAt(i)) &&
                (separator(input[gap - 1]) || separator(input[i]))) continue;
            i = gap;
            break;
        }
        // Never manufacture a token cut by the query work limit.
        if (i === limit && i < input.length && lexical(input.charCodeAt(i))) continue;
        let end = i;
        while (end > start && (input[end - 1] === '.' || input[end - 1] === ':')) end--;
        if (i - start > 96) continue;
        const span = input.slice(start, end), raw = spaced ? span.replace(/\s/g, '') : span;
        if (symbolPattern.test(raw) && visit(raw, start, end) === false) return;
    }
}
function identifiers(query) {
    const input = String(query), found = [];
    // Bound (query work/output): inspect 8000 code units and at most 8 distinct
    // API-looking tokens <= 96 chars. Overflow is ignored, never truncated.
    const limit = Math.min(8000, input.length);
    // Classify whole whitespace-delimited chunks BEFORE splitting identifiers.
    // Bound (chunk work/allocation): only the bounded query prefix is copied or
    // scanned. Omit a cut final chunk; never infer a name from its partial path.
    // A quoted path or filename may contain spaces: blank the whole quoted span
    // first, keeping its length so positions still match the input.
    // Bound (quote work): a quoted span is at most 512 code units on one line.
    const pathLike = s => /[\\/]/.test(s) || /\.[A-Za-z0-9_]+$/.test(s.trim());
    const unquoted = input.slice(0, limit).replace(/(["'`])([^"'`\n]{1,512})\1|“([^”\n]{1,512})”/g,
        (m, q, plain, curly) => pathLike(plain ?? curly) ? '!'.repeat(m.length) : m);
    const filtered = unquoted.replace(/\S+/g, (chunk, start) => {
        if (start + chunk.length === limit && limit < input.length && !/\s/.test(input[limit])) return '!';
        // A non-whitespace barrier keeps spaced qualifiers from crossing a path.
        if (/[\\/]|[A-Za-z0-9_]-[A-Za-z0-9_]/.test(chunk) || /\.[A-Za-z0-9_]+[^\w\s]*$/.test(chunk)) return '!';
        return chunk;
    });
    scanIdentifiers(filtered, raw => {
        // Keep syntax intact: never turn a filename/member call or operator+
        // into a different, supposedly missing API name.
        if (raw.includes('.') || raw.replace(/::/g, '').includes(':')) return;
        if (raw.split('::').some(part => /^operator/i.test(part))) return;
        if (NON_API_WORDS.has(raw)) return;
        if (!raw.includes('::') && (raw.length < 4 || !/[a-z][A-Z]/.test(raw))) return;
        const name = normalizeSymbol(raw).split('::')[0];
        if (NON_API_WORDS.has(name)) return;
        if (!found.includes(name)) found.push(name);
        return found.length < 8;
    }, filtered.length, true);
    return found;
}
// Bound (work): suggestions use edit distance <= 2 on names <= 96 characters.
// Reject length gaps and rows beyond the threshold before doing further work.
function nearDistance(a, b) {
    if (Math.abs(a.length - b.length) > 2) return 3;
    let row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const next = new Array(b.length + 1).fill(3);
        next[0] = i;
        let best = 3;
        // Only the five-column diagonal band can reach distance <= 2.
        for (let j = Math.max(1, i - 2); j <= Math.min(b.length, i + 2); j++) {
            next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
            best = Math.min(best, next[j]);
        }
        if (best > 2) return 3;
        row = next;
    }
    return row[b.length];
}
export function createSymbolChecker(corpus) {
    const names = new Map(), known = new Set();
    const addName = raw => {
        const name = normalizeSymbol(raw), lower = name.toLowerCase();
        // Only suggestions need canonical spellings; exact membership is separate.
        if (names.size < 2048 && !names.has(lower)) names.set(lower, name);
        for (const part of lower.split('::')) {
            if (admit(part) === false) break;
        }
    };
    // Bound (corpus scan work): at most 1 Gi code units across ALL card title/text
    // fields, twice the full 512 MiB external cache, with headroom for the
    // ~64 MiB embedding-heavy production JSON. Vectors are never scanned.
    // Bound (index memory): at most 1,000,000 distinct words/id components, each
    // <= 96 code units. Overall scan/count overflow abstains globally.
    let remaining = 1024 ** 3, complete = true;
    const admit = part => {
        if (!known.has(part) && known.size === 1000000) { complete = false; return false; }
        known.add(part);
    };
    // Core symbol/Lua/example ids and their components establish membership. Addon ids
    // use the same case-insensitive lookup as whole-word mentions below.
    for (const c of corpus) {
        if (/^(symbol|lua|example|addon):/.test(c.id || '')) {
            const raw = c.id.slice(c.id.indexOf(':') + 1);
            // Bound (id work): skip names over 96 chars before regex/normalizing.
            if (raw.length <= 96 && symbolPattern.test(raw)) addName(raw);
        }
        if (!complete) break;
    }
    const word = code => code >= 65 && code <= 90 || code >= 97 && code <= 122 ||
        code >= 48 && code <= 57 || code === 95;
    const scan = value => {
        if (!complete || typeof value !== 'string') return;
        if (value.length > remaining) { complete = false; return; }
        remaining -= value.length;
        // One forward pass over whole ASCII words, regardless of prose/code,
        // namespace, punctuation, comments or string syntax. No suffix searches.
        for (let i = 0; i < value.length;) {
            if (!word(value.charCodeAt(i))) { i++; continue; }
            const start = i;
            while (i < value.length && word(value.charCodeAt(i))) i++;
            // Bound (span allocation): an oversized word skips only itself,
            // before slicing/lowercasing; following words remain checkable.
            if (i - start <= 96 && admit(value.slice(start, i).toLowerCase()) === false) return;
        }
    };
    for (const c of corpus) {
        scan(c.title);
        scan(c.text);
        if (!complete) break;
    }
    if (!complete) {
        console.warn('[symbol-check] unavailable; documentation name checks disabled');
        return () => [];
    }
    // Bound (suggestion work/output): first 2048 indexed names, distance <= 2,
    // at most 3 suggestions per missing name. Overflow is omitted, not counted.
    const candidates = [];
    for (const entry of names) { candidates.push(entry); if (candidates.length === 2048) break; }
    return query => {
        const missing = new Set();
        for (const name of identifiers(query)) {
            const lower = name.toLowerCase();
            // All judged names use their leading owner, independent of prefix
            // or qualification. Any card's word abstains; it does not prove an API.
            if (!known.has(lower)) missing.add(name);
        }
        return [...missing].map(name => ({ name,
            suggestions: candidates.map(([lower, canonical]) => ({ name: canonical, distance: nearDistance(name.toLowerCase(), lower) }))
                .filter(c => c.distance <= 2).sort((a, b) => a.distance - b.distance || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).slice(0, 3).map(c => c.name),
        }));
    };
}
function boundedMissingSymbols(value) {
    const validName = name => typeof name === 'string' && name.length <= 96 &&
        /^[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*$/.test(name);
    // Bound (work/output): upstream notices use only the first 8 entries, names
    // <= 96 ASCII chars and the first 3 suggestions with the same validation.
    // Invalid entries are omitted; oversized names are never truncated into facts.
    return (Array.isArray(value) ? value.slice(0, 8) : []).filter(c => validName(c?.name)).map(c => ({
        name: c.name,
        suggestions: (Array.isArray(c.suggestions) ? c.suggestions.slice(0, 3) : []).filter(validName),
    }));
}
export function noSymbolFact(missing = [], closest = false) {
    return boundedMissingSymbols(missing).map(({ name, suggestions }) => `No TrussC symbol named \`${name}\` appears in the documentation.` +
        (closest ? ' The results below are the closest matches.' : '') +
        (suggestions.length ? ` Near names: ${suggestions.map(s => `\`${s}\``).join(', ')}.` : '')).join('\n');
}
// 0.7 recommends another chat search; 0.3 denotes probably insufficient evidence
// for MCP callers. Fixed policy, with no new configuration or environment input.
export const LOW_COVERAGE = 0.3;

function utf8Prefix(value, bytes) {
    let out = '', used = 0;
    for (const ch of String(value)) {
        used += Buffer.byteLength(ch);
        if (used > bytes) break;
        out += ch;
    }
    return out;
}
export function relatedCandidates(ranked) {
    const seen = new Set(), out = [];
    // Bound (output): retain 40 title/id candidates (20 cards + 20 spare slots).
    // Titles use at most 192 UTF-8 bytes; ids over 256 bytes are omitted, never
    // truncated, so trussc_get still receives exact ids. Overflow is not counted.
    for (const c of ranked) {
        if (typeof c?.id !== 'string' || !c.id || c.id.length > 256 || /[\x00-\x1f\x7f]/.test(c.id) || seen.has(c.id) || Buffer.byteLength(c.id) > 256) continue;
        seen.add(c.id);
        out.push({ id: c.id, title: utf8Prefix((typeof c.title === 'string' ? c.title.slice(0, 193) : '').replace(/[\r\n\t]/g, ' '), 192) });
        if (out.length === 40) break;
    }
    return out;
}
// Both HTTP MCP and the stdio proxy use the same serializable metadata shape.
export function searchResponse(retrieved, results) {
    const info = retrieved.retrieval || {};
    return { results, path: info.path, exists: info.exists, ...(retrieved.search || {}) };
}
export function formatSearchResults(results, query, info = {}) {
    const missing = boundedMissingSymbols(info.missingSymbols);
    const low = info.path === 'jev' && typeof info.exists === 'number' && info.exists < LOW_COVERAGE;
    const facts = noSymbolFact(missing, true);
    const intro = [facts,
        low && "These results probably don't answer the query.",
        (low || missing.length > 0) && 'Closest matches:'].filter(Boolean).join('\n');
    const shown = new Set(results.map(c => c.id));
    // Bound (output): append at most 16 related titles, each <= 192 UTF-8 bytes
    // with an exact id <= 256 bytes. Overflow is omitted and is not counted.
    // Bound (work): the stdio upstream may supply arbitrary metadata. Inspect
    // only its first 40 candidate slots, then validate with the producer's limits.
    const related = relatedCandidates(Array.isArray(info.candidates) ? info.candidates.slice(0, 40) : []).filter(c => !shown.has(c.id)).slice(0, 16);
    const tail = related.length ? '\n\nOther possibly related:\n' + related.map(c => `- ${c.title} [#${c.id}]`).join('\n') : '';
    // Bound (output): the entire search text fits 256 KiB, including warnings and
    // related titles. Overflow truncates card text with a get hint; not counted.
    const head = intro ? intro + '\n\n' : '';
    const marker = '\n… (search output truncated; use trussc_get for full cards)';
    const budget = 262144 - Buffer.byteLength(head + tail);
    let body = formatResults(results, query);
    if (Buffer.byteLength(body) > budget) body = utf8Prefix(body, budget - Buffer.byteLength(marker)) + marker;
    const output = head + body + tail;
    // Cap the final text as well, including the head, at both MCP boundaries.
    return Buffer.byteLength(output) > 262144 ? utf8Prefix(output, 262144 - Buffer.byteLength(marker)) + marker : output;
}

// Render results. On the Jev path each card carries its relevance probability p,
// which is the only score a caller can act on; fallback scores are internal.
function scoreLine(c) {
    return typeof c.p === 'number' && Number.isFinite(c.p) ? `  (relevance ${c.p.toFixed(2)})` : '';
}
export function formatResults(results, query) {
    if (!results || !results.length) return `No TrussC matches for "${query}".`;
    return results.map((c) =>
        `### [${c.source}] ${c.title}${c.id ? ` [#${c.id}]` : ''}${c.link ? `  ·  ${c.link}` : ''}${scoreLine(c)}\n${c.text || ''}`
    ).join('\n\n---\n\n');
}

// handlers: { search(query, k, full, lang) -> search response, get(ids) -> results[] }.
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
                    const lang = args.lang === 'lua' ? 'lua' : 'cpp';
                    const response = await handlers.search(query, k, !!args.full, lang);
                    const results = (Array.isArray(response) ? response : response.results).slice(0, k);
                    return toolText(formatSearchResults(results, query, response));
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
