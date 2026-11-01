// Captain's own reactions, the "Crew" set: one round yellow face with a
// dark outline, pink cheeks and a shaded lower right, plus a big symbol
// that says what the reaction means. Drawn on a 64×64 grid; used at 16px
// in reaction pills, 20px on the hover bar and 32px in the picker.

import {type ReactNode, useId} from 'react';

export const CREW_QUICK = ['thumbs_up', 'done', 'looking', 'thanks', 'celebrate', 'love'] as const;
export const CREW_MORE = ['thumbs_down', 'laugh', 'thinking', 'wow', 'fire', 'hundred', 'shipped', 'question', 'heads_up', 'waiting', 'sparkles', 'idea'] as const;
export type CrewId = (typeof CREW_QUICK)[number] | (typeof CREW_MORE)[number];
const ALL: readonly string[] = [...CREW_QUICK, ...CREW_MORE];

// Reactions people left before the Crew set (keep in step with server/src/shared/emoji.ts).
const LEGACY: Record<string, CrewId> = {
    '👍': 'thumbs_up', '✅': 'done', '👀': 'looking', '🙌': 'thanks', '🙏': 'thanks', '🎉': 'celebrate',
    '❤️': 'love', '❤': 'love', '👎': 'thumbs_down', '😂': 'laugh', '🤔': 'thinking', '😮': 'wow',
    '🔥': 'fire', '💯': 'hundred', '🚀': 'shipped', '❓': 'question', '⚠️': 'heads_up', '⏳': 'waiting',
    '✨': 'sparkles', '💡': 'idea',
};

export function crewId(emoji: string): CrewId | null {
    return ALL.includes(emoji) ? (emoji as CrewId) : LEGACY[emoji] ?? null;
}

const NAMES: Record<CrewId, [en: string, zh: string]> = {
    thumbs_up: ['Thumbs up', '赞'], done: ['Done', '完成'], looking: ['Looking', '在看'], thanks: ['Thanks', '谢谢'],
    celebrate: ['Celebrate', '庆祝'], love: ['Love', '爱了'], thumbs_down: ['Thumbs down', '踩'], laugh: ['Laugh', '笑哭'],
    thinking: ['Thinking', '思考中'], wow: ['Wow', '哇'], fire: ['Fire', '火'], hundred: ['100', '满分'],
    shipped: ['Shipped', '已上线'], question: ['Question', '有疑问'], heads_up: ['Heads up', '注意'], waiting: ['Waiting', '等待中'],
    sparkles: ['Sparkles', '闪亮'], idea: ['Idea', '好主意'],
};

const zh = typeof navigator !== 'undefined' && /^zh\b/i.test(navigator.language);
export function crewName(id: CrewId): string {
    return NAMES[id][zh ? 1 : 0];
}

// Colors of the set itself (not the app theme: emoji look the same in light and dark).
const INK = '#4A2C12';
const FACE = '#FFCC3E';
const SHADE = '#F0AE24';
const CHEEK = '#FF8FA3';
const W = 2.2;
const line = {stroke: INK, strokeWidth: W, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const};

type Parts = {eyes?: ReactNode; mouth?: ReactNode; extra?: ReactNode; symbol?: ReactNode};

const dotEyes = (dx = 0) => (
    <>
        <ellipse cx={21 + dx} cy={26} rx={2.5} ry={3.3} fill={INK}/>
        <ellipse cx={36 + dx} cy={26} rx={2.5} ry={3.3} fill={INK}/>
    </>
);
const happyEyes = <path d='M17.5 27.5q3.5-5 7 0M32.5 27.5q3.5-5 7 0' fill='none' {...line}/>;
const smile = <path d='M20 35.5q8.5 8 17 0' fill='none' {...line}/>;
const grin = <path d='M18.5 34h20q-1 10.5-10 10.5T18.5 34z' fill={INK} {...line}/>;
const flat = <path d='M22 38h13' fill='none' {...line}/>;
const frown = <path d='M21 40.5q7.5-6 15 0' fill='none' {...line}/>;

