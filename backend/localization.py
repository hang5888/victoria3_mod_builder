"""Reading and writing Paradox localization (.yml) files."""
import re

_HEADER = re.compile(r"^\s*l_(\w+)\s*:\s*(#.*)?$")
_LINE = re.compile(r'^\s*([\w.\-\']+):\d*\s*"(.*)"')
_REF = re.compile(r"\$([\w.\-']+)\$")
_CONCEPT = re.compile(r"\[(concept_\w+)\]")
_FUNCTION = re.compile(r"\[[^\]]*\]")
_FORMAT_OPEN = re.compile(r"#[\w;]+ ?")
_ICON = re.compile(r"@\w+!")


def read_loc_text(text):
    """Parse the text of one .yml file into {language: {key: value}}."""
    result = {}
    current = None
    for line in text.splitlines():
        m = _LINE.match(line)
        if m:
            if current is not None:
                current[m.group(1)] = m.group(2).replace('\\"', '"')
            continue
        h = _HEADER.match(line)
        if h:
            current = result.setdefault(h.group(1), {})
    return result


def read_loc_file(path):
    with open(path, encoding="utf-8-sig", errors="replace") as f:
        return read_loc_text(f.read())


def write_loc_file(path, language, entries):
    """Write {key: value} as a localization file. The game requires a UTF-8 BOM."""
    lines = [f"l_{language}:"]
    for key, value in entries.items():
        escaped = value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")
        lines.append(f' {key}: "{escaped}"')
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8-sig", newline="\n") as f:
        f.write("\n".join(lines) + "\n")


class Localization:
    """Lookup table for one language, with a fallback language behind it."""

    def __init__(self, entries, fallback=None):
        self.entries = entries
        self.fallback = fallback

    def raw(self, key):
        value = self.entries.get(key)
        if value is None and self.fallback is not None:
            return self.fallback.raw(key)
        return value

    def name(self, key, default=None):
        """Display text for a key: references resolved and markup removed."""
        value = self.raw(key)
        if value is None:
            return key if default is None else default
        text = self.clean(value)
        if not text and self.fallback is not None:
            # only script (as a mod's [GetCustom(...)] name): the fallback language's text says more
            return self.fallback.name(key, default)
        return text or key

    def clean(self, text, depth=0):
        if depth < 4:
            text = _REF.sub(lambda m: self._resolve(m.group(1), m.group(0), depth), text)
            text = _CONCEPT.sub(lambda m: self._resolve(m.group(1), "", depth), text)
        text = _FUNCTION.sub("", text)
        text = _FORMAT_OPEN.sub("", text).replace("#!", "")
        text = _ICON.sub("", text)
        return " ".join(text.split())

    def _resolve(self, key, default, depth):
        value = self.raw(key)
        return default if value is None else self.clean(value, depth + 1)
