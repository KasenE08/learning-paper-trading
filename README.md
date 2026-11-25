# Learn Paper Trading

A free, phone-only stock paper-trading PWA with a built-in learning layer. Pretend money, real market prices.
**Not financial advice.**

- **Live app:** https://kasene08.github.io/learning-paper-trading/ (installable: in Safari, Share → Add to Home Screen)
- **Data:** Yahoo Finance via the Cloudflare Worker at https://learning-paper-trading.ertel-kasen.workers.dev (auto-deploys from this repo; setup in [`worker/README.md`](worker/README.md)).
- **Storage:** on-device only (localStorage).

## Project layout
| Path | What |
|---|---|
| `index.html`, `css/`, `js/` | The app (vanilla JS modules, no build step) |
| `js/market.js` | US market calendar: sessions, holidays, early closes, T+1 days |
| `js/chart.js` | Candlestick chart (TradingView Lightweight Charts, vendored in `vendor/`) |
| `worker/worker.js` | Cloudflare Worker relay (`/search`, `/chart`, `/quote`) |
| `sw.js`, `manifest.webmanifest`, `icons/` | PWA shell |
| `tests/` | Unit + Playwright end-to-end tests |
| `design/` | Phase 1 concepts and phase screenshots |

## Tests
```
npm test                                   # unit + e2e (mocked relay)
node tests/worker-server.mjs 8787 &        # run the relay locally
LIVE_RELAY=http://localhost:8787 npm test  # adds a live-data test
```

## Status
- [x] Phase 1: icon + HUD design
- [x] Phase 2: PWA shell, relay, search, live quotes, candlestick chart, starting balance
- [ ] Phase 3: trading engine
- [ ] Phase 4: portfolio
- [ ] Phase 5: learning layer
- [ ] Phase 6: polish + full mobile testing
