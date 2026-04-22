#!/usr/bin/env python3
"""
HorizonInt — RSS Feed Fetcher
Runs hourly via GitHub Actions.
Fetches 19 RSS feeds, categorises articles, deduplicates, extracts geo-events,
classifies Romania impact via AI API, writes public/data/*.json
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
import re
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

try:
    from rapidfuzz import fuzz
    HAS_RAPIDFUZZ = True
except ImportError:
    HAS_RAPIDFUZZ = False
    logging.warning("rapidfuzz not installed; fuzzy dedup disabled")

try:
    import anthropic
    HAS_ANTHROPIC = True
except ImportError:
    HAS_ANTHROPIC = False

try:
    from openai import OpenAI
    HAS_OPENAI = True
except ImportError:
    HAS_OPENAI = False

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────

OUTPUT_DIR      = Path(os.getenv("OUTPUT_DIR", "docs/data"))
MAX_ARTICLES    = 100
MAX_EVENTS      = 400
RELEVANCE_THRESH = 0.35
FUZZY_THRESH    = 85
BATCH_SIZE      = 30
FEED_TIMEOUT    = 15   # seconds per feed

# ── RSS Feeds (~34) ───────────────────────────────────────────────────────────

RSS_FEEDS = [
    # Global / Western
    {"name": "BBC World",       "url": "http://feeds.bbci.co.uk/news/world/rss.xml",                      "region": "Global"},
    {"name": "Al Jazeera",      "url": "https://www.aljazeera.com/xml/rss/all.xml",                       "region": "Global"},
    {"name": "France 24",       "url": "https://www.france24.com/en/rss",                                  "region": "Europe"},
    {"name": "Deutsche Welle",  "url": "https://rss.dw.com/xml/rss-en-world",                             "region": "Europe"},
    {"name": "The Guardian",    "url": "https://www.theguardian.com/world/rss",                            "region": "Global"},
    {"name": "Reuters",         "url": "https://feeds.reuters.com/reuters/worldNews",                      "region": "Global"},
    {"name": "AP News",         "url": "https://rsshub.app/apnews/topics/world-news",                     "region": "Global"},
    {"name": "RFE/RL",          "url": "https://www.rferl.org/api/zpqosqosqesm",                          "region": "Eastern Europe"},
    {"name": "UN News",         "url": "https://news.un.org/feed/subscribe/en/news/all/rss.xml",          "region": "Global"},
    {"name": "ICRC",            "url": "https://www.icrc.org/en/rss/news",                                "region": "Global"},
    {"name": "Moscow Times",    "url": "https://www.themoscowtimes.com/rss/news",                         "region": "Russia"},
    {"name": "Middle East Eye", "url": "https://www.middleeasteye.net/rss",                               "region": "Middle East"},
    {"name": "Euronews",        "url": "https://www.euronews.com/rss?format=mrss&level=theme&name=news",  "region": "Europe"},
    {"name": "Politico EU",     "url": "https://www.politico.eu/feed/",                                   "region": "Europe"},
    # Romanian media
    {"name": "G4Media",         "url": "https://www.g4media.ro/feed",                                     "region": "Romania"},
    {"name": "Digi24",          "url": "https://www.digi24.ro/rss",                                       "region": "Romania"},
    {"name": "HotNews",         "url": "https://www.hotnews.ro/feed",                                     "region": "Romania"},
    {"name": "Romania Insider",  "url": "https://www.romania-insider.com/feed",                           "region": "Romania"},
    # Neighbor countries
    {"name": "Kyiv Independent", "url": "https://kyivindependent.com/feed/",                              "region": "Ukraine"},
    {"name": "Ukrinform EN",     "url": "https://www.ukrinform.net/rss/block-lastnews",                   "region": "Ukraine"},
    {"name": "Moldova.org EN",   "url": "https://www.moldova.org/en/feed/",                               "region": "Moldova"},
    {"name": "Balkan Insight",   "url": "https://balkaninsight.com/feed/",                                "region": "Balkans"},
    {"name": "Total Serbia News","url": "https://www.total-serbia-news.com/feed/",                        "region": "Balkans"},
    {"name": "Hungary Today",    "url": "https://hungarytoday.hu/feed/",                                  "region": "Hungary"},
    {"name": "Sofia Globe",      "url": "https://sofiaglobe.com/feed/",                                   "region": "Bulgaria"},
    # NATO / EU / Energy
    {"name": "NATO News",        "url": "https://www.nato.int/cps/en/natohq/news.rss",                    "region": "NATO/EU"},
    {"name": "EURACTIV East",    "url": "https://www.euractiv.com/sections/europe-s-east/feed/",          "region": "NATO/EU"},
    {"name": "Natural Gas World","url": "https://www.naturalgasworld.com/rss.xml",                        "region": "Energy"},
]

# ── Category Keywords ─────────────────────────────────────────────────────────

CATEGORY_KEYWORDS: dict[str, list[str]] = {
    "conflict": [
        "war", "attack", "airstrike", "air strike", "missile", "bomb", "bombing",
        "troops", "military", "combat", "assault", "invasion", "battle", "offensive",
        "shelling", "ceasefire", "casualties", "killed", "wounded", "sniper",
        "mortar", "rocket", "fighter jet", "artillery", "drone strike", "gunfire",
        "ambush", "siege", "blockade", "military operation", "ground offensive",
    ],
    "protests": [
        "protest", "demonstration", "riot", "unrest", "march", "rally", "strike",
        "uprising", "crackdown", "dissent", "activist", "opposition movement",
        "clashes", "water cannon", "tear gas", "detained activist", "civil unrest",
    ],
    "diplomacy": [
        "diplomacy", "summit", "treaty", "agreement", "negotiation", "talks",
        "envoy", "ambassador", "bilateral", "multilateral", "un security council",
        "foreign minister", "state visit", "accord", "memorandum", "diplomatic",
        "communique", "delegation", "mediation", "ceasefire talks",
    ],
    "sanctions": [
        "sanctions", "embargo", "blacklist", "ban", "freeze assets", "trade restriction",
        "export control", "import ban", "economic pressure", "financial penalty",
        "sanctioned", "targeted measures", "asset freeze",
    ],
    "elections": [
        "election", "vote", "ballot", "polling", "candidate", "campaign",
        "referendum", "inauguration", "parliament", "congress", "polling station",
        "electoral", "voter turnout", "rigging", "fraud", "runoff", "recount",
    ],
    "humanrights": [
        "human rights", "atrocity", "genocide", "persecution", "detention",
        "torture", "refugee", "displaced", "civilian", "war crimes", "accountability",
        "ethnic cleansing", "massacre", "prisoner", "abuse", "arbitrary arrest",
        "disappearance", "execution", "hostage", "famine", "starvation",
    ],
    "economy": [
        "economy", "gdp", "inflation", "recession", "trade", "investment",
        "currency", "debt", "budget", "tariff", "imf", "world bank", "fiscal",
        "monetary", "interest rate", "unemployment", "growth", "market", "bonds",
        "oil price", "energy crisis", "supply chain",
    ],
    "environment": [
        "climate", "environment", "floods", "drought", "wildfire", "deforestation",
        "emissions", "cop", "paris agreement", "pollution", "sea level", "carbon",
        "glacier", "biodiversity", "species", "ocean", "sustainability", "renewable",
    ],
    "technology": [
        "technology", "cyber", "hack", "hacking", "artificial intelligence", " ai ",
        "tech", "digital", "surveillance", "drone", "satellite", "spyware",
        "malware", "data breach", "disinformation", "deepfake", "5g", "quantum",
        "social media", "internet", "encryption",
    ],
    "disaster": [
        "earthquake", "tsunami", "hurricane", "typhoon", "cyclone", "flood",
        "volcanic", "disaster", "emergency", "evacuation", "eruption", "landslide",
        "avalanche", "famine", "disease outbreak", "epidemic", "pandemic",
        "magnitude", "richter", "death toll", "missing persons",
    ],
}

# ── City → Coordinates ────────────────────────────────────────────────────────

CITY_COORDS: dict[str, tuple[float, float]] = {
    # Middle East
    "baghdad": (33.3406, 44.4009), "mosul": (36.3350, 43.1189),
    "basra": (30.5085, 47.7804), "erbil": (36.1911, 44.0092),
    "tehran": (35.6892, 51.3890), "isfahan": (32.6546, 51.6680),
    "mashhad": (36.2605, 59.6168), "damascus": (33.5138, 36.2765),
    "aleppo": (36.2021, 37.1343), "idlib": (35.9310, 36.6348),
    "raqqa": (35.9518, 39.0064), "deir ez-zor": (35.3356, 40.1413),
    "kabul": (34.5553, 69.2075), "kandahar": (31.6257, 65.7075),
    "herat": (34.3482, 62.1998), "jalalabad": (34.4317, 70.4480),
    "riyadh": (24.6877, 46.7219), "jeddah": (21.5433, 39.1728),
    "dubai": (25.2048, 55.2708), "abu dhabi": (24.4539, 54.3773),
    "doha": (25.2867, 51.5333), "muscat": (23.5880, 58.3829),
    "kuwait city": (29.3759, 47.9774), "manama": (26.2235, 50.5876),
    "sanaa": (15.3694, 44.1910), "aden": (12.8007, 45.0373),
    "hodeidah": (14.7980, 42.9554), "amman": (31.9539, 35.9106),
    "beirut": (33.8938, 35.5018), "jerusalem": (31.7683, 35.2137),
    "tel aviv": (32.0853, 34.7818), "gaza": (31.5017, 34.4674),
    "ramallah": (31.9036, 35.2034), "ankara": (39.9334, 32.8597),
    "istanbul": (41.0082, 28.9784), "izmir": (38.4192, 27.1287),
    "nicosia": (35.1856, 33.3823),
    # South Caucasus / Central Asia
    "baku": (40.4093, 49.8671), "yerevan": (40.1872, 44.5152),
    "tbilisi": (41.6938, 44.8015), "tashkent": (41.2995, 69.2401),
    "almaty": (43.2220, 76.8512), "bishkek": (42.8746, 74.5698),
    "ashgabat": (37.9601, 58.3261), "dushanbe": (38.5598, 68.7738),
    "nur-sultan": (51.1801, 71.4460), "astana": (51.1801, 71.4460),
    # Russia / Eastern Europe
    "moscow": (55.7558, 37.6173), "st. petersburg": (59.9343, 30.3351),
    "saint petersburg": (59.9343, 30.3351), "novosibirsk": (54.9885, 82.9207),
    "kyiv": (50.4501, 30.5234), "kiev": (50.4501, 30.5234),
    "kharkiv": (49.9935, 36.2304), "odessa": (46.4825, 30.7233),
    "odesa": (46.4825, 30.7233), "mariupol": (47.0945, 37.5430),
    "donetsk": (48.0159, 37.8028), "luhansk": (48.5740, 39.3078),
    "zaporizhzhia": (47.8388, 35.1396), "kherson": (46.6354, 32.6169),
    "bakhmut": (48.5956, 37.9978), "avdiivka": (48.1383, 37.7542),
    "minsk": (53.9045, 27.5615), "warsaw": (52.2297, 21.0122),
    "krakow": (50.0647, 19.9450), "prague": (50.0755, 14.4378),
    "bratislava": (48.1486, 17.1077), "budapest": (47.4979, 19.0402),
    "vienna": (48.2082, 16.3738), "bucharest": (44.4268, 26.1025),
    "chisinau": (47.0105, 28.8638), "sofia": (42.6977, 23.3219),
    "belgrade": (44.8176, 20.4569), "sarajevo": (43.8563, 18.4131),
    "pristina": (42.6629, 21.1655), "skopje": (41.9981, 21.4254),
    "tirana": (41.3275, 19.8187), "zagreb": (45.8150, 15.9785),
    "ljubljana": (46.0569, 14.5058), "riga": (56.9460, 24.1059),
    "tallinn": (59.4370, 24.7536), "vilnius": (54.6872, 25.2797),
    "podgorica": (42.4304, 19.2594), "banja luka": (44.7739, 17.1908),
    # Western Europe
    "berlin": (52.5200, 13.4050), "munich": (48.1351, 11.5820),
    "frankfurt": (50.1109, 8.6821), "hamburg": (53.5753, 10.0153),
    "paris": (48.8566, 2.3522), "marseille": (43.2965, 5.3698),
    "lyon": (45.7640, 4.8357), "london": (51.5074, -0.1278),
    "manchester": (53.4808, -2.2426), "madrid": (40.4168, -3.7038),
    "barcelona": (41.3851, 2.1734), "rome": (41.9028, 12.4964),
    "milan": (45.4642, 9.1900), "naples": (40.8518, 14.2681),
    "amsterdam": (52.3676, 4.9041), "brussels": (50.8503, 4.3517),
    "zurich": (47.3769, 8.5417), "bern": (46.9480, 7.4474),
    "geneva": (46.2044, 6.1432), "lisbon": (38.7169, -9.1395),
    "athens": (37.9838, 23.7275), "stockholm": (59.3293, 18.0686),
    "oslo": (59.9139, 10.7522), "copenhagen": (55.6761, 12.5683),
    "helsinki": (60.1699, 24.9384), "reykjavik": (64.1355, -21.8954),
    "dublin": (53.3498, -6.2603), "valletta": (35.8997, 14.5147),
    "luxembourg": (49.6116, 6.1319), "vaduz": (47.1415, 9.5215),
    # Africa
    "cairo": (30.0444, 31.2357), "alexandria": (31.2001, 29.9187),
    "khartoum": (15.5007, 32.5599), "omdurman": (15.6452, 32.4804),
    "port sudan": (19.6158, 37.2164), "addis ababa": (9.0320, 38.7469),
    "nairobi": (-1.2921, 36.8219), "mombasa": (-4.0435, 39.6682),
    "dar es salaam": (-6.7924, 39.2083), "kampala": (0.3476, 32.5825),
    "kigali": (-1.9441, 30.0619), "bujumbura": (-3.3822, 29.3644),
    "kinshasa": (-4.4419, 15.2663), "brazzaville": (-4.2634, 15.2429),
    "luanda": (-8.8390, 13.2894), "harare": (-17.8252, 31.0335),
    "lusaka": (-15.3875, 28.3228), "maputo": (-25.9692, 32.5732),
    "johannesburg": (-26.2041, 28.0473), "cape town": (-33.9249, 18.4241),
    "durban": (-29.8587, 31.0218), "pretoria": (-25.7479, 28.2293),
    "abuja": (9.0579, 7.4951), "lagos": (6.5244, 3.3792),
    "kano": (12.0022, 8.5920), "accra": (5.6037, -0.1870),
    "dakar": (14.7167, -17.4677), "bamako": (12.6392, -8.0029),
    "ouagadougou": (12.3714, -1.5197), "niamey": (13.5137, 2.1098),
    "ndjamena": (12.1068, 15.0444), "n'djamena": (12.1068, 15.0444),
    "mogadishu": (2.0469, 45.3182), "djibouti": (11.5720, 43.1456),
    "asmara": (15.3229, 38.9251), "algiers": (36.7538, 3.0588),
    "tunis": (36.8065, 10.1815), "casablanca": (33.5731, -7.5898),
    "rabat": (34.0209, -6.8416), "tripoli": (32.8872, 13.1913),
    "benghazi": (32.1194, 20.0869), "freetown": (8.4657, -13.2317),
    "monrovia": (6.3000, -10.7969), "abidjan": (5.3600, -4.0083),
    "conakry": (9.5370, -13.6771), "bangui": (4.3612, 18.5550),
    "libreville": (0.4162, 9.4673), "malabo": (3.7500, 8.7833),
    "windhoek": (-22.5597, 17.0832), "gaborone": (-24.6282, 25.9231),
    "antananarivo": (-18.8792, 47.5079), "lilongwe": (-13.9626, 33.7741),
    "juba": (4.8517, 31.5825), "wau": (7.7009, 28.0008),
    # Asia
    "beijing": (39.9042, 116.4074), "shanghai": (31.2304, 121.4737),
    "guangzhou": (23.1291, 113.2644), "wuhan": (30.5928, 114.3055),
    "hong kong": (22.3193, 114.1694), "taipei": (25.0330, 121.5654),
    "tokyo": (35.6762, 139.6503), "osaka": (34.6937, 135.5023),
    "seoul": (37.5665, 126.9780), "pyongyang": (39.0194, 125.7381),
    "delhi": (28.6139, 77.2090), "new delhi": (28.6139, 77.2090),
    "mumbai": (19.0760, 72.8777), "kolkata": (22.5726, 88.3639),
    "bangalore": (12.9716, 77.5946), "chennai": (13.0827, 80.2707),
    "islamabad": (33.6844, 73.0479), "lahore": (31.5497, 74.3436),
    "karachi": (24.8607, 67.0011), "peshawar": (34.0151, 71.5249),
    "quetta": (30.1798, 66.9750), "dhaka": (23.8103, 90.4125),
    "chittagong": (22.3569, 91.7832), "kathmandu": (27.7172, 85.3240),
    "colombo": (6.9271, 79.8612), "male": (4.1755, 73.5093),
    "bangkok": (13.7563, 100.5018), "hanoi": (21.0285, 105.8542),
    "ho chi minh city": (10.8231, 106.6297), "phnom penh": (11.5564, 104.9282),
    "vientiane": (17.9757, 102.6331), "yangon": (16.8661, 96.1951),
    "naypyidaw": (19.7633, 96.0785), "kuala lumpur": (3.1390, 101.6869),
    "singapore": (1.3521, 103.8198), "jakarta": (-6.2088, 106.8456),
    "surabaya": (-7.2575, 112.7521), "manila": (14.5995, 120.9842),
    "cebu": (10.3157, 123.8854), "ulaanbaatar": (47.8864, 106.9057),
    "dhaka": (23.8103, 90.4125), "rangoon": (16.8661, 96.1951),
    "mandalay": (21.9588, 96.0891), "lashio": (22.9333, 97.7500),
    # Americas
    "washington": (38.9072, -77.0369), "washington dc": (38.9072, -77.0369),
    "new york": (40.7128, -74.0060), "los angeles": (34.0522, -118.2437),
    "miami": (25.7617, -80.1918), "chicago": (41.8781, -87.6298),
    "houston": (29.7604, -95.3698), "ottawa": (45.4215, -75.6972),
    "mexico city": (19.4326, -99.1332), "guadalajara": (20.6597, -103.3496),
    "havana": (23.1136, -82.3666), "bogota": (4.7110, -74.0721),
    "medellin": (6.2442, -75.5812), "cali": (3.4516, -76.5320),
    "caracas": (10.4806, -66.9036), "lima": (-12.0464, -77.0428),
    "quito": (-0.1807, -78.4678), "brasilia": (-15.7975, -47.8919),
    "rio de janeiro": (-22.9068, -43.1729), "sao paulo": (-23.5505, -46.6333),
    "buenos aires": (-34.6037, -58.3816), "santiago": (-33.4489, -70.6693),
    "montevideo": (-34.9011, -56.1645), "asuncion": (-25.2867, -57.6470),
    "la paz": (-16.5000, -68.1193), "port-au-prince": (18.5944, -72.3074),
    "santo domingo": (18.4861, -69.9312), "san jose": (9.9281, -84.0907),
    "panama city": (8.9824, -79.5199), "managua": (12.1364, -86.2514),
    "san salvador": (13.6929, -89.2182), "tegucigalda": (14.0650, -87.2067),
    "tegucigalpa": (14.0650, -87.2067), "guatemala city": (14.6349, -90.5069),
    # Oceania
    "canberra": (-35.2809, 149.1300), "sydney": (-33.8688, 151.2093),
    "melbourne": (-37.8136, 144.9631), "auckland": (-36.8509, 174.7645),
    "wellington": (-41.2865, 174.7762), "port moresby": (-9.4438, 147.1803),
}

# ── City → Geographic Region ───────────────────────────────────────────────────

_REGION_CITY_SETS: dict[str, list[str]] = {
    "ME": [
        "baghdad", "mosul", "basra", "erbil", "tehran", "isfahan", "mashhad",
        "damascus", "aleppo", "idlib", "raqqa", "deir ez-zor", "kabul", "kandahar",
        "herat", "jalalabad", "riyadh", "jeddah", "dubai", "abu dhabi", "doha",
        "muscat", "kuwait city", "manama", "sanaa", "aden", "hodeidah", "amman",
        "beirut", "jerusalem", "tel aviv", "gaza", "ramallah", "ankara", "istanbul",
        "izmir", "nicosia",
    ],
    "CA": [
        "baku", "yerevan", "tbilisi", "tashkent", "almaty", "bishkek", "ashgabat",
        "dushanbe", "nur-sultan", "astana",
    ],
    "EU": [
        "moscow", "st. petersburg", "saint petersburg", "novosibirsk", "kyiv", "kiev",
        "kharkiv", "odessa", "odesa", "mariupol", "donetsk", "luhansk", "zaporizhzhia",
        "kherson", "bakhmut", "avdiivka", "minsk", "warsaw", "krakow", "prague",
        "bratislava", "budapest", "vienna", "bucharest", "chisinau", "sofia",
        "belgrade", "sarajevo", "pristina", "skopje", "tirana", "zagreb", "ljubljana",
        "riga", "tallinn", "vilnius", "podgorica", "banja luka", "berlin", "munich",
        "frankfurt", "hamburg", "paris", "marseille", "lyon", "london", "manchester",
        "madrid", "barcelona", "rome", "milan", "naples", "amsterdam", "brussels",
        "zurich", "bern", "geneva", "lisbon", "athens", "stockholm", "oslo",
        "copenhagen", "helsinki", "reykjavik", "dublin", "valletta", "luxembourg",
        "vaduz",
    ],
    "AF": [
        "cairo", "alexandria", "khartoum", "omdurman", "port sudan", "addis ababa",
        "nairobi", "mombasa", "dar es salaam", "kampala", "kigali", "bujumbura",
        "kinshasa", "brazzaville", "luanda", "harare", "lusaka", "maputo",
        "johannesburg", "cape town", "durban", "pretoria", "abuja", "lagos", "kano",
        "accra", "dakar", "bamako", "ouagadougou", "niamey", "ndjamena", "n'djamena",
        "mogadishu", "djibouti", "asmara", "algiers", "tunis", "casablanca", "rabat",
        "tripoli", "benghazi", "freetown", "monrovia", "abidjan", "conakry", "bangui",
        "libreville", "malabo", "windhoek", "gaborone", "antananarivo", "lilongwe",
        "juba", "wau",
    ],
    "AS": [
        "beijing", "shanghai", "guangzhou", "wuhan", "hong kong", "taipei", "tokyo",
        "osaka", "seoul", "pyongyang", "delhi", "new delhi", "mumbai", "kolkata",
        "bangalore", "chennai", "islamabad", "lahore", "karachi", "peshawar",
        "quetta", "dhaka", "chittagong", "kathmandu", "colombo", "male", "bangkok",
        "hanoi", "ho chi minh city", "phnom penh", "vientiane", "yangon", "naypyidaw",
        "kuala lumpur", "singapore", "jakarta", "surabaya", "manila", "cebu",
        "ulaanbaatar", "rangoon", "mandalay", "lashio",
    ],
    "AM": [
        "washington", "washington dc", "new york", "los angeles", "miami", "chicago",
        "houston", "ottawa", "mexico city", "guadalajara", "havana", "bogota",
        "medellin", "cali", "caracas", "lima", "quito", "brasilia", "rio de janeiro",
        "sao paulo", "buenos aires", "santiago", "montevideo", "asuncion", "la paz",
        "port-au-prince", "santo domingo", "san jose", "panama city", "managua",
        "san salvador", "tegucigalda", "tegucigalpa", "guatemala city",
    ],
    "OC": ["canberra", "sydney", "melbourne", "auckland", "wellington", "port moresby"],
}

CITY_TO_REGION: dict[str, str] = {
    city: region
    for region, cities in _REGION_CITY_SETS.items()
    for city in cities
}

# Map feed source region labels → geo-region codes used above
_FEED_REGION_MAP: dict[str, str] = {
    "Middle East":   "ME",
    "Europe":        "EU",
    "Eastern Europe":"EU",
    "Russia":        "EU",
    "Africa":        "AF",
    "Asia":          "AS",
    "Romania":       "EU",
    "Ukraine":       "EU",
    "Moldova":       "EU",
    "Hungary":       "EU",
    "Bulgaria":      "EU",
    "Balkans":       "EU",
    "NATO/EU":       "EU",
    "Energy":        "EU",
}

# ── CAMEO Violence Codes (25) ──────────────────────────────────────────────────

CAMEO_VIOLENCE_CODES = {
    "145", "1451", "1452",           # Protest violently / riot
    "180",                           # Use unconventional violence
    "181",                           # Abduct / hijack / take hostage
    "182", "1821", "1822", "1823",   # Physically assault / torture / kill
    "183", "1831", "1832", "1833",   # Bombing / suicide / car / roadside
    "185", "186",                    # Attempt to / Assassinate
    "190", "191", "192",             # Military force / blockade / occupy
    "193", "194", "195", "196",      # Small arms / artillery / aerial / ceasefire violation
    "200", "201", "202", "203",      # Mass violence / expulsion / killings / ethnic cleansing
    "204",                           # WMD
}

# ── Helpers ───────────────────────────────────────────────────────────────────

def url_hash(url: str) -> str:
    norm = re.sub(r"[?#].*$", "", url.strip().lower())
    return hashlib.sha256(norm.encode()).hexdigest()[:20]


def normalize_title(title: str) -> str:
    return re.sub(r"\s+", " ", title.strip().lower())


def is_duplicate(new_url: str, new_title: str,
                  existing_hashes: set[str],
                  existing_titles: list[str]) -> bool:
    if url_hash(new_url) in existing_hashes:
        return True
    if HAS_RAPIDFUZZ:
        nt = normalize_title(new_title)
        for et in existing_titles:
            if fuzz.ratio(nt, et) > FUZZY_THRESH:
                return True
    return False


def categorize(text: str) -> str:
    tl = text.lower()
    best_cat, best_count = "other", 0
    for cat, keywords in CATEGORY_KEYWORDS.items():
        count = sum(1 for kw in keywords if kw in tl)
        if count > best_count:
            best_count, best_cat = count, cat
    return best_cat


def compute_relevance(text: str) -> float:
    tl = text.lower()
    all_kw = [kw for kws in CATEGORY_KEYWORDS.values() for kw in kws]
    hits = sum(1 for kw in all_kw if kw in tl)
    return min(1.0, hits / 6.0)


def extract_location(text: str, source_region: str | None = None) -> tuple[str, float, float] | None:
    tl = text.lower()
    matches: list[tuple[str, float, float]] = []
    for city, (lat, lng) in CITY_COORDS.items():
        if re.search(r'\b' + re.escape(city) + r'\b', tl):
            matches.append((city, lat, lng))
    if not matches:
        return None
    # With multiple matches, prefer the city whose region matches the article's source feed
    if source_region and len(matches) > 1:
        preferred_code = _FEED_REGION_MAP.get(source_region)
        if preferred_code:
            region_matches = [m for m in matches if CITY_TO_REGION.get(m[0]) == preferred_code]
            if region_matches:
                city, lat, lng = region_matches[0]
                return city.title(), lat, lng
    city, lat, lng = matches[0]
    return city.title(), lat, lng


def parse_date(entry) -> str:
    for attr in ("published_parsed", "updated_parsed"):
        val = getattr(entry, attr, None)
        if val:
            try:
                return datetime(*val[:6], tzinfo=timezone.utc).isoformat()
            except Exception:
                pass
    return datetime.now(timezone.utc).isoformat()


def entry_text(entry) -> str:
    summary = getattr(entry, "summary", "") or ""
    title   = getattr(entry, "title", "")  or ""
    return f"{title} {summary}"


# ── AI client ─────────────────────────────────────────────────────────────────

def get_ai_client():
    ak = os.getenv("ANTHROPIC_API_KEY")
    if ak and HAS_ANTHROPIC:
        model = os.getenv("ANTHROPIC_MODEL", "claude-haiku-4-5-20251001")
        return "anthropic", anthropic.Anthropic(api_key=ak), model
    ak = os.getenv("OPENAI_API_KEY")
    if ak and HAS_OPENAI:
        model = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
        return "openai", OpenAI(api_key=ak), model
    return None, None, None


# ── Hybrid Romania classifier ─────────────────────────────────────────────────

_DIRECT_KEYWORDS = {
    # Country / nationality
    "romania", "romanian", "romanians",
    # Capital and major cities (with and without diacritics)
    "bucharest", "bucurești",
    "cluj", "cluj-napoca",
    "timișoara", "timisoara",
    "iași", "iasi",
    "constanța", "constanta",
    "brașov", "brasov",
    "ploiești", "ploiesti",
    "galați", "galati",
    "craiova", "sibiu", "oradea", "arad", "bacău", "bacau",
    "suceava", "focșani", "focsani", "pitești", "pitesti",
    "târgu mureș", "targu mures", "brăila", "braila",
    # Moldova (closely tied to Romania — language, diaspora, EU accession)
    "chisinau", "chișinău", "moldovan",
    # Key Romanian state companies often mentioned by name in English press
    "petrom", "romgaz", "transgaz", "hidroelectrica", "banca transilvania",
    # Romanian political leaders / institutions
    "iohannis", "ciolacu", "ciuca", "cîțu", "citu",
    "romanian government", "romanian parliament", "romanian president",
    "romanian prime minister", "romanian pm",
    "psd", "pnl", "usr", "aur",          # major Romanian parties
    # Romanian military
    "romanian army", "romanian air force", "romanian navy",
    "romanian forces", "romanian troops", "romanian soldiers",
    # NATO installations in Romania
    "deveselu", "mihail kogalniceanu",
    # Black Sea / energy assets
    "romanian black sea", "neptun deep", "romanian eez",
    # Diaspora
    "romanian diaspora", "romanians abroad", "romanian workers",
}

_ECONOMIC_KEYWORDS = {
    # EU monetary / fiscal policy
    "ecb", "european central bank",
    "eu tariff", "eu trade", "eu budget",
    "cohesion fund", "structural fund", "recovery fund",
    "schengen", "euro adoption", "eurozone entry",
    # Energy — pipelines and prices
    "energy price", "gas price", "oil price", "lng price",
    "nord stream", "nordstream", "turkstream", "turk stream",
    "opec", "opec+",
    "eu energy", "energy union",
    "carbon border", "cbam",
    # Trade routes Romania depends on
    "black sea trade", "danube", "danube shipping",
    # Agriculture — Romania is a top EU grain/oilseed exporter
    "grain export", "wheat price", "corn price", "maize price",
    "sunflower oil", "sunflower price",
    "ukraine grain", "grain corridor", "grain deal",
    "fertilizer price", "fertiliser price",
    # Sanctions on Russia/Belarus directly affect Romanian trade and energy
    "sanctions on russia", "russian sanctions", "sanctions on belarus",
    "belarusian sanctions",
    # Macro conditions in Romania's top trade partners
    "german recession", "german economy", "german industry",
    "eu recession", "eurozone recession",
    "imf loan", "imf bailout",
    "eu inflation", "eurozone inflation",
    # Refugee/migration burden on public finances
    "ukrainian refugee", "refugee crisis europe",
    # Ukraine reconstruction spending (Romanian contractors, cross-border trade)
    "ukraine reconstruction",
    # Romania-specific fiscal / macro
    "romania imf", "romania credit rating", "romania budget deficit",
    "romanian budget", "romanian fiscal", "romanian economy",
    "romanian exports", "romanian imports",
    # EU recovery funds critical to Romania
    "pnrr", "national recovery plan",
    "eu funds romania", "cohesion romania",
    # Romania's offshore gas
    "neptun deep gas", "offshore gas romania",
    "romanian energy market",
    # Neighbor economic spillover
    "ukrainian grain glut", "moldova economic",
    "hungarian economy eu", "bulgarian economy",
}

_SECURITY_KEYWORDS = {
    # NATO
    "nato", "nato summit", "nato flank", "eastern flank",
    "nato ally", "nato member", "nato troops", "nato article 5",
    "nato enlargement", "nato expansion",
    # Ukraine conflict — geography close to Romania
    "ukraine war", "ukraine conflict", "ukraine front",
    "zelensky", "zelenskyy",
    "donbas", "donbass",
    "crimea",
    "odessa", "odesa",          # Black Sea port, ~200 km from Romanian border
    "zaporizhzhia", "zaporizhia",  # Nuclear plant — fallout risk for Romania
    "kherson",                  # Southern Ukraine, Black Sea region
    # Moldova / Transnistria
    "moldova", "transnistria", "transnistrian conflict",
    "gagauzia",                 # Separatist region of Moldova
    # Black Sea military
    "black sea fleet", "black sea security", "black sea navy",
    "russian navy", "snake island",
    # Balkans
    "balkans", "serbia", "kosovo", "bosnia", "north macedonia",
    # Russian military posture
    "russian military", "russian forces", "russian troops",
    "russian hybrid", "hybrid warfare", "hybrid attack",
    "wagner", "wagner group",
    # Belarus — Russia's forward staging area, NATO eastern flank
    "belarus", "lukashenko", "belarusian forces", "belarusian military",
    "kaliningrad",
    # Nuclear — Russia-specific framing
    "russian nuclear", "nuclear blackmail", "nuclear posture",
    "nuclear europe",
    # Air/missile defence relevant to Romania
    "patriot missile", "air defense system", "missile shield",
    "deveselu",         # NATO missile shield base in Romania
    # Energy as security vector
    "energy weapon", "gas cutoff", "gas blackmail",
    "energy dependence", "energy leverage",
    # Threats to Romanian territory / airspace
    "romanian airspace", "romanian territory",
    "black sea drone", "drone black sea",
    # Neighbor-specific security
    "hungarian veto", "orban nato",
    "serbian-nato", "serbia eu accession",
    "moldova nato", "moldova eu",
}


# ── Neighbor Country Keywords ─────────────────────────────────────────────────

NEIGHBOR_COUNTRY_KEYWORDS: dict[str, list[str]] = {
    "ua": [
        "ukraine", "ukrainian", "ukrainians",
        "kyiv", "kiev", "kharkiv", "odessa", "odesa", "lviv", "zaporizhzhia",
        "kherson", "mykolaiv", "dnipro", "mariupol", "donetsk", "luhansk",
        "sumy", "chernihiv", "poltava", "vinnytsia", "zhytomyr",
        "donbas", "donbass", "crimea", "azov sea", "azov",
        "bucha", "irpin", "bakhmut", "avdiivka", "chasiv yar",
        "zelensky", "zelenskyy", "zaluzhny", "syrsky",
        "verkhovna rada", "ukrinform",
        "grain corridor", "ukraine grain", "dnipro river",
    ],
    "md": [
        "moldova", "moldovan", "moldovans",
        "chisinau", "chișinău", "balti", "bălți",
        "transnistria", "transdniestria",
        "maia sandu", "igor dodon",
        "gagauzia", "prut river",
        "moldova gas", "moldovan gas",
    ],
    "hu": [
        "hungary", "hungarian", "hungarians",
        "budapest", "debrecen", "miskolc",
        "viktor orban", "orban", "orbán",
        "fidesz", "jobbik",
        "tisza river", "hungarian veto",
    ],
    "rs": [
        "serbia", "serbian", "serbs",
        "belgrade", "beograd", "novi sad", "nis",
        "vucic", "vučić", "aleksandar vucic",
        "sns", "vojvodina",
    ],
    "bg": [
        "bulgaria", "bulgarian", "bulgarians",
        "sofia", "plovdiv", "varna", "burgas",
        "borisov", "radev", "bulgarian lev",
    ],
    "energy": [
        "gas pipeline", "lng terminal", "lng import", "lng tanker",
        "nord stream", "nordstream", "turkstream", "turk stream",
        "neptun deep", "black sea gas",
        "romgaz", "petrom", "transgaz",
        "energy security europe", "eu energy",
        "gas transit ukraine", "ukraine gas transit",
        "natural gas price", "lng price", "spot gas",
        "interconnector", "danube corridor",
        "nabucco", "southstream",
    ],
    "nato": [
        "nato", "north atlantic treaty", "nato summit", "nato article 5",
        "nato eastern flank", "eastern flank", "nato member",
        "nato secretary general", "stoltenberg", "rutte",
        "nato troops", "allied forces", "collective defense",
        "deveselu", "mihail kogalniceanu",
        "nato air policing",
    ],
    "eu": [
        "european union", "european commission", "council of the eu",
        "eu parliament", "european parliament",
        "von der leyen", "eu enlargement", "eu accession",
        "schengen", "eurozone", "eu cohesion",
        "eu recovery fund", "recovery and resilience",
        "eu sanctions", "eu tariff", "eu trade",
        "pnrr",
    ],
}


def classify_neighbor_country(text: str) -> str:
    """Return the primary neighbor/topic tag for an article (rule-based, no AI)."""
    tl = text.lower()
    for country in ("ua", "md", "hu", "rs", "bg", "energy", "nato", "eu"):
        if any(kw in tl for kw in NEIGHBOR_COUNTRY_KEYWORDS[country]):
            return country
    return "other"


def rule_classify(title: str, summary: str) -> str | None:
    """Fast keyword pre-classification. Returns label or None if ambiguous."""
    tl = (title + " " + summary).lower()
    if any(kw in tl for kw in _DIRECT_KEYWORDS):
        return "direct"
    if any(kw in tl for kw in _SECURITY_KEYWORDS):
        return "security"
    if any(kw in tl for kw in _ECONOMIC_KEYWORDS):
        return "economic"
    return None


def classify_romania_impact_batch(articles: list[dict], client_type: str,
                                   client, model: str) -> list[str]:
    """Return a list of labels ('direct'|'economic'|'security'|'none') same order as articles."""
    items = [{"index": i, "title": a["title"], "summary": a.get("summary", "")}
             for i, a in enumerate(articles)]
    prompt = (
        "Classify how each news article impacts Romania. Romania is an EU/NATO member with a trade-dependent economy.\n"
        "For each article, respond with exactly one of: direct, economic, security, none\n\n"
        "Definitions:\n"
        "- direct: article explicitly mentions Romania\n"
        "- economic: article could meaningfully affect Romania's economy even without mentioning Romania — examples: EU energy policy, gas/oil price shocks, sanctions on Russia or Belarus (Romania depends on Black Sea trade and energy imports), grain/food price changes (Romania is a major exporter), ECB rate decisions, tariffs affecting EU trade, financial crises in major Romanian trade partners (Germany, Italy, Hungary), refugee/migration crises that burden Romanian public finances, disruption of Black Sea or Danube shipping routes\n"
        "- security: article involves a direct military or geopolitical threat relevant to Romania — NATO decisions, conflict in Ukraine or Moldova, Black Sea militarisation, Balkans instability\n"
        "- none: no meaningful Romania relevance — use this for articles about Asia, the Americas, Africa, Australia, domestic politics of non-adjacent countries, or topics with no plausible link to Romania's economy or security\n\n"
        "When in doubt, use 'none'. Do not over-classify.\n\n"
        f"Return a JSON array of {len(articles)} strings in the same order as input.\n\n"
        f"Articles:\n{json.dumps(items, ensure_ascii=False)}"
    )
    try:
        if client_type == "anthropic":
            resp = client.messages.create(
                model=model,
                max_tokens=512,
                messages=[{"role": "user", "content": prompt}],
            )
            raw = resp.content[0].text.strip()
        else:
            resp = client.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": prompt}],
                max_tokens=512,
            )
            raw = resp.choices[0].message.content.strip()

        # extract JSON array from response
        m = re.search(r"\[.*?\]", raw, re.DOTALL)
        if m:
            labels = json.loads(m.group())
            valid = {"direct", "economic", "security", "none"}
            return [l if l in valid else "none" for l in labels]
    except Exception as e:
        log.warning("Romania classification failed: %s", e)

    return ["none"] * len(articles)


# ── Feed Fetching ─────────────────────────────────────────────────────────────

def fetch_feed(feed_cfg: dict) -> list[dict]:
    log.info("Fetching %s ...", feed_cfg["name"])
    try:
        parsed = feedparser.parse(feed_cfg["url"], request_headers={
            "User-Agent": "HorizonInt/1.0 (+https://github.com) feedparser"
        })
    except Exception as e:
        log.warning("Feed error %s: %s", feed_cfg["name"], e)
        return []

    articles = []
    for entry in parsed.entries[:50]:
        url   = getattr(entry, "link", "") or ""
        title = getattr(entry, "title", "") or ""
        if not url or not title:
            continue
        summary = re.sub(r"<[^>]+>", "", getattr(entry, "summary", "") or "")[:500]
        text    = f"{title} {summary}"
        articles.append({
            "url":          url,
            "title":        title.strip(),
            "summary":      summary.strip(),
            "source_name":  feed_cfg["name"],
            "region":       feed_cfg["region"],
            "published_at": parse_date(entry),
            "_text":        text,
        })
    return articles


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # Load existing data
    articles_path = OUTPUT_DIR / "articles.json"
    existing: list[dict] = []
    if articles_path.exists():
        try:
            existing = json.loads(articles_path.read_text())
        except Exception:
            existing = []

    # Migrate legacy labels and backfill new fields on existing articles
    _valid_impacts = {"direct", "economic", "security", "none"}
    _valid_neighbors = {"ua", "md", "hu", "rs", "bg", "nato", "eu", "energy", "other"}
    for art in existing:
        if art.get("romania_impact") not in _valid_impacts:
            art["romania_impact"] = "none"
        if art.get("neighbor_country") not in _valid_neighbors:
            art["neighbor_country"] = classify_neighbor_country(
                art.get("title", "") + " " + art.get("summary", "")
            )

    existing_hashes = {url_hash(a["url"]) for a in existing}
    existing_titles = [normalize_title(a["title"]) for a in existing]

    # Fetch all feeds
    new_articles: list[dict] = []
    for feed_cfg in RSS_FEEDS:
        for raw in fetch_feed(feed_cfg):
            if is_duplicate(raw["url"], raw["title"], existing_hashes, existing_titles):
                continue
            cat = categorize(raw["_text"])
            rel = compute_relevance(raw["_text"])
            art = {
                "id":              url_hash(raw["url"]),
                "url":             raw["url"],
                "title":           raw["title"],
                "summary":         raw["summary"],
                "source_name":     raw["source_name"],
                "category":        cat,
                "region":          raw["region"],
                "published_at":    raw["published_at"],
                "relevance_score": round(rel, 3),
                "romania_impact":  "none",
                "neighbor_country": classify_neighbor_country(raw["_text"]),
            }
            new_articles.append(art)
            existing_hashes.add(url_hash(raw["url"]))
            existing_titles.append(normalize_title(raw["title"]))
        time.sleep(0.5)

    log.info("Found %d new articles", len(new_articles))

    # Classify Romania impact — hybrid: rules first, AI only for ambiguous
    if new_articles:
        # Pass 1: rule-based pre-classification
        ambiguous = []
        for art in new_articles:
            label = rule_classify(art["title"], art.get("summary", ""))
            if label is not None:
                art["romania_impact"] = label
            else:
                ambiguous.append(art)

        log.info(
            "Rule-classified %d articles; %d ambiguous → AI",
            len(new_articles) - len(ambiguous), len(ambiguous),
        )

        # Pass 2: AI for ambiguous articles only
        if ambiguous:
            client_type, client, model = get_ai_client()
            if client:
                log.info("Classifying %d ambiguous articles via %s (%s)…",
                         len(ambiguous), client_type, model)
                for i in range(0, len(ambiguous), BATCH_SIZE):
                    batch = ambiguous[i:i + BATCH_SIZE]
                    labels = classify_romania_impact_batch(batch, client_type, client, model)
                    for art, label in zip(batch, labels):
                        art["romania_impact"] = label
            else:
                log.warning("No AI API key found; ambiguous articles left as 'none'")

    # Merge + cap
    all_articles = new_articles + existing
    all_articles.sort(key=lambda a: a.get("published_at", ""), reverse=True)
    all_articles = all_articles[:MAX_ARTICLES]

    # Extract geo-events from high-relevance articles
    events_path = OUTPUT_DIR / "events.json"
    existing_events: list[dict] = []
    if events_path.exists():
        try:
            existing_events = json.loads(events_path.read_text())
        except Exception:
            existing_events = []

    event_ids = {e["id"] for e in existing_events}
    new_events: list[dict] = []
    geo_cats = {"conflict", "disaster", "protests", "humanrights"}

    for art in new_articles:
        if art["relevance_score"] < RELEVANCE_THRESH:
            continue
        if art["category"] not in geo_cats:
            continue
        # Require ≥2 keyword hits in the assigned category so a single stray keyword
        # (e.g. "rally" in a tourism article) can't promote an article to a map event.
        art_tl = (art["title"] + " " + art["summary"]).lower()
        cat_hits = sum(1 for kw in CATEGORY_KEYWORDS.get(art["category"], []) if kw in art_tl)
        if cat_hits < 2:
            continue
        loc = extract_location(art["title"] + " " + art["summary"], art["region"])
        if not loc:
            continue
        loc_name, lat, lng = loc
        sev = 3 if art["category"] == "conflict" else (2 if art["category"] in {"disaster", "humanrights"} else 1)
        eid = hashlib.sha256((art["id"] + loc_name).encode()).hexdigest()[:16]
        if eid in event_ids:
            continue
        event_ids.add(eid)
        new_events.append({
            "id":            eid,
            "title":         art["title"][:120],
            "description":   art["summary"][:300],
            "category":      art["category"],
            "lat":           lat,
            "lng":           lng,
            "location_name": loc_name,
            "severity":      sev,
            "source_url":    art["url"],
            "romania_impact": art["romania_impact"],
            "occurred_at":   art["published_at"],
        })

    cutoff = (datetime.now(timezone.utc) - timedelta(days=3)).isoformat()
    all_events = new_events + existing_events
    all_events.sort(key=lambda e: e.get("occurred_at", ""), reverse=True)
    all_events = [e for e in all_events if e.get("occurred_at", "") >= cutoff]
    all_events = all_events[:MAX_EVENTS]

    # Build GeoJSON (events only — GDELT appends separately)
    geojson_path = OUTPUT_DIR / "events.geojson"
    existing_geojson = {"type": "FeatureCollection", "features": []}
    if geojson_path.exists():
        try:
            existing_geojson = json.loads(geojson_path.read_text())
        except Exception:
            pass

    existing_geo_ids = {f["properties"]["id"] for f in existing_geojson.get("features", [])}
    new_features = []
    for ev in new_events:
        if ev["id"] not in existing_geo_ids:
            new_features.append({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [ev["lng"], ev["lat"]]},
                "properties": {k: v for k, v in ev.items() if k not in ("lat", "lng")},
            })

    all_features = new_features + existing_geojson.get("features", [])
    all_features = [f for f in all_features if f.get("properties", {}).get("occurred_at", "") >= cutoff]
    all_features = all_features[:MAX_EVENTS]

    # Stats
    cat_counts: dict[str, int] = {}
    for a in all_articles:
        cat_counts[a["category"]] = cat_counts.get(a["category"], 0) + 1
    regions = list({a["region"] for a in all_articles[:100]})

    neighbor_activity: dict[str, int] = {k: 0 for k in ("ua", "md", "hu", "rs", "bg", "nato", "eu", "energy", "other")}
    for a in all_articles:
        nc = a.get("neighbor_country", "other")
        neighbor_activity[nc] = neighbor_activity.get(nc, 0) + 1

    romania_impact_counts: dict[str, int] = {"direct": 0, "economic": 0, "security": 0, "none": 0}
    for a in all_articles:
        ri = a.get("romania_impact", "none")
        romania_impact_counts[ri] = romania_impact_counts.get(ri, 0) + 1

    energy_alerts = sum(
        1 for a in all_articles
        if a.get("neighbor_country") == "energy" and a.get("romania_impact") != "none"
    )

    # Write files
    (OUTPUT_DIR / "articles.json").write_text(
        json.dumps(all_articles, ensure_ascii=False, indent=2))
    (OUTPUT_DIR / "events.json").write_text(
        json.dumps(all_events, ensure_ascii=False, indent=2))
    (OUTPUT_DIR / "events.geojson").write_text(
        json.dumps({"type": "FeatureCollection", "features": all_features},
                   ensure_ascii=False, indent=2))
    (OUTPUT_DIR / "stats.json").write_text(json.dumps({
        "article_count":        len(all_articles),
        "event_count":          len(all_events),
        "last_updated":         datetime.now(timezone.utc).isoformat(),
        "active_regions":       sorted(regions),
        "categories":           cat_counts,
        "neighbor_activity":    neighbor_activity,
        "romania_impact_counts": romania_impact_counts,
        "energy_alerts":        energy_alerts,
    }, ensure_ascii=False, indent=2))

    log.info("Done. %d articles, %d events written to %s",
             len(all_articles), len(all_events), OUTPUT_DIR)


if __name__ == "__main__":
    main()