// The diplomacy (with the treaties) and characters tabs of a country start (see backend/diplomacy.py and
// backend/characters.py). The start keeps:
//   diplomacy         null (as the game has it), or every statement the country is part of:
//                     [{kind, first, second, type, value}], kind pact / relations / truce / obligation /
//                     liberty_desire (first: the overlord, the one acting, the one owing)
//   treaties_added    new treaties: [{names, first, second, date, years, articles: [{article, source,
//                     target, inputs}]}]
//   treaties_removed  ids of the game's treaties to take out
//   characters        null, or the whole list: [{template, extra, new}] (new: the fields of a new one)
// The page passes in what these tabs need as `ctx` (see relationBuilders).
import { t } from './i18n.js';
import { store, nameOf, language, languageName } from './store.js';
import { h } from './ui.js';
import { section, field, objectChip, scriptArea } from './widgets.js';
import { chooseObjects } from './choose.js';

const DATE_PATTERN = /^\d{1,4}\.\d{1,2}\.\d{1,2}$/;
const KINDS = ['pact', 'relations', 'truce', 'obligation'];
const TRAIT_KINDS = ['personality', 'skill', 'condition'];
const ROLES = ['ruler', 'heir', 'ig_leader', 'politician', 'general', 'admiral', 'agitator'];
const INPUT_KINDS = { goods: 'goods', law_type: 'laws', strategic_region: 'regions', company: 'companies',
  building_type: 'buildings', country: 'countries', state: 'states' };

let ctx = null;
let shown = [];       // the diplomacy statements on the page (copies): edits work on these
let shownChars = [];  // the characters on the page (copies)
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const involves = (item, tag) => item.first === tag || item.second === tag;

// ctx: { start(), game(), cdata, others() (the other saved starts), vanished(), cultures(), changed(), refresh(name) }
export function relationBuilders(context) {
  ctx = context;
  return { diplomacy: diplomacySection, treaties: treatiesSection, characters: charactersSection };
}

function countryButton(value, onPick, title = t('relations.partner')) {
  return h('button', { class: 'btn small', title: value, onclick: () => chooseObjects({
    kind: 'countries', title, multi: false, selected: value ? [value] : [],
    onDone: ([key]) => { if (key && key !== ctx.start().key) onPick(key); },
  }) }, value ? `${nameOf('countries', value)} (${value})` : t('common.choose'));
}

function vanishedBadge(tag) {
  return ctx.vanished().includes(tag)
    && h('span', { class: 'badge warn', title: t('relations.vanished_hint') }, t('country.not_existing'));
}

function numberInput(value, low, high, onInput, className = 'input territory-levels') {
  const input = h('input', { class: className, type: 'number', min: low, max: high, step: 1, value: String(value),
    oninput: () => {
      const n = Math.round(Number(input.value));
      const ok = input.value !== '' && n >= low && n <= high;
      input.classList.toggle('invalid', !ok);
      if (ok) onInput(n);
    } });
  return input;
}

function selectOf(options, value, onChange, empty) {
  const el = h('select', { class: 'input', onchange: () => onChange(el.value) },
    empty !== undefined && h('option', { value: '' }, empty),
    options.map(([key, text]) => h('option', { value: key }, text)));
  el.value = value;
  return el;
}

function resetButton(changedNow, reset) {
  return changedNow && h('button', { class: 'btn small', title: t('country.reset_hint'), onclick: reset }, t('country.reset'));
}

// ---------------------------------------------------------------- diplomacy

function baseItems() {
  return ctx.cdata.diplomacy.map(([kind, first, second, type, value]) => ({ kind, first, second, type, value }));
}

// The statements of the country without its own list: the game's, with the other starts' lists.
function gameList() {
  const tag = ctx.start().key;
  let items = baseItems();
  for (const other of ctx.others()) {
    if (!other.diplomacy) continue;
    items = [...items.filter((item) => !involves(item, other.key)), ...other.diplomacy];
  }
  return items.filter((item) => involves(item, tag));
}

