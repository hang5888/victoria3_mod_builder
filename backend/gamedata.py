"""Loading game data from the game folder plus the selected mods."""
import os
import re
from pathlib import Path

from . import pdx_script
from .companies import company_from_block
from .countries import (COUNTRY_TYPES, HISTORY_DIRS, LITERACY_LEVELS, TARIFF_LEVELS, TAX_LEVELS, TIERS,
                        WEALTH_LEVELS, definition_from_block, parse_color, effect_steps, empty_history, read_government,
                        read_history, read_population, scope_blocks, tech_tier_techs)
from .characters import empty_characters, read_characters, template_info, COMMANDER_RANKS
from .diplomacy import DIPLOMACY_FOLDER, TREATY_FOLDER, read_diplomacy, read_treaties
from .flags import COLORED_DIR, PATTERN_DIR, TEXTURED_DIR
from .goods import TEMPLATE_GOOD, ENGLISH_TEMPLATES, good_from_block, need_from_block, prestige_good_from_block
from .laws import law_from_block, stances_from_block
from .territory import STATE_DIRS, read_state_parts, read_states, state_blocks
from .factories import (MODIFIER_SUFFIXES, MODIFIER_TEMPLATE_BUILDING, factory_from_block, pm_from_block,
                        pmg_from_block)
from .localization import Localization, read_loc_file
from .pdx_script import Block, INJECT_PREFIXES, split_prefix

GAME_SOURCE = "game"
# DLC features the game checks with has_dlc_feature (1.15.1). Scanning every script
# file for them takes far too long, so this list is the base; features used by the
# loaded companies are added to it.
DLC_FEATURES = (
    "agitators", "ep1_content", "ep1_cosmetics", "ep2_content", "foreign_investment", "ip2_content",
    "ip3_content", "ip4_content", "ip5_content", "lobbies", "mp1_charter_companies", "mp1_content",
    "mp1_prestige_goods", "mp1_treaties", "power_bloc_features", "regional_exile_pools", "rp1_content",
    "ship_designer", "subject_and_bloc_actions", "voice_of_the_people_content", "voice_of_the_people_preorder",
)
_DLC_FEATURE = re.compile(r"has_dlc_feature\s*=\s*([A-Za-z0-9_]+)")
COMPANY_ICON_DIR = "gfx/interface/icons/company_icons"
COMPANY_BACKGROUND_DIR = "gfx/interface/icons/company_icons/company_backgrounds"
# Categories that exist even when no loaded company happens to use them.
BUILDING_ICON_DIR = "gfx/interface/icons/building_icons"
BUILDING_BACKGROUND_DIR = "gfx/interface/icons/building_icons/backgrounds"
PM_ICON_DIR = "gfx/interface/icons/production_method_icons"
PMG_ICON_DIR = "gfx/interface/icons/generic_icons"
LAW_ICON_DIR = "gfx/interface/icons/law_icons"
GOODS_ICON_DIR = "gfx/interface/icons/goods_icons"
PRESTIGE_ICON_DIR = "gfx/interface/icons/goods_icons/prestige_goods"
# The columns of the game's law screen, in order (law_group_category of the law groups),
# and the interface texts naming them.
LAW_CATEGORIES = {"power_structure": "POWER_STRUCTURE", "economy": "ECONOMY", "human_rights": "HUMAN_RIGHTS"}
# Building groups a factory can be put in: these and the groups below them.
PRODUCTION_GROUPS = ("bg_manufacturing", "bg_agriculture", "bg_ranching", "bg_plantations", "bg_extraction")
# Game objects only picked by key in the forms: payload name -> folder.
KEY_LISTS = {
    "principles": "common/power_bloc_principles",
    "identities": "common/power_bloc_identities",
    "religions": "common/religions",
    "straits": "common/strait_definitions",
    "culture_traits": "common/discrimination_traits",
}
BASE_CATEGORIES = ("aristocrat_owned", "bureaucrat_owned", "shopkeeper_owned", "academic_owned")


class Source:
    """One place files are read from: the game itself or a mod."""

    def __init__(self, source_id, name, root, kind, replace_paths=()):
        self.id = source_id
        self.name = name
        self.root = Path(root)
        self.kind = kind
        self.replace_paths = [p.replace("\\", "/").strip("/").lower() for p in replace_paths]


class FileSystem:
    """The game's merged view of files: later sources override earlier ones."""

    def __init__(self, sources):
        self.sources = sources

    def resolve(self, rel):
        """Absolute path of a game-relative file, from the last source that has it."""
        for source in reversed(self.sources):
            path = source.root / rel
            if path.is_file():
                return path
        return None

    def list_files(self, rel_dir, suffix, recursive=False):
        """Files in a folder as (source, path, relative name), in load order.

        A file with the same relative path in a later source replaces the
        earlier one, and files are then read in file name order.
        """
        merged = {}
        rel_key = rel_dir.lower()
        for source in self.sources:
            if rel_key in source.replace_paths:
                merged.clear()
            base = source.root / rel_dir
            if not base.is_dir():
                continue
            walker = os.walk(base) if recursive else [(str(base), [], os.listdir(base))]
            for folder, _dirs, names in walker:
                for name in names:
                    if not name.lower().endswith(suffix):
                        continue
                    path = Path(folder) / name
                    if not recursive and not path.is_file():
                        continue
                    rel_name = path.relative_to(base).as_posix()
                    merged[rel_name.lower()] = (source, path, rel_name)
        return [merged[k] for k in sorted(merged)]

    def loc_files(self, language):
        """All localization files for a language, in override order."""
        suffix = f"_l_{language}.yml"
        normal, replace = [], []
        for source in self.sources:
            base = source.root / "localization"
            if not base.is_dir():
                continue
            for folder, _dirs, names in os.walk(base):
                is_replace = "replace" in Path(folder).relative_to(base).parts
                for name in sorted(names):
                    if name.lower().endswith(suffix):
                        (replace if is_replace else normal).append(Path(folder) / name)
        return normal + replace


def read_text(path):
    with open(path, encoding="utf-8-sig", errors="replace") as f:
        return f.read()


