"""Country starts: what a country is (its definition) and how it starts (its history).

A country's start is spread over many files (see docs/mod_types/country_start.md). The
history files are scripts run in order, not a database: a mod cannot take back what an
earlier file did, only add to it. So a mod replaces the files whole, by writing a file
of the same path. This tool does that, keeping as much of the file in effect as it can:
it copies the file and changes only the statements of the country that were changed.

The project file keeps only what the user changed ("the tax level is high", "the
starting governance law is the presidential republic"), not the files. Every save takes
the files in effect at that time and applies the changes again, so after a mod or the
game is updated, saving starts from the new files.

The country definition is a database object and is overridden with REPLACE_OR_CREATE,
also written from the definition in effect with the changed fields put in.
"""
import colorsys
import re

from .companies import KEY_PATTERN, clean_names
from .pdx_script import Block, braces_balanced, dedent, parse

COUNTRY_TYPES = ("recognized", "unrecognized", "decentralized", "colonial", "company")
TIERS = ("city_state", "principality", "grand_principality", "kingdom", "empire", "hegemony")
TAX_LEVELS = ("very_low", "low", "medium", "high", "very_high")
TARIFF_LEVELS = ("max_tariffs", "high_tariffs", "low_tariffs", "no_tariffs_or_subventions", "low_subventions",
                 "high_subventions", "max_subventions")
WEALTH_LEVELS = ("low", "medium", "high", "very_high")
LITERACY_LEVELS = ("very_low", "low", "baseline", "middling", "high", "very_high")
TECH_TIERS = range(1, 8)          # effect_starting_technology_tier_1_tech (most advanced) .. 7
INSTITUTION_LEVELS = range(1, 6)  # MAX_INSTITUTION_INVESTMENT
DEFINITION_FIELDS = ("color", "country_type", "tier", "cultures", "capital", "religion", "social_hierarchy")
# Changes that replace a whole part of the history: None means "as the game has it".
HISTORY_FIELDS = ("tech_tier", "techs", "tax_level", "taxed_goods", "tariffs", "institutions", "election",
                  "ruling", "extra")
POPULATION_FIELDS = ("wealth", "literacy")
# The item that sets the laws every country starts with.
ALL_COUNTRIES = "*"
DATE_PATTERN = re.compile(r"^\d{1,4}\.\d{1,2}\.\d{1,2}$")
TAG_PATTERN = re.compile(r"^[A-Za-z0-9_]+$")
NEW_TAG_PATTERN = re.compile(r"^[A-Z][A-Z0-9]{2}$")  # the tag of a new country: three letters or digits
PROVINCE_PATTERN = re.compile(r"^[0-9A-F]{6}$")
_TECH_TIER = re.compile(r"^effect_starting_technology_tier_(\d)_tech$")
_WEALTH = re.compile(r"^effect_starting_pop_wealth_(\w+)$")
_LITERACY = re.compile(r"^effect_starting_pop_literacy_(\w+)$")
_NUMBER = re.compile(r"-?\d+(?:\.\d+)?")

# Where each part of a start is, and the top-level key its files use.
HISTORY_DIRS = {
    "countries": ("common/history/countries", "COUNTRIES"),
    "population": ("common/history/population", "POPULATION"),
    "governments": ("common/history/governments", "GOVERNMENT"),
    "characters": ("common/history/characters", "CHARACTERS"),
}


# ------------------------------------------------------------------ reading

def parse_color(value):
    """A colour as [r, g, b] (0-255) from `{ r g b }`, `rgb{ }`, `hsv{ h s v }` or `hsv360{ h s v }`."""
    if isinstance(value, Block):
        kind, numbers = "", [float(n) for n in _NUMBER.findall(" ".join(value.items()))]
    elif isinstance(value, str):
        kind = value.split("{", 1)[0].strip().lower()
        numbers = [float(n) for n in _NUMBER.findall(value.split("{", 1)[-1])]
    else:
        return None
    if len(numbers) < 3:
        return None
    a, b, c = numbers[:3]
    if kind == "hsv":
        rgb = colorsys.hsv_to_rgb(a % 1.0, b, c)
    elif kind == "hsv360":
        rgb = colorsys.hsv_to_rgb((a / 360.0) % 1.0, b / 100.0, c / 100.0)
    elif max(a, b, c) <= 1 and any("." in n for n in _NUMBER.findall(str(value))):
        rgb = (a, b, c)  # a colour in 0..1
    else:
        return [max(0, min(255, round(n))) for n in (a, b, c)]
    return [max(0, min(255, round(n * 255))) for n in rgb]


def definition_from_block(block):
    """The fields of a country definition the builder edits."""
    def text(name):
        value = block.get(name)
        return value if isinstance(value, str) else ""

    cultures = block.get("cultures")
    color = block.get("color")
    return {
        "color": parse_color(color),
        "country_type": text("country_type"),
        "tier": text("tier"),
        "cultures": cultures.items() if isinstance(cultures, Block) else [],
        "capital": text("capital"),
        "religion": text("religion"),
        "social_hierarchy": text("social_hierarchy"),
        "dynamic": text("dynamic_country_definition") == "yes",
        "named_from_capital": text("is_named_from_capital") == "yes",
    }


def scope_blocks(root, top_key):
    """The `c:TAG ?= { ... }` blocks of a history file: [(tag, Entry)]."""
    found = []
    for top in root.entries:
        if top.key != top_key or not isinstance(top.value, Block):
            continue
        for entry in top.value.entries:
            if entry.key and entry.key.startswith("c:") and isinstance(entry.value, Block):
                found.append((entry.key[2:], entry))
    return found


def _tariff(entry):
    """`set_import_tariff_level = { goods = g:x level = y }` as {kind, goods, level}, or None."""
    block = entry.value
    if not isinstance(block, Block) or len(block.entries) != 2:
        return None
    goods, level = block.get("goods"), block.get("level")
    if not (isinstance(goods, str) and goods.startswith("g:") and isinstance(level, str)):
        return None
    return {"kind": "import" if entry.key == "set_import_tariff_level" else "export", "goods": goods[2:],
            "level": level}