function diplomacyList() {
  const start = ctx.start();
  return structuredClone(start.diplomacy || gameList());
}

// Store a list (a copy of it); `redraw`: draw the section again.
function setList(list, redraw = true) {
  const start = ctx.start();
  start.diplomacy = same(list, gameList()) ? null : structuredClone(list);
  ctx.changed();
  if (redraw) ctx.refresh('diplomacy');
}

function editItem(item, change) {
  setList(shown.map((other) => (other === item ? { ...other, ...change } : other)));
}

function removeItem(item) {
  setList(shown.filter((other) => other !== item));
}

const pactType = (key) => ctx.cdata.pact_types.find((pact) => pact.key === key);

function pactRow(item) {
  const tag = ctx.start().key;
  const mine = item.first === tag;
  const partner = mine ? item.second : item.first;
  const subject = Boolean((pactType(item.type) || {}).subject);
  const role = subject ? (mine ? 'overlord' : 'subject') : (mine ? 'actor' : 'target');
  return h('div', { class: 'row country-line' },
    h('span', { class: 'badge', title: t('relations.role_hint.' + role) }, t('relations.role.' + role)),
    countryButton(partner, (key) => editItem(item, mine ? { second: key } : { first: key })),
    vanishedBadge(partner),
    selectOf(ctx.cdata.pact_types.map((pact) => [pact.key, pact.name || pact.key]), item.type,
      (value) => editItem(item, { type: value })),
    h('button', { class: 'btn small', title: t('relations.swap_hint'),
      onclick: () => editItem(item, { first: item.second, second: item.first }) }, '⇄'),
    h('span', { class: 'grow' }),
    h('button', { class: 'btn icon-btn', title: t('common.remove'), onclick: () => removeItem(item) }, '✕'));
}

function valueRow(item, low, high, unit) {
  const tag = ctx.start().key;
  const partner = item.first === tag ? item.second : item.first;
  return h('div', { class: 'row country-line' },
    countryButton(partner, (key) => editItem(item, item.first === tag ? { second: key } : { first: key })),
    vanishedBadge(partner),
    h('span', { class: 'grow' }),
    numberInput(item.value, low, high, (value) => {
      item.value = value;  // typed in place: no redraw, so the field keeps the focus
      setList(shown, false);
    }),
    unit && h('span', { class: 'muted small' }, unit),
    h('button', { class: 'btn icon-btn', title: t('common.remove'), onclick: () => removeItem(item) }, '✕'));
}

function obligationRow(item) {
  const tag = ctx.start().key;
  const mine = item.first === tag;
  const partner = mine ? item.second : item.first;
  return h('div', { class: 'row country-line' },
    selectOf([['owes', t('relations.owes')], ['owed', t('relations.owed')]], mine ? 'owes' : 'owed',
      (value) => { if ((value === 'owes') !== mine) editItem(item, { first: item.second, second: item.first }); }),
    countryButton(partner, (key) => editItem(item, mine ? { second: key } : { first: key })),
    vanishedBadge(partner),
    h('span', { class: 'grow' }),
    h('button', { class: 'btn icon-btn', title: t('common.remove'), onclick: () => removeItem(item) }, '✕'));
}

function addButton(kind) {
  const tag = ctx.start().key;
  const defaults = { pact: { type: 'puppet', value: 0 }, relations: { type: '', value: 20 },
    truce: { type: '', value: 12 }, obligation: { type: '', value: 0 } };
  return h('button', { class: 'btn small', onclick: () => chooseObjects({
    kind: 'countries', title: t('relations.add.' + kind), multi: false,
    onDone: ([key]) => {
      if (!key || key === tag) return;
      setList([...shown, { kind, first: tag, second: key, ...defaults[kind] }]);
    },
  }) }, t('relations.add.' + kind));
}

