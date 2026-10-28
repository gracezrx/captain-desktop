import {ArrowUp, Camera, Mic, Paperclip, X} from 'lucide-react';
import {type ReactNode, useCallback, useEffect, useRef, useState} from 'react';

import {getVoiceLang, setVoiceLang, useDictation, type VoiceLang} from '../lib/dictation';
import {errorMessage} from '../lib/mm';
import {captureScreen} from '../lib/native';
import {sendTyping} from '../lib/realtime';
import {type Attachment, makeAttachment, sendMessage} from '../lib/send';

type Props = {
    channelId: string | null;
    rootId?: string;
    variant: 'dashboard' | 'panel';
    placeholder?: string;
    autoFocus?: boolean;
    leading?: ReactNode;
    draftKey?: string;
    onSent?: () => void;
};

export function Composer({channelId, rootId = '', variant, placeholder, autoFocus, leading, draftKey, onSent}: Props) {
    const storageKey = draftKey ? `captain.draft.${draftKey}` : null;
    const [text, setText] = useState(() => (storageKey ? localStorage.getItem(storageKey) ?? '' : ''));
    const [attachments, setAttachments] = useState<Attachment[]>([]);
    const [sending, setSending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [capturing, setCapturing] = useState(false);
    const [lang, setLang] = useState<VoiceLang>(getVoiceLang());
    const area = useRef<HTMLTextAreaElement>(null);
    const textRef = useRef(text);
    textRef.current = text;
    const lastTyping = useRef(0);
    const panel = variant === 'panel';

    const dictation = useDictation(useCallback(() => textRef.current, []), useCallback((t: string) => setText(t), []));

    useEffect(() => {
        if (storageKey) {
            localStorage.setItem(storageKey, text);
        }
    }, [storageKey, text]);

    useEffect(() => {
        const el = area.current;
        if (el) {
            el.style.height = 'auto';
            el.style.height = `${Math.min(el.scrollHeight, panel ? 132 : 200)}px`;
        }
    }, [text, panel]);

    useEffect(() => {
        if (autoFocus) {
            area.current?.focus();
        }
    }, [autoFocus, channelId]);

    const addBlob = (blob: Blob, name?: string) => setAttachments((a) => [...a, makeAttachment(blob, name)]);

    const snapshot = async (region: boolean) => {
        setCapturing(true);
        setError(null);
        try {
            const blob = await captureScreen(region);
            if (blob) {
                addBlob(blob);
            }
        } catch (e) {
            setError(errorMessage(e));
        } finally {
            setCapturing(false);
            area.current?.focus();
        }
    };

    const send = async () => {
        const message = text.trim();
        if (!channelId || sending || (!message && attachments.length === 0)) {
            return;
        }
        if (dictation.listening) {
            dictation.stop();
        }
        setSending(true);
        setError(null);
        const toSend = attachments;
        setText('');
        setAttachments([]);
        try {
            await sendMessage({channelId, text: message, attachments: toSend, rootId});
            toSend.forEach((a) => URL.revokeObjectURL(a.previewUrl));
            onSent?.();
        } catch (e) {
            setText(message);
            setAttachments(toSend);
            setError(errorMessage(e));
        } finally {
            setSending(false);
            area.current?.focus();
        }
    };

    // Hold Option (alone) to talk; release to stop.
    const optionTimer = useRef<number | null>(null);
    const optionTalking = useRef(false);
    const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Alt' && !e.repeat && dictation.supported) {
            optionTimer.current = window.setTimeout(() => {
                optionTalking.current = true;
                dictation.start();
            }, 220);
            return;
        }
        if (optionTimer.current) {
            clearTimeout(optionTimer.current);
            optionTimer.current = null;
        }
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send();
        }
    };
    const onKeyUp = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Alt') {
            if (optionTimer.current) {
                clearTimeout(optionTimer.current);
                optionTimer.current = null;
            }
            if (optionTalking.current) {
                optionTalking.current = false;
                dictation.stop();
            }
        }
    };

    const onChange = (v: string) => {
        setText(v);
        if (channelId && Date.now() - lastTyping.current > 3000) {
            lastTyping.current = Date.now();
            sendTyping(channelId, rootId);
        }
    };

    const canSend = Boolean(channelId) && !sending && (text.trim().length > 0 || attachments.length > 0);
    const iconBtn = 'grid size-8 place-items-center rounded-full text-muted transition-colors hover:bg-tint hover:text-ink disabled:opacity-40';

    return (
        <div
            className={`rounded-[20px] bg-surface ${panel ? 'p-2.5' : 'p-3'}`}
            style={{boxShadow: 'var(--shadow-composer)'}}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
                e.preventDefault();
                [...e.dataTransfer.files].forEach((f) => addBlob(f, f.name));
            }}
        >
            {leading}
            {attachments.length > 0 && (
                <div className='mb-2 flex flex-wrap gap-2 px-1'>
                    {attachments.map((a) => (
                        <div key={a.clientId} className='relative'>
                            <img src={a.previewUrl} alt={a.name} className={`${panel ? 'h-20' : 'h-24'} rounded-xl object-cover ring-1 ring-line`}/>
                            <button
                                type='button'
                                aria-label='Remove attachment'
                                onClick={() => setAttachments((list) => list.filter((x) => x.clientId !== a.clientId))}
                                className='absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full bg-ink text-white shadow'
                            >
                                <X size={11} strokeWidth={3}/>
                            </button>
                        </div>
                    ))}
                </div>
            )}
            <textarea
                ref={area}
                rows={1}
                value={text}
                placeholder={dictation.listening ? 'Listening…' : placeholder ?? (channelId ? 'Message' : 'Pick a chat first')}
                onChange={(e) => onChange(e.target.value)}
                onKeyDown={onKeyDown}
                onKeyUp={onKeyUp}
                onPaste={(e) => {
                    const imgs = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
                    if (imgs.length) {
                        e.preventDefault();
                        imgs.forEach((f) => addBlob(f));
                    }
                }}
                className={`block w-full resize-none bg-transparent px-1.5 py-1 text-ink outline-none placeholder:text-muted ${panel ? 'text-[14px]' : 'text-[14.5px]'}`}
                aria-label='Message'
            />
            <div className='mt-1.5 flex items-center gap-0.5'>
                <button type='button' className={iconBtn} aria-label='Add a screen snapshot (hold Option to pick a region)' title='Snapshot your screen · ⌥-click to pick a region' disabled={capturing} onClick={(e) => void snapshot(e.altKey)}>
                    <Camera size={17}/>
                </button>
                {!panel && (
                    <label className={iconBtn} aria-label='Attach a file' title='Attach a file'>
                        <Paperclip size={17}/>
                        <input type='file' multiple className='hidden' onChange={(e) => [...(e.target.files ?? [])].forEach((f) => addBlob(f, f.name))}/>
                    </label>
                )}
                <VoiceButton dictation={dictation}/>
                {dictation.supported && (
                    <button
                        type='button'
                        className='h-6 rounded-full px-2 text-[11px] font-semibold text-muted hover:bg-tint'
                        title='Voice language'
                        onClick={() => {
                            const next: VoiceLang = lang === 'en-US' ? 'zh-CN' : 'en-US';
                            setVoiceLang(next);
                            setLang(next);
                        }}
                    >
                        {lang === 'en-US' ? 'EN' : '中文'}
                    </button>
                )}
                <div className='ml-auto flex items-center gap-2'>
                    {error && <span className='max-w-56 truncate text-[12px] text-alert' title={error}>{error}</span>}
                    {dictation.error && !error && <span className='max-w-56 truncate text-[12px] text-alert' title={dictation.error}>{dictation.error}</span>}
                    <button
                        type='button'
                        aria-label='Send'
                        disabled={!canSend}
                        onClick={() => void send()}
                        className='grid size-8 place-items-center rounded-full bg-accent text-on-accent transition-all disabled:bg-tint disabled:text-muted disabled:shadow-none'
                        style={canSend ? {boxShadow: 'var(--shadow-send)'} : undefined}
                    >
                        <ArrowUp size={17} strokeWidth={2.5}/>
                    </button>
                </div>
            </div>
        </div>
    );
}

