import '../styles/app.css';

import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';

import {isTauri} from '../lib/native';

import {App} from './App';

if (!isTauri) {
    document.documentElement.classList.add('browser-preview');
}

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <App/>
    </StrictMode>,
);
