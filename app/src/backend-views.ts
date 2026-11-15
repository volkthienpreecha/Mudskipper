import type { ApiChecks, FieldDetail } from '@mudskipper/core/contracts';
import type { DemoDataset, DemoField } from './data';

export const esc = (value: unknown): string => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const num = (value: number): string => (value === 0 ? 0 : value).toLocaleString('en-US', { maximumFractionDigits: 2 });
const pct = (value: number): string => `${num(value * 100)}%`;
const value = (v: number | null | undefined, suffix = ''): string => v == null ? '—' : `${num(v)}${suffix}`;
const exact = (v: number | null | undefined): string => v == null ? '—' : String(v);
export const shortDate = (date: string): string => new Date(`${date.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const stateName: Record<string, string> = { f: 'Flooded', d: 'Drained', u: 'Uncertain', '-': 'No observation' };
const dsrName: Record<string, string> = { dsr_signal: 'Direct-seeding signal', transplant_signal: 'Transplanting signal', unknown: 'No early-season signal' };
const verdictName: Record<string, string> = { consistent: 'Consistent with AWD', inconsistent: 'Not consistent with AWD', not_enough_evidence: 'Needs more evidence' };

/** Actual field-state counts per acquisition, usable for both the archive and published run. */
export function seasonProfile(dataset: DemoDataset): string {
  const fields = Object.values(dataset.tiles).flatMap((tile) => tile.fields);
  return `<div class="bt-season-profile"><div class="bt-section-heading"><div><p class="bt-kicker">Mapped season</p><h3>Water across the mapped fields</h3></div><p class="bt-fine">${num(fields.length)} fields · ${num(dataset.passes.length)} acquisitions</p></div><div class="bt-state-legend"><span class="is-f">Flooded</span><span class="is-d">Drained</span><span class="is-u">Uncertain</span><span class="is-n">No observation</span></div><div class="bt-season-columns" role="img" aria-label="Field states by acquisition. ${dataset.passes.map((date, index) => {
    const counts = ['f', 'd', 'u', '-'].map((state) => fields.filter((field) => field.s[index] === state).length);
    return `${shortDate(date)}: ${counts.map((count, i) => `${num(count)} ${stateName[['f', 'd', 'u', '-'][i]]}`).join(', ')}`;
  }).join('; ')}">${dataset.passes.map((date, index) => `<div class="bt-season-col"><div class="bt-season-stack">${['f', 'd', 'u', '-'].map((state) => {
    const count = fields.filter((field) => field.s[index] === state).length;
    return `<span class="is-${state === '-' ? 'n' : state}" style="height:${count / fields.length * 100}%" title="${esc(stateName[state])}: ${num(count)} fields"></span>`;
  }).join('')}</div><span>${esc(shortDate(date))}</span></div>`).join('')}</div></div>`;
}

/** Candidate schedule retains excluded passes and their reasons. Dates are never synthesized. */
export function passSchedule(dataset: DemoDataset): string {
  const passes = dataset.apiPasses;
  if (!passes) return '';
  const used = passes.filter((pass) => pass.used).length;
  return `<details class="bt-disclosure bt-pass-schedule"><summary>Acquisition schedule · ${used} used of ${passes.length} candidates</summary><ol class="bt-acquisitions">${[...passes].sort((a, b) => Date.parse(a.datetime) - Date.parse(b.datetime)).map((pass) => `<li class="${pass.used ? 'is-used' : 'is-excluded'}"><time datetime="${esc(pass.datetime)}">${esc(shortDate(pass.datetime))}</time><span><strong>${pass.used ? 'Used' : esc(pass.excluded_reason?.replaceAll('_', ' ') ?? 'Excluded')}</strong><small>${esc(pass.pass_id)} · ${esc(pass.pol_mode)} · ${pass.pixel_m} m · ${esc(pass.maturity)}</small></span><span>${Object.entries(pass.valid_fraction_by_tile).map(([tile, fraction]) => `${esc(tile)} ${fraction === undefined ? '—' : pct(fraction)}`).join('<br>')}</span></li>`).join('')}</ol></details>`;
}

