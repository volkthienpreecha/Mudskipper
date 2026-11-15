import type { DemoDataset, DemoField } from './data';
import type { FieldDetail } from '@mudskipper/core/contracts';
import { mountAstryxButton, mountAstryxTabs } from './astryx-controls';
import './components.css';

type Options = {
  dataset: DemoDataset;
  getJSON?: (path: string) => Promise<unknown>;
  getFieldDetail?: (field: DemoField) => Promise<FieldDetail>;
  selectField?: (id: string) => void | Promise<void>;
  apiBaseUrl?: string;
};
type Scene = 'early' | 'canopy' | 'cross';
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const count = (value: number) => new Intl.NumberFormat('en').format(value);
const date = (value: string) => new Date(`${value.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const state = (value: string) => ({ f: 'Flooded', d: 'Drained', u: 'Uncertain', '-': 'No observation' }[value] ?? 'No observation');
const arrow = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6" stroke="currentColor" stroke-width="1.5"/></svg>';
const ERROR = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Native adaptations of Animata's fluid-tab, timeline and animated-beam interaction ideas.
 * Reference: https://animata.design/components (MIT). No React or motion runtime is required.
 */
export function mountComponents(options: Options) {
  const roots = {
    story: document.querySelector<HTMLElement>('#storyDemo'),
    how: document.querySelector<HTMLElement>('#walkthroughDemo'),
    method: document.querySelector<HTMLElement>('#methodDemo'),
    api: document.querySelector<HTMLElement>('#apiDemo'),
  };
  let dataset = options.dataset;
  let fields: DemoField[] = [];
  let selected: DemoField;
  let pass = 0;
  let step = 0;
  let scene: Scene = 'early';
  let generation = 0;
  let alive = true;
  let detailLoading = false;
  let detailError = '';
  let apiEndpoint = 'meta';
  let apiBody = '';
  let apiRequest = 0;
  let apiExpanded = false;
  let checks: unknown = null;
  let checksError = '';
  let checkedRun = '';
  let walkthroughTabs: ReturnType<typeof mountAstryxTabs> | undefined;
  let apiAction: ReturnType<typeof mountAstryxButton> | undefined;
  const loadedDetails = new Set<string>();
  const endpointItems = [
    ['meta', 'Run metadata', 'Season, tiles, stages and counts'],
    ['passes', 'Satellite passes', 'Acquisition dates and exclusions'],
    ['states', 'Field states', 'The complete field-by-pass matrix'],
    ['fields', 'Field evidence', 'Geometry, observations and summary'],
    ['checks', 'Run checks', 'Season shape and independent comparisons'],
  ];

  const runLabel = () => `${dataset.fixture ? 'Sample run' : 'Run'} ${dataset.run_id}`;
  const fieldDistrict = () => Object.values(dataset.tiles).find((tile) => tile.fields.some((field) => field.id === selected.id))?.district ?? '';
  const valid = (version: number, id?: string) => alive && generation === version && (!id || selected.id === id);
  const bindTabs = (root: HTMLElement, selector: string, activate: (button: HTMLButtonElement) => void) => {
    const tabs = [...root.querySelectorAll<HTMLButtonElement>(selector)];
    tabs.forEach((button, index) => {
      button.onclick = () => {
        activate(button);
        root.querySelector<HTMLButtonElement>(`${selector}[data-value="${button.dataset.value}"]`)?.focus();
      };
      button.onkeydown = (event) => {
        let next = index;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % tabs.length;
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index + tabs.length - 1) % tabs.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = tabs.length - 1;
        else return;
        event.preventDefault();
        activate(tabs[next]);
        const replacement = root.querySelector<HTMLButtonElement>(`${selector}[data-value="${tabs[next].dataset.value}"]`);
        replacement?.focus();
      };
    });
  };
  const fluidTabs = (name: string, items: [string, string][], value: string) => `<div class="ms-tabs" role="tablist" aria-label="${name}">${items.map(([id, title]) => `<button type="button" role="tab" id="ms-${name}-${id}" aria-controls="ms-${name}-panel" aria-selected="${value === id}" tabindex="${value === id ? 0 : -1}" data-value="${id}">${title}</button>`).join('')}</div>`;
  const passButtons = (prefix: string) => `<div class="ms-pass-strip" style="--pass-count:${dataset.passes.length}" role="group" aria-label="Choose a satellite pass">${dataset.passes.map((day, index) => `<button type="button" class="ms-pass ms-state-${selected.s[index]}${pass === index ? ' is-current' : ''}" data-${prefix}-pass="${index}" aria-pressed="${pass === index}" aria-label="${date(day)}, ${state(selected.s[index])}"><span class="ms-pass-mark" aria-hidden="true"></span><span>${date(day)}</span></button>`).join('')}</div>`;

  function fieldMapMarkup(interactive = true): string {
    const prefix = interactive ? 'guide' : 'flow';
    const tile = Object.values(dataset.tiles).find((tile) => tile.fields.some((field) => field.id === selected.id))!;
    const rings = (field: DemoField) => field.geometry ? field.geometry.type === 'Polygon' ? field.geometry.coordinates : field.geometry.coordinates.flat() : [field.poly];
    const center = (field: DemoField) => { const points = rings(field).flat(); return points.reduce(([x, y], point) => [x + point[0] / points.length, y + point[1] / points.length], [0, 0]); };
    const [selectedX, selectedY] = center(selected);
    const distance = (field: DemoField) => { const [x, y] = center(field); return (x - selectedX) ** 2 + (y - selectedY) ** 2; };
    const nearby = interactive ? [...tile.fields].sort((a, b) => distance(a) - distance(b)).slice(0, 24) : [selected];
    const points = nearby.flatMap((field) => rings(field).flat());
    const minX = Math.min(...points.map((point) => point[0]));
    const maxX = Math.max(...points.map((point) => point[0]));
    const minY = Math.min(...points.map((point) => point[1]));
    const maxY = Math.max(...points.map((point) => point[1]));
    const scale = Math.min(480 / Math.max(.00001, maxX - minX), 280 / Math.max(.00001, maxY - minY));
    const px = (x: number) => 40 + (520 - (maxX - minX) * scale) / 2 + (x - minX) * scale;
    const py = (y: number) => 26 + (300 - (maxY - minY) * scale) / 2 + (maxY - y) * scale;
    return `<svg viewBox="0 0 600 352" class="ms-field-map ms-map-${prefix}" role="group" aria-label="${interactive ? 'Choose a mapped field' : 'Selected field geometry'} in ${esc(tile.district)}"><defs><pattern id="ms-${prefix}-land-grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="currentColor" opacity=".08"/></pattern><pattern id="ms-${prefix}-uncertain" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><path d="M0 0V6" stroke="var(--haze)" stroke-width="2"/></pattern></defs><rect width="600" height="352" fill="url(#ms-${prefix}-land-grid)"/>${nearby.map((field) => `<path class="ms-field ms-state-${field.s[pass]} ${field.id === selected.id ? 'is-selected' : ''}" fill-rule="evenodd" d="${rings(field).map((ring) => `${ring.map(([x, y], i) => `${i ? 'L' : 'M'}${px(x).toFixed(2)},${py(y).toFixed(2)}`).join('')}Z`).join(' ')}" ${interactive ? `role="button" tabindex="${field.id === selected.id ? 0 : -1}" data-guide-field="${esc(field.id)}" aria-label="${esc(field.id)}, ${state(field.s[pass])}" aria-pressed="${field.id === selected.id}"` : ''}><title>${esc(field.id)} · ${state(field.s[pass])}</title></path>`).join('')}<path d="M20 327h35m-35-4v8m35-8v8" stroke="var(--dim)" fill="none"/><text x="65" y="331" fill="var(--dim)" font-size="11">Field geometry from ${esc(dataset.run_id)}</text></svg>`;
  }

  function renderStory(): void {
    if (!roots.story) return;
    const currentState = selected.s[pass];
    roots.story.innerHTML = `<div class="ms-evidence-flow"><div class="ms-flow-source"><span class="ms-micro">The question</span><p>Was this field<br><em>really drained?</em></p><div class="ms-flow-field">${fieldMapMarkup(false)}</div><span class="ms-source-caption">${esc(selected.id)} · ${esc(fieldDistrict())}</span></div><div class="ms-flow-bridge" aria-hidden="true"><svg viewBox="0 0 440 240" preserveAspectRatio="none"><path class="ms-beam-track" d="M0 120H100Q120 120 120 100V50Q120 30 140 30H230Q250 30 250 50V100Q250 120 270 120H440M120 120v70q0 20 20 20h90q20 0 20-20v-70"/><path class="ms-beam-motion" d="M0 120H100Q120 120 120 100V50Q120 30 140 30H230Q250 30 250 50V100Q250 120 270 120H440"/><path class="ms-beam-motion ms-beam-alt" d="M0 120H120v70q0 20 20 20h90q20 0 20-20v-70h190"/></svg><div class="ms-radar-node"><svg viewBox="0 0 64 64" fill="none"><path d="m19 20 25 25m-15-25 15 15M21 43l-8 8m15-20-8 8m15-15-7 7M21 18l11-11 25 25-11 11Z" stroke="currentColor" stroke-width="1.5"/><path d="M12 25c14 0 25 11 25 25M12 34c9 0 16 7 16 16M12 43c4 0 7 3 7 7" stroke="var(--water)" stroke-width="1.5"/></svg><span>NISAR passes</span></div><span class="ms-bridge-note">Matched by<br>field and date</span></div><div class="ms-flow-result"><span class="ms-micro">The satellite evidence</span><div class="ms-result-state ms-state-${currentState}"><span class="ms-state-dot"></span><strong>${state(currentState)}</strong></div><p class="ms-result-date">${date(dataset.passes[pass])} · HH ${selected.hh[pass] === null ? 'not supplied' : `${selected.hh[pass]!.toFixed(2)} dB`}</p>${passButtons('flow')}<span class="ms-source-caption">${esc(runLabel())} · ${count(dataset.passes.length)} available dates</span></div></div><ol class="ms-story-notes"><li><span>01</span><div><h3>A promise in the paddy</h3><p>Alternate wetting and drying can reduce rice methane. Payments depend on what happened in the field.</p></div></li><li><span>02</span><div><h3>A season behind clouds</h3><p>Monsoon weather obscures optical imagery. NISAR radar records a different view of the surface.</p></div></li><li><span>03</span><div><h3>A trail to inspect</h3><p>Follow each field's inferred states, then use the evidence to plan a closer look.</p></div></li></ol>`;
    roots.story.querySelectorAll<HTMLButtonElement>('[data-flow-pass]').forEach((button) => button.onclick = () => choosePass(Number(button.dataset.flowPass), 'flow'));
  }

  function graphMarkup(): string {
    const measured = selected.hh.flatMap((value, index) => value === null ? [] : [{ value, index }]);
    if (!measured.length) return `<div class="ms-measurement-empty">${detailLoading ? 'Reading this field’s radar observations…' : detailError || 'HH measurements are not supplied for this field.'}</div>`;
    const low = Math.floor(Math.min(...measured.map((row) => row.value)) - 1);
    const high = Math.ceil(Math.max(...measured.map((row) => row.value)) + 1);
    const times = dataset.passes.map((day) => Date.parse(day));
    const firstTime = times[0], lastTime = times.at(-1)!;
    const xAtTime = (time: number) => 52 + (time - firstTime) / Math.max(1, lastTime - firstTime) * 480;
    const x = (index: number) => xAtTime(times[index]);
    const y = (value: number) => 190 - (value - low) / (high - low) * 150;
    let path = '', previous = -2;
    measured.forEach(({ value, index }) => {
      const acrossGap = previous >= 0 && dataset.gaps.some((gap) => times[previous] < Date.parse(gap.start) && times[index] > Date.parse(gap.end));
      path += `${index === previous + 1 && !acrossGap ? 'L' : 'M'}${x(index)},${y(value)} `;
      previous = index;
    });
    const gaps = dataset.gaps.flatMap((gap) => {
      const start = Math.max(firstTime, Date.parse(gap.start)), end = Math.min(lastTime, Date.parse(gap.end));
      return end > start ? [`<rect x="${xAtTime(start)}" y="34" width="${xAtTime(end) - xAtTime(start)}" height="163" fill="var(--ink)" opacity=".05"/><text x="${(xAtTime(start) + xAtTime(end)) / 2}" y="25" text-anchor="middle" fill="var(--dim)" font-size="10">No data</text>`] : [];
    }).join('');
    return `<svg class="ms-hh-chart" viewBox="0 0 570 240" role="img" aria-label="HH backscatter for ${esc(selected.id)}: ${esc(measured.map(({ value, index }) => `${date(dataset.passes[index])} ${value.toFixed(2)} dB`).join('; '))}${dataset.gaps.length ? '. Shaded bands mark gaps in satellite data.' : ''}">${gaps}${[0, .5, 1].map((fraction) => `<path d="M52 ${190 - fraction * 150}H532" stroke="var(--line)" stroke-dasharray="3 5"/><text x="39" y="${195 - fraction * 150}" fill="var(--dim)" text-anchor="end" font-size="12">${(low + fraction * (high - low)).toFixed(0)}</text>`).join('')}<text x="21" y="22" fill="var(--dim)" font-size="11">dB</text><path class="ms-signal-trace" d="${path}" fill="none" stroke="var(--water)" stroke-width="2" pathLength="1"/><path d="M${x(pass)} 28V198" stroke="var(--ink)" opacity=".35"/>${measured.map(({ value, index }) => `<circle class="ms-chart-point ms-state-${selected.s[index]}" cx="${x(index)}" cy="${y(value)}" r="${index === pass ? 6 : 3.5}"/>`).join('')}<text x="52" y="225" fill="var(--dim)" font-size="12">${date(dataset.passes[0])}</text><text x="532" y="225" fill="var(--dim)" font-size="12" text-anchor="end">${date(dataset.passes.at(-1)!)}</text></svg>`;
  }

  function renderHow(focus?: string): void {
    const root = roots.how;
    if (!root) return;
    const activeId = root.contains(document.activeElement) ? document.activeElement?.id : '';
    const activeField = root.contains(document.activeElement) ? document.activeElement?.getAttribute('data-guide-field') : null;
    walkthroughTabs?.destroy();
    const titles = [['0', 'Pick a field'], ['1', 'Read the passes'], ['2', 'Open the evidence']] as [string, string][];
    const current = selected.s[pass];
    const descriptions = ['Choose a mapped field. Its identity stays with every observation that follows.', 'Move through the available acquisitions. Each date is a separate radar look.', 'Read the observations behind a field state, then open that same field on the map.'];
    let view = '';
    if (step === 0) view = `<div class="ms-guide-map"><div class="ms-guide-map-heading"><span>${esc(fieldDistrict())}</span><span>${date(dataset.passes[pass])}</span></div>${fieldMapMarkup()}<p class="ms-map-instruction">Select a field boundary or choose a field below.</p><label class="ms-field-select">Field <select id="ms-guide-field">${Object.values(dataset.tiles).map((tile) => `<optgroup label="${esc(tile.district)}">${tile.fields.slice(0, 20).map((field) => `<option value="${esc(field.id)}" ${field.id === selected.id ? 'selected' : ''}>${esc(field.id)}</option>`).join('')}${!tile.fields.slice(0, 20).some((field) => field.id === selected.id) && tile.fields.some((field) => field.id === selected.id) ? `<option value="${esc(selected.id)}" selected>${esc(selected.id)}</option>` : ''}</optgroup>`).join('')}</select></label></div>`;
    else if (step === 1) view = `<div class="ms-guide-series"><div class="ms-large-reading"><span class="ms-micro">HH backscatter · ${date(dataset.passes[pass])}</span><p>${selected.hh[pass] === null ? '<span class="ms-reading-unavailable">No HH value</span>' : `${selected.hh[pass]!.toFixed(2)}<span>dB</span>`}</p><span class="ms-inline-state ms-state-${current}"><i></i>${state(current)}</span></div>${graphMarkup()}${passButtons('guide')}</div>`;
    else view = `<div class="ms-guide-report"><div class="ms-report-heading"><svg viewBox="0 0 44 52" fill="none" aria-hidden="true"><path d="M8 2h20l10 10v38H8Z" stroke="currentColor" stroke-width="1.5"/><path d="M28 2v12h10M15 25h16M15 32h16M15 39h10" stroke="currentColor" stroke-width="1.5"/></svg><div><span class="ms-micro">Field evidence</span><h3>${esc(selected.id)}</h3></div></div><dl class="ms-report-facts"><div><dt>Dataset</dt><dd>${esc(runLabel())}</dd></div><div><dt>District</dt><dd>${esc(fieldDistrict())}</dd></div><div><dt>Field area</dt><dd>${selected.ha.toFixed(2)} ha</dd></div><div><dt>Available observations</dt><dd>${selected.s.split('').filter((value) => value !== '-').length} of ${dataset.passes.length} dates</dd></div></dl><div class="ms-report-pass"><div><span>${date(dataset.passes[pass])}</span><strong class="ms-state-${current}">${state(current)}</strong></div><p>HH backscatter <b>${selected.hh[pass] === null ? 'Not supplied' : `${selected.hh[pass]!.toFixed(2)} dB`}</b></p><p>Classifier confidence <b>${selected.c[pass] === null ? 'Not supplied' : `${(selected.c[pass]! * 100).toFixed(0)}%`}</b></p></div><button type="button" class="ms-text-action" id="ms-open-field">Open this field on the map ${arrow}</button><p class="ms-action-status" id="ms-open-status" role="status"></p></div>`;
    root.innerHTML = `<div id="ms-walk-tabs"></div><div class="ms-walkthrough"><div class="ms-walk-copy"><div class="ms-walk-description"><span class="ms-stage-number" aria-hidden="true">0${step + 1}</span><h3>${titles[step][1]}</h3><p>${descriptions[step]}</p></div><button type="button" class="ms-next" id="ms-guide-next">${step < 2 ? 'Next step' : 'Back to field selection'} ${arrow}</button></div><div class="ms-product-window"><div class="ms-window-bar"><span class="ms-window-brand">Mudskipper</span><span>${esc(runLabel())}</span></div><div class="ms-walk-panel" id="ms-walk-panel" role="tabpanel" tabindex="0" aria-labelledby="ms-walk-${step}">${view}</div><div class="ms-window-footer"><span>${esc(selected.id)}</span><span class="ms-inline-state ms-state-${current}"><i></i>${state(current)}</span></div></div></div>`;
    walkthroughTabs = mountAstryxTabs(root.querySelector<HTMLElement>('#ms-walk-tabs')!, {
      items: titles.map(([value, label]) => ({ value, label, id: `ms-walk-${value}`, panelId: 'ms-walk-panel' })),
      value: String(step), label: 'Field walkthrough',
      onChange(value) { step = Number(value); renderHow(`#ms-walk-${step}`); },
    });
    root.querySelector<HTMLButtonElement>('#ms-guide-next')!.onclick = () => { step = (step + 1) % 3; renderHow(`#ms-walk-${step}`); };
    root.querySelectorAll<HTMLButtonElement>('[data-guide-pass]').forEach((button) => button.onclick = () => choosePass(Number(button.dataset.guidePass), 'guide'));
    root.querySelector<HTMLSelectElement>('#ms-guide-field')?.addEventListener('change', (event) => { chooseField((event.target as HTMLSelectElement).value); root.querySelector<HTMLSelectElement>('#ms-guide-field')?.focus(); });
    const fieldPaths = [...root.querySelectorAll<SVGPathElement>('[data-guide-field]')];
    fieldPaths.forEach((element, index) => {
      element.onclick = () => chooseField(element.dataset.guideField!);
      element.onkeydown = (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); chooseField(element.dataset.guideField!); return; }
        let next: number;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % fieldPaths.length;
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index + fieldPaths.length - 1) % fieldPaths.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = fieldPaths.length - 1;
        else return;
        event.preventDefault();
        fieldPaths.forEach((path) => path.setAttribute('tabindex', '-1'));
        fieldPaths[next].setAttribute('tabindex', '0');
        fieldPaths[next].focus();
      };
    });
    root.querySelector<HTMLButtonElement>('#ms-open-field')?.addEventListener('click', () => void openField());
    if (focus) root.querySelector<HTMLElement>(focus)?.focus();
    else if (activeId) root.querySelector<HTMLElement>(`#${CSS.escape(activeId)}`)?.focus();
    else if (activeField) root.querySelector<SVGPathElement>(`[data-guide-field="${CSS.escape(activeField)}"]`)?.focus();
  }

  function radarScene(): string {
    if (scene === 'cross') return `<svg class="ms-science-scene ms-cross-scene" viewBox="0 0 600 390" role="img" aria-label="Conceptual comparison of radar field states, independent water mapping and district context"><defs><pattern id="ms-cross-grid" width="34" height="34" patternUnits="userSpaceOnUse"><path d="M34 0H0V34" fill="none" stroke="var(--line)"/></pattern></defs><g transform="translate(160 25) rotate(12 170 100)"><rect width="280" height="180" rx="4" fill="#162e35" stroke="var(--line)"/><path d="M0 0h280v180H0Z" fill="url(#ms-cross-grid)"/><path class="ms-cross-patch" d="m33 29 69-9 28 42-41 47-55-15Zm105 20 69-16 37 53-25 45-66-10Z" fill="var(--water)" fill-opacity=".4"/></g><path class="ms-comparison-connect" d="M300 187v90M205 181l-55 113m245-112 55 112" fill="none" stroke="var(--water)" stroke-dasharray="5 7"/><g transform="translate(80 200) rotate(-8 160 80)"><rect width="300" height="150" rx="4" fill="#1d3030" stroke="var(--dim)" stroke-opacity=".4"/><path d="M0 75 70 44l77 31 70-40 83 40v75H0Z" fill="var(--water)" fill-opacity=".2"/><path d="M0 75 70 44l77 31 70-40 83 40" fill="none" stroke="var(--water)" stroke-width="2"/><text x="18" y="128" font-size="13" fill="var(--ink)">Independent water mapping</text></g><g transform="translate(361 222)"><rect width="172" height="115" rx="4" fill="#213035" stroke="var(--line)"/><path d="m30 65 14-27 28 7 23-20 39 20-10 33-44 8-50-8Z" fill="none" stroke="var(--mud)" stroke-width="1.5"/><text x="18" y="100" font-size="12" fill="var(--ink)">District context</text></g><text x="181" y="56" fill="var(--ink)" font-size="13">Field states from radar</text></svg>`;
    const canopy = scene === 'canopy';
    const stalks = Array.from({ length: canopy ? 15 : 8 }, (_, index) => {
      const x = 150 + index % 5 * 56 + Math.floor(index / 5) * 12;
      const base = 270 - Math.floor(index / 5) * 21;
      const height = canopy ? 74 + index % 3 * 13 : 20 + index % 3 * 5;
      return `<g class="ms-rice-stalk" style="--stalk-order:${index}"><path d="M${x} ${base}q-7-${height / 2} 0-${height}m0 ${height * .7}q-25-4-22-24m23 6q23-4 22-25" fill="none" stroke="#9caf83" stroke-width="${canopy ? 2.5 : 1.7}"/></g>`;
    }).join('');
    return `<svg class="ms-science-scene" viewBox="0 0 600 390" role="img" aria-label="Conceptual radar path: ${canopy ? 'radar reflects between standing water and rice stems back toward the satellite' : 'open water reflects radar away from the satellite'}"><defs><linearGradient id="ms-water-plane" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#3fd0c9" stop-opacity=".26"/><stop offset="1" stop-color="#3fd0c9" stop-opacity=".06"/></linearGradient><pattern id="ms-water-ripple" width="48" height="18" patternUnits="userSpaceOnUse"><path d="M0 9q12-4 24 0t24 0" fill="none" stroke="var(--water)" stroke-opacity=".25"/></pattern></defs><ellipse cx="310" cy="307" rx="220" ry="25" fill="#09171c"/><path d="m82 244 240-84 215 84-234 98Z" fill="#263d38"/><path d="m82 244 221 87 234-87v17l-234 98-221-98Z" fill="#25352e"/><path d="m99 240 222-77 198 79-216 88Z" fill="url(#ms-water-plane)" stroke="var(--water)" stroke-opacity=".6"/><path d="m99 240 222-77 198 79-216 88Z" fill="url(#ms-water-ripple)"/>${stalks}<g class="ms-satellite" transform="translate(100 32) rotate(25 40 25)"><path d="M32 11h26v30H32ZM5 12h23v28H5Zm57 0h23v28H62Z" fill="#17363d" stroke="var(--dim)"/><path d="M14 12v28m12-28v28m45-28v28m10-28v28M5 26h23m34 0h23" stroke="var(--dim)" stroke-opacity=".4"/><path d="M44 41v13m-8 0h16" stroke="var(--ink)"/></g><path class="ms-radar-ray ms-ray-in" d="M154 97 302 242" fill="none" stroke="var(--ink)" stroke-width="2" stroke-dasharray="7 8"/>${canopy ? '<path class="ms-radar-ray ms-ray-out" d="m302 242 31-53-179-92" fill="none" stroke="var(--water)" stroke-width="2" stroke-dasharray="7 8"/><circle class="ms-bounce-ring" cx="302" cy="242" r="18" fill="none" stroke="var(--water)"/><circle class="ms-bounce-ring ms-bounce-second" cx="333" cy="189" r="13" fill="none" stroke="var(--water)"/><text x="366" y="146" fill="var(--water)" font-size="13">Water + stems</text><text x="366" y="166" fill="var(--dim)" font-size="12">A return path to the satellite</text>' : '<path class="ms-radar-ray ms-ray-out" d="m302 242 178-139" fill="none" stroke="var(--water)" stroke-width="2" stroke-dasharray="7 8"/><circle class="ms-bounce-ring" cx="302" cy="242" r="18" fill="none" stroke="var(--water)"/><text x="374" y="80" fill="var(--water)" font-size="13">Open water</text><text x="374" y="100" fill="var(--dim)" font-size="12">Reflection away from the satellite</text>'}<text x="78" y="373" fill="var(--dim)" font-size="12">Conceptual radar path · not to scale</text></svg>`;
  }

  function renderMethod(): void {
    const root = roots.method;
    if (!root) return;
    const activeId = root.contains(document.activeElement) ? document.activeElement?.id : '';
    const content = {
      early: ['Before the canopy', 'Open water can reflect radar away from the satellite. A quiet return can carry information about flooding.'],
      canopy: ['When rice stands in water', 'Stems and standing water create another return path. The signal changes as the crop grows.'],
      cross: ['Put the signal in context', 'Compare the season shape, independent water mapping and district records alongside the field evidence.'],
    }[scene];
    let comparison = '';
    if (scene === 'cross') {
      const checksObject = checks && typeof checks === 'object' ? checks as Record<string, unknown> : null;
      const seasonCheck = checksObject?.season_shape as { pass?: boolean; rule?: string } | undefined;
      const opera = checksObject?.opera as { product?: string; n_dates?: number } | undefined;
      comparison = `<div class="ms-method-comparison"><h4>Checks from this run</h4>${dataset.kind === 'snapshot' ? `<p>Source file <b>${esc(dataset.source?.file ?? dataset.run_id)}</b></p><p>Field states and HH are supplied by this archived snapshot.</p>` : checksObject ? `<p>Season shape <b>${seasonCheck ? seasonCheck.pass ? 'Passed' : 'Did not pass' : 'Not supplied'}</b></p><p>Independent comparison <b>${opera ? `${esc(opera.product)} · ${count(opera.n_dates ?? 0)} dates` : 'Not supplied'}</b></p>${seasonCheck?.rule ? `<p class="ms-fine">${esc(seasonCheck.rule)}</p>` : ''}` : checksError ? `<p role="status">${esc(checksError)}</p><button type="button" class="ms-text-action" id="ms-retry-checks">Retry checks ${arrow}</button>` : '<p>Loading published checks…</p>'}<a class="ms-text-action" href="#analysis">Explore checks and sources ${arrow}</a></div>`;
    } else comparison = `<div class="ms-method-reading"><span class="ms-micro">Actual field measurement</span><div class="ms-measure-head"><strong>${selected.hh[pass] === null ? '—' : selected.hh[pass]!.toFixed(2)}<small>${selected.hh[pass] === null ? '' : ' dB'}</small></strong><span>${date(dataset.passes[pass])}<br>${esc(selected.id)}</span></div>${graphMarkup()}<label class="ms-signal-control" for="ms-method-pass"><span>Move through the season</span><input id="ms-method-pass" type="range" min="0" max="${dataset.passes.length - 1}" step="1" value="${pass}" aria-valuetext="${date(dataset.passes[pass])}, ${selected.hh[pass] === null ? 'HH not supplied' : `${selected.hh[pass]} dB`}"></label><p class="ms-fine">HH backscatter · ${esc(runLabel())}</p></div>`;
    root.innerHTML = `<div class="ms-method-lab"><div class="ms-method-header">${fluidTabs('science', [['early', 'Early season'], ['canopy', 'Rice canopy'], ['cross', 'Cross-checks']], scene)}</div><div class="ms-method-panel" id="ms-science-panel" role="tabpanel" tabindex="0" aria-labelledby="ms-science-${scene}"><div class="ms-scene-side">${radarScene()}<p class="ms-scene-mobile-note ms-fine">Conceptual illustration${scene === 'cross' ? '' : ' · not to scale'}</p><div class="ms-scene-caption"><h3>${content[0]}</h3><p>${content[1]}</p></div></div>${comparison}</div></div>`;
    bindTabs(root, '[role="tab"]', (button) => { scene = button.dataset.value as Scene; renderMethod(); if (scene === 'cross') void loadChecks(); });
    root.querySelector<HTMLButtonElement>('#ms-retry-checks')?.addEventListener('click', () => { checkedRun = ''; checksError = ''; renderMethod(); void loadChecks(); });
    root.querySelector<HTMLInputElement>('#ms-method-pass')?.addEventListener('input', (event) => {
      pass = Number((event.target as HTMLInputElement).value);
      const focus = document.activeElement?.id === 'ms-method-pass';
      renderStory(); renderHow(); renderMethod();
      if (focus) root.querySelector<HTMLInputElement>('#ms-method-pass')?.focus();
    });
    if (activeId) root.querySelector<HTMLElement>(`#${CSS.escape(activeId)}`)?.focus();
  }

  async function loadChecks(): Promise<void> {
    if (dataset.kind !== 'api' || !options.getJSON || checkedRun === dataset.run_id) return;
    const version = generation;
    checkedRun = dataset.run_id;
    if (checksError) { checksError = ''; renderMethod(); }
    try {
      const response = await options.getJSON('/api/checks');
      if (!valid(version)) return;
      if (!response || typeof response !== 'object' || (response as { run_id?: string }).run_id !== dataset.run_id) throw new Error('Checks belong to a different run.');
      checks = response;
      renderMethod();
    } catch (error) {
      if (!valid(version)) return;
      checks = null;
      checksError = ERROR(error);
      checkedRun = '';
      renderMethod();
    }
  }

  const apiPath = () => `/api/${apiEndpoint === 'fields' ? `fields/${encodeURIComponent(apiFieldId())}` : apiEndpoint}`;
  const apiFieldId = () => dataset.kind === 'api' ? selected.id : '';
  const apiUrl = () => `${(options.apiBaseUrl ?? '').replace(/\/$/, '')}${apiPath()}`;
  function renderApi(): void {
    const root = roots.api;
    if (!root) return;
    apiAction?.destroy();
    root.innerHTML = `<div class="ms-api-workspace"><div class="ms-api-sidebar"><h3>Make a request.</h3><p>Read the published run directly.</p><div class="ms-endpoints" role="tablist" aria-label="API endpoints" aria-orientation="vertical">${endpointItems.map(([id, title, description]) => `<button type="button" role="tab" aria-selected="${apiEndpoint === id}" id="ms-endpoint-${id}" aria-controls="ms-api-panel" tabindex="${apiEndpoint === id ? 0 : -1}" data-value="${id}"><span class="ms-get">GET</span><span><strong>${title}</strong><small>${description}</small></span>${arrow}</button>`).join('')}</div><a class="ms-api-analysis" href="#analysis">Generate an inspection list ${arrow}</a></div><div class="ms-console" id="ms-api-panel" role="tabpanel" tabindex="0" aria-labelledby="ms-endpoint-${apiEndpoint}"><div class="ms-console-request"><span class="ms-get">GET</span><code id="ms-request-path">${esc(apiPath())}</code><span id="ms-run-request-host"></span></div><div class="ms-console-context"><span>Published API${dataset.kind === 'api' ? ` · ${esc(runLabel())}` : ''}</span><a id="ms-api-open" href="${esc(apiUrl())}" target="_blank" rel="noopener">Open endpoint ↗</a></div><div class="ms-response-toolbar"><span id="ms-api-status" role="status">${apiEndpoint === 'fields' && !apiFieldId() ? 'Choose the published API dataset to query a field.' : 'Ready to request'}</span><button type="button" id="ms-copy-response" disabled>Copy response</button></div><pre class="ms-response" tabindex="0" aria-label="API response"><code id="ms-api-response">The response will appear here.</code></pre><div class="ms-response-footer"><span id="ms-api-size">JSON response</span><button type="button" id="ms-expand-response" hidden>Show more</button></div></div></div>`;
    bindTabs(root, '[role="tab"]', (button) => { apiEndpoint = button.dataset.value!; apiBody = ''; apiRequest++; apiExpanded = false; renderApi(); });
    apiAction = mountAstryxButton(root.querySelector<HTMLElement>('#ms-run-request-host')!, { label: 'Run request', id: 'ms-run-request', ariaControls: 'ms-api-response', variant: 'primary', disabled: !options.getJSON || (apiEndpoint === 'fields' && !apiFieldId()), onClick: () => requestApi() });
    root.querySelector<HTMLButtonElement>('#ms-copy-response')!.onclick = () => void copyResponse();
    root.querySelector<HTMLButtonElement>('#ms-expand-response')!.onclick = () => { apiExpanded = !apiExpanded; showResponse(); };
  }

  function showResponse(): void {
    const root = roots.api;
    if (!root) return;
    const lines = apiBody.split('\n');
    const limit = apiExpanded ? 300 : 38;
    root.querySelector('#ms-api-response')!.textContent = lines.slice(0, limit).join('\n') + (lines.length > limit ? `\n\n… ${count(lines.length - limit)} more lines. Copy response for the complete JSON.` : '');
    root.querySelector('#ms-api-size')!.textContent = `${count(new TextEncoder().encode(apiBody).length)} bytes · ${count(lines.length)} lines`;
    const expand = root.querySelector<HTMLButtonElement>('#ms-expand-response')!;
    expand.hidden = lines.length <= 38;
    expand.textContent = apiExpanded ? 'Collapse preview' : 'Show more';
  }

  async function requestApi(): Promise<void> {
    if (!options.getJSON || !roots.api) return;
    const version = generation;
    const request = ++apiRequest;
    const path = apiPath();
    const requestHadFocus = document.activeElement?.id === 'ms-run-request';
    apiBody = '';
    apiExpanded = false;
    const status = roots.api.querySelector('#ms-api-status')!;
    roots.api.querySelector<HTMLButtonElement>('#ms-copy-response')!.disabled = true;
    roots.api.querySelector<HTMLButtonElement>('#ms-expand-response')!.hidden = true;
    roots.api.querySelector('#ms-api-size')!.textContent = 'JSON response';
    apiAction?.update({ disabled: true, loading: true });
    status.textContent = 'Reading endpoint…';
    roots.api.querySelector('#ms-api-response')!.textContent = `GET ${path}`;
    try {
      const response = await options.getJSON(path);
      if (!valid(version) || request !== apiRequest) return;
      apiBody = JSON.stringify(response, null, 2);
      status.textContent = 'Response received';
      const identity = response as { run_id?: string; fixture?: boolean };
      if (identity && typeof identity.run_id === 'string') status.textContent = `${identity.fixture ? 'Sample run' : 'Run'} ${identity.run_id} · response received`;
      roots.api.querySelector<HTMLButtonElement>('#ms-copy-response')!.disabled = false;
      showResponse();
    } catch (error) {
      if (!valid(version) || request !== apiRequest) return;
      status.textContent = 'Request failed';
      roots.api.querySelector('#ms-api-response')!.textContent = ERROR(error);
    } finally {
      if (valid(version) && request === apiRequest) {
        apiAction?.update({ disabled: false, loading: false });
        if (requestHadFocus && document.activeElement === document.body) roots.api.querySelector<HTMLButtonElement>('#ms-run-request')?.focus();
      }
    }
  }

  async function copyResponse(): Promise<void> {
    if (!apiBody || !roots.api) return;
    try { await navigator.clipboard.writeText(apiBody); roots.api.querySelector('#ms-api-status')!.textContent = 'Complete response copied'; }
    catch { roots.api.querySelector('#ms-api-status')!.textContent = 'Copy unavailable. Open the endpoint to save the response.'; }
  }

  async function openField(): Promise<void> {
    const version = generation;
    const id = selected.id;
    const message = roots.how?.querySelector('#ms-open-status');
    try {
      await options.selectField?.(id);
      if (!valid(version, id)) return;
      document.querySelector('#map')?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.classList.contains('motion-paused') ? 'instant' : 'smooth' });
      if (message) message.textContent = `Selected ${id} on the map.`;
    } catch (error) { if (valid(version, id) && message) message.textContent = ERROR(error); }
  }

  function choosePass(index: number, origin: 'flow' | 'guide'): void {
    pass = index;
    renderStory(); renderHow(); renderMethod();
    const root = origin === 'flow' ? roots.story : roots.how;
    root?.querySelector<HTMLButtonElement>(`[data-${origin}-pass="${index}"]`)?.focus();
  }

  function chooseField(id: string): void {
    const field = fields.find((field) => field.id === id);
    if (!field) return;
    selected = field;
    detailError = '';
    renderStory(); renderHow(); renderMethod();
    if (apiEndpoint === 'fields') { apiRequest++; apiBody = ''; renderApi(); }
    void loadField();
  }

  async function loadField(): Promise<void> {
    if (dataset.kind !== 'api' || !options.getFieldDetail || loadedDetails.has(selected.id)) return;
    const version = generation;
    const field = selected;
    detailLoading = true;
    try {
      const detail = await options.getFieldDetail(field);
      if (!valid(version, field.id)) return;
      if (detail.run_id !== dataset.run_id || detail.field.properties.field_id !== field.id) throw new Error('Field observations belong to a different run or field.');
      for (const observation of detail.observations) {
        const index = dataset.passIds.indexOf(observation.pass_id);
        if (index >= 0) { field.hh[index] = observation.observed.hh_db; field.c[index] = observation.inferred.confidence; }
      }
      loadedDetails.add(field.id);
    } catch (error) { if (valid(version, field.id)) detailError = ERROR(error); }
    finally { if (valid(version, field.id)) { detailLoading = false; renderStory(); renderHow(); renderMethod(); } }
  }

  function updateDataset(next: DemoDataset): void {
    dataset = next;
    generation++;
    apiRequest++;
    fields = Object.values(dataset.tiles).flatMap((tile) => tile.fields);
    if (!fields.length || !dataset.passes.length) return;
    selected = fields.find((field) => field.s.includes('d') && field.s.includes('f')) ?? fields[0];
    pass = Math.max(0, selected.s.indexOf('d'));
    detailLoading = false;
    detailError = '';
    checks = null;
    checksError = '';
    checkedRun = '';
    loadedDetails.clear();
    renderStory(); renderHow(); renderMethod(); renderApi();
    void loadField();
    if (scene === 'cross') void loadChecks();
  }

  updateDataset(dataset);
  return {
    updateDataset,
    destroy() { alive = false; generation++; apiRequest++; walkthroughTabs?.destroy(); apiAction?.destroy(); Object.values(roots).forEach((root) => root?.replaceChildren()); },
  };
}
