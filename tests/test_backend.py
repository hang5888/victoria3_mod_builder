"""Tests for the parts that do not need a game install. Run: python -m unittest discover tests"""
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import project  # noqa: E402
from backend.companies import (company_from_block, company_to_script, empty_company,  # noqa: E402
                               normalize_company, validate_company)
from backend.factories import (factory_from_block, factory_to_script, modifier_texts,  # noqa: E402
                               normalize_factory, own_keys, pm_from_block, pm_to_script, pmg_from_block,
                               pmg_to_script, validate_factory)
from backend.gamedata import FileSystem, GameData, Source  # noqa: E402
from backend.localization import Localization, read_loc_file, read_loc_text  # noqa: E402
from backend.mods import PROJECT_FILE  # noqa: E402
from backend.pdx_script import braces_balanced, parse, split_prefix  # noqa: E402
from backend.textures import _bc7_block  # noqa: E402

COMPANY = """\
company_test = { # a comment with { braces
	icon = "gfx/interface/icons/company_icons/basic_agriculture_1.dds"
	background = "gfx/interface/icons/company_icons/company_backgrounds/comp_illu_farm_wheat.dds"

	flavored_company = yes
	preferred_headquarters = { STATE_SVEALAND STATE_NORRLAND }

	building_types = {
		building_iron_mine
		building_steel_mills
	}

	possible_prestige_goods = { prestige_good_swedish_bar_iron }

	potential = {
		has_interest_marker_in_region = region_baltic
	}

	possible = {
		any_scope_state = {
			state_region = s:STATE_SVEALAND
			any_scope_building = {
				is_building_type = building_iron_mine
				level >= 3
			}
		}
	}

	prosperity_modifier = {
		country_prestige_mult = 0.1
		unit_army_offense_mult = 0.05
	}

	ai_weight = {
		value = 3
	}
	uses_dynamic_naming = yes
	dynamic_company_type_names = {
		"dynamic_company_type_name_1"
	}
}
"""


BUILDING = """\
building_test_works = {
	building_group = bg_light_industry
	icon = "gfx/interface/icons/building_icons/food_industry.dds"
	city_type = city
	levels_per_mesh = 50

	unlocking_technologies = { manufacturies }

	production_method_groups = {
		pmg_base_building_test_works
		pmg_canning
	}

	required_construction = construction_cost_high

	possible = {
		is_incorporated = yes
	}

	ai_value = {
		value = 1000
		if = { limit = { always = yes } add = 500 }
	}
	ownership_type = self
	background = "gfx/interface/icons/building_icons/backgrounds/building_panel_bg_light_industry.dds"
}
"""

PMG = """\
pmg_base_building_test_works = {
	texture = "gfx/interface/icons/generic_icons/mixed_icon_base.dds"
	ai_selection = most_productive
	production_methods = { pm_test_bakery pm_sweeteners }
}
"""

PM = """\
pm_test_bakery = {
	texture = "gfx/interface/icons/production_method_icons/bakeries.dds"
	is_default = yes
	unlocking_technologies = { distillation }
	disallowing_laws = { law_industry_banned }

	building_modifiers = {
		workforce_scaled = {
			# input goods
			goods_input_grain_add = 40
			goods_input_small_arms_add = 5
			goods_output_groceries_add = 45
		}
		level_scaled = {
			building_employment_shopkeepers_add = 500
			building_employment_laborers_add = -4500
		}
		unscaled = { building_laborers_mortality_mult = 0.1 }
	}
	state_modifiers = {
		workforce_scaled = { state_pollution_generation_add = 10 }
	}
}
"""


def first_block(text):
    entry = parse(text).entries[0]
    return split_prefix(entry.key)[1], entry.value


def sample_factory():
    """The building above with its base group, and that group's first method, as the mod's own."""
    factory = factory_from_block(*first_block(BUILDING))
    pmg = pmg_from_block(*first_block(PMG))
    pmg["pms"][0] = pm_from_block(*first_block(PM))
    factory["pmgs"][0] = pmg
    return factory


NO_KEYS = {"buildings": set(), "pmgs": set(), "pms": set()}


def first_company(text):
    entry = parse(text).entries[0]
    _prefix, key = split_prefix(entry.key)
    return company_from_block(key, entry.value)


