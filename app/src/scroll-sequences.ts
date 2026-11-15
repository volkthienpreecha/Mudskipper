export type ScrollSequenceOptions = {
  stageSelector?: string;
  onProgress?: (progress: number, index: number) => void;
  fitTarget?: string;
};

/** A bounded sticky scene follows native scrolling. No wheel or keyboard interception. */
export function bindScrollSequence(host: HTMLElement, options: ScrollSequenceOptions = {}): () => void {
  const stages = [...host.querySelectorAll<HTMLElement>(options.stageSelector ?? '[data-scroll-stage]')];
  const media = matchMedia('(min-width:1000px) and (min-height:780px) and (prefers-reduced-motion:no-preference)');
  let frame = 0;
  let alive = true;
  let last = -1;
  let progress = 0;
  let pinned = false;
  let fitBlocked = false;
  const clamp = (n: number) => Math.max(0, Math.min(1, n));
  const schedule = () => { if (alive && !frame && !document.hidden) frame = requestAnimationFrame(render); };
  function render() {
    frame = 0;
    if (!alive || !host.isConnected || document.hidden) return;
    const wasPinned = pinned;
    pinned = !fitBlocked && media.matches && parseFloat(getComputedStyle(document.documentElement).fontSize) <= 24 &&
      !document.documentElement.classList.contains('motion-paused') && !host.querySelector('details[open]');
    host.classList.toggle('is-scroll-pinned', pinned);
    const nav = document.querySelector('nav[aria-label="Main"]')?.getBoundingClientRect().height ?? 73;
    const rect = host.getBoundingClientRect();
    if (pinned && options.fitTarget && rect.top <= nav + 1 && rect.bottom > innerHeight) {
      const target = host.querySelector<HTMLElement>(options.fitTarget);
      if (target && target.getBoundingClientRect().bottom > innerHeight - 12) {
        fitBlocked = true; pinned = false; host.classList.remove('is-scroll-pinned');
      }
    }
    progress = pinned ? clamp((nav - rect.top) / Math.max(1, rect.height - (innerHeight - nav))) : 1;
    const index = Math.min(Math.max(0, stages.length - 1), Math.floor(progress * stages.length));
    host.style.setProperty('--sequence-progress', progress.toFixed(5));
    host.dataset.scrollIndex = String(index);
    if (last !== index || wasPinned !== pinned || !pinned) {
      stages.forEach((stage, i) => {
        const hidden = pinned && i !== index;
        if (hidden && stage.contains(document.activeElement)) host.focus({ preventScroll: true });
        stage.inert = hidden;
        stage.setAttribute('aria-hidden', String(hidden));
        stage.classList.toggle('is-scroll-active', !hidden);
      });
      last = index;
    }
    options.onProgress?.(progress, index);
  }
  addEventListener('scroll', schedule, { passive: true });
  const refresh = () => { fitBlocked = false; schedule(); };
  addEventListener('resize', refresh, { passive: true });
  document.addEventListener('visibilitychange', schedule);
  media.addEventListener('change', schedule);
  host.addEventListener('toggle', schedule, true);
  const rootChanges = new MutationObserver(refresh);
  rootChanges.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
  const resize = new ResizeObserver(schedule);
  resize.observe(host);
  if (!host.hasAttribute('tabindex')) host.tabIndex = -1;
  schedule();
  return () => {
    alive = false;
    if (frame) cancelAnimationFrame(frame);
    removeEventListener('scroll', schedule);
    removeEventListener('resize', refresh);
    document.removeEventListener('visibilitychange', schedule);
    media.removeEventListener('change', schedule);
    host.removeEventListener('toggle', schedule, true);
    rootChanges.disconnect(); resize.disconnect();
  };
}
