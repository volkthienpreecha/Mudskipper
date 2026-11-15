import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { serveStatic, type StaticServer } from './support/static-server.ts';

let browser: Browser;
let server: StaticServer;
before(async () => {
  server = await serveStatic(fileURLToPath(new URL('../dist', import.meta.url)));
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await server?.close(); });

async function open(reducedMotion: 'reduce' | 'no-preference' = 'no-preference') {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, reducedMotion });
  const page = await context.newPage();
  await page.goto(server.origin + '/?dataset=snapshot');
  await page.locator('#pvPasses .pcol').first().waitFor();
  return page;
}
async function chapter(page: Page, index: number) {
  await page.locator(`.journey-chapter[data-chapter="${index}"]`).evaluate(e => {
    scrollTo({ top: scrollY + e.getBoundingClientRect().top - innerHeight * .4, behavior:'instant' });
  });
  await page.waitForFunction(i => document.querySelector('#journey')?.getAttribute('data-chapter') === String(i), index);
}

test('scroll story follows real pass dates and states without taking over document scroll', async () => {
  const page = await open();
  try {
    await chapter(page, 0);
    const first = await page.locator('#journeyAcquisition').innerText();
    await chapter(page, 1);
    const middle = await page.locator('#journeyAcquisition').innerText();
    assert.notEqual(middle, first);
    const selected = page.locator('#pvPasses .is-observed');
    assert.equal(await selected.count(), 1);
    const observation = await selected.getAttribute('title');
    assert.equal(middle.replace(' · ', ': '), observation);
    const expectedColor = await selected.locator('span').first().getAttribute('class');
    assert.equal(await page.locator('#pvMap .hf').evaluate(e => (e as SVGElement).style.fill), ({ f:'rgb(36, 79, 182)', d:'rgb(191, 68, 41)', u:'rgb(102, 115, 138)' } as Record<string,string>)[expectedColor!]);
    await chapter(page, 2);
    assert.notEqual(await page.locator('#journeyAcquisition').innerText(), middle);
    const y = await page.evaluate(() => scrollY);
    await page.waitForTimeout(180);
    assert.equal(await page.evaluate(() => scrollY), y, 'The scene must never snap or advance document scrolling');
  } finally { await page.context().close(); }
});

test('Pause animations freezes the orbit and scroll scene, then resumes at current position', async () => {
  const page = await open();
  try {
    await chapter(page, 0);
    await page.locator('#motionToggle').click();
    const progress = await page.locator('#journey').evaluate(e => (e as HTMLElement).style.getPropertyValue('--journey-progress'));
    const date = await page.locator('#journeyAcquisition').innerText();
    await chapter(page, 2);
    assert.equal(await page.locator('#journey').evaluate(e => (e as HTMLElement).style.getPropertyValue('--journey-progress')), progress);
    assert.equal(await page.locator('#journeyAcquisition').innerText(), date);
    assert.equal(await page.locator('.horizon-drift').evaluate(e => getComputedStyle(e).animationPlayState), 'paused');
    assert.equal(await page.locator('.horizon-drift').evaluate(e => getComputedStyle(e).animationName), 'horizon-breathe');
    const pausedTime = await page.locator('.horizon-drift').evaluate(e => e.getAnimations()[0].currentTime);
    await page.waitForTimeout(180);
    assert.equal(await page.locator('.horizon-drift').evaluate(e => e.getAnimations()[0].currentTime), pausedTime, 'Pause must preserve the animation timeline');
    await page.locator('#motionToggle').click();
    await page.waitForFunction(prior => document.querySelector<HTMLElement>('#journey')?.style.getPropertyValue('--journey-progress') !== prior, progress);
    assert.equal(await page.locator('.horizon-drift').evaluate(e => getComputedStyle(e).animationPlayState), 'running');
  } finally { await page.context().close(); }
});

test('sticky report fits below navigation or falls back to normal flow', async () => {
  const page = await open();
  try {
    for (const height of [900,1000,1100]) {
      await page.setViewportSize({ width:1440, height });
      await page.waitForTimeout(100);
      const fit = await page.locator('.journey-instrument').evaluate(e => {
        const style = getComputedStyle(e);
        const nav = document.querySelector('nav[aria-label="Main"]')!.getBoundingClientRect().height;
        return style.position !== 'sticky' || e.getBoundingClientRect().height + nav + 48 <= innerHeight;
      });
      assert.equal(fit, true, `The complete report must fit at ${height}px`);
      if (height === 1100) assert.equal(await page.locator('.journey-instrument').evaluate(e => getComputedStyle(e).position), 'sticky');
    }
  } finally { await page.context().close(); }
});

test('reduced motion and phone layouts preserve all chapters and the complete live report in normal flow', async () => {
  const page = await open('reduce');
  try {
    assert.equal(await page.locator('.journey-instrument').evaluate(e => getComputedStyle(e).position), 'relative');
    assert.equal(await page.locator('.horizon-drift').evaluate(e => getComputedStyle(e).animationName), 'none');
    assert.equal(await page.locator('.journey-chapter').count(), 3);
    assert.equal(await page.locator('#pvPasses .pcol').count(), 9);
    for (const width of [390,320]) {
      await page.setViewportSize({width,height:844});
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      for (const item of await page.locator('.journey-chapter').all()) assert.equal(await item.isVisible(), true);
      assert.equal(await page.locator('.journey-instrument').evaluate(e => getComputedStyle(e).position), 'relative');
      assert.equal(await page.locator('#preview [data-load="check"]').isVisible(), true);
    }
  } finally { await page.context().close(); }
});
