"""Converting company types between game script and the builder's data model.

Fields the builder has a real editor for are stored structured. Everything
else (triggers, AI weights, unknown fields) is kept as raw script text so that
editing an existing company never loses what the builder does not understand.
"""
import re

from .pdx_script import Block, braces_balanced, dedent

LIST_FIELDS = ("building_types", "extension_building_types", "possible_prestige_goods", "preferred_headquarters")
SCALAR_FIELDS = ("icon", "background", "category")
# Trigger / AI blocks, kept as raw script. Order is the order they are written out.
RAW_BLOCKS = ("prestige_goods_trigger", "potential", "attainable", "possible", "can_establish_in",
              "ai_will_do", "ai_construction_targets", "ai_weight")

KEY_PATTERN = re.compile(r"^[A-Za-z0-9_.\-]+$")
MODIFIER_VALUE_PATTERN = re.compile(r"^(-?\d+(\.\d+)?|yes|no)$")
LANGUAGE_PATTERN = re.compile(r"^[a-z_]+$")


def empty_company():
    company = {"key": "", "mode": "new", "names": {}, "flavored_company": True,
               "prosperity_modifier": [], "blocks": {name: "" for name in RAW_BLOCKS}, "extra": ""}
    for field in LIST_FIELDS:
        company[field] = []
    for field in SCALAR_FIELDS:
        company[field] = ""
    return company


def company_from_block(key, block):
    """Build the data model from a parsed `company_x = { ... }` block."""
    company = empty_company()
    company["key"] = key
    company["flavored_company"] = False  # the game's default when the field is absent
    extra = []
    for entry in block.entries:
        name, value = entry.key, entry.value
        if name in LIST_FIELDS and isinstance(value, Block):
            for item in value.items():
                if item not in company[name]:
                    company[name].append(item)
        elif name in SCALAR_FIELDS and isinstance(value, str):
            company[name] = value
        elif name == "flavored_company" and isinstance(value, str):
            company[name] = value == "yes"
        elif name == "prosperity_modifier" and isinstance(value, Block):
            for sub in value.entries:
                if sub.key and isinstance(sub.value, str):
                    company[name] = [m for m in company[name] if m["key"] != sub.key]
                    company[name].append({"key": sub.key, "value": sub.value})
        elif name in RAW_BLOCKS and isinstance(value, Block):
            text = value.inner()
            previous = company["blocks"][name]
            company["blocks"][name] = f"{previous}\n{text}" if previous and text else previous or text
        else:
            extra.append(dedent(entry.raw))
    company["extra"] = "\n".join(extra)
    return company


def clean_names(names):
    """Names per language as sent by the browser: one line each, real language keys only."""
    if not isinstance(names or {}, dict):
        raise ValueError("names")
    clean = {}
    for language, name in (names or {}).items():
        name = " ".join(str(name or "").split())
        if name and LANGUAGE_PATTERN.match(str(language)):
            clean[language] = name
    return clean


def normalize_company(raw):
    """Bring a company sent by the browser into the model's shape.

    Raises ValueError when it cannot be: the result is written into script
    files and file names, so nothing unexpected may get through.
    """
    company = empty_company()
    company["key"] = str(raw.get("key") or "").strip()
    company["mode"] = "override" if raw.get("mode") == "override" else "new"
    company["flavored_company"] = bool(raw.get("flavored_company"))
    company["names"] = clean_names(raw.get("names"))
    for field in LIST_FIELDS:
        items = raw.get(field) or []
        if not isinstance(items, list) or not all(isinstance(i, str) and KEY_PATTERN.match(i) for i in items):
            raise ValueError(field)
        company[field] = list(dict.fromkeys(items))
    for field in SCALAR_FIELDS:
        company[field] = " ".join(str(raw.get(field) or "").split())
    if company["category"] and not KEY_PATTERN.match(company["category"]):
        raise ValueError("category")
    modifiers = raw.get("prosperity_modifier") or []
    if not isinstance(modifiers, list) or not all(isinstance(m, dict) for m in modifiers):
        raise ValueError("prosperity_modifier")
    company["prosperity_modifier"] = [{"key": str(m.get("key") or ""), "value": str(m.get("value") or "").strip()}
                                      for m in modifiers]
    blocks = raw.get("blocks") or {}
    if not isinstance(blocks, dict):
        raise ValueError("blocks")
    for name in RAW_BLOCKS:
        company["blocks"][name] = str(blocks.get(name) or "").replace("\r\n", "\n")
    company["extra"] = str(raw.get("extra") or "").replace("\r\n", "\n")
    return company


