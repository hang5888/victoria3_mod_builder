// The territory, pops and buildings tabs of a country start (see backend/territory.py).
//
// What the country owns and what its parts of the states have comes from the server (it works out
// how pops and buildings move with the land); the start keeps only the changes:
//   gains / releases   provinces taken / own provinces given up to nobody
//   state_types        {state: incorporated | unincorporated}
//   homelands          {state: {add, remove}}, claims {add, remove}
//   pops / buildings   {state: [items]}: the whole list of a part, once the user changed it
// The page passes in what these tabs need as `ctx` (see territoryBuilders).
import { t } from './i18n.js';
import { store, nameOf } from './store.js';
import { h } from './ui.js';
import { thumb } from './icons.js';
import { section, objectChip } from './widgets.js';
import { chooseObjects } from './choose.js';
import { CountryMap } from './map.js';

let ctx = null;
let mode = 'province';      // what a click on the territory map does: province, state or claim
let territoryMap = null;
const openParts = new Set();  // states unfolded on the pops and buildings tabs

const without = (list, item) => list.filter((x) => x !== item);

// ctx: { start(), game(), cdata, parts(), owners(), colors(), capital(), changed(resolve), refresh(name) }
export function territoryBuilders(context) {
  ctx = context;
  return { territory: territorySection, parts: partsSection, claims: claimsSection, pops: popsSection,
    buildings: buildingsSection };
}

// Forget the map (after the game data was loaded again).
export function resetTerritoryMap() {
  territoryMap = null;
}

// ---------------------------------------------------------------- territory

function claimedStates() {
  const start = ctx.start();
  const claimed = new Set(Object.entries(ctx.cdata.claims).filter(([, tags]) => tags.includes(start.key))
    .map(([state]) => state));
  for (const state of start.claims.remove) claimed.delete(state);
  for (const state of start.claims.add) claimed.add(state);
  return claimed;
}

function take(province) {
  const start = ctx.start();
  start.releases = without(start.releases, province);
  if (!start.gains.includes(province)) start.gains.push(province);
}

function release(province) {
  const start = ctx.start();
  if (start.gains.includes(province)) start.gains = without(start.gains, province);
  else if (!start.releases.includes(province)) start.releases.push(province);
}

function toggleClaim(state) {
  const claims = ctx.start().claims;
  if (claimedStates().has(state)) {
    if (claims.add.includes(state)) claims.add = without(claims.add, state);
    else claims.remove.push(state);
  } else if (claims.remove.includes(state)) {
    claims.remove = without(claims.remove, state);
  } else {
    claims.add.push(state);
  }
}

function clickMap(state, province) {
  const tag = ctx.start().key;
  if (mode === 'claim') {
    toggleClaim(state);
    ctx.changed(true);
    ctx.refresh('claims');
    return;
  }
  const owners = ctx.owners();
  const provinces = mode === 'state' ? territoryMap.provincesOf(state) : [province].filter(Boolean);
  if (!provinces.length) return;
  const all = provinces.every((p) => owners.get(p) === tag);
  for (const p of provinces) {
    if (all) release(p);
    else if (owners.get(p) !== tag) take(p);
  }
  ctx.changed(true);
}

// Paint the territory map from the current owners (after the server worked them out).
function paintTerritory() {
  if (!territoryMap || !ctx || !ctx.start()) return;
  territoryMap.setOwners(ctx.owners(), ctx.colors(),
    { tag: ctx.start().key, state: ctx.capital(), claims: [...claimedStates()] });
}

function territorySection() {
  const start = ctx.start();
  if (!territoryMap) territoryMap = new CountryMap({ onState: (state, province) => clickMap(state, province) });
  paintTerritory();
  const modes = ['province', 'state', 'claim'].map((name) => h('button', {
    class: 'btn small' + (mode === name ? ' selected' : ''), title: t('territory.mode_hint.' + name),
    onclick: () => { mode = name; ctx.refresh('territory'); },
  }, t('territory.mode.' + name)));
  const changedCount = start.gains.length + start.releases.length;
  return section(t('territory.title'), t('territory.hint'),
    h('div', { class: 'row' }, h('span', { class: 'field-label' }, t('territory.click')), modes,
      h('span', { class: 'grow' }),
      changedCount > 0 && h('span', { class: 'muted small' },
        t('territory.changed', { gains: start.gains.length, releases: start.releases.length })),
      changedCount > 0 && h('button', { class: 'btn small', title: t('country.reset_hint'), onclick: () => {
        start.gains = [];
        start.releases = [];
        ctx.changed(true);
      } }, t('country.reset'))),
    h('p', { class: 'muted small' }, t('territory.mode_hint.' + mode)),
    territoryMap.el);
}

