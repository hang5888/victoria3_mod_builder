// Company builder: the company being edited (left), the editor (middle), existing companies (right).
import { api, textureUrl } from './api.js';
import { t } from './i18n.js';
import { store, refreshState, loadData, language, languageName, nameOf, iconOf } from './store.js';
import { h, fill, toast, errorText, confirmDialog, openPicker, debounce } from './ui.js';
import { StateMap } from './map.js';

// Script blocks edited as text, in the order they are shown.
const RAW_BLOCKS = ['potential', 'attainable', 'possible', 'can_establish_in', 'prestige_goods_trigger',
  'ai_will_do', 'ai_construction_targets', 'ai_weight'];
// Country-scope triggers the "insert condition" helpers can write into.
const HELPER_TARGETS = ['potential', 'attainable', 'possible', 'ai_will_do'];
const FIELDS = ['key', 'mode', 'names', 'flavored_company', 'prosperity_modifier', 'blocks', 'extra',
  'building_types', 'extension_building_types', 'possible_prestige_goods', 'preferred_headquarters',
  'icon', 'background', 'category'];
const KEY_PATTERN = /^[A-Za-z0-9_.\-]+$/;
const MODIFIER_VALUE_PATTERN = /^(-?\d+(\.\d+)?|yes|no)$/;
const PAGE = 200;

let root = null;
let editing = null;        // the company in the editor
let originalKey = null;    // its key in the project file, when it was opened from there
let editingProject = null; // folder of the project `editing` belongs to
let dirty = false;
let hqMap = null;
let hqMapData = null;
let showMarkers = true;
const filters = { query: '', source: '', building: '', region: '' };
let listed = [];           // existing companies in the order they are listed
let listLimit = PAGE;
let expanded = null;
const helper = { target: 'possible', state: '', building: '', level: '5' };
const els = {};
const sections = {};

window.addEventListener('beforeunload', (event) => {
  if (dirty) event.preventDefault();
});

async function run(action) {
  try {
    await action();
  } catch (error) {
    console.error(error);
    toast(errorText(error), 'error');
  }
}

function blankCompany() {
  return {
    key: '', mode: 'new', names: {}, flavored_company: true, prosperity_modifier: [],
    blocks: Object.fromEntries(RAW_BLOCKS.map((name) => [name, ''])), extra: '',
    building_types: [], extension_building_types: [], possible_prestige_goods: [],
    preferred_headquarters: [], icon: '', background: '', category: '',
  };
}

// The editable part of a company (drops display-only fields such as its source).
function modelOf(company) {
  const model = structuredClone(Object.fromEntries(FIELDS.map((field) => [field, company[field]])));
  return { ...blankCompany(), ...model, blocks: { ...blankCompany().blocks, ...model.blocks } };
}

export async function renderCompany(container) {
  root = container;
  await refreshState();
  const data = await loadData();
  const blocked = !data ? 'company.need_data' : !store.state.project ? 'company.need_project' : '';
  if (blocked) {
    root.replaceChildren(h('div', { class: 'notice warn page-notice' }, t(blocked), ' ',
      h('a', { href: '#/' }, t('company.go_home'))));
    return;
  }
  store.project = await api.get('/api/project');
  if (!editing || editingProject !== store.state.project.dir) {
    editing = blankCompany();
    originalKey = null;
    dirty = false;
    editingProject = store.state.project.dir;
  }
  els.left = h('div', { class: 'col col-left' });
  els.middle = h('div', { class: 'col col-middle' });
  els.right = h('div', { class: 'col col-right' });
  root.replaceChildren(h('div', { class: 'builder' }, els.left, els.middle, els.right));
  renderLeft();
  renderMiddle();
  renderRight();
}

// ----------------------------------------------------------------- helpers

function originalOf(company) {
  return company.mode === 'override' ? store.index.companies.get(company.key) : null;
}

function displayName(company) {
  const original = originalOf(company);
  return company.names[language()] || (original && original.name) || company.names.english
    || company.key || t('company.unnamed');
}

