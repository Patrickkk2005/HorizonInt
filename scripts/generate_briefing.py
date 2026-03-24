#!/usr/bin/env python3
"""
HorizonInt — Daily AI Briefing Generator
Runs daily at 06:00 UTC via GitHub Actions.
Loads top articles and generates a markdown intelligence briefing via AI API.
"""

import json
import logging
import os
import re
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

OUTPUT_DIR   = Path(os.getenv("OUTPUT_DIR", "public/data"))
TOP_ARTICLES = 30

BRIEFING_PROMPT = """\
You are a senior geopolitical intelligence analyst. Using the following {n} news articles \
from the past 24 hours, write a concise daily intelligence briefing.

Structure your briefing with these markdown sections:

## Executive Summary
2-3 sentences covering the most critical global developments.

## Key Conflict Situations
Brief bullets on active armed conflicts and their trajectory.

## Diplomatic Developments
Notable negotiations, agreements, or diplomatic incidents.

## Eastern Europe & Romania Watch
Any developments directly or indirectly affecting Romania, \
its neighbors (Moldova, Ukraine, Hungary, Serbia, Bulgaria), or NATO/EU security architecture.

## Economic & Sanctions Watch
Significant economic pressures, sanctions, or trade disruptions.

## 24-48 Hour Outlook
Concise assessment of what to watch in the near term.

---

Be factual, analytical, and concise. Do not speculate beyond what the articles support.
Use markdown formatting (bold for key entities, bullet points for lists).

ARTICLES:
{articles}
"""


def load_top_articles() -> list[dict]:
    path = OUTPUT_DIR / "articles.json"
    if not path.exists():
        log.error("articles.json not found at %s", path)
        return []
    articles: list[dict] = json.loads(path.read_text())
    # Sort by relevance then recency, pick top N
    articles.sort(key=lambda a: (
        a.get("relevance_score", 0),
        a.get("published_at", ""),
    ), reverse=True)
    return articles[:TOP_ARTICLES]


def format_articles_for_prompt(articles: list[dict]) -> str:
    lines = []
    for i, a in enumerate(articles, 1):
        lines.append(
            f"{i}. [{a['source_name']}] {a['title']}\n"
            f"   Category: {a['category']} | Region: {a['region']}\n"
            f"   {a.get('summary', '')[:300]}\n"
        )
    return "\n".join(lines)


def generate_briefing(articles: list[dict]) -> str:
    article_text = format_articles_for_prompt(articles)
    prompt = BRIEFING_PROMPT.format(n=len(articles), articles=article_text)

    ak = os.getenv("ANTHROPIC_API_KEY")
    if ak and HAS_ANTHROPIC:
        model = os.getenv("ANTHROPIC_MODEL", "claude-haiku-4-5-20251001")
        log.info("Generating briefing via Anthropic %s…", model)
        client = anthropic.Anthropic(api_key=ak)
        resp = client.messages.create(
            model=model,
            max_tokens=2048,
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
            max_tokens=2048,
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
