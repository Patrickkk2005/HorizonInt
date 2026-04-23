#!/usr/bin/env python3
"""
HorizonInt — GDELT Conflict Event Fetcher
Fetches the latest GDELT v2 15-minute export, filters for 25 CAMEO violence codes,
extracts events with lat/lng, merges into OUTPUT_DIR/events.geojson.
Runs hourly via Docker cron service.
"""

import csv
import hashlib
import io
import json
import logging
import os
try:
    import config
    for _k, _e in [('OPENAI_API_KEY','OPENAI_API_KEY'),('ANTHROPIC_API_KEY','ANTHROPIC_API_KEY'),('OUTPUT_DIR','OUTPUT_DIR')]:
        if hasattr(config, _k) and not os.environ.get(_e):
            os.environ[_e] = getattr(config, _k)
except ImportError:
    pass
import zipfile
from datetime import datetime, timezone, timedelta
from pathlib import Path

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

OUTPUT_DIR = Path(os.getenv("OUTPUT_DIR", "docs/data"))
GDELT_LASTUPDATE_URL = "http://data.gdeltproject.org/gdeltv2/lastupdate.txt"
MAX_GDELT_EVENTS = 100
REQUEST_TIMEOUT  = 30

# 25 CAMEO violence codes (strings for exact matching)
CAMEO_VIOLENCE_CODES = {
    "145", "1451", "1452",
    "180", "181",
    "182", "1821", "1822", "1823",
    "183", "1831", "1832", "1833",
    "185", "186",
    "190", "191", "192",
    "193", "194", "195", "196",
    "200", "201", "202", "203", "204",
}

CAMEO_LABELS = {
    "145": "Violent protest", "1451": "Riot", "1452": "Violent demonstration",
    "180": "Unconventional violence", "181": "Abduction/Hostage",
    "182": "Physical assault", "1821": "Sexual assault",
    "1822": "Torture", "1823": "Killing by assault",
    "183": "Bombing attack", "1831": "Suicide bombing",
    "1832": "Car bombing", "1833": "Roadside bombing",
    "185": "Assassination attempt", "186": "Assassination",
    "190": "Military force", "191": "Blockade",
    "192": "Occupation", "193": "Small arms combat",
    "194": "Artillery/Tank combat", "195": "Aerial weapons",
    "196": "Ceasefire violation",
    "200": "Mass violence", "201": "Mass expulsion",
    "202": "Mass killings", "203": "Ethnic cleansing", "204": "WMD use",
}

# GDELT v2 CSV column indices (0-based)
COL_EVENT_ID    = 0
COL_DATE        = 1
COL_EVENT_CODE  = 26
COL_GOLDSTEIN   = 30   # Goldstein scale (-10 to +10; negative = destabilising)
COL_ACT_LAT     = 53
COL_ACT_LNG     = 54
COL_ACT_NAME    = 56
COL_SOURCE_URL  = 57


def gdelt_severity(goldstein: float) -> int:
    """Map Goldstein scale to 1-3 severity."""
    if goldstein <= -7:
        return 3
    if goldstein <= -3:
        return 2
    return 1


def fetch_gdelt_export() -> list[list[str]]:
    """Download and parse the latest GDELT v2 export CSV."""
    log.info("Fetching GDELT lastupdate.txt…")
    try:
        r = requests.get(GDELT_LASTUPDATE_URL, timeout=REQUEST_TIMEOUT)
        r.raise_for_status()
    except Exception as e:
        log.error("Failed to fetch GDELT lastupdate: %s", e)
        return []

    # File has 3 lines; first line is the export CSV zip
    lines = r.text.strip().splitlines()
    if not lines:
        log.error("Empty lastupdate.txt")
        return []

    # Each line: "size hash url"
    export_url = lines[0].split()[-1]
    if not export_url.endswith(".export.CSV.zip"):
        # Try to find the export line
        for line in lines:
            if ".export.CSV.zip" in line:
                export_url = line.split()[-1]
                break
        else:
            log.error("Could not find export CSV URL in: %s", lines)
            return []

    log.info("Downloading GDELT export: %s", export_url)
    try:
        r = requests.get(export_url, timeout=REQUEST_TIMEOUT, stream=True)
        r.raise_for_status()
        data = r.content
    except Exception as e:
        log.error("Failed to download GDELT export: %s", e)
        return []

    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            csv_name = z.namelist()[0]
            csv_content = z.read(csv_name).decode("utf-8", errors="replace")
    except Exception as e:
        log.error("Failed to unzip GDELT export: %s", e)
        return []

    reader = csv.reader(io.StringIO(csv_content), delimiter="\t")
    return list(reader)


