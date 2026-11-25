// US equity market calendar & sessions (NYSE/Nasdaq rules), computed in America/New_York.
// Sessions: pre-market 4:00–9:30, regular 9:30–16:00, after-hours 16:00–20:00 ET.
// Early-close days: regular ends 13:00, after-hours ends 17:00.

const TZ = 'America/New_York';
const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, year: 'numeric', month: 'numeric', day: 'numeric',
  hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23', weekday: 'short',
});
const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// One-off closures not covered by the rules (e.g. national days of mourning).
const SPECIAL_CLOSED = new Set(['2025-01-09']);

export const SESSION = { PRE: 'pre', REGULAR: 'regular', POST: 'post', CLOSED: 'closed' };
export const MIN = { PRE_OPEN: 240, OPEN: 570, CLOSE: 960, EARLY_CLOSE: 780, POST_CLOSE: 1200, EARLY_POST_CLOSE: 1020 };

/** Wall-clock parts of a Date in New York. */
export function etParts(date = new Date()) {
  const p = Object.fromEntries(fmt.formatToParts(date).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour, mm: +p.minute, ss: +p.second, dow: DOW[p.weekday] };
}

export const ymd = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
export const etYmd = (date = new Date()) => { const p = etParts(date); return ymd(p.y, p.m, p.d); };

/** UTC offset (minutes) of New York at a given instant. */
export function etOffsetMinutes(date) {
  const p = etParts(date);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

/** Date for a New York wall-clock time. */
export function etDate(y, m, d, minutes = 0) {
  const guess = new Date(Date.UTC(y, m - 1, d, 0, minutes));
  let t = guess.getTime() - etOffsetMinutes(guess) * 60000;
  t = guess.getTime() - etOffsetMinutes(new Date(t)) * 60000; // second pass for DST edges
  return new Date(t);
}

// ---- holiday rules -------------------------------------------------------
const dowOf = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();
function nthWeekday(y, m, dow, n) { // n-th (1-based) weekday of month
  const first = dowOf(y, m, 1);
  return 1 + ((dow - first + 7) % 7) + (n - 1) * 7;
}
function lastWeekday(y, m, dow) {
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return last - ((dowOf(y, m, last) - dow + 7) % 7);
}
function easter(y) { // Anonymous Gregorian algorithm
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return [month, day];
}
function shift(y, m, d, days) { const t = new Date(Date.UTC(y, m - 1, d + days)); return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()]; }
// Saturday holiday -> Friday before, Sunday -> Monday after.
function observed(y, m, d) { const w = dowOf(y, m, d); return w === 6 ? shift(y, m, d, -1) : w === 0 ? shift(y, m, d, 1) : [y, m, d]; }

const holidayCache = new Map();
export function holidays(y) {
  if (holidayCache.has(y)) return holidayCache.get(y);
  const list = new Map();
  const add = (name, [yy, mm, dd]) => { if (yy === y) list.set(ymd(yy, mm, dd), name); };
  // New Year's Day: if Jan 1 is Saturday, NYSE does not close the Friday before.
  if (dowOf(y, 1, 1) !== 6) add("New Year's Day", observed(y, 1, 1));
  add('Martin Luther King Jr. Day', [y, 1, nthWeekday(y, 1, 1, 3)]);
  add("Washington's Birthday", [y, 2, nthWeekday(y, 2, 1, 3)]);
  const [em, ed] = easter(y); add('Good Friday', shift(y, em, ed, -2));
  add('Memorial Day', [y, 5, lastWeekday(y, 5, 1)]);
  if (y >= 2022) add('Juneteenth', observed(y, 6, 19));
  add('Independence Day', observed(y, 7, 4));
  add('Labor Day', [y, 9, nthWeekday(y, 9, 1, 1)]);
  add('Thanksgiving Day', [y, 11, nthWeekday(y, 11, 4, 4)]);
  add('Christmas Day', observed(y, 12, 25));
  for (const s of SPECIAL_CLOSED) if (s.startsWith(String(y))) list.set(s, 'Market closed');
  holidayCache.set(y, list);
  return list;
}

export function isWeekend(y, m, d) { const w = dowOf(y, m, d); return w === 0 || w === 6; }
export function holidayName(y, m, d) { return holidays(y).get(ymd(y, m, d)) || null; }
export function isTradingDay(y, m, d) { return !isWeekend(y, m, d) && !holidayName(y, m, d); }

/** Early close (1:00 PM ET): Jul 3, day after Thanksgiving, Dec 24 — when they are trading days. */
export function isEarlyClose(y, m, d) {
  if (!isTradingDay(y, m, d)) return false;
  if (m === 7 && d === 3) return true;
  if (m === 11 && d === nthWeekday(y, 11, 4, 4) + 1) return true;
  if (m === 12 && d === 24) return true;
  return false;
}

export function dayHours(y, m, d) {
  if (!isTradingDay(y, m, d)) return null;
  const early = isEarlyClose(y, m, d);
  return { pre: MIN.PRE_OPEN, open: MIN.OPEN, close: early ? MIN.EARLY_CLOSE : MIN.CLOSE, postClose: early ? MIN.EARLY_POST_CLOSE : MIN.POST_CLOSE, early };
}

/** Next trading day strictly after the given ET date. */
export function nextTradingDay(y, m, d) {
  let [yy, mm, dd] = shift(y, m, d, 1);
  for (let i = 0; i < 15 && !isTradingDay(yy, mm, dd); i++) [yy, mm, dd] = shift(yy, mm, dd, 1);
  return [yy, mm, dd];
}
/** Add n trading days (used for T+1 settlement). */
export function addTradingDays(y, m, d, n) { let c = [y, m, d]; for (let i = 0; i < n; i++) c = nextTradingDay(...c); return c; }

/**
 * Market state at an instant.
 * @returns {{session, label, early, holiday, next: Date, nextLabel, sessionEnd: Date|null}}
 */
export function marketState(now = new Date()) {
  const p = etParts(now), mins = p.hh * 60 + p.mm + p.ss / 60;
  const h = dayHours(p.y, p.m, p.d);
  const at = min => etDate(p.y, p.m, p.d, min);
  const nextOpenDay = () => { const n = nextTradingDay(p.y, p.m, p.d); return { pre: etDate(...n, MIN.PRE_OPEN), open: etDate(...n, MIN.OPEN) }; };
  if (h) {
    if (mins < h.pre) return st(SESSION.CLOSED, 'Market closed', at(h.pre), 'Pre-market in', null, h.early);
    if (mins < h.open) return st(SESSION.PRE, 'Pre-market', at(h.open), 'Opens in', at(h.open), h.early);
    if (mins < h.close) return st(SESSION.REGULAR, 'Market open', at(h.close), 'Closes in', at(h.close), h.early);
    if (mins < h.postClose) return st(SESSION.POST, 'After-hours', at(h.postClose), 'Ends in', at(h.postClose), h.early);
  }
  const n = nextOpenDay();
  return st(SESSION.CLOSED, 'Market closed', n.pre, 'Pre-market in', null, false, holidayName(p.y, p.m, p.d));
}
function st(session, label, next, nextLabel, sessionEnd, early, holiday = null) {
  return { session, label, next, nextLabel, sessionEnd, early: !!early, holiday };
}

/** Is a unix timestamp (seconds) within regular hours of its ET day? */
export function isRegularHours(ts) {
  const d = new Date(ts * 1000), p = etParts(d), h = dayHours(p.y, p.m, p.d);
  if (!h) return false;
  const mins = p.hh * 60 + p.mm;
  return mins >= h.open && mins < h.close;
}