function diplomacySection() {
  const start = ctx.start();
  const list = diplomacyList();
  shown = list;
  const rows = { pact: [], relations: [], truce: [], obligation: [] };
  for (const item of list) {
    if (item.kind === 'pact') rows.pact.push(pactRow(item));
    else if (item.kind === 'relations') rows.relations.push(valueRow(item, -100, 100));
    else if (item.kind === 'truce') rows.truce.push(valueRow(item, 1, 1200, t('relations.months')));
    else if (item.kind === 'obligation') rows.obligation.push(obligationRow(item));
  }
  const liberty = list.find((item) => item.kind === 'liberty_desire');
  const libertyInput = h('input', { class: 'input territory-levels', type: 'number', min: -100, max: 100, step: 1,
    value: liberty ? String(liberty.value) : '', placeholder: '—',
    onchange: () => {
      const others = shown.filter((item) => item.kind !== 'liberty_desire');
      const n = Math.round(Number(libertyInput.value));
      if (libertyInput.value === '' || Number.isNaN(n)) setList(others);
      else setList([...others, { kind: 'liberty_desire', first: start.key, second: '', type: '', value: Math.max(-100, Math.min(100, n)) }]);
    } });
  return section(t('relations.diplomacy'), t('relations.diplomacy_hint'),
    h('div', { class: 'row country-section-tools' },
      start.diplomacy && h('span', { class: 'badge accent' }, t('territory.own_list')),
      h('span', { class: 'grow' }),
      resetButton(start.diplomacy !== null, () => { start.diplomacy = null; ctx.changed(); ctx.refresh('diplomacy'); })),
    KINDS.map((kind) => h('div', { class: 'relations-group' },
      h('div', { class: 'row' }, h('h4', { class: 'grow' }, t('relations.kind.' + kind)), addButton(kind)),
      h('p', { class: 'muted small' }, t('relations.kind_hint.' + kind)),
      rows[kind].length ? rows[kind] : h('span', { class: 'muted small' }, t('common.none')))),
    h('div', { class: 'relations-group' },
      field(t('relations.kind.liberty_desire'), libertyInput, t('relations.kind_hint.liberty_desire'))),
    h('p', { class: 'muted small' }, t('relations.kept_note')));
}

// ---------------------------------------------------------------- treaties

const articleOf = (key) => ctx.cdata.treaty_articles.find((article) => article.key === key);

function articleName(key) {
  const article = articleOf(key);
  return (article && article.name) || key;
}

function inputText(article) {
  const parts = [];
  for (const [key, value] of Object.entries(article.inputs || {})) {
    if (key === 'state_country') continue;
    if (key === 'quantity') parts.push(String(value));
    else if (key === 'state') parts.push(`${nameOf('states', value)} (${article.inputs.state_country || '?'})`);
    else parts.push(nameOf(INPUT_KINDS[key], value));
  }
  return parts.join(' · ');
}

function articleLine(article) {
  const info = articleOf(article.article);
  const mutual = info ? info.kind === 'mutual' : !article.source;
  return h('li', {},
    h('b', {}, articleName(article.article)), ' ',
    !mutual && h('span', { class: 'muted small' }, `${article.source} → ${article.target}`), ' ',
    h('span', { class: 'small' }, inputText(article)));
}

// Which starts take out each of the game's treaties: id -> [tags].
function removals() {
  const found = new Map();
  for (const start of [...ctx.others(), ctx.start()]) {
    for (const id of start.treaties_removed || []) {
      if (!found.has(id)) found.set(id, []);
      found.get(id).push(start.key);
    }
  }
  return found;
}

