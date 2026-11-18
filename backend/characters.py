"""Characters of the country starts (stage 3 of docs/mod_types/country_start.md).

A country's starting characters are `create_character = { template = x }` statements in its block
of common/history/characters; what a character is (name, culture, interest group, role, ...) is in
the template (common/character_templates). A start keeps

  characters  None (as the game has it), or the whole list: [{template, extra, new}]
              template  the template used ("" for a new character)
              extra     the other statements of create_character, as script (on_created, ...)
              new       None, or the fields of a character the mod makes (see NEW_FIELDS)

A new character is written as a template of the mod, `<mod>_<tag>_character_<n>`, with its names as
new localization keys. Characters inside `if` and other statements of the block are kept as they are.
"""
from .companies import clean_names
from .countries import DATE_PATTERN, _key, _scoped_block_lines
from .pdx_script import Block, braces_balanced, dedent

# The roles of a new character, and the statement each one writes.
ROLES = {"ruler": "ruler", "heir": "heir", "ig_leader": "ig_leader", "politician": "", "general": "is_general",
         "admiral": "is_admiral", "agitator": "is_agitator"}
COMMANDER_RANKS = ("commander_rank_1", "commander_rank_2", "commander_rank_3", "commander_rank_4", "commander_rank_5")
TEMPLATE_ROLES = (("ruler", "ruler"), ("heir", "heir"), ("ig_leader", "ig_leader"), ("is_general", "general"),
                  ("is_admiral", "admiral"), ("is_agitator", "agitator"))


def _strip(value, prefix):
    value = value if isinstance(value, str) else ""
    return value[len(prefix):] if value.startswith(prefix) else value


# ------------------------------------------------------------------ reading

def read_characters(characters, block):
    """The characters of one `c:TAG ?= { }` block of the character history: their create_character
    statements, and how many other statements there are (kept as they are)."""
    for entry in block.entries:
        if entry.key == "create_character" and isinstance(entry.value, Block):
            template = entry.value.get("template")
            extra = [dedent(e.raw) for e in entry.value.entries if e.key != "template"]
            characters["items"].append({"template": template if isinstance(template, str) else "",
                                        "extra": "\n".join(extra), "new": None})
        elif entry.key:
            characters["other"] += 1
    return characters


def empty_characters():
    return {"items": [], "other": 0}


def template_info(block):
    """What the pages show of a character template."""
    roles = [name for key, name in TEMPLATE_ROLES if block.get(key) == "yes"]
    role = block.get("role")
    if isinstance(role, str):
        roles.append(role)
    traits = block.get("traits")
    return {
        "first_name": block.get("first_name") if isinstance(block.get("first_name"), str) else "",
        "last_name": block.get("last_name") if isinstance(block.get("last_name"), str) else "",
        "female": block.get("female") == "yes",
        "culture": _strip(block.get("culture"), "cu:"),
        "religion": _strip(block.get("religion"), "rel:"),
        "interest_group": _strip(block.get("interest_group"), ""),
        "ideology": _strip(block.get("ideology"), ""),
        "traits": traits.items() if isinstance(traits, Block) else [],
        "roles": list(dict.fromkeys(roles)),
        "birth_date": _strip(block.get("birth_date"), ""),
        "age": _strip(block.get("age"), ""),
    }


# ------------------------------------------------------------- normalizing

def normalize_new(raw):
    if not isinstance(raw, dict):
        raise ValueError("characters")
    role = raw.get("role") or "politician"
    if role not in ROLES:
        raise ValueError("characters")
    rank = str(raw.get("commander_rank") or "")
    if rank and rank not in COMMANDER_RANKS:
        raise ValueError("characters")
    traits = raw.get("traits") or []
    if not isinstance(traits, list):
        raise ValueError("characters")
    return {"first_name": clean_names(raw.get("first_name")), "last_name": clean_names(raw.get("last_name")),
            "female": bool(raw.get("female")), "birth_date": " ".join(str(raw.get("birth_date") or "").split()),
            "culture": _key(raw.get("culture"), "characters"), "religion": _key(raw.get("religion"), "characters"),
            "interest_group": _key(raw.get("interest_group"), "characters"),
            "ideology": _key(raw.get("ideology"), "characters"),
            "traits": list(dict.fromkeys(_key(t, "characters") for t in traits if t)),
            "home_region": _key(raw.get("home_region"), "characters"),
            "role": role, "commander_rank": rank if role in ("general", "admiral") else ""}


def normalize_characters(start, raw):
    items = raw.get("characters")
    if items is None:
        return
    if not isinstance(items, list):
        raise ValueError("characters")
    start["characters"] = []
    for item in items:
        if not isinstance(item, dict):
            raise ValueError("characters")
        new = normalize_new(item["new"]) if item.get("new") is not None else None
        start["characters"].append({"template": "" if new else _key(item.get("template"), "characters"),
                                    "extra": str(item.get("extra") or "").replace("\r\n", "\n"), "new": new})


