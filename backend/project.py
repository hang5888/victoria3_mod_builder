"""Mods created by this tool: the project file and the generated game files.

The project file is the source of truth. Every save regenerates the game files
from it, and only files this tool generated are ever written or deleted.
"""
import hashlib
import json
import re
import shutil
from pathlib import Path

from .companies import LANGUAGE_PATTERN, company_to_script, empty_company
from .countries import definition_script, fill_start, global_laws_script, start_languages, start_texts, write_starts
from .factories import (factory_to_script, fill_factory, modifier_texts, own_pmgs, own_pms, pm_to_script,
                        pmg_to_script)
from .laws import fill_law, fill_law_group, law_group_to_script, law_texts, law_to_script
from .localization import write_loc_file
from .monuments import fill_monument, history_script, locators_script, monument_to_script
from .mods import PROJECT_FILE, discover_mods

FORMAT = 1
# Imported images wait here until a save packs the ones in use into the mod's gfx folder.
IMAGE_STAGING = ".vmb_images"
# What each image field expects: kind -> (width, height, how a different shape is fitted).
# The browser resizes PNG imports to these; DDS files are kept as they are.
IMAGE_KINDS = {
    "company_icon": (256, 256, "contain"),
    "company_background": (1027, 496, "cover"),
    "building_icon": (256, 256, "contain"),
    "building_background": (652, 256, "cover"),
    "pmg_icon": (120, 120, "contain"),
    "pm_icon": (104, 104, "contain"),
    "law_icon": (302, 302, "contain"),
}
MAX_IMAGE_BYTES = 20 * 1024 * 1024
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def _slug(name):
    slug = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
    return slug or "vmb_mod"


def list_projects(local_mod_dir):
    return [{"dir": m["dir"], "name": m["name"]} for m in discover_mods("", local_mod_dir) if m["builder"]]


def create_project(local_mod_dir, name, game_version):
    """Create a new mod folder with launcher metadata and an empty project file."""
    base = Path(local_mod_dir)
    slug = _slug(name)
    folder, n = base / slug, 2
    while folder.exists():
        folder = base / f"{slug}_{n}"
        n += 1
    (folder / ".metadata").mkdir(parents=True)
    parts = game_version.split(".")
    supported = f"{parts[0]}.{parts[1]}.*" if len(parts) >= 2 else ""
    metadata = {
        "name": name,
        "id": folder.name,
        "version": "1.0",
        "supported_game_version": supported,
        "short_description": "",
        "tags": [],
        "relationships": [],
        "game_custom_data": {"multiplayer_synchronized": True},
    }
    (folder / ".metadata" / "metadata.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    project = {"tool": "vic-mod-builder", "format": FORMAT, "name": name, "slug": folder.name,
               "companies": [], "factories": [], "monuments": [], "laws": [], "law_groups": [], "country_starts": [],
               "images": [], "generated_files": []}
    save_project(folder, project)
    return str(folder)


def load_project(project_dir):
    path = Path(project_dir) / PROJECT_FILE
    project = json.loads(path.read_text(encoding="utf-8"))
    if project.get("tool") != "vic-mod-builder":
        raise ValueError("not a Vic Mod Builder project")
    project["slug"] = _slug(str(project.get("slug") or Path(project_dir).name))
    project.setdefault("generated_files", [])
    project["images"] = [i for i in project.get("images", []) if isinstance(i, dict) and _image_ok(i)]
    # Fill in fields added by later versions of the tool.
    project["companies"] = [{**empty_company(), **c, "blocks": {**empty_company()["blocks"], **c.get("blocks", {})}}
                            for c in project.get("companies", [])]
    project["factories"] = [fill_factory(f) for f in project.get("factories", [])]
    project["monuments"] = [fill_monument(m) for m in project.get("monuments", [])]
    project["laws"] = [fill_law(law) for law in project.get("laws", [])]
    project["law_groups"] = [fill_law_group(group) for group in project.get("law_groups", [])]
    project["country_starts"] = [fill_start(start) for start in project.get("country_starts", [])
                                 if isinstance(start, dict)]
    return project