function gameTreatyCard(treaty, removedBy) {
  const start = ctx.start();
  const tag = start.key;
  const partner = treaty.first === tag ? treaty.second : treaty.first;
  const mine = start.treaties_removed.includes(treaty.id);
  const others = (removedBy.get(treaty.id) || []).filter((key) => key !== tag);
  const toggle = () => {
    start.treaties_removed = mine ? start.treaties_removed.filter((id) => id !== treaty.id)
      : [...start.treaties_removed, treaty.id];
    ctx.changed();
    ctx.refresh('treaties');
  };
  return h('div', { class: 'territory-part relations-treaty' + (mine || others.length ? ' removed' : '') },
    h('div', { class: 'row' },
      h('b', {}, treaty.name_text || t('relations.treaty_unnamed')),
      h('span', { class: 'muted small' }, t('relations.treaty_meta',
        { partner: `${nameOf('countries', partner)} (${partner})`, date: treaty.date, years: treaty.years })),
      vanishedBadge(partner),
      treaty.dlc && h('span', { class: 'badge', title: t('relations.dlc_hint') }, t('relations.dlc')),
      mine && h('span', { class: 'badge warn' }, t('relations.to_remove')),
      others.length > 0 && h('span', { class: 'badge warn' },
        t('relations.removed_by', { names: others.map((key) => nameOf('countries', key)).join(' / ') })),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn small', title: mine ? '' : t('relations.remove_hint'), onclick: toggle },
        mine ? t('relations.keep') : t('relations.remove'))),
    h('ul', { class: 'relations-articles' }, treaty.articles.map(articleLine)));
}

function otherTreatyCard(owner, treaty) {
  return h('div', { class: 'territory-part relations-treaty' },
    h('div', { class: 'row' },
      h('b', {}, treaty.names[language()] || t('relations.treaty_unnamed')),
      h('span', { class: 'muted small' }, t('relations.treaty_meta',
        { partner: `${nameOf('countries', owner)} (${owner})`, date: treaty.date, years: treaty.years })),
      h('span', { class: 'badge accent' }, t('relations.added_by', { name: nameOf('countries', owner) }))),
    h('ul', { class: 'relations-articles' }, treaty.articles.map(articleLine)));
}

// The start's own treaties are edited in place (the start is the page's copy).
function editTreaty(index, change, redraw = true) {
  Object.assign(ctx.start().treaties_added[index], change);
  ctx.changed();
  if (redraw) ctx.refresh('treaties');
}

function inputControl(index, articleIndex, article, key, treaty) {
  const setInput = (change, redraw = true) => {
    Object.assign(article.inputs, change);
    editTreaty(index, {}, redraw);
  };
  const label = t('relations.input.' + key);
  if (key === 'quantity') {
    return h('label', { class: 'check small' }, label,
      numberInput(article.inputs.quantity ?? '', 0, 1e9, (n) => setInput({ quantity: n }, false)));
  }
  const value = article.inputs[key];
  const kind = INPUT_KINDS[key];
  const pick = h('button', { class: 'btn small' + (value ? '' : ' invalid'), title: label, onclick: () => chooseObjects({
    kind, title: label, multi: false, selected: value ? [value] : [],
    onDone: ([chosen]) => {
      if (!chosen) return;
      // a state is a country's part of it: the source's, unless another was chosen
      setInput(key === 'state' ? { state: chosen, state_country: article.inputs.state_country || article.source || treaty.first }
        : { [key]: chosen });
    },
  }) }, `${label}：${value ? nameOf(kind, value) : t('common.choose')}`);
  if (key !== 'state') return pick;
  const pair = [treaty.first, treaty.second];
  return h('span', { class: 'row' }, pick,
    selectOf(pair.map((tag) => [tag, t('relations.state_of', { name: nameOf('countries', tag) })]),
      article.inputs.state_country || article.source || treaty.first, (owner) => setInput({ state_country: owner })));
}