export function runCoverage(dataset: DemoDataset): string {
  const rows = Object.values(dataset.fieldRows ?? {});
  const total = rows.length;
  if (!total) return '';
  const groups = [
    { key: 'consistent', label: 'Consistent with AWD', color: 'water' },
    { key: 'inconsistent', label: 'Not consistent with AWD', color: 'mud' },
    { key: 'not_enough_evidence', label: 'Needs more evidence', color: 'neutral' },
  ];
  return `<div class="bt-run-coverage"><p class="bt-kicker">Published field summaries</p><h3>AWD assessment by field</h3>${groups.map((group) => {
    const count = rows.filter((row) => row.awd_verdict === group.key).length;
    return `<div class="bt-coverage-row"><span>${group.label}</span><strong>${num(count)}</strong><div class="bt-coverage-track"><span class="bt-fill-${group.color}" style="width:${count / total * 100}%"></span></div></div>`;
  }).join('')}<p class="bt-fine">${num(rows.filter((row) => row.dsr_signal === 'dsr_signal').length)} fields show an early-season direct-seeding signal.</p></div>`;
}

export function checkCharts(checks: ApiChecks): string {
  const season = checks.season_shape;
  const opera = checks.opera;
  return `<div class="bt-evidence-grid"><div class="bt-evidence-block"><p class="bt-kicker">Season shape · ${season.pass ? 'passed' : 'review needed'}</p><h3>Early water to season peak</h3><div class="bt-stage-bars" role="img" aria-label="Flooded field share: ${Object.entries(season.pct_flooded_by_stage).map(([stage, share]) => `${stage} ${value(share, '%')}`).join('; ')}">${Object.entries(season.pct_flooded_by_stage).map(([stage, share]) => `<div><strong>${value(share, '%')}</strong><div class="bt-stage-track"><span style="height:${share ?? 0}%"></span></div><span>${esc(stage)}</span></div>`).join('')}</div><p class="bt-fine">${esc(season.rule)}</p></div><div class="bt-evidence-block"><p class="bt-kicker">Independent water comparison</p><h3>${opera ? 'NISAR beside OPERA' : 'OPERA comparison'}</h3>${opera ? `<p class="bt-fine">${esc(opera.product)} · ${opera.n_dates} NISAR dates</p><div class="bt-comparison-key"><span>NISAR flooded share</span><span>OPERA water share</span></div><div class="bt-comparison">${opera.pairs.map((pair) => `<div class="bt-comparison-row"><span>${esc(shortDate(pair.date))}<small>${esc(pair.tile)} · OPERA ${esc(shortDate(pair.opera_date))}</small></span><div class="bt-comparison-bars"><span><em><i style="width:${pair.ours_flooded_frac * 100}%"></i></em><b>${pct(pair.ours_flooded_frac)}</b></span><span><em><i style="width:${pair.opera_water_frac * 100}%"></i></em><b>${pct(pair.opera_water_frac)}</b></span></div></div>`).join('')}</div><details class="bt-disclosure"><summary>How to read this comparison</summary><p>${esc(opera.note)}</p></details>` : '<p>No OPERA pairs were published for this run.</p>'}</div></div>`;
}