def _write_script(root, rel, definitions, generated):
    """One script file from the given definitions; nothing when there are none."""
    if not definitions:
        return
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8-sig", newline="\n") as f:
        f.write("\n\n".join(definitions) + "\n")
    generated.append(rel)


def _write_names(root, slug, kind, items, generated, extra=lambda item, lang: {}):
    """Localization of named items: one file per language, only for languages the user filled in.

    Names of overridden items go under replace/ so they win over the original.
    `extra(item, lang)` adds more texts for a new item that has a name in that language.
    """
    languages = {lang for item in items for lang, name in item.get("names", {}).items()
                 if name and LANGUAGE_PATTERN.match(lang)}
    for lang in sorted(languages):
        new, replaced = {}, {}
        for item in items:
            name = item.get("names", {}).get(lang)
            if not name:
                continue
            if item.get("mode") == "override":
                replaced[item["key"]] = name
            else:
                new[item["key"]] = name
                new.update(extra(item, lang))
        if new:
            rel = f"localization/{lang}/{slug}_{kind}_l_{lang}.yml"
            write_loc_file(root / rel, lang, new)
            generated.append(rel)
        if replaced:
            rel = f"localization/{lang}/replace/{slug}_{kind}_replace_l_{lang}.yml"
            write_loc_file(root / rel, lang, replaced)
            generated.append(rel)


def _write_texts(root, slug, kind, items, texts, generated):
    """Localization where each item has several texts: `texts(item, lang)` -> {key: text}.

    As in _write_names, the texts of overridden items go under replace/.
    """
    languages = {lang for item in items for field in ("names", "descs") for lang, text in item.get(field, {}).items()
                 if text and LANGUAGE_PATTERN.match(lang)}
    for lang in sorted(languages):
        new, replaced = {}, {}
        for item in items:
            (replaced if item.get("mode") == "override" else new).update(texts(item, lang))
        for entries, rel in ((new, f"localization/{lang}/{slug}_{kind}_l_{lang}.yml"),
                             (replaced, f"localization/{lang}/replace/{slug}_{kind}_replace_l_{lang}.yml")):
            if entries:
                write_loc_file(root / rel, lang, entries)
                generated.append(rel)


def _image_ok(image):
    """An image entry of the project file that can be used as a path (the file may be tampered with)."""
    return (image.get("kind") in IMAGE_KINDS and re.fullmatch(r"[a-z0-9_]+\.(png|dds)", str(image.get("file", "")))
            and re.fullmatch(r"gfx/interface/icons/[a-z0-9_]+/[a-z0-9_]+\.(png|dds)", str(image.get("path", ""))))


def image_slug(name):
    return re.sub(r"[^a-z0-9]+", "_", str(name).lower()).strip("_")[:40] or "image"


def add_image(project_dir, kind, name, data):
    """Keep an imported image (PNG or DDS bytes) in the project. Returns its entry.

    It is written to the staging folder and listed in the project file; the next
    save packs it into the mod when something uses it, or drops it.
    """
    if kind not in IMAGE_KINDS:
        raise ValueError("kind")
    if len(data) > MAX_IMAGE_BYTES:
        raise ValueError("too_large")
    if data[:8] == PNG_SIGNATURE:
        suffix = "png"
    elif data[:4] == b"DDS ":
        suffix = "dds"
    else:
        raise ValueError("format")
    root = Path(project_dir)
    project = load_project(root)
    # the content hash keeps names unique, so a cached picture is never a different image
    file = f"{kind}_{image_slug(Path(str(name)).stem)}_{hashlib.sha1(data).hexdigest()[:8]}.{suffix}"
    image = {"kind": kind, "file": file, "path": f"gfx/interface/icons/{project['slug']}_images/{file}"}
    staging = root / IMAGE_STAGING
    staging.mkdir(exist_ok=True)
    (staging / file).write_bytes(data)
    if not any(i["path"] == image["path"] for i in project["images"]):
        project["images"].append(image)
    (root / PROJECT_FILE).write_text(json.dumps(project, ensure_ascii=False, indent=2), encoding="utf-8")
    return image