def parse_gdelt_events(rows: list[list[str]]) -> list[dict]:
    events = []
    for row in rows:
        if len(row) < 58:
            continue
        code = row[COL_EVENT_CODE].strip()
        if code not in CAMEO_VIOLENCE_CODES:
            continue
        try:
            lat = float(row[COL_ACT_LAT])
            lng = float(row[COL_ACT_LNG])
        except (ValueError, IndexError):
            continue
        if lat == 0.0 and lng == 0.0:
            continue

        try:
            goldstein = float(row[COL_GOLDSTEIN])
        except (ValueError, IndexError):
            goldstein = -5.0

        date_str = row[COL_DATE][:8]
        try:
            occurred_at = datetime.strptime(date_str, "%Y%m%d").replace(
                tzinfo=timezone.utc).isoformat()
        except ValueError:
            occurred_at = datetime.now(timezone.utc).isoformat()

        location_name = row[COL_ACT_NAME].strip() or "Unknown location"
        source_url    = row[COL_SOURCE_URL].strip() if len(row) > COL_SOURCE_URL else ""
        event_id_raw  = row[COL_EVENT_ID].strip()
        eid = hashlib.sha256(f"gdelt-{event_id_raw}".encode()).hexdigest()[:16]
        label = CAMEO_LABELS.get(code, f"CAMEO {code}")

        events.append({
            "id":            eid,
            "title":         f"{label} — {location_name}",
            "description":   f"GDELT conflict event (CAMEO {code}). Source: {source_url[:100]}",
            "category":      "conflict",
            "lat":           lat,
            "lng":           lng,
            "location_name": location_name,
            "severity":      gdelt_severity(goldstein),
            "source_url":    source_url,
            "romania_impact": "none",
            "occurred_at":   occurred_at,
        })
    return events


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    rows = fetch_gdelt_export()
    if not rows:
        log.warning("No GDELT data fetched; skipping update")
        return

    new_events = parse_gdelt_events(rows)
    log.info("Parsed %d GDELT violence events", len(new_events))

    # Load existing GeoJSON
    geojson_path = OUTPUT_DIR / "events.geojson"
    existing = {"type": "FeatureCollection", "features": []}
    if geojson_path.exists():
        try:
            existing = json.loads(geojson_path.read_text())
        except Exception:
            pass

    existing_ids = {f["properties"]["id"] for f in existing.get("features", [])}

    new_features = []
    for ev in new_events:
        if ev["id"] in existing_ids:
            continue
        new_features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [ev["lng"], ev["lat"]]},
            "properties": {k: v for k, v in ev.items() if k not in ("lat", "lng")},
        })

    cutoff = (datetime.now(timezone.utc) - timedelta(days=3)).isoformat()
    all_features = new_features + existing.get("features", [])
    all_features = [f for f in all_features if f.get("properties", {}).get("occurred_at", "") >= cutoff]
    # Cap to avoid huge files; keep most recent
    all_features = all_features[:MAX_GDELT_EVENTS + 200]

    geojson_out = {"type": "FeatureCollection", "features": all_features}
    geojson_path.write_text(json.dumps(geojson_out, ensure_ascii=False, indent=2))
    log.info("events.geojson updated: %d total features", len(all_features))

    # Also append to events.json (timeline)
    events_path = OUTPUT_DIR / "events.json"
    existing_events: list[dict] = []
    if events_path.exists():
        try:
            existing_events = json.loads(events_path.read_text())
        except Exception:
            pass

    existing_event_ids = {e["id"] for e in existing_events}
    new_timeline = [e for e in new_events if e["id"] not in existing_event_ids]
    all_events = new_timeline + existing_events
    all_events.sort(key=lambda e: e.get("occurred_at", ""), reverse=True)
    all_events = [e for e in all_events if e.get("occurred_at", "") >= cutoff]
    all_events = all_events[:300]
    events_path.write_text(json.dumps(all_events, ensure_ascii=False, indent=2))
    log.info("events.json updated: %d total events", len(all_events))


if __name__ == "__main__":
    main()