// Shared MCP (JSON-RPC 2.0) protocol core for the TrussC docs grounding tool.
// One source of truth used by BOTH transports:
//   - mcp.mjs    : stdio, retrieval over HTTP /search (run locally / offline)
//   - server.mjs : POST /mcp, retrieval via local retrieve()  (api.trussc.org gateway)
// `dispatch(msg, searchFn)` handles one JSON-RPC message; searchFn(query,k) returns
// {results, path, exists, missingSymbols, candidates} (legacy arrays also work); returns the response
// object, or null for notifications (nothing to send back).

import { RELATED_MIX } from './config.mjs';

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
        'Provide exactly one of query or queries (1–3 nonempty strings, each at most 200 characters). ' +
        'Optional message is one short line shown to the user while you search, in the user\'s language (at most 300 characters). ' +
        'Set lang:"lua" for TrussSketch (the in-browser Lua playground) to get Lua-flavored ' +
        'cards (colon methods, Type.new, end_fbo/end_shader/end_cam) instead of the C++ API. ' +
        'Results may include a line saying a name does not appear in the documentation, ' +
        'near names, or a notice that the results probably do not answer the query. ' +
        'These results are labelled as closest matches. Cards show ids, followed by ' +
        'Other possibly related titles, short descriptions (when available), and ids for follow-up with trussc_get.',
    inputSchema: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'Natural-language description of what you want to do in TrussC. Exactly one of query or queries is required.' },
            // Bound (cost): reject queries outside 1–3 nonempty strings of <= 200 characters; never truncate.
            queries: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', maxLength: 200 }, description: 'Several searches merged into one retrieval. Exactly one of query or queries is required.' },
            // Bound (output): reject non-string messages or messages over 300 characters; never truncate.
            message: { type: 'string', maxLength: 300, description: "one short line shown to the user while you search, in the user's language" },
            k: { type: 'number', description: 'Max total results to return (default 8).' },
            full: { type: 'boolean', description: 'Return full untrimmed text for every result (default false; examples are trimmed). Prefer trussc_get for a specific chunk.' },
            lang: { type: 'string', enum: ['cpp', 'lua'], description: 'API flavor: "cpp" (default, the C++ framework) or "lua" (TrussSketch playground — prefers the Lua twin of each symbol, hides nothing else).' },
        },
    },
}, {
    name: 'trussc_get',
    description:
        'Fetch the FULL text of specific TrussC corpus chunks by id — use after ' +
        'trussc_search to expand a trimmed example (or any chunk) to its complete ' +
        'multi-file source. Pass ids as shown in results / the [#id] tags (a leading # is accepted): ' +
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

// Shared validation for MCP, HTTP (question aliases query), and native chat tools.
// Bound (cost): reject both/neither inputs, invalid 1–3 queries of <=200 characters, or messages over 300 characters; never truncate. Legacy query coercion/length handling is retained.
export function searchInput(args = {}) {
    const hasQuery = Object.hasOwn(args, 'query'), hasQueries = Object.hasOwn(args, 'queries');
    if (hasQuery === hasQueries) throw new Error('exactly one of query or queries is required');
    if (Object.hasOwn(args, 'message') && (typeof args.message !== 'string' || args.message.length > 300))
        throw new Error('message must be a string of at most 300 characters');
    if (hasQueries) {
        if (!Array.isArray(args.queries) || args.queries.length < 1 || args.queries.length > 3 ||
            !args.queries.every(q => typeof q === 'string' && q.trim() && q.length <= 200))
            throw new Error('queries must contain 1–3 nonempty strings of at most 200 characters');
        const queries = args.queries.map(q => q.trim());
        return { query: queries.join(' '), queries };
    }
    const query = String(args.query || '').trim();
    if (!query) throw new Error('empty query');
    return { query, queries: [query] };
}
// Bound (security): retain only strings and the first 20 ids, matching the existing MCP handling; overflow is omitted before getByIds strips one leading #.
export function getInput(args = {}) {
    return Array.isArray(args.ids) ? args.ids.filter(id => typeof id === 'string').slice(0, 20) : [];
}

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
// Shared by corpus-facing search metadata, MCP formatting and offline byte accounting.
export function sanitizeRelatedText(value, bytes) {
    // Bound (work): inspect only a UTF-8 prefix of the field's byte budget before cleaning; excess upstream text is discarded.
    return utf8Prefix(utf8Prefix(typeof value === 'string' ? value : '', bytes).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ')
        .replace(/\[#/g, '[ #').replace(/\s+/g, ' ').trim(), bytes);
}
export function relatedCandidates(ranked) {
    const seen = new Set(), out = [];
    // Bound (output): retain 40 candidates; titles fit 192 bytes and briefs 160. Invalid ids or ids over 256 bytes are omitted, never truncated.
    for (const c of ranked) {
        if (typeof c?.id !== 'string' || !c.id || c.lang === 'lua' || /[\x00-\x1f\x7f-\x9f\u2028\u2029]|\[#/.test(c.id) || seen.has(c.id) || Buffer.byteLength(c.id) > 256) continue;
        seen.add(c.id);
        const brief = sanitizeRelatedText(c.brief ?? c.meta?.brief, 160);
        out.push({ id: c.id, title: sanitizeRelatedText(c.title, 192), ...(brief ? { brief } : {}) });
        if (out.length === 40) break;
    }
    return out;
}
export function relatedText(cards) {
    return cards.length ? '\n\nOther possibly related:\n' + cards.map(relatedLine).join('\n') : '';
}
export function relatedLine(c) {
    return `- ${c.title}${c.brief ? ` — ${c.brief}` : ''} [#${c.id}]`;
}
// Pure: accepts corpus cards (or ids for shown/ranked) and operator/eval mix parameters.
// order contains sequential phases; an array phase interleaves sources by shown-card order.
export function buildRelatedList({ shown = [], ranked = [], corpus = [], mix = RELATED_MIX } = {}) {
    const options = { ...RELATED_MIX, ...mix, counts: { ...RELATED_MIX.counts, ...mix.counts } };
    const sources = ['ranked', 'related', 'near'];
    // Bound (configuration): quotas, total and per-shown M must be non-negative safe integers; invalid limits/order fail before filling.
    if ([options.total, options.nearPerShown, ...sources.map(s => options.counts[s])].some(n => !Number.isSafeInteger(n) || n < 0) ||
        !Array.isArray(options.order) || options.order.some(p => !(Array.isArray(p) ? p : [p]).every(s => sources.includes(s)))) throw new Error('Invalid related mix');
    const byId = corpus instanceof Map ? corpus : new Map(corpus.map(c => [c.id, c]));
    const card = c => typeof c === 'string' ? byId.get(c) : byId.get(c?.id) || c;
    const shownCards = shown.map(card).filter(Boolean);
    const seen = new Set(shown.map(c => typeof c === 'string' ? c : c.id)), out = [];
    const used = { ranked: 0, related: 0, near: 0 };
    function add(c, source) {
        if (!c || c.lang === 'lua' || seen.has(c.id) || used[source] >= options.counts[source] || out.length >= options.total) return;
        const entry = relatedCandidates([c])[0];
        if (!entry) return;
        seen.add(c.id); used[source]++;
        out.push({ ...entry, source });
    }
    function targets(source, c) {
        if (source === 'ranked') return ranked.map(card);
        if (source === 'near') return (c?.near || []).slice(0, options.nearPerShown).map(id => byId.get(id));
        return (c?.meta?.related || []).map(name => {
            if (typeof name !== 'string') return null;
            const normalized = name.trim().replace(/^tc::/, '').replace(/\(.*$/, '').trim();
            return byId.get(name) || byId.get('symbol:' + normalized);
        });
    }
    for (const phase of options.order) {
        if (Array.isArray(phase)) {
            for (const c of shownCards) {
                const queues = phase.map(source => targets(source, c));
                const length = Math.max(0, ...queues.map(q => q.length));
                for (let i = 0; i < length && out.length < options.total; i++)
                    phase.forEach((source, j) => add(queues[j][i], source));
            }
        } else if (phase === 'ranked') {
            for (const c of targets(phase)) add(c, phase);
        } else for (const c of shownCards) for (const target of targets(phase, c)) add(target, phase);
    }
    return out;
}
// Both HTTP MCP and the stdio proxy use the same serializable metadata shape.
export function searchResponse(retrieved, results) {
    const info = retrieved.retrieval || {};
    const search = retrieved.relatedFor ? { missingSymbols: retrieved.search?.missingSymbols } : retrieved.search || {};
    return { results, path: info.path, exists: info.exists, ...search,
        ...(retrieved.relatedFor ? { candidates: retrieved.relatedFor(results) } : {}) };
}
export function formatSearchResults(results, query, info = {}, packing) {
    const missing = boundedMissingSymbols(info.missingSymbols);
    const low = info.path === 'jev' && typeof info.exists === 'number' && info.exists < LOW_COVERAGE;
    const facts = noSymbolFact(missing, true);
    const intro = [facts,
        low && "These results probably don't answer the query.",
        (low || missing.length > 0) && 'Closest matches:'].filter(Boolean).join('\n');
    const shown = new Set(results.map(c => c.id));
    // Bound (output): at most 16 lines, each <= 619 UTF-8 bytes (192 title + 160 brief + 256 id + 11 punctuation); list <= 9919 bytes (9945 with header). Overflow is omitted and is not counted.
    // Bound (work): the stdio upstream may supply arbitrary metadata. Inspect
    // only its first 40 candidate slots, then validate with the producer's limits.
    const related = relatedCandidates(Array.isArray(info.candidates) ? info.candidates.slice(0, 40) : []).filter(c => !shown.has(c.id)).slice(0, 16);
    const tail = relatedText(related);
    // Bound (output): the entire search text fits 256 KiB, including warnings and
    // related titles. Packing keeps overflow id-only; unbudgeted MCP output
    // retains its existing truncation marker.
    const head = intro ? intro + '\n\n' : '';
    const marker = '\n… (search output truncated; use trussc_get for full cards)';
    const budget = 262144 - Buffer.byteLength(head + tail);
    let body = formatResults(results, query, packing && { ...packing,
        fits: text => Buffer.byteLength(text) <= budget && (!packing.fits || packing.fits(head + text + tail)) &&
            (packing.maxBytes === undefined || Buffer.byteLength(head + text + tail) <= packing.maxBytes), maxBytes: undefined });
    if (body === null) return null;
    if (Buffer.byteLength(body) > budget) body = utf8Prefix(body, budget - Buffer.byteLength(marker)) + marker;
    const output = head + body + tail;
    // Cap the final text as well, including the head, at both MCP boundaries.
    return Buffer.byteLength(output) > 262144 ? utf8Prefix(output, 262144 - Buffer.byteLength(marker)) + marker : output;
}

// Optional packing accepts maxBytes or fits(text), a predicate that can account for
// the complete serialized token budget; shownIds/cardText/onPacked serve chat packing.
// Render results. On the Jev path each card carries its relevance probability p,
// which is the only score a caller can act on; fallback scores are internal.
function scoreLine(c) {
    return typeof c.p === 'number' && Number.isFinite(c.p) ? `  (relevance ${c.p.toFixed(2)})` : '';
}
// Bound (output): optional byte/request-token budgets replace overflowing cards with [#id], highest p first; if even references do not fit, return null. Previously shown cards stay references.
export function formatResults(results, query, packing) {
    if (packing) {
        const shown = packing.shownIds || new Set(), added = [];
        const parts = results.map(c => `[#${c.id}]${shown.has(c.id) ? ' already shown above' : ''}`);
        const join = () => parts.join('\n\n---\n\n');
        const fits = text => (packing.maxBytes === undefined || Buffer.byteLength(text) <= packing.maxBytes) && (!packing.fits || packing.fits(text));
        if (!results.length) return fits(`No TrussC matches for "${query}".`) ? `No TrussC matches for "${query}".` : null;
        if (!fits(join())) return null;
        const priority = results.map((card, i) => ({ card, i })).sort((a, b) => (b.card.p ?? -1) - (a.card.p ?? -1));
        for (const { card, i } of priority) {
            if (shown.has(card.id)) continue;
            const old = parts[i];
            parts[i] = formatResults([{ ...card, text: packing.cardText ? packing.cardText(card) : card.text }], query);
            if (fits(join())) added.push(card.id); else parts[i] = old;
        }
        packing.onPacked?.({ added, idOnlyCards: results.filter(c => !shown.has(c.id) && !added.includes(c.id)).length });
        return join();
    }
    if (!results || !results.length) return `No TrussC matches for "${query}".`;
    return results.map((c) =>
        `### [${c.source}] ${c.title}${c.id ? ` [#${c.id}]` : ''}${c.link ? `  ·  ${c.link}` : ''}${scoreLine(c)}\n${c.text || ''}`
    ).join('\n\n---\n\n');
}

// Get shares the full-card formatter and the same empty-result wording across chat/MCP.
export function formatGetResults(results, ids, packing) {
    if (results.length) return formatResults(results, ids.join(', '), packing);
    const text = `No chunks found for: ${ids.join(', ')}`;
    // Bound (output): empty-get notices must also fit the optional byte/request budget; overflow returns null.
    return packing && ((packing.maxBytes !== undefined && Buffer.byteLength(text) > packing.maxBytes) ||
        (packing.fits && !packing.fits(text))) ? null : text;
}

// handlers: { search(query, k, full, lang, queries?) -> search response, get(ids) -> results[] }.
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
                    const { query, queries } = searchInput(args);
                    const k = Math.max(1, Math.min(20, Number(args.k) || 8));
                    const lang = args.lang === 'lua' ? 'lua' : 'cpp';
                    const response = await handlers.search(query, k, !!args.full, lang, Object.hasOwn(args, 'queries') ? queries : undefined);
                    const results = (Array.isArray(response) ? response : response.results).slice(0, k);
                    return toolText(formatSearchResults(results, query, response));
                }
                if (name === 'trussc_get') {
                    const ids = getInput(args);
                    if (!ids.length) return toolText('error: no ids', true);
                    const results = await handlers.get(ids);
                    return toolText(formatGetResults(results, ids));
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
