// Everything the bridge needs comes from environment variables
// (see server/.env.example).

export type AgentConfig = {
    username: string; // the bot account's username in Mattermost
    token: string; // the bot's access token
    instructions: string; // its system prompt
};

function env(name: string, fallback = ''): string {
    return (process.env[name] ?? fallback).trim();
}

export const config = {
    port: Number(env('BRIDGE_PORT', '8787')),
    // How Mattermost reaches the bridge for button clicks (inside Docker: http://bridge:8787).
    publicUrl: env('BRIDGE_PUBLIC_URL', 'http://localhost:8787').replace(/\/+$/, ''),
    // Shared secret placed in every button's context, so only Mattermost's callbacks are trusted.
    secret: env('BRIDGE_SECRET', 'change-me'),
    mattermostUrl: env('MM_URL', 'http://localhost:8065').replace(/\/+$/, ''),
    llm: {
        // Any OpenAI-compatible endpoint: Captain's router (Yunwu), OpenAI, OpenRouter...
        baseUrl: env('LLM_BASE_URL').replace(/\/+$/, ''),
        apiKey: env('LLM_API_KEY'),
        model: env('LLM_MODEL', 'auto'),
        visionModel: env('LLM_VISION_MODEL'),
    },
};

const DEFAULT_INSTRUCTIONS: Record<string, string> = {
    captain: [
        'You are Captain, the coordinator in a team group chat where people and AI agents work together.',
        'Answer in the language the person wrote in. Be brief and concrete: lead with the answer, then at most a few short points.',
        'If a screenshot is attached, describe what matters in it for the question.',
        'If the request needs an action with outside effects (sending email, posting publicly, spending money, deleting data),',
        'do not claim you did it. Instead end your reply with one line: DECISION: {"title": "...", "reason": "...", "fields": [{"label": "...", "value": "..."}]}',
        'so a person can approve it.',
    ].join(' '),
    researcher: 'You are Researcher, an agent in a team chat. Find and check facts, say how confident you are, and name the kind of source you would use. Be brief.',
    designer: 'You are Designer, an agent in a team chat. Give concrete UI and visual suggestions with specific sizes, colors and copy. Be brief.',
};

// Bot tokens: AGENT_TOKENS="captain=xxxx,researcher=yyyy,designer=zzzz"
export function loadAgents(): AgentConfig[] {
    return env('AGENT_TOKENS').
        split(',').
        map((pair) => pair.trim()).
        filter(Boolean).
        map((pair) => {
            const [username, token] = pair.split('=').map((s) => s.trim());
            return {username, token, instructions: env(`AGENT_PROMPT_${username.toUpperCase()}`) || DEFAULT_INSTRUCTIONS[username] || DEFAULT_INSTRUCTIONS.captain.replace('You are Captain, the coordinator', `You are ${username}, an agent`)};
        }).
        filter((a) => a.username && a.token);
}
