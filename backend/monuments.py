"""Monuments: buildings of the monument and skyscraper groups, and where they stand.

A monument is a factory in the model of factories.py, plus
  location: {state, x, z, locator}
            state: the state region it is limited to ('' for anywhere)
            x, z:  a new map position for its model, or None to keep `locator`, the name of an
                   existing map locator (an overridden monument that was not moved)
  history:  tag of the country that owns it when the game starts ('' when players build it)
  effects:  'simple' (one group with one method, edited as a list of effects) or 'full'
            (production method groups as in factories); only the editor uses it
The state, locator and history are written by the tool, so they are not kept in the
building's potential or other script.
"""
import re

from .companies import KEY_PATTERN
from .factories import empty_factory, factory_to_script, fill_factory, normalize_factory, validate_factory
from .pdx_script import dedent, parse

TAG_PATTERN = re.compile(r"^[A-Za-z0-9_]{1,12}$")
MONUMENT_GROUPS = ("bg_monuments", "bg_skyscraper")


def empty_location():
    return {"state": "", "x": None, "z": None, "locator": ""}


def empty_monument():
    monument = empty_factory()
    monument.update(location=empty_location(), history="", effects="simple")
    return monument


def fill_monument(stored):
    """A monument from a project file, with fields added by later versions of the tool filled in."""
    monument = fill_factory(stored)
    monument["location"] = {**empty_location(), **(stored.get("location") or {})}
    monument.setdefault("history", "")
    monument.setdefault("effects", "full")
    return monument


def _coordinate(value):
    if value is None or value == "":
        return None
    number = float(value)  # ValueError for anything else
    if not -100000 < number < 100000:
        raise ValueError("location")
    return round(number, 3)


def normalize_monument(raw):
    """Bring a monument sent by the browser into the model's shape (ValueError when it cannot be)."""
    monument = normalize_factory(raw)
    location = {} if raw.get("location") is None else raw["location"]
    if not isinstance(location, dict):
        raise ValueError("location")
    state = " ".join(str(location.get("state") or "").split())
    locator = " ".join(str(location.get("locator") or "").split())
    if (state and not KEY_PATTERN.match(state)) or (locator and not KEY_PATTERN.match(locator)):
        raise ValueError("location")
    x, z = _coordinate(location.get("x")), _coordinate(location.get("z"))
    if (x is None) != (z is None):
        raise ValueError("location")
    monument["location"] = {"state": state, "x": x, "z": z, "locator": locator}
    history = " ".join(str(raw.get("history") or "").split())
    if history and not TAG_PATTERN.match(history):
        raise ValueError("history")
    monument["history"] = history
    monument["effects"] = "simple" if raw.get("effects") == "simple" else "full"
    return monument


def validate_monument(monument, game, project):
    """Error codes, as validate_factory, plus where the monument stands."""
    errors = validate_factory(monument, game, project)
    if monument["history"] and not monument["location"]["state"]:
        errors.append("history_state")
    if monument["history"] and monument["mode"] == "override":
        errors.append("history_override")
    return errors


def locator_name(monument, slug):
    """Name of the map locator written for a monument placed by the tool."""
    if monument["mode"] == "override":
        return f"{monument['key']}_locator_{slug}"  # the original locator stays as it is
    return f"{monument['key']}_locator"


def _without(text, keys):
    """A script without the statements of the given keys (rebuilt from the others when it has any)."""
    entries = parse(text).entries
    if not any(entry.key in keys for entry in entries):
        return text
    return "\n".join(dedent(entry.raw) for entry in entries if entry.key not in keys)


def monument_to_script(monument, slug):
    building = {**monument, "blocks": dict(monument["blocks"])}
    state = monument["location"]["state"]
    if state:
        potential = monument["blocks"]["potential"].strip("\n")
        building["blocks"]["potential"] = f"state_region = s:{state}" + (f"\n{potential}" if potential.strip() else "")
    extra = _without(monument["extra"], {"locator"} | ({"buildable"} if monument["history"] else set()))
    lines = [extra] if extra.strip() else []
    if monument["location"]["x"] is not None:
        lines.append(f'locator = "{locator_name(monument, slug)}"')
    elif monument["location"]["locator"]:
        lines.append(f'locator = "{monument["location"]["locator"]}"')
    if monument["history"]:
        lines.append("buildable = no")
    building["extra"] = "\n".join(lines)
    return factory_to_script(building)


def locators_script(monuments, slug):
    """Map locators of the monuments placed by the tool (same layout as the game's files)."""
    out = []
    for monument in monuments:
        location = monument["location"]
        if location["x"] is None:
            continue
        out.append("\n".join([
            "game_object_locator={",
            f'\tname="{locator_name(monument, slug)}"',
            "\tclamp_to_water_level=no",
            "\trender_under_water=no",
            "\tgenerated_content=no",
            '\tlayer="static"',
            "\tinstances={",
            "\t\t{",
            "\t\t\tid=1",
            f"\t\t\tposition={{ {location['x']:.6f} 0.000000 {location['z']:.6f} }}",
            "\t\t\trotation={ -0.000000 -0.000000 -0.000000 1.000000 }",
            "\t\t\tscale={ 1.000000 1.000000 1.000000 }",
            "\t\t}",
            "\t}",
            "}",
        ]))
    return out


def history_script(monuments):
    """The BUILDINGS history that places the monuments existing when the game starts."""
    by_state = {}
    for monument in monuments:
        if monument["history"] and monument["location"]["state"]:
            by_state.setdefault(monument["location"]["state"], {}).setdefault(monument["history"], []).append(monument)
    if not by_state:
        return []
    out = ["BUILDINGS = {"]
    for state, owners in by_state.items():
        out.append(f"\ts:{state} = {{")
        for tag, placed in owners.items():
            out.append(f"\t\tregion_state:{tag} = {{")
            for monument in placed:
                out.append(f'\t\t\tcreate_building = {{ building = "{monument["key"]}" level = 1 }}')
            out.append("\t\t}")
        out.append("\t}")
    out.append("}")
    return ["\n".join(out)]
