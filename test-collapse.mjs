// Run with node test-collapse.mjs; no corpus or services needed.
import assert from 'node:assert/strict';
import { collapseInherited } from './rag.mjs';
const base = { id: 'symbol:Node::getGlobalPos', text: 'full card', meta: { kind: 'method', owner: 'Node' } };
const stub = (owner) => ({ id: `symbol:${owner}::getGlobalPos`, text: 'stub', meta: { kind: 'method', owner, inherited: 'Node', base: 'Node::getGlobalPos' }, score: 0.9, rrf: 0.03 });
const other = { id: 'symbol:Node::moveToBack', text: 'other', meta: {} };
const byId = (id) => (id === base.id ? base : null);
// A stub first: the base card takes its place; later stubs and the base itself drop out.
let out = collapseInherited([stub('RectNode'), other, stub('App'), base, stub('ScrollBar')], byId);
assert.deepEqual(out.map((c) => c.id), ['symbol:Node::getGlobalPos', 'symbol:Node::moveToBack']);
assert.equal(out[0].text, 'full card');
assert.equal(out[0].rrf, 0.03);
// The base first: stubs after it drop out.
out = collapseInherited([base, stub('RectNode')], byId);
assert.deepEqual(out.map((c) => c.id), ['symbol:Node::getGlobalPos']);
// A stub whose base card is missing stays as it is.
out = collapseInherited([stub('RectNode')], () => null);
assert.deepEqual(out.map((c) => c.id), ['symbol:RectNode::getGlobalPos']);
console.log('PASS collapseInherited: 6 assertions');
