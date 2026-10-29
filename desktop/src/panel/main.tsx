import '../styles/app.css';

import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';

import {isTauri, openLinksInBrowser} from '../lib/native';

import {Panel} from './Panel';

if (!isTauri) {
    document.documentElement.classList.add('browser-preview');
    document.body.classList.add('browser-preview');
}

openLinksInBrowser();

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <Panel/>
    </StrictMode>,
);
