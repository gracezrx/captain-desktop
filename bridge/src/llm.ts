// One call to any OpenAI-compatible chat completions endpoint. Without a
// configured endpoint the bridge still runs, and says so in its replies.

import {config} from './config.ts';

export type ChatPart = {type: 'text'; text: string} | {type: 'image_url'; image_url: {url: string}};
export type ChatMessage = {role: 'system' | 'user' | 'assistant'; content: string | ChatPart[]};

export const llmConfigured = Boolean(config.llm.baseUrl && config.llm.apiKey);

export async function complete(messages: ChatMessage[], {hasImages = false} = {}): Promise<string> {
    if (!llmConfigured) {
        const last = messages.filter((m) => m.role === 'user').at(-1);
        const text = typeof last?.content === 'string' ? last.content : last?.content.find((p) => p.type === 'text')?.text ?? '';
        return [
            hasImages ? 'I got your screenshot.' : 'Got it.',
            'No model is connected to this bridge yet, so this is a placeholder reply.',
            'Set LLM_BASE_URL and LLM_API_KEY (for example Captain\'s router) and I\'ll answer for real.',
            text ? `\n\nYou asked: "${text.slice(0, 140)}"` : '',
        ].join(' ');
    }
    const model = hasImages && config.llm.visionModel ? config.llm.visionModel : config.llm.model;
    const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {Authorization: `Bearer ${config.llm.apiKey}`, 'Content-Type': 'application/json'},
        body: JSON.stringify({model, messages, temperature: 0.4}),
        signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
        throw new Error(`model endpoint answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const body = (await res.json()) as {choices?: {message?: {content?: string}}[]};
    return body.choices?.[0]?.message?.content?.trim() || '(The model returned an empty reply.)';
}
