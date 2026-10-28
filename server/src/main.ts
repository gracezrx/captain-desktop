import {boot} from './boot.js';
import {config} from './config.js';
import {log} from './util/log.js';

const instance = await boot();
await instance.app.listen({port: config.port, host: config.host});
log.info({url: config.publicUrl}, 'Captain is running');

let stopping = false;
async function shutdown(signal: string) {
    if (stopping) {
        return;
    }
    stopping = true;
    log.info({signal}, 'shutting down');
    const force = setTimeout(() => process.exit(1), 20_000);
    try {
        await instance.stop();
    } finally {
        clearTimeout(force);
        process.exit(0);
    }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (err) => log.error({err}, 'unhandled rejection'));
