import { detectability } from '@mudskipper/core';
import type { MudskipperClient } from '@mudskipper/core/client';
import type { ApiChecks, AuditResponse, Claims, Detectability, Provenance } from '@mudskipper/core/contracts';
import type { DemoDataset } from './data';
import { getApiFieldDetails } from './data';
import { archivedFieldMarkup, checkCharts, modelFieldMarkup, passSchedule, runCoverage, seasonProfile } from './backend-views';
import './backend.css';

export interface BackendToolsOptions {
  client: MudskipperClient;
  getDataset: () => DemoDataset;
  selectApiDataset: () => Promise<void>;
  selectField: (id: string) => Promise<void>;
}

export interface BackendTools {
  /** Call after replacing the selected dataset. Pending responses from the old view are discarded. */
  refresh(): void;
  /** Invalidate pending work and empty the mount before removing the renderer. */
  destroy(): void;
}

type Tool = 'detectability' | 'inspection' | 'evidence';
type Scope = { generation: number; dataset: DemoDataset; panel: HTMLElement };
/** The API's inspection budget limit (contracts/CONTRACTS.md, POST /api/audit). */
const MAX_BUDGET = 500;
const TOOLS: { id: Tool; title: string; description: string }[] = [
  { id: 'detectability', title: 'Detectability', description: 'Explore drainage cycles against the pass schedule.' },
  { id: 'inspection', title: 'Inspection', description: 'Rank the published sample claims for a chosen budget.' },
  { id: 'evidence', title: 'Evidence', description: 'Read the run checks and trace the source artifacts.' },
];
const escape = (value: unknown): string => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const number = (value: number): string => Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 });
const percent = (value: number): string => `${number(value * 100)}%`;
const displayNumber = (value: number | null): string => value === null ? '—' : number(value);
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function verifyIdentity(value: { run_id: string; fixture?: boolean }, dataset: DemoDataset, name: string): void {
  assert(value.run_id === dataset.run_id, `${name} belongs to a different run.`);
  assert(value.fixture === dataset.fixture, `${name} has a different source identity.`);
}

function verifyClaims(claims: Claims, dataset: DemoDataset): void {
  if (claims.run_id !== undefined) assert(claims.run_id === dataset.run_id, 'Sample claims belong to a different run.');
  if (claims.fixture !== undefined) assert(claims.fixture === dataset.fixture, 'Sample claims have a different source identity.');
  assert(claims.type === 'FeatureCollection' && Array.isArray(claims.features) && claims.features.length > 0 && claims.features.length <= 5000, 'The sample program must contain 1–5,000 claims.');
  assert(claims.features.every((claim) => claim.properties && typeof claim.properties.synthetic === 'boolean'), 'The sample claims are missing their synthetic metadata.');
}

function safeLink(url: string, label: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return `<a href="${escape(parsed.href)}" target="_blank" rel="noreferrer">${escape(label)}<span class="sr-only"> (opens in a new tab)</span></a>`;
  } catch { /* An invalid citation remains plain text. */ }
  return escape(label);
}

