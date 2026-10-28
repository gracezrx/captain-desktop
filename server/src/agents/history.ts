// What an agent sees of the conversation:
// - in a thread: the thread up to the message that asked
// - in a direct message: the recent conversation
// - at the top of a channel: the last few messages, then the request
// Its own messages are "assistant" turns; everyone else's are "Name: text".
// Images on recent messages are passed to vision models; text files are inlined.

import type {Ctx} from '../app/context.js';
import type {ChatMessage, ContentPart} from '../llm/types.js';
import type {ChannelRow} from '../store/channels.js';
import {getFiles} from '../store/files.js';
import {listChannelPosts, listThread, type PostRow} from '../store/posts.js';
import {getUsers} from '../store/users.js';

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_TEXT_FILE_CHARS = 20_000;
const IMAGE = /^image\/(png|jpeg|gif|webp)$/;
const TEXT = /^(text\/|application\/(json|xml|csv|x-yaml|yaml))/;

export type Conversation = {messages: ChatMessage[]; text: string; hasImages: boolean};

function describe(p: PostRow): string {
    if (p.type === 'plan' && p.props.plan) {
        return `[Plan: ${p.props.plan.goal} (${p.props.plan.status})]`;
    }
    if (p.type === 'decision' && p.props.decision) {
        return `[Approval request: ${p.props.decision.title} (${p.props.decision.status})]`;
    }
    return p.message;
}

async function sources(ctx: Ctx, channel: ChannelRow, trigger: PostRow): Promise<{earlier: PostRow[]; contextOnly: boolean}> {
    if (trigger.rootId) {
        const thread = await listThread(ctx.sql, trigger.rootId);
        return {earlier: thread.filter((p) => p.createdAt < trigger.createdAt || (p.createdAt === trigger.createdAt && p.id !== trigger.id)).slice(-40), contextOnly: false};
    }
    if (channel.type === 'D' || channel.type === 'G') {
        const recent = (await listChannelPosts(ctx.sql, channel.id, {before: trigger.createdAt, limit: 24})).reverse();
        return {earlier: recent.filter((p) => !p.rootId), contextOnly: false};
    }
    // Top of a channel: recent messages are background, not a conversation with the agent.
    const recent = (await listChannelPosts(ctx.sql, channel.id, {before: trigger.createdAt, limit: 10})).reverse();
    return {earlier: recent.filter((p) => trigger.createdAt - p.createdAt < 6 * 3_600_000), contextOnly: true};
}

export async function attachmentsFor(ctx: Ctx, posts: PostRow[], withImages: boolean): Promise<Map<string, {images: string[]; texts: string[]}>> {
    const out = new Map<string, {images: string[]; texts: string[]}>();
    const files = await getFiles(ctx.sql, [...new Set(posts.flatMap((p) => p.fileIds ?? []))]);
    let textBudget = MAX_TEXT_FILE_CHARS * 2;
    for (const f of files) {
        if (!f.postId) {
            continue;
        }
        const entry = out.get(f.postId) ?? {images: [], texts: []};
        if (withImages && IMAGE.test(f.mime) && f.size <= MAX_IMAGE_BYTES) {
            const data = await ctx.storage.read(f.storageKey).catch(() => null);
            if (data) {
                entry.images.push(`data:${f.mime};base64,${data.toString('base64')}`);
            }
        } else if ((TEXT.test(f.mime) || /\.(md|txt|csv|json|ya?ml|html?)$/i.test(f.name)) && textBudget > 0) {
            const data = await ctx.storage.read(f.storageKey).catch(() => null);
            if (data) {
                const text = data.toString('utf8').slice(0, Math.min(MAX_TEXT_FILE_CHARS, textBudget));
                textBudget -= text.length;
                entry.texts.push(`[Attached file "${f.name}"]\n${text}`);
            }
        } else {
            entry.texts.push(`[Attached file "${f.name}" (${f.mime}), not readable here]`);
        }
        out.set(f.postId, entry);
    }
    return out;
}

export async function conversation(ctx: Ctx, channel: ChannelRow, trigger: PostRow, agentUserId: string): Promise<Conversation> {
    const {earlier, contextOnly} = await sources(ctx, channel, trigger);
    const all = [...earlier, trigger];
    const users = new Map((await getUsers(ctx.sql, [...new Set(all.map((p) => p.userId))])).map((u) => [u.id, u]));
    // Images from the request and the two messages before it.
    const imagePosts = new Set(all.slice(-3).map((p) => p.id));
    const attachments = await attachmentsFor(ctx, all, true);
    let hasImages = false;

    const name = (p: PostRow) => {
        const u = users.get(p.userId);
        return u ? `${u.displayName}${u.isBot ? ' (agent)' : ''}` : 'Someone';
    };
    const userTurn = (p: PostRow, prefix = ''): ChatMessage => {
        const files = attachments.get(p.id);
        const text = [`${prefix}${name(p)}: ${describe(p)}`, ...(files?.texts ?? [])].join('\n\n');
        const images = imagePosts.has(p.id) ? files?.images ?? [] : [];
        if (!images.length) {
            return {role: 'user', content: text};
        }
        hasImages = true;
        const parts: ContentPart[] = [{type: 'text', text}, ...images.map((url): ContentPart => ({type: 'image_url', image_url: {url}}))];
        return {role: 'user', content: parts};
    };

    const messages: ChatMessage[] = [];
    if (contextOnly) {
        const background = earlier.filter((p) => describe(p).trim()).map((p) => `${name(p)}: ${describe(p).slice(0, 1500)}`);
        if (background.length) {
            messages.push({role: 'user', content: `(Recent messages in #${channel.name}, for context)\n${background.join('\n')}`});
            messages.push({role: 'assistant', content: 'Noted.'});
        }
    } else {
        for (const p of earlier) {
            if (!describe(p).trim() && !(p.fileIds ?? []).length) {
                continue;
            }
            if (p.userId === agentUserId && p.type !== 'decision') {
                messages.push({role: 'assistant', content: p.message});
            } else {
                messages.push(userTurn(p));
            }
        }
    }
    messages.push(userTurn(trigger));
    return {messages, text: trigger.message, hasImages};
}

// For saving a transcript: drop image data (it can be megabytes), keep a marker.
export function withoutImageData(messages: ChatMessage[]): ChatMessage[] {
    return messages.map((m) => (m.role === 'user' && Array.isArray(m.content) ?
        {role: 'user', content: m.content.map((p) => (p.type === 'image_url' ? {type: 'text', text: '[an image was shared here]'} : p))} :
        m));
}
