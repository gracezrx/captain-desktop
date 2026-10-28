// How hard is this request? Cheap heuristics first, in the spirit of
// Captain's router: a base tier per purpose, bumped up for long or
// demanding work, never below the base.

import type {Tier} from '../shared/types.js';

export const TIERS: Tier[] = ['easy', 'balanced', 'hard'];

const HARD = /\b(strateg|architect|analy[sz]|financ|model(l)?ing|forecast|valuation|legal|contract|prove|proof|debug|refactor|security|due diligence|trade-?offs?|in depth|deep dive|research report|investment|pricing strategy)/i;
const BALANCED = /\b(plan|compare|write|draft|summari[sz]e|explain|review|outline|research|email|proposal|announce|design|why|how)\b/i;
const SMALL_TALK = /^(hi|hey|hello|thanks|thank you|ok|okay|cool|great|nice|yes|no|lol|good morning|gm)[!. ]*$/i;
const CODE = /```|\bfunction\b|\bclass\b|=>|SELECT\s|\bimport\s/;

export function bump(tier: Tier, by = 1): Tier {
    return TIERS[Math.min(TIERS.length - 1, TIERS.indexOf(tier) + by)];
}

export function maxTier(...tiers: Tier[]): Tier {
    return TIERS[Math.max(...tiers.map((t) => TIERS.indexOf(t)))];
}

export function classifyDifficulty(text: string, base: Tier = 'easy'): Tier {
    const t = text.trim();
    let tier: Tier = 'easy';
    if (SMALL_TALK.test(t)) {
        tier = 'easy';
    } else if (HARD.test(t) || t.length > 6000) {
        tier = 'hard';
    } else if (BALANCED.test(t) || CODE.test(t) || t.length > 600 || (t.match(/\?/g)?.length ?? 0) > 2) {
        tier = 'balanced';
    }
    if (t.length > 24_000) {
        tier = bump(tier);
    }
    return maxTier(tier, base);
}
