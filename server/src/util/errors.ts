// Errors the API turns into JSON responses: {error, message, status}.

export class AppError extends Error {
    readonly status: number;
    readonly code: string;

    constructor(status: number, code: string, message: string) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

export const badRequest = (message: string, code = 'bad_request') => new AppError(400, code, message);
export const unauthorized = (message = 'Sign in to continue.') => new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'You don\'t have permission to do that.') => new AppError(403, 'forbidden', message);
export const notFound = (what = 'That') => new AppError(404, 'not_found', `${what} wasn't found.`);
export const conflict = (message: string, code = 'conflict') => new AppError(409, code, message);
export const tooMany = (message = 'Too many requests. Wait a moment and try again.') => new AppError(429, 'rate_limited', message);
export const paymentRequired = (message: string) => new AppError(402, 'budget_exceeded', message);
