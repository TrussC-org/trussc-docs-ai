// Public trace boundary. Keep every object an explicit allowlist; internal
// retrieval records contain fallback reasons and must never be serialized here.
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const string = value => typeof value === 'string' ? value : null;
export function publicDebug(traces = []) {
    return { idOnlyCardsTotal: traces.reduce((n, trace) => n + (number(trace.idOnlyCards) ?? 0), 0), haikuCalls: traces.reduce((n, trace) => n + (number(trace.haikuCalls) ?? 0), 0), rounds: traces.map(trace => ({
        queries: trace.queries.map(string),
        idOnlyCards: number(trace.idOnlyCards) ?? 0,
        poolSize: number(trace.info.poolSize),
        picked: trace.picked.map(card => ({ id: string(card.id), title: string(card.title), p: number(card.p) })),
        exists: number(trace.info.exists),
        hintShown: trace.hintShown === true,
        hintFollowed: trace.hintShown === true && typeof trace.hintFollowed === 'boolean' ? trace.hintFollowed : null,
        path: trace.info.path === 'jev' ? 'jev' : 'fallback',
        haiku: { estInputTokens: (trace.haiku.estInputTokens ?? []).map(number).filter(n => n !== null), ms: number(trace.haiku.ms), inputTokens: (trace.haiku.inputTokens ?? []).map(number), inputTokensTotal: number(trace.haiku.inputTokensTotal), outputTokens: number(trace.haiku.outputTokens) },
        jev: { ms: number(trace.info.jevMs), tokens: number(trace.info.jevTokens) },
        message: string(trace.message),
    })) };
}
