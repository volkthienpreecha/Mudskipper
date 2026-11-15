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
  await page.locator('#ms-how-sequence').waitFor();
  await page.evaluate(()=>document.fonts.ready);
  return page;
}
async function scrollProgress(page:Page,id:string,progress:number) {
  await page.locator('#'+id).evaluate((e,p)=>{
    const nav=document.querySelector('nav[aria-label="Main"]')!.getBoundingClientRect().height;
    const box=e.getBoundingClientRect();
    scrollTo({top:scrollY+box.top-nav+p*(box.height-(innerHeight-nav)),behavior:'instant'});
  },progress);
  await page.waitForTimeout(100);
}
async function chapter(page:Page,index:number) {
  await scrollProgress(page,'journey',[.08,.52,.94][index]);
  await page.waitForFunction(i=>document.querySelector('#journey')?.getAttribute('data-chapter')===String(i),index);
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
    await page.locator('.journey-open').focus();
    await chapter(page,0);
    assert.equal(await page.evaluate(()=>document.activeElement?.id),'journey','Leaving a focused chapter retains focus on its scene');
  } finally { await page.context().close(); }
});

test('visible animation runs automatically and ignores the former stored pause setting',async()=>{
  const page=await open();
  try {
    await page.evaluate(()=>localStorage.setItem('mudskipper:motion-paused','1'));
    await page.reload();
    await page.locator('#ms-how-sequence').waitFor();
    assert.equal(await page.locator('#motionToggle').count(),0);
    await page.waitForFunction(()=>Number(document.querySelector<HTMLCanvasElement>('#riceParticles')?.dataset.frame)>3);
    const frame=await page.locator('#riceParticles').getAttribute('data-frame');
    await page.waitForFunction(prior=>document.querySelector('#riceParticles')?.getAttribute('data-frame')!==prior,frame);
    assert.equal(await page.locator('#journey').evaluate(e=>e.classList.contains('is-pinned')),true);
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.waitForFunction(()=>document.querySelector('#riceParticles')?.getAttribute('data-motion')==='static');
    await page.waitForFunction(()=>[...document.querySelectorAll('.ms-scroll-sequence')].every(e=>!e.classList.contains('is-scroll-pinned')));
    for(const id of ['ms-claim-sequence','ms-how-sequence','ms-method-sequence']){
      assert.equal(await page.locator('#'+id+' [data-scroll-stage]:not([inert])').count(),3);
    }
  } finally {await page.context().close();}
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
    assert.equal(await page.locator('#riceParticles').getAttribute('data-motion'),'static');
    assert.equal(await page.locator('.journey-chapter').count(), 3);
    assert.equal(await page.locator('#pvPasses .pcol').count(), 9);
    for (const width of [390,320]) {
      await page.setViewportSize({width,height:844});
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.equal(await page.locator('.brand-lockup').evaluate(e=>{const r=e.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth}),true,'The complete wordmark fits the phone, including native font differences');
      for (const item of await page.locator('.journey-chapter').all()) assert.equal(await item.isVisible(), true);
      assert.notEqual(await page.locator('.journey-pin').evaluate(e => getComputedStyle(e).position), 'sticky');
      assert.equal(await page.locator('#preview [data-load="check"]').isVisible(), true);
    }
  } finally { await page.context().close(); }
});

test('rice grains change pixels while visible, stop offscreen, and resume on return', async () => {
  const page=await open();
  try {
    const canvas=page.locator('#riceParticles');
    await page.waitForFunction(()=>Number(document.querySelector<HTMLCanvasElement>('#riceParticles')?.dataset.frame)>3);
    const pixels=await canvas.evaluate(e=>(e as HTMLCanvasElement).toDataURL());
    await page.mouse.move(240,420);
    await page.waitForTimeout(250);
    assert.notEqual(await canvas.evaluate(e=>(e as HTMLCanvasElement).toDataURL()),pixels);
    await chapter(page,1);
    await page.waitForFunction(()=>document.querySelector<HTMLCanvasElement>('#riceParticles')?.dataset.motion==='offscreen');
    const offscreen=await canvas.getAttribute('data-frame');
    await page.waitForTimeout(180);
    assert.equal(await canvas.getAttribute('data-frame'),offscreen);
    await page.evaluate(()=>scrollTo({top:0,behavior:'instant'}));
    await page.waitForFunction(prior=>document.querySelector('#riceParticles')?.getAttribute('data-frame')!==prior,offscreen);
  } finally {await page.context().close();}
});

test('all scroll chapters expose one accessible stage and no stage-selector buttons',async()=>{
  const page=await open();
  try {
    assert.equal(await page.locator('[data-scene-jump],#ms-walk-tabs,.ms-method-header [role="tab"],#ms-guide-next').count(),0);
    for(const id of ['ms-claim-sequence','ms-how-sequence','ms-method-sequence']){
      for(const index of [0,1,2]){
        await scrollProgress(page,id,[.1,.5,.9][index]);
        await page.waitForTimeout(380);
        assert.equal(await page.locator('#'+id).getAttribute('data-scroll-index'),String(index));
        assert.equal(await page.locator('#'+id+' [data-scroll-stage]:not([inert])').count(),1);
        const result=await new AxeBuilder({page}).include('#'+id).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']).analyze();
        assert.deepEqual(result.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})),[],`${id} ${index}`);
      }
    }
    assert.deepEqual(await page.evaluate(()=>{const ids=[...document.querySelectorAll('[id]')].map(e=>e.id);return ids.filter((id,i)=>ids.indexOf(id)!==i)}),[]);
  } finally {await page.context().close();}
});

