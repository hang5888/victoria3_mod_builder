"""Goods and prestige goods: converting between game script and the builder's data model.

A new good needs more than its definition: the input and output modifiers production methods
write (`goods_output_x_add` and the others) with their texts, the text icon the texts show
(`@x!`), and its colour in the market charts. Pops buy a good only through their needs
(`common/pop_needs/`), so each good of the mod lists the needs it is in.

An overridden good writes only what changed: its definition, its colour, its entries in the
needs. A need the mod only adds entries to is extended with INJECT; one whose own entries were
changed or removed is written again in whole with REPLACE_OR_CREATE, from the version in effect.

A prestige good is a better kind of a base good, made by the companies that list it.
"""
import re

from .companies import KEY_PATTERN, _indent, _quote, clean_names
from .pdx_script import Block, braces_balanced, dedent

CATEGORIES = ("staple", "industrial", "luxury", "military")
# yes/no fields, with the game's default
FLAGS = {"tradeable": True, "local": False, "fixed_price": False, "pop_consumption_can_add_infrastructure": False}
# number fields, empty when not written (the game's default then)
NUMBERS = ("prestige_factor", "traded_quantity", "convoy_cost_multiplier", "obsession_chance", "consumption_tax_cost")
NEED_FIELDS = ("weight", "max_supply_share", "min_supply_share")
NUMBER_PATTERN = re.compile(r"^-?\d+(\.\d+)?$")
# the modifiers a new good gets: name -> (colour, percent)
MODIFIERS = {"goods_output_{}_add": ("good", False), "goods_input_{}_add": ("bad", False),
             "goods_output_{}_mult": ("good", True), "goods_input_{}_mult": ("bad", True)}
# the good whose modifier texts are copied for new goods: the only one of the base game with all four
TEMPLATE_GOOD = "small_arms"
# English texts for when the game has none for a language: {icon} is "@x!", {name} the good's name
ENGLISH_TEMPLATES = {
    "goods_output_{}_add": "{icon} {name} output",
    "goods_output_{}_add_desc": "The amount of {icon} {name} produced by buildings",
    "goods_input_{}_add": "{icon} {name} input",
    "goods_input_{}_add_desc": "The amount of {icon} {name} consumed by buildings",
    "goods_output_{}_mult": "Building {icon} {name} output",
    "goods_output_{}_mult_desc": "A bonus or penalty to the amount of {icon} output produced by buildings",
    "goods_input_{}_mult": "{icon} {name} input",
    "goods_input_{}_mult_desc": "The amount of {icon} {name} consumed by buildings",
}


def empty_good():
    good = {"key": "", "mode": "new", "names": {}, "texture": "", "cost": "", "category": "",
            **{name: default for name, default in FLAGS.items()}, **{name: "" for name in NUMBERS},
            "color": None, "needs": [], "extra": "",
            # an override: whether its definition and colour differ from the game's (set when saved)
            "definition": True, "recolor": True}
    return good


def fill_good(stored):
    """A good from a project file, with fields added by later versions of the tool filled in."""
    return {**empty_good(), **stored}


def empty_prestige_good():
    return {"key": "", "mode": "new", "names": {}, "base_good": "", "prestige_bonus": "0.1", "texture": "",
            "possible": "has_dlc_feature = mp1_content", "extra": ""}


def fill_prestige_good(stored):
    return {**empty_prestige_good(), **stored}


# ------------------------------------------------------------------ reading

def _yes(value, default):
    return value == "yes" if value in ("yes", "no") else default


def good_from_block(key, block):
    """Build the data model from a parsed `good = { ... }` block."""
    good = empty_good()
    good["key"] = key
    extra = []
    seen = set()
    for entry in block.entries:
        name, value = entry.key, entry.value
        plain = isinstance(value, str) and entry.op == "=" and name not in seen
        if name == "texture" and plain:
            good["texture"] = value
        elif name == "cost" and plain and NUMBER_PATTERN.match(value):
            good["cost"] = value
        elif name == "category" and plain:
            good["category"] = value
        elif name in FLAGS and plain and value in ("yes", "no"):
            good[name] = value == "yes"
        elif name in NUMBERS and plain and NUMBER_PATTERN.match(value):
            good[name] = value
        else:
            extra.append(dedent(entry.raw))
            continue
        seen.add(name)
    good["extra"] = "\n".join(extra)
    return good


