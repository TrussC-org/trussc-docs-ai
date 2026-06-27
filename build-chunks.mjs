// Slice source docs into retrieval chunks → chunks.jsonl (one JSON object/line).
//
// v0 source: the hand-written concept half of FOR_AI_ASSISTANT.md — everything
// BEFORE "## API Index" (the tail is auto-generated from api-definition.yaml and
// is better served by per-symbol chunks later). We split on markdown headings,
// keeping the parent H2 as a breadcrumb so each chunk carries its own context.
//
// Adding more sources later = write another collector that returns the same
// {id, source, lang, title, text} shape and concat it here.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { FOR_AI, REFERENCE_DATA, EXAMPLES_JSON, EXAMPLES_SRC, CHUNKS } from './config.mjs';

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function chunkForAi(path) {
    let md = readFileSync(path, 'utf8');
    const cut = md.indexOf('\n## API Index');           // drop the generated tail
    if (cut !== -1) md = md.slice(0, cut);

    const chunks = [];
    let h2 = '', cur = null;
    const flush = () => {
        if (cur && cur.body.join('\n').trim()) {
            const crumb = cur.h2 && cur.h2 !== cur.heading ? `${cur.h2} > ${cur.heading}` : cur.heading;
            chunks.push({
                id: 'concept:' + slug(crumb),
                source: 'for-ai',
                lang: 'en',
                title: crumb,
                text: `# ${crumb}\n\n` + cur.body.join('\n').trim(),
            });
        }
        cur = null;
    };
    for (const line of md.split('\n')) {
        const m2 = /^## (.+)/.exec(line);
        const m3 = /^### (.+)/.exec(line);
        if (m2) { flush(); h2 = m2[1].trim(); cur = { h2, heading: h2, body: [] }; }
        else if (m3) { flush(); cur = { h2, heading: m3[1].trim(), body: [] }; }
        else if (cur) cur.body.push(line);
    }
    flush();
    return chunks;
}

// --- Source: reference-data.json (per-symbol) ------------------------------
// One chunk per documented symbol. The text is a compact, multilingual "card"
// (name + signatures + en/ja/ko descriptions + keywords + oF equivalent). bge-m3
// is multilingual, so a JA query matches the JA line and an EN query the EN line
// within the same chunk — no duplicate-symbol hits in the top-K.
function renderSig(sym, s) {
    const call = sym.owner ? `${sym.owner}::${sym.name}` : sym.name;
    const ret = s.ret ? s.ret + ' ' : '';
    return `  ${ret}${call}(${s.params || ''})${s.const ? ' const' : ''}`;
}

function chunkReference(path) {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    const chunks = [];
    for (const [id, sym] of Object.entries(data)) {
        if (!sym || sym.documented === false) continue;
        if ((sym.name || '').startsWith('operator')) continue;   // skip operators (low value for v0)

        const kindLabel =
            sym.kind === 'method' ? `${sym.static ? 'static method' : 'method'} of ${sym.owner}` :
            sym.kind === 'func' ? 'function' :
            sym.kind === 'type' ? 'type' :
            sym.kind === 'var' ? 'constant / global' :
            sym.kind === 'enum' ? 'enum' : (sym.kind || 'symbol');

        const d = sym.description || {};
        const lines = [`# ${id}   (${kindLabel})`];
        // Surface the openFrameworks equivalent prominently (second line) so oF→TrussC
        // migration queries ("what replaces ofSetColor?") match — the oF names are
        // exact tokens that get diluted when buried lower in the card.
        if (sym.of?.length) lines.push(`openFrameworks equivalent: ${sym.of.join(', ')} → use ${id} in TrussC.`);
        for (const lang of ['en', 'ja', 'ko']) if (d[lang]) lines.push(d[lang]);
        if (sym.signatures?.length) {
            lines.push('', 'Signatures:');
            for (const s of sym.signatures) lines.push(renderSig(sym, s));
        }
        if (sym.of?.length) {
            let l = `oF: ${sym.of.join(', ')}`;
            if (sym.of_notes?.en) l += `  (${sym.of_notes.en})`;
            lines.push('', l);
        }
        if (sym.keywords?.length) lines.push(`keywords: ${sym.keywords.join(', ')}`);
        if (sym.details) lines.push('', sym.details);

        chunks.push({
            id: 'symbol:' + id,
            source: 'reference',
            lang: 'multi',
            title: id,
            text: lines.join('\n'),
            meta: { kind: sym.kind, category: sym.category || null, owner: sym.owner || null, of: sym.of || [] },
        });
    }
    return chunks;
}

// --- Source: examples ------------------------------------------------------
// One chunk per example. examples.json only has name/size/web-support, so the
// "what does it show" content comes from the on-disk source (src/tcApp.cpp):
// the APIs it calls (intersected with the known symbol names) + a code excerpt.
// This makes both "show me an example of drawRect" and "what's the easyCam
// example about" answerable.
const LIFECYCLE = new Set(['setup', 'update', 'draw', 'exit']);   // overrides, not "used APIs"

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
        for (const it of (g.items || [])) {
            const cpp = join(srcRoot, group, it.name, 'src', 'tcApp.cpp');
            let apis = [], excerpt = '';
            if (existsSync(cpp)) {
                const src = readFileSync(cpp, 'utf8').replace(/\r/g, '');
                apis = exampleApis(src, nameSet);
                excerpt = src.slice(0, 1800);
            }
            const lines = [`# ${it.name}  (example — ${group})`,
                `A TrussC example${it.webSupported === false ? '' : ' (runs in the web player)'}.`];
            if (apis.length) lines.push(`APIs used: ${apis.slice(0, 40).join(', ')}`);
            if (excerpt) lines.push('', 'Source (src/tcApp.cpp, excerpt):', '```cpp', excerpt, '```');
            chunks.push({
                id: 'example:' + it.name,
                source: 'example',
                lang: 'en',
                title: `${it.name} (example)`,
                text: lines.join('\n'),
                meta: { group, webSupported: it.webSupported !== false, apis },
            });
        }
    }
    return chunks;
}

// --- Assemble ---------------------------------------------------------------
const refData = JSON.parse(readFileSync(REFERENCE_DATA, 'utf8'));
const nameSet = new Set(Object.values(refData).map((s) => s && s.name).filter(Boolean));

const concept = chunkForAi(FOR_AI);
const symbols = chunkReference(REFERENCE_DATA);
const examples = chunkExamples(EXAMPLES_JSON, EXAMPLES_SRC, nameSet);
const chunks = [...concept, ...symbols, ...examples];

writeFileSync(CHUNKS, chunks.map((c) => JSON.stringify(c)).join('\n') + '\n');
console.log(`wrote ${chunks.length} chunks → ${CHUNKS}`);
console.log(`  concept  (for-ai):     ${concept.length}`);
console.log(`  symbol   (reference):  ${symbols.length}`);
console.log(`  example  (examples):   ${examples.length}`);
