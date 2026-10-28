// A per-key token bucket in memory (per server instance). Enough to stop a
// runaway client or a password-guessing script; put a shared limiter in
// front of the service if you run many instances.

export class RateLimiter {
    private buckets = new Map<string, {tokens: number; at: number}>();
    private readonly perMinute: number;

    constructor(perMinute: number) {
        this.perMinute = perMinute;
    }

    // true if allowed
    take(key: string, cost = 1): boolean {
        const t = Date.now();
        const b = this.buckets.get(key) ?? {tokens: this.perMinute, at: t};
        b.tokens = Math.min(this.perMinute, b.tokens + ((t - b.at) / 60_000) * this.perMinute);
        b.at = t;
        const ok = b.tokens >= cost;
        if (ok) {
            b.tokens -= cost;
        }
        this.buckets.set(key, b);
        if (this.buckets.size > 50_000) {
            for (const [k, v] of this.buckets) {
                if (t - v.at > 120_000) {
                    this.buckets.delete(k);
                }
            }
        }
        return ok;
    }
}
