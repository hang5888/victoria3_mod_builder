// Law builder. The start screen is the game's law screen: three columns (power structure,
// economy, human rights) of law groups that unfold into their laws. A law opens in the editor:
// preview on the left, editor in the middle, ✕ back to the board.
import { api } from './api.js';
import { t } from './i18n.js';
import { store, refreshState, loadData, language, languageName, nameOf, lawName, setProject, editingImages,
  keptImages } from './store.js';
import { renderSidebar, refreshSidebar, takePending } from './sidebar.js';
import { h, fill, toast, confirmDialog, openPicker, debounce } from './ui.js';
import { thumb } from './icons.js';
import { run, section, field, objectChip, sourceName, sourceBadges, keyChips, imageField, scriptArea as scriptBox,
  formatModifier } from './widgets.js';
import { bracesBalanced } from './script.js';
import { COUNTRY_KINDS, conditionEditor, clearConditionCache, readConditions } from './conditions.js';

const TAX_LEVELS = ['very_low', 'low', 'medium', 'high', 'very_high'];
const MODIFIER_FIELDS = ['modifier', 'institution_modifier', 'acceptance_modifier',
  ...TAX_LEVELS.map((level) => `tax_modifier_${level}`)];
const RAW_BLOCKS = ['is_visible', 'can_enact', 'on_enact', 'on_activate', 'on_deactivate', 'can_impose',
  'ai_impose_chance', 'ai_will_do', 'ai_enact_weight_modifier'];
const LIST_FIELDS = ['unlocking_technologies', 'unlocking_laws', 'requires_law_or', 'disallowing_laws'];
const FIELDS = ['key', 'mode', 'names', 'descs', 'group', 'icon', 'progressiveness', 'parent', 'institution',
  ...LIST_FIELDS, 'modifiers', 'blocks', 'start', 'extra'];
const SCRIPT_BLOCKS = ['on_enact', 'on_activate', 'on_deactivate'];
const AI_BLOCKS = ['ai_enact_weight_modifier', 'ai_will_do', 'can_impose', 'ai_impose_chance'];
const KEY_PATTERN = /^[A-Za-z0-9_.\-]+$/;
const NUMBER_PATTERN = /^-?\d+(\.\d+)?$/;
const MODIFIER_VALUE_PATTERN = /^(-?\d+(\.\d+)?|yes|no)$/;
// What base game laws write: the AI wants a law more while a journal entry asks for it.
const AI_PETITIONS = 'value = 0\n\nif = {\n\tlimit = { ai_has_enact_weight_modifier_journal_entries = yes }\n\tadd = 750\n}';
// Effect scripts as base game laws write them.
const EXAMPLES = {
  on_enact: 'recalculate_pop_ig_support = yes',
  on_activate: 'if = {\n\tlimit = { has_modifier = antireligious_policies }\n\tremove_modifier = antireligious_policies\n}\n'
    + 'recalculate_pop_ig_support = yes',
  on_deactivate: 'set_variable = { name = my_law_was_repealed value = yes }',
};
const STANCE_VALUES = { strongly_approve: 2, approve: 1, neutral: 0, disapprove: -1, strongly_disapprove: -2 };
const TAX_GROUP = 'lawgroup_taxation';
const CITIZENSHIP_GROUP = 'lawgroup_citizenship';

let root = null;
let editing = null;        // the law in the editor; null shows the board
let originalKey = null;    // its key in the project file, when it was opened from there
let editingProject = null; // folder of the project `editing` belongs to
let dirty = false;
let pristine = true;       // nothing changed since it was opened (switching versions needs no question)
let versionSource = null;  // the source whose version an overridden law was started from (null: the one in effect)
const expanded = new Set();  // law groups unfolded on the board
const filters = { query: '', source: '' };
const els = {};
const sections = {};

window.addEventListener('beforeunload', (event) => {
  if (dirty) event.preventDefault();
});

function blankLaw(group) {
  return {
    key: '', mode: 'new', names: {}, descs: {}, group, icon: '', progressiveness: '0', parent: '', institution: '',
    ...Object.fromEntries(LIST_FIELDS.map((name) => [name, []])),
    modifiers: Object.fromEntries(MODIFIER_FIELDS.map((name) => [name, []])),
    blocks: { ...Object.fromEntries(RAW_BLOCKS.map((name) => [name, ''])), ai_enact_weight_modifier: AI_PETITIONS },
    start: { all: false, default: false },
    extra: '',
  };
}

