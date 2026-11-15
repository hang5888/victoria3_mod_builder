"""Converting buildings ("factories") between game script and the builder's data model.

A factory is a building with its production method groups (PMGs). A group in the
list is either a reference to an existing group, or one of the factory's own:
written out by this mod, as a new group or as an override of an existing one.
The production methods (PMs) of an own group work the same way.

As with companies, fields without a real editor are kept as raw script text.
"""
import re

from .companies import KEY_PATTERN, MODIFIER_VALUE_PATTERN, _indent, _quote, clean_names
from .pdx_script import Block, braces_balanced, dedent

RAW_BLOCKS = ("potential", "possible")
SCALAR_FIELDS = ("building_group", "icon", "background", "city_type", "required_construction")
MODIFIER_TARGETS = ("building", "state", "country")
SCALES = ("workforce_scaled", "level_scaled", "unscaled", "throughput_scaled")
NUMBER_PATTERN = re.compile(r"^-?\d+(\.\d+)?$")
_TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_.\-@]+$")
_INPUT = re.compile(r"^goods_input_(.+)_add$")
_OUTPUT = re.compile(r"^goods_output_(.+)_add$")
_EMPLOYMENT = re.compile(r"^building_employment_(.+)_add$")

# The game makes these modifiers for every building; new buildings need names for them.
# Used when the loaded game data has no text to copy (see modifier_texts).
MODIFIER_TEMPLATE_BUILDING = "building_food_industry"
MODIFIER_SUFFIXES = ("_throughput_add", "_throughput_add_desc")
DEFAULT_MODIFIER_TEXTS = {
    "_throughput_add": "$building_food_industry$ building [concept_throughput]",
    "_throughput_add_desc": "A bonus or penalty to both input and output of $building_food_industry$",
}


# ------------------------------------------------------------------- models

def empty_pm():
    return {"type": "own", "key": "", "mode": "new", "names": {}, "texture": "", "is_default": False,
            "inputs": [], "outputs": [], "employment": [], "unlocking_technologies": [], "unlocking_laws": [],
            "modifiers": [], "extra": ""}


def empty_pmg():
    return {"type": "own", "key": "", "mode": "new", "names": {}, "texture": "", "pms": [], "extra": ""}


def empty_factory():
    factory = {"key": "", "mode": "new", "names": {}, "unlocking_technologies": [], "ai_value": "",
               "blocks": {name: "" for name in RAW_BLOCKS}, "pmgs": [], "extra": ""}
    for field in SCALAR_FIELDS:
        factory[field] = ""
    return factory


# ------------------------------------------------------------------ reading

def _add_items(target, block):
    for item in block.items():
        if item not in target:
            target.append(item)


def _plain_modifiers(block):
    """True if a `*_modifiers` block is only `scale = { key = value ... }` groups."""
    for scale in block.entries:
        if scale.key not in SCALES or scale.op != "=" or not isinstance(scale.value, Block):
            return False
        for entry in scale.value.entries:
            if not entry.key or entry.op != "=" or not isinstance(entry.value, str):
                return False
    return True


def pm_from_block(key, block):
    pm = empty_pm()
    pm["key"] = key
    extra = []
    for entry in block.entries:
        name, value = entry.key, entry.value
        target = name[:-len("_modifiers")] if name and name.endswith("_modifiers") else None
        if name == "texture" and isinstance(value, str):
            pm["texture"] = value
        elif name == "is_default" and isinstance(value, str):
            pm["is_default"] = value == "yes"
        elif name in ("unlocking_technologies", "unlocking_laws") and isinstance(value, Block):
            _add_items(pm[name], value)
        elif target in MODIFIER_TARGETS and isinstance(value, Block) and _plain_modifiers(value):
            for scale in value.entries:
                for modifier in scale.value.entries:
                    _read_modifier(pm, target, scale.key, modifier.key, modifier.value)
        else:
            extra.append(dedent(entry.raw))
    pm["extra"] = "\n".join(extra)
    return pm


def _read_modifier(pm, target, scale, key, value):
    if target == "building" and scale == "workforce_scaled":
        for pattern, field in ((_INPUT, "inputs"), (_OUTPUT, "outputs")):
            match = pattern.match(key)
            if match:
                pm[field].append({"good": match.group(1), "amount": value})
                return
    if target == "building" and scale == "level_scaled":
        match = _EMPLOYMENT.match(key)
        if match:
            pm["employment"].append({"pop": match.group(1), "amount": value})
            return
    pm["modifiers"].append({"target": target, "scale": scale, "key": key, "value": value})


