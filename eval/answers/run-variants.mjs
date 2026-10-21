// Offline in-process evaluation. This module is never imported by the HTTP server.
import { writeFileSync, renameSync, rmSync, realpathSync, existsSync, statSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const usage = 'Usage: node eval/answers/run-variants.mjs <questions.json> <out.json> --variant base|filler|thinking [--filler 300] [--thinking 1024] [--ids file]';
// Bound (configuration): each questions/ids input is a regular file read through one descriptor, at most 4 MiB before parsing.
const MAX_INPUT_FILE_BYTES = 4 * 1024 * 1024;
// Bound (configuration): mirror server.mjs's 8000 UTF-16 code-unit question limit before retrieval.
const MAX_QUESTION_LENGTH = 8000;

// Existing paths resolve fully (a symlink at the last component included);
// a not-yet-existing output resolves through its parent directory.
function canonicalPath(path) {
    return existsSync(path) ? realpathSync(path) : join(realpathSync(dirname(path)), basename(path));
}
// Reads one regular file through a single descriptor, never more than the limit.
function readInput(path, name) {
    // Reject FIFOs/devices before opening: opening a FIFO blocks until a writer appears.
    let st;
    try { st = statSync(path); }
    catch { throw new Error(`Unable to read ${name} file`); }
    if (!st.isFile()) throw new Error(`${name} file must be a regular file`);
    let fd;
    try { fd = openSync(path, 'r'); }
    catch { throw new Error(`Unable to read ${name} file`); }
    try {
        if (!fstatSync(fd).isFile()) throw new Error(`${name} file must be a regular file`);
        const buffer = Buffer.alloc(MAX_INPUT_FILE_BYTES + 1);
        let length = 0, n;
        while (length < buffer.length && (n = readSync(fd, buffer, length, buffer.length - length, null)) > 0) length += n;
        if (length > MAX_INPUT_FILE_BYTES) throw new Error(`${name} file exceeds 4 MiB limit`);
        return buffer.toString('utf8', 0, length);
    } catch (error) {
        throw error.message?.startsWith(name) ? error : new Error(`Unable to read ${name} file`);
    } finally { closeSync(fd); }
}
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
    let outputPath, inputPaths;
    try {
        outputPath = canonicalPath(config.outputPath);
        inputPaths = [config.questionsPath, config.idsPath].filter(Boolean).map(canonicalPath);
    } catch { throw new Error('Unable to resolve input/output paths'); }
    if (inputPaths.includes(outputPath)) throw new Error('Output path must differ from questions and ids paths');
    const questionsJSON = readInput(config.questionsPath, 'Questions');
    let questions;
    try { questions = JSON.parse(questionsJSON); }
    catch { throw new Error('Unable to read questions JSON'); }
    const validId = id => (typeof id === 'string' && id.trim().length > 0) || (typeof id === 'number' && Number.isFinite(id));
    if (!Array.isArray(questions) || questions.some(q => !q || !validId(q.id) || typeof q.question !== 'string' || !q.question.trim())
        || new Set(questions.map(q => String(q.id))).size !== questions.length) throw new Error('Questions must be an array of {id, question} with unique string/number ids and nonempty question strings');
    if (config.idsPath) {
        const ids = new Set(readInput(config.idsPath, 'Ids').split(/\r?\n/).map(id => id.trim()).filter(Boolean));
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
    writeResults(outputPath, results);
    let failed = false;
    for (const question of questions) {
        const started = Date.now();
        let result, error;
        try {
            if (question.question.length > MAX_QUESTION_LENGTH) throw new Error('Question exceeds length limit');
            result = await answer(question.question, [], null, [], undefined, config.opts);
        }
        catch (e) { result = e; error = 'answer failed'; failed = true; }
        results.push({ id: question.id, variant: config.variant, answer: error ? '' : result.text,
            rounds: result?.rounds ?? 0, haikuCalls: result?.haikuCalls ?? 0,
            inputTokensPerCall: result?.inputTokensPerCall ?? [],
            inputTokens: result?.inputTokens ?? null, outputTokens: result?.outputTokens ?? null,
            thinkingTokens: result?.thinkingTokens ?? (config.opts.thinkingBudget ? 'included in outputTokens' : 0),
            ms: Date.now() - started, ...(error ? { error } : {}) });
        writeResults(outputPath, results);
    }
    writeResults(outputPath, results);
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