def _institution(entry):
    block = entry.value
    if not isinstance(block, Block) or len(block.entries) != 2:
        return None
    institution, level = block.get("institution"), block.get("level")
    if not (isinstance(institution, str) and isinstance(level, str) and level.isdigit()):
        return None
    return {"institution": institution, "level": int(level)}


def classify(entry):
    """What a statement of a country's history is: (kind, value). Kind "other" is kept as script."""
    key, value = entry.key, entry.value
    if key is None:
        return "other", None
    if key == "activate_law" and isinstance(value, str) and value.startswith("law_type:"):
        return "law", value[len("law_type:"):]
    if key.startswith("effect_starting_politics_") and value == "yes":
        return "politics", key
    match = _TECH_TIER.match(key)
    if match and value == "yes":
        return "tech_tier", int(match.group(1))
    if key == "add_technology_researched" and isinstance(value, str):
        return "tech", value
    if key == "set_tax_level" and isinstance(value, str):
        return "tax_level", value
    if key == "add_taxed_goods" and isinstance(value, str) and value.startswith("g:"):
        return "taxed_goods", value[2:]
    if key in ("set_import_tariff_level", "set_export_tariff_level") and _tariff(entry):
        return "tariffs", _tariff(entry)
    if key == "set_institution_investment_level" and _institution(entry):
        return "institutions", _institution(entry)
    if key == "set_next_election_date" and isinstance(value, str):
        return "election", value
    if key == "set_ruling_interest_groups" and isinstance(value, Block):
        return "ruling_set", value.items()
    if key.startswith("ig:") and isinstance(value, Block):
        return "ig", key[3:]
    return "other", None


def empty_history():
    return {"law_steps": [], "politics": [], "tech_tier": 0, "techs": [], "tax_level": "", "taxed_goods": [],
            "tariffs": [], "institutions": [], "election": "", "ruling": [], "ig_names": {}, "extra": ""}


def read_history(history, block):
    """Add the statements of one `c:TAG ?= { }` block of the country history to `history`."""
    extra = [history["extra"]] if history["extra"] else []
    for entry in block.entries:
        kind, value = classify(entry)
        if kind == "law":
            history["law_steps"].append({"law": value})
        elif kind == "politics":
            history["law_steps"].append({"effect": value})
            history["politics"].append(value)
        elif kind == "tech_tier":
            history["tech_tier"] = value
        elif kind in ("tech", "taxed_goods"):
            target = history["techs" if kind == "tech" else "taxed_goods"]
            if value not in target:
                target.append(value)
        elif kind in ("tax_level", "election"):
            history[kind] = value
        elif kind == "tariffs":
            history["tariffs"] = [t for t in history["tariffs"]
                                  if (t["kind"], t["goods"]) != (value["kind"], value["goods"])] + [value]
        elif kind == "institutions":
            history["institutions"] = [i for i in history["institutions"]
                                       if i["institution"] != value["institution"]] + [value]
        elif kind == "ruling_set":
            history["ruling"] = list(value)
        elif kind == "ig":
            for sub in entry.value.entries:
                if sub.key == "add_ruling_interest_group" and sub.value == "yes" and value not in history["ruling"]:
                    history["ruling"].append(value)
                elif sub.key == "set_interest_group_name" and isinstance(sub.value, str):
                    history["ig_names"][value] = sub.value
        else:
            extra.append(dedent(entry.raw))
    history["extra"] = "\n".join(extra)
    return history


def read_population(population, block):
    """Wealth and literacy levels of one `c:TAG ?= { }` block of the population history."""
    for entry in block.entries:
        if entry.value != "yes" or not entry.key:
            continue
        wealth, literacy = _WEALTH.match(entry.key), _LITERACY.match(entry.key)
        if wealth:
            population["wealth"] = wealth.group(1)
        elif literacy:
            population["literacy"] = literacy.group(1)
    return population


def read_government(government, block):
    """The ruling party of one `c:TAG ?= { }` block of the government history."""
    for entry in block.entries:
        if entry.key and entry.key.startswith("py:") and isinstance(entry.value, Block):
            if any(sub.key == "set_ruling_party" and sub.value == "yes" for sub in entry.value.entries):
                government["ruling_party"] = entry.key[3:]
    return government


# ------------------------------------------------- starting law presets

def _condition(block, triggers, depth=0):
    """A trigger block as a small expression the browser can evaluate for any country definition.

    {"all": [...]}, {"any": [...]}, {"not": x}, {"type": t}, {"religion": [r...]}, {"dlc": f}, {"unknown": text};
    scripted triggers (`country_is_islamic = yes`) are opened up when `triggers(name)` knows them.
    """
    parts = []
    for entry in block.entries:
        key, value = entry.key, entry.value
        if key in ("AND", "OR", "NOT", "NOR", "NAND") and isinstance(value, Block):
            inner = _condition(value, triggers, depth)
            items = inner["all"]
            if key == "OR":
                parts.append({"any": items})
            elif key in ("NOT", "NOR"):
                parts.append({"not": {"any": items}})
            elif key == "NAND":
                parts.append({"not": {"all": items}})
            else:
                parts.append(inner)
        elif key == "is_country_type" and isinstance(value, str):
            parts.append({"type": value})
        elif key == "country_has_state_religion" and isinstance(value, str):
            parts.append({"religion": [value[4:] if value.startswith("rel:") else value]})
        elif key == "has_dlc_feature" and isinstance(value, str):
            parts.append({"dlc": value})
        elif key and value in ("yes", "no") and depth < 4 and triggers(key) is not None:
            inner = _condition(triggers(key), triggers, depth + 1)
            parts.append(inner if value == "yes" else {"not": inner})
        else:
            parts.append({"unknown": dedent(entry.raw) if key else ""})
    return {"all": parts}


