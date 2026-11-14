// Sidebar of the editor pages: everything the mod changes, grouped by kind, with the save
// and open folder buttons.
//
// The editor page passes itself in as
//   { kind, state() -> {key, dirty, editing}, open(item), remove(item), discard(), save() }
// where `key` is the key of the opened item in the project (null for a new one) and
// `editing` is the item as it is being edited.
import { api } from './api.js';
import { t } from './i18n.js';
import { store, companyName } from './store.js';
import { h, fill, toast, errorText } from './ui.js';
import { thumb } from './icons.js';

// What a mod can contain, in the order shown.
const KINDS = {
  company: { items: (project) => project.companies, name: companyName, icon: (item) => item.icon },
};

const STORAGE_KEY = 'vmb.sidebar.collapsed';
const collapsed = loadCollapsed();
let container = null;
let editor = null;

function loadCollapsed() {
  try {
    return new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'));
  } catch {
    return new Set();
  }
}

function toggle(kind) {
  if (collapsed.has(kind)) collapsed.delete(kind);
  else collapsed.add(kind);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...collapsed]));
  } catch {
    // remembering is only a convenience
  }
  refreshSidebar();
}

async function run(action) {
  try {
    await action();
  } catch (error) {
    console.error(error);
    toast(errorText(error), 'error');
  }
}

export function renderSidebar(element, activeEditor) {
  container = element;
  editor = activeEditor;
  refreshSidebar();
}

// Redraw after the project, the opened item or its unsaved state changed.
export function refreshSidebar() {
  if (!container || !store.project) return;
  const state = editor.state();
  fill(container,
    h('div', { class: 'col-head' }, h('h2', {}, t('sidebar.title'))),
    h('div', { class: 'muted small', title: store.state.project ? store.state.project.dir : '' }, store.project.name),
    Object.entries(KINDS).map(([kind, def]) => group(kind, def, state)),
    h('div', { class: 'actions sidebar-actions' },
      h('button', { class: 'btn primary', onclick: () => run(editor.save) }, t('sidebar.save')),
      h('button', { class: 'btn', onclick: () => run(() => api.post('/api/project/open_folder', {})) },
        t('sidebar.open_folder'))));
}

function group(kind, def, state) {
  const active = editor.kind === kind;
  const items = def.items(store.project);
  const rows = items.map((item) => {
    const current = active && item.key === state.key;
    return row(def, current ? state.editing : item, {
      current,
      unsaved: current && state.dirty,
      onOpen: current ? null : () => editor.open(item),
      onRemove: () => editor.remove(item),
      removeTitle: t('sidebar.delete'),
    });
  });
  // A new item that has not been saved yet.
  if (active && state.key === null && state.dirty) {
    rows.unshift(row(def, state.editing, {
      current: true, unsaved: true, onOpen: null, onRemove: editor.discard, removeTitle: t('company.discard'),
    }));
  }
  const open = !collapsed.has(kind);
  return h('section', { class: 'side-group' },
    h('button', {
      class: 'side-group-head', title: open ? t('sidebar.collapse') : t('sidebar.expand'),
      'aria-expanded': String(open), onclick: () => toggle(kind),
    },
      h('span', { class: 'side-caret' }, open ? '▾' : '▸'),
      h('span', { class: 'side-group-title' }, t('sidebar.category.' + kind)),
      h('span', { class: 'badge' }, String(items.length))),
    open && (rows.length > 0
      ? h('div', { class: 'side-items' }, rows)
      : h('p', { class: 'muted small side-empty' }, t('sidebar.empty'))));
}

function row(def, item, { current, unsaved, onOpen, onRemove, removeTitle }) {
  return h('div', { class: 'side-item' + (current ? ' current' : '') },
    h('button', { class: 'side-item-main', onclick: onOpen && (() => run(onOpen)) },
      thumb(def.icon(item), 64, 'side-icon'),
      h('span', { class: 'company-title' },
        h('span', { class: 'company-name' }, def.name(item)),
        h('span', { class: 'company-key' }, item.key || '—')),
      h('span', { class: 'side-badges' },
        h('span', { class: 'badge' + (item.mode === 'override' ? ' accent' : '') }, t('company.mode.' + item.mode)),
        unsaved && h('span', { class: 'badge warn' }, t('company.unsaved')))),
    h('button', { class: 'btn icon-btn side-remove', title: removeTitle, onclick: () => run(onRemove) }, '✕'));
}
