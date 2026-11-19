"""Tests for the parts that do not need a game install. Run: python -m unittest discover tests"""
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import characters, countries, diplomacy, flags, project, territory, textures  # noqa: E402
from backend.companies import (company_from_block, company_to_script, empty_company,  # noqa: E402
                               normalize_company, validate_company)
from backend.factories import (factory_from_block, factory_to_script, modifier_texts,  # noqa: E402
                               normalize_factory, own_keys, pm_from_block, pm_to_script, pmg_from_block,
                               pmg_to_script, validate_factory)
from backend.gamedata import FileSystem, GameData, Source  # noqa: E402
from backend.monuments import monument_to_script, normalize_monument, validate_monument  # noqa: E402
from backend.laws import (law_from_block, law_group_to_script, law_to_script, normalize_law,  # noqa: E402
                          normalize_law_group, stances_from_block, validate_law, validate_law_group)
from backend import goods  # noqa: E402
from backend.localization import Localization, read_loc_file, read_loc_text  # noqa: E402
from backend.mods import PROJECT_FILE  # noqa: E402
from backend.pdx_script import Block, braces_balanced, parse, split_prefix  # noqa: E402
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


def sample_monument(**changes):
    monument = normalize_monument({
        **sample_factory(), "key": "building_test_tower", "building_group": "bg_monuments",
        "blocks": {"potential": "has_dlc_feature = ep1_content", "possible": ""},
        "extra": 'unique = yes\nlocator = "old_locator"\nbuildable = yes',
        "location": {"state": "STATE_ILE_DE_FRANCE", "x": 4144.3, "z": 2720.46}, "history": "", "effects": "simple"})
    monument.update(changes)
    return monument


class MonumentTest(unittest.TestCase):
    def test_script(self):
        entry = parse(monument_to_script(sample_monument(), "mymod")).entries[0]
        block = entry.value
        self.assertEqual(entry.key, "building_test_tower")
        self.assertEqual([e.raw for e in block.get("potential").entries],
                         ["state_region = s:STATE_ILE_DE_FRANCE", "has_dlc_feature = ep1_content"])
        self.assertEqual(block.get_all("locator"), ["building_test_tower_locator"])  # the tool's, not the old one
        self.assertEqual(block.get("buildable"), "yes")

    def test_kept_locator_and_history(self):
        kept = sample_monument(mode="override", location={"state": "", "x": None, "z": None, "locator": "old_locator"})
        block = parse(monument_to_script(kept, "mymod")).entries[0].value
        self.assertEqual(block.get_all("locator"), ["old_locator"])
        self.assertNotIn("state_region", block.get("potential").inner())
        moved = sample_monument(mode="override")
        self.assertEqual(parse(monument_to_script(moved, "mymod")).entries[0].value.get("locator"),
                         "building_test_tower_locator_mymod")
        placed = parse(monument_to_script(sample_monument(history="FRA"), "mymod")).entries[0].value
        self.assertEqual(placed.get_all("buildable"), ["no"])

    def test_normalize_and_validate(self):
        monument = sample_monument()
        self.assertEqual(validate_monument(monument, NO_KEYS, NO_KEYS), [])
        self.assertEqual(validate_monument(sample_monument(history="FRA", location={"state": ""}), NO_KEYS, NO_KEYS),
                         ["history_state"])
        for change in ({"location": {"state": "a b"}}, {"location": {"x": 1}}, {"location": {"x": "far", "z": 1}},
                       {"history": "c:FRA }"}, {"location": []}):
            with self.assertRaises(ValueError, msg=change):
                normalize_monument({**monument, **change})


LAW = """\
law_test_rights = {
	group = lawgroup_labor_rights
	parent = law_regulatory_bodies # inherits the stances
	icon = "gfx/interface/icons/law_icons/worker_protections.dds"
	progressiveness = 75
	unlocking_technologies = { human_rights }
	disallowing_laws = { law_command_economy }
	institution = institution_workplace_safety
	institution_modifier = { building_minimum_wage_mult = 0.1 }
	modifier = {
		country_authority_add = -50
		country_allow_voting_violent_hostility_bool = no
	}
	tax_modifier_low = { tax_land_add = 0.2 }
	is_visible = { has_technology_researched = human_rights }
	on_activate = { add_radicals = { value = 0.1 } }
	ai_enact_weight_modifier = { value = 0 }
	cultural_acceptance_rule = { always = yes }
}
"""


def first_law(text):
    entry = parse(text).entries[0]
    return law_from_block(entry.key, entry.value)


def sample_law(**changes):
    law = first_law(LAW)
    law.update(changes)
    return law


LAW_GAME = {"laws": {"law_no_workers_rights": "lawgroup_labor_rights", "law_regulatory_bodies": "lawgroup_labor_rights",
                     "law_monarchy": "lawgroup_governance_principles"},
            "groups": {"lawgroup_labor_rights", "lawgroup_governance_principles"}}


class LawTest(unittest.TestCase):
    def test_read_fields(self):
        law = first_law(LAW)
        self.assertEqual((law["group"], law["parent"], law["progressiveness"], law["institution"]),
                         ("lawgroup_labor_rights", "law_regulatory_bodies", "75", "institution_workplace_safety"))
        self.assertEqual(law["unlocking_technologies"], ["human_rights"])
        self.assertEqual(law["modifiers"]["modifier"][1], {"key": "country_allow_voting_violent_hostility_bool",
                                                           "value": "no"})
        self.assertEqual(law["modifiers"]["tax_modifier_low"], [{"key": "tax_land_add", "value": "0.2"}])
        self.assertEqual(law["blocks"]["on_activate"], "add_radicals = { value = 0.1 }")
        self.assertEqual(law["extra"], "cultural_acceptance_rule = { always = yes }")  # unknown fields stay script

    def test_round_trip(self):
        law = first_law(LAW)
        again = first_law(law_to_script(law))
        self.assertEqual(again, law)
        override = sample_law(mode="override")
        self.assertTrue(law_to_script(override).startswith("REPLACE_OR_CREATE:law_test_rights = {"))

    def test_unusual_blocks_stay_script(self):
        law = first_law("law_x = { group = g modifier = { country_a = { b = c } } unlocking_laws = { a = b } }")
        self.assertEqual(law["modifiers"]["modifier"], [])
        self.assertEqual(law["extra"], "modifier = { country_a = { b = c } }\nunlocking_laws = { a = b }")

    def test_stances(self):
        block = parse("ideology_x = { icon = x lawgroup_a = { law_a = approve law_b = strongly_disapprove } }")
        self.assertEqual(stances_from_block(block.entries[0].value),
                         {"law_a": "approve", "law_b": "strongly_disapprove"})

    def test_validate(self):
        law = normalize_law(sample_law())
        self.assertEqual(validate_law(law, LAW_GAME, []), [])
        self.assertIn("key_exists", validate_law({**law, "key": "law_monarchy"}, LAW_GAME, []))
        self.assertEqual(validate_law({**law, "key": "law_monarchy", "group": "lawgroup_governance_principles",
                                       "parent": "", "mode": "override"}, LAW_GAME, []), [])
        self.assertIn("group_unknown", validate_law({**law, "group": "lawgroup_x"}, LAW_GAME, []))
        # the parent must be another law of the same group
        self.assertIn("parent", validate_law({**law, "parent": "law_monarchy"}, LAW_GAME, []))
        self.assertIn("parent", validate_law({**law, "parent": "law_test_rights"}, LAW_GAME, []))
        mine = normalize_law(sample_law(key="law_mine", parent=""))
        self.assertEqual(validate_law({**law, "parent": "law_mine"}, LAW_GAME, [mine]), [])
        self.assertIn("progressiveness", validate_law({**law, "progressiveness": "high"}, LAW_GAME, []))
        bad = {**law, "modifiers": {**law["modifiers"], "modifier": [{"key": "country_authority_add", "value": "x"}]}}
        self.assertIn("modifier_value", validate_law(bad, LAW_GAME, []))
        self.assertIn("braces:on_enact", validate_law({**law, "blocks": {**law["blocks"], "on_enact": "a = {"}},
                                                      LAW_GAME, []))

    def test_normalize_drops_unsafe_input(self):
        law = sample_law()
        for bad in ({"group": "a b"}, {"unlocking_laws": ["x y"]}, {"modifiers": "x"}, {"parent": "law}"}):
            with self.assertRaises(ValueError):
                normalize_law({**law, **bad})
        # starting laws belong to the country starts: whatever the browser sends is not kept
        clean = normalize_law({**law, "names": {"english": " A  law ", "bad lang": "x"}, "start": {"all": True}})
        self.assertEqual(clean["names"], {"english": "A law"})
        self.assertNotIn("start", clean)


GROUP_GAME = {"groups": {"lawgroup_labor_rights"}, "categories": {"power_structure", "economy", "human_rights"},
              "hierarchies": {"edo_system"}}


def sample_group(**changes):
    group = normalize_law_group({"key": "lawgroup_test", "category": "economy", "names": {"english": "Test Group"},
                                 "ideological_opinion_impact": "0.5", "base_enactment_days": "200",
                                 "affected_by_regime_change": True, "hierarchy": "edo_system",
                                 "blocks": {"enable": "any_scope_state = { is_coastal = yes }"}})
    group.update(changes)
    return group


GOOD = """\
automobiles = {
	texture = "gfx/interface/icons/goods_icons/automobiles.dds"
	cost = 100
	category = luxury

	obsession_chance = 1.0
	prestige_factor = 10
	tradeable = no
	pop_consumption_can_add_infrastructure = yes
	odd_field = { a b }
}
"""

NEEDS = """\
popneed_luxury_items = {
	default = automobiles
	prestige_goods_demand_increase = 1.0

	entry = {
		goods = automobiles
		weight = 2
		max_supply_share = 1.0
		min_supply_share = 0.0
	}
	entry = {
		goods = porcelain
	}
}
popneed_free_movement = {
	default = transportation
	entry = { goods = transportation weight = 1 }
}
"""


def sample_good(**changes):
    good = goods.normalize_good({"key": "alloys", "names": {"english": "Alloys"}, "texture": "gfx/a.dds", "cost": "60",
                                 "category": "industrial", "color": [10, 20, 30],
                                 "needs": [{"need": "popneed_luxury_items", "weight": "1", "max_supply_share": "0.5",
                                            "min_supply_share": ""}]})
    good.update(changes)
    return good


def game_needs():
    return {split_prefix(e.key)[1]: goods.need_from_block(e.value) for e in parse(NEEDS).entries}