class ScriptTest(unittest.TestCase):
    def test_parse_nested_blocks_and_comments(self):
        block = parse(COMPANY)
        self.assertEqual([e.key for e in block.entries], ["company_test"])
        company = block.entries[0].value
        self.assertEqual(company.get("flavored_company"), "yes")
        self.assertEqual(company.get("building_types").items(), ["building_iron_mine", "building_steel_mills"])

    def test_prefix(self):
        self.assertEqual(split_prefix("REPLACE_OR_CREATE:company_x"), ("REPLACE_OR_CREATE", "company_x"))
        self.assertEqual(split_prefix("company_x"), (None, "company_x"))

    def test_braces_balanced(self):
        self.assertTrue(braces_balanced("a = { b = c } # }"))
        self.assertTrue(braces_balanced('name = "{"'))
        self.assertFalse(braces_balanced("a = { b = c"))
        self.assertFalse(braces_balanced("} a = {"))


class CompanyTest(unittest.TestCase):
    def test_read_fields(self):
        company = first_company(COMPANY)
        self.assertEqual(company["key"], "company_test")
        self.assertTrue(company["flavored_company"])
        self.assertEqual(company["preferred_headquarters"], ["STATE_SVEALAND", "STATE_NORRLAND"])
        self.assertEqual(company["possible_prestige_goods"], ["prestige_good_swedish_bar_iron"])
        self.assertEqual(company["prosperity_modifier"], [
            {"key": "country_prestige_mult", "value": "0.1"},
            {"key": "unit_army_offense_mult", "value": "0.05"}])
        self.assertIn("has_interest_marker_in_region", company["blocks"]["potential"])
        self.assertIn("level >= 3", company["blocks"]["possible"])
        self.assertIn("uses_dynamic_naming = yes", company["extra"])
        self.assertIn("dynamic_company_type_name_1", company["extra"])

    def test_flavored_defaults_to_no(self):
        company = first_company('company_x = { icon = "a.dds" }')
        self.assertFalse(company["flavored_company"])

    def test_round_trip(self):
        company = first_company(COMPANY)
        again = first_company(company_to_script(company))
        self.assertEqual(company, again)

    def test_override_uses_replace_or_create(self):
        company = first_company(COMPANY)
        company["mode"] = "override"
        script = company_to_script(company)
        self.assertTrue(script.startswith("REPLACE_OR_CREATE:company_test = {"))
        entry = parse(script).entries[0]
        self.assertEqual(split_prefix(entry.key), ("REPLACE_OR_CREATE", "company_test"))

    def test_validate(self):
        company = first_company(COMPANY)
        self.assertEqual(validate_company(company, set()), [])
        self.assertEqual(validate_company(company, {"company_test"}), ["key_exists"])
        company["mode"] = "override"
        self.assertEqual(validate_company(company, {"company_test"}), [])
        bad = empty_company()
        bad["key"] = "bad key"
        bad["prosperity_modifier"] = [{"key": "country_prestige_mult", "value": "lots"}]
        bad["blocks"]["possible"] = "a = {"
        self.assertEqual(validate_company(bad, set()), [
            "key_invalid", "icon_missing", "background_missing", "buildings_missing",
            "modifier_value", "braces:possible"])

    def test_normalize_drops_unsafe_input(self):
        raw = first_company(COMPANY)
        raw["names"] = {"english": "  Test\nCompany ", "../../evil": "x", "french": ""}
        raw["unknown"] = "ignored"
        clean = normalize_company(raw)
        self.assertEqual(clean["names"], {"english": "Test Company"})
        self.assertNotIn("unknown", clean)
        for field, value in (("building_types", ["building_x }"]), ("building_types", "building_x"),
                             ("category", "a b"), ("prosperity_modifier", ["x"]), ("names", ["x"])):
            with self.assertRaises(ValueError, msg=field):
                normalize_company({**raw, field: value})


