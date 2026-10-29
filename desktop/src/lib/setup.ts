// Opening the "Get started" guide from anywhere in the dashboard window (Home,
// Settings → This Mac, and the menu bar icon's "Get started…").

import {listen} from '@tauri-apps/api/event';

import {isTauri} from './native';

const EVENT = 'captain:open-setup';

export function openSetup(): void {
    window.dispatchEvent(new Event(EVENT));
}

export function onOpenSetup(handler: () => void): () => void {
    window.addEventListener(EVENT, handler);
    let un: (() => void) | undefined;
    let gone = false;
    if (isTauri) {
        void listen('open-setup', handler).then((u) => {
            if (gone) {
                u();
            } else {
                un = u;
            }
        });
    }
    return () => {
        gone = true;
        window.removeEventListener(EVENT, handler);
        un?.();
    };
}

const SEEN_KEY = 'captain.setup.seen';

export function setupSeen(): boolean {
    try {
        return localStorage.getItem(SEEN_KEY) === '1';
    } catch {
        return true;
    }
}

export function markSetupSeen(): void {
    try {
        localStorage.setItem(SEEN_KEY, '1');
    } catch {
        // private window: it shows again next time
    }
}