def _number(value, default):
    """A script value as a number; `default` when it is missing or not a plain number."""
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _descs(block, found):
    """Every `desc = key` in a block (a triggered name), in order."""
    for entry in block.entries:
        if entry.key == "desc" and isinstance(entry.value, str):
            found.append(entry.value)
        elif isinstance(entry.value, Block):
            _descs(entry.value, found)
    return found


def game_languages(game_dir):
    """Languages the game ships with, as [{key, name}], read from its localization folder."""
    base = Path(game_dir) / "localization"
    try:
        names = read_loc_file(base / "languages.yml").get("english", {})
        keys = sorted(p.name for p in base.iterdir() if p.is_dir() and any(p.glob(f"*_l_{p.name}.yml")))
    except OSError:
        return []
    if "english" in keys:  # English first: it is the fallback language
        keys.remove("english")
        keys.insert(0, "english")
    return [{"key": k, "name": names.get(f"l_{k}", k)} for k in keys]


class StartBase:
    """The files in effect that the country starts of a mod are written from (see countries.write_starts)."""

    def __init__(self, data):
        self.data = data
        # what territory.World works from
        self.state_provinces = {key: state["provinces"] for key, state in data.states.items() if not state["sea"]}
        self.shares = data.state_shares
        self.homelands = data.state_homelands
        self.claims = data.state_claims
        self.pops = data.state_pops
        self.buildings = data.state_buildings
        self.others = data.state_others
        self.articles = data.treaty_articles  # {article: {kind, inputs}}, what treaties are written with
        # the game's countries (a start may name a new one deleted from the mod); None: not known
        self.countries = set(data.country_defs) if hasattr(data, "country_defs") else None

    def files(self, kind, key):
        """Files with the block of a country (history kinds) or of a state (states, pops, buildings)."""
        if kind in STATE_DIRS:
            return self.data.state_files[kind].get(key, [])
        return self.data.history_files[kind].get(key, [])

    def folder_files(self, folder):
        """Every file of a history folder (game-relative paths), as diplomacy and treaties."""
        found = []
        for _source, path, rel_name in self.data.fs.list_files(folder, ".txt"):
            rel = f"{folder}/{rel_name}"
            self.data.history_paths[rel] = path
            found.append(rel)
        return found

    def text(self, rel):
        path = self.data.history_paths.get(rel)
        try:
            return read_text(path) if path else None
        except OSError:
            return None

    def law_group(self, law):
        info = self.data.laws.get(law)
        return info["group"] if info else ""

    def ruling(self, tag):
        return (self.data.histories.get(tag) or {}).get("ruling", [])

    def definition(self, tag):
        """Source text of the country's definition in effect, `{ ... }`; None for an unknown country."""
        info = self.data.country_defs.get(tag)
        return info["raw"] if info else None


