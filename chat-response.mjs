// Collect the public chat stream into a buffered answer for HTTP CLI callers.
export async function collectChatResponse(response) {
    const result = { answer: '', links: [], sources: [] };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0, buffer = '', event = '', data = [];
    function line(value) {
        if (!value) {
            const type = event, payload = data.join('\n');
            event = ''; data = [];
            if (!payload) return;
            const value = JSON.parse(payload);
            if (type === 'token') result.answer += value;
            else if (type === 'replace') result.answer = value;
            else if (type === 'sources' || type === 'links' || type === 'debug') result[type] = value;
            else if (type === 'error') return { error: value };
            else if (type === 'done') {
                const { corrected, usedIds, rounds, queries } = value;
                return { ...result, corrected, usedIds, rounds, queries };
            }
        } else if (value.startsWith('event:')) event = value.slice(6).replace(/^ /, '');
        else if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''));
    }
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) throw new Error('chat stream ended before done');
            bytes += value.byteLength;
            // Bound (response): accept at most 4 MiB of SSE bytes, including metadata;
            // overflow rejects and cancels the stream before retaining the chunk.
            if (bytes > 4 * 1024 * 1024) throw new Error('chat response too large');
            buffer += decoder.decode(value, { stream: true });
            let end;
            while ((end = buffer.indexOf('\n')) >= 0) {
                const value = buffer.slice(0, end).replace(/\r$/, '');
                buffer = buffer.slice(end + 1);
                const complete = line(value);
                if (complete) return complete;
            }
        }
    } finally {
        await reader.cancel();
        reader.releaseLock();
    }
}
