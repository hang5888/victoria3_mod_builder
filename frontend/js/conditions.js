// Conditions edited as a list of simple rows instead of script.
//
// The script text stays the source of truth: it is read into rows, and every
// change to a row writes the whole text again. Statements the rows cannot show
// become "script" rows that keep their original text, so nothing is lost.
import { t } from './i18n.js';
import { store, nameOf } from './store.js';
import { h, openPicker } from './ui.js';
import { objectIcon, pickerIcon } from './icons.js';
import { parseScript, dedent, blockText, isBlock, bracesBalanced } from './script.js';

// Row kinds offered in each place.
export const COUNTRY_KINDS = ['tech', 'building', 'state', 'entire_state', 'interest', 'country', 'culture', 'dlc'];
export const STATE_KINDS = ['state_is', 'incorporated'];
export const TARGET_KINDS = ['target'];

const simple = (entry, key, op = '=') => entry.key === key && entry.op === op && typeof entry.value === 'string';
const blockOf = (entry, key) => (entry.key === key && entry.op === '=' && isBlock(entry.value) ? entry.value : null);
const isLevel = (value) => /^\d+$/.test(value);
const levelOf = (value) => Math.max(1, parseInt(value, 10) || 1);
const stripPrefix = (value, prefix) => (value.startsWith(prefix) ? value.slice(prefix.length) : value);

// Several alternatives: one line, or an OR block.
function anyOf(lines) {
  if (lines.length === 0) return null;
  return lines.length === 1 ? lines[0] : blockText('OR', lines);
}

// `x = a` or `OR = { x = a  x = b }` -> [a, b], using read(entry) -> value or null.
function readAnyOf(entry, read) {
  const one = read(entry);
  if (one) return [one];
  const or = blockOf(entry, 'OR');
  if (!or || !or.entries.length) return null;
  const values = or.entries.map(read);
  return values.every(Boolean) ? values : null;
}

// any_scope_building = { is_building_type = a (or OR of them)  level >= n }
function readScopeBuilding(block) {
  const out = { buildings: [], level: '' };
  let groups = 0;
  for (const entry of block.entries) {
    const types = readAnyOf(entry, (e) => (simple(e, 'is_building_type') ? e.value : null));
    if (types) {
      out.buildings.push(...types);
      groups++;
    } else if (simple(entry, 'level', '>=') && isLevel(entry.value)) {
      out.level = entry.value;
    } else {
      return null;
    }
  }
  return groups === 1 && out.level ? out : null;
}

// any_scope_state = { state_region = s:X  is_incorporated = yes  any_scope_building = {...} }
function readStateScope(entry) {
  const block = blockOf(entry, 'any_scope_state');
  if (!block) return null;
  const out = { state: '', incorporated: false, building: null };
  for (const inner of block.entries) {
    const building = blockOf(inner, 'any_scope_building');
    if (simple(inner, 'state_region') && inner.value.startsWith('s:') && !out.state) {
      out.state = inner.value.slice(2);
    } else if (simple(inner, 'is_incorporated') && inner.value === 'yes') {
      out.incorporated = true;
    } else if (building && !out.building) {
      out.building = readScopeBuilding(building);
      if (!out.building) return null;
    } else {
      return null;
    }
  }
  return out;
}

