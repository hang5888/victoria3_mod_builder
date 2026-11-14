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
  'technologies', 'cultures'];

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
    store.data = data;
    store.index = index;
  }
  return store.data;
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

// Game path of an object's icon, or '' when it has none.
export function iconOf(kind, key) {
  const item = store.index && store.index[kind].get(key);
  return (item && item.icon) || '';
}
