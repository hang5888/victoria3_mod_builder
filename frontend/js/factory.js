// Factory builder: the mod's contents (sidebar), the factory being edited, the editor,
// and the existing buildings (right).
//
// A factory's production method groups (pmgs) are entries {type: 'ref', key} pointing at an
// existing group, or {type: 'own', ...} written by this mod (mode 'new' or 'override').
// The production methods (pms) of an own group are entries of the same two types.
import { api, textureUrl } from './api.js';
import { t } from './i18n.js';
import { store, refreshState, loadData, language, languageName, nameOf, factoryName, setProject } from './store.js';
import { renderSidebar, refreshSidebar, takePending } from './sidebar.js';
import { h, fill, toast, confirmDialog, openPicker, debounce } from './ui.js';
import { thumb, objectIcon, pickerIcon } from './icons.js';
import { bracesBalanced } from './script.js';
import { STATE_KINDS, conditionEditor, clearConditionCache, countConditions, valueButton } from './conditions.js';
import { run, section, field, objectChip, sourceName, sourceBadges, keyChips, pickerItems, imageField,
  scriptArea as scriptBox } from './widgets.js';

const RAW_BLOCKS = ['potential', 'possible'];
const FIELDS = ['key', 'mode', 'names', 'building_group', 'icon', 'background', 'city_type', 'required_construction',
  'unlocking_technologies', 'ai_value', 'blocks', 'pmgs', 'extra'];
const PM_FIELDS = ['texture', 'is_default', 'inputs', 'outputs', 'employment', 'unlocking_technologies',
  'unlocking_laws', 'modifiers', 'extra'];
const TARGETS = ['building', 'state', 'country'];
const SCALES = ['workforce_scaled', 'level_scaled', 'unscaled', 'throughput_scaled'];
const KEY_PATTERN = /^[A-Za-z0-9_.\-]+$/;
const NUMBER_PATTERN = /^-?\d+(\.\d+)?$/;
const MODIFIER_VALUE_PATTERN = /^(-?\d+(\.\d+)?|yes|no)$/;
const PMG_TEXTURE = 'gfx/interface/icons/generic_icons/mixed_icon_base.dds';
const PAGE = 200;

let root = null;
let editing = null;        // the factory in the editor
let originalKey = null;    // its key in the project file, when it was opened from there
let editingProject = null; // folder of the project `editing` belongs to
let dirty = false;
const filters = { query: '', source: '', group: '', output: '', input: '' };
let listed = [];
let listLimit = PAGE;
let expanded = null;
let goodsCache = null;             // building key -> {inputs, outputs} (sets of goods), for the filters
const versionChoice = new Map();   // building key -> source of the version shown in the list
const chosenPm = new Map();        // pmg entry -> pm entry picked for the estimate
const openPms = new WeakSet();     // pm entries whose editor is unfolded
const els = {};
const sections = {};

window.addEventListener('beforeunload', (event) => {
  if (dirty) event.preventDefault();
});

function blankFactory() {
  const group = store.index && store.index.building_groups.has('bg_light_industry') ? 'bg_light_industry' : '';
  const defaults = groupDefaults(group);
  return {
    key: '', mode: 'new', names: {}, building_group: group, icon: '', background: defaults.background,
    city_type: defaults.city_type, required_construction: 'construction_cost_medium', unlocking_technologies: [],
    ai_value: '', blocks: Object.fromEntries(RAW_BLOCKS.map((name) => [name, ''])), pmgs: [],
    extra: 'ownership_type = self',
  };
}

// The editable part of a building (drops display-only fields such as its source).
function modelOf(factory) {
  const model = structuredClone(Object.fromEntries(FIELDS.map((name) => [name, factory[name]])));
  return { ...blankFactory(), ...model, blocks: { ...blankFactory().blocks, ...model.blocks } };
}

export async function renderFactory(container) {
  root = container;
  await refreshState();
  const data = await loadData();
  const blocked = !data ? 'company.need_data' : !store.state.project ? 'company.need_project' : '';
  if (blocked) {
    root.replaceChildren(h('div', { class: 'notice warn page-notice' }, t(blocked), ' ',
      h('a', { href: '#/' }, t('company.go_home'))));
    return;
  }
  setProject(await api.get('/api/project'));
  if (editingProject !== store.state.project.dir) {
    editing = null;  // nothing open: the start screen
    originalKey = null;
    dirty = false;
    editingProject = store.state.project.dir;
  }
  goodsCache = null;
  els.sidebar = h('aside', { class: 'col col-sidebar' });
  els.left = h('div', { class: 'col col-left' });
  els.middle = h('div', { class: 'col col-middle' });
  els.right = h('div', { class: 'col col-right' });
  root.replaceChildren(h('div', { class: 'builder' }, els.sidebar, els.left, els.middle, els.right));
  renderSidebar(els.sidebar, sidebarEditor);
  renderLeft();
  renderMiddle();
  renderRight();
  // an item of this page clicked in the sidebar of another page
  const wanted = takePending('factory');
  const factory = wanted && wanted !== originalKey && store.project.factories.find((f) => f.key === wanted);
  if (factory) await edit(factory, factory.key);
}

// ----------------------------------------------------------------- helpers

const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const round = (value) => String(Math.round(value * 100) / 100);
const sum = (rows, value) => rows.reduce((total, row) => total + value(row), 0);
const knownName = (item) => (item && item.name && item.name !== item.key ? item.name : '');

// The definition behind an entry: the entry itself when it is the mod's own, else the game's
// (undefined when the reference points at nothing).
const pmgOf = (entry) => (entry.type === 'own' ? entry : store.index.pmgs.get(entry.key));
const pmOf = (entry) => (entry.type === 'own' ? entry : store.index.pms.get(entry.key));

// Name of a group ('pmgs') or method ('pms') entry.
function entryName(kind, entry) {
  if (entry.type !== 'own') return nameOf(kind, entry.key);
  return entry.names[language()] || (entry.mode === 'override' && knownName(store.index[kind].get(entry.key)))
    || entry.names.english || entry.key || t('factory.unnamed_part');
}

function entryKind(entry) {
  return entry.type !== 'own' ? 'ref' : entry.mode === 'override' ? 'override' : 'own';
}

function kindBadge(entry) {
  const kind = entryKind(entry);
  return h('span', { class: 'badge' + (kind === 'own' ? ' accent' : kind === 'override' ? ' warn' : '') },
    t('factory.kind.' + kind));
}

// The method a group starts with: the one marked default, else the first.
function defaultPm(pmg) {
  return pmg.pms.find((entry) => (pmOf(entry) || {}).is_default) || pmg.pms[0];
}