/** Mount into the authored page's #backendTools. API tools only run for an API dataset. */
export function mountBackendTools({ client, getDataset, selectApiDataset, selectField }: BackendToolsOptions): BackendTools {
  const mount = document.querySelector<HTMLElement>('#backendTools');
  if (!mount) throw new Error('The analysis mount #backendTools was not found.');
  const root = mount;
  let active: Tool = 'detectability';
  let generation = 0;
  let destroyed = false;
  // One persistent polite live region outside the re-rendered panel, so loading, results and errors
  // are announced reliably (WCAG 4.1.3).
  const live = document.createElement('p');
  live.className = 'sr-only';
  live.setAttribute('role', 'status');
  root.after(live);
  const announce = (text: string): void => {
    live.textContent = '';
    setTimeout(() => { live.textContent = text; }, 60);
  };

  function current(scope: Scope): boolean {
    return !destroyed && scope.generation === generation && getDataset() === scope.dataset && root.isConnected && scope.panel.isConnected && root.querySelector('#backend-tool-content') === scope.panel;
  }

  function failed(scope: Scope, title: string, error: unknown): void {
    if (!current(scope)) return;
    scope.panel.innerHTML = `<div class="bt-empty"><h3>${escape(title)}</h3><p class="bt-error" role="alert">${escape(errorText(error))}</p><button class="bt-action" type="button" data-retry>Retry</button></div>`;
    scope.panel.querySelector<HTMLButtonElement>('[data-retry]')!.onclick = () => { if (current(scope)) refresh(true); };
  }

  function snapshot(scope: Scope): void {
    const fields = Object.values(scope.dataset.tiles).flatMap((tile) => tile.fields);
    scope.panel.innerHTML = `<div class="bt-snapshot"><div><p class="bt-kicker">Archived selection</p><h3>The recorded season, field by field</h3><p>Read the archived state and HH measurements here. The published run adds the full 5,000-field model, inspection program and source checks.</p></div><div class="bt-source-action"><button class="bt-action" type="button" id="open-published-run">Open published run</button><p class="bt-status" id="published-run-status" role="status"></p></div></div>${seasonProfile(scope.dataset)}<div class="bt-field-workbench"><div class="bt-section-heading"><div><p class="bt-kicker">Archive evidence</p><h3>Follow one field</h3></div><label for="bt-archive-field">Field<select id="bt-archive-field">${fields.map((field) => `<option value="${escape(field.id)}">${escape(field.id)}</option>`).join('')}</select></label></div><div id="bt-archive-reading"></div><button class="bt-action" type="button" id="bt-archive-map">Open field on map</button></div>`;
    const picker = scope.panel.querySelector<HTMLSelectElement>('#bt-archive-field')!;
    const reading = scope.panel.querySelector<HTMLElement>('#bt-archive-reading')!;
    const renderArchive = () => {
      if (!current(scope)) return;
      const field = fields.find((field) => field.id === picker.value)!;
      reading.innerHTML = archivedFieldMarkup(field, scope.dataset);
      announce(`Archive evidence for ${field.id}`);
    };
    picker.onchange = renderArchive;
    renderArchive();
    scope.panel.querySelector<HTMLButtonElement>('#bt-archive-map')!.onclick = async () => {
      try { await selectField(picker.value); } catch (error) { if (current(scope)) announce(errorText(error)); }
    };
    const button = scope.panel.querySelector<HTMLButtonElement>('#open-published-run')!;
    const status = scope.panel.querySelector<HTMLElement>('#published-run-status')!;
    button.onclick = async () => {
      if (!current(scope) || button.disabled) return;
      button.disabled = true;
      status.textContent = 'Opening published run…';
      try {
        await selectApiDataset();
        // Source selection may itself call refresh. Never overwrite that newer view.
        if (!destroyed && generation === scope.generation && scope.panel.isConnected) refresh(true);
        // The button is gone once the run opens; keep keyboard focus on the active tab (WCAG 2.4.3).
        if (!root.contains(document.activeElement)) focusActiveTab();
      } catch (error) {
        if (!current(scope)) return;
        status.textContent = errorText(error);
        status.classList.add('bt-error');
        button.textContent = 'Retry published run';
      } finally {
        if (current(scope)) button.disabled = false;
      }
    };
  }

  async function loadDetectability(scope: Scope): Promise<void> {
    scope.panel.innerHTML = '<p class="bt-status">Loading the pass schedule…</p>';
    announce('Loading the detectability simulation');
    try {
      const simulation = await client.getDetectability();
      if (!current(scope)) return;
      verifyIdentity(simulation, scope.dataset, 'Detectability');
      assert(scope.dataset.apiPasses, 'The selected run has no API pass schedule.');
      const dates = scope.dataset.apiPasses.filter((pass) => pass.used).map((pass) => pass.datetime).sort((a, b) => Date.parse(a) - Date.parse(b));
      assert(Array.isArray(simulation.pass_dates) && dates.length === simulation.pass_dates.length && dates.every((date, index) => date === simulation.pass_dates[index]), 'Detectability pass dates do not match the selected run.');
      renderDetectability(scope, simulation);
      announce('Detectability simulation loaded');
    } catch (error) {
      failed(scope, 'Detectability could not be loaded', error);
    }
  }

  function renderDetectability(scope: Scope, simulation: Detectability): void {
    const cycleMin = simulation.params.cycle_days[0];
    const cycleMax = Math.max(14, Math.ceil(simulation.params.cycle_days[1]));
    const rates = simulation.params.per_pass_accuracy;
    const rateMin = Math.min(50, Math.floor(Math.min(rates.early, rates.mid, rates.late) * 100));
    const rateMax = Math.max(99, Math.ceil(Math.max(rates.early, rates.mid, rates.late) * 100));
    scope.panel.innerHTML = `<div class="bt-lab"><div class="bt-controls"><p class="bt-kicker">Simulation inputs</p><h3>A season of possible looks</h3><p>Adjust the timing and classification assumptions against this run’s pass dates.</p><label class="bt-slider-label" for="cycle">Drainage cycle <output id="cycle-value"></output></label><input type="range" id="cycle" min="${cycleMin}" max="${cycleMax}" step="1" value="${simulation.params.cycle_days[1]}"><label class="bt-slider-label" for="accuracy">Classification assumption <output id="accuracy-value"></output></label><input type="range" id="accuracy" min="${rateMin}" max="${rateMax}" step="1" value="${Math.round(rates.mid * 100)}"><p class="bt-fine" id="classification-stages">Early / mid / late. Moving the slider applies one rate across stages.</p><button class="bt-action" type="button" id="reset-simulation">Reset published assumptions</button><dl class="bt-facts"><div><dt>Drained fraction of cycle</dt><dd>${simulation.params.drained_fraction_of_cycle.map(percent).join('–')}</dd></div><div><dt>Simulated seasons</dt><dd>${number(simulation.n_sim)}</dd></div><div><dt>Seed</dt><dd>${escape(simulation.seed)}</dd></div></dl>${parameterSources(simulation)}</div><div class="bt-model"><p class="bt-kicker">Model outputs</p><p id="sim-sentence" class="bt-sim-sentence" aria-live="polite"></p><div id="detectability-metrics" class="bt-metrics"></div><div class="bt-charts" id="detectability-charts"></div><div id="detectability-threshold"></div></div></div>${passSchedule(scope.dataset)}`;
    const cycle = scope.panel.querySelector<HTMLInputElement>('#cycle')!;
    const classification = scope.panel.querySelector<HTMLInputElement>('#accuracy')!;
    let uniformClassification = false;
    const run = () => {
      if (!current(scope)) return;
      try {
        const rate = Number(classification.value) / 100;
        const params = {
          ...simulation.params,
          cycle_days: [cycleMin, Number(cycle.value)] as [number, number],
          per_pass_accuracy: uniformClassification ? { early: rate, mid: rate, late: rate } : rates,
        };
        const result = detectability(scope.dataset.apiPasses!, params, simulation.n_sim, simulation.seed);
        scope.panel.querySelector('#cycle-value')!.textContent = `${number(cycleMin)}–${number(Number(cycle.value))} days`;
        scope.panel.querySelector('#accuracy-value')!.textContent = uniformClassification ? percent(rate) : `${percent(rates.early)} / ${percent(rates.mid)} / ${percent(rates.late)}`;
        // Spoken values with units (WCAG 4.1.2).
        cycle.setAttribute('aria-valuetext', `${number(cycleMin)} to ${number(Number(cycle.value))} days`);
        classification.setAttribute('aria-valuetext', uniformClassification ? percent(rate) : `early ${percent(rates.early)}, mid ${percent(rates.mid)}, late ${percent(rates.late)}`);
        scope.panel.querySelector('#classification-stages')!.textContent = uniformClassification ? 'One classification rate across all season stages.' : 'Early / mid / late. Moving the slider applies one rate across stages.';
        scope.panel.querySelector('#sim-sentence')!.textContent = result.sentence;
        scope.panel.querySelector('#detectability-metrics')!.innerHTML = `<div><span>AWD · at least one drained look</span><strong>${percent(result.results.awd.p_ge1)}</strong></div><div><span>Continuous flooding · at least one drained label</span><strong>${percent(result.results.cf.p_ge1_false)}</strong></div><div><span>Separation threshold</span><strong>${result.results.k_star === null ? 'None' : `${result.results.k_star} looks`}</strong></div>`;
        scope.panel.querySelector('#detectability-charts')!.innerHTML = histogram('Alternate wetting and drying', result.results.awd.dist, 'water', result.results.k_star) + histogram('Continuous flooding', result.results.cf.dist, 'mud', result.results.k_star);
        const threshold = result.results.k_star;
        const atThreshold = (distribution: readonly number[]) => distribution.slice(threshold ?? distribution.length).reduce((total, p) => total + p, 0);
        scope.panel.querySelector('#detectability-threshold')!.innerHTML = `<div class="bt-threshold"><span>${threshold === null ? 'No separating threshold' : `At least ${threshold} drained labels`}</span><strong>${percent(atThreshold(result.results.awd.dist))}<small>of AWD seasons</small></strong><strong>${percent(atThreshold(result.results.cf.dist))}<small>of continuously flooded seasons</small></strong></div><p class="bt-fine">The threshold is the smallest count keeping the simulated continuous-flooding false flag at or below ${percent(simulation.params.cf_false_flag_max)}.</p>`;
      } catch (error) {
        failed(scope, 'Simulation could not be run', error);
      }
    };
    cycle.oninput = run;
    classification.oninput = () => { uniformClassification = true; run(); };
    scope.panel.querySelector<HTMLButtonElement>('#reset-simulation')!.onclick = () => {
      cycle.value = String(simulation.params.cycle_days[1]);
      classification.value = String(Math.round(rates.mid * 100));
      uniformClassification = false;
      run();
      announce('Published simulation assumptions restored');
    };
    run();
  }

  function renderInspection(scope: Scope): void {
    scope.panel.innerHTML = `<div class="bt-inspection"><div class="bt-controls"><p class="bt-kicker">Sample program</p><h3>Choose the inspection budget</h3><p id="claims-metadata" class="bt-fine">Loading sample claims…</p><form id="inspection-form" novalidate><label class="bt-slider-label" for="budget">Number of inspections, 1 to 500</label><input id="budget" type="number" min="1" max="500" step="1" value="20" required inputmode="numeric" aria-describedby="audit-message"><button class="bt-action" id="audit" type="submit" disabled>Generate inspection list</button></form><p id="audit-message" class="bt-status" role="status"></p><div id="claims-practices"></div></div><div class="bt-queue"><div id="audit-results">${runCoverage(scope.dataset)}<p class="bt-fine">Generate a list to assign this budget across scored and random checks of the sample claims.</p></div></div></div>`;
    const button = scope.panel.querySelector<HTMLButtonElement>('#audit')!;
    const budget = scope.panel.querySelector<HTMLInputElement>('#budget')!;
    const message = scope.panel.querySelector<HTMLElement>('#audit-message')!;
    const metadata = scope.panel.querySelector<HTMLElement>('#claims-metadata')!;
    const results = scope.panel.querySelector<HTMLElement>('#audit-results')!;
    if (scope.dataset.apiMeta?.assets.claims_sample === null) {
      metadata.textContent = 'No sample claims were published for this run.';
      message.textContent = 'Field summaries are available. Inspection ranking needs a published claims file.';
      button.textContent = 'Sample claims unavailable';
      budget.disabled = true;
      return;
    }
    let claims: Claims | null = null;
    let request = 0;
    let selection = 0;
    const valid = (id: number) => current(scope) && id === request;

    const loadClaims = async () => {
      const id = ++request;
      button.disabled = true;
      message.classList.remove('bt-error');
      message.textContent = 'Loading sample program…';
      try {
        const sample = await client.getClaimsSample();
        if (!valid(id)) return;
        verifyClaims(sample, scope.dataset);
        claims = sample;
        const count = claims.features.length;
        const synthetic = claims.features.filter((claim) => claim.properties.synthetic).length;
        metadata.textContent = `${synthetic === count ? 'Synthetic claims · ' : ''}${number(count)} claims${synthetic > 0 && synthetic !== count ? ` · ${number(synthetic)} synthetic` : ''} · Seed 7`;
        scope.panel.querySelector('#claims-practices')!.innerHTML = `<dl class="bt-facts"><div><dt>Claims for AWD</dt><dd>${number(sample.features.filter((claim) => claim.properties.claimed.includes('awd')).length)}</dd></div><div><dt>Claims for direct seeding</dt><dd>${number(sample.features.filter((claim) => claim.properties.claimed.includes('dsr')).length)}</dd></div></dl>`;
        message.textContent = 'Sample program ready.';
        button.textContent = 'Generate inspection list';
      } catch (error) {
        if (!valid(id)) return;
        metadata.textContent = 'Published sample program';
        message.textContent = errorText(error);
        message.classList.add('bt-error');
        button.textContent = 'Retry sample program';
      } finally {
        if (valid(id)) button.disabled = false;
      }
    };

    budget.addEventListener('input', () => {
      if (budget.getAttribute('aria-invalid') === 'true') budget.removeAttribute('aria-invalid');
    });
    const audit = async () => {
      if (!current(scope) || button.disabled) return;
      if (!claims) { await loadClaims(); return; }
      const count = Number(budget.value);
      if (budget.value.trim() === '' || !Number.isInteger(count) || count < 1 || count > MAX_BUDGET) {
        // The error is tied to the field and names the accepted range (WCAG 3.3.1, 3.3.3).
        message.textContent = `Enter a whole-number budget from 1 to 500${budget.value.trim() ? `; “${budget.value.trim()}” is not one` : ''}.`;
        message.classList.add('bt-error');
        budget.setAttribute('aria-invalid', 'true');
        budget.focus();
        return;
      }
      budget.removeAttribute('aria-invalid');
      const id = ++request;
      // Keep focus in the form while the button is busy: disabling a focused button drops focus.
      const hadFocus = document.activeElement === button;
      button.disabled = true;
      if (hadFocus) budget.focus();
      message.classList.remove('bt-error');
      message.textContent = 'Generating inspection list…';
      results.innerHTML = '<p class="bt-fine">Ranking sample claims…</p>';
      try {
        const response = await client.postAudit({ claims, budget: count, seed: 7 });
        if (!valid(id)) return;
        verifyIdentity(response, scope.dataset, 'Inspection results');
        assert(response.budget === count && response.seed === 7, 'Inspection results do not match the requested budget and seed.');
        verifyRankedFields(response, scope.dataset);
        message.textContent = `${number(response.ranked.length)} ranked · ${number(response.matched)} matched · ${number(response.unmatched)} unmatched`;
        // An ordered list of rows. Each row's spoken name is its visible text with short spoken labels,
        // so the visible label is part of the name (WCAG 1.3.1, 2.5.3).
        results.innerHTML = `<div class="bt-section-heading"><div><p class="bt-kicker">Ranked queue</p><h3>${number(response.ranked.length)} inspections assigned</h3></div><button class="bt-action" id="download-audit" type="button">Download results</button></div><div class="bt-audit-summary"><span><strong>${response.ranked.filter((row) => row.pick === 'score').length}</strong> scored picks</span><span><strong>${response.ranked.filter((row) => row.pick === 'random').length}</strong> random checks</span><span><strong>${response.unmatched}</strong> unmatched claims</span></div><p class="bt-fine bt-audit-meta">${response.synthetic ? 'Synthetic claims · ' : ''}Budget ${escape(response.budget)} · Seed ${escape(response.seed)} · ${escape(response.audit_id)}</p><div class="bt-queue-head" aria-hidden="true"><span>Rank</span><span>Field / claim and reason</span><span>Score</span></div><ol class="bt-queue-list" aria-label="Inspection list, ${escape(response.ranked.length)} claims in rank order">${response.ranked.map((row) => {
          const maxScore = Math.max(1, ...response.ranked.map((pick) => pick.score));
          const content = `<span class="bt-rank"><span class="sr-only">Rank </span>${escape(row.rank)}</span><span class="bt-pick-main"><strong>${escape(row.field_id ?? row.claim_id)}</strong><span>${escape(row.reason)}</span><small><span class="sr-only">Claim </span>${escape(row.claim_id)} · ${escape(row.pick)} · ${escape(row.district ?? 'Unmatched')} · weight ${escape(row.weight)}</small></span><span class="bt-score"><span class="sr-only">Score </span>${escape(row.score)}<i aria-hidden="true" style="width:${row.score / maxScore * 100}%"></i></span>`;
          return `<li>${row.field_id === null ? `<div class="audit-row">${content}</div>` : `<button class="audit-row" type="button" data-audit-field="${escape(row.field_id)}" aria-describedby="audit-row-hint">${content}</button>`}</li>`;
        }).join('')}</ol><p class="sr-only" id="audit-row-hint">Opens this field on the map.</p>${response.ranked.length === 0 ? '<p class="bt-fine">No claims were selected for this budget.</p>' : ''}`;
        results.querySelector<HTMLButtonElement>('#download-audit')!.onclick = () => {
          const link = document.createElement('a');
          const url = URL.createObjectURL(new Blob([JSON.stringify(response, null, 2)], { type: 'application/json' }));
          link.href = url;
          link.download = `${response.run_id}-${response.audit_id}.json`;
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        };
        results.querySelectorAll<HTMLButtonElement>('[data-audit-field]').forEach((row) => {
          row.onclick = async () => {
            if (!valid(id)) return;
            const selected = ++selection;
            const fieldId = row.dataset.auditField!;
            message.classList.remove('bt-error');
            message.textContent = `Opening ${fieldId}…`;
            try {
              await selectField(fieldId);
              if (valid(id) && selected === selection && row.isConnected) message.textContent = `Selected ${fieldId}.`;
            } catch (error) {
              if (!valid(id) || selected !== selection || !row.isConnected) return;
              message.textContent = errorText(error);
              message.classList.add('bt-error');
            }
          };
        });
      } catch (error) {
        if (!valid(id)) return;
        message.textContent = errorText(error);
        message.classList.add('bt-error');
        results.innerHTML = '<p class="bt-fine">The inspection list could not be generated.</p>';
        button.textContent = 'Retry inspection list';
      } finally {
        if (valid(id)) button.disabled = false;
      }
    };
    scope.panel.querySelector<HTMLFormElement>('#inspection-form')!.onsubmit = (event) => { event.preventDefault(); void audit(); };
    void loadClaims();
  }

  async function loadEvidence(scope: Scope): Promise<void> {
    scope.panel.innerHTML = '<p class="bt-status">Loading checks and source artifacts…</p>';
    announce('Loading checks and source artifacts');
    try {
      const [checks, provenance] = await Promise.all([client.getChecks(), client.getProvenance()]);
      if (!current(scope)) return;
      verifyIdentity(checks, scope.dataset, 'Checks');
      verifyIdentity(provenance, scope.dataset, 'Provenance');
      if (checks.district) {
        assert(checks.district.run_id === scope.dataset.run_id, 'District checks belong to a different run.');
        if (checks.district.fixture !== undefined) assert(checks.district.fixture === scope.dataset.fixture, 'District checks have a different source identity.');
      }
      scope.panel.innerHTML = `${checkCharts(checks)}${seasonProfile(scope.dataset)}<section class="bt-field-workbench" aria-label="Field model evidence"><div class="bt-section-heading"><div><p class="bt-kicker">${escape(scope.dataset.apiMeta?.methods.join(', ') ?? '')} · ${escape(scope.dataset.apiMeta?.pol_modes.join(', ') ?? '')}</p><h3>Read the model behind a field</h3></div><form id="bt-model-form"><label for="bt-model-id">Field ID</label><div class="bt-model-search"><input id="bt-model-id" type="text" value="${escape(Object.keys(scope.dataset.fieldRows!)[0])}" required autocapitalize="off" spellcheck="false" aria-describedby="bt-model-status"><button class="bt-action" type="submit">Load field</button></div></form></div><p class="bt-status" id="bt-model-status" role="status"></p><div id="bt-model-reading"></div></section>${evidenceMarkup(checks, provenance)}${assetMarkup(scope.dataset)}${passSchedule(scope.dataset)}`;
      mountModelEvidence(scope);
      announce('Checks and source artifacts loaded');
    } catch (error) {
      failed(scope, 'Evidence could not be loaded', error);
    }
  }

  function mountModelEvidence(scope: Scope): void {
    const input = scope.panel.querySelector<HTMLInputElement>('#bt-model-id')!;
    const status = scope.panel.querySelector<HTMLElement>('#bt-model-status')!;
    const reading = scope.panel.querySelector<HTMLElement>('#bt-model-reading')!;
    let request = 0;
    const load = async () => {
      const id = ++request;
      input.removeAttribute('aria-invalid');
      status.classList.remove('bt-error');
      status.textContent = `Loading ${input.value.trim()}…`;
      try {
        const detail = await getApiFieldDetails(client, scope.dataset, input.value.trim());
        if (!current(scope) || id !== request) return;
        status.textContent = `${detail.observations.length} observations · ${detail.run_id}`;
        const render = (pass = 0, focus = false) => {
          if (!current(scope) || id !== request) return;
          reading.innerHTML = modelFieldMarkup(detail, scope.dataset, pass);
          reading.querySelectorAll<HTMLButtonElement>('[data-model-pass]').forEach((button) => {
            button.onclick = () => render(Number(button.dataset.modelPass), true);
          });
          if (focus) reading.querySelector<HTMLButtonElement>(`[data-model-pass="${pass}"]`)?.focus();
        };
        render();
      } catch (error) {
        if (!current(scope) || id !== request) return;
        reading.replaceChildren();
        status.textContent = errorText(error);
        status.classList.add('bt-error');
        input.setAttribute('aria-invalid', 'true');
      }
    };
    scope.panel.querySelector<HTMLFormElement>('#bt-model-form')!.onsubmit = (event) => { event.preventDefault(); void load(); };
    void load();
  }

  function focusActiveTab(): void {
    root.querySelector<HTMLButtonElement>(`[data-tool="${active}"]`)?.focus();
  }

  /**
   * Re-render the tools. Focus inside the tools would be lost with the old markup, so it returns to the
   * active tab (WCAG 2.4.3); `keepFocus` also restores it when the trigger lived in the old panel.
   */
  function refresh(keepFocus = false): void {
    if (destroyed) return;
    const hadFocus = keepFocus || root.contains(document.activeElement);
    const dataset = getDataset();
    const version = ++generation;
    const fields = Object.values(dataset.tiles).reduce((total, tile) => total + tile.fields.length, 0);
    // ARIA tabs pattern: arrow keys, Home and End move between tabs and activate them; Tab moves into the panel.
    root.innerHTML = `<div class="bt-toolbar"><p class="bt-run">${dataset.kind === 'snapshot' ? 'Archive · ' : dataset.fixture ? 'Sample run · ' : 'Published run · '}${escape(dataset.run_id)} <span>${number(fields)} fields · ${number(dataset.passes.length)} dates · ${number(Object.keys(dataset.tiles).length)} tiles${dataset.apiMeta ? ` · ${number(dataset.apiMeta.counts.observations)} observations` : ''}</span></p><div class="bt-tabs" role="tablist" aria-label="Analysis tools">${TOOLS.map((tool) => `<button type="button" role="tab" id="backend-tab-${tool.id}" aria-controls="backend-tool-content" aria-selected="${active === tool.id}" tabindex="${active === tool.id ? '0' : '-1'}" data-tool="${tool.id}">${tool.title}</button>`).join('')}</div></div><div id="backend-tool-content" role="tabpanel" tabindex="0" aria-labelledby="backend-tab-${active}"></div>`;
    const panel = root.querySelector<HTMLElement>('#backend-tool-content')!;
    const scope: Scope = { generation: version, dataset, panel };
    const tabs = [...root.querySelectorAll<HTMLButtonElement>('[data-tool]')];
    tabs.forEach((button, index) => {
      button.onclick = () => {
        if (!current(scope)) return;
        if (active === button.dataset.tool) return;
        active = button.dataset.tool as Tool;
        refresh(true);
      };
      button.onkeydown = (event) => {
        if (!current(scope)) return;
        let next: number;
        if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
        else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = tabs.length - 1;
        else return;
        event.preventDefault();
        active = tabs[next].dataset.tool as Tool;
        refresh(true);
      };
    });
    if (hadFocus) focusActiveTab();
    if (dataset.kind === 'snapshot') snapshot(scope);
    else if (active === 'detectability') void loadDetectability(scope);
    else if (active === 'inspection') renderInspection(scope);
    else void loadEvidence(scope);
  }

  refresh();
  return { refresh: () => refresh(), destroy: () => { destroyed = true; generation++; root.replaceChildren(); live.remove(); } };
}

