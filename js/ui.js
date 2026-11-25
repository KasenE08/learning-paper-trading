// Small shared UI helpers: query, bottom sheets, toasts.
import { esc } from './format.js';
export const $ = (sel, root = document) => root.querySelector(sel);
export const BR = '<i class="br tl"></i><i class="br tr"></i><i class="br bl"></i><i class="br brr"></i>';

export function sheet(html, init, cls = '') {
  closeSheet();
  const s = document.createElement('div');
  s.className = 'scrim'; s.innerHTML = `<div class="sheet ${cls}" role="dialog">${html}</div>`;
  s.addEventListener('click', e => { if (e.target === s || e.target.closest('[data-close]')) closeSheet(); });
  document.body.appendChild(s);
  init?.($('.sheet', s));
  return $('.sheet', s);
}
export function closeSheet() { document.querySelector('.scrim')?.remove(); }

let toastTimer;
export function toast(msg, ms = 3600) {
  document.querySelector('.toast')?.remove(); clearTimeout(toastTimer);
  const t = document.createElement('div'); t.className = 'toast'; t.innerHTML = `<span class="c">›</span> ${esc(msg)}`;
  document.body.appendChild(t); toastTimer = setTimeout(() => t.remove(), ms);
}
