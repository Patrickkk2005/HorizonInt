#!/usr/bin/env python3
"""
HorizonInt — Daily AI Briefing Generator
Loads top articles and generates a Romania-first intelligence briefing via AI API.
"""

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
import sys
from datetime import datetime, timezone
from pathlib import Path

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

OUTPUT_DIR   = Path(os.getenv("OUTPUT_DIR", "docs/data"))
TOP_ARTICLES = 40

BRIEFING_PROMPT = """\
You are a senior intelligence analyst at a Romania-focused geopolitical monitoring center. \
Your primary audience is Romanian decision-makers and analysts tracking threats and opportunities \
from Romania's immediate neighbourhood and the NATO/EU strategic environment.

GEOPOLITICAL CONTEXT YOU MUST APPLY:
- Romania is a NATO member on the Alliance's eastern flank, bordering Ukraine (north-east, ~650 km) \
  and Moldova (east). This makes it a front-line state for any conflict escalation.
- Romania's Black Sea coastline (Constanța, Năvodari) is strategically vital for NATO maritime \
  operations and EU grain export routes via the Sulina Channel (Danube delta).
- Romania hosts two NATO installations: the Deveselu Aegis Ashore missile shield base and \
  Mihail Kogălniceanu air base (rotational US/NATO forces). Any upgrade or threat to these is \
  first-tier news.
- Romania completed Schengen land-border accession (January 2025) and is pursuing eurozone \
  entry — EU monetary policy and fiscal rules directly affect its macro outlook.
- NEPTUN DEEP: Romania's offshore Black Sea gas field (OMV Petrom + Romgaz joint venture). \
  First gas expected 2027. Any disruption, regulatory change, or Black Sea security threat \
  is directly economically relevant.
- Neighbor watch priority order: Ukraine (active war, shared ~650 km border) → Moldova \
  (energy dependency, Transnistrian frozen conflict) → Hungary (NATO/EU friction, ethnic \
  minority issues with Romanian Hungarians in Transylvania) → Serbia (EU candidate, swing \
  state between EU and Russia) → Bulgaria (shared Black Sea, Danube, NATO ally).
- Energy security: Ukraine gas transit to Moldova ended December 2024; Romania is the \
  fallback supplier. LNG import capacity at Constanța and BRUA pipeline interconnects are \
  strategic assets.
- Romania's 2024 presidential election was annulled after first round due to Russian \
  interference findings. A re-run was held in May 2025. Domestic political instability \
  combined with external pressure is a core vulnerability.

Using the following {n} news articles, write a structured daily intelligence briefing. \
Be analytical, concise, and Romania-first in your framing. Use **bold** for key entities \
and locations. Use bullet points for lists.

---

## EXECUTIVE SUMMARY
2-3 sentences on the single most critical development for Romania today.

## NEIGHBOR WATCH

### Ukraine
Key developments in/about Ukraine with direct Romania-relevance (front-line shifts, \
Black Sea security, energy transit, refugee flows). If no relevant articles, write \
"No significant new developments."

### Moldova
Developments in Moldova, Transnistria, or the Prut border area. Energy situation, \
Russian pressure signals, EU accession progress.

### Hungary
NATO/EU friction points, bilateral Romania-Hungary issues (Transylvanian Hungarians, \
Schengen cooperation, energy deals with Russia).

### Serbia
EU accession status, Kosovo escalation risk, Serbia-Russia ties and implications for \
NATO's southern flank.

### Bulgaria
Black Sea cooperation, energy infrastructure, Bulgarian domestic political instability.

## NATO / EU WATCH
Alliance posture changes, deployments to the eastern flank, Article 5 discussions, \
EU sanctions or enlargement moves with Romania relevance.

## ENERGY SECURITY
Gas prices, pipeline politics (TurkStream, NEPTUN DEEP, Transgaz interconnectors), \
LNG market moves, Black Sea energy infrastructure.

## DOMESTIC ROMANIA
Romanian government decisions, fiscal/economic data, judicial or anti-corruption \
developments, political stability signals.

## GLOBAL CONTEXT
2-3 bullets on global events indirectly relevant to Romania's strategic position \
(US policy shifts, Middle East energy disruption, major power signalling).

## 24-48 HOUR OUTLOOK
3 bullet points: what to watch, ranked by Romania-relevance.

---

Be factual and analytical. Do not speculate beyond what the articles support. \
If a section has no relevant articles, write "No significant developments." and move on.

ARTICLES:
{articles}
"""


