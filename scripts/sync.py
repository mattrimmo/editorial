#!/usr/bin/env python3
"""
Editorial Pitch Pack - sync script (Songstats test version).

Same job and same data/history.json shape as the Spot On Track version, so the page
is unchanged. For every tracked record it pulls from Songstats:
  * track metadata (artist, title, release date, artwork, DSP links)
  * playlist placements, current AND removed, with added/removed dates, on
    Spotify, Apple Music, Deezer and (new) Amazon Music
  * current chart positions on Spotify, Apple Music, Deezer and Shazam
  * Spotify daily streams and Shazam daily counts since release

Editorial classification (registry.json tags always win):
  Spotify : owned by Spotify (Editorial, Personalised, Chart, Songwriter) -> editorial, else independent.
            "This Is" and artist radio playlists are left out completely.
  Apple   : Songstats type "Editorial" -> editorial, "Curator"/"Listener" -> independent
  Deezer  : owner is a Deezer editor ("Laeti - Deezer Dance & EDM Editor", "Deezer Editors") -> editorial.
            "Deezer Charts" country lists -> independent (not pitch targets). Everything else independent.
            Provisional until Songstats confirm how they flag Deezer editorial.
  Amazon  : owner is Amazon Music (any region) -> editorial, else independent. Regional editions are
            folded into one playlist with one span per region, like Apple's countries.

Records added by link are matched to an ISRC through Songstats and kept in data/resolved.json.

Secret (GitHub Actions): SONGSTATS_API_KEY
Optional env: MIN_FOLLOWERS (default 100, Spotify and Deezer non-editorial only),
              STREAMS_SHIFT_DAYS (default 0, see README).
"""
import json
import os
import re
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

SS_KEY = os.environ.get("SONGSTATS_API_KEY", "")
SS_BASE = os.environ.get("SS_BASE", "https://api.songstats.com/enterprise/v1")
SS_DELAY = float(os.environ.get("SS_DELAY", "0.3"))
MIN_FOLLOWERS = int(os.environ.get("MIN_FOLLOWERS", "100") or 0)
STREAMS_SHIFT_DAYS = int(os.environ.get("STREAMS_SHIFT_DAYS", "0") or 0)
PAGE = 100
MAX_PAGES = 30

SPOTIFY_SKIP_TYPES = {"Artist Playlist", "Artist Radio"}   # same rule as the report generator

DSP_SOURCE = {"spotify": "spotify", "apple": "apple_music", "deezer": "deezer", "amazon": "amazon"}
LINK_KEYS = {"spotify": "spotify", "apple_music": "apple", "deezer": "deezer", "amazon": "amazon",
             "youtube": "youtube", "beatport": "beatport", "soundcloud": "soundcloud", "shazam": "shazam"}
calls = [0]


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


# ------------------------------------------------------------------ Songstats
class SsError(Exception):
    pass


def ss_get(path, params):
    """GET from Songstats. Returns the parsed body, or None for a 404. Retries on 429 / 5xx."""
    params = {k: v for k, v in params.items() if v not in (None, "")}
    for attempt in range(5):
        try:
            r = requests.get(f"{SS_BASE}/{path}", params=params,
                             headers={"apikey": SS_KEY, "accept": "application/json"}, timeout=60)
        except requests.RequestException as e:
            raise SsError(f"{path}: {e}")
        calls[0] += 1
        if r.status_code in (429, 500, 502, 503, 504) and attempt < 4:
            ra = r.headers.get("Retry-After")
            wait = min(int(float(ra)), 60) + 1 if ra and ra.replace(".", "", 1).isdigit() else 3 * (attempt + 1)
            print(f"  [songstats] {r.status_code} on {path}, waiting {wait}s")
            time.sleep(wait)
            continue
        if r.status_code == 404:
            time.sleep(SS_DELAY)
            raise SsError(f"{path}: not found on Songstats (404) {r.text[:160]}")
        if not r.ok:
            raise SsError(f"{path}: HTTP {r.status_code} {r.text[:160]}")
        time.sleep(SS_DELAY)
        try:
            body = r.json()
        except ValueError:
            raise SsError(f"{path}: response was not JSON")
        body = body.get("response", body)
        if isinstance(body, dict) and body.get("result") == "error":
            raise SsError(f"{path}: {body.get('message')}")
        return body
    raise SsError(f"{path}: kept failing")


