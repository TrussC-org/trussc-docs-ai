// Fetch the open `bug` issues of the TrussC repo → issues.json (local cache, same
// pattern as fetch-releases.mjs). build-chunks.mjs reads the cache, so the corpus
// build itself stays offline; update-corpus.sh re-runs this every rebuild, so a
// closed issue drops out of the corpus on the next rebuild.
//   node fetch-issues.mjs
// Only `bug` is taken — an `enhancement` alone is a missing feature, and answering
// it as a known bug would be wrong. (bug + enhancement is still a bug: kept.)
// Bodies run 5–17k chars (repro, root cause, suggested fix), which would drown the
// retrieval, so only the `## Summary` and `## Workaround` sections are kept. An issue
// without a Summary falls back to its first paragraph.
// On any fetch failure the existing cache is left untouched (exit 1 so callers can
// warn, but update-corpus.sh treats it as non-fatal).
import { writeFileSync } from 'node:fs';
import { ISSUES_JSON, ISSUES_REPO } from './config.mjs';

const SECTION_CAP = 1500;

// The body of a `## <name>` section, up to the next heading of level 1–2.
function section(body, re) {
    const lines = body.split('\n');
    const start = lines.findIndex((l) => re.test(l));
    if (start < 0) return '';
    const out = [];
    for (const l of lines.slice(start + 1)) {
        if (/^#{1,2}\s/.test(l)) break;
        out.push(l);
    }
    return out.join('\n').trim();
}

// No Summary: the first paragraph that is prose (not a heading, code fence or table).
function firstParagraph(body) {
    for (const p of body.split(/\n\s*\n/)) {
        const t = p.trim();
        if (t && !/^(#|```|\||<!--)/.test(t)) return t;
    }
    return '';
}

// Summaries cite GitHub blob lines as [file#L1-L2](https://github.com/…). The label
// carries the meaning; the permalink is noise to both the embedding and the model.
const tidy = (s) => {
    let t = s.replace(/\[([^\]]+)\]\(https?:\/\/[^)]*\)/g, '$1').replace(/\r/g, '').trim();
    if (t.length > SECTION_CAP) t = t.slice(0, SECTION_CAP).replace(/\s+\S*$/, '') + ' …';
    return t;
};

const issues = [];
for (let page = 1; ; page++) {
    const r = await fetch(`https://api.github.com/repos/${ISSUES_REPO}/issues?state=open&labels=bug&per_page=100&page=${page}`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'trussc-docs-ai' },
    });
    if (!r.ok) {
        console.error(`fetch issues failed: ${r.status} ${r.statusText} — keeping the existing cache`);
        process.exit(1);
    }
    const batch = await r.json();
    for (const x of batch) {
        if (x.pull_request) continue;            // the issues endpoint also lists PRs
        const body = (x.body || '').replace(/\r/g, '');
        const summary = section(body, /^##\s+Summary\b/i);
        issues.push({
            number: x.number,
            title: x.title,
            url: x.html_url,
            labels: (x.labels || []).map((l) => l.name),
            created: (x.created_at || '').slice(0, 10),
            updated: (x.updated_at || '').slice(0, 10),
            summary: tidy(summary || firstParagraph(body)),
            workaround: tidy(section(body, /^##\s+Workarounds?\b/i)),
        });
    }
    if (batch.length < 100) break;
}
issues.sort((a, b) => b.number - a.number);
const fetched = new Date().toISOString().slice(0, 10);
writeFileSync(ISSUES_JSON, JSON.stringify({ repo: ISSUES_REPO, fetched, issues }, null, 1) + '\n');
const wa = issues.filter((i) => i.workaround).length;
console.log(`wrote ${issues.length} open bug issues (${wa} with a workaround) → ${ISSUES_JSON} (as of ${fetched})`);