// The editable part of a law (drops display-only fields such as its sources).
function modelOf(law) {
  const blank = blankLaw('');
  const model = structuredClone(Object.fromEntries(FIELDS.map((name) => [name, law[name]])));
  return {
    ...blank, ...model, names: model.names || {}, descs: model.descs || {},
    modifiers: { ...blank.modifiers, ...model.modifiers },
    blocks: { ...Object.fromEntries(RAW_BLOCKS.map((name) => [name, ''])), ...model.blocks },
    start: { ...blank.start, ...model.start },
  };
}

export async function renderLaw(container) {
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
  const wanted = takePending('law');
  const law = wanted && wanted !== originalKey && (store.project.laws || []).find((l) => l.key === wanted);
  if (law) await edit(law, law.key);
}

// The board, or the editor with its preview.
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
  refreshSidebar();  // also puts back the collapsed sidebar's class
}

// ----------------------------------------------------------------- helpers

const projectLaws = () => store.project.laws || [];

function keyTaken(key) {
  return store.index.laws.has(key) || projectLaws().some((law) => law.key === key && law.key !== originalKey);
}

// The other laws of a group: the game's (or the mod's version of them), then the mod's new ones.
function groupRows(group) {
  const mine = new Map(projectLaws().map((law) => [law.key, law]));
  const rows = store.data.laws.filter((law) => law.group === group)
    .map((game) => ({ key: game.key, game, mine: mine.get(game.key) || null }));
  for (const law of projectLaws()) {
    // new laws, and overrides of laws the loaded data no longer has
    if (law.group === group && (law.mode === 'new' || !store.index.laws.has(law.key))) {
      rows.push({ key: law.key, game: null, mine: law });
    }
  }
  return rows;
}

const rowLaw = (row) => row.mine || row.game;

// Name of a law by its key: the mod's law, else the game's.
function lawNameOf(key) {
  const mine = projectLaws().find((law) => law.key === key);
  return mine ? lawName(mine) : nameOf('laws', key);
}
const rowName = (row) => (row.mine ? lawName(row.mine) : row.game.name || row.game.key);

// The law the game uses for countries whose history sets none: the mod's default law, else the
// group's first law.
function defaultOf(group) {
  const mine = projectLaws().find((law) => law.mode === 'new' && law.group === group && law.start.default);
  if (mine) return mine.key;
  const first = store.data.laws.find((law) => law.group === group && law.default);
  return first ? first.key : '';
}

// Laws a law can take its stances from: the others of its group without a parent of their own.
function parentOptions(law) {
  return groupRows(law.group).map(rowLaw).filter((other) => other.key !== law.key && !other.parent);
}

// What each interest group thinks of a law, from the ideologies it starts with. A law takes the
// stances of its parent; without one, new laws are neutral for everybody.
function stances(law) {
  const key = law.parent || (law.mode === 'override' ? law.key : '');
  return store.data.interest_groups.map((ig) => {
    const parts = ig.ideologies.map((id) => {
      const ideology = store.index.ideologies.get(id);
      return { id, stance: (key && ideology && ideology.stances[key]) || 'neutral' };
    });
    return { ig, parts, score: parts.reduce((total, part) => total + (STANCE_VALUES[part.stance] || 0), 0) };
  });
}

// Who can see a law, from its visibility conditions: "only Japan", "only Japanese culture", or just
// that it has conditions. null when every country sees it. `title`: the whole condition script.
function lawLimit(law) {
  const text = law.blocks.is_visible.trim();
  if (!text) return null;
  const model = readConditions(text, ['country', 'culture']);
  const rows = model ? model.rows : [];
  const countries = rows.filter((row) => row.kind === 'country').flatMap((row) => row.countries);
  const cultures = rows.filter((row) => row.kind === 'culture').flatMap((row) => row.cultures);
  const parts = [
    countries.length && t('law.limit_countries', { names: countries.map((tag) => nameOf('countries', tag)).join(' / ') }),
    cultures.length && t('law.limit_cultures', { names: cultures.map((key) => nameOf('cultures', key)).join(' / ') }),
  ].filter(Boolean);
  if (!parts.length) return { text: t('law.limit_other'), title: text };
  const more = rows.some((row) => row.kind === 'raw');
  return { text: parts.join(' · ') + (more ? t('law.limit_more') : ''), title: text };
}

// Who a law group is for: a social hierarchy (as the caste system), and its enabling conditions.
function groupLimits(group) {
  if (!group) return [];
  return [
    group.hierarchy && { text: t('law.limit_hierarchy', { name: group.hierarchy_name || group.hierarchy }),
      title: t('law.limit_hierarchy_hint') },
    group.enable.trim() && { text: t('law.limit_enable'), title: group.enable },
  ].filter(Boolean);
}

const limitBadge = (limit) => h('span', { class: 'badge limit', title: limit.title }, limit.text);

