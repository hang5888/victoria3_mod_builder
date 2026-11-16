// Building builders: the mod's contents (sidebar), the building being edited, the editor,
// and the existing buildings (right). Two pages are built from this module: production
// buildings ("factory") and monuments ("monument", see docs/mod_types/monument.md). They share
// the editor; KINDS holds what differs, and each page keeps its own state.
//
// A building's production method groups (pmgs) are entries {type: 'ref', key} pointing at an
// existing group, or {type: 'own', ...} written by this mod (mode 'new' or 'override').
// The production methods (pms) of an own group are entries of the same two types.
//
// A monument also has `location` {state, x, z, locator}, `history` (owner tag when it exists at
// the start) and `effects`: 'simple' (one own group with one method, edited as a list of
// effects) or 'full' (groups as in factories).
import { api, textureUrl } from './api.js';
import { t } from './i18n.js';
import { store, refreshState, loadData, language, languageName, nameOf, factoryName, monumentName, setProject,
  editingImages, keptImages } from './store.js';
import { renderSidebar, refreshSidebar, takePending } from './sidebar.js';
import { h, fill, toast, confirmDialog, openPicker, debounce } from './ui.js';
import { thumb, objectIcon, pickerIcon } from './icons.js';
import { bracesBalanced, scriptValue, setScriptValue } from './script.js';
import { StateMap } from './map.js';
import { scriptFields, splitScript, joinScript, usedValues } from './scriptfields.js';
import { COUNTRY_KINDS, STATE_KINDS, conditionEditor, clearConditionCache, countConditions, valueButton } from './conditions.js';
import { run, section, field, objectChip, sourceName, sourceBadges, keyChips, pickerItems, imageField,
  scriptArea as scriptBox } from './widgets.js';

const RAW_BLOCKS = ['potential', 'possible'];
const FIELDS = ['key', 'mode', 'names', 'building_group', 'icon', 'background', 'city_type', 'required_construction',
  'unlocking_technologies', 'ai_value', 'blocks', 'pmgs', 'extra', 'location', 'history', 'effects'];
const PM_FIELDS = ['texture', 'is_default', 'inputs', 'outputs', 'employment', 'unlocking_technologies',
  'unlocking_laws', 'modifiers', 'extra'];
const TARGETS = ['building', 'state', 'country'];
const SCALES = ['workforce_scaled', 'level_scaled', 'unscaled', 'throughput_scaled'];
const KEY_PATTERN = /^[A-Za-z0-9_.\-]+$/;
const NUMBER_PATTERN = /^-?\d+(\.\d+)?$/;
const MODIFIER_VALUE_PATTERN = /^(-?\d+(\.\d+)?|yes|no)$/;
const PMG_TEXTURE = 'gfx/interface/icons/generic_icons/mixed_icon_base.dds';
const WONDER_TEXTURE = 'gfx/interface/icons/production_method_icons/wonders.dds';
const MONUMENT_GROUPS = ['bg_monuments', 'bg_skyscraper'];
const PAGE = 200;

// What differs between the pages.
const KINDS = {
  factory: {
    name: 'factory', list: 'factories', placeholder: 'building_my_factory', displayName: factoryName,
    newLabel: () => t('factory.new'), existing: () => t('factory.existing'), copyLabel: () => t('factory.copy'),
    discardText: () => t('factory.discard_confirm'), alreadyText: () => t('factory.already_in_project'),
  },
  monument: {
    name: 'monument', list: 'monuments', placeholder: 'building_my_monument', displayName: monumentName,
    newLabel: () => t('monument.new'), existing: () => t('monument.existing'), copyLabel: () => t('monument.copy'),
    discardText: () => t('monument.discard_confirm'), alreadyText: () => t('monument.already_in_project'),
  },
};

const freshPage = (filters) => ({ editing: null, originalKey: null, editingProject: null, dirty: false, filters,
  listLimit: PAGE, expanded: null });
const pages = {
  factory: freshPage({ query: '', source: '', group: '', output: '', input: '' }),
  monument: freshPage({ query: '', source: '', group: '', region: '' }),
};
let kind = KINDS.factory;

let root = null;
let editing = null;        // the building in the editor
let originalKey = null;    // its key in the project file, when it was opened from there
let editingProject = null; // folder of the project `editing` belongs to
let dirty = false;
let filters = pages.factory.filters;
let listed = [];
let listLimit = PAGE;
let expanded = null;
let locationMap = null;    // the map of the monument page
let locationMapData = null;

// Make `name` the page this module works on: keep the state of the other one.
function usePage(name) {
  if (kind.name === name) return;
  Object.assign(pages[kind.name], { editing, originalKey, editingProject, dirty, filters, listLimit, expanded });
  kind = KINDS[name];
  ({ editing, originalKey, editingProject, dirty, filters, listLimit, expanded } = pages[name]);
}

// The building open on a page, whether or not it is the one shown.
const editingOn = (name) => (name === kind.name ? editing : pages[name].editing);
const isMonumentPage = () => kind.name === 'monument';
let goodsCache = null;             // building key -> {inputs, outputs} (sets of goods), for the filters
const versionChoice = new Map();   // building key -> source of the version shown in the list
const chosenPm = new Map();        // pmg entry -> pm entry picked for the estimate
const openPms = new WeakSet();     // pm entries whose editor is unfolded
const els = {};
const sections = {};

