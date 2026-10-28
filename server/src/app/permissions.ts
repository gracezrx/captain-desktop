import type {Db} from '../db/index.js';
import type {WorkspaceRole} from '../shared/types.js';
import {type ChannelMemberRow, type ChannelRow, getChannel, getChannelMember} from '../store/channels.js';
import {getMemberRole} from '../store/workspaces.js';
import {forbidden, notFound} from '../util/errors.js';

const RANK: Record<WorkspaceRole, number> = {guest: 0, member: 1, admin: 2, owner: 3};

export function atLeast(role: WorkspaceRole, min: WorkspaceRole): boolean {
    return RANK[role] >= RANK[min];
}

// The caller's role in a workspace, or 404 if they aren't in it (so outsiders
// can't learn which workspaces exist).
export async function requireWorkspaceRole(db: Db, workspaceId: string, userId: string, min: WorkspaceRole = 'guest'): Promise<WorkspaceRole> {
    const role = await getMemberRole(db, workspaceId, userId);
    if (!role) {
        throw notFound('Workspace');
    }
    if (!atLeast(role, min)) {
        throw forbidden();
    }
    return role;
}

// Read or write a channel: you must be a member. Public channels can be
// joined by any non-guest workspace member (see channels.join).
export async function requireChannelMember(db: Db, channelId: string, userId: string): Promise<{channel: ChannelRow; member: ChannelMemberRow}> {
    const channel = await getChannel(db, channelId);
    if (!channel) {
        throw notFound('Channel');
    }
    const member = await getChannelMember(db, channelId, userId);
    if (!member) {
        // Hide private channels and DMs entirely from non-members.
        if (channel.type !== 'O' || !(await getMemberRole(db, channel.workspaceId, userId))) {
            throw notFound('Channel');
        }
        throw forbidden('Join this channel first.');
    }
    return {channel, member};
}