def find_ids(isrc, hint=""):
    """Songstats track + artist IDs for an ISRC. Keys scoped to artists/members need the artist
    on every call, so we look the track up once (by ISRC, then by 'artist title') and send both."""
    for q in [isrc, hint]:
        if not q:
            continue
        for res in (ss_get("tracks/search", {"q": q, "limit": 5}) or {}).get("results") or []:
            artists = [a.get("songstats_artist_id") for a in res.get("artists") or [] if a.get("songstats_artist_id")]
            for aid in artists or [None]:
                ident = {"songstats_track_id": res.get("songstats_track_id"), "songstats_artist_id": aid}
                try:
                    body = ss_get("tracks/info", dict(ident, source="all"))
                except SsError:
                    continue
                info = (body or {}).get("track_info") or {}
                isrcs = {l.get("isrc") for l in info.get("links") or [] if l.get("isrc")}
                if q != isrc or isrc in isrcs or not isrcs:
                    return {k: v for k, v in ident.items() if v}, body
    raise SsError(f"could not find {isrc} on Songstats (searched by ISRC{' and ' + repr(hint) if hint else ''})")


def source_data(body, source):
    for s in (body or {}).get("stats", []) or []:
        if s.get("source") == source:
            return s.get("data") or {}
    return {}


def safe(label, errors, fn, default):
    """Run fn(); on failure record the error and return default plus ok=False."""
    try:
        return fn(), True
    except Exception as e:  # noqa: BLE001 - keep going on any endpoint failure
        msg = f"{label}: {e}"
        print("  ERROR", msg)
        errors.append(msg)
        return default, False


def all_playlists(ident, source, stop_below=None):
    """Current + removed playlist rows for one source, 100 per page."""
    rows = []
    for page in range(MAX_PAGES):
        body = ss_get("tracks/stats", dict(ident, source=source, with_playlists="true",
                                           limit=PAGE, offset=page * PAGE))
        pl = source_data(body, source).get("playlists") or []
        rows.extend(pl)
        if len(pl) < PAGE:
            break
        if stop_below is not None and (pl[-1].get("followers_count") or 0) < stop_below:
            break  # Spotify/Deezer lists come back biggest first
    return rows


# ------------------------------------------------------------------ classification
def deezer_kind(owner):
    o = (owner or "").strip().lower()
    if o == "deezer charts":
        return "independent"
    if "deezer" in o or re.search(r"\bedit(or|ors|rice|ora)\b", o):
        return "editorial"
    return "independent"


def classify(dsp, pid, auto_kind, registry):
    reg = registry.get(f"{dsp}:{pid}")
    if reg and reg.get("kind") in ("editorial", "independent", "ignore"):
        return reg["kind"]
    return auto_kind


def _span(cc, added, removed, position):
    return {"cc": cc, "added_at": (added or "")[:10] or None, "removed_at": (removed or "")[:10] or None,
            "position": None if removed else position}


def finish(by_id, registry, check_followers):
    out = []
    for p in by_id.values():
        kind = classify(p["dsp"], p["id"], p.pop("_auto"), registry)
        if kind == "ignore":
            continue
        if check_followers and kind != "editorial" and (p["followers"] or 0) < MIN_FOLLOWERS:
            continue
        p["kind"] = kind
        p["spans"].sort(key=lambda s: (s.get("added_at") or "", s.get("cc") or ""))
        out.append(p)
    out.sort(key=lambda p: (-(p["followers"] or 0), p["name"] or ""))
    return out


def spotify_placements(rows, registry):
    by_id = {}
    for r in rows:
        pid = r.get("spotifyid")
        if not pid:
            continue
        owned = (r.get("spotify_userid") or "").lower() == "spotify" or (r.get("owner_name") or "") == "Spotify"
        if owned and r.get("type") in SPOTIFY_SKIP_TYPES:
            continue   # "This Is ..." and artist radio: algorithmic / artist lists, not editorial support
        p = by_id.setdefault(pid, {"dsp": "spotify", "id": pid, "name": r.get("name"), "artwork": r.get("artwork"),
                                   "followers": 0, "_auto": "editorial" if owned else "independent", "spans": []})
        p["followers"] = max(p["followers"], r.get("followers_count") or 0)
        p["spans"].append(_span("", r.get("added_at"), r.get("removed_at"), r.get("current_position")))
    return finish(by_id, registry, check_followers=True)


