// Company builder: the mod's contents (sidebar), the company being edited, the editor,
// and the existing companies (right).
import { api } from './api.js';
import { t } from './i18n.js';
import { store, refreshState, loadData, language, languageName, nameOf, companyName, setProject, editingImages,
  keptImages } from './store.js';
import { renderSidebar, refreshSidebar, takePending } from './sidebar.js';
import { h, fill, toast, confirmDialog, openPicker, debounce } from './ui.js';
import { StateMap } from './map.js';
import { ICON_KINDS, thumb } from './icons.js';
import { run, section, field, objectChip, sourceName, sourceBadges, keyChips, imageField as imagePicker,
  scriptArea as scriptBox, formatModifier } from './widgets.js';
import { parseScript, bracesBalanced } from './script.js';
import { COUNTRY_KINDS, STATE_KINDS, TARGET_KINDS, conditionEditor, clearConditionCache, countConditions,
  newRow, writeConditions, valueButton } from './conditions.js';

// Script blocks of a company (written in this order by the backend).
const RAW_BLOCKS = ['potential', 'attainable', 'possible', 'can_establish_in', 'prestige_goods_trigger',
  'ai_will_do', 'ai_construction_targets', 'ai_weight'];
const CONDITION_BLOCKS = ['potential', 'attainable', 'possible', 'can_establish_in'];
const AI_ALWAYS = 'always = yes';
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
const filters = { query: '', source: '', building: '', region: '', prestige: '' };
let listed = [];           // existing companies in the order they are listed
let listLimit = PAGE;
let expanded = null;
const versionChoice = new Map();  // company key -> source of the version shown in the list
let aiMode = 'same';       // ai_will_do: 'same' as possible, 'custom' or 'never'
const template = { state: '', region: '', tech: '', buildings: null, level: '5', open: false };
const els = {};
const sections = {};

window.addEventListener('beforeunload', (event) => {
  if (dirty) event.preventDefault();
});

