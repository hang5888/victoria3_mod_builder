// Goods builder. The start screen is the game's market: four columns (staple, industrial, luxury,
// military) of goods that unfold into their prestige goods, or the same goods sorted by the pop needs
// they fill. A good or prestige good opens in the
// editor: preview on the left, editor in the middle, ✕ back to the board.
import { api, textureUrl } from './api.js';
import { t } from './i18n.js';
import { store, refreshState, loadData, language, languageName, nameOf, goodName, prestigeGoodName, companyName,
  factoryName, monumentName, setProject, editingImages, keptImages } from './store.js';
import { renderSidebar, refreshSidebar, takePending } from './sidebar.js';
import { h, fill, toast, confirmDialog, debounce } from './ui.js';
import { thumb } from './icons.js';
import { run, section, field, objectChip, sourceName, sourceBadges, imageField, scriptArea as scriptBox } from './widgets.js';
import { bracesBalanced } from './script.js';
import { COUNTRY_KINDS, conditionEditor, clearConditionCache } from './conditions.js';

const CATEGORIES = ['staple', 'industrial', 'luxury', 'military'];
const FLAGS = { tradeable: true, local: false, fixed_price: false, pop_consumption_can_add_infrastructure: false };
const NUMBERS = ['prestige_factor', 'traded_quantity', 'convoy_cost_multiplier', 'obsession_chance', 'consumption_tax_cost'];
const NEED_FIELDS = ['weight', 'max_supply_share', 'min_supply_share'];
const GOOD_FIELDS = ['key', 'mode', 'names', 'texture', 'cost', 'category', ...Object.keys(FLAGS), ...NUMBERS, 'color',
  'needs', 'extra'];
const PRESTIGE_FIELDS = ['key', 'mode', 'names', 'base_good', 'prestige_bonus', 'texture', 'possible', 'extra'];
const KEY_PATTERN = /^[A-Za-z0-9_.\-]+$/;
const NUMBER_PATTERN = /^-?\d+(\.\d+)?$/;
// What the base game's prestige goods need: the Charters of Commerce DLC.
const DEFAULT_POSSIBLE = 'has_dlc_feature = mp1_content';
const MAX_USES = 12;  // buildings listed in the preview before "and N more"

let root = null;
let editing = null;          // the good or prestige good in the editor; null shows the board
let editingKind = 'good';    // what `editing` is: 'good' or 'prestige'
let originalKey = null;      // its key in the project file, when it was opened from there
let editingProject = null;   // folder of the project `editing` belongs to
let dirty = false;
let pristine = true;         // nothing changed since it was opened (switching versions needs no question)
let versionSource = null;    // the source whose version an overridden item was started from
let autoColor = false;       // the colour of a new good follows its icon until it is set by hand
let usesCache = null;        // key -> {producers, consumers}, for the preview
const expanded = new Set();  // goods unfolded on the board (`need:key` in the needs view)
const filters = { query: '', source: '' };
const VIEW_KEY = 'vmb.goods.view';
let view = readView();       // how the board is sorted: 'category' or 'needs'

function readView() {
  try {
    return localStorage.getItem(VIEW_KEY) === 'needs' ? 'needs' : 'category';
  } catch {
    return 'category';
  }
}

function setView(name) {
  view = name;
  try {
    localStorage.setItem(VIEW_KEY, name);
  } catch {
    // the board still switches, it is only not remembered
  }
  renderBoard();
}
const els = {};
const sections = {};

window.addEventListener('beforeunload', (event) => {
  if (dirty) event.preventDefault();
});

function blankGood(category, need = '') {
  return {
    key: '', mode: 'new', names: {}, texture: '', cost: '', category, ...FLAGS,
    ...Object.fromEntries(NUMBERS.map((name) => [name, ''])), prestige_factor: '5',
    color: null, needs: need ? [{ need, ...Object.fromEntries(NEED_FIELDS.map((name) => [name, ''])) }] : [],
    extra: '',
  };
}

function blankPrestige(base) {
  return { key: '', mode: 'new', names: {}, base_good: base, prestige_bonus: '0.1', texture: '',
    possible: DEFAULT_POSSIBLE, extra: '' };
}

// The needs a good of the game is in, as the game has them.
function gameNeedsOf(key) {
  return store.data.pop_needs.flatMap((need) => need.entries.filter((entry) => entry.goods === key)
    .map((entry) => ({ need: need.key, ...Object.fromEntries(NEED_FIELDS.map((name) => [name, entry[name] || ''])) })));
}

// The editable part of a good (drops display-only fields such as its sources).
function goodModel(good) {
  const model = structuredClone(Object.fromEntries(GOOD_FIELDS.map((name) => [name, good[name]])));
  return { ...blankGood(''), ...model, names: model.names || {}, needs: model.needs || [] };
}

function prestigeModel(good) {
  const model = structuredClone(Object.fromEntries(PRESTIGE_FIELDS.map((name) => [name, good[name]])));
  return { ...blankPrestige(''), ...model, names: model.names || {} };
}

export async function renderGoods(container) {
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
  usesCache = null;
  if (editingProject !== store.state.project.dir) {
    editing = null;  // the board
    originalKey = null;
    dirty = false;
    editingProject = store.state.project.dir;
  }
  els.sidebar = h('aside', { class: 'col col-sidebar' });
  els.builder = h('div', { class: 'builder' });
  root.replaceChildren(els.builder);
  renderSidebar(els.sidebar, sidebarEditor);
  renderPage();
  // an item of this page clicked in the sidebar of another page
  const wantedGood = takePending('good');
  const wantedPrestige = takePending('prestige_good');
  const good = wantedGood && projectGoods().find((g) => g.key === wantedGood);
  const prestige = wantedPrestige && projectPrestige().find((g) => g.key === wantedPrestige);
  if (good && !(editingKind === 'good' && originalKey === good.key)) await editGood(good, good.key);
  if (prestige && !(editingKind === 'prestige' && originalKey === prestige.key)) await editPrestige(prestige, prestige.key);
}

