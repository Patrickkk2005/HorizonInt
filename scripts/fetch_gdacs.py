#!/usr/bin/env python3
"""
HorizonInt — GDACS Disaster Event Fetcher
Fetches the GDACS RSS feed (free, no API key) for major global disaster alerts.
Covers: earthquakes, tropical cyclones, floods, volcanoes, tsunamis, droughts, wildfires.
Merges into public/data/events.geojson and events.json
"""

import feedparser
import hashlib
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
from datetime import datetime, timezone, timedelta
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

OUTPUT_DIR = Path(os.getenv("OUTPUT_DIR", "docs/data"))
GDACS_RSS  = "https://www.gdacs.org/xml/rss.xml"
MAX_EVENTS = 60

ALERT_SEVERITY = {"green": 1, "orange": 2, "red": 3}

EVENT_CATEGORIES = {
    "EQ": "disaster",   # Earthquake
    "TC": "disaster",   # Tropical Cyclone
    "FL": "disaster",   # Flood
    "VO": "disaster",   # Volcano
    "TS": "disaster",   # Tsunami
    "DR": "environment", # Drought
    "WF": "environment", # Wildfire
}

EVENT_TYPE_LABELS = {
    "EQ": "Earthquake", "TC": "Tropical Cyclone", "FL": "Flood",
    "VO": "Volcanic Eruption", "TS": "Tsunami", "DR": "Drought", "WF": "Wildfire",
}


def _float(val, default=0.0) -> float:
    try:
        return float(val)
    except (TypeError, ValueError):
        return default


def parse_gdacs_events(feed) -> list[dict]:
    events = []
    for entry in feed.entries[:MAX_EVENTS]:
        # GDACS uses gdacs: namespace fields exposed by feedparser
        lat = _float(entry.get("gdacs_latitude") or entry.get("geo_lat"))
        lng = _float(entry.get("gdacs_longitude") or entry.get("geo_long"))
        if lat == 0.0 and lng == 0.0:
            continue

        alert_level = (entry.get("gdacs_alertlevel") or "green").lower().strip()
        severity    = ALERT_SEVERITY.get(alert_level, 1)
        event_type  = (entry.get("gdacs_eventtype") or "").upper().strip()
        category    = EVENT_CATEGORIES.get(event_type, "disaster")
        type_label  = EVENT_TYPE_LABELS.get(event_type, "Disaster")
        country     = (entry.get("gdacs_country") or "").strip()

        title   = (entry.get("title") or f"{type_label} alert").strip()
        summary = (entry.get("summary") or "").strip()[:300]
        link    = entry.get("link", "")

        try:
            val = entry.get("published_parsed") or entry.get("updated_parsed")
            occurred_at = (
                datetime(*val[:6], tzinfo=timezone.utc).isoformat()
                if val else datetime.now(timezone.utc).isoformat()
            )
        except Exception:
            occurred_at = datetime.now(timezone.utc).isoformat()

        eid = hashlib.sha256(f"gdacs-{link}".encode()).hexdigest()[:16]

        events.append({
            "id":            eid,
            "title":         title,
            "description":   summary,
            "category":      category,
            "lat":           lat,
            "lng":           lng,
            "location_name": country or title,
            "severity":      severity,
            "source_url":    link,
            "romania_impact": "none",
            "occurred_at":   occurred_at,
        })
    return events


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    log.info("Fetching GDACS RSS feed…")
    feed = feedparser.parse(
        GDACS_RSS,
        request_headers={"User-Agent": "HorizonInt/1.0 (+https://github.com) feedparser"},
    )
    if not feed.entries:
        log.warning("No GDACS entries received; skipping")
        return

    new_events = parse_gdacs_events(feed)
    log.info("Parsed %d GDACS disaster events", len(new_events))

    # ── Merge into events.geojson ─────────────────────────────────────────────
    geojson_path = OUTPUT_DIR / "events.geojson"
    existing_geo = {"type": "FeatureCollection", "features": []}
    if geojson_path.exists():
        try:
            existing_geo = json.loads(geojson_path.read_text())
        except Exception:
            pass

    existing_ids = {f["properties"]["id"] for f in existing_geo.get("features", [])}
    new_features = [
        {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [ev["lng"], ev["lat"]]},
            "properties": {k: v for k, v in ev.items() if k not in ("lat", "lng")},
        }
        for ev in new_events if ev["id"] not in existing_ids
    ]

    cutoff = (datetime.now(timezone.utc) - timedelta(days=3)).isoformat()
    all_features = new_features + existing_geo.get("features", [])
    all_features = [f for f in all_features if f.get("properties", {}).get("occurred_at", "") >= cutoff]
    all_features = all_features[:400]
    geojson_path.write_text(
        json.dumps({"type": "FeatureCollection", "features": all_features},
                   ensure_ascii=False, indent=2)
    )
    log.info("events.geojson updated: %d total features", len(all_features))

    # ── Merge into events.json (timeline) ────────────────────────────────────
    events_path = OUTPUT_DIR / "events.json"
    existing_events: list[dict] = []
    if events_path.exists():
        try:
            existing_events = json.loads(events_path.read_text())
        except Exception:
            pass

    existing_event_ids = {e["id"] for e in existing_events}
    new_timeline = [e for e in new_events if e["id"] not in existing_event_ids]
    all_events = (new_timeline + existing_events)
    all_events.sort(key=lambda e: e.get("occurred_at", ""), reverse=True)
    all_events = [e for e in all_events if e.get("occurred_at", "") >= cutoff]
    all_events = all_events[:400]
    events_path.write_text(json.dumps(all_events, ensure_ascii=False, indent=2))
    log.info("events.json updated: %d total events", len(all_events))


if __name__ == "__main__":
    main()