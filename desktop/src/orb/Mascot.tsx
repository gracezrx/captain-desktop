// The little Captain: the floating button's face, drawn from the "Captain
// Lite — floating Captain" canvas. One body, with hands, eyes, mouth and a
// ring that change with what it's doing.

export type MascotState = 'idle' | 'needs' | 'listening' | 'working' | 'speaking' | 'done';

const INK = '#142769';
const NAVY = '#1e3480';
const VISOR = '#172760';
const BODY = '#fcf9f3';
const BELLY = '#efeadf';
const CORAL = '#f0677f';
const BLUE = '#3a6fd8';
const BLUSH = '#f2a0a6';

const HAND_LEFT_DOWN = 'M30 72C25 73 21.5 77 21.5 82C21.5 87 25.5 90 29.5 89.5C31.5 89 32.5 87 32.5 84Z';
const HAND_LEFT_UP = 'M27.5 62C25.5 56 21.5 52.6 17.8 53.1C14.4 53.6 13.7 57.6 15.3 61.3C17.3 66.2 21.8 70.2 25.8 71.2Z';
const HAND_RIGHT_UP = 'M90.5 62C92.5 56 96.5 52.6 100.2 53.1C103.6 53.6 104.3 57.6 102.7 61.3C100.7 66.2 96.2 70.2 92.2 71.2Z';
const HAND_RIGHT_DOWN = 'M89 71C94.5 72 98 76.5 98 81.5C98 86.5 94.5 89.5 90.5 89C88.5 88.7 87 86.5 87 83.5Z';

const skin = {fill: BODY, stroke: INK, strokeOpacity: 0.14, strokeWidth: 0.8};

// Where the pupils look: [left x, left y, right x, right y].
const LOOK: Record<string, [number, number, number, number]> = {
    ahead: [45.6, 62.6, 75, 60.1],
    listening: [44.5, 62.4, 76, 59.9],
    up: [43.4, 61.8, 74.9, 59.3],
};

function Eyes({look}: {look: keyof typeof LOOK}) {
    const [lx, ly, rx, ry] = LOOK[look];
    return (
        <g className='m-eyes'>
            <circle cx={44.5} cy={63.5} r={6.8} fill='#ffffff'/>
            <circle cx={lx} cy={ly} r={5.5} fill='#0d1640'/>
            <circle cx={lx - 1.7} cy={ly - 1.9} r={1.6} fill='#ffffff'/>
            <circle cx={76} cy={61} r={6.8} fill='#ffffff'/>
            <circle cx={rx} cy={ry} r={5.5} fill='#0d1640'/>
            <circle cx={rx - 1.6} cy={ry - 1.9} r={1.6} fill='#ffffff'/>
        </g>
    );
}

function Mouth({state, level}: {state: MascotState; level: number}) {
    switch (state) {
    case 'listening': {
        // Four bars that follow your voice.
        const base = [2.6, 5, 6, 3.4];
        const k = 0.45 + Math.min(1, level) * 1.1;
        return (
            <g>
                {base.map((h, i) => {
                    const height = Math.max(1.6, Math.min(8, h * k));
                    return <rect key={i} x={56.2 + i * 2.6} y={67.8 - height / 2} width={1.6} height={height} rx={0.8} fill='#ffffff'/>;
                })}
            </g>
        );
    }
    case 'working':
        return (
            <g className='m-dots'>
                <circle cx={57.8} cy={67.8} r={0.95} fill='#ffffff'/>
                <circle cx={60.3} cy={67.8} r={0.95} fill='#ffffff'/>
                <circle cx={62.8} cy={67.8} r={0.95} fill='#ffffff'/>
            </g>
        );
    case 'speaking':
        return (
            <g className='m-talk'>
                <path d='M56.4 66.2Q60.3 65.6 64.2 66.2Q63.8 71.6 60.3 71.6Q56.8 71.6 56.4 66.2Z' fill='#ffffff'/>
                <path d='M58.3 69.9Q60.3 68.6 62.3 69.9Q61.5 71.2 60.3 71.2Q59.1 71.2 58.3 69.9Z' fill={BLUSH}/>
            </g>
        );
    case 'done':
        return <path d='M55.4 66.4Q60.3 73 65.2 66.4' fill='none' stroke='#ffffff' strokeWidth={2} strokeLinecap='round'/>;
    default:
        return <path d='M56.8 66.8Q60.3 70.2 63.8 66.8' fill='none' stroke='#ffffff' strokeWidth={1.7} strokeLinecap='round'/>;
    }
}

