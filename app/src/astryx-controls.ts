import { createElement as h, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Button } from '@astryxdesign/core/Button';
import { TabList, Tab } from '@astryxdesign/core/TabList';
import { Theme, defineTheme } from '@astryxdesign/core/theme';
import '@astryxdesign/core/astryx.css';
import './astryx-controls.css';

// Actual Astryx controls, scoped to small React islands around the existing map application.
// Astryx is MIT, Copyright (c) 2026 Meta Platforms, Inc. See public/licenses/astryx.txt.
const theme = defineTheme({
  name: 'mudskipper',
  tokens: {
    '--color-accent': '#3fd0c9',
    '--color-accent-muted': '#3fd0c926',
    '--color-on-accent': '#0e1a1f',
    '--color-neutral': '#253b42',
    '--color-background-body': '#0e1a1f',
    '--color-background-surface': '#15272e',
    '--color-background-muted': '#101e24',
    '--color-text-primary': '#eae6da',
    '--color-text-secondary': '#bdc9c3',
    '--color-text-accent': '#3fd0c9',
    '--color-icon-accent': '#3fd0c9',
    '--color-overlay-hover': '#eae6da14',
    '--color-overlay-pressed': '#eae6da26',
    '--font-family-body': '-apple-system,BlinkMacSystemFont,system-ui,"Segoe UI",sans-serif',
    '--font-family-heading': '-apple-system,BlinkMacSystemFont,system-ui,"Segoe UI",sans-serif',
    '--font-family-code': '-apple-system,BlinkMacSystemFont,system-ui,"Segoe UI",sans-serif',
    '--radius-element': '10px',
  },
});

function island(host: HTMLElement, className: string) {
  host.classList.add('astryx-island', className);
  const root = createRoot(host);
  let destroyed = false;
  return {
    render(content: ReactNode) {
      if (!destroyed) flushSync(() => root.render(h(Theme, { theme, mode: 'dark', children: content })));
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      root.unmount();
    },
  };
}

export interface AstryxButtonOptions {
  label: string;
  onClick: () => void | Promise<void>;
  variant?: 'primary' | 'secondary' | 'tertiary';
  disabled?: boolean;
  loading?: boolean;
  id?: string;
  ariaControls?: string;
}

export function mountAstryxButton(host: HTMLElement, initial: AstryxButtonOptions) {
  const view = island(host, 'ms-astryx-action');
  let options = initial;
  const render = () => view.render(h(Button, {
    label: options.label,
    variant: options.variant === 'tertiary' ? 'ghost' : options.variant ?? 'secondary',
    size: 'lg',
    isDisabled: options.disabled,
    isLoading: options.loading,
    id: options.id,
    'aria-controls': options.ariaControls,
    clickAction: () => options.onClick(),
  }));
  render();
  return { update(next: Partial<AstryxButtonOptions>) { options = { ...options, ...next }; render(); }, destroy: view.destroy };
}

export interface AstryxTabsOptions {
  items: { value: string; label: string; id?: string; panelId?: string }[];
  value: string;
  onChange: (value: string) => void;
  label?: string;
  panelId?: string;
}

export function mountAstryxTabs(host: HTMLElement, initial: AstryxTabsOptions) {
  const view = island(host, 'ms-astryx-tabs');
  let options = initial;
  const render = () => view.render(h(TabList, {
    role: 'tablist',
    'aria-label': options.label ?? 'Field walkthrough',
    value: options.value,
    onChange(value) { options = { ...options, value }; render(); options.onChange(value); },
    size: 'lg',
    layout: 'fill',
    overflow: 'visible',
    children: options.items.map((item) => h(Tab, {
      key: item.value, value: item.value, label: item.label,
      id: item.id, panelId: item.panelId ?? options.panelId,
    })),
  }));
  render();
  return { update(next: Partial<AstryxTabsOptions>) { options = { ...options, ...next }; render(); }, destroy: view.destroy };
}