const thumb = (down = false) => (
    <g transform={down ? 'rotate(180 51 50)' : undefined}>
        <path d='M44.5 47.5v-6.5q0-6 3.5-9.5 2.6-.4 3 2.4v7.6h6.4q3.4 0 3 3.4l-1.2 10.6q-.4 3-3.4 3H44.5z' fill={FACE} {...line}/>
        <rect x={39} y={46} width={6} height={15} rx={2} fill='#3A6FD8' {...line}/>
    </g>
);

const PARTS: Record<CrewId, Parts> = {
    thumbs_up: {eyes: dotEyes(), mouth: smile, symbol: thumb()},
    done: {
        eyes: happyEyes, mouth: smile,
        symbol: <><circle cx={50} cy={49} r={11.5} fill='#2F9E64' {...line}/><path d='M44.5 49.5l3.8 3.8 7.4-8' fill='none' stroke='#fff' strokeWidth={3.4} strokeLinecap='round' strokeLinejoin='round'/></>,
    },
    looking: {
        eyes: <><ellipse cx={20} cy={26} rx={4.2} ry={4.6} fill='#fff' {...line}/><ellipse cx={35} cy={26} rx={4.2} ry={4.6} fill='#fff' {...line}/><circle cx={22} cy={26.5} r={2} fill={INK}/><circle cx={37} cy={26.5} r={2} fill={INK}/></>,
        mouth: <path d='M24 38.5h8' fill='none' {...line}/>,
        symbol: <><path d='M53.5 53.5l6.5 6.5' stroke={INK} strokeWidth={5} strokeLinecap='round'/><circle cx={48} cy={47.5} r={8.5} fill='#CFE0FF' {...line}/><path d='M44 45q2-3 5-3' fill='none' stroke='#fff' strokeWidth={2} strokeLinecap='round'/></>,
    },
    thanks: {
        eyes: happyEyes, mouth: smile,
        symbol: <>
            <rect x={41} y={45} width={9} height={15} rx={4.5} fill='#FFE08A' transform='rotate(-14 45.5 52)' {...line}/>
            <rect x={53} y={45} width={9} height={15} rx={4.5} fill='#FFE08A' transform='rotate(14 57.5 52)' {...line}/>
            <path d='M41.5 40.5l-2-3M51.5 38.5v-3.5M61.5 40.5l2-3' stroke='#D4A46A' strokeWidth={2.4} strokeLinecap='round'/>
        </>,
    },
    celebrate: {
        eyes: happyEyes, mouth: grin,
        symbol: <>
            <path d='M41 61l6.5-19 12 12z' fill='#3A6FD8' {...line}/>
            <path d='M44 52.5l6 6M45.6 47.7l8.6 8.6' stroke='#D4A46A' strokeWidth={2.4} strokeLinecap='round'/>
            <circle cx={55} cy={39} r={2.2} fill='#FF8FA3'/><circle cx={61} cy={45} r={2} fill='#D4A46A'/><rect x={58} y={35} width={3.6} height={3.6} rx={1} fill='#3A6FD8' transform='rotate(20 59.8 36.8)'/>
        </>,
    },
    love: {
        eyes: <><path d='M21 31l-5-5a3 3 0 015-3.5 3 3 0 015 3.5z' fill='#E8455B' stroke={INK} strokeWidth={1.6} strokeLinejoin='round'/><path d='M36 31l-5-5a3 3 0 015-3.5 3 3 0 015 3.5z' fill='#E8455B' stroke={INK} strokeWidth={1.6} strokeLinejoin='round'/></>,
        mouth: smile,
        symbol: <path d='M51 61.5l-9.6-9.4a5.9 5.9 0 019.6-6.8 5.9 5.9 0 019.6 6.8z' fill='#E8455B' {...line}/>,
    },
    thumbs_down: {eyes: dotEyes(), mouth: frown, symbol: thumb(true)},
    laugh: {
        eyes: <path d='M17 23.5l6 3-6 3M40 23.5l-6 3 6 3' fill='none' {...line}/>,
        mouth: grin,
        extra: <><path d='M8 32q-3 5 0 8 3-3 0-8z' fill='#7FB6FF' stroke={INK} strokeWidth={1.6} strokeLinejoin='round'/><path d='M50 32q-3 5 0 8 3-3 0-8z' fill='#7FB6FF' stroke={INK} strokeWidth={1.6} strokeLinejoin='round'/></>,
    },
    thinking: {
        eyes: <><path d='M17.5 20.5l6-2' fill='none' {...line}/>{dotEyes()}</>,
        mouth: <path d='M23 39q5-2.5 11 0' fill='none' {...line}/>,
        symbol: <><path d='M42 43a8 8 0 0115.6-2.6A6 6 0 0157 52H46a5 5 0 01-4-9z' fill='#fff' {...line}/><circle cx={46.5} cy={47} r={1.4} fill={INK}/><circle cx={50.5} cy={47} r={1.4} fill={INK}/><circle cx={54.5} cy={47} r={1.4} fill={INK}/><circle cx={41} cy={58} r={2.2} fill='#fff' {...line}/></>,
    },
    wow: {
        eyes: <><circle cx={21} cy={26} r={3.8} fill='#fff' {...line}/><circle cx={36} cy={26} r={3.8} fill='#fff' {...line}/><circle cx={21} cy={26} r={1.6} fill={INK}/><circle cx={36} cy={26} r={1.6} fill={INK}/></>,
        mouth: <ellipse cx={28.5} cy={39.5} rx={4} ry={5} fill={INK}/>,
        symbol: <><circle cx={51} cy={50} r={10.5} fill='#D4A46A' {...line}/><path d='M51 44v7' stroke='#fff' strokeWidth={3.4} strokeLinecap='round'/><circle cx={51} cy={55.5} r={1.9} fill='#fff'/></>,
    },
    fire: {
        eyes: <path d='M17.5 23l7 2.5M39.5 23l-7 2.5' fill='none' {...line}/>,
        mouth: smile,
        symbol: <><path d='M51 62c-6.5 0-10-4.4-10-9.4 0-6.4 6-8.6 5.4-15.6 4.2 2 7 5.4 7.6 9 1.4-1.6 2-3.4 2-5.4 3.2 2.8 5 6.6 5 11.4 0 6-4.4 10-10 10z' fill='#FF7A2F' {...line}/><path d='M51 59c-2.8 0-4.4-1.8-4.4-4 0-2.6 2.4-3.6 2.4-6.6 2.6 1.6 6.4 4 6.4 6.6 0 2.4-2 4-4.4 4z' fill='#FFD84A'/></>,
    },
    hundred: {
        eyes: dotEyes(), mouth: smile,
        symbol: <>
            <text x={50} y={54} textAnchor='middle' fontSize={15} fontWeight={900} fontStyle='italic' fill='#E23D3D' stroke={INK} strokeWidth={0.9} paintOrder='stroke' fontFamily='Arial Black, Arial, sans-serif'>100</text>
            <path d='M39 58.5h23M40.5 62h20' stroke='#E23D3D' strokeWidth={2.6} strokeLinecap='round'/>
        </>,
    },
    shipped: {
        eyes: happyEyes, mouth: smile,
        symbol: <g transform='rotate(45 51 49)'>
            <path d='M51 34c5 4 6.5 9.5 6.5 15v8h-13v-8c0-5.5 1.5-11 6.5-15z' fill='#fff' {...line}/>
            <circle cx={51} cy={47} r={2.8} fill='#3A6FD8' stroke={INK} strokeWidth={1.6}/>
            <path d='M44.5 51l-4 6h4M57.5 51l4 6h-4' fill='#E8455B' {...line}/>
            <path d='M48 57.5q3 6 6 0' fill='#FF7A2F' {...line}/>
        </g>,
    },
    question: {
        eyes: <><path d='M33 20.5l6 1.5' fill='none' {...line}/>{dotEyes()}</>,
        mouth: <path d='M22 39.5q3.5-3 7 0t7 0' fill='none' {...line}/>,
        symbol: <><circle cx={51} cy={50} r={10.5} fill='#3A6FD8' {...line}/><text x={51} y={55.5} textAnchor='middle' fontSize={15} fontWeight={900} fill='#fff' fontFamily='Arial Black, Arial, sans-serif'>?</text></>,
    },
    heads_up: {
        eyes: <><path d='M17.5 22.5l6 1.5M39.5 22.5l-6 1.5' fill='none' {...line}/>{dotEyes()}</>,
        mouth: flat,
        symbol: <><path d='M51 38.5l11 20H40z' fill='#FFB020' {...line}/><path d='M51 45.5v6' stroke={INK} strokeWidth={3} strokeLinecap='round'/><circle cx={51} cy={55.2} r={1.7} fill={INK}/></>,
    },
    waiting: {
        eyes: <path d='M17.5 26.5h6.5M33 26.5h6.5' fill='none' {...line}/>,
        mouth: flat,
        symbol: <><path d='M43.5 38.5h15M43.5 61.5h15' stroke={INK} strokeWidth={W + 0.6} strokeLinecap='round'/><path d='M45 39v3.5q0 4.5 6 7.5 6-3 6-7.5V39zM45 61v-3.5q0-4.5 6-7.5 6 3 6 7.5V61z' fill='#CFE0FF' {...line}/><path d='M47.5 59.5q3.5-4 7 0z' fill='#D4A46A'/></>,
    },
    sparkles: {
        eyes: happyEyes, mouth: smile,
        symbol: <><path d='M50 37q1.8 7.2 9 9-7.2 1.8-9 9-1.8-7.2-9-9 7.2-1.8 9-9z' fill='#FFD84A' {...line}/><path d='M58.5 51.5q.9 3.6 4.5 4.5-3.6.9-4.5 4.5-.9-3.6-4.5-4.5 3.6-.9 4.5-4.5z' fill='#FFD84A' stroke={INK} strokeWidth={1.6} strokeLinejoin='round'/></>,
    },
    idea: {
        eyes: <><circle cx={21} cy={26} r={3.4} fill={INK}/><circle cx={36} cy={26} r={3.4} fill={INK}/><circle cx={22.2} cy={24.8} r={1.1} fill='#fff'/><circle cx={37.2} cy={24.8} r={1.1} fill='#fff'/></>,
        mouth: grin,
        symbol: <><path d='M51 35a9.5 9.5 0 00-5.6 17.2V55h11.2v-2.8A9.5 9.5 0 0051 35z' fill='#FFF0A8' {...line}/><path d='M46.5 58.5h9M48 62h6' stroke={INK} strokeWidth={W} strokeLinecap='round'/><path d='M48.5 48q2.5 2.5 5 0' fill='none' stroke='#D4A46A' strokeWidth={1.8} strokeLinecap='round'/></>,
    },
};

