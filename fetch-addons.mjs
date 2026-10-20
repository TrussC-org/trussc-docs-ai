// Operator-shell fetcher. Failure preserves the previous registry atomically;
// the builder can still use that registry and its existing external addon cache.
import { writeFileSync, renameSync, unlinkSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { CACHE_DIR, refreshExternalAddons, admitRegistryAddons, withCacheLock } from './addon-cache.mjs';

export const REGISTRY_URL = 'https://raw.githubusercontent.com/TrussC-org/trussc-addons/gh-pages/registry.json';
// Bound (security): read at most 2 MiB, incrementally, within 30 s overall.
// Consider at most 256 entries; first case-insensitive name/cache URL wins.
// Redirects, overflow, timeout, invalid JSON/shape or I/O failure keep the old file.
export const MAX_REGISTRY_BYTES = 2 * 1024 ** 2;
export const REGISTRY_TIMEOUT_MS = 30_000;
export function validateRegistry(value, warn = s => console.warn(`Warning: ${s}`)) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.addons)) throw new Error('registry must be an object with an addons array');
    const addons = admitRegistryAddons(value.addons, warn);
    return { ...value, addons };
}

export async function fetchRegistry({ path = process.env.ADDON_REGISTRY || fileURLToPath(new URL('./addon-registry.json', import.meta.url)),
    url = process.env.ADDON_REGISTRY_URL || REGISTRY_URL, fetchImpl = fetch, timeoutMs = REGISTRY_TIMEOUT_MS,
    warn = s => console.warn(`Warning: ${s}`) } = {}) {
    const controller = new AbortController();
    const tmp = `${path}.${randomUUID()}.tmp`;
    let timer, reader;
    try {
        const task = async () => {
            const response = await fetchImpl(url, { redirect: 'manual', signal: controller.signal,
                headers: { 'user-agent': 'trussc-docs-ai' } });
            if (!response.ok) throw new Error(`HTTP ${response.status} (redirects are not followed)`);
            if (Number(response.headers.get('content-length')) > MAX_REGISTRY_BYTES) throw new Error('registry exceeds 2 MiB');
            if (!response.body) throw new Error('registry response has no body');
            reader = response.body.getReader();
            const blocks = [];
            let bytes = 0;
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                bytes += value.byteLength;
                if (bytes > MAX_REGISTRY_BYTES) throw new Error('registry exceeds 2 MiB');
                blocks.push(Buffer.from(value));
            }
            return validateRegistry(JSON.parse(Buffer.concat(blocks).toString('utf8')), warn);
        };
        const registry = await Promise.race([task(), new Promise((_, reject) => {
            timer = setTimeout(() => { controller.abort(); reject(new Error('registry overall timeout')); }, timeoutMs);
        })]);
        writeFileSync(tmp, JSON.stringify(registry, null, 2) + '\n', { flag: 'wx' });
        renameSync(tmp, path);
        console.log(`wrote ${registry.addons.length} addons → ${path}`);
        return registry;
    } catch (e) {
        warn(`fetch addons failed: ${e.message} — keeping the existing addon registry`);
        return null;
    } finally {
        clearTimeout(timer);
        controller.abort();
        if (reader) reader.cancel().catch(() => {});
        try { unlinkSync(tmp); } catch { /* never created, or renamed */ }
    }
}

export async function main() {
    const path = process.env.ADDON_REGISTRY || fileURLToPath(new URL('./addon-registry.json', import.meta.url));
    try {
        return await withCacheLock({ cacheDir: CACHE_DIR }, async lock => {
            let registry = await fetchRegistry({ path });
            const failed = !registry;
            if (!registry && existsSync(path)) registry = validateRegistry(JSON.parse(readFileSync(path, 'utf8')));
            if (registry) await refreshExternalAddons(registry.addons, { cacheDir: CACHE_DIR, lock,
                // Test seam: original registry URLs still undergo GitHub-only validation.
                rewrites: JSON.parse(process.env.ADDON_URL_REWRITES || '{}') });
            return failed ? 1 : 0;
        });
    } catch (e) {
        console.warn(`Warning: external addon refresh failed: ${e.message}`);
        return 1;
    }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
