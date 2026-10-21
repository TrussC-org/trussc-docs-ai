// Offline in-process evaluation. This module is never imported by the HTTP server.
import { readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const usage = 'Usage: node eval/answers/run-variants.mjs <questions.json> <out.json> --variant base|filler|thinking [--filler 300] [--thinking 1024] [--ids file]';
function argumentsFor(args) {
    if (args.length < 4 || args[0].startsWith('--') || args[1].startsWith('--')) throw new Error(usage);
    const options = {};
    for (let i = 2; i < args.length; i += 2) {
        const name = args[i], value = args[i + 1];
        if (!['--variant', '--filler', '--thinking', '--ids'].includes(name) || !value || value.startsWith('--') || name in options) throw new Error(usage);
        options[name] = value;
    }
    const variant = options['--variant'];
    if (!['base', 'filler', 'thinking'].includes(variant)) throw new Error(usage);
    for (const name of ['--filler', '--thinking']) {
        if (name in options && !/^\d+$/.test(options[name])) throw new Error('Variant token values must be non-negative integers');
    }
    const filler = Number(options['--filler'] ?? 300), thinking = Number(options['--thinking'] ?? 1024);
    // Bound (configuration): the runner accepts at most 4096 filler periods, matching the core; invalid values fail before any calls.
    if (!Number.isSafeInteger(filler) || filler > 4096) throw new Error('--filler must be within 0..4096');
    // Bound (configuration): the runner accepts thinking 0 (off) or 1024..16384 tokens, matching the core; invalid values fail before any calls.
    if (!Number.isSafeInteger(thinking) || thinking > 16384 || (thinking > 0 && thinking < 1024)) throw new Error('--thinking must be 0 or within 1024..16384');
    const paths = [args[0], args[1], options['--ids']].filter(Boolean).map(p => resolve(p));
    if (new Set(paths).size !== paths.length) throw new Error('Questions, output and ids paths must be different');
    return { questionsPath: args[0], outputPath: args[1], idsPath: options['--ids'], variant,
        opts: { fillerTokens: variant === 'filler' ? filler : 0, thinkingBudget: variant === 'thinking' ? thinking : 0 } };
}
function writeResults(path, results) {
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
        writeFileSync(temporary, JSON.stringify(results, null, 2) + '\n', { flag: 'wx' });
        renameSync(temporary, path);
    } finally { rmSync(temporary, { force: true }); }
}
export async function main(args = process.argv.slice(2)) {
    const config = argumentsFor(args);
    for (const name of ['ANTHROPIC_API_KEY', 'TYPESAFE_API_KEY']) {
        if (!process.env[name]?.trim()) throw new Error(`Missing required environment variable: ${name}`);
    }
    let questions;
    try { questions = JSON.parse(readFileSync(config.questionsPath, 'utf8')); }
    catch { throw new Error('Unable to read questions JSON'); }
    const validId = id => (typeof id === 'string' && id.trim().length > 0) || (typeof id === 'number' && Number.isFinite(id));
    if (!Array.isArray(questions) || questions.some(q => !q || !validId(q.id) || typeof q.question !== 'string' || !q.question.trim())
        || new Set(questions.map(q => String(q.id))).size !== questions.length) throw new Error('Questions must be an array of {id, question} with unique string/number ids and nonempty question strings');
    if (config.idsPath) {
        let ids;
        try { ids = new Set(readFileSync(config.idsPath, 'utf8').split(/\r?\n/).map(id => id.trim()).filter(Boolean)); }
        catch { throw new Error('Unable to read ids file'); }
        if ([...ids].some(id => !questions.some(q => String(q.id) === id))) throw new Error('Ids file contains an unknown question id');
        questions = questions.filter(q => ids.has(String(q.id)));
    }
    // Set before importing config/rag; the standalone runner uses the hosted
    // two-stage path and must never produce stats.jsonl, even with STATS=1 inherited.
    process.env.STATS = '0';
    process.env.GEN_BACKEND = 'anthropic';
    process.env.RETRIEVAL = 'jev';
    let answer;
    try { ({ answer } = await import('../../rag.mjs')); }
    catch { throw new Error('Unable to load answer pipeline'); }
    const results = [];
    writeResults(config.outputPath, results);
    let failed = false;
    for (const question of questions) {
        const started = Date.now();
        let result, error;
        try { result = await answer(question.question, [], null, [], undefined, config.opts); }
        catch (e) { result = e; error = 'answer failed'; failed = true; }
        results.push({ id: question.id, variant: config.variant, answer: error ? '' : result.text,
            rounds: result?.rounds ?? 0, haikuCalls: result?.haikuCalls ?? 0,
            inputTokens: result?.inputTokens ?? null, outputTokens: result?.outputTokens ?? null,
            thinkingTokens: result?.thinkingTokens ?? (config.opts.thinkingBudget ? 'included in outputTokens' : 0),
            ms: Date.now() - started, ...(error ? { error } : {}) });
        writeResults(config.outputPath, results);
    }
    writeResults(config.outputPath, results);
    return failed ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().then(code => { process.exitCode = code; }).catch(error => {
        // Only validation errors above carry operator-facing detail. Filesystem
        // exceptions may contain arbitrary paths, so never print their raw text.
        console.error(error.code ? 'Unable to write variant results' : error.message);
        process.exitCode = 1;
    });
}
