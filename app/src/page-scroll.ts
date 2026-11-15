import { bindScrollSequence } from './scroll-sequences';

const clamp = (n: number) => Math.max(0, Math.min(1, n));
const brand = document.querySelector<HTMLElement>('#brandInterlude');
if (brand) bindScrollSequence(brand, { onProgress(progress) {
  const moving = brand.classList.contains('is-scroll-pinned');
  const t = clamp(progress / .46);
  const expand = t * t * (3 - 2 * t);
  const exit = moving ? clamp((progress - .73) / .27) : 0;
  brand.style.setProperty('--brand-inset-x', `${moving ? (1 - expand) * 22 : 4}%`);
  brand.style.setProperty('--brand-inset-top', `${moving ? (1 - expand) * 28 : 6}%`);
  brand.style.setProperty('--brand-inset-bottom', `${moving ? (1 - expand) * 12 : 6}%`);
  brand.style.setProperty('--brand-radius', `${moving ? (1 - expand) * 40 : 24}px`);
  brand.style.setProperty('--brand-y', `${moving ? 8 * (1 - expand) - exit * 10 : 0}vh`);
  brand.style.setProperty('--brand-scale', String(moving ? .6 + expand * .4 + exit * .12 : 1));
  brand.style.setProperty('--brand-opacity', String(1 - exit));
  brand.style.setProperty('--brand-handoff', String(exit));
  brand.style.setProperty('--brand-sky-scale', String(moving ? 1.06 + progress * .12 : 1.06));
}});

const season = document.querySelector<HTMLElement>('#season');
const seasonStats = season ? [...season.querySelectorAll<HTMLElement>('.stat')] : [];
if (season) bindScrollSequence(season, { fitTarget:'#seasonTable', onProgress(progress) {
  const moving = season.classList.contains('is-scroll-pinned');
  season.style.setProperty('--season-crop', `${moving ? (1 - (.4 + .6 * clamp(progress / .86))) * 100 : 0}%`);
  seasonStats.forEach((stat, index) => {
    const shown = moving ? clamp((progress - index * .07) / .18) : 1;
    stat.style.setProperty('--stat-y', `${-(1 - shown) * 12}px`);
  });
}});

// Introductory surfaces rise into place; their text and controls stay available.
const arrival = new IntersectionObserver(entries => {
  for (const entry of entries) if (entry.isIntersecting) {
    entry.target.classList.add('is-arrived');
    arrival.unobserve(entry.target);
  }
}, { threshold: .05 });
document.querySelectorAll('#map h2,#analysis h2,#api h2,.mapapp,#backendTools,#apiDemo').forEach(element => {
  element.classList.add('scroll-arrive'); arrival.observe(element);
});
