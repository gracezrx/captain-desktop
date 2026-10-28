import {resolve} from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import {defineConfig} from 'vite';

// Two pages, one bundle: the dashboard window (index.html) and the
// menu bar panel (panel.html). Tauri loads them from the dev server in
// development and from dist/ in a release build.
export default defineConfig({
    plugins: [react(), tailwindcss()],
    clearScreen: false,
    server: {
        port: 1420,
        strictPort: true,
    },
    envPrefix: ['VITE_', 'TAURI_ENV_'],
    build: {
        target: 'safari16',
        rollupOptions: {
            input: {
                main: resolve(__dirname, 'index.html'),
                panel: resolve(__dirname, 'panel.html'),
            },
        },
    },
});
