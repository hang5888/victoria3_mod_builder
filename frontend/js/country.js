// Country starts. The start screen is the world as the game starts: the map in the countries'
// colours and the list of countries. A country opens in the editor: preview on the left, its parts
// in tabs in the middle, ✕ back to the world. "Every country" sets laws every country starts with.
//
// A start keeps only what the mod changes (see backend/countries.py): definition fields that differ,
// laws by group, and the other parts as a whole value, where null means "as the game has it".
import { api } from './api.js';
import { t } from './i18n.js';
import { store, refreshState, loadData, language, languageName, nameOf, setProject, keptImages,
  countryStartName } from './store.js';
import { renderSidebar, refreshSidebar, takePending } from './sidebar.js';
import { h, fill, toast, confirmDialog, openPicker, debounce } from './ui.js';
import { thumb } from './icons.js';
import { run, section, field, sourceName, sourceBadges, keyChips, objectChip, scriptArea, pickerItems } from './widgets.js';
import { bracesBalanced } from './script.js';
import { CountryMap } from './map.js';
import { groupOf, groupRows, rowLaw, rowName, lawLimit, groupLimits, limitBadge, defaultOf, projectGroups } from './law.js';

const ALL = '*';
const DEFINITION_FIELDS = ['color', 'country_type', 'tier', 'cultures', 'capital', 'religion', 'social_hierarchy'];
// parts kept whole: null leaves the game's
const WHOLE_FIELDS = ['tech_tier', 'techs', 'tax_level', 'taxed_goods', 'tariffs', 'institutions', 'election',
  'ruling', 'extra', 'wealth', 'literacy', 'ruling_party'];
const TABS = ['country', 'politics', 'technology', 'other'];
const DATE_PATTERN = /^\d{1,4}\.\d{1,2}\.\d{1,2}$/;
const PAGE = 200;

let root = null;
let cdata = null;         // /api/countries in the current language
let cdataFor = null;      // the game data it was loaded with
let countries = null;     // tag -> country
let editing = null;       // the start in the editor; null shows the world
let editingProject = null;
let dirty = false;
let tab = 'country';
let worldMap = null;
let capitalMap = null;    // the map of the capital, shared by the countries opened
let limit = PAGE;
const filters = { query: '', type: '', tier: '', region: '', source: '', mine: false, existing: true };
const expanded = new Set();  // law groups unfolded on the politics tab
const els = {};
const sections = {};

window.addEventListener('beforeunload', (event) => {
  if (dirty) event.preventDefault();
});

function blankStart(key) {
  return {
    key, mode: key === ALL ? 'all' : 'override', names: {}, adjs: {}, defs: {}, definition: {}, laws: {}, ig_names: {},
    ...Object.fromEntries(WHOLE_FIELDS.map((name) => [name, null])),
  };
}

async function loadCountries() {
  if (cdata && cdataFor === store.data) return;
  cdata = await api.get('/api/countries?lang=' + encodeURIComponent(language()));
  cdataFor = store.data;
  countries = new Map(cdata.countries.map((country) => [country.key, country]));
  worldMap = null;  // painted from the new data
  capitalMap = null;
}

export async function renderCountry(container) {
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
  await loadCountries();
  if (editingProject !== store.state.project.dir || (editing && editing.mode !== 'all' && !countries.has(editing.key))) {
    editing = null;
    dirty = false;
    editingProject = store.state.project.dir;
  }
  els.sidebar = h('aside', { class: 'col col-sidebar' });
  els.builder = h('div', { class: 'builder' });
  root.replaceChildren(els.builder);
  renderSidebar(els.sidebar, sidebarEditor);
  renderPage();
  // a start clicked in the sidebar of another page
  const wanted = takePending('country_start');
  if (wanted && !(editing && editing.key === wanted)) await open(wanted);
}

function renderPage() {
  if (editing) {
    els.left = h('div', { class: 'col col-left' });
    els.middle = h('div', { class: 'col col-middle' });
    els.builder.className = 'builder country-edit';
    els.builder.replaceChildren(els.sidebar, els.left, els.middle);
    renderLeft();
    renderMiddle();
  } else {
    els.world = h('div', { class: 'col country-world' });
    els.list = h('div', { class: 'col col-right' });
    els.builder.className = 'builder country-world-mode';
    els.builder.replaceChildren(els.sidebar, els.world, els.list);
    renderWorld();
    renderList();
  }
  refreshSidebar();
}

// ------------------------------------------------------------------ helpers

const projectStarts = () => store.project.country_starts || [];
const savedStart = (key) => projectStarts().find((start) => start.key === key) || null;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const country = () => (editing && editing.mode !== 'all' ? countries.get(editing.key) : null);

// The game's value of a part kept whole.
function baseValue(name) {
  const game = country();
  if (name === 'wealth' || name === 'literacy' || name === 'ruling_party') return game[name];
  return game.history[name];
}

// What the country starts with: the mod's value, else the game's.
const current = (name) => (editing[name] !== null && editing[name] !== undefined ? editing[name] : baseValue(name));

function setValue(name, value) {
  editing[name] = same(value, baseValue(name)) ? null : value;
  changed();
}

// A field of the definition: the mod's, else the game's.
function definitionOf(start, game) {
  const own = (start && start.definition) || {};
  return Object.fromEntries(DEFINITION_FIELDS.map((name) => [name, name in own ? own[name] : game[name]]));
}

const def = (name) => definitionOf(editing, country())[name];

function setDef(name, value) {
  if (same(value, country()[name])) delete editing.definition[name];
  else editing.definition[name] = value;
  changed();
}

