// Hooks around the core, the way Mattermost's plugins see messages:
// - beforePostSave can rewrite a draft or reject it before it's stored
// - afterPostSave runs after the post is stored and delivered (agents start here)
// - postAction handles a button click on a message (decision cards)

import type {Db} from '../db/index.js';
import type {ChannelRow} from '../store/channels.js';
import type {PostRow} from '../store/posts.js';
import type {UserRow} from '../store/users.js';
import {log} from '../util/log.js';

export type Draft = {message: string; props: Record<string, unknown>; channel: ChannelRow; author: UserRow; rootId: string | null};
export type SavedPost = {post: PostRow; channel: ChannelRow; author: UserRow; mentions: string[]};
export type PostAction = {post: PostRow; action: string; user: UserRow};

type Before = (draft: Draft) => Promise<Draft | {reject: string}>;
type After = (saved: SavedPost) => Promise<void>;
type ActionHandler = (db: Db, a: PostAction) => Promise<void>;

export class Hooks {
    private before: Before[] = [];
    private after: After[] = [];
    private actions = new Map<string, ActionHandler>(); // post type -> handler

    beforePostSave(fn: Before): void {
        this.before.push(fn);
    }

    afterPostSave(fn: After): void {
        this.after.push(fn);
    }

    onPostAction(postType: string, fn: ActionHandler): void {
        this.actions.set(postType, fn);
    }

    async runBefore(draft: Draft): Promise<Draft | {reject: string}> {
        let current = draft;
        for (const fn of this.before) {
            const r = await fn(current);
            if ('reject' in r) {
                return r;
            }
            current = r;
        }
        return current;
    }

    // Fire-and-forget: a slow or failing hook never delays the sender.
    runAfter(saved: SavedPost): void {
        for (const fn of this.after) {
            fn(saved).catch((err) => log.error({err, post: saved.post.id}, 'afterPostSave hook failed'));
        }
    }

    actionHandler(postType: string): ActionHandler | undefined {
        return this.actions.get(postType);
    }
}
