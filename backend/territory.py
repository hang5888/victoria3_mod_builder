"""Territory, pops and buildings of the country starts (stage 2 of docs/mod_types/country_start.md).

Who owns which province, and the pops and buildings of each country's part of a state region
(its "region state"), are history files shared by many countries: common/history/states (one file
for the world), pops and buildings (one file per part of the world). As with the country history,
the mod replaces the files in effect with copies in which only the changed states are rewritten.

A start keeps what the mod changes:
  gains        provinces the country takes (from their owner at the start, or from nobody)
  releases     provinces of the country at the start that nobody owns now
  state_types  {state: "incorporated" | "unincorporated"} of the country's parts
  homelands    {state: {"add": [cultures], "remove": [cultures]}}
  claims       {"add": [states], "remove": [states]} the country claims
  pops         {state: [pop]}       the pops of the country's part of a state, as a whole
  buildings    {state: [building]}  the buildings of the country's part of a state, as a whole

World works out the result. When a country's whole part of a state goes to one other country, its
pops and buildings go along, and who owns the buildings is changed to match (the old country's
holdings there become the new country's; what other countries hold stays). When only some
provinces go, the pops are shared out by the number of provinces and the buildings stay. A country
left without land does not exist at the start: what it holds in other countries goes to the owner
there (and diplomacy.write_diplomacy drops the diplomacy and treaties that name it). Pops and buildings the mod set for
a part are its final lists; a part whose owner changes again starts from the game's again.
"""
from collections import Counter

from .countries import Patcher, entry_indent, _scoped_block_lines
from .pdx_script import Block, dedent, parse

STATE_DIRS = {
    "states": ("common/history/states", "STATES"),
    "pops": ("common/history/pops", "POPS"),
    "buildings": ("common/history/buildings", "BUILDINGS"),
}
POP_FIELDS = ("culture", "religion", "pop_type")
OWNER_KINDS = ("country", "building", "company")


def _tag(value):
    """`c:GBR` (quoted or not) as GBR."""
    value = str(value or "")
    return value[2:] if value.startswith("c:") else value


def _int(value, default=0):
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


# ------------------------------------------------------------------ models

def pop_from_block(block):
    pop = {name: "" for name in POP_FIELDS}
    extra = []
    for entry in block.entries:
        if entry.key in POP_FIELDS and isinstance(entry.value, str):
            pop[entry.key] = entry.value
        elif entry.key == "size" and isinstance(entry.value, str):
            pop["size"] = _int(entry.value)
        else:
            extra.append(dedent(entry.raw))
    pop.setdefault("size", 0)
    pop["extra"] = "\n".join(extra)
    return pop


def pop_lines(pop):
    lines = [f"culture = {pop['culture']}"]
    if pop["religion"]:
        lines.append(f"religion = {pop['religion']}")
    if pop["pop_type"]:
        lines.append(f"pop_type = {pop['pop_type']}")
    lines.append(f"size = {pop['size']}")
    if pop.get("extra"):
        lines += pop["extra"].split("\n")
    return _scoped_block_lines("create_pop =", lines)


def owner_from_entry(entry):
    """One holder of a building: {kind, country, type, region, levels}, or None."""
    if entry.key not in OWNER_KINDS or not isinstance(entry.value, Block):
        return None
    block = entry.value
    return {"kind": entry.key, "country": _tag(block.get("country")), "type": str(block.get("type") or ""),
            "region": str(block.get("region") or ""), "levels": _int(block.get("levels"), 1)}


def building_from_block(block):
    building = {"building": "", "level": 0, "ownership": [], "reserves": None, "pms": [], "subsidized": None,
                "extra": ""}
    extra = []
    for entry in block.entries:
        key, value = entry.key, entry.value
        if key == "building" and isinstance(value, str):
            building["building"] = value
        elif key == "level" and isinstance(value, str):
            building["level"] = _int(value)
        elif key == "reserves" and isinstance(value, str):
            building["reserves"] = _int(value)
        elif key == "subsidized" and value in ("yes", "no"):
            building["subsidized"] = value == "yes"
        elif key == "activate_production_methods" and isinstance(value, Block):
            building["pms"] = value.items()
        elif key == "add_ownership" and isinstance(value, Block):
            owners = [owner_from_entry(sub) for sub in value.entries]
            if all(owners):
                building["ownership"] += owners
            else:
                extra.append(dedent(entry.raw))
        else:
            extra.append(dedent(entry.raw))
    building["extra"] = "\n".join(extra)
    return building