// Value of a method per level at base prices (the same sums the game files note in comments).
function pmValue(pm) {
  if (!pm) return { input: 0, output: 0, profit: 0, jobs: 0 };
  const cost = (good) => (store.index.goods.get(good) || { cost: 0 }).cost;
  const input = sum(pm.inputs, (row) => number(row.amount) * cost(row.good));
  const output = sum(pm.outputs, (row) => number(row.amount) * cost(row.good));
  return { input, output, profit: output - input, jobs: sum(pm.employment, (row) => number(row.amount)) };
}

function goodsAmounts(rows) {
  return rows.map((row) => h('span', { class: 'flow-good', title: nameOf('goods', row.good) },
    objectIcon('goods', row.good) || nameOf('goods', row.good), ' ', row.amount));
}

// "inputs -> outputs" of a method, with the profit per level.
function pmFlow(pm) {
  if (!pm) return null;
  const { profit } = pmValue(pm);
  return h('span', { class: 'pm-flow' },
    goodsAmounts(pm.inputs), (pm.inputs.length > 0 || pm.outputs.length > 0) && h('span', { class: 'muted' }, '→'),
    goodsAmounts(pm.outputs),
    (pm.inputs.length > 0 || pm.outputs.length > 0)
      && h('b', { class: profit > 0 ? 'good' : profit < 0 ? 'bad' : '' }, (profit > 0 ? '+' : '') + round(profit)));
}