function sourceName(id) {
  if (id === 'game') return t('company.source_game');
  const source = store.index.sources.get(id);
  return source ? source.name : id;
}

function keyTaken(key) {
  return store.index.companies.has(key)
    || store.project.companies.some((c) => c.key === key && c.key !== originalKey);
}

function bracesBalanced(text) {
  let depth = 0;
  for (const line of text.split('\n')) {
    let quoted = false;
    for (const char of line) {
      if (char === '"') quoted = !quoted;
      else if (quoted) continue;
      else if (char === '#') break;
      else if (char === '{') depth++;
      else if (char === '}' && --depth < 0) return false;
    }
  }
  return depth === 0;
}

// Same checks as the backend, so problems show up while typing.
function problems(company) {
  const found = [];
  if (!company.key) found.push('key_missing');
  else if (!KEY_PATTERN.test(company.key)) found.push('key_invalid');
  else if (company.mode !== 'override' && keyTaken(company.key)) found.push('key_exists');
  if (!company.icon) found.push('icon_missing');
  if (!company.background) found.push('background_missing');
  if (!company.building_types.length) found.push('buildings_missing');
  if (company.prosperity_modifier.some((m) => !MODIFIER_VALUE_PATTERN.test(m.value))) found.push('modifier_value');
  for (const name of RAW_BLOCKS) if (!bracesBalanced(company.blocks[name])) found.push('braces:' + name);
  if (!bracesBalanced(company.extra)) found.push('braces:extra');
  return found;
}

function problemText(code) {
  if (code.startsWith('braces:')) return t('problem.braces', { name: code.slice(7) });
  return t('problem.' + code);
}

function formatModifier(modifier) {
  const info = store.index.modifiers.get(modifier.key);
  const value = Number(modifier.value);
  if (modifier.value === '' || Number.isNaN(value)) return { text: modifier.value, tone: '' };
  const sign = value > 0 ? '+' : '';
  const text = info && info.percent ? `${sign}${Math.round(value * 10000) / 100}%` : `${sign}${value}`;
  let tone = '';
  if (info && info.color !== 'neutral' && value !== 0) {
    tone = (value > 0) === (info.color === 'good') ? 'good' : 'bad';
  }
  return { text, tone };
}

function thumb(path, size, className) {
  if (!path) return h('div', { class: `${className} empty` });
  return h('img', { class: className, loading: 'lazy', alt: '', src: textureUrl(path, size),
    onerror: (event) => event.target.classList.add('broken') });
}

// Kinds of game objects that have their own small icon.
const ICON_KINDS = new Set(['buildings', 'prestige_goods']);
const ICON_SIZE = 64;

// The object's small icon, or null when it has none.
function objectIcon(kind, key) {
  const path = iconOf(kind, key);
  return path ? thumb(path, ICON_SIZE, 'chip-icon') : null;
}

// Icon option for openPicker; null for kinds without icons.
function pickerIcon(kind) {
  if (!ICON_KINDS.has(kind)) return null;
  return (item) => {
    const path = iconOf(kind, item.key);
    return path ? textureUrl(path, ICON_SIZE) : '';
  };
}

function objectChip(kind, key, ...extra) {
  return h('span', { class: 'chip', title: key }, objectIcon(kind, key), nameOf(kind, key), extra);
}

function changed() {
  dirty = true;
  renderPreview();
}

function refresh(name) {
  const fresh = builders[name]();
  sections[name].replaceWith(fresh);
  sections[name] = fresh;
}

// -------------------------------------------------------- switching company

async function edit(company, key, isDirty = false) {
  if (dirty && !(await confirmDialog(t('company.discard_confirm'), t('company.discard')))) return;
  editing = modelOf(company);
  originalKey = key;
  dirty = isDirty;
  renderLeft();
  renderMiddle();
  els.middle.scrollTop = 0;
}

function overrideCompany(company) {
  const existing = store.project.companies.find((c) => c.key === company.key);
  if (existing) {
    toast(t('company.already_in_project'));
    return edit(existing, existing.key);
  }
  return edit({ ...company, mode: 'override', names: {} }, null, true);
}

