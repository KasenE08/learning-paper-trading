// usage: node render.js <html> <out.png> [fullPage]
const { chromium } = require('playwright');
(async () => {
  const [,, html, out, full] = process.argv;
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await p.goto('file://' + require('path').resolve(html));
  await p.waitForTimeout(400);
  await p.screenshot({ path: out, fullPage: full === 'full' });
  await b.close();
})();
