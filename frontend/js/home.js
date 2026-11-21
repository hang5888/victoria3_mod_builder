// Home view: folders, mods to load, loading game data, the output mod, and the mod types.
import { api } from './api.js';
import { t } from './i18n.js';
import { store, refreshState, setState, loadData, dropData } from './store.js';
import { h, toast, errorText, debounce } from './ui.js';
import { resetMap } from './map.js';
import { thumb } from './icons.js';

const FOLDERS = ['game_dir', 'workshop_dir', 'local_mod_dir'];

let root = null;
let modsInfo = null;    // /api/mods, when the folders are valid
let projects = [];
let projectData = null; // the current mod's project file, for the counts on the type cards
let modQuery = '';
let onlyCompanyMods = false;
let triedDetect = false;
let pollTimer = null;
const els = {};         // parts of the page that are redrawn on their own

const foldersOk = () => Object.values(store.state.folders).every((error) => !error);

async function run(action) {
  try {
    await action();
  } catch (error) {
    console.error(error);
    toast(errorText(error), 'error');
  }
}

export async function renderHome(container) {
  root = container;
  await refreshState();
  if (!store.state.settings.game_dir && !triedDetect) {
    triedDetect = true;  // first start: look for the folders once
    await detectFolders(false);
  }
  if (foldersOk()) {
    [modsInfo, projects] = await Promise.all([
      api.get('/api/mods'), api.get('/api/projects').then((r) => r.projects)]);
  } else {
    modsInfo = null;
    projects = [];
  }
  projectData = store.state.project ? await api.get('/api/project').catch(() => null) : null;
  await loadData();
  draw();
  if (store.state.load.state === 'loading') poll();
}

// The five steps of the page, in order: [title, done].
function steps() {
  const { load, project } = store.state;
  return [
    [t('home.folders'), foldersOk()],
    [t('home.mods'), foldersOk()],  // choosing mods is optional
    [t('home.load_title'), load.state === 'ready' && !load.stale],
    [t('home.project'), Boolean(project)],
    [t('home.types'), false],
  ];
}

const allReady = () => steps().slice(0, 4).every(([, done]) => done);

function draw() {
  els.hero = hero();
  els.load = loadCard();
  els.types = typesCard();
  const setup = h('div', { class: 'home-grid' },
    h('div', { class: 'home-col' }, foldersCard(), els.load, projectCard()),
    h('div', { class: 'home-col' }, modsCard()));
  // Once everything is set up, what to make comes first.
  root.replaceChildren(h('div', { class: 'home' }, els.hero, allReady() ? [els.types, setup] : [setup, els.types]));
}

function redrawLoad() {
  for (const [name, build] of [['hero', hero], ['load', loadCard], ['types', typesCard]]) {
    const fresh = build();
    els[name].replaceWith(fresh);
    els[name] = fresh;
  }
}

// Title, where things stand, and the steps with the next one marked.
function hero() {
  const { version, project, load } = store.state;
  const list = steps();
  const next = list.findIndex(([, done]) => !done);
  const summary = load.state === 'ready' && load.summary;
  return h('header', { class: 'hero' },
    h('div', { class: 'hero-top' },
      h('div', { class: 'hero-text' },
        h('h1', {}, 'Victoria 3 Mod Builder'),
        h('p', {}, t('home.intro'))),
      h('div', { class: 'hero-status' },
        version && h('span', { class: 'hero-chip' }, t('home.game_version', { version })),
        project && h('span', { class: 'hero-chip accent', title: project.dir }, t('home.project_current', { name: project.name })),
        summary && h('span', { class: 'hero-chip' }, t('home.loaded_short', {
          companies: summary.companies, buildings: summary.buildings, mods: summary.mods })))),
    h('ol', { class: 'stepper' }, list.map(([title, done], i) => h('li', {
      class: 'stepper-item' + (done ? ' done' : '') + (i === next ? ' current' : ''),
    },
      h('button', {
        class: 'stepper-button',
        onclick: () => { const el = document.getElementById(`step-${i + 1}`); if (el) el.scrollIntoView({ behavior: 'smooth' }); },
      },
        h('span', { class: 'step' }, done ? '✓' : String(i + 1)),
        h('span', { class: 'stepper-title' }, title))))));
}

