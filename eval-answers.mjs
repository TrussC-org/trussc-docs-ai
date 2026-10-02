// Generation A/B over a fixed question set. eval.mjs only looks at retrieval, so a
// prompt change (SYSTEM / PRIMER) never shows up there; this one runs the real
// generation and saves every answer for side-by-side reading.
//
// Each question is retrieved ONCE, then answered by every prompt variant from that
// same context, so the variants differ only in the prompt:
//   new  — SYSTEM + PRIMER of the rag.mjs next to this file
//   base — SYSTEM + PRIMER of rag.mjs at EVAL_BASE_REF (default HEAD, via git show)
// Retrieval is also cached per question (EVAL_CACHE, optional) so a later run can
// reuse it. Point EMBEDDED at another chunks.embedded.json to run on another corpus.
//   GEN_BACKEND=anthropic ANTHROPIC_API_KEY=… RERANK=1 EVAL_OUT=/tmp/r1.json node eval-answers.mjs
//   node eval-answers.mjs --show /tmp/r1.json:base /tmp/r1.json:new
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chunks, expandQuery, retrieveMulti, buildMessages, chatStream, resolveLinks, SYSTEM, PRIMER } from './rag.mjs';
import { TOP_K, GEN_BACKEND, ANTHROPIC_MODEL, GEN_MODEL, EMBEDDED } from './config.mjs';

const QUESTIONS = [
    // the retrieval set from eval.mjs — general answer quality
    ['concept/en', 'how do I draw a smooth curve through points?'],
    ['concept/ja', '図形に穴を開けたいときはどうする？'],
    ['symbol/en',  'how do I get the length of a Vec2?'],
    ['symbol/ja',  'ColorをOKLabから作るには？'],
    ['of/ja',      'ofSetColor に相当する TrussC の関数は？'],
    ['of/en',      "what is TrussC's equivalent of ofDrawRectangle?"],
    ['example/ja', 'easyCam のサンプルは何を見せてる？'],
    ['example/en', 'is there an example that uses drawBitmapString?'],
    ['concept/ja', 'Nodeでシーングラフを作るメリットは？'],
    ['concept/en', 'how does hot reload work?'],
    ['symbol/ja',  'マウスの位置を取るには？'],
    ['concept/en', 'how do I load and draw an image?'],
    ['symbol/en',  'how do I play a sound?'],
    ['concept/ja', 'FPSを設定するには？'],
    ['symbol/en',  'how do I rotate the coordinate system?'],
    ['example/ja', 'シェーダーのサンプルある？'],
    // crash-prone tasks — where the crash-safety rules should change the code
    ['crash/ja',   'ボタンを押したら自分自身のノードを消したい'],
    ['crash/en',   'how do I create a child node inside my custom Node class?'],
    ['crash/ja',   'audioOut の音量に合わせて円の大きさを変えたい'],
    ['crash/en',   'I want to load an image in a background thread with Thread'],
    ['crash/ja',   'UDP で受け取ったメッセージで画面の文字を書き換えたい'],
    ['crash/en',   'how do I listen to a Node event from another object?'],
    ['crash/ja',   'callEveryAsync で 1 秒ごとに Fbo に描きたい'],
    ['crash/en',   'my app crashes when I delete nodes in a for loop over children'],
    // known issues — should surface an issue (once the issue corpus is in) + workaround
    ['issue/en',   'my Thread subclass aborts with terminate when it is destroyed'],
    ['issue/ja',   'Windows で callAfterAsync のタイミングが 15ms くらいずれる'],
    ['issue/ja',   'Font で Meiryo UI を読むと別のフォントになる'],
    ['issue/en',   'VideoPlayer setLoop before load does not work'],
    ['issue/ja',   'Sound を play しても鳴らないことがある'],
    ['issue/en',   'getElapsedTime returns 0 in draw even though setup took 5 seconds'],
    // not-yet features / enhancement territory — must NOT be answered as a known bug
    ['feature/en', 'does TrussC support Vulkan?'],
    ['feature/ja', 'Serial で USB を抜いたのを検知したい'],
    // troubleshooting docs (FOR_AI pitfalls, INSTALLATION_WINDOWS)
    ['doc/ja',     'アプリが落ちた。どこで落ちたか調べたい'],
    ['doc/en',     'which thread does audioOut run on?'],
    ['doc/ja',     'Windows で展示を何週間も動かしっぱなしにしたい'],
];

const USED_RE = /\n+@@USED:[ \t]*([^\n]*)\s*$/;

