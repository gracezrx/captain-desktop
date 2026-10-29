// The floating talk button: a small face that stays on top of everything.
//
// - Hold it (or hold the talk shortcut) to talk; let go to send.
// - Tap it (or tap the shortcut) to start talking hands-free; tap again to send.
// - Captain answers out loud, and the answer shows in a bubble (tap the bubble
//   to open the conversation).
// - Drag it anywhere. Right-click for options.
//
// Listening and speaking go through the app's voice helper; the question is
// sent from the dashboard window (lib/talk.ts), which holds the session.

import {emitTo, listen} from '@tauri-apps/api/event';
import {invoke} from '@tauri-apps/api/core';
import {getCurrentWindow, PhysicalPosition, PhysicalSize} from '@tauri-apps/api/window';
import {useCallback, useEffect, useRef, useState} from 'react';

import {getVoiceLang, setVoiceLang, type VoiceLang} from '../lib/dictation';
import {isTauri, onVoice, openDashboard, speak, speakStop, voiceCancel, voiceStart, voiceStop} from '../lib/native';
import type {TalkReply} from '../lib/talk';

type Phase = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error';
type Mode = 'hold' | 'handsfree' | 'key';

const OWNER = 'orb';
const ORB = 76; // the window's size with no bubble (logical px)
const HOLD_MS = 220; // longer than this is a hold, shorter a tap

