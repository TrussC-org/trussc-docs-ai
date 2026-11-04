import { collectChatResponse } from '../chat-response.mjs';

// Keep behavioral assertions in the buffered response shape while exercising SSE.
// HTTP validation failures already have JSON bodies; SSE failures retain HTTP 200.
export async function chatResponse(response) {
    if (response.status === 200) {
        response.data = JSON.stringify(await collectChatResponse(new Response(response.data)));
    }
    return response;
}

export async function requestChat(request, ...args) {
    return chatResponse(await request('/chat', ...args));
}
