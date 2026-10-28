// Voice typing. Uses the system speech recognizer through the Web Speech
// API, which macOS's WebKit provides (on-device where the language allows).
// A native Apple Speech bridge and ElevenLabs are planned behind the same hook.

import {useCallback, useEffect, useRef, useState} from 'react';

type Recognition = {
    lang: string;
    continuous: boolean;
    interimResults: boolean;
    start: () => void;
    stop: () => void;
    abort: () => void;
    onresult: ((e: {resultIndex: number; results: ArrayLike<ArrayLike<{transcript: string}> & {isFinal: boolean}>}) => void) | null;
    onend: (() => void) | null;
    onerror: ((e: {error: string}) => void) | null;
};

type Ctor = new () => Recognition;

function recognitionCtor(): Ctor | null {
    const w = window as unknown as {SpeechRecognition?: Ctor; webkitSpeechRecognition?: Ctor};
    return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export type VoiceLang = 'en-US' | 'zh-CN';

export function getVoiceLang(): VoiceLang {
    return (localStorage.getItem('captain.voiceLang') as VoiceLang) || (navigator.language.startsWith('zh') ? 'zh-CN' : 'en-US');
}

export function setVoiceLang(lang: VoiceLang): void {
    localStorage.setItem('captain.voiceLang', lang);
}

// onText receives the full field text: what was there before you started
// talking, plus everything said so far (final and in-progress words).
export function useDictation(getBase: () => string, onText: (text: string) => void) {
    const ctor = recognitionCtor();
    const [listening, setListening] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const rec = useRef<Recognition | null>(null);
    const base = useRef('');
    const finals = useRef('');

    const stop = useCallback(() => {
        rec.current?.stop();
    }, []);

    const start = useCallback(() => {
        if (!ctor || rec.current) {
            return;
        }
        setError(null);
        const r = new ctor();
        r.lang = getVoiceLang();
        r.continuous = true;
        r.interimResults = true;
        const before = getBase();
        base.current = before && !/\s$/.test(before) ? `${before} ` : before;
        finals.current = '';
        r.onresult = (e) => {
            let interim = '';
            for (let i = e.resultIndex; i < e.results.length; i++) {
                const res = e.results[i];
                if (res.isFinal) {
                    finals.current += res[0].transcript;
                } else {
                    interim += res[0].transcript;
                }
            }
            onText(base.current + finals.current + interim);
        };
        r.onerror = (e) => {
            if (e.error !== 'no-speech' && e.error !== 'aborted') {
                setError(e.error === 'not-allowed' ? 'Microphone access is off. Turn it on in System Settings > Privacy & Security.' : 'Voice typing stopped. Try again.');
            }
        };
        r.onend = () => {
            rec.current = null;
            setListening(false);
            onText(base.current + finals.current);
        };
        rec.current = r;
        try {
            r.start();
            setListening(true);
        } catch {
            rec.current = null;
        }
    }, [ctor, getBase, onText]);

    useEffect(() => () => rec.current?.abort(), []);

    return {supported: Boolean(ctor), listening, start, stop, error};
}