function articleEditor(index, treaty, article, articleIndex) {
  const info = articleOf(article.article);
  const directed = !info || info.kind !== 'mutual';
  const setArticle = (change) => editTreaty(index,
    { articles: treaty.articles.map((a, i) => (i === articleIndex ? { ...a, ...change } : a)) });
  const forward = article.source === treaty.first;
  return h('div', { class: 'territory-building' },
    h('div', { class: 'row' },
      selectOf(ctx.cdata.treaty_articles.map((a) => [a.key, a.name || a.key]), article.article, (key) => {
        const chosen = articleOf(key);
        const mutual = chosen && chosen.kind === 'mutual';
        setArticle({ article: key, source: mutual ? '' : treaty.first, target: mutual ? '' : treaty.second, inputs: {} });
      }),
      directed && selectOf([['forward', `${treaty.first} → ${treaty.second}`], ['back', `${treaty.second} → ${treaty.first}`]],
        forward ? 'forward' : 'back', (value) => setArticle(value === 'forward'
          ? { source: treaty.first, target: treaty.second } : { source: treaty.second, target: treaty.first })),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn icon-btn', title: t('common.remove'),
        onclick: () => editTreaty(index, { articles: treaty.articles.filter((_a, i) => i !== articleIndex) }) }, '✕')),
    info && info.desc && h('p', { class: 'muted small' }, info.desc),
    info && info.inputs.length > 0 && h('div', { class: 'row territory-owner' },
      info.inputs.map((key) => inputControl(index, articleIndex, article, key, treaty))));
}

function ownTreatyCard(treaty, index) {
  const start = ctx.start();
  const lang = language();
  const date = h('input', { class: 'input country-date' + (DATE_PATTERN.test(treaty.date) ? '' : ' invalid'),
    type: 'text', value: treaty.date, placeholder: '1836.1.1',
    oninput: () => {
      date.classList.toggle('invalid', !DATE_PATTERN.test(date.value.trim()));
      editTreaty(index, { date: date.value.trim() }, false);
    } });
  const name = h('input', { class: 'input', type: 'text', value: treaty.names[lang] || '', placeholder: t('relations.treaty_unnamed'),
    oninput: () => {
      const names = { ...treaty.names };
      if (name.value.trim()) names[lang] = name.value.trim();
      else delete names[lang];
      editTreaty(index, { names }, false);
    } });
  return h('div', { class: 'territory-part relations-treaty own' },
    h('div', { class: 'row' },
      h('span', { class: 'badge accent' }, t('relations.new_treaty')),
      countryButton(treaty.second, (key) => editTreaty(index, {
        second: key,
        articles: treaty.articles.map((a) => ({ ...a,
          source: a.source === treaty.second ? key : a.source, target: a.target === treaty.second ? key : a.target,
          inputs: a.inputs.state_country === treaty.second ? { ...a.inputs, state_country: key } : a.inputs })),
      })),
      vanishedBadge(treaty.second),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn icon-btn', title: t('common.remove'), onclick: () => {
        start.treaties_added = start.treaties_added.filter((_x, i) => i !== index);
        ctx.changed();
        ctx.refresh('treaties');
      } }, '✕')),
    h('div', { class: 'country-grid' },
      field(t('relations.treaty_name', { language: languageName(lang) }), name, t('relations.treaty_name_hint')),
      field(t('relations.treaty_date'), date),
      field(t('relations.treaty_years'), numberInput(treaty.years, 0, 500, (n) => editTreaty(index, { years: n }, false),
        'input'))),
    h('div', { class: 'territory-items' },
      treaty.articles.map((article, i) => articleEditor(index, treaty, article, i)),
      treaty.articles.length === 0 && h('p', { class: 'notice warn' }, t('cproblem.treaty_articles')),
      h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: () => editTreaty(index, {
        articles: [...treaty.articles, { article: 'defensive_pact', source: '', target: '', inputs: {} }],
      }) }, t('relations.add_article')))));
}