function changed() {
  dirty = true;
  renderPreview();
  refreshSidebar();
}

function refresh(name) {
  if (!sections[name]) return;
  const fresh = builders[name]();
  sections[name].replaceWith(fresh);
  sections[name] = fresh;
}

const rgb = (color) => (color ? `rgb(${color.join(',')})` : 'transparent');
const hex = (color) => '#' + (color || [128, 128, 128]).map((n) => n.toString(16).padStart(2, '0')).join('');
const fromHex = (text) => [1, 3, 5].map((i) => parseInt(text.slice(i, i + 2), 16));

function swatch(color, className = 'country-swatch') {
  return h('span', { class: className, style: `background:${rgb(color)}` });
}

function displayName(game, start) {
  return (start && start.names[language()]) || game.name || game.key;
}

const levelName = (list, key) => {
  const found = cdata.levels[list].find((level) => level.key === key);
  return found ? found.name : key;
};

// ------------------------------------------------------------ starting laws

function lawGroupOf(law) {
  const game = store.index.laws.get(law);
  if (game) return game.group;
  const mine = (store.project.laws || []).find((item) => item.key === law);
  return mine ? mine.group : '';
}

function stateReligion(definition) {
  return definition.religion || cdata.culture_religions[definition.cultures[0]] || '';
}

// Whether a condition of a starting law preset holds for a country definition.
function holds(cond, definition) {
  if (!cond) return true;
  if (cond.all) return cond.all.every((part) => holds(part, definition));
  if (cond.any) return cond.any.some((part) => holds(part, definition));
  if (cond.not) return !holds(cond.not, definition);
  if (cond.type) return definition.country_type === cond.type;
  if (cond.religion) return cond.religion.includes(stateReligion(definition));
  if (cond.dlc) return true;  // as with every DLC
  return false;
}

// The laws the country's history sets: group -> {law, via: 'explicit' | 'preset', preset}.
function historyLaws(game, definition) {
  const laws = {};
  for (const step of game.history.law_steps) {
    if (step.law) {
      const group = lawGroupOf(step.law);
      if (group) laws[group] = { law: step.law, via: 'explicit' };
      continue;
    }
    for (const part of cdata.effects[step.effect] || []) {
      const group = holds(part.cond, definition) && lawGroupOf(part.law);
      if (group) laws[group] = { law: part.law, via: 'preset', preset: step.effect };
    }
  }
  return laws;
}

// The laws set for every country: the one being edited, else the saved one.
function everyoneLaws() {
  if (editing && editing.mode === 'all') return editing.laws;
  const saved = savedStart(ALL);
  return saved ? saved.laws : {};
}

// What a country starts with in a group, without the mod's own law for it ({law, via}).
function lawWithoutMine(group, fromHistory) {
  const everyone = everyoneLaws();
  if (everyone[group]) return { law: everyone[group], via: 'all' };
  if (fromHistory[group]) return fromHistory[group];
  const fallback = defaultOf(group);
  return fallback ? { law: fallback, via: 'default' } : null;
}

function startLaw(group, fromHistory) {
  if (editing.mode === 'all') return editing.laws[group] ? { law: editing.laws[group], via: 'all' } : null;
  if (editing.laws[group]) return { law: editing.laws[group], via: 'mine' };
  return lawWithoutMine(group, fromHistory);
}

function lawName(key) {
  const row = findRow(key);
  return row ? rowName(row) : nameOf('laws', key);
}

function findRow(key) {
  const group = lawGroupOf(key);
  return group ? groupRows(group).find((row) => row.key === key) : null;
}

// Laws for some countries only (see the law page), and the choices that pick one.
function lawLimits(key) {
  const row = findRow(key);
  if (!row) return [];
  return [...groupLimits(groupOf(lawGroupOf(key))), lawLimit(rowLaw(row))].filter(Boolean);
}

// -------------------------------------------------------------- opening

async function open(key) {
  if (dirty && !(await confirmDialog(t('country.discard_confirm'), t('company.discard')))) return;
  if (key !== ALL && !countries.has(key)) return;
  const saved = savedStart(key);
  editing = { ...blankStart(key), ...structuredClone(saved || {}) };
  dirty = false;
  tab = key === ALL ? 'politics' : 'country';
  renderPage();
  if (els.middle) els.middle.scrollTop = 0;
}

async function close() {
  if (dirty && !(await confirmDialog(t('country.discard_confirm'), t('company.discard')))) return;
  editing = null;
  dirty = false;
  renderPage();
}

async function save() {
  const result = await api.post('/api/project/country_start', { start: editing, keep_images: keptImages() });
  if (result.errors.length) {
    toast(result.errors.map(problemText).join('\n'), 'error');
    return;
  }
  setProject(result.project);
  dirty = false;
  renderLeft();
  refreshSidebar();
  toast(t('company.saved', { dir: result.dir }));
}

async function remove(start) {
  const current = editing && editing.key === start.key;
  if (!(await confirmDialog(t('country.delete_confirm', { name: countryStartName(start) }), t('company.delete')))) return;
  setProject(await api.post('/api/project/country_start/delete', { key: start.key, keep_images: keptImages() }));
  if (current) {
    dirty = false;
    editing = null;
  }
  renderPage();
  toast(t('company.deleted'));
}

const sidebarEditor = {
  kind: 'country_start',
  state: () => ({ key: editing && savedStart(editing.key) ? editing.key : null, dirty }),
  open: (item) => open(item.key),
  remove: (item) => remove(item),
};

// ------------------------------------------------------------------- world

