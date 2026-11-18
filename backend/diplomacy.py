"""Diplomacy and treaties of the country starts (stage 3 of docs/mod_types/country_start.md).

The diplomacy files (common/history/diplomacy) and the treaty file (common/history/treaties) are
shared by every country, so, as with the territory, the mod writes copies of the files in effect in
which only what changed is taken out or added.

A start keeps:
  diplomacy         None (as the game has it), or every statement this country is part of, as a
                    whole: [{kind, first, second, type, value}] (see KINDS)
  treaties_added    new treaties: [{names, first, second, date, years, articles}]
  treaties_removed  ids of the game's treaties to take out (see treaty_id)

Diplomacy statements are written in the block of their first country: an overlord's subjects, the
country that owes a favour. Relations and truces are mutual: the game sets them for both sides.
When several starts change the statements between the same two countries, the one saved last wins
(sync_diplomacy keeps the others in line). Statements the tool does not know (inside
every_subject_or_below, if, ...) are kept as they are.

A country left without land does not exist at the start: what names it is taken out of both
folders, and the treaties added with it are not written.
"""
import re

from .companies import clean_names
from .countries import DATE_PATTERN, Patcher, TAG_PATTERN, _scoped_block_lines, entry_indent, scope_blocks
from .pdx_script import Block, parse

DIPLOMACY_FOLDER, DIPLOMACY_TOP = "common/history/diplomacy", "DIPLOMACY"
TREATY_FOLDER, TREATY_TOP = "common/history/treaties", "TREATIES"
# kind: (statement, the field with the number)
KINDS = {
    "pact": ("create_diplomatic_pact", None),         # first: the overlord / the one acting; type: the pact
    "relations": ("set_relations", "value"),          # -100 .. 100, both ways
    "truce": ("create_bidirectional_truce", "months"),
    "obligation": ("set_owes_obligation_to", None),   # first owes second a favour
    "liberty_desire": ("add_liberty_desire", None),   # of a subject (first); no second
}
STATEMENTS = {statement: kind for kind, (statement, _number) in KINDS.items()}
# Inputs of treaty articles, in the order they are written, and their script prefixes.
INPUT_PREFIXES = {"quantity": "", "goods": "g:", "state": "s:", "strategic_region": "sr:", "company": "company_type:",
                  "building_type": "bt:", "law_type": "law_type:", "country": "c:"}
KEY = re.compile(r"^[A-Za-z0-9_.\-]+$")


def _tag(value):
    value = str(value or "")
    return value[2:] if value.startswith("c:") else ""


def _int(value):
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


# ------------------------------------------------------------- diplomacy

def item_from_entry(tag, entry):
    """A diplomacy statement of country `tag`'s block as {kind, first, second, type, value}; None when
    the tool does not know it (it is kept as it is)."""
    kind = STATEMENTS.get(entry.key)
    if kind is None:
        return None
    if kind == "liberty_desire":
        value = _int(entry.value) if isinstance(entry.value, str) else None
        return None if value is None else {"kind": kind, "first": tag, "second": "", "type": "", "value": value}
    block = entry.value
    if not isinstance(block, Block):
        return None
    fields = {e.key: e.value for e in block.entries}
    if len(fields) != len(block.entries) or not all(isinstance(v, str) for v in fields.values()):
        return None
    second = _tag(fields.pop("country", ""))
    if not second:
        return None
    item = {"kind": kind, "first": tag, "second": second, "type": "", "value": 0}
    if kind == "pact":
        item["type"] = fields.pop("type", "")
        if not item["type"]:
            return None
    elif kind == "obligation":
        if fields.pop("setting", "yes") != "yes":
            return None
    else:
        value = _int(fields.pop(KINDS[kind][1], None))
        if value is None:
            return None
        item["value"] = value
    return None if fields else item


def item_lines(item):
    kind = item["kind"]
    statement = KINDS[kind][0]
    if kind == "liberty_desire":
        return [f"{statement} = {item['value']}"]
    if kind == "relations":
        return [f"{statement} = {{ country = c:{item['second']} value = {item['value']} }}"]
    inner = [f"country = c:{item['second']}"]
    if kind == "pact":
        inner.append(f"type = {item['type']}")
    elif kind == "truce":
        inner.append(f"months = {item['value']}")
    else:
        inner.append("setting = yes")
    return _scoped_block_lines(f"{statement} =", inner)