function treatiesSection() {
  const start = ctx.start();
  const tag = start.key;
  const removedBy = removals();
  const game = ctx.cdata.treaties.filter((treaty) => involves(treaty, tag));
  const fromOthers = ctx.others().flatMap((other) => (other.treaties_added || [])
    .filter((treaty) => treaty.second === tag).map((treaty) => [other.key, treaty]));
  const add = () => chooseObjects({
    kind: 'countries', title: t('relations.add_treaty'), multi: false,
    onDone: ([key]) => {
      if (!key || key === tag) return;
      start.treaties_added = [...start.treaties_added,
        { names: {}, first: tag, second: key, date: '1836.1.1', years: 5, articles: [] }];
      ctx.changed();
      ctx.refresh('treaties');
    },
  });
  return section(t('relations.treaties'), t('relations.treaties_hint'),
    h('div', { class: 'row country-section-tools' }, h('span', { class: 'grow' }),
      h('button', { class: 'btn', onclick: add }, t('relations.add_treaty'))),
    start.treaties_added.map((treaty, i) => ownTreatyCard(treaty, i)),
    fromOthers.map(([owner, treaty]) => otherTreatyCard(owner, treaty)),
    game.map((treaty) => gameTreatyCard(treaty, removedBy)),
    !game.length && !fromOthers.length && !start.treaties_added.length && h('span', { class: 'muted' }, t('common.none')));
}

// ---------------------------------------------------------------- characters

const templateOf = (key) => ctx.cdata.character_templates.find((item) => item.key === key);

function characterList() {
  const start = ctx.start();
  return structuredClone(start.characters || ctx.game().characters);
}

// Store the list on the page (a copy of it); `redraw`: draw the section again.
function setCharacters(list, redraw = true) {
  const start = ctx.start();
  start.characters = same(list, ctx.game().characters) ? null : structuredClone(list);
  ctx.changed();
  if (redraw) ctx.refresh('characters');
}

function roleName(role) {
  return ROLES.includes(role) ? t('relations.role_of.' + role) : role.replace(/^character_role_/, '');
}

function roleBadges(roles) {
  return roles.map((role) => h('span', { class: 'badge' }, roleName(role)));
}

function templateRow(item, index) {
  const info = templateOf(item.template);
  return h('div', { class: 'territory-building' },
    h('div', { class: 'row' },
      h('span', { class: 'grow' },
        h('b', {}, item.template ? (info && info.name) || item.template : t('relations.script_character')), ' ',
        item.template && h('span', { class: 'company-key' }, item.template)),
      info && roleBadges(info.roles),
      item.template && !info && h('span', { class: 'badge warn' }, t('cproblem.character_template')),
      h('button', { class: 'btn icon-btn', title: t('common.remove'),
        onclick: () => setCharacters(shownChars.filter((_x, i) => i !== index)) }, '✕')),
    info && h('div', { class: 'row muted small' },
      [info.culture && nameOf('cultures', info.culture), info.interest_group && nameOf('interest_groups', info.interest_group),
        info.ideology && (ctx.cdata.character_ideologies.find((i) => i.key === info.ideology) || {}).name,
        info.birth_date && t('relations.born', { date: info.birth_date }), info.age && t('relations.age', { age: info.age }),
        info.female && t('relations.female')].filter(Boolean).join(' · ')),
    (item.extra || !item.template) && h('details', { class: 'relations-extra', open: !item.template },
      h('summary', { class: 'muted small' }, t('relations.extra')),
      scriptArea(() => item.extra, (value) => { item.extra = value; }, () => setCharacters(shownChars, false))));
}

