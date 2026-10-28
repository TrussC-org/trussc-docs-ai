// Offline list coverage: only question/card ids and aggregate measurements leave this process.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { EMBEDDED, RELATED_MIX } from '../../config.mjs';
import { buildRelatedList, relatedText } from '../../mcp-core.mjs';

// Bound (cost): default grid tries four offline variants; extra variants run only when explicitly supplied with --grid.
export const DEFAULT_GRID = [
    { counts: { ranked: 16, related: 0, near: 0 } },
    {},
    { counts: { ranked: 4 }, nearPerShown: 3 },
    { counts: { ranked: 8, related: 24, near: 24 }, nearPerShown: 6, total: 24 },
];
export function symbolId(name) {
    return 'symbol:' + name.trim().replace(/^tc::/, '').replace(/\(.*$/, '').trim();
}
export function coverage(questions, dump, corpus, grid = DEFAULT_GRID) {
    const byId = new Map(corpus.map(c => [c.id, c]));
    const byQuestion = new Map(questions.map(q => [q.id, q]));
    if (!Array.isArray(grid) || !grid.length || !Array.isArray(dump) ||
        new Set(dump.map(r => r.id)).size !== dump.length) throw new Error('coverage: invalid input');
    return grid.map(variant => {
        const mix = { ...RELATED_MIX, ...variant, counts: { ...RELATED_MIX.counts, ...variant.counts } };
        // Validate even an empty dump's configuration with the actual builder.
        buildRelatedList({ mix });
        const totals = { shown: 0, list: 0, nowhere: 0, unmatched: 0, bySource: { ranked: 0, related: 0, near: 0 } };
        const bytes = [], rows = [];
        let failed = 0;
        for (const row of dump) {
            const q = byQuestion.get(row.id);
            if (!q || !Array.isArray(row.shown) || !Array.isArray(row.ranked)) throw new Error('coverage: invalid dump');
            if (row.error) { failed++; continue; }
            const gold = new Set((q.symbols || []).map(symbolId));
            const unmatched = [...gold].filter(id => !byId.has(id)).length;
            for (const id of gold) if (!byId.has(id)) gold.delete(id);
            const list = buildRelatedList({ shown: row.shown, ranked: row.ranked, corpus: byId, mix });
            const shown = new Set(row.shown), listById = new Map(list.map(c => [c.id, c.source]));
            const result = { id: row.id, shown: [], list: [], nowhere: [], unmatched, bySource: { ranked: [], related: [], near: [] } };
            for (const id of gold) {
                if (shown.has(id)) result.shown.push(id);
                else if (listById.has(id)) { result.list.push(id); result.bySource[listById.get(id)].push(id); }
                else result.nowhere.push(id);
            }
            for (const field of ['shown', 'list', 'nowhere']) totals[field] += result[field].length;
            totals.unmatched += unmatched;
            for (const source of ['ranked', 'related', 'near']) totals.bySource[source] += result.bySource[source].length;
            bytes.push(Buffer.byteLength(relatedText(list)));
            rows.push(result);
        }
        const sorted = bytes.slice().sort((a, b) => a - b);
        return { mix, questions: rows.length, failed, totals,
            meanBytes: bytes.length ? bytes.reduce((a, b) => a + b, 0) / bytes.length : 0,
            p90Bytes: sorted.length ? sorted[Math.ceil(sorted.length * .9) - 1] : 0, rows };
    });
}
export function main(args = process.argv.slice(2)) {
    const usage = 'Usage: node eval/related/coverage.mjs <questions.json> <dump.json> [--grid JSON] [--corpus corpus.json]';
    if (args.length < 2 || args[0].startsWith('--') || args[1].startsWith('--')) throw new Error(usage);
    let grid = DEFAULT_GRID, corpusPath = EMBEDDED;
    const seen = new Set();
    for (let i = 2; i < args.length; i++) {
        const opt = args[i];
        if (seen.has(opt) || !['--grid', '--corpus'].includes(opt) || args[i + 1] === undefined) throw new Error(usage);
        seen.add(opt);
        if (opt === '--grid') grid = JSON.parse(args[++i]); else corpusPath = args[++i];
    }
    const questions = JSON.parse(readFileSync(args[0], 'utf8'));
    if (!Array.isArray(questions) || questions.some(q => typeof q?.id !== 'string' || !q.id.trim() ||
        (q.symbols !== undefined && (!Array.isArray(q.symbols) || q.symbols.some(s => typeof s !== 'string')))) ||
        new Set(questions.map(q => q.id)).size !== questions.length) throw new Error('coverage: invalid questions');
    const report = coverage(questions, JSON.parse(readFileSync(args[1], 'utf8')), JSON.parse(readFileSync(corpusPath, 'utf8')), grid);
    console.log(JSON.stringify(report, null, 2));
    return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try { main(); } catch { console.error('coverage: failed (check arguments and input schemas)'); process.exitCode = 1; }
}
