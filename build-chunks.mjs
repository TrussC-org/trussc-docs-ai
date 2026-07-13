// Slice source docs into retrieval chunks → chunks.jsonl (one JSON object/line).
// Sources:
//   concept  — hand-written half of FOR_AI_ASSISTANT.md (task/how-to/idioms), by heading
//   symbol   — the merged web data (trussc-api.js) + oF mapping (of-mapping.json):
//              rich cards (signatures, enum values, properties, operators, related,
//              multilingual prose) whose NAMES match the reference page (links resolve)
//   example  — examples.json + each example's src/tcApp.cpp (APIs used + excerpt)
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { FOR_AI, TRUSSC_API, SKETCH_LUA_REF, OF_MAPPING, EXAMPLES_JSON, EXAMPLES_SRC, DOCS_DIR, ADDON_REGISTRY, ADDONS_DIR, RELEASES_JSON, CHUNKS } from './config.mjs';

const require = createRequire(import.meta.url);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const descBlock = (o) => ['desc', 'desc_ja', 'desc_ko'].map((k) => o[k]).filter(Boolean);

// Split markdown into [{crumb, text}] by ## / ### headings (### nested under its ##
// as "H2 > H3"). Content before the first heading is dropped (same as the original).
function splitHeadings(md) {
    const out = [];
    let h2 = '', cur = null;
    const flush = () => {
        if (cur && cur.body.join('\n').trim()) {
            const crumb = cur.h2 && cur.h2 !== cur.heading ? `${cur.h2} > ${cur.heading}` : cur.heading;
            out.push({ crumb, text: cur.body.join('\n').trim() });
        }
        cur = null;
    };
    const clean = (s) => s.replace(/[*`]/g, '').trim();   // drop markdown emphasis/code marks from headings
    for (const line of md.split('\n')) {
        const m2 = /^## (.+)/.exec(line), m3 = /^### (.+)/.exec(line);
        if (m2) { flush(); h2 = clean(m2[1]); cur = { h2, heading: h2, body: [] }; }
        else if (m3) { flush(); cur = { h2, heading: clean(m3[1]), body: [] }; }
        else if (cur) cur.body.push(line);
    }
    flush();
    return out;
}

// --- Source: FOR_AI concept half -------------------------------------------
function chunkForAi(path) {
    let md = readFileSync(path, 'utf8');
    const cut = md.indexOf('\n## API Index');
    if (cut !== -1) md = md.slice(0, cut);
    return splitHeadings(md).map(({ crumb, text }) =>
        ({ id: 'concept:' + slug(crumb), source: 'for-ai', lang: 'cpp', title: crumb, text: `# ${crumb}\n\n${text}` }));
}

// --- Source: hand-written TrussC docs (docs/*.md) --------------------------
// Curated list of high-value prose (how-to / design / migration). Vendored library
// docs, license/security boilerplate, and internal design memos are NOT included.
// FOR_AI_ASSISTANT.md is handled by chunkForAi (skip here to avoid duplicates).
const DOC_FILES = [
    ['README.md', 'TrussC'],                              // note: repo root, resolved below
    ['ARCHITECTURE.md', 'Architecture'],
    ['GET_STARTED.md', 'Get Started'],
    ['GET_STARTED_CONSOLE_MODE.md', 'Get Started (console mode)'],
    ['TrussC_vs_openFrameworks.md', 'TrussC vs openFrameworks'],
    ['ADDONS.md', 'Addons'],
    ['BUILD_SYSTEM.md', 'Build System'],
    ['AI_AUTOMATION.md', 'AI Automation (MCP)'],
    ['ROADMAP.md', 'Roadmap'],
];
function chunkDocs(docsDir) {
    const chunks = [];
    for (const [rel, label] of DOC_FILES) {
        // README lives at the repo root (one level up from docs/); the rest in docs/.
        const path = rel === 'README.md' ? join(docsDir, '..', rel) : join(docsDir, rel);
        if (!existsSync(path)) continue;
        for (const { crumb, text } of splitHeadings(readFileSync(path, 'utf8'))) {
            const title = `${label} > ${crumb}`;
            chunks.push({ id: 'doc:' + slug(label + ' ' + crumb), source: 'for-ai', lang: 'common', title, text: `# ${title}\n\n${text}` });
        }
    }
    return chunks;
}

// --- Source: official addon READMEs ----------------------------------------
// "Official" = present in the registry trussc.org renders. We ingest the README of
// each one that's also bundled locally, prefixed with the registry metadata
// (description / category / keywords) so the card retrieves well. Long READMEs are
// capped (the tail is usually license/build detail).
const ADDON_README_CAP = 8000;
function chunkAddons(registryPath, addonsDir) {
    if (!existsSync(registryPath)) return [];
    const reg = JSON.parse(readFileSync(registryPath, 'utf8')).addons || [];
    const chunks = [];
    for (const a of reg) {
        const head = [
            `# ${a.name}  (official addon — ${a.category || 'addon'})`,
            a.description || null,
            a.author ? `Author: ${a.author}${a.license ? ` · ${a.license}` : ''}` : null,
            (a.keywords && a.keywords.length) ? `keywords: ${a.keywords.join(', ')}` : null,
            `Add to a project: \`trusscli addon add ${a.name}\``,
        ].filter(Boolean).join('\n');
        // Prefer the README when the addon is bundled locally with one; otherwise fall
        // back to a registry-metadata-only card so every official addon is at least
        // findable (README-less ones like tcxBox2d were being dropped entirely before).
        const readme = join(addonsDir, a.name, 'README.md');
        let body = existsSync(readme) ? readFileSync(readme, 'utf8').replace(/\r/g, '') : '';
        if (body.length > ADDON_README_CAP) body = body.slice(0, ADDON_README_CAP) + '\n\n… (README truncated)';
        const text = body ? `${head}\n\n${body}` : head;
        chunks.push({ id: 'addon:' + a.name, source: 'addon', lang: 'common', title: `${a.name} (addon)`, text, meta: { category: a.category || null, url: a.url || null, keywords: a.keywords || [], addon: a.name } });
    }
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
        chunks.push({ id: 'symbol:' + id, source: 'reference', lang: 'cpp', title, text: lines.filter((l) => l != null && l !== '').join('\n'), meta });

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
// The web player shows tcApp.cpp + tcApp.h (fixed tabs) + additionalFiles. Mirror
// that: read each file IN FULL (no truncation), deliver them concatenated as one
// chunk per example, but embed a vector PER FILE (plus the whole combined text) so
// a query that matches only the .h or only the .glsl still surfaces the whole set.
// A chunk is thus { text: combined, embedTexts: [per-file...] } and is a HIT if the
// combined OR any file vector matches. main.cpp is window boilerplate → skipped,
// same as the player.
const LIFECYCLE = new Set(['setup', 'update', 'draw', 'exit']);
function exampleApis(src, nameSet) {
    const used = new Set();
    for (const m of src.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
        const w = m[1];
        if (w.length >= 4 && !LIFECYCLE.has(w) && nameSet.has(w)) used.add(w);
    }
    return [...used];
}
// Addon examples: each official addon ships example-*/ dirs whose src/ shows how to
// actually USE the addon (the physics Mod pattern, joints, etc.) — content README
// never covers. Ingest them through the SAME shape as core examples (source:'example',
// per-file vectors, lean-trimmed on delivery) so they share the example quota and need
// no mechanism change; id is namespaced `example:<addon>/<name>` and meta.addon is set
// so we can split them out later if they prove noisy. Scoped by env ADDON_EXAMPLES
// ('' = off, 'all', or a comma list of addon names) while we measure.
const ADDON_EXAMPLES = (process.env.ADDON_EXAMPLES || '').trim();
function chunkAddonExamples(registryPath, addonsDir, nameSet) {
    if (!ADDON_EXAMPLES || !existsSync(registryPath)) return [];
    const only = ADDON_EXAMPLES === 'all' ? null : new Set(ADDON_EXAMPLES.split(',').map((s) => s.trim()));
    const reg = JSON.parse(readFileSync(registryPath, 'utf8')).addons || [];
    const lang = (rel) => (rel.endsWith('.glsl') ? 'glsl' : 'cpp');
    const chunks = [];
    for (const a of reg) {
        if (only && !only.has(a.name)) continue;
        const addonDir = join(addonsDir, a.name);
        if (!existsSync(addonDir)) continue;
        let entries;
        try { entries = readdirSync(addonDir, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            if (!e.isDirectory() || !e.name.startsWith('example-')) continue;
            const srcDir = join(addonDir, e.name, 'src');           // ONLY src/ — never build dirs (Jolt/etc source)
            if (!existsSync(srcDir)) continue;
            let srcFiles;
            try { srcFiles = readdirSync(srcDir); } catch { continue; }
            // usage source only: tcApp.* first, then extra headers/impls; main.cpp is window boilerplate → skip
            const want = srcFiles
                .filter((f) => /\.(cpp|h|glsl)$/.test(f) && f !== 'main.cpp')
                .sort((x, y) => (x.startsWith('tcApp') ? -1 : y.startsWith('tcApp') ? 1 : x.localeCompare(y)));
            const files = [];
            for (const rel of want) {
                const p = join(srcDir, rel);
                if (existsSync(p)) files.push({ rel, src: readFileSync(p, 'utf8').replace(/\r/g, '') });
            }
            if (!files.length) continue;
            const name = e.name.replace(/^example-/, '');
            const label = `${a.name}/${name}`;
            const apis = exampleApis(files.map((f) => f.src).join('\n'), nameSet);
            const head = [`# ${label}  (${a.name} addon example)`, `A usage example for the ${a.name} addon.`, apis.length ? `APIs used: ${apis.slice(0, 50).join(', ')}` : null].filter(Boolean).join('\n');
            const block = (f) => `// ===== ${f.rel} =====\n\`\`\`${lang(f.rel)}\n${f.src}\n\`\`\``;
            const text = `${head}\n\n${files.map(block).join('\n\n')}`;
            const embedTexts = files.map((f) => `${label} (${a.name} addon example) — ${f.rel}\n${f.src}`);
            chunks.push({ id: 'example:' + label, source: 'example', lang: 'cpp', title: `${label} (addon example)`, text, embedTexts, meta: { group: `${a.name} addon`, addon: a.name, webSupported: false, apis, files: files.map((f) => f.rel) } });
        }
    }
    return chunks;
}
function chunkExamples(jsonPath, srcRoot, nameSet) {
    const j = JSON.parse(readFileSync(jsonPath, 'utf8'));
    const chunks = [];
    const lang = (rel) => (rel.endsWith('.glsl') ? 'glsl' : 'cpp');
    for (const [group, g] of Object.entries(j.examples || {})) {
        for (const it of g.items || []) {
            const dir = join(srcRoot, group, it.name, 'src');
            const want = ['tcApp.cpp', 'tcApp.h', ...(it.additionalFiles || [])];
            const seen = new Set(), files = [];
            for (const rel of want) {
                if (seen.has(rel)) continue;
                seen.add(rel);
                const p = join(dir, rel);
                if (existsSync(p)) files.push({ rel, src: readFileSync(p, 'utf8').replace(/\r/g, '') });
            }
            if (!files.length) continue;
            const web = it.webSupported !== false;
            const apis = exampleApis(files.map((f) => f.src).join('\n'), nameSet);
            const head = [`# ${it.name}  (example — ${group})`, `A TrussC example${web ? ' (runs in the web player)' : ''}.`, apis.length ? `APIs used: ${apis.slice(0, 50).join(', ')}` : null].filter(Boolean).join('\n');
            const block = (f) => `// ===== ${f.rel} =====\n\`\`\`${lang(f.rel)}\n${f.src}\n\`\`\``;
            const text = `${head}\n\n${files.map(block).join('\n\n')}`;
            // Per-file embed vectors; the header line carries the example name/group so
            // a file vector also responds to "<name> example" / "<group>" queries.
            const embedTexts = files.map((f) => `${it.name} (example — ${group}) — ${f.rel}\n${f.src}`);
            chunks.push({ id: 'example:' + it.name, source: 'example', lang: 'cpp', title: `${it.name} (example)`, text, embedTexts, meta: { group, webSupported: web, apis, files: files.map((f) => f.rel) } });
        }
    }
    return chunks;
}

// --- Source: Lua reference (generated/trusssketch-ref.js) -------------------
// TrussSketch is the in-browser Lua playground (trussc.org/sketch). Its API is a
// Lua-flavored TWIN of the C++ reference: the SAME symbols, but Lua syntax — methods
// with ':' (fbo:begin()), fields/statics/enum values/constants with '.' (v.x,
// Vec2.fromAngle, BlendMode.Add), Type(...) / Type.new(...) constructors, and
// reserved-word renames (end_fbo/end_shader/end_cam). We ingest it as a SEPARATE
// lang:'lua' corpus (source:'sketch-lua') so sketch-mode retrieval can PREFER the Lua
// twin over the C++ card (rag.mjs), while normal C++ chat excludes lang:'lua' entirely.
//
// Granularity mirrors the C++ reference chunking so titles line up 1:1 for the
// twin-dedup in rag.mjs: one chunk per function symbol (overloads grouped), one per
// type (methods + properties + statics INLINE — not per-member like C++, so the Lua
// renames like end_fbo travel with their type), one per enum. Plus a grouped Tasks
// chunk (spawn/wait/forever — TrussSketch-only, no C++ twin) and a single constants
// overview. Title = the bare symbol name, IDENTICAL to the C++ reference title.
const luaDesc = (o) => [o.desc, o.desc_ja].filter(Boolean);   // en (+ja); ko dropped to keep Lua cards lean
const luaRet = (rt) => (rt && rt !== '(nothing)' && rt !== 'void' && rt !== '' ? ` -> ${rt}` : '');
const luaSig = (m) => ((m.signatures && m.signatures.length ? m.signatures : ['']).map((s) => `${m.name}(${s})`).join(' | ')) + luaRet(m.return);
function chunkSketchLua(luaApi) {
    const out = [];
    const push = (name, kind, lines, meta) =>
        out.push({ id: 'lua:' + name, source: 'sketch-lua', lang: 'lua', title: name, text: lines.filter((l) => l != null && l !== '').join('\n'), meta: { kind, ...meta } });

    // functions — group overloads by name into one card (mirrors chunkApi). The Tasks
    // trio is pulled into its own grouped chunk below, so skip it here.
    const TASKS = new Set(['spawn', 'wait', 'forever']);
    const fnGroups = new Map();
    for (const cat of luaApi.categories || []) for (const f of cat.functions || []) {
        if (TASKS.has(f.name)) continue;
        if (!fnGroups.has(f.name)) fnGroups.set(f.name, { cat: cat.name, items: [] });
        fnGroups.get(f.name).items.push(f);
    }
    for (const [name, g] of fnGroups) {
        const f0 = g.items[0];
        const lines = [`# ${name}   (Lua function · ${g.cat})`, ...luaDesc(f0)];
        const seen = new Set(), sigs = [];
        for (const f of g.items) {
            const s = `  ${name}(${f.params_typed || f.params || ''})${luaRet(f.return_type)}`;
            if (!seen.has(s)) { seen.add(s); sigs.push(s); }
        }
        if (sigs.length) lines.push('', 'Lua signatures:', ...sigs);
        if (f0.keywords?.length) lines.push('', `keywords: ${f0.keywords.join(', ')}`);
        push(name, 'function', lines, { category: g.cat, keywords: f0.keywords || [] });
    }

    // types — one card, methods + properties + statics INLINE. Constructor works as
    // BOTH Type(...) and Type.new(...) in Lua (see lua:gotchas).
    for (const t of luaApi.types || []) {
        const lines = [`# ${t.name}   (Lua type)`, ...luaDesc(t)];
        const ctorSigs = (t.constructor && t.constructor.signatures) || [];   // own prop from JSON.parse; shadows Object.prototype
        if (ctorSigs.length) {
            lines.push('', `Construct with ${t.name}(...) or ${t.name}.new(...):`);
            for (const s of ctorSigs) lines.push(`  ${t.name}(${s})`);
        }
        if (t.properties?.length) { lines.push('', 'Properties (access with .):'); for (const p of t.properties) lines.push(`  ${p.name}${p.type ? ` (${p.type})` : ''}${p.desc ? ` — ${p.desc}` : ''}`); }
        if (t.methods?.length) { lines.push('', 'Methods (call with :):'); for (const m of t.methods) lines.push(`  ${luaSig(m)}${m.desc ? ` — ${m.desc}` : ''}`); }
        if (t.static_methods?.length) { lines.push('', 'Static functions (call with .):'); for (const m of t.static_methods) lines.push(`  ${luaSig(m)}${m.desc ? ` — ${m.desc}` : ''}`); }
        if (t.operators?.length) { lines.push('', 'Operators:'); for (const o of t.operators) lines.push(`  ${o.signature || o.cpp || ''}${o.desc ? ` — ${o.desc}` : ''}`); }
        if (t.related?.length) lines.push('', `Related: ${t.related.join(', ')}`);
        if (t.keywords?.length) lines.push(`keywords: ${t.keywords.join(', ')}`);
        push(t.name, 'type', lines, { keywords: t.keywords || [], related: t.related || [] });
    }

    // enums — accessed with '.', e.g. BlendMode.Add
    for (const e of luaApi.enums || []) {
        const lines = [`# ${e.name}   (Lua enum)`, ...luaDesc(e)];
        if (e.values?.length) { lines.push('', 'Values (access with .):'); for (const v of e.values) lines.push(`  ${e.name}.${v.name}${v.value != null ? ` = ${v.value}` : ''}${v.desc ? ` — ${v.desc}` : ''}`); }
        if (e.related?.length) lines.push('', `Related: ${e.related.join(', ')}`);
        if (e.keywords?.length) lines.push(`keywords: ${e.keywords.join(', ')}`);
        push(e.name, 'enum', lines, { keywords: e.keywords || [] });
    }

    // Tasks trio (spawn / wait / forever) — TrussSketch-only cooperative coroutines,
    // no C++ twin. Grouped because they only make sense together.
    const tasksCat = (luaApi.categories || []).find((c) => c.name === 'Tasks');
    if (tasksCat) {
        const lines = ['# Tasks: spawn / wait / forever   (Lua — TrussSketch cooperative tasks)',
            'TrussSketch runs cooperative tasks (coroutines) so you can animate or sequence things over time without blocking draw().', ''];
        for (const f of tasksCat.functions || []) {
            lines.push(`  ${f.name}(${f.params_typed || f.params || ''}) — ${f.desc || ''}`);
            if (f.desc_ja) lines.push(`      ${f.desc_ja}`);
        }
        lines.push('', 'Inside a task, wait(sec) pauses just that task. forever(fn) repeats fn forever, with an implicit wait(0) each loop so it yields.',
            'keywords: spawn, wait, forever, task, coroutine, async, animation, sequence, タスク, 待つ, 繰り返し');
        out.push({ id: 'lua:tasks', source: 'sketch-lua', lang: 'lua', title: 'Tasks (spawn/wait/forever)', text: lines.join('\n'), meta: { kind: 'tasks', keywords: ['spawn', 'wait', 'forever', 'task', 'coroutine'] } });
    }

    // constants overview — one card listing every global constant (used by bare name)
    if (luaApi.constants?.length) {
        const lines = ['# TrussSketch constants   (Lua)', 'Global constants available in every sketch (use the bare name):', ''];
        for (const c of luaApi.constants) lines.push(`  ${c.name}${c.desc ? ` — ${c.desc}` : ''}`);
        lines.push('', 'keywords: constant, key code, TAU, PI, angle, direction, blend, mouse button, 定数, キー');
        out.push({ id: 'lua:constants', source: 'sketch-lua', lang: 'lua', title: 'TrussSketch constants', text: lines.join('\n'), meta: { kind: 'constants', keywords: (luaApi.constants || []).map((c) => c.name) } });
    }

    return out;
}

// --- Hand-written: Lua gotchas (the sharp edges of the Lua binding) ---------
// Force-pinned in sketch mode (rag.mjs) so every TrussSketch answer respects the
// Lua-vs-C++ syntax differences even when the specific symbol chunk didn't surface.
function chunkLuaGotchas() {
    const text = `# TrussSketch Lua gotchas (read me first)

TrussSketch runs Lua 5.4, not C++. The API NAMES are the same as TrussC C++, but the syntax differs. Watch these:

- Call METHODS with a colon: \`fbo:begin()\`, \`mesh:draw()\`, \`v:length()\`. Access FIELDS, static functions, enum values and constants with a dot: \`v.x\`, \`Vec2.fromAngle(a)\`, \`BlendMode.Add\`, \`colors.red\`, \`TAU\`.
- Constructors work BOTH ways: \`Vec2(10, 20)\` and \`Vec2.new(10, 20)\` are equivalent — use whichever reads better.
- Reserved-word renames — Lua keyword \`end\` cannot be a method name, so the begin/end pairs are renamed. NEVER call \`:end()\`. Use:
    - Fbo:     \`fbo:begin()\` … \`fbo:end_fbo()\`
    - Shader:  \`shader:begin()\` … \`shader:end_shader()\`
    - Camera:  \`cam:begin()\` … \`cam:end_cam()\`
- Matrices: \`Mat3\` / \`Mat4\` use accessor methods, not index/operator sugar — read and write elements with \`m:at(row, col)\` and \`m:set(...)\`.
- Tweens are per-type globals: \`TweenFloat\`, \`TweenVec2\`, \`TweenVec3\`, \`TweenColor\`. There is NO plain \`Tween\` — pick the one matching the value you animate.
- Filesystem paths are plain Lua strings (e.g. \`"data/img.png"\`) — there is no path object.
- NOT bound in Lua (do not use in a sketch): \`Thread\`, \`SoundSource\`, \`Environment\`, \`VideoPlayerBase\`, \`Event<T>\`, \`ThreadChannel<T>\`. These are native-only.
- Cooperative tasks: \`spawn(fn)\` starts a task, \`wait(seconds)\` pauses the current task, \`forever(fn)\` loops fn forever (with an implicit \`wait(0)\` each iteration so it yields). Use these for animation/sequencing instead of blocking loops.
- Sketch lifecycle functions are OPTIONAL global functions: \`function setup() end\`, \`function update() end\`, \`function draw() end\`. If you don't define one, the host provides a no-op — define only what you need.
- Same core conventions as C++: colors are 0.0–1.0 floats (not 0–255); angles are in radians — use \`TAU\` (a full turn) instead of PI.

Lua syntax reminders: blocks close with \`end\`; comments start with \`--\`; no \`#include\`, no \`::\`, no type declarations, no semicolons.`;
    return {
        id: 'lua:gotchas', source: 'sketch-lua', lang: 'lua',
        title: 'TrussSketch Lua gotchas',
        text,
        meta: { kind: 'gotchas', keywords: ['lua', 'syntax', 'colon', 'dot', 'end_fbo', 'end_shader', 'end_cam', 'Type.new', 'constructor', 'tween', 'spawn', 'wait', 'forever', 'setup', 'update', 'draw', 'gotcha'] },
    };
}

// --- Assemble ---------------------------------------------------------------
const api = require(TRUSSC_API);
const luaApi = require(SKETCH_LUA_REF);
// --- Source: GitHub release notes (releases.json, cached by fetch-releases.mjs) ----
// Release notes are the only source that records WHAT changed and WHY — rationale
// that never reaches the reference or docs. Two hazards, both handled here:
//   1. Old notes mention APIs that were since renamed/removed → every chunk opens
//      with a historical-context header so the model treats it as history, not as
//      proof an API currently exists.
//   2. "What's new lately?" is a RECENCY question, and no ranking stage (dense /
//      BM25 / cross-encoder) knows dates — all releases look equally "release-ish".
//      So recency is baked in at build time: a digest chunk (release:latest) lists
//      the newest releases in order and carries the latest/recent/changelog keywords.
function chunkReleases(path) {
    if (!existsSync(path)) { console.warn(`  (releases: ${path} not found — run fetch-releases.mjs; skipping)`); return []; }
    const rel = JSON.parse(readFileSync(path, 'utf8'));   // newest-first (GitHub order)
    if (!rel.length) return [];
    const RELEASE_BODY_CAP = 6000;
    const chunks = rel.map((r, i) => {
        const latest = i === 0;
        const head = latest
            ? `[Release note for the CURRENT latest TrussC release: ${r.tag} (${r.date}).]`
            : `[Historical release note: ${r.tag}, published ${r.date}. It describes TrussC as of that version — APIs mentioned may have been renamed or removed since; for current signatures trust the reference. Use this note for what changed and why.]`;
        let body = r.body;
        if (body.length > RELEASE_BODY_CAP) body = body.slice(0, RELEASE_BODY_CAP) + '\n\n… (truncated)';
        return {
            id: 'release:' + r.tag, source: 'release', lang: 'common',
            title: `Release ${r.tag}${latest ? ' (latest)' : ''} — ${r.date}`,
            text: `${head}\n\n# ${r.name}\n\n${body}`,
            meta: { tag: r.tag, date: r.date, url: r.url, keywords: [r.tag, 'release', 'release notes', 'changelog'] },
        };
    });
    // Digest: the deterministic answer to recency queries, rebuilt every corpus update.
    // Excerpts cut on markdown line boundaries (never mid-bullet): whole lines are
    // taken top-down until the budget, and a heading left dangling with no content
    // below it is dropped. Feature bullets lead every note, so the budget naturally
    // captures the headline items and sheds the fixes/chores tail.
    const DIGEST_BUDGET = 1000;
    const excerpt = (body) => {
        const kept = [];
        let used = 0;
        for (const line of body.split('\n')) {
            if (used + line.length + 1 > DIGEST_BUDGET && kept.length) { kept.push('…'); break; }
            kept.push(line);
            used += line.length + 1;
        }
        while (kept.length && /^(#|\s*$|…$)/.test(kept[kept.length - 1])) {
            if (kept[kept.length - 1] === '…') break;
            kept.pop();                       // drop a trailing heading/blank with nothing under it
        }
        return kept.join('\n').trim();
    };
    const digest = rel.slice(0, 5).map((r) => `## ${r.tag} — ${r.name} (${r.date})\n${excerpt(r.body)}`).join('\n\n');
    chunks.unshift({
        id: 'release:latest', source: 'release', lang: 'common',
        title: 'Latest TrussC releases (newest first)',
        text: `The current latest TrussC release is ${rel[0].tag} (${rel[0].date}). Recent releases, newest first:\n\n${digest}\n\nFull history: https://github.com/TrussC-org/TrussC/releases`,
        meta: { url: 'https://github.com/TrussC-org/TrussC/releases', keywords: ['release notes', 'releases', 'latest release', 'newest', 'recent releases', 'changelog', 'version', 'update history', "what's new", 'リリースノート', '最新リリース', '更新履歴'] },
    });
    return chunks;
}

const ofIdx = loadOfIndex(OF_MAPPING);

// names for example API-usage detection: functions + type/method/static + enums
const nameSet = new Set();
for (const c of api.categories || []) for (const f of c.functions || []) nameSet.add(f.name);
for (const t of api.types || []) { nameSet.add(t.name); for (const m of [...(t.methods || []), ...(t.static_methods || [])]) nameSet.add(m.name); }
for (const e of api.enums || []) nameSet.add(e.name);

const concept = chunkForAi(FOR_AI);
const docs = chunkDocs(DOCS_DIR);
const symbols = chunkApi(api, ofIdx);
const examples = chunkExamples(EXAMPLES_JSON, EXAMPLES_SRC, nameSet);
const addonExamples = chunkAddonExamples(ADDON_REGISTRY, ADDONS_DIR, nameSet);
const addons = chunkAddons(ADDON_REGISTRY, ADDONS_DIR);
const releases = chunkReleases(RELEASES_JSON);
const sketchLua = chunkSketchLua(luaApi);
const luaGotchas = chunkLuaGotchas();
const chunks = [...concept, ...docs, ...symbols, ...examples, ...addonExamples, ...addons, ...releases, luaGotchas, ...sketchLua];

// Compact English-only repr for the cross-encoder reranker. The full chunk text is
// multilingual (en/ja/ko desc) + code + of-mapping, which dilutes cross-encoder
// scores; a clean "title + English desc + signatures" restores sharp rr. NOT embedded
// (vectors unchanged) — only fed to the reranker at query time (rag.rerankCandidates).
const CJK = /[぀-ヿ㐀-鿿가-힯]/;
function rerankRepr(c) {
    // Addons: the substance for reranking is the one-line pitch + the curated
    // keywords, NOT the README boilerplate (author / install command / WIP badge /
    // screenshots) that the generic line-scan below would otherwise grab. Build the
    // repr from the description line and meta.keywords so terms like "collision"
    // actually reach the cross-encoder.
    if (c.source === 'addon') {
        const lines = (c.text || '').split('\n').map((s) => s.trim());
        const desc = lines.find((t) =>
            t && !t.startsWith('#') && !/^(Author|Add to a project|keywords):/i.test(t) &&
            !t.startsWith('![') && !t.startsWith('>') && !CJK.test(t)) || '';
        const kw = ((c.meta && c.meta.keywords) || []).join(', ');
        return `${c.title}\n${desc}\n${kw}`.slice(0, 500);
    }
    // Releases: skip the historical-context header (pure boilerplate to a reranker)
    // and feed title + the first real content lines, so version/history queries score
    // on substance while ordinary API queries don't get hijacked by note bodies.
    if (c.source === 'release') {
        const keep = [];
        for (const raw of (c.text || '').split('\n')) {
            const t = raw.trim();
            if (!t || t.startsWith('[') || t.startsWith('```') || CJK.test(t)) continue;
            // keep headings (minus the marks): the release NAME line ("# v0.5.3 —
            // miniaudio unification, …") is often the best one-line summary there is
            keep.push(t.replace(/^#+\s+/, '').replace(/^[-*]\s+/, ''));
            if (keep.length >= 5) break;
        }
        // Keywords carry the query-facing vocabulary ("release notes", "latest",
        // 最新リリース…) — without them the digest loses to any old note whose body
        // happens to open with the literal phrase "Release Notes".
        const kw = ((c.meta && c.meta.keywords) || []).join(', ');
        return `${c.title}\n${kw}\n${keep.join('\n')}`.slice(0, 500);
    }
    const keep = [];
    for (const raw of (c.text || '').split('\n')) {
        const t = raw.trim();
        if (!t || t.startsWith('```') || t.startsWith('# ') || t.startsWith('// =====')) continue;
        if (/^openFrameworks:/.test(t) || /^keywords:/i.test(t)) continue;
        if (CJK.test(t)) continue;                          // drop ja/ko desc lines
        keep.push(t);
        if (keep.length >= 6) break;
    }
    return `${c.title}\n${keep.join('\n')}`.slice(0, 500);
}
for (const c of chunks) c.rerankText = rerankRepr(c);

writeFileSync(CHUNKS, chunks.map((c) => JSON.stringify(c)).join('\n') + '\n');
console.log(`wrote ${chunks.length} chunks → ${CHUNKS}`);
console.log(`  concept (for-ai):     ${concept.length}`);
console.log(`  doc     (docs/*.md):  ${docs.length}`);
console.log(`  symbol  (trussc-api): ${symbols.length}  (of-mapping entries: ${ofIdx.size})`);
console.log(`  example (examples):   ${examples.length}`);
console.log(`  addon   (registry):   ${addons.length}`);
console.log(`  release (github):     ${releases.length}`);
console.log(`  sketch-lua (lua ref): ${sketchLua.length + 1}  (gotchas + fn/type/enum/tasks/constants)`);