def character_errors(start, game):
    """`game` also has "templates", "traits", "ideologies" (sets of keys)."""
    errors = []
    for item in start.get("characters") or []:
        new = item["new"]
        if new is None:
            if not item["template"] and not item["extra"].strip():
                errors.append("characters")
            elif item["template"] and item["template"] not in game["templates"]:
                errors.append("character_template")
        else:
            if not any(new["first_name"].values()) or not any(new["last_name"].values()):
                errors.append("character_name")
            if new["birth_date"] and not DATE_PATTERN.match(new["birth_date"]):
                errors.append("character_birth")
            if (not new["culture"] or new["culture"] not in game["cultures"]
                    or (new["religion"] and new["religion"] not in game["religions"])
                    or (new["interest_group"] and new["interest_group"] not in game["igs"])
                    or (new["ideology"] and new["ideology"] not in game["ideologies"])
                    or any(trait not in game["traits"] for trait in new["traits"])
                    or (new["home_region"] and new["home_region"] not in game["states"])
                    or (new["role"] == "ig_leader" and not new["interest_group"])):
                errors.append("character_fields")
        if not braces_balanced(item["extra"]):
            errors.append("braces:extra")
    return list(dict.fromkeys(errors))


# ------------------------------------------------------------------ writing

def template_key(slug, tag, index):
    """Key of the template of a new character: the n-th new one of the country's list."""
    return f"{slug}_{tag.lower()}_character_{index + 1}"


def _new_keys(start, slug):
    """Template key of each new character of a start, by its place in the list."""
    keys, n = {}, 0
    for i, item in enumerate(start.get("characters") or []):
        if item["new"] is not None:
            keys[i] = template_key(slug, start["key"], n)
            n += 1
    return keys


def create_lines(start, slug):
    """The create_character statements of a start's list."""
    keys = _new_keys(start, slug)
    lines = []
    for i, item in enumerate(start["characters"]):
        inner = [f"template = {keys.get(i, item['template'])}"] if keys.get(i, item["template"]) else []
        if item["extra"].strip():
            inner += item["extra"].strip("\n").split("\n")
        lines += _scoped_block_lines("create_character =", inner)
    return lines


def patch_characters(scopes, start, slug):
    """Replace the country's create_character statements with its list: where the first one was in
    its last block, else at the end of that block."""
    lines = create_lines(start, slug)
    last = scopes[-1]
    placed = not lines
    for scope in scopes:
        for entry in scope.block.entries:
            if entry.key != "create_character":
                continue
            if scope is last and not placed:
                scope.patcher.replace(entry, lines)
                placed = True
            else:
                scope.patcher.remove(entry, blank=True)
    if not placed:
        last.patcher.insert_end(last.block, lines, last.indent)


def template_lines(key, new):
    lines = [f"first_name = {key}_first", f"last_name = {key}_last", f"female = {'yes' if new['female'] else 'no'}",
             "historical = yes"]
    if new["birth_date"]:
        lines.append(f"birth_date = {new['birth_date']}")
    if ROLES[new["role"]]:
        lines.append(f"{ROLES[new['role']]} = yes")
    elif new["role"] == "politician":
        lines.append("role = politician")
    if new["commander_rank"]:
        lines.append(f"commander_rank = {new['commander_rank']}")
    lines.append(f"culture = cu:{new['culture']}")
    if new["religion"]:
        lines.append(f"religion = rel:{new['religion']}")
    if new["interest_group"]:
        lines.append(f"interest_group = {new['interest_group']}")
    if new["ideology"]:
        lines.append(f"ideology = {new['ideology']}")
    if new["home_region"]:
        lines.append(f"home_region = {new['home_region']}")
    if new["traits"]:
        lines += _scoped_block_lines("traits =", new["traits"])
    return _scoped_block_lines(f"{key} =", lines)


def templates_script(starts, slug):
    """The templates of the new characters of the starts, or None."""
    blocks = []
    for start in starts:
        if start.get("mode") not in ("override", "new") or not start.get("characters"):
            continue
        for i, key in _new_keys(start, slug).items():
            blocks.append("\n".join(template_lines(key, start["characters"][i]["new"])))
    return "\n\n".join(blocks) if blocks else None


def character_texts(start, lang, slug):
    """Names of the new characters in one language (new localization keys)."""
    texts = {}
    for i, key in _new_keys(start, slug).items():
        new = start["characters"][i]["new"]
        for field, suffix in (("first_name", "_first"), ("last_name", "_last")):
            text = new[field].get(lang)
            if text:
                texts[key + suffix] = text
    return texts


def character_languages(start):
    return {lang for item in start.get("characters") or [] if item["new"]
            for field in ("first_name", "last_name") for lang, text in item["new"][field].items() if text}