def deezer_placements(rows, registry):
    by_id = {}
    for r in rows:
        pid = str(r.get("deezerid") or "")
        if not pid:
            continue
        p = by_id.setdefault(pid, {"dsp": "deezer", "id": pid, "name": r.get("name"), "artwork": r.get("artwork"),
                                   "followers": 0, "_auto": deezer_kind(r.get("owner_name")), "spans": []})
        p["followers"] = max(p["followers"], r.get("followers_count") or 0)
        p["spans"].append(_span("", r.get("added_at"), r.get("removed_at"), r.get("current_position")))
    return finish(by_id, registry, check_followers=True)


def apple_placements(rows, registry):
    by_id = {}
    for r in rows:
        pid = r.get("applemusicid")
        if not pid:
            continue
        auto = "editorial" if r.get("type") == "Editorial" else "independent"
        p = by_id.setdefault(pid, {"dsp": "apple", "id": pid, "name": r.get("name"), "artwork": r.get("artwork"),
                                   "followers": None, "_auto": auto, "spans": []})
        pbc = r.get("positions_by_country") or {}
        if pbc:
            for cc, v in pbc.items():
                p["spans"].append(_span(cc, v.get("added_at"), v.get("removed_at"), v.get("current_position")))
        else:
            p["spans"].append(_span("", r.get("added_at"), r.get("removed_at"), r.get("current_position")))
    return finish(by_id, registry, check_followers=False)


def amazon_placements(rows, registry):
    """One playlist per name, one span per regional edition."""
    by_id = {}
    for r in rows:
        name = r.get("name") or ""
        if not name:
            continue
        pid = "n-" + re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
        auto = "editorial" if "amazon" in (r.get("owner_name") or "").lower() else "independent"
        p = by_id.setdefault(pid, {"dsp": "amazon", "id": pid, "name": name, "artwork": r.get("artwork"),
                                   "followers": None, "_auto": auto, "spans": []})
        if auto == "editorial":
            p["_auto"] = "editorial"
        p["spans"].append(_span(r.get("region") or "", r.get("added_at"), r.get("removed_at"), r.get("current_position")))
    return finish(by_id, registry, check_followers=False)


# ------------------------------------------------------------------ charts
_COUNTRIES = None


def country_names():
    global _COUNTRIES
    if _COUNTRIES is None:
        _COUNTRIES = {"uk": "GB", "united kingdom": "GB", "usa": "US", "united states": "US", "russia": "RU",
                      "south korea": "KR", "vietnam": "VN", "czech republic": "CZ", "turkey": "TR", "taiwan": "TW",
                      "bolivia": "BO", "venezuela": "VE", "uae": "AE", "united arab emirates": "AE"}
        try:
            import pycountry
            for c in pycountry.countries:
                for n in (c.name, getattr(c, "common_name", None), getattr(c, "official_name", None)):
                    if n:
                        _COUNTRIES.setdefault(n.lower(), c.alpha_2)
        except ImportError:
            pass
    return _COUNTRIES


def match_country(text):
    t = (text or "").strip().lower()
    if t in ("global", "worldwide", "world"):
        return "GLOBAL", ""
    names = country_names()
    if t in names:
        return names[t], ""
    best = None
    for n, code in names.items():
        if t.endswith(" " + n) and (best is None or len(n) > len(best[0])):
            best = (n, code)
    return (best[1], text[: len(text) - len(best[0])].strip()) if best else ("", "")


def spotify_chart(c):
    sid = c.get("spotifyid") or ""
    m = re.match(r"(regional|viral)-([a-z]{2}|global)-(daily|weekly)", sid)
    if not m:
        return None  # city charts: Spot On Track never had these, so leave them out
    cc = "GLOBAL" if m.group(2) == "global" else m.group(2).upper()
    return {"id": sid, "country_code": cc, "position": c.get("current_position"), "previous_position": None,
            "type": "viral" if m.group(1) == "viral" else "regional", "frequency": m.group(3), "date": None, "streams": None}