class GameData:
    def __init__(self, game_dir, mods, progress=lambda step, done, total: None):
        """`mods` is the list of enabled mods (dicts from mods.discover_mods) in load order."""
        sources = [Source(GAME_SOURCE, "Victoria 3", game_dir, "game")]
        sources += [Source(m["id"], m["name"], m["dir"], m["kind"], m.get("replace_paths", ())) for m in mods]
        self.fs = FileSystem(sources)
        self.sources = sources
        self.warnings = []
        self._loc = {}

        steps = [
            ("companies", self._load_companies),
            ("buildings", self._load_buildings),
            ("modifiers", self._load_modifiers),
            ("states", self._load_states),
            ("misc", self._load_misc),
            ("countries", self._load_countries),
            ("textures", self._load_textures),
            ("localization", lambda: self.localization("english")),
        ]
        for i, (step, func) in enumerate(steps):
            progress(step, i, len(steps))
            func()
        progress("done", len(steps), len(steps))

    # ------------------------------------------------------------ database

    def load_db(self, rel_dir, origins=None):
        """Read every definition in a folder into {key: (Block, Source, file name)}.

        REPLACE-style prefixes and plain redefinitions replace the earlier
        definition; INJECT-style prefixes add their statements to it. If
        `origins` is a dict, it gets {key: [(Source, Block, file name)]}: the
        definition as it stood after each source that defines, replaces or
        injects into the key, in load order (the last one is in effect).
        """
        db = {}

        def touched(key, source, rel_name):
            if origins is None:
                return
            block = db[key][0]
            snapshot = Block(list(block.entries), block.start, block.end, block.text)
            versions = [v for v in origins.get(key, []) if v[0].id != source.id]
            origins[key] = versions + [(source, snapshot, rel_name)]

        for source, path, rel_name in self.fs.list_files(rel_dir, ".txt"):
            try:
                root = pdx_script.parse(read_text(path))
            except (OSError, RecursionError) as error:
                self.warnings.append(f"{source.name}: {rel_dir}/{rel_name}: {error}")
                continue
            for entry in root.entries:
                if entry.key is None or not isinstance(entry.value, Block):
                    continue
                prefix, key = split_prefix(entry.key)
                if prefix in INJECT_PREFIXES:
                    if key in db:
                        db[key][0].entries.extend(entry.value.entries)
                        touched(key, source, rel_name)
                    elif prefix == "INJECT_OR_CREATE":
                        db[key] = (entry.value, source, rel_name)
                        touched(key, source, rel_name)
                    elif prefix == "INJECT":
                        self.warnings.append(f"{source.name}: {rel_dir}/{rel_name}: INJECT target {key} not found")
                elif prefix in ("REPLACE", "TRY_REPLACE") and key not in db:
                    if prefix == "REPLACE":
                        self.warnings.append(f"{source.name}: {rel_dir}/{rel_name}: REPLACE target {key} not found")
                else:
                    db[key] = (entry.value, source, rel_name)
                    touched(key, source, rel_name)
        return db

    def _load_companies(self):
        self.companies = {}
        self.dlc_features = set(DLC_FEATURES)
        origins = {}
        for key, (block, source, rel_name) in self.load_db("common/company_types", origins).items():
            company = company_from_block(key, block)
            company["source"] = source.id  # where the definition in effect was written
            company["file"] = rel_name
            # Every source that defines or changes it, and the earlier versions to copy from.
            company["sources"] = [s.id for s, _b, _f in origins[key]]
            company["versions"] = [{**company_from_block(key, b), "source": s.id, "file": f}
                                   for s, b, f in origins[key][:-1]]
            self.companies[key] = company
            self.dlc_features.update(_DLC_FEATURE.findall(block.text[block.start:block.end]))

    def _load_buildings(self):
        self.lenses = set()  # sections of the build menu
        self.building_groups = {}
        self.group_info = {}
        for key, (block, _source, _file) in self.load_db("common/building_groups").items():
            parent = block.get("parent_group")
            self.building_groups[key] = parent if isinstance(parent, str) else None
            self.group_info[key] = {name: block.get(name) == "yes"
                                    for name in ("always_possible", "is_subsistence", "capped_by_resources")}
            self.group_info[key]["rural"] = block.get("land_usage") == "rural"
            funded = block.get("is_government_funded")  # yes / no, or None to take the parent group's
            self.group_info[key]["funded"] = funded == "yes" if funded in ("yes", "no") else None
            lens = block.get("lens")
            if isinstance(lens, str):
                self.lenses.add(lens)
        self.buildings = {}
        self.factories = {}  # every building, in the factory builder's model
        origins = {}
        for key, (block, source, rel_name) in self.load_db("common/buildings", origins).items():
            factory = factory_from_block(key, block)
            self.buildings[key] = {"group": factory["building_group"], "icon": factory["icon"]}
            factory["source"] = source.id
            factory["file"] = rel_name
            factory["sources"] = [s.id for s, _b, _f in origins[key]]
            factory["versions"] = [{**factory_from_block(key, b), "source": s.id, "file": f}
                                   for s, b, f in origins[key][:-1]]
            self.factories[key] = factory
        self.pmgs = {key: {**pmg_from_block(key, block), "source": source.id}
                     for key, (block, source, _file) in self.load_db("common/production_method_groups").items()}
        self.pms = {key: {**pm_from_block(key, block), "source": source.id}
                    for key, (block, source, _file) in self.load_db("common/production_methods").items()}
        self.goods = {}
        origins = {}
        for key, (block, source, rel_name) in self.load_db("common/goods", origins).items():
            good = good_from_block(key, block)
            good["source"] = source.id
            good["file"] = rel_name
            good["sources"] = [s.id for s, _b, _f in origins[key]]
            good["versions"] = [{**good_from_block(key, b), "source": s.id, "file": f} for s, b, f in origins[key][:-1]]
            self.goods[key] = good
        self.pop_types = {}
        for key, (block, _source, _file) in self.load_db("common/pop_types").items():
            texture = block.get("texture")
            self.pop_types[key] = {"icon": texture if isinstance(texture, str) else "",
                                   "wage_weight": _number(block.get("wage_weight"), 1.0),
                                   "working_adult_ratio": _number(block.get("working_adult_ratio"), None)}
        # construction_cost_x = 400 lines among the script values
        self.construction_costs = {}
        for source, path, rel_name in self.fs.list_files("common/script_values", ".txt"):
            try:
                root = pdx_script.parse(read_text(path))
            except (OSError, RecursionError) as error:
                self.warnings.append(f"{source.name}: common/script_values/{rel_name}: {error}")
                continue
            for entry in root.entries:
                if entry.key and entry.key.startswith("construction_cost_") and isinstance(entry.value, str):
                    self.construction_costs[entry.key] = entry.value

    def group_chain(self, group):
        """A building group and the groups above it."""
        chain = []
        while group and group not in chain:
            chain.append(group)
            group = self.building_groups.get(group)
        return chain

    def _load_modifiers(self):
        self.modifiers = {}
        for key, (block, _source, _file) in self.load_db("common/modifier_type_definitions").items():
            color = block.get("color")
            self.modifiers[key] = {
                "percent": block.get("percent") == "yes",
                "color": color if color in ("good", "bad") else "neutral",
            }

    def _load_states(self):
        self.states = {}
        for key, (block, _source, _file) in self.load_db("map_data/state_regions").items():
            provinces = block.get("provinces")
            state_id = block.get("id")
            self.states[key] = {
                "id": int(state_id) if isinstance(state_id, str) and state_id.isdigit() else 0,
                "provinces": [p.lstrip("xX").upper() for p in provinces.items()] if isinstance(provinces, Block) else [],
                "sea": block.get("city") is None and block.get("subsistence_building") is None,
                "region": "",
            }
        self.regions = {}
        for key, (block, _source, _file) in self.load_db("common/strategic_regions").items():
            states = block.get("states")
            members = states.items() if isinstance(states, Block) else []
            self.regions[key] = members
            for state in members:
                if state in self.states:
                    self.states[state]["region"] = key

    def _load_misc(self):
        self.country_defs = {}
        origins = {}
        for key, (block, source, rel_name) in self.load_db("common/country_definitions", origins).items():
            self.country_defs[key] = {**definition_from_block(block), "source": source.id, "file": rel_name,
                                      "sources": [s.id for s, _b, _f in origins[key]],
                                      "raw": block.text[block.start:block.end]}  # copied when it is overridden
        self.countries = list(self.country_defs)
        self.prestige_goods = {}
        origins = {}
        for key, (block, source, rel_name) in self.load_db("common/prestige_goods", origins).items():
            good = prestige_good_from_block(key, block)
            good["source"] = source.id
            good["file"] = rel_name
            good["sources"] = [s.id for s, _b, _f in origins[key]]
            good["versions"] = [{**prestige_good_from_block(key, b), "source": s.id, "file": f}
                                for s, b, f in origins[key][:-1]]
            self.prestige_goods[key] = good
        self._load_goods_extras()
        self.technologies = {}
        for key, (block, _source, _file) in self.load_db("common/technology/technologies").items():
            texture, era, category = block.get("texture"), block.get("era"), block.get("category")
            era_number = era.rpartition("_")[2] if isinstance(era, str) else ""  # era_3 -> 3 (eras have no names)
            self.technologies[key] = {"icon": texture if isinstance(texture, str) else "",
                                      "era": int(era_number) if era_number.isdigit() else 0,
                                      # production, military or society: the tabs of the game's tech screen
                                      "category": category if isinstance(category, str) else ""}
        self.culture_religions = {}
        self.culture_traits = {}  # culture -> {heritage, language}, for the pickers' filters
        for key, (block, _source, _file) in self.load_db("common/cultures").items():
            religion = block.get("religion")
            self.culture_religions[key] = religion if isinstance(religion, str) else ""
            self.culture_traits[key] = {name: value if isinstance(value, str) else ""
                                        for name, value in (("heritage", block.get("heritage")),
                                                            ("language", block.get("language")))}
        self.cultures = list(self.culture_religions)
        # what each geographic region is made of: strategic regions and state regions
        self.geographic_regions = {}
        for key, (block, _source, _file) in self.load_db("common/geographic_regions").items():
            regions, states = block.get("strategic_regions"), block.get("state_regions")
            self.geographic_regions[key] = {
                "regions": [r[3:] if r.startswith("sr:") else r for r in regions.items()]
                if isinstance(regions, Block) else [],
                "states": [s[2:] if s.startswith("s:") else s for s in states.items()]
                if isinstance(states, Block) else []}
        # parties, with the key of their name: the last text of their name, the one used when no other fits
        self.parties = {}
        for key, (block, _source, _file) in self.load_db("common/parties").items():
            name = block.get("name")
            texts = _descs(name, []) if isinstance(name, Block) else [name] if isinstance(name, str) else []
            self.parties[key] = texts[-1] if texts else key
        self.key_lists = {name: list(self.load_db(folder)) for name, folder in KEY_LISTS.items()}
        for factory in self.factories.values():
            lens = next((e.value for e in pdx_script.parse(factory["extra"]).entries
                         if e.key == "lens" and isinstance(e.value, str)), None)
            if lens:
                self.lenses.add(lens)
        self.key_lists["lenses"] = sorted(self.lenses)
        self._load_wages()
        self._load_laws()
        self._load_map_objects()

    def _load_goods_extras(self):
        """What goods are bought with (the pops' needs) and their market chart colours."""
        self.pop_needs = {key: need_from_block(block)
                          for key, (block, _source, _file) in self.load_db("common/pop_needs").items()}
        self.goods_colors = {}
        for source, path, rel_name in self.fs.list_files("common/named_colors", ".txt"):
            try:
                root = pdx_script.parse(read_text(path))
            except (OSError, RecursionError) as error:
                self.warnings.append(f"{source.name}: common/named_colors/{rel_name}: {error}")
                continue
            for block in root.get_all("colors"):
                if not isinstance(block, Block):
                    continue
                for entry in block.entries:
                    if entry.key in self.goods:
                        color = parse_color(entry.value)
                        if color:
                            self.goods_colors[entry.key] = color

    def _load_laws(self):
        """Laws with their groups, and what decides the interest groups' stances on them."""
        self.law_groups = {}
        for key, (block, _source, _file) in self.load_db("common/law_groups").items():
            category, hierarchy, enable = (block.get(name) for name in
                                           ("law_group_category", "linked_social_hierarchy", "enable"))
            self.law_groups[key] = {
                "category": category if isinstance(category, str) else "",
                # who the group is for: a social hierarchy (as the caste system), or its enable trigger
                "hierarchy": hierarchy if isinstance(hierarchy, str) else "",
                "enable": enable.inner() if isinstance(enable, Block) else ""}
        self.laws = {}
        origins = {}
        # in the order the game reads them: the first law of a group is its default
        for key, (block, source, rel_name) in self.load_db("common/laws", origins).items():
            law = law_from_block(key, block)
            law["source"] = source.id
            law["file"] = rel_name
            law["sources"] = [s.id for s, _b, _f in origins[key]]
            law["versions"] = [{**law_from_block(key, b), "source": s.id, "file": f} for s, b, f in origins[key][:-1]]
            self.laws[key] = law
        self.ideologies = {key: stances_from_block(block)
                           for key, (block, _source, _file) in self.load_db("common/ideologies").items()}
        self.interest_groups = {}
        for key, (block, _source, _file) in self.load_db("common/interest_groups").items():
            texture, ideologies = block.get("texture"), block.get("ideologies")
            self.interest_groups[key] = {
                "icon": texture if isinstance(texture, str) else "",
                "ideologies": ideologies.items() if isinstance(ideologies, Block) else []}
        # social hierarchies a law group can be tied to (not the default one, which everybody is in)
        self.social_hierarchies = [key for key, (block, _source, _file) in self.load_db("common/social_hierarchies").items()
                                   if block.get("is_default") != "yes"]
        self.institutions = {}
        for key, (block, _source, _file) in self.load_db("common/institutions").items():
            icon = block.get("icon")
            self.institutions[key] = {"icon": icon if isinstance(icon, str) else ""}

    def _load_wages(self):
        """What the factory estimate prices wages with: the cost of each wealth level's needs (the buy
        packages: £ at base prices per 10000 people a week) and the base share of working adults."""
        self.buy_packages = {}
        for key, (block, _source, _file) in self.load_db("common/buy_packages").items():
            level = key[len("wealth_"):] if key.startswith("wealth_") else ""
            # mods add needs with TRY_INJECT:wealth_10 = { goods = { ... } }: a second goods block, added to the first
            goods = [g for g in block.get_all("goods") if isinstance(g, Block)]
            if level.isdigit() and goods:
                self.buy_packages[int(level)] = sum(_number(e.value, 0.0) for g in goods for e in g.entries if e.key)
        self.working_adult_ratio = 0.25
        for source, path, rel_name in self.fs.list_files("common/defines", ".txt"):
            try:
                root = pdx_script.parse(read_text(path))
            except (OSError, RecursionError) as error:
                self.warnings.append(f"{source.name}: common/defines/{rel_name}: {error}")
                continue
            # mods change single defines, so the last value of the setting wins, not the last block
            for block in root.get_all("NPops"):
                if isinstance(block, Block):
                    self.working_adult_ratio = _number(block.get("WORKING_ADULT_RATIO_BASE"), self.working_adult_ratio)

    def _load_map_objects(self):
        """Map positions of the locators buildings use (monuments), and who owns each state at the start."""
        wanted = set()
        for factory in self.factories.values():
            for version in (factory, *factory["versions"]):
                for entry in pdx_script.parse(version["extra"]).entries:
                    if entry.key == "locator" and isinstance(entry.value, str):
                        wanted.add(entry.value)
        self.locators = {}
        for source, path, rel_name in self.fs.list_files("gfx/map/map_object_data", ".txt"):
            text = read_text(path)
            if "game_object_locator" not in text or not any(name in text for name in wanted):
                continue
            for entry in pdx_script.parse(text).entries:
                if entry.key != "game_object_locator" or not isinstance(entry.value, Block):
                    continue
                name, instances = entry.value.get("name"), entry.value.get("instances")
                if name not in wanted or not isinstance(instances, Block):
                    continue
                for instance in instances.entries:
                    position = instance.value.get("position") if isinstance(instance.value, Block) else None
                    numbers = position.items() if isinstance(position, Block) else []
                    try:
                        self.locators[name] = (float(numbers[0]), float(numbers[2]))
                        break
                    except (IndexError, ValueError):
                        continue
        # the parts of each state region the countries own ([{country, provinces, unincorporated}]), the
        # cultures with a homeland there and the countries claiming it; and which files have each state
        self.state_shares, self.state_homelands, self.state_claims = {}, {}, {}
        self.history_paths = {}  # game-relative path of a history file -> the file in effect
        self.state_files = {kind: {} for kind in STATE_DIRS}  # kind -> state -> [paths with its block]
        folder, top = STATE_DIRS["states"]
        for root, rel, path in self._history_roots(folder):
            self.history_paths[rel] = path
            self._note_state_files("states", root, rel)
            read_states(root, self.state_shares, self.state_homelands, self.state_claims)
        self.state_owners = {state: list(dict.fromkeys(s["country"] for s in shares))
                             for state, shares in self.state_shares.items()}

    def _note_state_files(self, kind, root, rel):
        for state, _entry in state_blocks(root, STATE_DIRS[kind][1]):
            files = self.state_files[kind].setdefault(state, [])
            if rel not in files:
                files.append(rel)

    def _load_countries(self):
        """How each country starts: its history, wealth and literacy, ruling party, and what it has."""
        self.history_files = {kind: {} for kind in HISTORY_DIRS}  # kind -> tag -> [paths with its block]
        self.histories, self.populations, self.governments = {}, {}, {}
        self.characters = {}
        readers = {"countries": (self.histories, empty_history, read_history),
                   "population": (self.populations, lambda: {"wealth": "", "literacy": ""}, read_population),
                   "governments": (self.governments, lambda: {"ruling_party": ""}, read_government),
                   "characters": (self.characters, empty_characters, read_characters)}
        for kind, (folder, top) in HISTORY_DIRS.items():
            target, empty, read = readers[kind]
            for root, rel, path in self._history_roots(folder):
                self.history_paths[rel] = path
                for tag, entry in scope_blocks(root, top):
                    files = self.history_files[kind].setdefault(tag, [])
                    if rel not in files:
                        files.append(rel)
                    read(target.setdefault(tag, empty()), entry.value)

        self.country_stats = {}

        def stats(tag):
            return self.country_stats.setdefault(tag, {"states": 0, "provinces": 0, "population": 0,
                                                       "buildings": 0, "characters": 0})

        for shares in self.state_shares.values():
            for share in shares:
                stats(share["country"])["states"] += 1
                stats(share["country"])["provinces"] += len(share["provinces"])
        # the pops and buildings of each country's part of each state: {state: {tag: [items]}}, and the
        # other statements of the parts in the building files
        self.state_pops, self.state_buildings, self.state_others = {}, {}, {}
        for kind, parts in (("pops", self.state_pops), ("buildings", self.state_buildings)):
            folder, top = STATE_DIRS[kind]
            for root, rel, path in self._history_roots(folder):
                self.history_paths[rel] = path
                self._note_state_files(kind, root, rel)
                read_state_parts(root, top, kind, parts, self.state_others if kind == "buildings" else {})
        for parts in self.state_pops.values():
            for tag, pops in parts.items():
                stats(tag)["population"] += sum(pop["size"] for pop in pops)
        for parts in self.state_buildings.values():
            for tag, buildings in parts.items():
                stats(tag)["buildings"] += len(buildings)
        for tag, characters in self.characters.items():
            stats(tag)["characters"] += len(characters["items"])
        self._load_relations()

        # the starting law presets and technology tiers the histories use
        self._triggers = None
        self.start_effects, self.tech_tiers = {}, {}
        for source, path, rel_name in self.fs.list_files("common/scripted_effects", ".txt"):
            text = read_text(path)
            if "effect_starting_" not in text:
                continue
            for entry in pdx_script.parse(text).entries:
                if not (entry.key and isinstance(entry.value, Block)):
                    continue
                tier = re.fullmatch(r"effect_starting_technology_tier_(\d)_tech", entry.key)
                if entry.key.startswith("effect_starting_politics_"):
                    self.start_effects[entry.key] = effect_steps(entry.value, self.scripted_trigger)
                elif tier:
                    self.tech_tiers[int(tier.group(1))] = tech_tier_techs(entry.value)
        self._triggers = None  # only needed while reading the presets

    def _load_relations(self):
        """Diplomacy and treaties as the game starts, character templates, and what they are made of."""
        self.diplomacy = []  # the statements the tool knows: {kind, first, second, type, value, file}
        for root, rel, path in self._history_roots(DIPLOMACY_FOLDER):
            self.history_paths[rel] = path
            found = []
            read_diplomacy(root, rel, found)
            self.diplomacy += [{**item, "file": rel} for item, *_rest in found]
        self.treaties = []
        for root, rel, path in self._history_roots(TREATY_FOLDER):
            self.history_paths[rel] = path
            found = []
            read_treaties(root, rel, found)
            seen = set()
            for treaty, _rel, _entry in found:
                if treaty["id"] not in seen:  # the two versions of a DLC condition are one treaty
                    seen.add(treaty["id"])
                    self.treaties.append({**treaty, "file": rel})
        # pacts: diplomatic actions with a pact; a subject relationship when it gives a subject type
        self.pact_types = {}
        for key, (block, _source, _file) in self.load_db("common/diplomatic_actions").items():
            pact = block.get("pact")
            if isinstance(pact, Block):
                self.pact_types[key] = {"subject": isinstance(pact.get("subject_type"), str)}
        self.treaty_articles = {}
        for key, (block, _source, _file) in self.load_db("common/treaty_articles").items():
            inputs = block.get("required_inputs")
            self.treaty_articles[key] = {"kind": "mutual" if block.get("kind") == "mutual" else "directed",
                                         "inputs": inputs.items() if isinstance(inputs, Block) else []}
        self.character_templates = {key: template_info(block) for key, (block, _s, _f)
                                    in self.load_db("common/character_templates").items() if key != "default"}
        self.character_traits = {}
        for key, (block, _source, _file) in self.load_db("common/character_traits").items():
            kind = block.get("type")
            self.character_traits[key] = kind if isinstance(kind, str) else ""
        self.character_ideologies = [key for key, (block, _s, _f) in self.load_db("common/ideologies").items()
                                     if block.get("character_ideology") == "yes"]
        self._load_coat_of_arms()

    def _load_coat_of_arms(self):
        """What the flags of new countries are made of: patterns, emblems and the coat of arms colours."""
        def files(folder, suffixes):
            return sorted(rel for _s, _p, rel in self.fs.list_files(folder, suffixes) if "/" not in rel)

        self.coa_patterns = [f for f in files(PATTERN_DIR, (".dds", ".tga")) if f.startswith("pattern")]
        self.coa_colored = [f for f in files(COLORED_DIR, (".dds", ".tga")) if f.lower() != "null.dds"]
        self.coa_textured = files(TEXTURED_DIR, (".dds", ".tga", ".png"))
        # named colours: those of the coat of arms files first (the ones the game's flags use)
        self.coa_colors = {}
        for source, path, rel_name in self.fs.list_files("common/named_colors", ".txt"):
            try:
                root = pdx_script.parse(read_text(path))
            except (OSError, RecursionError) as error:
                self.warnings.append(f"{source.name}: common/named_colors/{rel_name}: {error}")
                continue
            for block in root.get_all("colors"):
                if not isinstance(block, Block):
                    continue
                for entry in block.entries:
                    color = parse_color(entry.value) if entry.key else None
                    if color and ("coa" in rel_name.lower() or entry.key not in self.coa_colors):
                        self.coa_colors[entry.key] = {"rgb": color, "coa": "coa" in rel_name.lower()}

    def _history_roots(self, folder):
        """The parsed history files of a folder: (root block, game-relative path, file in effect)."""
        for source, path, rel_name in self.fs.list_files(folder, ".txt"):
            try:
                yield pdx_script.parse(read_text(path)), f"{folder}/{rel_name}", path
            except (OSError, RecursionError) as error:
                self.warnings.append(f"{source.name}: {folder}/{rel_name}: {error}")

    def scripted_trigger(self, name):
        """A scripted trigger's block, or None (read on first use)."""
        if self._triggers is None:
            self._triggers = {key: block for key, (block, _s, _f) in self.load_db("common/scripted_triggers").items()}
        return self._triggers.get(name)

    def start_base(self):
        """What the country starts are written from: the files in effect without the mod being built."""
        return StartBase(self)

    def _load_textures(self):
        suffixes = (".dds", ".png")  # some mods ship .png icons
        backgrounds = {f"{COMPANY_BACKGROUND_DIR}/{rel}" for _s, _p, rel in
                       self.fs.list_files(COMPANY_BACKGROUND_DIR, suffixes, recursive=True)}
        icons = {f"{COMPANY_ICON_DIR}/{rel}" for _s, _p, rel in
                 self.fs.list_files(COMPANY_ICON_DIR, suffixes, recursive=True)} - backgrounds
        # Mods may keep their images elsewhere; include whatever companies point at.
        for company in self.companies.values():
            for version in [company, *company["versions"]]:
                if version["icon"]:
                    icons.add(version["icon"])
                if version["background"]:
                    backgrounds.add(version["background"])
        self.icons = sorted(icons)
        self.backgrounds = sorted(backgrounds)

        def folder(rel_dir):
            return {f"{rel_dir}/{rel}" for _s, _p, rel in self.fs.list_files(rel_dir, suffixes)}

        versions = [v for factory in self.factories.values() for v in (factory, *factory["versions"])]
        self.building_icons = sorted(folder(BUILDING_ICON_DIR) | {v["icon"] for v in versions if v["icon"]})
        self.building_backgrounds = sorted(folder(BUILDING_BACKGROUND_DIR)
                                           | {v["background"] for v in versions if v["background"]})
        self.pm_icons = sorted(folder(PM_ICON_DIR) | {pm["texture"] for pm in self.pms.values() if pm["texture"]})
        self.pmg_icons = sorted({path for path in folder(PMG_ICON_DIR) if "/mixed_icon" in path}
                                | {pmg["texture"] for pmg in self.pmgs.values() if pmg["texture"]})
        self.law_icons = sorted(folder(LAW_ICON_DIR) | {v["icon"] for law in self.laws.values()
                                                         for v in (law, *law["versions"]) if v["icon"]})
        self.goods_icons = sorted(folder(GOODS_ICON_DIR) | {good["texture"] for good in self.goods.values()
                                                             if good["texture"]})
        self.prestige_icons = sorted(folder(PRESTIGE_ICON_DIR) | {good["texture"] for good in self.prestige_goods.values()
                                                                   if good["texture"]})

    # -------------------------------------------------------- localization

    def localization(self, language):
        if language not in self._loc:
            entries = {}
            for path in self.fs.loc_files(language):
                try:
                    entries.update(read_loc_file(path).get(language, {}))
                except OSError as error:
                    self.warnings.append(f"{path}: {error}")
            fallback = None if language == "english" else self.localization("english")
            self._loc[language] = Localization(entries, fallback)
        return self._loc[language]

    # ------------------------------------------------------------- payload

    def payload(self, language):
        """Everything the frontend needs, with names in the given language."""
        loc = self.localization(language)
        used_buildings, used_modifiers, categories = set(), set(), list(BASE_CATEGORIES)
        companies = []
        for key, company in self.companies.items():
            used_buildings.update(company["building_types"], company["extension_building_types"])
            used_modifiers.update(m["key"] for m in company["prosperity_modifier"])
            if company["category"] and company["category"] not in categories:
                categories.append(company["category"])
            companies.append({**company, "name": loc.name(key)})

        def group_root(group):
            chain = self.group_chain(group)
            return chain[-1] if chain else group

        groups = []
        for key in self.building_groups:
            chain = self.group_chain(key)
            flags = [self.group_info[g] for g in chain if g in self.group_info]
            groups.append({
                "key": key, "name": loc.name(key), "root": chain[-1], "parent": self.building_groups.get(key) or "",
                # where a factory can be put: production groups, not the subsistence ones
                "production": chain[-1] in PRODUCTION_GROUPS and not any(f["is_subsistence"] for f in flags),
                # needs arable land or a resource in the state region
                "needs_resources": (not any(f["always_possible"] for f in flags)
                                    and any(f["rural"] or f["capped_by_resources"] for f in flags)),
                # the state pays the wages and inputs (government buildings, monuments); the nearest group that says
                "government_funded": next((f["funded"] for f in flags if f["funded"] is not None), False),
            })

        buildings = []
        for key, info in self.buildings.items():
            root = group_root(info["group"])
            buildings.append({"key": key, "name": loc.name(key), "group": root, "icon": info["icon"],
                              "group_name": loc.name(root) if root else "", "used": key in used_buildings})
        # laws in the order the game reads them; the first of each group is the default
        laws, seen_groups, law_modifiers = [], set(), set()
        for key, law in self.laws.items():
            laws.append({**law, "name": loc.name(key), "desc": loc.name(f"{key}_desc", ""),
                         "group_name": loc.name(law["group"]) if law["group"] else "",
                         "default": law["group"] not in seen_groups})
            seen_groups.add(law["group"])
            law_modifiers.update(m["key"] for rows in law["modifiers"].values() for m in rows)
        # "used": by a company; "law_used": by a law (for the pickers' "only used" switches)
        modifiers = [{"key": key, "name": loc.name(key), "used": key in used_modifiers,
                      "law_used": key in law_modifiers, **info}
                     for key, info in self.modifiers.items()]
        for key in sorted((used_modifiers | law_modifiers) - set(self.modifiers)):
            modifiers.append({"key": key, "name": loc.name(key), "used": key in used_modifiers,
                              "law_used": key in law_modifiers, "percent": False, "color": "neutral"})
        states = [{"key": key, "name": loc.name(key), "region": s["region"], "sea": s["sea"]}
                  for key, s in self.states.items()]
        return {
            "language": language,
            "sources": [{"id": s.id, "name": s.name, "kind": s.kind} for s in self.sources],
            "companies": companies,
            "buildings": buildings,
            "factories": [{**factory, "name": loc.name(key)} for key, factory in self.factories.items()],
            "building_groups": groups,
            "pmgs": [{**pmg, "name": loc.name(key)} for key, pmg in self.pmgs.items()],
            "pms": [{**pm, "name": loc.name(key)} for key, pm in self.pms.items()],
            # "icon" and "cost" (a number) are what the pickers and the factory estimate use
            "goods": [{**good, "name": loc.name(key), "icon": good["texture"], "cost": _number(good["cost"], 0.0),
                       "cost_text": good["cost"], "color": self.goods_colors.get(key)}
                      for key, good in self.goods.items()],
            "pop_needs": [{"key": key, "name": loc.name(key), **need} for key, need in self.pop_needs.items()],
            "goods_icons": self.goods_icons,
            "prestige_icons": self.prestige_icons,
            "pop_types": [{"key": key, "name": loc.name(key), **pop} for key, pop in self.pop_types.items()],
            "buy_packages": [[level, round(cost, 2)] for level, cost in sorted(self.buy_packages.items())],
            "working_adult_ratio": self.working_adult_ratio,
            "laws": laws,
            "law_groups": [{"key": key, "name": loc.name(key), **group,
                            "hierarchy_name": loc.name(group["hierarchy"]) if group["hierarchy"] else ""}
                           for key, group in self.law_groups.items()],
            "law_categories": [{"key": key, "name": loc.name(text)} for key, text in LAW_CATEGORIES.items()],
            "social_hierarchies": [{"key": key, "name": loc.name(key)} for key in self.social_hierarchies],
            # only what the law pages need: stances on laws, and the ideologies interest groups start with
            "ideologies": [{"key": key, "name": loc.name(key), "stances": stances}
                           for key, stances in self.ideologies.items() if stances],
            "interest_groups": [{"key": key, "name": loc.name(key), **ig} for key, ig in self.interest_groups.items()],
            "institutions": [{"key": key, "name": loc.name(key), **institution}
                             for key, institution in self.institutions.items()],
            "law_icons": self.law_icons,
            "locators": [{"key": name, "x": x, "z": z} for name, (x, z) in self.locators.items()],
            "state_owners": self.state_owners,
            "construction_costs": [{"key": key, "value": value} for key, value in self.construction_costs.items()],
            "building_icons": self.building_icons,
            "building_backgrounds": self.building_backgrounds,
            "pm_icons": self.pm_icons,
            "pmg_icons": self.pmg_icons,
            "modifiers": modifiers,
            "states": states,
            "regions": [{"key": key, "name": loc.name(key)} for key in self.regions],
            # with what the pickers filter countries by: type, tier and the strategic region of the capital
            "countries": [{"key": tag, "name": loc.name(tag), "color": info["color"],
                           "country_type": info["country_type"], "tier": info["tier"],
                           "type_name": loc.name(info["country_type"]) if info["country_type"] else "",
                           "tier_name": loc.name(f"country_tier_{info['tier']}") if info["tier"] else "",
                           "region": (self.states.get(info["capital"]) or {}).get("region", "")
                           if info["capital"] else ""}
                          for tag, info in ((tag, self.country_defs[tag]) for tag in self.countries)],
            "prestige_goods": [{**good, "name": loc.name(key), "icon": good["texture"], "base": good["base_good"],
                                "good_name": loc.name(good["base_good"]) if good["base_good"] else ""}
                               for key, good in self.prestige_goods.items()],
            "technologies": [{"key": key, "name": loc.name(key), **tech} for key, tech in self.technologies.items()],
            "cultures": [{"key": key, "name": loc.name(key), **traits,
                          **{f"{name}_name": loc.name(value) if value else "" for name, value in traits.items()}}
                         for key, traits in ((key, self.culture_traits.get(key, {"heritage": "", "language": ""}))
                                             for key in self.cultures)],
            "geographic_regions": [{"key": key, "name": loc.name(key), **region}
                                   for key, region in self.geographic_regions.items()],
            **{name: [{"key": key, "name": loc.name(key)} for key in keys] for name, keys in self.key_lists.items()},
            "dlc_features": sorted(self.dlc_features),
            "categories": [{"key": c, "name": loc.name(f"company_category_{c}")} for c in categories],
            "default_category_name": loc.name("company_category_capitalist_owned"),
            "icons": self.icons,
            "backgrounds": self.backgrounds,
            "warnings": self.warnings,
        }

    def modifier_templates(self, language):
        """The game's names for one building's own modifiers, to copy for new buildings."""
        loc = self.localization(language)
        texts = {suffix: loc.raw(MODIFIER_TEMPLATE_BUILDING + suffix) for suffix in MODIFIER_SUFFIXES}
        return {suffix: text for suffix, text in texts.items() if text}

    def goods_templates(self, language):
        """The game's texts for TEMPLATE_GOOD's modifiers and its name, to copy for new goods."""
        loc = self.localization(language)
        texts = {pattern: loc.raw(pattern.format(TEMPLATE_GOOD)) for pattern in ENGLISH_TEMPLATES}
        return {"name": loc.raw(TEMPLATE_GOOD), "texts": {p: text for p, text in texts.items() if text}}

    def country_payload(self, language):
        """What the country start pages need: every country with how it starts, and the presets."""
        loc = self.localization(language)
        countries = []
        for tag, info in self.country_defs.items():
            if info["dynamic"]:
                continue  # placeholders for countries made during the game
            history = self.histories.get(tag) or empty_history()
            population = self.populations.get(tag) or {}
            countries.append({
                "key": tag, "name": loc.name(tag), "adj": loc.name(f"{tag}_ADJ", ""), "def": loc.name(f"{tag}_DEF", ""),
                **{name: info[name] for name in ("color", "country_type", "tier", "cultures", "capital", "religion",
                                                 "social_hierarchy", "named_from_capital", "source", "sources", "file")},
                "history": {**history, "files": self.history_files["countries"].get(tag, [])},
                "ig_name_texts": {ig: loc.name(key) for ig, key in history["ig_names"].items()},
                "wealth": population.get("wealth", ""), "literacy": population.get("literacy", ""),
                "ruling_party": (self.governments.get(tag) or {}).get("ruling_party", ""),
                "characters": (self.characters.get(tag) or empty_characters())["items"],
                "other_characters": (self.characters.get(tag) or empty_characters())["other"],
                "stats": self.country_stats.get(tag) or {"states": 0, "provinces": 0, "population": 0,
                                                         "buildings": 0, "characters": 0},
            })
        return {
            "countries": countries,
            "effects": self.start_effects,
            "tech_tiers": {str(tier): info for tier, info in sorted(self.tech_tiers.items())},
            # who owns which provinces of each state region: [country, provinces, unincorporated]
            "shares": {state: [[s["country"], s["provinces"], s["unincorporated"]] for s in shares]
                       for state, shares in self.state_shares.items() if shares},
            "homelands": self.state_homelands,
            "claims": self.state_claims,
            "culture_religions": self.culture_religions,
            # stage 3: diplomacy, treaties and characters
            "diplomacy": [[d["kind"], d["first"], d["second"], d["type"], d["value"]] for d in self.diplomacy],
            "pact_types": [{"key": key, "name": loc.name(key), **info} for key, info in self.pact_types.items()],
            "treaties": [{**treaty, "name_text": loc.name(treaty["name"]) if treaty["name"] else ""}
                         for treaty in self.treaties],
            # articles with an input the tool cannot give (a ship, a text) are left out
            "treaty_articles": [{"key": key, "name": loc.name(key), "desc": loc.name(f"{key}_desc", ""), **info}
                                for key, info in self.treaty_articles.items()
                                if not set(info["inputs"]) - {"quantity", "goods", "state", "strategic_region",
                                                              "company", "building_type", "law_type", "country"}],
            "character_templates": [{"key": key, "name": " ".join(filter(None, (loc.name(info["first_name"]) if info["first_name"] else "",
                                                                                loc.name(info["last_name"]) if info["last_name"] else ""))),
                                     **info} for key, info in self.character_templates.items()],
            "traits": [{"key": key, "name": loc.name(key), "kind": kind} for key, kind in self.character_traits.items()],
            "character_ideologies": [{"key": key, "name": loc.name(key)} for key in self.character_ideologies],
            "commander_ranks": [{"key": key, "name": loc.name(key)} for key in COMMANDER_RANKS],
            # stage 4: what the flags of new countries are made of
            "coa": {"patterns": self.coa_patterns, "colored": self.coa_colored, "textured": self.coa_textured,
                    "colors": [{"key": key, **info} for key, info in self.coa_colors.items()]},
            "parties": [{"key": key, "name": loc.name(name)} for key, name in self.parties.items()],
            # the choices, with the game's names where it has them
            "levels": {
                "country_types": [{"key": key, "name": loc.name(key)} for key in COUNTRY_TYPES],
                "tiers": [{"key": key, "name": loc.name(f"country_tier_{key}")} for key in TIERS],
                "tax_levels": [{"key": key, "name": loc.name(f"tax_level_{key}")} for key in TAX_LEVELS],
                "tariff_levels": [{"key": key, "name": loc.name(key)} for key in TARIFF_LEVELS],
                "wealth_levels": list(WEALTH_LEVELS), "literacy_levels": list(LITERACY_LEVELS),
            },
        }

    def map_payload(self):
        return {"states": [{"key": key, "provinces": s["provinces"], "sea": s["sea"]}
                           for key, s in self.states.items()]}

    def summary(self):
        return {"companies": len(self.companies), "buildings": len(self.buildings),
                "modifiers": len(self.modifiers), "states": sum(1 for s in self.states.values() if not s["sea"]),
                "mods": len(self.sources) - 1, "warnings": len(self.warnings)}
