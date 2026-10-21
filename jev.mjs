// One typed Jev request for all candidate cards. Failures contain fixed reasons,
// never upstream bodies, exception messages, headers, or credentials.
import * as config from './config.mjs';

class SelectionFailure extends Error {
    constructor(reason) { super('selection service error'); this.reason = reason; }
}

// Bound (security): cap each Jev card text at JEV_CARD_CHARS. Overflow truncates text and is not counted.
export function cardState(question, pool, cfg = config, searchMore = null) {
    return { question, ...(searchMore ? { search_more: { message: searchMore.message, queries: searchMore.queries } } : {}),
        cards: pool.map((c, i) => ({ card: `c${i + 1}`, title: c.title || '', text: (c.text || '').slice(0, cfg.JEV_CARD_CHARS) })) };
}
export function stateTokens(question, pool, cfg = config, searchMore = null) {
    return JSON.stringify(cardState(question, pool, cfg, searchMore)).length * cfg.JEV_TOKENS_PER_CHAR;
}
const noul = (instructions, criteria = { true: 'Yes', false: 'No' }) => ({ type: 'noul', instructions, criteria });
function questionsFor(state) {
    const gap = state.search_more ? ' Focus on the gap described by state.search_more.message and state.search_more.queries.' : '';
    return { ...Object.fromEntries(state.cards.map(c => [c.card, noul(`Does card ${c.card} in state.cards contain information needed to answer state.question?${gap}`)])),
        exists: noul(`Do the cards in state.cards together contain all the information needed to answer every part of state.question correctly, without guessing?${gap}`,
            { true: 'Yes: every part of the question can be answered from the cards', false: 'No: at least one part of the question is missing from the cards or would have to be guessed' }) };
}
export function perQuestionTokens(question, pool, cfg = config, searchMore = null) {
    const state = cardState(question, pool, cfg, searchMore);
    const largest = Math.max(...Object.values(questionsFor(state)).map(q => JSON.stringify(q).length));
    return (JSON.stringify(state).length + largest) * cfg.JEV_TOKENS_PER_CHAR;
}
export function createSelector({ cfg = config, fetchImpl = (...args) => fetch(...args), now = Date.now, warn = (...args) => console.warn(...args), maxIps = 10000 } = {}) {
    const hits = new Map();
    let day = '', tokens = 0, warned = false;
    if (!cfg.TYPESAFE_API_KEY) warn('Warning: TYPESAFE_API_KEY missing; Jev uses fallback');
    function localDay(t) { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; }
    async function selectCards(question, pool, { ip = 'unknown', searchMore = null } = {}) {
        const start = now();
        let estimatedTokens = 0;
        const result = (path, reason, extra = {}) => ({ picked: [], exists: null, path, reason, usage: null, estimatedTokens, ms: Math.max(0, now() - start), ...extra });
        try {
            if (!cfg.TYPESAFE_API_KEY) return result('fallback', 'nokey');
            if (!pool.length) return result('fallback', 'pool');
            const state = cardState(question, pool, cfg, searchMore);
            const questions = questionsFor(state);
            const body = JSON.stringify({ model: cfg.JEV_MODEL, state, questions });
            estimatedTokens = Math.ceil(body.length * cfg.JEV_TOKENS_PER_CHAR);
            // Bound (security): state plus each instruction must fit 32000 estimated tokens. Overflow selects pool fallback and is counted.
            if (perQuestionTokens(question, pool, cfg, searchMore) > 32000) return result('fallback', 'pool');
            const today = localDay(start);
            if (day !== today) { day = today; tokens = 0; warned = false; }
            // Bound (security): reserve estimated tokens before awaiting to enforce the daily budget. Overflow selects budget fallback and is counted.
            if (tokens + estimatedTokens > cfg.JEV_DAILY_TOKENS) {
                if (!warned) { warn('Warning: Jev daily token budget reached; using fallback'); warned = true; }
                return result('fallback', 'budget');
            }
            // Bound (security): cap calls per IP per sliding window. Overflow selects rate fallback and is counted.
            for (const [key, times] of hits) {
                const active = times.filter((t) => start - t < cfg.JEV_RATE_WIN_MS);
                if (active.length) hits.set(key, active); else hits.delete(key);
            }
            const times = hits.get(ip) || [];
            if (times.length >= cfg.JEV_RATE_MAX) return result('fallback', 'rate');
            hits.delete(ip);
            // Bound (security): cap tracked IPs after pruning expired entries. Overflow evicts the oldest IP and is not counted.
            if (hits.size >= maxIps) hits.delete(hits.keys().next().value);
            times.push(start); hits.set(ip, times);
            tokens += estimatedTokens;
            const controller = new AbortController();
            let timer;
            // Bound (security): deadline covers connect and the whole body even if transport ignores abort. Overflow selects timeout fallback and is counted.
            const deadline = new Promise((_, reject) => {
                timer = setTimeout(() => { controller.abort(); reject(new SelectionFailure('timeout')); }, cfg.JEV_TIMEOUT_MS);
            });
            try {
                const data = await Promise.race([deadline, (async () => {
                    const r = await fetchImpl(cfg.JEV_URL, { method: 'POST', redirect: 'manual', signal: controller.signal,
                        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.TYPESAFE_API_KEY}` }, body });
                    if (!r.ok) { controller.abort(); throw new SelectionFailure(r.status >= 300 && r.status < 400 ? 'redirect' : 'http'); }
                    const parts = []; let bytes = 0;
                    for await (const part of r.body) {
                        if (now() - start >= cfg.JEV_TIMEOUT_MS) { controller.abort(); throw new SelectionFailure('timeout'); }
                        // Bound (security): cap response bytes incrementally at 1 MiB before retention. Overflow selects oversize fallback and is counted.
                        bytes += part.byteLength;
                        if (bytes > 1048576) { controller.abort(); throw new SelectionFailure('oversize'); }
                        parts.push(Buffer.from(part));
                    }
                    let d;
                    try { d = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw new SelectionFailure('invalid'); }
                    for (const name of Object.keys(questions)) {
                        const p = d?.answers?.[name]?.noul;
                        if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) throw new SelectionFailure('invalid');
                    }
                    if (now() - start >= cfg.JEV_TIMEOUT_MS) { controller.abort(); throw new SelectionFailure('timeout'); }
                    return d;
                })()]);
                const usage = data.usage ?? null;
                const reported = usage?.total_tokens ?? (typeof usage?.input_tokens === 'number' && typeof usage?.output_tokens === 'number' ? usage.input_tokens + usage.output_tokens : usage?.input_tokens);
                // Preserve reservations on failure; reported usage replaces an estimate on success.
                if (typeof reported === 'number' && Number.isFinite(reported) && reported >= 0 && day === today) tokens += reported - estimatedTokens;
                const ranked = pool.map((c, i) => ({ ...c, p: data.answers[`c${i + 1}`].noul })).sort((a, b) => b.p - a.p);
                // Bound (selection): fixed or threshold/min/max rules bound returned cards. Overflow drops lower-probability cards and is not counted.
                const count = cfg.JEV_PICK === 'fixed' ? cfg.JEV_PICK_K : Math.min(cfg.JEV_PICK_MAX, Math.max(Math.min(cfg.JEV_PICK_MIN, cfg.JEV_PICK_MAX), ranked.filter((c) => c.p >= cfg.JEV_PICK_MIN_P).length));
                return result('jev', null, { picked: ranked.slice(0, count), exists: data.answers.exists.noul, usage,
                    tokens: typeof reported === 'number' && Number.isFinite(reported) && reported >= 0 ? reported : estimatedTokens });
            } catch (e) {
                // Only our fixed reason vocabulary may escape this module.
                const reason = e instanceof SelectionFailure ? e.reason : controller.signal.aborted ? 'timeout' : 'error';
                return result('fallback', reason, { error: 'selection service error', errorClass: config.transportClass(e) });
            } finally { clearTimeout(timer); }
        } catch (e) {
            // Request/state construction exceptions use the same safe boundary.
            return result('fallback', 'error', { error: 'selection service error', errorClass: config.transportClass(e) });
        }
    }
    return { selectCards, trackedIps: () => hits.size };
}
export const { selectCards } = createSelector();
