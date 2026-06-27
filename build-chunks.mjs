// Slice source docs into retrieval chunks → chunks.jsonl (one JSON object/line).
// Sources:
//   concept  — hand-written half of FOR_AI_ASSISTANT.md (task/how-to/idioms), by heading
//   symbol   — the merged web data (trussc-api.js) + oF mapping (of-mapping.json):
//              rich cards (signatures, enum values, properties, operators, related,
//              multilingual prose) whose NAMES match the reference page (links resolve)
//   example  — examples.json + each example's src/tcApp.cpp (APIs used + excerpt)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { FOR_AI, TRUSSC_API, OF_MAPPING, EXAMPLES_JSON, EXAMPLES_SRC, CHUNKS } from './config.mjs';

const require = createRequire(import.meta.url);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const descBlock = (o) => ['desc', 'desc_ja', 'desc_ko'].map((k) => o[k]).filter(Boolean);

// --- Source: FOR_AI concept half -------------------------------------------
function chunkForAi(path) {
    let md = readFileSync(path, 'utf8');
    const cut = md.indexOf('\n## API Index');
    if (cut !== -1) md = md.slice(0, cut);
    const chunks = [];
    let h2 = '', cur = null;
    const flush = () => {
        if (cur && cur.body.join('\n').trim()) {
            const crumb = cur.h2 && cur.h2 !== cur.heading ? `${cur.h2} > ${cur.heading}` : cur.heading;
            chunks.push({ id: 'concept:' + slug(crumb), source: 'for-ai', lang: 'en', title: crumb, text: `# ${crumb}\n\n` + cur.body.join('\n').trim() });
        }
        cur = null;
    };
    for (const line of md.split('\n')) {
        const m2 = /^## (.+)/.exec(line), m3 = /^### (.+)/.exec(line);
        if (m2) { flush(); h2 = m2[1].trim(); cur = { h2, heading: h2, body: [] }; }
        else if (m3) { flush(); cur = { h2, heading: m3[1].trim(), body: [] }; }
        else if (cur) cur.body.push(line);
    }
    flush();
    return chunks;
}

// --- openFrameworks index: TrussC symbol name -> [of names] ----------------
function loadOfIndex(path) {
    const m = JSON.parse(readFileSync(path, 'utf8'));
    const idx = new Map();
    for (const group of [...(m.functions || []), ...(m.types || [])]) {
        for (const mp of group.mappings || []) {
            const tc = (mp.tc || '').split('(')[0].trim();   // "getWindowWidth()" -> "getWindowWidth"
            if (!tc || !mp.of) continue;
            if (!idx.has(tc)) idx.set(tc, []);
            idx.get(tc).push(mp.of);
        }
    }
    return idx;
}

// --- Source: symbols from trussc-api.js (rich) -----------------------------
function chunkApi(api, ofIdx) {
    const chunks = [];
    const ofLine = (name) => (ofIdx.has(name) ? `openFrameworks: ${ofIdx.get(name).join(', ')} → use ${name} in TrussC.` : null);
    const deprNote = (dep) => {
        if (!dep) return null;
        const r = typeof dep === 'string' ? dep : dep.reason || '';
        return `⚠ Deprecated: ${r}${dep && dep.replacement ? ` Use ${dep.replacement}.` : ''}`;
    };
    const push = (id, title, lines, meta) =>
        chunks.push({ id: 'symbol:' + id, source: 'reference', lang: 'multi', title, text: lines.filter((l) => l != null && l !== '').join('\n'), meta });

    // functions — group overloads by name into one card
    const fnGroups = new Map();
    for (const cat of api.categories || []) for (const f of cat.functions || []) {
        if (!fnGroups.has(f.name)) fnGroups.set(f.name, { cat: cat.name, items: [] });
        fnGroups.get(f.name).items.push(f);
    }
    for (const [name, g] of fnGroups) {
        const f0 = g.items[0];
        const lines = [`# ${name}   (function · ${g.cat})`, ofLine(name), ...descBlock(f0)];
        const seen = new Set(), sigs = [];
        for (const f of g.items) {
            const s = `  ${f.return_type || 'void'} ${name}(${f.params_typed || f.params || ''})`;
            if (!seen.has(s)) { seen.add(s); sigs.push(s); }
        }
        if (sigs.length) lines.push('', 'Signatures:', ...sigs);
        if (f0.related?.length) lines.push('', `Related: ${f0.related.join(', ')}`);
        if (f0.examples?.length) lines.push(`Examples: ${f0.examples.map((e) => e.name || e).join(', ')}`);
        if (f0.details) lines.push('', f0.details);
        const dep = g.items.find((x) => x.deprecated)?.deprecated;
        if (deprNote(dep)) lines.push('', deprNote(dep));
        if (f0.keywords?.length) lines.push(`keywords: ${f0.keywords.join(', ')}`);
        push(name, name, lines, { kind: 'function', category: g.cat, related: f0.related || [], deprecated: !!dep });
    }

    // types — overview card + granular per-method/static cards
    for (const t of api.types || []) {
        const lines = [`# ${t.name}   (type)`, ofLine(t.name), ...descBlock(t)];
        if (t.constructor?.signatures?.length) lines.push('', 'Constructor:', ...t.constructor.signatures.map((s) => `  ${t.name}(${s})`));
        if (t.properties?.length) { lines.push('', 'Properties:'); for (const p of t.properties) lines.push(`  ${p.type} ${p.name}${p.desc ? ` — ${p.desc}` : ''}`); }
        if (t.methods?.length) lines.push('', `Methods: ${t.methods.map((m) => m.name).join(', ')}`);
        if (t.static_methods?.length) lines.push(`Static methods: ${t.static_methods.map((m) => m.name).join(', ')}`);
        if (t.operators?.length) { lines.push('', 'Operators:'); for (const o of t.operators) lines.push(`  ${o.signature || o.cpp}${o.desc ? ` — ${o.desc}` : ''}`); }
        if (t.related?.length) lines.push('', `Related: ${t.related.join(', ')}`);
        if (t.examples?.length) lines.push(`Examples: ${t.examples.map((e) => e.name || e).join(', ')}`);
        if (t.keywords?.length) lines.push(`keywords: ${t.keywords.join(', ')}`);
        push(t.name, t.name, lines, { kind: 'type', related: t.related || [] });

        const member = (m, kindLabel, kind) => {
            const id = `${t.name}::${m.name}`;
            const ml = [`# ${id}   (${kindLabel} of ${t.name})`, ofLine(id), ...descBlock(m)];
            if (m.signatures?.length) { ml.push('', 'Signatures:'); for (const s of m.signatures) ml.push(`  ${m.return || 'void'} ${id}(${s})`); }
            if (deprNote(m.deprecated)) ml.push('', deprNote(m.deprecated));
            push(id, id, ml, { kind, owner: t.name });
        };
        for (const m of t.methods || []) member(m, 'method', 'method');
        for (const m of t.static_methods || []) member(m, 'static method', 'static');
    }

    // enums — WITH values (the gap in the old source)
    for (const e of api.enums || []) {
        const lines = [`# ${e.name}   (enum)`, ...descBlock(e)];
        if (e.values?.length) { lines.push('', 'Values:'); for (const v of e.values) lines.push(`  ${e.name}::${v.name}${v.value != null ? ` = ${v.value}` : ''}${v.desc ? ` — ${v.desc}` : ''}`); }
        if (e.related?.length) lines.push('', `Related: ${e.related.join(', ')}`);
        if (e.keywords?.length) lines.push(`keywords: ${e.keywords.join(', ')}`);
        push(e.name, e.name, lines, { kind: 'enum' });
    }

    // macros + constants
    for (const m of api.macros || []) push(m.name, m.name, [`# ${m.name}   (macro)`, ...descBlock(m), m.signature ? `\n${m.signature}` : null], { kind: 'macro' });
    for (const c of api.constants || []) push(c.name, c.name, [`# ${c.name}   (constant)`, ...descBlock(c), c.value != null ? `Value: ${c.value}` : null], { kind: 'var' });

    return chunks;
}