function renderPage() {
  if (editing) {
    els.left = h('div', { class: 'col col-left' });
    els.middle = h('div', { class: 'col col-middle' });
    els.builder.className = 'builder law-edit';
    els.builder.replaceChildren(els.sidebar, els.left, els.middle);
    renderLeft();
    renderMiddle();
  } else {
    els.board = h('div', { class: 'col law-board' });
    els.builder.className = 'builder law-board-mode';
    els.builder.replaceChildren(els.sidebar, els.board);
    renderBoard();
  }
  refreshSidebar();
}

// ----------------------------------------------------------------- helpers

const projectGoods = () => store.project.goods || [];
const projectPrestige = () => store.project.prestige_goods || [];
const gameGood = (key) => store.data.gameGoods.find((good) => good.key === key);
const gamePrestige = (key) => store.data.gamePrestigeGoods.find((good) => good.key === key);

// Every good: the game's (or the mod's version of them), then the mod's new ones.
function goodRows() {
  const mine = new Map(projectGoods().map((good) => [good.key, good]));
  const rows = store.data.gameGoods.map((game) => ({ key: game.key, game, mine: mine.get(game.key) || null }));
  for (const good of projectGoods()) {
    if (good.mode === 'new' || !gameGood(good.key)) rows.push({ key: good.key, game: null, mine: good });
  }
  return rows;
}

// The prestige goods of a good, the same way.
function prestigeRows(base) {
  const mine = new Map(projectPrestige().map((good) => [good.key, good]));
  const rows = store.data.gamePrestigeGoods.map((game) => ({ key: game.key, game, mine: mine.get(game.key) || null }))
    .filter((row) => rowItem(row).base_good === base);
  for (const good of projectPrestige()) {
    if (good.base_good === base && (good.mode === 'new' || !gamePrestige(good.key))) {
      rows.push({ key: good.key, game: null, mine: good });
    }
  }
  return rows;
}

const rowItem = (row) => row.mine || row.game;
const goodRowName = (row) => (row.mine ? goodName(row.mine) : row.game.name || row.game.key);
const prestigeRowName = (row) => (row.mine ? prestigeGoodName(row.mine) : row.game.name || row.game.key);
const categoryName = (key) => {
  const text = t('picker.goods.' + key);
  return text === 'picker.goods.' + key ? key : text;
};
const needName = (key) => nameOf('pop_needs', key);
const hex = (color) => '#' + color.map((n) => n.toString(16).padStart(2, '0')).join('');
const rgb = (text) => [1, 3, 5].map((i) => parseInt(text.slice(i, i + 2), 16));

function keyTaken(key, kind = editingKind) {
  if (kind === 'good') return Boolean(gameGood(key)) || projectGoods().some((g) => g.key === key && g.key !== originalKey);
  return Boolean(gamePrestige(key)) || projectPrestige().some((g) => g.key === key && g.key !== originalKey);
}

// The average colour of an image, weighted by how opaque each pixel is; null when it cannot be read.
function averageColor(path) {
  return new Promise((resolve) => {
    if (!path) {
      resolve(null);
      return;
    }
    const image = new Image();
    image.onload = () => {
      const canvas = h('canvas', { width: 32, height: 32 });
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0, 32, 32);
      const pixels = context.getImageData(0, 0, 32, 32).data;
      const sum = [0, 0, 0];
      let weight = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const alpha = pixels[i + 3] / 255;
        for (let c = 0; c < 3; c++) sum[c] += pixels[i + c] * alpha;
        weight += alpha;
      }
      resolve(weight ? sum.map((n) => Math.round(n / weight)) : null);
    };
    image.onerror = () => resolve(null);
    image.src = textureUrl(path, 64);
  });
}

// Which buildings make and use a good: over all methods of the game's buildings and the mod's.
function usesOf(key) {
  if (!usesCache) usesCache = new Map();
  if (usesCache.has(key)) return usesCache.get(key);
  const own = [...(store.project.factories || []), ...(store.project.monuments || [])];
  const ownKeys = new Set(own.map((building) => building.key));
  const buildings = [...store.data.factories.filter((building) => !ownKeys.has(building.key)), ...own];
  const pmgOf = (entry) => (entry.type === 'own' ? entry : store.index.pmgs.get(entry.key));
  const pmOf = (entry) => (entry.type === 'own' ? entry : store.index.pms.get(entry.key));
  const found = { producers: [], consumers: [] };
  for (const building of buildings) {
    const made = new Set();
    const used = new Set();
    for (const entry of building.pmgs || []) {
      for (const pmEntry of (pmgOf(entry) || { pms: [] }).pms) {
        const pm = pmOf(pmEntry);
        if (!pm) continue;
        if (pm.outputs.some((row) => row.good === key)) made.add(pm.key);
        if (pm.inputs.some((row) => row.good === key)) used.add(pm.key);
      }
    }
    const name = ownKeys.has(building.key)
      ? (store.project.factories.includes(building) ? factoryName(building) : monumentName(building))
      : nameOf('factories', building.key);
    if (made.size) found.producers.push({ key: building.key, name, pms: [...made] });
    if (used.size) found.consumers.push({ key: building.key, name, pms: [...used] });
  }
  usesCache.set(key, found);
  return found;
}

// The needs written again in whole because an overridden good changed or left an entry the game has.
function rewrittenNeeds(good) {
  if (good.mode !== 'override') return [];
  const rows = new Map(good.needs.map((row) => [row.need, row]));
  const same = (a, b) => NEED_FIELDS.every((name) => (a[name] === '' ? null : Number(a[name])) === (b[name] === '' ? null : Number(b[name])));
  return gameNeedsOf(good.key).filter((entry) => !rows.has(entry.need) || !same(rows.get(entry.need), entry))
    .map((entry) => entry.need);
}

