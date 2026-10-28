// One agent = one Mattermost bot account. It answers when @mentioned or
// DMed, replies in the thread, reads attached screenshots, and turns actions
// with outside effects into decision cards a person must approve.

import {type AgentConfig, config} from './config.ts';
import {type ChatMessage, type ChatPart, complete} from './llm.ts';
import {Bot, nameOf, type Post, type User} from './mattermost.ts';

export const DECISION_POST_TYPE = 'custom_captain_decision';

export type Decision = {
    title: string;
    reason: string;
    fields: {label: string; value: string}[];
    status: 'pending' | 'approved' | 'rejected';
    decided_by: string;
    decided_at: number;
};

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export class Agent {
    readonly bot: Bot;
    readonly cfg: AgentConfig;
    private users = new Map<string, User>();

    constructor(cfg: AgentConfig) {
        this.cfg = cfg;
        this.bot = new Bot(cfg.token);
    }

    get username() {
        return this.bot.me?.username ?? this.cfg.username;
    }

    async start(): Promise<void> {
        await this.bot.init();
        this.bot.listen((e) => {
            if (e.event === 'posted') {
                void this.onPosted(JSON.parse(e.data.post as string) as Post, String(e.data.channel_type ?? ''), String(e.data.channel_name ?? '')).catch((err) => console.error(`[${this.username}]`, err));
            }
        });
        console.log(`[${this.username}] listening`);
    }

    private async user(id: string): Promise<User | undefined> {
        if (!this.users.has(id)) {
            const u = await this.bot.getUser(id).catch(() => undefined);
            if (u) {
                this.users.set(id, u);
            }
        }
        return this.users.get(id);
    }

    private addressed(post: Post, channelType: string, channelName: string): boolean {
        if (channelType === 'D' && channelName.split('__').includes(this.bot.me.id)) {
            return true;
        }
        return new RegExp(`(^|\\W)@${this.username}\\b`, 'i').test(post.message);
    }

    private async onPosted(post: Post, channelType: string, channelName: string): Promise<void> {
        if (post.user_id === this.bot.me.id || post.type?.startsWith('system_')) {
            return;
        }
        const author = await this.user(post.user_id);
        // Agents don't answer agents, which keeps two bots from looping forever.
        if (author?.is_bot || !this.addressed(post, channelType, channelName)) {
            return;
        }
        const rootId = post.root_id || (channelType === 'D' ? '' : post.id);
        this.bot.typing(post.channel_id, rootId);
        const typing = setInterval(() => this.bot.typing(post.channel_id, rootId), 4000);
        try {
            const {messages, hasImages} = await this.buildPrompt(post, rootId);
            const reply = await complete(messages, {hasImages});
            await this.respond(post.channel_id, rootId, reply);
        } catch (e) {
            await this.bot.post({channel_id: post.channel_id, root_id: rootId, message: `I couldn't finish that: ${(e as Error).message}`});
        } finally {
            clearInterval(typing);
        }
    }

    private async buildPrompt(trigger: Post, rootId: string): Promise<{messages: ChatMessage[]; hasImages: boolean}> {
        const history = rootId ? await this.bot.thread(rootId) : await this.bot.recent(trigger.channel_id, 12);
        const messages: ChatMessage[] = [{role: 'system', content: this.cfg.instructions}];
        for (const p of history.filter((x) => x.id !== trigger.id).slice(-12)) {
            if (p.user_id === this.bot.me.id) {
                messages.push({role: 'assistant', content: p.message});
            } else if (p.message) {
                messages.push({role: 'user', content: `${nameOf(await this.user(p.user_id))}: ${p.message}`});
            }
        }
        const parts: ChatPart[] = [{type: 'text', text: `${nameOf(await this.user(trigger.user_id))}: ${trigger.message || '(sent an attachment)'}`}];
        let hasImages = false;
        for (const id of (trigger.file_ids ?? []).slice(0, 2)) {
            const file = await this.bot.file(id).catch(() => null);
            if (file && file.type.startsWith('image/') && file.data.length <= MAX_IMAGE_BYTES) {
                parts.push({type: 'image_url', image_url: {url: `data:${file.type};base64,${file.data.toString('base64')}`}});
                hasImages = true;
            }
        }
        messages.push({role: 'user', content: hasImages ? parts : (parts[0] as {text: string}).text});
        return {messages, hasImages};
    }

    // A reply that ends with "DECISION: {...}" becomes a decision card.
    private async respond(channelId: string, rootId: string, reply: string): Promise<void> {
        const match = reply.match(/\n?DECISION:\s*(\{[\s\S]*\})\s*$/);
        const text = match ? reply.slice(0, match.index).trim() : reply;
        if (match) {
            try {
                const d = JSON.parse(match[1]) as Partial<Decision>;
                await this.proposeDecision(channelId, rootId, text || 'I need your sign-off before I do this.', {
                    title: String(d.title ?? 'Approve this action'),
                    reason: String(d.reason ?? ''),
                    fields: Array.isArray(d.fields) ? d.fields.slice(0, 6).map((f) => ({label: String(f.label), value: String(f.value)})) : [],
                });
                return;
            } catch {
                // Not valid JSON: fall through and post the text as-is.
            }
        }
        await this.bot.post({channel_id: channelId, root_id: rootId, message: reply});
    }

    async proposeDecision(channelId: string, rootId: string, message: string, d: Pick<Decision, 'title' | 'reason' | 'fields'>): Promise<Post> {
        const button = (id: 'approve' | 'reject', name: string, style: string) => ({
            id, name, type: 'button', style,
            integration: {url: `${config.publicUrl}/actions`, context: {secret: config.secret, action: id, agent: this.username}},
        });
        return this.bot.post({
            channel_id: channelId,
            root_id: rootId,
            message,
            type: DECISION_POST_TYPE,
            props: {
                decision: {...d, status: 'pending', decided_by: '', decided_at: 0} satisfies Decision,
                attachments: [{actions: [button('approve', 'Approve', 'primary'), button('reject', 'Reject', 'default')]}],
            },
        });
    }

    async afterDecision(post: Post, decision: Decision, user: User | undefined): Promise<void> {
        const who = nameOf(user);
        const message = decision.status === 'approved' ?
            `Approved by ${who}. I've recorded it; carrying it out is the next step once Captain's backend is connected.` :
            `${who} rejected this, so I'm holding it. Tell me what to change.`;
        // In a DM, follow up in the conversation; in a channel, in the card's thread.
        const channel = await this.bot.getChannel(post.channel_id).catch(() => undefined);
        const rootId = channel?.type === 'D' ? post.root_id : post.root_id || post.id;
        await this.bot.post({channel_id: post.channel_id, root_id: rootId, message});
    }
}