def need_from_block(block):
    """A pop need: its default good, its entries [{goods, weight, max_supply_share, min_supply_share, extra}]
    and the rest of its script (`extra`, kept when the need is written again)."""
    default = block.get("default")
    entries, extra = [], []
    for entry in block.entries:
        if entry.key == "entry" and isinstance(entry.value, Block):
            row = {"goods": "", **{name: "" for name in NEED_FIELDS}}
            others = []
            for sub in entry.value.entries:
                if sub.key in row and isinstance(sub.value, str) and not row[sub.key]:
                    row[sub.key] = sub.value
                else:
                    others.append(dedent(sub.raw))
            row["extra"] = "\n".join(others)
            if row["goods"]:
                entries.append(row)
        elif entry.key != "default":
            extra.append(dedent(entry.raw))
    return {"default": default if isinstance(default, str) else "", "entries": entries, "extra": "\n".join(extra)}


def prestige_good_from_block(key, block):
    good = empty_prestige_good()
    good["key"] = key
    good["possible"] = ""
    extra = []
    for entry in block.entries:
        name, value = entry.key, entry.value
        if name in ("base_good", "prestige_bonus", "texture") and isinstance(value, str) and entry.op == "=":
            good[name] = value
        elif name == "possible" and isinstance(value, Block) and entry.op == "=":
            good["possible"] = value.inner()
        else:
            extra.append(dedent(entry.raw))
    good["extra"] = "\n".join(extra)
    return good


# ---------------------------------------------------------------- checking

def _number_text(raw, name):
    return " ".join(str(raw.get(name) or "").split())


def _color(value):
    if value in (None, ""):
        return None
    if (not isinstance(value, list) or len(value) != 3
            or not all(isinstance(n, int) and not isinstance(n, bool) and 0 <= n <= 255 for n in value)):
        raise ValueError("color")
    return list(value)


def normalize_good(raw):
    """Bring a good sent by the browser into the model's shape (ValueError when it cannot be)."""
    good = empty_good()
    good["key"] = str(raw.get("key") or "").strip()
    good["mode"] = "override" if raw.get("mode") == "override" else "new"
    good["names"] = clean_names(raw.get("names"))
    good["texture"] = " ".join(str(raw.get("texture") or "").split())
    for name in ("cost", "category", *NUMBERS):
        good[name] = _number_text(raw, name)
    if good["category"] and not KEY_PATTERN.match(good["category"]):
        raise ValueError("category")
    for name, default in FLAGS.items():
        good[name] = bool(raw.get(name, default))
    good["color"] = _color(raw.get("color"))
    needs = raw.get("needs") or []
    if not isinstance(needs, list) or not all(isinstance(n, dict) for n in needs):
        raise ValueError("needs")
    good["needs"] = [{"need": str(n.get("need") or "").strip(),
                      **{name: _number_text(n, name) for name in NEED_FIELDS}} for n in needs]
    if any(not KEY_PATTERN.match(n["need"]) for n in good["needs"]):
        raise ValueError("needs")
    good["extra"] = str(raw.get("extra") or "").replace("\r\n", "\n")
    return good


def validate_good(good, game, others):
    """Error codes; empty means the good can be written.

    `game`: {"goods": game good keys, "needs": pop need keys, "categories": known categories}.
    `others`: the other goods of the project.
    """
    errors = []
    key = good["key"]
    if not key:
        errors.append("key_missing")
    elif not KEY_PATTERN.match(key):
        errors.append("key_invalid")
    elif any(other["key"] == key for other in others) or (good["mode"] != "override" and key in game["goods"]):
        errors.append("key_exists")
    if not good["texture"]:
        errors.append("icon_missing")
    if not NUMBER_PATTERN.match(good["cost"]) or float(good["cost"]) <= 0:
        errors.append("cost")
    if good["category"] not in game["categories"]:
        errors.append("category")
    if any(good[name] and not NUMBER_PATTERN.match(good[name]) for name in NUMBERS):
        errors.append("number")
    needs = [n["need"] for n in good["needs"]]
    if any(need not in game["needs"] for need in needs) or len(set(needs)) != len(needs):
        errors.append("need")
    if any(n[name] and not NUMBER_PATTERN.match(n[name]) for n in good["needs"] for name in NEED_FIELDS):
        errors.append("need_value")
    if not braces_balanced(good["extra"]):
        errors.append("braces:extra")
    return errors


