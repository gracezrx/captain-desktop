// Where a spoken request goes, picked from what you said: a chat you named
// ("…in the launch room", "#design") and the agents you named ("have Writer…").
// Shown live on the talk card, so you can see it before you let go.
//
// - A chat named: the message goes there, mentioning the agents named (or
//   @captain if none).
// - No chat, one agent: your direct message with that agent.
// - No chat, several agents or none: your direct message with Captain (who
//   works with just the agents you named).

export type DirectoryAgent = {id: string; userId: string; handle: string; name: string; portrait: string | null; isCoordinator: boolean};
export type DirectoryChannel = {id: string; name: string};
export type OrbDirectory = {channels: DirectoryChannel[]; agents: DirectoryAgent[]};

export type Route = {
    channel: DirectoryChannel | null; // null: a direct message
    agents: DirectoryAgent[]; // named specialists (not Captain)
    dmWith: DirectoryAgent | null; // who the direct message is with, when there's no chat
    reply?: {rootId: string | null}; // a reply in that chat (to this thread), from "Reply by voice"
};

// Channel names that are also everyday words need "#", "channel", "room" or
// "chat" next to them ("in general" alone isn't a chat).
const EVERYDAY = new Set(['general', 'random', 'team', 'all', 'news', 'updates', 'design', 'research', 'launch', 'ops', 'help', 'support', 'sales', 'marketing', 'product', 'engineering', 'fun', 'social']);

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function words(s: string): string {
    return s.toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// How strongly the text names this channel: 0 = not at all. Only a clear
// cue counts, so a private request doesn't land in a shared channel because
// a word matched: "#design", "the design channel", a name that is itself a
// room ("the launch room"), or "post / share / send … in <name>".
function channelScore(text: string, name: string): number {
    const n = words(name);
    if (!n) {
        return 0;
    }
    const t = words(text);
    const body = n.split(' ').map(esc).join('\\s+');
    if (new RegExp(`#\\s*${body}\\b`).test(t)) {
        return 4 + n.length;
    }
    if (new RegExp(`\\b${body}\\s+(?:channel|room|chat|thread)\\b`).test(t)) {
        return 3 + n.length;
    }
    if (n.includes(' ') && /\b(?:room|channel|chat)$/.test(n) && new RegExp(`\\b${body}\\b`).test(t)) {
        return 2 + n.length;
    }
    if (!EVERYDAY.has(n) && new RegExp(`\\b(?:post|share|send|drop|put|announce)\\b[^.?!]{0,40}?\\b(?:in|to|into|with)\\s+(?:the\\s+|our\\s+)?${body}\\b`).test(t)) {
        return 1 + n.length;
    }
    return 0;
}

function namesAgent(text: string, agent: DirectoryAgent): boolean {
    const t = words(text);
    const options = [...new Set([agent.handle, agent.name].map(words).filter((x) => x.length >= 3))];
    return options.some((o) => new RegExp(`(?:^|[^a-z0-9])@?${o.split(' ').map(esc).join('\\s+')}(?:s|'s)?\\b`).test(t));
}

export function routeFor(text: string, dir: OrbDirectory): Route {
    let channel: DirectoryChannel | null = null;
    let best = 0;
    for (const c of dir.channels) {
        const score = channelScore(text, c.name);
        if (score > best) {
            best = score;
            channel = c;
        }
    }
    const named = dir.agents.filter((a) => namesAgent(text, a));
    const agents = named.filter((a) => !a.isCoordinator);
    const captain = dir.agents.find((a) => a.isCoordinator) ?? null;
    // Naming Captain too ("Captain, have Writer…") keeps it with Captain.
    const dmWith = channel ? null : agents.length === 1 && !named.some((a) => a.isCoordinator) ? agents[0] : captain;
    return {channel, agents, dmWith};
}

// The message to post: the agents mentioned up front, unless already there.
export function messageFor(text: string, route: Route, dir: OrbDirectory): string {
    const mention = (a: DirectoryAgent) => (new RegExp(`@${esc(a.handle)}\\b`, 'i').test(text) ? '' : `@${a.handle} `);
    if (route.channel) {
        const who = route.agents.length ? route.agents : dir.agents.filter((a) => a.isCoordinator);
        return `${who.map(mention).join('')}${text}`.trim();
    }
    if (route.dmWith && !route.dmWith.isCoordinator) {
        return text; // your DM with that agent: it answers
    }
    // Captain's DM: naming two or more agents makes Captain work with just them.
    return `${route.agents.map(mention).join('')}${text}`.trim();
}