type Dictation = ReturnType<typeof useDictation>;

// Press and hold to talk; a quick tap toggles hands-free.
function VoiceButton({dictation}: {dictation: Dictation}) {
    const startedAt = useRef(0); // set when this press started listening
    if (!dictation.supported) {
        return (
            <span className='grid size-8 place-items-center rounded-full text-muted opacity-40' title='Voice typing is available in the Mac app'>
                <Mic size={17}/>
            </span>
        );
    }
    return (
        <button
            type='button'
            aria-label={dictation.listening ? 'Stop voice typing' : 'Hold to talk'}
            aria-pressed={dictation.listening}
            title='Hold to talk · tap for hands-free · or hold ⌥ while typing'
            onPointerDown={() => {
                if (dictation.listening) {
                    startedAt.current = 0;
                    dictation.stop(); // a tap while hands-free stops it
                    return;
                }
                startedAt.current = Date.now();
                dictation.start();
            }}
            onPointerUp={() => {
                // Held: stop on release. Quick tap: keep listening hands-free.
                if (startedAt.current && Date.now() - startedAt.current > 300) {
                    dictation.stop();
                }
                startedAt.current = 0;
            }}
            className={`relative grid size-8 place-items-center rounded-full transition-colors ${dictation.listening ? 'bg-accent text-on-accent' : 'text-muted hover:bg-tint hover:text-ink'}`}
        >
            {dictation.listening ? (
                <span className='flex h-3.5 items-center gap-[2px]' aria-hidden>
                    {[0, 120, 240, 360].map((d) => (
                        <span key={d} className='wave-bar block h-full w-[2.5px] rounded-full bg-current' style={{animationDelay: `${d}ms`}}/>
                    ))}
                </span>
            ) : (
                <Mic size={17}/>
            )}
        </button>
    );
}