function copyCompany(company) {
  let key = `${company.key}_copy`;
  for (let n = 2; keyTaken(key); n++) key = `${company.key}_copy${n}`;
  const names = company.name ? { [language()]: company.name } : {};
  return edit({ ...company, mode: 'new', key, names }, null, true);
}

async function save() {
  const result = await api.post('/api/project/company', { company: editing, original_key: originalKey });
  if (result.errors.length) {
    toast(result.errors.map(problemText).join('\n'), 'error');
    return;
  }
  store.project = result.project;
  originalKey = editing.key;
  dirty = false;
  renderLeft();
  toast(t('company.saved', { dir: result.dir }));
}

async function remove() {
  if (!(await confirmDialog(t('company.delete_confirm', { name: displayName(editing) }), t('company.delete')))) return;
  store.project = await api.post('/api/project/company/delete', { key: originalKey });
  dirty = false;
  await edit(blankCompany(), null);
  toast(t('company.deleted'));
}

// --------------------------------------------------------------------- left

function renderLeft() {
  const project = store.project;
  els.preview = h('div', { class: 'preview' });
  fill(els.left,
    h('div', { class: 'col-head' },
      h('h2', {}, t('company.editing')),
      h('button', { class: 'btn', onclick: () => run(() => edit(blankCompany(), null)) }, t('company.new'))),
    els.preview,
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary', onclick: () => run(save) }, t('company.save')),
      originalKey && h('button', { class: 'btn danger', onclick: () => run(remove) }, t('company.delete'))),
    h('h3', { class: 'list-title' }, t('company.in_project', { name: project.name, count: project.companies.length })),
    project.companies.length === 0 && h('p', { class: 'muted' }, t('company.project_empty')),
    h('div', { class: 'project-list' }, project.companies.map((company) =>
      h('button', {
        class: 'company-head' + (company.key === originalKey ? ' current' : ''),
        onclick: () => run(() => edit(company, company.key)),
      },
        thumb(company.icon, 64, 'company-icon'),
        h('span', { class: 'company-title' },
          h('span', { class: 'company-name' }, displayName(company)),
          h('span', { class: 'company-key' }, company.key)),
        h('span', { class: 'badge' + (company.mode === 'override' ? ' accent' : '') }, t('company.mode.' + company.mode))))));
  renderPreview();
}

function previewGroup(title, items, kind) {
  return h('div', { class: 'preview-group' },
    h('h4', {}, title),
    items.length
      ? h('div', { class: 'chips' }, items.map((key) => objectChip(kind, key)))
      : h('span', { class: 'muted' }, t('common.none')));
}

