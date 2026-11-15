export type ScrollFrame = {
  width: number;
  height: number;
  navHeight: number;
  fontSize: number;
  reducedMotion: boolean;
  settingsVersion: number;
};
type Client<T> = { measure: (frame: ScrollFrame) => T | undefined; render: (state: T, frame: ScrollFrame) => void };
const clients = new Set<Client<unknown>>();
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
let pending = 0;
let settingsDirty = true;
let settingsVersion = 0;
let environment: ScrollFrame;

/** All geometry reads finish before any scene changes styles or SVG attributes. */
function run() {
  pending = 0;
  if (document.hidden) return;
  if (settingsDirty) {
    settingsDirty = false;
    environment = {
      width: innerWidth,
      height: innerHeight,
      navHeight: document.querySelector('nav[aria-label="Main"]')?.getBoundingClientRect().height ?? 73,
      fontSize: parseFloat(getComputedStyle(document.documentElement).fontSize),
      reducedMotion: reduced.matches,
      settingsVersion: ++settingsVersion,
    };
  }
  const measured: { client: Client<unknown>; state: unknown }[] = [];
  for (const client of clients) {
    const state = client.measure(environment);
    if (state !== undefined) measured.push({ client, state });
  }
  for (const { client, state } of measured) if (clients.has(client)) client.render(state, environment);
}
export function requestScrollFrame() {
  if (!pending && !document.hidden) pending = requestAnimationFrame(run);
}
export function invalidateScrollFrame() {
  settingsDirty = true;
  requestScrollFrame();
}
export function registerScrollClient<T>(client: Client<T>): () => void {
  const entry = client as Client<unknown>;
  clients.add(entry);
  requestScrollFrame();
  return () => clients.delete(entry);
}
addEventListener('scroll', requestScrollFrame, { passive: true });
addEventListener('resize', invalidateScrollFrame, { passive: true });
addEventListener('pageshow', invalidateScrollFrame);
document.fonts.ready.then(invalidateScrollFrame);
reduced.addEventListener('change', invalidateScrollFrame);
new MutationObserver(invalidateScrollFrame).observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { if (pending) cancelAnimationFrame(pending); pending = 0; }
  else invalidateScrollFrame();
});
