// Offline stats/report regressions. In-memory HTTP and temp files only.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync, readdirSync, openSync, closeSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';

const dir = mkdtempSync(join(tmpdir(), 'docsai-stats-'));
const savedEnv = { ...process.env };
try {
    const archive = join(dir, 'daily with spaces');
    mkdirSync(archive);
    const live = join(archive, new Date().toISOString().slice(0, 10) + '.jsonl');
    Object.assign(process.env, { STATS: '1', STATS_DIR: archive, STATS_SALT: 'synthetic-test-salt', RATE_MAX: '1000' });
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
export const retrieveQueries = (queries, ...args) => retrieve(queries.join(' '), ...args);
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
    const { clientName, queryLanguage, pipelineStat, logStat, hashIp, hashNet } = await import(pathToFileURL(join(dir, 'stats.mjs')));
    assert.equal(hashNet('192.0.2.10'), hashIp('192.0.2.10'), 'IPv4 uses the full address and existing salt/hash');
    assert.notEqual(hashNet('192.0.2.10'), hashNet('192.0.2.11'));
    const home = hashNet('2001:db8:1234:5678::1');
    assert.match(home, /^[a-f0-9]{16}$/);
    assert.equal(home, hashIp('2001:0db8:1234:5678::/64'), 'canonical /64 key uses the existing salt/hash');
    assert.equal(home, hashNet('2001:db8:1234:5678:ffff:abcd:1234:5678'), 'same /64');
    assert.notEqual(home, hashNet('2001:db8:1234:5679::1'), 'different /64');
    for (const spelling of ['2001:0DB8:1234:5678:0000:0000:0000:0001', '2001:db8:1234:5678::1%eth0']) {
        assert.equal(home, hashNet(spelling), 'expanded/case/zone spelling');
    }
    assert.equal(hashNet('fe80::1%eth0'), hashNet('fe80:0:0:0:0:0:0:1%42'));
    assert.equal(hashNet('::'), hashNet('0:0:0:0:0:0:0:0'));
    assert.equal(hashNet('2001:db8::192.0.2.10'), hashNet('2001:db8:0:0:0:0:c000:20a'));
    for (const mapped of ['::ffff:192.0.2.10', '::FFFF:c000:020a', '0:0:0:0:0:ffff:c000:20a%eth0']) {
        assert.equal(hashNet(mapped), hashNet('192.0.2.10'), 'mapped IPv6 is full IPv4, even in hex notation');
    }
    assert.notEqual(hashNet('::ffff:192.0.2.10'), hashNet('::ffff:192.0.2.11'), 'mapped IPv6 keeps every IPv4 bit');
    for (const invalid of [undefined, null, '', 42, {}, [], 'garbage', '192.0.2.999', '192.0.2.010', '2001:db8:::1',
        '1:2:3:4:5:6:7:8:9', '::ffff:192.0.2.999', '[2001:db8::1]', 'fe80::1%', 'fe80::1%eth0%extra', ' 192.0.2.10', '192.0.2.10\n']) {
        assert.equal(hashNet(invalid), null, 'missing/unparseable address');
    }
    const boundedAddress = 'fe80::1%' + 'a'.repeat(120);
    assert.equal(boundedAddress.length, 128);
    assert.equal(hashNet(boundedAddress), hashNet('fe80::1'), '128 code units accepted');
    assert.equal(hashNet(boundedAddress + 'a'), null, '129 code units rejected');
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
    const expired = join(archive, '2000-01-01.jsonl');
    writeFileSync(expired, 'synthetic expired row\n');
    const interval = globalThis.setInterval;
    let timer, unrefCalled = false, server;
    globalThis.setInterval = (callback, delay) => {
        assert.equal(timer, undefined, 'only one retention timer');
        timer = { callback, delay };
        return { unref() { unrefCalled = true; } };
    };
    try { ({ server } = await import(pathToFileURL(join(dir, 'server.mjs')))); }
    finally { globalThis.setInterval = interval; }
    assert.equal(timer.delay, 6 * 60 * 60 * 1000);
    assert(unrefCalled, 'retention timer never keeps the server alive');
    assert(!existsSync(expired), 'startup prunes expired files');
    writeFileSync(expired, 'synthetic expired row\n');
    assert.equal((await timer.callback()).deleted, 1);
    assert(!existsSync(expired), 'timer callback prunes again');
    const rows = () => existsSync(live) ? readFileSync(live, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    async function request(path, body, headers = {}, logged = true, remoteAddress = '192.0.2.10') {
        const before = rows().length;
        const response = await new Promise(resolve => {
            const req = new PassThrough();
            Object.assign(req, { method:'POST', url:path, headers, socket:{remoteAddress} });
            const res = new EventEmitter();
            Object.assign(res, { data:'', setHeader() {}, writeHead(status) { this.status = status; },
                write(data) { this.data += data; return true; }, end(data = '') { this.data += data; resolve(this); } });
            server.emit('request', req, res); req.end(JSON.stringify(body));
        });
        if (!logged) return { response };
        const all = rows(); assert.equal(all.length, before + 1, path + ' writes exactly one line');
        const row = all.at(-1);
        for (const field of ['ts','ep','tool','client','ms','path','fallbackReason','rounds','haikuCalls','haiku','jevTokens','qLen','qLang','ip','net','errorReason','errorClass']) {
            assert(Object.hasOwn(row, field), `${path}: missing ${field}`);
        }
        assert(Number.isFinite(Date.parse(row.ts))); assert(row.ms >= 0);
        assert.deepEqual(Object.keys(row.haiku), ['in','out','thinking']);
        const address = headers['cf-connecting-ip'] || remoteAddress || '';
        assert.equal(row.ip, hashIp(address));
        assert.equal(row.net, hashNet(address));
        if (row.ip !== null) assert.match(row.ip, /^[a-f0-9]{16}$/);
        if (row.net !== null) assert.match(row.net, /^[a-f0-9]{16}$/);
        const written = readFileSync(live, 'utf8').trim().split('\n').at(-1);
        if (address) assert(!written.includes(address), `${path}: no raw address in written line`);
        for (const raw of ['192.0.2.10', '2001:db8:1234:5678', '2001:0DB8:1234:5678',
            '2001:0db8:1234:5678', 'fe80:', '::ffff:', '/64']) {
            assert(!written.includes(raw), `${path}: no raw address or prefix in written line: ${raw}`);
        }
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
    for (const [value, expected] of [
        ['N'.repeat(64), 'N'.repeat(64)], ['n'.repeat(65), 'other'],
        ['self-marker_2026.10-21 Home Office', 'self-marker_2026.10-21 Home Office'],
        ['', 'other'], ['bad/name', 'other'], ['bad\\name', 'other'], ['日本語', 'other'],
        ['name\n', 'other'], ['name\r', 'other'], ['name\t', 'other'], ['name\u0000', 'other'],
        ['bad😀', 'other'], [42, 'other'], [{name:'nested'}, 'other'], [[], 'other'],
        [null, null], [undefined, null],
    ]) {
        const { row } = await request('/mcp', {id:1, method:'initialize', params:{clientInfo:{name:value, version:value}}});
        assert.deepEqual(row.clientInfo, {name:expected, version:expected}, 'initialize clientInfo bounds');
    }
    assert.deepEqual((await request('/mcp', {id:1, method:'initialize'})).row.clientInfo, {name:null, version:null});
    for (const address of ['192.0.2.10', '::ffff:192.0.2.10', '2001:db8:1234:5678::1',
        '2001:0DB8:1234:5678:0000:0000:0000:0001%eth0', 'fe80::1%42', '', 'invalid-address']) {
        // Header and socket paths, including initialize, must write only hashes.
        for (const [path, body] of [['/get', {ids:['one']}], ['/mcp', {id:1, method:'initialize'}]]) {
            const { row } = await request(path, body, {}, true, address);
            const { row:header } = await request(path, body, {'cf-connecting-ip':address});
            if (address) assert.equal(header.net, row.net, 'header and socket normalization agree');
        }
    }
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
    console.log('PASS consistent endpoint/error schema, MCP initialize/tools/stdio, text, client bounds, network hashes/privacy, language and usage');

    // Exercise request handling with no stats directory; warn once per process.
    rmSync(archive, { recursive: true });
    const warnings = [], warn = console.warn;
    console.warn = message => warnings.push(message);
    try {
        for (let i = 0; i < 2; i++) {
            const { response } = await request('/get', { ids: ['one'] }, {}, false);
            assert.equal(response.status, 200);
        }
        assert.equal(warnings.length, 1);
        const pruned = await timer.callback();
        assert.equal(pruned.failures.directory, 1);
        assert.equal((await request('/get', { ids: ['one'] }, {}, false)).response.status, 200);
        assert(!existsSync(archive), 'logger never creates a directory');
    } finally { console.warn = warn; }

    mkdirSync(archive);
    const RealDate = Date, oldUmask = process.umask(0);
    function at(ts) {
        globalThis.Date = class extends RealDate {
            constructor(...args) { super(...(args.length ? args : [ts])); }
        };
    }
    try {
        // UTC midnight boundaries, including month/year and local-time offsets.
        at('2025-12-31T23:59:59.999Z'); logStat({ ep: 'ask', q: 'December' });
        at('2026-01-01T00:00:00Z'); logStat({ ep: 'mcp', tool: 'trussc_get', client: 'claude' });
        at('2026-01-01T09:00:00+09:00'); logStat({ ep: 'search', q: 'January' });
        at('2026-01-02T00:00:00Z'); logStat({ ep: 'search', q: 'Next day' });
        const files = readdirSync(archive).sort();
        assert.deepEqual(files, ['2025-12-31.jsonl', '2026-01-01.jsonl', '2026-01-02.jsonl']);
        for (const name of files) {
            assert.match(name, /^\d{4}-\d{2}-\d{2}\.jsonl$/);
            assert.equal(statSync(join(archive, name)).mode & 0o777, 0o600);
            const lines = readFileSync(join(archive, name), 'utf8').trim().split('\n');
            for (const line of lines) {
                const row = JSON.parse(line);
                assert.equal(row.ts.slice(0, 10) + '.jsonl', name);
                assert.equal(row.net, null, 'the writer supplies net even without request metadata');
            }
        }
        assert.equal(readFileSync(join(archive, '2026-01-01.jsonl'), 'utf8').trim().split('\n').length, 2);
        // Expanded ISO years must never create a name outside the allowed pattern.
        at('+010000-01-01T00:00:00Z'); assert.doesNotThrow(() => logStat({ ep: 'get' }));
        assert.deepEqual(readdirSync(archive).sort(), files);
        // Refuse a symlink without changing its target or replacing the link.
        const target = join(dir, 'target'); writeFileSync(target, 'unchanged');
        const link = join(archive, '2026-02-01.jsonl'); symlinkSync(target, link);
        at('2026-02-01T00:00:00Z'); assert.doesNotThrow(() => logStat({ ep: 'get' }));
        assert.equal(readFileSync(target, 'utf8'), 'unchanged'); rmSync(link);
        // Failed opens also leave requests usable; existing non-files are refused.
        mkdirSync(link); assert.doesNotThrow(() => logStat({ ep: 'get' })); rmSync(link, { recursive: true });
    } finally { globalThis.Date = RealDate; process.umask(oldUmask); }
    console.log('PASS UTC day/month/year boundaries, strict filenames, append, mode 0600 under umask 0, symlink refusal, missing directory and one warning');

    function report(args = [], statsDir = archive) {
        const out = openSync(join(dir, 'report.out'), 'w'), err = openSync(join(dir, 'report.err'), 'w');
        let result;
        try {
            result = spawnSync(process.execPath, [fileURLToPath(new URL('./report.mjs', import.meta.url)),
                '--live', join(dir, 'stats.jsonl'), ...args], {
                env: { ...process.env, STATS_DIR: statsDir, EXCLUDE_IP: '' },
                stdio: ['ignore', out, err], timeout: 10000,
            });
        } finally { closeSync(out); closeSync(err); }
        assert.equal(result.error, undefined);
        assert.equal(result.status, 0, readFileSync(join(dir, 'report.err'), 'utf8'));
        return readFileSync(join(dir, 'report.out'), 'utf8');
    }
    const reportOutput = report();
    assert.match(reportOutput, /\(4 requests,/);
    for (const label of ['by endpoint:', 'by tool:', 'by client:', 'by day:', 'ask', 'search', 'mcp', 'trussc_get', 'claude', '2025-12-31', '2026-01-01']) assert(reportOutput.includes(label), label);
    assert.match(report(['--archive-dir', archive], join(dir, 'absent')), /\(4 requests,/);
    assert.match(report(['--stats-dir', archive], join(dir, 'absent')), /\(4 requests,/);
    assert.match(report([], join(dir, 'absent')), /no requests/);
    console.log('PASS report reads STATS_DIR across months with missing legacy file, directory aliases and absent inputs');
} finally {
    for (const name of Object.keys(process.env)) if (!(name in savedEnv)) delete process.env[name];
    Object.assign(process.env,savedEnv); rmSync(dir,{recursive:true,force:true});
}