def validate_company(company, existing_keys):
    """Returns a list of error codes; empty means the company can be written."""
    errors = []
    key = company.get("key", "")
    if not key:
        errors.append("key_missing")
    elif not KEY_PATTERN.match(key):
        errors.append("key_invalid")
    elif company.get("mode") != "override" and key in existing_keys:
        errors.append("key_exists")
    if not company.get("icon"):
        errors.append("icon_missing")
    if not company.get("background"):
        errors.append("background_missing")
    if not company.get("building_types"):
        errors.append("buildings_missing")
    for modifier in company.get("prosperity_modifier", []):
        # numbers, or yes/no for the few on/off modifiers
        if not (isinstance(modifier, dict) and KEY_PATTERN.match(str(modifier.get("key", "")))
                and MODIFIER_VALUE_PATTERN.match(str(modifier.get("value", "")))):
            errors.append("modifier_value")
            break
    for name in RAW_BLOCKS:
        if not braces_balanced(company.get("blocks", {}).get(name, "")):
            errors.append(f"braces:{name}")
    if not braces_balanced(company.get("extra", "")):
        errors.append("braces:extra")
    return errors


def _indent(text, tabs):
    prefix = "\t" * tabs
    return "\n".join(prefix + line if line.strip() else "" for line in text.split("\n"))


def _quote(value):
    return '"' + value.replace('"', '\\"') + '"'


def company_to_script(company):
    """Script text for one company.

    Overrides use REPLACE_OR_CREATE so the definition replaces the original
    whether or not the mod that defined it is loaded.
    """
    key = company["key"]
    head = f"REPLACE_OR_CREATE:{key}" if company.get("mode") == "override" else key
    out = [f"{head} = {{"]
    out.append(f"\ticon = {_quote(company['icon'])}")
    out.append(f"\tbackground = {_quote(company['background'])}")
    out.append("")
    if company.get("category"):
        out.append(f"\tcategory = {company['category']}")
    out.append(f"\tflavored_company = {'yes' if company.get('flavored_company') else 'no'}")
    out.append("")
    if company.get("preferred_headquarters"):
        out.append("\tpreferred_headquarters = { " + " ".join(company["preferred_headquarters"]) + " }")
        out.append("")
    for field in ("building_types", "extension_building_types", "possible_prestige_goods"):
        items = company.get(field) or []
        if not items and field == "possible_prestige_goods":
            continue
        out.append(f"\t{field} = {{")
        out.extend(f"\t\t{item}" for item in items)
        out.append("\t}")
        out.append("")
    blocks = company.get("blocks", {})

    def write_block(name, always=False):
        text = (blocks.get(name) or "").strip("\n")
        if not text.strip() and not always:
            return
        out.append(f"\t{name} = {{")
        if text.strip():
            out.append(_indent(text, 2))
        out.append("\t}")
        out.append("")

    for name in ("prestige_goods_trigger", "potential", "attainable"):
        write_block(name)
    write_block("possible", always=True)
    write_block("can_establish_in")
    out.append("\tprosperity_modifier = {")
    for modifier in company.get("prosperity_modifier", []):
        out.append(f"\t\t{modifier['key']} = {modifier['value']}")
    out.append("\t}")
    out.append("")
    for name in ("ai_will_do", "ai_construction_targets", "ai_weight"):
        write_block(name)
    extra = (company.get("extra") or "").strip("\n")
    if extra.strip():
        out.append(_indent(extra, 1))
        out.append("")
    while out[-1] == "":
        out.pop()
    out.append("}")
    return "\n".join(out)