class FactoryTest(unittest.TestCase):
    def test_read_fields(self):
        factory = factory_from_block(*first_block(BUILDING))
        self.assertEqual(factory["building_group"], "bg_light_industry")
        self.assertEqual(factory["required_construction"], "construction_cost_high")
        self.assertEqual(factory["unlocking_technologies"], ["manufacturies"])
        self.assertEqual(factory["pmgs"], [{"type": "ref", "key": "pmg_base_building_test_works"},
                                           {"type": "ref", "key": "pmg_canning"}])
        self.assertIn("is_incorporated", factory["blocks"]["possible"])
        self.assertIn("add = 500", factory["ai_value"])
        self.assertEqual(factory["extra"], "levels_per_mesh = 50\nownership_type = self")
        pmg = pmg_from_block(*first_block(PMG))
        self.assertEqual([pm["key"] for pm in pmg["pms"]], ["pm_test_bakery", "pm_sweeteners"])
        self.assertEqual(pmg["extra"], "ai_selection = most_productive")
        pm = pm_from_block(*first_block(PM))
        self.assertTrue(pm["is_default"])
        self.assertEqual(pm["inputs"], [{"good": "grain", "amount": "40"}, {"good": "small_arms", "amount": "5"}])
        self.assertEqual(pm["outputs"], [{"good": "groceries", "amount": "45"}])
        self.assertEqual(pm["employment"], [{"pop": "shopkeepers", "amount": "500"},
                                            {"pop": "laborers", "amount": "-4500"}])
        self.assertEqual(pm["modifiers"], [
            {"target": "building", "scale": "unscaled", "key": "building_laborers_mortality_mult", "value": "0.1"},
            {"target": "state", "scale": "workforce_scaled", "key": "state_pollution_generation_add", "value": "10"}])
        self.assertEqual(pm["extra"], "disallowing_laws = { law_industry_banned }")

    def test_round_trip(self):
        for text, read, write in ((BUILDING, factory_from_block, factory_to_script),
                                  (PMG, pmg_from_block, pmg_to_script), (PM, pm_from_block, pm_to_script)):
            model = read(*first_block(text))
            self.assertEqual(read(*first_block(write(model))), model)

    def test_plain_ai_value_and_override(self):
        factory = factory_from_block(*first_block("building_x = { building_group = bg_a  ai_value = 1000 }"))
        self.assertEqual(factory["ai_value"], "1000")
        factory["mode"] = "override"
        script = factory_to_script(factory)
        self.assertTrue(script.startswith("REPLACE_OR_CREATE:building_x = {"))
        self.assertIn("\tai_value = 1000\n", script)

    def test_unusual_modifiers_stay_script(self):
        pm = pm_from_block(*first_block("pm_x = { building_modifiers = { odd_scale = { a = 1 } } }"))
        self.assertEqual(pm["modifiers"], [])
        self.assertIn("odd_scale", pm["extra"])

    def test_validate(self):
        factory = normalize_factory(sample_factory())
        self.assertEqual(validate_factory(factory, NO_KEYS, NO_KEYS), [])
        self.assertEqual(own_keys([factory]), {"buildings": {"building_test_works"},
                                               "pmgs": {"pmg_base_building_test_works"}, "pms": {"pm_test_bakery"}})
        # keys taken by the game, unless the item overrides it
        game = {"buildings": {"building_test_works"}, "pmgs": {"pmg_base_building_test_works"},
                "pms": {"pm_test_bakery"}}
        self.assertEqual(validate_factory(factory, game, NO_KEYS), [
            "key_exists:building_test_works", "pmg_key_exists:pmg_base_building_test_works",
            "pm_key_exists:pm_test_bakery"])
        factory["mode"] = factory["pmgs"][0]["mode"] = factory["pmgs"][0]["pms"][0]["mode"] = "override"
        self.assertEqual(validate_factory(factory, game, NO_KEYS), [])
        # keys written by another factory of the mod are taken either way
        self.assertEqual(len(validate_factory(factory, NO_KEYS, game)), 3)

        bad = normalize_factory({"key": "bad key", "pmgs": [
            {"type": "ref", "key": "pmg_a"}, {"type": "ref", "key": "pmg_a"},
            {"type": "own", "key": "pmg_b", "pms": []},
            {"type": "own", "key": "pmg_c", "extra": "a = {", "pms": [
                {"type": "own", "key": "pm_a", "inputs": [{"good": "grain", "amount": "lots"}]},
                {"type": "own", "key": "pm_a", "modifiers": [{"target": "moon", "scale": "unscaled", "key": "x",
                                                              "value": "1"}]}]}]})
        self.assertEqual(validate_factory(bad, NO_KEYS, NO_KEYS), [
            "key_invalid:bad key", "group_missing", "icon_missing", "pmg_key_exists:pmg_a", "pmg_empty:pmg_b",
            "braces:pmg_c", "pm_value:pm_a", "pm_key_exists:pm_a"])
        self.assertEqual(validate_factory(normalize_factory({}), NO_KEYS, NO_KEYS),
                         ["key_missing", "group_missing", "icon_missing", "pmgs_missing"])

    def test_normalize_drops_unsafe_input(self):
        raw = sample_factory()
        raw["names"] = {"english": " Test\nWorks ", "../../evil": "x"}
        raw["unknown"] = "ignored"
        clean = normalize_factory(raw)
        self.assertEqual(clean["names"], {"english": "Test Works"})
        self.assertNotIn("unknown", clean)
        for field, value in (("unlocking_technologies", ["a }"]), ("pmgs", "x"), ("pmgs", [{"type": "ref", "key": "a b"}]),
                             ("blocks", ["x"]), ("names", ["x"])):
            with self.assertRaises(ValueError, msg=field):
                normalize_factory({**raw, field: value})

    def test_modifier_texts(self):
        factory = {"key": "building_test_works"}
        self.assertEqual(modifier_texts(factory, "english"), {
            "building_test_works_throughput_add": "$building_test_works$ building [concept_throughput]",
            "building_test_works_throughput_add_desc":
                "A bonus or penalty to both input and output of $building_test_works$"})
        texts = modifier_texts(factory, "french", {"_throughput_add": "Débit de $building_food_industry$"})
        self.assertEqual(texts["building_test_works_throughput_add"], "Débit de $building_test_works$")


