"""
Loads journal profiles (profiles/*.yaml) so journal-specific rules can change without editing code.

A profile can start from another one with `based_on:` and list only what it changes.
settings.json picks which profile is used by default, and can override a few settings on top:

    {"profile": "generic", "abstract_word_limit": 300}
"""

import json
from pathlib import Path

import yaml

from rules import RULES, SEVERITIES, REVIEW_MODELS, CITATION_STYLES

HERE = Path(__file__).parent
PROFILE_DIR = HERE / "profiles"
DEFAULT_PROFILE = "generic"

# Settings that settings.json (or the website sidebar) may override
SETTING_KEYS = ["review_model", "citation_style", "old_reference_years", "old_reference_share",
                "self_citation_share", "limits", "title_max_words", "require_running_title", "abstract_structure",
                "abstract_headings", "keywords", "require_highlights", "highlights", "require_line_numbers",
                "require_double_spacing", "require_page_numbers", "p_value_style", "spelling",
                "abstract_word_limit", "data_cutoff_year",
                "extra_ignore_abbreviations", "skip_gene_and_chemical_symbols"]


def merge(base, extra):
    """Combine two profiles: dictionaries are merged key by key, anything else is replaced."""
    out = dict(base)
    for key, value in extra.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = merge(out[key], value)
        else:
            out[key] = value
    return out


def list_profiles():
    """{profile id: display name} for every file in profiles/, generic first."""
    found = {}
    for path in sorted(PROFILE_DIR.glob("*.yaml")):
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        found[path.stem] = data.get("name", path.stem)
    order = sorted(found, key=lambda p: (p != DEFAULT_PROFILE, found[p].lower()))
    return {p: found[p] for p in order}


def load_profile(profile_id=DEFAULT_PROFILE, _seen=None):
    """Read a profile and everything it is based on, and return the combined result."""
    _seen = _seen or []
    if profile_id in _seen:
        raise ValueError(f"Profiles are based on each other in a loop: {' -> '.join(_seen + [profile_id])}")
    path = PROFILE_DIR / f"{profile_id}.yaml"
    if not path.exists():
        raise FileNotFoundError(f"No profile called '{profile_id}' (looked for {path.name} in profiles/)")
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}

    parent = data.pop("based_on", None)
    profile = merge(load_profile(parent, _seen + [profile_id]), data) if parent else data
    profile["id"] = profile_id
    check_profile(profile)
    return profile


def check_profile(profile):
    """Catch typos early: unknown rule IDs or severities."""
    rules = profile.get("rules", {})
    for rule, severity in rules.items():
        if severity is False:             # YAML reads a bare `off` as False
            severity = rules[rule] = "off"
        if rule not in RULES:
            raise ValueError(f"Profile '{profile['id']}' mentions an unknown rule: '{rule}' (see rules.py)")
        if severity not in SEVERITIES:
            raise ValueError(f"Profile '{profile['id']}', rule '{rule}': severity must be one of "
                             f"{', '.join(SEVERITIES)}, not '{severity}'")
    model = profile.get("settings", {}).get("review_model", "single_blind")
    if model not in REVIEW_MODELS:
        raise ValueError(f"Profile '{profile['id']}': review_model must be one of "
                         f"{', '.join(REVIEW_MODELS)}, not '{model}'")
    style = profile.get("settings", {}).get("citation_style", "auto")
    if style not in CITATION_STYLES:
        raise ValueError(f"Profile '{profile['id']}': citation_style must be one of "
                         f"{', '.join(CITATION_STYLES)}, not '{style}'")


def load_settings(profile_id=None):
    """The profile to check with: the one named here, or the one chosen in settings.json,
    with any settings.json overrides applied on top."""
    local = {}
    path = HERE / "settings.json"
    try:
        local = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        pass
    except json.JSONDecodeError as e:
        print(f"Warning: settings.json has a mistake ({e}); ignoring it.")

    profile = load_profile(profile_id or local.get("profile", DEFAULT_PROFILE))
    overrides = {k: v for k, v in local.items() if k in SETTING_KEYS}
    profile["settings"] = merge(profile.get("settings", {}), overrides)
    return profile