def effect_steps(block, triggers, condition=None):
    """The laws a starting effect activates, in order: [{law, cond}] (cond None: always)."""
    steps = []

    def both(a, b):
        return b if a is None else a if b is None else {"all": [a, b]}

    before = []  # conditions of the if / else_if before an else
    for entry in block.entries:
        key, value = entry.key, entry.value
        if key == "activate_law" and isinstance(value, str) and value.startswith("law_type:"):
            steps.append({"law": value[len("law_type:"):], "cond": condition})
        elif key in ("if", "else_if", "else") and isinstance(value, Block):
            if key == "if":
                before = []
            limit = value.get("limit")
            own = _condition(limit, triggers) if isinstance(limit, Block) else None
            missed = [{"not": c} for c in before]
            cond = condition
            for part in [*missed, *([own] if own and key != "else" else [])]:
                cond = both(cond, part)
            steps += effect_steps(value, triggers, cond)
            if key == "else":
                before = []
            elif own:
                before.append(own)
    return steps


def tech_tier_techs(block):
    """The era and technologies an effect_starting_technology_tier_N_tech effect gives."""
    return {"eras": [e.value for e in block.entries if e.key == "add_era_researched" and isinstance(e.value, str)],
            "techs": [e.value for e in block.entries
                      if e.key == "add_technology_researched" and isinstance(e.value, str)]}


# --------------------------------------------------------------- the model

def is_country(start):
    """A start of one country: of the game's ("override") or a new one of the mod ("new")."""
    return start.get("mode") in ("override", "new")


def empty_start(key="", mode="override"):
    """What a mod changes in one country's start. None (and missing laws) leave the game's as it is.

    The territory fields are described in territory.py, diplomacy and treaties in diplomacy.py,
    characters in characters.py, the flag of a new country in flags.py. A new country ("new") has its
    whole definition in `definition`, and no history of the game's.
    """
    return {"key": key, "mode": mode, "names": {}, "adjs": {}, "defs": {}, "definition": {}, "laws": {},
            "ig_names": {}, "ruling_party": None, **{name: None for name in HISTORY_FIELDS},
            **{name: None for name in POPULATION_FIELDS},
            "gains": [], "releases": [], "state_types": {}, "homelands": {}, "claims": {"add": [], "remove": []},
            "pops": {}, "buildings": {},
            "diplomacy": None, "treaties_added": [], "treaties_removed": [], "characters": None, "flag": None}


def fill_start(stored):
    """A country start from a project file, with fields added by later versions of the tool filled in."""
    start = {**empty_start(), **stored}
    blank = empty_start()
    for name in ("names", "adjs", "defs", "definition", "laws", "ig_names", "state_types", "homelands", "claims",
                 "pops", "buildings", "gains", "releases", "treaties_added", "treaties_removed"):
        if not isinstance(start.get(name), type(blank[name])):
            start[name] = blank[name]
    start["claims"] = {"add": [], "remove": [], **start["claims"]}
    for name in ("diplomacy", "characters"):
        if not isinstance(start.get(name), list):
            start[name] = None
    if not isinstance(start.get("flag"), dict):
        start["flag"] = None
    return start


def _key(value, field):
    value = str(value or "").strip()
    if value and not KEY_PATTERN.match(value):
        raise ValueError(field)
    return value


def _keys(values, field):
    if not isinstance(values, list):
        raise ValueError(field)
    return list(dict.fromkeys(_key(v, field) for v in values if str(v or "").strip()))


def normalize_start(raw):
    """Bring a country start sent by the browser into the model's shape (ValueError when it cannot be)."""
    mode = raw.get("mode") if raw.get("mode") in ("all", "new") else "override"
    start = empty_start(ALL_COUNTRIES if mode == "all" else str(raw.get("key") or "").strip(), mode)
    if mode != "all" and not (NEW_TAG_PATTERN if mode == "new" else TAG_PATTERN).match(start["key"]):
        raise ValueError("key")
    laws = raw.get("laws") or {}
    if not isinstance(laws, dict):
        raise ValueError("laws")
    start["laws"] = {_key(group, "laws"): _key(law, "laws") for group, law in laws.items() if law}
    if mode == "all":
        return start
    for name in ("names", "adjs", "defs"):
        start[name] = clean_names(raw.get(name))
    definition = raw.get("definition") or {}
    if not isinstance(definition, dict):
        raise ValueError("definition")
    for name in DEFINITION_FIELDS:
        if name not in definition:
            continue
        value = definition[name]
        if name == "color":
            if not (isinstance(value, list) and len(value) == 3 and all(isinstance(n, int) for n in value)):
                raise ValueError("color")
            start["definition"]["color"] = [max(0, min(255, n)) for n in value]
        elif name == "cultures":
            start["definition"]["cultures"] = _keys(value, name)
        else:
            start["definition"][name] = _key(value, name)
    names = raw.get("ig_names") or {}
    if not isinstance(names, dict):
        raise ValueError("ig_names")
    start["ig_names"] = {_key(ig, "ig_names"): clean_names(texts) for ig, texts in names.items()}
    party = raw.get("ruling_party")
    start["ruling_party"] = None if party is None else _key(party, "ruling_party")
    for name in ("tax_level", "election", "wealth", "literacy"):
        value = raw.get(name)
        start[name] = None if value is None else " ".join(str(value).split())
    if start["election"] and not DATE_PATTERN.match(start["election"]):
        raise ValueError("election")
    for name in ("tax_level", "wealth", "literacy"):
        if start[name]:
            _key(start[name], name)
    tier = raw.get("tech_tier")
    if tier is not None:
        if not isinstance(tier, int) or not (tier == 0 or tier in TECH_TIERS):
            raise ValueError("tech_tier")
        start["tech_tier"] = tier
    for name in ("techs", "taxed_goods", "ruling"):
        if raw.get(name) is not None:
            start[name] = _keys(raw.get(name), name)
    if raw.get("tariffs") is not None:
        rows = raw["tariffs"]
        if not isinstance(rows, list) or not all(isinstance(r, dict) for r in rows):
            raise ValueError("tariffs")
        start["tariffs"] = [{"kind": "export" if r.get("kind") == "export" else "import",
                             "goods": _key(r.get("goods"), "tariffs"), "level": _key(r.get("level"), "tariffs")}
                            for r in rows]
    if raw.get("institutions") is not None:
        rows = raw["institutions"]
        if not isinstance(rows, list) or not all(isinstance(r, dict) for r in rows):
            raise ValueError("institutions")
        start["institutions"] = [{"institution": _key(r.get("institution"), "institutions"),
                                  "level": int(r.get("level") or 0)} for r in rows]
    if raw.get("extra") is not None:
        start["extra"] = str(raw["extra"]).replace("\r\n", "\n")
    _normalize_territory(start, raw)
    from .characters import normalize_characters
    from .diplomacy import normalize_diplomacy
    normalize_diplomacy(start, raw)
    normalize_characters(start, raw)
    if mode == "new":
        from .flags import normalize_flag
        start["flag"] = normalize_flag(raw.get("flag")) if raw.get("flag") is not None else None
    return start


