// Fetch GitHub release notes → releases.json (local cache, committed like the
// addon registry). build-chunks.mjs reads the cache, so the corpus build itself
// stays offline; re-run this whenever a release is published.
//   node fetch-releases.mjs
// On any fetch failure the existing cache is left untouched (exit 1 so callers
// can warn, but update-corpus.sh treats it as non-fatal).
import { writeFileSync } from 'node:fs';
import { RELEASES_JSON, RELEASES_REPO } from './config.mjs';

const r = await fetch(`https://api.github.com/repos/${RELEASES_REPO}/releases?per_page=100`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'trussc-docs-ai' },
});
if (!r.ok) {
    console.error(`fetch releases failed: ${r.status} ${r.statusText} — keeping the existing cache`);
    process.exit(1);
}
// GitHub returns newest-first; keep that order (chunkReleases relies on [0] = latest).
const releases = (await r.json())
    .filter((x) => !x.draft)
    .map((x) => ({
        tag: x.tag_name,
        name: x.name || x.tag_name,
        date: (x.published_at || '').slice(0, 10),
        url: x.html_url,
        body: (x.body || '').replace(/\r/g, ''),
    }));
writeFileSync(RELEASES_JSON, JSON.stringify(releases, null, 1) + '\n');
console.log(`wrote ${releases.length} releases → ${RELEASES_JSON} (latest: ${releases[0]?.tag} ${releases[0]?.date})`);