class GoodsTest(unittest.TestCase):
    def test_read_fields(self):
        good = goods.good_from_block(*first_block(GOOD))
        self.assertEqual((good["cost"], good["category"], good["obsession_chance"], good["prestige_factor"]),
                         ("100", "luxury", "1.0", "10"))
        self.assertFalse(good["tradeable"])
        self.assertTrue(good["pop_consumption_can_add_infrastructure"])
        self.assertEqual(good["extra"], "odd_field = { a b }")

    def test_round_trip(self):
        good = goods.good_from_block(*first_block(GOOD))
        again = goods.good_from_block(*first_block(goods.good_to_script(good)))
        self.assertTrue(goods.same_definition(again, good))
        self.assertFalse(goods.same_definition({**again, "cost": "90"}, good))
        self.assertTrue(goods.same_definition({**again, "cost": "100.0"}, good))
        override = goods.good_to_script({**good, "mode": "override"})
        self.assertTrue(override.startswith("REPLACE_OR_CREATE:automobiles = {"))

    def test_validate(self):
        game = {"goods": {"automobiles"}, "needs": {"popneed_luxury_items"}, "categories": set(goods.CATEGORIES)}
        self.assertEqual(goods.validate_good(sample_good(), game, []), [])
        bad = sample_good(key="automobiles", texture="", cost="0", category="x", obsession_chance="a",
                          needs=[{"need": "popneed_x", "weight": "a", "max_supply_share": "", "min_supply_share": ""}],
                          extra="{")
        self.assertEqual(goods.validate_good(bad, game, []), ["key_exists", "icon_missing", "cost", "category", "number",
                                                              "need", "need_value", "braces:extra"])
        self.assertEqual(goods.validate_good(sample_good(key="automobiles", mode="override"), game, []), [])
        self.assertEqual(goods.validate_good(sample_good(), game, [sample_good()]), ["key_exists"])

    def test_normalize_drops_unsafe_input(self):
        for raw in ({"key": "x", "category": "a b"}, {"key": "x", "color": [1, 2]}, {"key": "x", "color": [1, 2, 300]},
                    {"key": "x", "needs": "x"}, {"key": "x", "needs": [{"need": "bad need"}]}):
            with self.assertRaises(ValueError, msg=raw):
                goods.normalize_good(raw)
        good = goods.normalize_good({"key": " x ", "mode": "weird", "cost": " 5 ", "tradeable": 0})
        self.assertEqual((good["key"], good["mode"], good["cost"], good["tradeable"]), ("x", "new", "5", False))
        with self.assertRaises(ValueError):
            goods.normalize_prestige_good({"key": "x", "base_good": "a b"})

    def test_needs_read_and_unchanged(self):
        needs = game_needs()
        luxury = needs["popneed_luxury_items"]
        self.assertEqual(luxury["default"], "automobiles")
        self.assertEqual(luxury["extra"], "prestige_goods_demand_increase = 1.0")
        self.assertEqual([e["goods"] for e in luxury["entries"]], ["automobiles", "porcelain"])
        self.assertEqual(luxury["entries"][1]["weight"], "")
        # an override with the game's entries writes nothing
        same = sample_good(key="automobiles", mode="override", needs=[
            {"need": "popneed_luxury_items", "weight": "2.0", "max_supply_share": "1", "min_supply_share": "0"}])
        self.assertEqual(goods.needs_script([same], needs), ([], []))

    def test_needs_inject_new_entries(self):
        definitions, whole = goods.needs_script([sample_good()], game_needs())
        self.assertEqual(whole, [])
        self.assertEqual(len(definitions), 1)
        entry = parse(definitions[0]).entries[0]
        self.assertEqual(entry.key, "INJECT:popneed_luxury_items")
        self.assertEqual(entry.value.get("entry").get("goods"), "alloys")
        self.assertEqual(entry.value.get("entry").get("min_supply_share"), None)

    def test_needs_rewrite_when_game_entries_change(self):
        needs = game_needs()
        # automobiles leaves the luxury items and joins free movement with a new weight
        moved = sample_good(key="automobiles", mode="override", needs=[
            {"need": "popneed_free_movement", "weight": "3", "max_supply_share": "", "min_supply_share": ""}])
        new = sample_good()
        definitions, whole = goods.needs_script([moved, new], needs)
        self.assertEqual(whole, ["popneed_luxury_items"])
        luxury, movement = (parse(d).entries[0] for d in definitions)
        self.assertEqual(luxury.key, "REPLACE_OR_CREATE:popneed_luxury_items")
        back = goods.need_from_block(luxury.value)
        self.assertEqual(back["default"], "automobiles")
        self.assertEqual(back["extra"], "prestige_goods_demand_increase = 1.0")
        self.assertEqual([(e["goods"], e["weight"]) for e in back["entries"]], [("porcelain", ""), ("alloys", "1")])
        self.assertEqual(movement.key, "INJECT:popneed_free_movement")
        self.assertEqual(movement.value.get("entry").get("weight"), "3")

    def test_prestige_good(self):
        text = """prestige_good_x = {\n\tpossible = {\n\t\thas_dlc_feature = mp1_content\n\t}\n\tbase_good = artillery\n""" \
               """\tprestige_bonus = 0.1\n\ttexture = "gfx/x.dds"\n}"""
        good = goods.prestige_good_from_block(*first_block(text))
        self.assertEqual((good["base_good"], good["possible"].strip()), ("artillery", "has_dlc_feature = mp1_content"))
        self.assertEqual(goods.prestige_good_to_script(good), text)
        game = {"prestige_goods": {"prestige_good_x"}, "goods": {"artillery"}}
        self.assertEqual(goods.validate_prestige_good({**good, "mode": "override"}, game, []), [])
        bad = {**good, "base_good": "x", "texture": "", "prestige_bonus": "a", "possible": "{"}
        self.assertEqual(goods.validate_prestige_good(bad, game, []),
                         ["key_exists", "base_good", "icon_missing", "prestige_bonus", "braces:possible"])

    def test_new_good_files(self):
        new = sample_good()
        modifiers = parse("\n".join(goods.modifiers_script([new])))
        self.assertEqual([e.key for e in modifiers.entries], ["goods_output_alloys_add", "goods_input_alloys_add",
                                                              "goods_output_alloys_mult", "goods_input_alloys_mult"])
        self.assertEqual(modifiers.entries[2].value.get("percent"), "yes")
        icon = parse(goods.texticons_script([new])[0]).entries[0].value
        self.assertEqual((icon.get("icon"), icon.get("iconsize").get("texture")), ("alloys", "gfx/a.dds"))
        colors = parse(goods.colors_script([new, sample_good(key="b", color=None)])[0]).get("colors")
        self.assertEqual([(e.key, e.value) for e in colors.entries], [("alloys", "rgb { 10 20 30 }")])
        english = goods.modifier_texts(new, "english", None)
        self.assertEqual(english["goods_output_alloys_add"], "@alloys! Alloys output")
        chinese = goods.modifier_texts({**new, "names": {"simp_chinese": "合金"}}, "simp_chinese",
                                       {"name": "轻武器", "texts": {"goods_input_{}_add": "@small_arms!轻武器投入"}})
        self.assertEqual(chinese["goods_input_alloys_add"], "@alloys!合金投入")
        self.assertEqual(chinese["goods_output_alloys_add"], "@alloys! 合金 output")  # no game text: English
        self.assertEqual(goods.modifier_texts(new, "french", None), {})


class LawGroupTest(unittest.TestCase):
    def test_script(self):
        block = parse(law_group_to_script(sample_group())).get("lawgroup_test")
        self.assertEqual([(e.key, e.value if isinstance(e.value, str) else "{}") for e in block.entries], [
            ("law_group_category", "economy"), ("base_enactment_days", "200"), ("ideological_opinion_impact", "0.5"),
            ("affected_by_regime_change", "yes"), ("linked_social_hierarchy", "edo_system"), ("enable", "{}")])
        self.assertEqual(block.get("enable").get("any_scope_state").get("is_coastal"), "yes")

    def test_validate(self):
        self.assertEqual(validate_law_group(sample_group(), GROUP_GAME, []), [])
        self.assertIn("key_exists", validate_law_group(sample_group(key="lawgroup_labor_rights"), GROUP_GAME, []))
        self.assertIn("key_exists", validate_law_group(sample_group(), GROUP_GAME, [sample_group()]))
        self.assertIn("category", validate_law_group(sample_group(category="space"), GROUP_GAME, []))
        self.assertIn("opinion_impact", validate_law_group(sample_group(ideological_opinion_impact=""), GROUP_GAME, []))
        self.assertIn("enactment_days", validate_law_group(sample_group(base_enactment_days="1.5"), GROUP_GAME, []))
        self.assertIn("approval_mult", validate_law_group(sample_group(enactment_approval_mult="x"), GROUP_GAME, []))
        self.assertIn("hierarchy", validate_law_group(sample_group(hierarchy="caste"), GROUP_GAME, []))
        self.assertIn("braces:enable", validate_law_group(sample_group(blocks={"enable": "a = {",
                                                                               "change_allowed_trigger": ""}),
                                                          GROUP_GAME, []))

    def test_normalize_drops_unsafe_input(self):
        for bad in ({"category": "a b"}, {"hierarchy": "x}"}, {"blocks": "x"}):
            with self.assertRaises(ValueError):
                normalize_law_group({"key": "lawgroup_x", **bad})


HISTORY = """\
COUNTRIES = {
	c:TST ?= {
		set_next_election_date = 1836.2.1

		ig:ig_intelligentsia ?= {
			add_ruling_interest_group = yes
		}
		ig:ig_devout ?= {
			add_ruling_interest_group = yes
			add_ideology = ideology_moralist # keeps its ideology
		}

		effect_starting_technology_tier_1_tech = yes
		add_technology_researched = labor_movement # had it early

		set_tax_level = medium
		add_taxed_goods = g:liquor

		effect_starting_politics_traditional = yes
		activate_law = law_type:law_monarchy # the crown
		activate_law = law_type:law_wealth_voting

		set_institution_investment_level = {
			institution = institution_schools
			level = 3
		}
		add_journal_entry = { type = je_test }
	}
}
"""

POPULATION = "POPULATION = {\n\tc:TST ?= {\n\t\teffect_starting_pop_wealth_high = yes\n\t}\n}\n"
GOVERNMENT = ("GOVERNMENT = {\n\tc:TST ?= {\n\t\tpy:liberal_party ?= {\n\t\t\tset_ruling_party = yes\n"
              "\t\t\tadd_momentum = 0.5\n\t\t}\n\t}\n}\n")
DEFINITION = "TST = {\n\tcolor = hsv{ 0.5 0.5 0.5 } # teal\n\tcountry_type = recognized\n\ttier = kingdom\n" \
             "\tcultures = { british }\n\tcapital = STATE_TEST\n}\n"
COUNTRY_LAWS = {"law_monarchy": "lawgroup_governance_principles", "law_presidential_republic": "lawgroup_governance_principles",
                "law_wealth_voting": "lawgroup_distribution_of_power", "law_autocracy": "lawgroup_distribution_of_power",
                "law_no_workers_rights": "lawgroup_labor_rights", "law_worker_protections": "lawgroup_labor_rights"}


class FakeStartBase:
    """The files in effect the country starts are written from (gamedata.StartBase)."""

    def __init__(self, files, state_provinces=None):
        self.texts = files  # game-relative path -> text
        self.state_provinces = state_provinces or {}
        self.shares, self.homelands, self.claims = {}, {}, {}
        self.pops, self.buildings, self.others = {}, {}, {}
        self.articles = {"defensive_pact": {"kind": "mutual", "inputs": []},
                         "goods_transfer": {"kind": "directed", "inputs": ["quantity", "goods"]},
                         "treaty_port": {"kind": "directed", "inputs": ["state"]}}
        for rel, text in files.items():
            root = parse(text)
            if rel.startswith("common/history/states/"):
                territory.read_states(root, self.shares, self.homelands, self.claims)
            elif rel.startswith("common/history/pops/"):
                territory.read_state_parts(root, "POPS", "pops", self.pops, {})
            elif rel.startswith("common/history/buildings/"):
                territory.read_state_parts(root, "BUILDINGS", "buildings", self.buildings, self.others)

    def files(self, kind, key):
        if kind in territory.STATE_DIRS:
            folder = territory.STATE_DIRS[kind][0]
            return [rel for rel, text in self.texts.items() if rel.startswith(folder + "/") and f"s:{key} " in text]
        folder = {"countries": "common/history/countries", "population": "common/history/population",
                  "governments": "common/history/governments", "characters": "common/history/characters"}[kind]
        return [rel for rel, text in self.texts.items() if rel.startswith(folder + "/") and f"c:{key} " in text]

    def folder_files(self, folder):
        return [rel for rel in self.texts if rel.startswith(folder + "/")]

    def text(self, rel):
        return self.texts.get(rel)

    def law_group(self, law):
        return COUNTRY_LAWS.get(law, "")

    def ruling(self, tag):
        return ["ig_intelligentsia", "ig_devout"] if tag == "TST" else []

    def definition(self, tag):
        if tag != "TST":
            return None
        return DEFINITION[DEFINITION.index("{"):].rstrip()