// Typical city type and background of the buildings in a group (the game sets them per building).
function groupDefaults(group) {
  const info = store.index && store.index.building_groups.get(group);
  if (!info) return { city_type: '', background: '' };
  const most = (buildings, name) => {
    const counts = new Map();
    for (const building of buildings) {
      if (building[name]) counts.set(building[name], (counts.get(building[name]) || 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1]).map(([value]) => value)[0] || '';
  };
  const same = store.data.factories.filter((f) => f.building_group === group);
  const related = store.data.factories.filter((f) => (store.index.building_groups.get(f.building_group) || {}).root === info.root);
  return { city_type: most(same, 'city_type') || most(related, 'city_type'),
    background: most(same, 'background') || most(related, 'background') };
}

// Keys written by the other factories of the mod.
function projectKeys() {
  const keys = { factories: new Set(), pmgs: new Set(), pms: new Set() };
  for (const factory of store.project.factories) {
    if (factory.key === originalKey) continue;
    keys.factories.add(factory.key);
    for (const pmg of factory.pmgs.filter((entry) => entry.type === 'own')) {
      keys.pmgs.add(pmg.key);
      for (const pm of pmg.pms.filter((entry) => entry.type === 'own')) keys.pms.add(pm.key);
    }
  }
  return keys;
}

// Keys of the factory in the editor: its groups and their own methods.
function editingKeys() {
  if (!editing) return { factories: new Set(), pmgs: new Set(), pms: new Set() };
  const own = editing.pmgs.filter((entry) => entry.type === 'own');
  return { factories: new Set([editing.key]), pmgs: new Set(editing.pmgs.map((entry) => entry.key)),
    pms: new Set(own.flatMap((pmg) => pmg.pms.filter((entry) => entry.type === 'own').map((pm) => pm.key))) };
}

// A key of this kind ('factories', 'pmgs', 'pms') nothing else uses yet.
function freeKey(kind, base) {
  const mine = projectKeys()[kind];
  const here = editingKeys()[kind];
  const taken = (key) => store.index[kind].has(key) || mine.has(key) || here.has(key);
  let key = base;
  for (let n = 2; taken(key); n++) key = `${base}${n}`;
  return key;
}

// Same checks as the backend, so problems show up while typing.
function problems(factory) {
  const found = [];
  const mine = projectKeys();
  const checkKey = (item, kind, seen, prefix) => {
    const { key } = item;
    if (!key) found.push(`${prefix}key_missing`);
    else if (!KEY_PATTERN.test(key)) found.push(`${prefix}key_invalid:${key}`);
    else if (seen.has(key) || mine[kind].has(key) || (item.mode !== 'override' && store.index[kind].has(key))) {
      found.push(`${prefix}key_exists:${key}`);
    }
    seen.add(key);
  };
  checkKey(factory, 'factories', new Set(), '');
  if (!factory.building_group) found.push('group_missing');
  else if (!KEY_PATTERN.test(factory.building_group)) found.push('group_invalid');
  if (!factory.icon) found.push('icon_missing');
  if (factory.city_type && !KEY_PATTERN.test(factory.city_type)) found.push('city_type_invalid');
  const cost = factory.required_construction;
  if (cost && !KEY_PATTERN.test(cost) && !NUMBER_PATTERN.test(cost)) found.push('construction_invalid');
  for (const name of RAW_BLOCKS) if (!bracesBalanced(factory.blocks[name])) found.push('braces:' + name);
  for (const name of ['ai_value', 'extra']) if (!bracesBalanced(factory[name])) found.push('braces:' + name);
  if (!factory.pmgs.length) found.push('pmgs_missing');
  const seenPmgs = new Set();
  const seenPms = new Set();
  for (const pmg of factory.pmgs) {
    if (pmg.type !== 'own') {
      if (seenPmgs.has(pmg.key)) found.push('pmg_key_exists:' + pmg.key);
      seenPmgs.add(pmg.key);
      continue;
    }
    checkKey(pmg, 'pmgs', seenPmgs, 'pmg_');
    const label = pmg.key || '?';
    if (!pmg.pms.length) found.push('pmg_empty:' + label);
    if (!bracesBalanced(pmg.extra)) found.push('braces:' + label);
    const listedPms = new Set();
    for (const pm of pmg.pms) {
      if (listedPms.has(pm.key)) found.push('pm_key_exists:' + pm.key);
      listedPms.add(pm.key);
      if (pm.type !== 'own') continue;
      checkKey(pm, 'pms', seenPms, 'pm_');
      const amounts = [...pm.inputs, ...pm.outputs].map((row) => [row.good, row.amount])
        .concat(pm.employment.map((row) => [row.pop, row.amount]));
      const values = amounts.every(([key, amount]) => KEY_PATTERN.test(key) && NUMBER_PATTERN.test(amount))
        && pm.modifiers.every((m) => KEY_PATTERN.test(m.key) && MODIFIER_VALUE_PATTERN.test(m.value));
      if (!values) found.push('pm_value:' + (pm.key || '?'));
      if (!bracesBalanced(pm.extra)) found.push('braces:' + (pm.key || '?'));
    }
  }
  return [...new Set(found)];
}

// "code" or "code:name" from the checks above or from the backend.
function problemText(code) {
  const at = code.indexOf(':');
  return at < 0 ? t('fproblem.' + code) : t('fproblem.' + code.slice(0, at), { name: code.slice(at + 1) });
}

function changed() {
  dirty = true;
  renderPreview();
  refreshSidebar();
}

function refresh(name) {
  const fresh = builders[name]();
  sections[name].replaceWith(fresh);
  sections[name] = fresh;
}

// After adding, removing or moving groups and methods.
function restructured() {
  changed();
  refresh('pmgs');
}

const scriptArea = (get, set) => scriptBox(get, set, changed);

// -------------------------------------------------------- switching factory

async function edit(factory, key, isDirty = false) {
  if (dirty && !(await confirmDialog(t('factory.discard_confirm'), t('company.discard')))) return;
  editing = modelOf(factory);
  originalKey = key;
  dirty = isDirty;
  chosenPm.clear();
  clearConditionCache();
  renderLeft();
  renderMiddle();
  els.middle.scrollTop = 0;
}

function overrideFactory(factory) {
  const existing = store.project.factories.find((f) => f.key === factory.key);
  if (existing) {
    toast(t('factory.already_in_project'));
    return edit(existing, existing.key);
  }
  return edit({ ...factory, mode: 'override', names: {} }, null, true);
}

function copyFactory(factory) {
  const names = knownName(factory) ? { [language()]: factory.name } : {};
  return edit({ ...factory, mode: 'new', key: freeKey('factories', `${factory.key}_copy`), names }, null, true);
}

async function save() {
  const result = await api.post('/api/project/factory', { factory: editing, original_key: originalKey });
  if (result.errors.length) {
    toast(result.errors.map(problemText).join('\n'), 'error');
    return;
  }
  setProject(result.project);
  originalKey = editing.key;
  dirty = false;
  renderLeft();
  toast(t('company.saved', { dir: result.dir }));
}

// Remove a factory of the project; when it is the one being edited, start a new one.
async function remove(factory) {
  const current = factory.key === originalKey;
  const name = factoryName(current ? editing : factory);
  if (!(await confirmDialog(t('company.delete_confirm', { name }), t('company.delete')))) return;
  setProject(await api.post('/api/project/factory/delete', { key: factory.key }));
  if (current) {
    dirty = false;
    await close();
  } else {
    if (editing) renderPreview();  // key checks depend on the other factories
    refreshSidebar();
  }
  toast(t('company.deleted'));
}

// Leave the editor for the start screen.
async function close() {
  if (dirty && !(await confirmDialog(t('factory.discard_confirm'), t('company.discard')))) return;
  editing = null;
  originalKey = null;
  dirty = false;
  renderLeft();
  renderMiddle();
}

const startFactory = () => run(() => edit(blankFactory(), null));

// What the sidebar needs from this page.
const sidebarEditor = {
  kind: 'factory',
  state: () => ({ key: originalKey, dirty }),
  open: (factory) => edit(factory, factory.key),
  remove,
};

// --------------------------------------------------------------------- left

function renderLeft() {
  if (!editing) {
    fill(els.left,
      h('div', { class: 'col-head' }, h('h2', {}, t('company.editing'))),
      h('p', { class: 'muted' }, t('editor.nothing_open')));
    refreshSidebar();
    return;
  }
  els.preview = h('div', { class: 'preview' });
  fill(els.left,
    h('div', { class: 'col-head' },
      h('h2', {}, t('company.editing')),
      h('button', { class: 'btn primary', onclick: () => run(save) }, t('editor.save'))),
    els.preview,
    h('button', { class: 'btn new-item', onclick: startFactory }, t('factory.new')));
  renderPreview();
  refreshSidebar();
}

// The methods picked for the estimate: per group the chosen one, else its default.
function pickedPms(factory) {
  return factory.pmgs.map((entry) => {
    const pmg = pmgOf(entry);
    if (!pmg || !pmg.pms.length) return null;
    const chosen = chosenPm.get(entry);
    return pmg.pms.includes(chosen) ? chosen : defaultPm(pmg);
  });
}

function estimate(factory) {
  const picked = pickedPms(factory);
  const totals = { input: 0, output: 0, profit: 0, jobs: 0 };
  const goods = { inputs: new Map(), outputs: new Map() };
  for (const entry of picked) {
    const pm = entry && pmOf(entry);
    if (!pm) continue;
    const value = pmValue(pm);
    for (const name of Object.keys(totals)) totals[name] += value[name];
    for (const side of ['inputs', 'outputs']) {
      for (const row of pm[side]) goods[side].set(row.good, (goods[side].get(row.good) || 0) + number(row.amount));
    }
  }
  const rows = (side) => [...goods[side]].filter(([, amount]) => amount !== 0)
    .map(([good, amount]) => ({ good, amount: round(amount) }));
  const groups = factory.pmgs.map((entry, i) => {
    const pmg = pmgOf(entry);
    if (!pmg) return h('div', { class: 'estimate-group' }, h('span', { class: 'bad' }, t('factory.missing', { key: entry.key })));
    const select = h('select', {
      class: 'input', title: entryName('pmgs', entry),
      onchange: () => { chosenPm.set(entry, pmg.pms[Number(select.value)]); renderPreview(); },
    }, pmg.pms.map((pm, n) => h('option', { value: String(n) }, entryName('pms', pm))));
    select.value = String(pmg.pms.indexOf(picked[i]));
    return h('div', { class: 'estimate-group' }, h('span', { class: 'muted small' }, entryName('pmgs', entry)), select);
  });
  const line = (label, value, tone) => h('div', { class: 'estimate-line' },
    h('span', { class: 'muted' }, label), h('b', { class: tone || '' }, value));
  return h('div', { class: 'preview-group' },
    h('h4', {}, t('factory.estimate')),
    groups,
    h('div', { class: 'pm-flow' }, goodsAmounts(rows('inputs')), h('span', { class: 'muted' }, '→'), goodsAmounts(rows('outputs'))),
    line(t('factory.estimate_input'), round(totals.input)),
    line(t('factory.estimate_output'), round(totals.output)),
    line(t('factory.estimate_profit'), (totals.profit > 0 ? '+' : '') + round(totals.profit),
      totals.profit > 0 ? 'good' : totals.profit < 0 ? 'bad' : ''),
    line(t('factory.estimate_jobs'), round(totals.jobs)),
    h('p', { class: 'muted small' }, t('factory.estimate_hint')));
}

function costText(value) {
  const known = store.data.construction_costs.find((cost) => cost.key === value);
  return known ? known.value : value || '—';
}

function renderPreview() {
  const factory = editing;
  const found = problems(factory);
  const notes = [];
  if (factory.mode === 'new' && !Object.values(factory.names).some(Boolean)) notes.push(t('note.no_name'));
  const group = store.index.building_groups.get(factory.building_group);
  if (factory.mode === 'new' && group && group.needs_resources) notes.push(t('factory.resource_note'));
  const filled = store.state.languages.filter((l) => factory.names[l.key]);
  const conditionChips = RAW_BLOCKS.filter((name) => factory.blocks[name].trim()).map((name) =>
    h('span', { class: 'chip', title: name }, `${t('fblock.title.' + name)} · ${countConditions(factory.blocks[name])}`));
  fill(els.preview,
    h('div', { class: 'preview-art' },
      thumb(factory.background, 480, 'preview-background'),
      thumb(factory.icon, 128, 'preview-icon')),
    h('h3', { class: 'preview-name' }, factoryName(factory)),
    h('div', { class: 'preview-meta' },
      h('span', { class: 'company-key' }, factory.key || '—'),
      h('span', { class: 'badge' + (factory.mode === 'override' ? ' accent' : '') }, t('company.mode.' + factory.mode)),
      dirty && h('span', { class: 'badge warn' }, t('company.unsaved'))),
    h('div', { class: 'muted' }, nameOf('building_groups', factory.building_group) || '—',
      ` · ${t('factory.cost_short', { value: costText(factory.required_construction) })}`),
    h('div', { class: 'preview-group' },
      h('h4', {}, t('factory.technologies')),
      factory.unlocking_technologies.length
        ? h('div', { class: 'chips' }, factory.unlocking_technologies.map((key) => objectChip('technologies', key)))
        : h('span', { class: 'muted' }, t('factory.no_technologies'))),
    h('div', { class: 'preview-group' },
      h('h4', {}, t('factory.pmgs')),
      factory.pmgs.length === 0 && h('span', { class: 'muted' }, t('common.none')),
      factory.pmgs.map((entry) => {
        const pmg = pmgOf(entry);
        const first = pmg && defaultPm(pmg);
        return h('div', { class: 'preview-pmg' },
          h('div', {}, entryName('pmgs', entry), ' ', kindBadge(entry)),
          pmg && h('div', { class: 'chips' }, pmg.pms.map((pm) =>
            h('span', { class: 'chip' + (pm === first ? ' filled' : ''), title: pm.key }, entryName('pms', pm)))));
      })),
    factory.pmgs.length > 0 && estimate(factory),
    conditionChips.length > 0 && h('div', { class: 'preview-group' },
      h('h4', {}, t('factory.conditions')), h('div', { class: 'chips' }, conditionChips)),
    h('div', { class: 'preview-group' },
      h('h4', {}, t('company.translations', { count: filled.length, total: store.state.languages.length })),
      h('div', { class: 'chips' }, store.state.languages.map((l) =>
        h('span', { class: 'chip' + (factory.names[l.key] ? ' filled' : ' missing'), title: factory.names[l.key] || '' }, l.name)))),
    found.length > 0 && h('ul', { class: 'problems' }, found.map((code) => h('li', {}, problemText(code)))),
    notes.length > 0 && h('ul', { class: 'notes' }, notes.map((note) => h('li', {}, note))));
}

// ------------------------------------------------------------------- middle

// Key and name inputs of a factory, group or method. `redraw` runs after each edit.
function keyInput(item, placeholder, redraw) {
  const input = h('input', {
    class: 'input mono', type: 'text', spellcheck: false, value: item.key, disabled: item.mode === 'override',
    placeholder, oninput: () => { item.key = input.value.trim(); redraw(); },
  });
  return input;
}

function nameInput(item, placeholder, redraw) {
  const lang = language();
  const input = h('input', {
    class: 'input', type: 'text', value: item.names[lang] || '', placeholder: placeholder || '',
    oninput: () => {
      if (input.value.trim()) item.names[lang] = input.value.trim();
      else delete item.names[lang];
      redraw();
    },
  });
  return input;
}

const nameLabel = () => t('company.name', { language: languageName(language()) });

function basicSection() {
  const factory = editing;
  const original = factory.mode === 'override' ? store.index.factories.get(factory.key) : null;
  const options = store.data.building_groups.filter((g) => g.production || g.key === factory.building_group);
  const group = h('select', {
    class: 'input',
    onchange: () => {
      const before = groupDefaults(factory.building_group);
      const after = groupDefaults(group.value);
      factory.building_group = group.value;
      factory.city_type = after.city_type;
      if (!factory.background || factory.background === before.background) factory.background = after.background;
      changed();
      refresh('basic');
      refresh('images');
    },
  },
    !factory.building_group && h('option', { value: '' }, t('common.choose')),
    options.map((g) => h('option', { value: g.key }, g.name && g.name !== g.key ? `${g.name} (${g.key})` : g.key)));
  group.value = factory.building_group;
  const info = store.index.building_groups.get(factory.building_group);
  const cityTypes = [...new Set(store.data.factories.map((f) => f.city_type).filter(Boolean))].sort();
  const city = h('select', { class: 'input', onchange: () => { factory.city_type = city.value; changed(); } },
    h('option', { value: '' }, t('factory.city_type_none')),
    [...new Set([...cityTypes, factory.city_type].filter(Boolean))].map((type) => h('option', { value: type }, type)));
  city.value = factory.city_type;
  return section(t('company.basic'), null,
    factory.mode === 'override' && h('div', { class: 'notice warn' },
      t('factory.override_note', { source: original ? sourceName(original.source) : '?' })),
    field(t('company.key'), keyInput(factory, 'building_my_factory', changed),
      factory.mode === 'override' ? null : t('factory.key_hint')),
    field(nameLabel(), nameInput(factory, knownName(original), changed),
      factory.mode === 'override' ? t('company.name_hint_override') : t('company.name_hint')),
    field(t('factory.group'), group, t('factory.group_hint')),
    factory.mode === 'new' && info && info.needs_resources && h('div', { class: 'notice warn' }, t('factory.resource_note')),
    field(t('factory.city_type'), city, t('factory.city_type_hint')));
}

function imagesSection() {
  const image = (name, label, paths, wide) => imageField({ label, value: editing[name], paths, wide,
    onChange: (path) => { editing[name] = path; changed(); refresh('images'); } });
  return section(t('company.images'), t('company.images_hint'),
    image('icon', t('company.icon'), store.data.building_icons, false),
    image('background', t('company.background'), store.data.building_backgrounds, true));
}

function unlockSection() {
  const factory = editing;
  const costs = store.data.construction_costs;
  const custom = factory.required_construction && !costs.some((cost) => cost.key === factory.required_construction);
  const amount = h('input', {
    class: 'input level', type: 'number', min: '0', value: custom ? factory.required_construction : '',
    oninput: () => { factory.required_construction = amount.value.trim(); changed(); },
  });
  const select = h('select', {
    class: 'input',
    onchange: () => {
      factory.required_construction = select.value === 'custom' ? '100' : select.value;
      changed();
      refresh('unlock');
    },
  },
    h('option', { value: '' }, t('factory.cost_none')),
    costs.map((cost) => h('option', { value: cost.key }, `${cost.key.replace('construction_cost_', '')} (${cost.value})`)),
    h('option', { value: 'custom' }, t('factory.cost_custom')));
  select.value = custom ? 'custom' : factory.required_construction;
  return section(t('factory.unlock'), null,
    keyChips({ keys: factory.unlocking_technologies, kind: 'technologies', label: t('factory.technologies'),
      hint: t('factory.technologies_hint'),
      onChange: (keys) => { factory.unlocking_technologies = keys; changed(); refresh('unlock'); } }),
    h('div', { class: 'field' },
      h('span', { class: 'field-label' }, t('factory.cost')),
      h('div', { class: 'row' }, select, custom && amount),
      h('span', { class: 'muted small' }, t('factory.cost_hint'))));
}

// ------------------------------------------------- production method groups

function moveButtons(list, index) {
  const move = (step) => {
    const [item] = list.splice(index, 1);
    list.splice(index + step, 0, item);
    restructured();
  };
  return [
    h('button', { class: 'btn icon-btn', title: t('factory.move_up'), disabled: index === 0, onclick: () => move(-1) }, '↑'),
    h('button', { class: 'btn icon-btn', title: t('factory.move_down'), disabled: index === list.length - 1,
      onclick: () => move(1) }, '↓'),
  ];
}

function removeButton(list, index) {
  return h('button', { class: 'btn icon-btn', title: t('common.remove'),
    onclick: () => { list.splice(index, 1); restructured(); } }, '✕');
}

// Names of the other buildings that depend on a group ('pmgs') or a method ('pms'); a method
// in a group no building uses counts through that group. What this factory itself overrides
// is left out. Empty means nothing else is affected by changing it.
function usersOf(kind, key) {
  const buildingsOf = (group) => store.data.factories
    .filter((f) => f.key !== editing.key && f.pmgs.some((entry) => entry.key === group));
  if (kind === 'pmgs') return buildingsOf(key).map((item) => item.name || item.key);
  const groups = store.data.pmgs.filter((g) => g.pms.some((entry) => entry.key === key)
    && !editing.pmgs.some((entry) => entry.type === 'own' && entry.mode === 'override' && entry.key === g.key));
  const names = groups.flatMap((g) => {
    const buildings = buildingsOf(g.key);
    return (buildings.length ? buildings : [g]).map((item) => item.name || item.key);
  });
  return [...new Set(names)];
}

const userNames = (users) => users.slice(0, 8).join(', ') + (users.length > 8 ? '…' : '');

function confirmOverride(users) {
  return confirmDialog(t('factory.override_shared', { count: users.length, names: userNames(users) }),
    t('factory.override_direct'));
}

// What can be done with a referenced group or method. Shared with other buildings: copy it
// for this factory, or override it for all of them (they are listed). Not shared: just edit it.
function referenceActions(kind, key, small, replace) {
  const users = usersOf(kind, key);
  const cls = 'btn' + (small ? ' small' : '');
  if (!users.length) {
    return { note: null, buttons: [h('button', { class: cls, onclick: () => replace('override') }, t('factory.edit'))] };
  }
  return {
    note: h('div', { class: 'shared-note', title: users.join(', ') },
      t('factory.shared_with', { count: users.length, names: userNames(users) })),
    buttons: [
      h('button', { class: cls, title: t('factory.copy_own_hint'), onclick: () => replace('new') }, t('factory.copy_own')),
      h('button', { class: cls, title: t('factory.override_direct_hint'), onclick: () => run(async () => {
        if (await confirmOverride(users)) replace('override');
      }) }, t('factory.override_direct')),
    ],
  };
}

// A copy of an existing method as the mod's own: a new one, or an override of the same key.
function ownPm(key, mode) {
  const source = store.index.pms.get(key);
  if (!source) return { type: 'ref', key };
  const fields = structuredClone(Object.fromEntries(PM_FIELDS.map((name) => [name, source[name]])));
  const copy = mode === 'new';
  return { type: 'own', mode, key: copy ? freeKey('pms', `${key}_copy`) : key,
    names: copy && knownName(source) ? { [language()]: source.name } : {}, ...fields };
}

function ownPmg(key, mode) {
  const source = store.index.pmgs.get(key);
  const copy = mode === 'new';
  const pmg = { type: 'own', mode, key: copy ? freeKey('pmgs', `${key}_copy`) : key,
    names: copy && knownName(source) ? { [language()]: source.name } : {},
    texture: source.texture, extra: source.extra, pms: [] };
  for (const entry of source.pms) {
    // keys of the copies made so far count as taken: add them one by one
    const pm = copy ? ownPm(entry.key, 'new') : { type: 'ref', key: entry.key };
    while (pm.type === 'own' && pmg.pms.some((other) => other.key === pm.key)) pm.key += '_2';
    pmg.pms.push(pm);
  }
  return pmg;
}

function newPm() {
  const pm = { type: 'own', mode: 'new', key: freeKey('pms', 'pm_new'), names: {}, texture: '', is_default: false,
    inputs: [], outputs: [], employment: [], unlocking_technologies: [], unlocking_laws: [], modifiers: [], extra: '' };
  openPms.add(pm);
  return pm;
}

function addRefPmgs() {
  const present = new Set(editing.pmgs.map((entry) => entry.key));
  const users = new Map();
  for (const factory of store.data.factories) {
    for (const entry of factory.pmgs) users.set(entry.key, [...(users.get(entry.key) || []), factory.name || factory.key]);
  }
  // each group shows the icon of its first method
  const firstIcon = (pmg) => ((pmg.pms.length && store.index.pms.get(pmg.pms[0].key)) || { texture: '' }).texture;
  openPicker({
    title: t('factory.add_pmg_ref'), selected: [], roomy: true,
    icon: (item) => (item.icon ? textureUrl(item.icon, 64) : ''),
    items: store.data.pmgs.filter((pmg) => !present.has(pmg.key)).map((pmg) => ({
      key: pmg.key, name: pmg.name || pmg.key, icon: firstIcon(pmg),
      sub: `${pmg.key} · ${userNames(users.get(pmg.key) || ['—'])}` })),
    onDone: (keys) => {
      editing.pmgs.push(...keys.map((key) => ({ type: 'ref', key })));
      restructured();
    },
  });
}

function addOwnPmg() {
  const key = freeKey('pmgs', `pmg_base_${editing.key || 'building_new'}`);
  editing.pmgs.push({ type: 'own', mode: 'new', key, names: {}, texture: PMG_TEXTURE,
    extra: '', pms: [newPm()] });
  restructured();
}

function pmgCard(entry, index) {
  const list = editing.pmgs;
  const pmg = pmgOf(entry);
  const own = entry.type === 'own';
  const title = h('span', { class: 'company-title' });
  const drawTitle = () => fill(title,
    h('span', { class: 'company-name' }, entryName('pmgs', entry)),
    h('span', { class: 'company-key' }, entry.key || '—'));
  drawTitle();
  const head = h('div', { class: 'pmg-head' },
    thumb((pmg && pmg.texture) || '', 64, 'pmg-icon'), title, kindBadge(entry),
    moveButtons(list, index), removeButton(list, index));
  if (!pmg) return h('div', { class: 'pmg-card' }, head, h('div', { class: 'notice warn' }, t('factory.missing', { key: entry.key })));
  if (!own) {
    const actions = referenceActions('pmgs', entry.key, false,
      (mode) => { list[index] = ownPmg(entry.key, mode); restructured(); });
    return h('div', { class: 'pmg-card' }, head, actions.note,
      pmg.pms.map((pm) => pmLine(pm)),
      h('div', { class: 'row' }, actions.buttons));
  }
  const touch = () => { drawTitle(); changed(); };
  const original = entry.mode === 'override' ? store.index.pmgs.get(entry.key) : null;
  return h('div', { class: 'pmg-card own' }, head,
    entry.mode === 'override' && h('div', { class: 'notice warn small' }, t('factory.pmg_override_note')),
    h('div', { class: 'pair' },
      field(t('company.key'), keyInput(entry, 'pmg_my_group', touch)),
      field(nameLabel(), nameInput(entry, knownName(original), touch))),
    imageField({ label: t('factory.pmg_icon'), value: entry.texture, paths: store.data.pmg_icons,
      onChange: (path) => { entry.texture = path; restructured(); } }),
    h('span', { class: 'field-label' }, t('factory.pms')),
    entry.pms.map((pm, n) => (pm.type === 'own' ? pmEditor(entry, pm, n) : pmReference(entry, pm, n))),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: () => { entry.pms.push(newPm()); restructured(); } }, t('factory.add_pm')),
      h('button', { class: 'btn', onclick: () => addRefPms(entry) }, t('factory.add_pm_ref'))),
    h('details', { class: 'cond-script', open: Boolean(entry.extra.trim()) },
      h('summary', {}, t('factory.other_script')),
      h('p', { class: 'muted small' }, t('factory.pmg_extra_hint')),
      scriptArea(() => entry.extra, (value) => { entry.extra = value; })));
}