// Who owns each province as the game starts.
function provinceOwners() {
  const owners = new Map();
  for (const shares of Object.values(cdata.shares)) {
    for (const [tag, provinces] of shares) for (const hex of provinces) owners.set(hex, tag);
  }
  return owners;
}

function colors() {
  const result = new Map();
  for (const game of cdata.countries) result.set(game.key, definitionOf(savedStart(game.key), game).color);
  return result;
}

function renderWorld() {
  if (!worldMap) worldMap = new CountryMap({ onPick: (tag) => run(() => open(tag)) });
  const painted = colors();
  const signature = JSON.stringify([...painted]);
  if (worldMap.signature !== signature) {  // painting takes a moment: only when a colour changed
    worldMap.signature = signature;
    worldMap.setOwners(provinceOwners(), painted);
  }
  const existing = cdata.countries.filter((game) => game.stats.states > 0).length;
  fill(els.world,
    h('div', { class: 'col-head' }, h('h2', {}, t('country.title')),
      h('span', { class: 'muted' }, t('country.count', { count: existing, total: cdata.countries.length }))),
    h('p', { class: 'muted small' }, t('country.world_hint')),
    worldMap.el);
}

function matches(game) {
  const query = filters.query.trim().toLowerCase();
  const start = savedStart(game.key);
  if (query && !displayName(game, start).toLowerCase().includes(query) && !game.key.toLowerCase().includes(query)) {
    return false;
  }
  const definition = definitionOf(start, game);
  if (filters.type && definition.country_type !== filters.type) return false;
  if (filters.tier && definition.tier !== filters.tier) return false;
  if (filters.region) {
    const capital = store.index.states.get(definition.capital);
    if (!capital || capital.region !== filters.region) return false;
  }
  if (filters.source && !game.sources.includes(filters.source)) return false;
  if (filters.mine && !start) return false;
  if (filters.existing && game.stats.states === 0) return false;
  return true;
}

function renderList() {
  const select = (name, placeholder, options) => {
    const el = h('select', {
      class: 'input', title: placeholder,
      onchange: () => { filters[name] = el.value; limit = PAGE; renderRows(); },
    }, h('option', { value: '' }, placeholder), options.map(([value, text]) => h('option', { value }, text)));
    el.value = filters[name];
    return el;
  };
  const check = (name, label) => h('label', { class: 'check' },
    h('input', { type: 'checkbox', checked: filters[name],
      onchange: (event) => { filters[name] = event.target.checked; limit = PAGE; renderRows(); } }),
    label);
  const regions = new Set(cdata.countries.map((game) => {
    const capital = store.index.states.get(game.capital);
    return capital && capital.region;
  }).filter(Boolean));
  const sources = new Set(cdata.countries.flatMap((game) => game.sources));
  const search = h('input', {
    class: 'input', type: 'search', placeholder: t('country.search'), value: filters.query,
    oninput: debounce(() => { filters.query = search.value; limit = PAGE; renderRows(); }, 150),
  });
  els.rows = h('div', { class: 'country-rows' });
  const everyone = savedStart(ALL);
  fill(els.list,
    h('div', { class: 'col-head' }, h('h2', {}, t('country.list'))),
    search,
    h('div', { class: 'country-filters' },
      select('type', t('country.filter_type'), cdata.levels.country_types.map((l) => [l.key, l.name])),
      select('tier', t('country.filter_tier'), cdata.levels.tiers.map((l) => [l.key, l.name])),
      select('region', t('country.filter_region'), store.data.regions.filter((r) => regions.has(r.key))
        .map((r) => [r.key, r.name || r.key])),
      select('source', t('company.filter_source'), store.data.sources.filter((s) => sources.has(s.id))
        .map((s) => [s.id, sourceName(s.id)]))),
    h('div', { class: 'row' }, check('existing', t('country.only_existing')), check('mine', t('country.only_mine'))),
    h('button', { class: 'country-row everyone', onclick: () => run(() => open(ALL)) },
      h('span', { class: 'country-swatch all' }, '∗'),
      h('span', { class: 'company-title' },
        h('span', { class: 'company-name' }, t('country.all')),
        h('span', { class: 'muted small' }, everyone && Object.keys(everyone.laws).length
          ? t('country.all_count', { count: Object.keys(everyone.laws).length }) : t('country.all_hint'))),
      everyone && h('span', { class: 'badge accent' }, t('country.modified'))),
    els.rows);
  renderRows();
}

function renderRows() {
  const shown = cdata.countries.filter(matches)
    .sort((a, b) => displayName(a, savedStart(a.key)).localeCompare(displayName(b, savedStart(b.key))));
  fill(els.rows,
    shown.length === 0 && h('p', { class: 'muted small' }, t('country.no_match')),
    shown.slice(0, limit).map((game) => {
      const start = savedStart(game.key);
      const definition = definitionOf(start, game);
      return h('button', { class: 'country-row', title: game.key, onclick: () => run(() => open(game.key)) },
        swatch(definition.color),
        h('span', { class: 'company-title' },
          h('span', { class: 'company-name' }, displayName(game, start)),
          h('span', { class: 'company-key' }, `${game.key} · ${levelName('tiers', definition.tier)}`)),
        h('span', { class: 'side-badges' },
          start && h('span', { class: 'badge accent' }, t('country.modified')),
          game.stats.states === 0 && h('span', { class: 'badge faded', title: t('country.not_existing_hint') },
            t('country.not_existing')),
          sourceBadges(game)));
    }),
    shown.length > limit && h('button', { class: 'btn picker-more', onclick: () => { limit += PAGE; renderRows(); } },
      t('common.show_more', { count: shown.length - limit })));
}

