// Export / import / reset. All data lives in localStorage on this phone.
import * as store from './store.js';
import * as fmt from './format.js';
import { $, sheet, closeSheet, toast } from './ui.js';
import { APP_VERSION } from './config.js';

const APP = 'learn-paper-trading';

export function backupJson() {
  return JSON.stringify({ app: APP, format: 1, appVersion: APP_VERSION, exportedAt: new Date().toISOString(), state: store.get() }, null, 1);
}
const fileName = () => `learn-paper-trading-backup-${new Date().toISOString().slice(0, 10)}.json`;

/** Save a backup: share sheet on iPhone (Save to Files), download link elsewhere. */
export async function exportBackup() {
  const json = backupJson(), name = fileName();
  const file = new File([json], name, { type: 'application/json' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Learn Paper Trading backup' });
      return 'shared';
    }
  } catch (e) { if (e.name === 'AbortError') return 'canceled'; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return 'downloaded';
}

/** Check an imported file. Returns { ok, state, error, summary }. */
export function parseBackup(text) {
  let obj;
  try { obj = JSON.parse(text); } catch { return { ok: false, error: 'This file isn’t valid JSON.' }; }
  if (!obj || obj.app !== APP || !obj.state) return { ok: false, error: 'This isn’t a Learn Paper Trading backup file.' };
  const s = obj.state;
  if (!s.account || !(s.account.startingBalance > 0)) return { ok: false, error: 'The backup has no account in it.' };
  if (s.trading && (!Array.isArray(s.trading.fills) || !Array.isArray(s.trading.orders))) return { ok: false, error: 'The backup’s trade history is damaged.' };
  return { ok: true, state: s, exportedAt: obj.exportedAt, summary: { start: s.account.startingBalance, trades: s.trading?.fills?.length || 0, opened: s.account.createdAt } };
}

export function importFlow() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'application/json,.json';
  input.addEventListener('change', async () => {
    const f = input.files?.[0]; if (!f) return;
    const r = parseBackup(await f.text());
    if (!r.ok) return toast(r.error, 5000);
    sheet(`<h3>IMPORT BACKUP</h3>
      <p class="w">Replace the account on this phone with this backup?</p>
      <div class="est">
        <div class="kv"><span class="d">Backup from</span><span class="w">${r.exportedAt ? new Date(r.exportedAt).toLocaleString() : '—'}</span></div>
        <div class="kv"><span class="d">Starting balance</span><span class="w">${fmt.money(r.summary.start)}</span></div>
        <div class="kv"><span class="d">Trades</span><span class="w">${r.summary.trades}</span></div>
      </div>
      <p class="d">Your current account will be erased. This can’t be undone.</p>
      <div class="btns"><button class="btn" data-close style="border-color:var(--line-hi)">CANCEL</button><button class="btn cy" id="doImport">REPLACE</button></div>`,
      el => $('#doImport', el).addEventListener('click', () => { store.replace(r.state); closeSheet(); location.reload(); }));
  });
  input.click();
}

export function resetFlow() {
  sheet(`<h3>RESET ACCOUNT</h3>
    <p class="w">This erases everything on this phone: your balance, positions, orders, trade history and learning progress. It can’t be undone.</p>
    <button class="btn cy wide" id="rExport">EXPORT A BACKUP FIRST</button>
    <div class="lbl" style="margin-top:14px">Type RESET to confirm</div>
    <label class="field" style="margin:6px 0 14px"><input id="rText" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="RESET"></label>
    <div class="btns"><button class="btn" data-close style="border-color:var(--line-hi)">CANCEL</button><button class="btn sell" id="rGo" disabled>RESET</button></div>`,
    el => {
      $('#rExport', el).addEventListener('click', async () => { const r = await exportBackup(); if (r !== 'canceled') toast('Backup saved.'); });
      $('#rText', el).addEventListener('input', e => { $('#rGo', el).disabled = e.target.value.trim() !== 'RESET'; });
      $('#rGo', el).addEventListener('click', () => { store.wipe(); closeSheet(); location.reload(); });
    });
}
