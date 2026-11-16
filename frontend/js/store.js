// State shared by all views: what the backend knows, and the loaded game data.
import { api } from './api.js';
import { t } from './i18n.js';

export const store = {
  state: null,    // /api/state: settings, folder checks, load status, current project
  data: null,     // /api/data: game data with names in the current language
  index: null,    // lookups by key into `data`
  project: null,  // the mod being built
  onState: null,  // called whenever `state` changes
};

export function setState(state) {
  store.state = state;
  if (store.onState) store.onState();
  return state;
}

export async function refreshState() {
  return setState(await api.get('/api/state'));
}

export function language() {
  return store.state.settings.language;
}

export function languageName(key) {
  const found = store.state.languages.find((l) => l.key === key);
  return found ? found.name : key;
}

const INDEXED = ['companies', 'buildings', 'modifiers', 'states', 'regions', 'countries', 'prestige_goods', 'categories',
  'technologies', 'cultures', 'factories', 'building_groups', 'pmgs', 'pms', 'goods', 'pop_types', 'laws',
  'principles', 'identities', 'geographic_regions', 'religions', 'straits', 'culture_traits', 'lenses',
  'law_groups', 'law_categories', 'ideologies', 'interest_groups', 'institutions'];

// Game data for the current language, or null when nothing is loaded yet.
export async function loadData() {
  if (store.state.load.state !== 'ready') {
    store.data = store.index = null;
    return null;
  }
  if (!store.data || store.data.language !== language()) {
    const data = await api.get('/api/data?lang=' + encodeURIComponent(language()));
    const index = { sources: new Map(data.sources.map((s) => [s.id, s])) };
    for (const kind of INDEXED) index[kind] = new Map(data[kind].map((item) => [item.key, item]));
    data.gameBuildings = data.buildings;
    store.data = data;
    store.index = index;
    listProjectBuildings();
  }
  return store.data;
}

// Imported images the items open in the editor pages use, by page: page -> () => paths.
// Saves send them along so that the backend keeps them although nothing saved uses them yet.
export const editingImages = new Map();

// `except`: a page whose open item is going away (deleted), so its images do not count.
export function keptImages(except = null) {
  return [...editingImages].filter(([page]) => page !== except).flatMap(([, paths]) => paths())
    .filter((path) => typeof path === 'string' && path);
}

// The mod being built, as the backend returned it.
export function setProject(project) {
  store.project = project;
  listProjectBuildings();
  return project;
}

// New factories of the mod can be chosen wherever a building is chosen.
function listProjectBuildings() {
  const { data, index, project } = store;
  if (!data || !project) return;
  const known = new Set(data.gameBuildings.map((building) => building.key));
  const own = (project.factories || []).filter((factory) => !known.has(factory.key)).map((factory) => {
    const group = index.building_groups.get(factory.building_group);
    const root = group ? group.root : factory.building_group;
    return { key: factory.key, name: factoryName(factory), group: root, icon: factory.icon, used: false,
      group_name: `${nameOf('building_groups', root)} · ${t('factory.in_mod')}` };
  });
  data.buildings = [...data.gameBuildings, ...own];
  index.buildings = new Map(data.buildings.map((building) => [building.key, building]));
}

export function dropData() {
  store.data = store.index = null;
}

// Display name of a game object; falls back to its key.
export function nameOf(kind, key) {
  const item = store.index && store.index[kind].get(key);
  return (item && item.name) || key;
}

// Name of a company in the project: its own name in the current language, else the game's
// name of the company it overrides, else its English name or key.
export function companyName(company) {
  const original = company.mode === 'override' && store.index ? store.index.companies.get(company.key) : null;
  return company.names[language()] || (original && original.name) || company.names.english
    || company.key || t('company.unnamed');
}

// Name of a factory or monument in the project, by the same rules.
function buildingName(building, unnamed) {
  const original = building.mode === 'override' && store.index ? store.index.factories.get(building.key) : null;
  return building.names[language()] || (original && original.name) || building.names.english || building.key || unnamed;
}

export const factoryName = (factory) => buildingName(factory, t('factory.unnamed'));
export const monumentName = (monument) => buildingName(monument, t('monument.unnamed'));

// Name of a law in the project, by the same rules.
export function lawName(law) {
  const original = law.mode === 'override' && store.index ? store.index.laws.get(law.key) : null;
  return law.names[language()] || (original && original.name) || law.names.english || law.key || t('law.unnamed');
}

// Game path of an object's icon, or '' when it has none.
export function iconOf(kind, key) {
  const item = store.index && store.index[kind].get(key);
  return (item && item.icon) || '';
}
