// One call to an OpenAI-compatible /chat/completions endpoint, streaming.
// Collects text and tool calls from the server-sent events and reports the
// text as it grows.

import {config} from '../config.js';

import {type CallOptions, type CallResult, LlmError, type ToolCall} from './types.js';

export type Endpoint = {baseUrl: string; apiKey: string; model: string; headers?: Record<string, string>};

// Rough token estimate when a provider doesn't report usage (~4 characters per token).
export function estimateTokens(value: unknown): number {
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
    return Math.ceil(text.length / 4);
}

export async function chatCompletion(ep: Endpoint, opts: CallOptions): Promise<CallResult> {
    const body: Record<string, unknown> = {
        model: ep.model,
        messages: opts.messages,
        stream: true,
        stream_options: {include_usage: true},
        temperature: opts.temperature ?? 0.4,
        ...(opts.maxTokens ? {max_tokens: opts.maxTokens} : {}),
        ...(opts.tools?.length ? {tools: opts.tools, tool_choice: 'auto'} : {}),
        ...(opts.json ? {response_format: {type: 'json_object'}} : {}),
    };
    const timeout = AbortSignal.timeout(config.llm.requestTimeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

    let res: Response;
    try {
        res = await fetch(`${ep.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: {Authorization: `Bearer ${ep.apiKey}`, 'Content-Type': 'application/json', Accept: 'text/event-stream', ...(ep.headers ?? {})},
            body: JSON.stringify(body),
            signal,
        });
    } catch (e) {
        if (opts.signal?.aborted) {
            throw new LlmError('cancelled', 0, false);
        }
        throw new LlmError(`could not reach the provider: ${(e as Error).message}`, 0, true);
    }
    if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 400);
        const retryAfter = Number(res.headers.get('retry-after'));
        // 4xx other than rate limits means this request won't work on this model.
        throw new LlmError(`provider answered ${res.status}: ${detail}`, res.status, res.status === 429 || res.status >= 500 || res.status === 408, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null);
    }

    const type = res.headers.get('content-type') ?? '';
    if (!type.includes('text/event-stream')) {
        // Some gateways ignore stream=true and answer in one piece.
        const json = (await res.json()) as {choices?: {message?: {content?: string; tool_calls?: ToolCall[]}; finish_reason?: string}[]; usage?: {prompt_tokens?: number; completion_tokens?: number}};
        const msg = json.choices?.[0]?.message;
        const text = msg?.content ?? '';
        if (text) {
            opts.onText?.(text);
        }
        return {
            text,
            toolCalls: msg?.tool_calls ?? [],
            tokensIn: json.usage?.prompt_tokens ?? estimateTokens(opts.messages),
            tokensOut: json.usage?.completion_tokens ?? estimateTokens(text),
            finishReason: json.choices?.[0]?.finish_reason ?? 'stop',
        };
    }

    let text = '';
    let finishReason = 'stop';
    let usage: {prompt_tokens?: number; completion_tokens?: number} | undefined;
    const calls = new Map<number, {id: string; name: string; args: string}>();
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
        for (;;) {
            const {done, value} = await reader.read();
            if (done) {
                break;
            }
            buffer += decoder.decode(value, {stream: true});
            let nl: number;
            while ((nl = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, nl).trim();
                buffer = buffer.slice(nl + 1);
                if (!line.startsWith('data:')) {
                    continue;
                }
                const data = line.slice(5).trim();
                if (data === '[DONE]') {
                    continue;
                }
                let chunk: {choices?: {delta?: {content?: string; tool_calls?: {index?: number; id?: string; function?: {name?: string; arguments?: string}}[]}; finish_reason?: string | null}[]; usage?: typeof usage; error?: {message?: string; code?: number | string}};
                try {
                    chunk = JSON.parse(data);
                } catch {
                    continue;
                }
                if (chunk.error) {
                    // Errors can arrive mid-stream (OpenRouter sends its status as the code).
                    const code = Number(chunk.error.code);
                    throw new LlmError(`provider error: ${chunk.error.message ?? 'unknown'}`, Number.isInteger(code) && code >= 400 && code < 600 ? code : 0, true);
                }
                if (chunk.usage) {
                    usage = chunk.usage;
                }
                const choice = chunk.choices?.[0];
                if (!choice) {
                    continue;
                }
                if (choice.finish_reason) {
                    finishReason = choice.finish_reason;
                }
                const delta = choice.delta;
                if (delta?.content) {
                    text += delta.content;
                    opts.onText?.(text);
                }
                for (const tc of delta?.tool_calls ?? []) {
                    const idx = tc.index ?? 0;
                    const cur = calls.get(idx) ?? {id: '', name: '', args: ''};
                    if (tc.id) {
                        cur.id = tc.id;
                    }
                    if (tc.function?.name) {
                        cur.name += tc.function.name;
                    }
                    if (tc.function?.arguments) {
                        cur.args += tc.function.arguments;
                    }
                    calls.set(idx, cur);
                }
            }
        }
    } catch (e) {
        if (opts.signal?.aborted) {
            throw new LlmError('cancelled', 0, false);
        }
        if (e instanceof LlmError) {
            throw e;
        }
        throw new LlmError(`stream broke: ${(e as Error).message}`, 0, true);
    }

    const toolCalls: ToolCall[] = [...calls.entries()].sort((a, b) => a[0] - b[0]).filter(([, c]) => c.name).map(([i, c]) => ({
        id: c.id || `call_${i}_${Date.now()}`,
        type: 'function',
        function: {name: c.name, arguments: c.args || '{}'},
    }));
    return {
        text,
        toolCalls,
        tokensIn: usage?.prompt_tokens ?? estimateTokens(opts.messages),
        tokensOut: usage?.completion_tokens ?? estimateTokens(text) + estimateTokens(toolCalls),
        finishReason,
    };
}
