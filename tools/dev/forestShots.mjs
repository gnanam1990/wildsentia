// Screenshots of the Congo forest from a few fixed viewpoints, for comparing looks.
//   node tools/dev/forestShots.mjs <url> <outDir> <label> [species]
import { chromium } from 'playwright';
const [url, out, label, species = 'blue_duiker'] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.error('pageerror', e.message));
page.on('console', (m) => { if (m.type() === 'error' && /shader|GLSL|ERROR/i.test(m.text())) console.error('console', m.text().slice(0, 600)); });
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__vana && document.querySelector('#species-picker option[value]:not([value=""])'), null, { timeout: 120000 });
await page.selectOption('#species-picker', species);
await page.waitForTimeout(12000);
await page.click('#clear-view').catch(() => {});
const views = { eye: { phi: 0.08, distance: 9 }, under: { phi: -0.25, distance: 6 }, mid: { phi: 0.45, distance: 45 }, high: { phi: 0.9, distance: 260 } };
for (const [name, v] of Object.entries(views)) {
  await page.evaluate((v) => { const f = window.__vana.follow; f.phi = v.phi; f.distance = v.distance; }, v);
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${out}/${label}-${name}.jpg`, quality: 80 });
  console.log('shot', name);
}
await browser.close();
