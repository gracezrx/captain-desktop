import '../styles/app.css';

import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';

import {Orb} from './Orb';

document.documentElement.classList.add('orb-html');

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <Orb/>
    </StrictMode>,
);