function addRefPms(pmg) {
  const present = new Set(pmg.pms.map((entry) => entry.key));
  openPicker({
    title: t('factory.add_pm_ref'), selected: [], roomy: true,
    icon: (item) => (item.icon ? textureUrl(item.icon, 64) : ''),
    items: store.data.pms.filter((pm) => !present.has(pm.key)).map((pm) => ({
      key: pm.key, name: pm.name || pm.key, icon: pm.texture, sub: pm.key })),
    onDone: (keys) => {
      pmg.pms.push(...keys.map((key) => ({ type: 'ref', key })));
      restructured();
    },
  });
}

// One method as a line: icon, name, key, what it turns into what.
function pmLine(entry, ...actions) {
  const pm = pmOf(entry);
  return h('div', { class: 'pm-line' },
    thumb((pm && pm.texture) || '', 64, 'pm-icon'),
    h('span', { class: 'company-title' },
      h('span', { class: 'company-name' }, entryName('pms', entry),
        pm && pm.is_default && h('span', { class: 'badge' }, t('factory.default'))),
      h('span', { class: 'company-key' }, entry.key || '—')),
    pm ? pmFlow(pm) : h('span', { class: 'bad small' }, t('factory.missing', { key: entry.key })),
    actions);
}

// A referenced method inside an own group.
function pmReference(pmg, entry, index) {
  const actions = store.index.pms.has(entry.key) ? referenceActions('pms', entry.key, true, (mode) => {
    pmg.pms[index] = ownPm(entry.key, mode);
    openPms.add(pmg.pms[index]);
    restructured();
  }) : { note: null, buttons: [] };
  return h('div', { class: 'pm-reference' },
    pmLine(entry, actions.buttons, moveButtons(pmg.pms, index), removeButton(pmg.pms, index)),
    actions.note);
}

