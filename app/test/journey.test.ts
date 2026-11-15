import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
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
  await page.locator(`[data-scene-jump="${index}"]`).click();
  await page.waitForFunction(i => document.querySelector('#journey')?.getAttribute('data-chapter') === String(i), index);
}

test('scroll story follows real pass dates and states without taking over document scroll', async () => {
  const page = await open();
  try {
    await chapter(page, 0);
    const wide = Number((await page.locator('#pvMap').getAttribute('viewBox'))!.split(' ')[2]);
    assert.equal(await page.locator('.scene-orbit').evaluate(e=>getComputedStyle(e).opacity), '1');
    const pinTop = await page.locator('.journey-pin').evaluate(e=>e.getBoundingClientRect().top);
    const first = await page.locator('#journeyAcquisition').innerText();
    await chapter(page, 1);
    const close = Number((await page.locator('#pvMap').getAttribute('viewBox'))!.split(' ')[2]);
    assert.ok(wide > close * 4, 'Camera must zoom into the actual field');
    assert.equal(await page.locator('.scene-orbit').evaluate(e=>getComputedStyle(e).opacity), '0');
    assert.equal(await page.locator('.journey-pin').evaluate(e=>e.getBoundingClientRect().top), pinTop, 'The entire scene stays pinned');
    assert.equal(await page.locator('.journey-readout').evaluate(e=>getComputedStyle(e).opacity), '0');
    const middle = await page.locator('#journeyAcquisition').innerText();
    assert.notEqual(middle, first);
    const selected = page.locator('#pvPasses .is-observed');
    assert.equal(await selected.count(), 1);
    const observation = await selected.getAttribute('title');
    assert.equal(middle.replace(' · ', ': '), observation);
    const expectedColor = await selected.locator('span').first().getAttribute('class');
    assert.equal(await page.locator('#pvMap .hf').evaluate(e => (e as SVGElement).style.fill), ({ f:'rgb(36, 79, 182)', d:'rgb(191, 68, 41)', u:'rgb(102, 115, 138)' } as Record<string,string>)[expectedColor!]);
    await chapter(page, 2);
    assert.equal(await page.locator('.journey-readout').evaluate(e=>getComputedStyle(e).opacity), '1');
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
    await page.locator('#journey').evaluate(e=>{
      const nav=document.querySelector('nav[aria-label="Main"]')!.getBoundingClientRect().height;
      const box=e.getBoundingClientRect();
      scrollTo({top:scrollY+box.top-nav+.94*(box.height-(innerHeight-nav)),behavior:'instant'});
    });
    await page.waitForTimeout(100);
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

test('whole scene pins on desktop and the final evidence fits the viewport', async () => {
  const page = await open();
  try {
    for (const [width,height] of [[1000,680],[1440,680],[1440,720],[1440,900],[1440,1100]]) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(100);
      await chapter(page,2);
      const fit = await page.locator('.journey-readout').evaluate(e => e.getBoundingClientRect().bottom <= e.closest('#preview')!.getBoundingClientRect().bottom);
      assert.equal(fit, true, `The complete report must fit at ${height}px`);
      assert.equal(await page.locator('.journey-pin').evaluate(e => getComputedStyle(e).position), 'sticky');
    }
  } finally { await page.context().close(); }
});

test('reduced motion and phone layouts preserve all chapters and the complete live report in normal flow', async () => {
  const page = await open('reduce');
  try {
    assert.notEqual(await page.locator('.journey-pin').evaluate(e => getComputedStyle(e).position), 'sticky');
    assert.equal(await page.locator('.horizon-drift').evaluate(e => getComputedStyle(e).animationName), 'none');
    assert.equal(await page.locator('.journey-chapter').count(), 3);
    assert.equal(await page.locator('#pvPasses .pcol').count(), 9);
    for (const width of [390,320]) {
      await page.setViewportSize({width,height:844});
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      for (const item of await page.locator('.journey-chapter').all()) assert.equal(await item.isVisible(), true);
      assert.notEqual(await page.locator('.journey-pin').evaluate(e => getComputedStyle(e).position), 'sticky');
      assert.equal(await page.locator('#preview [data-load="check"]').isVisible(), true);
    }
  } finally { await page.context().close(); }
});

test('water contours change pixels, freeze on pause and offscreen, and resume on return', async () => {
  const page=await open();
  try {
    const canvas=page.locator('#waterContours');
    await page.waitForFunction(()=>Number(document.querySelector<HTMLCanvasElement>('#waterContours')?.dataset.frame)>3);
    const pixels=await canvas.evaluate(e=>(e as HTMLCanvasElement).toDataURL());
    await page.mouse.move(240,420);
    await page.waitForTimeout(250);
    assert.notEqual(await canvas.evaluate(e=>(e as HTMLCanvasElement).toDataURL()),pixels);
    await page.locator('#motionToggle').click();
    const frozen=await canvas.getAttribute('data-frame');
    await page.waitForTimeout(180);
    assert.equal(await canvas.getAttribute('data-frame'),frozen);
    await page.locator('#motionToggle').click();
    await page.waitForFunction(prior=>document.querySelector('#waterContours')?.getAttribute('data-frame')!==prior,frozen);
    await chapter(page,1);
    await page.waitForFunction(()=>document.querySelector<HTMLCanvasElement>('#waterContours')?.dataset.motion==='offscreen');
    const offscreen=await canvas.getAttribute('data-frame');
    await page.waitForTimeout(180);
    assert.equal(await canvas.getAttribute('data-frame'),offscreen);
    await page.evaluate(()=>scrollTo({top:0,behavior:'instant'}));
    await page.waitForFunction(prior=>document.querySelector('#waterContours')?.getAttribute('data-frame')!==prior,offscreen);
  } finally {await page.context().close();}
});

test('each animated stage has accessible controls and hides inactive chapter links', async()=>{
  const page=await open();
  try {
    for(const i of [0,1,2]){
      await chapter(page,i);
      await page.waitForTimeout(350);
      assert.equal(await page.locator('.journey-chapter:not([inert])').count(),1);
      const results=await new AxeBuilder({page}).include('#journey').withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']).analyze();
      assert.deepEqual(results.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})),[],`Animated stage ${i}`);
    }
    await page.locator('[data-scene-jump="0"]').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#journey').getAttribute('data-chapter'),'0');
    await page.locator('#motionToggle').click();
    await page.locator('[data-scene-jump="2"]').click();
    assert.equal(await page.locator('#journey').getAttribute('data-chapter'),'2','Explicit scene navigation remains usable while paused');
  } finally {await page.context().close();}
});
