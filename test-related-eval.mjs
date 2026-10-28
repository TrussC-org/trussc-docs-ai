// Real MCP retrieval and eval runners, with injected fetches and synthetic files only.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, openSync, closeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'related-eval-'));
const oldEnv = { ...process.env }, oldFetch = globalThis.fetch, oldError = console.error, oldLog = console.log;
try {
    mkdirSync(join(dir, 'eval/related'), { recursive: true });
    for (const file of ['rag.mjs', 'config.mjs', 'jev.mjs', 'mcp-core.mjs', 'embed.mjs', 'eval/related/dump.mjs', 'eval/related/coverage.mjs'])
        writeFileSync(join(dir, file), readFileSync(new URL(file, import.meta.url)));
    const questions = ['slow', 'fast', 'error'].map(id => ({ id, question: `PRIVATE_QUESTION_${id}`, symbols: ['tc::Card0(...)'] }));
    const qf = join(dir, 'questions.json'), out = join(dir, 'dump.json');
    writeFileSync(qf, JSON.stringify(questions));
    const corpus = Array.from({ length: 50 }, (_, i) => ({ id: `symbol:Card${i}`, title: `Card${i}`, source: 'reference',
        text: 'Synthetic documentation', lang: 'cpp', vector: [1, 0], ...(i === 0 ? { meta: { brief: 'A card.', related: ['Card49'] }, near: ['symbol:Card48'] } : {}) }));
    writeFileSync(join(dir, 'corpus.json'), JSON.stringify(corpus));
    Object.assign(process.env, { EMBEDDED: join(dir, 'corpus.json'), STATS: '1', STATS_DIR: dir,
        TYPESAFE_API_KEY: 'synthetic-key', JEV_URL: 'https://stub.invalid/systemone', OLLAMA_URL: 'https://stub.invalid',
        JEV_PICK: 'fixed', JEV_PICK_K: '16', RETRIEVAL: 'jev', RERANK: '0', JEV_RATE_MAX: '10000', JEV_DAILY_TOKENS: '100000000' });
    let active = 0, highWater = 0, calls = 0, checkpoint = false;
    const logs = [];
    console.error = (...args) => logs.push(args.join(' '));
    globalThis.fetch = async (url, options) => {
        calls++;
        const req = JSON.parse(options.body);
        if (url.endsWith('/api/embed')) {
            active++; highWater = Math.max(highWater, active);
            if (req.input.endsWith('_slow')) {
                await new Promise(resolve => setTimeout(resolve, 80));
                assert(JSON.parse(readFileSync(out)).some(row => row.id === 'fast'));
                checkpoint = true;
            }
            active--;
            if (req.input.endsWith('_error')) {
                console.warn('PRIVATE upstream warning');
                throw new Error('PRIVATE upstream error ' + req.input);
            }
            return Response.json({ embeddings: [[1, 0]] });
        }
        assert(url.endsWith('/systemone'), 'No generation endpoint may be called');
        return Response.json({ answers: { ...Object.fromEntries(req.state.cards.map((c, i) => [c.card, { noul: 1 - i / 1000 }])), exists: { noul: .9 } } });
    };
    const { main } = await import(pathToFileURL(join(dir, 'eval/related/dump.mjs')));
    assert.equal(await main([qf, out, '--jobs', '2']), 1);
    assert.equal(process.env.STATS, '0');
    assert.equal((await import(pathToFileURL(join(dir, 'config.mjs')))).STATS, false);
    assert(checkpoint && highWater === 2 && active === 0);
    const serialized = readFileSync(out, 'utf8'), rows = JSON.parse(serialized);
    assert.deepEqual(rows.map(r => r.id), ['slow', 'fast', 'error']);
    assert.deepEqual(Object.keys(rows[0]).sort(), ['id', 'shown', 'ranked', 'path'].sort());
    assert.equal(rows[0].shown.length, 8); assert.equal(rows[0].ranked.length, 40);
    assert.equal(rows[0].path, 'jev'); assert.equal(rows[2].error, 'search failed');
    assert.deepEqual(rows[0].shown, rows[0].ranked.slice(0, 8));
    assert(!serialized.includes('PRIVATE')); assert(!serialized.includes('Synthetic documentation'));
    assert(!logs.join('\n').includes('PRIVATE'));
    assert(!readdirSync(dir).some(name => name.endsWith('.jsonl') || name.endsWith('.tmp')));
    const before = calls;
    assert.equal(await main([qf, out, '--resume']), 1);
    assert.equal(logs.at(-1), 'dump: completed 0, failed 1, retained 3');
    assert.equal(calls, before); assert.equal(readFileSync(out, 'utf8'), serialized);
    for (const row of [ { ...rows[0], question: 'PRIVATE' }, { id: 'slow' }, { ...rows[0], path: 'bad' }, { ...rows[0], ranked: [42] },
        { ...rows[0], error: 'PRIVATE' }, { ...rows[0], ranked: Array(41).fill('symbol:Card0') },
        { id: 'slow', shown: [], ranked: [], path: null },
        { ...rows[0], error: 'search failed' }, { ...rows[2], shown: ['symbol:Card0'] },
        { ...rows[2], ranked: ['symbol:Card0'] } ]) {
        writeFileSync(join(dir, 'bad.json'), JSON.stringify([row]));
        const original = readFileSync(join(dir, 'bad.json'), 'utf8');
        await assert.rejects(main([qf, join(dir, 'bad.json'), '--resume']), /invalid resume/);
        assert.equal(readFileSync(join(dir, 'bad.json'), 'utf8'), original);
        assert.equal(calls, before);
    }
    const successOut = join(dir, 'success.json');
    writeFileSync(successOut, JSON.stringify(rows.slice(0, 2)));
    const successQuestions = join(dir, 'success-questions.json');
    writeFileSync(successQuestions, JSON.stringify(questions.slice(0, 2)));
    assert.equal(await main([successQuestions, successOut, '--resume']), 0);
    assert.equal(logs.at(-1), 'dump: completed 0, failed 0, retained 2');
    const partialOut = join(dir, 'partial.json');
    writeFileSync(partialOut, JSON.stringify([rows[2]]));
    assert.equal(await main([qf, partialOut, '--resume']), 1);
    assert.equal(logs.at(-1), 'dump: completed 2, failed 1, retained 1');
    const afterPartial = calls;
    await assert.rejects(main([qf, out, '--jobs', '0']));
    await assert.rejects(main([qf, qf]));
    assert.equal(calls, afterPartial);
    // Presentation uses the actual shown boundary, even when Jev selected more than MCP's k.
    const { retrieve } = await import(pathToFileURL(join(dir, 'rag.mjs')));
    const { searchResponse, dispatch } = await import(pathToFileURL(join(dir, 'mcp-core.mjs')));
    const retrieved = await retrieve('synthetic retrieval');
    assert.equal(retrieved.length, 16);
    const all = searchResponse(retrieved, retrieved);
    assert(!all.candidates.some(c => retrieved.some(s => s.id === c.id)));
    const mcp = searchResponse(retrieved, retrieved.slice(0, 8));
    assert.equal(mcp.candidates[0].id, retrieved[8].id);
    assert(mcp.candidates.some(c => c.id === 'symbol:Card49'));
    assert(mcp.candidates.some(c => c.id === 'symbol:Card48'));
    const rpc = await dispatch({ id: 1, method: 'tools/call', params: { name: 'trussc_search', arguments: { query: 'synthetic retrieval' } } }, { search: async () => mcp });
    assert(rpc.result.content[0].text.includes('Other possibly related:'));
    let coverageOutput;
    console.log = s => { coverageOutput = s; };
    const { main: coverageMain } = await import(pathToFileURL(join(dir, 'eval/related/coverage.mjs')));
    coverageMain([qf, out, '--corpus', join(dir, 'corpus.json')]);
    const report = JSON.parse(coverageOutput);
    assert(report.every(r => r.failed === 1 && r.questions === 2 && r.totals.shown === 2));
    assert(!coverageOutput.includes('PRIVATE'));
    console.log = oldLog;
    // Embed main writes computed neighbours after all vectors have been regrouped.
    writeFileSync(join(dir, 'chunks.jsonl'), corpus.slice(0, 3).map(c => JSON.stringify({ ...c, text: c.text + c.id })).join('\n') + '\n');
    const { main: embedMain } = await import(pathToFileURL(join(dir, 'embed.mjs')));
    globalThis.fetch = async (_url, options) => Response.json({ embeddings: JSON.parse(options.body).input.map(() => [2, 0]) });
    console.log = () => {};
    await embedMain();
    const embedded = JSON.parse(readFileSync(join(dir, 'corpus.next.json')));
    assert.deepEqual(embedded.map(c => c.near), [ ['symbol:Card1', 'symbol:Card2'], ['symbol:Card0', 'symbol:Card2'], ['symbol:Card0', 'symbol:Card1'] ]);
    globalThis.fetch = () => { throw new Error('Cached build must not fetch'); };
    // The first output becomes the next build's vector cache.
    writeFileSync(join(dir, 'corpus.json'), JSON.stringify(embedded));
    await embedMain();
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'corpus.next.json'))).map(c => c.near), embedded.map(c => c.near));
    // Invalid cached primary vectors fail the CLI build with one line and leave output untouched.
    const goodOutput = readFileSync(join(dir, 'corpus.next.json'), 'utf8');
    for (const invalid of [{ length: 1e8 }, [1], [null]]) {
        const broken = structuredClone(embedded);
        broken[1].vectors[0] = invalid;
        writeFileSync(join(dir, 'corpus.json'), JSON.stringify(broken));
        const fds = [openSync('/dev/null', 'r'), openSync(join(dir, 'embed-stdout'), 'w'), openSync(join(dir, 'embed-stderr'), 'w')];
        let result;
        try { result = spawnSync(process.execPath, [join(dir, 'embed.mjs')], { cwd: dir, env: process.env, stdio: fds, timeout: 30000 }); }
        finally { fds.forEach(closeSync); }
        assert.equal(result.status, 1, result.error?.message);
        assert.match(readFileSync(join(dir, 'embed-stderr'), 'utf8'), /^Invalid primary vector: [^\r\n]+\n$/);
        assert.equal(readFileSync(join(dir, 'corpus.next.json'), 'utf8'), goodOutput);
    }
} finally {
    console.error = oldError; console.log = oldLog; globalThis.fetch = oldFetch;
    for (const name of Object.keys(process.env)) if (!(name in oldEnv)) delete process.env[name];
    Object.assign(process.env, oldEnv); rmSync(dir, { recursive: true, force: true });
}
console.log('Related dump, resume, old-corpus retrieval and embed persistence tests passed');