function stanceLabel(score) {
  if (score > 0) return { text: t('law.stance_approve', { score: `+${score}` }), tone: 'good' };
  if (score < 0) return { text: t('law.stance_disapprove', { score: String(score) }), tone: 'bad' };
  return { text: t('law.stance_neutral'), tone: '' };
}

// Same checks as the backend, so problems show up while typing.
function problems(law) {
  const found = [];
  const others = projectLaws().filter((other) => other.key !== originalKey);
  if (!law.key) found.push('key_missing');
  else if (!KEY_PATTERN.test(law.key)) found.push('key_invalid');
  else if (others.some((other) => other.key === law.key) || (law.mode !== 'override' && store.index.laws.has(law.key))) {
    found.push('key_exists');
  }
  if (!law.group) found.push('group_missing');
  if (!law.icon) found.push('icon_missing');
  if (law.progressiveness && !NUMBER_PATTERN.test(law.progressiveness)) found.push('progressiveness');
  if (law.parent) {
    const parent = store.index.laws.get(law.parent) || others.find((other) => other.key === law.parent);
    if (law.parent === law.key || !parent || parent.group !== law.group) found.push('parent');
  }
  if (MODIFIER_FIELDS.some((name) => law.modifiers[name].some((m) => !MODIFIER_VALUE_PATTERN.test(m.value)))) {
    found.push('modifier_value');
  }
  for (const name of RAW_BLOCKS) if (!bracesBalanced(law.blocks[name])) found.push('braces:' + name);
  if (!bracesBalanced(law.extra)) found.push('braces:extra');
  const sameGroup = others.filter((other) => other.group === law.group);
  if (law.start.default && law.mode === 'override') found.push('default_override');
  if (law.start.default && sameGroup.some((other) => other.start.default)) found.push('default_twice');
  if (law.start.all && sameGroup.some((other) => other.start.all)) found.push('all_twice');
  return found;
}

function problemText(code) {
  if (code.startsWith('braces:')) return t('problem.braces', { name: code.slice(7) });
  return t('lproblem.' + code);
}

function changed() {
  dirty = true;
  pristine = false;
  renderPreview();
  refreshSidebar();
}

function refresh(name) {
  const fresh = builders[name]();
  sections[name].replaceWith(fresh);
  sections[name] = fresh;
}

// ---------------------------------------------------------- opening laws

async function edit(law, key, isDirty = false) {
  if (dirty && !(await confirmDialog(t('law.discard_confirm'), t('company.discard')))) return;
  editing = modelOf(law);
  originalKey = key;
  dirty = isDirty;
  pristine = true;
  clearConditionCache();
  renderPage();
  els.middle.scrollTop = 0;
}

// A law clicked on the board: the mod's version, or the game's to override.
function openRow(row) {
  versionSource = null;
  if (row.mine) return edit(row.mine, row.mine.key);
  return edit({ ...row.game, mode: 'override', names: {}, descs: {} }, null, true);
}

function copyRow(row) {
  const source = rowLaw(row);
  let key = `${source.key}_copy`;
  for (let n = 2; keyTaken(key); n++) key = `${source.key}_copy${n}`;
  const lang = language();
  const name = rowName(row);
  const desc = row.mine ? row.mine.descs[lang] : row.game.desc;
  return edit({
    ...source, mode: 'new', key, names: name ? { [lang]: name } : {}, descs: desc ? { [lang]: desc } : {},
    // the copy thinks like the copied law: it takes the stances the copied law has
    parent: source.parent || source.key,
    start: { countries: [], all: false, default: false },
  }, null, true);
}

const newLaw = (group) => edit(blankLaw(group), null);

async function save() {
  const result = await api.post('/api/project/law', { law: editing, original_key: originalKey, keep_images: keptImages() });
  if (result.errors.length) {
    toast(result.errors.map(problemText).join('\n'), 'error');
    return;
  }
  setProject(result.project);
  originalKey = editing.key;
  dirty = false;
  renderLeft();
  refreshSidebar();
  toast(t('company.saved', { dir: result.dir }));
}

