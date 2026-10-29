// System prompts. The "ROLE:" first lines tell the model (and the demo model)
// which job it is doing.

import type {AgentRow} from '../store/agents.js';
import type {ChannelRow} from '../store/channels.js';

export type Setting = {workspaceName: string; channel: ChannelRow; requesterName: string};

function where(s: Setting): string {
    const c = s.channel;
    if (c.type === 'D') {
        return `a direct message with ${s.requesterName}`;
    }
    if (c.type === 'G') {
        return 'a group message';
    }
    return `the #${c.name} channel${c.purpose ? ` (${c.purpose})` : ''}`;
}

function today(): string {
    return new Date().toISOString().slice(0, 10);
}

export function agentSystem(agent: AgentRow, s: Setting, toolNames: string[]): string {
    const lines = [
        agent.instructions,
        '',
        `Today is ${today()}. You are in ${where(s)} of the "${s.workspaceName}" workspace. ${s.requesterName} asked for this.`,
        'Messages from people are shown as "Name: message".',
    ];
    if (toolNames.length) {
        lines.push(`You can use these tools when they help: ${toolNames.join(', ')}. Don't describe a tool call; make it.`);
        if (toolNames.includes('send_email') || toolNames.includes('request_approval')) {
            lines.push('Sending or publishing anything outside the workspace always waits for a person to approve it.');
        }
    }
    return lines.join('\n');
}

export function roster(agents: AgentRow[]): string {
    return agents.map((a) => `- @${a.handle}: ${a.description || a.name}`).join('\n');
}

export function plannerSystem(captain: AgentRow, team: AgentRow[], s: Setting, maxSteps: number, named = false): string {
    if (named) {
        return [
            'ROLE: PLANNER',
            `You are ${captain.name}, coordinating AI agents in a group chat. The person asked for these agents by name, so split the work between them:`,
            roster(team),
            `Context: ${where(s)} of "${s.workspaceName}". Today is ${today()}.`,
            '',
            'Reply with a JSON object only:',
            `{"mode":"plan","goal":"one line","steps":[{"id":"s1","agent":"researcher","title":"Short title","instructions":"What to do and what to hand back","dependsOn":[]}]}`,
            `Give every agent listed at least one step, use no one else, and use 1 to ${maxSteps} steps. A step with no dependencies runs at the same time as the others; a step sees the outputs of the steps it depends on, so make a step depend on another when it builds on that work. Keep each step focused on that agent's strength. You'll combine their results into one answer afterwards.`,
        ].join('\n');
    }
    return [
        'ROLE: PLANNER',
        `You are ${captain.name}, coordinating a team of AI agents in a group chat. Decide how to handle the latest request.`,
        `Context: ${where(s)} of "${s.workspaceName}". Today is ${today()}.`,
        '',
        'The team:',
        roster(team),
        '',
        'Reply with a JSON object only.',
        '- {"mode":"direct"} when one agent can answer well in one go: questions, quick drafts, small talk, follow-ups.',
        `- {"mode":"plan","goal":"one line","steps":[{"id":"s1","agent":"researcher","title":"Short title","instructions":"What to do and what to hand back","dependsOn":[]}]} when the work has distinct parts that benefit from different specialists. Use 2 to ${maxSteps} steps.`,
        'Steps with no dependencies run at the same time; a step sees the outputs of the steps it depends on. Use only handles from the list. Put the step that produces the final deliverable last.',
    ].join('\n');
}

export function stepSystem(agent: AgentRow, s: Setting, toolNames: string[], goal: string, step: {title: string; instructions: string}): string {
    return [
        'ROLE: STEP',
        agentSystem(agent, s, toolNames),
        '',
        `You are doing one step of a plan the team is working on together. The overall goal: ${goal}`,
        `Your step: ${step.title}`,
        `Instructions: ${step.instructions}`,
        'Hand back only your part, complete and ready for the next teammate. Keep it focused.',
    ].join('\n');
}

export function synthesisSystem(captain: AgentRow, s: Setting, goal: string, results: {title: string; handle: string; output: string; failed: boolean}[]): string {
    return [
        'ROLE: SYNTHESIS',
        agentSystem(captain, s, []),
        '',
        `Your team just finished a plan for: ${goal}`,
        'Combine their work into one answer for the person. Lead with the result. Keep what matters, drop repetition, and point out anything that failed or still needs a decision. Don\'t list who did what unless it helps.',
        '',
        'Team results:',
        ...results.map((r) => `### ${r.title} (@${r.handle})${r.failed ? ' [failed]' : ''}\n${r.output.slice(0, 12_000)}`),
    ].join('\n');
}

export function classifierSystem(): string {
    return [
        'ROLE: CLASSIFIER',
        'Rate how demanding the request is for an AI model. Answer with one word:',
        'easy (chit-chat, lookups, short rewrites), balanced (writing, summaries, plans, ordinary analysis), or hard (deep reasoning, strategy, math, code, long documents).',
    ].join('\n');
}