test('field and acquisition selection preserve focus, selected identity and scroll stage across redraws',async()=>{
  const page=await open();
  try {
    await scrollProgress(page,'ms-how-sequence',.1);
    await page.locator('#ms-guide-field').focus();
    const y=await page.evaluate(()=>scrollY);
    await page.locator('#ms-guide-field').selectOption({index:1});
    const id=await page.locator('#ms-guide-field').inputValue();
    assert.equal(await page.evaluate(()=>document.activeElement?.id),'ms-guide-field');
    assert.ok(Math.abs(await page.evaluate(()=>scrollY)-y)<3);
    await scrollProgress(page,'ms-how-sequence',.5);
    const pass=page.locator('[data-guide-pass="2"]');
    await pass.click();
    assert.equal(await page.locator('#ms-how-sequence').getAttribute('data-scroll-index'),'1');
    assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('data-guide-pass')),'2');
    await scrollProgress(page,'ms-how-sequence',.9);
    assert.ok((await page.locator('#ms-open-field').locator('..').innerText()).includes(id));
    await page.locator('#ms-open-field').click();
    await page.waitForFunction(id=>document.querySelector('#fcard .fc-id')?.textContent===id,id);
  } finally {await page.context().close();}
});

test('centered hero and wordmark use the supplied sky, and season reveals do not alter the data',async()=>{
  const page=await open();
  try {
    assert.equal(await page.evaluate(()=>document.fonts.check('16px ROMANS')),true);
    for(const selector of ['h1','nav a','#season .sub','#searchField','#seasonSvg text','#ms-api-response','#ms-run-request']) {
      assert.ok((await page.locator(selector).first().evaluate(e=>getComputedStyle(e).fontFamily)).includes('ROMANS'),selector+' uses the supplied font');
    }
    assert.equal((await page.locator('h1').innerText()).replace(/\s+/g,' '),'Check rice-field drainage from space.');
    for(const selector of ['h1','nav[aria-label="Main"]>ul']){
      const center=await page.locator(selector).evaluate(e=>{const r=e.getBoundingClientRect();return r.left+r.width/2});
      assert.ok(Math.abs(center-720)<2,`${selector} is centered`);
    }
    const image=await page.request.get(server.origin+'/img/rice-sky.png');
    assert.equal(image.status(),200);assert.equal((await image.body()).subarray(1,4).toString(),'PNG');
    await scrollProgress(page,'brandInterlude',0);
    const initialMask=await page.locator('.brand-card').evaluate(e=>getComputedStyle(e).clipPath);
    assert.match(initialMask,/28% 22% 12%/);
    assert.equal(await page.locator('.brand-wordmark-logo').count(),1);
    const first=await page.locator('.brand-lockup').evaluate(e=>getComputedStyle(e).transform);
    await scrollProgress(page,'brandInterlude',.6);
    assert.notEqual(await page.locator('.brand-lockup').evaluate(e=>getComputedStyle(e).transform),first);
    assert.notEqual(await page.locator('.brand-card').evaluate(e=>getComputedStyle(e).clipPath),initialMask);
    const center=await page.locator('.brand-lockup').evaluate(e=>{const r=e.getBoundingClientRect();return r.left+r.width/2});
    assert.ok(Math.abs(center-720)<3);
    const data=await page.locator('#seasonTable tbody').innerText();
    await scrollProgress(page,'season',.1);const crop=await page.locator('#seasonSvg').evaluate(e=>getComputedStyle(e).clipPath);
    await scrollProgress(page,'season',.9);assert.notEqual(await page.locator('#seasonSvg').evaluate(e=>getComputedStyle(e).clipPath),crop);
    assert.equal(await page.locator('#seasonTable tbody').innerText(),data);
    assert.equal(await page.locator('#season .stat').evaluateAll(items=>items.every(e=>{
      const label=e.querySelector('span')!.getBoundingClientRect(),box=e.getBoundingClientRect(),style=getComputedStyle(e);
      return label.top>=box.top && label.bottom<=box.bottom && style.borderTopWidth==='0px' && style.borderBottomWidth==='0px' && style.transform==='none';
    })),true,'Metric labels stay inside their row without crossing animated dividers');
    await page.locator('#seasonTable summary').click();
    await page.waitForFunction(()=>!document.querySelector('#season')?.classList.contains('is-scroll-pinned'));
    assert.equal(await page.locator('#seasonSvg').evaluate(e=>getComputedStyle(e).clipPath),'none');
  } finally {await page.context().close();}
});


test('season legend and focused table control remain in view on short desktops',async()=>{
 const page=await open();
 try{
  for(const [width,height] of [[1000,780],[1440,900]]){
   await page.setViewportSize({width,height});
   await scrollProgress(page,'season',.7);
   await page.locator('#seasonTable summary').focus();
   await page.waitForTimeout(100);
   const visible=await page.locator('#seasonTable summary').evaluate(e=>{const r=e.getBoundingClientRect();const n=document.querySelector('nav[aria-label="Main"]')!.getBoundingClientRect().height;return r.top>=n && r.bottom<=innerHeight});
   assert.equal(visible,true,`Season table focus visible at ${width}×${height}`);
  }
 }finally{await page.context().close()}
});

test('scrolling away from a focused claim retains focus on the sequence',async()=>{
 const page=await open();
 try{
  await scrollProgress(page,'ms-claim-sequence',.9);
  await page.locator('[data-flow-pass="2"]').focus();
  await scrollProgress(page,'ms-claim-sequence',.1);
  assert.equal(await page.evaluate(()=>document.activeElement?.id),'ms-claim-sequence');
 }finally{await page.context().close()}
});
