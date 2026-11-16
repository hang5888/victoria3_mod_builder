// Fields of a script edited as form controls.
//
// The script text (for example a building's `extra`) stays the source of truth: every control
// reads its field from it and writes back only that statement, or removes it when the field is
// back at the game's default. Fields the form does not know stay in the script and are edited
// in a text box of their own (see splitScript).
//
// A field is described as
//   { key, kind, group?, hint?, risky?(value), ...options of its kind }
// kind:
//   flag        yes/no; `default` is the game's value when the field is not written
//   number      a number
//   select      one of `options` (array, or function returning one); `label(option)` for its text
//   text        a quoted string
//   key         one game object of the kind `pick`
//   keys        a list `key = { a b }` of game objects of the kind `pick`, or free keys without `pick`
//   repeat      the same key written once per value (`key = a  key = b`), objects of the kind `pick`
//   amounts     `key = { object = number ... }`, objects of the kind `pick`
//   conditions  a trigger block, edited as a condition list with the row kinds `kinds`
//   block       any other block, edited as script
//   entity      `key = { "entity_name" }`: one of `options`, or an empty block
//   gfx         city_gfx_interactions: `size` and `clear_size_area`
// `group`: fields without one are always shown; the others sit in collapsible groups.
// `hint`: there is a hint text. `risky(value)`: there is a warning, shown in yellow above the
// field at all times, and marked while risky(value) is true.
import { t } from './i18n.js';
import { h, openPicker } from './ui.js';
import { pickerIcon } from './icons.js';
import { parseScript, isBlock, dedent, blockText, scriptValue, setScriptValue } from './script.js';
import { conditionEditor, valueButton } from './conditions.js';
import { objectChip, pickerItems, scriptArea } from './widgets.js';

const NUMBER = /^-?\d+(\.\d+)?$/;
const opened = new Map();  // `${scope}.${group}` -> open, once the user has toggled the group

// Every value of a key that is written more than once (`key = a  key = b`).
function scriptValues(text, key) {
  const entries = parseScript(text) || [];
  return entries.filter((entry) => entry.key === key && typeof entry.value === 'string').map((entry) => entry.value);
}

// The script inside `key = { ... }`, or null when the key is not there.
export function scriptBlock(text, key) {
  const entries = parseScript(text) || [];
  const found = entries.filter((entry) => entry.key === key && isBlock(entry.value));
  if (!found.length) return null;
  const { start, end } = found[found.length - 1];
  const raw = text.slice(start, end);
  return dedent(raw.slice(raw.indexOf('{') + 1, raw.lastIndexOf('}')));
}

// {known, unknown}: the statements of the given keys, and all the others, as separate texts;
// null when the script cannot be read.
export function splitScript(text, keys) {
  const entries = parseScript(text);
  if (!entries) return null;
  const part = (known) => entries.filter((entry) => keys.has(entry.key) === known)
    .map((entry) => dedent(text.slice(entry.start, entry.end))).join('\n');
  return { known: part(true), unknown: part(false) };
}

export const joinScript = (...parts) => parts.filter((part) => part && part.trim()).join('\n');

// Values of a key found in the scripts of loaded game objects (for choices without a list).
export function usedValues(texts, key) {
  const values = new Set();
  for (const text of texts) {
    for (const value of [scriptValue(text, key)].flat()) if (typeof value === 'string' && value) values.add(value);
  }
  return [...values].sort();
}

// The form.
//   scope:  name for remembering which groups are open, and for condition list ids
//   get():  the current script; write(text, redraw): store it (redraw false: the control
//           redraws itself, like condition lists)
//   fields, groups: the field descriptions, and the group keys in the order shown
export function scriptFields({ scope, get, write, fields, groups = [] }) {
  if (parseScript(get()) === null) return h('p', { class: 'notice warn' }, t('fset.unreadable'));
  const put = (key, line, redraw = true) => write(setScriptValue(get(), key, line), redraw);
  const isSet = (field) => scriptValue(get(), field.key) !== null;
  const grid = (list) => h('div', { class: 'settings-grid' }, list.map((field) => fieldElement(field, scope, get, put)));
  return h('div', { class: 'script-fields' },
    grid(fields.filter((field) => !field.group)),
    groups.map((group) => {
      const list = fields.filter((field) => field.group === group);
      const id = `${scope}.${group}`;
      const count = list.filter(isSet).length;
      // open when the user opened it, or when something in it is set
      const open = opened.has(id) ? opened.get(id) : count > 0;
      return h('details', {
        class: 'settings-group', open,
        ontoggle: (event) => { opened.set(id, event.target.open); },
      },
        h('summary', {}, t('fset.group.' + group), count > 0 && h('span', { class: 'badge' }, String(count))),
        grid(list));
    }));
}

