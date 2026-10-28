// Evaluate the real chat stream. Inputs and credentials stay outside the repo.
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync, realpathSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const usage = 'Usage: node eval/answers/answer.mjs <questions.json> <out.json> [--jobs 3] [--limit N] [--ids a,b,c] [--resume]';
const validId = id => typeof id === 'string' && id.trim() !== '';
const invalidId = 'answer: ids must be non-empty strings';
const numericFields = ['rounds', 'queries', 'haikuCalls', 'inputTokens', 'outputTokens', 'jevEstimatedTokens', 'ms'];
const requiredFields = ['id', 'text', 'usedIds', ...numericFields, 'path'];
function validRow(row) {
    return row !== null && typeof row === 'object' && !Array.isArray(row) &&
        requiredFields.every(field => Object.hasOwn(row, field)) &&
        Object.keys(row).every(field => requiredFields.includes(field) || field === 'error') &&
        validId(row.id) && typeof row.text === 'string' &&
        Array.isArray(row.usedIds) && row.usedIds.every(id => typeof id === 'string') &&
        numericFields.every(field => row[field] === null || (typeof row[field] === 'number' && Number.isFinite(row[field]))) &&
        ['jev', 'fallback', null].includes(row.path) &&
        (!Object.hasOwn(row, 'error') || row.error === 'answer failed');
}
function parseArgs(args) {
    if (args.length < 2 || args[0].startsWith('--') || args[1].startsWith('--')) throw new Error(usage);
    const options = {};
    for (let i = 2; i < args.length; i++) {
        const name = args[i];
        if (name in options) throw new Error(usage);
        if (name === '--resume') { options[name] = true; continue; }
        if (!['--jobs', '--limit', '--ids'].includes(name) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(usage);
        options[name] = args[++i];
    }
    for (const name of ['--jobs', '--limit']) {
        // Bound (configuration): accept positive safe integers only; invalid concurrency/subset sizes fail before calls.
        if (name in options && (!/^\d+$/.test(options[name]) || !Number.isSafeInteger(Number(options[name])) || Number(options[name]) < 1)) throw new Error(usage);
    }
    return { questions: args[0], out: args[1], jobs: Number(options['--jobs'] ?? 3),
        limit: options['--limit'] === undefined ? undefined : Number(options['--limit']),
        ids: options['--ids']?.split(','), resume: options['--resume'] === true };
}
function canonical(path) {
    return existsSync(path) ? realpathSync(path) : join(realpathSync(dirname(path)), basename(path));
}
function writeResults(path, rows) {
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
        writeFileSync(temporary, JSON.stringify(rows, null, 2) + '\n', { flag: 'wx' });
        renameSync(temporary, path);
    } finally { rmSync(temporary, { force: true }); }
}
function tokenSum(result, total, traceField) {
    if (typeof result?.[total] === 'number') return result[total];
    const values = (result?.traces ?? []).map(t => t.haiku?.[traceField]).filter(n => typeof n === 'number');
    return values.length ? values.reduce((a, b) => a + b, 0) : null;
}
function rowFor(id, result, ms, error) {
    return { id, text: error ? '' : result.text, usedIds: error ? [] : result.usedIds ?? [],
        rounds: result?.rounds ?? 0, queries: result?.queries?.length ?? 0,
        haikuCalls: result?.haikuCalls ?? 0,
        inputTokens: tokenSum(result, 'inputTokens', 'inputTokensTotal'),
        outputTokens: tokenSum(result, 'outputTokens', 'outputTokens'),
        jevEstimatedTokens: result?.jevEstimatedTokens ?? null,
        path: ['jev', 'fallback'].includes(result?.path) ? result.path : null, ms, ...(error ? { error } : {}) };
}
function reportError(error, message) {
    console.error(message);
    if (process.env.ANSWER_EVAL_DEBUG === '1') console.error(error?.stack ?? error);
}

export async function main(args = process.argv.slice(2)) {
    // Set before importing rag/config, even if STATS=1 was inherited from the shell.
    process.env.STATS = '0';
    if (process.env.GEN_BACKEND !== 'anthropic') throw new Error('answer: GEN_BACKEND=anthropic is required');
    if (!process.env.ANTHROPIC_API_KEY?.trim()) throw new Error('answer: ANTHROPIC_API_KEY is required');
    const config = parseArgs(args);
    const out = canonical(config.out);
    if (out === canonical(config.questions)) throw new Error('Output must differ from questions');
    let questions = JSON.parse(readFileSync(config.questions, 'utf8'));
    if (Array.isArray(questions) && questions.some(q => !validId(q?.id))) throw new Error(invalidId);
    if (!Array.isArray(questions) || questions.some(q => !q || !validId(q.id) || typeof q.question !== 'string' || !q.question.trim()) ||
        new Set(questions.map(q => String(q.id))).size !== questions.length) throw new Error('Invalid questions');
    if (config.ids) {
        if (config.ids.some(id => !questions.some(q => String(q.id) === id))) throw new Error('Unknown id');
        const ids = new Set(config.ids);
        questions = questions.filter(q => ids.has(String(q.id)));
    }
    // Bound (cost): --limit selects the first N filtered questions; overflow questions are not run or written.
    if (config.limit !== undefined) questions = questions.slice(0, config.limit);
    const previous = config.resume && existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : [];
    if (!Array.isArray(previous) || previous.some(r => !validRow(r)) ||
        new Set(previous.map(r => String(r.id))).size !== previous.length) throw new Error('answer: invalid resume results');
    const done = new Set(previous.map(r => String(r.id)));
    questions = questions.filter(q => !done.has(String(q.id)));
    const { answerStream } = await import('../../rag.mjs');
    const completed = new Array(questions.length);
    const rows = () => [...previous, ...completed.filter(Boolean)];
    writeResults(out, rows());
    let next = 0, failed = false;
    async function worker() {
        while (next < questions.length) {
            const index = next++, q = questions[index], started = Date.now();
            let final, result, error;
            try {
                for await (const event of answerStream(q.question)) {
                    if (event.type === 'final') final = event;
                }
                if (!final || typeof final.text !== 'string') throw new Error('Missing final event');
                result = final;
            } catch (e) {
                result = e; error = 'answer failed'; failed = true;
                reportError(e, 'answer: question failed');
            }
            // Whitelist fields: traces contain original questions and search strings.
            const row = rowFor(q.id, result, Date.now() - started, error);
            if (!validRow(row)) throw new Error('answer: invalid result');
            completed[index] = row;
            writeResults(out, rows());
        }
    }
    // Bound (cost): --jobs questions in flight; remaining questions queue in input order.
    await Promise.all(Array.from({ length: Math.min(config.jobs, questions.length) }, () => worker()));
    console.error(`answer: completed ${questions.length}, failed ${completed.filter(r => r.error).length}, retained ${previous.length}`);
    return failed ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().then(code => { process.exitCode = code; }).catch(error => {
        const missing = ['answer: GEN_BACKEND=anthropic is required', 'answer: ANTHROPIC_API_KEY is required',
            invalidId, 'answer: invalid resume results', 'answer: invalid result'];
        reportError(error, missing.includes(error.message) ? error.message : 'answer: failed (set ANSWER_EVAL_DEBUG=1 for details; they may quote questions)');
        process.exitCode = 1;
    });
}
