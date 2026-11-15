import { bindScrollSequence } from './scroll-sequences';

const clamp = (n: number) => Math.max(0, Math.min(1, n));
const brand = document.querySelector<HTMLElement>('#brandInterlude');
if (brand) bindScrollSequence(brand, { onProgress(progress) {
  const moving = brand.classList.contains('is-scroll-pinned');
  const enter = clamp(progress / .5);
  const exit = clamp((progress - .68) / .32);
  brand.style.setProperty('--brand-y', `${moving ? 18 * (1 - enter) - exit * 8 : 0}vh`);
  brand.style.setProperty('--brand-scale', String(moving ? .88 + enter * .12 + exit * .28 : 1));
  brand.style.setProperty('--brand-opacity', String(moving ? 1 - exit * .45 : 1));
  brand.style.setProperty('--brand-sky-scale', String(moving ? 1.08 + progress * .12 : 1.08));
}});

const season = document.querySelector<HTMLElement>('#season');
if (season) bindScrollSequence(season, { fitTarget:'#seasonTable', onProgress(progress) {
  const moving = season.classList.contains('is-scroll-pinned');
  season.style.setProperty('--season-crop', `${moving ? (1 - clamp((progress - .18) / .68)) * 100 : 0}%`);
  season.querySelectorAll<HTMLElement>('.stat').forEach((stat, index) => {
    const shown = moving ? clamp((progress - index * .07) / .18) : 1;
    stat.style.setProperty('--stat-y', `${(1 - shown) * 28}px`);
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
