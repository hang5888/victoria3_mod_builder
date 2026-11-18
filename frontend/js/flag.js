// Flags of new countries (see backend/flags.py): drawing one from its coat of arms, and the editor.
//
// A flag is a pattern tinted with three colours, then emblems on it: single-colour emblems tinted with
// their own three colours, then pictures. The browser composes it as the game does:
//   pattern       colour1, towards colour2 by the green channel, towards colour3 by the blue channel
//   colored       colour1, towards colour2 by green, towards colour3 by red; blue shades it (half: none);
//                 alpha is where it is
//   textured      drawn as it is
import { textureUrl } from './api.js';
import { t } from './i18n.js';
import { store } from './store.js';
import { h, openPicker } from './ui.js';
import { field, importImage, run } from './widgets.js';

export const PATTERN_DIR = 'gfx/coat_of_arms/patterns';
export const COLORED_DIR = 'gfx/coat_of_arms/colored_emblems';
export const TEXTURED_DIR = 'gfx/coat_of_arms/textured_emblems';
const SIZE = 256;  // the size textures are loaded at

const images = new Map();  // url -> Promise<HTMLImageElement | null>
const tinted = new Map();  // texture + colours -> canvas

function loadImage(path) {
  const url = textureUrl(path, SIZE);
  if (!images.has(url)) {
    images.set(url, new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    }));
  }
  return images.get(url);
}

export function defaultFlag(color) {
  return { pattern: 'pattern_solid.tga', colors: [nearestColor(color) || 'white', 'white', 'red'], emblems: [] };
}

// The coat of arms colours: [{key, rgb, coa}].
function colorList() {
  return (store.coa && store.coa.colors) || [];
}

function rgbOf(name) {
  const found = colorList().find((color) => color.key === name);
  return found ? found.rgb : [128, 128, 128];
}

// The coat of arms colour nearest to a country colour.
export function nearestColor(rgb) {
  if (!rgb) return null;
  let best = null;
  let distance = Infinity;
  for (const color of colorList().filter((c) => c.coa)) {
    const d = color.rgb.reduce((sum, value, i) => sum + (value - rgb[i]) ** 2, 0);
    if (d < distance) { distance = d; best = color.key; }
  }
  return best;
}

const mix = (a, b, w) => a + (b - a) * w;
const overlay = (base, shade) => (shade < 0.5 ? 2 * base * shade : 1 - 2 * (1 - base) * (1 - shade));

function pixelsOf(img, width, height) {
  const canvas = h('canvas', { width, height });
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(img, 0, 0, width, height);
  return { canvas, context, data: context.getImageData(0, 0, width, height) };
}

function tintEmblem(img, texture, colors) {
  const key = texture + '|' + colors.join(',');
  if (tinted.has(key)) return tinted.get(key);
  const { canvas, context, data } = pixelsOf(img, img.naturalWidth, img.naturalHeight);
  const [c1, c2, c3] = colors.map(rgbOf);
  const d = data.data;
  for (let i = 0; i < d.length; i += 4) {
    const g = d[i + 1] / 255;
    const r = d[i] / 255;
    const shade = d[i + 2] / 255;
    for (let c = 0; c < 3; c++) {
      const value = mix(mix(c1[c], c2[c], g), c3[c], r) / 255;
      d[i + c] = Math.round(255 * Math.min(1, Math.max(0, overlay(value, shade))));
    }
  }
  context.putImageData(data, 0, 0);
  tinted.set(key, canvas);
  return canvas;
}