// Homelands of a state as they are with this start's changes.
function homelandsOf(state) {
  const change = ctx.start().homelands[state] || { add: [], remove: [] };
  const base = (ctx.cdata.homelands[state] || []).filter((c) => !change.remove.includes(c));
  return [...base, ...change.add.filter((c) => !base.includes(c))];
}

function setHomelands(state, cultures) {
  const base = ctx.cdata.homelands[state] || [];
  const change = { add: cultures.filter((c) => !base.includes(c)), remove: base.filter((c) => !cultures.includes(c)) };
  if (change.add.length || change.remove.length) ctx.start().homelands[state] = change;
  else delete ctx.start().homelands[state];
  ctx.changed(false);
  ctx.refresh('parts');
}

function baseShare(state) {
  return (ctx.cdata.shares[state] || []).find(([tag]) => tag === ctx.start().key) || null;
}

function partsSection() {
  const start = ctx.start();
  const parts = ctx.parts();
  if (!parts) return section(t('territory.parts'), null, h('p', { class: 'muted' }, t('territory.working')));
  const gained = new Set(start.gains);
  const rows = parts.map((part) => {
    const share = baseShare(part.state);
    const unincorporated = h('input', { type: 'checkbox', checked: part.unincorporated, onchange: (event) => {
      const value = event.target.checked ? 'unincorporated' : 'incorporated';
      if (share && share[2] === event.target.checked) delete start.state_types[part.state];
      else start.state_types[part.state] = value;
      ctx.changed(true);
    } });
    const homelands = homelandsOf(part.state);
    const addHomeland = () => chooseObjects({
      kind: 'cultures', title: t('territory.homelands'), selected: homelands,
      onDone: (keys) => setHomelands(part.state, keys),
    });
    const taken = part.provinces.filter((p) => gained.has(p)).length;
    return h('div', { class: 'territory-part' },
      h('div', { class: 'row' },
        h('b', {}, nameOf('states', part.state)),
        h('span', { class: 'company-key' }, part.state),
        h('span', { class: 'muted small' }, t('territory.provinces', { count: part.provinces.length, total: part.total })),
        !share && h('span', { class: 'badge accent' }, t('territory.new_part')),
        share && taken > 0 && h('span', { class: 'badge accent' }, t('territory.taken', { count: taken })),
        h('span', { class: 'grow' }),
        h('label', { class: 'check', title: t('territory.unincorporated_hint') }, unincorporated, t('territory.unincorporated')),
        h('button', { class: 'btn small', title: t('territory.release_hint'), onclick: () => {
          for (const p of part.provinces) release(p);
          ctx.changed(true);
        } }, t('territory.release'))),
      h('div', { class: 'chips' },
        h('span', { class: 'muted small' }, t('territory.homelands')),
        homelands.map((culture) => objectChip('cultures', culture,
          h('button', { class: 'chip-remove', title: t('common.remove'),
            onclick: () => setHomelands(part.state, without(homelands, culture)) }, '✕'))),
        h('button', { class: 'btn small', onclick: addHomeland }, t('common.choose'))));
  });
  const lost = Object.entries(ctx.cdata.shares).filter(([state, shares]) =>
    shares.some(([tag]) => tag === start.key) && !parts.some((part) => part.state === state)).map(([state]) => state);
  return section(t('territory.parts'), t('territory.parts_hint', { count: parts.length }),
    rows.length ? rows : h('p', { class: 'notice warn' }, t('country.not_existing_hint')),
    lost.length > 0 && h('div', { class: 'chips' }, h('span', { class: 'muted small' }, t('territory.lost')),
      lost.map((state) => h('span', { class: 'chip', title: state }, nameOf('states', state)))));
}

