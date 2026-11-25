# Data relay setup (Cloudflare Worker, free)

The app gets prices from Yahoo Finance through a tiny relay that you own. It's free
(100,000 requests/day on Cloudflare's free plan; the app uses a small fraction of that) and needs no API keys.

You can do all of this from your phone's browser (it's a bit easier on a computer).

## 1. Create the account
1. Go to **https://dash.cloudflare.com/sign-up** and sign up with email + password.
2. Verify your email from the message Cloudflare sends.
3. If it asks what you want to build or which plan to use, pick **Free** and skip any domain setup. You don't need a domain.

## 2. Create the Worker
1. In the dashboard, open **Workers & Pages** (in the left menu, sometimes under **Compute**; use the search bar at the top if you can't find it).
2. Tap **Create** (or **Create application**), then **Start with Hello World!** (it may be labelled "Create Worker").
3. First time only: Cloudflare asks you to choose a **workers.dev subdomain**. Pick anything (e.g. your initials). It becomes part of the relay address.
4. Name the worker **`lpt-relay`** and tap **Deploy**. (It deploys a placeholder "Hello World" first; that's expected.)

## 3. Paste the relay code
1. On the Worker's page, tap **Edit code**.
2. Open this file in another tab, then select all of it and copy:
   https://raw.githubusercontent.com/KasenE08/learning-paper-trading/claude/learn-paper-trading-pwa-rs848q/worker/worker.js
3. Back in the editor, delete everything in `worker.js` and paste the copied code.
4. Tap **Deploy** (top right), and confirm if it asks.

## 4. Test it
Open these in your browser (replace the address with yours, shown on the Worker's page):
- `https://lpt-relay.<your-subdomain>.workers.dev/health` → should show `{"ok":true,...}`
- `https://lpt-relay.<your-subdomain>.workers.dev/quote?symbols=SPY` → should show SPY's price.

## 5. Connect the app
Send the address (`https://lpt-relay.<your-subdomain>.workers.dev`) to Claude so it can be built into the app,
**or** paste it yourself in the app: **Menu → Data relay → Save & test**.

## Troubleshooting
- **`upstream 429`**: Yahoo is throttling for a moment; it retries a second Yahoo server automatically. Wait a minute.
- **`origin not allowed`**: the relay only answers the app's own site (`https://kasene08.github.io`). Opening URLs directly in your browser is allowed.
- **Changing the code later**: repeat step 3 with the new file.
