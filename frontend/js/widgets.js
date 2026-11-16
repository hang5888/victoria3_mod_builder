// Pieces shared by the editor pages: form parts, chips and source tags.
import { api, textureUrl } from './api.js';
import { t } from './i18n.js';
import { store, nameOf, setProject } from './store.js';
import { h, toast, errorText, openPicker, confirmDialog, imageDialog } from './ui.js';
import { thumb, objectIcon, pickerIcon } from './icons.js';
import { bracesBalanced } from './script.js';

// Run an action of a button; failures are shown instead of lost.
export async function run(action) {
  try {
    await action();
  } catch (error) {
    console.error(error);
    toast(errorText(error), 'error');
  }
}

export function section(title, hint, ...children) {
  return h('section', { class: 'card' }, h('h3', {}, title), hint && h('p', { class: 'muted' }, hint), children);
}

export function field(label, control, hint) {
  return h('label', { class: 'field' },
    h('span', { class: 'field-label' }, label), control, hint && h('span', { class: 'muted small' }, hint));
}

export function sourceName(id) {
  if (id === 'game') return t('company.source_game');
  const source = store.index.sources.get(id);
  return source ? source.name : id;
}

// A tag for every source that defines or changes the item; none for a base game only item.
// The last one is in effect and is the strong one.
export function sourceBadges(item) {
  if (item.sources.length === 1 && item.source === 'game') return null;
  const last = item.sources[item.sources.length - 1];
  return h('span', { class: 'badges' }, item.sources.map((id) => h('span', {
    class: 'badge source' + (id === last ? '' : ' faded'),
    title: id === last && item.sources.length > 1 ? t('company.source_active', { source: sourceName(id) }) : sourceName(id),
  }, sourceName(id))));
}

// A modifier's value as the game shows it (percent or plain), and whether it is good or bad.
export function formatModifier(modifier) {
  const info = store.index.modifiers.get(modifier.key);
  const value = Number(modifier.value);
  if (modifier.value === '' || Number.isNaN(value)) return { text: modifier.value, tone: '' };
  const sign = value > 0 ? '+' : '';
  const text = info && info.percent ? `${sign}${Math.round(value * 10000) / 100}%` : `${sign}${value}`;
  let tone = '';
  if (info && info.color !== 'neutral' && value !== 0) {
    tone = (value > 0) === (info.color === 'good') ? 'good' : 'bad';
  }
  return { text, tone };
}

export function objectChip(kind, key, ...extra) {
  return h('span', { class: 'chip', title: key }, objectIcon(kind, key), nameOf(kind, key), extra);
}

// A script text box. get() -> text, set(text) stores it, onChange() runs after every edit.
export function scriptArea(get, set, onChange) {
  const area = h('textarea', {
    class: 'input mono script', spellcheck: false, value: get(),
    rows: Math.min(16, Math.max(2, get().split('\n').length + 1)),
    oninput: () => {
      set(area.value);
      area.classList.toggle('invalid', !bracesBalanced(area.value));
      onChange();
    },
    onkeydown: (event) => {
      if (event.key !== 'Tab' || event.shiftKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      area.setRangeText('\t', area.selectionStart, area.selectionEnd, 'end');
      area.dispatchEvent(new Event('input'));
    },
  });
  area.classList.toggle('invalid', !bracesBalanced(area.value));
  return area;
}

// The size the game uses for each kind of image, and how a picture of another shape is fitted
// (same as IMAGE_KINDS in backend/project.py).
const IMAGE_SIZES = {
  company_icon: [256, 256, 'contain'],
  company_background: [1027, 496, 'cover'],
  building_icon: [256, 256, 'contain'],
  building_background: [652, 256, 'cover'],
  pmg_icon: [120, 120, 'contain'],
  pm_icon: [104, 104, 'contain'],
  law_icon: [302, 302, 'contain'],
};

function readBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^[^,]*,/, ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// Turn a picture file into a PNG of the game's size for this kind, after the user saw it.
// DDS files are kept as they are. Resolves to the image's game path, or null when cancelled.
async function importImage(kind, file) {
  const [width, height, fit] = IMAGE_SIZES[kind];
  const size = `${width}×${height}`;
  let data;
  if (/\.dds$/i.test(file.name)) {
    if (!(await confirmDialog(t('image.dds_note', { size }), t('image.import_confirm')))) return null;
    data = await readBase64(file);
  } else {
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      toast(t('error.image_format'), 'error');
      return null;
    }
    const canvas = h('canvas', { width, height });
    const context = canvas.getContext('2d');
    context.imageSmoothingQuality = 'high';
    const scale = (fit === 'cover' ? Math.max : Math.min)(width / bitmap.width, height / bitmap.height);
    const w = bitmap.width * scale;
    const hgt = bitmap.height * scale;
    context.drawImage(bitmap, (width - w) / 2, (height - hgt) / 2, w, hgt);
    const src = canvas.toDataURL('image/png');
    const ok = await imageDialog({
      title: t('image.preview_title'), src, wide: fit === 'cover', confirmLabel: t('image.import_confirm'),
      lines: [`${file.name}：${bitmap.width}×${bitmap.height} → ${size}`,
        fit === 'cover' ? t('image.fit_cover', { size }) : t('image.fit_contain', { size }), t('image.packed_note')],
    });
    if (!ok) return null;
    data = src.replace(/^[^,]*,/, '');
  }
  const result = await api.post('/api/project/image', { kind, name: file.name, data });
  setProject(result.project);
  return result.image.path;
}

