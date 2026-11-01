// Demo mode: a stand-in model used when no provider key is configured (and
// in tests). It follows the same protocol as a real model, including
// streaming, tool calls and planning JSON, so every part of the product can
// be clicked through before keys are added. Replies say they are demo replies.

import type {CallOptions, CallResult, ChatMessage, ContentPart, ToolCall} from './types.js';

const NOTE = '\n\n_Demo mode: add a model key in Settings → Models for real answers._';

function textOf(m: ChatMessage | undefined): string {
    if (!m || m.content === null) {
        return '';
    }
    if (typeof m.content === 'string') {
        return m.content;
    }
    return (m.content as ContentPart[]).filter((p) => p.type === 'text').map((p) => (p as {text: string}).text).join('\n');
}

function hasImage(m: ChatMessage | undefined): boolean {
    return Boolean(m && Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));
}

function roster(system: string): {handle: string; description: string}[] {
    return [...system.matchAll(/^- @([a-z0-9._-]+): (.+)$/gim)].map((m) => ({handle: m[1], description: m[2]}));
}

function call(name: string, args: Record<string, unknown>): ToolCall {
    return {id: `demo_${name}_${Math.random().toString(36).slice(2, 8)}`, type: 'function', function: {name, arguments: JSON.stringify(args)}};
}

function request(messages: ChatMessage[]): string {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    return textOf(lastUser).replace(/^[^:\n]{1,40}:\s*/, '').replace(/^(@[a-z0-9._-]+[\s,]*)+/i, '').trim();
}

function plan(system: string, ask: string): string {
    const team = roster(system).filter((r) => r.handle !== 'captain');
    const has = (h: string) => team.some((t) => t.handle === h);
    const big = ask.length > 70 || /\b(plan|launch|strategy|research|compare|campaign|report|proposal|and then|steps)\b/i.test(ask);
    if (!big || team.length < 2) {
        return JSON.stringify({mode: 'direct'});
    }
    const steps: {id: string; agent: string; title: string; instructions: string; dependsOn: string[]}[] = [];
    const research = has('researcher') ? 'researcher' : team[0].handle;
    steps.push({id: 's1', agent: research, title: 'Gather the facts', instructions: `Collect the key facts, numbers and examples needed for: ${ask}`, dependsOn: []});
    if (has('analyst')) {
        steps.push({id: 's2', agent: 'analyst', title: 'Weigh the options', instructions: `Using the facts, compare the main options and recommend one for: ${ask}`, dependsOn: ['s1']});
    }
    const writer = has('writer') ? 'writer' : team[team.length - 1].handle;
    steps.push({id: `s${steps.length + 1}`, agent: writer, title: 'Draft the deliverable', instructions: `Write the final deliverable for: ${ask}`, dependsOn: steps.map((s) => s.id)});
    return JSON.stringify({mode: 'plan', goal: ask.slice(0, 140), steps});
}

function short(text: string, max: number): string {
    if (text.length <= max) {
        return text;
    }
    const cut = text.slice(0, max);
    return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max / 2))}…`;
}

function reply(system: string, messages: ChatMessage[], ask: string): string {
    const lastToolResult = messages.at(-1)?.role === 'tool' ? textOf(messages.at(-1)) : '';
    if (lastToolResult) {
        if (/rejected/i.test(lastToolResult)) {
            return `Understood, I won't do that. Tell me what you'd like to change.${NOTE}`;
        }
        if (/nothing was sent/i.test(lastToolResult)) {
            return `Approved, but this server has no email account yet (\`SMTP_URL\`), so nothing was sent. Copy the draft above and send it yourself.${NOTE}`;
        }
        if (/^Created "/.test(lastToolResult)) {
            const kind = /\.pptx"/.test(lastToolResult) ? 'deck' : /\.xlsx"/.test(lastToolResult) ? 'spreadsheet' : 'document';
            const google = /Also made it in (Google [A-Za-z]+)/.exec(lastToolResult)?.[1];
            return `Here's a first draft of the ${kind}${google ? `, also in ${google}` : ''}.${NOTE}`;
        }
        return `Done. ${lastToolResult.slice(0, 300)}${NOTE}`;
    }
    if (/ROLE: SYNTHESIS/.test(system)) {
        const parts = [...system.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
        return [
            `Here's where the team landed on **${short(ask, 80)}**:`,
            '',
            ...parts.map((p) => `- **${p}**: covered above in the thread.`),
            '',
            'Recommended next step: review the draft and approve anything that needs sending.',
        ].join('\n') + NOTE;
    }
    if (/ROLE: STEP/.test(system)) {
        const title = system.match(/Your step: (.+)/)?.[1] ?? 'This step';
        return [
            `**${title}**`,
            '',
            `- Main point for "${short(ask, 60)}": start with the outcome people care about most.`,
            '- Supporting detail: two or three concrete examples make it credible.',
            '- Open question: who signs off before anything goes out?',
        ].join('\n') + NOTE;
    }
    const name = system.match(/You are ([A-Z][a-z]+)/)?.[1] ?? 'Captain';
    if (/^(hi|hey|hello|thanks|thank you)\b/i.test(ask)) {
        return `Hi! I'm ${name}. Ask me anything, or mention @captain with a bigger task and I'll bring in the team.${NOTE}`;
    }
    return `Here's a first take on "${short(ask, 120)}":\n\n- Start from the outcome you want and who it's for.\n- Pick the one or two moves that matter most this week.\n- I can turn this into a plan with the other agents: mention @captain.${NOTE}`;
}

