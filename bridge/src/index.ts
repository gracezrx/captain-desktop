// Captain bridge: runs each configured agent as a Mattermost bot and serves
// the callback Mattermost calls when someone clicks Approve or Reject.

import http from 'node:http';

import {Agent, type Decision} from './agent.ts';
import {config, loadAgents} from './config.ts';
import {llmConfigured} from './llm.ts';
import type {Post} from './mattermost.ts';

const agents = loadAgents().map((cfg) => new Agent(cfg));
if (!agents.length) {
    console.error('No agents configured. Set AGENT_TOKENS="captain=<bot token>,..." (see server/.env.example).');
    process.exit(1);
}

async function startAgents(): Promise<void> {
    for (const agent of agents) {
        // Retry until Mattermost is up (it starts slower than the bridge).
        for (let attempt = 1; ; attempt++) {
            try {
                await agent.start();
                break;
            } catch (e) {
                const wait = Math.min(30, attempt * 3);
                console.warn(`[${agent.cfg.username}] can't reach Mattermost yet (${(e as Error).message}); retrying in ${wait}s`);
                await new Promise((r) => setTimeout(r, wait * 1000));
            }
        }
    }
}

type ActionRequest = {
    user_id: string;
    post_id: string;
    channel_id: string;
    context?: {secret?: string; action?: string; agent?: string};
};

function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let raw = '';
        req.on('data', (c) => {
            raw += c;
            if (raw.length > 1_000_000) {
                reject(new Error('body too large'));
                req.destroy();
            }
        });
        req.on('end', () => resolve(raw));
        req.on('error', reject);
    });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(body));
}

// Mattermost POSTs here when a decision card's button is clicked. The reply's
// "update" rewrites the card for everyone; then the agent follows up in the thread.
async function handleAction(req: ActionRequest, res: http.ServerResponse): Promise<void> {
    const ctx = req.context ?? {};
    if (ctx.secret !== config.secret) {
        return send(res, 403, {ephemeral_text: 'This button is not from this Captain bridge.'});
    }
    const agent = agents.find((a) => a.username === ctx.agent) ?? agents[0];
    const post = await agent.bot.api<Post>(`/posts/${req.post_id}`);
    const decision = post.props?.decision as Decision | undefined;
    if (!decision) {
        return send(res, 200, {ephemeral_text: 'This card has no decision attached.'});
    }
    if (decision.status !== 'pending') {
        return send(res, 200, {ephemeral_text: `Already ${decision.status}.`});
    }
    const updated: Decision = {...decision, status: ctx.action === 'approve' ? 'approved' : 'rejected', decided_by: req.user_id, decided_at: Date.now()};
    send(res, 200, {update: {message: post.message, props: {...post.props, decision: updated}}});
    const user = await agent.bot.getUser(req.user_id).catch(() => undefined);
    setTimeout(() => void agent.afterDecision(post, updated, user).catch((e) => console.error(e)), 400);
}

http.createServer(async (req, res) => {
    try {
        if (req.method === 'GET' && req.url === '/health') {
            return send(res, 200, {ok: true, agents: agents.map((a) => a.username), model: llmConfigured ? config.llm.model : null});
        }
        if (req.method === 'POST' && req.url === '/actions') {
            return await handleAction(JSON.parse(await readBody(req)) as ActionRequest, res);
        }
        send(res, 404, {error: 'not found'});
    } catch (e) {
        console.error(e);
        send(res, 500, {ephemeral_text: 'The Captain bridge hit an error. Try again.'});
    }
}).listen(config.port, () => {
    console.log(`Captain bridge on :${config.port} → Mattermost ${config.mattermostUrl}; model: ${llmConfigured ? config.llm.model : 'none (placeholder replies)'}`);
});

void startAgents();
