import pino from 'pino';

import {config} from '../config.js';

// One structured logger for code outside a request (jobs, agents, hub).
// Request handlers use request.log, which carries the request id.
export const log = pino({
    level: config.logLevel,
    base: undefined,
    redact: ['req.headers.authorization', '*.password', '*.token', '*.apiKey'],
    ...(config.production ? {} : {transport: {target: 'pino-pretty', options: {colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname'}}}),
});