def building_lines(building):
    lines = [f'building = "{building["building"]}"']
    if building["level"]:
        lines.append(f"level = {building['level']}")
    if building["ownership"]:
        owners = []
        for owner in building["ownership"]:
            inner = []
            if owner["kind"] != "country":
                inner.append(f'type = "{owner["type"]}"')
            inner.append(f'country = "c:{owner["country"]}"')
            inner.append(f"levels = {owner['levels']}")
            if owner["kind"] == "building":
                inner.append(f'region = "{owner["region"]}"')
            owners += _scoped_block_lines(f"{owner['kind']} =", inner)
        lines += _scoped_block_lines("add_ownership =", owners)
    if building["reserves"] is not None:
        lines.append(f"reserves = {building['reserves']}")
    if building["subsidized"] is not None:
        lines.append(f"subsidized = {'yes' if building['subsidized'] else 'no'}")
    if building["pms"]:
        lines.append("activate_production_methods = { " + " ".join(f'"{pm}"' for pm in building["pms"]) + " }")
    if building.get("extra"):
        lines += building["extra"].split("\n")
    return _scoped_block_lines("create_building =", lines)


def building_levels(building):
    return building["level"] + sum(owner["levels"] for owner in building["ownership"])


def read_state_parts(root, top, kind, parts, others):
    """The parts of the states in one pops or buildings file: parts {state: {tag: [items]}};
    others {state: {tag: [raw statements]}} keeps what is not a pop or building."""
    wanted = "create_pop" if kind == "pops" else "create_building"
    read = pop_from_block if kind == "pops" else building_from_block
    for state, entry in state_blocks(root, top):
        for part in entry.value.entries:
            if not (part.key and part.key.startswith("region_state:") and isinstance(part.value, Block)):
                continue
            tag = part.key[len("region_state:"):]
            items = parts.setdefault(state, {}).setdefault(tag, [])
            for item in part.value.entries:
                if item.key == wanted and isinstance(item.value, Block):
                    items.append(read(item.value))
                else:
                    others.setdefault(state, {}).setdefault(tag, []).append(dedent(item.raw))


def state_blocks(root, top):
    """The `s:STATE = { }` blocks of a history file: [(state, Entry)]."""
    found = []
    for entry in root.entries:
        if entry.key == top and isinstance(entry.value, Block):
            found += [(sub.key[2:], sub) for sub in entry.value.entries
                      if sub.key and sub.key.startswith("s:") and isinstance(sub.value, Block)]
    return found


def read_states(root, shares, homelands, claims):
    """Owners, homelands and claims from one file of common/history/states."""
    for state, entry in state_blocks(root, "STATES"):
        for sub in entry.value.entries:
            if sub.key == "create_state" and isinstance(sub.value, Block):
                provinces = sub.value.get("owned_provinces")
                tag = _tag(sub.value.get("country"))
                if tag:
                    shares.setdefault(state, []).append({
                        "country": tag,
                        "provinces": [p.lstrip("xX").upper() for p in provinces.items()] if isinstance(provinces, Block) else [],
                        "unincorporated": sub.value.get("state_type") == "unincorporated"})
            elif sub.key == "add_homeland" and isinstance(sub.value, str):
                homelands.setdefault(state, []).append(sub.value[3:] if sub.value.startswith("cu:") else sub.value)
            elif sub.key == "add_claim" and isinstance(sub.value, str):
                claims.setdefault(state, []).append(_tag(sub.value))


# ------------------------------------------------------------------- world

def _merge_pops(pops):
    merged = {}
    for pop in pops:
        key = (pop["culture"], pop["religion"], pop["pop_type"], pop.get("extra", ""))
        if key in merged:
            merged[key]["size"] += pop["size"]
        else:
            merged[key] = dict(pop)
    return [pop for pop in merged.values() if pop["size"] > 0]