def _provinces(values, field):
    if not isinstance(values, list):
        raise ValueError(field)
    found = []
    for value in values:
        value = str(value or "").strip().lstrip("xX").upper()
        if not PROVINCE_PATTERN.match(value):
            raise ValueError(field)
        found.append(value)
    return list(dict.fromkeys(found))


def _dict(raw, field):
    value = raw.get(field) or {}
    if not isinstance(value, dict):
        raise ValueError(field)
    return value


def _rows(value, field):
    if not isinstance(value, list) or not all(isinstance(row, dict) for row in value):
        raise ValueError(field)
    return value


def _count(value, field, low=0):
    if isinstance(value, bool) or not isinstance(value, int) or value < low:
        raise ValueError(field)
    return value


def normalize_pop(raw):
    return {"culture": _key(raw.get("culture"), "pops"), "religion": _key(raw.get("religion"), "pops"),
            "pop_type": _key(raw.get("pop_type"), "pops"), "size": _count(raw.get("size"), "pops"),
            "extra": str(raw.get("extra") or "").replace("\r\n", "\n")}


def normalize_building(raw):
    owners = []
    for owner in _rows(raw.get("ownership") or [], "buildings"):
        kind = owner.get("kind")
        if kind not in ("country", "building", "company"):
            raise ValueError("buildings")
        owners.append({"kind": kind, "country": _key(owner.get("country"), "buildings"),
                       "type": _key(owner.get("type"), "buildings") if kind != "country" else "",
                       "region": _key(owner.get("region"), "buildings") if kind == "building" else "",
                       "levels": _count(owner.get("levels"), "buildings", 1)})
    reserves, subsidized = raw.get("reserves"), raw.get("subsidized")
    return {"building": _key(raw.get("building"), "buildings"), "level": _count(raw.get("level") or 0, "buildings"),
            "ownership": owners, "reserves": None if reserves is None else _count(reserves, "buildings"),
            "pms": _keys(raw.get("pms") or [], "buildings"),
            "subsidized": None if subsidized is None else bool(subsidized),
            "extra": str(raw.get("extra") or "").replace("\r\n", "\n")}


def _normalize_territory(start, raw):
    start["gains"] = _provinces(raw.get("gains") or [], "gains")
    start["releases"] = _provinces(raw.get("releases") or [], "releases")
    for state, kind in _dict(raw, "state_types").items():
        if kind not in ("incorporated", "unincorporated"):
            raise ValueError("state_types")
        start["state_types"][_key(state, "state_types")] = kind
    for state, change in _dict(raw, "homelands").items():
        if not isinstance(change, dict):
            raise ValueError("homelands")
        add, remove = _keys(change.get("add") or [], "homelands"), _keys(change.get("remove") or [], "homelands")
        if add or remove:
            start["homelands"][_key(state, "homelands")] = {"add": add, "remove": remove}
    claims = _dict(raw, "claims")
    start["claims"] = {"add": _keys(claims.get("add") or [], "claims"),
                       "remove": _keys(claims.get("remove") or [], "claims")}
    for state, pops in _dict(raw, "pops").items():
        start["pops"][_key(state, "pops")] = [normalize_pop(pop) for pop in _rows(pops, "pops")]
    for state, buildings in _dict(raw, "buildings").items():
        start["buildings"][_key(state, "buildings")] = [normalize_building(b) for b in _rows(buildings, "buildings")]


def has_territory_changes(start):
    return bool(start["gains"] or start["releases"] or start["state_types"] or start["homelands"]
                or start["claims"]["add"] or start["claims"]["remove"] or start["pops"] or start["buildings"])


def is_empty_start(start):
    """True when a start changes nothing (everything was put back as the game has it). A new country
    is never empty: it is there until it is deleted."""
    return start["mode"] != "new" and (not any(start[name] for name in ("names", "adjs", "defs", "definition", "laws", "ig_names",
                                             "treaties_added", "treaties_removed"))
            and start["ruling_party"] is None and start["diplomacy"] is None and start["characters"] is None
            and all(start[name] is None for name in (*HISTORY_FIELDS, *POPULATION_FIELDS))
            and not has_territory_changes(start))


