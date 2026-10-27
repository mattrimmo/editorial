#!/usr/bin/env python3
"""
Editorial Pitch Pack - sync script.

Records in data/tracked.json can be added by ISRC or by a track link (Spotify, Apple,
Deezer or Shazam). Links are matched to an ISRC through Spot On Track's free track search
and the result is kept in data/resolved.json, so no ISRC ever needs to be looked up by hand.

For every record this pulls, from Spot On Track only:
  * track metadata (artist, title, release date, DSP links)
  * playlist placements (current AND removed, with added/removed dates) on
    Spotify, Apple Music and Deezer
  * current chart positions on Spotify, Apple, Deezer and Shazam
  * Spotify daily streams and Shazam daily counts since release

Everything is written to data/history.json. Because every placement carries its
own added/removed dates, the page can rebuild any release week (Friday to
Thursday) from this one file, so there is no need to wait for weekly snapshots
to build up.

Editorial classification (see classify()):
  Spotify : id starts 37i9dQZF1 (Spotify's own), or Spot On Track names Spotify
            as owner, or you tagged it in data/registry.json. Everything else
            on Spotify is treated as independent.
  Apple / Deezer : only if Spot On Track supplies an owner name that is the DSP
            itself, or you tagged it in data/registry.json (the page has a
            "Needs tagging" panel). Untagged ones are kept, flagged as untagged.

Secret (GitHub Actions): SOT_API_KEY
Optional env: MIN_FOLLOWERS (default 100, Spotify and Deezer non-editorial only)
"""
import json
import os
import sys
import time
from datetime import datetime, timezone, timedelta, date

import requests

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(REPO_ROOT, "data")
TRACKED_FP = os.path.join(DATA, "tracked.json")
HISTORY_FP = os.path.join(DATA, "history.json")
REGISTRY_FP = os.path.join(DATA, "registry.json")
RESOLVED_FP = os.path.join(DATA, "resolved.json")

SOT_KEY = os.environ.get("SOT_API_KEY", "")
SOT_BASE = os.environ.get("SOT_BASE", "https://www.spotontrack.com/api/v1")
SOT_DELAY = float(os.environ.get("SOT_DELAY", "0.4"))
MIN_FOLLOWERS = int(os.environ.get("MIN_FOLLOWERS", "100") or 0)

EDITORIAL_ID_PREFIX = "37i9dQZF1"
EDITORIAL_OWNERS = {
    "spotify", "apple music", "apple", "apple music editors", "apple music editorial",
    "deezer", "deezer editors", "deezer editorial",
}
OWNER_KEYS = ("owner_name", "owner", "curator_name", "curator", "user_name",
              "creator", "author", "user", "playlist_owner")
NAME_SUBKEYS = ("display_name", "name", "title", "username", "id")

_logged_keys = set()


# ------------------------------------------------------------------ file helpers
def load_json(path, default=None):
    if not os.path.exists(path):
        return default
    with open(path, "r", encoding="utf-8") as f:
        txt = f.read().strip()
        return json.loads(txt) if txt else default


def save_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, path)


# ------------------------------------------------------------------ Spot On Track
class SotError(Exception):
    pass


def sot_get(path, params=None):
    """GET from Spot On Track. Returns parsed JSON, or None for a 404 (endpoint/track
    not available). Retries on 429 using Retry-After. Raises SotError otherwise."""
    for _ in range(5):
        try:
            r = requests.get(SOT_BASE + path, params=params or None,
                             headers={"Authorization": "Bearer " + SOT_KEY}, timeout=40)
        except requests.RequestException as e:
            raise SotError(f"{path}: {e}")
        if r.status_code == 429:
            try:
                wait = min(int(r.headers.get("Retry-After", "5") or 5), 60) + 1
            except ValueError:
                wait = 6
            print(f"  [sot] 429 on {path}, waiting {wait}s")
            time.sleep(wait)
            continue
        if r.status_code == 404:
            time.sleep(SOT_DELAY)
            return None
        if not r.ok:
            raise SotError(f"{path}: HTTP {r.status_code} {r.text[:120]}")
        time.sleep(SOT_DELAY)
        try:
            return r.json()
        except ValueError:
            raise SotError(f"{path}: response was not JSON")
    raise SotError(f"{path}: kept rate limiting")