// Rows of "object + amount" (goods in or out, employed pops).
function amountRows(pm, name, objectField, kind, label, startAmount, touch) {
  const rows = pm[name];
  const add = () => openPicker({
    title: label, selected: [], icon: pickerIcon(kind),
    items: pickerItems(kind).filter((item) => !rows.some((row) => row[objectField] === item.key)),
    onDone: (keys) => {
      rows.push(...keys.map((key) => ({ [objectField]: key, amount: startAmount })));
      restructured();
    },
  });
  return h('div', { class: 'amounts' },
    h('div', { class: 'row' }, h('span', { class: 'field-label' }, label),
      h('button', { class: 'btn small', onclick: add }, t('factory.add'))),
    rows.map((row, index) => {
      const amount = h('input', {
        class: 'input mono amount' + (NUMBER_PATTERN.test(row.amount) ? '' : ' invalid'), type: 'text', value: row.amount,
        oninput: () => {
          row.amount = amount.value.trim();
          amount.classList.toggle('invalid', !NUMBER_PATTERN.test(row.amount));
          touch();
        },
      });
      return h('div', { class: 'amount-row' },
        valueButton({ kind, title: label, keys: [row[objectField]],
          onDone: ([key]) => { if (key) row[objectField] = key; restructured(); } }),
        amount, removeButton(rows, index));
    }),
    rows.length === 0 && h('span', { class: 'muted small' }, t('common.none')));
}