// Remove a law from the project; when it is the one being edited, go back to the board.
async function remove(law) {
  const current = law.key === originalKey;
  const name = lawName(current ? editing : law);
  if (!(await confirmDialog(t('company.delete_confirm', { name }), t('company.delete')))) return;
  setProject(await api.post('/api/project/law/delete', { key: law.key, keep_images: keptImages(current ? 'law' : null) }));
  if (current) {
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
  if (dirty && !(await confirmDialog(t('law.discard_confirm'), t('company.discard')))) return;
  editing = null;
  originalKey = null;
  dirty = false;
  renderPage();
}

editingImages.set('law', () => (editing ? [editing.icon] : []));

// What the sidebar needs from this page.
const sidebarEditor = {
  kind: 'law',
  state: () => ({ key: originalKey, dirty }),
  open: (law) => edit(law, law.key),
  remove,
};

// ------------------------------------------------------------------- board

function matches(row) {
  const query = filters.query.trim().toLowerCase();
  if (query && !rowName(row).toLowerCase().includes(query) && !row.key.toLowerCase().includes(query)) return false;
  if (filters.source === 'project') return Boolean(row.mine);
  if (filters.source) return Boolean(row.game && row.game.sources.includes(filters.source));
  return true;
}

function renderBoard() {
  const data = store.data;
  const counts = new Map();
  for (const law of data.laws) for (const id of law.sources) counts.set(id, (counts.get(id) || 0) + 1);
  const select = h('select', {
    class: 'input', title: t('company.filter_source'),
    onchange: () => { filters.source = select.value; renderColumns(); },
  },
    h('option', { value: '' }, t('company.filter_source')),
    h('option', { value: 'project' }, t('law.filter_project', { count: projectLaws().length })),
    data.sources.filter((s) => counts.has(s.id)).map((s) =>
      h('option', { value: s.id }, `${sourceName(s.id)} (${counts.get(s.id)})`)));
  select.value = filters.source;
  if (select.value !== filters.source) filters.source = '';
  const search = h('input', {
    class: 'input', type: 'search', placeholder: t('law.search'), value: filters.query,
    oninput: debounce(() => { filters.query = search.value; renderColumns(); }, 150),
  });
  els.columns = h('div', { class: 'law-columns' });
  fill(els.board,
    h('div', { class: 'col-head' }, h('h2', {}, t('law.title')),
      h('span', { class: 'muted' }, t('law.count', { count: data.laws.length, groups: data.law_groups.length }))),
    h('div', { class: 'law-filters' }, search, select),
    h('p', { class: 'muted small' }, t('law.board_hint')),
    els.columns);
  renderColumns();
}

function renderColumns() {
  const data = store.data;
  const filtering = Boolean(filters.query.trim() || filters.source);
  // the game's three columns, then any category a mod made up
  const categories = [...data.law_categories];
  for (const group of data.law_groups) {
    if (!categories.some((c) => c.key === group.category)) categories.push({ key: group.category, name: group.category });
  }
  fill(els.columns, categories.map((category) => {
    const cards = data.law_groups.filter((group) => group.category === category.key).map((group) => {
      const rows = groupRows(group.key);
      const shown = filtering ? rows.filter(matches) : rows;
      if (filtering && !shown.length) return null;
      return groupCard(group, rows, shown, filtering);
    }).filter(Boolean);
    return h('section', { class: 'law-column' },
      h('h3', { class: 'law-column-title' }, category.name || category.key),
      cards.length ? cards : h('p', { class: 'muted small' }, t('law.no_match')));
  }));
}

function groupCard(group, rows, shown, filtering) {
  const open = filtering || expanded.has(group.key);
  const fallback = defaultOf(group.key);
  const changes = rows.filter((row) => row.mine).length;
  const first = rows.find((row) => row.key === fallback) || rows[0];
  const toggle = () => {
    if (expanded.has(group.key)) expanded.delete(group.key);
    else expanded.add(group.key);
    renderColumns();
  };
  const query = filters.query.trim();
  return h('div', { class: 'law-group' + (open ? ' open' : '') },
    h('button', { class: 'law-group-head', onclick: filtering ? null : toggle, title: group.key },
      thumb(first ? rowLaw(first).icon : '', 128, 'law-group-icon'),
      h('span', { class: 'law-group-text' },
        h('span', { class: 'law-group-name' }, group.name || group.key),
        first && h('span', { class: 'muted small' }, t('law.default_short', { name: rowName(first) })),
        groupLimits(group).length > 0 && h('span', { class: 'badges' }, groupLimits(group).map(limitBadge))),
      changes > 0 && h('span', { class: 'badge accent', title: t('law.changed_hint') }, t('law.changed', { count: changes })),
      h('span', { class: 'badge' }, String(rows.length)),
      !filtering && h('span', { class: 'side-caret' }, open ? '▾' : '▸')),
    open && h('div', { class: 'law-list' },
      shown.map((row) => lawRow(row, fallback, Boolean(query))),
      h('button', { class: 'btn law-add', onclick: () => run(() => newLaw(group.key)) }, `＋ ${t('law.new')}`)));
}

function lawRow(row, fallback, highlight) {
  const law = rowLaw(row);
  const limit = lawLimit(law);
  return h('div', { class: 'law-row' + (highlight ? ' match' : '') },
    h('button', { class: 'law-row-main', onclick: () => run(() => openRow(row)) },
      thumb(law.icon, 64, 'law-icon'),
      h('span', { class: 'company-title' },
        h('span', { class: 'company-name' }, rowName(row)),
        h('span', { class: 'company-key' }, row.key),
        limit && h('span', {}, limitBadge(limit))),
      h('span', { class: 'side-badges' },
        row.key === fallback && h('span', { class: 'badge', title: t('law.default_hint') }, t('law.default')),
        row.mine && h('span', { class: 'badge accent' }, row.mine.mode === 'override' ? t('law.modified') : t('law.added')),
        row.game && sourceBadges(row.game))),
    h('button', { class: 'btn small', title: t('law.copy_hint'), onclick: () => run(() => copyRow(row)) }, t('law.copy')));
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

function modifierLines(rows) {
  return h('ul', { class: 'modifier-lines' }, rows.map((modifier) => {
    const { text, tone } = formatModifier(modifier);
    return h('li', {}, h('b', { class: tone }, text), ' ', nameOf('modifiers', modifier.key));
  }));
}

function renderPreview() {
  const law = editing;
  const found = problems(law);
  const notes = [];
  if (law.mode === 'new' && !Object.values(law.names).some(Boolean)) notes.push(t('note.no_name'));
  if (law.mode === 'new' && !law.parent) notes.push(t('law.note_no_parent'));
  const lang = language();
  const original = law.mode === 'override' ? store.index.laws.get(law.key) : null;
  const desc = law.descs[lang] || (original && original.desc) || '';
  const group = store.index.law_groups.get(law.group);
  const limit = lawLimit(law);
  const limits = [
    ...groupLimits(group).map((item) => h('div', { title: item.title }, t('law.limit_group_line', { text: item.text }))),
    limit && h('div', { title: limit.title }, t('law.limit_law_line', { text: limit.text })),
  ].filter(Boolean);
  const limited = limits.length > 0 || law.blocks.can_enact.trim();
  if ((law.start.all || law.start.default) && limited) notes.push(t('law.note_start_conditions'));
  const category = group && store.index.law_categories.get(group.category);
  const counts = { good: 0, bad: 0, neutral: 0 };
  for (const { score } of stances(law)) counts[score > 0 ? 'good' : score < 0 ? 'bad' : 'neutral'] += 1;
  const others = groupRows(law.group).filter((row) => row.key !== (originalKey || law.key))
    .map((row) => ({ name: rowName(row), value: Number(rowLaw(row).progressiveness) || 0 }));
  const progression = [...others, { name: lawName(law), value: Number(law.progressiveness) || 0, current: true }]
    .sort((a, b) => a.value - b.value);
  const filled = store.state.languages.filter((l) => law.names[l.key]);
  const startChips = [
    law.start.all && h('span', { class: 'chip' }, t('law.start_all')),
    law.start.default && h('span', { class: 'chip' }, t('law.start_default')),
  ].filter(Boolean);
  const effects = MODIFIER_FIELDS.filter((name) => name !== 'institution_modifier' && law.modifiers[name].length);
  fill(els.preview,
    h('div', { class: 'law-preview-art' }, thumb(law.icon, 256, 'law-preview-icon')),
    h('h3', { class: 'preview-name' }, lawName(law)),
    desc && h('p', { class: 'muted small' }, desc),
    h('div', { class: 'preview-meta' },
      h('span', { class: 'company-key' }, law.key || '—'),
      h('span', { class: 'badge' + (law.mode === 'override' ? ' accent' : '') }, t('company.mode.' + law.mode)),
      dirty && h('span', { class: 'badge warn' }, t('company.unsaved'))),
    h('div', { class: 'muted' }, [category && category.name, group ? group.name : law.group].filter(Boolean).join(' · ')),
    h('div', { class: 'preview-group' },
      h('h4', {}, t('law.limits')),
      limits.length ? limits : h('span', { class: 'muted' }, t('law.no_limits'))),
    h('div', { class: 'preview-group' },
      h('h4', {}, t('law.stances')),
      h('div', {}, law.parent ? t('law.parent_short', { name: lawNameOf(law.parent) }) : t('law.no_parent')),
      h('div', { class: 'chips' },
        h('span', { class: 'chip good' }, t('law.count_approve', { count: counts.good })),
        h('span', { class: 'chip' }, t('law.count_neutral', { count: counts.neutral })),
        h('span', { class: 'chip bad' }, t('law.count_disapprove', { count: counts.bad })))),
    h('div', { class: 'preview-group' },
      h('h4', {}, t('law.progression')),
      h('ol', { class: 'law-progression' }, progression.map((item) =>
        h('li', { class: item.current ? 'current' : '' }, h('b', {}, String(item.value)), ' ', item.name)))),
    h('div', { class: 'preview-group' },
      h('h4', {}, t('factory.technologies')),
      law.unlocking_technologies.length
        ? h('div', { class: 'chips' }, law.unlocking_technologies.map((key) => objectChip('technologies', key)))
        : h('span', { class: 'muted' }, t('factory.no_technologies'))),
    h('div', { class: 'preview-group' },
      h('h4', {}, t('law.effects')),
      effects.length || law.institution
        ? [effects.map((name) => [effects.length > 1 && h('div', { class: 'muted small' }, t('law.modifier_title.' + name)),
          modifierLines(law.modifiers[name])]),
        law.institution && [h('div', { class: 'muted small' }, `${t('law.institution')}: ${nameOf('institutions', law.institution)}`),
          modifierLines(law.modifiers.institution_modifier)]]
        : h('span', { class: 'muted' }, t('common.none'))),
    h('div', { class: 'preview-group' },
      h('h4', {}, t('law.start')),
      startChips.length ? h('div', { class: 'chips' }, startChips) : h('span', { class: 'muted' }, t('law.start_none'))),
    h('div', { class: 'preview-group' },
      h('h4', {}, t('company.translations', { count: filled.length, total: store.state.languages.length })),
      h('div', { class: 'chips' }, store.state.languages.map((l) =>
        h('span', { class: 'chip' + (law.names[l.key] ? ' filled' : ' missing'), title: law.names[l.key] || '' }, l.name)))),
    found.length > 0 && h('ul', { class: 'problems' }, found.map((code) => h('li', {}, problemText(code)))),
    notes.length > 0 && h('ul', { class: 'notes' }, notes.map((note) => h('li', {}, note))));
}

// ------------------------------------------------------------------- editor

const scriptArea = (get, set) => scriptBox(get, set, changed);

function basicSection() {
  const law = editing;
  const lang = language();
  const original = law.mode === 'override' ? store.index.laws.get(law.key) : null;
  const key = h('input', {
    class: 'input mono', type: 'text', spellcheck: false, value: law.key, disabled: law.mode === 'override',
    placeholder: 'law_my_law', oninput: () => { law.key = key.value.trim(); changed(); },
  });
  const text = (field) => (event) => {
    const value = event.target.value.trim();
    if (value) law[field][lang] = value;
    else delete law[field][lang];
    changed();
  };
  const name = h('input', { class: 'input', type: 'text', value: law.names[lang] || '',
    placeholder: (original && original.name) || '', oninput: text('names') });
  const desc = h('textarea', { class: 'input', rows: 3, value: law.descs[lang] || '',
    placeholder: (original && original.desc) || '', oninput: text('descs') });
  const group = h('select', {
    class: 'input', disabled: law.mode === 'override',
    onchange: () => {
      law.group = group.value;
      // the parent and the default belong to the old group
      law.parent = '';
      changed();
      refresh('stances');
    },
  }, store.data.law_categories.map((category) => h('optgroup', { label: category.name },
    store.data.law_groups.filter((g) => g.category === category.key).map((g) => h('option', { value: g.key }, g.name || g.key)))));
  group.value = law.group;
  const progress = h('input', {
    class: 'input level' + (NUMBER_PATTERN.test(law.progressiveness) ? '' : ' invalid'), type: 'text',
    value: law.progressiveness,
    oninput: () => {
      law.progressiveness = progress.value.trim();
      progress.classList.toggle('invalid', !NUMBER_PATTERN.test(law.progressiveness));
      changed();
    },
  });
  return section(t('company.basic'), null,
    law.mode === 'override' && h('div', { class: 'notice warn' },
      t('law.override_note', { source: original ? sourceName(original.source) : '?' })),
    field(t('company.key'), key, law.mode === 'override' ? null : t('law.key_hint')),
    field(t('company.name', { language: languageName(lang) }), name,
      law.mode === 'override' ? t('company.name_hint_override') : t('company.name_hint')),
    field(t('law.desc', { language: languageName(lang) }), desc),
    field(t('law.group'), group, law.mode === 'override' ? t('law.group_locked') : t('law.group_hint')),
    field(t('law.progressiveness'), progress, t('law.progressiveness_hint')));
}

function imagesSection() {
  return section(t('company.images'), t('law.images_hint'),
    imageField({ label: t('company.icon'), value: editing.icon, paths: store.data.law_icons, kind: 'law_icon',
      onChange: (path) => { editing.icon = path; changed(); refresh('images'); } }));
}

function stancesSection() {
  const law = editing;
  const options = parentOptions(law);
  const parent = h('select', {
    class: 'input',
    onchange: () => { law.parent = parent.value; changed(); refresh('stances'); },
  },
    h('option', { value: '' }, t('law.no_parent')),
    options.map((other) => h('option', { value: other.key }, `${lawNameOf(other.key)} (${other.key})`)));
  parent.value = law.parent;
  const rows = stances(law).map(({ ig, parts, score }) => {
    const label = stanceLabel(score);
    return h('div', { class: 'stance-row' },
      thumb(ig.icon, 64, 'stance-icon'),
      h('span', { class: 'grow' },
        h('span', {}, ig.name || ig.key),
        h('span', { class: 'muted small' }, parts.map((part) =>
          `${nameOf('ideologies', part.id)}：${t('law.stance.' + part.stance)}`).join(' · '))),
      h('b', { class: label.tone }, label.text));
  });
  return section(t('law.stances'), t('law.stances_hint'),
    field(t('law.parent'), parent, law.mode === 'override' && !law.parent ? t('law.parent_override_hint') : t('law.parent_hint')),
    h('div', { class: 'stance-table' }, rows),
    h('p', { class: 'muted small' }, t('law.stances_note')));
}

function startSection() {
  const law = editing;
  const check = (name, label, hint, disabled = false) => h('div', {},
    h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: law.start[name], disabled,
        onchange: (event) => { law.start[name] = event.target.checked; changed(); } }),
      label),
    h('p', { class: 'muted small' }, hint));
  return section(t('law.start'), t('law.start_hint'),
    check('all', t('law.start_all'), t('law.start_all_hint')),
    check('default', t('law.start_default'),
      law.mode === 'override' ? t('law.start_default_override') : t('law.start_default_hint'), law.mode === 'override'));
}