def country_base():
    return FakeStartBase({"common/history/countries/tst - test.txt": HISTORY,
                          "common/history/population/tst - test.txt": POPULATION,
                          "common/history/governments/tst - test.txt": GOVERNMENT})


def sample_start(**changes):
    start = countries.empty_start("TST")
    start.update(changes)
    return countries.normalize_start(start)


class CountryStartTest(unittest.TestCase):
    def test_colors(self):
        self.assertEqual(countries.parse_color(parse("c = { 147 130 110 }").get("c")), [147, 130, 110])
        self.assertEqual(countries.parse_color(parse("c = rgb{ 10 20 30 }").get("c")), [10, 20, 30])
        self.assertEqual(countries.parse_color(parse("c = hsv{ 0 1 1 }").get("c")), [255, 0, 0])
        self.assertEqual(countries.parse_color(parse("c = hsv360{ 120 100 50 }").get("c")), [0, 128, 0])
        self.assertIsNone(countries.parse_color(parse("c = { 1 2 }").get("c")))

    def test_read_history(self):
        scope = countries.scope_blocks(parse(HISTORY), "COUNTRIES")
        self.assertEqual([tag for tag, _entry in scope], ["TST"])
        history = countries.read_history(countries.empty_history(), scope[0][1].value)
        self.assertEqual(history["law_steps"], [{"effect": "effect_starting_politics_traditional"},
                                                {"law": "law_monarchy"}, {"law": "law_wealth_voting"}])
        self.assertEqual(history["ruling"], ["ig_intelligentsia", "ig_devout"])
        self.assertEqual((history["tech_tier"], history["techs"]), (1, ["labor_movement"]))
        self.assertEqual((history["tax_level"], history["taxed_goods"]), ("medium", ["liquor"]))
        self.assertEqual(history["institutions"], [{"institution": "institution_schools", "level": 3}])
        self.assertEqual(history["election"], "1836.2.1")
        self.assertEqual(history["extra"], "add_journal_entry = { type = je_test }")
        definition = countries.definition_from_block(parse(DEFINITION).get("TST"))
        self.assertEqual((definition["tier"], definition["cultures"], definition["capital"]),
                         ("kingdom", ["british"], "STATE_TEST"))

    def test_preset_conditions(self):
        triggers = {"country_is_islamic": parse("t = { OR = { country_has_state_religion = rel:sunni } }").get("t")}
        effect = parse("""e = {
            if = { limit = { country_is_islamic = yes } activate_law = law_type:law_a }
            else = { activate_law = law_type:law_b }
            activate_law = law_type:law_c
            if = { limit = { is_country_type = decentralized } activate_law = law_type:law_d }
        }""").get("e")
        steps = countries.effect_steps(effect, triggers.get)
        islamic = {"all": [{"all": [{"any": [{"religion": ["sunni"]}]}]}]}
        self.assertEqual(steps, [
            {"law": "law_a", "cond": islamic}, {"law": "law_b", "cond": {"not": islamic}},
            {"law": "law_c", "cond": None}, {"law": "law_d", "cond": {"all": [{"type": "decentralized"}]}}])

    def test_patch_history(self):
        start = sample_start(laws={"lawgroup_governance_principles": "law_presidential_republic",
                                   "lawgroup_labor_rights": "law_worker_protections"},
                             tax_level="high", taxed_goods=["liquor", "tea"], ruling=["ig_devout", "ig_industrialists"],
                             ig_names={"ig_devout": {"english": "The Church"}}, election="")
        texts = countries.write_starts([start], country_base(), "mymod")
        self.assertEqual(sorted(texts), ["common/history/countries/tst - test.txt"])
        text = texts["common/history/countries/tst - test.txt"]
        block = parse(text).get("COUNTRIES").get("c:TST")
        keys = [e.key for e in block.entries]
        # the law of the group is replaced where it was; a group the history did not set comes after the laws
        self.assertIn("activate_law = law_type:law_presidential_republic\n", text)
        self.assertNotIn("law_monarchy", text)
        laws = [e.value for e in block.entries if e.key == "activate_law"]
        self.assertEqual(laws, ["law_type:law_presidential_republic", "law_type:law_wealth_voting",
                                "law_type:law_worker_protections"])
        self.assertLess(keys.index("effect_starting_politics_traditional"), keys.index("activate_law"))
        self.assertEqual(block.get("set_tax_level"), "high")
        self.assertEqual([e.value for e in block.entries if e.key == "add_taxed_goods"], ["g:liquor", "g:tea"])
        self.assertNotIn("set_next_election_date", keys)
        # ruling interest groups: one left, one kept (with its ideology), one new; the new name
        self.assertNotIn("ig:ig_intelligentsia", keys)
        devout = block.get("ig:ig_devout")
        self.assertEqual([(e.key, e.value) for e in devout.entries], [
            ("add_ruling_interest_group", "yes"), ("add_ideology", "ideology_moralist"),
            ("set_interest_group_name", "mymod_tst_ig_devout_name")])
        self.assertEqual(block.get("ig:ig_industrialists").get("add_ruling_interest_group"), "yes")
        # what was not changed stays as it was, comments too
        self.assertIn("add_technology_researched = labor_movement # had it early", text)
        self.assertIn("\t\tadd_journal_entry = { type = je_test }\n\t}\n}", text)
        self.assertEqual(block.get("set_institution_investment_level").get("level"), "3")

    def test_patch_other_parts(self):
        start = sample_start(tech_tier=4, techs=[], institutions=[], extra="add_modifier = { name = x }",
                             wealth="low", literacy="middling", ruling_party="conservative_party")
        texts = countries.write_starts([start], country_base(), "mymod")
        block = parse(texts["common/history/countries/tst - test.txt"]).get("COUNTRIES").get("c:TST")
        keys = [e.key for e in block.entries]
        self.assertIn("effect_starting_technology_tier_4_tech", keys)
        self.assertNotIn("effect_starting_technology_tier_1_tech", keys)
        self.assertNotIn("add_technology_researched", keys)
        self.assertNotIn("set_institution_investment_level", keys)
        self.assertNotIn("add_journal_entry", keys)
        self.assertEqual(block.get("add_modifier").get("name"), "x")
        population = parse(texts["common/history/population/tst - test.txt"]).get("POPULATION").get("c:TST")
        self.assertEqual([e.key for e in population.entries],
                         ["effect_starting_pop_wealth_low", "effect_starting_pop_literacy_middling"])
        government = parse(texts["common/history/governments/tst - test.txt"]).get("GOVERNMENT").get("c:TST")
        self.assertEqual([(e.key, [(s.key, s.value) for s in e.value.entries]) for e in government.entries], [
            ("py:liberal_party", [("add_momentum", "0.5")]),
            ("py:conservative_party", [("set_ruling_party", "yes")])])

    def test_country_without_history(self):
        start = countries.normalize_start({"key": "NEW", "laws": {"lawgroup_labor_rights": "law_worker_protections"},
                                           "tax_level": "low", "wealth": "medium", "ruling_party": "liberal_party"})
        texts = countries.write_starts([start], country_base(), "mymod")
        self.assertEqual(sorted(texts), ["common/history/countries/zzz_mymod_countries.txt",
                                         "common/history/governments/zzz_mymod_governments.txt",
                                         "common/history/population/zzz_mymod_population.txt"])
        block = parse(texts["common/history/countries/zzz_mymod_countries.txt"]).get("COUNTRIES").get("c:NEW")
        self.assertEqual([(e.key, e.value) for e in block.entries], [
            ("activate_law", "law_type:law_worker_protections"), ("set_tax_level", "low")])

    def test_definition_and_global_laws(self):
        script = countries.definition_script("TST", country_base().definition("TST"),
                                             {"color": [1, 2, 3], "tier": "empire", "religion": "catholic"})
        entry = parse(script).entries[0]
        self.assertEqual(entry.key, "REPLACE_OR_CREATE:TST")
        self.assertEqual([(e.key, e.value if isinstance(e.value, str) else e.value.items()) for e in entry.value.entries], [
            ("color", ["1", "2", "3"]), ("country_type", "recognized"), ("tier", "empire"), ("cultures", ["british"]),
            ("capital", "STATE_TEST"), ("religion", "catholic")])
        mine = sample_start(laws={"lawgroup_labor_rights": "law_no_workers_rights",
                                  "lawgroup_governance_principles": "law_monarchy"})
        script = countries.global_laws_script({"lawgroup_labor_rights": "law_worker_protections"}, [mine])
        root = parse(script).get("GLOBAL")
        self.assertEqual(root.get("every_country").get("activate_law"), "law_type:law_worker_protections")
        # countries the mod set a law of the group for keep theirs; other groups are not repeated
        self.assertEqual([(e.key, e.value) for e in root.get("c:TST").entries],
                         [("activate_law", "law_type:law_no_workers_rights")])
        self.assertIsNone(countries.global_laws_script({}, [mine]))

    def test_normalize_and_validate(self):
        game = {"countries": {"TST"}, "laws": COUNTRY_LAWS, "groups": set(COUNTRY_LAWS.values()),
                "goods": {"liquor", "tea"}, "techs": {"labor_movement"}, "igs": {"ig_devout"},
                "institutions": {"institution_schools"}, "parties": {"liberal_party"}, "cultures": {"british"},
                "states": {"STATE_TEST"}, "religions": {"catholic"}, "hierarchies": set()}
        self.assertEqual(countries.validate_start(sample_start(tax_level="high", wealth="low"), game), [])
        bad = sample_start(laws={"lawgroup_labor_rights": "law_monarchy"}, tax_level="huge", wealth="rich",
                           taxed_goods=["gold"], tariffs=[{"goods": "tea", "level": "free"}],
                           institutions=[{"institution": "institution_schools", "level": 9}], techs=["x"],
                           ruling=["ig_landowners"], ruling_party="party", extra="a = {",
                           definition={"tier": "huge", "cultures": [], "capital": "STATE_X"})
        self.assertEqual(countries.validate_start(bad, game), [
            "law", "tier", "cultures", "capital", "tax_level", "wealth", "goods", "tariffs", "institutions",
            "techs", "igs", "ruling_party", "braces:extra"])
        self.assertEqual(countries.validate_start(sample_start(key="ZZZ"), game), ["country_unknown"])
        for raw in ({"key": "../x"}, {"key": "TST", "laws": {"a b": "c"}}, {"key": "TST", "election": "soon"},
                    {"key": "TST", "definition": {"color": "red"}}, {"key": "TST", "tech_tier": 9}):
            with self.assertRaises(ValueError):
                countries.normalize_start(raw)
        everyone = countries.normalize_start({"key": "x", "mode": "all", "tax_level": "high",
                                              "laws": {"lawgroup_labor_rights": "law_worker_protections"}})
        self.assertEqual((everyone["key"], everyone["tax_level"]), ("*", None))
        self.assertEqual(countries.validate_start(everyone, game), [])
        self.assertTrue(countries.is_empty_start(sample_start()))
        self.assertFalse(countries.is_empty_start(sample_start(ruling_party="")))  # "no ruling party" is a change
        self.assertFalse(countries.is_empty_start(everyone))

    def test_load(self):
        with tempfile.TemporaryDirectory() as tmp:
            files = {
                "game/common/history/countries/tst - test.txt": HISTORY,
                "game/common/history/population/tst - test.txt": POPULATION,
                "mod/common/history/governments/tst - test.txt": GOVERNMENT,
                "game/common/history/pops/00_pops.txt":
                    "POPS = { s:STATE_TEST = { region_state:TST = { create_pop = { culture = a size = 1500 } "
                    "create_pop = { culture = b size = 500 } } } }\n",
                "game/common/history/buildings/00_buildings.txt":
                    "BUILDINGS = { s:STATE_TEST = { region_state:TST = { create_building = { building = x } } } }\n",
                "game/common/history/characters/tst.txt": "CHARACTERS = { c:TST ?= { create_character = { } } }\n",
                "game/common/scripted_effects/00_politics.txt":
                    "effect_starting_politics_traditional = { activate_law = law_type:law_monarchy }\n"
                    "effect_starting_technology_tier_1_tech = { add_era_researched = era_1 "
                    "add_technology_researched = railways }\n",
            }
            for rel, text in files.items():
                path = Path(tmp) / rel
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(text, encoding="utf-8")
            data = GameData.__new__(GameData)
            data.fs = FileSystem([Source(name, name, Path(tmp) / name, "mod") for name in ("game", "mod")])
            data.warnings = []
            data.state_shares = {"STATE_TEST": [{"country": "TST", "provinces": ["AAAAAA", "BBBBBB"],
                                                 "unincorporated": False}]}
            data.history_paths, data.states, data.state_homelands, data.state_claims = {}, {}, {}, {}
            data.state_files = {kind: {} for kind in territory.STATE_DIRS}
            data._load_countries()
            self.assertEqual(data.history_files["governments"], {"TST": ["common/history/governments/tst - test.txt"]})
            self.assertEqual(data.governments["TST"], {"ruling_party": "liberal_party"})
            self.assertEqual(data.populations["TST"], {"wealth": "high", "literacy": ""})
            self.assertEqual(data.histories["TST"]["ruling"], ["ig_intelligentsia", "ig_devout"])
            self.assertEqual(data.country_stats["TST"], {"states": 1, "provinces": 2, "population": 2000,
                                                         "buildings": 1, "characters": 1})
            self.assertEqual(data.start_effects, {"effect_starting_politics_traditional": [{"law": "law_monarchy",
                                                                                           "cond": None}]})
            self.assertEqual(data.tech_tiers, {1: {"eras": ["era_1"], "techs": ["railways"]}})
            base = data.start_base()
            self.assertEqual(base.text("common/history/governments/tst - test.txt"), GOVERNMENT)