export function Mascot({state, level = 0, size = 80}: {state: MascotState; level?: number; size?: number}) {
    const leftUp = state === 'speaking' || state === 'done';
    const rightUp = state === 'idle' || state === 'needs' || state === 'done';
    return (
        <svg className={`mascot mascot-${state}`} viewBox='6 4 108 108' width={size} height={size} aria-hidden='true' style={{overflow: 'visible'}}>
            {state === 'listening' && (
                <g className='m-glow'>
                    <circle cx={58} cy={66} r={47} fill={CORAL} fillOpacity={0.13}/>
                    <circle cx={58} cy={66} r={41} fill={CORAL} fillOpacity={0.2}/>
                </g>
            )}
            {state === 'working' && (
                <g>
                    <circle cx={58} cy={66} r={46} fill='none' stroke={BLUE} strokeOpacity={0.18} strokeWidth={2.6}/>
                    <circle className='m-spin' cx={58} cy={66} r={46} fill='none' stroke={BLUE} strokeWidth={2.6} strokeLinecap='round' strokeDasharray='64 225'/>
                </g>
            )}
            <ellipse cx={43} cy={99} rx={7.2} ry={4.6} fill={NAVY}/>
            <ellipse cx={76} cy={99} rx={7.2} ry={4.4} fill={NAVY}/>
            <path d={leftUp ? HAND_LEFT_UP : HAND_LEFT_DOWN} {...skin}/>
            <path className={state === 'idle' ? 'm-wave' : undefined} d={rightUp ? HAND_RIGHT_UP : HAND_RIGHT_DOWN} {...skin}/>
            <path d='M22 64C22 41 38 30.5 60 30.5C83 30.5 95 44 95 64C95 86 83 100.5 58.5 100.5C34 100.5 22 88 22 64Z' {...skin}/>
            <path d='M26 78C30 92 42 99 58.5 99C74 99 86 92 91 80C85 90 74 95.5 58.5 95.5C43 95.5 31 89 26 78Z' fill={BELLY}/>
            <path
                d='M31 62C31 50.5 42.5 44.5 60 44.5C77.5 44.5 89 49.5 89 60.5C89 72 79 79 60 79C41.5 79 31 73 31 62Z'
                fill={VISOR}
                stroke={state === 'listening' ? CORAL : undefined}
                strokeWidth={state === 'listening' ? 1.6 : undefined}
            />
            {state === 'done' ? (
                <g>
                    <path d='M39 64.8Q44.5 58.6 50 64.8' fill='none' stroke='#ffffff' strokeWidth={2.3} strokeLinecap='round'/>
                    <path d='M70.5 62.3Q76 56.1 81.5 62.3' fill='none' stroke='#ffffff' strokeWidth={2.3} strokeLinecap='round'/>
                </g>
            ) : (
                <Eyes look={state === 'working' ? 'up' : state === 'listening' ? 'listening' : 'ahead'}/>
            )}
            <Mouth state={state} level={level}/>
            <path d='M35.6 71.6L37 70M38.2 72.2L39.6 70.6M80.6 69.4L82 67.8M83.2 70L84.6 68.4' fill='none' stroke={BLUSH} strokeWidth={1.5} strokeLinecap='round'/>
            {state === 'speaking' && (
                <g className='m-waves'>
                    <path d='M102.5 59Q106 66 102.5 73' fill='none' stroke={BLUE} strokeWidth={2.4} strokeLinecap='round'/>
                    <path d='M107 54.5Q111.5 66 107 77.5' fill='none' stroke={BLUE} strokeWidth={2.4} strokeLinecap='round'/>
                </g>
            )}
            <g transform='rotate(-18 45 28)'>
                <path d='M24 27.5C24 18.5 34 13 46 13C58 13 67 18 67 25C67 28.2 64.5 30.2 60.5 30.3L30.5 31.2C26.5 31.3 24 29.8 24 27.5Z' fill={NAVY}/>
                <path d='M31 32.6L61.2 32C62.6 32 63.2 33.2 63.2 34.6C63.2 36 62.3 37 60.8 37L32 37.8C30.6 37.8 29.8 36.8 29.8 35.4C29.8 33.8 30.2 32.6 31 32.6Z' fill={NAVY}/>
                <path d='M30.5 31.3L61 30.5' stroke='#ffffff' strokeWidth={2} strokeLinecap='round'/>
                <path d='M51.5 15.8L52.7 19.1L56 20.3L52.7 21.5L51.5 24.8L50.3 21.5L47 20.3L50.3 19.1Z' fill='#ffffff'/>
            </g>
        </svg>
    );
}
