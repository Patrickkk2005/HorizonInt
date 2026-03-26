# HorizonInt

Real-time geopolitical intelligence dashboard with a Romania-centric focus. Aggregates global news, GDELT conflict events, and GDACS disaster alerts — classified and summarised by AI.

**Live:** [patrickkk2005.github.io/HorizonInt](https://patrickkk2005.github.io/HorizonInt)

## What it does

- Fetches 19 RSS feeds hourly, deduplicates, and classifies each article's Romania impact (`direct` / `economic` / `security` / `none`) using a keyword pre-filter and AI fallback
- Pulls GDELT conflict events and GDACS disaster alerts
- Generates a daily AI intelligence briefing at 06:00 UTC
- Renders everything on a Leaflet map with category filters, a heatmap toggle, and Romania arc lines