// Same checks as the backend, so problems show up while typing.
function goodProblems(good) {
  const found = [];
  const others = projectGoods().filter((other) => other.key !== originalKey);
  if (!good.key) found.push('key_missing');
  else if (!KEY_PATTERN.test(good.key)) found.push('key_invalid');
  else if (others.some((other) => other.key === good.key) || (good.mode !== 'override' && gameGood(good.key))) {
    found.push('key_exists');
  }
  if (!good.texture) found.push('icon_missing');
  if (!NUMBER_PATTERN.test(good.cost) || Number(good.cost) <= 0) found.push('cost');
  if (!CATEGORIES.includes(good.category) && !store.data.gameGoods.some((g) => g.category === good.category)) {
    found.push('category');
  }
  if (NUMBERS.some((name) => good[name] && !NUMBER_PATTERN.test(good[name]))) found.push('number');
  const needs = good.needs.map((row) => row.need);
  if (needs.some((need) => !store.index.pop_needs.has(need)) || new Set(needs).size !== needs.length) found.push('need');
  if (good.needs.some((row) => NEED_FIELDS.some((name) => row[name] && !NUMBER_PATTERN.test(row[name])))) {
    found.push('need_value');
  }
  if (!bracesBalanced(good.extra)) found.push('braces:extra');
  return found;
}

function prestigeProblems(good) {
  const found = [];
  const others = projectPrestige().filter((other) => other.key !== originalKey);
  if (!good.key) found.push('key_missing');
  else if (!KEY_PATTERN.test(good.key)) found.push('key_invalid');
  else if (others.some((other) => other.key === good.key) || (good.mode !== 'override' && gamePrestige(good.key))) {
    found.push('key_exists');
  }
  if (!store.index.goods.has(good.base_good)) found.push('base_good');
  if (!good.texture) found.push('icon_missing');
  if (!NUMBER_PATTERN.test(good.prestige_bonus)) found.push('prestige_bonus');
  for (const name of ['possible', 'extra']) if (!bracesBalanced(good[name])) found.push('braces:' + name);
  return found;
}

function problemText(code) {
  if (code.startsWith('braces:')) return t('problem.braces', { name: code.slice(7) });
  return editingKind === 'good' ? t('gdproblem.' + code) : t('pgproblem.' + code);
}

function changed() {
  dirty = true;
  pristine = false;
  renderPreview();
  showRewrite();
  refreshSidebar();
}

// The warning of the needs section, kept up while the values are typed.
function showRewrite() {
  if (!els.rewrite || editingKind !== 'good') return;
  const whole = rewrittenNeeds(editing);
  els.rewrite.hidden = !whole.length;
  els.rewrite.textContent = whole.length ? t('goods.rewrite_warn', { needs: whole.map(needName).join('、') }) : '';
}

function refresh(name) {
  const fresh = (editingKind === 'good' ? goodBuilders : prestigeBuilders)[name]();
  sections[name].replaceWith(fresh);
  sections[name] = fresh;
}

const discardText = () => (editingKind === 'good' ? t('goods.discard_confirm') : t('pgood.discard_confirm'));

// ---------------------------------------------------------- opening items

async function open(kind, model, key, isDirty) {
  if (dirty && !(await confirmDialog(discardText(), t('company.discard')))) return false;
  editing = model;
  editingKind = kind;
  originalKey = key;
  dirty = isDirty;
  pristine = true;
  autoColor = kind === 'good' && model.mode === 'new' && !model.color;
  usesCache = null;
  clearConditionCache();
  renderPage();
  els.middle.scrollTop = 0;
  return true;
}

const editGood = (good, key, isDirty = false) => open('good', goodModel(good), key, isDirty);
const editPrestige = (good, key, isDirty = false) => open('prestige', prestigeModel(good), key, isDirty);

// A game good to override: as the game has it, with its needs and colour.
const overrideOf = (game) => ({ ...game, texture: game.texture, cost: game.cost_text, mode: 'override', names: {},
  needs: gameNeedsOf(game.key), color: game.color || null });

function openGood(row) {
  versionSource = null;
  if (row.mine) return editGood(row.mine, row.mine.key);
  return editGood(overrideOf(row.game), null, true);
}

function openPrestige(row) {
  versionSource = null;
  if (row.mine) return editPrestige(row.mine, row.mine.key);
  return editPrestige({ ...row.game, mode: 'override', names: {} }, null, true);
}

function freeKey(base, kind) {
  let key = `${base}_copy`;
  for (let n = 2; keyTaken(key, kind); n++) key = `${base}_copy${n}`;
  return key;
}

// A new good made from another: everything but the key, and its name as a start.
function copyGood(row) {
  const source = row.mine || overrideOf(row.game);
  const name = goodRowName(row);
  const key = freeKey(source.key, 'good');
  return editGood({ ...source, mode: 'new', key, names: name ? { [language()]: name } : {} }, null, true);
}

function copyPrestige(row) {
  const source = rowItem(row);
  const name = prestigeRowName(row);
  const key = freeKey(source.key, 'prestige');
  return editPrestige({ ...source, mode: 'new', key, names: name ? { [language()]: name } : {} }, null, true);
}

const newGood = (category, need = '') => editGood(blankGood(category, need), null);
const newPrestige = (base) => editPrestige(blankPrestige(base), null);

async function save() {
  const kind = editingKind;
  const url = kind === 'good' ? '/api/project/good' : '/api/project/prestige_good';
  const result = await api.post(url, { good: editing, original_key: originalKey, keep_images: keptImages() });
  if (result.errors.length) {
    toast(result.errors.map(problemText).join('\n'), 'error');
    return;
  }
  setProject(result.project);
  originalKey = editing.key;
  dirty = false;
  usesCache = null;
  renderLeft();
  refreshSidebar();
  toast(t('company.saved', { dir: result.dir }));
}