def ro_priority_score(a: dict) -> float:
    impact_bonus  = {"direct": 3.0, "security": 2.0, "economic": 1.5, "none": 0.0}
    neighbor_bonus = {
        "ua": 1.5, "md": 1.2, "nato": 1.2, "eu": 1.0,
        "hu": 0.8, "rs": 0.6, "bg": 0.6, "energy": 1.0, "other": 0.0,
    }
    base = a.get("relevance_score", 0)
    ri   = impact_bonus.get(a.get("romania_impact", "none"), 0)
    nc   = neighbor_bonus.get(a.get("neighbor_country", "other"), 0)
    return base + ri + nc


def load_top_articles() -> list[dict]:
    path = OUTPUT_DIR / "articles.json"
    if not path.exists():
        log.error("articles.json not found at %s", path)
        return []
    articles: list[dict] = json.loads(path.read_text())
    articles.sort(key=ro_priority_score, reverse=True)
    return articles[:TOP_ARTICLES]


def format_articles_for_prompt(articles: list[dict]) -> str:
    lines = []
    for i, a in enumerate(articles, 1):
        nc = a.get("neighbor_country", "other")
        ri = a.get("romania_impact", "none")
        lines.append(
            f"{i}. [{a['source_name']}] {a['title']}\n"
            f"   Category: {a['category']} | Neighbor: {nc} | RO Impact: {ri}\n"
            f"   {a.get('summary', '')[:300]}\n"
        )
    return "\n".join(lines)


def generate_briefing(articles: list[dict]) -> tuple[str, str]:
    article_text = format_articles_for_prompt(articles)
    prompt = BRIEFING_PROMPT.format(n=len(articles), articles=article_text)

    ak = os.getenv("ANTHROPIC_API_KEY")
    if ak and HAS_ANTHROPIC:
        model = os.getenv("ANTHROPIC_MODEL", "claude-haiku-4-5-20251001")
        log.info("Generating briefing via Anthropic %s…", model)
        client = anthropic.Anthropic(api_key=ak)
        resp = client.messages.create(
            model=model,
            max_tokens=2800,
            messages=[{"role": "user", "content": prompt}],
        )
        return resp.content[0].text.strip(), model

    ak = os.getenv("OPENAI_API_KEY")
    if ak and HAS_OPENAI:
        model = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
        log.info("Generating briefing via OpenAI %s…", model)
        client = OpenAI(api_key=ak)
        resp = client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            max_tokens=2800,
        )
        return resp.choices[0].message.content.strip(), model

    log.error("No AI API key configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.")
    sys.exit(1)


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    articles = load_top_articles()
    if not articles:
        log.error("No articles available. Run fetch_feeds.py first.")
        sys.exit(1)

    log.info("Generating briefing from %d articles…", len(articles))
    content, model_used = generate_briefing(articles)

    now = datetime.now(timezone.utc)
    briefing = {
        "date":          now.strftime("%Y-%m-%d"),
        "content":       content,
        "article_count": len(articles),
        "generated_at":  now.isoformat(),
        "model_used":    model_used,
    }

    out = OUTPUT_DIR / "briefing.json"
    out.write_text(json.dumps(briefing, ensure_ascii=False, indent=2))
    log.info("Briefing written to %s", out)


if __name__ == "__main__":
    main()
