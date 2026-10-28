// Accounts and sessions. Passwords are hashed with scrypt; sessions are
// random bearer tokens stored only as hashes, valid for SESSION_DAYS and
// extended while in use.

import {z} from 'zod';

import {config} from '../config.js';
import type {Db} from '../db/index.js';
import type {Session, User} from '../shared/types.js';
import {audit} from '../store/audit.js';
import {createSession, deleteSession, deleteUserSessions, getSessionByHash, touchSession} from '../store/sessions.js';
import {createUser, freeUsername, getUser, getUserByLogin, toUser, updateUser, type UserRow} from '../store/users.js';
import {hashPassword, newToken, sha256, verifyPassword} from '../util/crypto.js';
import {badRequest, conflict, unauthorized} from '../util/errors.js';
import {now} from '../util/ids.js';

export const passwordSchema = z.string().min(8, 'Use at least 8 characters for your password.').max(200);
export const emailSchema = z.string().trim().toLowerCase().email('Enter a valid email address.').max(254);
export const nameSchema = z.string().trim().min(1, 'Enter your name.').max(80);

const sessionMs = () => config.sessionDays * 86_400_000;

export async function issueSession(db: Db, user: UserRow, meta: {userAgent?: string; ip?: string}): Promise<Session> {
    const token = newToken();
    await createSession(db, {userId: user.id, tokenHash: sha256(token), expiresAt: now() + sessionMs(), userAgent: meta.userAgent?.slice(0, 300), ip: meta.ip});
    return {token, user: toUser(user, {includeEmail: true})};
}

export async function signupUser(db: Db, input: {email: string; password: string; name: string}): Promise<UserRow> {
    const email = emailSchema.parse(input.email);
    const password = passwordSchema.parse(input.password);
    const name = nameSchema.parse(input.name);
    if (await getUserByLogin(db, email)) {
        throw conflict('An account with this email already exists. Sign in instead.', 'email_taken');
    }
    const username = await freeUsername(db, name.split(/\s+/)[0] || email.split('@')[0]);
    return createUser(db, {email, username, displayName: name, passwordHash: await hashPassword(password)});
}

// The same error for "no such user" and "wrong password", after the same work.
const DUMMY_HASH = 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
export async function login(db: Db, input: {login: string; password: string}, meta: {userAgent?: string; ip?: string}): Promise<Session> {
    const loginId = String(input.login ?? '').trim().toLowerCase();
    if (!loginId || !input.password) {
        throw badRequest('Enter your email and password.');
    }
    const user = await getUserByLogin(db, loginId);
    const ok = await verifyPassword(String(input.password), user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) {
        audit(db, {userId: user?.id, action: 'login_failed', target: loginId, ip: meta.ip});
        throw unauthorized('That email and password don\'t match.');
    }
    audit(db, {userId: user.id, action: 'login', ip: meta.ip});
    return issueSession(db, user, meta);
}

// Resolve a bearer token, with a short in-memory cache (sessions are checked on every request).
const cache = new Map<string, {userId: string; sessionId: string; until: number}>();
export async function authenticate(db: Db, token: string): Promise<{user: UserRow; sessionId: string} | null> {
    if (!token || token.length > 200) {
        return null;
    }
    const hash = sha256(token);
    const hit = cache.get(hash);
    if (hit && hit.until > Date.now()) {
        const user = await getUser(db, hit.userId);
        return user ? {user, sessionId: hit.sessionId} : null;
    }
    const session = await getSessionByHash(db, hash);
    if (!session) {
        cache.delete(hash);
        return null;
    }
    const user = await getUser(db, session.userId);
    if (!user) {
        return null;
    }
    void touchSession(db, session.id, now() + sessionMs()).catch(() => undefined);
    cache.set(hash, {userId: user.id, sessionId: session.id, until: Date.now() + 30_000});
    if (cache.size > 10_000) {
        cache.clear();
    }
    return {user, sessionId: session.id};
}

// After a password change or reset: no cached session survives.
export function clearSessionCache(): void {
    cache.clear();
}

export async function logout(db: Db, token: string, sessionId: string): Promise<void> {
    cache.delete(sha256(token));
    await deleteSession(db, sessionId);
}

export async function changePassword(db: Db, user: UserRow, sessionId: string, current: string, next: string): Promise<void> {
    if (!user.passwordHash || !(await verifyPassword(current, user.passwordHash))) {
        throw unauthorized('Your current password isn\'t right.');
    }
    await updateUser(db, user.id, {passwordHash: await hashPassword(passwordSchema.parse(next))});
    // Sign out everywhere else.
    await deleteUserSessions(db, user.id, sessionId);
    cache.clear();
    audit(db, {userId: user.id, action: 'password_changed'});
}

export function me(user: UserRow): User {
    return toUser(user, {includeEmail: true});
}