function renderPreview() {
  const company = editing;
  const found = problems(company);
  const notes = [];
  if (!company.blocks.ai_will_do.trim()) notes.push(t('note.no_ai'));
  if (company.mode === 'new' && !Object.values(company.names).some(Boolean)) notes.push(t('note.no_name'));
  const category = company.category ? nameOf('categories', company.category) : store.data.default_category_name;
  const filled = store.state.languages.filter((l) => company.names[l.key]);
  const blocks = RAW_BLOCKS.filter((name) => company.blocks[name].trim());
  fill(els.preview,
    h('div', { class: 'preview-art' },
      thumb(company.background, 480, 'preview-background'),
      thumb(company.icon, 128, 'preview-icon')),
    h('h3', { class: 'preview-name' }, displayName(company)),
    h('div', { class: 'preview-meta' },
      h('span', { class: 'company-key' }, company.key || '—'),
      h('span', { class: 'badge' + (company.mode === 'override' ? ' accent' : '') }, t('company.mode.' + company.mode)),
      dirty && h('span', { class: 'badge warn' }, t('company.unsaved'))),
    h('div', { class: 'muted' }, category || '',
      company.flavored_company ? ` · ${t('company.flavored_short')}` : ''),
    previewGroup(t('company.building_types'), company.building_types, 'buildings'),
    previewGroup(t('company.extension_building_types'), company.extension_building_types, 'buildings'),
    previewGroup(t('company.prestige_goods'), company.possible_prestige_goods, 'prestige_goods'),
    h('div', { class: 'preview-group' },
      h('h4', {}, t('company.modifiers')),
      company.prosperity_modifier.length
        ? h('ul', { class: 'modifier-lines' }, company.prosperity_modifier.map((modifier) => {
          const { text, tone } = formatModifier(modifier);
          return h('li', {}, h('b', { class: tone }, text), ' ', nameOf('modifiers', modifier.key));
        }))
        : h('span', { class: 'muted' }, t('common.none'))),
    previewGroup(t('company.headquarters'), company.preferred_headquarters, 'states'),
    h('div', { class: 'preview-group' },
      h('h4', {}, t('company.conditions')),
      blocks.length
        ? h('div', { class: 'chips' }, blocks.map((name) => h('span', { class: 'chip mono' }, name)))
        : h('span', { class: 'muted' }, t('common.none'))),
    h('div', { class: 'preview-group' },
      h('h4', {}, t('company.translations', { count: filled.length, total: store.state.languages.length })),
      h('div', { class: 'chips' }, store.state.languages.map((l) =>
        h('span', { class: 'chip' + (company.names[l.key] ? ' filled' : ' missing'), title: company.names[l.key] || '' }, l.name)))),
    found.length > 0 && h('ul', { class: 'problems' }, found.map((code) => h('li', {}, problemText(code)))),
    notes.length > 0 && h('ul', { class: 'notes' }, notes.map((note) => h('li', {}, note))));
}

// ------------------------------------------------------------------- middle

function section(title, hint, ...children) {
  return h('section', { class: 'card' }, h('h3', {}, title), hint && h('p', { class: 'muted' }, hint), children);
}

function field(label, control, hint) {
  return h('label', { class: 'field' },
    h('span', { class: 'field-label' }, label), control, hint && h('span', { class: 'muted small' }, hint));
}

function basicSection() {
  const company = editing;
  const original = originalOf(company);
  const lang = language();
  const key = h('input', {
    class: 'input mono', type: 'text', spellcheck: false, value: company.key, disabled: company.mode === 'override',
    placeholder: 'company_my_company',
    oninput: () => { company.key = key.value.trim(); changed(); },
  });
  const name = h('input', {
    class: 'input', type: 'text', value: company.names[lang] || '',
    placeholder: (original && original.name) || '',
    oninput: () => {
      if (name.value.trim()) company.names[lang] = name.value.trim();
      else delete company.names[lang];
      changed();
    },
  });
  const category = h('select', {
    class: 'input',
    onchange: () => { company.category = category.value; changed(); },
  },
    h('option', { value: '' }, store.data.default_category_name || 'capitalist'),
    store.data.categories.map((c) => h('option', { value: c.key }, c.name || c.key)));
  category.value = company.category;
  return section(t('company.basic'), null,
    company.mode === 'override' && h('div', { class: 'notice warn' },
      t('company.override_note', { source: original ? sourceName(original.source) : '?' })),
    field(t('company.key'), key, company.mode === 'override' ? null : t('company.key_hint')),
    field(t('company.name', { language: languageName(lang) }), name,
      company.mode === 'override' ? t('company.name_hint_override') : t('company.name_hint')),
    field(t('company.category'), category, t('company.category_hint')),
    h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: company.flavored_company,
        onchange: (event) => { company.flavored_company = event.target.checked; changed(); } }),
      t('company.flavored')),
    h('p', { class: 'muted small' }, t('company.flavored_hint')));
}