function newRow(item, index) {
  const lang = language();
  const fields = item.new;
  const edit = (change, redraw = false) => {
    Object.assign(fields, change);
    setCharacters(shownChars, redraw);
  };
  // a name in any language will do; the others fall back to English in the game
  const anyName = (texts) => texts[lang] || Object.values(texts).find(Boolean) || '';
  const nameInput = (name) => {
    const input = h('input', { class: 'input' + (anyName(fields[name]) ? '' : ' invalid'), type: 'text',
      value: fields[name][lang] || '', placeholder: anyName(fields[name]),
      oninput: () => {
        const texts = { ...fields[name] };
        if (input.value.trim()) texts[lang] = input.value.trim();
        else delete texts[lang];
        input.classList.toggle('invalid', !anyName(texts));
        edit({ [name]: texts });
      } });
    return input;
  };
  const birth = h('input', { class: 'input country-date', type: 'text', value: fields.birth_date, placeholder: '1800.1.1',
    oninput: () => {
      birth.classList.toggle('invalid', Boolean(birth.value.trim()) && !DATE_PATTERN.test(birth.value.trim()));
      edit({ birth_date: birth.value.trim() });
    } });
  const culture = h('button', { class: 'btn small', onclick: () => chooseObjects({
    kind: 'cultures', title: t('territory.culture'), multi: false, selected: [fields.culture],
    onDone: ([key]) => { if (key) edit({ culture: key }, true); },
  }) }, fields.culture ? nameOf('cultures', fields.culture) : t('common.choose'));
  const home = h('button', { class: 'btn small', onclick: () => chooseObjects({
    kind: 'states', title: t('relations.home_region'), multi: false, selected: fields.home_region ? [fields.home_region] : [],
    onDone: ([key]) => edit({ home_region: key || '' }, true),
  }) }, fields.home_region ? nameOf('states', fields.home_region) : t('relations.random'));
  const traitItems = ctx.cdata.traits.map((trait) => ({ key: trait.key, name: trait.name || trait.key,
    sub: TRAIT_KINDS.includes(trait.kind) ? t('relations.trait.' + trait.kind) : trait.key }));
  const military = fields.role === 'general' || fields.role === 'admiral';
  return h('div', { class: 'territory-building relations-new' },
    h('div', { class: 'row' },
      h('span', { class: 'badge accent' }, t('relations.new_character')),
      h('b', { class: 'grow' }, [anyName(fields.first_name), anyName(fields.last_name)].filter(Boolean).join(' ') || '—'),
      h('button', { class: 'btn icon-btn', title: t('common.remove'),
        onclick: () => setCharacters(shownChars.filter((_x, i) => i !== index)) }, '✕')),
    h('div', { class: 'country-grid' },
      field(t('relations.first_name', { language: languageName(lang) }), nameInput('first_name')),
      field(t('relations.last_name', { language: languageName(lang) }), nameInput('last_name')),
      field(t('relations.role_label'), selectOf(ROLES.map((role) => [role, t('relations.role_of.' + role)]), fields.role,
        (value) => edit({ role: value, commander_rank: value === 'general' || value === 'admiral' ? fields.commander_rank : '' }, true))),
      military && field(t('relations.commander_rank'), selectOf(ctx.cdata.commander_ranks.map((r) => [r.key, r.name || r.key]),
        fields.commander_rank, (value) => edit({ commander_rank: value }), t('relations.random'))),
      field(t('relations.birth_date'), birth, t('relations.birth_hint')),
      field(t('territory.culture'), culture),
      field(t('country.part.religion'), selectOf(store.data.religions.map((r) => [r.key, r.name || r.key]), fields.religion,
        (value) => edit({ religion: value }), t('territory.religion_of_culture'))),
      field(t('relations.interest_group'), selectOf(store.data.interest_groups.map((ig) => [ig.key, ig.name || ig.key]),
        fields.interest_group, (value) => edit({ interest_group: value }), t('relations.random'))),
      field(t('relations.ideology'), selectOf(ctx.cdata.character_ideologies.map((i) => [i.key, i.name || i.key]),
        fields.ideology, (value) => edit({ ideology: value }), t('relations.random'))),
      field(t('relations.home_region'), home),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: fields.female,
        onchange: (event) => edit({ female: event.target.checked }) }), t('relations.female'))),
    h('div', { class: 'chips' },
      h('span', { class: 'muted small' }, t('relations.traits')),
      fields.traits.map((key) => h('span', { class: 'chip', title: key },
        (ctx.cdata.traits.find((trait) => trait.key === key) || {}).name || key,
        h('button', { class: 'chip-remove', title: t('common.remove'),
          onclick: () => edit({ traits: fields.traits.filter((x) => x !== key) }, true) }, '✕'))),
      h('button', { class: 'btn small', onclick: () => chooseObjects({
        kind: 'traits', title: t('relations.traits'), selected: fields.traits, items: traitItems,
        onDone: (keys) => edit({ traits: keys }, true),
      }) }, t('common.choose'))));
}

