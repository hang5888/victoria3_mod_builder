// World map of state regions, built in the browser from the game's provinces.png.
import { api } from './api.js';
import { t } from './i18n.js';
import { store, nameOf } from './store.js';
import { h } from './ui.js';

const SHRINK = 2;  // the map is handled at half the size of provinces.png
const SEA = [19, 30, 42];
const NO_STATE = [30, 36, 44];
const SELECTED = [222, 170, 68];

let mapPromise = null;

// Forget the processed map (after game data was reloaded with other mods).
export function resetMap() {
  mapPromise = null;
}

function loadMap() {
  if (!mapPromise) {
    mapPromise = buildMap().catch((error) => {
      mapPromise = null;
      throw error;
    });
  }
  return mapPromise;
}

function hash(text) {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
  return value >>> 0;
}

function hslToRgb(hue, saturation, lightness) {
  const a = saturation * Math.min(lightness, 1 - lightness);
  const f = (n) => {
    const k = (n + hue / 30) % 12;
    return Math.round(255 * (lightness - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

// States of one strategic region share a hue, so regions read as areas.
function stateColor(key, sea) {
  if (sea) return SEA;
  const state = store.index && store.index.states.get(key);
  const hue = hash((state && state.region) || key) % 360;
  return hslToRgb(hue, 0.24, 0.3 + (hash(key) % 9) / 100);
}

async function buildMap() {
  const [info, blob] = await Promise.all([
    api.get('/api/map'),
    fetch('/api/mapimage').then((response) => {
      if (!response.ok) throw new Error('map image not available');
      return response.blob();
    }),
  ]);
  // Province colours must arrive unchanged, so no colour management.
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const fullHeight = bitmap.height;  // map positions (locators) count from the bottom of the full map
  const width = Math.round(bitmap.width / SHRINK);
  const height = Math.round(bitmap.height / SHRINK);
  const layer = document.createElement('canvas');
  layer.width = width;
  layer.height = height;
  const ctx = layer.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const image = ctx.getImageData(0, 0, width, height);
  const pixels = image.data;

  const states = info.states;
  // provinces by colour: their number (from 1) and the state they are in
  const byColor = new Map();
  const provinceKeys = [];
  const provinceStates = [];
  states.forEach((state, i) => state.provinces.forEach((hex) => {
    byColor.set(parseInt(hex, 16), provinceKeys.length + 1);
    provinceKeys.push(hex);
    provinceStates.push(i);
  }));

  // Which province and state each pixel belongs to, plus each state's bounding box and centre.
  const index = new Int16Array(width * height);
  const provinces = new Uint16Array(width * height);  // 0: no province
  const box = states.map(() => [width, height, -1, -1]);
  const sums = states.map(() => [0, 0, 0]);
  let lastColor = -1;
  let lastState = -1;
  let lastProvince = 0;
  for (let y = 0, i = 0; y < height; y++) {
    for (let x = 0; x < width; x++, i++) {
      const color = (pixels[i * 4] << 16) | (pixels[i * 4 + 1] << 8) | pixels[i * 4 + 2];
      if (color !== lastColor) {
        lastColor = color;
        lastProvince = byColor.get(color) || 0;
        lastState = lastProvince ? provinceStates[lastProvince - 1] : -1;
      }
      index[i] = lastState;
      provinces[i] = lastProvince;
      if (lastState >= 0) {
        const b = box[lastState];
        if (x < b[0]) b[0] = x;
        if (y < b[1]) b[1] = y;
        if (x > b[2]) b[2] = x;
        if (y > b[3]) b[3] = y;
        const s = sums[lastState];
        s[0] += x;
        s[1] += y;
        s[2]++;
      }
    }
  }

  // Paint the states; pixels on a state border are drawn darker.
  const colors = states.map((state) => stateColor(state.key, state.sea));
  const border = new Uint8Array(width * height);
  for (let y = 0, i = 0; y < height; y++) {
    for (let x = 0; x < width; x++, i++) {
      const state = index[i];
      const edge = (x + 1 < width && index[i + 1] !== state) || (y + 1 < height && index[i + width] !== state);
      const land = state >= 0 && !states[state].sea;
      if (edge && land) border[i] = 1;
      const color = state < 0 ? NO_STATE : colors[state];
      const shade = border[i] ? 0.55 : 1;
      pixels[i * 4] = color[0] * shade;
      pixels[i * 4 + 1] = color[1] * shade;
      pixels[i * 4 + 2] = color[2] * shade;
      pixels[i * 4 + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);

  return {
    width, height, fullHeight, layer, ctx, index, border, colors, box, states, provinces, provinceKeys,
    provinceIndex: new Map(provinceKeys.map((hex, i) => [hex, i + 1])),
    keyIndex: new Map(states.map((state, i) => [state.key, i])),
    centers: sums.map((s) => (s[2] ? [s[0] / s[2], s[1] / s[2]] : null)),
    painted: new Map(),  // state index -> 'selected' | 'hover' | 'selected-hover'
  };
}

// Repaint one state in its normal, selected or hovered look.
function paintState(map, i, selected, hover) {
  const [x0, y0, x1, y1] = map.box[i];
  if (x1 < 0) return;
  const w = x1 - x0 + 1;
  const hgt = y1 - y0 + 1;
  const image = map.ctx.getImageData(x0, y0, w, hgt);
  const base = selected ? SELECTED : map.colors[i];
  const lift = hover ? 38 : 0;
  for (let y = 0; y < hgt; y++) {
    let at = (y0 + y) * map.width + x0;
    for (let x = 0; x < w; x++, at++) {
      if (map.index[at] !== i) continue;
      const shade = map.border[at] ? 0.55 : 1;
      const p = (y * w + x) * 4;
      image.data[p] = (base[0] + lift) * shade;
      image.data[p + 1] = (base[1] + lift) * shade;
      image.data[p + 2] = (base[2] + lift) * shade;
    }
  }
  map.ctx.putImageData(image, x0, y0);
}

// The map widget. `onToggle(stateKey)` is called when a land state is clicked; with `onPoint`,
// onPoint(stateKey, x, z) is called instead, with the game's map position of the click (as in
// map locators: x from the left, z from the bottom of the full map).
// `markerText(count, names)`: the tooltip line for the markers of a state.
export class StateMap {
  constructor({ onToggle, onPoint = null, markerText = null }) {
    this.onToggle = onToggle;
    this.onPoint = onPoint;
    this.markerText = markerText || ((count, names) => t('map.headquarters', { count, names }));
    this.points = [];          // [{x, z, current}] map positions drawn as pins
    this.selected = new Set();
    this.markers = new Map();  // state key -> names of companies headquartered there
    this.showMarkers = true;
    this.map = null;
    this.hover = -1;
    this.zoomed = false;
    this.scale = 1;            // screen pixels per map pixel
    this.x = 0;                // map position of the view's top-left corner
    this.y = 0;

    this.canvas = h('canvas', {});
    this.tip = h('div', { class: 'map-tip', hidden: true });
    this.message = h('div', { class: 'map-message' }, t('map.loading'));
    this.el = h('div', { class: 'map' },
      this.canvas, this.tip, this.message,
      h('div', { class: 'map-controls' },
        h('button', { class: 'btn icon-btn', title: t('map.zoom_in'), onclick: () => this.zoom(1.5) }, '+'),
        h('button', { class: 'btn icon-btn', title: t('map.zoom_out'), onclick: () => this.zoom(1 / 1.5) }, '−'),
        h('button', { class: 'btn icon-btn', title: t('map.reset'), onclick: () => this.fit() }, '⟲')));
    this.bind();
    new ResizeObserver(() => this.resize()).observe(this.el);
    loadMap().then((map) => {
      this.map = map;
      this.message.hidden = true;
      this.fit();
      this.ready();
    }).catch((error) => {
      console.error(error);
      this.message.textContent = t('map.failed');
    });
  }

  // The map is loaded: paint it.
  ready() {
    this.repaintAll();
  }

  // Bring the shared map picture in line with this widget's selection.
  repaintAll() {
    const map = this.map;
    if (!map) return;
    const wanted = new Map();
    for (const key of this.selected) {
      const i = map.keyIndex.get(key);
      if (i !== undefined) wanted.set(i, 'selected');
    }
    if (this.hover >= 0) wanted.set(this.hover, wanted.has(this.hover) ? 'selected-hover' : 'hover');
    for (const i of new Set([...map.painted.keys(), ...wanted.keys()])) {
      const look = wanted.get(i);
      if (map.painted.get(i) === look) continue;
      paintState(map, i, !!look && look.startsWith('selected'), !!look && look.endsWith('hover'));
      if (look) map.painted.set(i, look);
      else map.painted.delete(i);
    }
    this.draw();
  }

  setSelected(keys) {
    this.selected = new Set(keys);
    this.repaintAll();
  }

  setMarkers(markers) {
    this.markers = markers;
    this.draw();
  }

  setPoints(points) {
    this.points = points;
    this.draw();
  }

  resize() {
    const ratio = window.devicePixelRatio || 1;
    const width = this.el.clientWidth;
    const height = this.el.clientHeight;
    if (!width || !height) return;
    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(height * ratio);
    if (!this.map) return this.draw();
    if (this.zoomed) {
      this.scale = Math.max(this.scale, this.minScale());
      this.clamp();
      this.draw();
    } else {
      this.fit();
    }
  }

  minScale() {
    return this.map ? this.el.clientWidth / this.map.width : 1;
  }

  fit() {
    if (!this.map || !this.el.clientWidth) return;  // not on the page yet; resize() fits it later
    this.scale = this.minScale();
    this.zoomed = false;
    this.x = 0;
    this.y = 0;
    this.clamp();
    this.draw();
  }

  clamp() {
    const map = this.map;
    const viewW = this.el.clientWidth / this.scale;
    const viewH = this.el.clientHeight / this.scale;
    this.x = viewW >= map.width ? (map.width - viewW) / 2 : Math.max(0, Math.min(this.x, map.width - viewW));
    this.y = viewH >= map.height ? (map.height - viewH) / 2 : Math.max(0, Math.min(this.y, map.height - viewH));
  }

  // Zoom keeping the point under (px, py) in place; defaults to the centre.
  zoom(factor, px = this.el.clientWidth / 2, py = this.el.clientHeight / 2) {
    if (!this.map) return;
    const scale = Math.max(this.minScale(), Math.min(this.scale * factor, 6));
    const mapX = this.x + px / this.scale;
    const mapY = this.y + py / this.scale;
    this.scale = scale;
    this.zoomed = scale > this.minScale();
    this.x = mapX - px / scale;
    this.y = mapY - py / scale;
    this.clamp();
    this.draw();
  }

  stateAt(px, py) {
    const at = this.pixelAt(px, py);
    return at === null ? -1 : this.map.index[at];
  }

  bind() {
    const canvas = this.canvas;
    let drag = null;
    const position = (event) => {
      const rect = canvas.getBoundingClientRect();
      return [event.clientX - rect.left, event.clientY - rect.top];
    };
    canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      const [px, py] = position(event);
      this.zoom(event.deltaY < 0 ? 1.25 : 0.8, px, py);
    }, { passive: false });
    canvas.addEventListener('pointerdown', (event) => {
      if (!this.map || event.button !== 0) return;
      canvas.setPointerCapture(event.pointerId);
      drag = { startX: event.clientX, startY: event.clientY, x: this.x, y: this.y, moved: false };
    });
    canvas.addEventListener('pointermove', (event) => {
      if (!this.map) return;
      if (drag) {
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
        if (drag.moved) {
          this.x = drag.x - dx / this.scale;
          this.y = drag.y - dy / this.scale;
          this.clamp();
          this.draw();
          this.tip.hidden = true;
          return;
        }
      }
      const [px, py] = position(event);
      this.hoverAt(px, py);
    });
    canvas.addEventListener('pointerup', (event) => {
      if (!this.map || !drag) return;
      const moved = drag.moved;
      drag = null;
      if (moved) return;
      const [px, py] = position(event);
      this.clickAt(px, py);
    });
    canvas.addEventListener('pointercancel', () => { drag = null; });
    canvas.addEventListener('pointerleave', () => this.hoverAt(-1, -1));
  }

  // Position on the map (half the size of provinces.png) under a point of the widget, or null.
  pixelAt(px, py) {
    const map = this.map;
    const x = Math.floor(this.x + px / this.scale);
    const y = Math.floor(this.y + py / this.scale);
    if (px < 0 || x < 0 || y < 0 || x >= map.width || y >= map.height) return null;
    return y * map.width + x;
  }

  hoverAt(px, py) {
    this.setHover(px < 0 ? -1 : this.stateAt(px, py), px, py);
  }

  clickAt(px, py) {
    const state = this.stateAt(px, py);
    if (state < 0 || this.map.states[state].sea) return;
    const key = this.map.states[state].key;
    if (!this.onPoint) return this.onToggle(key);
    const x = (this.x + px / this.scale) * SHRINK;
    const y = (this.y + py / this.scale) * SHRINK;
    this.onPoint(key, Math.round(x * 100) / 100, Math.round((this.map.fullHeight - y) * 100) / 100);
  }

  showTip(lines, px, py) {
    this.tip.replaceChildren(...lines);
    this.tip.hidden = false;
    const flip = px > this.el.clientWidth * 0.6;
    this.tip.style.left = flip ? '' : `${px + 14}px`;
    this.tip.style.right = flip ? `${this.el.clientWidth - px + 14}px` : '';
    this.tip.style.top = `${Math.min(py + 14, this.el.clientHeight - 70)}px`;
  }

  setHover(state, px, py) {
    const map = this.map;
    if (state >= 0 && map.states[state].sea) state = -1;
    if (state !== this.hover) {
      this.hover = state;
      this.repaintAll();
    }
    if (state < 0) {
      this.tip.hidden = true;
      return;
    }
    const key = map.states[state].key;
    const info = store.index && store.index.states.get(key);
    const companies = this.markers.get(key) || [];
    const lines = [h('b', {}, nameOf('states', key))];
    if (info && info.region) lines.push(h('span', { class: 'muted' }, nameOf('regions', info.region)));
    if (companies.length) {
      const shown = companies.slice(0, 6).join(', ') + (companies.length > 6 ? ` +${companies.length - 6}` : '');
      lines.push(h('span', {}, this.markerText(companies.length, shown)));
    }
    this.showTip(lines, px, py);
  }

  draw() {
    const map = this.map;
    const canvas = this.canvas;
    const ctx = canvas.getContext('2d');
    const ratio = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = `rgb(${SEA.join(',')})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!map) return;
    const scale = this.scale * ratio;
    ctx.imageSmoothingEnabled = scale < 1;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.layer || map.layer, -this.x * scale, -this.y * scale, map.width * scale, map.height * scale);

    const dot = (key, radius, fill) => {
      const center = map.centers[map.keyIndex.get(key)];
      if (!center) return;
      ctx.beginPath();
      ctx.arc((center[0] - this.x) * scale, (center[1] - this.y) * scale, radius * ratio, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.lineWidth = ratio;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
      ctx.stroke();
    };
    if (this.showMarkers) {
      for (const [key, companies] of this.markers) {
        dot(key, 2 + Math.min(companies.length, 8) * 0.45, 'rgba(126, 200, 255, 0.9)');
      }
    }
    for (const key of this.selected) dot(key, 4.5, '#fff3d0');
    // pins at map positions; the current one last, so it is on top
    for (const point of [...this.points].sort((a, b) => Number(a.current) - Number(b.current))) {
      const sx = (point.x / SHRINK - this.x) * scale;
      const sy = ((map.fullHeight - point.z) / SHRINK - this.y) * scale;
      const size = (point.current ? 7 : 3.5) * ratio;
      ctx.beginPath();
      ctx.moveTo(sx, sy - size);
      ctx.lineTo(sx + size, sy);
      ctx.lineTo(sx, sy + size);
      ctx.lineTo(sx - size, sy);
      ctx.closePath();
      ctx.fillStyle = point.current ? '#d9a94a' : 'rgba(255, 255, 255, 0.85)';
      ctx.fill();
      ctx.lineWidth = ratio * (point.current ? 1.5 : 1);
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
      ctx.stroke();
    }
  }
}

const UNOWNED = [62, 66, 72];
const NO_COLOR = [120, 120, 120];

const dim = (color) => color.map((value) => Math.round(value * 0.3 + 34));

// The world as it starts: every province in the colour of the country that owns it.
// setOwners(owners: Map province -> tag, colors: Map tag -> [r, g, b], focus) paints it. Without a focus,
// onPick(tag) is called when a country is clicked. With focus {tag, state}, the other countries are
// dimmed, the state is marked, the view goes to the country, and onState(stateKey) is called when a
// state is clicked.
export class CountryMap extends StateMap {
  constructor({ onPick = () => {}, onState = null }) {
    super({ onToggle: () => {} });
    this.onPick = onPick;
    this.onState = onState;
    this.owners = null;
    this.colors = null;
    this.focus = null;
    this.layer = null;          // this widget's own picture: the shared one shows the states
    this.provinceOwner = null;  // province number -> number of its owner in ownerTags (0: nobody)
    this.ownerTags = [];
    this.zoomedTo = null;       // the country the view went to
    this.pendingZoom = null;    // where to go once the widget is on the page
  }

  setOwners(owners, colors, focus = null) {
    this.owners = owners;
    this.colors = colors;
    this.focus = focus;
    if (this.map) this.paint();
  }

  ready() {
    this.paint();
  }

  resize() {
    super.resize();
    if (this.pendingZoom && this.map && this.el.clientWidth) {
      this.zoomTo(this.pendingZoom);
      this.pendingZoom = null;
    }
  }

  // Show a box of the map ([x0, y0, x1, y1] in map pixels) with some room around it.
  zoomTo([x0, y0, x1, y1]) {
    const width = this.el.clientWidth;
    const height = this.el.clientHeight;
    const scale = Math.max(this.minScale(), Math.min(width / (Math.max(x1 - x0, 30) * 1.8),
      height / (Math.max(y1 - y0, 20) * 1.8), 6));
    this.scale = scale;
    this.zoomed = scale > this.minScale();
    this.x = (x0 + x1) / 2 - width / scale / 2;
    this.y = (y0 + y1) / 2 - height / scale / 2;
    this.clamp();
    this.draw();
  }

  paint() {
    const map = this.map;
    if (!map || !this.owners) return;
    const tags = [];
    const numbers = new Map();
    const owner = new Uint16Array(map.provinceKeys.length + 1);
    map.provinceKeys.forEach((hex, i) => {
      const tag = this.owners.get(hex);
      if (!tag) return;
      if (!numbers.has(tag)) numbers.set(tag, tags.push(tag));
      owner[i + 1] = numbers.get(tag);
    });
    this.provinceOwner = owner;
    this.ownerTags = tags;
    const focus = this.focus;
    const focusNumber = focus ? numbers.get(focus.tag) || -1 : 0;
    const marked = focus && focus.state ? map.keyIndex.get(focus.state) : undefined;
    const palette = tags.map((tag) => {
      const color = this.colors.get(tag) || NO_COLOR;
      return focus && tag !== focus.tag ? dim(color) : color;
    });
    const unowned = focus ? dim(UNOWNED) : UNOWNED;
    // Where the focused country is, near the marked state (the capital): colonies far away would
    // otherwise make the view the whole world.
    const box = [map.width, map.height, -1, -1];
    const markedBox = marked !== undefined && map.box[marked][2] >= 0 ? map.box[marked] : null;
    const near = markedBox ? [(markedBox[0] + markedBox[2]) / 2 - 300, (markedBox[1] + markedBox[3]) / 2 - 180,
      (markedBox[0] + markedBox[2]) / 2 + 300, (markedBox[1] + markedBox[3]) / 2 + 180] : null;
    if (!this.layer) {
      this.layer = h('canvas', { width: map.width, height: map.height });
    }
    const ctx = this.layer.getContext('2d');
    const image = ctx.createImageData(map.width, map.height);
    const pixels = image.data;
    const { width, height, provinces, index, states } = map;
    for (let y = 0, i = 0; y < height; y++) {
      for (let x = 0; x < width; x++, i++) {
        const state = index[i];
        let color = NO_STATE;
        let shade = 1;
        if (state >= 0 && states[state].sea) {
          color = SEA;
        } else if (state >= 0) {
          const mine = owner[provinces[i]];
          color = state === marked ? SELECTED : mine ? palette[mine - 1] : unowned;
          if (mine === focusNumber && (!near || (x >= near[0] && x <= near[2] && y >= near[1] && y <= near[3]))) {
            if (x < box[0]) box[0] = x;
            if (y < box[1]) box[1] = y;
            if (x > box[2]) box[2] = x;
            if (y > box[3]) box[3] = y;
          }
          // country borders dark, state borders inside a country lighter
          const right = x + 1 < width ? i + 1 : -1;
          const below = y + 1 < height ? i + width : -1;
          for (const next of [right, below]) {
            if (next < 0 || index[next] < 0) continue;
            if (owner[provinces[next]] !== mine && !states[index[next]].sea) shade = Math.min(shade, 0.45);
            else if (index[next] !== state) shade = Math.min(shade, 0.78);
          }
        }
        const p = i * 4;
        pixels[p] = color[0] * shade;
        pixels[p + 1] = color[1] * shade;
        pixels[p + 2] = color[2] * shade;
        pixels[p + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    const target = box[2] >= 0 ? box : markedBox;  // a capital away from the country's land: the capital
    if (focus && focus.tag !== this.zoomedTo && target) {
      this.zoomedTo = focus.tag;
      if (this.el.clientWidth) this.zoomTo(target);
      else this.pendingZoom = target;  // resize() goes there once the widget is shown
    }
    this.draw();
  }

  // The country and state under a point: {tag, state} (tag '' for land nobody owns), or null.
  placeAt(px, py) {
    const at = px < 0 ? null : this.pixelAt(px, py);
    if (at === null || !this.provinceOwner) return null;
    const state = this.map.index[at];
    if (state < 0 || this.map.states[state].sea) return null;
    const mine = this.provinceOwner[this.map.provinces[at]];
    return { tag: mine ? this.ownerTags[mine - 1] : '', state: this.map.states[state].key };
  }

  hoverAt(px, py) {
    const place = this.placeAt(px, py);
    if (!place) {
      this.tip.hidden = true;
      return;
    }
    this.showTip([
      h('b', {}, place.tag ? `${nameOf('countries', place.tag)} (${place.tag})` : t('map.unowned')),
      h('span', { class: 'muted' }, nameOf('states', place.state)),
    ], px, py);
  }

  clickAt(px, py) {
    const place = this.placeAt(px, py);
    if (!place) return;
    if (this.onState) this.onState(place.state);
    else if (place.tag) this.onPick(place.tag);
  }
}
