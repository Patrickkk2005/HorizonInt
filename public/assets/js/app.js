/* ── HorizonInt — Main App ───────────────────────────────────────────────── */

const DATA_BASE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
  ? './data'
  : './data';  // same for GH Pages — served relative to index.html

const CATEGORY_COLORS = {
  conflict:    '#ef4444',
  protests:    '#f97316',
  diplomacy:   '#3b82f6',
  sanctions:   '#a855f7',
  humanrights: '#ec4899',
  elections:   '#22c55e',
  economy:     '#84cc16',
  environment: '#14b8a6',
  technology:  '#06b6d4',
  disaster:    '#f59e0b',
  other:       '#6b7280',
};

const SEVERITY_RADII = { 1: 5, 2: 8, 3: 12 };

// ── State ─────────────────────────────────────────────────────────────────────
let activeCategory = 'all';
let leafletMap     = null;
let mapLayerGroup  = null;
let allArticles    = [];
let allEvents      = [];

// ── UTC Clock ─────────────────────────────────────────────────────────────────
function startClock() {
  function tick() {
    const now = new Date();
    const hh = String(now.getUTCHours()).padStart(2, '0');
    const mm = String(now.getUTCMinutes()).padStart(2, '0');
    const ss = String(now.getUTCSeconds()).padStart(2, '0');
    document.getElementById('utc-clock').textContent = `${hh}:${mm}:${ss} UTC`;
  }
  tick();
  setInterval(tick, 1000);
}

// ── Data Fetching ─────────────────────────────────────────────────────────────
async function fetchJSON(path) {
  try {
    const r = await fetch(path + '?t=' + Date.now());
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    console.warn(`Failed to load ${path}:`, e);
    return null;
  }
}

function relativeTime(isoStr) {
  if (!isoStr) return '';
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function catColor(cat) {
  return CATEGORY_COLORS[cat] || CATEGORY_COLORS.other;
}

function romaniaLabel(impact) {
  const labels = { direct: 'RO Direct', neighbor: 'RO Neighbor', regional: 'RO Regional' };
  return labels[impact] || null;
}

// ── Stats ─────────────────────────────────────────────────────────────────────
function renderStats(stats) {
  if (!stats) return;
  const ac = document.getElementById('article-count');
  const ec = document.getElementById('event-count');
  const lu = document.getElementById('last-updated');
  if (ac) ac.textContent = stats.article_count?.toLocaleString() ?? '–';
  if (ec) ec.textContent = stats.event_count?.toLocaleString() ?? '–';
  if (lu && stats.last_updated) {
    lu.textContent = relativeTime(stats.last_updated);
    lu.title = new Date(stats.last_updated).toUTCString();
  }
}

// ── Briefing ──────────────────────────────────────────────────────────────────
function renderBriefing(briefing) {
  const content = document.getElementById('briefing-content');
  const dateel  = document.getElementById('briefing-date');
  const meta    = document.getElementById('briefing-meta');
  if (!content) return;

  if (!briefing || !briefing.content) {
    content.innerHTML = '<p class="empty-state">No briefing available yet.</p>';
    return;
  }

  content.innerHTML = marked.parse(briefing.content);

  if (dateel && briefing.date) dateel.textContent = briefing.date;

  if (meta) {
    const parts = [];
    if (briefing.model_used)    parts.push(`Model: ${briefing.model_used}`);
    if (briefing.article_count) parts.push(`${briefing.article_count} articles analysed`);
    if (briefing.generated_at)  parts.push(relativeTime(briefing.generated_at));
    meta.textContent = parts.join(' · ');
  }
}

// ── News Feed ─────────────────────────────────────────────────────────────────
function renderFeed(articles) {
  allArticles = articles || [];
  const list = document.getElementById('feed-list');
  const countEl = document.getElementById('feed-count');
  if (!list) return;

  if (!allArticles.length) {
    list.innerHTML = '<p class="empty-state">No articles loaded. Workflows run hourly.</p>';
    return;
  }

  list.innerHTML = '';
  const frag = document.createDocumentFragment();

  allArticles.forEach(art => {
    const el = document.createElement('div');
    el.className = 'feed-item';
    el.dataset.cat = art.category || 'other';

    const color  = catColor(art.category);
    const roTag  = romaniaLabel(art.romania_impact);
    const roHtml = roTag ? `<span class="romania-tag">${roTag}</span>` : '';

    el.innerHTML = `
      <div class="feed-item-title">${escHtml(art.title)}</div>
      <div class="feed-item-meta">
        <span class="cat-badge" style="--badge-color:${color}">${art.category || 'other'}</span>
        <span class="feed-dot"></span>
        <span class="feed-source">${escHtml(art.source_name || '')}</span>
        <span class="feed-dot"></span>
        <span class="feed-time">${relativeTime(art.published_at)}</span>
        ${art.region ? `<span class="feed-dot"></span><span class="feed-region">${escHtml(art.region)}</span>` : ''}
        ${roHtml}
      </div>`;

    el.addEventListener('click', () => {
      if (art.url) window.open(art.url, '_blank', 'noopener');
    });

    frag.appendChild(el);
  });

  list.appendChild(frag);
  applyFilter();

  const visible = allArticles.filter(
    a => activeCategory === 'all' || a.category === activeCategory
  ).length;
  if (countEl) countEl.textContent = `${visible.toLocaleString()} articles`;
}

// ── Event Timeline ────────────────────────────────────────────────────────────
function renderTimeline(events) {
  allEvents = events || [];
  const list = document.getElementById('timeline-list');
  if (!list) return;

  if (!allEvents.length) {
    list.innerHTML = '<p class="empty-state">No geo-events yet. Workflows run hourly.</p>';
    return;
  }

  list.innerHTML = '';
  const frag = document.createDocumentFragment();

  allEvents.forEach(ev => {
    const el = document.createElement('div');
    el.className = 'timeline-item';
    el.dataset.cat = ev.category || 'conflict';

    const color   = catColor(ev.category);
    const sevNum  = ev.severity || 1;
    const roTag   = romaniaLabel(ev.romania_impact);
    const roHtml  = roTag ? `<span class="romania-tag">${roTag}</span>` : '';

    el.style.setProperty('--item-color', color);

    el.innerHTML = `
      <div class="timeline-title">${escHtml(ev.title || '')}</div>
      <div class="timeline-desc">${escHtml(ev.description || '')}</div>
      <div class="timeline-meta">
        <span class="severity-badge sev-${sevNum}">SEV ${sevNum}</span>
        <span class="feed-dot"></span>
        <span class="timeline-location">📍 ${escHtml(ev.location_name || '')}</span>
        <span class="feed-dot"></span>
        <span class="feed-time">${relativeTime(ev.occurred_at)}</span>
        ${roHtml}
      </div>`;

    el.addEventListener('click', () => {
      if (ev.source_url) window.open(ev.source_url, '_blank', 'noopener');
    });

    frag.appendChild(el);
  });

  list.appendChild(frag);
  applyFilter();
}

// ── Map ───────────────────────────────────────────────────────────────────────
function initMap() {
  if (leafletMap) return;

  leafletMap = L.map('map', {
    center: [20, 10],
    zoom: 2,
    zoomControl: true,
    attributionControl: true,
    minZoom: 1,
    maxZoom: 10,
  });

  L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 19,
    }
  ).addTo(leafletMap);

  mapLayerGroup = L.layerGroup().addTo(leafletMap);
}

