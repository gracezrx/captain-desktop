// Outgoing email over SMTP (SMTP_URL). One transport for the whole server.

import nodemailer from 'nodemailer';

import {config} from '../config.js';

let transport: nodemailer.Transporter | null = null;

export function mailEnabled(): boolean {
    return Boolean(config.tools.smtpUrl);
}

export function fromAddress(): string {
    const m = config.tools.mailFrom.match(/<([^>]+)>/);
    return (m ? m[1] : config.tools.mailFrom).trim();
}

export async function sendMail(m: {to: string[]; subject: string; text: string; fromName?: string; replyTo?: string}): Promise<string> {
    if (!config.tools.smtpUrl) {
        throw new Error('email is not set up on this server (SMTP_URL)');
    }
    transport ??= nodemailer.createTransport(config.tools.smtpUrl);
    const info = await transport.sendMail({
        from: {name: m.fromName ?? 'Captain', address: fromAddress()},
        replyTo: m.replyTo,
        to: m.to,
        subject: m.subject,
        text: m.text,
    });
    return info.messageId;
}
