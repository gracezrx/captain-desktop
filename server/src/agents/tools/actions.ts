// Tools that make something or reach outside the workspace.
// - request_approval: ask a person to sign off before the agent goes on
// - send_email: real email over SMTP, always after a person approves

import {config} from '../../config.js';
import {audit} from '../../store/audit.js';
import {sendMail} from '../../util/mail.js';

import {str, type Tool} from './types.js';

export const requestApproval: Tool = {
    name: 'request_approval',
    description: 'Ask a person to approve something before you continue (spending money, publishing, contacting people outside the team, anything hard to undo). Never for searching, opening pages or reading documents, which need no approval. You will be told whether they approved.',
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


// The card shows exactly what gets sent: same fields, same limits.
const TO_MAX = 500;
const SUBJECT_MAX = 200;
const BODY_MAX = 20_000;

function recipients(raw: unknown): string[] {
    return str(raw, TO_MAX).split(/[,;\s]+/).map((s) => s.trim()).filter((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s));
}


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
            {label: 'To', value: recipients(args.to).join(', ') || '(no valid address)'},
            {label: 'Subject', value: str(args.subject, SUBJECT_MAX)},
            {label: 'Message', value: str(args.body, BODY_MAX)},
        ],
    }),
    async run(tc, args) {
        const to = recipients(args.to);
        if (!to.length || to.length > 20) {
            return {content: 'The email was not sent: the recipient list is empty, invalid or longer than 20 addresses.'};
        }
        if (!config.tools.smtpUrl) {
            return {content: 'Approved, but this server has no email account set up (SMTP_URL), so nothing was sent. Tell the person to copy the draft and send it themselves.'};
        }
        // A daily cap per workspace, so an open sign-up can't turn the server into a spam relay.
        const [{n}] = await tc.ctx.sql`
            select coalesce(sum((meta->>'recipients')::int), 0)::int as n from audit_log
            where workspace_id = ${tc.channel.workspaceId} and action = 'email_sent' and created_at > ${Date.now() - 86_400_000}`;
        if (Number(n) + to.length > config.tools.emailDailyLimit) {
            return {content: `The email was not sent: this workspace has reached its limit of ${config.tools.emailDailyLimit} email recipients a day.`};
        }
        const messageId = await sendMail({
            fromName: `${tc.requester.displayName} via Captain`,
            replyTo: tc.requester.email ?? undefined,
            to,
            subject: str(args.subject, SUBJECT_MAX),
            text: str(args.body, BODY_MAX),
        });
        audit(tc.ctx.sql, {workspaceId: tc.channel.workspaceId, userId: tc.requester.id, action: 'email_sent', target: tc.run.id, meta: {recipients: to.length, messageId}});
        return {content: `Email sent to ${to.join(', ')}.`};
    },
};
