// Record the real in-process MCP search path; never persist questions or card text.
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync, realpathSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const usage = 'Usage: node eval/related/dump.mjs <questions.json> <out.json> [--jobs 3] [--resume]';
const validId = id => typeof id === 'string' && id.trim() !== '';
function validRow(row) {
    return row && Object.keys(row).every(k => ['id', 'shown', 'ranked', 'path', 'error'].includes(k)) &&
        validId(row.id) && ['shown', 'ranked'].every(k => Array.isArray(row[k]) && row[k].every(validId)) &&
        row.ranked.length <= 40 && (Object.hasOwn(row, 'error')
            ? row.error === 'search failed' && row.path === null && row.shown.length === 0 && row.ranked.length === 0
            : ['jev', 'fallback'].includes(row.path));
}
function canonical(path) {
    return existsSync(path) ? realpathSync(path) : join(realpathSync(dirname(path)), basename(path));
}
function save(path, rows) {
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
        writeFileSync(temporary, JSON.stringify(rows, null, 2) + '\n', { flag: 'wx' });
        renameSync(temporary, path);
    } finally { rmSync(temporary, { force: true }); }
}
export async function main(args = process.argv.slice(2)) {
    process.env.STATS = '0'; // Must precede config/rag imports, including mcp-core's config.
    if (args.length < 2 || args[0].startsWith('--') || args[1].startsWith('--')) throw new Error(usage);
    let jobs = 3, resume = false;
    const seenOptions = new Set();
    for (let i = 2; i < args.length; i++) {
        const option = args[i];
        if (seenOptions.has(option)) throw new Error(usage);
        seenOptions.add(option);
        if (option === '--resume') resume = true;
        else if (option === '--jobs') {
            // Bound (cost): only positive safe integer job counts are accepted; invalid concurrency fails before search.
            const raw = args[++i];
            if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1) throw new Error(usage);
            jobs = Number(raw);
        } else throw new Error(usage);
    }
    const out = canonical(args[1]);
    if (out === canonical(args[0])) throw new Error('dump: output must differ from questions');
    const questions = JSON.parse(readFileSync(args[0], 'utf8'));
    if (!Array.isArray(questions) || questions.some(q => !validId(q?.id) || typeof q.question !== 'string' || !q.question.trim()) ||
        new Set(questions.map(q => q.id)).size !== questions.length) throw new Error('dump: invalid questions');
    const previous = resume && existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : [];
    if (!Array.isArray(previous) || previous.some(r => !validRow(r)) || new Set(previous.map(r => r.id)).size !== previous.length)
        throw new Error('dump: invalid resume results');
    const done = new Set(previous.map(r => r.id)), pending = questions.filter(q => !done.has(q.id));
    // Upstream warning messages can quote queries. The eval prints only a fixed diagnostic.
    const originalWarn = console.warn;
    console.warn = () => originalWarn('dump: retrieval warning');
    try {
        const { retrieve, retrievalInfo, leanText, refLink } = await import('../../rag.mjs');
        const { dispatch, searchResponse } = await import('../../mcp-core.mjs');
        const completed = new Array(pending.length);
        const rows = () => [...previous, ...completed.filter(Boolean)];
        save(out, rows());
        let next = 0;
        async function worker() {
            while (next < pending.length) {
                const index = next++, q = pending[index];
                let row;
                try {
                    const response = await dispatch({ id: 1, method: 'tools/call', params: {
                        name: 'trussc_search', arguments: { query: q.question } } }, {
                        search: async (query, k, full, lang) => {
                            const retrieved = await retrieve(query, k, { lang });
                            // Bound (output): record the first 40 ranked ids, matching the retrieval metadata budget; overflow ids are omitted.
                            row = { id: q.id, shown: retrieved.slice(0, k).map(c => c.id),
                                ranked: retrieved.rankedIds.slice(0, 40), path: retrievalInfo(retrieved).path };
                            return searchResponse(retrieved, retrieved.slice(0, k).map(c => ({ ...c, text: full ? c.text : leanText(c), link: refLink(c) })));
                        },
                    });
                    if (response?.result?.isError || !validRow(row)) throw new Error('search failed');
                } catch {
                    row = { id: q.id, shown: [], ranked: [], path: null, error: 'search failed' };
                    console.error('dump: search failed');
                }
                completed[index] = row;
                save(out, rows());
            }
        }
        // Bound (cost): run at most --jobs searches in flight; remaining ids queue in input order.
        await Promise.all(Array.from({ length: Math.min(jobs, pending.length) }, () => worker()));
        const failed = rows().filter(r => r.error).length;
        console.error(`dump: completed ${pending.length}, failed ${failed}, retained ${previous.length}`);
        return failed ? 1 : 0;
    } finally { console.warn = originalWarn; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().then(code => { process.exitCode = code; }).catch(() => {
        console.error('dump: failed (check arguments, inputs and output path)'); process.exitCode = 1;
    });
}
