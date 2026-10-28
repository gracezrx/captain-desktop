// The API contract lives with the server; the app only imports its types.
export type * from '../../../server/src/shared/types';

import type {Post} from '../../../server/src/shared/types';

// A message as the app holds it: the server's copy, or an optimistic one
// still on its way (pending) or that failed to send.
export type ClientPost = Post & {pending?: boolean; failed?: boolean};
