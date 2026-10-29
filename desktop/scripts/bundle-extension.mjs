// Builds the Chrome extension and copies it into the Mac app's resources
// (src-tauri/resources/extension), so the app can hand it to Chrome
// (Settings → This Mac → Setup guide → "Show the extension in Finder").

import {execSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const built = path.join(desktop, 'dist-extension');
const out = path.join(desktop, 'src-tauri', 'resources', 'extension');

execSync('npx vite build --config vite.extension.config.ts', {cwd: desktop, stdio: 'inherit'});
if (!fs.existsSync(path.join(built, 'manifest.json'))) {
    throw new Error('The extension build has no manifest.json');
}
for (const entry of fs.readdirSync(out)) {
    if (entry !== 'README.md') {
        fs.rmSync(path.join(out, entry), {recursive: true, force: true});
    }
}
fs.cpSync(built, out, {recursive: true});
console.log('bundled the Chrome extension');
