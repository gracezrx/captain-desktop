// The Mac app's global shortcuts as people see them (⌃⇧C), for hints.

import {useEffect, useState} from 'react';

import {prettyKeys, shortcutsGet} from './native';

const DEFAULTS = {panel: '⌃⇧C', talk: '⌃⇧Space'};

export function useShortcutLabels(): {panel: string; talk: string} {
    const [labels, setLabels] = useState(DEFAULTS);
    useEffect(() => {
        void shortcutsGet().then((s) => {
            if (s) {
                setLabels({panel: prettyKeys(s.panel.keys), talk: prettyKeys(s.talk.keys)});
            }
        }).catch(() => undefined);
    }, []);
    return labels;
}