function conditionBlock(name) {
  const law = editing;
  return h('div', { class: 'cond-block' },
    h('div', { class: 'cond-head' },
      h('span', { class: 'field-label' }, t('law.block.' + name)),
      h('span', { class: 'mono muted small' }, name)),
    h('p', { class: 'muted small' }, t('law.block_hint.' + name)),
    conditionEditor({
      id: 'law_' + name, kinds: COUNTRY_KINDS,
      get: () => law.blocks[name],
      set: (text) => { law.blocks[name] = text; changed(); },
    }));
}

function unlockSection() {
  const law = editing;
  const chips = (name, kind) => keyChips({ keys: law[name], kind, label: t('law.list.' + name),
    hint: t('law.list_hint.' + name), onChange: (keys) => { law[name] = keys; changed(); refresh('unlock'); } });
  return section(t('law.unlock'), null,
    chips('unlocking_technologies', 'technologies'),
    chips('unlocking_laws', 'laws'),
    chips('requires_law_or', 'laws'),
    chips('disallowing_laws', 'laws'),
    conditionBlock('is_visible'),
    conditionBlock('can_enact'));
}

// The rows of one modifier block, with a picker to choose which modifiers it has.
function modifierRows(name, sectionName, hint) {
  const law = editing;
  const label = t('law.modifier_title.' + name);
  const pick = () => openPicker({
    title: label,
    selected: law.modifiers[name].map((m) => m.key),
    toggle: { label: t('law.only_law_modifiers'), test: (item) => item.law_used, on: true },
    items: store.data.modifiers.map((m) => ({ key: m.key, name: m.name || m.key, sub: m.key, law_used: m.law_used })),
    onDone: (keys) => {
      const values = new Map(law.modifiers[name].map((m) => [m.key, m.value]));
      law.modifiers[name] = keys.map((key) => ({ key, value: values.get(key) ?? '0.1' }));
      changed();
      refresh(sectionName);
    },
  });
  const rows = law.modifiers[name].map((modifier) => {
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
      h('span', { class: 'grow' }, h('span', {}, nameOf('modifiers', modifier.key)), h('span', { class: 'company-key' }, modifier.key)),
      input, effect,
      h('button', { class: 'btn icon-btn', title: t('common.remove'), onclick: () => {
        law.modifiers[name] = law.modifiers[name].filter((m) => m !== modifier);
        changed();
        refresh(sectionName);
      } }, '✕'));
  });
  return h('div', { class: 'law-modifiers' },
    h('div', { class: 'row' }, h('span', { class: 'field-label' }, label), h('span', { class: 'mono muted small' }, name)),
    hint && h('p', { class: 'muted small' }, hint),
    rows,
    h('div', { class: 'row' }, h('button', { class: 'btn', onclick: pick }, t('company.add_modifier'))));
}

