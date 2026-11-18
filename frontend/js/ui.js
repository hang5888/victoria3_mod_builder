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

export function openModal(content, onClose) {
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

// Shows a picture with some lines of text; resolves to true when the user confirms.
export function imageDialog({ title, src, lines = [], confirmLabel, wide = false }) {
  return new Promise((resolve) => {
    let answer = false;
    const ok = h('button', { class: 'btn primary', onclick: () => { answer = true; close(); } }, confirmLabel || t('common.ok'));
    const close = openModal(
      h('div', { class: 'modal image-dialog' + (wide ? ' wide' : '') },
        h('div', { class: 'modal-header' }, h('h3', {}, title)),
        h('div', { class: 'image-dialog-picture' }, h('img', { src, alt: '' })),
        lines.map((line) => h('p', { class: 'muted' }, line)),
        h('div', { class: 'modal-footer' },
          h('button', { class: 'btn', onclick: () => close() }, t('common.cancel')), ok)),
      () => resolve(answer));
    ok.focus();
  });
}

const PAGE = 200;

// The closed sections of a picker, kept in the browser (nothing is kept when storage is not available).
function readClosed(name) {
  if (!name) return [];
  try {
    const value = JSON.parse(localStorage.getItem('vmb.picker.' + name) || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function writeClosed(name, closed) {
  if (!name) return;
  try {
    localStorage.setItem('vmb.picker.' + name, JSON.stringify([...closed]));
  } catch {
    // not kept
  }
}

// A searchable list to choose from.
//   items:    [{key, name, sub}]  (sub: small secondary text)
//   selected: keys chosen so far; multi: allow several
//   thumb:    optional function item -> image URL (shows a picture grid)
//   icon:     optional function item -> small image URL beside the name ('' for none)
//   roomy:    wider dialog and items, with the secondary text on several lines
//   toggle:   optional {label, test(item), on} extra filter checkbox
//   filters:  optional [{label, options: [[value, text]], test(item, value)}] drop-down filters ('' shows all)
//   tabs:     optional [{key, label, test(item)}]: the items of one tab are shown at a time
//   groups:   optional {of(item) -> group key, label(key), order: [keys], remember: name}: the items in
//             sections under bars that open and close (remembered in the browser under `remember`)
//   onDone:   called with the chosen keys
// The chosen items stay in the list whatever the toggle and filters say; search and tabs apply to all.
export function openPicker({ title, items, selected = [], multi = true, thumb = null, icon = null, wide = false,
  roomy = false, toggle = null, filters = [], tabs = null, groups = null, onDone }) {
  const chosen = new Set(selected);
  let query = '';
  let limit = PAGE;
  let filterOn = toggle ? toggle.on : false;
  const filterValues = filters.map(() => '');
  const visibleTabs = tabs ? tabs.filter((tab) => items.some((item) => tab.test(item))) : [];
  let tab = visibleTabs.length ? (visibleTabs.find((one) => items.some((item) => chosen.has(item.key) && one.test(item)))
    || visibleTabs[0]).key : null;
  const closed = new Set(groups ? readClosed(groups.remember) : []);
  for (const item of items) {
    if (!item.search) item.search = `${item.name} ${item.key} ${item.sub || ''}`.toLowerCase();
  }
  const tabBar = visibleTabs.length > 1 ? h('div', { class: 'tabs picker-tabs' }) : null;

  const list = h('div', { class: 'picker-list' + (thumb ? ' picker-grid' : '') + (wide ? ' picker-wide' : '')
    + (roomy ? ' picker-roomy' : '') });
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
    if (groups) renderList();  // the bars count the chosen items
  }

  function updateFooter() {
    doneButton.textContent = t('picker.done', { count: chosen.size });
  }

  function itemButton(item) {
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
  }

  // the items in sections: a bar per group (with how many items and how many are chosen), then its items
  function groupRows(matches, searching) {
    const byGroup = new Map();
    for (const item of matches) {
      const key = groups.of(item);
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key).push(item);
    }
    const order = [...groups.order.filter((key) => byGroup.has(key)), ...[...byGroup.keys()].filter((key) => !groups.order.includes(key))];
    return order.flatMap((key) => {
      const members = byGroup.get(key);
      const open = searching || !closed.has(key);
      const picked = members.filter((item) => chosen.has(item.key)).length;
      const bar = h('button', {
        class: 'picker-group' + (open ? ' open' : ''),
        onclick: () => {
          if (closed.has(key)) closed.delete(key);
          else closed.add(key);
          writeClosed(groups.remember, closed);
          renderList();
        },
      }, h('span', { class: 'picker-group-arrow' }, open ? '▾' : '▸'), h('b', {}, groups.label(key)),
      h('span', { class: 'muted' }, t('picker.group_count', { count: members.length })),
      picked > 0 && h('span', { class: 'badge accent' }, t('picker.group_chosen', { count: picked })));
      return [bar, ...(open ? members.map(itemButton) : [])];
    });
  }

  function renderList() {
    const q = query.trim().toLowerCase();
    const matches = items.filter((item) => (!q || item.search.includes(q)) && (chosen.has(item.key)
      || ((!filterOn || toggle.test(item)) && filters.every((filter, i) => !filterValues[i] || filter.test(item, filterValues[i])))));
    if (tabBar) {
      tabBar.replaceChildren(...visibleTabs.map((one) => h('button', {
        class: 'tab' + (one.key === tab ? ' active' : ''), onclick: () => { tab = one.key; limit = PAGE; renderList(); },
      }, one.label, q && ` (${matches.filter((item) => one.test(item)).length})`)));
    }
    const current = visibleTabs.find((one) => one.key === tab);
    const shown = current ? matches.filter((item) => current.test(item)) : matches;
    if (groups) {
      list.replaceChildren(...groupRows(shown, Boolean(q)));
    } else {
      list.replaceChildren(...shown.slice(0, limit).map(itemButton));
      if (shown.length > limit) {
        list.append(h('button', { class: 'btn picker-more', onclick: () => { limit += PAGE; renderList(); } },
          t('common.show_more', { count: shown.length - limit })));
      }
    }
    status.textContent = t('picker.count', { count: shown.length });
  }

  const search = h('input', {
    type: 'search', class: 'input', placeholder: t('common.search'),
    oninput: debounce(() => { query = search.value; limit = PAGE; renderList(); }, 120),
  });
  const modal = h('div', { class: 'modal picker' + (roomy ? ' modal-large' : '') },
    h('div', { class: 'modal-header' },
      h('h3', {}, title),
      h('button', { class: 'btn icon-btn', title: t('common.close'), onclick: () => close() }, '✕')),
    h('div', { class: 'picker-tools' },
      search,
      filters.map((filter, i) => {
        const select = h('select', {
          class: 'input picker-filter', title: filter.label,
          onchange: () => { filterValues[i] = select.value; limit = PAGE; renderList(); },
        }, h('option', { value: '' }, `${filter.label}: ${t('picker.all')}`),
        filter.options.map(([value, text]) => h('option', { value }, text)));
        return select;
      }),
      toggle && h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: filterOn,
          onchange: (event) => { filterOn = event.target.checked; limit = PAGE; renderList(); } }),
        toggle.label),
      status),
    tabBar,
    list,
    multi && h('div', { class: 'modal-footer' },
      h('button', { class: 'btn', onclick: () => close() }, t('common.cancel')), doneButton));
  const close = openModal(modal);
  updateFooter();
  renderList();
  search.focus();
}
