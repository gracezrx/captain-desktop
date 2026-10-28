// The API contract between the Captain server and its clients (the Mac app
// and the web app). Types only: clients import this file with `import type`.
//
// Conventions (borrowed from Mattermost): 26-character random IDs,
// timestamps in Unix milliseconds, soft deletes via deletedAt.

export type ID = string;
export type Ms = number;

export type Tier = 'easy' | 'balanced' | 'hard';
export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'guest';
export type ChannelType = 'O' | 'P' | 'D' | 'G'; // open, private, direct, group

export type User = {
    id: ID;
    username: string;
    displayName: string;
    email?: string; // only on your own profile and for admins
    isBot: boolean;
    agentId: ID | null;
    portrait: string | null; // agent portrait name, e.g. "fox"
    createdAt: Ms;
};

export type Workspace = {
    id: ID;
    name: string;
    slug: string;
    createdAt: Ms;
    role: WorkspaceRole; // your role
    monthlyBudgetUsd: number | null;
};

export type WorkspaceMember = {userId: ID; role: WorkspaceRole; joinedAt: Ms};

export type Channel = {
    id: ID;
    workspaceId: ID;
    type: ChannelType;
    name: string;
    displayName: string;
    purpose: string;
    createdBy: ID;
    createdAt: Ms;
    lastPostAt: Ms;
    totalMsgCount: number;
    memberIds?: ID[]; // filled for direct and group messages
};

export type ChannelMember = {
    channelId: ID;
    userId: ID;
    role: 'admin' | 'member';
    lastViewedAt: Ms;
    msgCount: number; // messages read; unread = channel.totalMsgCount - msgCount
    mentionCount: number;
};

export type FileInfo = {
    id: ID;
    name: string;
    mime: string;
    size: number;
    width: number | null;
    height: number | null;
    url: string; // signed, usable in <img src> for a limited time
};

export type ModelAttribution = {id: string; provider: string; tier: Tier; costUsd: number};

export type PlanStepStatus = 'pending' | 'running' | 'waiting_approval' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';
export type RunStatus = 'queued' | 'planning' | 'running' | 'waiting_approval' | 'succeeded' | 'failed' | 'cancelled';

export type PlanCard = {
    runId: ID;
    status: RunStatus;
    goal: string;
    steps: {id: string; title: string; agentId: ID; status: PlanStepStatus; postId: ID | null; dependsOn: string[]}[];
};

export type DecisionCard = {
    approvalId: ID;
    runId: ID | null;
    title: string;
    reason: string;
    fields: {label: string; value: string}[];
    tool: string;
    status: 'pending' | 'approved' | 'rejected' | 'expired';
    decidedBy: ID | null;
    decidedAt: Ms | null;
};

export type PostType = '' | 'system' | 'plan' | 'decision' | 'agent_step';

export type PostProps = {
    streaming?: boolean; // an agent is still writing this message
    model?: ModelAttribution;
    plan?: PlanCard;
    decision?: DecisionCard;
    step?: {runId: ID; stepId: string; title: string};
    error?: string;
    [key: string]: unknown;
};

export type Post = {
    id: ID;
    channelId: ID;
    workspaceId: ID;
    userId: ID;
    rootId: ID | null;
    type: PostType;
    message: string;
    props: PostProps;
    files: FileInfo[];
    createdAt: Ms;
    updatedAt: Ms;
    editedAt: Ms | null;
    deletedAt: Ms | null;
    replyCount: number;
    lastReplyAt: Ms | null;
    pendingId: string | null; // echoed back so the sender can swap its optimistic copy
    reactions: {emoji: string; userIds: ID[]}[];
};

export type AgentTool = {name: string; description: string; external: boolean; available: boolean};

export type Agent = {
    id: ID;
    workspaceId: ID;
    userId: ID; // the agent's bot account
    handle: string;
    name: string;
    description: string;
    instructions: string;
    tier: Tier | 'auto';
    model: string | null; // pin a model; null lets the router choose
    tools: string[];
    portrait: string;
    isCoordinator: boolean;
    enabled: boolean;
    builtin: boolean;
};

export type ModelInfo = {
    id: string;
    provider: string;
    label: string;
    tiers: Tier[];
    vision: boolean;
    tools: boolean;
    priceInPerM: number;
    priceOutPerM: number;
    configured: boolean; // its provider has a key
    healthy: boolean;
    lastError: string | null;
};

export type UsageSummary = {
    periodStart: Ms;
    totalUsd: number;
    budgetUsd: number | null;
    calls: number;
    byModel: {modelId: string; usd: number; calls: number; tokensIn: number; tokensOut: number}[];
    byAgent: {agentId: ID | null; usd: number; calls: number}[];
};

export type RunStep = {
    id: string;
    title: string;
    agentId: ID;
    status: PlanStepStatus;
    dependsOn: string[];
    output: string | null;
    error: string | null;
    modelId: string | null;
    costUsd: number;
    startedAt: Ms | null;
    finishedAt: Ms | null;
};

export type Run = {
    id: ID;
    workspaceId: ID;
    channelId: ID;
    rootPostId: ID | null;
    status: RunStatus;
    kind: 'single' | 'plan';
    goal: string;
    steps: RunStep[];
    costUsd: number;
    error: string | null;
    createdAt: Ms;
    updatedAt: Ms;
};

export type Session = {token: string; user: User};

export type InvitePreview = {workspaceName: string; role: WorkspaceRole; valid: boolean};

// ------------------------------------------------------------ real time

export type ServerEvent =
    | {event: 'hello'; data: {connectionId: string; serverTime: Ms; replayed: boolean}}
    | {event: 'posted'; data: {post: Post; mentions: ID[]; channelType: ChannelType}}
    | {event: 'post_edited'; data: {post: Post}}
    | {event: 'post_deleted'; data: {postId: ID; channelId: ID}}
    | {event: 'post_stream'; data: {postId: ID; channelId: ID; text: string}} // droppable: full text so far
    | {event: 'typing'; data: {channelId: ID; rootId: ID | null; userId: ID}}
    | {event: 'channel_created' | 'channel_updated'; data: {channel: Channel}}
    | {event: 'channel_member_added' | 'channel_member_removed'; data: {channelId: ID; userId: ID}}
    | {event: 'channel_viewed'; data: {channelId: ID}}
    | {event: 'reaction_changed'; data: {postId: ID; channelId: ID; reactions: Post['reactions']}}
    | {event: 'run_updated'; data: {runId: ID; channelId: ID; status: RunStatus}}
    | {event: 'user_updated'; data: {user: User}}
    | {event: 'workspace_member_added'; data: {workspaceId: ID; user: User; role: WorkspaceRole}};

export type EventName = ServerEvent['event'];
export type EventEnvelope = ServerEvent & {seq: number};

// Messages the client sends over the socket.
export type ClientMessage =
    | {action: 'auth'; seq: number; token: string; connectionId?: string; lastSeq?: number}
    | {action: 'typing'; seq: number; channelId: ID; rootId?: ID | null}
    | {action: 'ping'; seq: number};

export type ApiError = {error: string; message: string; status: number};
