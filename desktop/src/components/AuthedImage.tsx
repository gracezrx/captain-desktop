import {useEffect, useState} from 'react';

import {authedObjectUrl} from '../lib/mm';

type Props = {src: string; alt: string; className?: string; onClick?: () => void};

export function AuthedImage({src, alt, className, onClick}: Props) {
    const [url, setUrl] = useState<string | null>(null);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
        let alive = true;
        authedObjectUrl(src).then((u) => alive && setUrl(u)).catch(() => alive && setFailed(true));
        return () => {
            alive = false;
        };
    }, [src]);
    if (failed) {
        return <div className={`grid place-items-center bg-tint text-xs text-muted ${className}`}>Image unavailable</div>;
    }
    if (!url) {
        return <div className={`animate-pulse bg-tint ${className}`}/>;
    }
    return <img src={url} alt={alt} className={className} onClick={onClick} draggable={false}/>;
}