function lineChart(series: { name: string; values: (number | null | undefined)[]; color: string }[], dates: string[], label: string): string {
  const all = series.flatMap((row) => row.values).filter((v): v is number => v != null && Number.isFinite(v));
  if (!all.length) return '<p class="bt-fine">No radar measurements in this selection.</p>';
  const low = Math.floor(Math.min(...all) / 5) * 5;
  const high = Math.max(low + 5, Math.ceil(Math.max(...all) / 5) * 5);
  const x = (index: number) => 45 + index / Math.max(1, dates.length - 1) * 605;
  const y = (v: number) => 155 - (v - low) / (high - low) * 130;
  const description = series.map((row) => `${row.name}: ${row.values.map((v, index) => `${shortDate(dates[index])} ${value(v, ' dB')}`).join('; ')}`).join('. ');
  return `<div class="bt-signal-chart"><svg viewBox="0 0 675 185" role="img" aria-label="${esc(`${label}. ${description}`)}">${[low, (low + high) / 2, high].map((v) => `<line x1="45" x2="650" y1="${y(v)}" y2="${y(v)}" class="bt-chart-grid"/><text x="35" y="${y(v) + 4}" text-anchor="end">${num(v)}</text>`).join('')}${series.map((row) => {
    let path = '';
    let connected = false;
    row.values.forEach((v, index) => { if (v == null) { connected = false; return; } path += `${connected ? 'L' : 'M'}${x(index)},${y(v)} `; connected = true; });
    return `<path class="bt-signal-trace" pathLength="1" d="${path}" stroke="${row.color}" fill="none" stroke-width="2"/>${row.values.map((v, index) => v == null ? '' : `<circle cx="${x(index)}" cy="${y(v)}" r="3" fill="${row.color}"/>`).join('')}`;
  }).join('')}${dates.map((date, index) => `<text x="${x(index)}" y="178" text-anchor="middle">${esc(shortDate(date))}</text>`).join('')}</svg><p class="bt-signal-legend">${series.map((row) => `<span><i style="background:${row.color}"></i>${esc(row.name)}</span>`).join('')}<span>dB</span></p></div>`;
}

export function archivedFieldMarkup(field: DemoField, dataset: DemoDataset): string {
  return `<div class="bt-field-heading"><h3>${esc(field.id)}</h3><p>${num(field.ha)} ha · ${field.rice === null ? 'Rice cover unavailable' : `${pct(field.rice)} rice cover`}</p></div><div class="bt-archive-states" role="img" aria-label="${esc(dataset.passes.map((date, index) => `${shortDate(date)}: ${stateName[field.s[index]]}, confidence ${value(field.c[index])}`).join('; '))}">${dataset.passes.map((date, index) => `<div><span>${esc(shortDate(date))}</span><strong class="is-${field.s[index] === '-' ? 'n' : field.s[index]}">${esc(stateName[field.s[index]])}</strong><small>${value(field.c[index])} confidence</small></div>`).join('')}</div>${lineChart([{ name: 'HH', values: field.hh, color: '#101d42' }], dataset.passes, 'Archived HH backscatter')}<p class="bt-fine">Confidence is |2 × flooded probability − 1|, rounded in this archive. Flooded probabilities are available in the published run.</p>`;
}