const KINDS = {
  tech: {
    blank: () => ({ tech: '' }),
    read: (e) => simple(e, 'has_technology_researched') && { tech: e.value },
    write: (r) => r.tech && `has_technology_researched = ${r.tech}`,
  },
  building: {
    blank: () => ({ buildings: [], level: '5', state: '', incorporated: true }),
    read(e) {
      const levels = blockOf(e, 'has_building_levels_in_state_region');
      if (levels) {
        const row = { state: '', buildings: [], level: '', incorporated: false, form: 'levels' };
        for (const x of levels.entries) {
          if (simple(x, 'region')) row.state = x.value;
          else if (simple(x, 'building')) row.buildings = [x.value];
          else if (simple(x, 'levels', '>=') && isLevel(x.value)) row.level = x.value;
          else if (simple(x, 'is_incorporated') && x.value === 'yes') row.incorporated = true;
          else return null;
        }
        return row.state && row.buildings.length && row.level ? row : null;
      }
      const scope = readStateScope(e);
      return scope && scope.building && { state: scope.state, incorporated: scope.incorporated,
        buildings: scope.building.buildings, level: scope.building.level, form: 'scope' };
    },
    write(r) {
      if (!r.buildings.length) return null;
      const level = levelOf(r.level);
      if (r.state && r.buildings.length === 1 && r.form !== 'scope') {
        return blockText('has_building_levels_in_state_region', [`region = ${r.state}`,
          `building = ${r.buildings[0]}`, `levels >= ${level}`, r.incorporated && 'is_incorporated = yes'].filter(Boolean));
      }
      const types = anyOf(r.buildings.map((b) => `is_building_type = ${b}`));
      return blockText('any_scope_state', [r.state && `state_region = s:${r.state}`,
        r.incorporated && 'is_incorporated = yes', blockText('any_scope_building', [types, `level >= ${level}`])]
        .filter(Boolean));
    },
  },
  state: {
    blank: () => ({ state: '', incorporated: true }),
    read(e) {
      const scope = readStateScope(e);
      return scope && !scope.building && scope.state && { state: scope.state, incorporated: scope.incorporated };
    },
    write: (r) => r.state && blockText('any_scope_state',
      [`state_region = s:${r.state}`, r.incorporated && 'is_incorporated = yes'].filter(Boolean)),
  },
  entire_state: {
    blank: () => ({ state: '' }),
    read: (e) => simple(e, 'owns_entire_state_region') && { state: stripPrefix(e.value, 's:') },
    write: (r) => r.state && `owns_entire_state_region = ${r.state}`,
  },
  interest: {
    blank: () => ({ regions: [] }),
    read(e) {
      const regions = readAnyOf(e, (x) => (simple(x, 'has_interest_marker_in_region') ? stripPrefix(x.value, 'sr:') : null));
      return regions && { regions };
    },
    write: (r) => anyOf(r.regions.map((region) => `has_interest_marker_in_region = sr:${region}`)),
  },
  country: {
    blank: () => ({ countries: [] }),
    read(e) {
      const tags = readAnyOf(e, (x) => (/^c:\w+$/.test(x.key || '') && x.op === '?=' && x.value === 'this'
        ? x.key.slice(2) : null));
      return tags && { countries: tags };
    },
    write: (r) => anyOf(r.countries.map((tag) => `c:${tag} ?= this`)),
  },
  culture: {
    blank: () => ({ cultures: [] }),
    read(e) {
      const cultures = readAnyOf(e, (x) => (simple(x, 'country_has_primary_culture') && x.value.startsWith('cu:')
        ? x.value.slice(3) : null));
      return cultures && { cultures };
    },
    write: (r) => anyOf(r.cultures.map((c) => `country_has_primary_culture = cu:${c}`)),
  },
  dlc: {
    blank: () => ({ dlc: '' }),
    read: (e) => simple(e, 'has_dlc_feature') && { dlc: e.value },
    write: (r) => r.dlc && `has_dlc_feature = ${r.dlc}`,
  },
  state_is: {
    blank: () => ({ states: [] }),
    read(e) {
      const states = readAnyOf(e, (x) => (simple(x, 'state_region') && x.value.startsWith('s:') ? x.value.slice(2) : null));
      return states && { states };
    },
    write: (r) => anyOf(r.states.map((s) => `state_region = s:${s}`)),
  },
  incorporated: {
    blank: () => ({}),
    read: (e) => simple(e, 'is_incorporated') && e.value === 'yes' && {},
    write: () => 'is_incorporated = yes',
  },
  // ai_construction_targets: building_x = { level = 5  state_trigger = { state_region = s:X } }
  target: {
    blank: () => ({ building: '', level: '5', state: '' }),
    read(e) {
      if (!e.key || e.op !== '=' || !isBlock(e.value)) return null;
      const row = { building: e.key, level: '', state: '' };
      for (const x of e.value.entries) {
        const trigger = blockOf(x, 'state_trigger');
        if (simple(x, 'level') && isLevel(x.value)) {
          row.level = x.value;
        } else if (trigger && trigger.entries.length === 1 && simple(trigger.entries[0], 'state_region')
          && trigger.entries[0].value.startsWith('s:')) {
          row.state = trigger.entries[0].value.slice(2);
        } else {
          return null;
        }
      }
      return row.level ? row : null;
    },
    write: (r) => r.building && blockText(r.building, [`level = ${levelOf(r.level)}`,
      r.state && blockText('state_trigger', [`state_region = s:${r.state}`])].filter(Boolean)),
  },
  // Anything else, kept as script.
  raw: {
    blank: () => ({ text: '' }),
    read: () => null,
    write: (r) => r.text.trim() || null,
  },
};

