// Retrieval quality snapshot over a representative question set (en/ja across
// concept / symbol / example / oF-migration). Prints the top-5 chunks per query
// so retrieval quality is eyeball-able at a glance. Fast (no generation).
//   node eval.mjs
import { retrieve } from './rag.mjs';

const QUESTIONS = [
    ['concept/en', 'how do I draw a smooth curve through points?'],
    ['concept/ja', '図形に穴を開けたいときはどうする？'],
    ['symbol/en',  'how do I get the length of a Vec2?'],
    ['symbol/ja',  'ColorをOKLabから作るには？'],
    ['of/ja',      'ofSetColor に相当する TrussC の関数は？'],
    ['of/en',      "what is TrussC's equivalent of ofDrawRectangle?"],
    ['example/ja', 'easyCam のサンプルは何を見せてる？'],
    ['example/en', 'is there an example that uses drawBitmapString?'],
    ['concept/ja', 'Nodeでシーングラフを作るメリットは？'],
    ['concept/en', 'how does hot reload work?'],
    ['symbol/ja',  'マウスの位置を取るには？'],
    ['concept/en', 'how do I load and draw an image?'],
    ['symbol/en',  'how do I play a sound?'],
    ['concept/ja', 'FPSを設定するには？'],
    ['symbol/en',  'how do I rotate the coordinate system?'],
    ['example/ja', 'シェーダーのサンプルある？'],
];

for (const [tag, q] of QUESTIONS) {
    const r = await retrieve(q, 5);
    console.log(`\n[${tag}] ${q}`);
    for (const c of r) console.log(`   ${c.score.toFixed(3)} [${c.source}] ${c.title}`);
}