function parameterSources(simulation: Detectability): string {
  const rows = Object.entries(simulation.param_sources).flatMap(([key, source]) => {
    return source ? [`<div class="bt-parameter-source"><h4>${escape(key.replaceAll('_', ' '))}</h4><p>${source.url ? safeLink(source.url, source.citation) : escape(source.citation)}</p><p>${escape(source.note)}</p></div>`] : [];
  });
  return rows.length ? `<details class="bt-disclosure"><summary>Parameter sources</summary>${rows.join('')}</details>` : '';
}

function histogram(title: string, values: readonly number[], color: 'water' | 'mud', threshold: number | null): string {
  assert(values.length > 0 && values.every((value) => Number.isFinite(value) && value >= 0 && value <= 1), 'Simulation probabilities must be between zero and one.');
  return `<div class="bt-chart bt-chart-${color}"><h4>${title}</h4><div class="bt-histogram" role="img" aria-label="${escape(title)}: ${escape(values.map((value, index) => `${index} drained labels ${percent(value)}`).join('; '))}"><div class="bt-axis"><span>100%</span><span>50%</span><span>0%</span></div><div class="bt-bars">${values.map((value, index) => `<div class="bt-bar-col${threshold !== null && index >= threshold ? ' bt-over-threshold' : ''}" title="${index} drained labels: ${percent(value)}"><div class="bt-bar-track"><div class="bt-bar" style="height:${value * 100}%"><span>${percent(value)}</span></div></div><span class="bt-bin">${index}</span></div>`).join('')}</div></div><p class="bt-chart-label">Number of drained labels · probability per simulated season</p></div>`;
}

