// trussc_search output: the tool description and per-result score line stay caller-facing.
import assert from 'node:assert/strict';
import { TOOLS, formatResults } from './mcp-core.mjs';

const search = TOOLS.find(tool => tool.name === 'trussc_search');
for (const internal of ['BM25', 'RRF', 'bge-m3', 'cross-encoder', 'reranker', 'Jev']) {
    assert(!search.description.includes(internal), `description leaks retrieval internals: ${internal}`);
}
for (const guidance of ['full:true', 'trussc_get', 'lang:"lua"', 'TAU not PI']) {
    assert(search.description.includes(guidance), `description keeps usage guidance: ${guidance}`);
}
const withP = formatResults([{ source: 'api', title: 'drawCircle', p: 0.873, rrf: 0.0123, score: 0.51, rerank: 0.9, text: 'body' }], 'circle');
assert(withP.includes('(relevance 0.87)'));
for (const internal of ['rrf', 'cos ', 'rr ']) assert(!withP.includes(internal), `score line leaks ${internal}`);
const fallback = formatResults([{ source: 'api', title: 'drawCircle', rrf: 0.0123, score: 0.51, text: 'body' }], 'circle');
assert(!fallback.includes('(') || !/\((cos|rrf|rr|relevance)/.test(fallback), 'fallback results show no internal score');
console.log('MCP format tests passed');