function charactersSection() {
  const start = ctx.start();
  const game = ctx.game();
  const list = characterList();
  shownChars = list;
  const tag = start.key.toLowerCase();
  const pickTemplates = () => {
    // the country's own templates first
    const items = ctx.cdata.character_templates.map((info) => ({
      key: info.key, name: info.name || info.key, raw: info,
      sub: [info.key, ...info.roles.map(roleName)].join(' · '),
    })).sort((a, b) => Number(!a.key.toLowerCase().startsWith(tag + '_')) - Number(!b.key.toLowerCase().startsWith(tag + '_')));
    chooseObjects({ kind: 'character_templates', title: t('relations.add_template'), items,
      selected: list.filter((item) => item.template).map((item) => item.template),
      onDone: (keys) => {
        const have = new Set(list.map((item) => item.template));
        const kept = list.filter((item) => !item.template || item.new || keys.includes(item.template) || item.extra);
        setCharacters([...kept, ...keys.filter((key) => !have.has(key)).map((key) => ({ template: key, extra: '', new: null }))]);
      } });
  };
  const addNew = () => setCharacters([...list, { template: '', extra: '', new: {
    first_name: {}, last_name: {}, female: false, birth_date: '', culture: ctx.cultures()[0] || '', religion: '',
    interest_group: '', ideology: '', traits: [], home_region: '', role: 'politician', commander_rank: '' } }]);
  const rulers = list.filter((item) => (item.new ? item.new.role === 'ruler'
    : ((templateOf(item.template) || {}).roles || []).includes('ruler'))).length;
  return section(t('relations.characters'), t('relations.characters_hint'),
    h('div', { class: 'row country-section-tools' },
      start.characters && h('span', { class: 'badge accent' }, t('territory.own_list')),
      h('span', { class: 'grow' }),
      resetButton(start.characters !== null, () => { start.characters = null; ctx.changed(); ctx.refresh('characters'); }),
      h('button', { class: 'btn', onclick: pickTemplates }, t('relations.add_template')),
      h('button', { class: 'btn', onclick: addNew }, t('relations.add_character'))),
    rulers > 1 && h('p', { class: 'notice warn' }, t('relations.many_rulers', { count: rulers })),
    h('div', { class: 'territory-items' },
      list.map((item, i) => (item.new ? newRow(item, i) : templateRow(item, i))),
      list.length === 0 && h('span', { class: 'muted' }, t('common.none'))),
    game.other_characters > 0 && h('p', { class: 'muted small' }, t('relations.other_characters', { count: game.other_characters })));
}

// What a start's stage 3 parts change, for the preview's list of changes.
export function relationChanges(start) {
  const parts = [];
  if (start.diplomacy) parts.push('diplomacy');
  if (start.treaties_added.length || start.treaties_removed.length) parts.push('treaties');
  if (start.characters) parts.push('characters');
  return parts;
}

// Problems the page can see before saving.
export function relationProblems(start) {
  const found = [];
  for (const treaty of start.treaties_added) {
    if (!DATE_PATTERN.test(treaty.date)) found.push('treaty_date');
    if (!treaty.articles.length) found.push('treaty_articles');
    for (const article of treaty.articles) {
      const info = ctx && articleOf(article.article);
      if (info && info.inputs.some((key) => article.inputs[key] === undefined || article.inputs[key] === '')) {
        found.push('treaty_inputs');
      }
    }
  }
  for (const item of start.characters || []) {
    if (!item.new) continue;
    if (!Object.values(item.new.first_name).some(Boolean) || !Object.values(item.new.last_name).some(Boolean)) {
      found.push('character_name');
    }
    if (item.new.birth_date && !DATE_PATTERN.test(item.new.birth_date)) found.push('character_birth');
    if (!item.new.culture || (item.new.role === 'ig_leader' && !item.new.interest_group)) found.push('character_fields');
  }
  return [...new Set(found)];
}
