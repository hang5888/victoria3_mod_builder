// Text of the tool's own interface. English is the fallback for every other language.

const loaded = {};
let strings = {};
let fallback = {};

async function load(name) {
  if (!loaded[name]) loaded[name] = await (await fetch(`i18n/${name}.json`)).json();
  return loaded[name];
}

// The interface is translated to English and Simplified Chinese; other game
// languages get the English interface.
export async function setUiLanguage(gameLanguage) {
  const name = gameLanguage === 'simp_chinese' ? 'zh-hans' : 'en';
  fallback = await load('en');
  strings = await load(name);
  document.documentElement.lang = name === 'zh-hans' ? 'zh-Hans' : 'en';
  applyI18n(document);
}

export function t(key, vars) {
  let text = strings[key] ?? fallback[key] ?? key;
  for (const [name, value] of Object.entries(vars || {})) text = text.replaceAll(`{${name}}`, value);
  return text;
}

export function applyI18n(root) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
}
