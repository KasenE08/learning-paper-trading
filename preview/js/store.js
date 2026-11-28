// On-device state (localStorage only).
import { migrate, freshTrading } from './engine.js';
const KEY = 'lpt.v1';
const defaults = () => ({
  version: 1,
  account: null,               // { startingBalance, settled, unsettled:[{amount, settles}], createdAt }
  trading: freshTrading(),
  settings: { relayUrl: '', symbol: null, range: '1D', intervals: {} },
  recentSearches: [],          // [{symbol, name}]
  dismissedTips: {},
});

let state = load();
const listeners = new Set();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    const s = JSON.parse(raw), d = defaults();
    return migrate({ ...d, ...s, settings: { ...d.settings, ...(s.settings || {}) } });
  } catch { return defaults(); }
}
function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { console.warn('save failed', e); }
  listeners.forEach(fn => fn(state));
}

export const get = () => state;
export function update(fn) { fn(state); persist(); }
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function createAccount(amount) {
  update(s => { s.account = { startingBalance: amount, settled: amount, unsettled: [], createdAt: Date.now() }; s.trading = freshTrading(); });
}
export function addRecent(item) {
  update(s => {
    s.recentSearches = [item, ...s.recentSearches.filter(r => r.symbol !== item.symbol)].slice(0, 8);
  });
}

/** Replace everything with an imported state (validated by the caller). */
export function replace(next) { state = migrate({ ...defaults(), ...next, settings: { ...defaults().settings, ...(next.settings || {}) } }); persist(); }
/** Erase all saved data on this device. */
export function wipe() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } state = defaults(); }
