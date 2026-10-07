import { $ } from './constants.js';

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}

const ICONS = {
  plus: 'M12 5v14|M5 12h14',
  x: 'M18 6 6 18|M6 6l12 12',
  check: 'M20 6 9 17l-5-5',
  error: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z|M15 9l-6 6|M9 9l6 6',
  warning: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z|M12 9v4|M12 17h.01',
  info: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z|M12 16v-4|M12 8h.01',
  refresh: 'M21 12a9 9 0 1 1-2.64-6.36|M21 3v6h-6',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z|M12 1v2|M12 21v2|M4.2 4.2l1.4 1.4|M18.4 18.4l1.4 1.4|M1 12h2|M21 12h2|M4.2 19.8l1.4-1.4|M18.4 5.6l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  arrow: 'M5 12h14|M13 6l6 6-6 6',
  chevron: 'M9 18l6-6-6-6',
};

export function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ICONS[name].split('|')) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

export function tip(el, content) {
  const box = $('tip');
  const place = (e) => {
    const r = box.getBoundingClientRect();
    box.style.left = `${Math.max(8, Math.min(window.innerWidth - r.width - 8, e.clientX - r.width / 2))}px`;
    box.style.top = `${e.clientY - r.height - 14 < 8 ? e.clientY + 18 : e.clientY - r.height - 14}px`;
  };
  el.addEventListener('pointerenter', (e) => {
    box.replaceChildren(...[content()].flat());
    box.style.cssText = el.closest('[style*="--series"]')?.style.cssText ?? '';
    box.hidden = false;
    place(e);
  });
  el.addEventListener('pointermove', place);
  el.addEventListener('pointerleave', () => { box.hidden = true; });
}

export function ask(title, body, ok) {
  const dialog = $('confirm-dialog');
  $('confirm-title').textContent = title;
  $('confirm-body').textContent = body;
  $('confirm-ok').textContent = ok;
  return new Promise((resolve) => {
    dialog.returnValue = '';
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
    $('confirm-ok').onclick = () => dialog.close('ok');
    $('confirm-cancel').onclick = () => dialog.close('');
    dialog.showModal();
  });
}
