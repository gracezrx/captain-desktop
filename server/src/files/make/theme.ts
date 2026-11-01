// Captain's look for the files agents make: the app's own palette (navy ink,
// royal blue, gold for what needs a person) and one modern Office typeface.

export const BRAND = {
    navy: '142769', // ink: titles, table headers, dark slides
    night: '0F1C52', // the darkest navy, behind title slides
    royal: '3A6FD8', // accent: bars, bullets, the first chart series
    deep: '2A56B8', // links and second-level headings
    text: '2A3654',
    muted: '6B7891',
    line: 'E3E9F4',
    tint: 'EEF3FD', // zebra rows, callouts
    subtle: 'F7F9FD',
    gold: 'D4A46A',
    goldTint: 'FDF6EC',
    goldText: '7A5524',
    white: 'FFFFFF',
    onDark: 'C9D6F5', // secondary text on navy
};

// Chart series, in order: blue, navy, gold, light blue, teal, rust.
export const SERIES = ['3A6FD8', '142769', 'D4A46A', '7FA6FF', '2A9D8F', 'C2410C'];

// Aptos is Office's own typeface (Word, PowerPoint and Excel on Mac and
// Windows); Google converts it to its nearest match.
export const FONT = {head: 'Aptos Display', body: 'Aptos', mono: 'Menlo'};

export function today(): string {
    return new Date().toLocaleDateString('en-US', {month: 'long', day: 'numeric', year: 'numeric'});
}

// A file name from a title, as people would name it ("Launch brief"):
// letters, numbers, spaces, dashes and a few safe marks.
export function fileStem(title: string): string {
    return title.replace(/[^\p{L}\p{N} _.,&()'-]+/gu, ' ').replace(/\s+/g, ' ').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 80).trim() || 'Document';
}
