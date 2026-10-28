import type {UserProfile} from '@mattermost/types/users';

const PORTRAITS = ['fox', 'owl', 'panda', 'rabbit', 'cat', 'penguin'];

function portraitFor(user: UserProfile): string {
    const chosen = (user.props as Record<string, string> | undefined)?.portrait;
    if (chosen && PORTRAITS.includes(chosen)) {
        return chosen;
    }
    let h = 0;
    for (const ch of user.username) {
        h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    }
    return PORTRAITS[h % PORTRAITS.length];
}

function initials(user: UserProfile): string {
    const a = user.first_name || user.username;
    return ((a[0] ?? '?') + (user.last_name?.[0] ?? '')).toUpperCase();
}

type Props = {user?: UserProfile; size?: number; className?: string};

// People get initials on royal blue; agents get Captain's animal portraits,
// and the Captain agent itself gets the anchor mark.
export function Avatar({user, size = 32, className = ''}: Props) {
    const style = {width: size, height: size, borderRadius: Math.round(size * 0.3)};
    if (!user) {
        return <span className={`inline-block shrink-0 bg-tint ${className}`} style={style}/>;
    }
    if (user.is_bot) {
        const isCaptain = user.username === 'captain';
        return (
            <span
                className={`inline-flex shrink-0 items-center justify-center overflow-hidden bg-white ring-1 ring-line ${className}`}
                style={style}
                aria-hidden
            >
                <img
                    src={isCaptain ? '/captain-mark.png' : `/agents/${portraitFor(user)}.png`}
                    alt=""
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
            className={`inline-flex shrink-0 items-center justify-center bg-royal font-semibold text-white ${className}`}
            style={{...style, fontSize: Math.round(size * 0.4)}}
            aria-hidden
        >
            {initials(user)}
        </span>
    );
}
