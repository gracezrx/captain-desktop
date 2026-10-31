import type {FastifyInstance} from 'fastify';

import * as connections from '../app/connections.js';

import type {Api} from '../server.js';

type P = {id: string; toolkit: string};

// Settings → Connections (see app/connections.ts).
export function connectionRoutes(app: FastifyInstance, api: Api): void {
    const {ctx} = api;

    app.get('/workspaces/:id/connections', async (req) => connections.listConnections(ctx, req.user, (req.params as P).id));

    app.post('/workspaces/:id/connections/:toolkit', {config: {cost: 5}}, async (req) => {
        const p = req.params as P;
        return connections.connect(ctx, req.user, p.id, p.toolkit);
    });

    app.delete('/workspaces/:id/connections/:toolkit', async (req) => {
        const p = req.params as P;
        await connections.disconnect(ctx, req.user, p.id, p.toolkit);
        return {ok: true};
    });

    // The server's Composio key, for the people who run it.
    app.put('/admin/connector-key', {config: {cost: 10}}, async (req) => {
        await connections.saveComposioKey(ctx, req.user, req.body, req.ip);
        return {ok: true};
    });

    app.delete('/admin/connector-key', async (req) => {
        await connections.removeComposioKey(ctx, req.user, req.ip);
        return {ok: true};
    });
}