function blankCompany() {
  return {
    key: '', mode: 'new', names: {}, flavored_company: true, prosperity_modifier: [],
    blocks: { ...Object.fromEntries(RAW_BLOCKS.map((name) => [name, ''])), ai_will_do: AI_ALWAYS }, extra: '',
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
  setProject(await api.get('/api/project'));
  if (editingProject !== store.state.project.dir) {
    editing = null;  // nothing open: the start screen
    originalKey = null;
    dirty = false;
    editingProject = store.state.project.dir;
  }
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
  const wanted = takePending('company');
  const company = wanted && wanted !== originalKey && store.project.companies.find((c) => c.key === wanted);
  if (company) await edit(company, company.key);
}

// ----------------------------------------------------------------- helpers

function originalOf(company) {
  return company.mode === 'override' ? store.index.companies.get(company.key) : null;
}

const displayName = companyName;

function keyTaken(key) {
  return store.index.companies.has(key)
    || store.project.companies.some((c) => c.key === key && c.key !== originalKey);
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

const squash = (text) => text.replace(/\s+/g, ' ').trim();

// How ai_will_do relates to possible: the same conditions, its own, or empty (the AI never founds it).
function aiModeOf(company) {
  const ai = squash(company.blocks.ai_will_do);
  if (!ai) return 'never';
  return ai === (squash(company.blocks.possible) || AI_ALWAYS) ? 'same' : 'custom';
}

function changed() {
  if (aiMode === 'same') editing.blocks.ai_will_do = editing.blocks.possible.trim() || AI_ALWAYS;
  dirty = true;
  renderPreview();
  refreshSidebar();
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
  aiMode = aiModeOf(editing);
  clearConditionCache();
  template.buildings = null;  // follow the new company's building types
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
  const result = await api.post('/api/project/company',
    { company: editing, original_key: originalKey, keep_images: keptImages() });
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

// Remove a company of the project; when it is the one being edited, start a new one.
async function remove(company) {
  const current = company.key === originalKey;
  const name = displayName(current ? editing : company);
  if (!(await confirmDialog(t('company.delete_confirm', { name }), t('company.delete')))) return;
  setProject(await api.post('/api/project/company/delete', { key: company.key, keep_images: keptImages(current ? 'company' : null) }));
  if (current) {
    dirty = false;
    await close();
  } else {
    refreshSidebar();
  }
  toast(t('company.deleted'));
}

// Leave the editor for the start screen.
async function close() {
  if (dirty && !(await confirmDialog(t('company.discard_confirm'), t('company.discard')))) return;
  editing = null;
  originalKey = null;
  dirty = false;
  renderLeft();
  renderMiddle();
}

const startCompany = () => run(() => edit(blankCompany(), null));

editingImages.set('company', () => (editing ? [editing.icon, editing.background] : []));

// What the sidebar needs from this page.
const sidebarEditor = {
  kind: 'company',
  state: () => ({ key: originalKey, dirty }),
  open: (company) => edit(company, company.key),
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
    h('button', { class: 'btn new-item', onclick: startCompany }, t('company.new')));
  renderPreview();
  refreshSidebar();
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
  const conditionChips = CONDITION_BLOCKS.filter((name) => company.blocks[name].trim()).map((name) =>
    h('span', { class: 'chip', title: name }, `${t('block.title.' + name)} · ${countConditions(company.blocks[name])}`));
  const weight = aiWeightOf(company);
  const targets = countConditions(company.blocks.ai_construction_targets);
  const aiChips = [
    h('span', { class: 'chip' }, t('ai.mode.' + aiMode)),
    weight !== null && weight !== '' && h('span', { class: 'chip' }, t('ai.weight_short', { value: weight })),
    targets > 0 && h('span', { class: 'chip' }, t('ai.targets_short', { count: targets })),
  ];
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
      conditionChips.length
        ? h('div', { class: 'chips' }, conditionChips)
        : h('span', { class: 'muted' }, t('company.no_conditions'))),
    h('div', { class: 'preview-group' },
      h('h4', {}, t('company.ai')),
      h('div', { class: 'chips' }, aiChips)),
    h('div', { class: 'preview-group' },
      h('h4', {}, t('company.translations', { count: filled.length, total: store.state.languages.length })),
      h('div', { class: 'chips' }, store.state.languages.map((l) =>
        h('span', { class: 'chip' + (company.names[l.key] ? ' filled' : ' missing'), title: company.names[l.key] || '' }, l.name)))),
    found.length > 0 && h('ul', { class: 'problems' }, found.map((code) => h('li', {}, problemText(code)))),
    notes.length > 0 && h('ul', { class: 'notes' }, notes.map((note) => h('li', {}, note))));
}

// ------------------------------------------------------------------- middle

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
  return imagePicker({ label, value: editing[name], paths, wide, kind: `company_${name}`,
    onChange: (path) => { editing[name] = path; changed(); refresh('images'); } });
}

function imagesSection() {
  return section(t('company.images'), t('company.images_hint'),
    imageField('icon', t('company.icon'), store.data.icons, false),
    imageField('background', t('company.background'), store.data.backgrounds, true));
}

function chipField(name, kind, label, hint, sectionName, toggle) {
  return keyChips({ keys: editing[name], kind, label, hint, toggle,
    onChange: (keys) => { editing[name] = keys; changed(); refresh(sectionName); } });
}

function buildingsSection() {
  const toggle = { label: t('company.only_used_buildings'), test: (item) => item.used, on: false };
  return section(t('company.buildings'), null,
    chipField('building_types', 'buildings', t('company.building_types'), t('company.building_types_hint'), 'buildings', toggle),
    chipField('extension_building_types', 'buildings', t('company.extension_building_types'),
      t('company.extension_building_types_hint'), 'buildings', toggle));
}