class LocalizationTest(unittest.TestCase):
    def test_read_and_clean(self):
        entries = read_loc_text('l_english:\n company_x:0 "The #b $other$#! Co." # note\n other: "Big"\n')["english"]
        self.assertEqual(entries["company_x"], "The #b $other$#! Co.")
        self.assertEqual(Localization(entries).name("company_x"), "The Big Co.")
        self.assertEqual(Localization({}, Localization(entries)).name("other"), "Big")
        self.assertEqual(Localization({}).name("missing"), "missing")


def bit_block(fields):
    """16 bytes built from (value, bit count) fields, lowest bits first."""
    value, pos = 0, 0
    for field, bits in fields:
        value |= field << pos
        pos += bits
    assert pos == 128
    return value.to_bytes(16, "little")


class TextureTest(unittest.TestCase):
    def test_bc7_mode6(self):
        # Mode 6: endpoints 0 = 127 with p-bit 1 (white, opaque), endpoints 1 = 0 with p-bit 0.
        block = bit_block([(1 << 6, 7)] + [(127, 7), (0, 7)] * 4 + [(1, 1), (0, 1)]
                          + [(0, 3), (15, 4)] + [(0, 4)] * 14)
        pixels = _bc7_block(block)
        self.assertEqual(pixels[0], (255, 255, 255, 255))
        self.assertEqual(pixels[1], (0, 0, 0, 0))
        self.assertEqual(pixels[15], (255, 255, 255, 255))

    def test_bc7_reserved_mode(self):
        self.assertEqual(_bc7_block(bytes(16)), [(0, 0, 0, 0)] * 16)


