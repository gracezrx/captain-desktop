const timeFmt = new Intl.DateTimeFormat(undefined, {hour: 'numeric', minute: '2-digit'});
const dayFmt = new Intl.DateTimeFormat(undefined, {month: 'short', day: 'numeric'});
const weekdayFmt = new Intl.DateTimeFormat(undefined, {weekday: 'short'});

export function timeOfDay(ts: number): string {
    return timeFmt.format(ts);
}

// Short label for lists: "11:02", "Yesterday", "Tue", "Oct 21".
export function shortWhen(ts: number): string {
    const d = new Date(ts);
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (ts >= startOfToday) {
        return timeFmt.format(d);
    }
    if (ts >= startOfToday - 86400000) {
        return 'Yesterday';
    }
    if (ts >= startOfToday - 6 * 86400000) {
        return weekdayFmt.format(d);
    }
    return dayFmt.format(d);
}

export function dayLabel(ts: number): string {
    const label = shortWhen(ts);
    return /\d:\d\d/.test(label) ? 'Today' : label;
}