function imageField(name, label, paths, wide) {
  const input = h('input', {
    class: 'input mono', type: 'text', spellcheck: false, value: editing[name],
    onchange: () => { editing[name] = input.value.trim(); changed(); refresh('images'); },
  });
  const choose = () => openPicker({
    title: label, multi: false, wide, selected: editing[name] ? [editing[name]] : [],
    items: paths.map((path) => ({ key: path, name: path.split('/').pop().replace(/\.\w+$/, '') })),
    thumb: (item) => textureUrl(item.key, wide ? 320 : 128),
    onDone: ([path]) => { editing[name] = path; changed(); refresh('images'); },
  });
  return h('div', { class: 'image-field' + (wide ? ' wide' : '') },
    thumb(editing[name], wide ? 320 : 128, 'image-thumb'),
    h('div', { class: 'grow' },
      h('span', { class: 'field-label' }, label),
      input,
      h('button', { class: 'btn', onclick: choose }, t('common.choose'))));
}

function imagesSection() {
  return section(t('company.images'), t('company.images_hint'),
    imageField('icon', t('company.icon'), store.data.icons, false),
    imageField('background', t('company.background'), store.data.backgrounds, true));
}

// A list of chosen game objects shown as removable chips, with a picker to add more.
function chipField(name, kind, label, hint, sectionName, toggle) {
  const pick = () => openPicker({
    title: label, selected: editing[name], toggle, icon: pickerIcon(kind),
    items: store.data[kind].filter((item) => !item.sea).map((item) => ({
      key: item.key, name: item.name || item.key, used: item.used,
      sub: item.group_name || item.good_name || (item.region && nameOf('regions', item.region)) || item.key,
    })),
    onDone: (keys) => { editing[name] = keys; changed(); refresh(sectionName); },
  });
  return h('div', { class: 'chip-field' },
    h('div', { class: 'row' },
      h('span', { class: 'field-label' }, label),
      h('button', { class: 'btn', onclick: pick }, t('common.choose'))),
    hint && h('p', { class: 'muted small' }, hint),
    h('div', { class: 'chips' }, editing[name].map((key) =>
      objectChip(kind, key,
        h('button', { class: 'chip-remove', title: t('common.remove'), onclick: () => {
          editing[name] = editing[name].filter((k) => k !== key);
          changed();
          refresh(sectionName);
        } }, '✕'))),
    editing[name].length === 0 && h('span', { class: 'muted' }, t('common.none'))));
}

function buildingsSection() {
  const toggle = { label: t('company.only_used_buildings'), test: (item) => item.used, on: false };
  return section(t('company.buildings'), null,
    chipField('building_types', 'buildings', t('company.building_types'), t('company.building_types_hint'), 'buildings', toggle),
    chipField('extension_building_types', 'buildings', t('company.extension_building_types'),
      t('company.extension_building_types_hint'), 'buildings', toggle));
}

function prestigeSection() {
  return section(t('company.prestige'), null,
    chipField('possible_prestige_goods', 'prestige_goods', t('company.prestige_goods'), t('company.prestige_goods_hint'), 'prestige'));
}

function modifiersSection() {
  const company = editing;
  const pick = () => openPicker({
    title: t('company.modifiers'),
    selected: company.prosperity_modifier.map((m) => m.key),
    toggle: { label: t('company.only_used_modifiers'), test: (item) => item.used, on: true },
    items: store.data.modifiers.map((m) => ({ key: m.key, name: m.name || m.key, sub: m.key, used: m.used })),
    onDone: (keys) => {
      const values = new Map(company.prosperity_modifier.map((m) => [m.key, m.value]));
      company.prosperity_modifier = keys.map((key) => ({ key, value: values.get(key) ?? '0.1' }));
      changed();
      refresh('modifiers');
    },
  });
  const rows = company.prosperity_modifier.map((modifier) => {
    const effect = h('b', { class: 'modifier-effect' });
    const showEffect = () => {
      const { text, tone } = formatModifier(modifier);
      effect.textContent = MODIFIER_VALUE_PATTERN.test(modifier.value) ? text : '?';
      effect.className = `modifier-effect ${tone}`;
    };
    const input = h('input', {
      class: 'input mono modifier-value', type: 'text', spellcheck: false, value: modifier.value,
      oninput: () => { modifier.value = input.value.trim(); showEffect(); changed(); },
    });
    showEffect();
    return h('div', { class: 'modifier-row' },
      h('span', { class: 'grow' },
        h('span', {}, nameOf('modifiers', modifier.key)),
        h('span', { class: 'company-key' }, modifier.key)),
      input, effect,
      h('button', { class: 'btn icon-btn', title: t('common.remove'), onclick: () => {
        company.prosperity_modifier = company.prosperity_modifier.filter((m) => m !== modifier);
        changed();
        refresh('modifiers');
      } }, '✕'));
  });
  return section(t('company.modifiers'), t('company.modifiers_hint'),
    rows,
    h('div', { class: 'row' }, h('button', { class: 'btn', onclick: pick }, t('company.add_modifier'))));
}