// Remove a good (with the mod's prestige goods of it, when it is new) or a prestige good from the project.
async function remove(item, kind) {
  const current = editingKind === kind && item.key === originalKey;
  let text;
  if (kind === 'good') {
    const name = goodName(current ? editing : item);
    const prestige = item.mode === 'new' ? projectPrestige().filter((good) => good.base_good === item.key).length : 0;
    const used = item.mode === 'new' ? usesOf(item.key) : { producers: [], consumers: [] };
    const buildings = new Set([...used.producers, ...used.consumers].map((use) => use.key)).size;
    text = [t('company.delete_confirm', { name }),
      prestige > 0 && t('goods.delete_prestige', { count: prestige }),
      buildings > 0 && t('goods.delete_used', { count: buildings })].filter(Boolean).join('\n');
  } else {
    text = t('company.delete_confirm', { name: prestigeGoodName(current ? editing : item) });
  }
  if (!(await confirmDialog(text, t('company.delete')))) return;
  const url = kind === 'good' ? '/api/project/good/delete' : '/api/project/prestige_good/delete';
  setProject(await api.post(url, { key: item.key, keep_images: keptImages(current ? 'goods' : null) }));
  usesCache = null;
  // a prestige good of a new good that is gone has nothing to be made of
  const lost = editing && (current || (kind === 'good' && item.mode === 'new' && editingKind === 'prestige'
    && editing.base_good === item.key));
  if (lost) {
    dirty = false;
    await close();
  } else if (editing) {
    refreshSidebar();
  } else {
    renderPage();
  }
  toast(t('company.deleted'));
}

async function close() {
  if (dirty && !(await confirmDialog(discardText(), t('company.discard')))) return;
  editing = null;
  originalKey = null;
  dirty = false;
  renderPage();
}

editingImages.set('goods', () => (editing ? [editing.texture] : []));

// What the sidebar needs from this page: it edits goods and prestige goods.
const sidebarEditor = {
  kind: 'good',
  handles: (kind) => kind === 'good' || kind === 'prestige_good',
  state: () => ({ key: originalKey, dirty, kind: editingKind === 'prestige' ? 'prestige_good' : 'good' }),
  open: (item, kind) => (kind === 'prestige_good' ? editPrestige(item, item.key) : editGood(item, item.key)),
  remove: (item, kind) => remove(item, kind === 'prestige_good' ? 'prestige' : 'good'),
};

// ------------------------------------------------------------------- board

function matchesText(name, key) {
  const query = filters.query.trim().toLowerCase();
  return !query || name.toLowerCase().includes(query) || key.toLowerCase().includes(query);
}

function matchesSource(row) {
  if (filters.source === 'project') return Boolean(row.mine);
  if (filters.source) return Boolean(row.game && row.game.sources.includes(filters.source));
  return true;
}

function renderBoard() {
  const data = store.data;
  const counts = new Map();
  for (const item of [...data.gameGoods, ...data.gamePrestigeGoods]) {
    for (const id of item.sources) counts.set(id, (counts.get(id) || 0) + 1);
  }
  const mine = projectGoods().length + projectPrestige().length;
  const select = h('select', {
    class: 'input', title: t('company.filter_source'),
    onchange: () => { filters.source = select.value; renderColumns(); },
  },
    h('option', { value: '' }, t('company.filter_source')),
    h('option', { value: 'project' }, t('law.filter_project', { count: mine })),
    data.sources.filter((s) => counts.has(s.id)).map((s) =>
      h('option', { value: s.id }, `${sourceName(s.id)} (${counts.get(s.id)})`)));
  select.value = filters.source;
  if (select.value !== filters.source) filters.source = '';
  const search = h('input', {
    class: 'input', type: 'search', placeholder: t('goods.search'), value: filters.query,
    oninput: debounce(() => { filters.query = search.value; renderColumns(); }, 150),
  });
  els.columns = h('div', { class: 'law-columns goods-columns' });
  fill(els.board,
    h('div', { class: 'col-head' }, h('h2', {}, t('goods.title')),
      h('span', { class: 'muted' }, t('goods.count', { count: data.gameGoods.length, prestige: data.gamePrestigeGoods.length }))),
    h('div', { class: 'tabs goods-views' }, ['category', 'needs'].map((name) => h('button', {
      class: 'tab' + (name === view ? ' active' : ''), onclick: () => setView(name),
    }, t('goods.view.' + name)))),
    h('div', { class: 'law-filters' }, search, select),
    h('p', { class: 'muted small' }, view === 'needs' ? t('goods.board_hint_needs') : t('goods.board_hint')),
    els.columns);
  renderColumns();
}

function renderColumns() {
  if (view === 'needs') renderNeedColumns();
  else renderCategoryColumns();
}

// The card of a good when the board is searched or filtered: null when neither it nor its prestige goods match.
function shownCard(row, filtering, extra) {
  const prestige = prestigeRows(row.key);
  let shown = prestige;
  if (filtering) {
    shown = prestige.filter((p) => matchesSource(p) && matchesText(prestigeRowName(p), p.key));
    const self = matchesSource(row) && matchesText(goodRowName(row), row.key);
    if (!self && !shown.length) return null;
  }
  return goodCard(row, prestige, shown, filtering, extra);
}

// The needs a good is in now: the mod's for a good it has, the game's for the others.
const needsOfRow = (row) => (row.mine ? row.mine.needs || [] : gameNeedsOf(row.key));

// Where a good is in a list of the game's order; the ones not in it go last.
function rank(order, key) {
  const index = order.indexOf(key);
  return index < 0 ? order.length : index;
}

// The board by pop needs: each need a row across the board, its goods (in the game's order, then the mod's)
// in four columns; the goods in no need in a last row the same way.
function renderNeedColumns() {
  const filtering = Boolean(filters.query.trim() || filters.source);
  const placed = goodRows().map((row) => ({ row, needs: needsOfRow(row) }));
  const blocks = store.data.pop_needs.map((need) => {
    const order = need.entries.map((entry) => entry.goods);
    const members = placed.filter((item) => item.needs.some((entry) => entry.need === need.key))
      .sort((a, b) => rank(order, a.row.key) - rank(order, b.row.key));
    const cards = members.map(({ row, needs }) => shownCard(row, filtering, {
      id: need.key + ':' + row.key,
      need: needs.find((entry) => entry.need === need.key),
      isDefault: need.default === row.key,
    })).filter(Boolean);
    return { title: need.name || need.key, hint: need.key, cards, add: () => newGood('staple', need.key) };
  });
  blocks.push({ title: t('goods.no_need'), hint: '', add: () => newGood('industrial'),
    cards: placed.filter((item) => !item.needs.length)
      .map(({ row }) => shownCard(row, filtering, { id: 'none:' + row.key })).filter(Boolean) });
  const shown = filtering ? blocks.filter((block) => block.cards.length) : blocks;
  if (!shown.length) {
    fill(els.columns, h('p', { class: 'muted small' }, t('goods.no_match')));
    return;
  }
  fill(els.columns, shown.map((block) => h('section', { class: 'law-column goods-need-block' },
    h('h3', { class: 'law-column-title', title: block.hint }, block.title),
    block.cards.length ? h('div', { class: 'goods-need-grid' }, block.cards) : h('p', { class: 'muted small' }, t('goods.no_goods')),
    !filtering && h('button', { class: 'btn law-add', onclick: () => run(block.add) }, `＋ ${t('goods.new')}`))));
}

