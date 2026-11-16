"""Laws and law groups: converting between game script and the builder's data model.

A law belongs to a law group: one of the game's, or a new one of the mod (existing groups are
not changed). Interest groups take their stance on a law from their ideologies, which this
tool does not change: a new law gets stances only through its `parent`, whose stances it
inherits (the game also treats it as a variant of the parent); the laws of a new group have no
parent, so every interest group is neutral about them.
Which laws countries start with belongs to the country starts (not made yet), not here; in a
new group, which no history sets, every country starts with the group's first law (the first
one the mod made, as the laws are written in the order they were made).

As with companies, fields without a real editor are kept as raw script text.
"""
import re

from .companies import KEY_PATTERN, MODIFIER_VALUE_PATTERN, _indent, _quote, clean_names
from .pdx_script import Block, braces_balanced, dedent

SCALAR_FIELDS = ("group", "icon", "progressiveness", "parent", "institution")
LIST_FIELDS = ("unlocking_technologies", "unlocking_laws", "requires_law_or", "disallowing_laws")
TAX_LEVELS = ("very_low", "low", "medium", "high", "very_high")
MODIFIER_FIELDS = ("modifier", "institution_modifier", "acceptance_modifier",
                   *(f"tax_modifier_{level}" for level in TAX_LEVELS))
# Trigger, effect and AI blocks, kept as raw script; written in this order.
RAW_BLOCKS = ("is_visible", "can_enact", "on_enact", "on_activate", "on_deactivate",
              "can_impose", "ai_impose_chance", "ai_will_do", "ai_enact_weight_modifier")
NUMBER_PATTERN = re.compile(r"^-?\d+(\.\d+)?$")


def empty_law():
    law = {"key": "", "mode": "new", "names": {}, "descs": {}, "modifiers": {name: [] for name in MODIFIER_FIELDS},
           "blocks": {name: "" for name in RAW_BLOCKS}, "extra": ""}
    for field in SCALAR_FIELDS:
        law[field] = ""
    for field in LIST_FIELDS:
        law[field] = []
    return law


def fill_law(stored):
    """A law from a project file, with fields added by later versions of the tool filled in."""
    law = {**empty_law(), **stored}
    law["modifiers"] = {**empty_law()["modifiers"], **(stored.get("modifiers") or {})}
    law["blocks"] = {**empty_law()["blocks"], **(stored.get("blocks") or {})}
    law.pop("start", None)  # starting laws were set here once; they belong to the country starts now
    return law


# ------------------------------------------------------------------ reading

def _plain(block):
    """True if a block is only `key = value` lines (a plain modifier list)."""
    return all(e.key and e.op == "=" and isinstance(e.value, str) for e in block.entries)


def _bare(block):
    """True if a block is only bare items, as `unlocking_laws = { law_a law_b }`."""
    return all(e.key is None and isinstance(e.value, str) for e in block.entries)


def law_from_block(key, block):
    """Build the data model from a parsed `law_x = { ... }` block."""
    law = empty_law()
    law["key"] = key
    extra = []
    for entry in block.entries:
        name, value = entry.key, entry.value
        if name in SCALAR_FIELDS and isinstance(value, str) and entry.op == "=" and not law[name]:
            law[name] = value
        elif name in LIST_FIELDS and isinstance(value, Block) and _bare(value):
            for item in value.items():
                if item not in law[name]:
                    law[name].append(item)
        elif name in MODIFIER_FIELDS and isinstance(value, Block) and _plain(value) and not law["modifiers"][name]:
            rows = {}
            for sub in value.entries:
                rows.pop(sub.key, None)  # the last value of a modifier counts
                rows[sub.key] = sub.value
            law["modifiers"][name] = [{"key": k, "value": v} for k, v in rows.items()]
        elif name in RAW_BLOCKS and isinstance(value, Block) and entry.op == "=":
            text = value.inner()
            previous = law["blocks"][name]
            law["blocks"][name] = f"{previous}\n{text}" if previous and text else previous or text
        else:
            extra.append(dedent(entry.raw))
    law["extra"] = "\n".join(extra)
    return law


def stances_from_block(block):
    """An ideology's stances on laws: {law: stance}, from its `lawgroup_x = { law_y = approve }` blocks."""
    stances = {}
    for entry in block.entries:
        if entry.key and entry.key.startswith("lawgroup_") and isinstance(entry.value, Block):
            for sub in entry.value.entries:
                if sub.key and isinstance(sub.value, str):
                    stances[sub.key] = sub.value
    return stances


# ---------------------------------------------------------------- checking

def _keys(raw, field):
    items = raw.get(field) or []
    if not isinstance(items, list) or not all(isinstance(i, str) and KEY_PATTERN.match(i) for i in items):
        raise ValueError(field)
    return list(dict.fromkeys(items))


