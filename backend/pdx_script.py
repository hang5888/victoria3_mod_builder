"""Parser for Paradox script files (the .txt format under common/ and map_data/).

The parser is tolerant: mod files are often slightly malformed, and the game
itself skips over most errors, so stray tokens are ignored instead of raising.
"""
import re

_TOKEN = re.compile(
    r"""
    (?P<skip>\s+|\#[^\n]*)
  | (?P<string>"(?:[^"\\]|\\.)*")
  | (?P<open>\{)
  | (?P<close>\})
  | (?P<op>\?=|==|!=|>=|<=|=|>|<)
  | (?P<word>@\[[^\]]*\]|[^\s{}=<>!?\#"]+)
  | (?P<other>.)
    """,
    re.X,
)

# Database-object prefixes that control how a definition combines with an
# earlier definition of the same key.
REPLACE_PREFIXES = {"REPLACE", "TRY_REPLACE", "REPLACE_OR_CREATE"}
INJECT_PREFIXES = {"INJECT", "TRY_INJECT", "INJECT_OR_CREATE"}
PREFIXES = REPLACE_PREFIXES | INJECT_PREFIXES

# `color = hsv{ 0.5 0.5 0.5 }` style values: a word directly followed by a block.
_BLOCK_TAGS = {"hsv", "hsv360", "rgb", "hex", "list", "range"}


class Entry:
    """One `key op value` statement, or a bare item inside a list block."""

    __slots__ = ("key", "op", "value", "start", "end", "text")

    def __init__(self, key, op, value, start, end, text):
        self.key = key  # None for bare list items
        self.op = op
        self.value = value  # str or Block
        self.start = start
        self.end = end
        self.text = text  # full source the entry was parsed from

    @property
    def raw(self):
        return self.text[self.start:self.end]


class Block:
    __slots__ = ("entries", "start", "end", "text")

    def __init__(self, entries, start, end, text):
        self.entries = entries
        self.start = start  # index of '{'
        self.end = end  # index just past '}'
        self.text = text

    def get(self, key, default=None):
        """Value of the last entry with this key."""
        for entry in reversed(self.entries):
            if entry.key == key:
                return entry.value
        return default

    def get_all(self, key):
        return [e.value for e in self.entries if e.key == key]

    def items(self):
        """Bare scalar items, e.g. the contents of `building_types = { a b }`."""
        return [e.value for e in self.entries if e.key is None and isinstance(e.value, str)]

    def inner(self):
        """Source text between the braces, dedented."""
        return dedent(self.text[self.start + 1:self.end - 1])


def dedent(text):
    lines = [line.rstrip() for line in text.replace("\r\n", "\n").split("\n")]
    while lines and not lines[0]:
        lines.pop(0)
    while lines and not lines[-1]:
        lines.pop()
    if not lines:
        return ""
    lines[0] = lines[0].lstrip()  # text right after '{' has no indentation of its own
    indents = [len(l) - len(l.lstrip()) for l in lines[1:] if l]
    cut = min(indents) if indents else 0
    return "\n".join([lines[0]] + [l[cut:] for l in lines[1:]])


def _unquote(token):
    return token[1:-1].replace('\\"', '"')


def tokenize(text):
    tokens = []
    for m in _TOKEN.finditer(text):
        kind = m.lastgroup
        if kind != "skip":
            tokens.append((kind, m.group(), m.start(), m.end()))
    return tokens


def parse(text):
    """Parse a whole file. Returns a Block whose entries are the top-level statements."""
    tokens = tokenize(text)
    pos = 0
    n = len(tokens)

    def parse_block(open_start):
        nonlocal pos
        entries = []
        while pos < n:
            kind, tok, start, end = tokens[pos]
            if kind == "close":
                pos += 1
                if open_start is None:
                    continue  # stray '}' at top level
                return Block(entries, open_start, end, text)
            if kind == "open":
                pos += 1
                block = parse_block(start)
                entries.append(Entry(None, None, block, start, block.end, text))
                continue
            if kind not in ("word", "string"):
                pos += 1  # stray operator or junk
                continue
            pos += 1
            first = _unquote(tok) if kind == "string" else tok
            if pos < n and tokens[pos][0] == "op":
                op = tokens[pos][1]
                pos += 1
                if pos >= n:
                    break
                vkind, vtok, vstart, vend = tokens[pos]
                if vkind == "open":
                    pos += 1
                    block = parse_block(vstart)
                    entries.append(Entry(first, op, block, start, block.end, text))
                elif vkind in ("word", "string"):
                    pos += 1
                    value = _unquote(vtok) if vkind == "string" else vtok
                    value_end = vend
                    if vkind == "word" and vtok in _BLOCK_TAGS and pos < n and tokens[pos][0] == "open":
                        open_at = tokens[pos][2]
                        pos += 1
                        value_end = parse_block(open_at).end
                        value = text[vstart:value_end]
                    entries.append(Entry(first, op, value, start, value_end, text))
                # anything else: drop the dangling `key =`
            else:
                entries.append(Entry(None, None, first, start, end, text))
        end = len(text)
        return Block(entries, open_start if open_start is not None else 0, end, text)

    return parse_block(None)


def split_prefix(key):
    """Split `REPLACE:company_x` into ('REPLACE', 'company_x')."""
    if ":" in key:
        prefix, _, rest = key.partition(":")
        if prefix in PREFIXES:
            return prefix, rest
    return None, key


def braces_balanced(text):
    """True if a raw script fragment has matching braces (ignoring comments and strings)."""
    depth = 0
    for kind, *_ in tokenize(text):
        if kind == "open":
            depth += 1
        elif kind == "close":
            depth -= 1
            if depth < 0:
                return False
    return depth == 0