// ------------------------------------------------------------------ preview

function renderLeft() {
  els.preview = h('div', { class: 'preview' });
  fill(els.left,
    h('div', { class: 'col-head' },
      h('h2', {}, t('company.editing')),
      h('button', { class: 'btn primary', onclick: () => run(save) }, t('editor.save'))),
    els.preview);
  renderPreview();
}

// What the start changes, part by part.
function changes(start) {
  const parts = [];
  if (['names', 'adjs', 'defs'].some((name) => Object.keys(start[name] || {}).length)) parts.push('names');
  parts.push(...DEFINITION_FIELDS.filter((name) => name in start.definition));
  if (Object.keys(start.laws).length) parts.push('laws');
  if (Object.keys(start.ig_names).length) parts.push('ig_names');
  parts.push(...WHOLE_FIELDS.filter((name) => start[name] !== null && start[name] !== undefined));
  return parts;
}

function problems(start) {
  const found = [];
  if (start.mode === 'all') return found;
  if (start.election && !DATE_PATTERN.test(start.election)) found.push('election');
  if (start.definition.cultures && !start.definition.cultures.length) found.push('cultures');
  if (start.extra !== null && !bracesBalanced(start.extra)) found.push('braces:extra');
  return found;
}

function problemText(code) {
  if (code.startsWith('braces:')) return t('problem.braces', { name: code.slice(7) });
  return t('cproblem.' + code);
}

function ownedStates(tag) {
  return Object.entries(cdata.shares).filter(([, shares]) => shares.some(([owner]) => owner === tag))
    .map(([state]) => state);
}

function notes(start) {
  const found = [];
  const chosen = Object.values(start.laws).filter((law) => lawLimits(law).length);
  if (chosen.length) found.push(t('country.note_limited', { names: chosen.map(lawName).join(' / ') }));
  if (start.mode === 'all') {
    if (Object.keys(start.laws).length) found.push(t('country.note_all'));
    return found;
  }
  const game = country();
  if (game.stats.states === 0) found.push(t('country.not_existing_hint'));
  else if (!ownedStates(game.key).includes(def('capital'))) found.push(t('country.note_capital'));
  if (game.named_from_capital && Object.keys(start.names).length) found.push(t('country.note_named_from_capital'));
  return found;
}

function stat(label, value) {
  return h('div', { class: 'stat' }, h('b', {}, value), h('span', {}, label));
}

function renderPreview() {
  if (!els.preview) return;
  const start = editing;
  const found = problems(start);
  const extra = notes(start);
  const parts = changes(start);
  const changeList = h('div', { class: 'preview-group' },
    h('h4', {}, t('country.changes')),
    parts.length ? h('ul', { class: 'country-changes' }, parts.map((part) => h('li', {},
      part === 'laws' ? t('country.change_laws', { count: Object.keys(start.laws).length }) : t('country.part.' + part))))
      : h('span', { class: 'muted' }, t('country.no_changes')));
  if (start.mode === 'all') {
    fill(els.preview,
      h('div', { class: 'country-flag all' }, '∗'),
      h('h3', { class: 'preview-name' }, t('country.all')),
      h('p', { class: 'muted small' }, t('country.all_desc')),
      dirty && h('div', { class: 'preview-meta' }, h('span', { class: 'badge warn' }, t('company.unsaved'))),
      changeList,
      found.length > 0 && h('ul', { class: 'problems' }, found.map((code) => h('li', {}, problemText(code)))),
      extra.length > 0 && h('ul', { class: 'notes' }, extra.map((note) => h('li', {}, note))));
    return;
  }
  const game = country();
  const lang = language();
  const definition = definitionOf(start, game);
  const ruling = current('ruling');
  const tier = current('tech_tier');
  const filled = store.state.languages.filter((l) => start.names[l.key]);
  fill(els.preview,
    h('div', { class: 'country-flag', style: `background:${rgb(definition.color)}`, title: t('country.flag_hint') }),
    h('h3', { class: 'preview-name' }, start.names[lang] || game.name),
    (start.defs[lang] || game.def) && h('p', { class: 'muted small' }, start.defs[lang] || game.def),
    h('div', { class: 'preview-meta' },
      h('span', { class: 'company-key' }, game.key),
      h('span', { class: 'badge' + (savedStart(game.key) ? ' accent' : '') },
        savedStart(game.key) ? t('country.modified') : t('country.game')),
      dirty && h('span', { class: 'badge warn' }, t('company.unsaved'))),
    h('div', { class: 'muted' }, [levelName('country_types', definition.country_type), levelName('tiers', definition.tier)]
      .join(' · ')),
    h('div', { class: 'preview-group' },
      h('h4', {}, t('country.part.capital')),
      h('div', {}, nameOf('states', definition.capital) || '—')),
    h('div', { class: 'preview-group' },
      h('h4', {}, t('country.part.cultures')),
      h('div', { class: 'chips' }, definition.cultures.map((key) => objectChip('cultures', key)))),
    h('div', { class: 'stats country-stats' },
      stat(t('country.stat.states'), String(game.stats.states)),
      stat(t('country.stat.population'), game.stats.population.toLocaleString()),
      stat(t('country.stat.buildings'), String(game.stats.buildings)),
      stat(t('country.stat.characters'), String(game.stats.characters))),
    h('div', { class: 'preview-group' },
      h('h4', {}, t('country.part.tech_tier')),
      h('div', {}, tier ? t('country.tier_n', { n: tier }) : t('country.tier_none'))),
    h('div', { class: 'preview-group' },
      h('h4', {}, t('country.part.ruling')),
      ruling.length ? h('div', { class: 'chips' }, ruling.map((ig) => h('span', { class: 'chip' },
        thumb(store.index.interest_groups.get(ig) ? store.index.interest_groups.get(ig).icon : '', 64, 'chip-icon'),
        igName(ig))))
        : h('span', { class: 'muted' }, t('country.ruling_game'))),
    changeList,
    h('div', { class: 'preview-group' },
      h('h4', {}, t('company.translations', { count: filled.length, total: store.state.languages.length })),
      h('div', { class: 'chips' }, store.state.languages.map((l) =>
        h('span', { class: 'chip' + (start.names[l.key] ? ' filled' : ' missing'), title: start.names[l.key] || '' }, l.name)))),
    found.length > 0 && h('ul', { class: 'problems' }, found.map((code) => h('li', {}, problemText(code)))),
    extra.length > 0 && h('ul', { class: 'notes' }, extra.map((note) => h('li', {}, note))));
}