// Draw a flag on a canvas (any size, 3:2). For one canvas, a later call wins over an earlier one still loading.
export async function drawFlag(canvas, flag) {
  canvas.flagTicket = (canvas.flagTicket || 0) + 1;
  const ticket = canvas.flagTicket;
  const width = canvas.width;
  const height = canvas.height;
  const context = canvas.getContext('2d');
  if (!flag) {
    context.clearRect(0, 0, width, height);
    return;
  }
  const ordered = [...flag.emblems.filter((e) => e.kind === 'colored'), ...flag.emblems.filter((e) => e.kind === 'textured')];
  const [pattern, ...emblems] = await Promise.all([
    loadImage(`${PATTERN_DIR}/${flag.pattern}`),
    ...ordered.map((e) => loadImage(`${e.kind === 'colored' ? COLORED_DIR : TEXTURED_DIR}/${e.texture}`)),
  ]);
  if (ticket !== canvas.flagTicket) return;
  const [c1, c2, c3] = flag.colors.map(rgbOf);
  const out = context.createImageData(width, height);
  const source = pattern ? pixelsOf(pattern, width, height).data.data : null;
  for (let i = 0; i < out.data.length; i += 4) {
    const g = source ? source[i + 1] / 255 : 0;
    const b = source ? source[i + 2] / 255 : 0;
    for (let c = 0; c < 3; c++) out.data[i + c] = Math.round(mix(mix(c1[c], c2[c], g), c3[c], b));
    out.data[i + 3] = 255;
  }
  context.putImageData(out, 0, 0);
  ordered.forEach((emblem, i) => {
    const img = emblems[i];
    if (!img) return;
    const picture = emblem.kind === 'colored' ? tintEmblem(img, emblem.texture, emblem.colors) : img;
    context.save();
    context.translate(emblem.x * width, emblem.y * height);
    context.rotate((emblem.rotation * Math.PI) / 180);
    context.scale(Math.sign(emblem.sx) || 1, Math.sign(emblem.sy) || 1);
    const w = Math.abs(emblem.sx) * width;
    const hgt = Math.abs(emblem.sy) * height;
    context.drawImage(picture, -w / 2, -hgt / 2, w, hgt);
    context.restore();
  });
}

// A canvas with the flag drawn on it.
export function flagCanvas(flag, width, className) {
  const canvas = h('canvas', { class: className, width, height: Math.round((width * 2) / 3) });
  drawFlag(canvas, flag);
  return canvas;
}

// ------------------------------------------------------------------ editor

function colorSelect(value, onChange) {
  const swatch = h('span', { class: 'country-swatch', style: `background:rgb(${rgbOf(value).join(',')})` });
  const select = h('select', { class: 'input', onchange: () => {
    swatch.style.background = `rgb(${rgbOf(select.value).join(',')})`;
    onChange(select.value);
  } }, colorList().filter((c) => c.coa || c.key === value).map((c) => h('option', { value: c.key }, c.key)));
  select.value = value;
  return h('span', { class: 'row flag-color' }, swatch, select);
}

function pickTexture(title, folder, files, onPick, extra = []) {
  openPicker({
    title, multi: false, wide: false,
    items: [...extra, ...files.map((file) => ({ key: file, name: file.replace(/\.\w+$/, '') }))],
    thumb: (item) => textureUrl(`${folder}/${item.key}`, 128),
    onDone: ([key]) => { if (key) onPick(key); },
  });
}