def image_file(project_dir, path):
    """The file on disk of an imported image, by its game path; None when it is not one."""
    root = Path(project_dir)
    for image in load_project(root)["images"]:
        if image["path"] == path:
            for candidate in (root / IMAGE_STAGING / image["file"], root / image["path"]):
                if candidate.is_file():
                    return candidate
    return None


def used_images(project):
    """Game paths of the images the saved items use."""
    used = set()
    for company in project["companies"]:
        used.update((company.get("icon"), company.get("background")))
    buildings = [*project.get("factories", []), *project.get("monuments", [])]
    for building in buildings:
        used.update((building.get("icon"), building.get("background")))
    used.update(item.get("texture") for item in [*own_pmgs(buildings), *own_pms(buildings)])
    used.update(law.get("icon") for law in project.get("laws", []))
    return used


def _start_file(rel, slug):
    """True for the files the country starts write."""
    return rel.startswith(("common/history/", "common/country_definitions/")) or f"/{slug}_countries_" in rel


def _write_country_starts(root, slug, starts, base, generated):
    """Country starts: the overridden definitions, their names, the history files they change (copies of
    the files in effect, see countries.write_starts) and the laws every country starts with."""
    countries = [s for s in starts if s["mode"] == "override"]
    everyone = next((s for s in starts if s["mode"] == "all"), None)
    definitions = []
    for start in countries:
        raw = base.definition(start["key"]) if start["definition"] else None
        if raw is not None:
            definitions.append(definition_script(start["key"], raw, start["definition"]))
    _write_script(root, f"common/country_definitions/zzz_{slug}_countries.txt", definitions, generated)
    for rel, text in sorted(write_starts(countries, base, slug).items()):
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w", encoding="utf-8-sig", newline="\n") as f:
            f.write(text if text.endswith("\n") else text + "\n")
        generated.append(rel)
    script = global_laws_script(everyone["laws"], countries) if everyone else None
    _write_script(root, f"common/history/global/zzz_{slug}_start.txt", [script] if script else [], generated)
    for lang in sorted({lang for start in countries for lang in start_languages(start)}):
        if not LANGUAGE_PATTERN.match(lang):
            continue
        replaced, new = {}, {}
        for start in countries:
            texts = start_texts(start, lang, slug)
            replaced.update(texts[0])
            new.update(texts[1])
        for entries, rel in ((new, f"localization/{lang}/{slug}_countries_l_{lang}.yml"),
                             (replaced, f"localization/{lang}/replace/{slug}_countries_replace_l_{lang}.yml")):
            if entries:
                write_loc_file(root / rel, lang, entries)
                generated.append(rel)