function fieldElement(field, scope, get, put) {
  const { key } = field;
  const value = scriptValue(get(), key);
  const risky = field.risky ? Boolean(field.risky(value)) : false;
  const wide = ['conditions', 'block', 'amounts'].includes(field.kind);
  return h('div', { class: 'setting' + (risky ? ' warned' : '') + (wide ? ' wide' : '') },
    field.risky && h('div', { class: 'setting-warn' }, risky && '⚠ ', t('fset.warn.' + key)),
    h('div', { class: 'field' },
      h('span', { class: 'field-label' }, t('fset.label.' + key), h('span', { class: 'mono muted small' }, ` ${key}`)),
      control(field, value, scope, get, put),
      field.hint && h('span', { class: 'muted small' }, t('fset.hint.' + key))));
}

// Chosen objects as removable chips, with a button to choose (the label is the field's own).
function chips(kind, title, keys, onChange) {
  return h('div', { class: 'chips' },
    keys.map((key) => objectChip(kind, key,
      h('button', { class: 'chip-remove', title: t('common.remove'), onclick: () => onChange(keys.filter((k) => k !== key)) }, '✕'))),
    h('button', { class: 'btn small', onclick: () => openPicker({
      title, selected: keys, icon: pickerIcon(kind), items: pickerItems(kind), onDone: onChange }) }, t('common.choose')));
}

// A button choosing one object, with a clear button.
function oneObject(kind, title, current, onChange) {
  return h('div', { class: 'row' },
    valueButton({ kind, title, keys: current ? [current] : [], onDone: ([chosen]) => onChange(chosen || null) }),
    current && h('button', { class: 'cond-clear', title: t('cond.clear'), onclick: () => onChange(null) }, '✕'));
}