def apple_chart(c):
    aid = c.get("applemusicid") or ""
    m = re.match(r"CHARTS-([a-z]{2})-", aid)
    name = c.get("name") or ""
    genre = name.split(":", 1)[0].strip() if ":" in name else None
    if genre and genre.lower().startswith("top"):
        genre = "All genres"
    cc = m.group(1).upper() if m else match_country(name.split(":", 1)[-1])[0]
    return {"id": aid or name, "country_code": cc, "position": c.get("current_position"), "previous_position": None,
            "genre": genre, "date": None}


def deezer_chart(c):
    name = c.get("name") or ""
    cc, _ = match_country(re.sub(r"^(top|deezer)\s+", "", name.split(":", 1)[-1], flags=re.I))
    return {"id": c.get("deezerid") or name, "country_code": cc, "position": c.get("current_position"),
            "previous_position": None, "date": None}


def shazam_chart(c):
    name = c.get("name") or ""
    genre = city = None
    if (c.get("location_type") or "").lower() == "city":
        cc, city = match_country(name)
        city = city or name
    else:
        country, _, genre = name.partition(" - ")
        cc, _ = match_country(country)
        genre = genre or None
    return {"id": c.get("external_id") or name, "country_code": cc or "", "type": "shazams",
            "position": c.get("current_position"), "previous_position": None, "genre": genre, "city": city, "date": None}


def fetch_charts(ident):
    body = ss_get("tracks/stats", {**ident, "source": "spotify,apple_music,deezer,shazam",
                                   "with_charts": "true", "only_current": "true", "limit": PAGE})
    out = {"spotify": [], "apple": [], "deezer": [], "shazam": []}
    for c in source_data(body, "spotify").get("charts") or []:
        row = spotify_chart(c)
        if row:
            out["spotify"].append(row)
    for c in source_data(body, "apple_music").get("track_charts") or []:
        out["apple"].append(apple_chart(c))
    dz = source_data(body, "deezer")
    for c in (dz.get("track_charts") or []) + (dz.get("charts") or []):
        out["deezer"].append(deezer_chart(c))
    for c in source_data(body, "shazam").get("charts") or []:
        out["shazam"].append(shazam_chart(c))
    return out


def carry_previous(charts, prev_charts):
    """Songstats has no 'previous position', so use the position from the last sync."""
    for dsp, rows in charts.items():
        prev = {p.get("id"): p.get("position") for p in (prev_charts or {}).get(dsp, []) if p.get("id")}
        for r in rows:
            r["previous_position"] = prev.get(r.get("id"))
    return charts


# ------------------------------------------------------------------ series
def to_date(s):
    try:
        return date.fromisoformat((s or "")[:10])
    except ValueError:
        return None


def daily_series(history, key, shift_days):
    """Songstats gives a running total per day. Totals don't always move every day, so when a total
    sits still for a few days and then jumps, the jump is spread evenly over those days. Days at the
    end that haven't moved yet get no daily figure (unknown, not zero)."""
    pts = sorted(((to_date(h.get("date")), h.get(key)) for h in history or []
                  if to_date(h.get("date")) and h.get(key) is not None), key=lambda x: x[0])
    out = [{"date": (d - timedelta(days=shift_days)).isoformat(), "daily": None, "total": v} for d, v in pts]
    i = 0
    while i < len(pts) - 1:
        j = i + 1
        while j < len(pts) and pts[j][1] == pts[i][1]:
            j += 1
        if j == len(pts):
            break  # flat to the end: not updated yet
        gain = pts[j][1] - pts[i][1]
        days = j - i
        if gain >= 0:
            for k in range(i + 1, j + 1):
                out[k]["daily"] = round(gain / days)
        i = j
    return out


# ------------------------------------------------------------------ link -> ISRC
def entry_key(entry):
    return (entry.get("key") or entry.get("link") or "").strip()


def effective_isrc(entry, resolved):
    isrc = (entry.get("isrc") or "").strip()
    if isrc:
        return isrc
    return ((resolved.get(entry_key(entry)) or {}).get("isrc") or "").strip()


def isrc_from_info(info, prefer_source=None):
    links = (info or {}).get("links") or []
    for l in links:
        if l.get("isrc") and (prefer_source is None or l.get("source") == prefer_source):
            return l["isrc"].strip()
    for l in links:
        if l.get("isrc"):
            return l["isrc"].strip()
    return None


