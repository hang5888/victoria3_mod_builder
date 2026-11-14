"""Finding the game, the mod folders, the installed mods and launcher playsets."""
import json
import os
import re
import sqlite3
import sys
from pathlib import Path

STEAM_APP_ID = "529340"
PROJECT_FILE = "vic_mod_builder.json"  # marks a mod as created by this tool


# ---------------------------------------------------------------- folders

def _steam_libraries():
    roots = []
    if sys.platform == "win32":
        try:
            import winreg
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam") as key:
                roots.append(Path(winreg.QueryValueEx(key, "SteamPath")[0]))
        except OSError:
            pass
        roots.append(Path(r"C:\Program Files (x86)\Steam"))
    else:
        home = Path.home()
        roots += [home / ".steam/steam", home / ".local/share/Steam",
                  home / "Library/Application Support/Steam"]
    libraries = []
    for root in roots:
        vdf = root / "steamapps" / "libraryfolders.vdf"
        if not vdf.is_file():
            continue
        libraries.append(root)
        text = vdf.read_text(encoding="utf-8", errors="replace")
        for path in re.findall(r'"path"\s+"([^"]+)"', text):
            libraries.append(Path(path.replace("\\\\", "\\")))
    unique = []
    for lib in libraries:
        if lib not in unique:
            unique.append(lib)
    return unique


def _documents_dir():
    if sys.platform == "win32":
        try:
            import ctypes
            buf = ctypes.create_unicode_buffer(260)
            # CSIDL_PERSONAL: follows OneDrive / relocated Documents folders
            if ctypes.windll.shell32.SHGetFolderPathW(None, 5, None, 0, buf) == 0:
                return Path(buf.value)
        except (OSError, AttributeError):
            pass
        return Path.home() / "Documents"
    if sys.platform == "darwin":
        return Path.home() / "Documents"
    return Path.home() / ".local/share"


def detect_folders():
    """Best guess for the three folders; missing ones come back as ''."""
    found = {"game_dir": "", "workshop_dir": "", "local_mod_dir": ""}
    for lib in _steam_libraries():
        game = lib / "steamapps" / "common" / "Victoria 3" / "game"
        if not found["game_dir"] and (game / "common").is_dir():
            found["game_dir"] = str(game)
        workshop = lib / "steamapps" / "workshop" / "content" / STEAM_APP_ID
        if not found["workshop_dir"] and workshop.is_dir():
            found["workshop_dir"] = str(workshop)
    local = _documents_dir() / "Paradox Interactive" / "Victoria 3" / "mod"
    if local.is_dir():
        found["local_mod_dir"] = str(local)
    return found


def normalize_game_dir(path):
    """Accept either the install root or its `game` subfolder."""
    p = Path(path)
    if (p / "game" / "common").is_dir():
        return p / "game"
    return p


def validate_folders(settings):
    """Returns {folder: error code or None}."""
    result = {}
    game = settings.get("game_dir") or ""
    if not game:
        result["game_dir"] = "missing"
    elif not (Path(game) / "common" / "company_types").is_dir() or not (Path(game) / "localization").is_dir():
        result["game_dir"] = "not_game"
    else:
        result["game_dir"] = None
    workshop = settings.get("workshop_dir") or ""
    result["workshop_dir"] = None if (not workshop or Path(workshop).is_dir()) else "not_found"
    local = settings.get("local_mod_dir") or ""
    if not local:
        result["local_mod_dir"] = "missing"
    else:
        result["local_mod_dir"] = None if Path(local).is_dir() else "not_found"
    return result


def game_version(game_dir):
    """Version of the selected game install, e.g. ('1.15.1', '1.15.1 (Ivan-Chai)')."""
    try:
        path = Path(game_dir).parent / "launcher" / "launcher-settings.json"
        data = json.loads(path.read_text(encoding="utf-8-sig"))
        return data.get("rawVersion", ""), data.get("version", "")
    except (OSError, ValueError):
        return "", ""