function renderCategoryColumns() {
  const filtering = Boolean(filters.query.trim() || filters.source);
  const rows = goodRows();
  const categories = [...CATEGORIES];
  for (const row of rows) if (!categories.includes(rowItem(row).category)) categories.push(rowItem(row).category);
  fill(els.columns, categories.map((category) => {
    const cards = rows.filter((row) => rowItem(row).category === category)
      .map((row) => shownCard(row, filtering)).filter(Boolean);
    return h('section', { class: 'law-column' },
      h('h3', { class: 'law-column-title' }, categoryName(category)),
      cards.length ? cards : h('p', { class: 'muted small' }, t('goods.no_match')),
      !filtering && h('button', { class: 'btn law-add', onclick: () => run(() => newGood(category)) }, `＋ ${t('goods.new')}`));
  }));
}

// A good on the board. In the needs view `extra` tells which card it is (a good can be in two needs),
// its entry in that need and whether it is the need's default good: a card in a need shows its weight and
// shares where the others show the price (the price is then in the tooltip).
function goodCard(row, prestige, shown, filtering, extra = {}) {
  const good = rowItem(row);
  const id = extra.id || row.key;
  const open = filtering || expanded.has(id);
  const toggle = () => {
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
    renderColumns();
  };
  const entry = extra.need;
  const shares = entry ? NEED_FIELDS.filter((name) => entry[name] !== '' && entry[name] != null)
    .map((name) => `${t('goods.need_short.' + name)} ${entry[name]}`) : [];
  const price = t('goods.price_short', { cost: good.cost_text || good.cost });
  const changes = prestige.filter((p) => p.mine).length;
  return h('div', { class: 'law-group' + (open ? ' open' : '') },
    h('button', { class: 'law-group-head', onclick: filtering ? null : toggle, title: row.key },
      thumb(good.texture, 128, 'law-group-icon'),
      h('span', { class: 'law-group-text', title: entry ? price : null },
        h('span', { class: 'law-group-name' }, goodRowName(row),
          extra.isDefault && h('span', { class: 'goods-default', title: t('goods.need_default') }, ' ★')),
        entry ? shares.length > 0 && h('span', { class: 'muted small' }, shares.join(' · '))
          : h('span', { class: 'muted small' }, price)),
      row.mine && h('span', { class: 'badge accent' }, row.mine.mode === 'override' ? t('law.modified') : t('law.added')),
      changes > 0 && h('span', { class: 'badge accent', title: t('goods.prestige_changed_hint') },
        t('law.changed', { count: changes })),
      prestige.length > 0 && h('span', { class: 'badge', title: t('goods.prestige_count_hint') }, String(prestige.length)),
      !filtering && h('span', { class: 'side-caret' }, open ? '▾' : '▸')),
    open && h('div', { class: 'law-list' },
      h('div', { class: 'row goods-card-actions' },
        h('button', { class: 'btn small', onclick: () => run(() => openGood(row)) },
          row.mine && row.mine.mode === 'new' ? t('goods.edit') : t('goods.modify')),
        h('button', { class: 'btn small', title: t('goods.copy_hint'), onclick: () => run(() => copyGood(row)) }, t('law.copy')),
        row.game && sourceBadges(row.game)),
      h('div', { class: 'muted small' }, t('goods.prestige_title')),
      shown.map((p) => prestigeRow(p, Boolean(filters.query.trim()))),
      !shown.length && h('p', { class: 'muted small' }, t('goods.no_prestige')),
      h('button', { class: 'btn law-add', onclick: () => run(() => newPrestige(row.key)) }, `＋ ${t('pgood.new')}`)));
}

