const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const weekdayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const shortDateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const longDateFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const fullFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short' });

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const daysBetween = (a: Date, b: Date) => Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / 86_400_000);

/** "3:42 PM": shown next to each message. */
export function formatMessageTime(iso: string): string {
  return timeFormat.format(new Date(iso));
}

/** Full date and time, for tooltips and screen readers. */
export function formatFullTimestamp(iso: string): string {
  return fullFormat.format(new Date(iso));
}

/** Conversation list: the time today, the weekday this week, otherwise the date. */
export function formatListTimestamp(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const days = daysBetween(date, now);
  if (days <= 0) return timeFormat.format(date);
  if (days < 7) return weekdayFormat.format(date);
  return shortDateFormat.format(date);
}

/** Day separator in the message list: "Today", "Yesterday", or the date. */
export function formatDayLabel(iso: string, now = new Date()): string {
  const days = daysBetween(new Date(iso), now);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return longDateFormat.format(new Date(iso));
}

export function isSameDay(a: string, b: string): boolean {
  return startOfDay(new Date(a)).getTime() === startOfDay(new Date(b)).getTime();
}