STATES = """\
STATES = {
	s:STATE_A = {
		create_state = {
			country = c:TST
			owned_provinces = { xA00001 xA00002 }
		}
		create_state = {
			country = c:OTH
			owned_provinces = { xA00003 xA00004 }
			state_type = unincorporated
		}
		add_homeland = cu:british # the old homeland
	}
	s:STATE_B = {
		create_state = {
			country = c:TST
			owned_provinces = { xB00001 xB00002 }
		}
		add_claim = c:OTH
	}
	s:STATE_C = {
		create_state = {
			country = c:OTH
			owned_provinces = { xC00001 }
		}
	}
}
"""

POPS = """\
POPS = {
	s:STATE_A = {
		region_state:TST = {
			create_pop = { culture = british size = 1000 }
		}
		region_state:OTH = {
			create_pop = { culture = french size = 401 }
			create_pop = { culture = french religion = protestant pop_type = slaves size = 10 }
		}
	}
	s:STATE_B = {
		region_state:TST = {
			create_pop = { culture = british size = 600 }
		}
	}
	s:STATE_C = {
		region_state:OTH = {
			create_pop = { culture = french size = 300 }
		}
	}
}
"""

BUILDINGS = """\
BUILDINGS = {
	s:STATE_A = {
		region_state:TST = {
			create_building = {
				building = "building_financial_district"
				add_ownership = { country = { country = "c:TST" levels = 1 } }
				reserves = 1
			}
		}
	}
	s:STATE_B = {
		region_state:TST = {
			establish_cossack_host = yes
			create_building = {
				building = "building_manor_house"
				add_ownership = { country = { country = "c:TST" levels = 2 } }
				activate_production_methods = { "pm_a" }
			}
			create_building = {
				building = "building_farm"
				add_ownership = {
					building = { type = "building_manor_house" country = "c:TST" levels = 3 region = "STATE_B" }
					building = { type = "building_financial_district" country = "c:TST" levels = 1 region = "STATE_A" }
				}
			}
		}
	}
	s:STATE_C = {
		region_state:OTH = {
			create_building = {
				building = "building_mine"
				add_ownership = {
					building = { type = "building_financial_district" country = "c:TST" levels = 2 region = "STATE_A" }
					country = { country = "c:OTH" levels = 1 }
				}
			}
		}
	}
}
"""

DIPLOMACY = """\
DIPLOMACY = {
	c:OTH ?= {
		set_relations = { country = c:TST value = -30 }
		set_relations = { country = c:ZZZ value = 10 }
	}
}
"""

TREATIES = """\
TREATIES = {
	create_treaty = { first_country = c:TST second_country = c:OTH is_draft = no }
	create_treaty = { first_country = c:OTH second_country = c:ZZZ is_draft = no }
}
"""


def world_base():
    return FakeStartBase({"common/history/states/00_states.txt": STATES, "common/history/pops/00_pops.txt": POPS,
                          "common/history/buildings/00_buildings.txt": BUILDINGS,
                          "common/history/diplomacy/00_relations.txt": DIPLOMACY,
                          "common/history/treaties/00_treaties.txt": TREATIES},
                         {"STATE_A": ["A00001", "A00002", "A00003", "A00004"], "STATE_B": ["B00001", "B00002"],
                          "STATE_C": ["C00001"], "STATE_D": ["D00001"]})


def territory_start(key, **changes):
    start = countries.empty_start(key)
    start.update(changes)
    return countries.normalize_start(start)


def owners_of(building):
    return [(o["kind"], o["country"], o["region"], o["levels"]) for o in building["ownership"]]


class TerritoryTest(unittest.TestCase):
    def test_read(self):
        base = world_base()
        self.assertEqual([(s["country"], s["provinces"], s["unincorporated"]) for s in base.shares["STATE_A"]],
                         [("TST", ["A00001", "A00002"], False), ("OTH", ["A00003", "A00004"], True)])
        self.assertEqual((base.homelands, base.claims), ({"STATE_A": ["british"]}, {"STATE_B": ["OTH"]}))
        self.assertEqual(base.pops["STATE_A"]["OTH"][1], {"culture": "french", "religion": "protestant",
                                                          "pop_type": "slaves", "size": 10, "extra": ""})
        farm = base.buildings["STATE_B"]["TST"][1]
        self.assertEqual(owners_of(farm), [("building", "TST", "STATE_B", 3), ("building", "TST", "STATE_A", 1)])
        self.assertEqual(base.others["STATE_B"]["TST"], ["establish_cossack_host = yes"])
        # a building written out reads back the same
        again = territory.building_from_block(parse("\n".join(territory.building_lines(farm))).get("create_building"))
        self.assertEqual(again, farm)
        manor = base.buildings["STATE_B"]["TST"][0]
        self.assertEqual(manor["pms"], ["pm_a"])

    def test_whole_state_moves_with_pops_and_buildings(self):
        world = territory.World(world_base(), [territory_start("OTH", gains=["B00001", "B00002"])])
        self.assertEqual(world.changed_provinces, {"B00001": "OTH", "B00002": "OTH"})
        self.assertEqual([s["country"] for s in world.shares["STATE_B"]], ["OTH"])
        self.assertEqual(world.pops[("STATE_B", "TST")], None)
        self.assertEqual(world.pops[("STATE_B", "OTH")], [{"culture": "british", "religion": "", "pop_type": "",
                                                           "size": 600, "extra": ""}])
        manor, farm = world.buildings[("STATE_B", "OTH")]
        self.assertEqual(owners_of(manor), [("country", "OTH", "", 2)])
        # the manor moved along, and what TST's district elsewhere held is OTH's now
        self.assertEqual(owners_of(farm), [("building", "OTH", "STATE_B", 3), ("country", "OTH", "", 1)])
        self.assertEqual(world.moved, {("STATE_B", "TST"): "OTH"})
        self.assertEqual(world.vanished, set())

    def test_some_provinces_share_out_the_pops(self):
        world = territory.World(world_base(), [territory_start("TST", gains=["A00003"])])
        self.assertEqual([(s["country"], s["provinces"]) for s in world.shares["STATE_A"]],
                         [("TST", ["A00001", "A00002", "A00003"]), ("OTH", ["A00004"])])
        sizes = {(p["culture"], p["pop_type"]): p["size"] for p in world.pops[("STATE_A", "TST")]}
        self.assertEqual(sizes, {("british", ""): 1000, ("french", ""): 200, ("french", "slaves"): 5})
        self.assertEqual(sum(p["size"] for p in world.pops[("STATE_A", "OTH")]), 206)
        self.assertNotIn(("STATE_A", "OTH"), world.buildings)  # the buildings stay; OTH has none there

    def test_vanished_country(self):
        gains = ["A00001", "A00002", "B00001", "B00002"]
        world = territory.World(world_base(), [territory_start("OTH", gains=gains)])
        self.assertEqual(world.vanished, {"TST"})
        # the mine was held by TST's district, which is OTH's now
        mine = world.buildings[("STATE_C", "OTH")][0]
        self.assertEqual(owners_of(mine), [("building", "OTH", "STATE_A", 2), ("country", "OTH", "", 1)])
        texts = diplomacy.write_diplomacy([], world.vanished, world_base(), "mymod", world_base().articles)
        relations = parse(texts["common/history/diplomacy/00_relations.txt"]).get("DIPLOMACY").get("c:OTH")
        self.assertEqual([e.value.get("country") for e in relations.entries], ["c:ZZZ"])
        treaties = parse(texts["common/history/treaties/00_treaties.txt"]).get("TREATIES")
        self.assertEqual([e.value.get("first_country") for e in treaties.entries], ["c:OTH"])

    def test_released_and_settings(self):
        start = territory_start("TST", releases=["A00002"], state_types={"STATE_A": "unincorporated"},
                                homelands={"STATE_A": {"add": ["scottish"], "remove": ["british"]}},
                                claims={"add": ["STATE_C"], "remove": []})
        world = territory.World(world_base(), [start])
        self.assertEqual([(s["country"], s["provinces"], s["unincorporated"]) for s in world.shares["STATE_A"]],
                         [("TST", ["A00001"], True), ("OTH", ["A00003", "A00004"], True)])
        self.assertEqual(world.pops[("STATE_A", "TST")][0]["size"], 500)  # half the provinces: half the pops
        self.assertEqual((world.homelands, world.claims), ({"STATE_A": ["scottish"]}, {"STATE_C": ["TST"]}))
        text = territory.write_territory(world, world_base(), "mymod")["common/history/states/00_states.txt"]
        block = parse(text).get("STATES").get("s:STATE_A")
        self.assertEqual([(e.key, e.value if isinstance(e.value, str) else e.value.get("country")) for e in block.entries],
                         [("create_state", "c:TST"), ("create_state", "c:OTH"), ("add_homeland", "cu:scottish")])
        self.assertEqual(block.entries[0].value.get("owned_provinces").items(), ["xA00001"])
        self.assertEqual(block.entries[0].value.get("state_type"), "unincorporated")
        self.assertEqual(parse(text).get("STATES").get("s:STATE_C").get("add_claim"), "c:TST")
        self.assertIn("\t\tadd_claim = c:OTH\n", text)  # the other states stay as they were

    def test_own_lists_and_writing(self):
        pops = [{"culture": "scottish", "size": 50}]
        start = territory_start("TST", gains=["C00001", "D00001"], pops={"STATE_C": pops})
        world = territory.World(world_base(), [start])
        self.assertEqual([p["culture"] for p in world.pops[("STATE_C", "TST")]], ["scottish"])
        before = territory.World(world_base(), [start], own_lists_of="TST")
        self.assertEqual([p["culture"] for p in before.pops[("STATE_C", "TST")]], ["french"])
        parts = {part["state"]: part for part in before.country("TST")}
        self.assertEqual(sorted(parts), ["STATE_A", "STATE_B", "STATE_C", "STATE_D"])
        self.assertEqual((parts["STATE_C"]["moved"], parts["STATE_B"]["moved"]), (True, False))
        texts = territory.write_territory(world, world_base(), "mymod")
        self.assertEqual(sorted(texts), ["common/history/buildings/00_buildings.txt", "common/history/pops/00_pops.txt",
                                         "common/history/states/00_states.txt",
                                         "common/history/states/zzz_mymod_states.txt"])
        state_c = parse(texts["common/history/pops/00_pops.txt"]).get("POPS").get("s:STATE_C")
        self.assertEqual([e.key for e in state_c.entries], ["region_state:TST"])
        self.assertEqual(state_c.get("region_state:TST").get("create_pop").get("culture"), "scottish")
        buildings = parse(texts["common/history/buildings/00_buildings.txt"]).get("BUILDINGS")
        self.assertEqual(buildings.get("s:STATE_C").get("region_state:TST").get("create_building").get("building"),
                         "building_mine")
        # a state nobody owned at the start gets its own block
        fresh = parse(texts["common/history/states/zzz_mymod_states.txt"]).get("STATES").get("s:STATE_D")
        self.assertEqual(fresh.get("create_state").get("country"), "c:TST")
        # what did not change stays as it was
        self.assertIn('building = "building_manor_house"', texts["common/history/buildings/00_buildings.txt"])

    def test_normalize_and_validate(self):
        game = {"countries": {"TST", "OTH"}, "laws": {}, "groups": set(), "goods": set(), "techs": set(), "igs": set(),
                "institutions": set(), "parties": set(), "cultures": {"british"}, "states": {"STATE_A"},
                "religions": {"catholic"}, "hierarchies": set(), "provinces": {"A00001"}, "pop_types": {"slaves"},
                "buildings": {"building_farm"}, "pms": {"pm_a"}, "companies": set()}
        good = territory_start("TST", gains=["xa00001"], pops={"STATE_A": [{"culture": "british", "size": 5}]},
                               buildings={"STATE_A": [{"building": "building_farm", "pms": ["pm_a"], "ownership": [
                                   {"kind": "country", "country": "OTH", "levels": 2}]}]})
        self.assertEqual(good["gains"], ["A00001"])
        self.assertEqual(countries.validate_start(good, game), [])
        bad = territory_start("TST", gains=["B00001"], homelands={"STATE_X": {"add": ["x"]}},
                              pops={"STATE_A": [{"culture": "x", "size": 5}]},
                              buildings={"STATE_A": [{"building": "building_x"}]})
        self.assertEqual(countries.validate_start(bad, game), ["provinces", "states", "cultures", "pops", "buildings"])
        for raw in ({"gains": ["nope"]}, {"pops": {"STATE_A": [{"culture": "a", "size": -1}]}},
                    {"buildings": {"STATE_A": [{"building": "b", "ownership": [{"kind": "x"}]}]}},
                    {"state_types": {"STATE_A": "sort of"}}):
            with self.assertRaises(ValueError):
                countries.normalize_start({"key": "TST", **raw})
        self.assertFalse(countries.is_empty_start(territory_start("TST", releases=["A00001"])))