function prestigeRow(row, highlight) {
  const good = rowItem(row);
  return h('div', { class: 'law-row' + (highlight ? ' match' : '') },
    h('button', { class: 'law-row-main', onclick: () => run(() => openPrestige(row)) },
      thumb(good.texture, 64, 'law-icon'),
      h('span', { class: 'company-title' },
        h('span', { class: 'company-name' }, prestigeRowName(row)),
        h('span', { class: 'company-key' }, row.key)),
      h('span', { class: 'side-badges' },
        row.mine && h('span', { class: 'badge accent' }, row.mine.mode === 'override' ? t('law.modified') : t('law.added')),
        row.game && sourceBadges(row.game))),
    h('button', { class: 'btn small', title: t('pgood.copy_hint'), onclick: () => run(() => copyPrestige(row)) }, t('law.copy')));
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

function renderPreview() {
  if (editingKind === 'good') renderGoodPreview();
  else renderPrestigePreview();
}

function translations(item) {
  const filled = store.state.languages.filter((l) => item.names[l.key]);
  return h('div', { class: 'preview-group' },
    h('h4', {}, t('company.translations', { count: filled.length, total: store.state.languages.length })),
    h('div', { class: 'chips' }, store.state.languages.map((l) =>
      h('span', { class: 'chip' + (item.names[l.key] ? ' filled' : ' missing'), title: item.names[l.key] || '' }, l.name))));
}

function usesList(uses, empty) {
  if (!uses.length) return h('span', { class: 'muted' }, empty);
  return h('ul', { class: 'goods-uses' },
    uses.slice(0, MAX_USES).map((use) => h('li', { title: use.pms.map((pm) => nameOf('pms', pm)).join('\n') },
      use.name, h('span', { class: 'muted small' }, ` · ${t('goods.methods', { count: use.pms.length })}`))),
    uses.length > MAX_USES && h('li', { class: 'muted' }, t('goods.more', { count: uses.length - MAX_USES })));
}

// The goods in each need the good is in, with their weights (this good as it is being edited).
function needsPreview(good) {
  if (!good.needs.length) return h('span', { class: 'muted' }, t('goods.no_needs'));
  const key = originalKey || good.key;
  return good.needs.map((row) => {
    const need = store.index.pop_needs.get(row.need);
    const others = need ? need.entries.filter((entry) => entry.goods !== key) : [];
    const lines = [...others.map((entry) => ({ name: nameOf('goods', entry.goods), weight: entry.weight || '1' })),
      { name: goodName(good), weight: row.weight || '1', current: true }];
    return h('div', {},
      h('div', { class: 'muted small' }, needName(row.need)),
      h('ol', { class: 'law-progression' }, lines.map((line) =>
        h('li', { class: line.current ? 'current' : '' }, h('b', {}, line.weight), ' ', line.name))));
  });
}

function renderGoodPreview() {
  const good = editing;
  const found = goodProblems(good);
  const key = originalKey || good.key;
  const uses = good.mode === 'new' && !originalKey ? { producers: [], consumers: [] } : usesOf(key);
  const notes = [];
  if (good.mode === 'new' && !Object.values(good.names).some(Boolean)) notes.push(t('note.no_name'));
  if (!uses.producers.length) notes.push(t('goods.note_no_producer'));
  if (!uses.consumers.length && !good.needs.length) notes.push(t('goods.note_no_buyer'));
  const whole = rewrittenNeeds(good);
  if (whole.length) notes.push(t('goods.note_rewrite', { needs: whole.map(needName).join('、') }));
  const flags = Object.entries(FLAGS).filter(([name, value]) => good[name] !== value).map(([name]) => t('goods.flag.' + name));
  if (good.obsession_chance && Number(good.obsession_chance) > 0) flags.push(t('goods.obsession_short', { value: good.obsession_chance }));
  if (good.consumption_tax_cost) flags.push(t('goods.tax_short', { value: good.consumption_tax_cost }));
  const prestige = key ? prestigeRows(key) : [];
  fill(els.preview,
    h('div', { class: 'law-preview-art' }, thumb(good.texture, 256, 'law-preview-icon')),
    h('h3', { class: 'preview-name' }, goodName(good)),
    h('div', { class: 'preview-meta' },
      h('span', { class: 'company-key' }, good.key || '—'),
      h('span', { class: 'badge' + (good.mode === 'override' ? ' accent' : '') }, t('company.mode.' + good.mode)),
      dirty && h('span', { class: 'badge warn' }, t('company.unsaved'))),
    h('div', { class: 'muted' }, [categoryName(good.category), t('goods.price_short', { cost: good.cost || '?' })].join(' · ')),
    h('div', { class: 'row' },
      h('span', { class: 'goods-swatch', style: good.color ? `background:${hex(good.color)}` : '' }),
      h('span', { class: 'muted small' }, good.color ? t('goods.color_preview') : t('goods.no_color'))),
    flags.length > 0 && h('div', { class: 'chips' }, flags.map((text) => h('span', { class: 'chip' }, text))),
    h('div', { class: 'preview-group' }, h('h4', {}, t('goods.producers')),
      usesList(uses.producers, good.mode === 'new' && !originalKey ? t('goods.save_first') : t('goods.none_producing'))),
    h('div', { class: 'preview-group' }, h('h4', {}, t('goods.consumers')),
      usesList(uses.consumers, good.mode === 'new' && !originalKey ? t('goods.save_first') : t('goods.none_using'))),
    h('div', { class: 'preview-group' }, h('h4', {}, t('goods.needs')), needsPreview(good)),
    h('div', { class: 'preview-group' }, h('h4', {}, t('goods.prestige_title')),
      prestige.length
        ? h('div', { class: 'chips' }, prestige.map((p) => h('span', { class: 'chip' },
          thumb(rowItem(p).texture, 64, 'chip-icon'), prestigeRowName(p))))
        : h('span', { class: 'muted' }, t('goods.no_prestige'))),
    translations(good),
    found.length > 0 && h('ul', { class: 'problems' }, found.map((code) => h('li', {}, problemText(code)))),
    notes.length > 0 && h('ul', { class: 'notes' }, notes.map((note) => h('li', {}, note))));
}

// Companies that can make a prestige good: the game's, with the mod's versions of them, and the mod's new ones.
function makersOf(key) {
  const mine = store.project.companies || [];
  const mineKeys = new Set(mine.map((company) => company.key));
  return [
    ...store.data.companies.filter((company) => !mineKeys.has(company.key)
      && company.possible_prestige_goods.includes(key)).map((company) => company.name || company.key),
    ...mine.filter((company) => (company.possible_prestige_goods || []).includes(key)).map(companyName),
  ];
}

function renderPrestigePreview() {
  const good = editing;
  const found = prestigeProblems(good);
  const notes = [];
  if (good.mode === 'new' && !Object.values(good.names).some(Boolean)) notes.push(t('note.no_name'));
  const makers = makersOf(originalKey || good.key);
  if (!makers.length) notes.push(t('pgood.note_no_company'));
  const base = store.index.goods.get(good.base_good);
  fill(els.preview,
    h('div', { class: 'law-preview-art' }, thumb(good.texture, 256, 'law-preview-icon')),
    h('h3', { class: 'preview-name' }, prestigeGoodName(good)),
    h('div', { class: 'preview-meta' },
      h('span', { class: 'company-key' }, good.key || '—'),
      h('span', { class: 'badge' + (good.mode === 'override' ? ' accent' : '') }, t('company.mode.' + good.mode)),
      dirty && h('span', { class: 'badge warn' }, t('company.unsaved'))),
    h('div', { class: 'muted' }, t('pgood.base_line', { name: base ? base.name || base.key : good.base_good,
      bonus: good.prestige_bonus })),
    h('div', { class: 'preview-group' }, h('h4', {}, t('pgood.companies')),
      makers.length ? h('div', { class: 'chips' }, makers.map((name) => h('span', { class: 'chip' }, name)))
        : h('span', { class: 'muted' }, t('pgood.no_company'))),
    translations(good),
    found.length > 0 && h('ul', { class: 'problems' }, found.map((code) => h('li', {}, problemText(code)))),
    notes.length > 0 && h('ul', { class: 'notes' }, notes.map((note) => h('li', {}, note))));
}

// ------------------------------------------------------------------- editor

const scriptArea = (get, set) => scriptBox(get, set, changed);

function numberInput(item, name, placeholder = '', onInput = null) {
  const input = h('input', {
    class: 'input level', type: 'text', value: item[name], placeholder,
    oninput: () => {
      item[name] = input.value.trim();
      input.classList.toggle('invalid', Boolean(item[name]) && !NUMBER_PATTERN.test(item[name]));
      if (onInput) onInput();
      changed();
    },
  });
  input.classList.toggle('invalid', Boolean(item[name]) && !NUMBER_PATTERN.test(item[name]));
  return input;
}

function nameFields(item, original, keyPlaceholder, keyHint) {
  const lang = language();
  const key = h('input', {
    class: 'input mono', type: 'text', spellcheck: false, value: item.key, disabled: item.mode === 'override',
    placeholder: keyPlaceholder, oninput: () => { item.key = key.value.trim(); changed(); },
  });
  const name = h('input', {
    class: 'input', type: 'text', value: item.names[lang] || '', placeholder: (original && original.name) || '',
    oninput: (event) => {
      const value = event.target.value.trim();
      if (value) item.names[lang] = value;
      else delete item.names[lang];
      changed();
    },
  });
  return [
    item.mode === 'override' && h('div', { class: 'notice warn' },
      t('goods.override_note', { source: original ? sourceName(original.source) : '?' })),
    field(t('company.key'), key, item.mode === 'override' ? null : keyHint),
    field(t('company.name', { language: languageName(lang) }), name,
      item.mode === 'override' ? t('company.name_hint_override') : t('company.name_hint')),
  ];
}

function goodBasicSection() {
  const good = editing;
  const original = good.mode === 'override' ? gameGood(good.key) : null;
  const categories = [...CATEGORIES];
  for (const game of store.data.gameGoods) if (!categories.includes(game.category)) categories.push(game.category);
  const category = h('select', {
    class: 'input', onchange: () => { good.category = category.value; changed(); },
  }, categories.map((key) => h('option', { value: key }, categoryName(key))));
  category.value = good.category;
  return section(t('company.basic'), null,
    nameFields(good, original, 'my_good', t('goods.key_hint')),
    imageField({ label: t('company.icon'), value: good.texture, paths: store.data.goods_icons, kind: 'goods_icon',
      onChange: (path) => {
        good.texture = path;
        changed();
        refresh('basic');
        if (autoColor) {
          averageColor(path).then((color) => {
            if (!autoColor || editing !== good || good.texture !== path || !color) return;
            good.color = color;
            changed();
            refresh('look');
          });
        }
      } }),
    field(t('goods.category'), category, t('goods.category_hint')),
    field(t('goods.cost'), numberInput(good, 'cost', '30'), t('goods.cost_hint')));
}

function check(item, name) {
  return h('div', {},
    h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: item[name],
        onchange: (event) => { item[name] = event.target.checked; changed(); } }),
      t('goods.flag.' + name)),
    h('p', { class: 'muted small' }, t('goods.flag_hint.' + name)));
}