function card(step, title, ...children) {
  const done = steps()[Number(step) - 1][1];
  return h('section', { class: 'card home-card', id: `step-${step}` },
    h('h2', {}, h('span', { class: 'step' + (done ? ' done' : '') }, done ? '✓' : step), title),
    children);
}

// ------------------------------------------------------------------ folders

async function saveFolders(values) {
  setState(await api.post('/api/settings', values));
  await renderHome(root);
}

async function detectFolders(redraw = true) {
  const found = await api.post('/api/detect');
  const values = Object.fromEntries(FOLDERS.filter((key) => found[key]).map((key) => [key, found[key]]));
  if (Object.keys(values).length === 0) {
    if (redraw) toast(t('home.detect_failed'), 'error');
    return;
  }
  setState(await api.post('/api/settings', values));
  if (redraw) await renderHome(root);
}

async function browse(key, current) {
  const { path } = await api.post('/api/browse', { initial: current });
  if (path) await saveFolders({ [key]: path });
}

function foldersCard() {
  const { settings, folders, version } = store.state;
  const rows = FOLDERS.map((key) => {
    const error = folders[key];
    const input = h('input', {
      class: 'input', type: 'text', spellcheck: false, value: settings[key],
      onchange: () => run(() => saveFolders({ [key]: input.value })),
    });
    let status = h('span', { class: 'status good' }, '✓');
    if (error) status = h('span', { class: 'status bad' }, t('home.folder_error.' + error));
    else if (!settings[key]) status = h('span', { class: 'status' }, t('home.optional'));
    return h('div', { class: 'folder-row' },
      h('label', {}, t('home.folder.' + key)),
      input,
      h('button', { class: 'btn', onclick: () => run(() => browse(key, input.value)) }, t('home.browse')),
      status);
  });
  return card('1', t('home.folders'),
    rows,
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: () => run(() => detectFolders()) }, t('home.detect')),
      version && h('span', { class: 'muted' }, t('home.game_version', { version }))));
}

// --------------------------------------------------------------------- mods

async function setEnabled(ids) {
  const state = setState(await api.post('/api/mods/enabled', { enabled: ids }));
  modsInfo.enabled = state.settings.enabled_mods;
  renderModList();
  redrawLoad();
}

function moveMod(id, delta) {
  const ids = [...modsInfo.enabled];
  const from = ids.indexOf(id);
  const to = from + delta;
  if (to < 0 || to >= ids.length) return;
  [ids[from], ids[to]] = [ids[to], ids[from]];
  run(() => setEnabled(ids));
}

function modRow(mod, position) {
  const enabled = position !== null;
  const toggle = () => run(() => setEnabled(
    enabled ? modsInfo.enabled.filter((id) => id !== mod.id) : [...modsInfo.enabled, mod.id]));
  return h('div', { class: 'mod-row' + (enabled ? ' enabled' : '') },
    h('label', { class: 'check mod-name' },
      h('input', { type: 'checkbox', checked: enabled, onchange: toggle }),
      enabled && h('span', { class: 'order' }, String(position + 1)),
      h('span', { title: mod.dir }, mod.name)),
    mod.has_companies && h('span', { class: 'badge accent' }, t('home.mod_has_companies')),
    mod.builder && h('span', { class: 'badge' }, t('home.mod_builder')),
    h('span', { class: 'badge' }, t('home.mod_kind.' + mod.kind)),
    mod.game_version && h('span', { class: 'badge' }, mod.game_version),
    enabled && h('span', { class: 'mod-move' },
      h('button', { class: 'btn icon-btn', title: t('home.move_up'), disabled: position === 0,
        onclick: () => moveMod(mod.id, -1) }, '↑'),
      h('button', { class: 'btn icon-btn', title: t('home.move_down'),
        disabled: position === modsInfo.enabled.length - 1, onclick: () => moveMod(mod.id, 1) }, '↓')));
}