function claimsSection() {
  const claims = [...claimedStates()].sort();
  const pick = () => chooseObjects({
    kind: 'states', title: t('territory.claims'), selected: claims,
    // the map in the countries' colours, the claims striped
    map: { country: { owners: ctx.owners(), colors: ctx.colors(),
      focus: (keys) => ({ tag: ctx.start().key, state: ctx.capital(), claims: keys }) } },
    onDone: (keys) => {
      for (const state of claims) if (!keys.includes(state)) toggleClaim(state);
      for (const state of keys) if (!claims.includes(state)) toggleClaim(state);
      ctx.changed(true);
      ctx.refresh('claims');
    },
  });
  return section(t('territory.claims'), t('territory.claims_hint'),
    h('div', { class: 'chips' },
      claims.map((state) => h('span', { class: 'chip', title: state }, nameOf('states', state),
        h('button', { class: 'chip-remove', title: t('common.remove'), onclick: () => {
          toggleClaim(state);
          ctx.changed(true);
          ctx.refresh('claims');
        } }, '✕'))),
      claims.length === 0 && h('span', { class: 'muted' }, t('common.none')),
      h('button', { class: 'btn small', onclick: pick }, t('common.choose'))));
}

// ---------------------------------------------------------------- pops

// The pops (or buildings) of a part: the mod's list, else what the part gets.
export function partItems(start, part, field) {
  return start[field][part.state] || part[field];
}

// The mod's own list of a part, made from what it has when first changed.
function ownList(part, field) {
  const start = ctx.start();
  if (!start[field][part.state]) start[field][part.state] = structuredClone(part[field]);
  return start[field][part.state];
}

function partCard(part, field, summary, body) {
  const start = ctx.start();
  const own = Boolean(start[field][part.state]);
  const details = h('details', { class: 'territory-part', open: openParts.has(field + part.state) },
    h('summary', {},
      h('b', {}, nameOf('states', part.state)), ' ',
      h('span', { class: 'muted small' }, summary),
      own && h('span', { class: 'badge accent' }, t('territory.own_list')),
      !own && part.moved && h('span', { class: 'badge', title: t('territory.moved_hint') }, t('territory.moved'))));
  let filled = false;
  const fillBody = () => {
    if (filled || !details.open) return;
    filled = true;
    details.append(...[body(), own && h('div', { class: 'row' },
      h('button', { class: 'btn small', title: t('territory.own_reset_hint'), onclick: () => {
        delete start[field][part.state];
        ctx.changed(false);
        ctx.refresh(field);
      } }, t('country.reset')))].filter(Boolean));
  };
  details.addEventListener('toggle', () => {
    if (details.open) openParts.add(field + part.state);
    else openParts.delete(field + part.state);
    fillBody();
  });
  fillBody();
  return details;
}

function popRow(part, pop, index) {
  const edit = (change) => {
    const list = ownList(part, 'pops');
    Object.assign(list[index], change);
    ctx.changed(false);
  };
  const culture = h('button', { class: 'btn small', onclick: () => chooseObjects({
    kind: 'cultures', title: t('territory.culture'), multi: false, selected: [pop.culture],
    onDone: ([key]) => { if (key) { edit({ culture: key }); ctx.refresh('pops'); } },
  }) }, nameOf('cultures', pop.culture));
  const religion = h('select', { class: 'input', onchange: () => edit({ religion: religion.value }) },
    h('option', { value: '' }, t('territory.religion_of_culture')),
    store.data.religions.map((r) => h('option', { value: r.key }, r.name || r.key)));
  religion.value = pop.religion;
  const type = h('select', { class: 'input', onchange: () => edit({ pop_type: type.value }) },
    h('option', { value: '' }, t('territory.pop_type_any')),
    store.data.pop_types.map((p) => h('option', { value: p.key }, p.name || p.key)));
  type.value = pop.pop_type;
  const size = h('input', { class: 'input territory-size', type: 'number', min: 0, step: 1, value: String(pop.size),
    oninput: () => {
      const value = Math.max(0, Math.round(Number(size.value) || 0));
      size.classList.toggle('invalid', size.value === '' || Number(size.value) < 0);
      edit({ size: value });
    } });
  return h('div', { class: 'row territory-line' }, culture, religion, type, size,
    h('button', { class: 'btn icon-btn', title: t('common.remove'), onclick: () => {
      const list = ownList(part, 'pops');
      list.splice(index, 1);
      ctx.changed(false);
      ctx.refresh('pops');
    } }, '✕'));
}