def normalize_prestige_good(raw):
    good = empty_prestige_good()
    good["key"] = str(raw.get("key") or "").strip()
    good["mode"] = "override" if raw.get("mode") == "override" else "new"
    good["names"] = clean_names(raw.get("names"))
    for name in ("base_good", "prestige_bonus", "texture"):
        good[name] = " ".join(str(raw.get(name) or "").split())
    if good["base_good"] and not KEY_PATTERN.match(good["base_good"]):
        raise ValueError("base_good")
    for name in ("possible", "extra"):
        good[name] = str(raw.get(name) or "").replace("\r\n", "\n")
    return good


def validate_prestige_good(good, game, others):
    """Error codes. `game`: {"prestige_goods": keys, "goods": keys of the game's and the mod's goods}."""
    errors = []
    key = good["key"]
    if not key:
        errors.append("key_missing")
    elif not KEY_PATTERN.match(key):
        errors.append("key_invalid")
    elif any(other["key"] == key for other in others) or (
            good["mode"] != "override" and key in game["prestige_goods"]):
        errors.append("key_exists")
    if good["base_good"] not in game["goods"]:
        errors.append("base_good")
    if not good["texture"]:
        errors.append("icon_missing")
    if not NUMBER_PATTERN.match(good["prestige_bonus"]):
        errors.append("prestige_bonus")
    for name in ("possible", "extra"):
        if not braces_balanced(good[name]):
            errors.append(f"braces:{name}")
    return errors


def same_definition(good, game):
    """True when a good's definition (all but names, colour and needs) is the same as `game`'s."""
    fields = ("texture", "cost", "category", *FLAGS, *NUMBERS)

    def value(item, name):
        text = item.get(name)
        if name in NUMBERS or name == "cost":
            return float(text) if text and NUMBER_PATTERN.match(text) else None
        return text

    return (all(value(good, name) == value(game, name) for name in fields)
            and good["extra"].strip() == (game.get("extra") or "").strip())


# ------------------------------------------------------------------ writing

def good_to_script(good):
    """Script text for one good, laid out as the game's. Overrides use REPLACE_OR_CREATE."""
    key = good["key"]
    head = f"REPLACE_OR_CREATE:{key}" if good["mode"] == "override" else key
    out = [f"{head} = {{", f"\ttexture = {_quote(good['texture'])}", f"\tcost = {good['cost']}",
           f"\tcategory = {good['category']}"]
    flags = [f"\t{name} = {'yes' if good[name] else 'no'}" for name, default in FLAGS.items() if good[name] != default]
    numbers = [f"\t{name} = {good[name]}" for name in NUMBERS if good[name]]
    for lines in (flags, numbers):
        if lines:
            out.append("")
            out.extend(lines)
    extra = good["extra"].strip("\n")
    if extra.strip():
        out.extend(["", _indent(extra, 1)])
    out.append("}")
    return "\n".join(out)


def modifiers_script(goods):
    """The input and output modifiers of the new goods, as the game defines its own."""
    out = []
    for good in goods:
        for pattern, (color, percent) in MODIFIERS.items():
            lines = [f"{pattern.format(good['key'])} = {{", "\tdecimals = 1", f"\tcolor = {color}"]
            if percent:
                lines.append("\tpercent = yes")
            lines.extend(["\tgame_data = {", "\t\tai_value = 0", "\t}", "}"])
            out.append("\n".join(lines))
    return out


def texticons_script(goods):
    """Text icons, so that `@x!` in a text shows the good's icon."""
    return [f"texticon = {{\n\ticon = {good['key']}\n\n\ticonsize = {{\n\t\tsize = {{ 25 25 }}\n"
            f"\t\toffset = {{ 0 7 }}\n\t\tfontsize = 18\n\t\ttexture = {_quote(good['texture'])}\n\t}}\n}}"
            for good in goods]


def colors_script(goods):
    """Market chart colours of the goods that set one."""
    rows = [f"\t{good['key']} = rgb {{ {' '.join(str(n) for n in good['color'])} }}" for good in goods if good["color"]]
    return ["colors = {\n" + "\n".join(rows) + "\n}"] if rows else []


def _number(text):
    return float(text) if text and NUMBER_PATTERN.match(text) else None


def _same_entry(a, b):
    return all(_number(a.get(name)) == _number(b.get(name)) for name in NEED_FIELDS)