def normalize_law(raw):
    """Bring a law sent by the browser into the model's shape.

    Raises ValueError when it cannot be: the result is written into script files.
    """
    law = empty_law()
    law["key"] = str(raw.get("key") or "").strip()
    law["mode"] = "override" if raw.get("mode") == "override" else "new"
    law["names"] = clean_names(raw.get("names"))
    law["descs"] = clean_names(raw.get("descs"))
    for field in SCALAR_FIELDS:
        law[field] = " ".join(str(raw.get(field) or "").split())
    for field in ("group", "parent", "institution"):
        if law[field] and not KEY_PATTERN.match(law[field]):
            raise ValueError(field)
    for field in LIST_FIELDS:
        law[field] = _keys(raw, field)
    modifiers = raw.get("modifiers") or {}
    if not isinstance(modifiers, dict):
        raise ValueError("modifiers")
    for name in MODIFIER_FIELDS:
        rows = modifiers.get(name) or []
        if not isinstance(rows, list) or not all(isinstance(m, dict) for m in rows):
            raise ValueError(name)
        law["modifiers"][name] = [{"key": str(m.get("key") or ""), "value": str(m.get("value") or "").strip()}
                                  for m in rows]
    blocks = raw.get("blocks") or {}
    if not isinstance(blocks, dict):
        raise ValueError("blocks")
    for name in RAW_BLOCKS:
        law["blocks"][name] = str(blocks.get(name) or "").replace("\r\n", "\n")
    law["extra"] = str(raw.get("extra") or "").replace("\r\n", "\n")
    return law


def validate_law(law, game, others):
    """Error codes; empty means the law can be written.

    `game`: {"laws": {key: group}, "groups": set of law group keys}, the loaded game data.
    `others`: the other laws of the project.
    """
    errors = []
    key = law["key"]
    taken = {other["key"] for other in others}
    if not key:
        errors.append("key_missing")
    elif not KEY_PATTERN.match(key):
        errors.append("key_invalid")
    elif key in taken or (law["mode"] != "override" and key in game["laws"]):
        errors.append("key_exists")
    if not law["group"]:
        errors.append("group_missing")
    elif law["group"] not in game["groups"]:
        errors.append("group_unknown")
    if not law["icon"]:
        errors.append("icon_missing")
    if law["progressiveness"] and not NUMBER_PATTERN.match(law["progressiveness"]):
        errors.append("progressiveness")
    if law["parent"]:
        groups = {**game["laws"], **{other["key"]: other["group"] for other in others}}
        if law["parent"] == key or groups.get(law["parent"]) != law["group"]:
            errors.append("parent")
    for name in MODIFIER_FIELDS:
        if any(not (KEY_PATTERN.match(m["key"]) and MODIFIER_VALUE_PATTERN.match(m["value"]))
               for m in law["modifiers"][name]):
            errors.append("modifier_value")
            break
    for name in RAW_BLOCKS:
        if not braces_balanced(law["blocks"][name]):
            errors.append(f"braces:{name}")
    if not braces_balanced(law["extra"]):
        errors.append("braces:extra")
    return errors


# ------------------------------------------------------------------ writing

def law_to_script(law):
    """Script text for one law. Overrides use REPLACE_OR_CREATE, as for companies."""
    key = law["key"]
    head = f"REPLACE_OR_CREATE:{key}" if law["mode"] == "override" else key
    out = [f"{head} = {{", f"\tgroup = {law['group']}"]
    if law["parent"]:
        out.append(f"\tparent = {law['parent']}")
    out.append("")
    out.append(f"\ticon = {_quote(law['icon'])}")
    out.append("")
    out.append(f"\tprogressiveness = {law['progressiveness'] or '0'}")
    out.append("")
    blocks = law["blocks"]

    def write_list(field):
        if law[field]:
            out.append(f"\t{field} = {{")
            out.extend(f"\t\t{item}" for item in law[field])
            out.append("\t}")
            out.append("")

    def write_block(name):
        text = (blocks[name] or "").strip("\n")
        if text.strip():
            out.append(f"\t{name} = {{")
            out.append(_indent(text, 2))
            out.append("\t}")
            out.append("")

    def write_modifiers(name):
        rows = law["modifiers"][name]
        if rows:
            out.append(f"\t{name} = {{")
            out.extend(f"\t\t{m['key']} = {m['value']}" for m in rows)
            out.append("\t}")
            out.append("")

    for field in LIST_FIELDS:
        write_list(field)
    write_block("is_visible")
    write_block("can_enact")
    if law["institution"]:
        out.append(f"\tinstitution = {law['institution']}")
        out.append("")
    write_modifiers("institution_modifier")
    write_modifiers("modifier")
    for level in TAX_LEVELS:
        write_modifiers(f"tax_modifier_{level}")
    write_modifiers("acceptance_modifier")
    for name in ("on_enact", "on_activate", "on_deactivate", "can_impose", "ai_impose_chance", "ai_will_do",
                 "ai_enact_weight_modifier"):
        write_block(name)
    extra = (law["extra"] or "").strip("\n")
    if extra.strip():
        out.append(_indent(extra, 1))
        out.append("")
    while out[-1] == "":
        out.pop()
    out.append("}")
    return "\n".join(out)


