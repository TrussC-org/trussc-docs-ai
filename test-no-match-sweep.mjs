// Offline regression over real reference inputs. No embeddings, services or Git.
// Uses the builder's config paths/overrides; also discovers an ancestor's sibling
// trussc.org checkout when this test lives in a nested worktree.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, existsSync, rmSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createSymbolChecker } from './mcp-core.mjs';

const here = dirname(fileURLToPath(import.meta.url));
function sibling(relative) {
    for (let parent = dirname(here);; parent = dirname(parent)) {
        const path = join(parent, relative);
        if (existsSync(path)) return path;
        if (parent === dirname(parent)) return undefined;
    }
}

test('real builder corpus never reports a documented reference name absent', t => {
    const dir = mkdtempSync(join(tmpdir(), 'docsai-name-sweep-'));
    const cache = mkdtempSync(join(tmpdir(), 'docsai-name-cache-'));
    try {
        const run = (args, env) => {
            const out = join(dir, 'stdout'), err = join(dir, 'stderr');
            const stdout = openSync(out, 'w'), stderr = openSync(err, 'w');
            let result;
            try { result = spawnSync(process.execPath, args, { cwd: dir, env, timeout: 30000, stdio: ['ignore', stdout, stderr] }); }
            finally { closeSync(stdout); closeSync(stderr); }
            assert.equal(result.status, 0, readFileSync(err, 'utf8') || result.error?.message);
            return readFileSync(out, 'utf8');
        };
        // Run the actual complete builder in a scratch directory so its output and
        // cache lock cannot modify either checkout. Its existing config determines
        // input paths, including explicit per-file overrides.
        for (const name of ['build-chunks.mjs', 'config.mjs', 'addon-cache.mjs', 'fetch-addons.mjs'])
            copyFileSync(join(here, name), join(dir, name));
        const site = process.env.SITE_REPO || sibling('trussc.org');
        const env = { ...process.env, ...(site ? { SITE_REPO: site } : {}) };
        const configProbe = run(['--input-type=module', '-e',
            `import * as c from ${JSON.stringify(pathToFileURL(join(dir, 'config.mjs')).href)};
             console.log(JSON.stringify(Object.fromEntries(['TRUSSC_API','SKETCH_LUA_REF','OF_MAPPING','EXAMPLES_JSON'].map(k=>[k,c[k]]))));`],
        env);
        const paths = JSON.parse(configProbe);
        const missing = ['TRUSSC_API', 'SKETCH_LUA_REF', 'OF_MAPPING', 'EXAMPLES_JSON'].filter(k => !existsSync(paths[k]));
        if (missing.length) {
            const reason = `real corpus source data unavailable: ${missing.join(', ')}`;
            console.log(`SKIP ${reason}`); t.skip(reason); return;
        }

        // This sweep is restricted to site data and the reference TOML. Core
        // docs/example sources and bundled/external addon trees are outside its
        // allowed read scope. Their unavailable inputs are explicit, not fixtures
        // masquerading as real documentation. No service gains a new input path.
        console.log('SKIP concept/docs/core example sources and addon source trees: outside this sweep\'s read scope');
        mkdirSync(join(dir, 'empty'));
        writeFileSync(join(dir, 'for-ai.md'), '');
        Object.assign(env, {
            TRUSSC_REPO: join(dir, 'empty'), FOR_AI: join(dir, 'for-ai.md'),
            DOCS_DIR: join(dir, 'empty'), EXAMPLES_SRC: join(dir, 'empty'),
            ADDONS_DIR: join(dir, 'empty'), ADDON_CACHE_DIR: cache,
            ADDON_REGISTRY: join(here, 'addon-registry.json'),
            RELEASES_JSON: join(here, 'releases.json'), ISSUES_JSON: join(here, 'issues.json'),
        });
        run([join(dir, 'build-chunks.mjs')], env);
        const cards = readFileSync(join(dir, 'chunks.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
        assert(cards.some(c => c.id.startsWith('symbol:')));
        assert(cards.some(c => c.id.startsWith('lua:')));
        const check = createSymbolChecker(cards);

        // Independent whole-word oracle. Keep card boundaries separate so words
        // cannot be manufactured across adjacent fields/cards.
        const words = new Set(cards.flatMap(c => [c.title, c.text].flatMap(s =>
            typeof s === 'string' ? (s.match(/[A-Za-z0-9_]+/g) || []).map(w => w.toLowerCase()) : [])));
        const toml = sibling('TrussC/docs/reference/api-reference.toml');
        let canonical;
        if (toml) {
            canonical = [...readFileSync(toml, 'utf8').matchAll(/^\["([^"\n]+)"\]\s*$/gm)].map(m => m[1]);
            assert(canonical.length > 0, 'reference TOML has no symbol headings');
        } else {
            console.log('SKIP reference TOML unavailable; sweeping every name in the builder\'s real API input instead');
            const api = createRequire(import.meta.url)(paths.TRUSSC_API), names = new Set();
            const visit = value => {
                if (!value || typeof value !== 'object') return;
                if (typeof value.name === 'string') names.add(value.name);
                for (const child of Object.values(value)) visit(child);
            };
            visit(api); canonical = [...names];
        }
        // Every TOML spelling, plus distinct bare components: the latter catches
        // inline members/fields even when the owning type already has an id.
        const bare = [...new Set(canonical.flatMap(n => n.split('::')))];
        const sweep = names => {
            const present = [], reported = [], falseReports = [];
            for (const name of names) {
                const parts = name.replace(/^(?:tc|tcx)::/i, '').split('::');
                const inText = parts.every(p => words.has(p.toLowerCase()));
                const missing = check(`how do I use ${name}`);
                if (inText) present.push(name);
                if (missing.length) reported.push(name);
                if (missing.some(m => words.has(m.name.toLowerCase())) || inText && missing.length)
                    falseReports.push(name);
            }
            return { total: names.length, present: present.length, reported: reported.length, remaining: reported, falseReports };
        };
        const canonicalResult = sweep(canonical), bareResult = sweep(bare);
        console.log(`SWEEP ${JSON.stringify({ cards: cards.length,
            textCodeUnits: cards.reduce((n, c) => n + (c.title?.length || 0) + (c.text?.length || 0), 0),
            distinctTextWords: words.size, canonical: canonicalResult, bare: bareResult })}`);
        assert.deepEqual(canonicalResult.falseReports, [], 'documented canonical names must abstain');
        assert.deepEqual(bareResult.falseReports, [], 'documented inline names must abstain');
        for (const name of ['onMouseDrag', 'sampleRate', 'EaseFunction', 'MatrixScope', 'earlyUpdate']) {
            assert(words.has(name.toLowerCase()), `review control ${name} missing from real corpus`);
            assert.deepEqual(check(`how do I use ${name}`), [], name);
        }
        for (const name of ['CudaGraph', 'setupGui', 'loadFromUrlAsync', 'FboSettings', 'drawRoundedRect']) {
            assert(!words.has(name.toLowerCase()), `absence control ${name} unexpectedly documented`);
            assert.deepEqual(check(`how do I use ${name}`).map(m => m.name), [name], name);
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(cache, { recursive: true, force: true });
    }
});
