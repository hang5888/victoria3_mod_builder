"""Mods created by this tool: the project file and the generated game files.

The project file is the source of truth. Every save regenerates the game files
from it, and only files this tool generated are ever written or deleted.
"""
import json
import re
from pathlib import Path

from .companies import LANGUAGE_PATTERN, company_to_script, empty_company
from .factories import (factory_to_script, fill_factory, modifier_texts, own_pmgs, own_pms, pm_to_script,
                        pmg_to_script)
from .localization import write_loc_file
from .mods import PROJECT_FILE, discover_mods

FORMAT = 1


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
               "companies": [], "factories": [], "generated_files": []}
    save_project(folder, project)
    return str(folder)


def load_project(project_dir):
    path = Path(project_dir) / PROJECT_FILE
    project = json.loads(path.read_text(encoding="utf-8"))
    if project.get("tool") != "vic-mod-builder":
        raise ValueError("not a Vic Mod Builder project")
    project["slug"] = _slug(str(project.get("slug") or Path(project_dir).name))
    project.setdefault("generated_files", [])
    # Fill in fields added by later versions of the tool.
    project["companies"] = [{**empty_company(), **c, "blocks": {**empty_company()["blocks"], **c.get("blocks", {})}}
                            for c in project.get("companies", [])]
    project["factories"] = [fill_factory(f) for f in project.get("factories", [])]
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


def save_project(project_dir, project, modifier_templates=lambda lang: None):
    """Write the project file and regenerate the game files from it.

    `modifier_templates(lang)`: the game's texts for a building's modifiers in
    that language (see factories.modifier_texts), or None for the built-in English.
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