class LoadDbTest(unittest.TestCase):
    def test_origins_list_every_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            files = {
                "game/common/company_types/00_base.txt": "company_a = { icon = a }\ncompany_b = { icon = b }\n",
                "mod1/common/company_types/zz_mod1.txt": "company_a = { icon = a2 }\nINJECT:company_b = { x = y }\n",
                "mod2/common/company_types/zz_mod2.txt": "company_c = { icon = c }\n",
            }
            for rel, text in files.items():
                path = Path(tmp) / rel
                path.parent.mkdir(parents=True)
                path.write_text(text, encoding="utf-8")
            data = GameData.__new__(GameData)
            data.fs = FileSystem([Source(name, name, Path(tmp) / name, "mod") for name in ("game", "mod1", "mod2")])
            data.warnings = []
            origins = {}
            db = data.load_db("common/company_types", origins)
            self.assertEqual(db["company_a"][1].id, "mod1")
            self.assertEqual(db["company_b"][1].id, "game")  # injected into, still the base definition
            sources = {key: [s.id for s, _b, _f in versions] for key, versions in origins.items()}
            self.assertEqual(sources, {"company_a": ["game", "mod1"], "company_b": ["game", "mod1"],
                                       "company_c": ["mod2"]})
            # each version is the definition as that source left it
            self.assertEqual(origins["company_a"][0][1].get("icon"), "a")
            self.assertEqual(origins["company_a"][1][1].get("icon"), "a2")
            self.assertIsNone(origins["company_b"][0][1].get("x"))
            self.assertEqual(origins["company_b"][1][1].get("x"), "y")
            self.assertEqual(origins["company_b"][1][2], "zz_mod1.txt")


class ProjectTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.mods = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_create_save_and_reopen(self):
        folder = Path(project.create_project(str(self.mods), "My Test Mod!", "1.15.1"))
        self.assertEqual(folder.name, "my_test_mod")
        metadata = json.loads((folder / ".metadata" / "metadata.json").read_text(encoding="utf-8"))
        self.assertEqual(metadata["name"], "My Test Mod!")
        self.assertEqual(metadata["supported_game_version"], "1.15.*")
        self.assertEqual(project.list_projects(str(self.mods)), [{"dir": str(folder), "name": "My Test Mod!"}])
        # a second mod with the same name gets its own folder
        self.assertEqual(Path(project.create_project(str(self.mods), "My Test Mod!", "1.15.1")).name, "my_test_mod_2")

        new = first_company(COMPANY)
        new["names"] = {"english": 'Test "Quoted" Co.', "simp_chinese": "测试公司"}
        override = first_company(COMPANY.replace("company_test", "company_basic_steel"))
        override["mode"] = "override"
        override["names"] = {"english": "Better Steel"}
        proj = project.load_project(folder)
        proj["companies"] = [new, override]
        generated = project.save_project(folder, proj)
        self.assertEqual(sorted(generated), [
            "common/company_types/zzz_my_test_mod_companies.txt",
            "localization/english/my_test_mod_companies_l_english.yml",
            "localization/english/replace/my_test_mod_companies_replace_l_english.yml",
            "localization/simp_chinese/my_test_mod_companies_l_simp_chinese.yml"])

        raw = (folder / generated[0]).read_bytes()
        self.assertTrue(raw.startswith(b"\xef\xbb\xbf"))  # the game wants a BOM
        entries = parse(raw.decode("utf-8-sig")).entries
        self.assertEqual([e.key for e in entries], ["company_test", "REPLACE_OR_CREATE:company_basic_steel"])
        self.assertEqual(company_from_block("company_test", entries[0].value)["blocks"], new["blocks"])
        english = read_loc_file(folder / "localization/english/my_test_mod_companies_l_english.yml")
        self.assertEqual(english, {"english": {"company_test": 'Test "Quoted" Co.'}})
        chinese = read_loc_file(folder / "localization/simp_chinese/my_test_mod_companies_l_simp_chinese.yml")
        self.assertEqual(chinese, {"simp_chinese": {"company_test": "测试公司"}})

        reopened = project.load_project(folder)
        self.assertEqual(reopened["companies"], [new, override])

    def test_factories(self):
        folder = Path(project.create_project(str(self.mods), "Works", "1.15.1"))
        new = normalize_factory(sample_factory())
        new["names"] = {"english": "Test Works"}
        new["pmgs"][0]["names"] = {"english": "Base"}
        new["pmgs"][0]["pms"][0]["names"] = {"english": "Bakery", "french": "Boulangerie"}
        override = normalize_factory({**sample_factory(), "key": "building_food_industry", "mode": "override",
                                      "names": {"english": "Better Food"},
                                      "pmgs": [{"type": "ref", "key": "pmg_canning"},
                                               {"type": "own", "mode": "override", "key": "pmg_distillery",
                                                "pms": [{"type": "ref", "key": "pm_pot_stills"}]}]})
        proj = project.load_project(folder)
        proj["factories"] = [new, override]
        generated = project.save_project(folder, proj, lambda lang: {"_throughput_add": f"{lang} $building_food_industry$"})
        self.assertEqual(sorted(generated), [
            "common/buildings/zzz_works_buildings.txt",
            "common/production_method_groups/zzz_works_buildings.txt",
            "common/production_methods/zzz_works_buildings.txt",
            "localization/english/replace/works_buildings_replace_l_english.yml",
            "localization/english/works_buildings_l_english.yml",
            "localization/french/works_buildings_l_french.yml"])

        def keys(rel):
            raw = (folder / rel).read_bytes()
            self.assertTrue(raw.startswith(b"\xef\xbb\xbf"))
            return [e.key for e in parse(raw.decode("utf-8-sig")).entries]

        self.assertEqual(keys(generated[0]), ["building_test_works", "REPLACE_OR_CREATE:building_food_industry"])
        self.assertEqual(keys(generated[1]), ["pmg_base_building_test_works", "REPLACE_OR_CREATE:pmg_distillery"])
        self.assertEqual(keys(generated[2]), ["pm_test_bakery"])
        english = read_loc_file(folder / "localization/english/works_buildings_l_english.yml")["english"]
        self.assertEqual(english, {
            "building_test_works": "Test Works",
            "building_test_works_throughput_add": "english $building_test_works$",
            "building_test_works_throughput_add_desc":
                "A bonus or penalty to both input and output of $building_test_works$",
            "pmg_base_building_test_works": "Base", "pm_test_bakery": "Bakery"})
        replaced = read_loc_file(folder / "localization/english/replace/works_buildings_replace_l_english.yml")
        self.assertEqual(replaced, {"english": {"building_food_industry": "Better Food"}})
        # only the method has a French name: no modifier texts for the building there
        french = read_loc_file(folder / "localization/french/works_buildings_l_french.yml")
        self.assertEqual(french, {"french": {"pm_test_bakery": "Boulangerie"}})
        self.assertEqual(project.load_project(folder)["factories"], [new, override])

        # removing the factory removes its groups and methods with it
        proj["factories"] = [override]
        generated = project.save_project(folder, proj)
        self.assertFalse((folder / "common/production_methods").exists())
        self.assertEqual(keys("common/production_method_groups/zzz_works_buildings.txt"),
                         ["REPLACE_OR_CREATE:pmg_distillery"])

    def test_imported_images(self):
        folder = Path(project.create_project(str(self.mods), "Pics", "1.15.1"))
        png = project.PNG_SIGNATURE + b"rest of a png"
        icon = project.add_image(folder, "company_icon", "My Icon!.png", png)
        self.assertEqual(icon["path"], f"gfx/interface/icons/pics_images/{icon['file']}")
        self.assertTrue(icon["file"].startswith("company_icon_my_icon_") and icon["file"].endswith(".png"))
        self.assertEqual(project.add_image(folder, "company_icon", "My Icon!.png", png), icon)  # same picture once
        unused = project.add_image(folder, "pm_icon", "x.dds", b"DDS " + bytes(124))
        kept = project.add_image(folder, "building_icon", "kept.png", project.PNG_SIGNATURE + b"other")
        for kind, name, data, error in (("company_icon", "a.gif", b"GIF89a", "format"), ("../x", "a.png", png, "kind")):
            with self.assertRaises(ValueError, msg=error):
                project.add_image(folder, kind, name, data)
        self.assertEqual(project.image_file(folder, icon["path"]), folder / project.IMAGE_STAGING / icon["file"])
        self.assertIsNone(project.image_file(folder, "gfx/interface/icons/other.png"))

        company = first_company(COMPANY)
        company["icon"] = icon["path"]
        proj = project.load_project(folder)
        proj["companies"] = [company]
        generated = project.save_project(folder, proj, keep_images=[kept["path"]])
        # the used image is packed, the kept one waits, the unused one is gone
        self.assertIn(icon["path"], generated)
        self.assertEqual((folder / icon["path"]).read_bytes(), png)
        self.assertEqual([i["path"] for i in project.load_project(folder)["images"]], [icon["path"], kept["path"]])
        self.assertFalse((folder / project.IMAGE_STAGING / unused["file"]).exists())
        self.assertFalse((folder / kept["path"]).exists())

        # no longer used: removed from the mod and the project
        proj = project.load_project(folder)
        proj["companies"] = []
        self.assertEqual(project.save_project(folder, proj), [])
        self.assertFalse((folder / "gfx").exists())
        self.assertEqual(project.load_project(folder)["images"], [])

    def test_stale_files_are_removed_but_nothing_else(self):
        folder = Path(project.create_project(str(self.mods), "Clean", "1.15.1"))
        mine = folder / "common" / "company_types" / "my_own_file.txt"
        outside = self.mods / "outside.txt"
        outside.write_text("keep", encoding="utf-8")
        company = first_company(COMPANY)
        company["names"] = {"english": "Test"}
        proj = project.load_project(folder)
        proj["companies"] = [company]
        project.save_project(folder, proj)
        mine.write_text("# written by hand", encoding="utf-8")

        proj = project.load_project(folder)
        proj["companies"] = []
        proj["generated_files"].append("../outside.txt")  # a tampered project file must not reach outside
        self.assertEqual(project.save_project(folder, proj), [])
        self.assertTrue(mine.is_file())
        self.assertTrue(outside.is_file())
        self.assertFalse((folder / "common" / "company_types" / "zzz_clean_companies.txt").exists())
        self.assertFalse((folder / "localization").exists())
        self.assertTrue((folder / PROJECT_FILE).is_file())

    def test_bad_language_never_becomes_a_path(self):
        folder = Path(project.create_project(str(self.mods), "Lang", "1.15.1"))
        company = first_company(COMPANY)
        company["names"] = {"../../escape": "x"}
        proj = project.load_project(folder)
        proj["companies"] = [company]
        generated = project.save_project(folder, proj)
        self.assertEqual(generated, ["common/company_types/zzz_lang_companies.txt"])
        self.assertEqual(sorted(p.name for p in self.mods.iterdir()), ["lang"])