function modifierRows(pm, touch) {
  const add = () => openPicker({
    title: t('factory.modifiers'), selected: [],
    items: store.data.modifiers.map((m) => ({ key: m.key, name: m.name || m.key, sub: m.key })),
    onDone: (keys) => {
      pm.modifiers.push(...keys.map((key) => {
        const target = key.startsWith('state_') ? 'state' : key.startsWith('building_') ? 'building' : 'country';
        return { target, scale: target === 'building' ? 'unscaled' : 'workforce_scaled', key, value: '0.1' };
      }));
      restructured();
    },
  });
  const choice = (modifier, name, options, label) => {
    const select = h('select', { class: 'input', onchange: () => { modifier[name] = select.value; touch(); } },
      options.map((value) => h('option', { value }, label(value))));
    select.value = modifier[name];
    return select;
  };
  return h('div', { class: 'amounts' },
    h('div', { class: 'row' }, h('span', { class: 'field-label' }, t('factory.modifiers')),
      h('button', { class: 'btn small', onclick: add }, t('factory.add'))),
    h('p', { class: 'muted small' }, t('factory.modifiers_hint')),
    pm.modifiers.map((modifier, index) => {
      const value = h('input', {
        class: 'input mono amount' + (MODIFIER_VALUE_PATTERN.test(modifier.value) ? '' : ' invalid'), type: 'text',
        value: modifier.value,
        oninput: () => {
          modifier.value = value.value.trim();
          value.classList.toggle('invalid', !MODIFIER_VALUE_PATTERN.test(modifier.value));
          touch();
        },
      });
      return h('div', { class: 'modifier-row' },
        h('span', { class: 'grow' },
          h('span', {}, nameOf('modifiers', modifier.key)),
          h('span', { class: 'company-key' }, modifier.key)),
        value, choice(modifier, 'target', TARGETS, (target) => t('factory.target.' + target)),
        choice(modifier, 'scale', SCALES, (scale) => t('factory.scale.' + scale)),
        removeButton(pm.modifiers, index));
    }));
}