function effectsSection() {
  const law = editing;
  const institution = h('select', {
    class: 'input',
    onchange: () => { law.institution = institution.value; changed(); refresh('effects'); },
  },
    h('option', { value: '' }, t('law.no_institution')),
    store.data.institutions.map((item) => h('option', { value: item.key }, item.name || item.key)));
  institution.value = law.institution;
  return section(t('law.effects'), t('law.effects_hint'),
    modifierRows('modifier', 'effects'),
    field(t('law.institution'), institution, t('law.institution_hint')),
    (law.institution || law.modifiers.institution_modifier.length > 0)
      && modifierRows('institution_modifier', 'effects', t('law.institution_modifier_hint')));
}

// Taxes for the taxation laws, acceptance for the citizenship laws (or any law that has them).
function specialSection() {
  const law = editing;
  const tax = law.group === TAX_GROUP || TAX_LEVELS.some((level) => law.modifiers[`tax_modifier_${level}`].length);
  const acceptance = law.group === CITIZENSHIP_GROUP || law.modifiers.acceptance_modifier.length > 0;
  if (!tax && !acceptance) return h('div', { class: 'law-special-none' });
  return section(t('law.special'), t('law.special_hint'),
    tax && TAX_LEVELS.map((level) => modifierRows(`tax_modifier_${level}`, 'special')),
    acceptance && modifierRows('acceptance_modifier', 'special'));
}

