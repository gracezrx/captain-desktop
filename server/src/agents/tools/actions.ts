// Tools that make something or reach outside the workspace.
// - create_document: a Markdown file attached to the agent's reply
// - request_approval: ask a person to sign off before the agent goes on
// - send_email: real email over SMTP, always after a person approves

import nodemailer from 'nodemailer';

import {storeFile} from '../../app/files.js';
import {config} from '../../config.js';

import {str, type Tool} from './types.js';

export const createDocument: Tool = {
    name: 'create_document',
    description: 'Create a document (Markdown) and attach it to your reply. Use for anything longer than a chat message: briefs, plans, reports, drafts.',
    parameters: {
        type: 'object',
        properties: {title: {type: 'string'}, markdown: {type: 'string', description: 'The full document in Markdown'}},
        required: ['title', 'markdown'],
    },
    external: false,
    available: () => true,
    async run(tc, args) {
        const title = str(args.title, 120).trim() || 'Document';
        const body = str(args.markdown, 200_000);
        const filename = `${title.replace(/[^\p{L}\p{N} _-]+/gu, '').trim().replace(/\s+/g, '-').slice(0, 80) || 'document'}.md`;
        const info = await storeFile(tc.ctx, {
            workspaceId: tc.channel.workspaceId, channelId: tc.channel.id, userId: tc.agentUser.id,
            name: filename, mime: 'text/markdown', data: Buffer.from(body.startsWith('#') ? body : `# ${title}\n\n${body}`, 'utf8'),
        });
        return {content: `Created "${filename}" (${body.length} characters). It will be attached to your reply.`, fileIds: [info.id]};
    },
};

export const requestApproval: Tool = {
    name: 'request_approval',
    description: 'Ask a person to approve something before you continue (spending money, publishing, contacting people outside the team, anything hard to undo). You will be told whether they approved.',
    parameters: {
        type: 'object',
        properties: {
            title: {type: 'string', description: 'What needs approval, in a few words'},
            reason: {type: 'string', description: 'Why it needs a person'},
            action: {type: 'string', description: 'Exactly what will happen if approved'},
        },
        required: ['title', 'action'],
    },
    external: true,
    available: () => true,
    describe: (args) => ({
        title: str(args.title, 120) || 'Approve this action',
        reason: str(args.reason, 400),
        fields: [{label: 'What happens', value: str(args.action, 1000)}],
    }),
    async run() {
        return {content: 'Approved. Go ahead.'};
    },
};

let transport: nodemailer.Transporter | null = null;

export const sendEmail: Tool = {
    name: 'send_email',
    description: 'Send an email. A person must approve it first; they see the recipients, subject and body.',
    parameters: {
        type: 'object',
        properties: {
            to: {type: 'string', description: 'Recipient addresses, comma separated'},
            subject: {type: 'string'},
            body: {type: 'string', description: 'Plain text body'},
        },
        required: ['to', 'subject', 'body'],
    },
    external: true,
    // Offered even without SMTP, so drafting and approving work; sending says it's not set up.
    available: () => true,
    describe: (args) => ({
        title: `Send email: ${str(args.subject, 100)}`,
        reason: 'This email leaves the workspace.',
        fields: [
            {label: 'To', value: str(args.to, 500)},
            {label: 'Subject', value: str(args.subject, 200)},
            {label: 'Message', value: str(args.body, 4000)},
        ],
    }),
    async run(tc, args) {
        const to = str(args.to, 500).split(/[,;\s]+/).map((s) => s.trim()).filter((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s));
        if (!to.length || to.length > 20) {
            return {content: 'The email was not sent: the recipient list is empty, invalid or longer than 20 addresses.'};
        }
        if (!config.tools.smtpUrl) {
            return {content: 'Approved, but this server has no email account set up (SMTP_URL), so nothing was sent. Tell the person to copy the draft and send it themselves.'};
        }
        transport ??= nodemailer.createTransport(config.tools.smtpUrl);
        const info = await transport.sendMail({
            from: config.tools.mailFrom || undefined,
            replyTo: tc.requester.email ?? undefined,
            to,
            subject: str(args.subject, 200),
            text: str(args.body, 50_000),
        });
        return {content: `Email sent to ${to.join(', ')} (message id ${info.messageId}).`};
    },
};