// The name of an interest group in this country: the mod's, the history's, or the game's.
function igName(ig) {
  const own = editing.ig_names[ig] && editing.ig_names[ig][language()];
  const game = country();
  return own || (game && game.ig_name_texts[ig]) || nameOf('interest_groups', ig);
}

// ------------------------------------------------------------------- editor

function renderMiddle() {
  for (const name of Object.keys(sections)) delete sections[name];
  const tabs = editing.mode === 'all' ? ['politics'] : TABS;
  for (const name of TAB_SECTIONS[editing.mode === 'all' ? 'all' : tab]) sections[name] = builders[name]();
  fill(els.middle,
    h('div', { class: 'editor-bar' },
      h('div', { class: 'tabs' }, tabs.map((name) => h('button', {
        class: 'tab' + (name === tab || editing.mode === 'all' ? ' active' : ''),
        onclick: () => { tab = name; renderMiddle(); els.middle.scrollTop = 0; },
      }, t('country.tab.' + name)))),
      h('button', { class: 'btn icon-btn', title: t('country.back'), onclick: () => run(close) }, '✕')),
    Object.values(sections));
}

// A "back to the game's" button for a part the mod changed.
function resetButton(changedNow, reset) {
  return changedNow && h('button', { class: 'btn small', title: t('country.reset_hint'), onclick: reset }, t('country.reset'));
}

function resetWhole(name, sectionName) {
  return resetButton(editing[name] !== null, () => { editing[name] = null; changed(); refresh(sectionName); });
}

function resetDef(name, sectionName = 'definition') {
  return resetButton(name in editing.definition, () => {
    delete editing.definition[name];
    changed();
    refresh(sectionName);
    if (name === 'color') refresh('capital');
  });
}

function labelled(text, ...extra) {
  return h('span', { class: 'country-label' }, text, extra);
}

function selectOf(options, value, onChange, empty) {
  const el = h('select', { class: 'input', onchange: () => onChange(el.value) },
    empty !== undefined && h('option', { value: '' }, empty),
    options.map(([key, text]) => h('option', { value: key }, text)));
  el.value = value;
  return el;
}

// ------------------------------------------------------------ country tab

function namesSection() {
  const lang = language();
  const game = country();
  const input = (field, placeholder) => h('input', {
    class: 'input', type: 'text', value: editing[field][lang] || '', placeholder,
    oninput: (event) => {
      const value = event.target.value.trim();
      if (value) editing[field][lang] = value;
      else delete editing[field][lang];
      changed();
    },
  });
  return section(t('country.names'), t('country.names_hint'),
    field(t('country.name', { language: languageName(lang) }), input('names', game.name), t('country.name_hint')),
    field(t('country.adj', { language: languageName(lang) }), input('adjs', game.adj)),
    field(t('country.def', { language: languageName(lang) }), input('defs', game.def)),
    game.named_from_capital && h('p', { class: 'muted small' }, t('country.note_named_from_capital')));
}

function definitionSection() {
  const game = country();
  const color = h('input', { class: 'country-color', type: 'color', value: hex(def('color')),
    onchange: () => { setDef('color', fromHex(color.value)); refresh('definition'); refresh('capital'); } });
  const religionOf = cdata.culture_religions[def('cultures')[0]];
  return section(t('country.definition'), t('country.definition_hint', { source: sourceName(game.source) }),
    h('div', { class: 'country-grid' },
      field(labelled(t('country.part.color'), resetDef('color')), h('div', { class: 'row' }, color, swatch(def('color')))),
      field(labelled(t('country.part.country_type'), resetDef('country_type')),
        selectOf(cdata.levels.country_types.map((l) => [l.key, l.name]), def('country_type'),
          (value) => { setDef('country_type', value); refresh('definition'); })),
      field(labelled(t('country.part.tier'), resetDef('tier')),
        selectOf(cdata.levels.tiers.map((l) => [l.key, l.name]), def('tier'),
          (value) => { setDef('tier', value); refresh('definition'); })),
      field(labelled(t('country.part.religion'), resetDef('religion')),
        selectOf(store.data.religions.map((r) => [r.key, r.name || r.key]), def('religion'),
          (value) => { setDef('religion', value); refresh('definition'); },
          t('country.religion_of_culture', { name: religionOf ? nameOf('religions', religionOf) : '—' }))),
      field(labelled(t('country.part.social_hierarchy'), resetDef('social_hierarchy')),
        selectOf(store.data.social_hierarchies.map((s) => [s.key, s.name || s.key]), def('social_hierarchy'),
          (value) => { setDef('social_hierarchy', value); refresh('definition'); }, t('country.hierarchy_default')))),
    h('div', {},
      keyChips({ keys: def('cultures'), kind: 'cultures', label: t('country.part.cultures'), hint: t('country.cultures_hint'),
        onChange: (keys) => { setDef('cultures', keys); refresh('definition'); } }),
      resetDef('cultures')));
}

