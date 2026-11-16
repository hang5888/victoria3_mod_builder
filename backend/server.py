"""Local web server: serves the frontend and a JSON API for it."""
import base64
import binascii
import json
import mimetypes
import os
import struct
import subprocess
import sys
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import mods, project, textures
from .companies import normalize_company, validate_company
from .factories import normalize_factory, own_keys, validate_factory
from .gamedata import GameData, game_languages

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"
SETTINGS_FILE = ROOT / "settings.json"
DEFAULT_SETTINGS = {"game_dir": "", "workshop_dir": "", "local_mod_dir": "", "language": "english",
                    "enabled_mods": [], "project_dir": ""}


class ApiError(Exception):
    def __init__(self, code, status=400):
        super().__init__(code)
        self.code = code
        self.status = status


class App:
    """Everything the server keeps in memory between requests."""

    def __init__(self, settings_file=SETTINGS_FILE):
        self.lock = threading.RLock()
        self.settings_file = Path(settings_file)
        self.settings = dict(DEFAULT_SETTINGS)
        try:
            self.settings.update(json.loads(self.settings_file.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            pass
        self.data = None
        self.loaded_signature = None
        self.load_state = {"state": "idle", "step": "", "done": 0, "total": 1, "error": ""}
        self.payload_cache = {}
        self.texture_cache = {}

    def save_settings(self):
        self.settings_file.write_text(json.dumps(self.settings, ensure_ascii=False, indent=2), encoding="utf-8")

    # ------------------------------------------------------------ helpers

    def folders_ok(self):
        return not any(mods.validate_folders(self.settings).values())

    def all_mods(self):
        """Installed mods that can be used as data sources (the tool's own mods are projects instead)."""
        found = mods.discover_mods(self.settings["workshop_dir"], self.settings["local_mod_dir"])
        return [m for m in found if not m["builder"]]

    def enabled_mods(self):
        by_id = {m["id"]: m for m in self.all_mods()}
        return [by_id[i] for i in self.settings["enabled_mods"] if i in by_id]

    def signature(self):
        s = self.settings
        return json.dumps([s["game_dir"], s["workshop_dir"], s["local_mod_dir"], s["enabled_mods"]])

    def require_data(self):
        if self.data is None:
            raise ApiError("not_loaded", 409)
        return self.data

    def require_project(self):
        path = self.settings.get("project_dir") or ""
        if not path or not (Path(path) / mods.PROJECT_FILE).is_file():
            raise ApiError("no_project", 409)
        return path

    def save_project(self, path, proj, body=None):
        """Regenerate the mod's files; needs the game data for the texts copied from the game.

        `body.keep_images`: imported images an unsaved item in the editor uses, so they stay.
        """
        keep = (body or {}).get("keep_images") or []
        keep = [k for k in keep if isinstance(k, str)] if isinstance(keep, list) else []
        return project.save_project(path, proj, self.require_data().modifier_templates, keep)

    def project_image(self, rel):
        """An image imported into the current project (not part of the game data)."""
        try:
            return project.image_file(self.require_project(), rel)
        except (ApiError, OSError, ValueError):
            return None

    def project_info(self):
        try:
            path = self.require_project()
            return {"dir": path, "name": project.load_project(path)["name"]}
        except (ApiError, OSError, ValueError):
            return None

    # ------------------------------------------------------------ state

    def state(self):
        with self.lock:
            s = self.settings
            raw, full = mods.game_version(s["game_dir"]) if s["game_dir"] else ("", "")
            return {
                "settings": s,
                "folders": mods.validate_folders(s),
                "version": full or raw,
                "languages": game_languages(s["game_dir"]) if s["game_dir"] else [],
                "load": {**self.load_state,
                         "stale": self.data is not None and self.loaded_signature != self.signature(),
                         "summary": self.data.summary() if self.data else None},
                "project": self.project_info(),
            }

    # ------------------------------------------------------------ loading

    def start_load(self):
        with self.lock:
            if self.load_state["state"] == "loading":
                return
            if not self.folders_ok():
                raise ApiError("folders_invalid")
            self.load_state = {"state": "loading", "step": "start", "done": 0, "total": 1, "error": ""}
            signature = self.signature()
            game_dir = self.settings["game_dir"]
            enabled = self.enabled_mods()
        threading.Thread(target=self._load, args=(game_dir, enabled, signature), daemon=True).start()

    def _load(self, game_dir, enabled, signature):
        def progress(step, done, total):
            self.load_state = {"state": "loading", "step": step, "done": done, "total": total, "error": ""}

        try:
            data = GameData(game_dir, enabled, progress)
        except Exception as error:  # report any failure to the UI instead of dying silently
            traceback.print_exc()
            self.load_state = {"state": "error", "step": "", "done": 0, "total": 1, "error": str(error)}
            return
        with self.lock:
            self.data = data
            self.loaded_signature = signature
            self.payload_cache = {}
            self.texture_cache = {}
            self.load_state = {"state": "ready", "step": "done", "done": 1, "total": 1, "error": ""}

    def payload(self, language):
        data = self.require_data()
        with self.lock:
            if language not in self.payload_cache:
                body = json.dumps(data.payload(language), ensure_ascii=False).encode("utf-8")
                self.payload_cache = {language: body}  # keep one language in memory
            return self.payload_cache[language]

    def texture(self, rel, size):
        data = self.require_data()
        rel = rel.replace("\\", "/")
        if (".." in rel.split("/") or rel.startswith("/") or ":" in rel
                or not rel.lower().endswith((".dds", ".png", ".jpg", ".jpeg"))):
            raise ApiError("bad_path")
        key = (rel.lower(), size)
        if key in self.texture_cache:
            return self.texture_cache[key]
        path = data.fs.resolve(rel)
        if path is None:
            path = self.project_image(rel)
        if path is None:
            raise ApiError("not_found", 404)
        try:
            raw = path.read_bytes()
            image = textures.to_browser_image(raw, size)
        except (OSError, struct.error):
            raise ApiError("not_found", 404)
        except textures.UnsupportedTexture:
            raise ApiError("unsupported_texture", 415)
        if image[0] is not raw:  # converted thumbnails are worth keeping; passed-through files are not
            self.texture_cache[key] = image
        return image


def browse_folder(initial):
    """Open a native folder dialog. Runs in a child process: Tk must own its main thread."""
    code = ("import sys, tkinter as tk\nfrom tkinter import filedialog\n"
            "root = tk.Tk(); root.withdraw(); root.attributes('-topmost', True)\n"
            "print(filedialog.askdirectory(initialdir=sys.argv[1] or None, parent=root))")
    env = dict(os.environ, PYTHONIOENCODING="utf-8")
    try:
        result = subprocess.run([sys.executable, "-c", code, initial], capture_output=True, text=True,
                                encoding="utf-8", env=env, timeout=600)
    except (OSError, subprocess.TimeoutExpired):
        raise ApiError("browse_unavailable", 500)
    if result.returncode != 0:
        raise ApiError("browse_unavailable", 500)
    return result.stdout.strip()


def open_folder(path):
    """Show a folder in the system's file manager (only ever the current project's folder)."""
    try:
        if sys.platform == "win32":
            os.startfile(path)  # noqa: S606 - a folder we created, not user input
        else:
            subprocess.Popen(["open" if sys.platform == "darwin" else "xdg-open", path])
    except OSError:
        raise ApiError("open_folder_failed", 500)


# -------------------------------------------------------------------- routes

def api_get(app, path, query):
    if path == "/api/state":
        return app.state()
    if path == "/api/mods":
        with app.lock:
            return {"mods": app.all_mods(), "enabled": app.settings["enabled_mods"],
                    "playsets": mods.list_playsets(app.settings["local_mod_dir"])}
    if path == "/api/projects":
        return {"projects": project.list_projects(app.settings["local_mod_dir"])}
    if path == "/api/project":
        return project.load_project(app.require_project())
    if path == "/api/map":
        return app.require_data().map_payload()
    raise ApiError("not_found", 404)


def api_post(app, path, body):
    s = app.settings
    if path == "/api/detect":
        return mods.detect_folders()
    if path == "/api/browse":
        return {"path": browse_folder(str(body.get("initial") or ""))}
    if path == "/api/settings":
        with app.lock:
            for key in ("game_dir", "workshop_dir", "local_mod_dir"):
                if key in body:
                    value = str(body[key]).strip().strip('"')
                    if key == "game_dir" and value:
                        value = str(mods.normalize_game_dir(value))
                    s[key] = value
            if "language" in body:
                s["language"] = str(body["language"])
            app.save_settings()
        return app.state()
    if path == "/api/mods/enabled":
        with app.lock:
            known = {m["id"] for m in app.all_mods()}
            s["enabled_mods"] = [i for i in body.get("enabled", []) if i in known]
            app.save_settings()
        return app.state()
    if path == "/api/playsets/import":
        with app.lock:
            ids = mods.playset_mod_ids(s["local_mod_dir"], str(body.get("id")), app.all_mods())
            s["enabled_mods"] = ids
            app.save_settings()
        return {"enabled": ids}
    if path == "/api/load":
        app.start_load()
        return app.state()
    if path == "/api/projects":
        name = str(body.get("name") or "").strip()
        if not name:
            raise ApiError("name_missing")
        if not app.folders_ok():
            raise ApiError("folders_invalid")
        with app.lock:
            raw, _full = mods.game_version(s["game_dir"])
            s["project_dir"] = project.create_project(s["local_mod_dir"], name, raw)
            app.save_settings()
        return app.state()
    if path == "/api/projects/open":
        target = str(body.get("dir") or "")
        allowed = {p["dir"] for p in project.list_projects(s["local_mod_dir"])}
        if target not in allowed:
            raise ApiError("not_found", 404)
        with app.lock:
            s["project_dir"] = target
            app.save_settings()
        return app.state()
    if path == "/api/project/save":
        # Regenerate every file of the mod from the project file, without changing anything.
        with app.lock:
            path_ = app.require_project()
            proj = project.load_project(path_)
            generated = app.save_project(path_, proj, body)
            return {"project": proj, "generated": generated, "dir": path_}
    if path == "/api/project/open_folder":
        open_folder(app.require_project())
        return {}
    if path == "/api/project/company":
        return save_company(app, body)
    if path == "/api/project/company/delete":
        with app.lock:
            path_ = app.require_project()
            proj = project.load_project(path_)
            proj["companies"] = [c for c in proj["companies"] if c["key"] != body.get("key")]
            app.save_project(path_, proj, body)
            return proj
    if path == "/api/project/factory":
        return save_factory(app, body)
    if path == "/api/project/factory/delete":
        with app.lock:
            path_ = app.require_project()
            proj = project.load_project(path_)
            proj["factories"] = [f for f in proj["factories"] if f["key"] != body.get("key")]
            app.save_project(path_, proj, body)
            return proj
    if path == "/api/project/image":
        try:
            data = base64.b64decode(str(body.get("data") or ""), validate=True)
            with app.lock:
                image = project.add_image(app.require_project(), str(body.get("kind") or ""),
                                          str(body.get("name") or ""), data)
                return {"image": image, "project": project.load_project(app.require_project())}
        except (ValueError, binascii.Error) as error:
            raise ApiError("image_" + (str(error) if str(error) in ("kind", "too_large", "format") else "format"))
    raise ApiError("not_found", 404)


def save_company(app, body):
    """Add or update one company in the current project and regenerate the mod files."""
    if not isinstance(body.get("company"), dict):
        raise ApiError("bad_request")
    try:
        clean = normalize_company(body["company"])
    except ValueError:
        raise ApiError("bad_request")
    original_key = body.get("original_key") or clean["key"]
    with app.lock:
        data = app.require_data()
        path = app.require_project()
        proj = project.load_project(path)
        others = [c for c in proj["companies"] if c["key"] != original_key]
        taken = set(data.companies) | {c["key"] for c in others}
        errors = validate_company(clean, taken)
        if clean["mode"] == "override" and clean["key"] in {c["key"] for c in others}:
            errors.append("key_exists")
        if errors:
            return {"errors": errors}
        index = next((i for i, c in enumerate(proj["companies"]) if c["key"] == original_key), None)
        if index is None:
            proj["companies"].append(clean)
        else:
            proj["companies"][index] = clean
        generated = app.save_project(path, proj, body)
        return {"errors": [], "project": proj, "generated": generated, "dir": path}


def save_factory(app, body):
    """Add or update one factory in the current project and regenerate the mod files."""
    if not isinstance(body.get("factory"), dict):
        raise ApiError("bad_request")
    try:
        clean = normalize_factory(body["factory"])
    except (ValueError, AttributeError):
        raise ApiError("bad_request")
    original_key = body.get("original_key") or clean["key"]
    with app.lock:
        data = app.require_data()
        path = app.require_project()
        proj = project.load_project(path)
        others = [f for f in proj["factories"] if f["key"] != original_key]
        game = {"buildings": set(data.factories), "pmgs": set(data.pmgs), "pms": set(data.pms)}
        errors = validate_factory(clean, game, own_keys(others))
        if errors:
            return {"errors": errors}
        index = next((i for i, f in enumerate(proj["factories"]) if f["key"] == original_key), None)
        if index is None:
            proj["factories"].append(clean)
        else:
            proj["factories"][index] = clean
        generated = app.save_project(path, proj, body)
        return {"errors": [], "project": proj, "generated": generated, "dir": path}


class Handler(BaseHTTPRequestHandler):
    app = None
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass  # keep the console quiet; errors are printed where they happen

    def _send(self, status, body, content_type, cache=False):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "max-age=86400" if cache else "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, value, status=200):
        body = value if isinstance(value, bytes) else json.dumps(value, ensure_ascii=False).encode("utf-8")
        self._send(status, body, "application/json; charset=utf-8")

    def _local_request(self):
        """Refuse requests that reach this server under another host name (DNS rebinding)."""
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0]
        return host in ("127.0.0.1", "localhost")

    def _handle(self, func):
        if not self._local_request():
            return self._json({"error": "forbidden"}, 403)
        try:
            func()
        except ApiError as error:
            self._json({"error": error.code}, error.status)
        except (BrokenPipeError, ConnectionError):
            pass
        except Exception as error:
            traceback.print_exc()
            self._json({"error": "server_error", "detail": str(error)}, 500)

    def do_GET(self):
        self._handle(self._get)

    def do_POST(self):
        self._handle(self._post)

    def _get(self):
        url = urlparse(self.path)
        query = {k: v[0] for k, v in parse_qs(url.query).items()}
        app = self.app
        if url.path == "/api/data":
            return self._json(app.payload(query.get("lang") or "english"))
        if url.path == "/api/texture":
            try:
                size = min(1024, max(16, int(query.get("size") or 64)))
            except ValueError:
                raise ApiError("bad_request")
            image, content_type = app.texture(query.get("path") or "", size)
            return self._send(200, image, content_type, cache=True)
        if url.path == "/api/mapimage":
            path = app.require_data().fs.resolve("map_data/provinces.png")
            if path is None:
                raise ApiError("not_found", 404)
            return self._send(200, path.read_bytes(), "image/png")
        if url.path.startswith("/api/"):
            return self._json(api_get(app, url.path, query))
        self._static(url.path)

    def _post(self):
        # Requiring JSON keeps other web pages from posting here with a plain form.
        if "application/json" not in (self.headers.get("Content-Type") or ""):
            raise ApiError("bad_request")
        length = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            raise ApiError("bad_request")
        self._json(api_post(self.app, urlparse(self.path).path, body if isinstance(body, dict) else {}))

    def _static(self, url_path):
        rel = "index.html" if url_path in ("", "/") else url_path.lstrip("/")
        path = (FRONTEND / rel).resolve()
        if FRONTEND.resolve() not in path.parents or not path.is_file():
            return self._send(404, b"Not found", "text/plain")
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if path.suffix == ".js":
            content_type = "text/javascript"
        if content_type.startswith("text/") or content_type == "application/json":
            content_type += "; charset=utf-8"
        self._send(200, path.read_bytes(), content_type)


def make_server(port, settings_file=SETTINGS_FILE):
    """Bind to the first free port starting at `port`. Local connections only."""
    Handler.app = App(settings_file)
    last_error = None
    for candidate in range(port, port + 20):
        try:
            return ThreadingHTTPServer(("127.0.0.1", candidate), Handler)
        except OSError as error:
            last_error = error
    raise last_error
