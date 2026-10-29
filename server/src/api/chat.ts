// Channels, messages, threads, reactions, files and search.

import type {FastifyInstance} from 'fastify';
import {z} from 'zod';

import {channelRuns} from '../app/agents.js';
import * as channels from '../app/channels.js';
import * as files from '../app/files.js';
import * as posts from '../app/posts.js';
import {badRequest} from '../util/errors.js';

import type {Api} from '../server.js';

type P = {id: string; userId: string; emoji: string; action: string};

export function chatRoutes(app: FastifyInstance, api: Api): void {
    const {ctx} = api;
    const id = (req: {params: unknown}) => (req.params as P).id;

    // ---------------------------------------------------------- channels
    app.get('/workspaces/:id/channels', async (req) => channels.myChannels(ctx, req.user, id(req)));
    app.get('/workspaces/:id/channels/browse', async (req) => channels.browse(ctx, req.user, id(req)));
    app.post('/workspaces/:id/channels', async (req) => channels.create(ctx, req.user, id(req), req.body));
    app.post('/workspaces/:id/dms', async (req) => {
        const {userId} = z.object({userId: z.string()}).parse(req.body);
        return channels.directMessage(ctx, req.user, id(req), userId);
    });
    app.get('/workspaces/:id/search', async (req) => posts.search(ctx, req.user, id(req), String((req.query as {q?: string}).q ?? '')));

    app.get('/channels/:id', async (req) => channels.getOne(ctx, req.user, id(req)));
    app.patch('/channels/:id', async (req) => {
        const body = z.object({displayName: z.string().trim().min(1).max(64).optional(), purpose: z.string().trim().max(250).optional()}).parse(req.body);
        return channels.update(ctx, req.user, id(req), body);
    });
    app.delete('/channels/:id', async (req) => {
        await channels.archive(ctx, req.user, id(req));
        return {ok: true};
    });
    app.post('/channels/:id/join', async (req) => channels.join(ctx, req.user, id(req)));
    app.post('/channels/:id/leave', async (req) => {
        await channels.leave(ctx, req.user, id(req));
        return {ok: true};
    });
    app.get('/channels/:id/members', async (req) => channels.channelMembers(ctx, req.user, id(req)));
    app.post('/channels/:id/members', async (req) => {
        const {userIds} = z.object({userIds: z.array(z.string()).min(1).max(100)}).parse(req.body);
        await channels.addMembers(ctx, req.user, id(req), userIds);
        return {ok: true};
    });
    app.delete('/channels/:id/members/:userId', async (req) => {
        await channels.removeMember(ctx, req.user, id(req), (req.params as P).userId);
        return {ok: true};
    });
    app.post('/channels/:id/view', async (req) => {
        await channels.view(ctx, req.user, id(req));
        return {ok: true};
    });
    app.get('/channels/:id/runs', async (req) => channelRuns(ctx, req.user, id(req)));

    // ---------------------------------------------------------- messages
    app.get('/channels/:id/posts', async (req) => {
        const q = req.query as {before?: string; limit?: string};
        return posts.list(ctx, req.user, id(req), {before: q.before ? Number(q.before) : undefined, limit: q.limit ? Number(q.limit) : undefined});
    });
    app.post('/channels/:id/posts', {config: {cost: 2}}, async (req) => posts.create(ctx, req.user, id(req), req.body));
    app.get('/posts/:id', async (req) => posts.getOne(ctx, req.user, id(req)));
    app.get('/posts/:id/thread', async (req) => posts.thread(ctx, req.user, id(req)));
    app.patch('/posts/:id', async (req) => {
        const {message} = z.object({message: z.string()}).parse(req.body);
        return posts.edit(ctx, req.user, id(req), message);
    });
    app.delete('/posts/:id', async (req) => {
        await posts.remove(ctx, req.user, id(req));
        return {ok: true};
    });
    app.post('/posts/:id/reactions', async (req) => {
        const {emoji} = z.object({emoji: z.string()}).parse(req.body);
        await posts.react(ctx, req.user, id(req), emoji, true);
        return {ok: true};
    });
    app.delete('/posts/:id/reactions/:emoji', async (req) => {
        await posts.react(ctx, req.user, id(req), decodeURIComponent((req.params as P).emoji), false);
        return {ok: true};
    });
    app.post('/posts/:id/actions/:action', async (req) => posts.action(ctx, req.user, id(req), (req.params as P).action, req.body));

    // ---------------------------------------------------------- files
    app.post('/channels/:id/files', {config: {cost: 5}}, async (req) => {
        const file = await req.file();
        if (!file) {
            throw badRequest('Choose a file to upload.');
        }
        const info = await files.upload(ctx, req.user, id(req), {filename: file.filename, mimetype: file.mimetype, stream: file.file});
        if (file.file.truncated) {
            throw badRequest('That file is too large.', 'file_too_large');
        }
        return info;
    });

    // A signed link is the permission, so <img src> works without headers.
    app.get('/files/:id/content', {config: {public: true}}, async (req, reply) => {
        const q = req.query as {exp?: string; sig?: string; download?: string};
        const {file, stream, inline} = await files.openSigned(ctx, id(req), Number(q.exp), String(q.sig ?? ''));
        const disposition = inline && !q.download ? 'inline' : 'attachment';
        reply.header('Content-Type', inline ? file.mime : 'application/octet-stream');
        reply.header('Content-Length', String(file.size));
        reply.header('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(file.name)}`);
        reply.header('Cache-Control', 'private, max-age=3600');
        reply.header('Content-Security-Policy', 'sandbox; default-src \'none\'; img-src \'self\'; style-src \'unsafe-inline\'');
        return reply.send(stream);
    });
}
