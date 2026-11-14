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
        "block.": ["prestige_goods_trigger", "potential", "attainable", "possible", "can_establish_in",
                   "ai_will_do", "ai_construction_targets", "ai_weight"],
        "problem.": ["key_missing", "key_invalid", "key_exists", "icon_missing", "background_missing",
                     "buildings_missing", "modifier_value", "braces"],
        "error.": ["offline", "server_error", "not_loaded", "no_project", "folders_invalid", "bad_request",
                   "not_found", "name_missing", "browse_unavailable", "bad_path", "unsupported_texture",
                   "forbidden"],
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