// An image path with a thumbnail, a picker over the given paths, and (with a `kind`) an import
// button for a picture of the user's own. onChange(path) stores it and redraws.
export function imageField({ label, value, paths, wide = false, kind = null, onChange }) {
  const input = h('input', {
    class: 'input mono', type: 'text', spellcheck: false, value,
    onchange: () => onChange(input.value.trim()),
  });
  // images imported into this mod come first
  const imported = ((store.project && store.project.images) || []).filter((image) => image.kind === kind)
    .map((image) => image.path);
  const mine = new Set(imported);
  const choose = () => openPicker({
    title: label, multi: false, wide, selected: value ? [value] : [],
    items: [...imported, ...paths.filter((path) => !mine.has(path))].map((path) => ({
      key: path,
      name: (mine.has(path) ? `${t('image.imported')} · ` : '') + path.split('/').pop().replace(/\.\w+$/, ''),
    })),
    thumb: (item) => textureUrl(item.key, wide ? 320 : 128),
    onDone: ([path]) => onChange(path),
  });
  const upload = () => {
    const file = h('input', { type: 'file', accept: 'image/*,.dds' });
    file.addEventListener('change', () => run(async () => {
      if (!file.files.length) return;
      const path = await importImage(kind, file.files[0]);
      if (path) onChange(path);
    }));
    file.click();
  };
  return h('div', { class: 'image-field' + (wide ? ' wide' : '') },
    thumb(value, wide ? 320 : 128, 'image-thumb'),
    h('div', { class: 'grow' },
      h('span', { class: 'field-label' }, label, mine.has(value) && h('span', { class: 'badge accent' }, t('image.imported'))),
      input,
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: choose }, t('common.choose')),
        kind && h('button', { class: 'btn', title: t('image.import_hint'), onclick: upload }, t('image.import')))));
}

// Game objects of a kind as picker items.
export function pickerItems(kind) {
  return store.data[kind].filter((item) => !item.sea).map((item) => ({
    key: item.key, name: item.name || item.key, used: item.used,
    sub: item.group_name || item.good_name || (item.era && t('cond.era', { n: item.era }))
      || (item.region && nameOf('regions', item.region)) || item.key,
  }));
}

// A list of chosen game objects shown as removable chips, with a picker to add more.
// onChange(keys) stores the new list and redraws.
export function keyChips({ keys, kind, label, hint, toggle, onChange }) {
  const pick = () => openPicker({
    title: label, selected: keys, toggle, icon: pickerIcon(kind), items: pickerItems(kind), onDone: onChange,
  });
  return h('div', { class: 'chip-field' },
    h('div', { class: 'row' },
      h('span', { class: 'field-label' }, label),
      h('button', { class: 'btn', onclick: pick }, t('common.choose'))),
    hint && h('p', { class: 'muted small' }, hint),
    h('div', { class: 'chips' }, keys.map((key) =>
      objectChip(kind, key,
        h('button', { class: 'chip-remove', title: t('common.remove'),
          onclick: () => onChange(keys.filter((k) => k !== key)) }, '✕'))),
    keys.length === 0 && h('span', { class: 'muted' }, t('common.none'))));
}
