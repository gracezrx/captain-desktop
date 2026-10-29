import fs from 'node:fs';
import {resolve} from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import {defineConfig, type Plugin} from 'vite';

// The Chrome extension (dist-extension/): the popup and side panel pages,
// built from the same code as the Mac app's menu bar panel, and a background
// worker. Load dist-extension in chrome://extensions → Load unpacked.
const copyManifest: Plugin = {
    name: 'captain-extension-files',
    generateBundle() {
        const dir = resolve(__dirname, 'extension');
        this.emitFile({type: 'asset', fileName: 'manifest.json', source: fs.readFileSync(resolve(dir, 'manifest.json'))});
        for (const f of fs.readdirSync(resolve(dir, 'icons'))) {
            this.emitFile({type: 'asset', fileName: `icons/${f}`, source: fs.readFileSync(resolve(dir, 'icons', f))});
        }
    },
};

export default defineConfig({
    plugins: [react(), tailwindcss(), copyManifest],
    build: {
        outDir: 'dist-extension',
        emptyOutDir: true,
        target: 'chrome120',
        modulePreload: false,
        rollupOptions: {
            input: {
                popup: resolve(__dirname, 'extension/popup.html'),
                sidepanel: resolve(__dirname, 'extension/sidepanel.html'),
                background: resolve(__dirname, 'src/extension/background.ts'),
            },
            output: {
                entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
            },
        },
    },
});