// Script -> {hidden, rows}, or null when the braces do not match.
// `hidden`: the conditions sit inside hidden_trigger, so the game does not list them.
export function readConditions(text, kinds) {
  const entries = parseScript(text);
  if (!entries) return null;
  let list = entries;
  let hidden = false;
  if (list.length === 1 && blockOf(list[0], 'hidden_trigger')) {
    hidden = true;
    list = list[0].value.entries;
  }
  const rows = list.map((entry) => {
    for (const kind of kinds) {
      const row = KINDS[kind].read(entry);
      if (row) return { kind, ...row };
    }
    return { kind: 'raw', text: dedent(text.slice(entry.start, entry.end)) };
  });
  return { hidden, rows };
}

export function writeConditions(model) {
  const body = model.rows.map((row) => KINDS[row.kind].write(row)).filter(Boolean).join('\n');
  return model.hidden && body ? blockText('hidden_trigger', [body]) : body;
}

export function newRow(kind, values = {}) {
  return { kind, ...KINDS[kind].blank(), ...values };
}

// Number of conditions in a script, for summaries.
export function countConditions(text) {
  const model = readConditions(text, []);
  return model ? model.rows.length : 0;
}

// ---------------------------------------------------------------------- UI

// Rows being edited, so rows that are not filled in yet survive a redraw.
const cache = new Map();

export function clearConditionCache() {
  cache.clear();
}

function itemsOf(kind) {
  return store.data[kind].filter((item) => !item.sea).map((item) => ({
    key: item.key, name: item.name || item.key,
    sub: item.group_name || (item.era && t('cond.era', { n: item.era })) || (item.region && nameOf('regions', item.region))
      || item.key,
  }));
}

// A button showing the chosen game objects; clicking it opens a picker.
export function valueButton({ kind, keys, multi = false, title, placeholder = t('common.choose'), onDone }) {
  const shown = keys.slice(0, 3).map((key) => h('span', { class: 'cond-value' }, objectIcon(kind, key), nameOf(kind, key)));
  return h('button', {
    class: 'btn cond-pick' + (keys.length ? '' : ' empty'),
    title: keys.join(', '),
    onclick: () => openPicker({
      title, multi, selected: keys, icon: pickerIcon(kind), items: itemsOf(kind), onDone,
    }),
  }, keys.length ? [shown, keys.length > 3 && h('span', { class: 'muted' }, `+${keys.length - 3}`)] : placeholder);
}

