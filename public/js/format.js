import { UNLIMITED } from './constants.js';

export const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
export const show = (n) => (n === null || n === undefined ? '—' : n === UNLIMITED ? 'unlimited' : String(round(n, 4)));
export const cards = (n) => `${show(n)} ${n === 1 ? 'card' : 'cards'}`;

export function ago(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}