def safe(label, errors, fn, default):
    """Run fn(); on failure record the error and return default plus ok=False."""
    try:
        return fn(), True
    except Exception as e:  # noqa: BLE001 - we want to keep going on any endpoint failure
        msg = f"{label}: {e}"
        print("  ERROR", msg)
        errors.append(msg)
        return default, False


def owner_of(pl):
    for k in OWNER_KEYS:
        if k in pl:
            v = pl[k]
            if isinstance(v, str) and v.strip():
                return v.strip()
            if isinstance(v, dict):
                for sk in NAME_SUBKEYS:
                    if isinstance(v.get(sk), str) and v[sk].strip():
                        return v[sk].strip()
    return None


# ------------------------------------------------------------------ classification
def classify(dsp, pid, owner, registry):
    """Returns 'editorial' | 'independent' | 'ignore' | None (None = needs tagging)."""
    reg = registry.get(f"{dsp}:{pid}")
    if reg and reg.get("kind") in ("editorial", "independent", "ignore"):
        return reg["kind"]
    if dsp == "spotify":
        if pid.startswith(EDITORIAL_ID_PREFIX):
            return "editorial"
        if owner and owner.lower() in EDITORIAL_OWNERS:
            return "editorial"
        return "independent"
    if owner and owner.lower() in EDITORIAL_OWNERS:
        return "editorial"
    return None


# ------------------------------------------------------------------ placements
def _span(cc, added, removed, position):
    return {"cc": cc, "added_at": added, "removed_at": removed, "position": position}


def build_flat_placements(dsp, idkey, current, removed, registry):
    """Spotify and Deezer: one span per placement, grouped by playlist id."""
    by_id = {}

    def add(row, is_removed):
        pl = row.get("playlist") or {}
        pid = str(pl.get(idkey) or "")
        if not pid:
            return
        if dsp + ":keys" not in _logged_keys:
            _logged_keys.add(dsp + ":keys")
            print(f"  [sot] {dsp} playlist object keys: {sorted(pl.keys())} | owner field found: {owner_of(pl) is not None}")
        p = by_id.setdefault(pid, {"dsp": dsp, "id": pid, "name": pl.get("name"),
                                   "artwork": pl.get("artwork"), "followers": 0,
                                   "owner": owner_of(pl), "spans": []})
        p["followers"] = max(p["followers"], pl.get("followers") or 0)
        p["spans"].append(_span("", row.get("added_at"),
                                row.get("removed_at") if is_removed else None,
                                None if is_removed else row.get("position")))

    for r in current or []:
        add(r, False)
    for r in removed or []:
        add(r, True)
    return finish_placements(by_id, registry, check_followers=True)


def build_apple_placements(current, removed, registry):
    by_id = {}

    def add(row, is_removed):
        pl = row.get("playlist") or {}
        pid = str(pl.get("apple_id") or "")
        if not pid:
            return
        if "apple:keys" not in _logged_keys:
            _logged_keys.add("apple:keys")
            print(f"  [sot] apple playlist object keys: {sorted(pl.keys())} | owner field found: {owner_of(pl) is not None}")
        p = by_id.setdefault(pid, {"dsp": "apple", "id": pid, "name": pl.get("name"),
                                   "artwork": pl.get("artwork"), "followers": None,
                                   "owner": owner_of(pl), "spans": []})
        for c in row.get("countries") or []:
            p["spans"].append(_span(c.get("country_code") or "", c.get("added_at"),
                                    c.get("removed_at") if is_removed else None,
                                    None if is_removed else c.get("position")))

    for r in current or []:
        add(r, False)
    for r in removed or []:
        add(r, True)
    return finish_placements(by_id, registry, check_followers=False)


def finish_placements(by_id, registry, check_followers):
    out = []
    for p in by_id.values():
        kind = classify(p["dsp"], p["id"], p.pop("owner", None), registry)
        if kind == "ignore":
            continue
        if check_followers and kind != "editorial" and (p["followers"] or 0) < MIN_FOLLOWERS:
            continue
        p["kind"] = kind  # may be None (needs tagging)
        p["spans"].sort(key=lambda s: (s.get("added_at") or "", s.get("cc") or ""))
        out.append(p)
    out.sort(key=lambda p: (-(p["followers"] or 0), p["name"] or ""))
    return out


