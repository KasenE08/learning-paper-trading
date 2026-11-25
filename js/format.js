const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const money = n => (n == null || isNaN(n) ? '—' : usd.format(n));
export const signedMoney = n => (n == null || isNaN(n) ? '—' : (n >= 0 ? '+' : '−') + usd.format(Math.abs(n)));
export const pct = n => (n == null || isNaN(n) ? '—' : (n >= 0 ? '+' : '−') + Math.abs(n).toFixed(2) + '%');
export function price(n) {
  if (n == null || isNaN(n)) return '—';
  return n >= 1 ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
}
export const tone = n => (n > 0 ? 'up' : n < 0 ? 'down' : 'flat');
export const arrow = n => (n > 0 ? '▲' : n < 0 ? '▼' : '■');
export function countdown(ms) {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return [h, m, x].map(v => String(v).padStart(2, '0')).join(':');
}
export function etWhen(date) {
  return date.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' }).toUpperCase() + ' ET';
}
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** 'YYYY-MM-DD' → 'Fri, Nov 27' */
export function day(ymd) {
  if (!ymd) return '';
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
}