SUBJECTS = """\
DIPLOMACY = {
	c:TST ?= {
		create_diplomatic_pact = {
			country = c:SUB
			type = puppet
		}
		add_liberty_desire = -30
		every_subject_or_below = {
			set_relations = { country = c:OTH value = 10 }
		}
	}
	c:OTH ?= {
		create_diplomatic_pact = {
			country = c:ZZZ
			type = rivalry
		}
	}
}
"""

DLC_TREATIES = """\
TREATIES = {
	# Alliance
	if = {
		limit = { has_dlc_feature = mp1_treaties }
		create_treaty = {
			name = treaty_name_x
			first_country = c:TST
			second_country = c:OTH
			is_draft = no
			entered_into_force_on = 1830.1.1
			binding_period = { years = 10 }
			articles_to_create = {
				{ article = defensive_pact }
				{
					article = goods_transfer
					source_country = c:OTH
					target_country = c:TST
					inputs = { { goods = g:wine } { quantity = 20 } }
				}
			}
		}
	}
	else = {
		create_treaty = {
			name = treaty_name_x
			first_country = c:TST
			second_country = c:OTH
			is_draft = no
			entered_into_force_on = 1830.1.1
			articles_to_create = { { article = defensive_pact } }
		}
	}
	create_treaty = {
		first_country = c:OTH
		second_country = c:ZZZ
		entered_into_force_on = 1831.1.1
		articles_to_create = { { article = treaty_port source_country = c:ZZZ target_country = c:OTH
			inputs = { { state = s:STATE_C.region_state:ZZZ } } } }
	}
}
"""

CHARACTERS = """\
CHARACTERS = {
	c:TST ?= {
		# Ruler
		create_character = {
			template = tst_king
		}

		create_character = {
			template = tst_general
			on_created = { set_variable = x }
		}

		if = {
			limit = { exists = c:OTH }
			create_character = { template = tst_maybe }
		}
	}
}
"""


def relations_base():
    return FakeStartBase({"common/history/diplomacy/00_relations.txt": DIPLOMACY,
                          "common/history/diplomacy/00_subjects.txt": SUBJECTS,
                          "common/history/treaties/00_treaties.txt": DLC_TREATIES,
                          "common/history/characters/tst.txt": CHARACTERS})


def relations_start(key="TST", **changes):
    start = countries.empty_start(key)
    start.update(changes)
    return countries.normalize_start(start)