function control(field, value, scope, get, put) {
  const { key } = field;
  const title = t('fset.label.' + key);
  switch (field.kind) {
    case 'flag': {
      const on = value === null ? field.default : value === 'yes';
      return h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: on,
          // only what differs from the game's default is written
          onchange: (event) => put(key, event.target.checked === field.default ? null
            : `${key} = ${event.target.checked ? 'yes' : 'no'}`) }),
        field.default ? t('fset.default_yes') : t('fset.default_no'));
    }
    case 'number': {
      const input = h('input', {
        class: 'input', type: 'text', inputmode: 'decimal', value: typeof value === 'string' ? value : '',
        placeholder: t('fset.unset'),
        onchange: () => {
          const typed = input.value.trim();
          if (typed && !NUMBER.test(typed)) { input.classList.add('invalid'); return; }
          put(key, typed ? `${key} = ${typed}` : null);
        },
      });
      return input;
    }
    case 'select': {
      const options = typeof field.options === 'function' ? field.options() : field.options;
      const current = typeof value === 'string' ? value : '';
      const label = field.label || ((option) => option);
      const select = h('select', { class: 'input', onchange: () => put(key, select.value ? `${key} = ${select.value}` : null) },
        h('option', { value: '' }, t('fset.unset')),
        [...new Set([...options, current].filter(Boolean))].map((option) => h('option', { value: option }, label(option))));
      select.value = current;
      return select;
    }
    case 'text': {
      const input = h('input', {
        class: 'input mono', type: 'text', spellcheck: false, value: typeof value === 'string' ? value : '',
        placeholder: t('fset.unset'),
        onchange: () => {
          const typed = input.value.trim().replace(/"/g, '');
          put(key, typed ? `${key} = "${typed}"` : null);
        },
      });
      return input;
    }
    case 'key':
      return oneObject(field.pick, title, typeof value === 'string' ? value : '',
        (chosen) => put(key, chosen ? `${key} = ${chosen}` : null));
    case 'keys': {
      const items = Array.isArray(value) ? value : [];
      const write = (keys) => put(key, keys.length ? blockText(key, keys) : null);
      if (field.pick) return chips(field.pick, title, items, write);
      const input = h('input', {
        class: 'input mono', type: 'text', spellcheck: false, value: items.join(' '), placeholder: t('fset.unset'),
        onchange: () => write(input.value.trim().split(/\s+/).filter(Boolean)),
      });
      return input;
    }
    case 'repeat': {
      const items = scriptValues(get(), key);
      return chips(field.pick, title, items,
        (keys) => put(key, keys.length ? keys.map((item) => `${key} = ${item}`).join('\n') : null));
    }
    case 'amounts': return amounts(field, get, put);
    case 'conditions':
      return conditionEditor({
        id: `${scope}.${key}`, kinds: field.kinds || [],
        get: () => scriptBlock(get(), key) || '',
        set: (inner) => put(key, inner.trim() ? blockText(key, [inner]) : null, false),
      });
    case 'block':
      return scriptArea(() => scriptBlock(get(), key) || '',
        (inner) => put(key, inner.trim() ? blockText(key, [inner]) : null, false), () => {});
    case 'entity': {
      // not set, an empty block (shows nothing), or one entity
      const current = value === null ? '' : value.length ? value[0] : '-';
      const select = h('select', {
        class: 'input mono',
        onchange: () => put(key, !select.value ? null : select.value === '-' ? `${key} = { }` : `${key} = { "${select.value}" }`),
      },
        h('option', { value: '' }, t('fset.unset')),
        h('option', { value: '-' }, t('fset.entity_none')),
        [...new Set([...field.options(), current].filter((option) => option && option !== '-'))]
          .map((option) => h('option', { value: option }, option)));
      select.value = current;
      return select;
    }
    case 'gfx': {
      const inner = scriptBlock(get(), key);
      const size = inner === null ? '' : scriptValue(inner, 'size') || '';
      const clear = inner !== null && scriptValue(inner, 'clear_size_area') === 'yes';
      const write = (newSize, newClear) => {
        const lines = [newClear && 'clear_size_area = yes', newSize && `size = ${newSize}`].filter(Boolean);
        put(key, lines.length ? blockText(key, lines) : null);
      };
      const sizeInput = h('input', {
        class: 'input level', type: 'number', min: '0', value: size, placeholder: t('fset.unset'),
        onchange: () => write(sizeInput.value.trim(), clear),
      });
      return h('div', { class: 'row' },
        h('span', { class: 'muted' }, t('fset.gfx_size')), sizeInput,
        h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: clear, onchange: (event) => write(size, event.target.checked) }),
          t('fset.gfx_clear')));
    }
    default:
      return null;
  }
}

// `key = { object = number ... }` as rows of an object and a number.
function amounts(field, get, put) {
  const { key, pick } = field;
  const inner = scriptBlock(get(), key);
  const rows = ((inner !== null && parseScript(inner)) || [])
    .filter((entry) => entry.key && typeof entry.value === 'string').map((entry) => ({ key: entry.key, amount: entry.value }));
  const write = (list) => put(key, list.length ? blockText(key, list.map((row) => `${row.key} = ${row.amount}`)) : null);
  const add = () => openPicker({
    title: t('fset.label.' + key), selected: [], icon: pickerIcon(pick),
    items: pickerItems(pick).filter((item) => !rows.some((row) => row.key === item.key)),
    onDone: (keys) => write([...rows, ...keys.map((chosen) => ({ key: chosen, amount: '1' }))]),
  });
  return h('div', { class: 'amounts' },
    rows.map((row, index) => {
      const input = h('input', {
        class: 'input mono amount', type: 'text', value: row.amount,
        onchange: () => {
          if (!NUMBER.test(input.value.trim())) { input.classList.add('invalid'); return; }
          write(rows.map((other, n) => (n === index ? { ...other, amount: input.value.trim() } : other)));
        },
      });
      return h('div', { class: 'amount-row' },
        valueButton({ kind: pick, title: t('fset.label.' + key), keys: [row.key],
          onDone: ([chosen]) => chosen && write(rows.map((other, n) => (n === index ? { ...other, key: chosen } : other))) }),
        input,
        h('button', { class: 'btn icon-btn', title: t('common.remove'),
          onclick: () => write(rows.filter((_other, n) => n !== index)) }, '✕'));
    }),
    h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: add }, t('factory.add'))));
}
