// CLI: ask a question against the embedded corpus.
//   node ask.mjs "how do I draw a curve?"
//   node ask.mjs "Nodeでシーングラフを作るメリットは？"
// Retrieved chunk titles + scores go to stderr; the streamed answer to stdout.
import { ask } from './rag.mjs';

const question = process.argv.slice(2).join(' ').trim();
if (!question) { console.error('usage: node ask.mjs "<question>"'); process.exit(1); }

const { retrieved, links, stream } = await ask(question);

console.error('— retrieved —');
for (const c of retrieved) console.error(`  ${c.score.toFixed(3)}  [${c.source}] ${c.title}`);
console.error('—\n');

for await (const delta of stream) process.stdout.write(delta);
process.stdout.write('\n');

if (links.length) {
    console.log('\n詳しくは:');
    for (const l of links) console.log(`  ${l.label} → ${l.url}`);
}