function renderModList() {
  const byId = new Map(modsInfo.mods.map((mod) => [mod.id, mod]));
  const query = modQuery.trim().toLowerCase();
  const shown = (mod) => (!query || mod.name.toLowerCase().includes(query) || mod.id.includes(query))
    && (!onlyCompanyMods || mod.has_companies);
  const enabled = modsInfo.enabled.map((id) => byId.get(id)).filter(Boolean);
  const rest = modsInfo.mods.filter((mod) => !modsInfo.enabled.includes(mod.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  const rows = [
    ...enabled.map((mod, i) => shown(mod) && modRow(mod, i)),
    ...rest.map((mod) => shown(mod) && modRow(mod, null)),
  ].filter(Boolean);
  els.modList.replaceChildren(...(rows.length ? rows : [h('p', { class: 'muted pad' }, t('home.no_mods'))]));
  els.modCount.textContent = t('home.mods_enabled', { count: enabled.length, total: modsInfo.mods.length });
}

async function importPlayset(id) {
  const playset = modsInfo.playsets.find((p) => p.id === id);
  const { enabled } = await api.post('/api/playsets/import', { id });
  modsInfo.enabled = enabled;
  await refreshState();
  renderModList();
  redrawLoad();
  toast(t('home.playset_imported', { count: enabled.length, total: playset ? playset.count : enabled.length }));
}

function modsCard() {
  if (!modsInfo) return card('2', t('home.mods'), h('p', { class: 'muted' }, t('home.need_folders')));
  els.modList = h('div', { class: 'mod-list' });
  els.modCount = h('span', { class: 'muted' });
  const search = h('input', {
    class: 'input', type: 'search', placeholder: t('common.search'), value: modQuery,
    oninput: debounce(() => { modQuery = search.value; renderModList(); }, 120),
  });
  const playsets = h('select', { class: 'input' },
    modsInfo.playsets.map((p) => h('option', { value: p.id },
      `${p.name} (${p.count})${p.active ? ' ★' : ''}`)));
  const result = card('2', t('home.mods'),
    h('p', { class: 'muted' }, t('home.mods_hint')),
    h('div', { class: 'row' },
      search,
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: onlyCompanyMods,
          onchange: (event) => { onlyCompanyMods = event.target.checked; renderModList(); } }),
        t('home.only_company_mods')),
      els.modCount,
      h('button', { class: 'btn', onclick: () => run(() => setEnabled([])) }, t('home.clear_mods'))),
    modsInfo.playsets.length > 0 && h('div', { class: 'row' },
      h('span', {}, t('home.playset')),
      playsets,
      h('button', { class: 'btn', onclick: () => run(() => importPlayset(playsets.value)) }, t('home.import_playset'))),
    els.modList);
  renderModList();
  return result;
}

// --------------------------------------------------------------------- load

async function startLoad() {
  setState(await api.post('/api/load'));
  redrawLoad();
  poll();
}

function poll() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      await refreshState();
    } catch {
      return;  // server not reachable right now; try again on the next tick
    }
    if (store.state.load.state === 'loading') {
      if (root.classList.contains('view-home')) redrawLoad();
      return;
    }
    clearInterval(pollTimer);
    dropData();
    resetMap();
    if (root.classList.contains('view-home')) run(() => renderHome(root));
  }, 400);
}

function loadCard() {
  const { load } = store.state;
  const loading = load.state === 'loading';
  const parts = [h('p', { class: 'muted' }, t('home.load_hint'))];
  parts.push(h('div', { class: 'row' },
    h('button', { class: 'btn primary', disabled: loading || !foldersOk(), onclick: () => run(startLoad) },
      load.state === 'ready' ? t('home.reload') : t('home.load')),
    loading && h('span', {}, t('home.loading', { step: t('home.step.' + load.step) }))));
  if (loading) {
    parts.push(h('div', { class: 'progress' },
      h('div', { class: 'progress-bar', style: `width:${Math.round(100 * load.done / Math.max(1, load.total))}%` })));
  }
  if (load.state === 'error') parts.push(h('div', { class: 'notice error' }, t('home.load_failed', { error: load.error })));
  if (load.state === 'ready' && load.summary) {
    const s = load.summary;
    parts.push(h('div', { class: 'stats' },
      ['companies', 'buildings', 'modifiers', 'states', 'mods'].map((key) =>
        h('div', { class: 'stat' }, h('b', {}, String(s[key])), h('span', {}, t('home.stat.' + key))))));
    if (load.stale) parts.push(h('div', { class: 'notice warn' }, t('home.stale')));
    const warnings = (store.data && store.data.warnings) || [];
    if (warnings.length) {
      parts.push(h('details', { class: 'warnings' },
        h('summary', {}, t('home.warnings', { count: warnings.length })),
        h('ul', {}, warnings.slice(0, 500).map((w) => h('li', {}, w)))));
    }
  }
  return card('3', t('home.load_title'), parts);
}

// ------------------------------------------------------------------ project