class InterfaceTextTest(unittest.TestCase):
    """Every text key the frontend asks for exists in both translations."""

    DYNAMIC = {  # keys built at run time: prefix -> the values that can follow it
        "home.folder.": ["game_dir", "workshop_dir", "local_mod_dir"],
        "home.folder_error.": ["missing", "not_game", "not_found"],
        "home.mod_kind.": ["workshop", "local"],
        "home.step.": ["start", "companies", "buildings", "modifiers", "states", "misc", "textures",
                       "localization", "done"],
        "home.stat.": ["companies", "buildings", "modifiers", "states", "mods"],
        "company.mode.": ["new", "override"],
        "version_note.": ["active", "same", "hidden", "shown"],
        "block.": ["prestige_goods_trigger", "potential", "attainable", "possible", "can_establish_in",
                   "ai_construction_targets", "ai_weight"],
        "block.title.": ["prestige_goods_trigger", "potential", "attainable", "possible", "can_establish_in",
                         "ai_will_do", "ai_construction_targets", "ai_weight"],
        "ai.mode.": ["same", "custom", "never"],
        "ai.mode_hint.": ["same", "custom", "never"],
        "cond.kind.": ["tech", "building", "state", "entire_state", "interest", "country", "culture", "dlc",
                       "state_is", "incorporated", "target", "raw"],
        "template.": ["state", "region", "tech"],
        "problem.": ["key_missing", "key_invalid", "key_exists", "icon_missing", "background_missing",
                     "buildings_missing", "modifier_value", "braces"],
        "error.": ["offline", "server_error", "not_loaded", "no_project", "folders_invalid", "bad_request",
                   "not_found", "name_missing", "browse_unavailable", "bad_path", "unsupported_texture",
                   "forbidden", "open_folder_failed", "image_kind", "image_too_large", "image_format"],
        "sidebar.category.": ["company", "factory"],
        "factory.kind.": ["ref", "own", "override"],
        "factory.target.": ["building", "state", "country"],
        "factory.scale.": ["workforce_scaled", "level_scaled", "unscaled", "throughput_scaled"],
        "fblock.": ["potential", "possible"],
        "fset.label.": ['ai_nationalization_desire', 'ai_selection', 'ai_value', 'ai_weight', 'aliases', 'buildable', 'can_build_government', 'can_build_private', 'can_have_country_monopoly', 'can_switch_owner', 'category_building_type', 'city_lights_color_index', 'construction_modifier', 'disallowing_laws', 'disallowing_religions', 'downsizeable', 'economic_contribution', 'expandable', 'generates_residences', 'ignore_stateregion_max_level', 'investment_scores', 'is_hidden_when_unavailable', 'lens', 'levels_per_mesh', 'min_raise_to_hire', 'ownership_type', 'pollution_generation', 'profession_ratio', 'replacement_if_valid', 'required_input_goods', 'residence_points_per_level', 'scoring_override', 'should_auto_expand', 'slaves_role', 'terrain_manipulator', 'timed_modifiers', 'unlocking_company_categories', 'unlocking_geographic_regions', 'unlocking_global_technologies', 'unlocking_identity', 'unlocking_principles', 'unlocking_production_methods', 'unlocking_religions', 'valid_pop_culture_traits'],
        "fset.hint.": ['ai_nationalization_desire', 'ai_selection', 'ai_value', 'ai_weight', 'aliases', 'can_build_government', 'can_build_private', 'can_have_country_monopoly', 'can_switch_owner', 'category_building_type', 'city_lights_color_index', 'construction_modifier', 'economic_contribution', 'generates_residences', 'ignore_stateregion_max_level', 'investment_scores', 'is_hidden_when_unavailable', 'lens', 'levels_per_mesh', 'min_raise_to_hire', 'ownership_type', 'pollution_generation', 'profession_ratio', 'replacement_if_valid', 'required_input_goods', 'residence_points_per_level', 'scoring_override', 'should_auto_expand', 'slaves_role', 'terrain_manipulator', 'timed_modifiers', 'unlocking_global_technologies', 'unlocking_identity', 'unlocking_production_methods', 'valid_pop_culture_traits'],
        "fset.group.": ['conditions', 'economy', 'misc', 'other', 'unlock'],
        "fset.ownership.": ["self", "other", "no_ownership"],
        "fset.warn.": ['aliases', 'buildable', 'expandable', 'ownership_type', 'terrain_manipulator'],
        "fblock.title.": ["potential", "possible"],
        "fproblem.": ["key_missing", "key_invalid", "key_exists", "group_missing", "group_invalid", "icon_missing",
                      "city_type_invalid", "construction_invalid", "braces", "pmgs_missing", "pmg_key_missing",
                      "pmg_key_invalid", "pmg_key_exists", "pmg_empty", "pm_key_missing", "pm_key_invalid",
                      "pm_key_exists", "pm_value"],
    }

    def test_keys(self):
        frontend = ROOT / "frontend"
        # keys that reach t() through a variable: error codes of the API, and the builder's "not ready" notices
        wanted = {"error." + code for code in self.DYNAMIC["error."]} | {"company.need_data", "company.need_project"}
        for path in list((frontend / "js").glob("*.js")) + [frontend / "index.html"]:
            text = path.read_text(encoding="utf-8")
            for key in re.findall(r"""\bt\(\s*['"]([\w.]+)['"]""", text) + re.findall(r'data-i18n="([\w.]+)"', text):
                if key.endswith("."):
                    self.assertIn(key, self.DYNAMIC, f"{path.name}: unknown dynamic key {key}")
                    wanted.update(key + value for value in self.DYNAMIC[key])
                else:
                    wanted.add(key)
        self.assertGreater(len(wanted), 150)
        english = json.loads((frontend / "i18n" / "en.json").read_text(encoding="utf-8"))
        chinese = json.loads((frontend / "i18n" / "zh-hans.json").read_text(encoding="utf-8"))
        self.assertEqual(sorted(wanted - set(english)), [], "missing in en.json")
        self.assertEqual(sorted(set(english) - set(chinese)), [], "missing in zh-hans.json")
        self.assertEqual(sorted(set(chinese) - set(english)), [], "only in zh-hans.json")
        self.assertEqual(sorted(set(english) - wanted), [], "unused keys in en.json")
        for key, text in english.items():
            placeholders = set(re.findall(r"\{(\w+)\}", text))
            self.assertEqual(placeholders, set(re.findall(r"\{(\w+)\}", chinese[key])), key)


if __name__ == "__main__":
    unittest.main()
