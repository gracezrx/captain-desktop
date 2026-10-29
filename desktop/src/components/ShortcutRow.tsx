// A global shortcut in the Mac app: what it is, whether macOS allowed it,
// and a way to record new keys.

import {useEffect, useState} from 'react';

import {prettyKeys, shortcutSet, type ShortcutStatus} from '../lib/native';

import {ghostBtn} from './Modal';

// Keys a shortcut can use: letters, digits, Space, F-keys and a few marks.
function acceleratorFrom(e: KeyboardEvent): string | null {
    const mods = [e.metaKey && 'Command', e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean) as string[];
    const code = e.code;
    if (!mods.length || /^(Meta|Control|Alt|Shift)(Left|Right)$/.test(code) || !code) {
        return null;
    }
    return [...mods, code].join('+');
}

export function ShortcutRow({kind, label, hint, status, onChange}: {kind: 'panel' | 'talk'; label: string; hint: string; status: ShortcutStatus; onChange: (s: ShortcutStatus) => void}) {
    const [recording, setRecording] = useState(false);
    const [error, setError] = useState<string | null>(status.ok ? null : status.error);

    useEffect(() => {
        if (!recording) {
            return undefined;
        }
        const onKey = (e: KeyboardEvent) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.key === 'Escape') {
                setRecording(false);
                return;
            }
            const keys = acceleratorFrom(e);
            if (!keys) {
                return; // still holding modifiers
            }
            setRecording(false);
            void shortcutSet(kind, keys).then((st) => {
                if (st.ok) {
                    onChange(st);
                    setError(null);
                } else {
                    setError(`${prettyKeys(keys)}: ${st.error}`);
                }
            });
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [recording, kind, onChange]);

    return (
        <div className='rounded-xl bg-bg-subtle px-3 py-2.5 ring-1 ring-line/70'>
            <div className='flex items-center gap-3'>
                <div className='min-w-0 flex-1'>
                    <div className='text-[13px] font-bold text-ink'>{label}</div>
                    <div className='text-[12px] text-muted'>{hint}</div>
                </div>
                <kbd className={`rounded-lg px-2 py-1 font-sans text-[13px] font-bold ring-1 ${status.ok ? 'bg-surface text-ink ring-line' : 'bg-surface text-alert ring-alert/40'}`}>
                    {recording ? 'Press keys…' : prettyKeys(status.keys)}
                </kbd>
                <button type='button' className={ghostBtn} onClick={() => setRecording(!recording)}>{recording ? 'Cancel' : 'Change'}</button>
            </div>
            {!status.ok && !error && <p className='mt-1.5 text-[12px] text-alert'>This shortcut isn&apos;t working: macOS didn&apos;t allow it. Pick another.</p>}
            {error && <p className='mt-1.5 text-[12px] text-alert'>{error}</p>}
        </div>
    );
}