// One Crew reaction. `pop` plays its little entrance once (not with reduced motion).
export function Crew({id, size = 20, pop = false, title}: {id: CrewId; size?: number; pop?: boolean; title?: string}) {
    const clip = useId();
    const p = PARTS[id];
    return (
        <svg
            viewBox='0 0 64 64'
            width={size}
            height={size}
            role='img'
            aria-label={title ?? crewName(id)}
            className={`shrink-0 ${pop ? 'crew-pop' : ''}`}
        >
            <title>{title ?? crewName(id)}</title>
            <defs>
                <clipPath id={clip}><circle cx={29} cy={30} r={23}/></clipPath>
            </defs>
            <circle cx={29} cy={30} r={23} fill={SHADE}/>
            <circle cx={25.5} cy={26.5} r={23} fill={FACE} clipPath={`url(#${clip})`}/>
            <circle cx={29} cy={30} r={23} fill='none' stroke={INK} strokeWidth={W}/>
            <ellipse cx={15} cy={35.5} rx={4} ry={2.6} fill={CHEEK} opacity={0.75}/>
            <ellipse cx={41.5} cy={35.5} rx={4} ry={2.6} fill={CHEEK} opacity={0.75}/>
            {p.eyes}
            {p.mouth}
            {p.extra}
            {/* the symbol is the point of the reaction: drawn large, over the lower right */}
            <g transform='translate(50 49) scale(1.14) translate(-51 -50)'>{p.symbol}</g>
        </svg>
    );
}

// A reaction that isn't one of ours (left by an old client): shown as-is.
export function ReactionGlyph({emoji, size = 16, pop = false}: {emoji: string; size?: number; pop?: boolean}) {
    const id = crewId(emoji);
    return id ? <Crew id={id} size={size} pop={pop}/> : <span style={{fontSize: size * 0.85, lineHeight: 1}}>{emoji}</span>;
}