# ---------------------------------------------------------------- mods

def read_metadata(mod_dir):
    mod_dir = Path(mod_dir)
    meta = {}
    try:
        meta = json.loads((mod_dir / ".metadata" / "metadata.json").read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        pass
    if not isinstance(meta, dict):
        meta = {}
    if not meta.get("name"):
        try:
            text = (mod_dir / "descriptor.mod").read_text(encoding="utf-8-sig", errors="replace")
            m = re.search(r'^name\s*=\s*"([^"]*)"', text, re.M)
            if m:
                meta["name"] = m.group(1)
        except OSError:
            pass
    return meta


def _mod_info(mod_dir, kind):
    meta = read_metadata(mod_dir)
    custom = meta.get("game_custom_data") if isinstance(meta.get("game_custom_data"), dict) else {}
    return {
        "id": f"{kind}:{mod_dir.name}",
        "name": str(meta.get("name") or mod_dir.name),
        "dir": str(mod_dir),
        "kind": kind,
        "version": str(meta.get("version") or ""),
        "game_version": str(meta.get("supported_game_version") or ""),
        "replace_paths": [str(p) for p in custom.get("replace_paths") or []],
        "has_companies": (mod_dir / "common" / "company_types").is_dir(),
        "builder": (mod_dir / PROJECT_FILE).is_file(),
    }


def discover_mods(workshop_dir, local_mod_dir):
    mods = []
    for folder, kind in ((workshop_dir, "workshop"), (local_mod_dir, "local")):
        if not folder or not Path(folder).is_dir():
            continue
        for child in sorted(Path(folder).iterdir(), key=lambda p: p.name.lower()):
            if child.is_dir():
                mods.append(_mod_info(child, kind))
    return mods


# ---------------------------------------------------------------- playsets

def _launcher_db(local_mod_dir):
    return Path(local_mod_dir).parent / "launcher-v2.sqlite"


def _connect(local_mod_dir):
    db = _launcher_db(local_mod_dir)
    if not db.is_file():
        return None
    return sqlite3.connect(db.as_uri() + "?mode=ro", uri=True)


def list_playsets(local_mod_dir):
    """Playsets saved by the game launcher."""
    try:
        con = _connect(local_mod_dir)
        if con is None:
            return []
        with con:
            rows = con.execute(
                "SELECT p.id, p.name, p.isActive, "
                "(SELECT COUNT(*) FROM playsets_mods pm WHERE pm.playsetId = p.id AND pm.enabled) "
                "FROM playsets p WHERE p.isRemoved = 0 ORDER BY p.isActive DESC, p.name"
            ).fetchall()
        con.close()
    except sqlite3.Error:
        return []
    return [{"id": r[0], "name": r[1], "active": bool(r[2]), "count": r[3]} for r in rows]


def playset_mod_ids(local_mod_dir, playset_id, mods):
    """Enabled mods of a playset, in load order, as ids from discover_mods()."""
    try:
        con = _connect(local_mod_dir)
        if con is None:
            return []
        with con:
            rows = con.execute(
                "SELECT m.dirPath, m.steamId FROM playsets_mods pm JOIN mods m ON m.id = pm.modId "
                "WHERE pm.playsetId = ? AND pm.enabled ORDER BY pm.position", (playset_id,)
            ).fetchall()
        con.close()
    except sqlite3.Error:
        return []
    by_dir = {os.path.normcase(os.path.normpath(m["dir"])): m["id"] for m in mods}
    by_steam = {m["id"].split(":", 1)[1]: m["id"] for m in mods if m["kind"] == "workshop"}
    ids = []
    for dir_path, steam_id in rows:
        mod_id = by_dir.get(os.path.normcase(os.path.normpath(dir_path or ""))) or by_steam.get(str(steam_id or ""))
        if mod_id and mod_id not in ids:
            ids.append(mod_id)
    return ids