function readPref(key: string): string | null {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

function writePref(key: string, value: string): void {
    try {
        localStorage.setItem(key, value);
    } catch {
        // not remembered
    }
}

// Speak the start of an answer, ending on a sentence.
function spoken(text: string): string {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (clean.length <= 600) {
        return clean;
    }
    const cut = clean.slice(0, 600);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('。'), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    return end > 200 ? cut.slice(0, end + 1) : `${cut}…`;
}

function languageOf(text: string): VoiceLang {
    const cjk = (text.match(/[㐀-鿿]/g) ?? []).length;
    return cjk > text.length * 0.15 ? 'zh-CN' : 'en-US';
}

// Grow or shrink the window, keeping the button where it is (bottom right).
async function resizeWindow(width: number, height: number): Promise<void> {
    if (!isTauri) {
        return;
    }
    const win = getCurrentWindow();
    const [scale, pos, size] = await Promise.all([win.scaleFactor(), win.outerPosition(), win.outerSize()]);
    const w = Math.round(width * scale);
    const h = Math.round(height * scale);
    if (w === size.width && h === size.height) {
        return;
    }
    const right = pos.x + size.width;
    const bottom = pos.y + size.height;
    await win.setSize(new PhysicalSize(w, h));
    await win.setPosition(new PhysicalPosition(right - w, bottom - h));
}

export function Orb() {
    const [phase, setPhase] = useState<Phase>('idle');
    const [bubble, setBubble] = useState<string | null>(null);
    const [channelId, setChannelId] = useState<string | null>(null);
    const [level, setLevel] = useState(0);
    const [muted, setMuted] = useState(() => readPref('captain.orb.muted') === '1');
    const [lang, setLang] = useState<VoiceLang>(getVoiceLang());
    const mode = useRef<Mode>('hold');
    const phaseRef = useRef<Phase>('idle');
    phaseRef.current = phase;
    const asking = useRef<string | null>(null);
    const heard = useRef('');
    const fade = useRef<number | undefined>(undefined);
    const bubbleBox = useRef<HTMLDivElement>(null);

    const show = useCallback((text: string | null, forMs?: number) => {
        window.clearTimeout(fade.current);
        setBubble(text);
        if (text && forMs) {
            fade.current = window.setTimeout(() => setBubble(null), forMs);
        }
    }, []);

    // Size the window to the bubble.
    useEffect(() => {
        const el = bubbleBox.current;
        if (!bubble || !el) {
            void resizeWindow(ORB, ORB);
            return;
        }
        // The bubble sits 72px from the right edge and 14px up (see app.css).
        const r = el.getBoundingClientRect();
        void resizeWindow(Math.ceil(r.width) + 82, Math.max(ORB, Math.ceil(r.height) + 24));
    }, [bubble, phase]);

    const startListening = useCallback(async (how: Mode) => {
        await speakStop();
        mode.current = how;
        heard.current = '';
        setChannelId(null);
        setPhase('listening');
        show(how === 'handsfree' ? 'Listening… tap again to send' : 'Listening…');
        try {
            await voiceStart(lang, OWNER);
        } catch (e) {
            setPhase('error');
            show(typeof e === 'string' ? e : 'Voice isn\'t available.', 5000);
        }
    }, [lang, show]);

    const finishListening = useCallback(() => {
        void voiceStop();
    }, []);

    const send = useCallback(async (text: string) => {
        const id = crypto.randomUUID();
        asking.current = id;
        setPhase('thinking');
        show(text);
        await emitTo('main', 'talk-ask', {id, text});
    }, [show]);

    // What the microphone hears.
    useEffect(() => onVoice(OWNER, (e) => {
        if (e.type === 'level') {
            setLevel(e.value);
        } else if (e.type === 'partial') {
            heard.current = e.text;
            show(e.text);
        } else if (e.type === 'final') {
            heard.current = e.text.trim();
        } else if (e.type === 'error') {
            setPhase('error');
            show(e.message, 6000);
        } else if (e.type === 'end') {
            setLevel(0);
            if (phaseRef.current !== 'listening') {
                return;
            }
            if (heard.current) {
                void send(heard.current);
            } else {
                setPhase('idle');
                show('I didn\'t catch that.', 2500);
            }
        }
    }), [send, show]);

    // Captain's answer, from the dashboard window.
    useEffect(() => {
        let un: (() => void) | undefined;
        void listen<TalkReply>('talk-reply', async (e) => {
            const r = e.payload;
            if (r.id !== asking.current) {
                return;
            }
            if (r.channelId) {
                setChannelId(r.channelId);
            }
            if (r.type === 'thinking') {
                return;
            }
            asking.current = null;
            if (r.type === 'error') {
                setPhase('error');
                show(r.text ?? 'Something went wrong.', 7000);
                return;
            }
            const text = r.text ?? '';
            show(text.length > 280 ? `${text.slice(0, 280)}…` : text);
            if (muted || !text) {
                setPhase('idle');
                show(text.length > 280 ? `${text.slice(0, 280)}…` : text, 12000);
                return;
            }
            setPhase('speaking');
            await speak(spoken(text), languageOf(text)).catch(() => undefined);
            if (phaseRef.current === 'speaking') {
                setPhase('idle');
                show(text.length > 280 ? `${text.slice(0, 280)}…` : text, 6000);
            }
        }).then((u) => {
            un = u;
        });
        return () => un?.();
    }, [muted, show]);

    // The talk shortcut: hold to talk, or tap to start and tap again to send.
    const keyDownAt = useRef(0);
    useEffect(() => {
        let un: (() => void) | undefined;
        void listen<boolean>('talk-key', (e) => {
            const pressed = e.payload;
            const p = phaseRef.current;
            if (pressed) {
                keyDownAt.current = Date.now();
                if (p === 'listening') {
                    finishListening();
                    keyDownAt.current = 0;
                } else {
                    void startListening('key');
                }
            } else if (keyDownAt.current) {
                const held = Date.now() - keyDownAt.current > 350;
                keyDownAt.current = 0;
                if (held) {
                    finishListening();
                } else {
                    mode.current = 'handsfree';
                    show('Listening… press the keys again to send');
                }
            }
        }).then((u) => {
            un = u;
        });
        return () => un?.();
    }, [finishListening, startListening, show]);

    // Right-click options.
    useEffect(() => {
        let un: (() => void) | undefined;
        void listen<string>('orb-menu', (e) => {
            if (e.payload === 'orb-mute') {
                setMuted((m) => {
                    writePref('captain.orb.muted', m ? '0' : '1');
                    return !m;
                });
            } else if (e.payload === 'orb-lang') {
                setLang((l) => {
                    const next: VoiceLang = l === 'zh-CN' ? 'en-US' : 'zh-CN';
                    setVoiceLang(next);
                    show(next === 'zh-CN' ? '我会听中文' : 'Listening in English', 2000);
                    return next;
                });
            }
        }).then((u) => {
            un = u;
        });
        return () => un?.();
    }, [show]);

    // Remember where it was dragged to.
    useEffect(() => {
        if (!isTauri) {
            return undefined;
        }
        let timer: number | undefined;
        let un: (() => void) | undefined;
        void getCurrentWindow().onMoved(() => {
            window.clearTimeout(timer);
            timer = window.setTimeout(() => void invoke('orb_moved'), 500);
        }).then((u) => {
            un = u;
        });
        return () => {
            window.clearTimeout(timer);
            un?.();
        };
    }, []);

    // Press: hold to talk, tap to toggle, drag to move.
    const press = useRef<{x: number; y: number; at: number; timer: number; dragging: boolean; started: boolean} | null>(null);

    const onPointerDown = (e: React.PointerEvent) => {
        if (e.button !== 0) {
            return;
        }
        const p = {x: e.screenX, y: e.screenY, at: Date.now(), timer: 0, dragging: false, started: false};
        if (phaseRef.current === 'idle' || phaseRef.current === 'error') {
            p.timer = window.setTimeout(() => {
                p.started = true;
                void startListening('hold');
            }, HOLD_MS);
        }
        press.current = p;
    };

    const onPointerMove = (e: React.PointerEvent) => {
        const p = press.current;
        if (!p || p.dragging || p.started || !(e.buttons & 1)) {
            return;
        }
        if (Math.hypot(e.screenX - p.x, e.screenY - p.y) > 5) {
            window.clearTimeout(p.timer);
            p.dragging = true;
            if (isTauri) {
                void getCurrentWindow().startDragging();
            }
        }
    };

    const onPointerUp = () => {
        const p = press.current;
        press.current = null;
        if (!p || p.dragging) {
            return;
        }
        window.clearTimeout(p.timer);
        if (p.started) {
            finishListening(); // let go: send
            return;
        }
        // A tap.
        const now = phaseRef.current;
        if (now === 'idle' || now === 'error') {
            void startListening('handsfree');
        } else if (now === 'listening') {
            finishListening();
        } else if (now === 'speaking') {
            void speakStop();
            setPhase('idle');
        }
    };

    const onContextMenu = (e: React.MouseEvent) => {
        e.preventDefault();
        if (isTauri) {
            void invoke('orb_menu', {muted, lang});
        }
    };

    // Esc stops whatever it's doing.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') {
                return;
            }
            if (phaseRef.current === 'listening') {
                void voiceCancel();
                setPhase('idle');
                show(null);
            } else if (phaseRef.current === 'speaking') {
                void speakStop();
                setPhase('idle');
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [show]);

    const title = phase === 'listening' ? 'Listening: let go or tap to send' : phase === 'thinking' ? 'Captain is thinking' : phase === 'speaking' ? 'Tap to stop' : 'Hold to talk to Captain · tap for hands-free · right-click for options';

    return (
        <div className='orb-stage'>
            {bubble && (
                <div
                    ref={bubbleBox}
                    className={`orb-bubble ${phase === 'error' ? 'orb-bubble-error' : ''}`}
                    onClick={() => channelId && void openDashboard(channelId)}
                    title={channelId ? 'Open the conversation' : undefined}
                >
                    {bubble}
                </div>
            )}
            <button
                type='button'
                aria-label={title}
                title={title}
                className={`orb orb-${phase}`}
                style={{'--level': level} as React.CSSProperties}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onContextMenu={onContextMenu}
            >
                <span className='orb-ring'/>
                <span className='orb-face'>
                    <span className='orb-eye'/>
                    <span className='orb-eye'/>
                </span>
                <span className='orb-mouth'>
                    {[0, 1, 2, 3].map((i) => <span key={i} style={{animationDelay: `${i * 110}ms`}}/>)}
                </span>
                {muted && <span className='orb-muted' aria-hidden>🔇</span>}
            </button>
        </div>
    );
}