// An own method: a line that unfolds into its editor.
function pmEditor(pmg, pm, index) {
  const summary = h('summary', {});
  const drawSummary = () => fill(summary, pmLine(pm, kindBadge(pm)));
  const touch = () => { drawSummary(); changed(); };
  drawSummary();
  const original = pm.mode === 'override' ? store.index.pms.get(pm.key) : null;
  return h('details', {
    class: 'pm-card', open: openPms.has(pm),
    ontoggle: (event) => { if (event.target.open) openPms.add(pm); else openPms.delete(pm); },
  },
    summary,
    pm.mode === 'override' && h('div', { class: 'notice warn small' }, t('factory.pm_override_note')),
    h('div', { class: 'pair' },
      field(t('company.key'), keyInput(pm, 'pm_my_method', touch)),
      field(nameLabel(), nameInput(pm, knownName(original), touch))),
    imageField({ label: t('factory.pm_icon'), value: pm.texture, paths: store.data.pm_icons,
      onChange: (path) => { pm.texture = path; restructured(); } }),
    h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: pm.is_default, onchange: (event) => {
        // only one method of a group can be its default
        for (const other of pmg.pms) if (other.type === 'own') other.is_default = false;
        pm.is_default = event.target.checked;
        restructured();
      } }),
      t('factory.is_default')),
    amountRows(pm, 'inputs', 'good', 'goods', t('factory.inputs'), '10', touch),
    amountRows(pm, 'outputs', 'good', 'goods', t('factory.outputs'), '10', touch),
    amountRows(pm, 'employment', 'pop', 'pop_types', t('factory.employment'), '1000', touch),
    keyChips({ keys: pm.unlocking_technologies, kind: 'technologies', label: t('factory.technologies'),
      onChange: (keys) => { pm.unlocking_technologies = keys; restructured(); } }),
    keyChips({ keys: pm.unlocking_laws, kind: 'laws', label: t('factory.laws'),
      onChange: (keys) => { pm.unlocking_laws = keys; restructured(); } }),
    modifierRows(pm, touch),
    h('details', { class: 'cond-script', open: Boolean(pm.extra.trim()) },
      h('summary', {}, t('factory.other_script')),
      h('p', { class: 'muted small' }, t('factory.pm_extra_hint')),
      scriptArea(() => pm.extra, (value) => { pm.extra = value; })),
    h('div', { class: 'row pm-actions' }, moveButtons(pmg.pms, index),
      h('button', { class: 'btn danger', onclick: () => { pmg.pms.splice(index, 1); restructured(); } },
        t('factory.remove_pm'))));
}

function pmgsSection() {
  return section(t('factory.pmgs'), t('factory.pmgs_hint'),
    editing.pmgs.map((entry, index) => pmgCard(entry, index)),
    editing.pmgs.length === 0 && h('p', { class: 'muted' }, t('factory.pmgs_empty')),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: addRefPmgs }, t('factory.add_pmg_ref')),
      h('button', { class: 'btn', onclick: addOwnPmg }, t('factory.add_pmg_own'))));
}

// ---------------------------------------------------- conditions, AI, other

function conditionsSection() {
  const factory = editing;
  const block = (name) => h('div', { class: 'cond-block' },
    h('div', { class: 'cond-head' },
      h('span', { class: 'field-label' }, t('fblock.title.' + name)),
      h('span', { class: 'mono muted small' }, name)),
    h('p', { class: 'muted small' }, t('fblock.' + name)),
    conditionEditor({
      id: 'factory.' + name, kinds: STATE_KINDS,
      get: () => factory.blocks[name],
      set: (text) => { factory.blocks[name] = text; changed(); },
    }));
  return section(t('factory.conditions'), t('factory.conditions_hint'), block('potential'), block('possible'));
}

function aiSection() {
  const factory = editing;
  const plain = factory.ai_value.trim() === '' || NUMBER_PATTERN.test(factory.ai_value.trim());
  const input = h('input', {
    class: 'input level', type: 'number', step: 'any', value: plain ? factory.ai_value.trim() : '',
    oninput: () => { factory.ai_value = input.value.trim(); changed(); },
  });
  return section(t('factory.ai_value'), t('factory.ai_value_hint'),
    plain ? input : [h('p', { class: 'notice warn' }, t('factory.ai_value_script')),
      scriptArea(() => factory.ai_value, (value) => { factory.ai_value = value; })]);
}

function advancedSection() {
  const factory = editing;
  return section(t('company.advanced'), null,
    h('div', { class: 'script-field' },
      h('span', { class: 'field-label' }, t('factory.other_script')),
      h('p', { class: 'muted small' }, t('factory.extra_hint')),
      scriptArea(() => factory.extra, (value) => { factory.extra = value; })));
}

const builders = {
  basic: basicSection,
  images: imagesSection,
  unlock: unlockSection,
  pmgs: pmgsSection,
  conditions: conditionsSection,
  ai: aiSection,
  advanced: advancedSection,
};

function renderMiddle() {
  if (!editing) {
    // The start screen: nothing is being edited yet.
    fill(els.middle, h('div', { class: 'editor-start' },
      h('button', { class: 'btn primary start-button', onclick: startFactory }, t('factory.new')),
      h('p', { class: 'muted' }, t('editor.start_hint'))));
    return;
  }
  const scroll = els.middle.scrollTop;
  for (const name of Object.keys(builders)) sections[name] = builders[name]();
  fill(els.middle,
    h('div', { class: 'editor-bar' },
      h('button', { class: 'btn icon-btn', title: t('editor.close'), onclick: () => run(close) }, '✕')),
    Object.values(sections));
  els.middle.scrollTop = scroll;
}

// -------------------------------------------------------------------- right

// Goods a building can take in and put out, over all methods of all its groups.
function goodsOf(factory) {
  if (!goodsCache) goodsCache = new Map();
  if (!goodsCache.has(factory.key)) {
    const goods = { inputs: new Set(), outputs: new Set() };
    for (const entry of factory.pmgs) {
      for (const pmEntry of (pmgOf(entry) || { pms: [] }).pms) {
        const pm = pmOf(pmEntry);
        if (!pm) continue;
        for (const row of pm.inputs) goods.inputs.add(row.good);
        for (const row of pm.outputs) goods.outputs.add(row.good);
      }
    }
    goodsCache.set(factory.key, goods);
  }
  return goodsCache.get(factory.key);
}

function matchesFilters(factory) {
  const query = filters.query.trim().toLowerCase();
  if (query && !(factory.name || '').toLowerCase().includes(query) && !factory.key.toLowerCase().includes(query)) return false;
  if (filters.source && !factory.sources.includes(filters.source)) return false;
  if (filters.group && !groupChain(factory.building_group).includes(filters.group)) return false;
  if (filters.output && !goodsOf(factory).outputs.has(filters.output)) return false;
  if (filters.input && !goodsOf(factory).inputs.has(filters.input)) return false;
  return true;
}

