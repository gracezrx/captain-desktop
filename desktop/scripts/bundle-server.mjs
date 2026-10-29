// Copies the Captain server into the Mac app's resources (src-tauri/resources/server):
// its compiled code, migrations, model catalog and production packages. The app
// runs it with the Mac's Node.js (see "built-in server" in src-tauri/src/lib.rs).

import {execSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = path.resolve(desktop, '..', 'server');
const out = path.join(desktop, 'src-tauri', 'resources', 'server');
const run = (cmd, cwd) => execSync(cmd, {cwd, stdio: 'inherit'});

if (!fs.existsSync(path.join(server, 'node_modules'))) {
    run('npm ci --no-audit --no-fund', server);
}
run('npm run build', server);

for (const entry of fs.readdirSync(out)) {
    if (entry !== 'README.md') {
        fs.rmSync(path.join(out, entry), {recursive: true, force: true});
    }
}
const copy = (from, to = from) => fs.cpSync(path.join(server, from), path.join(out, to), {recursive: true});
copy('dist');
copy('config');
copy(path.join('src', 'db', 'migrations'));
copy('package.json');
// The web app too, so Captain on this Mac also opens in a browser (and the
// Chrome extension's "open dashboard" has somewhere to go).
const web = path.join(desktop, 'dist');
if (fs.existsSync(path.join(web, 'index.html'))) {
    fs.cpSync(web, path.join(out, 'web'), {recursive: true});
}
copy('package-lock.json');
run('npm ci --omit=dev --no-audit --no-fund --ignore-scripts', out);
fs.rmSync(path.join(out, 'node_modules', '.bin'), {recursive: true, force: true});
fs.rmSync(path.join(out, 'package-lock.json'), {force: true});

let bytes = 0;
const walk = (dir) => {
    for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            walk(p);
        } else {
            bytes += fs.statSync(p).size;
        }
    }
};
walk(out);
console.log(`bundled the server: ${(bytes / 1e6).toFixed(1)} MB`);
