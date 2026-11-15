// Sidebar of the editor pages: everything the mod changes, grouped by kind, with the save
// and open folder buttons.
//
// The editor page passes itself in as
//   { kind, state() -> {key, dirty, editing}, open(item), remove(item), discard(), save() }
// where `key` is the key of the opened item in the project (null for a new one) and
// `editing` is the item as it is being edited.
import { api } from './api.js';
import { t } from './i18n.js';
import { store, companyName, factoryName, setProject } from './store.js';
import { h, fill, toast } from './ui.js';
import { thumb } from './icons.js';
import { run } from './widgets.js';

// What a mod can contain, in the order shown. The kind is also the name of its editor page.
const KINDS = {
  company: { items: (project) => project.companies, name: companyName, icon: (item) => item.icon },
  factory: { items: (project) => project.factories || [], name: factoryName, icon: (item) => item.icon },
};

// Collapsed categories, and '' when the whole sidebar is collapsed.
const STORAGE_KEY = 'vmb.sidebar.collapsed';
const SIDEBAR = '';
const collapsed = loadCollapsed();
let container = null;
let editor = null;
let pending = null;  // an item of another page that was clicked: {kind, key}

// The key of the item the page of this kind should open, when the user came for one.
export function takePending(kind) {
  if (!pending || pending.kind !== kind) return null;
  const { key } = pending;
  pending = null;
  return key;
}

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

export function renderSidebar(element, activeEditor) {
  container = element;
  editor = activeEditor;
  refreshSidebar();
}

// Redraw after the project, the opened item or its unsaved state changed.
export function refreshSidebar() {
  if (!container || !store.project) return;
  const state = editor.state();
  const hidden = collapsed.has(SIDEBAR);
  container.classList.toggle('collapsed', hidden);
  if (container.parentElement) container.parentElement.classList.toggle('sidebar-collapsed', hidden);
  if (hidden) {
    // A thin strip; anywhere on it opens the sidebar again.
    fill(container, h('button', { class: 'side-strip', title: t('sidebar.show'), onclick: () => toggle(SIDEBAR) },
      h('span', { class: 'side-toggle' }, '»'),
      h('span', { class: 'side-strip-title' }, t('sidebar.title')),
      state.dirty && h('span', { class: 'side-dot', title: t('company.unsaved') })));
    return;
  }
  fill(container,
    h('div', { class: 'col-head' }, h('h2', {}, t('sidebar.title')),
      h('button', { class: 'btn icon-btn side-toggle', title: t('sidebar.hide'), onclick: () => toggle(SIDEBAR) }, '«')),
    h('div', { class: 'muted small', title: store.state.project ? store.state.project.dir : '' }, store.project.name),
    Object.entries(KINDS).map(([kind, def]) => group(kind, def, state)),
    h('div', { class: 'actions sidebar-actions' },
      h('button', { class: 'btn primary', onclick: () => run(save) }, t('sidebar.save')),
      h('button', { class: 'btn', onclick: () => run(() => api.post('/api/project/open_folder', {})) },
        t('sidebar.open_folder'))));
}

// Save the item being edited; with nothing changed, write the mod's files again from the project.
async function save() {
  if (editor.state().dirty) return editor.save();
  const result = await api.post('/api/project/save', {});
  setProject(result.project);
  refreshSidebar();
  toast(t('company.saved', { dir: result.dir }));
}

function group(kind, def, state) {
  const active = editor.kind === kind;
  const items = def.items(store.project);
  const rows = items.map((item) => {
    const current = active && item.key === state.key;
    return row(def, current ? state.editing : item, {
      current,
      unsaved: current && state.dirty,
      // items of other kinds are edited on their own page
      onOpen: current ? null : active ? () => editor.open(item) : () => {
        pending = { kind, key: item.key };
        location.hash = '#/' + kind;
      },
      onRemove: active ? () => editor.remove(item) : null,
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
    onRemove && h('button', { class: 'btn icon-btn side-remove', title: removeTitle, onclick: () => run(onRemove) }, '✕'));
}