def pmg_from_block(key, block):
    """A group as it is defined; its production methods are references (keys)."""
    pmg = empty_pmg()
    pmg["key"] = key
    extra = []
    for entry in block.entries:
        if entry.key == "texture" and isinstance(entry.value, str):
            pmg["texture"] = entry.value
        elif entry.key == "production_methods" and isinstance(entry.value, Block):
            for item in entry.value.items():
                if not any(pm["key"] == item for pm in pmg["pms"]):
                    pmg["pms"].append({"type": "ref", "key": item})
        else:
            extra.append(dedent(entry.raw))
    pmg["extra"] = "\n".join(extra)
    return pmg


def factory_from_block(key, block):
    factory = empty_factory()
    factory["key"] = key
    extra = []
    for entry in block.entries:
        name, value = entry.key, entry.value
        if name in SCALAR_FIELDS and isinstance(value, str):
            factory[name] = value
        elif name == "unlocking_technologies" and isinstance(value, Block):
            _add_items(factory[name], value)
        elif name == "production_method_groups" and isinstance(value, Block):
            for item in value.items():
                if not any(pmg["key"] == item for pmg in factory["pmgs"]):
                    factory["pmgs"].append({"type": "ref", "key": item})
        elif name == "ai_value":
            factory["ai_value"] = value.inner() if isinstance(value, Block) else value
        elif name in RAW_BLOCKS and isinstance(value, Block):
            text = value.inner()
            previous = factory["blocks"][name]
            factory["blocks"][name] = f"{previous}\n{text}" if previous and text else previous or text
        else:
            extra.append(dedent(entry.raw))
    factory["extra"] = "\n".join(extra)
    return factory


# -------------------------------------------------------------- normalizing

def _text(value):
    return " ".join(str(value or "").split())


def _script(value):
    return str(value or "").replace("\r\n", "\n")


def _keys(raw, field):
    items = raw.get(field) or []
    if not isinstance(items, list) or not all(isinstance(i, str) and KEY_PATTERN.match(i) for i in items):
        raise ValueError(field)
    return list(dict.fromkeys(items))


def _rows(raw, field, names):
    rows = raw.get(field) or []
    if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
        raise ValueError(field)
    return [{name: _text(row.get(name)) for name in names} for row in rows]


def _reference(raw):
    key = _text(raw.get("key"))
    if not KEY_PATTERN.match(key):
        raise ValueError("key")
    return {"type": "ref", "key": key}


def _own(raw, empty):
    item = empty()
    item["key"] = _text(raw.get("key"))
    item["mode"] = "override" if raw.get("mode") == "override" else "new"
    item["names"] = clean_names(raw.get("names"))
    item["texture"] = _text(raw.get("texture"))
    item["extra"] = _script(raw.get("extra"))
    return item


def _children(raw, field, normalize_own):
    items = raw.get(field) or []
    if not isinstance(items, list) or not all(isinstance(item, dict) for item in items):
        raise ValueError(field)
    return [_reference(item) if item.get("type") == "ref" else normalize_own(item) for item in items]


def normalize_pm(raw):
    pm = _own(raw, empty_pm)
    pm["is_default"] = bool(raw.get("is_default"))
    pm["inputs"] = _rows(raw, "inputs", ("good", "amount"))
    pm["outputs"] = _rows(raw, "outputs", ("good", "amount"))
    pm["employment"] = _rows(raw, "employment", ("pop", "amount"))
    pm["modifiers"] = _rows(raw, "modifiers", ("target", "scale", "key", "value"))
    pm["unlocking_technologies"] = _keys(raw, "unlocking_technologies")
    pm["unlocking_laws"] = _keys(raw, "unlocking_laws")
    return pm


def normalize_pmg(raw):
    pmg = _own(raw, empty_pmg)
    pmg["pms"] = _children(raw, "pms", normalize_pm)
    return pmg


def normalize_factory(raw):
    """Bring a factory sent by the browser into the model's shape (ValueError when it cannot be)."""
    factory = empty_factory()
    factory["key"] = _text(raw.get("key"))
    factory["mode"] = "override" if raw.get("mode") == "override" else "new"
    factory["names"] = clean_names(raw.get("names"))
    for field in SCALAR_FIELDS:
        factory[field] = _text(raw.get(field))
    factory["unlocking_technologies"] = _keys(raw, "unlocking_technologies")
    factory["ai_value"] = _script(raw.get("ai_value")).strip()
    blocks = raw.get("blocks") or {}
    if not isinstance(blocks, dict):
        raise ValueError("blocks")
    for name in RAW_BLOCKS:
        factory["blocks"][name] = _script(blocks.get(name))
    factory["pmgs"] = _children(raw, "pmgs", normalize_pmg)
    factory["extra"] = _script(raw.get("extra"))
    return factory