def _merge_owners(owners):
    merged = {}
    for owner in owners:
        key = (owner["kind"], owner["country"], owner["type"], owner["region"])
        if key in merged:
            merged[key]["levels"] += owner["levels"]
        else:
            merged[key] = dict(owner)
    return list(merged.values())


def _merge_buildings(buildings):
    """Buildings of one part: the same type twice becomes one, with the levels added up."""
    merged = {}
    for building in buildings:
        key = building["building"]
        if key in merged:
            first = merged[key]
            first["level"] += building["level"]
            first["ownership"] = _merge_owners(first["ownership"] + building["ownership"])
            if building["reserves"] is not None:
                first["reserves"] = max(first["reserves"] or 0, building["reserves"])
        else:
            merged[key] = {**building, "ownership": [dict(o) for o in building["ownership"]], "pms": list(building["pms"])}
    return list(merged.values())


def _copy_buildings(buildings):
    return [{**b, "ownership": [dict(o) for o in b["ownership"]], "pms": list(b["pms"])} for b in buildings]


class World:
    """The territory, pops and buildings a mod's country starts give.

    `base`: the game's (see gamedata.StartBase): state_provinces {state: [province]}, shares {state:
    [{country, provinces, unincorporated}]}, pops / buildings {state: {tag: [items]}}, homelands {state:
    [cultures]}, claims {state: [tags]}. `starts`: the mod's country starts, the one being edited last
    (it wins over the others). `own_lists_of`: a tag whose own pop and building lists are left out, to
    show what the country gets before them.
    """

    def __init__(self, base, starts, own_lists_of=None):
        self.base = base
        starts = [s for s in starts if s.get("mode") in ("override", "new")]
        self.base_owner = {}
        self.province_state = {}
        for state, provinces in base.state_provinces.items():
            for province in provinces:
                self.province_state[province] = state
        for state, shares in base.shares.items():
            for share in shares:
                for province in share["provinces"]:
                    self.base_owner[province] = share["country"]
                    self.province_state.setdefault(province, state)
        owners = {}
        for start in starts:
            for province in start.get("releases") or []:
                if self.base_owner.get(province) == start["key"]:
                    owners[province] = ""
        for start in starts:
            for province in start.get("gains") or []:
                if province in self.province_state:
                    owners[province] = start["key"]
        self.changed_provinces = {p: t for p, t in owners.items() if self.base_owner.get(p, "") != t}
        touched = {self.province_state[p] for p in self.changed_provinces}

        # who owns what in the states that changed
        self.shares = {}
        for state in touched:
            self.shares[state] = self._shares(state)
        for start in starts:
            for state, kind in (start.get("state_types") or {}).items():
                shares = self.shares.get(state) or [dict(s) for s in base.shares.get(state, [])]
                for share in shares:
                    if share["country"] == start["key"]:
                        share["unincorporated"] = kind == "unincorporated"
                if any(s["country"] == start["key"] for s in shares):
                    self.shares[state] = shares
        tags_before = {s["country"] for shares in base.shares.values() for s in shares}
        tags_after = {s["country"] for state, shares in base.shares.items() if state not in self.shares
                      for s in shares} | {s["country"] for shares in self.shares.values() for s in shares}
        self.vanished = tags_before - tags_after

        # pops and buildings: parts whose owner changed, then the holders of buildings
        self.pops = {}       # (state, tag) -> [pop] or None (the part is gone)
        self.buildings = {}  # (state, tag) -> [building] or None
        self.moved = {}      # (state, old tag) -> new tag: where the buildings of a part went
        for state in touched:
            self._move(state)
        self._rehome()
        for start in starts:
            if start["key"] == own_lists_of:
                continue
            for field, target in (("pops", self.pops), ("buildings", self.buildings)):
                for state, items in (start.get(field) or {}).items():
                    if self.has_part(state, start["key"]):
                        target[(state, start["key"])] = items

        # homelands and claims
        self.homelands, self.claims = {}, {}
        for start in starts:
            for state, change in (start.get("homelands") or {}).items():
                current = self.homelands.get(state, list(base.homelands.get(state, [])))
                current = [c for c in current if c not in change.get("remove", [])]
                current += [c for c in change.get("add", []) if c not in current]
                self.homelands[state] = current
            claims = start.get("claims") or {}
            for state in [*claims.get("add", []), *claims.get("remove", [])]:
                current = self.claims.get(state, list(base.claims.get(state, [])))
                current = [t for t in current if t != start["key"]]
                if state in claims.get("add", []):
                    current.append(start["key"])
                self.claims[state] = current
        self.homelands = {s: v for s, v in self.homelands.items() if v != base.homelands.get(s, [])}
        self.claims = {s: v for s, v in self.claims.items() if v != base.claims.get(s, [])}

    # --------------------------------------------------------------- queries

    def owner(self, province):
        return self.changed_provinces.get(province, self.base_owner.get(province, ""))

    def state_shares(self, state):
        return self.shares.get(state, self.base.shares.get(state, []))

    def has_part(self, state, tag):
        return any(s["country"] == tag for s in self.state_shares(state))

    def part_pops(self, state, tag):
        key = (state, tag)
        if key in self.pops:
            return self.pops[key] or []
        return self.base.pops.get(state, {}).get(tag, []) if self.has_part(state, tag) else []

    def part_buildings(self, state, tag):
        key = (state, tag)
        if key in self.buildings:
            return self.buildings[key] or []
        return self.base.buildings.get(state, {}).get(tag, []) if self.has_part(state, tag) else []

    def country_states(self, tag):
        """The states a country has a part of: [(state, share)]."""
        found = []
        for state in {*self.base.shares, *self.shares}:
            for share in self.state_shares(state):
                if share["country"] == tag:
                    found.append((state, share))
        return sorted(found)

    # ------------------------------------------------------------- working

    def _shares(self, state):
        provinces = self.base.state_provinces.get(state) or [p for s in self.base.shares.get(state, [])
                                                               for p in s["provinces"]]
        groups = {}
        for province in provinces:
            tag = self.owner(province)
            if tag:
                groups.setdefault(tag, []).append(province)
        base = {s["country"]: s for s in self.base.shares.get(state, [])}
        shares = []
        for tag, owned in groups.items():
            if tag in base:
                unincorporated = base[tag]["unincorporated"]
            else:  # a new part is as the part most of its provinces came from
                sources = Counter(self.base_owner.get(p, "") for p in owned)
                source = base.get(sources.most_common(1)[0][0])
                unincorporated = bool(source and source["unincorporated"])
            # a part that changed hands whole keeps its provinces in the order they were written
            same = next((s for s in base.values() if set(s["provinces"]) == set(owned)), None)
            if same:
                owned = list(same["provinces"])
            shares.append({"country": tag, "provinces": owned, "unincorporated": unincorporated})
        return shares

    def _move(self, state):
        """Pops and buildings of the parts of a state whose provinces changed owners."""
        pops, buildings = {}, {}
        tags = [s["country"] for s in self.shares[state]]
        for tag in tags:
            pops[tag], buildings[tag] = [], []
        new_parts = set(tags) - {s["country"] for s in self.base.shares.get(state, [])}
        pops_changed, buildings_changed = set(new_parts), set(new_parts)
        for share in self.base.shares.get(state, []):
            old = share["country"]
            own_pops = self.base.pops.get(state, {}).get(old, [])
            own_buildings = self.base.buildings.get(state, {}).get(old, [])
            provinces = share["provinces"] or [None]
            counts = Counter(self.owner(p) if p else old for p in provinces)
            if counts.get(old, 0) == len(provinces):
                pops[old] += own_pops
                buildings[old] += _copy_buildings(own_buildings)
                continue
            receivers = {tag: n for tag, n in counts.items() if tag}
            pops_changed.update([old, *receivers])
            for pop in own_pops:
                for tag, size in _share_out(pop["size"], counts, old, len(provinces)).items():
                    pops[tag].append({**pop, "size": size})
            if counts.get(old):
                buildings[old] += _copy_buildings(own_buildings)  # some provinces left: the buildings stay
            elif receivers:  # the part is gone: its buildings go to whoever has the most of it
                target = max(receivers, key=lambda tag: (receivers[tag], tag == tags[0]))
                self.moved[(state, old)] = target
                buildings_changed.add(target)
                buildings[target] += [{**b, "_from": old} for b in _copy_buildings(own_buildings)]
        for share in self.base.shares.get(state, []):
            if share["country"] not in pops:
                self.pops[(state, share["country"])] = None
                self.buildings[(state, share["country"])] = None
        for tag in tags:
            if tag in pops_changed:
                self.pops[(state, tag)] = _merge_pops(pops[tag])
            if tag in buildings_changed:
                self.buildings[(state, tag)] = buildings[tag]

    def _rehome(self):
        """Holders of buildings after parts changed owners (see the module notes):
        a holding building that moved is held by its new country; in a building that moved, what the old
        country held is the new country's; what a country without land held is the local owner's."""
        moved = self.moved
        parts = set()
        for state, tags in self.base.buildings.items():
            parts.update((state, tag) for tag in tags)
        parts.update(key for key, items in self.buildings.items() if items is not None)
        for state, tag in sorted(parts):
            if not self.has_part(state, tag):
                continue
            items = self.buildings.get((state, tag))
            source = items if items is not None else self.base.buildings.get(state, {}).get(tag, [])
            changed = False
            result = []
            for building in source:
                came_from = building.get("_from")
                owners = []
                for owner in building["ownership"]:
                    new = dict(owner)
                    if owner["kind"] == "building" and (owner["region"], owner["country"]) in moved:
                        new["country"] = moved[(owner["region"], owner["country"])]  # the holding building moved
                    elif came_from and owner["country"] == came_from and owner["kind"] in ("country", "building"):
                        new = {"kind": "country", "country": tag, "type": "", "region": "", "levels": owner["levels"]}
                    if new["country"] in self.vanished:
                        new = {"kind": "country", "country": tag, "type": "", "region": "", "levels": owner["levels"]}
                    changed = changed or new != owner
                    owners.append(new)
                result.append({key: value for key, value in building.items() if key != "_from"}
                              | {"ownership": _merge_owners(owners)})
            if changed or items is not None:
                self.buildings[(state, tag)] = _merge_buildings(result)

    # ------------------------------------------------------------ for pages

    def country(self, tag, pop_lists=None, building_lists=None):
        """What a country has, part by part, for the page: the lists before its own (see own_lists_of)."""
        parts = []
        for state, share in self.country_states(tag):
            parts.append({
                "state": state, "provinces": share["provinces"], "unincorporated": share["unincorporated"],
                "total": len(self.base.state_provinces.get(state, [])) or len(share["provinces"]),
                "pops": self.part_pops(state, tag), "buildings": self.part_buildings(state, tag),
                "moved": (state, tag) in self.pops,  # the pops or buildings changed with the territory
            })
        return parts


