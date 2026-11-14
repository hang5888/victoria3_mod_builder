// Game images shown next to names.
import { textureUrl } from './api.js';
import { iconOf } from './store.js';
import { h } from './ui.js';

// Kinds of game objects that have their own small icon.
export const ICON_KINDS = new Set(['buildings', 'prestige_goods', 'technologies']);
const ICON_SIZE = 64;

export function thumb(path, size, className) {
  if (!path) return h('div', { class: `${className} empty` });
  return h('img', { class: className, loading: 'lazy', alt: '', src: textureUrl(path, size),
    onerror: (event) => event.target.classList.add('broken') });
}

// The object's small icon, or null when it has none.
export function objectIcon(kind, key) {
  const path = iconOf(kind, key);
  return path ? thumb(path, ICON_SIZE, 'chip-icon') : null;
}

// Icon option for openPicker; null for kinds without icons.
export function pickerIcon(kind) {
  if (!ICON_KINDS.has(kind)) return null;
  return (item) => {
    const path = iconOf(kind, item.key);
    return path ? textureUrl(path, ICON_SIZE) : '';
  };
}