class RelationsTest(unittest.TestCase):
    def test_read_diplomacy(self):
        found = []
        diplomacy.read_diplomacy(parse(SUBJECTS), "x", found)
        items = [(i["kind"], i["first"], i["second"], i["type"], i["value"]) for i, *_rest in found]
        # what is inside every_subject_or_below is kept as script
        self.assertEqual(items, [("pact", "TST", "SUB", "puppet", 0), ("liberty_desire", "TST", "", "", -30),
                                 ("pact", "OTH", "ZZZ", "rivalry", 0)])
        again = parse("\n".join(diplomacy.item_lines(found[0][0]))).entries[0]
        self.assertEqual(diplomacy.item_from_entry("TST", again), found[0][0])

    def test_resolve_and_sync(self):
        base = [{"kind": "relations", "first": "OTH", "second": "TST", "type": "", "value": -30},
                {"kind": "relations", "first": "OTH", "second": "ZZZ", "type": "", "value": 10}]
        tst = relations_start(diplomacy=[{"kind": "relations", "first": "OTH", "second": "TST", "value": -30},
                                         {"kind": "truce", "first": "TST", "second": "ZZZ", "value": 12}])
        removed, added = diplomacy.resolve_diplomacy(base, [tst])
        self.assertEqual(removed, [])  # written again as it was: stays where it was
        self.assertEqual([(i["kind"], i["second"]) for i in added], [("truce", "ZZZ")])
        # ZZZ saved later without the truce: TST's list follows
        zzz = relations_start("ZZZ", diplomacy=[])
        diplomacy.sync_diplomacy(zzz, [tst])
        self.assertEqual([i["kind"] for i in tst["diplomacy"]], ["relations"])
        self.assertEqual(diplomacy.resolve_diplomacy(base, [tst, zzz]), ([1], []))
        self.assertEqual(diplomacy.resolve_diplomacy(base, [], {"TST"}), ([0], []))

    def test_write_diplomacy(self):
        base = relations_base()
        start = relations_start(diplomacy=[
            {"kind": "pact", "first": "TST", "second": "SUB", "type": "puppet"},
            {"kind": "pact", "first": "TST", "second": "NEW", "type": "puppet"},
            {"kind": "relations", "first": "TST", "second": "ZZZ", "value": 50},
            {"kind": "obligation", "first": "TST", "second": "OTH"},
            {"kind": "pact", "first": "OTH", "second": "TST", "type": "embargo"}])
        texts = diplomacy.write_diplomacy([start], set(), base, "mymod", base.articles)
        tst = parse(texts["common/history/diplomacy/00_subjects.txt"]).get("DIPLOMACY").get("c:TST")
        # the liberty desire goes (not in the list); what the tool does not know stays
        self.assertEqual([(e.key, e.value.get("country")) for e in tst.entries],
                         [("create_diplomatic_pact", "c:SUB"), ("every_subject_or_below", None),
                          ("create_diplomatic_pact", "c:NEW")])
        text = texts["common/history/diplomacy/00_relations.txt"]
        relations = parse(text).get("DIPLOMACY")
        # OTH's relations with TST go (TST's list has none)
        self.assertEqual([e.value.get("country") for e in relations.get("c:OTH").entries], ["c:ZZZ"])
        self.assertIn("\tc:TST ?= {\n\t\tset_relations = { country = c:ZZZ value = 50 }\n\t}\n", text)
        fresh = parse(texts["common/history/diplomacy/zzz_mymod_diplomacy.txt"]).get("DIPLOMACY")
        self.assertEqual(fresh.get("c:TST").get("set_owes_obligation_to").get("country"), "c:OTH")
        # a pact type no file has yet: in the file with most pacts, in OTH's block there
        other = parse(texts["common/history/diplomacy/00_subjects.txt"]).get("DIPLOMACY").get("c:OTH")
        self.assertEqual([e.value.get("type") for e in other.entries], ["rivalry", "embargo"])

    def test_treaties(self):
        base = relations_base()
        found = []
        diplomacy.read_treaties(parse(DLC_TREATIES), "t", found)
        first, port = found[0][0], found[2][0]
        self.assertEqual((first["id"], first["dlc"], found[1][0]["id"]),
                         ("TST|OTH|treaty_name_x|1830.1.1", True, "TST|OTH|treaty_name_x|1830.1.1"))
        self.assertEqual(first["articles"][1], {"article": "goods_transfer", "source": "OTH", "target": "TST",
                                                "inputs": {"goods": "wine", "quantity": 20}})
        self.assertEqual(port["articles"][0]["inputs"], {"state": "STATE_C", "state_country": "ZZZ"})
        added = {"names": {"english": "Pact"}, "second": "OTH", "date": "1836.1.1", "years": 5, "articles": [
            {"article": "goods_transfer", "source": "TST", "target": "OTH", "inputs": {"goods": "grain", "quantity": 3}},
            {"article": "treaty_port", "source": "OTH", "target": "TST",
             "inputs": {"state": "STATE_A", "state_country": "OTH"}}]}
        start = relations_start(treaties_removed=[first["id"]], treaties_added=[added])
        texts = diplomacy.write_diplomacy([start], set(), base, "mymod", base.articles)
        text = texts["common/history/treaties/00_treaties.txt"]
        # both versions of the DLC condition go, with the condition
        self.assertEqual([e.key for e in parse(text).get("TREATIES").entries], ["create_treaty"])
        self.assertIn("\t# Alliance\n\tcreate_treaty", text)
        new = parse(texts["common/history/treaties/zzz_mymod_treaties.txt"]).get("TREATIES").get("create_treaty")
        self.assertEqual((new.get("name"), new.get("first_country"), new.get("entered_into_force_on")),
                         ("mymod_treaty_tst_1", "c:TST", "1836.1.1"))
        read = diplomacy.treaty_from_block(new)
        self.assertEqual([a["inputs"] for a in read["articles"]], [{"quantity": 3, "goods": "grain"},
                                                                   {"state": "STATE_A", "state_country": "OTH"}])
        self.assertEqual(countries.start_texts(start, "english", "mymod")[1], {"mymod_treaty_tst_1": "Pact"})
        # a country without land: its treaties go, and the new ones with it are not written
        texts = diplomacy.write_diplomacy([start], {"OTH"}, base, "mymod", base.articles)
        self.assertNotIn("common/history/treaties/zzz_mymod_treaties.txt", texts)
        self.assertEqual(parse(texts["common/history/treaties/00_treaties.txt"]).get("TREATIES").entries, [])

    def test_characters(self):
        found = characters.read_characters(characters.empty_characters(),
                                           parse(CHARACTERS).get("CHARACTERS").get("c:TST"))
        self.assertEqual(found["items"], [{"template": "tst_king", "extra": "", "new": None},
                                          {"template": "tst_general", "extra": "on_created = { set_variable = x }",
                                           "new": None}])
        self.assertEqual(found["other"], 1)
        new = {"first_name": {"english": "Ann"}, "last_name": {"english": "Lee"}, "culture": "british",
               "role": "general", "commander_rank": "commander_rank_2", "traits": ["direct"], "female": True}
        start = relations_start(characters=[found["items"][1], {"new": new}])
        text = countries.write_starts([start], relations_base(), "mymod")["common/history/characters/tst.txt"]
        block = parse(text).get("CHARACTERS").get("c:TST")
        self.assertEqual([e.value.get("template") for e in block.entries if e.key == "create_character"],
                         ["tst_general", "mymod_tst_character_1"])
        self.assertEqual(block.get("if").get("create_character").get("template"), "tst_maybe")
        self.assertNotIn("tst_king", text)
        self.assertNotIn("}\n\n\t\tcreate_character", text)  # no gap where a character was
        template = parse(characters.templates_script([start], "mymod")).get("mymod_tst_character_1")
        self.assertEqual((template.get("first_name"), template.get("female"), template.get("is_general"),
                          template.get("culture"), template.get("traits").items()),
                         ("mymod_tst_character_1_first", "yes", "yes", "cu:british", ["direct"]))
        self.assertEqual(countries.start_texts(start, "english", "mymod")[1],
                         {"mymod_tst_character_1_first": "Ann", "mymod_tst_character_1_last": "Lee"})
        # a country without characters gets a block of its own
        other = relations_start("OTH", characters=[{"template": "tst_king"}])
        texts = countries.write_starts([other], relations_base(), "mymod")
        fresh = parse(texts["common/history/characters/zzz_mymod_characters.txt"]).get("CHARACTERS")
        self.assertEqual(fresh.get("c:OTH").get("create_character").get("template"), "tst_king")

    def test_normalize_and_validate(self):
        game = {"countries": {"TST", "OTH"}, "laws": {}, "groups": set(), "goods": {"wine"}, "techs": set(),
                "igs": {"ig_devout"}, "institutions": set(), "parties": set(), "cultures": {"british"},
                "states": {"STATE_A"}, "religions": set(), "hierarchies": set(), "provinces": set(),
                "pop_types": set(), "buildings": set(), "pms": set(), "companies": set(), "pact_types": {"puppet"},
                "articles": relations_base().articles, "regions": set(), "law_types": set(),
                "templates": {"tst_king"}, "traits": {"direct"}, "ideologies": set()}
        good = relations_start(
            diplomacy=[{"kind": "pact", "first": "OTH", "second": "TST", "type": "puppet"},
                       {"kind": "liberty_desire", "value": -10}],
            treaties_added=[{"second": "OTH", "date": "1836.1.1", "years": 5, "articles": [
                {"article": "goods_transfer", "source": "OTH", "target": "TST",
                 "inputs": {"goods": "wine", "quantity": 1}}]}],
            characters=[{"template": "tst_king"}, {"new": {"first_name": {"english": "A"},
                                                           "last_name": {"english": "B"}, "culture": "british",
                                                           "traits": ["direct"]}}])
        self.assertEqual(countries.validate_start(good, game), [])
        self.assertEqual(good["diplomacy"][1], {"kind": "liberty_desire", "first": "TST", "second": "", "type": "",
                                                "value": -10})
        self.assertFalse(countries.is_empty_start(relations_start(diplomacy=[])))
        self.assertTrue(countries.is_empty_start(relations_start()))
        bad = relations_start(
            diplomacy=[{"kind": "pact", "first": "TST", "second": "XXX", "type": "puppet"}],
            treaties_added=[{"second": "OTH", "date": "soon", "years": 5, "articles": [
                {"article": "goods_transfer", "source": "TST", "target": "TST", "inputs": {"goods": "gold"}}]}],
            characters=[{"template": "nobody"}, {"new": {"culture": "x", "role": "ig_leader"}}])
        self.assertEqual(countries.validate_start(bad, game),
                         ["diplomacy", "treaty_date", "treaty_articles", "treaty_inputs", "character_template",
                          "character_name", "character_fields"])
        for raw in ({"diplomacy": [{"kind": "war"}]},
                    {"diplomacy": [{"kind": "relations", "first": "OTH", "second": "ZZZ", "value": 5}]},
                    {"diplomacy": [{"kind": "relations", "second": "OTH", "value": 500}]},
                    {"treaties_added": [{"second": "TST", "years": 1, "articles": []}]},
                    {"characters": [{"new": {"role": "king"}}]}):
            with self.assertRaises(ValueError):
                countries.normalize_start({"key": "TST", **raw})


def new_country(**changes):
    start = {"key": "NEW", "mode": "new", "names": {"english": "New Land"}, "adjs": {"english": "Newish"},
             "definition": {"color": [10, 20, 30], "country_type": "recognized", "tier": "principality",
                            "cultures": ["british"], "capital": "STATE_A"},
             "laws": {"lawgroup_labor_rights": "law_worker_protections"}, "tax_level": "high",
             "gains": ["A00001"],
             "flag": {"pattern": "pattern_solid.tga", "colors": ["white", "blue", "red"], "emblems": [
                 {"kind": "textured", "texture": "mymod_eagle_12345678.dds", "x": 0.5, "y": 0.5, "sx": 1, "sy": 1,
                  "rotation": 0},
                 {"kind": "colored", "texture": "ce_star.dds", "colors": ["yellow", "yellow", "red"], "x": 0.25,
                  "y": 0.3, "sx": -0.4, "sy": 0.4, "rotation": 15}]}}
    start.update(changes)
    return countries.normalize_start(start)


FLAG_GAME = {"countries": {"TST", "OTH"}, "laws": COUNTRY_LAWS, "groups": set(COUNTRY_LAWS.values()),
             "goods": set(), "techs": set(), "igs": set(), "institutions": set(), "parties": set(),
             "cultures": {"british"}, "states": {"STATE_A"}, "religions": set(), "hierarchies": set(),
             "provinces": {"A00001"}, "pop_types": set(), "buildings": set(), "pms": set(), "companies": set(),
             "patterns": {"pattern_solid.tga"}, "colored_emblems": {"ce_star.dds"},
             "textured_emblems": {"mymod_eagle_12345678.dds"}, "coa_colors": {"white", "blue", "red", "yellow"}}


class NewCountryTest(unittest.TestCase):
    def test_normalize_and_validate(self):
        start = new_country()
        self.assertEqual((start["mode"], start["flag"]["emblems"][1]["sx"]), ("new", -0.4))
        self.assertEqual(countries.validate_start(start, FLAG_GAME), [])
        self.assertFalse(countries.is_empty_start(new_country(gains=[], laws={}, tax_level=None)))
        bad = new_country(key="TST", names={}, definition={"cultures": []},
                          flag={"pattern": "pattern_x.dds", "colors": ["white", "blue", "red"]})
        self.assertEqual(countries.validate_start(bad, FLAG_GAME),
                         ["key_exists", "color_missing", "country_type", "tier", "cultures", "capital_missing",
                          "name_missing", "flag"])
        self.assertEqual(countries.validate_start(new_country(flag=None), FLAG_GAME), ["flag"])
        for raw in ({"key": "new"}, {"key": "NEWS"}, {"flag": {"pattern": "../x.dds", "colors": ["a", "b", "c"]}},
                    {"flag": {"pattern": "p.dds", "colors": ["a"]}},
                    {"flag": {"pattern": "p.dds", "colors": ["a", "b", "c"], "emblems": [{"kind": "colored",
                                                                                          "texture": "e.dds"}]}}):
            with self.assertRaises(ValueError):
                new_country(**raw)

    def test_flag_scripts(self):
        start = new_country()
        coa = parse(flags.coat_of_arms_script("NEW", start["flag"])).get("NEW")
        self.assertEqual((coa.get("pattern"), coa.get("color1"), coa.get("color3")), ("pattern_solid.tga", "white", "red"))
        # the colours under the pictures
        self.assertEqual([e.key for e in coa.entries if isinstance(e.value, Block)], ["colored_emblem", "textured_emblem"])
        instance = coa.get("colored_emblem").get("instance")
        self.assertEqual((instance.get("position").items(), instance.get("scale").items(), instance.get("rotation")),
                         (["0.25", "0.3"], ["-0.4", "0.4"], "15"))
        self.assertIsNone(coa.get("textured_emblem").get("instance"))
        definition = parse(flags.flag_definition_script("NEW")).get("NEW").get("flag_definition")
        self.assertEqual((definition.get("coa"), definition.get("priority")), ("NEW", "1"))
        self.assertEqual(flags.flag_images(start["flag"]), {"gfx/coat_of_arms/textured_emblems/mymod_eagle_12345678.dds"})

    def test_writing(self):
        start = new_country()
        definition = parse(countries.new_definition_script(start)).get("NEW")
        self.assertEqual((definition.get("tier"), definition.get("cultures").items(), definition.get("capital")),
                         ("principality", ["british"], "STATE_A"))
        self.assertEqual(countries.start_texts(start, "english", "mymod"), ({}, {"NEW": "New Land", "NEW_ADJ": "Newish"}))
        texts = countries.write_starts([start], world_base(), "mymod")
        self.assertEqual(sorted(texts), ["common/history/countries/new - new_land.txt"])
        block = parse(texts["common/history/countries/new - new_land.txt"]).get("COUNTRIES").get("c:NEW")
        self.assertEqual((block.get("activate_law"), block.get("set_tax_level")),
                         ("law_type:law_worker_protections", "high"))
        # its land is taken like any other country's
        world = territory.World(world_base(), [start])
        self.assertEqual(world.owner("A00001"), "NEW")

    def test_missing_countries(self):
        # a new country without land, and one deleted from the mod, are not named in diplomacy
        base = world_base()
        base.countries = {"TST", "OTH", "ZZZ"}
        landless = new_country(gains=[])
        tst = territory_start("TST", diplomacy=[{"kind": "relations", "first": "TST", "second": "NEW", "value": 5},
                                                 {"kind": "relations", "first": "TST", "second": "OLD", "value": 5}])
        world = territory.World(base, [landless, tst])
        self.assertEqual(project.missing_countries(world, [landless, tst], base), {"NEW", "OLD"})
        texts = diplomacy.write_diplomacy([landless, tst], {"NEW", "OLD"}, base, "mymod", base.articles)
        self.assertNotIn("c:NEW", texts["common/history/diplomacy/00_relations.txt"])
        self.assertNotIn("c:OLD", texts["common/history/diplomacy/00_relations.txt"])

    def test_textures(self):
        pixels = bytes(range(256)) * 6  # 4×6 RGBA... as 6×... any size works
        width, height = 8, 6
        pixels = bytes((x * 7 + y * 13 + c * 50) % 256 for y in range(height) for x in range(width) for c in range(4))
        dds = textures.rgba_to_dds(width, height, pixels)
        self.assertEqual(textures.png_pixels(textures.dds_to_png(dds, 64)), (width, height, pixels))
        # the smallest mip level is one pixel: 8×6, 4×3, 2×1, 1×1
        self.assertEqual(len(dds), 128 + 4 * (48 + 12 + 2 + 1))
        tga = bytes([0, 0, 2]) + bytes(9) + bytes([2, 0, 1, 0, 24, 0]) + bytes([1, 2, 3, 4, 5, 6])  # bottom-up
        self.assertEqual(textures.png_pixels(textures.to_browser_image(tga, 64, "x.tga")[0])[2],
                         bytes([3, 2, 1, 255, 6, 5, 4, 255]))


