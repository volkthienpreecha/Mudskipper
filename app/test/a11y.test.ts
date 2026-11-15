// Accessibility checks for the built app (app/dist), in a real headless Chromium:
//   1. axe-core at the WCAG 2.0/2.1/2.2 A and AA tags, in every section and state: each analysis tab, the map
//      with a field selected, error states, the phone menu and the legal pages. Zero violations allowed.
//   2. A keyboard-only walkthrough that reaches and operates every control: skip links, navigation, the map's
//      study areas and fields, the field list, search, playback, the pass slider, map view buttons and the
//      analysis tabs, with a visible focus that the fixed navigation never hides.
//   3. Reflow at 320 CSS pixels and 200% zoom without horizontal scrolling.
//
// Run after `npm run build -w @mudskipper/app`:  npm run test:a11y -w @mudskipper/app
// The published-run states call the live API (https://mudskipper-nisar.pages.dev); set A11Y_OFFLINE=1 to
// skip only those states when the network is unavailable.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { serveStatic, type StaticServer } from './support/static-server.ts';

const DIST = fileURLToPath(new URL('../dist', import.meta.url));
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const OFFLINE = process.env.A11Y_OFFLINE === '1';
const API = 'https://mudskipper-nisar.pages.dev';
const LONG = 180_000;

let server: StaticServer;
let browser: Browser;

before(async () => {
  assert.ok(existsSync(DIST), 'Build the app first: npm run build -w @mudskipper/app');
  server = await serveStatic(DIST);
  browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
});

after(async () => {
  await browser?.close();
  await server?.close();
});

async function open(viewport = { width: 1440, height: 900 }, setup?: (context: BrowserContext) => Promise<void>): Promise<Page> {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
  context.setDefaultTimeout(LONG);
  await setup?.(context);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  (page as Page & { errors: string[] }).errors = errors;
  await page.goto(server.origin + '/', { waitUntil: 'domcontentloaded', timeout: LONG });
  await page.waitForSelector('#fcard .pickbtn', { timeout: LONG });
  // Scroll-triggered reveals: show every section, as a visitor scrolling through would see it.
  await page.evaluate(() => document.querySelectorAll('.rv, .step, .card, #tl, .track').forEach((element) => element.classList.add('in')));
  return page;
}

async function expectNoViolations(page: Page, state: string): Promise<void> {
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const summary = result.violations.map((violation) => `${violation.id} (${violation.impact}): ${violation.nodes.slice(0, 5).map((node) => node.target.join(' ')).join(', ')}`);
  assert.deepEqual(summary, [], `${state}: axe found violations`);
}

async function chooseApiDataset(page: Page): Promise<void> {
  await page.selectOption('#datasetSelect', 'api');
  await page.waitForFunction(() => {
    const select = document.querySelector<HTMLSelectElement>('#datasetSelect');
    return select && !select.disabled && select.value === 'api' && !document.querySelector('#open-published-run');
  }, null, { timeout: LONG });
}

async function waitForTabPanel(page: Page, ready: string): Promise<void> {
  await page.waitForSelector(`#backend-tool-content :is(${ready}, .bt-error)`, { timeout: LONG });
  const error = await page.locator('#backend-tool-content .bt-error').first().textContent().catch(() => null);
  assert.equal(error, null, `analysis panel error: ${error}`);
}

/** No content wider than the viewport, other than regions that scroll on their own (data tables). */
async function horizontalOverflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const out: string[] = [];
    if (document.documentElement.scrollWidth > width + 1) out.push(`document scrollWidth ${document.documentElement.scrollWidth} > ${width}`);
    for (const element of document.body.querySelectorAll<HTMLElement>('body *')) {
      if (element.closest('.sr-only, .bg, [hidden], .bt-table-wrap, .chart-table-wrap, svg, .skip-link, nav > ul')) continue;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || style.position === 'fixed') continue;
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (box.right > width + 1 || box.left < -1) out.push(`${element.tagName.toLowerCase()}${element.id ? '#' + element.id : ''}.${[...element.classList].join('.')} [${Math.round(box.left)}, ${Math.round(box.right)}]`);
    }
    return out.slice(0, 10);
  });
}

