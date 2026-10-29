import '../styles/app.css';

import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';

import {extensionSurface} from '../lib/native';

import {ExtensionApp} from './App';

document.documentElement.classList.add('extension', `extension-${extensionSurface ?? 'sidepanel'}`);

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <ExtensionApp/>
    </StrictMode>,
);