def read_diplomacy(root, rel, found):
    """The statements of one diplomacy file the tool knows: found gets (item, rel, entry, scope entry)."""
    for tag, scope in scope_blocks(root, DIPLOMACY_TOP):
        for entry in scope.value.entries:
            item = item_from_entry(tag, entry)
            if item:
                found.append((item, rel, entry, scope))


def involves(item, tag):
    return tag in (item["first"], item["second"])


def same_item(a, b):
    return all(a[name] == b[name] for name in ("kind", "first", "second", "type", "value"))


def resolve_diplomacy(base_items, starts, vanished=()):
    """What the mod's starts change: (indexes of the game's items taken out, items added).

    Each start with its own list replaces every statement its country is part of; the later start
    wins. What names a country without land goes."""
    current = [(item, i) for i, item in enumerate(base_items)]
    for start in starts:
        if start.get("mode") not in ("override", "new") or start.get("diplomacy") is None:
            continue
        tag = start["key"]
        current = [(item, i) for item, i in current if not involves(item, tag)]
        current += [(dict(item, first=item["first"] or tag), None) for item in start["diplomacy"]]
    vanished = set(vanished)
    current = [(item, i) for item, i in current
               if item["second"] not in vanished and (i is not None or item["first"] not in vanished)]
    kept = {i for _item, i in current if i is not None}
    removed = [i for i in range(len(base_items)) if i not in kept]
    added = []
    for item, i in current:
        if i is not None:
            continue
        # a statement written again as it was stays where it was
        match = next((r for r in removed if same_item(base_items[r], item)), None)
        if match is None:
            added.append(item)
        else:
            removed.remove(match)
    return removed, added


def sync_diplomacy(start, starts):
    """After `start` is saved, the other starts' lists agree with it on the statements between them."""
    if start.get("diplomacy") is None:
        return
    tag = start["key"]
    for other in starts:
        if other is start or other["key"] == tag or other.get("diplomacy") is None:
            continue
        mine = [dict(item) for item in start["diplomacy"] if involves(item, other["key"])]
        other["diplomacy"] = [item for item in other["diplomacy"] if not involves(item, tag)] + mine


# --------------------------------------------------------------- treaties

def treaty_id(first, second, name, date):
    """How a treaty of the game is known again: the two countries, its name and when it starts.
    The two versions of a treaty in `if` / `else` (with or without a DLC) have the same id."""
    return f"{first}|{second}|{name}|{date}"


def _input_value(key, value):
    """An article input as the model keeps it ({state, state_country} for a state)."""
    if key == "quantity":
        number = _int(value)
        return {key: number} if number is not None else None
    prefix = INPUT_PREFIXES.get(key)
    if prefix is None or not value.startswith(prefix):
        return None
    if key == "state":
        state, _, part = value[2:].partition(".region_state:")
        return {"state": state, "state_country": part} if state and part else None
    return {key: value[len(prefix):]}


def treaty_from_block(block):
    """A create_treaty block as {first, second, name, date, years, articles}; None when the tool
    cannot read it."""
    first, second = _tag(block.get("first_country")), _tag(block.get("second_country"))
    if not (first and second):
        return None
    period = block.get("binding_period")
    years = _int(period.get("years")) if isinstance(period, Block) else None
    name, date = block.get("name"), block.get("entered_into_force_on")
    treaty = {"first": first, "second": second, "name": name if isinstance(name, str) else "",
              "date": date if isinstance(date, str) else "", "years": years or 0, "articles": [],
              "draft": block.get("is_draft") == "yes"}
    articles = block.get("articles_to_create")
    for entry in articles.entries if isinstance(articles, Block) else []:
        if not isinstance(entry.value, Block):
            continue
        article = entry.value
        found = {"article": str(article.get("article") or ""), "source": _tag(article.get("source_country")),
                 "target": _tag(article.get("target_country")), "inputs": {}}
        inputs = article.get("inputs")
        for item in inputs.entries if isinstance(inputs, Block) else []:
            for sub in item.value.entries if isinstance(item.value, Block) else []:
                value = _input_value(sub.key, sub.value) if isinstance(sub.value, str) else None
                if value:
                    found["inputs"].update(value)
        treaty["articles"].append(found)
    return treaty