def law_texts(law, lang):
    """Localization of a law in one language: name and description, where filled in."""
    texts = {}
    if law["names"].get(lang):
        texts[law["key"]] = law["names"][lang]
    if law["descs"].get(lang):
        texts[f"{law['key']}_desc"] = law["descs"][lang]
    return texts


# --------------------------------------------------------------- law groups

GROUP_BLOCKS = ("enable", "change_allowed_trigger")
INTEGER_PATTERN = re.compile(r"^\d+$")


def empty_law_group():
    return {"key": "", "mode": "new", "names": {}, "descs": {}, "category": "", "ideological_opinion_impact": "1",
            "base_enactment_days": "", "enactment_approval_mult": "", "affected_by_regime_change": False,
            "hierarchy": "", "blocks": {name: "" for name in GROUP_BLOCKS}, "extra": ""}


def fill_law_group(stored):
    """A law group from a project file, with fields added by later versions of the tool filled in."""
    group = {**empty_law_group(), **stored}
    group["blocks"] = {**empty_law_group()["blocks"], **(stored.get("blocks") or {})}
    return group


def normalize_law_group(raw):
    """Bring a law group sent by the browser into the model's shape (ValueError when it cannot be)."""
    group = empty_law_group()
    group["key"] = str(raw.get("key") or "").strip()
    group["names"] = clean_names(raw.get("names"))
    group["descs"] = clean_names(raw.get("descs"))
    for field in ("category", "ideological_opinion_impact", "base_enactment_days", "enactment_approval_mult",
                  "hierarchy"):
        group[field] = " ".join(str(raw.get(field) or "").split())
    for field in ("category", "hierarchy"):
        if group[field] and not KEY_PATTERN.match(group[field]):
            raise ValueError(field)
    group["affected_by_regime_change"] = bool(raw.get("affected_by_regime_change"))
    blocks = raw.get("blocks") or {}
    if not isinstance(blocks, dict):
        raise ValueError("blocks")
    for name in GROUP_BLOCKS:
        group["blocks"][name] = str(blocks.get(name) or "").replace("\r\n", "\n")
    group["extra"] = str(raw.get("extra") or "").replace("\r\n", "\n")
    return group


def validate_law_group(group, game, others):
    """Error codes; empty means the group can be written.

    `game`: {"groups": law group keys, "categories": law group categories, "hierarchies": social
    hierarchy keys} of the loaded game data. `others`: the other law groups of the project.
    """
    errors = []
    key = group["key"]
    if not key:
        errors.append("key_missing")
    elif not KEY_PATTERN.match(key):
        errors.append("key_invalid")
    elif key in game["groups"] or any(other["key"] == key for other in others):
        errors.append("key_exists")
    if group["category"] not in game["categories"]:
        errors.append("category")
    if not NUMBER_PATTERN.match(group["ideological_opinion_impact"]):
        errors.append("opinion_impact")
    if group["base_enactment_days"] and not INTEGER_PATTERN.match(group["base_enactment_days"]):
        errors.append("enactment_days")
    if group["enactment_approval_mult"] and not NUMBER_PATTERN.match(group["enactment_approval_mult"]):
        errors.append("approval_mult")
    if group["hierarchy"] and group["hierarchy"] not in game["hierarchies"]:
        errors.append("hierarchy")
    for name in GROUP_BLOCKS:
        if not braces_balanced(group["blocks"][name]):
            errors.append(f"braces:{name}")
    if not braces_balanced(group["extra"]):
        errors.append("braces:extra")
    return errors


def law_group_to_script(group):
    """Script text for one new law group, laid out as the game's."""
    out = [f"{group['key']} = {{", f"\tlaw_group_category = {group['category']}"]
    for field in ("base_enactment_days", "enactment_approval_mult"):
        if group[field]:
            out.append(f"\t{field} = {group[field]}")
    out.append(f"\tideological_opinion_impact = {group['ideological_opinion_impact']}")
    if group["affected_by_regime_change"]:
        out.append("\taffected_by_regime_change = yes")
    if group["hierarchy"]:
        out.append(f"\tlinked_social_hierarchy = {group['hierarchy']}")
    for name in GROUP_BLOCKS:
        text = group["blocks"][name].strip("\n")
        if text.strip():
            out.extend(["", f"\t{name} = {{", _indent(text, 2), "\t}"])
    extra = group["extra"].strip("\n")
    if extra.strip():
        out.extend(["", _indent(extra, 1)])
    out.append("}")
    return "\n".join(out)