# ------------------------------------------------------------------ dates / series
def to_date(s):
    try:
        return date.fromisoformat((s or "")[:10])
    except ValueError:
        return None


def align_series(rows, shift_days):
    """Spot On Track stream dates are recorded dates; shift to Spotify for Artists days."""
    out = []
    for r in rows or []:
        d = to_date(r.get("date"))
        if not d:
            continue
        out.append({"date": (d - timedelta(days=shift_days)).isoformat(),
                    "daily": r.get("daily"), "total": r.get("total")})
    out.sort(key=lambda x: x["date"])
    return out


def chart_rows(rows, keys):
    return [{k: r.get(k) for k in keys} for r in rows or []]


# ------------------------------------------------------------------ link -> ISRC
def entry_key(entry):
    """The link (already tidied by the page) that identifies a record added without an ISRC."""
    return (entry.get("key") or entry.get("link") or "").strip()


def effective_isrc(entry, resolved):
    isrc = (entry.get("isrc") or "").strip()
    if isrc:
        return isrc
    return ((resolved.get(entry_key(entry)) or {}).get("isrc") or "").strip()


def resolve_links(tracked, resolved, only):
    """Match records added by link to an ISRC using Spot On Track's track search.
    The search endpoint does not count toward the entity quota. Failures are stored so the
    page can say so, and are retried on the next run."""
    changed = False
    for entry in tracked.get("tracks", []):
        if (entry.get("isrc") or "").strip():
            continue
        key = entry_key(entry)
        if not key or (resolved.get(key) or {}).get("isrc"):
            continue
        if only and key != only:
            continue
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        print(f"Matching link {key}")
        try:
            rows = sot_get("/tracks", {"query": key}) or []
        except SotError as e:
            resolved[key] = {"error": f"Search failed: {e}", "tried_at": now}
            changed = True
            print("  ERROR", e)
            continue
        hit = next((r for r in rows if isinstance(r, dict) and r.get("isrc")), None)
        if hit:
            resolved[key] = {"isrc": hit["isrc"].strip(), "name": hit.get("name"),
                             "release_date": hit.get("release_date"), "resolved_at": now}
            print(f"  -> {hit['isrc']} ({hit.get('name')})")
        else:
            resolved[key] = {"error": "No match found on Spot On Track for this link. Paste the ISRC instead.", "tried_at": now}
            print("  no match")
        changed = True
    return changed