function marketSection() {
  const good = editing;
  return section(t('goods.market'), null,
    check(good, 'tradeable'), check(good, 'local'), check(good, 'fixed_price'),
    field(t('goods.number.traded_quantity'), numberInput(good, 'traded_quantity', '10'), t('goods.number_hint.traded_quantity')),
    field(t('goods.number.convoy_cost_multiplier'), numberInput(good, 'convoy_cost_multiplier', '1'),
      t('goods.number_hint.convoy_cost_multiplier')));
}

function needRow(row) {
  const good = editing;
  const inputs = NEED_FIELDS.map((name) => h('label', { class: 'goods-need-field' },
    h('span', { class: 'muted small' }, t('goods.need_field.' + name)),
    numberInput(row, name, name === 'weight' ? '1' : '')));
  return h('div', { class: 'goods-need-row' },
    h('span', { class: 'grow' }, h('span', {}, needName(row.need)), h('span', { class: 'company-key' }, row.need)),
    inputs,
    h('button', { class: 'btn icon-btn', title: t('common.remove'), onclick: () => {
      good.needs = good.needs.filter((other) => other !== row);
      changed();
      refresh('pops');
    } }, '✕'));
}

function popsSection() {
  const good = editing;
  const used = new Set(good.needs.map((row) => row.need));
  const add = h('select', {
    class: 'input',
    onchange: () => {
      if (!add.value) return;
      good.needs.push({ need: add.value, weight: '1', max_supply_share: '1.0', min_supply_share: '0.0' });
      changed();
      refresh('pops');
    },
  },
    h('option', { value: '' }, t('goods.add_need')),
    store.data.pop_needs.filter((need) => !used.has(need.key))
      .map((need) => h('option', { value: need.key }, `${need.name || need.key} (${need.key})`)));
  els.rewrite = h('div', { class: 'notice warn' });
  showRewrite();
  return section(t('goods.pops'), null,
    field(t('goods.number.obsession_chance'), numberInput(good, 'obsession_chance', ''), t('goods.number_hint.obsession_chance')),
    field(t('goods.number.consumption_tax_cost'), numberInput(good, 'consumption_tax_cost', ''),
      t('goods.number_hint.consumption_tax_cost')),
    check(good, 'pop_consumption_can_add_infrastructure'),
    h('div', { class: 'law-modifiers' },
      h('span', { class: 'field-label' }, t('goods.needs')),
      h('p', { class: 'muted small' }, t('goods.needs_hint')),
      good.needs.map(needRow),
      !good.needs.length && h('p', { class: 'muted' }, t('goods.no_needs')),
      els.rewrite,
      h('div', { class: 'row' }, add)));
}