function popsSection() {
  const start = ctx.start();
  const parts = ctx.parts();
  if (!parts) return section(t('territory.pops'), null, h('p', { class: 'muted' }, t('territory.working')));
  const cards = parts.map((part) => {
    const pops = partItems(start, part, 'pops');
    const total = pops.reduce((sum, pop) => sum + pop.size, 0);
    return partCard(part, 'pops', t('territory.pops_summary', { count: pops.length, total: total.toLocaleString() }), () =>
      h('div', { class: 'territory-items' },
        pops.map((pop, i) => popRow(part, pop, i)),
        h('button', { class: 'btn small', onclick: () => chooseObjects({
          kind: 'cultures', title: t('territory.culture'), multi: false,
          onDone: ([culture]) => {
            if (!culture) return;
            ownList(part, 'pops').push({ culture, religion: '', pop_type: '', size: 10000, extra: '' });
            openParts.add('pops' + part.state);
            ctx.changed(false);
            ctx.refresh('pops');
          },
        }) }, t('territory.add_pop'))));
  });
  return section(t('territory.pops'), t('territory.pops_hint'), cards);
}

// ------------------------------------------------------------- buildings

const levelsOf = (building) => building.level + building.ownership.reduce((sum, o) => sum + o.levels, 0);

function countryButton(value, onPick) {
  return h('button', { class: 'btn small', onclick: () => chooseObjects({
    kind: 'countries', title: t('territory.owner_country'), multi: false, selected: [value],
    onDone: ([key]) => { if (key) onPick(key); },
  }) }, value ? `${nameOf('countries', value)} (${value})` : t('common.choose'));
}

function ownerRow(part, index, owner, ownerIndex) {
  const edit = (change, redraw = false) => {
    Object.assign(ownList(part, 'buildings')[index].ownership[ownerIndex], change);
    ctx.changed(false);
    if (redraw) ctx.refresh('buildings');
  };
  const kind = h('select', { class: 'input', onchange: () => edit({ kind: kind.value, type: '', region: '' }, true) },
    ['country', 'building', 'company'].map((k) => h('option', { value: k }, t('territory.owner.' + k))));
  kind.value = owner.kind;
  const levels = h('input', { class: 'input territory-levels', type: 'number', min: 1, step: 1, value: String(owner.levels),
    oninput: () => edit({ levels: Math.max(1, Math.round(Number(levels.value) || 1)) }) });
  const typeKind = owner.kind === 'company' ? 'companies' : 'buildings';
  const type = owner.kind !== 'country' && h('button', { class: 'btn small', onclick: () => chooseObjects({
    kind: typeKind, title: t('territory.owner.' + owner.kind), multi: false, selected: [owner.type],
    onDone: ([key]) => { if (key) edit({ type: key }, true); },
  }) }, owner.type ? nameOf(owner.kind === 'company' ? 'companies' : 'buildings', owner.type) : t('common.choose'));
  const region = owner.kind === 'building' && h('button', { class: 'btn small', onclick: () => chooseObjects({
    kind: 'states', title: t('territory.owner_region'), multi: false, selected: [owner.region],
    onDone: ([key]) => { if (key) edit({ region: key }, true); },
  }) }, owner.region ? nameOf('states', owner.region) : t('common.choose'));
  return h('div', { class: 'row territory-owner' }, kind, type,
    countryButton(owner.country, (key) => edit({ country: key }, true)), region, levels,
    h('button', { class: 'btn icon-btn', title: t('common.remove'), onclick: () => {
      ownList(part, 'buildings')[index].ownership.splice(ownerIndex, 1);
      ctx.changed(false);
      ctx.refresh('buildings');
    } }, '✕'));
}

// One select per production method group of the building.
function pmSelects(part, index, building) {
  const info = store.index.factories.get(building.building);
  const groups = info ? info.pmgs.map((pmg) => store.index.pmgs.get(pmg.key)).filter(Boolean) : [];
  return groups.map((group) => {
    const keys = group.pms.map((pm) => pm.key);
    const select = h('select', { class: 'input', title: group.name || group.key, onchange: () => {
      const list = ownList(part, 'buildings')[index];
      list.pms = [...list.pms.filter((pm) => !keys.includes(pm)), select.value].filter(Boolean);
      ctx.changed(false);
    } },
      h('option', { value: '' }, `${group.name || group.key}: ${t('territory.pm_default')}`),
      keys.map((key) => h('option', { value: key }, nameOf('pms', key))));
    select.value = building.pms.find((pm) => keys.includes(pm)) || '';
    return select;
  });
}