# ------------------------------------------------------------------ one record
def sync_record(entry, prior, registry):
    isrc = entry["isrc"].strip()
    errors = []
    rec = {"isrc": isrc, "synced_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
           "errors": errors}
    prior = prior or {}

    meta, ok = safe("metadata", errors, lambda: sot_get(f"/tracks/{isrc}"), None)
    if meta:
        rec["meta"] = {
            "name": meta.get("name"),
            "artists": [a.get("name") for a in meta.get("artists") or []],
            "release_date": meta.get("release_date"),
            "artwork": meta.get("artwork"),
            "links": meta.get("links") or {},
        }
    else:
        rec["meta"] = prior.get("meta") or {}

    rel = to_date(entry.get("release_date")) or to_date(rec["meta"].get("release_date"))
    since = (rel or (date.today() - timedelta(days=90))).isoformat()

    # --- placements per DSP (keep prior data for a DSP if its fetch failed)
    placements = []
    prior_by_dsp = {}
    for p in prior.get("placements", []):
        prior_by_dsp.setdefault(p["dsp"], []).append(p)

    def flat(dsp, idkey):
        cur, ok1 = safe(f"{dsp} current", errors, lambda: sot_get(f"/tracks/{isrc}/{dsp}/playlists/current"), [])
        rem, ok2 = safe(f"{dsp} removed", errors, lambda: sot_get(f"/tracks/{isrc}/{dsp}/playlists/removed"), [])
        if not (ok1 and ok2) and dsp in prior_by_dsp:
            print(f"  keeping previous {dsp} placements (fetch failed)")
            return prior_by_dsp[dsp]
        return build_flat_placements(dsp, idkey, cur, rem, registry)

    def apple():
        cur, ok1 = safe("apple current", errors, lambda: sot_get(f"/tracks/{isrc}/apple/playlists/current"), [])
        rem, ok2 = safe("apple removed", errors, lambda: sot_get(f"/tracks/{isrc}/apple/playlists/removed"), [])
        if not (ok1 and ok2) and "apple" in prior_by_dsp:
            print("  keeping previous apple placements (fetch failed)")
            return prior_by_dsp["apple"]
        return build_apple_placements(cur, rem, registry)

    placements += flat("spotify", "spotify_id")
    placements += apple()
    placements += flat("deezer", "deezer_id")
    rec["placements"] = placements

    # --- charts
    prev_charts = prior.get("charts", {})
    charts = {}
    for dsp, keys in (
        ("spotify", ("country_code", "position", "previous_position", "type", "frequency", "date", "streams")),
        ("apple", ("country_code", "position", "previous_position", "genre", "date")),
        ("deezer", ("country_code", "position", "previous_position", "date")),
        ("shazam", ("country_code", "type", "position", "previous_position", "genre", "city", "date")),
    ):
        rows, ok = safe(f"{dsp} charts", errors, lambda d=dsp: sot_get(f"/tracks/{isrc}/{d}/charts/current"), None)
        charts[dsp] = chart_rows(rows, keys) if ok else prev_charts.get(dsp, [])
    rec["charts"] = charts

    # --- streams and shazams
    s, ok = safe("spotify streams", errors,
                 lambda: sot_get(f"/tracks/{isrc}/spotify/streams", {"from": since}), None)
    rec["streams"] = align_series(s, 2) if ok else prior.get("streams", [])
    z, ok = safe("shazams", errors,
                 lambda: sot_get(f"/tracks/{isrc}/shazam/shazams", {"from": since}), None)
    rec["shazams"] = align_series(z, 0) if ok else prior.get("shazams", [])
    return rec


# ------------------------------------------------------------------ main
def main():
    if not SOT_KEY:
        print("Missing SOT_API_KEY.")
        sys.exit(1)
    tracked = load_json(TRACKED_FP, {"tracks": []}) or {"tracks": []}
    registry = (load_json(REGISTRY_FP, {"playlists": {}}) or {}).get("playlists", {})
    resolved_doc = load_json(RESOLVED_FP, {"entries": {}}) or {"entries": {}}
    resolved = resolved_doc.setdefault("entries", {})
    history = load_json(HISTORY_FP, {"generated_at": None, "records": {}}) or {}
    history.setdefault("records", {})

    only = os.environ.get("ONLY_ISRC", "").strip()
    if resolve_links(tracked, resolved, only):
        save_json(RESOLVED_FP, resolved_doc)

    ok = failed = 0
    seen = set()
    for entry in tracked.get("tracks", []):
        isrc = effective_isrc(entry, resolved)
        if not isrc:
            continue  # link not matched yet, the page shows why
        if isrc in seen:
            continue  # same record added twice (by link and by ISRC)
        seen.add(isrc)
        if only and only.upper() != isrc.upper() and only != entry_key(entry):
            continue
        entry = dict(entry, isrc=isrc)
        print(f"Syncing {entry.get('artist') or '?'} - {entry.get('track') or '?'} ({isrc})")
        try:
            rec = sync_record(entry, history["records"].get(isrc), registry)
        except Exception as e:  # noqa: BLE001
            print(f"  FAILED: {e}")
            failed += 1
            continue
        history["records"][isrc] = rec
        if not rec["meta"].get("name") and rec["errors"]:
            failed += 1
        else:
            ok += 1
        ed = sum(1 for p in rec["placements"] if p.get("kind") == "editorial")
        un = sum(1 for p in rec["placements"] if p.get("kind") is None)
        print(f"  placements={len(rec['placements'])} editorial={ed} untagged={un} errors={len(rec['errors'])}")
        history["generated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        save_json(HISTORY_FP, history)  # checkpoint after each record

    # drop history for records no longer tracked
    if not only:
        live = {effective_isrc(t, resolved) for t in tracked.get("tracks", [])}
        history["records"] = {k: v for k, v in history["records"].items() if k in live}
    history["generated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    save_json(HISTORY_FP, history)
    print(f"\nSUMMARY ok={ok} failed={failed}")
    if ok == 0 and failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