function prestigeSection() {
  const company = editing;
  return section(t('company.prestige'), null,
    chipField('possible_prestige_goods', 'prestige_goods', t('company.prestige_goods'), t('company.prestige_goods_hint'), 'prestige'),
    h('details', { class: 'cond-script', open: Boolean(company.blocks.prestige_goods_trigger.trim()) },
      h('summary', {}, t('block.title.prestige_goods_trigger')),
      h('p', { class: 'muted small' }, t('block.prestige_goods_trigger')),
      scriptArea(() => company.blocks.prestige_goods_trigger, (value) => { company.blocks.prestige_goods_trigger = value; })));
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

// ------------------------------------------------------------- conditions

function blockHead(name) {
  return h('div', { class: 'cond-head' },
    h('span', { class: 'field-label' }, t('block.title.' + name)),
    h('span', { class: 'mono muted small' }, name));
}

// A list of conditions editing one script block of the company.
function blockEditor(name, kinds, hideOption = false) {
  const company = editing;
  return h('div', { class: 'cond-block' },
    blockHead(name),
    h('p', { class: 'muted small' }, t('block.' + name)),
    conditionEditor({
      id: name, kinds, hideOption,
      get: () => company.blocks[name],
      set: (text) => { company.blocks[name] = text; changed(); },
    }));
}

// ai_weight as a plain number: '' when empty, null when it is more than `value = n`.
function aiWeightOf(company) {
  const text = company.blocks.ai_weight.trim();
  if (!text) return '';
  const entries = parseScript(text);
  const only = entries && entries.length === 1 ? entries[0] : null;
  return only && only.key === 'value' && only.op === '=' && /^-?\d+(\.\d+)?$/.test(only.value) ? only.value : null;
}

// Fill in everything the way the base game writes a company tied to one state region.
async function applyTemplate() {
  const company = editing;
  const buildings = template.buildings || company.building_types;
  if (!template.state) return toast(t('template.need_state'), 'error');
  const replaces = aiMode === 'custom'
    || ['potential', 'attainable', 'possible', 'ai_construction_targets'].some((name) => company.blocks[name].trim());
  if (replaces && !(await confirmDialog(t('template.confirm'), t('template.apply')))) return;
  const { state, region, level } = template;
  const tech = template.tech ? [newRow('tech', { tech: template.tech })] : [];
  company.blocks.potential = region ? writeConditions({ rows: [newRow('interest', { regions: [region] })] }) : '';
  // Hidden: the game would only repeat what possible already says.
  company.blocks.attainable = writeConditions({ hidden: true, rows: [newRow('state', { state, incorporated: false })] });
  company.blocks.possible = writeConditions({ rows: [...tech, buildings.length
    ? newRow('building', { state, buildings: [...buildings], level })
    : newRow('state', { state })] });
  // The AI starts working towards the company once it owns the state, then builds up the buildings.
  company.blocks.ai_will_do = writeConditions({ rows: [...tech, newRow('state', { state })] });
  aiMode = 'custom';
  company.blocks.ai_construction_targets = writeConditions({
    rows: buildings.map((building) => newRow('target', { building, level, state })) });
  if (!company.blocks.ai_weight.trim()) company.blocks.ai_weight = 'value = 3';
  if (!company.preferred_headquarters.includes(state)) company.preferred_headquarters.push(state);
  clearConditionCache();
  changed();
  for (const name of ['conditions', 'ai', 'headquarters']) refresh(name);
  toast(t('template.applied'));
}

function templateCard() {
  const buildings = template.buildings || editing.building_types;
  const field = (label, ...controls) => h('div', { class: 'row' }, h('span', { class: 'helper-label' }, label), controls);
  const one = (name, kind, placeholder) => [
    valueButton({
      kind, title: t('template.' + name), placeholder, keys: template[name] ? [template[name]] : [],
      onDone: ([key]) => {
        template[name] = key || '';
        const info = name === 'state' && store.index.states.get(template.state);
        if (info && info.region) template.region = info.region;  // the state's own strategic region
        refresh('conditions');
      },
    }),
    template[name] && h('button', { class: 'cond-clear', title: t('cond.clear'),
      onclick: () => { template[name] = ''; refresh('conditions'); } }, '✕'),
  ];
  const level = h('input', { class: 'input level', type: 'number', min: '1', value: template.level,
    oninput: () => { template.level = level.value; } });
  return h('details', { class: 'helpers template', open: template.open,
    ontoggle: (event) => { template.open = event.target.open; } },
    h('summary', {}, h('b', {}, t('template.title'))),
    h('p', { class: 'muted small' }, t('template.hint')),
    field(t('template.state'), one('state', 'states')),
    field(t('template.region'), one('region', 'regions')),
    field(t('template.tech'), one('tech', 'technologies', t('template.optional'))),
    field(t('template.buildings'),
      valueButton({
        kind: 'buildings', multi: true, title: t('template.buildings'), keys: buildings,
        onDone: (keys) => { template.buildings = keys; refresh('conditions'); },
      }),
      h('span', { class: 'muted' }, t('cond.level')), level),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', onclick: () => run(applyTemplate) }, t('template.apply'))));
}

function conditionsSection() {
  return section(t('company.conditions'), t('company.conditions_hint'),
    templateCard(),
    blockEditor('potential', COUNTRY_KINDS),
    blockEditor('attainable', COUNTRY_KINDS, true),
    blockEditor('possible', COUNTRY_KINDS),
    blockEditor('can_establish_in', STATE_KINDS));
}

function aiSection() {
  const company = editing;
  const setMode = (mode) => {
    aiMode = mode;
    if (mode === 'never') company.blocks.ai_will_do = '';
    // custom starts from what the AI used so far: a copy of possible
    else if (mode === 'custom' && !company.blocks.ai_will_do.trim()) company.blocks.ai_will_do = company.blocks.possible;
    changed();  // 'same' copies possible here
    refresh('ai');
  };
  const weight = aiWeightOf(company);
  const weightInput = h('input', {
    class: 'input level', type: 'number', step: 'any', value: weight || '',
    oninput: () => {
      const value = weightInput.value.trim();
      company.blocks.ai_weight = value ? `value = ${value}` : '';
      changed();
    },
  });
  return section(t('company.ai'), null,
    h('div', { class: 'cond-block' },
      blockHead('ai_will_do'),
      h('div', { class: 'radios' }, ['same', 'custom', 'never'].map((mode) => h('label', { class: 'check' },
        h('input', { type: 'radio', name: 'ai-mode', checked: aiMode === mode, onchange: () => setMode(mode) }),
        t('ai.mode.' + mode)))),
      h('p', { class: 'muted small' }, t('ai.mode_hint.' + aiMode)),
      aiMode === 'custom' && conditionEditor({
        id: 'ai_will_do', kinds: COUNTRY_KINDS,
        get: () => company.blocks.ai_will_do,
        set: (text) => { company.blocks.ai_will_do = text; changed(); },
      })),
    h('div', { class: 'cond-block' },
      blockHead('ai_weight'),
      h('p', { class: 'muted small' }, t('block.ai_weight')),
      weight === null
        ? [h('p', { class: 'notice warn' }, t('ai.weight_script')),
          scriptArea(() => company.blocks.ai_weight, (value) => { company.blocks.ai_weight = value; })]
        : weightInput),
    blockEditor('ai_construction_targets', TARGET_KINDS));
}

const scriptArea = (get, set) => scriptBox(get, set, changed);

function advancedSection() {
  const company = editing;
  return section(t('company.advanced'), null,
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
  ai: aiSection,
  advanced: advancedSection,
};

function renderMiddle() {
  if (!editing) {
    // The start screen: nothing is being edited yet.
    fill(els.middle, h('div', { class: 'editor-start' },
      h('button', { class: 'btn primary start-button', onclick: startCompany }, t('company.new')),
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

function matchesFilters(company) {
  const query = filters.query.trim().toLowerCase();
  if (query && !(company.name || '').toLowerCase().includes(query) && !company.key.toLowerCase().includes(query)) return false;
  if (filters.source && !company.sources.includes(filters.source)) return false;
  if (filters.building && !company.building_types.includes(filters.building)
    && !company.extension_building_types.includes(filters.building)) return false;
  if (filters.region && !company.preferred_headquarters.some((state) => {
    const info = store.index.states.get(state);
    return info && info.region === filters.region;
  })) return false;
  if (filters.prestige && (company.possible_prestige_goods.length > 0) !== (filters.prestige === 'yes')) return false;
  return true;
}

// The version of a company shown in the list: the one in effect, or an earlier one picked
// from its sources (base game, or a mod that was later overridden).
function shownVersion(company) {
  const version = company.versions.find((v) => v.source === versionChoice.get(company.key));
  return version ? { ...company, ...version } : company;
}

function versionPicker(company) {
  const last = company.sources[company.sources.length - 1];
  const choice = versionChoice.get(company.key);
  const version = company.versions.find((v) => v.source === choice);
  const current = version ? choice : last;
  return h('div', {},
    h('div', { class: 'detail-chips' }, h('span', { class: 'muted' }, `${t('company.version')}: `),
      company.sources.map((id) => h('button', {
        class: 'btn small' + (id === current ? ' selected' : ''),
        title: id === last ? t('company.source_active', { source: sourceName(id) }) : sourceName(id),
        onclick: () => { versionChoice.set(company.key, id); renderList(); },
      }, sourceName(id)))),
    h('div', { class: 'muted small' }, t('version_note.' + (version ? versionDifference(company, version) : 'active'))));
}

// How an earlier version differs from the one in effect: 'same', 'hidden' (only in what the
// list does not show: conditions, AI and other script) or 'shown'.
const LISTED_FIELDS = ['building_types', 'extension_building_types', 'possible_prestige_goods',
  'preferred_headquarters', 'prosperity_modifier'];
function versionDifference(company, version) {
  const differs = (field) => JSON.stringify(version[field]) !== JSON.stringify(company[field]);
  if (LISTED_FIELDS.some(differs)) return 'shown';
  return FIELDS.some(differs) ? 'hidden' : 'same';
}

function companyDetails(company) {
  const shown = shownVersion(company);
  const line = (label, keys, kind) => keys.length > 0 && (ICON_KINDS.has(kind)
    ? h('div', { class: 'detail-chips' }, h('span', { class: 'muted' }, `${label}: `),
      keys.map((key) => objectChip(kind, key)))
    : h('div', {}, h('span', { class: 'muted' }, `${label}: `), keys.map((key) => nameOf(kind, key)).join(', ')));
  return h('div', { class: 'company-details' },
    company.sources.length > 1 && versionPicker(company),
    line(t('company.building_types'), shown.building_types, 'buildings'),
    line(t('company.extension_building_types'), shown.extension_building_types, 'buildings'),
    line(t('company.prestige_goods'), shown.possible_prestige_goods, 'prestige_goods'),
    line(t('company.headquarters'), shown.preferred_headquarters, 'states'),
    shown.prosperity_modifier.length > 0 && h('ul', { class: 'modifier-lines' },
      shown.prosperity_modifier.map((modifier) => {
        const { text, tone } = formatModifier(modifier);
        return h('li', {}, h('b', { class: tone }, text), ' ', nameOf('modifiers', modifier.key));
      })),
    h('div', { class: 'muted small' }, `${sourceName(shown.source)} · ${shown.file}`),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: () => run(() => overrideCompany(shown)) }, t('company.override')),
      h('button', { class: 'btn', onclick: () => run(() => copyCompany(shown)) }, t('company.copy'))));
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
        sourceBadges(company)),
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
  for (const company of data.companies) {
    for (const id of company.sources) counts.set(id, (counts.get(id) || 0) + 1);
  }
  // Base game first, then the mods in load order (the data comes in file name order),
  // each company where it was first defined.
  const rank = new Map(data.sources.map((source, i) => [source.id, i]));
  listed = [...data.companies].sort((a, b) => rank.get(a.sources[0]) - rank.get(b.sources[0]));
  const sources = data.sources.filter((s) => counts.has(s.id)).map((s) => [s.id, `${sourceName(s.id)} (${counts.get(s.id)})`]);
  const buildings = data.buildings.filter((b) => b.used).map((b) => [b.key, b.name || b.key]).sort(byName);
  // Only regions where some company has its headquarters, with how many companies.
  const regionCounts = new Map();
  for (const company of data.companies) {
    const regions = new Set(company.preferred_headquarters.map((state) => store.index.states.get(state))
      .filter(Boolean).map((info) => info.region).filter(Boolean));
    for (const region of regions) regionCounts.set(region, (regionCounts.get(region) || 0) + 1);
  }
  const regions = data.regions.filter((r) => regionCounts.has(r.key))
    .map((r) => [r.key, `${r.name || r.key} (${regionCounts.get(r.key)})`]).sort(byName);
  const withPrestige = data.companies.filter((c) => c.possible_prestige_goods.length > 0).length;
  const prestige = [['yes', t('company.filter_prestige_yes', { count: withPrestige })],
    ['no', t('company.filter_prestige_no', { count: data.companies.length - withPrestige })]];
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
      filterSelect('region', t('company.filter_region'), regions),
      filterSelect('prestige', t('company.filter_prestige'), prestige)),
    els.list);
  renderList();
}