function verifyRankedFields(response: AuditResponse, dataset: DemoDataset): void {
  assert(Array.isArray(response.ranked), 'Inspection results are missing the ranked queue.');
  for (const row of response.ranked) {
    assert(Number.isInteger(row.rank) && row.rank > 0 && Number.isFinite(row.score) && typeof row.reason === 'string', 'Inspection results contain an invalid rank, score or reason.');
    assert(row.field_id === null || Object.hasOwn(dataset.fieldRows ?? {}, row.field_id), `Inspection field ${row.field_id} is absent from the selected run.`);
  }
}

function assetMarkup(dataset: DemoDataset): string {
  const assets = dataset.apiMeta!.assets;
  const sources = [
    ['Field polygons', assets.fields_geojson], ['Vector tiles', assets.fields_pmtiles],
    ['Imagery index', assets.overlays_index], ['Sample claims', assets.claims_sample],
    ['Early histogram', assets.hist.early], ['Mid-season histogram', assets.hist.mid], ['Late histogram', assets.hist.late],
  ];
  return `<details class="bt-disclosure"><summary>Published source assets</summary><dl class="bt-facts bt-provenance-facts">${sources.map(([name, path]) => `<div><dt>${name}</dt><dd>${path === null ? 'Not published' : escape(path)}</dd></div>`).join('')}</dl></details>`;
}