// --- Source: examples ------------------------------------------------------
const LIFECYCLE = new Set(['setup', 'update', 'draw', 'exit']);
function exampleApis(src, nameSet) {
    const used = new Set();
    for (const m of src.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
        const w = m[1];
        if (w.length >= 4 && !LIFECYCLE.has(w) && nameSet.has(w)) used.add(w);
    }
    return [...used];
}
function chunkExamples(jsonPath, srcRoot, nameSet) {
    const j = JSON.parse(readFileSync(jsonPath, 'utf8'));
    const chunks = [];
    for (const [group, g] of Object.entries(j.examples || {})) {
        for (const it of g.items || []) {
            const cpp = join(srcRoot, group, it.name, 'src', 'tcApp.cpp');
            let apis = [], excerpt = '';
            if (existsSync(cpp)) { const src = readFileSync(cpp, 'utf8').replace(/\r/g, ''); apis = exampleApis(src, nameSet); excerpt = src.slice(0, 2200); }
            const lines = [`# ${it.name}  (example — ${group})`, `A TrussC example${it.webSupported === false ? '' : ' (runs in the web player)'}.`];
            if (apis.length) lines.push(`APIs used: ${apis.slice(0, 50).join(', ')}`);
            if (excerpt) lines.push('', 'Source (src/tcApp.cpp, excerpt):', '```cpp', excerpt, '```');
            chunks.push({ id: 'example:' + it.name, source: 'example', lang: 'en', title: `${it.name} (example)`, text: lines.join('\n'), meta: { group, webSupported: it.webSupported !== false, apis } });
        }
    }
    return chunks;
}

// --- Assemble ---------------------------------------------------------------
const api = require(TRUSSC_API);
const ofIdx = loadOfIndex(OF_MAPPING);

// names for example API-usage detection: functions + type/method/static + enums
const nameSet = new Set();
for (const c of api.categories || []) for (const f of c.functions || []) nameSet.add(f.name);
for (const t of api.types || []) { nameSet.add(t.name); for (const m of [...(t.methods || []), ...(t.static_methods || [])]) nameSet.add(m.name); }
for (const e of api.enums || []) nameSet.add(e.name);

const concept = chunkForAi(FOR_AI);
const symbols = chunkApi(api, ofIdx);
const examples = chunkExamples(EXAMPLES_JSON, EXAMPLES_SRC, nameSet);
const chunks = [...concept, ...symbols, ...examples];

writeFileSync(CHUNKS, chunks.map((c) => JSON.stringify(c)).join('\n') + '\n');
console.log(`wrote ${chunks.length} chunks → ${CHUNKS}`);
console.log(`  concept (for-ai):     ${concept.length}`);
console.log(`  symbol  (trussc-api): ${symbols.length}  (of-mapping entries: ${ofIdx.size})`);
console.log(`  example (examples):   ${examples.length}`);