def save_project(project_dir, project, modifier_templates=lambda lang: None, keep_images=(), base=None):
    """Write the project file and regenerate the game files from it.

    Imported images in use are packed into the mod; unused ones are deleted,
    except `keep_images` (paths an unsaved item in the editor uses).

    `modifier_templates(lang)`: the game's texts for a building's modifiers in
    that language (see factories.modifier_texts), or None for the built-in English.
    `base`: the files in effect the country starts are written from (gamedata.StartBase); without it
    the country starts are not written.
    """
    root = Path(project_dir)
    slug = project["slug"]
    generated = []

    # "zzz" keeps the files last in their folder's load order.
    companies = project["companies"]
    _write_script(root, f"common/company_types/zzz_{slug}_companies.txt",
                  [company_to_script(c) for c in companies], generated)
    _write_names(root, slug, "companies", companies, generated)

    factories = project.get("factories", [])
    groups, methods = own_pmgs(factories), own_pms(factories)
    _write_script(root, f"common/buildings/zzz_{slug}_buildings.txt",
                  [factory_to_script(f) for f in factories], generated)
    _write_script(root, f"common/production_method_groups/zzz_{slug}_buildings.txt",
                  [pmg_to_script(g) for g in groups], generated)
    _write_script(root, f"common/production_methods/zzz_{slug}_buildings.txt",
                  [pm_to_script(m) for m in methods], generated)
    building_keys = {f["key"] for f in factories}
    _write_names(root, slug, "buildings", [*factories, *groups, *methods], generated,
                 lambda item, lang: (modifier_texts(item, lang, modifier_templates(lang))
                                     if item["key"] in building_keys and "pmgs" in item else {}))

    monuments = project.get("monuments", [])
    groups, methods = own_pmgs(monuments), own_pms(monuments)
    _write_script(root, f"common/buildings/zzz_{slug}_monuments.txt",
                  [monument_to_script(m, slug) for m in monuments], generated)
    _write_script(root, f"common/production_method_groups/zzz_{slug}_monuments.txt",
                  [pmg_to_script(g) for g in groups], generated)
    _write_script(root, f"common/production_methods/zzz_{slug}_monuments.txt",
                  [pm_to_script(m) for m in methods], generated)
    # map positions of the monuments' models, and the ones that exist when the game starts
    _write_script(root, f"gfx/map/map_object_data/zzz_{slug}_monuments.txt", locators_script(monuments, slug), generated)
    _write_script(root, f"common/history/buildings/zzz_{slug}_monuments.txt", history_script(monuments), generated)
    monument_keys = {m["key"] for m in monuments}
    _write_names(root, slug, "monuments", [*monuments, *groups, *methods], generated,
                 lambda item, lang: (modifier_texts(item, lang, modifier_templates(lang))
                                     if item["key"] in monument_keys and "pmgs" in item else {}))

    # Laws in the order they were made: in a new group the first one is the default.
    laws, law_groups = project.get("laws", []), project.get("law_groups", [])
    _write_script(root, f"common/law_groups/zzz_{slug}_law_groups.txt",
                  [law_group_to_script(group) for group in law_groups], generated)
    _write_script(root, f"common/laws/zzz_{slug}_laws.txt", [law_to_script(law) for law in laws], generated)
    _write_texts(root, slug, "laws", [*law_groups, *laws], law_texts, generated)  # key and key_desc for both

    starts = project.get("country_starts", [])
    if base is not None:
        _write_country_starts(root, slug, starts, base, generated)
    elif starts:
        # without the game data the copies cannot be made again: keep the ones written last time
        written = set(generated)
        generated += [rel for rel in project.get("generated_files", []) if rel not in written and _start_file(rel, slug)]

    # Imported images: pack the used ones, drop the others.
    used = used_images(project)
    kept = []
    for image in project.get("images", []):
        staged = root / IMAGE_STAGING / image["file"]
        if image["path"] in used and staged.is_file():
            target = root / image["path"]
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(staged, target)
            generated.append(image["path"])
            kept.append(image)
        elif image["path"] in keep_images and staged.is_file():
            kept.append(image)
        elif staged.is_file():
            staged.unlink()
    project["images"] = kept

    for rel in project.get("generated_files", []):
        if rel not in generated:
            stale = root / rel
            if root.resolve() not in stale.resolve().parents:
                continue  # never touch anything outside the mod folder
            if stale.is_file():
                stale.unlink()
            for parent in stale.parents:  # drop folders this left empty
                if parent == root or not parent.is_dir() or any(parent.iterdir()):
                    break
                parent.rmdir()
    project["generated_files"] = generated
    (root / PROJECT_FILE).write_text(json.dumps(project, ensure_ascii=False, indent=2), encoding="utf-8")
    return generated
