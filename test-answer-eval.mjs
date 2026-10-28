// Synthetic corpus, injected fetch, no sockets and no credential files.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const dir = mkdtempSync(join(tmpdir(), 'docsai-answer-eval-'));
const savedEnv = { ...process.env }, savedFetch = globalThis.fetch, savedError = console.error;
try {
    mkdirSync(join(dir, 'eval/answers'), { recursive: true });
    for (const file of ['rag.mjs', 'config.mjs', 'jev.mjs', 'stats.mjs', 'mcp-core.mjs', 'eval/answers/answer.mjs']) {
        writeFileSync(join(dir, file), readFileSync(new URL(file, import.meta.url)));
    }
    const qf = join(dir, 'synthetic.json'), out = join(dir, 'out.json');
    const questions = ['slow', 'fast', 'error', 'tool', 'fallback'].map(id => ({ id, question: `SYNTHETIC_PRIVATE_${id}`, answer: 'reference is never copied' }));
    writeFileSync(qf, JSON.stringify(questions));
    const corpus = [{ id: 'symbol:drawCircle', title: 'drawCircle', source: 'reference', lang: 'cpp',
        text: 'drawCircle draws a circle.', vector: [1, 0], meta: { kind: 'function' } }];
    writeFileSync(join(dir, 'corpus.json'), JSON.stringify(corpus));
    Object.assign(process.env, { EMBEDDED: join(dir, 'corpus.json'), STATS: '1', STATS_DIR: dir,
        GEN_BACKEND: 'anthropic', ANTHROPIC_API_KEY: 'synthetic-haiku', TYPESAFE_API_KEY: 'synthetic-jev',
        RETRIEVAL: 'jev', RERANK: '0', JEV_RATE_MAX: '10000', JEV_DAILY_TOKENS: '100000000',
        JEV_URL: 'https://stub.invalid/systemone', OLLAMA_URL: 'https://stub.invalid', MAX_SEARCH_ROUNDS: '4' });
    delete process.env.ANSWER_EVAL_DEBUG;
    const logs = [];
    console.error = (...args) => logs.push(args.join(' '));
    const inFlight = new Set();
    let active = 0, highWater = 0, checkpoint = false, embeds = [], inspectCheckpoint = true;
    const frames = value => `data: ${JSON.stringify(value)}\n\n`;
    globalThis.fetch = async (url, options) => {
        const req = JSON.parse(options.body);
        if (url.endsWith('/api/embed')) {
            embeds.push(req.input);
            if (req.input.startsWith('SYNTHETIC_PRIVATE_')) {
                inFlight.add(req.input); active = inFlight.size; highWater = Math.max(highWater, active);
            }
            if (req.input.endsWith('_error')) {
                inFlight.delete(req.input); active = inFlight.size;
                throw Object.assign(new Error(`upstream quoted ${req.input}`), { path: req.input });
            }
            if (req.input.endsWith('_slow')) {
                await new Promise(resolve => setTimeout(resolve, 80));
                if (inspectCheckpoint) {
                    const rows = JSON.parse(readFileSync(out));
                    assert(rows.some(r => r.id === 'fast'));
                    assert(!rows.some(r => r.id === 'slow'));
                    checkpoint = true;
                }
            }
            return Response.json({ embeddings: [[1, 0]] });
        }
        if (url.endsWith('/systemone')) {
            if (req.state.question.endsWith('_fallback')) return new Response('', { status: 503 });
            return Response.json({ answers: { ...Object.fromEntries(req.state.cards.map(c => [c.card, { noul: .99 }])), exists: { noul: .8 } } });
        }
        assert.equal(url, 'https://api.anthropic.com/v1/messages');
        assert.equal(req.messages[0].role, 'user');
        const tool = req.messages[0].content.includes('SYNTHETIC_PRIVATE_tool') && !req.messages.some(m => Array.isArray(m.content) && m.content.some(c => c.type === 'tool_result'));
        let sse = frames({ type: 'message_start', message: { usage: { input_tokens: 101, output_tokens: 0 } } });
        if (tool) {
            assert(req.tools);
            sse += frames({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'DISCARDED RESEARCH TEXT' } });
            sse += frames({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', name: 'search_more', id: 'search1', input: { message: 'Looking', queries: ['PRIVATE_SEARCH_QUERY'] } } });
        } else {
            sse += frames({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Use [[drawCircle]].\n\n@@USED: symbol:drawCircle' } });
            inFlight.delete(req.messages[0].content.match(/SYNTHETIC_PRIVATE_\w+/)[0]); active = inFlight.size;
        }
        sse += frames({ type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 17 } });
        sse += frames({ type: 'message_stop' });
        return new Response(sse);
    };
    const { main } = await import(pathToFileURL(join(dir, 'eval/answers/answer.mjs')));
    assert.equal(await main([qf, out, '--jobs', '2']), 1);
    assert.equal(process.env.STATS, '0');
    assert.equal((await import(pathToFileURL(join(dir, 'config.mjs')))).STATS, false);
    const rows = JSON.parse(readFileSync(out));
    assert.deepEqual(rows.map(r => r.id), questions.map(q => q.id));
    assert(checkpoint && highWater === 2 && active === 0, JSON.stringify({checkpoint, highWater, active, logs, rows}));
    assert.deepEqual(Object.keys(rows[0]).sort(), ['id', 'text', 'usedIds', 'rounds', 'queries', 'haikuCalls', 'inputTokens', 'outputTokens', 'jevEstimatedTokens', 'path', 'ms'].sort());
    assert(rows[0].text.includes('[drawCircle]('));
    assert(!rows[0].text.includes('@@USED'));
    assert.deepEqual(rows[0].usedIds, ['symbol:drawCircle']);
    assert.equal(rows[0].inputTokens, 101); assert.equal(rows[0].outputTokens, 17);
    assert.equal(rows[0].haikuCalls, 1); assert.equal(rows[0].rounds, 1); assert.equal(rows[0].queries, 1);
    assert.equal(rows[0].path, 'jev'); assert(rows[0].jevEstimatedTokens > 0); assert(rows[0].ms >= 0);
    assert.equal(rows[2].error, 'answer failed'); assert.equal(rows[2].text, ''); assert.equal(rows[2].path, null);
    assert.equal(rows[3].rounds, 2); assert.equal(rows[3].haikuCalls, 2); assert.equal(rows[3].queries, 2);
    assert.equal(rows[3].inputTokens, 202); assert.equal(rows[3].outputTokens, 34);
    assert.equal(rows[4].path, 'fallback');
    const serialized = readFileSync(out, 'utf8');
    for (const secret of [...questions.map(q => q.question), 'PRIVATE_SEARCH_QUERY', 'reference is never copied', 'DISCARDED RESEARCH TEXT', 'synthetic-haiku', 'synthetic-jev']) {
        assert(!serialized.includes(secret)); assert(!logs.join('\n').includes(secret));
    }
    assert(logs.includes('answer: question failed'));
    assert(!readdirSync(dir).some(name => name.endsWith('.jsonl') || name.endsWith('.tmp')));
    const count = embeds.length;
    assert.equal(await main([qf, out, '--resume']), 0);
    assert.equal(embeds.length, count); assert.equal(readFileSync(out, 'utf8'), serialized);
    const seeded = join(dir, 'seeded.json');
    const invalidRows = [
        { ...rows[0], question: 'PRIVATE QUESTION', answer: 'PRIVATE REFERENCE', queries: ['PRIVATE QUERY'] },
        { id: 'slow' },
        { ...rows[0], question: 'PRIVATE QUESTION' },
        { ...rows[0], answer: 'PRIVATE REFERENCE' },
        { ...rows[0], queries: ['PRIVATE QUERY'] },
        { ...rows[0], id: 1 },
        { ...rows[0], text: null },
        { ...rows[0], usedIds: [1] },
        { ...rows[0], path: 'other' },
        { ...rows[0], error: 'PRIVATE FAILURE' },
        ...['rounds', 'queries', 'haikuCalls', 'inputTokens', 'outputTokens', 'jevEstimatedTokens', 'ms']
            .map(field => ({ ...rows[0], [field]: '1' })),
        ...Object.keys(rows[0]).map(field => Object.fromEntries(Object.entries(rows[0]).filter(([key]) => key !== field))),
    ];
    for (const row of invalidRows) {
        const seed = JSON.stringify([row]);
        writeFileSync(seeded, seed);
        await assert.rejects(main([qf, seeded, '--resume']), { message: 'answer: invalid resume results' });
        assert.equal(readFileSync(seeded, 'utf8'), seed);
        assert.equal(embeds.length, count);
    }
    const invalidQuestions = join(dir, 'invalid-questions.json');
    for (const id of [1, 1.5, '', '  ', null, true]) {
        writeFileSync(invalidQuestions, JSON.stringify([{ id, question: 'SYNTHETIC QUESTION' }]));
        await assert.rejects(main([invalidQuestions, seeded]), { message: 'answer: ids must be non-empty strings' });
        assert.equal(embeds.length, count);
    }
    inspectCheckpoint = false;
    const subset = join(dir, 'subset.json');
    assert.equal(await main([qf, subset, '--ids', 'fast,slow', '--limit', '1']), 0);
    assert.deepEqual(JSON.parse(readFileSync(subset)).map(r => r.id), ['slow']);
    const before = embeds.length;
    assert.equal(await main([qf, subset, '--ids', 'fast,slow', '--resume']), 0);
    assert.equal(embeds.length, before + 1);
    assert.deepEqual(JSON.parse(readFileSync(subset)).map(r => r.id), ['slow', 'fast']);
    await assert.rejects(main([qf, subset, '--jobs', '0']));
    await assert.rejects(main([qf, qf]));
    await assert.rejects(main([qf, subset, '--ids', 'unknown']));
    assert.equal(readFileSync(qf, 'utf8'), JSON.stringify(questions));
    for (const [input, output, flags, message] of [
        [invalidQuestions, seeded, [], 'answer: ids must be non-empty strings'],
        [qf, seeded, ['--resume'], 'answer: invalid resume results'],
    ]) {
        const stdout = openSync(join(dir, 'stdout'), 'w'), stderr = openSync(join(dir, 'stderr'), 'w');
        let result;
        try { result = spawnSync(process.execPath, ['eval/answers/answer.mjs', input, output, ...flags], {
            stdio: ['ignore', stdout, stderr], env: process.env,
        }); } finally { closeSync(stdout); closeSync(stderr); }
        assert.ifError(result.error);
        assert.equal(result.status, 1);
        assert.equal(readFileSync(join(dir, 'stderr'), 'utf8').trim(), message);
        assert.equal(readFileSync(join(dir, 'stdout'), 'utf8'), '');
    }
    for (const [backend, key, message] of [['ollama', '', 'answer: GEN_BACKEND=anthropic is required'], ['anthropic', '', 'answer: ANTHROPIC_API_KEY is required']]) {
        const stdout = openSync(join(dir, 'stdout'), 'w'), stderr = openSync(join(dir, 'stderr'), 'w');
        let result;
        try { result = spawnSync(process.execPath, ['eval/answers/answer.mjs', qf, out], {
            stdio: ['ignore', stdout, stderr], env: { ...process.env, GEN_BACKEND: backend, ANTHROPIC_API_KEY: key },
        }); } finally { closeSync(stdout); closeSync(stderr); }
        assert.ifError(result.error);
        assert.equal(result.status, 1); assert.equal(readFileSync(join(dir, 'stderr'), 'utf8').trim(), message);
        assert.equal(readFileSync(join(dir, 'stdout'), 'utf8'), '');
    }
    process.env.ANSWER_EVAL_DEBUG = '1';
    const logIndex = logs.length;
    assert.equal(await main([qf, join(dir, 'debug.json'), '--ids', 'error']), 1);
    assert(logs.slice(logIndex).some(line => line.includes('SYNTHETIC_PRIVATE_error')));
    console.log('PASS answer eval fields, privacy, concurrent checkpoints/order, subsets, resume, fallback, errors and preflight');
} finally {
    console.error = savedError; globalThis.fetch = savedFetch;
    for (const name of Object.keys(process.env)) if (!(name in savedEnv)) delete process.env[name];
    Object.assign(process.env, savedEnv);
    rmSync(dir, { recursive: true, force: true });
}