def resolve_links(tracked, resolved, only):
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
            sp = re.search(r"open\.spotify\.com/(?:intl-[a-z]+/)?track/([A-Za-z0-9]+)", key)
            info, isrc = {}, None
            if sp:
                try:
                    body = ss_get("tracks/info", {"spotify_track_id": sp.group(1), "source": "spotify"})
                    info = (body or {}).get("track_info") or {}
                    isrc = isrc_from_info(info, "spotify")
                except SsError as e:
                    print(f"  direct lookup failed ({e}), trying search")
            if not isrc:
                found = (ss_get("tracks/search", {"q": key, "limit": 1}) or {}).get("results") or []
                info, isrc = {}, None
                if found:
                    aid = next((x.get("songstats_artist_id") for x in found[0].get("artists") or []), None)
                    body = ss_get("tracks/info", {"songstats_track_id": found[0]["songstats_track_id"],
                                                  "songstats_artist_id": aid, "source": "all"})
                    info = (body or {}).get("track_info") or {}
                    isrc = isrc_from_info(info)
        except SsError as e:
            resolved[key] = {"error": f"Search failed: {e}", "tried_at": now}
            changed = True
            print("  ERROR", e)
            continue
        if isrc:
            resolved[key] = {"isrc": isrc, "name": info.get("title"), "release_date": info.get("release_date"),
                             "songstats_track_id": info.get("songstats_track_id"), "resolved_at": now}
            print(f"  -> {isrc} ({info.get('title')})")
        else:
            resolved[key] = {"error": "No match found on Songstats for this link. Paste the ISRC instead.", "tried_at": now}
            print("  no match")
        changed = True
    return changed


# ------------------------------------------------------------------ one record
def sync_record(entry, prior, registry):
    isrc = entry["isrc"].strip()
    errors = []
    rec = {"isrc": isrc, "synced_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
           "source": "songstats", "errors": errors}
    prior = prior or {}

    pm = prior.get("meta") or {}
    hint = " ".join(filter(None, [", ".join(pm.get("artists") or []) or entry.get("artist"), pm.get("name") or entry.get("track")]))
    found, ok = safe("lookup", errors, lambda: find_ids(isrc, hint), None)
    if not ok:
        rec["meta"] = pm
        for k in ("placements", "charts", "streams", "shazams"):
            rec[k] = prior.get(k, {} if k == "charts" else [])
        return rec
    ident, body = found
    rec["songstats"] = ident
    info = (body or {}).get("track_info") or {}
    if info:
        links = {}
        for l in info.get("links") or []:
            k = LINK_KEYS.get(l.get("source"))
            if not k or not l.get("url"):
                continue
            # prefer the link for this exact ISRC (Apple often lists mixes and DJ-mix versions too)
            if k not in links or (l.get("isrc") == isrc and links[k][1] != isrc):
                links[k] = (l["url"], l.get("isrc"))
        rec["meta"] = {
            "name": info.get("title"),
            "artists": [a.get("name") for a in info.get("artists") or []],
            "release_date": info.get("release_date"),
            "artwork": info.get("avatar"),
            "label": ", ".join(l.get("name") for l in (info.get("labels") or [])[:1] if l.get("name")),
            "links": {k: v[0] for k, v in links.items()},
        }
    else:
        rec["meta"] = prior.get("meta") or {}

    rel = to_date(entry.get("release_date")) or to_date(rec["meta"].get("release_date"))
    since = rel or (date.today() - timedelta(days=90))

    # --- placements per DSP (keep prior data for a DSP if its fetch failed)
    prior_by_dsp = {}
    for p in prior.get("placements", []):
        prior_by_dsp.setdefault(p["dsp"], []).append(p)
    builders = {"spotify": spotify_placements, "apple": apple_placements,
                "deezer": deezer_placements, "amazon": amazon_placements}
    placements = []
    for dsp in ("spotify", "apple", "deezer", "amazon"):
        stop = MIN_FOLLOWERS if dsp in ("spotify", "deezer") else None
        rows, ok = safe(f"{dsp} playlists", errors, lambda d=dsp, s=stop: all_playlists(ident, DSP_SOURCE[d], s), None)
        if not ok:
            if dsp in prior_by_dsp:
                print(f"  keeping previous {dsp} placements (fetch failed)")
                placements += prior_by_dsp[dsp]
            continue
        placements += builders[dsp](rows, registry)
    rec["placements"] = placements

    # --- charts
    charts, ok = safe("charts", errors, lambda: fetch_charts(ident), None)
    rec["charts"] = carry_previous(charts, prior.get("charts")) if ok else prior.get("charts", {})

    # --- streams and shazams
    end = date.today()
    s, ok = safe("spotify streams", errors, lambda: ss_get("tracks/historic_stats", {
        **ident, "source": "spotify", "start_date": since.isoformat(), "end_date": end.isoformat()}), None)
    rec["streams"] = daily_series(source_data(s, "spotify").get("history"), "streams_total", STREAMS_SHIFT_DAYS) \
        if ok else prior.get("streams", [])
    z, ok = safe("shazams", errors, lambda: ss_get("tracks/historic_stats", {
        **ident, "source": "shazam", "start_date": since.isoformat(), "end_date": end.isoformat()}), None)
    rec["shazams"] = daily_series(source_data(z, "shazam").get("history"), "shazams_total", 0) \
        if ok else prior.get("shazams", [])

    # --- everything else Songstats has: socials, radio, DJ support, Beatport, SoundCloud, Traxsource
    more, ok = safe("social, radio and DJ history", errors, lambda: fetch_more(ident, since), None)
    rec["more"] = more if ok else prior.get("more", {})
    sup, ok = safe("radio, DJ and Beatport detail", errors, lambda: fetch_support(ident), None)
    rec["support"] = sup if ok else prior.get("support", {})
    return rec


