// Client for the Cloudflare Worker relay.
import { RELAY_URL } from './config.js';
import { get } from './store.js';

export class RelayMissingError extends Error { constructor() { super('Data relay not set up'); this.code = 'NO_RELAY'; } }

export const relayUrl = () => (get().settings.relayUrl || RELAY_URL || '').replace(/\/+$/, '');

async function call(path, params = {}, timeout = 10000) {
  const base = relayUrl();
  if (!base) throw new RelayMissingError();
  const qs = new URLSearchParams(params).toString();
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(`${base}${path}${qs ? '?' + qs : ''}`, { signal: ctrl.signal, cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(body.error || `relay error ${res.status}`); e.status = res.status; throw e; }
    return body;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Relay timed out');
    if (e instanceof TypeError) throw new Error('Can’t reach the data relay');
    throw e;
  } finally { clearTimeout(timer); }
}

export const health = () => call('/health', {}, 6000);
export const search = q => call('/search', { q });
export const quotes = symbols => call('/quote', { symbols: symbols.join(',') });
export const chart = (symbol, range, interval, prepost) =>
  call('/chart', { symbol, range, interval, ...(prepost ? { prepost: '1' } : {}) });