window.addEventListener('beforeunload', (event) => {
  if (dirty || Object.entries(pages).some(([name, page]) => name !== kind.name && page.dirty)) event.preventDefault();
});

function blankFactory() {
  if (isMonumentPage()) return blankMonument();
  const group = store.index && store.index.building_groups.has('bg_light_industry') ? 'bg_light_industry' : '';
  const defaults = groupDefaults(group);
  return {
    key: '', mode: 'new', names: {}, building_group: group, icon: '', background: defaults.background,
    city_type: defaults.city_type, required_construction: 'construction_cost_medium', unlocking_technologies: [],
    ai_value: '', blocks: Object.fromEntries(RAW_BLOCKS.map((name) => [name, ''])), pmgs: [],
    extra: 'ownership_type = self\nlevels_per_mesh = 50',
  };
}

// A new monument as the base game writes them, with a list of effects.
function blankMonument() {
  return {
    key: '', mode: 'new', names: {}, building_group: 'bg_monuments', icon: '',
    background: groupDefaults('bg_monuments').background, city_type: '', required_construction: 'construction_cost_monument',
    unlocking_technologies: [], ai_value: '', blocks: Object.fromEntries(RAW_BLOCKS.map((name) => [name, ''])),
    pmgs: [simpleGroup(null)],
    extra: 'expandable = no\ndownsizeable = no\nunique = yes\nentity_not_constructed = { }\n'
      + 'entity_under_construction = { "building_construction_3x3_entity" }\ncity_gfx_interactions = {\n\tclear_size_area = yes\n\tsize = 3\n}',
    location: { state: '', x: null, z: null, locator: '' }, history: '', effects: 'simple',
  };
}

// The editable part of a building (drops display-only fields such as its source).
function modelOf(factory) {
  const blank = blankFactory();
  const model = structuredClone(Object.fromEntries(FIELDS.filter((name) => factory[name] !== undefined && name in blank)
    .map((name) => [name, factory[name]])));
  return { ...blank, ...model, blocks: { ...blank.blocks, ...model.blocks } };
}

export function renderFactory(container) {
  return renderPage(container, 'factory');
}

export function renderMonument(container) {
  return renderPage(container, 'monument');
}