// Companies headquartered in each state, for the dots on the map.
function headquartersByState() {
  const markers = new Map();
  for (const company of store.data.companies) {
    for (const state of company.preferred_headquarters) {
      if (!markers.has(state)) markers.set(state, []);
      markers.get(state).push(company.name || company.key);
    }
  }
  return markers;
}

function toggleHeadquarters(state) {
  const list = editing.preferred_headquarters;
  editing.preferred_headquarters = list.includes(state) ? list.filter((s) => s !== state) : [...list, state];
  changed();
  refresh('headquarters');
}

function headquartersSection() {
  if (!hqMap || hqMapData !== store.data) {
    hqMap = new StateMap({ onToggle: toggleHeadquarters });
    hqMapData = store.data;
    hqMap.setMarkers(headquartersByState());
  }
  hqMap.showMarkers = showMarkers;
  hqMap.setSelected(editing.preferred_headquarters);
  return section(t('company.headquarters'), t('company.headquarters_hint'),
    hqMap.el,
    h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: showMarkers, onchange: (event) => {
        showMarkers = hqMap.showMarkers = event.target.checked;
        hqMap.draw();
      } }),
      t('company.show_headquarters')),
    chipField('preferred_headquarters', 'states', t('company.headquarters_states'), null, 'headquarters'));
}

function insertCondition(text) {
  const current = editing.blocks[helper.target].replace(/\s+$/, '');
  editing.blocks[helper.target] = current ? `${current}\n${text}` : text;
  changed();
  refresh('conditions');
}

function conditionHelpers() {
  const pickOne = (kind, name, title) => openPicker({
    title, multi: false, selected: helper[name] ? [helper[name]] : [], icon: pickerIcon(kind),
    items: store.data[kind].filter((item) => !item.sea).map((item) => ({
      key: item.key, name: item.name || item.key, sub: item.group_name || item.key })),
    onDone: ([key]) => { helper[name] = key; refresh('conditions'); },
  });
  const countries = () => openPicker({
    title: t('helper.country'),
    items: store.data.countries.map((c) => ({ key: c.key, name: c.name || c.key, sub: c.key })),
    onDone: (tags) => {
      if (tags.length === 1) insertCondition(`c:${tags[0]} ?= this`);
      else if (tags.length > 1) insertCondition(`OR = {\n${tags.map((tag) => `\tc:${tag} ?= this`).join('\n')}\n}`);
    },
  });
  const level = h('input', { class: 'input level', type: 'number', min: '1', value: helper.level,
    oninput: () => { helper.level = level.value; } });
  const insertBuilding = () => {
    const levels = Math.max(1, parseInt(helper.level, 10) || 1);
    if (!helper.building) return toast(t('helper.need_building'), 'error');
    if (helper.state) {
      insertCondition('has_building_levels_in_state_region = {\n'
        + `\tregion = ${helper.state}\n\tbuilding = ${helper.building}\n\tlevels >= ${levels}\n}`);
    } else {
      insertCondition('any_scope_state = {\n\tany_scope_building = {\n'
        + `\t\tis_building_type = ${helper.building}\n\t\tlevel >= ${levels}\n\t}\n}`);
    }
  };
  const target = h('select', { class: 'input mono', onchange: () => { helper.target = target.value; } },
    HELPER_TARGETS.map((name) => h('option', { value: name }, name)));
  target.value = helper.target;
  return h('div', { class: 'helpers' },
    h('div', { class: 'row' }, h('b', {}, t('helper.title')), h('span', {}, t('helper.target')), target),
    h('div', { class: 'row' },
      h('span', { class: 'helper-label' }, t('helper.country')),
      h('button', { class: 'btn', onclick: countries }, t('helper.pick_countries'))),
    h('div', { class: 'row' },
      h('span', { class: 'helper-label' }, t('helper.building_level')),
      h('button', { class: 'btn', onclick: () => pickOne('buildings', 'building', t('helper.building')) },
        helper.building ? [objectIcon('buildings', helper.building), nameOf('buildings', helper.building)]
          : t('helper.building')),
      h('span', {}, '≥'), level,
      h('button', { class: 'btn', onclick: () => pickOne('states', 'state', t('helper.state')) },
        helper.state ? nameOf('states', helper.state) : t('helper.any_state')),
      helper.state && h('button', { class: 'btn icon-btn', title: t('common.remove'),
        onclick: () => { helper.state = ''; refresh('conditions'); } }, '✕'),
      h('button', { class: 'btn primary', onclick: insertBuilding }, t('helper.insert'))));
}