export async function demoCompletion(opts: CallOptions): Promise<CallResult> {
    const system = opts.messages.filter((m) => m.role === 'system').map((m) => textOf(m)).join('\n');
    const ask = request(opts.messages);
    const tools = new Set((opts.tools ?? []).map((t) => t.function.name));
    const last = opts.messages.at(-1);
    const image = hasImage([...opts.messages].reverse().find((m) => m.role === 'user'));

    let text = '';
    const toolCalls: ToolCall[] = [];

    if (/ROLE: CLASSIFIER/.test(system)) {
        text = ask.length > 400 ? 'hard' : ask.length > 80 ? 'balanced' : 'easy';
    } else if (/ROLE: PLANNER/.test(system)) {
        text = plan(system, ask);
    } else if (last?.role === 'user' && /\b(send|email|publish|post it|announce to)\b/i.test(ask) && (tools.has('send_email') || tools.has('request_approval'))) {
        text = 'I\'ll get your sign-off before sending.';
        toolCalls.push(tools.has('send_email') ?
            call('send_email', {to: 'team@example.com', subject: 'Update from Captain', body: `Hi team,\n\n${ask}\n\nBest,\nCaptain`}) :
            call('request_approval', {title: `Send: ${ask.slice(0, 60)}`, reason: 'This goes outside the workspace.', action: ask.slice(0, 200)}));
    } else if (last?.role === 'tool' && /asked for a change: "/.test(textOf(last)) && tools.has('send_email')) {
        // "Change it": redo the draft that way and ask again.
        const change = textOf(last).match(/asked for a change: "([^"]*)"/)?.[1] ?? '';
        text = `Changed it (${change}). Here it is again for your OK.`;
        toolCalls.push(call('send_email', {to: 'team@example.com', subject: 'Update from Captain (revised)', body: `Hi team,\n\n${ask}\n\n(${change})\n\nBest,\nCaptain`}));
    } else if (last?.role === 'user' && /\b(deck|slides|presentation|pitch)\b/i.test(ask) && tools.has('create_presentation') && !/ROLE: SYNTHESIS/.test(system)) {
        text = 'Making the deck.';
        toolCalls.push(call('create_presentation', {title: ask.slice(0, 60) || 'Deck', subtitle: 'A first draft prepared in demo mode', slides: [
            {layout: 'title'},
            {layout: 'bullets', kicker: 'Why now', title: 'Teams already work with AI in their chats', bullets: ['**3 in 4** teams paste AI answers into chat', 'Context gets lost between tools', 'Approvals happen in side threads']},
            {layout: 'stats', kicker: 'Early signal', title: 'Pilots are using it every day', stats: [{value: '12', label: 'Pilot teams'}, {value: '4.6', label: 'Runs per person a day'}, {value: '91%', label: 'Weekly retention'}]},
            {layout: 'chart', kicker: 'Usage', title: 'Runs doubled in four weeks', chart: {type: 'bar', categories: ['Week 1', 'Week 2', 'Week 3', 'Week 4'], series: [{name: 'Runs', values: [180, 240, 310, 390]}]}, takeaway: 'Most growth came from new agents, not new people.'},
            {layout: 'closing', title: 'Next steps', bullets: ['Review the draft', 'Fill in real numbers']},
        ]}));
    } else if (last?.role === 'user' && /\b(spreadsheet|sheet|budget|tracker|table)\b/i.test(ask) && tools.has('create_spreadsheet') && !/ROLE: SYNTHESIS/.test(system)) {
        text = 'Building the sheet.';
        toolCalls.push(call('create_spreadsheet', {title: ask.slice(0, 60) || 'Spreadsheet', sheets: [{
            name: 'Plan', title: ask.slice(0, 80) || 'Plan', note: 'A first draft prepared in demo mode',
            columns: [{header: 'Item'}, {header: 'Owner'}, {header: 'Cost', type: 'currency'}, {header: 'Due', type: 'date'}],
            rows: [['Kickoff', 'Grace', 1200, '2026-11-03'], ['Design', 'Mia', 3400, '2026-11-10'], ['Launch', 'Captain', 800, '2026-11-17']],
            totals: true,
        }]}));
    } else if (last?.role === 'user' && /\b(document|doc|write-?up|one-?pager|report|brief|memo|plan)\b/i.test(ask) && tools.has('create_document') && !/ROLE: SYNTHESIS/.test(system)) {
        text = 'Drafting the document.';
        toolCalls.push(call('create_document', {title: ask.slice(0, 60) || 'Draft', subtitle: 'A first draft prepared in demo mode', markdown: `## Summary\n\n${ask.slice(0, 300)}\n\n## What we know\n\n| Area | Status |\n|---|---|\n| Goal | Agreed |\n| Owner | To confirm |\n\n## Next steps\n\n- Review\n- Approve\n`}));
    } else {
        text = (image ? 'I can see the screenshot you shared. ' : '') + reply(system, opts.messages, ask);
    }

    // Stream it like a real model.
    if (opts.onText && text && !toolCalls.length && !/ROLE: (PLANNER|CLASSIFIER)/.test(system)) {
        let shown = '';
        for (let i = 0; i < text.length; i += 14) {
            if (opts.signal?.aborted) {
                break;
            }
            shown = text.slice(0, i + 14);
            opts.onText(shown);
            await new Promise((r) => setTimeout(r, 12));
        }
    }
    return {
        text: toolCalls.length ? '' : text,
        toolCalls,
        tokensIn: Math.ceil(JSON.stringify(opts.messages).length / 4),
        tokensOut: Math.ceil(text.length / 4),
        finishReason: toolCalls.length ? 'tool_calls' : 'stop',
    };
}