// Cheap flags for skimming; the real judgement is reading the answers side by side.
function flags(answer) {
    const code = [...answer.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n');
    const f = [];
    const issues = [...new Set([...answer.matchAll(/#(\d{3})\b/g)].map((m) => '#' + m[1]))];
    if (issues.length) f.push(`issues ${issues.join(' ')}`);
    if (/removeChild\s*\(/.test(code)) f.push('code:removeChild');
    if (/\bnew\s+[A-Z]\w*/.test(code)) f.push('code:new');
    if (/make_shared/.test(code)) f.push('code:make_shared');
    if (/\[\s*(this|&)\s*[\],]/.test(code)) f.push('code:capture-this/&');
    if (/#(symbol|sym|concept|doc|example|addon|release|issue|lua):\w/.test(answer)) f.push('raw:id-leak');   // before resolveLinks cleans it up
    return f;
}

if (process.argv[2] === '--show') {
    // args: file.json:variant … — print those answers per question, in that order
    const cols = process.argv.slice(3).map((a) => {
        const i = a.lastIndexOf(':');
        const [file, variant] = i > 0 && !a.slice(i).includes('/') ? [a.slice(0, i), a.slice(i + 1)] : [a, 'new'];
        return { name: `${file.replace(/^.*\//, '').replace(/\.json$/, '')}:${variant}`, variant, data: JSON.parse(readFileSync(file, 'utf8')) };
    });
    for (const [i, r0] of cols[0].data.results.entries()) {
        console.log(`\n=========== [${r0.tag}] ${r0.q}`);
        for (const col of cols) {
            const r = col.data.results.find((x) => x.q === r0.q) || col.data.results[i];
            const a = r?.answers?.[col.variant];
            if (!a) { console.log(`--- ${col.name}: (missing)`); continue; }
            console.log(`--- ${col.name} (${a.answer.length} ch${a.usedOk ? '' : ', NO @@USED'}${a.flags.length ? ' | ' + a.flags.join(', ') : ''}) ctx: ${r.ids.filter((id) => id.startsWith('issue:')).join(' ') || '-'}\n${a.answer}`);
        }
    }
    console.log('');
    for (const col of cols) {
        const as = col.data.results.map((r) => r.answers?.[col.variant]).filter(Boolean);
        const len = as.map((a) => a.answer.length).sort((p, q) => p - q);
        console.log(`${col.name}: n=${as.length} median=${len[len.length >> 1]}ch mean=${Math.round(len.reduce((s, v) => s + v, 0) / (len.length || 1))}ch usedOk=${as.filter((a) => a.usedOk).length}/${as.length} mentionsIssue=${as.filter((a) => a.flags.some((f) => f.startsWith('issues'))).length}`);
    }
    process.exit(0);
}

const OUT = process.env.EVAL_OUT || '';
if (!OUT) { console.error('set EVAL_OUT=<file.json>'); process.exit(1); }
const CACHE = process.env.EVAL_CACHE || '';
const PAR = Number(process.env.EVAL_PAR || 3);
const VARIANTS = (process.env.EVAL_VARIANTS || 'base,new').split(',').map((s) => s.trim()).filter(Boolean);
const BASE_REF = process.env.EVAL_BASE_REF || 'HEAD';

// Prompt text per variant. The base prompts come from rag.mjs at BASE_REF, loaded as
// a throwaway module next to this file so its './config.mjs' import resolves.
const HERE = dirname(fileURLToPath(import.meta.url));
const prompts = { new: { SYSTEM, PRIMER } };
if (VARIANTS.includes('base')) {
    const tmp = join(HERE, `.eval-base-rag-${process.pid}.mjs`);
    writeFileSync(tmp, execFileSync('git', ['-C', HERE, 'show', `${BASE_REF}:rag.mjs`]));
    try { const m = await import(pathToFileURL(tmp).href); prompts.base = { SYSTEM: m.SYSTEM, PRIMER: m.PRIMER }; }
    finally { unlinkSync(tmp); }
}
const sysOf = (p) => `${p.SYSTEM}\n\n${p.PRIMER}`;

const byId = new Map(chunks().map((c) => [c.id, c]));
const cache = CACHE && existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {};
let cacheDirty = false;

async function generate(messages) {
    let full = '';
    for (let attempt = 1; ; attempt++) {         // the hosted API throws transient 5xx/429s; retry with backoff
        try { full = ''; for await (const d of chatStream(messages)) full += d; break; }
        catch (e) {
            if (attempt >= 4) throw e;
            process.stderr.write(`\n  retry ${attempt}: ${String(e.message).slice(0, 80)}\n`);
            await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
        }
    }
    const m = full.match(USED_RE);
    const raw = m ? full.slice(0, m.index).replace(/\s+$/, '') : full;
    const answer = resolveLinks(raw);
    return { answer, usedOk: !!m, flags: flags(raw) };
}

async function one([tag, q]) {
    const ids = cache[q];
    let retrieved = ids ? ids.map((id) => byId.get(id)).filter(Boolean) : null;
    if (!retrieved || retrieved.length !== ids.length) {
        const expanded = await expandQuery(q);
        retrieved = await retrieveMulti([q, expanded], TOP_K);
        cache[q] = retrieved.map((c) => c.id);
        cacheDirty = true;
    }
    const msgs = buildMessages(q, retrieved, [], null);
    if (msgs[0].content !== sysOf(prompts.new)) throw new Error('buildMessages system layout changed — update eval-answers.mjs');
    const answers = {};
    for (const v of VARIANTS) {
        try { answers[v] = await generate([{ role: 'system', content: sysOf(prompts[v]) }, ...msgs.slice(1)]); }
        catch (e) { answers[v] = { answer: '', usedOk: false, flags: [`error: ${String(e.message).slice(0, 60)}`] }; }   // keep the rest of the run
    }
    return { tag, q, ids: cache[q], answers };
}

const results = new Array(QUESTIONS.length);
let next = 0, done = 0;
await Promise.all(Array.from({ length: PAR }, async () => {
    while (next < QUESTIONS.length) {
        const i = next++;
        results[i] = await one(QUESTIONS[i]);
        process.stderr.write(`\r${++done}/${QUESTIONS.length}`);
    }
}));
process.stderr.write('\n');
if (CACHE && cacheDirty) writeFileSync(CACHE, JSON.stringify(cache, null, 1));
const model = GEN_BACKEND === 'anthropic' ? ANTHROPIC_MODEL : GEN_MODEL;
writeFileSync(OUT, JSON.stringify({ model, corpus: EMBEDDED, variants: VARIANTS, baseRef: BASE_REF, at: new Date().toISOString(), results }, null, 1));
console.log(`wrote ${results.length} questions × ${VARIANTS.join('/')} (${model}) → ${OUT}`);