function buildingRow(part, building, index) {
  const edit = (change) => {
    Object.assign(ownList(part, 'buildings')[index], change);
    ctx.changed(false);
  };
  const reserves = h('input', { class: 'input territory-levels', type: 'number', min: 0, step: 1,
    value: building.reserves === null ? '' : String(building.reserves), placeholder: '—', title: t('territory.reserves'),
    oninput: () => edit({ reserves: reserves.value === '' ? null : Math.max(0, Math.round(Number(reserves.value) || 0)) }) });
  const level = h('input', { class: 'input territory-levels', type: 'number', min: 0, step: 1,
    value: String(building.level), title: t('territory.level_hint'),
    oninput: () => edit({ level: Math.max(0, Math.round(Number(level.value) || 0)) }) });
  return h('div', { class: 'territory-building' },
    h('div', { class: 'row' },
      thumb((store.index.buildings.get(building.building) || {}).icon || '', 64, 'law-icon'),
      h('span', { class: 'grow' }, h('b', {}, nameOf('buildings', building.building)), ' ',
        h('span', { class: 'company-key' }, building.building)),
      h('span', { class: 'muted small' }, t('territory.levels', { count: levelsOf(building) })),
      h('label', { class: 'check small' }, t('territory.reserves'), reserves),
      h('button', { class: 'btn icon-btn', title: t('common.remove'), onclick: () => {
        ownList(part, 'buildings').splice(index, 1);
        ctx.changed(false);
        ctx.refresh('buildings');
      } }, '✕')),
    building.ownership.map((owner, i) => ownerRow(part, index, owner, i)),
    h('div', { class: 'row territory-owner' },
      h('button', { class: 'btn small', onclick: () => {
        ownList(part, 'buildings')[index].ownership.push({ kind: 'country', country: ctx.start().key, type: '', region: '',
          levels: 1 });
        ctx.changed(false);
        ctx.refresh('buildings');
      } }, t('territory.add_owner')),
      (building.level > 0 || !building.ownership.length) && h('label', { class: 'check small' }, t('territory.level'), level)),
    h('div', { class: 'row territory-pms' }, pmSelects(part, index, building)));
}

function buildingsSection() {
  const start = ctx.start();
  const parts = ctx.parts();
  if (!parts) return section(t('territory.buildings'), null, h('p', { class: 'muted' }, t('territory.working')));
  const cards = parts.map((part) => {
    const buildings = partItems(start, part, 'buildings');
    const levels = buildings.reduce((sum, b) => sum + levelsOf(b), 0);
    return partCard(part, 'buildings', t('territory.buildings_summary', { count: buildings.length, levels }), () =>
      h('div', { class: 'territory-items' },
        buildings.map((building, i) => buildingRow(part, building, i)),
        h('button', { class: 'btn small', onclick: () => chooseObjects({
          kind: 'buildings', title: t('territory.add_building'), multi: false,
          onDone: ([key]) => {
            if (!key) return;
            ownList(part, 'buildings').push({ building: key, level: 0, reserves: 1, pms: [], subsidized: null, extra: '',
              ownership: [{ kind: 'country', country: start.key, type: '', region: '', levels: 1 }] });
            openParts.add('buildings' + part.state);
            ctx.changed(false);
            ctx.refresh('buildings');
          },
        }) }, t('territory.add_building'))));
  });
  return section(t('territory.buildings'), t('territory.buildings_hint'), cards);
}

// What a start's territory changes, for the preview's list of changes.
export function territoryChanges(start) {
  const parts = [];
  if (start.gains.length || start.releases.length) parts.push('territory');
  if (Object.keys(start.state_types).length) parts.push('state_types');
  if (Object.keys(start.homelands).length) parts.push('homelands');
  if (start.claims.add.length || start.claims.remove.length) parts.push('claims');
  if (Object.keys(start.pops).length) parts.push('pops');
  if (Object.keys(start.buildings).length) parts.push('buildings');
  return parts;
}