def fill_factory(stored):
    """A factory from a project file, with fields added by later versions of the tool filled in."""
    factory = {**empty_factory(), **stored, "blocks": {**empty_factory()["blocks"], **stored.get("blocks", {})}}
    factory["pmgs"] = [pmg if pmg.get("type") == "ref" else {
        **empty_pmg(), **pmg,
        "pms": [pm if pm.get("type") == "ref" else {**empty_pm(), **pm} for pm in pmg.get("pms", [])],
    } for pmg in factory["pmgs"]]
    return factory


# --------------------------------------------------------------- validating

def own_keys(factories):
    """Keys written by these factories: {"buildings": set, "pmgs": set, "pms": set}."""
    keys = {"buildings": set(), "pmgs": set(), "pms": set()}
    for factory in factories:
        keys["buildings"].add(factory["key"])
        for pmg in factory["pmgs"]:
            if pmg["type"] != "own":
                continue
            keys["pmgs"].add(pmg["key"])
            keys["pms"].update(pm["key"] for pm in pmg["pms"] if pm["type"] == "own")
    return keys


def _check_key(item, game, project, seen, errors, prefix):
    """Key rules shared by buildings, groups and methods. `seen`: keys of this kind in the factory so far."""
    key = item["key"]
    if not key:
        errors.append(f"{prefix}key_missing")
    elif not KEY_PATTERN.match(key):
        errors.append(f"{prefix}key_invalid:{key}")
    elif key in seen or key in project or (item["mode"] != "override" and key in game):
        errors.append(f"{prefix}key_exists:{key}")
    seen.add(key)


def validate_factory(factory, game, project):
    """Error codes; empty means the factory can be written.

    `game`: keys that exist in the game data, `project`: keys written by the
    other factories of the mod; both shaped like the result of own_keys().
    """
    errors = []
    _check_key(factory, game["buildings"], project["buildings"], set(), errors, "")
    if not factory["building_group"]:
        errors.append("group_missing")
    elif not KEY_PATTERN.match(factory["building_group"]):
        errors.append("group_invalid")
    if not factory["icon"]:
        errors.append("icon_missing")
    if factory["city_type"] and not KEY_PATTERN.match(factory["city_type"]):
        errors.append("city_type_invalid")
    cost = factory["required_construction"]
    if cost and not (KEY_PATTERN.match(cost) or NUMBER_PATTERN.match(cost)):
        errors.append("construction_invalid")
    for name in RAW_BLOCKS:
        if not braces_balanced(factory["blocks"][name]):
            errors.append(f"braces:{name}")
    for name in ("ai_value", "extra"):
        if not braces_balanced(factory[name]):
            errors.append(f"braces:{name}")
    if not factory["pmgs"]:
        errors.append("pmgs_missing")
    seen_pmgs, seen_pms = set(), set()
    for pmg in factory["pmgs"]:
        if pmg["type"] == "ref":
            if pmg["key"] in seen_pmgs:
                errors.append(f"pmg_key_exists:{pmg['key']}")
            seen_pmgs.add(pmg["key"])
            continue
        _check_key(pmg, game["pmgs"], project["pmgs"], seen_pmgs, errors, "pmg_")
        label = pmg["key"] or "?"
        if not pmg["pms"]:
            errors.append(f"pmg_empty:{label}")
        if not braces_balanced(pmg["extra"]):
            errors.append(f"braces:{label}")
        listed = set()
        for pm in pmg["pms"]:
            if pm["key"] in listed:
                errors.append(f"pm_key_exists:{pm['key']}")
            listed.add(pm["key"])
            if pm["type"] == "own":
                _check_key(pm, game["pms"], project["pms"], seen_pms, errors, "pm_")
                errors.extend(_pm_errors(pm))
    return list(dict.fromkeys(errors))


def _pm_errors(pm):
    label = pm["key"] or "?"
    errors = []
    amounts = [(row["good"], row["amount"]) for row in pm["inputs"] + pm["outputs"]]
    amounts += [(row["pop"], row["amount"]) for row in pm["employment"]]
    if not all(KEY_PATTERN.match(key) and NUMBER_PATTERN.match(amount) for key, amount in amounts):
        errors.append(f"pm_value:{label}")
    for modifier in pm["modifiers"]:
        if not (modifier["target"] in MODIFIER_TARGETS and modifier["scale"] in SCALES
                and KEY_PATTERN.match(modifier["key"]) and MODIFIER_VALUE_PATTERN.match(modifier["value"])):
            errors.append(f"pm_value:{label}")
    if not braces_balanced(pm["extra"]):
        errors.append(f"braces:{label}")
    return errors


# ------------------------------------------------------------------ writing

