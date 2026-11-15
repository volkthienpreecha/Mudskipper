import { registerScrollClient, requestScrollFrame, type ScrollFrame } from './scroll-frame';

export type ScrollSequenceOptions = {
  stageSelector?: string;
  onProgress?: (progress: number, index: number) => void;
  fitTarget?: string;
};

/** Native scroll advances a bounded scene; only visible or changed scenes are painted. */
export function bindScrollSequence(host: HTMLElement, options: ScrollSequenceOptions = {}): () => void {
  const stages = [...host.querySelectorAll<HTMLElement>(options.stageSelector ?? '[data-scroll-stage]')];
  const fitTarget = options.fitTarget ? host.querySelector<HTMLElement>(options.fitTarget) : null;
  let alive = true;
  let last = -1;
  let lastProgress = -1;
  let lastPinned = host.classList.contains('is-scroll-pinned');
  let lastSettings = -1;
  let dirty = true;
  let fitBlocked = false;
  const clamp = (n: number) => Math.max(0, Math.min(1, n));
  type State = { pinned: boolean; modeChanged: boolean; progress: number; index: number; settings: number };
  const dispose = registerScrollClient<State>({
    measure(frame: ScrollFrame) {
      if (!alive || !host.isConnected) return;
      if (lastSettings !== frame.settingsVersion) { dirty = true; fitBlocked = false; }
      const pinned = !fitBlocked && frame.width >= 1000 && frame.height >= 780 && !frame.reducedMotion && frame.fontSize <= 24 && !host.querySelector('details[open]');
      const actualPinned = host.classList.contains('is-scroll-pinned');
      const rect = host.getBoundingClientRect();
      if (pinned !== actualPinned) return { pinned, modeChanged: true, progress: pinned ? clamp(lastProgress) : 1, index: last, settings: frame.settingsVersion };
      if (pinned && fitTarget && rect.top <= frame.navHeight + 1 && rect.bottom > frame.height && fitTarget.getBoundingClientRect().bottom > frame.height - 12) {
        fitBlocked = true;
        return { pinned: false, modeChanged: true, progress: 1, index: last, settings: frame.settingsVersion };
      }
      const progress = pinned ? clamp((frame.navHeight - rect.top) / Math.max(1, rect.height - (frame.height - frame.navHeight))) : 1;
      const index = Math.min(Math.max(0, stages.length - 1), Math.floor(progress * stages.length));
      if (!dirty && progress === lastProgress && pinned === lastPinned && index === last) return;
      return { pinned, modeChanged: false, progress, index, settings: frame.settingsVersion };
    },
    render(state) {
      host.classList.toggle('is-scroll-pinned', state.pinned);
      lastSettings = state.settings;
      if (state.modeChanged) {
        dirty = true;
        requestScrollFrame(); // Measure the new layout on the next frame, not after this write.
        return;
      }
      const modeChanged = state.pinned !== lastPinned;
      host.style.setProperty('--sequence-progress', state.progress.toFixed(5));
      host.dataset.scrollIndex = String(state.index);
      stages.forEach((stage, index) => {
        const enter = index === 0 ? 1 : clamp((state.progress - index / stages.length + .065) / .13);
        const leave = index === stages.length - 1 ? 1 : clamp(((index + 1) / stages.length + .065 - state.progress) / .13);
        const opacity = state.pinned ? Math.min(enter, leave) : 1;
        stage.style.setProperty('--stage-opacity', opacity.toFixed(5));
        stage.style.setProperty('--stage-y', `${(1 - opacity) * 24}px`);
      });
      if (last !== state.index || modeChanged || dirty) stages.forEach((stage, i) => {
        const hidden = state.pinned && i !== state.index;
        if (hidden && stage.contains(document.activeElement)) host.focus({ preventScroll: true });
        stage.inert = hidden;
        stage.setAttribute('aria-hidden', String(hidden));
        stage.classList.toggle('is-scroll-active', !hidden);
      });
      last = state.index; lastProgress = state.progress; lastPinned = state.pinned; dirty = false;
      options.onProgress?.(state.progress, state.index);
    },
  });
  const refresh = () => { dirty = true; requestScrollFrame(); };
  host.addEventListener('toggle', refresh, true);
  const resize = new ResizeObserver(refresh);
  resize.observe(host);
  if (!host.hasAttribute('tabindex')) host.tabIndex = -1;
  return () => { alive = false; dispose(); host.removeEventListener('toggle', refresh, true); resize.disconnect(); };
}
