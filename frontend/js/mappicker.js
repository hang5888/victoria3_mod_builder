// A window with the world map to choose state regions, strategic regions or geographic regions.
import { t } from './i18n.js';
import { store, nameOf } from './store.js';
import { h, debounce, openModal } from './ui.js';
import { StateMap, CountryMap } from './map.js';

export const MAP_KINDS = new Set(['states', 'regions', 'geographic_regions']);

const RESULTS = 60;  // search results shown at a time

function landStates() {
  return store.data.states.filter((state) => !state.sea);
}

// The state regions of a strategic region.
function regionStates(region) {
  return landStates().filter((state) => state.region === region).map((state) => state.key);
}

// The state regions of a geographic region: its own and those of its strategic regions.
function geographicStates(key) {
  const region = store.index.geographic_regions.get(key);
  if (!region) return [];
  const regions = new Set(region.regions || []);
  return [...new Set([...(region.states || []),
    ...landStates().filter((state) => regions.has(state.region)).map((state) => state.key)])];
}

// What the map shows as chosen for some chosen keys of a kind.
function statesOf(kind, keys) {
  if (kind === 'regions') return keys.flatMap(regionStates);
  if (kind === 'geographic_regions') return keys.flatMap(geographicStates);
  return keys;
}

// Opens the window.
//   kind:     'states' | 'regions' | 'geographic_regions'
//   selected: keys chosen so far; multi: allow several
//   onDone(keys, point): called with the chosen keys (and, with `position`, the point placed: {x, z},
//             or null when no point was placed in the window)
//   markers:  optional Map state -> names, drawn as dots (markerText(count, names) is their tooltip line);
//             markersLabel: a checkbox to show them
//   position: optional {current: {x, z} | null, others: [{x, z}]}: clicking the map also places a point
//             in the state (as the model of a monument); only one state is chosen then
//   country:  optional {owners, colors, focus(keys)}: the map in the colours of the countries (see CountryMap)
//   first:    optional {keys: Set, label}: states listed first when nothing is searched, as the country's own
export function openMapPicker({ kind = 'states', title, selected = [], multi = true, onDone,
  markers = null, markerText = null, markersLabel = null, position = null, country = null, first = null }) {
  const chosen = new Set(selected.filter(Boolean));
  if (position) multi = false;
  let point = position ? position.current : null;
  let placed = false;  // a point was placed in this window
  let query = '';
  let within = '';  // geographic regions: only those with this state

  const regionOf = (state) => (store.index.states.get(state) || {}).region || '';
  const onClick = (state, x, z) => clickState(state, x, z);
  const map = country
    ? new CountryMap({ onState: (state) => onClick(state) })
    : new StateMap({
      onToggle: (state) => onClick(state),
      onPoint: position ? (state, x, z) => onClick(state, x, z) : null,
      markerText, groupOf: kind === 'regions' ? regionOf : null,
    });
  map.selectedDots = kind === 'states';
  if (markers) {
    map.showMarkers = true;
    map.setMarkers(markers);
  } else if (kind === 'geographic_regions') {
    // the tooltip names the geographic regions a state is in
    const inside = new Map();
    for (const region of store.data.geographic_regions) {
      for (const state of geographicStates(region.key)) {
        if (!inside.has(state)) inside.set(state, []);
        inside.get(state).push(region.name || region.key);
      }
    }
    map.markerText = (count, names) => t('mappicker.inside', { count, names });
    map.showMarkers = false;
    map.setMarkers(inside);
  }

  const results = h('div', { class: 'map-picker-results' });
  const chosenList = h('div', { class: 'map-picker-chosen' });
  const doneButton = h('button', { class: 'btn primary', onclick: () => finish() });

  function finish() {
    close();
    onDone([...chosen], placed ? point : null);
  }

  function choose(key) {
    if (!key) return;
    if (position) {  // a state from the list: no point in it yet
      point = null;
      placed = false;
    }
    if (!multi) {
      chosen.clear();
      chosen.add(key);
    } else if (chosen.has(key)) {
      chosen.delete(key);
    } else {
      chosen.add(key);
    }
    update();
  }

  function clickState(state, x, z) {
    if (kind === 'geographic_regions') {
      within = within === state ? '' : state;
      renderResults();
      return;
    }
    if (position) {
      chosen.clear();
      chosen.add(state);
      point = { x, z };
      placed = true;
      return update();
    }
    choose(kind === 'regions' ? regionOf(state) : state);
  }

  function paint() {
    const keys = [...chosen];
    if (country) map.setOwners(country.owners, country.colors, country.focus(keys));
    else map.setSelected(statesOf(kind, keys));
    if (position) {
      map.setPoints([...(position.others || []).map((other) => ({ x: other.x, z: other.z, current: false })),
        ...(point && chosen.size ? [{ ...point, current: true }] : [])]);
    }
  }

  function goTo(key) {
    map.zoomToStates(statesOf(kind, [key]));
  }

  function row(key, sub, { removable = false } = {}) {
    const name = nameOf(kind, key);
    return h('div', { class: 'map-picker-row' + (chosen.has(key) && !removable ? ' selected' : '') },
      h('button', {
        class: 'map-picker-name', title: key,
        onclick: () => {
          if (!removable) choose(key);
          goTo(key);
        },
      }, h('span', {}, name), sub && h('span', { class: 'muted small' }, sub)),
      removable && multi && h('button', { class: 'chip-remove', title: t('common.remove'),
        onclick: () => { chosen.delete(key); update(); } }, '✕'));
  }

  function subOf(key) {
    if (kind === 'states') {
      const own = first && first.keys.has(key) ? first.label : '';
      return [own, regionOf(key) && nameOf('regions', regionOf(key))].filter(Boolean).join(' · ');
    }
    if (kind === 'regions') return t('mappicker.state_count', { count: regionStates(key).length });
    return '';
  }

  function renderResults() {
    const q = query.trim().toLowerCase();
    const items = kind === 'states' ? landStates() : store.data[kind];
    let keys;
    if (kind === 'geographic_regions') {
      keys = items.filter((item) => !within || geographicStates(item.key).includes(within)).map((item) => item.key);
    } else if (!q) {
      keys = first ? [...first.keys] : [];
    } else {
      keys = items.map((item) => item.key);
    }
    if (q) keys = keys.filter((key) => `${nameOf(kind, key)} ${key}`.toLowerCase().includes(q));
    results.replaceChildren(
      within && h('div', { class: 'row map-picker-within' },
        h('span', { class: 'muted small grow' }, t('mappicker.within', { name: nameOf('states', within) })),
        h('button', { class: 'btn small', onclick: () => { within = ''; renderResults(); } }, t('mappicker.show_all'))),
      !keys.length && h('p', { class: 'muted small' }, q ? t('mappicker.no_results') : t('mappicker.hint.' + kind)),
      keys.slice(0, RESULTS).map((key) => row(key, subOf(key))),
      keys.length > RESULTS && h('p', { class: 'muted small' }, t('mappicker.more', { count: keys.length - RESULTS })));
  }

  function update() {
    paint();
    renderResults();
    chosenList.replaceChildren(
      h('div', { class: 'field-label' }, t('mappicker.chosen', { count: chosen.size })),
      chosen.size === 0 && h('span', { class: 'muted small' }, t('common.none')),
      [...chosen].map((key) => row(key, subOf(key), { removable: true })),
      position && chosen.size > 0 && h('div', { class: 'muted small' }, point
        ? t('monument.position_at', { x: Math.round(point.x), z: Math.round(point.z) }) : t('mappicker.no_point')));
    doneButton.textContent = multi ? t('picker.done', { count: chosen.size }) : t('mappicker.done');
  }

  const search = h('input', {
    type: 'search', class: 'input', placeholder: t('common.search'),
    oninput: debounce(() => { query = search.value; renderResults(); }, 120),
  });
  const modal = h('div', { class: 'modal map-picker' },
    h('div', { class: 'modal-header' },
      h('h3', {}, title),
      h('button', { class: 'btn icon-btn', title: t('common.close'), onclick: () => close() }, '✕')),
    h('div', { class: 'map-picker-body' },
      map.el,
      h('div', { class: 'map-picker-side' },
        search,
        markersLabel && h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: map.showMarkers, onchange: (event) => {
            map.showMarkers = event.target.checked;
            map.draw();
          } }),
          markersLabel),
        results,
        chosenList)),
    h('div', { class: 'modal-footer' },
      h('span', { class: 'muted small grow' }, t('mappicker.click.' + (position ? 'position' : kind))),
      h('button', { class: 'btn', onclick: () => close() }, t('common.cancel')), doneButton));
  const close = openModal(modal);
  update();
  if (!country && chosen.size) map.zoomToStates(statesOf(kind, [...chosen]));
  search.focus();
}
