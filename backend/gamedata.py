"""Loading game data from the game folder plus the selected mods."""
import os
import re
from pathlib import Path

from . import pdx_script
from .companies import company_from_block
from .laws import law_from_block, stances_from_block
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
# The columns of the game's law screen, in order (law_group_category of the law groups),
# and the interface texts naming them.
LAW_CATEGORIES = {"power_structure": "POWER_STRUCTURE", "economy": "ECONOMY", "human_rights": "HUMAN_RIGHTS"}
# Building groups a factory can be put in: these and the groups below them.
PRODUCTION_GROUPS = ("bg_manufacturing", "bg_agriculture", "bg_ranching", "bg_plantations", "bg_extraction")
# Game objects only picked by key in the forms: payload name -> folder.
KEY_LISTS = {
    "principles": "common/power_bloc_principles",
    "identities": "common/power_bloc_identities",
    "geographic_regions": "common/geographic_regions",
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
        for key, (block, _source, _file) in self.load_db("common/goods").items():
            texture, cost = block.get("texture"), block.get("cost")
            try:
                cost = float(cost)
            except (TypeError, ValueError):
                cost = 0
            self.goods[key] = {"icon": texture if isinstance(texture, str) else "", "cost": cost}
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
        self.countries = list(self.load_db("common/country_definitions"))
        self.prestige_goods = {}
        for key, (block, _source, _file) in self.load_db("common/prestige_goods").items():
            base = block.get("base_good")
            texture = block.get("texture")
            self.prestige_goods[key] = {"base": base if isinstance(base, str) else "",
                                        "icon": texture if isinstance(texture, str) else ""}
        self.technologies = {}
        for key, (block, _source, _file) in self.load_db("common/technology/technologies").items():
            texture, era = block.get("texture"), block.get("era")
            era_number = era.rpartition("_")[2] if isinstance(era, str) else ""  # era_3 -> 3 (eras have no names)
            self.technologies[key] = {"icon": texture if isinstance(texture, str) else "",
                                      "era": int(era_number) if era_number.isdigit() else 0}
        self.cultures = list(self.load_db("common/cultures"))
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
        self.state_owners = {}
        for source, path, rel_name in self.fs.list_files("common/history/states", ".txt"):
            try:
                root = pdx_script.parse(read_text(path))
            except (OSError, RecursionError) as error:
                self.warnings.append(f"{source.name}: common/history/states/{rel_name}: {error}")
                continue
            for top in root.entries:
                if not isinstance(top.value, Block):
                    continue
                for state in top.value.entries:
                    if not (state.key and state.key.startswith("s:") and isinstance(state.value, Block)):
                        continue
                    owners = self.state_owners.setdefault(state.key[2:], [])
                    for create in state.value.get_all("create_state"):
                        country = create.get("country") if isinstance(create, Block) else None
                        tag = country[2:] if isinstance(country, str) and country.startswith("c:") else None
                        if tag and tag not in owners:
                            owners.append(tag)

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
            "goods": [{"key": key, "name": loc.name(key), **good} for key, good in self.goods.items()],
            "pop_types": [{"key": key, "name": loc.name(key), **pop} for key, pop in self.pop_types.items()],
            "buy_packages": [[level, round(cost, 2)] for level, cost in sorted(self.buy_packages.items())],
            "working_adult_ratio": self.working_adult_ratio,
            "laws": laws,
            "law_groups": [{"key": key, "name": loc.name(key), **group,
                            "hierarchy_name": loc.name(group["hierarchy"]) if group["hierarchy"] else ""}
                           for key, group in self.law_groups.items()],
            "law_categories": [{"key": key, "name": loc.name(text)} for key, text in LAW_CATEGORIES.items()],
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
            "countries": [{"key": tag, "name": loc.name(tag)} for tag in self.countries],
            "prestige_goods": [{"key": key, "name": loc.name(key), "icon": good["icon"],
                                "good_name": loc.name(good["base"]) if good["base"] else ""}
                               for key, good in self.prestige_goods.items()],
            "technologies": [{"key": key, "name": loc.name(key), "icon": tech["icon"], "era": tech["era"]}
                             for key, tech in self.technologies.items()],
            "cultures": [{"key": key, "name": loc.name(key)} for key in self.cultures],
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

    def map_payload(self):
        return {"states": [{"key": key, "provinces": s["provinces"], "sea": s["sea"]}
                           for key, s in self.states.items()]}

    def summary(self):
        return {"companies": len(self.companies), "buildings": len(self.buildings),
                "modifiers": len(self.modifiers), "states": sum(1 for s in self.states.values() if not s["sea"]),
                "mods": len(self.sources) - 1, "warnings": len(self.warnings)}