describe('axe-core, WCAG 2.2 A and AA', { timeout: 30 * 60_000 }, () => {
  test('home page at 1440 × 900, every section', async () => {
    const page = await open();
    await expectNoViolations(page, 'home');
    await page.context().close();
  });

  test('map: study area, selected field, field list and search error', async () => {
    const page = await open();
    await page.click('#fcard .pickbtn');
    await page.waitForSelector('#fieldPicker');
    await expectNoViolations(page, 'study area with the field list');
    await page.selectOption('#fieldPicker', { index: 3 });
    await page.click('#fieldPickerOpen');
    await page.waitForSelector('#fcard .chips');
    await page.click('#fcard [data-field-pass="4"]');
    await page.evaluate(() => { const details = document.querySelector<HTMLDetailsElement>('#seasonTable'); if (details) details.open = true; });
    await expectNoViolations(page, 'field selected');
    await page.fill('#searchField', 'not-a-field');
    await page.press('#searchField', 'Enter');
    await page.waitForSelector('#searchField[aria-invalid="true"]');
    assert.match((await page.textContent('#dataStatus')) ?? '', /No field “not-a-field”/);
    await expectNoViolations(page, 'search error');
    await page.context().close();
  });

  test('phone at 390 × 844 with the menu open, and reflow at 320 px', async () => {
    const page = await open({ width: 390, height: 844 });
    await page.click('.nav-toggle');
    await expectNoViolations(page, 'phone menu');
    await page.keyboard.press('Escape');
    assert.deepEqual(await horizontalOverflow(page), [], 'overflow at 390 px');
    await page.setViewportSize({ width: 320, height: 640 });
    await page.click('#fcard .pickbtn');
    await page.waitForSelector('#fieldPicker');
    await expectNoViolations(page, '320 px');
    assert.deepEqual(await horizontalOverflow(page), [], 'overflow at 320 px');
    await page.context().close();
  });

  test('200% zoom (1440 × 900 at device scale 2 is a 720 × 450 CSS viewport)', async () => {
    const context = await browser.newContext({ viewport: { width: 720, height: 450 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
    context.setDefaultTimeout(LONG);
    const page = await context.newPage();
    await page.goto(server.origin + '/', { waitUntil: 'domcontentloaded', timeout: LONG });
    await page.waitForSelector('#fcard .pickbtn');
    assert.deepEqual(await horizontalOverflow(page), [], 'overflow at 200%');
    await context.close();
  });

  test('API unavailable: dataset and field errors are announced and pass axe', async () => {
    const page = await open(undefined, async (context) => {
      await context.route(`${API}/**`, (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' }));
    });
    await page.selectOption('#datasetSelect', 'api');
    await page.waitForFunction(() => /Retry the dataset selection/.test(document.querySelector('#dataStatus')?.textContent ?? ''), null, { timeout: LONG });
    assert.equal(await page.getAttribute('#dataStatus', 'role'), 'status');
    await expectNoViolations(page, 'API error');
    await page.context().close();
  });

  test('legal pages', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    for (const name of ['credits', 'privacy', 'terms']) {
      await page.goto(`${server.origin}/${name}.html`);
      await expectNoViolations(page, name);
    }
    await context.close();
  });

  test('published run: each analysis tab', { skip: OFFLINE && 'A11Y_OFFLINE=1' }, async () => {
    const page = await open();
    await chooseApiDataset(page);
    await waitForTabPanel(page, '#detectability-charts .bt-chart');
    await page.evaluate(() => document.querySelectorAll<HTMLDetailsElement>('#backendTools details').forEach((details) => { details.open = true; }));
    await expectNoViolations(page, 'Detectability');
    await page.click('[data-tool="inspection"]');
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#audit')?.disabled, null, { timeout: LONG });
    await page.fill('#budget', '0');
    await page.click('#audit');
    await page.waitForSelector('#budget[aria-invalid="true"]');
    await expectNoViolations(page, 'Inspection budget error');
    await page.fill('#budget', '12');
    await page.click('#audit');
    await waitForTabPanel(page, '.bt-queue-list');
    await expectNoViolations(page, 'Inspection list');
    await page.click('[data-tool="evidence"]');
    await waitForTabPanel(page, '.bt-evidence-grid');
    await page.evaluate(() => document.querySelectorAll<HTMLDetailsElement>('#backendTools details').forEach((details) => { details.open = true; }));
    await expectNoViolations(page, 'Evidence');
    await page.locator('#gF path').first().waitFor({ state: 'attached' }).catch(() => undefined);
    await page.click('#fcard .pickbtn');
    await page.selectOption('#fieldPicker', { index: 1 });
    await page.click('#fieldPickerOpen');
    await page.waitForSelector('#fcard .chips', { timeout: LONG });
    await page.evaluate(() => { const details = document.querySelector<HTMLDetailsElement>('.model-details'); if (details) details.open = true; });
    await expectNoViolations(page, 'published run field selected');
    await page.context().close();
  });
});

type Stop = { name: string; visibleFocus: boolean; obscured: boolean; inViewport: boolean };

/** Press a key and describe where focus landed. */
async function press(page: Page, key: string): Promise<Stop> {
  await page.keyboard.press(key);
  return describeFocus(page);
}

async function describeFocus(page: Page): Promise<Stop> {
  return page.evaluate(() => {
    const element = document.activeElement as HTMLElement | SVGElement | null;
    if (!element || element === document.body) return { name: 'body', visibleFocus: false, obscured: false, inViewport: false };
    const style = getComputedStyle(element);
    let visibleFocus = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0;
    if (element instanceof SVGElement) {
      // SVG controls show focus with a dashed stroke (fields) or a white ring and highlighted label (markers).
      if (element.tagName === 'path') visibleFocus = style.strokeDasharray !== 'none' && parseFloat(style.strokeWidth) >= 3;
      if (element.classList.contains('mk')) visibleFocus = getComputedStyle(element.querySelector('.dot')!).stroke !== 'none';
    }
    const box = element.getBoundingClientRect();
    // Obscured: the topmost element at the control's centre belongs to the fixed navigation.
    const x = Math.min(innerWidth - 1, Math.max(0, box.left + box.width / 2));
    const y = Math.min(innerHeight - 1, Math.max(0, box.top + box.height / 2));
    const top = document.elementFromPoint(x, y);
    const obscured = !element.closest('nav') && !!top?.closest('nav');
    const inViewport = box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth;
    const label = element.getAttribute('aria-label') ?? (element.textContent ?? '').trim().slice(0, 40);
    return { name: `${element.tagName.toLowerCase()}${element.id ? '#' + element.id : ''} ${label}`, visibleFocus, obscured, inViewport };
  });
}

function assertStop(stop: Stop, where: string): void {
  assert.ok(stop.visibleFocus, `${where}: no visible focus on ${stop.name}`);
  assert.ok(!stop.obscured, `${where}: ${stop.name} is hidden under the fixed navigation`);
  assert.ok(stop.inViewport, `${where}: ${stop.name} is off screen`);
}

describe('keyboard only', { timeout: 30 * 60_000 }, () => {
  test('Tab reaches every control with visible, unobscured focus, and there is no keyboard trap', async () => {
    const page = await open();
    await page.evaluate(() => window.scrollTo(0, 0));
    const first = await press(page, 'Tab');
    assert.match(first.name, /Skip to main content/);
    const seen: Stop[] = [first];
    for (let i = 0; i < 160; i++) {
      const stop = await press(page, 'Tab');
      if (stop.name === 'body' || /Skip to main content/.test(stop.name)) break;
      assertStop(stop, `Tab stop ${i + 2}`);
      seen.push(stop);
    }
    const names = seen.map((stop) => stop.name).join('\n');
    for (const expected of [/Skip to the map/, /Pause animations/, /Explore the map/, /Take the tour/, /Inspect another field/, /Explore Fazilka|Fazilka/, /datasetSelect/, /searchField/, /Zoom in/, /Pan left/, /pickbtn|Sri Muktsar Sahib/, /seasonPlot/, /backend-tab-detectability/, /Privacy policy/]) {
      assert.match(names, expected, `Tab order is missing ${expected}`);
    }
    // Shift+Tab walks back out of the page footer without getting stuck.
    for (let i = 0; i < 5; i++) assertStop(await press(page, 'Shift+Tab'), 'Shift+Tab');
    await page.context().close();
  });

  test('operate the map, field selection, playback and tabs with the keyboard alone', async () => {
    const page = await open();
    const focusOn = async (selector: string) => {
      await page.focus(selector);
      const stop = await describeFocus(page);
      assertStop(stop, selector);
      return stop;
    };

    // Skip link moves focus to the map section.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    assert.match((await describeFocus(page)).name, /Skip to the map/);
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'map');

    // A district marker on the country map opens the study area and hands focus to the first field.
    await page.focus('#fieldMap .mk');
    assertStop(await describeFocus(page), 'district marker');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement?.matches('#gF path'), null, { timeout: LONG });
    const firstField = await describeFocus(page);
    assertStop(firstField, 'first field');
    assert.match(firstField.name, /^path Field \S+, (flooded|drained|uncertain|no observation) on /);
    assert.equal(await page.getAttribute('#fieldMap .mk', 'tabindex'), '-1', 'hidden markers leave the tab order');

    // Arrow keys move between fields; Enter selects the same way a click does.
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('End');
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    const fieldName = (await describeFocus(page)).name.match(/Field (\S+),/)![1];
    await page.keyboard.press('Enter');
    await page.waitForFunction((id) => document.querySelector('#fcard .fc-id')?.textContent === id, fieldName, { timeout: LONG });
    assert.equal(await page.getAttribute('#gF path.sel', 'aria-label').then((label) => label?.endsWith(', selected')), true);

    // Pass chips: Enter changes the pass and focus stays on the chip after the report re-renders.
    await focusOn('#fcard [data-field-pass="2"]');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.fieldPass), '2');
    assert.equal(await page.getAttribute('#fcard [data-field-pass="2"]', 'aria-current'), 'true');

    // Slider: arrows step one acquisition at a time.
    await focusOn('#passSlider');
    const before = await page.getAttribute('#passSlider', 'aria-valuetext');
    await page.keyboard.press('ArrowRight');
    assert.notEqual(await page.getAttribute('#passSlider', 'aria-valuetext'), before);

    // Play and pause.
    await focusOn('#playBtn');
    await page.keyboard.press('Enter');
    assert.equal(await page.getAttribute('#playBtn', 'aria-label'), 'Pause season');
    await page.keyboard.press('Space');
    assert.equal(await page.getAttribute('#playBtn', 'aria-label'), 'Play season');

    // Map view buttons pan and zoom without dragging.
    const viewBox = () => page.getAttribute('#fieldMap', 'viewBox');
    for (const id of ['#zoomIn', '.pan[data-pan="left"]', '.pan[data-pan="up"]', '.pan[data-pan="right"]', '.pan[data-pan="down"]', '#zoomOut']) {
      const old = await viewBox();
      await focusOn(id);
      await page.keyboard.press('Enter');
      assert.notEqual(await viewBox(), old, `${id} moves the map`);
    }

    // Field list in the report: choose a field without the map.
    await focusOn('#backBtn');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#fcard .pickbtn');
    await focusOn('#fcard .pickbtn[data-tile="muktsar"]');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement?.id === 'fieldPicker', null, { timeout: LONG });
    const option = await page.evaluate(() => {
      const select = document.querySelector<HTMLSelectElement>('#fieldPicker')!;
      return select.options[5].textContent;
    });
    await page.keyboard.press('ArrowDown');
    await page.selectOption('#fieldPicker', { label: option! });
    await page.keyboard.press('Enter');
    await page.waitForFunction((id) => document.querySelector('#fcard .fc-id')?.textContent === id, option, { timeout: LONG });
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'fcard', 'focus moves to the opened report');

    // Search by ID with an error, then a match.
    await focusOn('#searchField');
    await page.keyboard.type('nope');
    await page.keyboard.press('Enter');
    assert.equal(await page.getAttribute('#searchField', 'aria-invalid'), 'true');
    await page.fill('#searchField', 'fazilka-00012');
    const real = await page.evaluate(() => document.querySelector('#fieldIds option')?.getAttribute('value'));
    await page.fill('#searchField', real!);
    await page.keyboard.press('Enter');
    await page.waitForFunction((id) => document.querySelector('#fcard .fc-id')?.textContent === id, real, { timeout: LONG });
    assert.equal(await page.getAttribute('#searchField', 'aria-invalid'), null);

    // Season chart: arrow keys read each pass.
    await focusOn('#seasonPlot');
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => /flooded \d+%/.test(document.querySelector('#seasonAnnounce')?.textContent ?? ''));
    await page.keyboard.press('Escape');

    // Pause animations toggles.
    await focusOn('#motionToggle');
    const pressed = await page.getAttribute('#motionToggle', 'aria-pressed');
    await page.keyboard.press('Enter');
    assert.notEqual(await page.getAttribute('#motionToggle', 'aria-pressed'), pressed);

    // Analysis tabs follow the ARIA tabs pattern: arrows move and select, focus stays on the tab.
    await focusOn('#backend-tab-detectability');
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'backend-tab-inspection');
    assert.equal(await page.getAttribute('#backend-tab-inspection', 'aria-selected'), 'true');
    await page.keyboard.press('End');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'backend-tab-evidence');
    await page.keyboard.press('Home');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'backend-tab-detectability');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'backend-tab-evidence');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'backend-tool-content', 'Tab moves into the panel');

    assert.deepEqual((page as Page & { errors: string[] }).errors, []);
    await page.context().close();
  });

  test('published run: tabs and inspection list by keyboard', { skip: OFFLINE && 'A11Y_OFFLINE=1' }, async () => {
    const page = await open();
    await chooseApiDataset(page);
    await page.focus('#backend-tab-detectability');
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#audit')?.disabled, null, { timeout: LONG });
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'backend-tab-inspection');
    await page.focus('#budget');
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('6');
    await page.keyboard.press('Enter');
    await waitForTabPanel(page, '.bt-queue-list');
    const row = page.locator('button.audit-row').first();
    const id = await row.getAttribute('data-audit-field');
    await row.focus();
    assertStop(await describeFocus(page), 'inspection row');
    await page.keyboard.press('Enter');
    await page.waitForFunction((field) => document.querySelector('#fcard .fc-id')?.textContent === field, id, { timeout: LONG });
    await page.waitForFunction(() => document.activeElement?.id === 'fcard', null, { timeout: LONG });
    await page.context().close();
  });
});