async function renderPage(container, name) {
  usePage(name);
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
  const wanted = takePending(kind.name);
  const item = wanted && wanted !== originalKey && store.project[kind.list].find((f) => f.key === wanted);
  if (item) await edit(item, item.key);
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

// Keys written by the other factories and monuments of the mod (they share one set of keys).
function projectKeys() {
  const keys = { factories: new Set(), pmgs: new Set(), pms: new Set() };
  const others = [...store.project.factories, ...(store.project.monuments || [])];
  for (const factory of others) {
    if (factory.key === originalKey && store.project[kind.list].includes(factory)) continue;
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
  if (factory.history && !factory.location.state) found.push('history_state');
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
  syncSimpleKeys();
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
  if (dirty && !(await confirmDialog(kind.discardText(), t('company.discard')))) return;
  editing = modelOf(factory);
  originalKey = key;
  dirty = isDirty;
  syncSimpleKeys();
  chosenPm.clear();
  clearConditionCache();
  renderLeft();
  renderMiddle();
  els.middle.scrollTop = 0;
}

function overrideFactory(factory) {
  const existing = store.project[kind.list].find((f) => f.key === factory.key);
  if (existing) {
    toast(kind.alreadyText());
    return edit(existing, existing.key);
  }
  const item = { ...factory, mode: 'override', names: {} };
  return edit(isMonumentPage() ? asMonument(item, factory) : item, null, true);
}

function copyFactory(factory) {
  const names = knownName(factory) ? { [language()]: factory.name } : {};
  const item = { ...factory, mode: 'new', key: freeKey('factories', `${factory.key}_copy`), names };
  return edit(isMonumentPage() ? asMonument(item, factory) : item, null, true);
}

async function save() {
  const result = await api.post(`/api/project/${kind.name}`,
    { [kind.name]: editing, original_key: originalKey, keep_images: keptImages() });
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
  const name = kind.displayName(current ? editing : factory);
  if (!(await confirmDialog(t('company.delete_confirm', { name }), t('company.delete')))) return;
  setProject(await api.post(`/api/project/${kind.name}/delete`,
    { key: factory.key, keep_images: keptImages(current ? kind.name : null) }));
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
  if (dirty && !(await confirmDialog(kind.discardText(), t('company.discard')))) return;
  editing = null;
  originalKey = null;
  dirty = false;
  renderLeft();
  renderMiddle();
}

const startFactory = () => run(() => edit(blankFactory(), null));

// Images of a building and its own groups and methods.
function imagesOf(item) {
  if (!item) return [];
  const own = item.pmgs.filter((entry) => entry.type === 'own');
  return [item.icon, item.background, ...own.map((pmg) => pmg.texture),
    ...own.flatMap((pmg) => pmg.pms.filter((pm) => pm.type === 'own').map((pm) => pm.texture))];
}
editingImages.set('factory', () => imagesOf(editingOn('factory')));
editingImages.set('monument', () => imagesOf(editingOn('monument')));

// What the sidebar needs from this page.
const sidebarEditor = {
  get kind() { return kind.name; },
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
    h('button', { class: 'btn new-item', onclick: startFactory }, kind.newLabel()));
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
  if (isMonumentPage()) notes.push(...monumentNotes(factory));
  const filled = store.state.languages.filter((l) => factory.names[l.key]);
  const conditionChips = RAW_BLOCKS.filter((name) => factory.blocks[name].trim()).map((name) =>
    h('span', { class: 'chip', title: name }, `${t('fblock.title.' + name)} · ${countConditions(factory.blocks[name])}`));
  fill(els.preview,
    h('div', { class: 'preview-art' },
      thumb(factory.background, 480, 'preview-background'),
      thumb(factory.icon, 128, 'preview-icon')),
    h('h3', { class: 'preview-name' }, kind.displayName(factory)),
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
    isMonumentPage() && monumentPreview(factory),
    !(isMonumentPage() && factory.effects === 'simple') && h('div', { class: 'preview-group' },
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
    !isMonumentPage() && factory.pmgs.length > 0 && estimate(factory),
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
  const options = store.data.building_groups.filter((g) => g.key === factory.building_group
    || (isMonumentPage() ? MONUMENT_GROUPS.includes(g.key) : g.production));
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
    field(t('company.key'), keyInput(factory, kind.placeholder, changed),
      factory.mode === 'override' ? null : t('factory.key_hint')),
    field(nameLabel(), nameInput(factory, knownName(original), changed),
      factory.mode === 'override' ? t('company.name_hint_override') : t('company.name_hint')),
    field(t('factory.group'), group, isMonumentPage() ? t('monument.group_hint') : t('factory.group_hint')),
    factory.mode === 'new' && info && info.needs_resources && h('div', { class: 'notice warn' }, t('factory.resource_note')),
    !isMonumentPage() && field(t('factory.city_type'), city, t('factory.city_type_hint')));
}

function imagesSection() {
  const image = (name, label, paths, wide) => imageField({ label, value: editing[name], paths, wide, kind: `building_${name}`,
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
    imageField({ label: t('factory.pmg_icon'), value: entry.texture, paths: store.data.pmg_icons, kind: 'pmg_icon',
      onChange: (path) => { entry.texture = path; restructured(); } }),
    h('span', { class: 'field-label' }, t('factory.pms')),
    entry.pms.map((pm, n) => (pm.type === 'own' ? pmEditor(entry, pm, n) : pmReference(entry, pm, n))),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: () => { entry.pms.push(newPm()); restructured(); } }, t('factory.add_pm')),
      h('button', { class: 'btn', onclick: () => addRefPms(entry) }, t('factory.add_pm_ref'))),
    scriptFields({ scope: 'pmg', fields: PMG_SCRIPT_FIELDS, get: () => entry.extra,
      write: (text) => { entry.extra = text; restructured(); } }),
    h('details', { class: 'cond-script', open: hasUnknown(entry, PMG_KEYS) },
      h('summary', {}, t('factory.other_script')),
      h('p', { class: 'muted small' }, t('factory.pmg_extra_hint')),
      unknownBox(entry, PMG_KEYS, restructured)));
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

function modifierRows(pm, touch, label = t('factory.modifiers')) {
  const add = () => openPicker({
    title: label, selected: [],
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
    h('div', { class: 'row' }, h('span', { class: 'field-label' }, label),
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
    imageField({ label: t('factory.pm_icon'), value: pm.texture, paths: store.data.pm_icons, kind: 'pm_icon',
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
    scriptFields({ scope: 'pm', fields: PM_SCRIPT_FIELDS, groups: PM_GROUPS, get: () => pm.extra,
      write: (text, redraw) => { pm.extra = text; if (redraw) restructured(); else touch(); } }),
    h('details', { class: 'cond-script', open: hasUnknown(pm, PM_KEYS) },
      h('summary', {}, t('factory.other_script')),
      h('p', { class: 'muted small' }, t('factory.pm_extra_hint')),
      unknownBox(pm, PM_KEYS, restructured)),
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

// ------------------------------------------------------- script fields
//
// The fields of a building, group or method that have no editor of their own above are kept
// in its other script (`extra`). The known ones are edited as form controls (scriptfields.js);
// the text box only shows what the tool does not know, for example fields added by mods.

const no = (value) => value === 'no';
const given = (value) => (Array.isArray(value) ? value.length > 0 : Boolean(value));
const OWNERSHIP = ['self', 'other', 'no_ownership'];
const flag = (key, fallback, more = {}) => ({ key, kind: 'flag', default: fallback, ...more });
const buildingTexts = () => store.data.factories.map((factory) => factory.extra);

// Only fields of production buildings: those of monuments, ports, military buildings, canals and
// statues are not offered (they stay in the other script of a building copied from one).
const BUILDING_GROUPS = ['economy', 'conditions', 'misc'];
const BUILDING_SCRIPT_FIELDS = [
  { key: 'ownership_type', kind: 'select', options: OWNERSHIP, hint: true, risky: (value) => value !== 'self',
    label: (option) => (OWNERSHIP.includes(option) ? `${t('fset.ownership.' + option)} (${option})` : option) },
  { key: 'terrain_manipulator', kind: 'select', options: () => usedValues(buildingTexts(), 'terrain_manipulator'), hint: true,
    risky: (value) => typeof value === 'string' && value.startsWith('urban_') },
  { key: 'levels_per_mesh', kind: 'number', hint: true },
  { key: 'ai_nationalization_desire', kind: 'number', hint: true },
  flag('buildable', true, { risky: no }),
  flag('expandable', true, { risky: no }),
  flag('downsizeable', true),
  { key: 'aliases', kind: 'keys', hint: true, risky: given },

  flag('can_switch_owner', true, { group: 'economy', hint: true }),
  { key: 'min_raise_to_hire', group: 'economy', kind: 'number', hint: true },
  { key: 'slaves_role', group: 'economy', kind: 'key', pick: 'pop_types', hint: true },
  { key: 'economic_contribution', group: 'economy', kind: 'number', hint: true },
  { key: 'residence_points_per_level', group: 'economy', kind: 'number', hint: true },
  flag('generates_residences', true, { group: 'economy', hint: true }),
  { key: 'category_building_type', group: 'economy', kind: 'key', pick: 'buildings', hint: true },
  { key: 'valid_pop_culture_traits', group: 'economy', kind: 'keys', pick: 'culture_traits', hint: true },
  { key: 'investment_scores', group: 'economy', kind: 'block', hint: true },

  flag('ignore_stateregion_max_level', false, { group: 'misc', hint: true }),
  { key: 'lens', group: 'misc', kind: 'key', pick: 'lenses', hint: true },

  { key: 'can_build_government', group: 'conditions', kind: 'conditions', kinds: STATE_KINDS, hint: true },
  { key: 'can_build_private', group: 'conditions', kind: 'conditions', kinds: STATE_KINDS, hint: true },
  { key: 'can_have_country_monopoly', group: 'conditions', kind: 'conditions', kinds: COUNTRY_KINDS, hint: true },
  { key: 'should_auto_expand', group: 'conditions', kind: 'conditions', kinds: [], hint: true },
  { key: 'construction_modifier', group: 'conditions', kind: 'block', hint: true },
];

const PMG_SCRIPT_FIELDS = [
  { key: 'ai_selection', kind: 'select', options: ['most_profitable', 'most_productive'], hint: true },
  flag('is_hidden_when_unavailable', false, { hint: true }),
];

const PM_GROUPS = ['unlock', 'other'];
const PM_SCRIPT_FIELDS = [
  { key: 'required_input_goods', kind: 'repeat', pick: 'goods', hint: true },
  { key: 'disallowing_laws', kind: 'keys', pick: 'laws' },
  flag('is_hidden_when_unavailable', false, { hint: true }),

  { key: 'unlocking_production_methods', group: 'unlock', kind: 'keys', pick: 'pms', hint: true },
  { key: 'unlocking_global_technologies', group: 'unlock', kind: 'keys', pick: 'technologies', hint: true },
  { key: 'unlocking_principles', group: 'unlock', kind: 'keys', pick: 'principles' },
  { key: 'unlocking_identity', group: 'unlock', kind: 'repeat', pick: 'identities', hint: true },
  { key: 'unlocking_company_categories', group: 'unlock', kind: 'keys', pick: 'categories' },
  { key: 'unlocking_geographic_regions', group: 'unlock', kind: 'keys', pick: 'geographic_regions' },
  { key: 'unlocking_religions', group: 'unlock', kind: 'keys', pick: 'religions' },
  { key: 'disallowing_religions', group: 'unlock', kind: 'keys', pick: 'religions' },
  { key: 'replacement_if_valid', group: 'unlock', kind: 'key', pick: 'pms', hint: true },

  { key: 'profession_ratio', group: 'other', kind: 'amounts', pick: 'pop_types', hint: true },
  { key: 'ai_weight', group: 'other', kind: 'number', hint: true },
  { key: 'ai_value', group: 'other', kind: 'number', hint: true },
  { key: 'scoring_override', group: 'other', kind: 'select', hint: true,
    options: () => usedValues(store.data.pms.map((pm) => pm.extra), 'scoring_override') },
  { key: 'pollution_generation', group: 'other', kind: 'number', hint: true },
  { key: 'city_lights_color_index', group: 'other', kind: 'number', hint: true },
  { key: 'timed_modifiers', group: 'other', kind: 'block', hint: true },
];

const keysOf = (fields) => new Set(fields.map((field) => field.key));
const BUILDING_KEYS = keysOf(BUILDING_SCRIPT_FIELDS);
const PMG_KEYS = keysOf(PMG_SCRIPT_FIELDS);
const PM_KEYS = keysOf(PM_SCRIPT_FIELDS);

// What the form does not know of an item's other script, as a text box. `redraw` runs when
// the box loses the focus after a change, so fields typed into it move to the form.
function unknownBox(item, keys, redraw) {
  const parts = splitScript(item.extra, keys);
  if (!parts) {
    // the braces do not match: edit the whole script until they do
    const area = scriptArea(() => item.extra, (value) => { item.extra = value; });
    area.addEventListener('change', redraw);
    return area;
  }
  let { known } = parts;
  let last = item.extra;
  const area = scriptArea(() => parts.unknown, (typed) => {
    if (item.extra !== last) {  // the form changed it meanwhile
      const now = splitScript(item.extra, keys);
      if (now) known = now.known;
    }
    item.extra = last = joinScript(known, typed);
  });
  area.addEventListener('change', redraw);
  return area;
}

function hasUnknown(item, keys) {
  const parts = splitScript(item.extra, keys);
  return !parts || Boolean(parts.unknown.trim());
}

function settingsSection() {
  const monument = isMonumentPage();
  return section(t('fset.title'), t('fset.hint'), scriptFields({
    scope: monument ? 'monument' : 'building', fields: monument ? monumentSettingFields() : BUILDING_SCRIPT_FIELDS,
    groups: monument ? MONUMENT_GROUPS_OF_FIELDS : BUILDING_GROUPS,
    get: () => editing.extra,
    write: (text, redraw) => {
      editing.extra = text;
      changed();
      if (redraw) refresh('settings');
      refresh('advanced');
    },
  }));
}

function advancedSection() {
  const redraw = () => { refresh('settings'); refresh('advanced'); };
  return section(t('company.advanced'), null,
    h('div', { class: 'script-field' },
      h('span', { class: 'field-label' }, t('factory.other_script')),
      h('p', { class: 'muted small' }, t('factory.extra_hint')),
      unknownBox(editing, isMonumentPage() ? monumentKeys() : BUILDING_KEYS, redraw)));
}

const FACTORY_BUILDERS = {
  basic: basicSection,
  images: imagesSection,
  unlock: unlockSection,
  pmgs: pmgsSection,
  conditions: conditionsSection,
  ai: aiSection,
  settings: settingsSection,
  advanced: advancedSection,
};

const MONUMENT_BUILDERS = {
  basic: basicSection,
  images: imagesSection,
  location: locationSection,
  models: modelsSection,
  pmgs: effectsSection,
  unlock: unlockSection,
  conditions: conditionsSection,
  ai: aiSection,
  settings: settingsSection,
  advanced: advancedSection,
};

const builders = new Proxy({}, {
  get: (_target, name) => (isMonumentPage() ? MONUMENT_BUILDERS : FACTORY_BUILDERS)[name],
  ownKeys: () => Reflect.ownKeys(isMonumentPage() ? MONUMENT_BUILDERS : FACTORY_BUILDERS),
  getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
});

function renderMiddle() {
  if (!editing) {
    // The start screen: nothing is being edited yet.
    fill(els.middle, h('div', { class: 'editor-start' },
      h('button', { class: 'btn primary start-button', onclick: startFactory }, kind.newLabel()),
      h('p', { class: 'muted' }, t('editor.start_hint'))));
    return;
  }
  const scroll = els.middle.scrollTop;
  for (const name of Object.keys(sections)) delete sections[name];
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

// Buildings this page is for: production buildings (not monuments, government, military,
// infrastructure or the subsistence buildings).
function isProduction(factory) {
  const group = store.index.building_groups.get(factory.building_group);
  return Boolean(group && group.production);
}

// Buildings of the monument page: monuments and skyscrapers.
function isMonument(factory) {
  return groupChain(factory.building_group).some((group) => MONUMENT_GROUPS.includes(group));
}

// The pages' buildings.
const belongs = (factory) => (isMonumentPage() ? isMonument(factory) : isProduction(factory));

function matchesFilters(factory) {
  const query = filters.query.trim().toLowerCase();
  if (query && !(factory.name || '').toLowerCase().includes(query) && !factory.key.toLowerCase().includes(query)) return false;
  if (filters.source && !factory.sources.includes(filters.source)) return false;
  if (filters.group && !groupChain(factory.building_group).includes(filters.group)) return false;
  if (filters.region && regionOf(factory) !== filters.region) return false;
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
  const monument = isMonumentPage();
  return h('div', { class: 'company-details' },
    factory.sources.length > 1 && versionPicker(factory),
    monument && h('div', {}, h('span', { class: 'muted' }, `${t('monument.state')}: `),
      stateOf(shown) ? nameOf('states', stateOf(shown)) : t('monument.anywhere')),
    monument && effectLines(picked),
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
    !monument && picked.length > 0 && h('div', {}, h('span', { class: 'muted' }, `${t('factory.estimate_profit')}: `),
      h('b', { class: profit > 0 ? 'good' : profit < 0 ? 'bad' : '' }, (profit > 0 ? '+' : '') + round(profit))),
    h('div', { class: 'muted small' }, `${sourceName(shown.source)} · ${shown.file}`),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: () => run(() => overrideFactory(shown)) }, t('company.override')),
      h('button', { class: 'btn', onclick: () => run(() => copyFactory(shown)) }, kind.copyLabel())));
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
  els.count.textContent = t('company.count', { count: matches.length, total: listed.length });
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
    for (const factory of data.factories.filter(belongs)) {
      for (const key of keysOf(factory)) counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
  };
  const options = (counts, kind) => [...counts].map(([key, n]) => [key, `${nameOf(kind, key)} (${n})`]).sort(byName);
  const sourceCounts = count((factory) => factory.sources);
  // Base game first, then the mods in load order, each building where it was first defined.
  const rank = new Map(data.sources.map((source, i) => [source.id, i]));
  listed = data.factories.filter(belongs).sort((a, b) => rank.get(a.sources[0]) - rank.get(b.sources[0]));
  const sources = data.sources.filter((s) => sourceCounts.has(s.id))
    .map((s) => [s.id, `${sourceName(s.id)} (${sourceCounts.get(s.id)})`]);
  els.list = h('div', { class: 'company-list' });
  els.count = h('span', { class: 'muted' });
  const search = h('input', {
    class: 'input', type: 'search', placeholder: t('company.search'), value: filters.query,
    oninput: debounce(() => { filters.query = search.value; listLimit = PAGE; renderList(); }, 150),
  });
  const groupFilter = filterSelect('group', t('factory.filter_group'),
    groupOptions(count((factory) => groupChain(factory.building_group))));
  els.right.replaceChildren(
    h('div', { class: 'col-head' }, h('h2', {}, kind.existing()), els.count),
    h('div', { class: 'filters' },
      search,
      filterSelect('source', t('company.filter_source'), sources),
      groupFilter,
      isMonumentPage()
        ? filterSelect('region', t('company.filter_region'),
          options(count((factory) => (regionOf(factory) ? [regionOf(factory)] : [])), 'regions'))
        : [filterSelect('output', t('factory.filter_output'), options(count((factory) => goodsOf(factory).outputs), 'goods')),
          filterSelect('input', t('factory.filter_input'), options(count((factory) => goodsOf(factory).inputs), 'goods'))]),
    els.list);
  renderList();
}

// ------------------------------------------------------------------ monuments

// The state region a building of the game is limited to (in its potential), or ''.
function stateOf(building) {
  if (building.location) return building.location.state;
  const value = scriptValue(building.blocks.potential, 'state_region');
  return typeof value === 'string' && value.startsWith('s:') ? value.slice(2) : '';
}

function regionOf(building) {
  const state = store.index.states.get(stateOf(building));
  return (state && state.region) || '';
}

// The default names of a monument's own group and method, as the base game's monuments have them.
function defaultNames(kindOfList, key) {
  const name = knownName(store.index[kindOfList].get(key));
  return name ? { [language()]: name } : {};
}

// Methods the base game's monuments offer besides their own one (smaller or no effects).
const SHARED_MONUMENT_PMS = ['pm_monument_prestige_only', 'pm_monument_no_effects'];

// The group of a monument edited as a list of effects: its own method first, then shared ones
// kept as they are (`others`, keys; by default the base game's). The own method is a copy of
// `source` (a method of the game) when given.
function simpleGroup(source, others = SHARED_MONUMENT_PMS.filter((key) => store.index.pms.has(key))) {
  const copied = source ? structuredClone(Object.fromEntries(PM_FIELDS.map((name) => [name, source[name]]))) : {};
  const pm = {
    type: 'own', mode: 'new', key: '', names: defaultNames('pms', 'pm_default_building_eiffel_tower'),
    texture: WONDER_TEXTURE, is_default: false, inputs: [], outputs: [], employment: [], unlocking_technologies: [],
    unlocking_laws: [], modifiers: [], extra: 'is_hidden_when_unavailable = yes', ...copied,
  };
  return { type: 'own', mode: 'new', key: '', names: defaultNames('pmgs', 'pmg_base_building_eiffel_tower'),
    texture: PMG_TEXTURE, extra: 'ai_selection = most_productive\nis_hidden_when_unavailable = yes',
    pms: [pm, ...others.map((key) => ({ type: 'ref', key }))] };
}

// A new monument's own group and method are named after it.
function syncSimpleKeys() {
  if (!editing || !isMonumentPage() || editing.effects !== 'simple') return;
  const pmg = editing.pmgs[0];
  if (!pmg || pmg.type !== 'own' || pmg.mode !== 'new' || !pmg.pms[0] || pmg.pms[0].type !== 'own') return;
  const base = (editing.key || 'building_new').replace(/^building_/, '');
  pmg.key = `pmg_base_building_${base}`;
  pmg.pms[0].key = `pm_default_building_${base}`;
}

// The group and first method of a game monument when it has one group of its own whose first
// method nothing else uses (the base game's pattern); then it is edited as a list of effects,
// and the group's other methods are kept as they are.
function ownEffects(building) {
  if (building.pmgs.length !== 1 || building.pmgs[0].type !== 'ref') return null;
  const pmg = store.index.pmgs.get(building.pmgs[0].key);
  if (!pmg || !pmg.pms.length) return null;
  const pm = store.index.pms.get(pmg.pms[0].key);
  const groupUsers = store.data.factories.filter((f) => f.pmgs.some((entry) => entry.key === pmg.key)).length;
  const methodUsers = store.data.pmgs.filter((g) => g.pms.some((entry) => entry.key === pmg.pms[0].key)).length;
  return pm && groupUsers <= 1 && methodUsers <= 1 ? { pmg, pm, others: pmg.pms.slice(1).map((entry) => entry.key) } : null;
}

// A game building opened on the monument page: `item` is it as a copy or override, `source` the
// building as the game has it. Its state, locator and buildable move out of the script.
function asMonument(item, source) {
  const model = { ...item, blocks: { ...item.blocks } };
  const state = stateOf(source);
  if (state) model.blocks.potential = setScriptValue(model.blocks.potential, 'state_region', null);
  const locator = scriptValue(model.extra, 'locator');
  model.extra = setScriptValue(model.extra, 'locator', null);
  if (item.mode === 'new') model.extra = setScriptValue(model.extra, 'buildable', null);
  model.location = { state, x: null, z: null,
    locator: item.mode === 'override' && typeof locator === 'string' ? locator : '' };
  model.history = '';
  const own = ownEffects(source);
  model.effects = own ? 'simple' : 'full';
  if (own && item.mode === 'override') {
    model.pmgs = [{ type: 'own', mode: 'override', key: own.pmg.key, names: {}, texture: own.pmg.texture,
      extra: own.pmg.extra, pms: [ownPm(own.pm.key, 'override'), ...own.others.map((key) => ({ type: 'ref', key }))] }];
  } else if (own) {
    model.pmgs = [{ ...simpleGroup(own.pm, own.others), texture: own.pmg.texture, extra: own.pmg.extra }];
  }
  return model;
}

// Map positions of the monuments of the game (by their locators).
function monumentPositions() {
  const byName = new Map(store.data.locators.map((locator) => [locator.key, locator]));
  return store.data.factories.filter(isMonument).map((building) => {
    const name = scriptValue(building.extra, 'locator');
    const locator = typeof name === 'string' && byName.get(name);
    return locator ? { key: building.key, name: building.name || building.key, x: locator.x, z: locator.z } : null;
  }).filter(Boolean);
}

// Where the model of the monument in the editor stands: {x, z} or null.
function currentPosition() {
  const { location } = editing;
  if (location.x !== null && location.x !== undefined) return { x: location.x, z: location.z };
  const locator = location.locator && store.data.locators.find((l) => l.key === location.locator);
  return locator ? { x: locator.x, z: locator.z } : null;
}

function monumentNotes(monument) {
  const notes = [];
  if (!monument.location.state) notes.push(t('monument.note_anywhere'));
  else if (!currentPosition()) notes.push(t('monument.note_no_position'));
  return notes;
}

// "Prestige +100" lines of the effects of methods.
function effectLines(pms) {
  const lines = pms.flatMap((pm) => [
    ...pm.modifiers.map((m) => {
      const info = store.index.modifiers.get(m.key);
      const value = Number(m.value);
      const text = Number.isNaN(value) ? m.value
        : `${value > 0 ? '+' : ''}${info && info.percent ? `${Math.round(value * 10000) / 100}%` : value}`;
      return `${nameOf('modifiers', m.key)} ${text}`;
    }),
    ...pm.employment.map((row) => `${nameOf('pop_types', row.pop)} ${row.amount}`),
  ]);
  return lines.length ? h('ul', { class: 'modifier-lines' }, lines.map((line) => h('li', {}, line))) : null;
}

function monumentPreview(monument) {
  const position = currentPosition();
  const simple = monument.effects === 'simple' && monument.pmgs[0] && monument.pmgs[0].pms[0];
  return [
    h('div', { class: 'preview-group' },
      h('h4', {}, t('monument.location')),
      h('div', {}, monument.location.state ? nameOf('states', monument.location.state) : t('monument.anywhere')),
      monument.location.state && h('div', { class: 'muted small' }, position
        ? t('monument.position_at', { x: Math.round(position.x), z: Math.round(position.z) }) : t('monument.position_none')),
      monument.history && h('div', { class: 'muted small' }, t('monument.owner_at_start', { owner: nameOf('countries', monument.history) }))),
    simple && h('div', { class: 'preview-group' },
      h('h4', {}, t('monument.effects')),
      effectLines([simple]) || h('span', { class: 'muted' }, t('monument.no_effects'))),
  ];
}

function setPosition(state, x, z) {
  Object.assign(editing.location, { state, x, z });
  changed();
  refresh('location');
}

function locationSection() {
  const { location } = editing;
  if (!locationMap || locationMapData !== store.data) {
    locationMap = new StateMap({ onToggle: () => {}, onPoint: (state, x, z) => setPosition(state, x, z),
      markerText: (count, names) => t('monument.map_monuments', { count, names }) });
    locationMapData = store.data;
  }
  const others = monumentPositions().filter((point) => point.key !== editing.key);
  const markers = new Map();
  for (const building of store.data.factories.filter(isMonument)) {
    const state = stateOf(building);
    if (state) markers.set(state, [...(markers.get(state) || []), building.name || building.key]);
  }
  const position = currentPosition();
  locationMap.showMarkers = false;
  locationMap.setMarkers(markers);
  locationMap.setSelected(location.state ? [location.state] : []);
  locationMap.setPoints([...others.map((point) => ({ x: point.x, z: point.z, current: false })),
    ...(position ? [{ ...position, current: true }] : [])]);
  const owners = (store.data.state_owners[location.state] || []);
  const canStart = editing.mode === 'new';
  return section(t('monument.location'), t('monument.location_hint'),
    locationMap.el,
    h('div', { class: 'row' },
      h('span', { class: 'field-label' }, t('monument.state')),
      valueButton({ kind: 'states', title: t('monument.state'), placeholder: t('monument.anywhere'),
        keys: location.state ? [location.state] : [],
        onDone: ([state]) => {
          if (!state || state === location.state) return;
          Object.assign(location, { state, x: null, z: null });
          changed();
          refresh('location');
        } }),
      location.state && h('button', { class: 'btn small', onclick: () => {
        Object.assign(location, { state: '', x: null, z: null });
        editing.history = '';
        changed();
        refresh('location');
      } }, t('monument.clear_state'))),
    h('div', { class: 'muted' }, `${t('monument.position')}: `,
      !location.state ? t('monument.position_anywhere')
        : location.x !== null && location.x !== undefined ? t('monument.position_at', { x: Math.round(location.x), z: Math.round(location.z) })
          : location.locator ? t('monument.position_kept', { name: location.locator }) : t('monument.position_none')),
    canStart && h('div', { class: 'cond-block' },
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: Boolean(editing.history), disabled: !location.state || !owners.length,
          onchange: (event) => { editing.history = event.target.checked ? owners[0] : ''; changed(); refresh('location'); } }),
        t('monument.history')),
      h('p', { class: 'muted small' }, !location.state ? t('monument.history_need_state')
        : !owners.length ? t('monument.history_no_owner') : t('monument.history_hint')),
      editing.history && owners.length > 1 && (() => {
        const select = h('select', { class: 'input', onchange: () => { editing.history = select.value; changed(); refresh('location'); } },
          owners.map((tag) => h('option', { value: tag }, `${nameOf('countries', tag)} (${tag})`)));
        select.value = editing.history;
        return field(t('monument.history_owner'), select);
      })(),
      editing.history && owners.length === 1 && h('div', {}, t('monument.owner_at_start', { owner: nameOf('countries', owners[0]) }))));
}

const entities = () => [...new Set(['entity_constructed', 'entity_under_construction', 'entity_not_constructed']
  .flatMap((key) => usedValues(buildingTexts(), key)))].sort();

const MODEL_FIELDS = [
  { key: 'entity_constructed', kind: 'entity', options: entities, hint: true },
  { key: 'entity_under_construction', kind: 'entity', options: entities, hint: true },
  { key: 'entity_not_constructed', kind: 'entity', options: entities, hint: true },
  { key: 'city_gfx_interactions', kind: 'gfx', hint: true },
  { key: 'meshes', kind: 'block', hint: true },
];

function modelsSection() {
  return section(t('monument.models'), t('monument.models_hint'), scriptFields({
    scope: 'models', fields: MODEL_FIELDS, get: () => editing.extra,
    write: (text, redraw) => {
      editing.extra = text;
      changed();
      if (redraw) refresh('models');
      refresh('advanced');
    },
  }));
}

const MONUMENT_GROUPS_OF_FIELDS = ['misc', 'conditions'];

// The other fields of a monument; buildable only for an override (a new one is buildable unless
// it exists at the start).
function monumentSettingFields() {
  return [
    flag('unique', false, { hint: true }),
    flag('expandable', true),
    flag('downsizeable', true),
    ...(editing.mode === 'override' ? [flag('buildable', true)] : []),
    { key: 'levels_per_mesh', kind: 'number', hint: true },
    { key: 'terrain_manipulator', kind: 'select', options: () => usedValues(buildingTexts(), 'terrain_manipulator'), hint: true },
    flag('enable_air_connection', false, { group: 'misc', hint: true }),
    flag('statue', false, { group: 'misc', hint: true }),
    { key: 'lens', group: 'misc', kind: 'key', pick: 'lenses', hint: true },
    { key: 'ownership_type', group: 'misc', kind: 'select', options: OWNERSHIP, hint: true,
      label: (option) => (OWNERSHIP.includes(option) ? `${t('fset.ownership.' + option)} (${option})` : option) },
    { key: 'ai_nationalization_desire', group: 'misc', kind: 'number', hint: true },
    { key: 'can_build_government', group: 'conditions', kind: 'conditions', kinds: STATE_KINDS, hint: true },
    { key: 'can_build_private', group: 'conditions', kind: 'conditions', kinds: STATE_KINDS, hint: true },
    { key: 'should_auto_expand', group: 'conditions', kind: 'conditions', kinds: [], hint: true },
  ];
}

// Keys the monument forms edit (the text box shows the others).
function monumentKeys() {
  return new Set([...keysOf(monumentSettingFields()), ...keysOf(MODEL_FIELDS)]);
}

async function switchEffects(mode) {
  if (mode === editing.effects) return;
  if (!(await confirmDialog(t('monument.effects_switch_confirm'), t('monument.effects_switch')))) {
    refresh('pmgs');
    return;
  }
  editing.effects = mode;
  editing.pmgs = mode === 'simple' ? [simpleGroup(null)] : [];
  restructured();
}

function effectsSection() {
  const simple = editing.effects === 'simple';
  const pm = simple && editing.pmgs[0] && editing.pmgs[0].pms[0];
  const touch = () => changed();
  const choice = h('div', { class: 'radios' }, ['simple', 'full'].map((mode) => h('label', { class: 'check' },
    h('input', { type: 'radio', name: 'effects-mode', checked: editing.effects === mode,
      onchange: () => run(() => switchEffects(mode)) }),
    mode === 'simple' ? t('monument.effects_simple') : t('monument.effects_full'))));
  if (!simple) {
    return section(t('monument.effects'), t('monument.effects_hint'), choice,
      editing.pmgs.map((entry, index) => pmgCard(entry, index)),
      editing.pmgs.length === 0 && h('p', { class: 'muted' }, t('factory.pmgs_empty')),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: addRefPmgs }, t('factory.add_pmg_ref')),
        h('button', { class: 'btn', onclick: addOwnPmg }, t('factory.add_pmg_own'))));
  }
  if (!pm || pm.type !== 'own') {
    return section(t('monument.effects'), null, choice, h('p', { class: 'notice warn' }, t('monument.effects_broken')));
  }
  const others = editing.pmgs[0].pms.slice(1);
  return section(t('monument.effects'), t('monument.effects_hint'), choice,
    editing.pmgs[0].mode === 'override' && h('div', { class: 'notice warn small' }, t('monument.effects_override')),
    modifierRows(pm, touch, t('monument.effect_list')),
    amountRows(pm, 'employment', 'pop', 'pop_types', t('factory.employment'), '100', touch),
    others.length > 0 && h('p', { class: 'muted small' },
      t('monument.effects_others', { names: others.map((entry) => entryName('pms', entry)).join(', ') })));
}
