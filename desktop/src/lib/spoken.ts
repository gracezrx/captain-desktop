// Text that goes to or comes from the voice: what to read aloud of an
// answer, which voice to read it in, and voice typing's spoken commands.

import type {VoiceLang} from './dictation';

// Speak the start of an answer, ending on a sentence.
export function spoken(text: string): string {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (clean.length <= 600) {
        return clean;
    }
    const cut = clean.slice(0, 600);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('。'), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    return end > 200 ? cut.slice(0, end + 1) : `${cut}…`;
}

export function languageOf(text: string): VoiceLang {
    const cjk = (text.match(/[㐀-鿿]/g) ?? []).length;
    return cjk > text.length * 0.15 ? 'zh-CN' : 'en-US';
}

// Voice typing: "new line", "new paragraph" and "scratch that" (drops the
// sentence before it), in English; 换行 for a new line in Chinese.
export function dictated(raw: string): string {
    let text = raw;
    const scratch = /\s*\bscratch that\b[.,!?]?\s*/i;
    while (scratch.test(text)) {
        const m = text.match(scratch)!;
        const before = text.slice(0, m.index).replace(/\s+$/, '');
        const after = text.slice((m.index ?? 0) + m[0].length);
        const cut = Math.max(before.lastIndexOf('. ', before.length - 2), before.lastIndexOf('! ', before.length - 2), before.lastIndexOf('? ', before.length - 2), before.lastIndexOf('\n'));
        text = (cut >= 0 ? before.slice(0, cut + 1).replace(/\s+$/, '') + (after ? ' ' : '') : '') + after;
    }
    text = text.replace(/\s*\bnew paragraph\b[.,]?\s*/gi, '\n\n').replace(/\s*\bnew line\b[.,]?\s*/gi, '\n').replace(/\s*换行[，。]?\s*/g, '\n');
    text = text.replace(/\n([a-z])/g, (_, c: string) => `\n${c.toUpperCase()}`);
    return text.trim();
}
