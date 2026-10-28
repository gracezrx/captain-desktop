// Server configuration, all from environment variables (see .env.example).

import {randomBytes} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// When compiled, this file lives in dist/src; step back out of dist.
const SERVER_DIR = path.basename(ROOT) === 'dist' ? path.dirname(ROOT) : ROOT;

function env(name: string, fallback = ''): string {
    return (process.env[name] ?? fallback).trim();
}

function int(name: string, fallback: number): number {
    const v = Number(env(name));
    return Number.isFinite(v) && env(name) !== '' ? v : fallback;
}

function bool(name: string, fallback: boolean): boolean {
    const v = env(name).toLowerCase();
    return v === '' ? fallback : ['1', 'true', 'yes', 'on'].includes(v);
}

const production = env('NODE_ENV') === 'production';
const secret = env('APP_SECRET');
if (production && secret.length < 32) {
    throw new Error('Set APP_SECRET to a random string of at least 32 characters (it signs file links).');
}

export const config = {
    production,
    port: int('PORT', 8080),
    host: env('HOST', '0.0.0.0'),
    // The address people use to reach the server; used in invite links.
    publicUrl: env('PUBLIC_URL', `http://localhost:${int('PORT', 8080)}`).replace(/\/+$/, ''),
    databaseUrl: env('DATABASE_URL', 'postgres://postgres@127.0.0.1:5432/captain'),
    databasePoolSize: int('DATABASE_POOL_SIZE', 10),
    appSecret: secret || randomBytes(32).toString('hex'),
    // Origins allowed to call the API from a browser (the Mac app's and the dev server's).
    corsOrigins: env('CORS_ORIGINS', 'tauri://localhost,http://tauri.localhost,http://localhost:1420,http://127.0.0.1:1420').split(',').map((s) => s.trim()).filter(Boolean),
    // Anyone can sign up and create a workspace, or only people with an invite link.
    openSignup: bool('OPEN_SIGNUP', true),
    sessionDays: int('SESSION_DAYS', 30),
    files: {
        dir: env('FILES_DIR', path.join(SERVER_DIR, 'data', 'files')),
        maxBytes: int('MAX_UPLOAD_MB', 25) * 1024 * 1024,
        linkMinutes: int('FILE_LINK_MINUTES', 60 * 24),
    },
    // The built web app (desktop/dist), served at / so testers need no install.
    webDist: env('WEB_DIST', path.join(SERVER_DIR, '..', 'desktop', 'dist')),
    llm: {
        modelsFile: env('MODELS_FILE', path.join(SERVER_DIR, 'config', 'models.json')),
        // With no provider key configured, agents answer in demo mode.
        demoWhenUnconfigured: bool('LLM_DEMO_FALLBACK', true),
        requestTimeoutMs: int('LLM_TIMEOUT_MS', 120_000),
        // Ask a cheap model to rate difficulty when the heuristics are unsure.
        llmClassifier: bool('ROUTER_LLM_CLASSIFIER', false),
    },
    agents: {
        maxParallelSteps: int('AGENT_MAX_PARALLEL', 3),
        maxSteps: int('AGENT_MAX_PLAN_STEPS', 6),
        maxToolRounds: int('AGENT_MAX_TOOL_ROUNDS', 6),
    },
    workers: {
        enabled: bool('WORKERS', true),
        concurrency: int('WORKER_CONCURRENCY', 4),
        leaseSeconds: int('JOB_LEASE_SECONDS', 90),
    },
    tools: {
        tavilyKey: env('TAVILY_API_KEY'),
        braveKey: env('BRAVE_SEARCH_API_KEY'),
        smtpUrl: env('SMTP_URL'), // e.g. smtps://user:pass@smtp.example.com:465
        mailFrom: env('MAIL_FROM'),
    },
    rateLimit: {
        perMinute: int('RATE_LIMIT_PER_MINUTE', 600),
        authPerMinute: int('AUTH_RATE_LIMIT_PER_MINUTE', 20),
    },
    logLevel: env('LOG_LEVEL', production ? 'info' : 'debug'),
    serverDir: SERVER_DIR,
};

export type Config = typeof config;
