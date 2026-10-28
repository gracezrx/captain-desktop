// The model catalog: providers (where to send a request, with which key) and
// models (tier, priority, price, capabilities, and the provider routes that
// serve them). Loaded from config/models.json; keys come from environment
// variables, so the same file works everywhere.

import fs from 'node:fs';

import {config} from '../config.js';
import type {ModelInfo, Tier} from '../shared/types.js';

export type ProviderCfg = {label: string; baseUrl?: string; baseUrlEnv?: string; apiKeyEnv: string; headers?: Record<string, string>};
export type ModelCfg = {
    id: string;
    label: string;
    vendor: string;
    tier: Tier;
    priority: number;
    vision: boolean;
    tools: boolean;
    priceInPerM: number;
    priceOutPerM: number;
    routes: [string, string][]; // [provider id, model name at that provider]
};

export type Route = {model: ModelCfg; providerId: string; upstream: string; baseUrl: string; apiKey: string; headers?: Record<string, string>};

export const DEMO_MODEL: ModelCfg = {
    id: 'demo', label: 'Demo (no model key set)', vendor: 'Captain', tier: 'easy', priority: 0, vision: true, tools: true,
    priceInPerM: 0, priceOutPerM: 0, routes: [],
};

export class Catalog {
    readonly providers: Record<string, ProviderCfg>;
    readonly models: ModelCfg[];

    constructor(data: {providers: Record<string, ProviderCfg>; models: ModelCfg[]}) {
        this.providers = data.providers;
        this.models = data.models;
    }

    static load(file = config.llm.modelsFile): Catalog {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        return new Catalog({providers: raw.providers ?? {}, models: raw.models ?? []});
    }

    // Provider credentials, read on each call so a key added to the
    // environment is used on the next restart without touching the file.
    private endpoint(providerId: string): {baseUrl: string; apiKey: string; headers?: Record<string, string>} | null {
        const p = this.providers[providerId];
        if (!p) {
            return null;
        }
        const apiKey = (process.env[p.apiKeyEnv] ?? '').trim();
        const baseUrl = (p.baseUrl ?? (p.baseUrlEnv ? process.env[p.baseUrlEnv] ?? '' : '')).trim();
        return apiKey && baseUrl ? {baseUrl, apiKey, headers: p.headers} : null;
    }

    routesFor(model: ModelCfg): Route[] {
        const out: Route[] = [];
        for (const [providerId, upstream] of model.routes) {
            const ep = this.endpoint(providerId);
            if (ep) {
                out.push({model, providerId, upstream, ...ep});
            }
        }
        return out;
    }

    get(id: string): ModelCfg | undefined {
        return this.models.find((m) => m.id === id);
    }

    available(): ModelCfg[] {
        return this.models.filter((m) => this.routesFor(m).length > 0);
    }

    anyConfigured(): boolean {
        return this.available().length > 0;
    }

    info(health: (modelId: string) => {healthy: boolean; lastError: string | null}): ModelInfo[] {
        return this.models.map((m) => {
            const routes = this.routesFor(m);
            const h = health(m.id);
            return {
                id: m.id,
                provider: routes[0]?.providerId ?? m.routes[0]?.[0] ?? '',
                label: m.label,
                tiers: [m.tier],
                vision: m.vision,
                tools: m.tools,
                priceInPerM: m.priceInPerM,
                priceOutPerM: m.priceOutPerM,
                configured: routes.length > 0,
                healthy: h.healthy,
                lastError: h.lastError,
            };
        });
    }
}

export function costUsd(model: ModelCfg, tokensIn: number, tokensOut: number): number {
    return (tokensIn * model.priceInPerM + tokensOut * model.priceOutPerM) / 1_000_000;
}
