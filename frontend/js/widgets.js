// Pieces shared by the editor pages: form parts, chips and source tags.
import { textureUrl } from './api.js';
import { t } from './i18n.js';
import { store, nameOf } from './store.js';
import { h, toast, errorText, openPicker } from './ui.js';
import { thumb, objectIcon, pickerIcon } from './icons.js';
import { bracesBalanced } from './script.js';

// Run an action of a button; failures are shown instead of lost.
export async function run(action) {
  try {
    await action();
  } catch (error) {
    console.error(error);
    toast(errorText(error), 'error');
  }
}

export function section(title, hint, ...children) {
  return h('section', { class: 'card' }, h('h3', {}, title), hint && h('p', { class: 'muted' }, hint), children);
}

export function field(label, control, hint) {
  return h('label', { class: 'field' },
    h('span', { class: 'field-label' }, label), control, hint && h('span', { class: 'muted small' }, hint));
}

export function sourceName(id) {
  if (id === 'game') return t('company.source_game');
  const source = store.index.sources.get(id);
  return source ? source.name : id;
}

// A tag for every source that defines or changes the item; none for a base game only item.
// The last one is in effect and is the strong one.
export function sourceBadges(item) {
  if (item.sources.length === 1 && item.source === 'game') return null;
  const last = item.sources[item.sources.length - 1];
  return h('span', { class: 'badges' }, item.sources.map((id) => h('span', {
    class: 'badge source' + (id === last ? '' : ' faded'),
    title: id === last && item.sources.length > 1 ? t('company.source_active', { source: sourceName(id) }) : sourceName(id),
  }, sourceName(id))));
}

export function objectChip(kind, key, ...extra) {
  return h('span', { class: 'chip', title: key }, objectIcon(kind, key), nameOf(kind, key), extra);
}

// A script text box. get() -> text, set(text) stores it, onChange() runs after every edit.
export function scriptArea(get, set, onChange) {
  const area = h('textarea', {
    class: 'input mono script', spellcheck: false, value: get(),
    rows: Math.min(16, Math.max(2, get().split('\n').length + 1)),
    oninput: () => {
      set(area.value);
      area.classList.toggle('invalid', !bracesBalanced(area.value));
      onChange();
    },
    onkeydown: (event) => {
      if (event.key !== 'Tab' || event.shiftKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      area.setRangeText('\t', area.selectionStart, area.selectionEnd, 'end');
      area.dispatchEvent(new Event('input'));
    },
  });
  area.classList.toggle('invalid', !bracesBalanced(area.value));
  return area;
}

// An image path with a thumbnail and a picker over the given paths. onChange(path) stores
// it and redraws.
export function imageField({ label, value, paths, wide = false, onChange }) {
  const input = h('input', {
    class: 'input mono', type: 'text', spellcheck: false, value,
    onchange: () => onChange(input.value.trim()),
  });
  const choose = () => openPicker({
    title: label, multi: false, wide, selected: value ? [value] : [],
    items: paths.map((path) => ({ key: path, name: path.split('/').pop().replace(/\.\w+$/, '') })),
    thumb: (item) => textureUrl(item.key, wide ? 320 : 128),
    onDone: ([path]) => onChange(path),
  });
  return h('div', { class: 'image-field' + (wide ? ' wide' : '') },
    thumb(value, wide ? 320 : 128, 'image-thumb'),
    h('div', { class: 'grow' },
      h('span', { class: 'field-label' }, label),
      input,
      h('button', { class: 'btn', onclick: choose }, t('common.choose'))));
}

// Game objects of a kind as picker items.
export function pickerItems(kind) {
  return store.data[kind].filter((item) => !item.sea).map((item) => ({
    key: item.key, name: item.name || item.key, used: item.used,
    sub: item.group_name || item.good_name || (item.era && t('cond.era', { n: item.era }))
      || (item.region && nameOf('regions', item.region)) || item.key,
  }));
}

// A list of chosen game objects shown as removable chips, with a picker to add more.
// onChange(keys) stores the new list and redraws.
export function keyChips({ keys, kind, label, hint, toggle, onChange }) {
  const pick = () => openPicker({
    title: label, selected: keys, toggle, icon: pickerIcon(kind), items: pickerItems(kind), onDone: onChange,
  });
  return h('div', { class: 'chip-field' },
    h('div', { class: 'row' },
      h('span', { class: 'field-label' }, label),
      h('button', { class: 'btn', onclick: pick }, t('common.choose'))),
    hint && h('p', { class: 'muted small' }, hint),
    h('div', { class: 'chips' }, keys.map((key) =>
      objectChip(kind, key,
        h('button', { class: 'chip-remove', title: t('common.remove'),
          onclick: () => onChange(keys.filter((k) => k !== key)) }, '✕'))),
    keys.length === 0 && h('span', { class: 'muted' }, t('common.none'))));
}
