// App-wide settings. RELAY_URL is filled in once the Cloudflare Worker is deployed;
// it can also be set in-app under Menu → Data relay.
export const RELAY_URL = '';
export const REFRESH_MS = 5000;          // live quote refresh while a session is open
export const CHART_REFRESH_MS = 60000;   // full chart re-sync
export const DEFAULT_SYMBOL = 'SPY';
export const MIN_BALANCE = 100;
export const MAX_BALANCE = 10_000_000;
export const APP_VERSION = '0.2.0';