function prestigeSection() {
  return section(t('goods.prestige'), null,
    field(t('goods.number.prestige_factor'), numberInput(editing, 'prestige_factor', ''), t('goods.number_hint.prestige_factor')));
}

function lookSection() {
  const good = editing;
  const color = h('input', {
    type: 'color', class: 'goods-color', value: good.color ? hex(good.color) : '#808080',
    oninput: () => { good.color = rgb(color.value); autoColor = false; changed(); },
  });
  const fromIcon = async () => {
    const average = await averageColor(good.texture);
    if (!average) {
      toast(t('goods.color_failed'), 'error');
      return;
    }
    good.color = average;
    autoColor = good.mode === 'new';
    changed();
    refresh('look');
  };
  return section(t('goods.look'), null,
    h('div', { class: 'row' },
      color,
      h('button', { class: 'btn', disabled: !good.texture, onclick: () => run(fromIcon) }, t('goods.color_from_icon')),
      good.color && good.mode === 'override' && h('button', { class: 'btn', onclick: () => {
        const game = gameGood(good.key);
        good.color = (game && game.color) || null;
        changed();
        refresh('look');
      } }, t('goods.color_reset'))),
    h('p', { class: 'muted small' }, good.color ? t('goods.color_hint') : t('goods.no_color')),
    h('p', { class: 'muted small' }, good.mode === 'new' ? t('goods.texticon_hint', { key: good.key || 'my_good' })
      : t('goods.texticon_game')));
}

function advancedSection() {
  const item = editing;
  return section(t('company.advanced'), null,
    h('div', { class: 'script-field' },
      h('span', { class: 'field-label' }, t('company.extra')),
      h('p', { class: 'muted small' }, t('goods.extra_hint')),
      scriptArea(() => item.extra, (value) => { item.extra = value; })));
}

const goodBuilders = {
  basic: goodBasicSection,
  market: marketSection,
  pops: popsSection,
  prestige: prestigeSection,
  look: lookSection,
  advanced: advancedSection,
};

function prestigeBasicSection() {
  const good = editing;
  const original = good.mode === 'override' ? gamePrestige(good.key) : null;
  // the base good is chosen on the board, where the prestige good was made, and stays
  const base = h('div', { class: 'readonly-value' }, objectChip('goods', good.base_good));
  return section(t('company.basic'), null,
    nameFields(good, original, 'prestige_good_my_good', t('pgood.key_hint')),
    imageField({ label: t('company.icon'), value: good.texture, paths: store.data.prestige_icons, kind: 'prestige_icon',
      onChange: (path) => { good.texture = path; changed(); refresh('basic'); } }),
    field(t('pgood.base_good'), base, t('pgood.base_locked')),
    field(t('pgood.bonus'), numberInput(good, 'prestige_bonus', '0.1'), t('pgood.bonus_hint')));
}

function prestigeConditionsSection() {
  const good = editing;
  return section(t('pgood.conditions'), null,
    h('div', { class: 'cond-block' },
      h('div', { class: 'cond-head' },
        h('span', { class: 'field-label' }, t('pgood.possible')),
        h('span', { class: 'mono muted small' }, 'possible')),
      h('p', { class: 'muted small' }, t('pgood.possible_hint')),
      conditionEditor({
        id: 'prestige_possible', kinds: COUNTRY_KINDS,
        get: () => good.possible,
        set: (text) => { good.possible = text; changed(); },
      })));
}

function prestigeCompaniesSection() {
  const makers = makersOf(originalKey || editing.key);
  return section(t('pgood.companies'), t('pgood.companies_hint'),
    makers.length ? h('div', { class: 'chips' }, makers.map((name) => h('span', { class: 'chip' }, name)))
      : h('p', { class: 'muted' }, t('pgood.no_company')),
    h('div', { class: 'row' }, h('a', { class: 'btn', href: '#/company' }, t('pgood.to_companies'))));
}

const prestigeBuilders = {
  basic: prestigeBasicSection,
  conditions: prestigeConditionsSection,
  companies: prestigeCompaniesSection,
  advanced: advancedSection,
};

// An overridden item that several sources define: which version to start from.
function versionBar() {
  const item = editing;
  const game = item.mode === 'override' && originalKey === null
    ? (editingKind === 'good' ? gameGood(item.key) : gamePrestige(item.key)) : null;
  if (!game || game.sources.length < 2) return null;
  const last = game.sources[game.sources.length - 1];
  const current = versionSource || last;
  const pick = async (id) => {
    if (id === current) return;
    if (!pristine && !(await confirmDialog(t('law.version_confirm'), t('company.discard')))) return;
    const version = game.versions.find((v) => v.source === id);
    versionSource = id;
    dirty = false;
    if (editingKind === 'good') {
      // an earlier version of the definition; the needs and colour are the ones in effect
      await editGood(version ? { ...overrideOf(game), ...version, mode: 'override', names: {},
        needs: gameNeedsOf(game.key), color: game.color || null } : overrideOf(game), null, true);
    } else {
      await editPrestige({ ...(version ? { ...game, ...version } : game), mode: 'override', names: {} }, null, true);
    }
  };
  return h('div', { class: 'law-version detail-chips' },
    h('span', { class: 'muted' }, `${t('company.version')}: `),
    game.sources.map((id) => h('button', {
      class: 'btn small' + (id === current ? ' selected' : ''),
      title: id === last ? t('company.source_active', { source: sourceName(id) }) : sourceName(id),
      onclick: () => run(() => pick(id)),
    }, sourceName(id))),
    h('span', { class: 'muted small' }, t('goods.version_hint')));
}

function renderMiddle() {
  const active = editingKind === 'good' ? goodBuilders : prestigeBuilders;
  for (const name of Object.keys(sections)) delete sections[name];
  for (const name of Object.keys(active)) sections[name] = active[name]();
  fill(els.middle,
    h('div', { class: 'editor-bar' },
      versionBar(),
      h('button', { class: 'btn icon-btn', title: t('law.back'), onclick: () => run(close) }, '✕')),
    Object.values(sections));
}