class LocalizationTest(unittest.TestCase):
    def test_read_and_clean(self):
        entries = read_loc_text('l_english:\n company_x:0 "The #b $other$#! Co." # note\n other: "Big"\n')["english"]
        self.assertEqual(entries["company_x"], "The #b $other$#! Co.")
        self.assertEqual(Localization(entries).name("company_x"), "The Big Co.")
        self.assertEqual(Localization({}, Localization(entries)).name("other"), "Big")
        self.assertEqual(Localization({}).name("missing"), "missing")
        # a text that is only script (as a mod's [GetCustom(...)] name) takes the fallback language's
        scripted = Localization({"party": "[SCOPE.GetCustom('x')]"}, Localization({"party": "Party"}))
        self.assertEqual(scripted.name("party"), "Party")
        self.assertEqual(Localization({"party": "[SCOPE.GetCustom('x')]"}).name("party"), "party")


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

    def test_wage_basis(self):
        with tempfile.TemporaryDirectory() as tmp:
            files = {
                "game/common/buy_packages/00_buy_packages.txt":
                    "wealth_1 = { political_strength = 0.03 goods = { popneed_a = 23 popneed_b = 90 } }\n"
                    "wealth_2 = { goods = { popneed_a = 27 popneed_b = 94.5 } }\nnot_a_level = { goods = { x = 1 } }\n",
                "game/common/defines/00_defines.txt":
                    "NGame = { WORKING_ADULT_RATIO_BASE = 9 }\nNPops = { WORKING_ADULT_RATIO_BASE = 0.25 OTHER = 1 }\n",
                # a mod changing one define keeps the others; a later block without the setting changes nothing
                "mod1/common/defines/zz_mod.txt": "NPops = { WORKING_ADULT_RATIO_BASE = 0.2 }\nNPops = { OTHER = 2 }\n",
                # a mod adding a need to a level
                "mod1/common/buy_packages/zz_mod.txt": "TRY_INJECT:wealth_2 = { goods = { popneed_c = 5 } }\n",
            }
            for rel, text in files.items():
                path = Path(tmp) / rel
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(text, encoding="utf-8")
            data = GameData.__new__(GameData)
            data.fs = FileSystem([Source(name, name, Path(tmp) / name, "mod") for name in ("game", "mod1")])
            data.warnings = []
            data._load_wages()
            self.assertEqual(data.buy_packages, {1: 113.0, 2: 126.5})
            self.assertEqual(data.working_adult_ratio, 0.2)


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

    def test_monuments(self):
        folder = Path(project.create_project(str(self.mods), "Wonders", "1.15.1"))
        tower = sample_monument(names={"english": "Test Tower"})
        palace = sample_monument(key="building_test_palace", history="FRA",
                                 location={"state": "STATE_ILE_DE_FRANCE", "x": None, "z": None, "locator": ""})
        palace["pmgs"] = [{"type": "ref", "key": "pmg_base_building_eiffel_tower"}]
        proj = project.load_project(folder)
        proj["monuments"] = [tower, palace]
        generated = project.save_project(folder, proj)
        for rel in ("common/buildings/zzz_wonders_monuments.txt", "gfx/map/map_object_data/zzz_wonders_monuments.txt",
                    "common/history/buildings/zzz_wonders_monuments.txt",
                    "localization/english/wonders_monuments_l_english.yml"):
            self.assertIn(rel, generated)
        locators = parse((folder / "gfx/map/map_object_data/zzz_wonders_monuments.txt").read_text(encoding="utf-8-sig"))
        self.assertEqual([e.value.get("name") for e in locators.entries], ["building_test_tower_locator"])
        position = locators.entries[0].value.get("instances").entries[0].value.get("position").items()
        self.assertEqual(position, ["4144.300000", "0.000000", "2720.460000"])
        history = parse((folder / "common/history/buildings/zzz_wonders_monuments.txt").read_text(encoding="utf-8-sig"))
        create = history.get("BUILDINGS").get("s:STATE_ILE_DE_FRANCE").get("region_state:FRA").get("create_building")
        self.assertEqual(create.get("building"), "building_test_palace")
        english = read_loc_file(folder / "localization/english/wonders_monuments_l_english.yml")["english"]
        self.assertEqual(english["building_test_tower"], "Test Tower")
        self.assertIn("building_test_tower_throughput_add", english)
        self.assertEqual(project.load_project(folder)["monuments"], [tower, palace])

    def test_laws(self):
        folder = Path(project.create_project(str(self.mods), "Rights", "1.15.1"))
        new = sample_law(names={"english": "Test Rights"}, descs={"english": "Workers get rights."})
        override = sample_law(key="law_no_workers_rights", mode="override", parent="",
                              names={"english": "No Rights"}, descs={"simp_chinese": "没有权利"})
        proj = project.load_project(folder)
        proj["laws"] = [new, override]
        generated = project.save_project(folder, proj)
        self.assertEqual(sorted(generated), [
            "common/laws/zzz_rights_laws.txt",
            "localization/english/replace/rights_laws_replace_l_english.yml",
            "localization/english/rights_laws_l_english.yml",
            "localization/simp_chinese/replace/rights_laws_replace_l_simp_chinese.yml"])
        laws = parse((folder / "common/laws/zzz_rights_laws.txt").read_text(encoding="utf-8-sig"))
        self.assertEqual([e.key for e in laws.entries], ["law_test_rights", "REPLACE_OR_CREATE:law_no_workers_rights"])
        english = read_loc_file(folder / "localization/english/rights_laws_l_english.yml")["english"]
        self.assertEqual(english, {"law_test_rights": "Test Rights", "law_test_rights_desc": "Workers get rights."})
        replaced = read_loc_file(folder / "localization/simp_chinese/replace/rights_laws_replace_l_simp_chinese.yml")
        self.assertEqual(replaced["simp_chinese"], {"law_no_workers_rights_desc": "没有权利"})
        self.assertEqual(project.load_project(folder)["laws"], [new, override])
        # starting laws saved by an earlier version are dropped
        proj["laws"] = [{**new, "start": {"all": True, "default": True}}]
        project.save_project(folder, proj)
        self.assertEqual(project.load_project(folder)["laws"], [new])

    def test_law_groups(self):
        folder = Path(project.create_project(str(self.mods), "Groups", "1.15.1"))
        group = sample_group(descs={"english": "A new group."})
        first = sample_law(key="law_first", group="lawgroup_test", parent="", names={"english": "First"})
        second = sample_law(key="law_second", group="lawgroup_test", parent="")
        proj = project.load_project(folder)
        proj["law_groups"], proj["laws"] = [group], [first, second]
        generated = project.save_project(folder, proj)
        self.assertIn("common/law_groups/zzz_groups_law_groups.txt", generated)
        groups = parse((folder / "common/law_groups/zzz_groups_law_groups.txt").read_text(encoding="utf-8-sig"))
        self.assertEqual([e.key for e in groups.entries], ["lawgroup_test"])
        # the laws keep the order they were made in: the first is the group's default
        laws = parse((folder / "common/laws/zzz_groups_laws.txt").read_text(encoding="utf-8-sig"))
        self.assertEqual([e.key for e in laws.entries], ["law_first", "law_second"])
        english = read_loc_file(folder / "localization/english/groups_laws_l_english.yml")["english"]
        self.assertEqual(english, {"lawgroup_test": "Test Group", "lawgroup_test_desc": "A new group.",
                                   "law_first": "First"})
        reopened = project.load_project(folder)
        self.assertEqual((reopened["law_groups"], reopened["laws"]), ([group], [first, second]))

    def test_goods(self):
        folder = Path(project.create_project(str(self.mods), "Market", "1.15.1"))
        new = sample_good()
        # only the needs of the game's good change: its definition and colour are not written
        moved = sample_good(key="automobiles", mode="override", names={}, definition=False, recolor=False, needs=[
            {"need": "popneed_free_movement", "weight": "3", "max_supply_share": "", "min_supply_share": ""}])
        prestige = goods.normalize_prestige_good({"key": "prestige_good_alloys", "names": {"english": "Fine Alloys"},
                                                  "base_good": "alloys", "texture": "gfx/p.dds"})
        proj = project.load_project(folder)
        proj["goods"], proj["prestige_goods"] = [new, moved], [prestige]
        base = {"needs": game_needs(), "templates": lambda lang: None}
        generated = project.save_project(folder, proj, goods_base=base)
        self.assertEqual(sorted(generated), [
            "common/goods/zzz_market_goods.txt",
            "common/modifier_type_definitions/zzz_market_goods_modifier_types.txt",
            "common/named_colors/zzz_market_goods_colors.txt",
            "common/pop_needs/zzz_market_pop_needs.txt",
            "common/prestige_goods/zzz_market_prestige_goods.txt",
            "gui/zzz_market_goods_texticons.gui",
            "localization/english/market_goods_l_english.yml"])
        written = parse((folder / "common/goods/zzz_market_goods.txt").read_text(encoding="utf-8-sig"))
        self.assertEqual([e.key for e in written.entries], ["alloys"])
        needs = parse((folder / "common/pop_needs/zzz_market_pop_needs.txt").read_text(encoding="utf-8-sig"))
        self.assertEqual([e.key for e in needs.entries], ["REPLACE_OR_CREATE:popneed_luxury_items",
                                                          "INJECT:popneed_free_movement"])
        english = read_loc_file(folder / "localization/english/market_goods_l_english.yml")["english"]
        self.assertEqual(english["alloys"], "Alloys")
        self.assertEqual(english["prestige_good_alloys"], "Fine Alloys")
        self.assertEqual(english["goods_input_alloys_mult"], "@alloys! Alloys input")
        self.assertNotIn("goods_output_automobiles_add", english)
        self.assertEqual(project.load_project(folder)["goods"], [new, moved])
        # without the game's needs, the needs file of the last save stays
        self.assertIn("common/pop_needs/zzz_market_pop_needs.txt", project.save_project(folder, proj))
        # a changed definition is written as an override
        proj["goods"] = [{**moved, "definition": True, "needs": []}]
        proj["prestige_goods"] = []
        generated = project.save_project(folder, proj, goods_base=base)
        written = parse((folder / "common/goods/zzz_market_goods.txt").read_text(encoding="utf-8-sig"))
        self.assertEqual([e.key for e in written.entries], ["REPLACE_OR_CREATE:automobiles"])
        self.assertNotIn("gui/zzz_market_goods_texticons.gui", generated)
        self.assertFalse((folder / "gui").exists())

    def test_country_starts(self):
        folder = Path(project.create_project(str(self.mods), "Starts", "1.15.1"))
        start = sample_start(names={"english": "Testland"}, adjs={"english": "Testish"},
                             ig_names={"ig_devout": {"english": "The Church"}}, definition={"tier": "empire"},
                             tax_level="high", laws={"lawgroup_labor_rights": "law_worker_protections"})
        everyone = countries.normalize_start({"mode": "all", "laws": {"lawgroup_labor_rights": "law_no_workers_rights"}})
        proj = project.load_project(folder)
        proj["country_starts"] = [start, everyone]
        generated = project.save_project(folder, proj, base=country_base())
        self.assertEqual(sorted(generated), [
            "common/country_definitions/zzz_starts_countries.txt",
            "common/history/countries/tst - test.txt",
            "common/history/global/zzz_starts_start.txt",
            "localization/english/replace/starts_countries_replace_l_english.yml",
            "localization/english/starts_countries_l_english.yml"])
        history = (folder / "common/history/countries/tst - test.txt").read_text(encoding="utf-8-sig")
        self.assertIn("set_tax_level = high", history)
        definitions = parse((folder / "common/country_definitions/zzz_starts_countries.txt").read_text(encoding="utf-8-sig"))
        self.assertEqual(definitions.get("REPLACE_OR_CREATE:TST").get("tier"), "empire")
        replaced = read_loc_file(folder / "localization/english/replace/starts_countries_replace_l_english.yml")
        self.assertEqual(replaced["english"], {"TST": "Testland", "TST_ADJ": "Testish"})
        names = read_loc_file(folder / "localization/english/starts_countries_l_english.yml")
        self.assertEqual(names["english"], {"starts_tst_ig_devout_name": "The Church"})
        self.assertEqual(project.load_project(folder)["country_starts"], [start, everyone])
        # saved without the game data, the copies stay as they were
        self.assertEqual(sorted(project.save_project(folder, project.load_project(folder))), sorted(generated))
        # without the changes the copies go, and the files in effect count again
        proj = project.load_project(folder)
        proj["country_starts"] = []
        self.assertEqual(project.save_project(folder, proj, base=country_base()), [])
        self.assertFalse((folder / "common").exists())

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
        "home.step.": ["start", "companies", "buildings", "modifiers", "states", "misc", "countries", "textures",
                       "localization", "done"],
        "home.stat.": ["companies", "buildings", "modifiers", "states", "mods"],
        "company.mode.": ["new", "override", "all"],
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
        "sidebar.category.": ["company", "factory", "monument", "law", "law_group", "good", "prestige_good",
                              "country_start"],
        "goods.flag.": ["tradeable", "local", "fixed_price", "pop_consumption_can_add_infrastructure"],
        "goods.flag_hint.": ["tradeable", "local", "fixed_price", "pop_consumption_can_add_infrastructure"],
        "goods.need_field.": ["weight", "max_supply_share", "min_supply_share"],
        "goods.view.": ["category", "needs"],
        "gdproblem.": ["key_missing", "key_invalid", "key_exists", "icon_missing", "cost", "category", "number", "need",
                       "need_value"],
        "pgproblem.": ["key_missing", "key_invalid", "key_exists", "base_good", "icon_missing", "prestige_bonus"],
        "country.tab.": ["country", "politics", "technology", "territory", "pops", "buildings", "diplomacy",
                         "characters", "other"],
        "country.part.": ["names", "color", "country_type", "tier", "cultures", "capital", "religion", "social_hierarchy",
                          "ig_names", "ruling", "tax_level", "taxed_goods", "tariffs", "institutions", "election",
                          "ruling_party", "tech_tier", "techs", "wealth", "literacy", "extra", "territory", "state_types",
                          "homelands", "claims", "pops", "buildings", "diplomacy", "treaties", "characters", "new"],
        "territory.mode.": ["province", "state", "claim"],
        "territory.mode_hint.": ["province", "state", "claim"],
        "territory.owner.": ["country", "building", "company"],
        "country.via.": ["explicit", "preset", "default", "all", "mine"],
        "country.via_hint.": ["explicit", "default", "all", "mine"],
        "country.wealth.": ["low", "medium", "high", "very_high"],
        "country.literacy.": ["very_low", "low", "baseline", "middling", "high", "very_high"],
        "cproblem.": ["election", "cultures", "country_unknown", "law", "country_type", "tier", "capital", "religion",
                      "social_hierarchy", "tax_level", "wealth", "literacy", "goods", "tariffs", "institutions", "techs",
                      "igs", "ruling_party", "provinces", "states", "pops", "buildings", "diplomacy", "treaty_date",
                      "treaty_country", "treaty_articles", "treaty_inputs", "character_template", "character_name",
                      "character_birth", "character_fields", "characters", "name_missing", "color_missing",
                      "key_exists", "flag", "capital_missing"],
        "flag.": ["x", "y", "sx", "sy", "rotation"],
        "flag.kind.": ["colored", "textured"],
        "relations.add.": ["pact", "relations", "truce", "obligation"],
        "relations.kind.": ["pact", "relations", "truce", "obligation"],
        "relations.kind_hint.": ["pact", "relations", "truce", "obligation"],
        "relations.role.": ["overlord", "subject", "actor", "target"],
        "relations.role_hint.": ["overlord", "subject", "actor", "target"],
        "relations.role_of.": ["ruler", "heir", "ig_leader", "politician", "general", "admiral", "agitator"],
        "relations.input.": ["quantity", "goods", "state", "strategic_region", "company", "building_type", "law_type",
                             "country"],
        "relations.trait.": ["personality", "skill", "condition"],
        "lgroup.block.": ["enable", "change_allowed_trigger"],
        "lgroup.block_hint.": ["enable", "change_allowed_trigger"],
        "gproblem.": ['key_missing', 'key_invalid', 'key_exists', 'category', 'opinion_impact', 'enactment_days', 'approval_mult', 'hierarchy'],
        "law.block.": ['is_visible', 'can_enact', 'on_enact', 'on_activate', 'on_deactivate', 'can_impose', 'ai_impose_chance', 'ai_will_do', 'ai_enact_weight_modifier'],
        "law.block_hint.": ['is_visible', 'can_enact', 'on_enact', 'on_activate', 'on_deactivate', 'can_impose', 'ai_impose_chance', 'ai_will_do', 'ai_enact_weight_modifier'],
        "law.list.": ['unlocking_technologies', 'unlocking_laws', 'requires_law_or', 'disallowing_laws'],
        "law.list_hint.": ['unlocking_technologies', 'unlocking_laws', 'requires_law_or', 'disallowing_laws'],
        "law.modifier_title.": ['modifier', 'institution_modifier', 'acceptance_modifier', 'tax_modifier_very_low', 'tax_modifier_low', 'tax_modifier_medium', 'tax_modifier_high', 'tax_modifier_very_high'],
        "law.stance.": ["strongly_approve", "approve", "neutral", "disapprove", "strongly_disapprove"],
        "lproblem.": ['key_missing', 'key_invalid', 'key_exists', 'group_missing', 'group_unknown', 'icon_missing', 'progressiveness', 'parent', 'modifier_value'],
        "factory.kind.": ["ref", "own", "override"],
        "factory.target.": ["building", "state", "country"],
        "factory.scale.": ["workforce_scaled", "level_scaled", "unscaled", "throughput_scaled"],
        "fblock.": ["potential", "possible"],
        "fset.label.": ['ai_nationalization_desire', 'ai_selection', 'ai_value', 'ai_weight', 'aliases', 'buildable', 'can_build_government', 'can_build_private', 'can_have_country_monopoly', 'can_switch_owner', 'category_building_type', 'city_gfx_interactions', 'city_lights_color_index', 'construction_modifier', 'disallowing_laws', 'disallowing_religions', 'downsizeable', 'economic_contribution', 'enable_air_connection', 'entity_constructed', 'entity_not_constructed', 'entity_under_construction', 'expandable', 'generates_residences', 'ignore_stateregion_max_level', 'investment_scores', 'is_hidden_when_unavailable', 'lens', 'levels_per_mesh', 'meshes', 'min_raise_to_hire', 'ownership_type', 'pollution_generation', 'profession_ratio', 'replacement_if_valid', 'required_input_goods', 'residence_points_per_level', 'scoring_override', 'should_auto_expand', 'slaves_role', 'statue', 'terrain_manipulator', 'timed_modifiers', 'unique', 'unlocking_company_categories', 'unlocking_geographic_regions', 'unlocking_global_technologies', 'unlocking_identity', 'unlocking_principles', 'unlocking_production_methods', 'unlocking_religions', 'valid_pop_culture_traits'],
        "fset.hint.": ['ai_nationalization_desire', 'ai_selection', 'ai_value', 'ai_weight', 'aliases', 'can_build_government', 'can_build_private', 'can_have_country_monopoly', 'can_switch_owner', 'category_building_type', 'city_gfx_interactions', 'city_lights_color_index', 'construction_modifier', 'economic_contribution', 'enable_air_connection', 'entity_constructed', 'entity_not_constructed', 'entity_under_construction', 'generates_residences', 'ignore_stateregion_max_level', 'investment_scores', 'is_hidden_when_unavailable', 'lens', 'levels_per_mesh', 'meshes', 'min_raise_to_hire', 'ownership_type', 'pollution_generation', 'profession_ratio', 'replacement_if_valid', 'required_input_goods', 'residence_points_per_level', 'scoring_override', 'should_auto_expand', 'slaves_role', 'statue', 'terrain_manipulator', 'timed_modifiers', 'unique', 'unlocking_global_technologies', 'unlocking_identity', 'unlocking_production_methods', 'valid_pop_culture_traits'],
        "fset.group.": ['conditions', 'economy', 'misc', 'other', 'unlock'],
        "fset.ownership.": ["self", "other", "no_ownership"],
        "fset.warn.": ['aliases', 'buildable', 'expandable', 'ownership_type', 'terrain_manipulator'],
        "fblock.title.": ["potential", "possible"],
        "picker.tech.": ["production", "military", "society", "other"],
        "picker.goods.": ["staple", "industrial", "luxury", "military"],
        "mappicker.hint.": ["states", "regions", "geographic_regions"],
        "mappicker.click.": ["states", "regions", "geographic_regions", "position"],
        "fproblem.": ["key_missing", "key_invalid", "key_exists", "group_missing", "group_invalid", "icon_missing",
                      "city_type_invalid", "construction_invalid", "braces", "pmgs_missing", "pmg_key_missing",
                      "pmg_key_invalid", "pmg_key_exists", "pmg_empty", "pm_key_missing", "pm_key_invalid",
                      "pm_key_exists", "pm_value", "history_state", "history_override"],
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
