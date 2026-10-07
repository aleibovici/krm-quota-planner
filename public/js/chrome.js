import { $ } from './constants.js';
import { icon } from './dom.js';
import { paint } from './sync.js';

export function initChrome() {
  const stored = (() => { try { return localStorage.getItem('planner-theme'); } catch { return null; } })();
  if (stored === 'light' || stored === 'dark') document.documentElement.dataset.theme = stored;
  const isDark = () => (document.documentElement.dataset.theme ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark';
  const paintTheme = () => $('theme').replaceChildren(icon(isDark() ? 'sun' : 'moon'));
  $('theme').addEventListener('click', () => {
    document.documentElement.dataset.theme = isDark() ? 'light' : 'dark';
    try { localStorage.setItem('planner-theme', document.documentElement.dataset.theme); } catch { /* private window */ }
    paintTheme();
  });
  paintTheme();
  $('reload').prepend(icon('refresh'));
  $('hide-plan')?.append(icon('x'));

  for (const tab of document.querySelectorAll('[role="tab"]')) {
    tab.addEventListener('click', () => {
      for (const other of document.querySelectorAll('[role="tab"]')) {
        other.setAttribute('aria-selected', String(other === tab));
        $(other.getAttribute('aria-controls')).hidden = other !== tab;
      }
    });
  }

  for (const dialog of document.querySelectorAll('dialog.modal')) {
    dialog.querySelector('[data-close]')?.append(icon('x'));
    dialog.querySelector('[data-close]')?.addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', (e) => {
      const r = dialog.getBoundingClientRect();
      if (e.target === dialog && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) dialog.close();
    });
  }
  $('add-dialog').addEventListener('close', () => $('add-form').replaceChildren());
  $('commit-open').addEventListener('click', () => {
    $('commit-output').hidden = true;
    $('commit-dialog').showModal();
  });
  window.addEventListener('resize', () => paint());
  // The overview pins itself under the app bar, whose height follows its content.
  const bar = document.querySelector('.appbar');
  new ResizeObserver(() => document.documentElement.style.setProperty('--appbar-h', `${bar.offsetHeight}px`)).observe(bar);
}
