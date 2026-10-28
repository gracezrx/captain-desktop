import {loadSession, type Session} from './mm';
import {startRealtime} from './realtime';
import {useStore} from './store';

// Load what the window needs to show "needs you" items without opening every
// chat: posts for chats with mentions or unread DMs, plus the most recent few.
export async function preloadRecent(limit = 8): Promise<void> {
    const s = useStore.getState();
    const byRecent = Object.values(s.channels).sort((a, b) => b.last_post_at - a.last_post_at);
    const wanted = new Set(byRecent.slice(0, limit).map((c) => c.id));
    for (const c of byRecent) {
        const m = s.members[c.id];
        if (m && (m.mention_count > 0 || ((c.type === 'D' || c.type === 'G') && c.total_msg_count > m.msg_count))) {
            wanted.add(c.id);
        }
    }
    await Promise.all([...wanted].filter((id) => !s.loadedChannels[id]).map((id) => s.loadPosts(id).catch(() => undefined)));
}

let stopRealtime: (() => void) | null = null;

export async function startSession(session: Session): Promise<void> {
    await useStore.getState().bootstrap(session);
    stopRealtime?.();
    stopRealtime = startRealtime(session);
    void preloadRecent();
}

export function stopSession(): void {
    stopRealtime?.();
    stopRealtime = null;
    useStore.getState().reset();
}

export async function resume(): Promise<boolean> {
    const session = await loadSession();
    if (!session) {
        return false;
    }
    try {
        await startSession(session);
        return true;
    } catch {
        return false;
    }
}