function scriptBlock(name, example) {
  const law = editing;
  return h('div', { class: 'script-field' },
    h('div', { class: 'cond-head' },
      h('span', { class: 'field-label' }, t('law.block.' + name)),
      h('span', { class: 'mono muted small' }, name)),
    h('p', { class: 'muted small' }, t('law.block_hint.' + name)),
    scriptArea(() => law.blocks[name], (value) => { law.blocks[name] = value; }),
    example && h('details', { class: 'cond-script' },
      h('summary', {}, t('law.example')),
      h('pre', { class: 'law-example mono' }, example)));
}

function scriptsSection() {
  return section(t('law.scripts'), t('law.scripts_hint'),
    SCRIPT_BLOCKS.map((name) => scriptBlock(name, EXAMPLES[name])));
}

function aiSection() {
  const law = editing;
  return section(t('company.ai'), null,
    AI_BLOCKS.map((name) => scriptBlock(name, name === 'ai_enact_weight_modifier' ? AI_PETITIONS : null)),
    law.blocks.ai_enact_weight_modifier.trim() !== AI_PETITIONS && h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: () => {
        law.blocks.ai_enact_weight_modifier = AI_PETITIONS;
        changed();
        refresh('ai');
      } }, t('law.ai_petitions'))));
}

function advancedSection() {
  const law = editing;
  return section(t('company.advanced'), null,
    h('div', { class: 'script-field' },
      h('span', { class: 'field-label' }, t('company.extra')),
      h('p', { class: 'muted small' }, t('law.extra_hint')),
      scriptArea(() => law.extra, (value) => { law.extra = value; })));
}