// The capital, chosen on a map of the country (the other countries dimmed) or from a list.
function capitalSection() {
  const game = country();
  const capital = def('capital');
  const owned = ownedStates(game.key);
  const choose = (key) => {
    if (!key || !editing || editing.mode === 'all') return;
    setDef('capital', key);
    refresh('capital');
  };
  if (!capitalMap) capitalMap = new CountryMap({ onState: choose });
  capitalMap.onState = choose;
  const painted = colors();
  painted.set(game.key, def('color'));
  capitalMap.setOwners(provinceOwners(), painted, { tag: game.key, state: capital });
  const list = () => {
    const mine = new Set(owned);
    const items = pickerItems('states').map((item) => (mine.has(item.key)
      ? { ...item, sub: `${t('country.capital_owned')} · ${item.sub}` } : item))
      .sort((a, b) => Number(mine.has(b.key)) - Number(mine.has(a.key)));
    openPicker({ title: t('country.part.capital'), multi: false, selected: [capital], items,
      onDone: ([key]) => choose(key) });
  };
  return section(t('country.part.capital'), t('country.capital_hint'),
    h('div', { class: 'row country-capital' },
      h('b', {}, nameOf('states', capital) || '—'),
      h('span', { class: 'company-key' }, capital),
      capital && !owned.includes(capital) && h('span', { class: 'badge warn', title: t('country.note_capital') },
        t('country.capital_not_owned')),
      h('span', { class: 'grow' }),
      resetDef('capital', 'capital'),
      h('button', { class: 'btn', onclick: list }, t('country.capital_list'))),
    capitalMap.el);
}

// ----------------------------------------------------------- politics tab

function lawsSection() {
  const data = store.data;
  const fromHistory = editing.mode === 'all' ? {} : historyLaws(country(), definitionOf(editing, country()));
  const categories = [...data.law_categories];
  for (const group of data.law_groups) {
    if (!categories.some((c) => c.key === group.category)) categories.push({ key: group.category, name: group.category });
  }
  const groups = [...data.law_groups, ...projectGroups().map((group) => groupOf(group.key))];
  return section(t('country.laws'), editing.mode === 'all' ? t('country.laws_all_hint') : t('country.laws_hint'),
    h('div', { class: 'law-columns' }, categories.map((category) => h('section', { class: 'law-column' },
      h('h3', { class: 'law-column-title' }, category.name || category.key),
      groups.filter((group) => group.category === category.key).map((group) => startCard(group, fromHistory))))),
    h('p', { class: 'muted small' }, t('country.laws_note')));
}

function viaBadge(current) {
  if (!current) return null;  // "not set" is the line above
  const title = current.via === 'preset' ? current.preset : t('country.via_hint.' + current.via);
  return h('span', { class: 'badge' + (current.via === 'mine' || current.via === 'all' ? ' accent' : ''), title },
    t('country.via.' + current.via));
}

function chooseLaw(group, key, fromHistory) {
  if (editing.mode === 'all') {
    if (key) editing.laws[group] = key;
    else delete editing.laws[group];
  } else {
    const without = lawWithoutMine(group, fromHistory);
    if (!key || (without && without.law === key)) delete editing.laws[group];
    else editing.laws[group] = key;
  }
  changed();
  refresh('laws');
  refresh('government');  // the laws decide whether there are elections
}

function startCard(group, fromHistory) {
  const current = startLaw(group.key, fromHistory);
  const rows = groupRows(group.key);
  const open = expanded.has(group.key);
  const chosen = current && rows.find((row) => row.key === current.law);
  const toggle = () => {
    if (expanded.has(group.key)) expanded.delete(group.key);
    else expanded.add(group.key);
    refresh('laws');
  };
  const mine = Boolean(editing.laws[group.key]);
  const limits = groupLimits(group);
  return h('div', { class: 'law-group' + (open ? ' open' : '') + (mine ? ' changed' : '') },
    h('button', { class: 'law-group-head', onclick: toggle, title: group.key },
      thumb(chosen ? rowLaw(chosen).icon : '', 128, 'law-group-icon'),
      h('span', { class: 'law-group-text' },
        h('span', { class: 'law-group-name' }, group.name || group.key),
        h('span', { class: 'small' }, current ? lawName(current.law) : t('country.law_unset')),
        h('span', { class: 'row country-via' }, viaBadge(current), limits.map(limitBadge))),
      h('span', { class: 'side-caret' }, open ? '▾' : '▸')),
    open && h('div', { class: 'law-list' },
      editing.mode === 'all' && h('button', {
        class: 'law-row-main country-law' + (current ? '' : ' current'),
        onclick: () => chooseLaw(group.key, '', fromHistory),
      }, h('span', { class: 'law-icon empty' }), h('span', { class: 'company-title' },
        h('span', { class: 'company-name' }, t('country.law_unset')),
        h('span', { class: 'muted small' }, t('country.law_unset_hint')))),
      mine && editing.mode !== 'all' && h('button', { class: 'btn small law-group-edit',
        onclick: () => chooseLaw(group.key, '', fromHistory) }, t('country.law_reset')),
      rows.map((row) => {
        const law = rowLaw(row);
        const limit = lawLimit(law);
        return h('button', {
          class: 'law-row-main country-law' + (current && current.law === row.key ? ' current' : ''),
          onclick: () => chooseLaw(group.key, row.key, fromHistory),
        },
          thumb(law.icon, 64, 'law-icon'),
          h('span', { class: 'company-title' },
            h('span', { class: 'company-name' }, rowName(row)),
            h('span', { class: 'company-key' }, row.key),
            limit && h('span', {}, limitBadge(limit))),
          row.key === defaultOf(group.key) && h('span', { class: 'badge', title: t('law.default_hint') }, t('law.default')));
      })));
}

