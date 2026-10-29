// OpenAI-compatible chat shapes (the lingua franca of every provider we route to).

export type TextPart = {type: 'text'; text: string};
export type ImagePart = {type: 'image_url'; image_url: {url: string}};
export type ContentPart = TextPart | ImagePart;

export type ToolCall = {id: string; type: 'function'; function: {name: string; arguments: string}};

export type ChatMessage =
    | {role: 'system'; content: string}
    | {role: 'user'; content: string | ContentPart[]}
    | {role: 'assistant'; content: string | null; tool_calls?: ToolCall[]}
    | {role: 'tool'; content: string; tool_call_id: string};

export type ToolDef = {type: 'function'; function: {name: string; description: string; parameters: Record<string, unknown>}};

export type CallResult = {
    text: string;
    toolCalls: ToolCall[];
    tokensIn: number;
    tokensOut: number;
    finishReason: string;
};

export type CallOptions = {
    messages: ChatMessage[];
    tools?: ToolDef[];
    maxTokens?: number;
    temperature?: number;
    json?: boolean; // ask for a JSON object
    signal?: AbortSignal;
    onText?: (textSoFar: string) => void; // streamed text, called with everything so far
};

export class LlmError extends Error {
    readonly status: number;
    readonly retryable: boolean;
    readonly retryAfterMs: number | null; // from a rate limit's Retry-After

    constructor(message: string, status = 0, retryable = true, retryAfterMs: number | null = null) {
        super(message);
        this.status = status;
        this.retryable = retryable;
        this.retryAfterMs = retryAfterMs;
    }
}