const builders = {
  basic: basicSection,
  images: imagesSection,
  stances: stancesSection,
  start: startSection,
  unlock: unlockSection,
  effects: effectsSection,
  special: specialSection,
  scripts: scriptsSection,
  ai: aiSection,
  advanced: advancedSection,
};

// An overridden law that several sources define: which version to start from.
function versionBar() {
  const law = editing;
  const game = law.mode === 'override' && originalKey === null ? store.index.laws.get(law.key) : null;
  if (!game || game.sources.length < 2) return null;
  const last = game.sources[game.sources.length - 1];
  const current = versionSource || last;
  const pick = async (id) => {
    if (id === current) return;
    if (!pristine && !(await confirmDialog(t('law.version_confirm'), t('company.discard')))) return;
    const version = game.versions.find((v) => v.source === id);
    versionSource = id;
    dirty = false;
    await edit({ ...(version ? { ...game, ...version } : game), mode: 'override', names: {}, descs: {} }, null, true);
  };
  return h('div', { class: 'law-version detail-chips' },
    h('span', { class: 'muted' }, `${t('company.version')}: `),
    game.sources.map((id) => h('button', {
      class: 'btn small' + (id === current ? ' selected' : ''),
      title: id === last ? t('company.source_active', { source: sourceName(id) }) : sourceName(id),
      onclick: () => run(() => pick(id)),
    }, sourceName(id))),
    h('span', { class: 'muted small' }, t('law.version_hint')));
}

function renderMiddle() {
  for (const name of Object.keys(builders)) sections[name] = builders[name]();
  fill(els.middle,
    h('div', { class: 'editor-bar' },
      versionBar(),
      h('button', { class: 'btn icon-btn', title: t('law.back'), onclick: () => run(close) }, '✕')),
    Object.values(sections));
}
