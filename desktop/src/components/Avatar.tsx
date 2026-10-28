import type {User} from '../lib/types';

export const PORTRAITS = ['fox', 'owl', 'panda', 'rabbit', 'cat', 'penguin'];

export function portraitSrc(portrait: string | null | undefined, fallbackKey = ''): string {
    if (portrait === 'captain') {
        return '/captain-mark.png';
    }
    if (portrait && PORTRAITS.includes(portrait)) {
        return `/agents/${portrait}.png`;
    }
    let h = 0;
    for (const ch of fallbackKey) {
        h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    }
    return `/agents/${PORTRAITS[h % PORTRAITS.length]}.png`;
}

function initials(user: User): string {
    const parts = (user.displayName || user.username).trim().split(/\s+/);
    return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

// A stable, friendly color per person.
const TONES = ['#3a6fd8', '#6a5cd6', '#1f9d8b', '#d0703c', '#c2477a', '#2f8fd1', '#7a8f2a'];
function toneFor(id: string): string {
    let h = 0;
    for (const ch of id) {
        h = (h * 33 + ch.charCodeAt(0)) >>> 0;
    }
    return TONES[h % TONES.length];
}

type Props = {user?: User; size?: number; className?: string};

// People get initials on a color of their own; agents get Captain's animal
// portraits, and the Captain coordinator the anchor mark.
export function Avatar({user, size = 32, className = ''}: Props) {
    const style = {width: size, height: size, borderRadius: Math.round(size * 0.32)};
    if (!user) {
        return <span className={`inline-block shrink-0 bg-tint ${className}`} style={style}/>;
    }
    if (user.isBot) {
        const isCaptain = user.portrait === 'captain';
        return (
            <span className={`inline-flex shrink-0 items-center justify-center overflow-hidden bg-white ring-1 ring-line ${className}`} style={style} aria-hidden>
                <img
                    src={portraitSrc(user.portrait, user.username)}
                    alt=''
                    width={size}
                    height={size}
                    style={{width: isCaptain ? '72%' : '100%', height: isCaptain ? '72%' : '100%', objectFit: 'contain'}}
                    draggable={false}
                />
            </span>
        );
    }
    return (
        <span
            className={`inline-flex shrink-0 items-center justify-center font-bold text-white ${className}`}
            style={{...style, fontSize: Math.round(size * 0.38), background: toneFor(user.id)}}
            aria-hidden
        >
            {initials(user)}
        </span>
    );
}