// The flag editor: `get()` the flag, `set(flag)` stores it (a new object each time), `redraw()` the section.
export function flagEditor({ get, set, redraw }) {
  const flag = get();
  const preview = flagCanvas(flag, 384, 'flag-preview');
  const update = (change, full = false) => {
    Object.assign(flag, change);
    set(flag);
    if (full) redraw();
    else drawFlag(preview, flag);
  };
  const coa = store.coa;
  const imported = ((store.project && store.project.images) || []).filter((image) => image.kind === 'coa_emblem');
  const importedItems = imported.map((image) => ({ key: image.file, name: `${t('image.imported')} · ${image.file}` }));
  const addEmblem = (kind, texture) => update({ emblems: [...flag.emblems, {
    kind, texture, x: 0.5, y: 0.5, sx: kind === 'colored' ? 0.5 : 1, sy: kind === 'colored' ? 0.5 : 1, rotation: 0,
    ...(kind === 'colored' ? { colors: [flag.colors[1] || 'white', flag.colors[2] || 'red', 'yellow'] } : {}),
  }] }, true);
  const upload = () => {
    const file = h('input', { type: 'file', accept: 'image/*,.dds' });
    file.addEventListener('change', () => run(async () => {
      if (!file.files.length) return;
      const path = await importImage('coa_emblem', file.files[0]);
      if (path) addEmblem('textured', path.split('/').pop());
    }));
    file.click();
  };
  const emblemRows = flag.emblems.map((emblem, index) => {
    const edit = (change, full = false) => {
      Object.assign(emblem, change);
      update({ emblems: flag.emblems }, full);
    };
    const number = (name, step, low, high) => {
      const input = h('input', { class: 'input flag-number', type: 'number', step, min: low, max: high,
        value: String(emblem[name]), title: t('flag.' + name),
        oninput: () => {
          const value = Number(input.value);
          const ok = input.value !== '' && value >= low && value <= high;
          input.classList.toggle('invalid', !ok);
          if (ok) edit({ [name]: value });
        } });
      return h('label', { class: 'check small' }, t('flag.' + name), input);
    };
    const move = (to) => {
      const list = [...flag.emblems];
      list.splice(index, 1);
      list.splice(to, 0, emblem);
      update({ emblems: list }, true);
    };
    const folder = emblem.kind === 'colored' ? COLORED_DIR : TEXTURED_DIR;
    return h('div', { class: 'territory-building' },
      h('div', { class: 'row' },
        h('img', { class: 'flag-thumb', src: textureUrl(`${folder}/${emblem.texture}`, 64), alt: '' }),
        h('span', { class: 'badge' }, t('flag.kind.' + emblem.kind)),
        h('button', { class: 'btn small', onclick: () => (emblem.kind === 'colored'
          ? pickTexture(t('flag.kind.colored'), COLORED_DIR, coa.colored, (key) => edit({ texture: key }, true))
          : pickTexture(t('flag.kind.textured'), TEXTURED_DIR, coa.textured, (key) => edit({ texture: key }, true), importedItems)) },
        emblem.texture.replace(/\.\w+$/, '')),
        h('span', { class: 'grow' }),
        index > 0 && h('button', { class: 'btn icon-btn', title: t('flag.up'), onclick: () => move(index - 1) }, '↑'),
        index < flag.emblems.length - 1 && h('button', { class: 'btn icon-btn', title: t('flag.down'), onclick: () => move(index + 1) }, '↓'),
        h('button', { class: 'btn icon-btn', title: t('common.remove'),
          onclick: () => update({ emblems: flag.emblems.filter((e) => e !== emblem) }, true) }, '✕')),
      emblem.kind === 'colored' && h('div', { class: 'row territory-owner' },
        emblem.colors.map((color, i) => colorSelect(color, (value) => {
          const colors = [...emblem.colors];
          colors[i] = value;
          edit({ colors });
        }))),
      h('div', { class: 'row territory-owner' },
        number('x', 0.01, -1, 2), number('y', 0.01, -1, 2), number('sx', 0.05, -2, 2), number('sy', 0.05, -2, 2),
        number('rotation', 5, -360, 360),
        h('button', { class: 'btn small', title: t('flag.mirror_hint'), onclick: () => edit({ sx: -emblem.sx }, true) }, t('flag.mirror'))));
  });
  return h('div', { class: 'flag-editor' },
    h('div', { class: 'row flag-top' },
      preview,
      h('div', { class: 'grow flag-base' },
        field(t('flag.pattern'), h('button', { class: 'btn', onclick: () => pickTexture(t('flag.pattern'), PATTERN_DIR,
          coa.patterns, (key) => update({ pattern: key }, true)) }, flag.pattern.replace(/\.\w+$/, ''))),
        flag.colors.map((color, i) => field(t('flag.color', { n: i + 1 }), colorSelect(color, (value) => {
          const colors = [...flag.colors];
          colors[i] = value;
          update({ colors });
        }))))),
    h('p', { class: 'muted small' }, t('flag.order_hint')),
    h('div', { class: 'territory-items' }, emblemRows),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: () => pickTexture(t('flag.kind.colored'), COLORED_DIR, coa.colored,
        (key) => addEmblem('colored', key)) }, t('flag.add_colored')),
      h('button', { class: 'btn', onclick: () => pickTexture(t('flag.kind.textured'), TEXTURED_DIR, coa.textured,
        (key) => addEmblem('textured', key), importedItems) }, t('flag.add_textured')),
      h('button', { class: 'btn', title: t('flag.import_hint'), onclick: upload }, t('flag.import'))));
}