function evidenceMarkup(checks: ApiChecks, provenance: Provenance): string {
  const district = checks.district;
  return `<div class="bt-evidence-block"><p class="bt-kicker">District context${district ? ` · ${escape(district.year)}` : ''}</p>${district ? `<div class="bt-table-wrap" tabindex="0" role="region" aria-label="District context"><table><thead><tr><th scope="col">District</th><th scope="col">Government DSR acres</th><th scope="col">Farmers</th><th scope="col">Tile rice ha</th><th scope="col">Tile DSR signal ha</th><th scope="col">Tile DSR signal share</th></tr></thead><tbody>${district.rows.map((row) => `<tr><th scope="row">${escape(row.district)}</th><td>${displayNumber(row.gov_dsr_acres)}</td><td>${displayNumber(row.gov_farmers)}</td><td>${displayNumber(row.tile_rice_ha)}</td><td>${displayNumber(row.tile_dsr_signal_ha)}</td><td>${row.tile_dsr_signal_frac === null ? '—' : percent(row.tile_dsr_signal_frac)}</td></tr>`).join('')}</tbody></table></div><p class="bt-fine">${escape(district.note)}</p><p class="bt-fine">${district.source_urls.map((url, index) => safeLink(url, `District source ${index + 1}`)).join(' · ')}</p>` : '<p>No district comparison in this run.</p>'}</div><div class="bt-evidence-block"><p class="bt-kicker">Provenance</p><h3>Trace the inputs</h3><dl class="bt-facts bt-provenance-facts"><div><dt>Created</dt><dd>${escape(provenance.created_at)}</dd></div><div><dt>Revision</dt><dd>${escape(provenance.git_sha)}</dd></div><div><dt>Decomposition reference</dt><dd>${escape(provenance.decomposition_check.reference)}</dd></div><div><dt>Maximum difference</dt><dd>${provenance.decomposition_check.max_abs_diff_db === null ? '—' : `${number(provenance.decomposition_check.max_abs_diff_db)} dB`}</dd></div></dl><details class="bt-disclosure"><summary>Source granules (${number(provenance.granules.length)})</summary>${provenance.granules.map((granule) => `<div class="bt-hash"><strong>${escape(granule.granule_id)}</strong><span>CRID ${escape(granule.crid)}</span><code>${granule.subset_sha256 === null ? 'No subset hash' : escape(granule.subset_sha256)}</code></div>`).join('')}</details><details class="bt-disclosure"><summary>Artifact hashes (${number(provenance.artifacts.length)})</summary>${provenance.artifacts.map((artifact) => `<div class="bt-hash"><strong>${escape(artifact.path)}</strong><code>${escape(artifact.sha256)}</code></div>`).join('')}</details></div>`;
}