async function createProject(name) {
  if (!name.trim()) return toast(t('error.name_missing'), 'error');
  setState(await api.post('/api/projects', { name: name.trim() }));
  toast(t('home.project_created', { dir: store.state.project.dir }));
  await renderHome(root);
}

async function openProject(dir) {
  setState(await api.post('/api/projects/open', { dir }));
  await renderHome(root);
}

function projectCard() {
  if (!foldersOk()) return card('4', t('home.project'), h('p', { class: 'muted' }, t('home.need_folders')));
  const { project } = store.state;
  const select = h('select', { class: 'input' },
    projects.map((p) => h('option', { value: p.dir, selected: project && p.dir === project.dir }, p.name)));
  const name = h('input', { class: 'input', type: 'text', placeholder: t('home.project_name') });
  return card('4', t('home.project'),
    h('p', { class: 'muted' }, t('home.project_hint')),
    project
      ? h('div', { class: 'notice good' }, t('home.project_current', { name: project.name }),
        h('div', { class: 'muted path' }, project.dir))
      : h('div', { class: 'notice warn' }, t('home.project_none')),
    projects.length > 0 && h('div', { class: 'row' },
      h('span', {}, t('home.project_existing')),
      select,
      h('button', { class: 'btn', onclick: () => run(() => openProject(select.value)) }, t('home.project_open'))),
    h('div', { class: 'row' },
      h('span', {}, t('home.project_new')),
      name,
      h('button', { class: 'btn', onclick: () => run(() => createProject(name.value)) }, t('home.project_create'))));
}

// -------------------------------------------------------------------- types

function typesCard() {
  const { load, project } = store.state;
  let blocked = '';
  if (load.state !== 'ready') blocked = t('home.need_data');
  else if (!project) blocked = t('home.need_project');
  // Game art for the cards, once there is data to take it from.
  const data = store.data;
  const find = (paths, word) => (data && (paths.find((path) => path.includes(word)) || paths[0])) || '';
  const typeCard = (route, title, hint, art, icon, count) => h('button', {
    class: 'type-card', disabled: !!blocked, onclick: () => { location.hash = '#/' + route; },
  },
    h('div', { class: 'type-art' },
      thumb(art, 480, 'type-bg'), thumb(icon, 128, 'type-icon'),
      count > 0 && h('span', { class: 'type-count' }, t('home.type.count', { count }))),
    h('div', { class: 'type-body' }, h('b', {}, title), h('span', {}, blocked || hint)));
  const counts = projectData || { companies: [], factories: [] };
  return card('5', t('home.types'),
    h('div', { class: 'types' },
      typeCard('company', t('home.type.company'), t('home.type.company_hint'),
        find(data ? data.backgrounds : [], 'comp_illu_harbor_shipbuilding'), find(data ? data.icons : [], 'basic_steel'),
        counts.companies.length),
      typeCard('factory', t('home.type.factory'), t('home.type.factory_hint'),
        find(data ? data.building_backgrounds : [], 'light_industry'), find(data ? data.building_icons : [], 'food_industry'),
        (counts.factories || []).length),
      typeCard('monument', t('home.type.monument'), t('home.type.monument_hint'),
        find(data ? data.building_backgrounds : [], 'monuments'), find(data ? data.building_icons : [], 'eiffel'),
        (counts.monuments || []).length),
      typeCard('law', t('home.type.law'), t('home.type.law_hint'),
        find(data ? data.building_backgrounds : [], 'government'), find(data ? data.law_icons : [], 'monarchy'),
        (counts.laws || []).length),
      typeCard('goods', t('home.type.goods'), t('home.type.goods_hint'),
        find(data ? data.backgrounds : [], 'comp_illu_manufacturing_light'), find(data ? data.goods_icons : [], 'automobiles'),
        (counts.goods || []).length + (counts.prestige_goods || []).length),
      typeCard('country', t('home.type.country'), t('home.type.country_hint'),
        find(data ? data.backgrounds : [], 'comp_illu_trade'), find(data ? data.law_icons : [], 'monarchy'),
        (counts.country_starts || []).length),
      h('div', { class: 'type-card planned' },
        h('div', { class: 'type-art' }, h('span', { class: 'type-plus' }, '+')),
        h('div', { class: 'type-body' }, h('b', {}, t('home.type.more')), h('span', {}, t('home.type.planned'))))));
}
