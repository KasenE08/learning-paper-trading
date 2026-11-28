// App-wide settings. RELAY_URL is filled in once the Cloudflare Worker is deployed;
// it can also be set in-app under Menu → Data relay.
export const RELAY_URL = 'https://learning-paper-trading.ertel-kasen.workers.dev';
export const REFRESH_MS = 5000;          // live quote refresh while a session is open
export const CHART_REFRESH_MS = 60000;   // full chart re-sync
export const DEFAULT_SYMBOL = 'SPY';
export const MIN_BALANCE = 0.01;               // any positive amount
export const MAX_BALANCE = 1_000_000_000_000;  // technical cap: larger values can't be tracked to the cent
export const APP_VERSION = '0.7.0';