# ------------------------------------------------------------------ socials, radio, DJ, Beatport
# key: (source, field). All running totals, turned into daily figures the same way as streams.
MORE = {
    "tiktok_videos": ("tiktok", "videos_total"), "tiktok_views": ("tiktok", "views_total"),
    "ig_reels": ("instagram", "videos_total"), "ig_views": ("instagram", "views_total"),
    "yt_views": ("youtube", "video_views_total"), "yt_shorts": ("youtube", "shorts_total"),
    "sc_plays": ("soundcloud", "streams_total"), "dj_supports": ("tracklist", "total_supports_total"),
    "radio_plays": ("radio", "radio_plays_total"), "radio_stations": ("radio", "radio_stations_total"),
}
PRE_DAYS = 28   # socials often start before release, so look back a little for a fair "week before"


def with_start(history, key, start):
    """If a total only appears after the window opens (new release, or the platform picked it up late),
    it was zero before that, so add a zero day. Otherwise the first day's count is lost."""
    pts = [h for h in history or [] if h.get(key) is not None and to_date(h.get("date"))]
    if pts:
        first = min(to_date(h["date"]) for h in pts)
        if first > start:
            pts = [{"date": (first - timedelta(days=1)).isoformat(), key: 0}] + pts
    return pts


def fetch_more(ident, since):
    start = since - timedelta(days=PRE_DAYS)
    sources = sorted({s for s, _ in MORE.values()})
    params = {**ident, "start_date": start.isoformat(), "end_date": date.today().isoformat()}
    hist = {}
    try:
        body = ss_get("tracks/historic_stats", dict(params, source=",".join(sources)))
        for st in (body or {}).get("stats") or []:
            hist[st.get("source")] = (st.get("data") or {}).get("history") or []
    except SsError as e:  # a source not on this key: try them one by one
        print(f"  combined history failed ({e}), trying each source")
        for src in sources:
            try:
                hist[src] = source_data(ss_get("tracks/historic_stats", dict(params, source=src)), src).get("history") or []
            except SsError as e2:
                print(f"  {src} history unavailable: {e2}")
    out = {}
    for key, (src, field) in MORE.items():
        pts = with_start(hist.get(src), field, start)
        series = daily_series(pts, field, 0)
        if any(r.get("total") for r in series):
            out[key] = series
    return out


def _chart_row(c):
    return {"name": c.get("name"), "position": c.get("current_position"), "peak": c.get("top_position"),
            "peak_date": (c.get("top_position_date") or "")[:10] or None,
            "added_at": (c.get("added_at") or "")[:10] or None, "removed_at": (c.get("removed_at") or "")[:10] or None}