function igSection() {
  const ruling = current('ruling');
  const lang = language();
  const game = country();
  const rows = store.data.interest_groups.map((ig) => {
    const own = editing.ig_names[ig.key] || {};
    const name = h('input', {
      class: 'input', type: 'text', value: own[lang] || '',
      placeholder: game.ig_name_texts[ig.key] || ig.name || ig.key,
      oninput: () => {
        const texts = { ...(editing.ig_names[ig.key] || {}) };
        if (name.value.trim()) texts[lang] = name.value.trim();
        else delete texts[lang];
        if (Object.keys(texts).length) editing.ig_names[ig.key] = texts;
        else delete editing.ig_names[ig.key];
        changed();
      },
    });
    return h('div', { class: 'country-ig' },
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: ruling.includes(ig.key), onchange: (event) => {
          const next = event.target.checked ? [...ruling, ig.key] : ruling.filter((key) => key !== ig.key);
          setValue('ruling', next);
          refresh('igs');
        } }),
        thumb(ig.icon, 64, 'stance-icon'),
        h('span', {}, ig.name || ig.key)),
      name);
  });
  return section(t('country.igs'), t('country.igs_hint'),
    h('div', { class: 'row country-ig-head' }, h('span', { class: 'field-label grow' }, t('country.part.ruling')),
      h('span', { class: 'field-label grow' }, t('country.ig_name', { language: languageName(lang) })),
      resetWhole('ruling', 'igs')),
    rows);
}

// Whether a law gives anybody votes (as the voting laws of the distribution of power do).
function givesVotes(key) {
  const row = findRow(key);
  const law = row && rowLaw(row);
  return Boolean(law && law.modifiers && (law.modifiers.modifier || []).some((m) => m.key.includes('voting_power')));
}

// Whether the country starts with elections: the game holds them when a law gives votes.
function hasElections(fromHistory) {
  const groups = [...store.data.law_groups, ...projectGroups()];
  return groups.some((group) => {
    const law = startLaw(group.key, fromHistory);
    return law && givesVotes(law.law);
  });
}

// Elections and the ruling party, for countries that start with elections.
function governmentSection() {
  const fromHistory = historyLaws(country(), definitionOf(editing, country()));
  if (!hasElections(fromHistory)) {
    const power = startLaw('lawgroup_distribution_of_power', fromHistory);
    const set = editing.election !== null || editing.ruling_party !== null;
    return section(t('country.government'), null,
      h('p', { class: 'muted' }, t('country.no_elections', { law: power ? lawName(power.law) : '—' })),
      set && h('div', { class: 'notice warn row' }, h('span', { class: 'grow' }, t('country.no_elections_set')),
        h('button', { class: 'btn small', onclick: () => {
          editing.election = null;
          editing.ruling_party = null;
          changed();
          refresh('government');
        } }, t('country.reset'))));
  }
  const election = h('input', {
    class: 'input country-date' + (!current('election') || DATE_PATTERN.test(current('election')) ? '' : ' invalid'),
    type: 'text', value: current('election'), placeholder: '1836.2.1',
    oninput: () => {
      election.classList.toggle('invalid', Boolean(election.value.trim()) && !DATE_PATTERN.test(election.value.trim()));
      setValue('election', election.value.trim());
    },
  });
  return section(t('country.government'), t('country.government_hint'),
    h('div', { class: 'country-grid' },
      field(labelled(t('country.part.ruling_party'), resetWhole('ruling_party', 'government')),
        selectOf(cdata.parties.map((p) => [p.key, p.name || p.key]), current('ruling_party'),
          (value) => { setValue('ruling_party', value); refresh('government'); }, t('country.no_party')),
        t('country.party_hint')),
      field(labelled(t('country.part.election'), resetWhole('election', 'government')), election,
        t('country.election_hint'))));
}

function taxSection() {
  return section(t('country.taxes'), null,
    field(labelled(t('country.part.tax_level'), resetWhole('tax_level', 'taxes')),
      selectOf(cdata.levels.tax_levels.map((l) => [l.key, l.name]), current('tax_level'),
        (value) => { setValue('tax_level', value); refresh('taxes'); }, t('country.unset'))),
    h('div', {},
      keyChips({ keys: current('taxed_goods'), kind: 'goods', label: t('country.part.taxed_goods'),
        hint: t('country.taxed_goods_hint'), onChange: (keys) => { setValue('taxed_goods', keys); refresh('taxes'); } }),
      resetWhole('taxed_goods', 'taxes')));
}