def read_treaties(root, rel, found):
    """The treaties of one treaty file: found gets (treaty with "id" and "dlc", rel, entry)."""
    def walk(block, conditional, depth):
        for entry in block.entries:
            if not isinstance(entry.value, Block):
                continue
            if entry.key == "create_treaty":
                treaty = treaty_from_block(entry.value)
                if treaty:
                    treaty["id"] = treaty_id(treaty["first"], treaty["second"], treaty["name"], treaty["date"])
                    treaty["dlc"] = conditional
                    found.append((treaty, rel, entry))
            elif entry.key in ("if", "else_if", "else") and depth < 4:
                walk(entry.value, True, depth + 1)

    for top in root.entries:
        if top.key == TREATY_TOP and isinstance(top.value, Block):
            walk(top.value, False, 0)


def treaty_name_key(slug, tag, index):
    """Localization key of the name of a treaty a start adds."""
    return f"{slug}_treaty_{tag.lower()}_{index + 1}"


def treaty_lines(treaty, name_key, articles):
    """create_treaty for a treaty a start adds. `articles`: {article: {kind, inputs}}."""
    lines = []
    if name_key:
        lines.append(f"name = {name_key}")
    lines += [f"first_country = c:{treaty['first']}", f"second_country = c:{treaty['second']}", "is_draft = no",
              f"entered_into_force_on = {treaty['date']}", f"binding_period = {{ years = {treaty['years']} }}"]
    created = []
    for article in treaty["articles"]:
        inner = [f"article = {article['article']}"]
        if (articles.get(article["article"]) or {}).get("kind") != "mutual":
            inner += [f"source_country = c:{article['source']}", f"target_country = c:{article['target']}"]
        inputs = []
        for key in (articles.get(article["article"]) or {}).get("inputs", []):
            value = article["inputs"].get(key)
            if key == "state":
                value = f"s:{value}.region_state:{article['inputs'].get('state_country', '')}"
            elif key != "quantity":
                value = f"{INPUT_PREFIXES[key]}{value}"
            inputs.append(f"{{ {key} = {value} }}")
        if inputs:
            inner += _scoped_block_lines("inputs =", inputs)
        created += ["{", *("\t" + line for line in inner), "}"]
    lines += _scoped_block_lines("articles_to_create =", created)
    return _scoped_block_lines("create_treaty =", lines)


def start_treaty_texts(start, lang, slug):
    return {treaty_name_key(slug, start["key"], i): treaty["names"][lang]
            for i, treaty in enumerate(start.get("treaties_added") or []) if treaty["names"].get(lang)}


# ------------------------------------------------------------- normalizing

def _country(value, field):
    value = str(value or "").strip()
    if not TAG_PATTERN.match(value):
        raise ValueError(field)
    return value


def _key(value, field):
    value = str(value or "").strip()
    if value and not KEY.match(value):
        raise ValueError(field)
    return value


def _number(value, field, low, high):
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise ValueError(field)
    return value


def normalize_item(raw, tag):
    if not isinstance(raw, dict) or raw.get("kind") not in KINDS:
        raise ValueError("diplomacy")
    kind = raw["kind"]
    item = {"kind": kind, "first": _country(raw.get("first") or tag, "diplomacy"), "second": "", "type": "",
            "value": 0}
    if kind == "liberty_desire":
        item["first"] = tag
        item["value"] = _number(raw.get("value"), "diplomacy", -100, 100)
        return item
    item["second"] = _country(raw.get("second"), "diplomacy")
    if not involves(item, tag) or item["first"] == item["second"]:
        raise ValueError("diplomacy")
    if kind == "pact":
        item["type"] = _key(raw.get("type"), "diplomacy")
        if not item["type"]:
            raise ValueError("diplomacy")
    elif kind == "relations":
        item["value"] = _number(raw.get("value"), "diplomacy", -100, 100)
    elif kind == "truce":
        item["value"] = _number(raw.get("value"), "diplomacy", 1, 1200)
    return item