def fetch_support(ident):
    out = {}
    body = ss_get("tracks/stats", {**ident, "source": "tracklist,radio", "with_playlists": "true",
                                   "with_stations": "true", "limit": PAGE})
    tl = source_data(body, "tracklist")
    out["dj_sets"] = [{"name": t.get("tracklist_name"), "dj": t.get("artist_name"), "type": t.get("tracklist_type"),
                       "date": (t.get("record_date") or "")[:10] or None, "views": t.get("tracklist_views")}
                      for t in tl.get("tracklists") or []]
    out["dj_total"] = tl.get("total_support")
    out["dj_unique"] = tl.get("unique_support")
    out["tracklist_charts"] = [_chart_row(c) for c in tl.get("charts") or []]
    rd = source_data(body, "radio")
    out["radio"] = {"plays": rd.get("radio_plays_total"), "stations_total": rd.get("radio_stations_total"),
                    "stations": [{"name": (r.get("name") or "").strip(), "type": r.get("type"), "plays": r.get("radio_plays_total"),
                                  "first": r.get("first_played_at"), "last": r.get("last_played_at"), "cc": r.get("country_code"),
                                  "city": r.get("city_name") or None}
                                 for r in sorted(rd.get("radio_stations") or [], key=lambda r: -(r.get("radio_plays_total") or 0))]}
    for sources in ("beatport,soundcloud,traxsource", "beatport,soundcloud"):
        try:
            body = ss_get("tracks/stats", {**ident, "source": sources, "with_charts": "true", "with_playlists": "true", "limit": PAGE})
            break
        except SsError as e:
            print(f"  {sources} detail failed ({e})")
            body = None
    if body:
        bp = source_data(body, "beatport")
        out["beatport"] = {"charts": [_chart_row(c) for c in (bp.get("top_100") or []) + (bp.get("release_charts") or []) + (bp.get("features") or [])],
                           "dj_charts": [{"name": c.get("name"), "owner": c.get("owner_name"), "position": c.get("position"),
                                          "date": (c.get("release_date") or "")[:10] or None}
                                         for c in sorted(bp.get("dj_charts") or [], key=lambda c: c.get("release_date") or "", reverse=True)],
                           "dj_charts_total": bp.get("dj_charts_total")}
        sc = source_data(body, "soundcloud")
        out["soundcloud"] = {"editorial": [dict(_chart_row(p), followers=p.get("followers_count"), owner=p.get("owner_name"))
                                           for p in sc.get("playlists") or [] if (p.get("playlist_type") or "").lower() == "editorial"],
                             "charts": [_chart_row(c) for c in sc.get("charts") or []]}
        tx = source_data(body, "traxsource")
        if tx:
            rows = []
            for k in ("charts", "top_100", "features", "track_charts", "genre_charts"):
                rows += [_chart_row(c) for c in tx.get(k) or [] if isinstance(c, dict)]
            out["traxsource"] = {"charts": rows,
                                 "dj_charts": [{"name": c.get("name"), "owner": c.get("owner_name"), "position": c.get("position"),
                                                "date": (c.get("release_date") or "")[:10] or None} for c in tx.get("dj_charts") or []]}
    return out


# ------------------------------------------------------------------ main
def main():
    if not SS_KEY:
        print("Missing SONGSTATS_API_KEY.")
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
        if not isrc or isrc in seen:
            continue
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
        by = {}
        for p in rec["placements"]:
            if p.get("kind") == "editorial":
                by[p["dsp"]] = by.get(p["dsp"], 0) + 1
        print(f"  placements={len(rec['placements'])} editorial={ed} {by} errors={len(rec['errors'])}")
        history["generated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        save_json(HISTORY_FP, history)  # checkpoint after each record

    if not only:
        live = {effective_isrc(t, resolved) for t in tracked.get("tracks", [])}
        history["records"] = {k: v for k, v in history["records"].items() if k in live}
    history["generated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    save_json(HISTORY_FP, history)
    print(f"\nSUMMARY ok={ok} failed={failed} | Songstats calls this run={calls[0]}")
    if ok == 0 and failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