def validate_start(start, game):
    """Error codes; empty means the start can be written.

    `game`: sets of the loaded keys ("countries", "laws" {law: group}, "groups", "goods", "techs", "igs",
    "institutions", "parties", "cultures", "states", "religions", "hierarchies"), with the mod's laws
    and law groups.
    """
    errors = []
    if start["mode"] == "override" and start["key"] not in game["countries"]:
        errors.append("country_unknown")
    if start["mode"] == "new":
        if start["key"] in game["countries"]:
            errors.append("key_exists")
        definition = start["definition"]
        for name in ("color", "country_type", "tier", "cultures", "capital"):
            if not definition.get(name):
                errors.append({"color": "color_missing", "capital": "capital_missing"}.get(name, name))
        if not any(start["names"].values()):
            errors.append("name_missing")
    for group, law in start["laws"].items():
        if game["laws"].get(law) != group or group not in game["groups"]:
            errors.append("law")
            break
    if start["mode"] == "all":
        return errors
    definition = start["definition"]
    if "country_type" in definition and definition["country_type"] not in COUNTRY_TYPES:
        errors.append("country_type")
    if "tier" in definition and definition["tier"] not in TIERS:
        errors.append("tier")
    if "cultures" in definition and (not definition["cultures"]
                                     or any(c not in game["cultures"] for c in definition["cultures"])):
        errors.append("cultures")
    if "capital" in definition and definition["capital"] not in game["states"]:
        errors.append("capital")
    if definition.get("religion") and definition["religion"] not in game["religions"]:
        errors.append("religion")
    if definition.get("social_hierarchy") and definition["social_hierarchy"] not in game["hierarchies"]:
        errors.append("social_hierarchy")
    if start["tax_level"] and start["tax_level"] not in TAX_LEVELS:
        errors.append("tax_level")
    if start["wealth"] and start["wealth"] not in WEALTH_LEVELS:
        errors.append("wealth")
    if start["literacy"] and start["literacy"] not in LITERACY_LEVELS:
        errors.append("literacy")
    if any(goods not in game["goods"] for goods in start["taxed_goods"] or []):
        errors.append("goods")
    if any(row["goods"] not in game["goods"] or row["level"] not in TARIFF_LEVELS for row in start["tariffs"] or []):
        errors.append("tariffs")
    if any(row["institution"] not in game["institutions"] or row["level"] not in INSTITUTION_LEVELS
           for row in start["institutions"] or []):
        errors.append("institutions")
    if any(tech not in game["techs"] for tech in start["techs"] or []):
        errors.append("techs")
    if any(ig not in game["igs"] for ig in [*(start["ruling"] or []), *start["ig_names"]]):
        errors.append("igs")
    if start["ruling_party"] and start["ruling_party"] not in game["parties"]:
        errors.append("ruling_party")
    if start["extra"] is not None and not braces_balanced(start["extra"]):
        errors.append("braces:extra")
    errors += _territory_errors(start, game)
    if start["mode"] == "new" and "patterns" in game:  # stage 4 (the flag of a new country)
        from .flags import flag_errors
        errors += flag_errors(start["flag"], game)
    if "articles" in game:  # stage 3 (diplomacy, treaties and characters)
        from .characters import character_errors
        from .diplomacy import diplomacy_errors
        errors += diplomacy_errors(start, game) + character_errors(start, game)
    return list(dict.fromkeys(errors))


def _territory_errors(start, game):
    """`game` also has "provinces", "pop_types", "buildings", "pms", "companies" (sets of keys)."""
    errors = []
    if any(p not in game["provinces"] for p in [*start["gains"], *start["releases"]]):
        errors.append("provinces")
    states = [*start["state_types"], *start["homelands"], *start["claims"]["add"], *start["claims"]["remove"],
              *start["pops"], *start["buildings"]]
    if any(state not in game["states"] for state in states):
        errors.append("states")
    if any(c not in game["cultures"] for change in start["homelands"].values() for c in change["add"]):
        errors.append("cultures")
    pops = [pop for pops in start["pops"].values() for pop in pops]
    if any(pop["culture"] not in game["cultures"] or (pop["religion"] and pop["religion"] not in game["religions"])
           or (pop["pop_type"] and pop["pop_type"] not in game["pop_types"]) for pop in pops):
        errors.append("pops")
    buildings = [b for items in start["buildings"].values() for b in items]
    for building in buildings:
        bad_owner = any(owner["country"] not in game["countries"]
                        or (owner["kind"] == "building" and (owner["type"] not in game["buildings"]
                                                             or owner["region"] not in game["states"]))
                        or (owner["kind"] == "company" and owner["type"] not in game["companies"])
                        for owner in building["ownership"])
        if (building["building"] not in game["buildings"] or bad_owner
                or any(pm not in game["pms"] for pm in building["pms"])):
            errors.append("buildings")
            break
    if any(not braces_balanced(item["extra"]) for item in [*pops, *buildings]):
        errors.append("braces:extra")
    return errors


# ----------------------------------------------------------------- patching

def _line_span(text, start, end):
    """The span to cut for a statement: its whole line(s) with a trailing comment, when it has them alone."""
    line_start = text.rfind("\n", 0, start) + 1
    line_end = text.find("\n", end)
    line_end = len(text) if line_end < 0 else line_end
    rest = text[end:line_end].strip()
    if not text[line_start:start].strip() and (not rest or rest.startswith("#")):
        return line_start, min(line_end + 1, len(text))
    return start, end


def _indent_of(text, position):
    line_start = text.rfind("\n", 0, position) + 1
    prefix = text[line_start:position]
    return prefix if not prefix.strip() else re.match(r"[ \t]*", prefix).group(0)


def _reindent(text, indent):
    return "".join(indent + line + "\n" if line.strip() else "\n" for line in text.split("\n"))


class Patcher:
    """Edits of one file's text, applied together. Spans never overlap."""

    def __init__(self, text):
        self.text = text
        self.edits = []  # (start, end, replacement)

    def remove(self, entry, blank=False):
        """Take a statement out; `blank`: with the empty line before it, when it is on lines of its own."""
        start, end = _line_span(self.text, entry.start, entry.end)
        if blank and start != entry.start and start > 0:
            before = self.text.rfind("\n", 0, start - 1) + 1
            if not self.text[before:start].strip():
                start = before
        self.edits.append((start, end, ""))

    def replace(self, entry, lines):
        """Put lines (statements) where the entry was."""
        start, end = _line_span(self.text, entry.start, entry.end)
        if start == entry.start:  # shares its line with other statements
            self.edits.append((start, end, " ".join(lines)))
        else:
            self.edits.append((start, end, _reindent("\n".join(lines), _indent_of(self.text, entry.start))))

    def insert_after(self, entry, lines, indent):
        _start, end = _line_span(self.text, entry.start, entry.end)
        if end == entry.end:
            self.edits.append((end, end, " " + " ".join(lines)))
        else:
            self.edits.append((end, end, _reindent("\n".join(lines), indent)))

    def insert_end(self, block, lines, indent):
        """Add lines at the end of a block, before its closing brace."""
        close = block.end - 1
        line_start = self.text.rfind("\n", 0, close) + 1
        if not self.text[line_start:close].strip():
            self.edits.append((line_start, line_start, _reindent("\n".join(lines), indent)))
        else:
            self.edits.append((close, close, "\n" + _reindent("\n".join(lines), indent)
                               + _indent_of(self.text, block.start)))

    def result(self):
        # the same statement taken out twice counts once, and nothing is done inside what is taken out
        # (as a treaty of a DLC condition that goes as a whole)
        cuts = sorted({(start, end) for start, end, replacement in self.edits if not replacement and end > start})
        edits, seen = [], set()
        for start, end, replacement in self.edits:
            if not replacement and (start, end) in seen:
                continue
            if any((s < start < e) if start == end else (s <= start and end <= e and (s, e) != (start, end))
                   for s, e in cuts):
                continue
            if not replacement:
                seen.add((start, end))
            edits.append((start, end, replacement))
        # from the end of the file; of edits at one place the later one first, so they come out in order
        text = self.text
        order = sorted(range(len(edits)), key=lambda i: (edits[i][0], edits[i][1], i), reverse=True)
        for i in order:
            start, end, replacement = edits[i]
            text = text[:start] + replacement + text[end:]
        return text