def normalize_treaty(raw, tag):
    if not isinstance(raw, dict):
        raise ValueError("treaties")
    treaty = {"names": clean_names(raw.get("names")), "first": tag,
              "second": _country(raw.get("second"), "treaties"),
              "date": " ".join(str(raw.get("date") or "").split()),
              "years": _number(raw.get("years"), "treaties", 0, 500), "articles": []}
    if treaty["second"] == tag:
        raise ValueError("treaties")
    articles = raw.get("articles")
    if not isinstance(articles, list):
        raise ValueError("treaties")
    for article in articles:
        if not isinstance(article, dict):
            raise ValueError("treaties")
        inputs = article.get("inputs") or {}
        if not isinstance(inputs, dict):
            raise ValueError("treaties")
        clean = {}
        for key, value in inputs.items():
            if key == "quantity":
                clean[key] = _number(value, "treaties", 0, 10 ** 9)
            elif key in INPUT_PREFIXES or key == "state_country":
                clean[key] = _key(value, "treaties")
        treaty["articles"].append({"article": _key(article.get("article"), "treaties"),
                                   "source": _key(article.get("source"), "treaties"),
                                   "target": _key(article.get("target"), "treaties"), "inputs": clean})
    return treaty


def normalize_diplomacy(start, raw):
    tag = start["key"]
    items = raw.get("diplomacy")
    if items is not None:
        if not isinstance(items, list):
            raise ValueError("diplomacy")
        start["diplomacy"] = []
        for item in (normalize_item(item, tag) for item in items):
            if not any(same_item(item, other) for other in start["diplomacy"]):
                start["diplomacy"].append(item)
    added = raw.get("treaties_added") or []
    if not isinstance(added, list):
        raise ValueError("treaties")
    start["treaties_added"] = [normalize_treaty(treaty, tag) for treaty in added]
    removed = raw.get("treaties_removed") or []
    if not isinstance(removed, list) or not all(isinstance(i, str) and len(i) < 300 for i in removed):
        raise ValueError("treaties")
    start["treaties_removed"] = list(dict.fromkeys(removed))


def diplomacy_errors(start, game):
    """`game` also has "pact_types" and "articles" {key: {kind, inputs}}, "regions", "companies"."""
    errors = []
    for item in start.get("diplomacy") or []:
        if (item["second"] and item["second"] not in game["countries"]) or (
                item["kind"] == "pact" and item["type"] not in game["pact_types"]):
            errors.append("diplomacy")
            break
    for treaty in start["treaties_added"]:
        if not DATE_PATTERN.match(treaty["date"]):
            errors.append("treaty_date")
        if treaty["second"] not in game["countries"]:
            errors.append("treaty_country")
        if not treaty["articles"]:
            errors.append("treaty_articles")
        for article in treaty["articles"]:
            info = game["articles"].get(article["article"])
            if info is None:
                errors.append("treaty_articles")
                continue
            pair = {treaty["first"], treaty["second"]}
            if info["kind"] != "mutual" and not (article["source"] in pair and article["target"] in pair
                                                  and article["source"] != article["target"]):
                errors.append("treaty_articles")
            lists = {"goods": "goods", "law_type": "law_types", "strategic_region": "regions", "company": "companies",
                     "building_type": "buildings", "country": "countries", "state": "states"}
            for key in info["inputs"]:
                value = article["inputs"].get(key)
                if value is None or value == "" or (key in lists and value not in game[lists[key]]) or (
                        key == "state" and article["inputs"].get("state_country") not in pair):
                    errors.append("treaty_inputs")
                    break
    return list(dict.fromkeys(errors))


# ------------------------------------------------------------------ writing

def _drop_mentions(patcher, block, tags, depth=0):
    """Take out the statements whose block names one of the countries as the other side."""
    for entry in block.entries:
        if not isinstance(entry.value, Block):
            continue
        if depth > 0 and any(_tag(entry.value.get(key)) in tags
                             for key in ("country", "first_country", "second_country")
                             if isinstance(entry.value.get(key), str)):
            patcher.remove(entry)
        elif depth < 6:
            _drop_mentions(patcher, entry.value, tags, depth + 1)


def _chains(block):
    """The `if` / `else_if` / `else` chains of a block, as lists of entries."""
    chains, chain = [], []
    for entry in block.entries:
        if entry.key == "if":
            chain = [entry]
            chains.append(chain)
        elif entry.key in ("else_if", "else") and chain:
            chain.append(entry)
            if entry.key == "else":
                chain = []
        else:
            chain = []
    return chains


