// Choosing game objects: the picker with the filters of each kind, or the map for regions.
import { t } from './i18n.js';
import { store, nameOf } from './store.js';
import { openPicker } from './ui.js';
import { pickerIcon } from './icons.js';
import { MAP_KINDS, openMapPicker } from './mappicker.js';

// The tabs of the game's technology screen.
const TECH_CATEGORIES = ['production', 'military', 'society'];

// Game objects of a kind as picker items (`raw`: the object itself, for the filters).
export function pickerItems(kind) {
  return store.data[kind].filter((item) => !item.sea).map((item) => ({
    key: item.key, name: item.name || item.key, used: item.used, raw: item,
    sub: item.group_name || item.good_name || (item.era && t('cond.era', { n: item.era }))
      || (item.region && nameOf('regions', item.region)) || item.key,
  }));
}

// A drop-down filter over what valueOf(raw object) gives (a value or a list); none when there is
// nothing to tell apart.
function filterOf(label, items, valueOf, textOf) {
  const values = (item) => [].concat(valueOf(item.raw || {}) || []).filter(Boolean);
  const texts = new Map();
  for (const item of items) {
    for (const value of values(item)) if (!texts.has(value)) texts.set(value, textOf(value) || value);
  }
  if (texts.size < 2) return null;
  return {
    label,
    options: [...texts].sort((a, b) => a[1].localeCompare(b[1])),
    test: (item, value) => values(item).includes(value),
  };
}

// The buildings each production method is used in.
function pmBuildings() {
  const found = new Map();
  for (const factory of store.data.factories) {
    for (const entry of factory.pmgs || []) {
      const pmg = entry.type === 'ref' ? store.index.pmgs.get(entry.key) : entry;
      for (const pm of (pmg && pmg.pms) || []) {
        if (!found.has(pm.key)) found.set(pm.key, []);
        found.get(pm.key).push(factory.key);
      }
    }
  }
  return found;
}

const groupName = (key) => nameOf('building_groups', key);

// The filters, tabs and sections of the picker for a kind.
export function pickerOptions(kind, items) {
  switch (kind) {
    case 'buildings': {
      // by industry: the top building groups, in the game's order
      const order = store.data.building_groups.filter((group) => !group.parent).map((group) => group.key);
      return {
        filters: [filterOf(t('picker.filter.industry'), items, (b) => b.group, groupName)].filter(Boolean),
        groups: { of: (item) => item.raw.group || '', order,
          label: (key) => (key ? groupName(key) : t('picker.no_group')), remember: 'building_industries' },
      };
    }
    case 'technologies': {
      const categoryOf = (item) => (TECH_CATEGORIES.includes(item.raw.category) ? item.raw.category : '');
      const eras = [...new Set(items.map((item) => Number(item.raw.era) || 0))]
        .sort((a, b) => (a || Infinity) - (b || Infinity)).map(String);
      return {
        tabs: [...TECH_CATEGORIES, ''].map((category) => ({
          key: category, label: t('picker.tech.' + (category || 'other')), test: (item) => categoryOf(item) === category })),
        groups: { of: (item) => String(Number(item.raw.era) || 0), order: eras,
          label: (key) => (key !== '0' ? t('cond.era', { n: key }) : t('picker.no_era')), remember: 'tech_eras' },
      };
    }
    case 'countries':
      return { filters: [
        filterOf(t('picker.filter.country_type'), items, (c) => c.country_type, (v) => {
          const country = store.data.countries.find((c) => c.country_type === v);
          return (country && country.type_name) || v;
        }),
        filterOf(t('picker.filter.tier'), items, (c) => c.tier, (v) => {
          const country = store.data.countries.find((c) => c.tier === v);
          return (country && country.tier_name) || v;
        }),
        filterOf(t('picker.filter.region'), items, (c) => c.region, (v) => nameOf('regions', v)),
      ].filter(Boolean) };
    case 'cultures': {
      const named = (field) => (value) => {
        const culture = store.data.cultures.find((c) => c[field] === value);
        return (culture && culture[field + '_name']) || value;
      };
      return { filters: [
        filterOf(t('picker.filter.heritage'), items, (c) => c.heritage, named('heritage')),
        filterOf(t('picker.filter.language'), items, (c) => c.language, named('language')),
      ].filter(Boolean) };
    }
    case 'goods':
      return { filters: [filterOf(t('picker.filter.goods_category'), items, (g) => g.category,
        (v) => { const text = t('picker.goods.' + v); return text === 'picker.goods.' + v ? v : text; })].filter(Boolean) };
    case 'laws':
      return { filters: [filterOf(t('picker.filter.law_group'), items, (law) => law.group,
        (v) => nameOf('law_groups', v))].filter(Boolean) };
    case 'companies':
      return { filters: [filterOf(t('picker.filter.company_category'), items,
        (c) => c.category || '-', (v) => (v === '-' ? store.data.default_category_name : nameOf('categories', v)))].filter(Boolean) };
    case 'pms': {
      const users = pmBuildings();
      return { filters: [filterOf(t('picker.filter.building'), items, (pm) => users.get(pm.key) || [],
        (v) => nameOf('factories', v))].filter(Boolean) };
    }
    default:
      return {};
  }
}

// Choose objects of a kind: regions on the map (`map`: what else the map window takes, see
// openMapPicker), the rest in the picker with the kind's filters. onDone(keys) gets the chosen keys.
//   items: optional picker items to choose from instead of every object of the kind
export function chooseObjects({ kind, title, selected = [], multi = true, toggle = null, items = null, map = {}, onDone }) {
  if (MAP_KINDS.has(kind)) {
    return openMapPicker({ kind, title, selected, multi, onDone, ...map });
  }
  const list = items || pickerItems(kind);
  return openPicker({ title, selected, multi, toggle, icon: pickerIcon(kind), items: list,
    ...pickerOptions(kind, list), onDone });
}
