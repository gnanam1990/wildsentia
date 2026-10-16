// Screenshots of the Congo forest at a fixed place (world metres), for comparing looks.
//   node tools/dev/placeShots.mjs <url> <outDir> <label> <x> <z>
import { chromium } from 'playwright';
const [url, out, label, x, z] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('console', (m) => { if (m.type() === 'error' && /shader|GLSL/i.test(m.text())) console.error('console', m.text().slice(0, 400)); });
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__vana && document.querySelector('#species-picker option[value]:not([value=""])'), null, { timeout: 120000 });
await page.click('#freecam').catch(() => {});
await page.click('#clear-view').catch(() => {});
const views = { eye: { phi: 0.06, distance: 14 }, mid: { phi: 0.4, distance: 70 }, high: { phi: 0.85, distance: 320 } };
for (const [name, v] of Object.entries(views)) {
  await page.evaluate(([v, x, z]) => { const f = window.__vana.follow; f.target.set(Number(x), f.target.y, Number(z)); f.phi = v.phi; f.distance = v.distance; }, [v, x, z]);
  await page.waitForTimeout(6000);
  await page.evaluate(([v, x, z]) => { const f = window.__vana.follow; f.target.set(Number(x), f.target.y, Number(z)); f.phi = v.phi; f.distance = v.distance; }, [v, x, z]);
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${out}/${label}-${name}.jpg`, quality: 80 });
}
await browser.close();