def entry_indent(text, block):
    """The indentation of a block's statements."""
    for entry in block.entries:
        indent = _indent_of(text, entry.start)
        if text[text.rfind("\n", 0, entry.start) + 1:entry.start].strip() == "":
            return indent
    return _indent_of(text, block.start) + "\t"


def _scoped_block_lines(head, lines):
    """A block as lines; `head` is the key with its operator, as `ig:ig_devout ?=`."""
    return [f"{head} {{", *("\t" + line for line in lines), "}"]


class Scope:
    """One `c:TAG ?= { }` block of a history file, with the patcher of its file."""

    def __init__(self, patcher, entry):
        self.patcher = patcher
        self.entry = entry
        self.block = entry.value
        self.indent = entry_indent(patcher.text, self.block)


def _replace_kind(scopes, kinds, lines, after_kinds=()):
    """Take out every statement of these kinds; put `lines` where the first one was in the last scope,
    else after the last statement of `after_kinds` there, else at its end."""
    last = scopes[-1]
    placed = not lines
    for scope in scopes:
        for entry in scope.block.entries:
            if classify(entry)[0] not in kinds:
                continue
            if scope is last and not placed:
                scope.patcher.replace(entry, lines)
                placed = True
            else:
                scope.patcher.remove(entry)
    if placed:
        return
    anchors = [e for e in last.block.entries if classify(e)[0] in after_kinds]
    if anchors:
        last.patcher.insert_after(anchors[-1], lines, last.indent)
    else:
        last.patcher.insert_end(last.block, lines, last.indent)


def _patch_laws(scopes, laws, law_group):
    """Changed starting laws: the group's own activate_law lines are replaced; the starting presets
    (effect_starting_politics_*) stay, and a new line comes after them so that it wins."""
    if not laws:
        return
    last = scopes[-1]
    presets = [e for e in last.block.entries if classify(e)[0] == "politics"]
    last_preset = presets[-1].start if presets else -1
    pending = []
    for group, law in laws.items():
        line = f"activate_law = law_type:{law}"
        placed = False
        for scope in scopes:
            for entry in scope.block.entries:
                kind, value = classify(entry)
                if kind != "law" or law_group(value) != group:
                    continue
                if scope is last and not placed and entry.start > last_preset:
                    scope.patcher.replace(entry, [line])
                    placed = True
                else:
                    scope.patcher.remove(entry)
        if not placed:
            pending.append(line)
    if pending:
        anchors = [e for e in last.block.entries if classify(e)[0] in ("law", "politics")]
        if anchors:
            last.patcher.insert_after(anchors[-1], pending, last.indent)
        else:
            last.patcher.insert_end(last.block, pending, last.indent)


def ig_name_key(slug, tag, ig):
    """Localization key of an interest group's name set by the mod."""
    return f"{slug}_{tag.lower()}_{ig}_name"


def _patch_igs(scopes, start, base_ruling, slug):
    """Ruling interest groups and their names, in the `ig:x ?= { }` blocks."""
    ruling = start["ruling"]
    names = start["ig_names"]
    if ruling is None and not names:
        return
    wanted_ruling = list(base_ruling if ruling is None else ruling)
    if ruling is not None:
        for scope in scopes:
            for entry in scope.block.entries:
                if classify(entry)[0] == "ruling_set":
                    scope.patcher.remove(entry)
    last = scopes[-1]
    # the last block of each interest group in the last scope gets its settings; others lose them
    last_blocks = {}
    for entry in last.block.entries:
        kind, ig = classify(entry)
        if kind == "ig":
            last_blocks[ig] = entry
    handled = set()
    for scope in scopes:
        for entry in scope.block.entries:
            kind, ig = classify(entry)
            if kind != "ig" or (ruling is None and ig not in names):
                continue
            keep_here = scope is last and last_blocks.get(ig) is entry
            lines = []
            for sub in entry.value.entries:
                if sub.key == "add_ruling_interest_group" and ruling is not None:
                    continue
                if sub.key == "set_interest_group_name" and ig in names:
                    continue
                lines += dedent(sub.raw).split("\n")
            if keep_here:
                handled.add(ig)
                if ruling is not None and ig in wanted_ruling:
                    lines.insert(0, "add_ruling_interest_group = yes")
                if names.get(ig):
                    lines.append(f"set_interest_group_name = {ig_name_key(slug, start['key'], ig)}")
            if not lines:
                scope.patcher.remove(entry)
            else:
                scope.patcher.replace(entry, _scoped_block_lines(f"{entry.key} {entry.op}", lines))
    new_blocks = []
    for ig in dict.fromkeys([*(wanted_ruling if ruling is not None else []), *names]):
        if ig in handled:
            continue
        lines = []
        if ruling is not None and ig in wanted_ruling:
            lines.append("add_ruling_interest_group = yes")
        if names.get(ig):
            lines.append(f"set_interest_group_name = {ig_name_key(slug, start['key'], ig)}")
        if lines:
            new_blocks += _scoped_block_lines(f"ig:{ig} ?=", lines)
    if new_blocks:
        anchors = [e for e in last.block.entries if classify(e)[0] == "ig"]
        if anchors:
            last.patcher.insert_after(anchors[-1], new_blocks, last.indent)
        else:
            last.patcher.insert_end(last.block, new_blocks, last.indent)