// A building group and the groups above it.
function groupChain(group) {
  const chain = [];
  while (group && !chain.includes(group)) {
    chain.push(group);
    group = (store.index.building_groups.get(group) || {}).parent;
  }
  return chain;
}

// Group filter options as a tree: each group under its parent, indented, with the number of
// buildings in it and the groups below it.
function groupOptions(counts) {
  const children = new Map();
  for (const key of counts.keys()) {
    const parent = (store.index.building_groups.get(key) || {}).parent || '';
    const top = counts.has(parent) ? parent : '';
    if (!children.has(top)) children.set(top, []);
    children.get(top).push(key);
  }
  const options = [];
  const walk = (parent, depth) => {
    const keys = (children.get(parent) || []).sort((a, b) => nameOf('building_groups', a).localeCompare(nameOf('building_groups', b)));
    for (const key of keys) {
      options.push([key, `${'   '.repeat(depth)}${nameOf('building_groups', key)} (${counts.get(key)})`]);
      walk(key, depth + 1);
    }
  };
  walk('', 0);
  return options;
}

// The version of a building shown in the list: the one in effect, or an earlier one picked
// from its sources.
function shownVersion(factory) {
  const version = factory.versions.find((v) => v.source === versionChoice.get(factory.key));
  return version ? { ...factory, ...version } : factory;
}

function versionPicker(factory) {
  const last = factory.sources[factory.sources.length - 1];
  const choice = versionChoice.get(factory.key);
  const version = factory.versions.find((v) => v.source === choice);
  const current = version ? choice : last;
  const same = version && FIELDS.every((name) => JSON.stringify(version[name]) === JSON.stringify(factory[name]));
  return h('div', {},
    h('div', { class: 'detail-chips' }, h('span', { class: 'muted' }, `${t('company.version')}: `),
      factory.sources.map((id) => h('button', {
        class: 'btn small' + (id === current ? ' selected' : ''),
        title: id === last ? t('company.source_active', { source: sourceName(id) }) : sourceName(id),
        onclick: () => { versionChoice.set(factory.key, id); renderList(); },
      }, sourceName(id)))),
    h('div', { class: 'muted small' }, t('version_note.' + (!version ? 'active' : same ? 'same' : 'shown'))));
}

function factoryDetails(factory) {
  const shown = shownVersion(factory);
  const picked = pickedPms(shown).map((entry) => entry && pmOf(entry)).filter(Boolean);
  const profit = sum(picked, (pm) => pmValue(pm).profit);
  return h('div', { class: 'company-details' },
    factory.sources.length > 1 && versionPicker(factory),
    h('div', {}, h('span', { class: 'muted' }, `${t('factory.group')}: `), nameOf('building_groups', shown.building_group),
      ` · ${t('factory.cost_short', { value: costText(shown.required_construction) })}`),
    shown.unlocking_technologies.length > 0 && h('div', { class: 'detail-chips' },
      h('span', { class: 'muted' }, `${t('factory.technologies')}: `),
      shown.unlocking_technologies.map((key) => objectChip('technologies', key))),
    shown.pmgs.map((entry) => {
      const pmg = pmgOf(entry);
      return h('div', {}, h('span', { class: 'muted' }, `${entryName('pmgs', entry)}: `),
        pmg ? pmg.pms.map((pm) => entryName('pms', pm)).join(', ') : t('factory.missing', { key: entry.key }));
    }),
    picked.length > 0 && h('div', {}, h('span', { class: 'muted' }, `${t('factory.estimate_profit')}: `),
      h('b', { class: profit > 0 ? 'good' : profit < 0 ? 'bad' : '' }, (profit > 0 ? '+' : '') + round(profit))),
    h('div', { class: 'muted small' }, `${sourceName(shown.source)} · ${shown.file}`),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: () => run(() => overrideFactory(shown)) }, t('company.override')),
      h('button', { class: 'btn', onclick: () => run(() => copyFactory(shown)) }, t('factory.copy'))));
}

function renderList() {
  const matches = listed.filter(matchesFilters);
  const rows = matches.slice(0, listLimit).map((factory) => {
    const open = expanded === factory.key;
    return h('div', { class: 'company-item' + (open ? ' open' : '') },
      h('button', { class: 'company-head', onclick: () => { expanded = open ? null : factory.key; renderList(); } },
        thumb(factory.icon, 64, 'company-icon'),
        h('span', { class: 'company-title' },
          h('span', { class: 'company-name' }, factory.name || factory.key),
          h('span', { class: 'company-key' }, factory.key)),
        sourceBadges(factory)),
      open && factoryDetails(factory));
  });
  if (matches.length > listLimit) {
    rows.push(h('button', { class: 'btn', onclick: () => { listLimit += PAGE; renderList(); } },
      t('common.show_more', { count: matches.length - listLimit })));
  }
  els.list.replaceChildren(...rows);
  els.count.textContent = t('company.count', { count: matches.length, total: store.data.factories.length });
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
  const count = (keysOf) => {
    const counts = new Map();
    for (const factory of data.factories) for (const key of keysOf(factory)) counts.set(key, (counts.get(key) || 0) + 1);
    return counts;
  };
  const options = (counts, kind) => [...counts].map(([key, n]) => [key, `${nameOf(kind, key)} (${n})`]).sort(byName);
  const sourceCounts = count((factory) => factory.sources);
  // Base game first, then the mods in load order, each building where it was first defined.
  const rank = new Map(data.sources.map((source, i) => [source.id, i]));
  listed = [...data.factories].sort((a, b) => rank.get(a.sources[0]) - rank.get(b.sources[0]));
  const sources = data.sources.filter((s) => sourceCounts.has(s.id))
    .map((s) => [s.id, `${sourceName(s.id)} (${sourceCounts.get(s.id)})`]);
  els.list = h('div', { class: 'company-list' });
  els.count = h('span', { class: 'muted' });
  const search = h('input', {
    class: 'input', type: 'search', placeholder: t('company.search'), value: filters.query,
    oninput: debounce(() => { filters.query = search.value; listLimit = PAGE; renderList(); }, 150),
  });
  els.right.replaceChildren(
    h('div', { class: 'col-head' }, h('h2', {}, t('factory.existing')), els.count),
    h('div', { class: 'filters' },
      search,
      filterSelect('source', t('company.filter_source'), sources),
      filterSelect('group', t('factory.filter_group'), groupOptions(count((factory) => groupChain(factory.building_group)))),
      filterSelect('output', t('factory.filter_output'), options(count((factory) => goodsOf(factory).outputs), 'goods')),
      filterSelect('input', t('factory.filter_input'), options(count((factory) => goodsOf(factory).inputs), 'goods'))),
    els.list);
  renderList();
}
