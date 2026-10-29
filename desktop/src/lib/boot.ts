import {loadSession, setUnauthorizedHandler, signOut, type StoredSession} from './api';
import {isTauri, LOCAL_SERVER, waitForServer} from './native';
import {startRealtime} from './realtime';
import {useStore} from './store';

// Load what the window needs to show "needs you" items without opening every
// chat: posts for chats with mentions or unread DMs, plus the most recent few.
export async function preloadRecent(limit = 8): Promise<void> {
    const s = useStore.getState();
    const byRecent = Object.values(s.channels).sort((a, b) => b.lastPostAt - a.lastPostAt);
    const wanted = new Set(byRecent.slice(0, limit).map((c) => c.id));
    for (const c of byRecent) {
        const m = s.members[c.id];
        if (m && (m.mentionCount > 0 || ((c.type === 'D' || c.type === 'G') && c.totalMsgCount > m.msgCount))) {
            wanted.add(c.id);
        }
    }
    await Promise.all([...wanted].filter((id) => !s.loadedChannels[id]).map((id) => s.loadPosts(id).catch(() => undefined)));
}

let stopRealtime: (() => void) | null = null;
let onSignedOut: (() => void) | null = null;

export function whenSignedOut(fn: () => void): void {
    onSignedOut = fn;
}

export async function startSession(session: StoredSession): Promise<void> {
    setUnauthorizedHandler(() => {
        void endSession();
    });
    await useStore.getState().bootstrap(session);
    stopRealtime?.();
    stopRealtime = startRealtime();
    void preloadRecent();
}

export function stopSession(): void {
    stopRealtime?.();
    stopRealtime = null;
    useStore.getState().reset();
}

export async function endSession(): Promise<void> {
    stopSession();
    await signOut();
    onSignedOut?.();
}

export async function resume(): Promise<boolean> {
    const session = await loadSession();
    if (!session) {
        return false;
    }
    // The app's own server starts with the app: give it a moment.
    if (isTauri && session.serverUrl === LOCAL_SERVER && !(await waitForServer(LOCAL_SERVER, 40_000))) {
        return false;
    }
    try {
        await startSession(session);
        return true;
    } catch {
        return false;
    }
}