def write_diplomacy(starts, vanished, base, slug, articles):
    """The diplomacy and treaty files the starts need: {game-relative path: text}.

    `base` as for countries.write_starts (folder_files, text); `articles`: {article: {kind, inputs}}."""
    starts = [s for s in starts if s.get("mode") in ("override", "new")]
    vanished = set(vanished)
    texts = {}
    loaded = {}

    def load(folder):
        for rel in base.folder_files(folder):
            text = base.text(rel)
            if text is not None and rel not in loaded:
                loaded[rel] = (Patcher(text), parse(text))
        return [rel for rel in loaded if rel.startswith(folder + "/")]

    # diplomacy
    diplomacy_files = load(DIPLOMACY_FOLDER)
    found = []
    for rel in diplomacy_files:
        read_diplomacy(loaded[rel][1], rel, found)
    removed, added = resolve_diplomacy([item for item, *_rest in found], starts, vanished)
    for i in removed:
        _item, rel, entry, _scope = found[i]
        loaded[rel][0].remove(entry)
    if vanished:
        for rel in diplomacy_files:
            _drop_mentions(loaded[rel][0], loaded[rel][1], vanished)
    fresh = {}
    for item in added:
        rel = _file_for(item, found) or ""
        fresh.setdefault((rel, item["first"]), []).extend(item_lines(item))
    new_blocks = []
    for (rel, tag), lines in fresh.items():
        if not rel:
            new_blocks += _scoped_block_lines(f"c:{tag} ?=", lines)
            continue
        patcher, root = loaded[rel]
        scopes = [scope for scope_tag, scope in scope_blocks(root, DIPLOMACY_TOP) if scope_tag == tag]
        if scopes:
            patcher.insert_end(scopes[-1].value, lines, entry_indent(patcher.text, scopes[-1].value))
        else:
            top = [e for e in root.entries if e.key == DIPLOMACY_TOP and isinstance(e.value, Block)][-1]
            patcher.insert_end(top.value, _scoped_block_lines(f"c:{tag} ?=", lines), entry_indent(patcher.text, top.value))
    if new_blocks:
        texts[f"{DIPLOMACY_FOLDER}/zzz_{slug}_diplomacy.txt"] = (
            f"{DIPLOMACY_TOP} = {{\n" + "".join(f"\t{line}\n" for line in new_blocks) + "}\n")

    # treaties
    gone = {treaty_id_ for start in starts for treaty_id_ in start.get("treaties_removed") or []}
    treaty_files = load(TREATY_FOLDER)
    for rel in treaty_files:
        patcher, root = loaded[rel]
        treaties = []
        read_treaties(root, rel, treaties)
        dropped = {id(entry) for treaty, _rel, entry in treaties if treaty["id"] in gone}
        for top in root.entries:
            if top.key != TREATY_TOP or not isinstance(top.value, Block):
                continue
            whole = set()
            for chain in _chains(top.value):
                # a DLC chain with nothing left but its conditions goes as a whole
                if all(all(e.key == "limit" or id(e) in dropped for e in part.value.entries)
                       for part in chain if isinstance(part.value, Block)) and any(
                        id(e) in dropped for part in chain if isinstance(part.value, Block) for e in part.value.entries):
                    for part in chain:
                        patcher.remove(part)
                        whole.update(id(e) for e in part.value.entries if isinstance(part.value, Block))
            for treaty, _rel, entry in treaties:
                if id(entry) in dropped and id(entry) not in whole:
                    patcher.remove(entry)
        if vanished:
            _drop_mentions(patcher, root, vanished)
    lines = []
    for start in starts:
        for i, treaty in enumerate(start.get("treaties_added") or []):
            if {treaty["first"], treaty["second"]} & vanished:
                continue
            name = treaty_name_key(slug, start["key"], i) if any(treaty["names"].values()) else ""
            lines += treaty_lines(treaty, name, articles)
    if lines:
        texts[f"{TREATY_FOLDER}/zzz_{slug}_treaties.txt"] = (
            f"{TREATY_TOP} = {{\n" + "".join(f"\t{line}\n" for line in lines) + "}\n")

    texts.update({rel: patcher.result() for rel, (patcher, _root) in loaded.items() if patcher.edits})
    return texts


def _file_for(item, found):
    """Where a new statement goes: the file with most statements of its kind (and pact type)."""
    for same in (lambda other: other["kind"] == item["kind"] and other["type"] == item["type"],
                 lambda other: other["kind"] == item["kind"]):
        counts = {}
        for other, rel, _entry, _scope in found:
            if same(other):
                counts[rel] = counts.get(rel, 0) + 1
        if counts:
            return max(counts, key=lambda rel: counts[rel])
    return None