export function modelFieldMarkup(detail: FieldDetail, dataset: DemoDataset, selected = 0): string {
  const observations = dataset.passIds.map((id) => detail.observations.find((observation) => observation.pass_id === id));
  const o = observations[selected];
  const awd = detail.summary?.awd;
  const dsr = detail.summary?.dsr;
  const componentNames = [['ps_db', 'Surface'], ['pd_db', 'Double bounce'], ['pv_db', 'Volume']] as const;
  const components = componentNames.filter(([key]) => observations.some((row) => row?.observed[key] != null));
  return `<div class="bt-field-heading"><h3>${esc(detail.field.properties.field_id)}</h3><p>${esc(detail.field.properties.district)} · ${num(detail.field.properties.area_ha)} ha · ${pct(detail.field.properties.rice_mask_frac)} rice cover</p></div><div class="bt-probability-heading"><span>Flooded probability by acquisition</span><span>0–100%</span></div><div class="bt-probability-passes">${observations.map((row, index) => `<button type="button" data-model-pass="${index}" aria-pressed="${selected === index}" title="${esc(row?.inferred.state ?? 'No observation')}; flooded probability"><span>${esc(shortDate(dataset.passes[index]))}</span><span class="bt-probability-track"><i style="height:${(row?.inferred.p_flooded ?? 0) * 100}%"></i></span><strong>${row?.inferred.p_flooded == null ? '—' : pct(row.inferred.p_flooded)}</strong></button>`).join('')}</div><div class="bt-observation"><div class="bt-observation-title"><p class="bt-kicker">${esc(shortDate(dataset.passes[selected]))} · ${esc(o?.stage ?? 'no observation')}</p><h4>${esc(o?.inferred.state ?? 'No observation')}</h4><p>${esc(o?.inferred.method ?? '')}</p></div><dl class="bt-observation-values"><div><dt>Confidence</dt><dd>${value(o?.inferred.confidence)}</dd></div><div><dt>Valid pixels</dt><dd>${o ? `${pct(o.valid_frac)} of ${num(o.n_px)}` : '—'}</dd></div><div><dt>HH − HV</dt><dd>${value(o?.observed.hh_hv_db, ' dB')}</dd></div>${components.map(([key, name]) => `<div><dt>${name}</dt><dd>${value(o?.observed[key], ' dB')}</dd></div>`).join('')}</dl></div><p class="bt-fine bt-flags">${o?.flags.length ? `Processing flags: ${esc(o.flags.join(', '))}` : 'No processing flags on this observation.'}</p>${lineChart([{ name: 'HH', values: observations.map((row) => row?.observed.hh_db), color: '#101d42' }, { name: 'HV', values: observations.map((row) => row?.observed.hv_db), color: '#5145d7' }, ...components.map(([key, name], index) => ({ name, values: observations.map((row) => row?.observed[key]), color: ['#cf4628', '#995000', '#4c5f7a'][index] }))], dataset.passes, 'Radar backscatter and decomposition')}<div class="bt-decisions"><div><p class="bt-kicker">Alternate wetting and drying</p><h4>${esc(awd ? verdictName[awd.verdict] : 'No summary')}</h4><p>${esc(awd?.reason ?? '')}</p>${awd ? `<dl class="bt-facts"><div><dt>Drained / clear looks</dt><dd>${awd.drained_hits} / ${awd.clear_looks}</dd></div><div><dt>Separation threshold</dt><dd>${awd.k_star === null ? 'None' : `${awd.k_star} drained looks`}</dd></div><div><dt>Chance of a drained look if AWD</dt><dd>${pct(awd.p_catch_ge1_if_awd)}</dd></div><div><dt>${esc(awd.window.source)} AWD window</dt><dd>${esc(shortDate(awd.window.start))}–${esc(shortDate(awd.window.end))}</dd></div></dl>` : ''}</div><div><p class="bt-kicker">Direct seeding</p><h4>${esc(dsr ? dsrName[dsr.signal] : 'No summary')}</h4><p>${esc(dsr?.reason ?? '')}</p><p class="bt-fine">Classifier confidence = |2 × flooded probability − 1|. Clear labels require at least 60% valid pixels; probabilities between 35% and 65% remain uncertain.</p></div></div><details class="bt-disclosure"><summary>All observation values</summary><div class="bt-table-wrap" tabindex="0" role="region" aria-label="All field observation values"><table><thead><tr>${['Acquisition UTC', 'Pass ID', 'Stage', 'State', 'Flooded probability', 'Confidence', 'HH dB', 'HV dB', 'HH − HV dB', 'VV dB', 'Surface dB', 'Double bounce dB', 'Volume dB', 'Valid share', 'Pixels', 'Method', 'Flags'].map((title) => `<th scope="col">${title}</th>`).join('')}</tr></thead><tbody>${observations.map((row, index) => `<tr><th scope="row">${esc(row?.datetime ?? dataset.passes[index])}</th>${row ? `<td>${esc(row.pass_id)}</td><td>${esc(row.stage)}</td><td>${esc(row.inferred.state)}</td><td>${exact(row.inferred.p_flooded)}</td><td>${exact(row.inferred.confidence)}</td><td>${exact(row.observed.hh_db)}</td><td>${exact(row.observed.hv_db)}</td><td>${exact(row.observed.hh_hv_db)}</td><td>${exact(row.observed.vv_db)}</td><td>${exact(row.observed.ps_db)}</td><td>${exact(row.observed.pd_db)}</td><td>${exact(row.observed.pv_db)}</td><td>${pct(row.valid_frac)}</td><td>${row.n_px}</td><td>${esc(row.inferred.method)}</td><td>${esc(row.flags.join(', '))}</td>` : '<td colspan="16">No observation</td>'}</tr>`).join('')}</tbody></table></div></details>`;
}