function scriptArea(get, set) {
  const area = h('textarea', {
    class: 'input mono script', spellcheck: false, value: get(),
    rows: Math.min(16, Math.max(2, get().split('\n').length + 1)),
    oninput: () => {
      set(area.value);
      area.classList.toggle('invalid', !bracesBalanced(area.value));
      changed();
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

function conditionsSection() {
  const company = editing;
  const copyToAi = () => {
    company.blocks.ai_will_do = company.blocks.possible;
    changed();
    refresh('conditions');
  };
  return section(t('company.conditions'), t('company.conditions_hint'),
    conditionHelpers(),
    RAW_BLOCKS.map((name) => h('div', { class: 'script-field' },
      h('div', { class: 'row' },
        h('span', { class: 'field-label mono' }, name),
        name === 'ai_will_do' && h('button', { class: 'btn small', onclick: copyToAi }, t('company.copy_possible'))),
      h('p', { class: 'muted small' }, t('block.' + name)),
      scriptArea(() => company.blocks[name], (value) => { company.blocks[name] = value; }))),
    h('div', { class: 'script-field' },
      h('span', { class: 'field-label' }, t('company.extra')),
      h('p', { class: 'muted small' }, t('company.extra_hint')),
      scriptArea(() => company.extra, (value) => { company.extra = value; })));
}

const builders = {
  basic: basicSection,
  images: imagesSection,
  buildings: buildingsSection,
  prestige: prestigeSection,
  modifiers: modifiersSection,
  headquarters: headquartersSection,
  conditions: conditionsSection,
};

function renderMiddle() {
  const scroll = els.middle.scrollTop;
  for (const name of Object.keys(builders)) sections[name] = builders[name]();
  els.middle.replaceChildren(...Object.values(sections));
  els.middle.scrollTop = scroll;
}

// -------------------------------------------------------------------- right

function matchesFilters(company) {
  const query = filters.query.trim().toLowerCase();
  if (query && !(company.name || '').toLowerCase().includes(query) && !company.key.toLowerCase().includes(query)) return false;
  if (filters.source && company.source !== filters.source) return false;
  if (filters.building && !company.building_types.includes(filters.building)
    && !company.extension_building_types.includes(filters.building)) return false;
  if (filters.region && !company.preferred_headquarters.some((state) => {
    const info = store.index.states.get(state);
    return info && info.region === filters.region;
  })) return false;
  return true;
}

function companyDetails(company) {
  const line = (label, keys, kind) => keys.length > 0 && (ICON_KINDS.has(kind)
    ? h('div', { class: 'detail-chips' }, h('span', { class: 'muted' }, `${label}: `),
      keys.map((key) => objectChip(kind, key)))
    : h('div', {}, h('span', { class: 'muted' }, `${label}: `), keys.map((key) => nameOf(kind, key)).join(', ')));
  return h('div', { class: 'company-details' },
    line(t('company.building_types'), company.building_types, 'buildings'),
    line(t('company.extension_building_types'), company.extension_building_types, 'buildings'),
    line(t('company.prestige_goods'), company.possible_prestige_goods, 'prestige_goods'),
    line(t('company.headquarters'), company.preferred_headquarters, 'states'),
    company.prosperity_modifier.length > 0 && h('ul', { class: 'modifier-lines' },
      company.prosperity_modifier.map((modifier) => {
        const { text, tone } = formatModifier(modifier);
        return h('li', {}, h('b', { class: tone }, text), ' ', nameOf('modifiers', modifier.key));
      })),
    h('div', { class: 'muted small' }, `${sourceName(company.source)} · ${company.file}`),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: () => run(() => overrideCompany(company)) }, t('company.override')),
      h('button', { class: 'btn', onclick: () => run(() => copyCompany(company)) }, t('company.copy'))));
}

function renderList() {
  const matches = listed.filter(matchesFilters);
  const rows = matches.slice(0, listLimit).map((company) => {
    const open = expanded === company.key;
    return h('div', { class: 'company-item' + (open ? ' open' : '') },
      h('button', { class: 'company-head', onclick: () => { expanded = open ? null : company.key; renderList(); } },
        thumb(company.icon, 64, 'company-icon'),
        h('span', { class: 'company-title' },
          h('span', { class: 'company-name' }, company.name || company.key),
          h('span', { class: 'company-key' }, company.key)),
        company.source !== 'game' && h('span', { class: 'badge source', title: sourceName(company.source) }, sourceName(company.source))),
      open && companyDetails(company));
  });
  if (matches.length > listLimit) {
    rows.push(h('button', { class: 'btn', onclick: () => { listLimit += PAGE; renderList(); } },
      t('common.show_more', { count: matches.length - listLimit })));
  }
  els.list.replaceChildren(...rows);
  els.count.textContent = t('company.count', { count: matches.length, total: store.data.companies.length });
}

function filterSelect(name, label, options) {
  const select = h('select', {
    class: 'input', title: label,
    onchange: () => { filters[name] = select.value; listLimit = PAGE; renderList(); },
  }, h('option', { value: '' }, label), options.map(([value, text]) => h('option', { value }, text)));
  if (options.some(([value]) => value === filters[name])) select.value = filters[name];
  else filters[name] = '';
  return select;
}

function renderRight() {
  const data = store.data;
  const byName = (a, b) => a[1].localeCompare(b[1]);
  const counts = new Map();
  for (const company of data.companies) counts.set(company.source, (counts.get(company.source) || 0) + 1);
  // Base game first, then the mods in load order (the data comes in file name order).
  const rank = new Map(data.sources.map((source, i) => [source.id, i]));
  listed = [...data.companies].sort((a, b) => rank.get(a.source) - rank.get(b.source));
  const sources = data.sources.filter((s) => counts.has(s.id)).map((s) => [s.id, `${sourceName(s.id)} (${counts.get(s.id)})`]);
  const buildings = data.buildings.filter((b) => b.used).map((b) => [b.key, b.name || b.key]).sort(byName);
  const regions = data.regions.map((r) => [r.key, r.name || r.key]).sort(byName);
  els.list = h('div', { class: 'company-list' });
  els.count = h('span', { class: 'muted' });
  const search = h('input', {
    class: 'input', type: 'search', placeholder: t('company.search'), value: filters.query,
    oninput: debounce(() => { filters.query = search.value; listLimit = PAGE; renderList(); }, 150),
  });
  els.right.replaceChildren(
    h('div', { class: 'col-head' }, h('h2', {}, t('company.existing')), els.count),
    h('div', { class: 'filters' },
      search,
      filterSelect('source', t('company.filter_source'), sources),
      filterSelect('building', t('company.filter_building'), buildings),
      filterSelect('region', t('company.filter_region'), regions)),
    els.list);
  renderList();
}