def _share_out(size, counts, old, total):
    """Pops of a part shared out by provinces: {tag: size}; provinces nobody owns take theirs away."""
    owners = [tag for tag in counts if tag]
    kept = round(size * sum(counts[tag] for tag in owners) / total)
    shares = {tag: size * counts[tag] // total for tag in owners}
    if owners:
        biggest = old if old in shares else max(owners, key=lambda tag: counts[tag])
        shares[biggest] += kept - sum(shares.values())
    return {tag: n for tag, n in shares.items() if n > 0}


# ------------------------------------------------------------------ writing

def _state_scopes(base, kind, state, cache):
    folder, top = STATE_DIRS[kind]
    found = []
    for rel in base.files(kind, state):
        if rel not in cache:
            text = base.text(rel)
            if text is None:
                continue
            cache[rel] = (Patcher(text), parse(text))
        patcher, root = cache[rel]
        found += [(patcher, entry) for name, entry in state_blocks(root, top) if name == state]
    return found


def _part_lines(kind, tag, items, others=()):
    lines = list(others)
    for item in items:
        lines += pop_lines(item) if kind == "pops" else building_lines(item)
    return _scoped_block_lines(f"region_state:{tag} =", lines) if lines else []


def write_territory(world, base, slug):
    """The history files the territory changes need: {game-relative path: text}."""
    cache = {}
    fresh = {kind: [] for kind in STATE_DIRS}

    # owners, homelands and claims
    states = set(world.shares) | set(world.homelands) | set(world.claims)
    for state in sorted(states):
        scopes = _state_scopes(base, "states", state, cache)
        shares = world.state_shares(state)
        homelands = world.homelands.get(state, base.homelands.get(state, []))
        claims = world.claims.get(state, base.claims.get(state, []))
        create = []
        for share in shares:
            inner = [f"country = c:{share['country']}",
                     "owned_provinces = { " + " ".join(f"x{p}" for p in share["provinces"]) + " }"]
            if share["unincorporated"]:
                inner.append("state_type = unincorporated")
            create += _scoped_block_lines("create_state =", inner)
        if not scopes:
            lines = create + [f"add_homeland = cu:{c}" for c in homelands] + [f"add_claim = c:{t}" for t in claims]
            fresh["states"].append(_scoped_block_lines(f"s:{state} =", lines))
            continue
        patcher, entry = scopes[-1]
        for other, other_entry in scopes[:-1]:
            for sub in other_entry.value.entries:
                if sub.key in ("create_state", "add_homeland", "add_claim"):
                    other.remove(sub)
        indent = entry_indent(patcher.text, entry.value)
        groups = [("create_state", create, state in world.shares),
                  ("add_homeland", [f"add_homeland = cu:{c}" for c in homelands], state in world.homelands),
                  ("add_claim", [f"add_claim = c:{t}" for t in claims], state in world.claims)]
        last = None
        for key, lines, changed in groups:
            existing = [sub for sub in entry.value.entries if sub.key == key]
            if changed:
                for i, sub in enumerate(existing):
                    if i == 0 and lines:
                        patcher.replace(sub, lines)
                    else:
                        patcher.remove(sub)
                if not existing and lines:
                    if last is not None:
                        patcher.insert_after(last, lines, indent)
                    else:
                        patcher.insert_end(entry.value, lines, indent)
            if existing:
                last = existing[-1]

    # pops and buildings of the parts that changed
    for kind, changes in (("pops", world.pops), ("buildings", world.buildings)):
        for (state, tag), items in sorted(changes.items(), key=lambda change: change[0]):
            scopes = _state_scopes(base, kind, state, cache)
            if kind == "buildings" and items is not None and _patch_buildings(scopes, state, tag, items, base):
                continue
            others = base.others.get(state, {}).get(tag, []) if kind == "buildings" and items is not None else []
            lines = _part_lines(kind, tag, items or [], others)
            placed = not lines
            for patcher, entry in scopes:
                for part in entry.value.entries:
                    if part.key == f"region_state:{tag}":
                        if not placed:
                            patcher.replace(part, lines)
                            placed = True
                        else:
                            patcher.remove(part)
            if placed:
                continue
            if scopes:
                patcher, entry = scopes[0]
                patcher.insert_end(entry.value, lines, entry_indent(patcher.text, entry.value))
            else:
                fresh[kind].append((state, lines))

    texts = {rel: patcher.result() for rel, (patcher, _root) in cache.items() if patcher.edits}
    for kind, blocks in fresh.items():
        if not blocks:
            continue
        folder, top = STATE_DIRS[kind]
        if kind == "states":
            body = [line for block in blocks for line in block]
        else:  # parts grouped by state
            by_state = {}
            for state, lines in blocks:
                by_state.setdefault(state, []).extend(lines)
            body = [line for state, lines in by_state.items() for line in _scoped_block_lines(f"s:{state} =", lines)]
        texts[f"{folder}/zzz_{slug}_{kind}.txt"] = f"{top} = {{\n" + "".join(f"\t{line}\n" for line in body) + "}\n"
    return texts


def _patch_buildings(scopes, state, tag, items, base):
    """When a part keeps the same buildings and only who holds them changed, rewrite just those
    buildings, so the rest of the part stays as it was. False when the part has to be written whole."""
    old = base.buildings.get(state, {}).get(tag, [])
    blocks = [(patcher, entry) for patcher, scope in scopes for part in scope.value.entries
              if part.key == f"region_state:{tag}" and isinstance(part.value, Block)
              for entry in part.value.entries if entry.key == "create_building" and isinstance(entry.value, Block)]
    if (len(old) != len(items) or len(blocks) != len(old)
            or any(a["building"] != b["building"] for a, b in zip(old, items))):
        return False
    for (patcher, entry), before, after in zip(blocks, old, items):
        if before != after:
            patcher.replace(entry, building_lines(after))
    return True
