// Password resets. Two ways to get a one-time link:
// - ask for it by email (needs SMTP_URL); the answer never says whether the
//   address has an account
// - a workspace admin makes one for a member and passes it on (works without email)
// Using a link sets the new password, signs out every device, and signs you in.

import {z} from 'zod';

import {config} from '../config.js';
import {tx, type Db} from '../db/index.js';
import type {Session} from '../shared/types.js';
import {audit} from '../store/audit.js';
import {deleteUserSessions} from '../store/sessions.js';
import {getUser, getUserByLogin, isInstanceAdmin, updateUser, type UserRow} from '../store/users.js';
import {getMemberRole} from '../store/workspaces.js';
import {hashPassword, newToken, sha256} from '../util/crypto.js';
import {badRequest, forbidden, notFound} from '../util/errors.js';
import {newId, now} from '../util/ids.js';
import {log} from '../util/log.js';
import {mailEnabled, sendMail} from '../util/mail.js';

import {clearSessionCache, emailSchema, issueSession, passwordSchema} from './auth.js';
import type {Ctx} from './context.js';
import {atLeast, requireWorkspaceRole} from './permissions.js';

const EMAIL_LINK_MS = 60 * 60_000; // an emailed link works for an hour
const ADMIN_LINK_MS = 24 * 3_600_000; // an admin's link for a day

async function createReset(db: Db, userId: string, createdBy: string | null, ttlMs: number): Promise<string> {
    const token = newToken(24);
    // A new link replaces any earlier unused one.
    await db`update password_resets set used_at = ${now()} where user_id = ${userId} and used_at is null`;
    await db`
        insert into password_resets (id, user_id, token_hash, created_by, created_at, expires_at)
        values (${newId()}, ${userId}, ${sha256(token)}, ${createdBy}, ${now()}, ${now() + ttlMs})`;
    return token;
}

export function resetUrl(token: string): string {
    return `${config.publicUrl}/?reset=${token}`;
}

export async function requestByEmail(ctx: Ctx, emailInput: unknown, meta: {ip?: string}): Promise<void> {
    const email = emailSchema.parse(emailInput);
    if (!mailEnabled()) {
        throw badRequest('This server can\'t send email yet. Ask a workspace admin for a reset link.', 'email_disabled');
    }
    const user = await getUserByLogin(ctx.sql, email);
    audit(ctx.sql, {userId: user?.id ?? null, action: 'password_reset_requested', target: email, ip: meta.ip});
    if (!user?.email) {
        return; // same answer either way
    }
    const token = await createReset(ctx.sql, user.id, null, EMAIL_LINK_MS);
    sendMail({
        to: [user.email],
        subject: 'Reset your Captain password',
        text: `Hi ${user.displayName},\n\nSomeone asked to reset the password for your Captain account. To choose a new one, open this link within an hour:\n\n${resetUrl(token)}\n\nIf it wasn't you, ignore this email; your password stays the same.\n\nCaptain`,
    }).catch((err) => log.error({err}, 'reset email failed'));
}

// A workspace admin makes a link for a member (the member's role must be lower,
// unless an owner asks). An account can belong to several workspaces, so only
// accounts that belong to this workspace alone qualify, and never the people
// who run the server. Everyone else uses Forgot password.
export async function adminResetLink(ctx: Ctx, actor: UserRow, workspaceId: string, userId: string): Promise<{url: string; expiresAt: number}> {
    const actorRole = await requireWorkspaceRole(ctx.sql, workspaceId, actor.id, 'admin');
    const targetRole = await getMemberRole(ctx.sql, workspaceId, userId);
    const target = await getUser(ctx.sql, userId);
    if (!targetRole || !target || target.isBot) {
        throw notFound('Member');
    }
    if (target.id === actor.id) {
        throw badRequest('Change your own password in Settings → Your profile.');
    }
    if (atLeast(targetRole, 'admin') && actorRole !== 'owner') {
        throw forbidden('Only an owner can reset an admin\'s or owner\'s password.');
    }
    if (isInstanceAdmin(target) && !isInstanceAdmin(actor)) {
        throw forbidden('This person runs the server, so they reset their own password with "Forgot password?".');
    }
    const [{elsewhere}] = await ctx.sql`select count(*)::int as elsewhere from workspace_members where user_id = ${userId} and workspace_id <> ${workspaceId}`;
    if (Number(elsewhere) > 0 && !isInstanceAdmin(actor)) {
        throw forbidden('This person is also in other workspaces, so only they can reset their password, with "Forgot password?".');
    }
    const token = await createReset(ctx.sql, userId, actor.id, ADMIN_LINK_MS);
    audit(ctx.sql, {workspaceId, userId: actor.id, action: 'password_reset_link_created', target: userId});
    return {url: resetUrl(token), expiresAt: now() + ADMIN_LINK_MS};
}

export async function useResetLink(ctx: Ctx, input: unknown, meta: {userAgent?: string; ip?: string}): Promise<Session> {
    const data = z.object({token: z.string().min(10).max(200), password: passwordSchema}).parse(input);
    const hash = await hashPassword(data.password);
    const user = await tx(ctx.sql, async (t) => {
        const [row] = await t`
            update password_resets set used_at = ${now()}
            where token_hash = ${sha256(data.token)} and used_at is null and expires_at > ${now()}
            returning user_id`;
        if (!row) {
            throw badRequest('This reset link has expired or was already used. Ask for a new one.', 'reset_invalid');
        }
        const u = await updateUser(t, row.userId as string, {passwordHash: hash});
        await deleteUserSessions(t, u.id);
        return u;
    });
    clearSessionCache();
    ctx.hub.closeUserSessions(user.id);
    audit(ctx.sql, {userId: user.id, action: 'password_reset', ip: meta.ip});
    return issueSession(ctx.sql, user, meta);
}