// A list of conditions.
//   id:    unique name of the place being edited (for the cache)
//   get(): current script; set(text): store the new script
//   kinds: row kinds offered; hideOption: show the "hide in game" checkbox
export function conditionEditor({ id, get, set, kinds, hideOption = false }) {
  const rowsEl = h('div', { class: 'cond-rows' });
  const hideEl = h('div');
  const script = h('textarea', {
    class: 'input mono script', spellcheck: false, rows: 6,
    oninput: () => {
      script.classList.toggle('invalid', !bracesBalanced(script.value));
      set(script.value);
    },
    onchange: () => render(),  // read the edited script into rows again
  });
  const addKinds = [...kinds, 'raw'];
  const add = kinds.length === 1
    ? h('button', { class: 'btn', onclick: () => addRow(kinds[0]) }, t('cond.add_one'))
    : h('select', { class: 'input cond-add', onchange: (event) => {
      const kind = event.target.value;
      event.target.value = '';
      if (kind) addRow(kind);
    } },
    h('option', { value: '' }, t('cond.add')),
    addKinds.map((kind) => h('option', { value: kind }, t('cond.kind.' + kind))));
  const el = h('div', { class: 'cond-editor' }, hideEl, rowsEl, h('div', { class: 'row' }, add),
    h('details', { class: 'cond-script' }, h('summary', {}, t('cond.script')), script));
  let model = null;

  function current() {
    const text = get();
    const cached = cache.get(id);
    if (cached && cached.text === text) return cached.model;
    const fresh = readConditions(text, kinds);
    if (fresh) cache.set(id, { text, model: fresh });
    return fresh;
  }

  function commit() {
    const text = writeConditions(model);
    cache.set(id, { text, model });
    if (document.activeElement !== script) {
      script.value = text;
      script.classList.remove('invalid');
    }
    set(text);
  }

  function addRow(kind) {
    model.rows.push(newRow(kind));
    commit();
    render();
    const last = rowsEl.lastElementChild;
    const first = last && last.querySelector('.cond-pick, textarea, select');
    if (first && first.tagName === 'BUTTON') first.click();
    else if (first) first.focus();
  }

  function pickButton(row, field, kind, { multi = false, placeholder } = {}) {
    return valueButton({
      kind, multi, placeholder, title: t('cond.kind.' + row.kind),
      keys: multi ? row[field] : (row[field] ? [row[field]] : []),
      onDone: (chosen) => {
        row[field] = multi ? chosen : (chosen[0] || '');
        commit();
        render();
      },
    });
  }

  function levelInput(row) {
    const input = h('input', { class: 'input level', type: 'number', min: '1', value: row.level,
      oninput: () => { row.level = input.value; commit(); } });
    return h('label', { class: 'cond-level' }, h('span', { class: 'muted' }, t('cond.level')), input);
  }

  function check(row, field, label) {
    return h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: row[field], onchange: (event) => { row[field] = event.target.checked; commit(); } }),
      label);
  }

  // A state that may be left empty ("any state").
  function optionalState(row) {
    return [
      pickButton(row, 'state', 'states', { placeholder: t('cond.any_state') }),
      row.state && h('button', { class: 'cond-clear', title: t('cond.clear'),
        onclick: () => { row.state = ''; commit(); render(); } }, '✕'),
    ];
  }

  function controls(row) {
    switch (row.kind) {
      case 'tech': return pickButton(row, 'tech', 'technologies');
      case 'building': return [pickButton(row, 'buildings', 'buildings', { multi: true }), levelInput(row),
        h('span', { class: 'muted' }, t('cond.in')), optionalState(row), check(row, 'incorporated', t('cond.incorporated'))];
      case 'state': return [pickButton(row, 'state', 'states'), check(row, 'incorporated', t('cond.incorporated'))];
      case 'entire_state': return pickButton(row, 'state', 'states');
      case 'interest': return pickButton(row, 'regions', 'regions', { multi: true });
      case 'country': return pickButton(row, 'countries', 'countries', { multi: true });
      case 'culture': return pickButton(row, 'cultures', 'cultures', { multi: true });
      case 'state_is': return pickButton(row, 'states', 'states', { multi: true });
      case 'incorporated': return null;
      case 'target': return [pickButton(row, 'building', 'buildings'), levelInput(row),
        h('span', { class: 'muted' }, t('cond.in')), optionalState(row)];
      case 'dlc': {
        const select = h('select', { class: 'input', onchange: () => { row.dlc = select.value; commit(); } },
          h('option', { value: '' }, t('common.choose')),
          store.data.dlc_features.map((feature) => h('option', { value: feature }, feature)));
        select.value = row.dlc;
        return select;
      }
      default: {
        const area = h('textarea', { class: 'input mono script', spellcheck: false, value: row.text,
          rows: Math.min(10, Math.max(1, row.text.split('\n').length)),
          oninput: () => {
            row.text = area.value;
            area.classList.toggle('invalid', !bracesBalanced(area.value));
            commit();
          } });
        return area;
      }
    }
  }

  function render() {
    model = current();
    if (document.activeElement !== script) script.value = get();
    if (!model) {
      hideEl.replaceChildren();
      rowsEl.replaceChildren(h('p', { class: 'notice warn' }, t('cond.unreadable')));
      add.disabled = true;
      return;
    }
    add.disabled = false;
    hideEl.replaceChildren(...(hideOption || model.hidden ? [h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: model.hidden,
        onchange: (event) => { model.hidden = event.target.checked; commit(); } }),
      t('cond.hidden'))] : []));
    rowsEl.replaceChildren(...model.rows.map((row) => h('div', { class: 'cond-row' + (row.kind === 'raw' ? ' raw' : '') },
      h('span', { class: 'cond-type' }, t('cond.kind.' + row.kind)),
      h('div', { class: 'cond-controls' }, controls(row)),
      h('button', { class: 'btn icon-btn', title: t('common.remove'), onclick: () => {
        model.rows.splice(model.rows.indexOf(row), 1);
        commit();
        render();
      } }, '✕'))));
    if (!model.rows.length) rowsEl.append(h('p', { class: 'muted small' }, t('cond.empty')));
  }

  render();
  return el;
}
