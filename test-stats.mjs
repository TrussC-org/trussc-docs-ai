// Offline stats/rotation/report regressions. In-memory HTTP and temp files only.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync, readdirSync, openSync, closeSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { EventEmitter, once } from 'node:events';
import { spawnSync, spawn } from 'node:child_process';

const dir = mkdtempSync(join(tmpdir(), 'docsai-stats-'));
const savedEnv = { ...process.env };
let holder;
try {
    const live = join(dir, 'stats.jsonl'), archive = join(dir, 'archive with spaces');
    Object.assign(process.env, { STATS: '1', STATS_LOG: live, STATS_SALT: 'synthetic-test-salt', RATE_MAX: '1000' });
    for (const file of ['stats.mjs', 'config.mjs', 'server.mjs', 'mcp-core.mjs', 'debug.mjs']) {
        writeFileSync(join(dir, file), readFileSync(new URL(file, import.meta.url)));
    }
    writeFileSync(join(dir, 'rag.mjs'), `
export const chunks = () => [];
export const refLink = () => 'https://example.invalid/ref';
export const leanText = c => c.text;
const fail = () => { throw Object.assign(new Error('stub failure'), {
    errorReason: 'generation', errorClass: 'StubFailure', haikuCalls: 1, rounds: 1,
    path: 'fallback', reason: 'stub', inputTokens: 7, outputTokens: 3,
}); };
export const getByIds = ids => ids.includes('fail') ? fail() : [{ id:'one', title:'One', text:'full', source:'reference' }];
export const retrievalInfo = retrieved => retrieved.retrieval;
export const retrieve = async query => {
    if (query === 'fail') fail();
    const retrieved = getByIds([]);
    retrieved.retrieval = {path:'jev', reason:null, jevTokens:12, jevEstimatedTokens:15};
    return retrieved;
};
export const answer = async query => ({ text:'A'.repeat(4005), retrieved:await retrieve(query), links:[],
    rounds:2, haikuCalls:2, inputTokens:22, outputTokens:11, thinkingTokens:'included in outputTokens',
    path:'jev', reason:null, retrievals:[{jevTokens:12}, {jevTokens:14}], corrected:false });
export async function* answerStream(query) {
    const result = await answer(query);
    yield {type:'meta', retrieved:result.retrieved, links:[]};
    yield {type:'delta', text:'old'};
    yield {type:'replace', text:result.text};
    yield {type:'final', ...result};
}
`);
    const { clientName, queryLanguage, pipelineStat, logStat, hashIp } = await import(pathToFileURL(join(dir, 'stats.mjs')));
    for (const [ua, expected] of [
        [undefined, 'unknown'], ['', 'unknown'], ['  ', 'unknown'],
        ['Claude-Code/1.2.3 (linux)', 'claude'], ['Claude-Desktop/2.0', 'claude'],
        ['Cursor/0.50', 'cursor'], ['Codex/1.0', 'codex'], ['curl/8.5', 'curl'],
        ['MCP-Inspector-1.2.3', 'inspector'], ['python-httpx/0.27', 'python-httpx'],
        ['TrussC-MCP-Stdio/0.1.0', 'trussc-mcp-stdio'],
        ['A'.repeat(32) + '/1.2', 'a'.repeat(32)], ['a'.repeat(33) + '/1.2', 'other'],
        ['bad!name/1', 'other'], ['日本語/1', 'other'], ['/1', 'other'], ['__proto__/1', '__proto__'],
    ]) {
        const token = clientName(ua); assert.equal(token, expected, String(ua));
        assert.match(token, /^[a-z0-9._-]{1,32}$/);
    }
    for (const [q, lang] of [['円を描く', 'ja'], ['カメラ', 'ja'], ['원을 그리기', 'ko'], ['画圆', 'zh'], ['draw circle', 'en'], ['123 😀', 'other'], ['', 'other']]) {
        assert.equal(queryLanguage(q), lang, q);
    }
    assert.deepEqual(pipelineStat({ haikuCalls:1, inputTokens:5, outputTokens:6, thinkingTokens:2 }).haiku, {in:5,out:6,thinking:2});
    assert.equal(pipelineStat({ haikuCalls:1, thinkingTokens:'included in outputTokens' }).haiku.thinking, null);
    assert.equal(pipelineStat({ retrievals:[{jevTokens:1}, {jevTokens:2}] }).jevTokens, 3);
    assert.equal(pipelineStat({}).jevTokens, null);
    const { server } = await import(pathToFileURL(join(dir, 'server.mjs')));
    const rows = () => existsSync(live) ? readFileSync(live, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    async function request(path, body, headers = {}) {
        const before = rows().length;
        const response = await new Promise(resolve => {
            const req = new PassThrough();
            Object.assign(req, { method:'POST', url:path, headers, socket:{remoteAddress:'192.0.2.10'} });
            const res = new EventEmitter();
            Object.assign(res, { data:'', setHeader() {}, writeHead(status) { this.status = status; },
                write(data) { this.data += data; return true; }, end(data = '') { this.data += data; resolve(this); } });
            server.emit('request', req, res); req.end(JSON.stringify(body));
        });
        const all = rows(); assert.equal(all.length, before + 1, path + ' writes exactly one line');
        const row = all.at(-1);
        for (const field of ['ts','ep','tool','client','ms','path','fallbackReason','rounds','haikuCalls','haiku','jevTokens','qLen','qLang','ip','errorReason','errorClass']) {
            assert(Object.hasOwn(row, field), `${path}: missing ${field}`);
        }
        assert(Number.isFinite(Date.parse(row.ts))); assert(row.ms >= 0);
        assert.deepEqual(Object.keys(row.haiku), ['in','out','thinking']);
        assert.equal(row.ip, hashIp('192.0.2.10')); assert.match(row.ip, /^[a-f0-9]{16}$/);
        for (const field of ['ua','ref','headers','qlen']) assert(!Object.hasOwn(row, field));
        return {row, response};
    }
    for (const ep of ['chat','ask','search']) {
        const { row } = await request('/' + ep, { question:'  円を描く 😀  ' }, {origin:'https://trussc.org', 'user-agent':'PRIVATE-RAW/1.2'});
        assert.equal(row.ep, ep); assert.equal(row.tool, null);
        assert.equal(row.client, ep === 'search' ? 'http' : 'widget');
        assert.equal(row.q, '円を描く 😀'); assert.equal(row.qLen, row.q.length); assert.equal(row.qLang, 'ja');
        assert.equal(row.errorReason, null); assert.equal(row.path, 'jev');
        if (ep !== 'search') {
            assert.equal(row.a, 'A'.repeat(4000)); assert.equal(row.rounds, 2);
            assert.deepEqual(row.haiku, {in:22,out:11,thinking:null}); assert.equal(row.jevTokens, 26);
        } else {
            assert(!Object.hasOwn(row, 'a')); assert.equal(row.jevTokens, 12);
        }
        assert(!JSON.stringify(row).includes('PRIVATE-RAW'));
    }
    assert.equal((await request('/ask', {question:'circle', debug:true})).row.client, 'http');
    assert.equal((await request('/chat', {question:'circle', page:'drawCircle'})).row.client, 'widget');
    assert.equal((await request('/ask', {question:'circle'}, {origin:'https://trussc.org.evil.invalid'})).row.client, 'http');
    const {row: get} = await request('/get', {ids:['one']});
    assert.equal(get.ep, 'get'); assert.equal(get.client, 'http');
    assert.equal(get.qLen, null); assert.equal(get.qLang, null); assert(!Object.hasOwn(get, 'q'));
    assert.equal(get.rounds, 0); assert.equal(get.haikuCalls, 0); assert.equal(get.path, null);
    const call = (name, args) => ({jsonrpc:'2.0', id:1, method:'tools/call', params:{name, arguments:args}});
    const {row:init} = await request('/mcp', {id:1, method:'initialize', params:{clientInfo:{name:'Client Name', version:'1.2.3'}}}, {'user-agent':'Cursor/1.1'});
    assert.equal(init.ep, 'mcp'); assert.equal(init.method, 'initialize'); assert.equal(init.client, 'cursor');
    assert.deepEqual(init.clientInfo, {name:'Client Name', version:'1.2.3'}); assert.equal(init.tool, null);
    for (const [tool, args] of [['trussc_search', {query:'circle'}], ['trussc_get', {ids:['one']} ]]) {
        const {row} = await request('/mcp', call(tool,args), {'user-agent':'Claude-Code/1.2.3'});
        assert.equal(row.ep, 'mcp'); assert.equal(row.tool, tool); assert.equal(row.client, 'claude');
        assert(!Object.hasOwn(row, 'clientInfo'), 'initialize never contaminates later stateless calls');
        assert.equal(row.qLen, tool === 'trussc_search' ? 6 : null);
        if (tool === 'trussc_search') assert.equal(row.q, 'circle');
        const {row:unknown} = await request('/mcp', call(tool,args)); assert.equal(unknown.client, 'unknown');
        const {row:failure} = await request('/mcp', call(tool,tool === 'trussc_search' ? {query:'fail'} : {ids:['fail']}));
        assert.equal(failure.errorReason, 'generation'); assert.equal(failure.errorClass, 'StubFailure');
        assert.equal(failure.tool, tool); assert.equal(failure.path, 'fallback');
        assert.deepEqual(failure.haiku, {in:7,out:3,thinking:null});
        assert(!Object.hasOwn(failure, 'q'));
        assert.equal(failure.qLen, tool === 'trussc_search' ? 4 : null);
        assert.equal(failure.qLang, tool === 'trussc_search' ? 'en' : null);
    }
    for (const [ep, body] of [['chat',{question:'fail'}], ['ask',{question:'fail'}], ['search',{question:'fail'}], ['get',{ids:['fail']}]]) {
        const {row} = await request('/' + ep, body);
        assert.equal(row.errorClass, 'StubFailure'); assert.equal(row.errorReason, 'generation'); assert.equal(row.ep, ep);
    }
    for (const ep of ['ask','chat','search']) {
        assert.equal((await request('/'+ep, {question:''})).row.errorReason, 'input');
        const {row:oversize} = await request('/'+ep, {question:'x'.repeat(8001)});
        assert.equal(oversize.errorReason, 'input-fields'); assert.equal(oversize.qLen,8001); assert.equal(oversize.qLang,'en');
        assert(!Object.hasOwn(oversize,'q'),'validation retains metadata without adding query text');
    }
    for (const [tool,args] of [['trussc_search',{}], ['trussc_get',{}]]) {
        const {row} = await request('/mcp', call(tool,args)); assert.equal(row.tool, tool); assert.equal(row.errorReason, 'mcp');
    }
    const {row:malformed} = await request('/mcp',call('trussc_search',{query:{toString:{}}}));
    assert.equal(malformed.errorReason,'mcp'); assert.equal(malformed.qLen,null);
    // Execute the real stdio entry point against the same in-memory request handler.
    // Fetch is stubbed; requests and their supplied UA are replayed through HTTP.
    const input = join(dir, 'input'), output = join(dir, 'stdio.out'), error = join(dir, 'stdio.err');
    const captured = join(dir, 'proxy-requests.jsonl'), preload = join(dir, 'preload.mjs');
    writeFileSync(input, [call('trussc_search',{query:'proxy circle'}),call('trussc_get',{ids:['one']})].map(JSON.stringify).join('\n')+'\n');
    writeFileSync(preload, `import {appendFileSync} from 'node:fs'; globalThis.fetch = async (url, opts) => {
        appendFileSync(${JSON.stringify(captured)}, JSON.stringify({path:new URL(url).pathname,body:JSON.parse(opts.body),headers:opts.headers})+'\\n');
        return Response.json({results:[]});
    };`);
    const fds = [openSync(input,'r'),openSync(output,'w'),openSync(error,'w')];
    let child;
    try { child = spawnSync(process.execPath, ['--import',preload,fileURLToPath(new URL('./mcp.mjs',import.meta.url))], {stdio:fds}); }
    finally { fds.forEach(closeSync); }
    assert.equal(child.status, 0, readFileSync(error,'utf8'));
    for (const proxy of readFileSync(captured,'utf8').trim().split('\n').map(JSON.parse)) {
        const {row} = await request(proxy.path,proxy.body,proxy.headers);
        assert.equal(row.ep,'mcp'); assert.equal(row.client,'trussc-mcp-stdio');
        assert.equal(row.tool,proxy.path === '/search' ? 'trussc_search' : 'trussc_get');
    }
    // A logging failure cannot affect request completion.
    rmSync(live); mkdirSync(live);
    assert.doesNotThrow(() => logStat({ep:'get'})); rmSync(live,{recursive:true});
    console.log('PASS consistent endpoint/error schema, MCP initialize/tools/stdio, text, client bound, language and usage');

    const rotation = fileURLToPath(new URL('./deploy/rotate-stats.sh',import.meta.url));
    function run(command, args, env = process.env) {
        const out = openSync(join(dir,'cmd.out'),'w'), err = openSync(join(dir,'cmd.err'),'w');
        let result;
        try { result = spawnSync(command,args,{env,stdio:['ignore',out,err]}); }
        finally { closeSync(out); closeSync(err); }
        assert.equal(result.error, undefined);
        return {...result, stdout:readFileSync(join(dir,'cmd.out'),'utf8'), stderr:readFileSync(join(dir,'cmd.err'),'utf8')};
    }
    const rotate = () => run('bash',['-c','umask 0022; exec bash "$@"','rotation-test',rotation,live,archive]);
    const mode = path => statSync(path).mode & 0o777;
    assert.equal(rotate().status,0,'missing live is OK');
    const row = (ep, tool, client, ts) => JSON.stringify({ts,ep,tool,client,ms:10,q:ep});
    const first = row('ask',null,'widget','2025-12-31T23:59:59Z')+'\n';
    const second = row('mcp','trussc_get','claude','2026-01-01T00:00:00Z')+'\n';
    writeFileSync(live,first,{mode:0o600});
    const inode = statSync(live).ino;
    assert.equal(rotate().status,0);
    assert.equal(statSync(live).ino,inode); assert.equal(mode(live),0o600); assert.equal(readFileSync(live,'utf8'),'');
    writeFileSync(live,second); assert.equal(rotate().status,0); assert.equal(readFileSync(live,'utf8'),'');
    const monthFiles = readdirSync(archive).filter(f=>f.endsWith('.jsonl'));
    assert.equal(monthFiles.length,1,'rotation month, not each timestamp month');
    assert.equal(monthFiles[0],new Date().toISOString().slice(0,7)+'.jsonl');
    assert.equal(readFileSync(join(archive,monthFiles[0]),'utf8'),first+second);
    assert.equal(rotate().status,0,'empty file is OK');
    const monthly = join(archive,monthFiles[0]), lock = join(archive,'.rotate.lock');
    assert.equal(mode(archive),0o700); assert.equal(mode(monthly),0o600); assert.equal(mode(lock),0o600);
    chmodSync(archive,0o755); chmodSync(monthly,0o644); chmodSync(lock,0o644);
    assert.equal(rotate().status,0,'empty rotation repairs existing modes');
    assert.equal(mode(archive),0o700); assert.equal(mode(monthly),0o600); assert.equal(mode(lock),0o600);
    assert.equal(mode(live),0o600); assert.equal(statSync(live).ino,inode);
    // Pause an actual first rotation while it holds flock, before copying.
    const bin = join(dir,'bin'); mkdirSync(bin);
    const ready = join(archive,'ready');
    writeFileSync(join(bin,'head'), '#!/bin/bash\n: > "$STATS_TEST_READY"\nread -r release\nexec /usr/bin/head "$@"\n', {mode:0o755});
    writeFileSync(live,'third\n');
    holder = spawn('bash',[rotation,live,archive], {env:{...process.env,PATH:bin+':'+process.env.PATH,STATS_TEST_READY:ready},stdio:['pipe','ignore','inherit']});
    const holderExit = once(holder,'exit');
    const deadline = Date.now()+5000;
    while(!existsSync(ready) && Date.now()<deadline) await new Promise(r=>setTimeout(r,10));
    assert(existsSync(ready),'first rotation reached its locked copy');
    const blocked = rotate(); assert.equal(blocked.status,1); assert.match(blocked.stderr,/holds the lock/);
    assert.equal(readFileSync(live,'utf8'),'third\n');
    holder.stdin.end('release\n'); assert.deepEqual(await holderExit,[0,null]); holder = null;
    assert.equal(readFileSync(join(archive,monthFiles[0]),'utf8'),first+second+'third\n');
    assert.equal(readFileSync(live,'utf8'),'');
    console.log('PASS restrictive/repairable archive modes under umask 0022; rotation appends in order, truncates, tolerates missing/empty live, and blocks concurrent rotation');

    writeFileSync(live,row('search',null,'http','2026-01-02T00:00:00Z')+'\n{partial');
    const report = fileURLToPath(new URL('./report.mjs',import.meta.url));
    const result = run(process.execPath,[report,'--live',live,'--archive-dir',archive]);
    assert.equal(result.status,0,result.stderr); assert.match(result.stdout,/\(3 requests,/);
    for (const label of ['by endpoint:','by tool:','by client:','by day:','ask','search','mcp','trussc_get','widget','claude','http','2025-12-31','2026-01-01','2026-01-02']) assert(result.stdout.includes(label),label);
    rmSync(live);
    assert.match(run(process.execPath,[report,'--live',live,'--archive-dir',archive]).stdout,/\(2 requests,/);
    assert.match(run(process.execPath,[report,'--live',live,'--archive-dir',join(dir,'absent')]).stdout,/no requests/);
    // Missing-live rotation also repairs previous monthly archive permissions.
    const olderArchive = join(archive,'2000-01.jsonl');
    writeFileSync(olderArchive,'older\n',{mode:0o644});
    chmodSync(archive,0o755); chmodSync(lock,0o644);
    assert.equal(rotate().status,0);
    assert.equal(mode(olderArchive),0o600); assert.equal(mode(archive),0o700); assert.equal(mode(lock),0o600);
    assert.equal(readFileSync(olderArchive,'utf8'),'older\n');
    console.log('PASS report combines archive/live and groups endpoint/tool/client/day, tolerating missing files and malformed tails');
} finally {
    if (holder) { holder.stdin.end('release\n'); await once(holder,'exit'); }
    for (const name of Object.keys(process.env)) if (!(name in savedEnv)) delete process.env[name];
    Object.assign(process.env,savedEnv); rmSync(dir,{recursive:true,force:true});
}
