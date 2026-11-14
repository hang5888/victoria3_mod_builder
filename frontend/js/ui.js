// Small DOM helpers and the shared dialogs.
import { t } from './i18n.js';

// h('div', {class: 'x', onclick: fn}, child, 'text', ...) builds an element.
// Text is always inserted as text, never as HTML: mod data is untrusted.
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (name === 'class') el.className = value;
    else if (name.startsWith('on')) el.addEventListener(name.slice(2), value);
    else if (name in el) el[name] = value;
    else el.setAttribute(name, value === true ? '' : value);
  }
  el.append(...children.flat(Infinity).filter((c) => c != null && c !== false));
  return el;
}

// Replace an element's content; like h(), it skips null and false children.
export function fill(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false));
}

export function toast(message, kind = 'info') {
  const el = h('div', { class: `toast toast-${kind}` }, message);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 7000 : 3500);
}

// Message for an error thrown by api.js.
export function errorText(error) {
  const key = 'error.' + (error.code || 'server_error');
  const text = t(key);
  return text === key ? String(error.message || error) : text;
}

export function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function openModal(content, onClose) {
  const backdrop = h('div', { class: 'modal-backdrop' }, content);
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') close();
  };
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) close();
  });
  document.addEventListener('keydown', onKey);
  document.body.append(backdrop);
  return close;
}

// Resolves to true when the user confirms.
export function confirmDialog(message, confirmLabel) {
  return new Promise((resolve) => {
    let answer = false;
    const ok = h('button', { class: 'btn primary', onclick: () => { answer = true; close(); } },
      confirmLabel || t('common.ok'));
    const close = openModal(
      h('div', { class: 'modal modal-small' },
        h('p', {}, message),
        h('div', { class: 'modal-footer' },
          h('button', { class: 'btn', onclick: () => close() }, t('common.cancel')), ok)),
      () => resolve(answer));
    ok.focus();
  });
}

const PAGE = 200;

// A searchable list to choose from.
//   items:    [{key, name, sub}]  (sub: small secondary text)
//   selected: keys chosen so far; multi: allow several
//   thumb:    optional function item -> image URL (shows a picture grid)
//   icon:     optional function item -> small image URL beside the name ('' for none)
//   toggle:   optional {label, test(item), on} extra filter checkbox
//   onDone:   called with the chosen keys
export function openPicker({ title, items, selected = [], multi = true, thumb = null, icon = null, wide = false,
  toggle = null, onDone }) {
  const chosen = new Set(selected);
  let query = '';
  let limit = PAGE;
  let filterOn = toggle ? toggle.on : false;
  for (const item of items) {
    if (!item.search) item.search = `${item.name} ${item.key} ${item.sub || ''}`.toLowerCase();
  }

  const list = h('div', { class: 'picker-list' + (thumb ? ' picker-grid' : '') + (wide ? ' picker-wide' : '') });
  const status = h('span', { class: 'muted' });
  const doneButton = h('button', { class: 'btn primary', onclick: () => finish() });

  function finish() {
    close();
    onDone([...chosen]);
  }

  function pick(item, row) {
    if (!multi) {
      chosen.clear();
      chosen.add(item.key);
      return finish();
    }
    if (chosen.has(item.key)) chosen.delete(item.key);
    else chosen.add(item.key);
    row.classList.toggle('selected', chosen.has(item.key));
    updateFooter();
  }

  function updateFooter() {
    doneButton.textContent = t('picker.done', { count: chosen.size });
  }

  function renderList() {
    const q = query.trim().toLowerCase();
    const matches = items.filter((item) =>
      (!q || item.search.includes(q)) && (!filterOn || chosen.has(item.key) || toggle.test(item)));
    list.replaceChildren(...matches.slice(0, limit).map((item) => {
      const row = h('button', {
        class: 'picker-item' + (chosen.has(item.key) ? ' selected' : ''),
        title: item.key,
        onclick: () => pick(item, row),
      },
        thumb && h('img', { loading: 'lazy', src: thumb(item), alt: '',
          onerror: (event) => event.target.classList.add('broken') }),
        icon && (icon(item)
          ? h('img', { class: 'picker-icon', loading: 'lazy', src: icon(item), alt: '',
            onerror: (event) => event.target.classList.add('broken') })
          : h('span', { class: 'picker-icon' })),
        h('span', { class: 'picker-text' },
          h('span', { class: 'picker-name' }, item.name),
          item.sub && h('span', { class: 'picker-sub' }, item.sub)));
      return row;
    }));
    if (matches.length > limit) {
      list.append(h('button', { class: 'btn picker-more', onclick: () => { limit += PAGE; renderList(); } },
        t('common.show_more', { count: matches.length - limit })));
    }
    status.textContent = t('picker.count', { count: matches.length });
  }

  const search = h('input', {
    type: 'search', class: 'input', placeholder: t('common.search'),
    oninput: debounce(() => { query = search.value; limit = PAGE; renderList(); }, 120),
  });
  const modal = h('div', { class: 'modal picker' },
    h('div', { class: 'modal-header' },
      h('h3', {}, title),
      h('button', { class: 'btn icon-btn', title: t('common.close'), onclick: () => close() }, '✕')),
    h('div', { class: 'picker-tools' },
      search,
      toggle && h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: filterOn,
          onchange: (event) => { filterOn = event.target.checked; limit = PAGE; renderList(); } }),
        toggle.label),
      status),
    list,
    multi && h('div', { class: 'modal-footer' },
      h('button', { class: 'btn', onclick: () => close() }, t('common.cancel')), doneButton));
  const close = openModal(modal);
  updateFooter();
  renderList();
  search.focus();
}