def history_lines(start, slug, base_ruling=()):
    """The statements of a history block written from scratch (a country that has none)."""
    lines = [f"activate_law = law_type:{law}" for law in start["laws"].values()]
    if start["tech_tier"]:
        lines.append(f"effect_starting_technology_tier_{start['tech_tier']}_tech = yes")
    lines += [f"add_technology_researched = {tech}" for tech in start["techs"] or []]
    if start["tax_level"]:
        lines.append(f"set_tax_level = {start['tax_level']}")
    lines += [f"add_taxed_goods = g:{goods}" for goods in start["taxed_goods"] or []]
    lines += [_tariff_line(row) for row in start["tariffs"] or []]
    lines += [_institution_line(row) for row in start["institutions"] or []]
    if start["election"]:
        lines.append(f"set_next_election_date = {start['election']}")
    ruling = list(base_ruling if start["ruling"] is None else start["ruling"])
    for ig in dict.fromkeys([*ruling, *(ig for ig, texts in start["ig_names"].items() if texts)]):
        inner = ["add_ruling_interest_group = yes"] if ig in ruling else []
        if start["ig_names"].get(ig):
            inner.append(f"set_interest_group_name = {ig_name_key(slug, start['key'], ig)}")
        lines += _scoped_block_lines(f"ig:{ig} ?=", inner)
    if start["extra"]:
        lines += start["extra"].strip("\n").split("\n")
    return lines


def _tariff_line(row):
    kind = "set_export_tariff_level" if row["kind"] == "export" else "set_import_tariff_level"
    return f"{kind} = {{ goods = g:{row['goods']} level = {row['level']} }}"


def _institution_line(row):
    return f"set_institution_investment_level = {{ institution = {row['institution']} level = {row['level']} }}"


def has_history_changes(start):
    return bool(start["laws"]) or bool(start["ig_names"]) or any(start[name] is not None for name in HISTORY_FIELDS)


def patch_history(scopes, start, law_group, base_ruling, slug):
    """Apply a country's changes to its `c:TAG ?= { }` blocks of the country history (in load order)."""
    _patch_laws(scopes, start["laws"], law_group)
    if start["tech_tier"] is not None:
        tier = [f"effect_starting_technology_tier_{start['tech_tier']}_tech = yes"] if start["tech_tier"] else []
        _replace_kind(scopes, ("tech_tier",), tier, ("politics",))
    # field: (statement kind, its lines, kinds to put them after when there were none)
    simple = {
        "techs": ("tech", lambda value: [f"add_technology_researched = {tech}" for tech in value], ("tech_tier",)),
        "tax_level": ("tax_level", lambda value: [f"set_tax_level = {value}"] if value else [], ("tech", "tech_tier")),
        "taxed_goods": ("taxed_goods", lambda value: [f"add_taxed_goods = g:{goods}" for goods in value],
                        ("tax_level",)),
        "tariffs": ("tariffs", lambda value: [_tariff_line(row) for row in value], ()),
        "institutions": ("institutions", lambda value: [_institution_line(row) for row in value], ()),
        "election": ("election", lambda value: [f"set_next_election_date = {value}"] if value else [], ()),
    }
    for name, (kind, lines, after) in simple.items():
        if start[name] is not None:
            _replace_kind(scopes, (kind,), lines(start[name]), after)
    _patch_igs(scopes, start, base_ruling, slug)
    if start["extra"] is not None:
        text = start["extra"].strip("\n")
        _replace_kind(scopes, ("other",), text.split("\n") if text.strip() else [])


def population_lines(start):
    lines = []
    if start["wealth"]:
        lines.append(f"effect_starting_pop_wealth_{start['wealth']} = yes")
    if start["literacy"]:
        lines.append(f"effect_starting_pop_literacy_{start['literacy']} = yes")
    return lines


def patch_population(scopes, start):
    last = scopes[-1]
    for name, pattern in (("wealth", _WEALTH), ("literacy", _LITERACY)):
        if start[name] is None:
            continue
        line = [f"effect_starting_pop_{name}_{start[name]} = yes"] if start[name] else []
        placed = not line
        for scope in scopes:
            for entry in scope.block.entries:
                if not (entry.key and pattern.match(entry.key)):
                    continue
                if scope is last and not placed:
                    scope.patcher.replace(entry, line)
                    placed = True
                else:
                    scope.patcher.remove(entry)
        if not placed:
            last.patcher.insert_end(last.block, line, last.indent)


def patch_government(scopes, start):
    """Move `set_ruling_party = yes` to the chosen party (none: no ruling party is set)."""
    party = start["ruling_party"]
    last = scopes[-1]
    placed = not party
    for scope in scopes:
        for entry in scope.block.entries:
            if not (entry.key and entry.key.startswith("py:") and isinstance(entry.value, Block)):
                continue
            mine = entry.key[3:] == party and scope is last and not placed
            kept = [sub for sub in entry.value.entries if sub.key != "set_ruling_party"]
            if len(kept) == len(entry.value.entries) and not mine:
                continue  # nothing to change in this block
            lines = [line for sub in kept for line in dedent(sub.raw).split("\n")]
            if mine:
                lines.insert(0, "set_ruling_party = yes")
                placed = True
            if lines:
                scope.patcher.replace(entry, _scoped_block_lines(f"{entry.key} {entry.op}", lines))
            else:
                scope.patcher.remove(entry)
    if not placed:
        last.patcher.insert_end(last.block, _scoped_block_lines(f"py:{party} ?=", ["set_ruling_party = yes"]),
                                last.indent)


def government_lines(start):
    return _scoped_block_lines(f"py:{start['ruling_party']} ?=", ["set_ruling_party = yes"]) if start["ruling_party"] else []


def definition_script(key, raw, changes):
    """`REPLACE_OR_CREATE:TAG = { }` from the definition in effect (its source text) with the changes put in."""
    text = f"{key} = {raw}"
    entry = next((e for e in parse(text).entries if isinstance(e.value, Block)), None)
    if entry is None:
        text, entry = f"{key} = {{\n}}", parse(f"{key} = {{\n}}").entries[0]
    patcher = Patcher(text)
    block = entry.value
    indent = entry_indent(text, block)
    for name in DEFINITION_FIELDS:
        if name not in changes:
            continue
        value = changes[name]
        if name == "color":
            line = f"color = {{ {value[0]} {value[1]} {value[2]} }}"
        elif name == "cultures":
            line = "cultures = { " + " ".join(value) + " }"
        else:
            line = f"{name} = {value}" if value else ""
        existing = [e for e in block.entries if e.key == name]
        if existing:
            for i, old in enumerate(existing):
                if i == 0 and line:
                    patcher.replace(old, [line])
                else:
                    patcher.remove(old)
        elif line:
            patcher.insert_end(block, [line], indent)
    return f"REPLACE_OR_CREATE:{patcher.result()}"