def _entry_script(goods, row, extra=""):
    """One entry of a need; `extra`: the rest of the game's entry, kept when it is written again."""
    fields = [f"\t\t{name} = {row[name]}" for name in NEED_FIELDS if row.get(name)]
    lines = ["\tentry = {", f"\t\tgoods = {goods}", *([""] + fields if fields else [])]
    if extra.strip():
        lines.append(_indent(extra.strip("\n"), 2))
    lines.append("\t}")
    return "\n".join(lines)


def needs_script(goods, needs):
    """The pop needs the mod's goods change. `needs`: the game's needs in effect, {need: need_from_block}.

    Returns (definitions, whole): `whole` names the needs written again in whole, which take the
    changes of mods loaded earlier only as they were when this was written.
    """
    wanted = {}  # need -> {good: row}, for every need a good of the mod is or was in
    for good in goods:
        rows = {row["need"]: row for row in good["needs"]}
        for need, info in needs.items():
            if any(entry["goods"] == good["key"] for entry in info["entries"]):
                wanted.setdefault(need, {})[good["key"]] = rows.get(need)
        for need, row in rows.items():
            wanted.setdefault(need, {})[good["key"]] = row
    definitions, whole = [], []
    for need in sorted(wanted, key=lambda n: list(needs).index(n) if n in needs else len(needs)):
        changes = wanted[need]
        info = needs.get(need, {"default": "", "entries": []})
        present = {entry["goods"]: entry for entry in info["entries"]}
        if all(changes.get(goods) is not None and _same_entry(changes[goods], entry)
               for goods, entry in present.items() if goods in changes):
            added = [goods for goods, row in changes.items() if row is not None and goods not in present]
            if added:
                body = "\n\n".join(_entry_script(goods, changes[goods]) for goods in added)
                definitions.append(f"INJECT:{need} = {{\n{body}\n}}")
            continue
        # an entry the game has was changed or removed: the need again in whole
        rows = []
        for entry in info["entries"]:
            if entry["goods"] in changes:
                if changes[entry["goods"]] is not None:
                    rows.append(_entry_script(entry["goods"], changes[entry["goods"]], entry.get("extra", "")))
            else:
                rows.append(_entry_script(entry["goods"], entry, entry.get("extra", "")))
        rows += [_entry_script(goods, row) for goods, row in changes.items() if row is not None and goods not in present]
        head = f"\tdefault = {info['default']}\n\n" if info["default"] else ""
        if (info.get("extra") or "").strip():
            head += _indent(info["extra"].strip("\n"), 1) + "\n\n"
        definitions.append(f"REPLACE_OR_CREATE:{need} = {{\n{head}" + "\n\n".join(rows) + "\n}")
        whole.append(need)
    return definitions, whole


def prestige_good_to_script(good):
    key = good["key"]
    head = f"REPLACE_OR_CREATE:{key}" if good["mode"] == "override" else key
    out = [f"{head} = {{"]
    possible = good["possible"].strip("\n")
    if possible.strip():
        out.extend(["\tpossible = {", _indent(possible, 2), "\t}"])
    out.extend([f"\tbase_good = {good['base_good']}", f"\tprestige_bonus = {good['prestige_bonus']}",
                f"\ttexture = {_quote(good['texture'])}"])
    extra = good["extra"].strip("\n")
    if extra.strip():
        out.append(_indent(extra, 1))
    out.append("}")
    return "\n".join(out)


def modifier_texts(good, lang, templates):
    """Texts of a new good's modifiers in one language, made from the game's texts for TEMPLATE_GOOD.

    `templates`: {"name": the template good's name, "texts": {pattern: text}} in that language, or None
    for the built-in English. Nothing when the good has no name in the language.
    """
    name = good["names"].get(lang)
    if not name:
        return {}
    key, icon = good["key"], f"@{good['key']}!"
    texts = {}
    for pattern, english in ENGLISH_TEMPLATES.items():
        template = (templates or {}).get("texts", {}).get(pattern)
        if template:
            text = template.replace(f"@{TEMPLATE_GOOD}!", icon).replace(f"${TEMPLATE_GOOD}$", f"${key}$")
            if templates.get("name"):
                text = text.replace(templates["name"], name)
        else:
            text = english.format(icon=icon, name=name)
        texts[pattern.format(key)] = text
    return texts
