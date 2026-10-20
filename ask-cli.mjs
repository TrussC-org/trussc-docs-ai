// HTTP client for the public, allowlisted per-round trace. No model credentials.
import { pathToFileURL } from 'node:url';

export async function main(args = process.argv.slice(2), { fetchImpl = fetch, print = console.log } = {}) {
    let question, json = false, url = `http://127.0.0.1:${process.env.PORT || 8788}/ask`;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--json') json = true;
        else if (arg === '--url' && args[i + 1]) url = args[++i];
        else if (arg.startsWith('--') || question !== undefined) throw new Error('Usage: node ask-cli.mjs "question" [--json] [--url URL]');
        else question = arg;
    }
    if (!question?.trim()) throw new Error('Usage: node ask-cli.mjs "question" [--json] [--url URL]');
    const response = await fetchImpl(url, {
        method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question, debug: true }),
    });
    if (!response.ok) throw new Error(`ask HTTP ${response.status}`);
    const raw = await response.text();
    if (json) { print(raw); return; }
    const result = JSON.parse(raw);
    if (typeof result.debug?.haikuCalls === 'number') print(`Haiku calls: ${result.debug.haikuCalls}`);
    for (const [i, round] of (result.debug?.rounds || []).entries()) {
        print(`Round ${i + 1}: ${round.path}, exists p=${round.exists ?? 'unknown'}`);
        print(`  Queries: ${round.queries.join(' / ')}`);
        print(`  Pool: ${round.poolSize ?? 'unknown'} cards`);
        print(`  Haiku: ${round.haiku.ms} ms, tokens in=${round.haiku.inputTokens ?? 'unknown'} out=${round.haiku.outputTokens ?? 'unknown'}`);
        print(`  Jev: ${round.jev.ms} ms, tokens=${round.jev.tokens ?? 'unknown'}`);
        for (const card of round.picked) print(`  ${card.id} | ${card.title} | p=${card.p ?? 'unknown'}`);
        if (round.message) print(`  Search: ${round.message}`);
    }
    print(`\n${result.answer}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