def new_definition_script(start):
    """The definition of a new country (a plain definition: the tag is not the game's)."""
    definition = start["definition"]
    color = definition.get("color") or [128, 128, 128]
    lines = [f"color = {{ {color[0]} {color[1]} {color[2]} }}"]
    for name in ("country_type", "tier"):
        if definition.get(name):
            lines.append(f"{name} = {definition[name]}")
    lines.append("cultures = { " + " ".join(definition.get("cultures") or []) + " }")
    for name in ("capital", "religion", "social_hierarchy"):
        if definition.get(name):
            lines.append(f"{name} = {definition[name]}")
    return "\n".join(_scoped_block_lines(f"{start['key']} =", lines))


def global_laws_script(all_laws, starts):
    """The laws every country starts with, then the countries the mod set a law of those groups for."""
    if not all_laws:
        return None
    lines = ["GLOBAL = {", "\tevery_country = {"]
    lines += [f"\t\tactivate_law = law_type:{law}" for law in all_laws.values()]
    lines.append("\t}")
    for start in starts:
        own = [law for group, law in start["laws"].items() if group in all_laws]
        if own:
            lines.append(f"\tc:{start['key']} ?= {{")
            lines += [f"\t\tactivate_law = law_type:{law}" for law in own]
            lines.append("\t}")
    lines.append("}")
    return "\n".join(lines)


def start_texts(start, lang, slug):
    """Localization of one start in one language: (replaced texts, new texts).

    The country's names replace the game's (a new country's are new keys); names of interest groups,
    treaties and new characters are new keys.
    """
    from .characters import character_texts
    from .diplomacy import start_treaty_texts
    replaced, new = {}, {}
    names = new if start["mode"] == "new" else replaced
    for field, suffix in (("names", ""), ("adjs", "_ADJ"), ("defs", "_DEF")):
        if start[field].get(lang):
            names[start["key"] + suffix] = start[field][lang]
    for ig, texts in start["ig_names"].items():
        if texts.get(lang):
            new[ig_name_key(slug, start["key"], ig)] = texts[lang]
    new.update(start_treaty_texts(start, lang, slug))
    new.update(character_texts(start, lang, slug))
    return replaced, new


def start_languages(start):
    from .characters import character_languages
    return {lang for field in ("names", "adjs", "defs") for lang, text in start[field].items() if text} | {
        lang for texts in start["ig_names"].values() for lang, text in texts.items() if text} | {
        lang for treaty in start["treaties_added"] for lang, text in treaty["names"].items() if text} | (
        character_languages(start))


# ------------------------------------------------------------------ writing

def new_file_name(start):
    """The history files of a new country: `<tag> - <English name, else the first name>.txt`."""
    name = start["names"].get("english") or next((n for n in start["names"].values() if n), "") or start["key"]
    name = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_") or start["key"].lower()
    return f"{start['key'].lower()} - {name}.txt"


def write_starts(starts, base, slug):
    """The history files a mod's country starts need: {game-relative path: text}.

    `base` gives what is in effect without this mod: base.files(kind, tag) -> paths of the files with
    the country's block (in load order), base.text(path) -> the file's text, base.law_group(law),
    base.ruling(tag) -> the ruling interest groups of its history.
    """
    from .characters import create_lines, patch_characters
    starts = [s for s in starts if is_country(s)]
    texts = {}
    patchers = {}

    def scopes_of(kind, tag):
        folder, top = HISTORY_DIRS[kind]
        found = []
        for rel in base.files(kind, tag):
            if rel not in patchers:
                text = base.text(rel)
                if text is None:
                    continue
                patchers[rel] = (Patcher(text), parse(text))
            patcher, root = patchers[rel]
            found += [Scope(patcher, entry) for scope_tag, entry in scope_blocks(root, top) if scope_tag == tag]
        return found

    fresh = {kind: [] for kind in HISTORY_DIRS}  # blocks for countries that have none
    for start in starts:
        tag = start["key"]
        parts = {
            "countries": (has_history_changes(start),
                          lambda scopes: patch_history(scopes, start, base.law_group, base.ruling(tag), slug),
                          lambda: history_lines(start, slug, base.ruling(tag))),
            "population": (any(start[name] is not None for name in POPULATION_FIELDS),
                           lambda scopes: patch_population(scopes, start), lambda: population_lines(start)),
            "governments": (start["ruling_party"] is not None,
                            lambda scopes: patch_government(scopes, start), lambda: government_lines(start)),
            "characters": (start["characters"] is not None,
                           lambda scopes: patch_characters(scopes, start, slug), lambda: create_lines(start, slug)),
        }
        for kind, (wanted, patch, lines) in parts.items():
            if not wanted:
                continue
            scopes = scopes_of(kind, tag) if start["mode"] == "override" else []
            if scopes:
                patch(scopes)
            elif lines() and start["mode"] == "new":  # a new country has files of its own
                folder, top = HISTORY_DIRS[kind]
                body = "".join(f"\t{line}\n" for line in _scoped_block_lines(f"c:{tag} ?=", lines()))
                texts[f"{folder}/{new_file_name(start)}"] = f"{top} = {{\n{body}}}\n"
            elif lines():
                fresh[kind].append(_scoped_block_lines(f"c:{tag} ?=", lines()))
    for rel, (patcher, _root) in patchers.items():
        if patcher.edits:
            texts[rel] = patcher.result()
    for kind, blocks in fresh.items():
        if blocks:
            folder, top = HISTORY_DIRS[kind]
            body = "\n".join("\t" + line for block in blocks for line in block)
            texts[f"{folder}/zzz_{slug}_{kind}.txt"] = f"{top} = {{\n{body}\n}}\n"
    return texts
