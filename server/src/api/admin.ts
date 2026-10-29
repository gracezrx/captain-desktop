import type {FastifyInstance} from 'fastify';

import * as admin from '../app/admin.js';

import type {Api} from '../server.js';

type P = {id: string};

// Server settings for the people who run it (see app/admin.ts).
export function adminRoutes(app: FastifyInstance, api: Api): void {
    const {ctx} = api;

    app.get('/admin/providers', async (req) => admin.listProviders(ctx, req.user));

    app.put('/admin/providers/:id', async (req) => admin.saveProviderKey(ctx, req.user, (req.params as P).id, req.body, req.ip));

    app.delete('/admin/providers/:id', async (req) => {
        await admin.removeProviderKey(ctx, req.user, (req.params as P).id, req.ip);
        return {ok: true};
    });

    // Sends a real (tiny) model request, so it counts as ten requests against the rate limit.
    app.post('/admin/providers/:id/check', {config: {cost: 10}}, async (req) => admin.checkProvider(ctx, req.user, (req.params as P).id));
}