function renderMap(geojson) {
  if (!leafletMap || !mapLayerGroup) return;
  mapLayerGroup.clearLayers();

  const features = geojson?.features || [];
  if (!features.length) return;

  features.forEach(feat => {
    const props = feat.properties || {};
    const [lng, lat] = feat.geometry?.coordinates || [0, 0];
    if (!lat && !lng) return;

    const cat    = props.category || 'other';
    const color  = catColor(cat);
    const radius = SEVERITY_RADII[props.severity] || 5;

    // Romania impact → dashed yellow ring behind the marker
    if (props.romania_impact && props.romania_impact !== 'none') {
      L.circleMarker([lat, lng], {
        radius:    radius + 5,
        color:     '#facc15',
        weight:    2,
        dashArray: '5 4',
        fill:      false,
        opacity:   0.85,
      }).addTo(mapLayerGroup);
    }

    // Main marker
    const marker = L.circleMarker([lat, lng], {
      radius:      radius,
      color:       color,
      fillColor:   color,
      fillOpacity: 0.65,
      weight:      1.5,
      opacity:     0.9,
    });

    const roLabel = romaniaLabel(props.romania_impact);
    const popup = `
      <div class="popup-title">${escHtml(props.title || '')}</div>
      <div class="popup-loc">📍 ${escHtml(props.location_name || '')}</div>
      <div class="popup-time">${relativeTime(props.occurred_at)}</div>
      ${roLabel ? `<div style="margin-top:4px"><span class="romania-tag">${roLabel}</span></div>` : ''}
      ${props.source_url ? `<a class="popup-link" href="${escHtml(props.source_url)}" target="_blank" rel="noopener">→ Source</a>` : ''}
    `;
    marker.bindPopup(popup);
    marker.addTo(mapLayerGroup);
  });
}

// ── Category Filter ───────────────────────────────────────────────────────────
function applyFilter() {
  // Feed
  document.querySelectorAll('.feed-item').forEach(el => {
    el.classList.toggle('hidden',
      activeCategory !== 'all' && el.dataset.cat !== activeCategory);
  });
  // Timeline
  document.querySelectorAll('.timeline-item').forEach(el => {
    el.classList.toggle('hidden',
      activeCategory !== 'all' && el.dataset.cat !== activeCategory);
  });
  // Map
  if (leafletMap && mapLayerGroup) {
    // Re-render map with filtered features
    const geojsonEl = window.__cachedGeojson;
    if (geojsonEl) {
      const filtered = {
        ...geojsonEl,
        features: activeCategory === 'all'
          ? geojsonEl.features
          : geojsonEl.features.filter(f => f.properties?.category === activeCategory),
      };
      renderMap(filtered);
    }
  }
  // Update feed count
  const countEl = document.getElementById('feed-count');
  if (countEl) {
    const vis = allArticles.filter(
      a => activeCategory === 'all' || a.category === activeCategory
    ).length;
    countEl.textContent = `${vis.toLocaleString()} articles`;
  }
}

function setupFilters() {
  document.querySelectorAll('.cat-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeCategory = btn.dataset.cat;
      applyFilter();
    });
  });
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function escHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Boot ──────────────────────────────────────────────────────────────────────
async function init() {
  startClock();
  setupFilters();
  initMap();

  // Parallel fetch all data
  const [stats, briefing, articles, events, geojson] = await Promise.all([
    fetchJSON(`${DATA_BASE}/stats.json`),
    fetchJSON(`${DATA_BASE}/briefing.json`),
    fetchJSON(`${DATA_BASE}/articles.json`),
    fetchJSON(`${DATA_BASE}/events.json`),
    fetchJSON(`${DATA_BASE}/events.geojson`),
  ]);

  // Cache geojson for filter re-renders
  window.__cachedGeojson = geojson;

  renderStats(stats);
  renderBriefing(briefing);
  renderFeed(articles);
  renderTimeline(events);
  renderMap(geojson);
}

document.addEventListener('DOMContentLoaded', init);