function tariffSection() {
  const tariffs = current('tariffs');
  const rows = tariffs.map((row, i) => h('div', { class: 'row country-line' },
    objectChip('goods', row.goods),
    selectOf([['import', t('country.import')], ['export', t('country.export')]], row.kind, (value) => {
      setValue('tariffs', tariffs.map((r, j) => (j === i ? { ...r, kind: value } : r)));
      refresh('tariffs');
    }),
    selectOf(cdata.levels.tariff_levels.map((l) => [l.key, l.name]), row.level, (value) => {
      setValue('tariffs', tariffs.map((r, j) => (j === i ? { ...r, level: value } : r)));
      refresh('tariffs');
    }),
    h('button', { class: 'btn icon-btn', title: t('common.remove'), onclick: () => {
      setValue('tariffs', tariffs.filter((_r, j) => j !== i));
      refresh('tariffs');
    } }, '✕')));
  const add = () => openPicker({
    title: t('country.part.tariffs'), multi: false, items: pickerItems('goods'),
    onDone: ([goods]) => {
      if (!goods) return;
      setValue('tariffs', [...tariffs, { kind: 'import', goods, level: 'high_tariffs' }]);
      refresh('tariffs');
    },
  });
  return section(t('country.part.tariffs'), t('country.tariffs_hint'),
    h('div', { class: 'row country-section-tools' }, resetWhole('tariffs', 'tariffs'),
      h('button', { class: 'btn', onclick: add }, t('country.add_tariff'))),
    rows.length ? rows : h('span', { class: 'muted' }, t('common.none')));
}

function institutionSection() {
  const institutions = current('institutions');
  const rows = institutions.map((row, i) => h('div', { class: 'row country-line' },
    selectOf(store.data.institutions.map((item) => [item.key, item.name || item.key]), row.institution, (value) => {
      setValue('institutions', institutions.map((r, j) => (j === i ? { ...r, institution: value } : r)));
      refresh('institutions');
    }),
    selectOf([1, 2, 3, 4, 5].map((n) => [String(n), t('country.level_n', { n })]), String(row.level), (value) => {
      setValue('institutions', institutions.map((r, j) => (j === i ? { ...r, level: Number(value) } : r)));
      refresh('institutions');
    }),
    h('button', { class: 'btn icon-btn', title: t('common.remove'), onclick: () => {
      setValue('institutions', institutions.filter((_r, j) => j !== i));
      refresh('institutions');
    } }, '✕')));
  const unused = store.data.institutions.filter((item) => !institutions.some((row) => row.institution === item.key));
  return section(t('country.part.institutions'), t('country.institutions_hint'),
    h('div', { class: 'row country-section-tools' }, resetWhole('institutions', 'institutions'),
      unused.length > 0 && h('button', { class: 'btn', onclick: () => {
        setValue('institutions', [...institutions, { institution: unused[0].key, level: 1 }]);
        refresh('institutions');
      } }, t('country.add_institution'))),
    rows.length ? rows : h('span', { class: 'muted' }, t('common.none')));
}

// ---------------------------------------------------------- technology tab

function technologySection() {
  const tier = current('tech_tier');
  const given = cdata.tech_tiers[String(tier)];
  return section(t('country.technology'), t('country.technology_hint'),
    field(labelled(t('country.part.tech_tier'), resetWhole('tech_tier', 'technology')),
      selectOf([['0', t('country.tier_none')], ...Object.keys(cdata.tech_tiers).map((n) => [n, t('country.tier_n', { n })])],
        String(tier), (value) => { setValue('tech_tier', Number(value)); refresh('technology'); }),
      t('country.tier_hint')),
    given && h('div', { class: 'preview-group' },
      h('h4', {}, t('country.tier_gives')),
      given.eras.length > 0 && h('div', { class: 'muted small' },
        given.eras.map((era) => t('cond.era', { n: era.replace(/\D/g, '') })).join(' · ')),
      h('div', { class: 'chips' }, given.techs.map((key) => objectChip('technologies', key)))),
    h('div', {},
      keyChips({ keys: current('techs'), kind: 'technologies', label: t('country.part.techs'), hint: t('country.techs_hint'),
        onChange: (keys) => { setValue('techs', keys); refresh('technology'); } }),
      resetWhole('techs', 'technology')));
}

function populationSection() {
  const wealth = cdata.levels.wealth_levels.map((key) => [key, t('country.wealth.' + key)]);
  const literacy = cdata.levels.literacy_levels.map((key) => [key, t('country.literacy.' + key)]);
  return section(t('country.population'), t('country.population_hint'),
    h('div', { class: 'country-grid' },
      field(labelled(t('country.part.wealth'), resetWhole('wealth', 'population')),
        selectOf(wealth, current('wealth'), (value) => { setValue('wealth', value); refresh('population'); },
          t('country.unset'))),
      field(labelled(t('country.part.literacy'), resetWhole('literacy', 'population')),
        selectOf(literacy, current('literacy'), (value) => { setValue('literacy', value); refresh('population'); },
          t('country.unset')))));
}

// --------------------------------------------------------------- other tab

function otherSection() {
  const game = country();
  return section(t('country.other'), t('country.other_hint'),
    h('div', { class: 'script-field' },
      h('div', { class: 'row' }, h('span', { class: 'field-label' }, t('country.part.extra')), resetWhole('extra', 'other')),
      scriptArea(() => current('extra'), (value) => { editing.extra = value === game.history.extra ? null : value; },
        changed)),
    h('div', { class: 'muted small' }, t('country.files'),
      h('ul', {}, game.history.files.length ? game.history.files.map((file) => h('li', { class: 'mono' }, file))
        : h('li', {}, t('country.no_files')))));
}

const builders = {
  names: namesSection,
  definition: definitionSection,
  capital: capitalSection,
  laws: lawsSection,
  igs: igSection,
  government: governmentSection,
  taxes: taxSection,
  tariffs: tariffSection,
  institutions: institutionSection,
  technology: technologySection,
  population: populationSection,
  other: otherSection,
};

const TAB_SECTIONS = {
  country: ['names', 'definition', 'capital'],
  politics: ['laws', 'igs', 'government', 'taxes', 'tariffs', 'institutions'],
  technology: ['technology', 'population'],
  other: ['other'],
  all: ['laws'],
};
