// Captain's own reactions (the "Crew" set): six quick ones on the hover bar
// and twelve more in the picker. Reactions are stored by these ids; the
// handful of Unicode emoji people used before map onto them.

export const CREW_QUICK = ['thumbs_up', 'done', 'looking', 'thanks', 'celebrate', 'love'] as const;
export const CREW_MORE = ['thumbs_down', 'laugh', 'thinking', 'wow', 'fire', 'hundred', 'shipped', 'question', 'heads_up', 'waiting', 'sparkles', 'idea'] as const;
export const CREW = [...CREW_QUICK, ...CREW_MORE] as const;
export type CrewId = (typeof CREW)[number];

export const LEGACY_EMOJI: Record<string, CrewId> = {
    '👍': 'thumbs_up', '✅': 'done', '👀': 'looking', '🙌': 'thanks', '🙏': 'thanks', '🎉': 'celebrate',
    '❤️': 'love', '❤': 'love', '👎': 'thumbs_down', '😂': 'laugh', '🤔': 'thinking', '😮': 'wow',
    '🔥': 'fire', '💯': 'hundred', '🚀': 'shipped', '❓': 'question', '⚠️': 'heads_up', '⏳': 'waiting',
    '✨': 'sparkles', '💡': 'idea',
};

export function crewId(emoji: string): CrewId | null {
    return (CREW as readonly string[]).includes(emoji) ? (emoji as CrewId) : LEGACY_EMOJI[emoji] ?? null;
}

// The ways a reaction may be stored: its id and the Unicode it replaced.
export function storedForms(id: CrewId): string[] {
    return [id, ...Object.entries(LEGACY_EMOJI).filter(([, v]) => v === id).map(([k]) => k)];
}
