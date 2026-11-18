"""Flags of new countries (stage 4 of docs/mod_types/country_start.md).

A country's flag is a coat of arms (common/coat_of_arms/coat_of_arms): a pattern with up to three
colours, and emblems on it; and a flag definition (common/flag_definitions) that says which coat of
arms the country uses. A new country of the mod gets one of each, both named by its tag.

The start keeps
  flag  {pattern, colors: [3 colour names], emblems: [emblem]}
        emblem: {kind: "colored" | "textured", texture (file name), colors (colored: 3 names),
                 x, y (centre, 0..1), sx, sy (size, -2..2; negative mirrors), rotation (degrees)}

Patterns are in gfx/coat_of_arms/patterns, single-colour emblems (tinted with up to three colours) in
gfx/coat_of_arms/colored_emblems, picture emblems in gfx/coat_of_arms/textured_emblems: the game's,
or pictures imported into the mod (written there as uncompressed DDS with mipmaps). Colours are the
game's named colours (common/named_colors). Coloured emblems are written before picture emblems, as
the game's flags have them (the colours under the pictures); each kind in the order of the list.
"""
import re

from .countries import _scoped_block_lines

PATTERN_DIR = "gfx/coat_of_arms/patterns"
COLORED_DIR = "gfx/coat_of_arms/colored_emblems"
TEXTURED_DIR = "gfx/coat_of_arms/textured_emblems"
FILE = re.compile(r"^[A-Za-z0-9_.\-]+\.(dds|tga|png)$", re.I)
COLOR = re.compile(r"^[A-Za-z0-9_]+$")
MAX_EMBLEMS = 40


def default_flag():
    return {"pattern": "pattern_solid.tga", "colors": ["white", "blue", "red"], "emblems": []}


def _number(value, field, low, high):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not low <= value <= high:
        raise ValueError(field)
    return round(float(value), 4)


def _file(value):
    value = str(value or "").strip()
    if not FILE.match(value):
        raise ValueError("flag")
    return value


def _color(value):
    value = str(value or "").strip()
    if not COLOR.match(value):
        raise ValueError("flag")
    return value


def normalize_flag(raw):
    if not isinstance(raw, dict):
        raise ValueError("flag")
    colors = raw.get("colors")
    if not isinstance(colors, list) or len(colors) != 3:
        raise ValueError("flag")
    emblems = raw.get("emblems") or []
    if not isinstance(emblems, list) or len(emblems) > MAX_EMBLEMS:
        raise ValueError("flag")
    flag = {"pattern": _file(raw.get("pattern")), "colors": [_color(c) for c in colors], "emblems": []}
    for emblem in emblems:
        if not isinstance(emblem, dict) or emblem.get("kind") not in ("colored", "textured"):
            raise ValueError("flag")
        clean = {"kind": emblem["kind"], "texture": _file(emblem.get("texture")),
                 "x": _number(emblem.get("x", 0.5), "flag", -1, 2), "y": _number(emblem.get("y", 0.5), "flag", -1, 2),
                 "sx": _number(emblem.get("sx", 1), "flag", -2, 2), "sy": _number(emblem.get("sy", 1), "flag", -2, 2),
                 "rotation": _number(emblem.get("rotation", 0), "flag", -360, 360)}
        if clean["kind"] == "colored":
            emblem_colors = emblem.get("colors")
            if not isinstance(emblem_colors, list) or len(emblem_colors) != 3:
                raise ValueError("flag")
            clean["colors"] = [_color(c) for c in emblem_colors]
        flag["emblems"].append(clean)
    return flag


def flag_errors(flag, game):
    """`game`: "patterns", "colored_emblems", "textured_emblems" (file names, with the mod's imported
    pictures), "coa_colors" (colour names)."""
    if flag is None:
        return ["flag"]
    if (flag["pattern"] not in game["patterns"] or any(c not in game["coa_colors"] for c in flag["colors"])):
        return ["flag"]
    for emblem in flag["emblems"]:
        files = game["colored_emblems"] if emblem["kind"] == "colored" else game["textured_emblems"]
        if emblem["texture"] not in files or any(c not in game["coa_colors"] for c in emblem.get("colors", [])):
            return ["flag"]
    return []


def _number_text(value):
    return f"{value:g}"


def _instance(emblem):
    parts = []
    if (emblem["x"], emblem["y"]) != (0.5, 0.5):
        parts.append(f"position = {{ {_number_text(emblem['x'])} {_number_text(emblem['y'])} }}")
    if (emblem["sx"], emblem["sy"]) != (1, 1):
        parts.append(f"scale = {{ {_number_text(emblem['sx'])} {_number_text(emblem['sy'])} }}")
    if emblem["rotation"]:
        parts.append(f"rotation = {_number_text(emblem['rotation'])}")
    return f"instance = {{ {' '.join(parts)} }}" if parts else None


def coat_of_arms_script(tag, flag):
    """The coat of arms of a new country, named by its tag."""
    lines = [f'pattern = "{flag["pattern"]}"']
    lines += [f'color{i + 1} = "{color}"' for i, color in enumerate(flag["colors"])]
    ordered = ([e for e in flag["emblems"] if e["kind"] == "colored"]
               + [e for e in flag["emblems"] if e["kind"] == "textured"])
    for emblem in ordered:
        inner = [f'texture = "{emblem["texture"]}"']
        if emblem["kind"] == "colored":
            inner += [f'color{i + 1} = "{color}"' for i, color in enumerate(emblem["colors"])]
        instance = _instance(emblem)
        if instance:
            inner.append(instance)
        lines += _scoped_block_lines(f"{emblem['kind']}_emblem =", inner)
    return "\n".join(_scoped_block_lines(f"{tag} =", lines))


def flag_definition_script(tag):
    """The flag definition of a new country: always its own coat of arms."""
    inner = [f"coa = {tag}", f"subject_canton = {tag}", "allow_overlord_canton = yes", "priority = 1"]
    return "\n".join(_scoped_block_lines(f"{tag} =", _scoped_block_lines("flag_definition =", inner)))


def flag_images(flag):
    """Game paths of the picture emblems a flag uses (to keep the imported ones in the mod)."""
    return {f"{TEXTURED_DIR}/{e['texture']}" for e in (flag or {}).get("emblems", []) if e["kind"] == "textured"}
