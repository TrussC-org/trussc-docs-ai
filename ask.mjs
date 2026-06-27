// CLI: ask a question against the embedded corpus.
//   node ask.mjs "how do I draw a curve?"
//   node ask.mjs "Nodeでシーングラフを作るメリットは？"
// Retrieval + (corrected?) note go to stderr; the answer + links to stdout.
import { answer } from './rag.mjs';

const question = process.argv.slice(2).join(' ').trim();
if (!question) { console.error('usage: node ask.mjs "<question>"'); process.exit(1); }

const { retrieved, links, text, corrected } = await answer(question);

console.error('— retrieved —');
for (const c of retrieved) console.error(`  ${c.score.toFixed(3)}  [${c.source}] ${c.title}`);
if (corrected) console.error('  (verify: fabricated API detected → corrective pass ran)');
console.error('—\n');

process.stdout.write(text + '\n');

if (links.length) {
    console.log('\n詳しくは:');
    for (const l of links) console.log(`  ${l.label} → ${l.url}`);
}