def _head(item):
    """Overrides replace the original whether or not the mod that defined it is loaded."""
    return f"REPLACE_OR_CREATE:{item['key']}" if item.get("mode") == "override" else item["key"]


def _list(out, name, items):
    out.append(f"\t{name} = {{")
    out.extend(f"\t\t{item}" for item in items)
    out.append("\t}")
    out.append("")


def _finish(out, extra):
    extra = (extra or "").strip("\n")
    if extra.strip():
        out.append(_indent(extra, 1))
    while out[-1] == "":
        out.pop()
    out.append("}")
    return "\n".join(out)


def pm_to_script(pm):
    out = [f"{_head(pm)} = {{"]
    if pm["texture"]:
        out.append(f"\ttexture = {_quote(pm['texture'])}")
    if pm["is_default"]:
        out.append("\tis_default = yes")
    out.append("")
    for field in ("unlocking_technologies", "unlocking_laws"):
        if pm[field]:
            _list(out, field, pm[field])
    groups = {}  # (target, scale) -> lines, in the order the game files use
    for target in MODIFIER_TARGETS:
        for scale in SCALES:
            groups[(target, scale)] = []
    for row in pm["inputs"]:
        groups[("building", "workforce_scaled")].append(f"goods_input_{row['good']}_add = {row['amount']}")
    for row in pm["outputs"]:
        groups[("building", "workforce_scaled")].append(f"goods_output_{row['good']}_add = {row['amount']}")
    for row in pm["employment"]:
        groups[("building", "level_scaled")].append(f"building_employment_{row['pop']}_add = {row['amount']}")
    for modifier in pm["modifiers"]:
        groups[(modifier["target"], modifier["scale"])].append(f"{modifier['key']} = {modifier['value']}")
    for target in MODIFIER_TARGETS:
        scales = [(scale, groups[(target, scale)]) for scale in SCALES if groups[(target, scale)]]
        if not scales:
            continue
        out.append(f"\t{target}_modifiers = {{")
        for scale, lines in scales:
            out.append(f"\t\t{scale} = {{")
            out.extend(f"\t\t\t{line}" for line in lines)
            out.append("\t\t}")
        out.append("\t}")
        out.append("")
    return _finish(out, pm["extra"])


def pmg_to_script(pmg):
    out = [f"{_head(pmg)} = {{"]
    if pmg["texture"]:
        out.append(f"\ttexture = {_quote(pmg['texture'])}")
    _list(out, "production_methods", [pm["key"] for pm in pmg["pms"]])
    return _finish(out, pmg["extra"])


def factory_to_script(factory):
    out = [f"{_head(factory)} = {{"]
    out.append(f"\tbuilding_group = {factory['building_group']}")
    if factory["icon"]:
        out.append(f"\ticon = {_quote(factory['icon'])}")
    if factory["background"]:
        out.append(f"\tbackground = {_quote(factory['background'])}")
    if factory["city_type"]:
        out.append(f"\tcity_type = {factory['city_type']}")
    if factory["required_construction"]:
        out.append(f"\trequired_construction = {factory['required_construction']}")
    out.append("")
    if factory["unlocking_technologies"]:
        _list(out, "unlocking_technologies", factory["unlocking_technologies"])
    _list(out, "production_method_groups", [pmg["key"] for pmg in factory["pmgs"]])
    for name in RAW_BLOCKS:
        text = factory["blocks"][name].strip("\n")
        if text.strip():
            out.append(f"\t{name} = {{")
            out.append(_indent(text, 2))
            out.append("\t}")
            out.append("")
    ai_value = factory["ai_value"].strip("\n")
    if _TOKEN_PATTERN.match(ai_value.strip()):
        out.append(f"\tai_value = {ai_value.strip()}")
        out.append("")
    elif ai_value.strip():
        out.append("\tai_value = {")
        out.append(_indent(ai_value, 2))
        out.append("\t}")
        out.append("")
    return _finish(out, factory["extra"])


def own_pmgs(factories):
    return [pmg for factory in factories for pmg in factory["pmgs"] if pmg["type"] == "own"]


def own_pms(factories):
    return [pm for pmg in own_pmgs(factories) for pm in pmg["pms"] if pm["type"] == "own"]


def modifier_texts(factory, language, templates=None):
    """Names of the modifiers the game makes for a new building, in one language.

    `templates`: {suffix: text} for the language, written for MODIFIER_TEMPLATE_BUILDING.
    """
    texts = {**DEFAULT_MODIFIER_TEXTS, **(templates or {})}
    return {factory["key"] + suffix: texts[suffix].replace(MODIFIER_TEMPLATE_BUILDING, factory["key"])
            for suffix in MODIFIER_SUFFIXES}
