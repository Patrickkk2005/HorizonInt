/* ── HorizonInt — App v3.0 ──────────────────────────────────────────────────── */

const SELF_HOSTED_API = 'https://horizon.n8n-xpert.online';

const DATA_BASE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
  ? './data'
  : `${SELF_HOSTED_API}/data`;

const CATEGORY_COLORS = {
  conflict:    '#ef4444',
  protests:    '#f97316',
  diplomacy:   '#60a5fa',
  sanctions:   '#c084fc',
  humanrights: '#f472b6',
  elections:   '#4ade80',
  economy:     '#a3e635',
  environment: '#2dd4bf',
  technology:  '#22d3ee',
  disaster:    '#fbbf24',
  other:       '#6b7280',
};

const NEIGHBOR_COLORS = {
  ua:     '#60a5fa',
  md:     '#a78bfa',
  hu:     '#34d399',
  rs:     '#f87171',
  bg:     '#fb923c',
  nato:   '#38bdf8',
  energy: '#facc15',
};

const NEIGHBOR_META = {
  ua:     { name: 'Ukraine',  sub: 'Neighbor' },
  md:     { name: 'Moldova',  sub: 'Neighbor' },
  hu:     { name: 'Hungary',  sub: 'Neighbor' },
  rs:     { name: 'Serbia',   sub: 'Neighbor' },
  bg:     { name: 'Bulgaria', sub: 'Neighbor' },
  nato:   { name: 'NATO/EU',  sub: 'Alliance' },
  energy: { name: 'Energy',   sub: 'Sector' },
};

const SEVERITY_RADII = { 1: 5, 2: 8, 3: 12 };
const BUCHAREST = [44.4268, 26.1025];

const NEIGHBOR_CAPITALS = {
  ua: { name: 'Kyiv',     coords: [50.4501, 30.5234] },
  md: { name: 'Chișinău', coords: [47.0105, 28.8638] },
  hu: { name: 'Budapest', coords: [47.4979, 19.0402] },
  rs: { name: 'Belgrade', coords: [44.8176, 20.4569] },
  bg: { name: 'Sofia',    coords: [42.6977, 23.3219] },
};

// ── State ─────────────────────────────────────────────────────────────────────
let activeCategory     = 'all';
let activeNeighbor     = null;
let activeFeedTab      = 'all';
let searchQuery        = '';
let leafletMap         = null;
let mapLayerGroup      = null;
let heatLayer          = null;
let arcLayerGroup      = null;
let neighborCapsLayer  = null;
let heatActive         = false;
let arcsActive         = false;
let neighborCapsActive = false;
let allArticles        = [];
let allEvents          = [];

// ── Clock ─────────────────────────────────────────────────────────────────────
function startClock() {
  function tick() {
    const now = new Date();
    const hh = String(now.getUTCHours()).padStart(2, '0');
    const mm = String(now.getUTCMinutes()).padStart(2, '0');
    const ss = String(now.getUTCSeconds()).padStart(2, '0');
    const el = document.getElementById('clock');
    if (el) el.textContent = `${hh}:${mm}:${ss}`;
  }
  tick();
  setInterval(tick, 1000);
}

// ── Counter animation ─────────────────────────────────────────────────────────
function animateCounter(el, target, duration = 900) {
  if (!el) return;
  const start = performance.now();
  const from  = parseInt(el.textContent.replace(/,/g, '')) || 0;
  function step(ts) {
    const progress = Math.min((ts - start) / duration, 1);
    const eased    = 1 - Math.pow(1 - progress, 3);
    el.textContent = Math.round(from + (target - from) * eased).toLocaleString();
    if (progress < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// ── Sparklines ────────────────────────────────────────────────────────────────
function generateSparkline(svgEl, color) {
  if (!svgEl) return;
  const pts = Array.from({ length: 10 }, () => Math.random() * 13 + 2);
  const w = 64, h = 18, max = Math.max(...pts);
  const coords = pts.map((v, i) =>
    `${(i / (pts.length - 1)) * w},${h - (v / max) * (h - 3) - 1}`
  ).join(' ');
  svgEl.innerHTML =
    `<polyline points="${coords}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" opacity="0.7"/>`;
}

// ── Ticker ────────────────────────────────────────────────────────────────────
function renderTicker(articles) {
  const ticker = document.getElementById('ticker');
  if (!ticker || !articles.length) return;

  const items = articles.slice(0, 20).map(a => {
    const color   = CATEGORY_COLORS[a.category] || CATEGORY_COLORS.other;
    const roMark  = (a.romania_impact && a.romania_impact !== 'none') ? '🟡 ' : '';
    const srcText = a.source_name ? ` · ${escHtml(a.source_name)}` : '';
    return `<span class="tick-item">
      <span class="tick-tag" style="--tag-c:${color}">${(a.category || 'news').toUpperCase()}</span>
      <span class="tick-text">${roMark}${escHtml(a.title)}</span>
      <span class="tick-src">${srcText}</span>
      <span class="tick-dot"></span>
    </span>`;
  }).join('');

  ticker.innerHTML = items + items;
}

// ── Threat Index ──────────────────────────────────────────────────────────────
function updateThreatIndex(events) {
  const levelEl = document.getElementById('threat-level');
  const barEl   = document.getElementById('threat-bar');
  if (!levelEl || !events.length) return;

  const sev3  = events.filter(e => (e.severity || 1) >= 3).length;
  const sev2  = events.filter(e => (e.severity || 1) === 2).length;
  const score = Math.min(100, Math.round((sev3 * 3 + sev2 * 1) / events.length * 34));

  let level, pos;
  if      (score < 18)  { level = 'LOW';      pos = '12%'; }
  else if (score < 38)  { level = 'GUARDED';  pos = '32%'; }
  else if (score < 62)  { level = 'ELEVATED'; pos = '55%'; }
  else if (score < 82)  { level = 'HIGH';     pos = '75%'; }
  else                  { level = 'CRITICAL'; pos = '92%'; }

  levelEl.textContent = level;
  if (barEl) barEl.style.setProperty('--threat-pos', pos);
}

// ── Data fetching ─────────────────────────────────────────────────────────────
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
  if (mins < 1)   return 'just now';
  if (mins < 60)  return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)   return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function catColor(cat) {
  return CATEGORY_COLORS[cat] || CATEGORY_COLORS.other;
}

function romaniaLabel(impact) {
  return { direct: 'RO Direct', economic: 'RO Econ', security: 'RO Sec' }[impact] || null;
}

// ── Stats ─────────────────────────────────────────────────────────────────────
function renderStats(stats, articles) {
  if (!stats) return;

  const artCount = stats.article_count || 0;
  const evCount  = stats.event_count   || 0;
  const roCount  = (articles || []).filter(
    a => a.romania_impact && a.romania_impact !== 'none'
  ).length;

  animateCounter(document.getElementById('kpi-articles'), artCount);
  animateCounter(document.getElementById('kpi-events'),   evCount);
  animateCounter(document.getElementById('kpi-ro'),       roCount);

  generateSparkline(document.getElementById('spark-articles'), '#60a5fa');
  generateSparkline(document.getElementById('spark-events'),   '#f97316');
  generateSparkline(document.getElementById('spark-ro'),       '#facc15');

  // Romania impact side stats
  const ri = stats.romania_impact_counts || {};
  document.querySelectorAll('.ii[data-impact]').forEach(el => {
    const n = el.querySelector('.ii-n');
    if (n) n.textContent = ri[el.dataset.impact] ?? '–';
  });

  // Last updated
  const updateVal  = document.getElementById('si-update-val');
  const updateNote = document.getElementById('si-update-note');
  if (stats.last_updated) {
    if (updateVal)  updateVal.textContent  = relativeTime(stats.last_updated);
    if (updateNote) updateNote.textContent = new Date(stats.last_updated).toUTCString().slice(0, 25);
  }

  renderNeighborSidebar(stats);
}

// ── Category rows (sidebar) ───────────────────────────────────────────────────
function renderCategoryRows(articles) {
  const container = document.getElementById('cat-rows');
  if (!container) return;

  const counts = {};
  (articles || []).forEach(a => {
    const c = a.category || 'other';
    counts[c] = (counts[c] || 0) + 1;
  });

  const cats = [
    ['conflict', 'Conflict'], ['protests', 'Protests'], ['diplomacy', 'Diplomacy'],
    ['sanctions', 'Sanctions'], ['humanrights', 'Human Rights'], ['elections', 'Elections'],
    ['economy', 'Economy'], ['environment', 'Environment'],
    ['technology', 'Technology'], ['disaster', 'Disaster'],
  ];

  container.innerHTML = cats.map(([key, label]) =>
    `<div class="cat-row${activeCategory === key ? ' active' : ''}" data-cat="${key}">
      <span class="cat-swatch" style="--c:${catColor(key)}"></span>
      <span class="cat-name">${label}</span>
      <span class="cat-n">${counts[key] || 0}</span>
    </div>`
  ).join('');

  container.querySelectorAll('.cat-row').forEach(row => {
    row.addEventListener('click', () => {
      const cat = row.dataset.cat;
      activeCategory = (activeCategory === cat) ? 'all' : cat;
      renderCategoryRows(articles);
      applyAllFilters();
    });
  });
}

// ── Neighbor list (sidebar) ───────────────────────────────────────────────────
function renderNeighborSidebar(stats) {
  const container = document.getElementById('neighbor-list');
  if (!container) return;

  const na        = stats?.neighbor_activity || {};
  const neighbors = ['ua', 'md', 'hu', 'rs', 'bg', 'nato', 'energy'];

  container.innerHTML = neighbors.map(k => {
    const color = NEIGHBOR_COLORS[k];
    const meta  = NEIGHBOR_META[k];
    const n     = na[k] || 0;
    const flag  = k === 'energy' ? '⚡' : k.toUpperCase();
    return `<div class="neighbor${activeNeighbor === k ? ' active' : ''}" data-neighbor="${k}" style="--nc:${color}">
      <span class="nei-flag">${flag}</span>
      <div class="nei-name">${meta.name}<span class="nei-sub">${meta.sub}</span></div>
      <div class="nei-val">
        <span class="nei-n">${n}</span>
        <svg class="nei-trend" viewBox="0 0 34 14" preserveAspectRatio="none"></svg>
      </div>
    </div>`;
  }).join('');

  // Neighbor sparklines
  container.querySelectorAll('.nei-trend').forEach((svg, i) => {
    const color = NEIGHBOR_COLORS[neighbors[i]];
    const pts   = Array.from({ length: 6 }, () => Math.random() * 10 + 2);
    const w = 34, h = 14, max = Math.max(...pts);
    const coords = pts.map((v, j) =>
      `${(j / (pts.length - 1)) * w},${h - (v / max) * (h - 2) - 1}`
    ).join(' ');
    svg.innerHTML = `<polyline points="${coords}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" opacity="0.8"/>`;
  });

  // Top region for briefing side
  const top = neighbors.slice(0, 5).reduce((best, k) =>
    (na[k] || 0) > (na[best] || 0) ? k : best, 'ua');
  const topEl = document.getElementById('si-top-region');
  if (topEl) topEl.textContent = NEIGHBOR_META[top]?.name || top.toUpperCase();

  container.querySelectorAll('.neighbor').forEach(el => {
    el.addEventListener('click', () => {
      const nb = el.dataset.neighbor;
      activeNeighbor = (activeNeighbor === nb) ? null : nb;
      renderNeighborSidebar(stats);
      applyAllFilters();
    });
  });
}

// ── Region bars ───────────────────────────────────────────────────────────────
function renderRegionBars(stats) {
  const container = document.getElementById('region-bars');
  if (!container) return;

  const na    = stats?.neighbor_activity || {};
  const total = Math.max(1, Object.values(na).reduce((s, v) => s + v, 0));

  const regions = [
    { key: 'ua',     label: 'Ukraine'  },
    { key: 'md',     label: 'Moldova'  },
    { key: 'nato',   label: 'NATO/EU'  },
    { key: 'energy', label: 'Energy'   },
    { key: 'hu',     label: 'Hungary'  },
    { key: 'rs',     label: 'Serbia'   },
    { key: 'bg',     label: 'Bulgaria' },
  ];

  container.innerHTML = regions.map(r => {
    const n   = na[r.key] || 0;
    const pct = Math.round(n / total * 100);
    const col = NEIGHBOR_COLORS[r.key];
    return `<div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
        <span style="font-size:12px;color:var(--text)">${r.label}</span>
        <span style="font-family:var(--f-mono);font-size:10px;color:var(--text-dim)">${pct}% <span style="color:var(--text-xdim)">(${n})</span></span>
      </div>
      <div style="height:5px;border-radius:99px;background:var(--bg-3)">
        <div style="width:${pct}%;height:100%;border-radius:99px;background:${col};opacity:0.8;transition:width .6s ease"></div>
      </div>
    </div>`;
  }).join('');
}

// ── Briefing ──────────────────────────────────────────────────────────────────
function renderBriefing(briefing) {
  const content = document.getElementById('briefing-content');
  if (!content) return;

  if (!briefing || !briefing.content) {
    content.innerHTML = '<p style="color:var(--text-xdim);font-size:12px;">No briefing available yet. Run generate_briefing.py to generate one.</p>';
    return;
  }

  content.innerHTML = marked.parse(briefing.content);

  const kickerDate = document.getElementById('briefing-date-text');
  if (kickerDate) {
    const dateLabel = briefing.date
      ? `Daily Intelligence Briefing · ${briefing.date}`
      : 'Daily Intelligence Briefing';
    kickerDate.textContent = dateLabel;
  }

  const genTime = document.getElementById('briefing-gen-time');
  if (genTime && briefing.generated_at) {
    const d  = new Date(briefing.generated_at);
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    genTime.textContent = `GENERATED ${hh}:${mm} UTC`;
  }

  const tagsEl = document.getElementById('briefing-tags');
  if (tagsEl && briefing.article_count) {
    tagsEl.innerHTML = `<span class="chip" style="--c:var(--ro)">RO BRIEFING · ${briefing.article_count} sources</span>`;
  }
}

// ── Feed ──────────────────────────────────────────────────────────────────────
function buildFeedItem(art) {
  const el = document.createElement('div');
  el.className   = 'feed-item';
  el.dataset.cat      = art.category || 'other';
  el.dataset.neighbor = art.neighbor_country || 'other';
  el.dataset.roImpact = art.romania_impact   || 'none';

  if (art.romania_impact && art.romania_impact !== 'none') el.classList.add('ro');

  const color    = catColor(art.category);
  const nc       = art.neighbor_country;
  const ncColor  = nc && nc !== 'other' ? (NEIGHBOR_COLORS[nc] || null) : null;
  const roLabel  = romaniaLabel(art.romania_impact);
  const roTag    = roLabel ? `<span class="tag ro">${roLabel}</span>` : '';
  const ncTag    = ncColor
    ? `<span class="tag" style="--c:${ncColor}">${nc === 'energy' ? '⚡' : nc.toUpperCase()}</span>`
    : '';

  el.innerHTML = `
    <div class="feed-title">${escHtml(art.title)}</div>
    <div class="feed-meta">
      <span class="tag" style="--c:${color}">${(art.category || 'news').toUpperCase()}</span>
      <span class="feed-src">${escHtml(art.source_name || '')}</span>
      <span class="feed-time">${relativeTime(art.published_at)}</span>
      ${roTag}${ncTag}
    </div>`;

  el.addEventListener('click', () => {
    if (art.url) window.open(art.url, '_blank', 'noopener');
  });
  return el;
}

function renderFeed(articles) {
  allArticles = articles || [];
  const list  = document.getElementById('feed-list');
  if (!list) return;

  list.innerHTML = '';
  if (!allArticles.length) {
    list.innerHTML = '<p class="empty-state">No articles loaded yet.</p>';
    return;
  }

  const frag = document.createDocumentFragment();
  allArticles.forEach(a => frag.appendChild(buildFeedItem(a)));
  list.appendChild(frag);

  applyAllFilters();
}

// ── Timeline ──────────────────────────────────────────────────────────────────
function renderTimeline(events) {
  allEvents = events || [];
  const list = document.getElementById('timeline-list');
  if (!list) return;

  if (!allEvents.length) {
    list.innerHTML = '<p class="empty-state">No geo-events yet.</p>';
    return;
  }

  list.innerHTML = '';
  const frag = document.createDocumentFragment();

  allEvents.forEach(ev => {
    const el     = document.createElement('div');
    el.className = 'tl-item';
    el.dataset.cat = ev.category || 'conflict';

    const color  = catColor(ev.category);
    const sevNum = ev.severity || 1;
    const roTag  = romaniaLabel(ev.romania_impact)
      ? `<span class="tag ro">${romaniaLabel(ev.romania_impact)}</span>`
      : '';

    let timeStr = '–', dayStr = '';
    if (ev.occurred_at) {
      const d = new Date(ev.occurred_at);
      timeStr = `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
      dayStr  = `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
    }

    el.innerHTML = `
      <div class="tl-gutter">
        <div class="tl-time">${timeStr}<br><span style="font-size:9px;color:var(--text-xdim)">${dayStr}</span></div>
        <div class="tl-node" style="--c:${color}"></div>
      </div>
      <div class="tl-body">
        <div class="tl-title">${escHtml(ev.title || '')}</div>
        <div class="tl-desc">${escHtml(ev.description || '')}</div>
        <div class="tl-meta">
          <span class="sev sev-${sevNum}">SEV ${sevNum}</span>
          <span style="font-size:10.5px;color:var(--text-dim)">📍 ${escHtml(ev.location_name || '')}</span>
          ${roTag}
        </div>
      </div>`;

    el.addEventListener('click', () => {
      if (ev.source_url) window.open(ev.source_url, '_blank', 'noopener');
    });
    frag.appendChild(el);
  });

  list.appendChild(frag);

  const countEl = document.getElementById('timeline-new-count');
  if (countEl) countEl.textContent = `● ${allEvents.length} events`;

  applyAllFilters();
}

// ── Map ───────────────────────────────────────────────────────────────────────
function initMap() {
  if (leafletMap) return;

  leafletMap = L.map('map', {
    center: [20, 10], zoom: 2,
    zoomControl: true, attributionControl: true,
    minZoom: 1, maxZoom: 10,
    scrollWheelZoom: true,
  });

  // Leaflet measures the container at init; in a flex/grid layout the height may
  // not be resolved yet. Two rAF frames guarantees the browser has painted.
  requestAnimationFrame(() => requestAnimationFrame(() => leafletMap.invalidateSize()));

  // Re-measure whenever the container is resized (e.g. window resize, panel toggle).
  if (window.ResizeObserver) {
    new ResizeObserver(() => leafletMap.invalidateSize()).observe(
      document.getElementById('map')
    );
  }

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd', maxZoom: 19,
  }).addTo(leafletMap);

  mapLayerGroup = L.layerGroup().addTo(leafletMap);

  fetch(`${DATA_BASE}/romania.geojson`)
    .then(r => r.ok ? r.json() : null)
    .then(geojson => {
      if (!geojson) return;
      L.geoJSON(geojson, {
        style: { color: '#facc15', weight: 2, opacity: 0.6,
          fillColor: '#facc15', fillOpacity: 0.04, dashArray: '5 4' },
        interactive: false,
      }).addTo(leafletMap);
    })
    .catch(() => {});
}

function toggleHeatmap() {
  if (!window.__cachedGeojson) return;
  const btn = document.querySelector('.tgl[data-toggle="heat"]');
  heatActive = !heatActive;
  if (heatActive) {
    const pts = (window.__cachedGeojson.features || [])
      .filter(f => f.geometry)
      .map(f => {
        const [lng, lat] = f.geometry.coordinates;
        return [lat, lng, (f.properties.severity || 1) / 3];
      });
    heatLayer = L.heatLayer(pts, {
      radius: 30, blur: 22, maxZoom: 6,
      gradient: { 0.3: '#3b82f6', 0.6: '#f97316', 1.0: '#ef4444' },
    }).addTo(leafletMap);
    btn?.classList.add('on');
  } else {
    if (heatLayer) { leafletMap.removeLayer(heatLayer); heatLayer = null; }
    btn?.classList.remove('on');
  }
}

function toggleArcs() {
  if (!window.__cachedGeojson) return;
  const btn = document.querySelector('.tgl[data-toggle="arcs"]');
  arcsActive = !arcsActive;
  if (arcsActive) {
    arcLayerGroup = L.layerGroup().addTo(leafletMap);
    (window.__cachedGeojson.features || [])
      .filter(f => f.properties?.romania_impact && f.properties.romania_impact !== 'none' && f.geometry)
      .forEach(f => {
        const [lng, lat] = f.geometry.coordinates;
        L.polyline([BUCHAREST, [lat, lng]], {
          color: '#facc15', weight: 1.5, opacity: 0.55, dashArray: '5 6',
        }).addTo(arcLayerGroup);
      });
    L.circleMarker(BUCHAREST, {
      radius: 6, color: '#facc15', fillColor: '#facc15', fillOpacity: 0.9, weight: 2,
    }).bindPopup('<div class="popup-title">Bucharest, Romania</div>').addTo(arcLayerGroup);
    btn?.classList.add('on');
  } else {
    if (arcLayerGroup) { arcLayerGroup.remove(); arcLayerGroup = null; }
    btn?.classList.remove('on');
  }
}

function toggleNeighborCaps() {
  const btn = document.querySelector('.tgl[data-toggle="caps"]');
  neighborCapsActive = !neighborCapsActive;
  if (neighborCapsActive) {
    neighborCapsLayer = L.layerGroup().addTo(leafletMap);
    L.circleMarker(BUCHAREST, {
      radius: 9, color: '#facc15', fillColor: '#facc15', fillOpacity: 0.9, weight: 2,
    }).bindPopup('<div class="popup-title">Bucharest, Romania</div>').addTo(neighborCapsLayer);

    Object.entries(NEIGHBOR_CAPITALS).forEach(([code, cap]) => {
      L.circleMarker(cap.coords, {
        radius: 7, color: '#facc15', fillColor: '#facc15', fillOpacity: 0.3, weight: 2,
      }).bindPopup(`<div class="popup-title">${cap.name}</div><div class="popup-loc">${code.toUpperCase()}</div>`)
        .addTo(neighborCapsLayer);
      L.polyline([BUCHAREST, cap.coords], {
        color: '#facc15', weight: 1.5, opacity: 0.4, dashArray: '6 5',
      }).addTo(neighborCapsLayer);
    });
    btn?.classList.add('on');
  } else {
    if (neighborCapsLayer) { neighborCapsLayer.remove(); neighborCapsLayer = null; }
    btn?.classList.remove('on');
  }
}

function renderMap(geojson) {
  if (!leafletMap || !mapLayerGroup) return;
  mapLayerGroup.clearLayers();

  const features = geojson?.features || [];
  if (!features.length) return;

  const bounds = [];
  features.forEach(feat => {
    const props        = feat.properties || {};
    const [lng, lat]   = feat.geometry?.coordinates || [0, 0];
    if (!lat && !lng) return;
    bounds.push([lat, lng]);

    const color  = catColor(props.category);
    const radius = SEVERITY_RADII[props.severity] || 5;

    if ((props.severity || 1) >= 3) {
      L.marker([lat, lng], {
        icon: L.divIcon({
          className: '',
          html: `<div class="pulse-ring" style="--ring-color:${color}"></div>`,
          iconSize: [32, 32], iconAnchor: [16, 16],
        }),
        interactive: false, zIndexOffset: -100,
      }).addTo(mapLayerGroup);
    }

    if (['direct', 'economic', 'security'].includes(props.romania_impact)) {
      L.circleMarker([lat, lng], {
        radius: radius + 5, color: '#facc15', weight: 2,
        dashArray: '5 4', fill: false, opacity: 0.85,
      }).addTo(mapLayerGroup);
    }

    const marker = L.circleMarker([lat, lng], {
      radius, color, fillColor: color, fillOpacity: 0.65, weight: 1.5, opacity: 0.9,
    });

    const roLabel = romaniaLabel(props.romania_impact);
    marker.bindPopup(`
      <div class="popup-title">${escHtml(props.title || '')}</div>
      <div class="popup-loc">📍 ${escHtml(props.location_name || '')}</div>
      <div class="popup-time">${relativeTime(props.occurred_at)}</div>
      ${roLabel ? `<div style="margin-top:4px;color:#facc15;font-size:11px">${roLabel}</div>` : ''}
      ${props.source_url ? `<a class="popup-link" href="${escHtml(props.source_url)}" target="_blank" rel="noopener">→ Source</a>` : ''}
    `);
    marker.addTo(mapLayerGroup);
  });

  if (!window.__mapFit && bounds.length) {
    leafletMap.fitBounds(bounds, { padding: [30, 30], maxZoom: 4 });
    window.__mapFit = true;
  }

  if (heatActive && heatLayer) {
    leafletMap.removeLayer(heatLayer);
    heatLayer = null; heatActive = false;
    toggleHeatmap();
  }
}

// ── Filters ───────────────────────────────────────────────────────────────────
function applyAllFilters() {
  const q = searchQuery.toLowerCase();

  document.querySelectorAll('.feed-item').forEach(el => {
    const catMatch    = activeCategory === 'all' || el.dataset.cat === activeCategory;
    const nbMatch     = !activeNeighbor || el.dataset.neighbor === activeNeighbor;
    const tabMatch    = activeFeedTab === 'all'
      || (activeFeedTab === 'ro'    && el.dataset.roImpact !== 'none')
      || (activeFeedTab === 'world' && el.dataset.roImpact === 'none');
    const searchMatch = !q || el.textContent.toLowerCase().includes(q);
    el.classList.toggle('hidden', !(catMatch && nbMatch && tabMatch && searchMatch));
  });

  document.querySelectorAll('.tl-item').forEach(el => {
    const catMatch = activeCategory === 'all' || el.dataset.cat === activeCategory;
    el.classList.toggle('hidden', !catMatch);
  });

  if (leafletMap && mapLayerGroup && window.__cachedGeojson) {
    const filtered = {
      ...window.__cachedGeojson,
      features: window.__cachedGeojson.features.filter(f =>
        activeCategory === 'all' || f.properties?.category === activeCategory
      ),
    };
    renderMap(filtered);
  }
}

function setupFeedTabs() {
  document.querySelectorAll('.feed-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.feed-tab').forEach(t => t.classList.remove('on'));
      tab.classList.add('on');
      activeFeedTab = tab.dataset.feed;
      applyAllFilters();
    });
  });
}

// ── Search ────────────────────────────────────────────────────────────────────
function setupSearch() {
  const input = document.getElementById('q');
  if (!input) return;
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      searchQuery = input.value.trim();
      applyAllFilters();
    }, 200);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') { input.value = ''; searchQuery = ''; applyAllFilters(); }
  });
}

// ── Tweaks panel ──────────────────────────────────────────────────────────────
function setupTweaks() {
  const btn   = document.getElementById('btn-tweaks');
  const panel = document.getElementById('tweaks');
  const close = document.getElementById('tw-close');

  btn?.addEventListener('click',   () => panel?.classList.toggle('on'));
  close?.addEventListener('click', () => panel?.classList.remove('on'));

  document.querySelectorAll('#tw-accent .sw').forEach(sw => {
    sw.addEventListener('click', () => {
      document.querySelectorAll('#tw-accent .sw').forEach(s => s.classList.remove('sel'));
      sw.classList.add('sel');
      document.documentElement.style.setProperty('--accent', sw.dataset.c);
    });
  });

  document.querySelectorAll('#tw-density .tgl').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#tw-density .tgl').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      document.body.dataset.density = b.dataset.d;
    });
  });

  const tickerSwitch = document.getElementById('tw-ticker');
  tickerSwitch?.addEventListener('click', () => {
    tickerSwitch.classList.toggle('on');
    const wrap = document.querySelector('.ticker-wrap');
    if (wrap) wrap.style.visibility = tickerSwitch.classList.contains('on') ? 'visible' : 'hidden';
  });

  const glowSwitch = document.getElementById('tw-glow');
  glowSwitch?.addEventListener('click', () => {
    glowSwitch.classList.toggle('on');
    document.body.dataset.glow = glowSwitch.classList.contains('on') ? '1' : '0';
  });
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function escHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── PDF Export ────────────────────────────────────────────────────────────────
async function exportPDF() {
  const btn     = document.getElementById('btn-export');
  const labelEl = btn?.querySelector('span');
  if (btn) { btn.disabled = true; if (labelEl) labelEl.textContent = 'GENERATING…'; }

  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });

    const pageW = 210, margin = 18, contentW = pageW - margin * 2;
    let y = margin;

    const C_BLACK = [20, 20, 24], C_MID = [80, 85, 100],
          C_LIGHT = [140, 145, 158], C_RULE = [220, 222, 228];
    const now         = new Date();
    const utcStr      = now.toUTCString();
    const filterLabel = activeCategory === 'all'
      ? 'All Categories'
      : activeCategory.charAt(0).toUpperCase() + activeCategory.slice(1);

    const rule = (yPos, w = 0.25) => {
      doc.setDrawColor(...C_RULE); doc.setLineWidth(w);
      doc.line(margin, yPos, pageW - margin, yPos);
    };
    const sectionTitle = (label, yPos) => {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(7); doc.setTextColor(...C_LIGHT);
      doc.text(label.toUpperCase(), margin, yPos); rule(yPos + 2); return yPos + 7;
    };

    doc.setFont('helvetica', 'bold'); doc.setFontSize(20); doc.setTextColor(...C_BLACK);
    doc.text('HorizonInt', margin, y + 8);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...C_MID);
    doc.text('Romania Geopolitical Intelligence Report', margin, y + 15);
    doc.setFontSize(7.5); doc.setTextColor(...C_LIGHT);
    doc.text(`${utcStr}  ·  Filter: ${filterLabel}`, margin, y + 21);
    rule(y + 26, 0.5); y += 32;

    const visArticles = allArticles.filter(a => activeCategory === 'all' || a.category === activeCategory);
    const visEvents   = allEvents.filter(e => activeCategory === 'all' || e.category === activeCategory);
    const roCount     = visArticles.filter(a => a.romania_impact && a.romania_impact !== 'none').length;

    y = sectionTitle('Summary', y);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...C_BLACK);
    doc.text(`Articles: ${visArticles.length.toLocaleString()} total  ·  RO-relevant: ${roCount}`, margin, y);
    doc.text(`Events: ${visEvents.length.toLocaleString()}`, margin + 110, y);
    y += 10;

    const top10 = [...visEvents]
      .sort((a, b) => new Date(b.occurred_at || 0) - new Date(a.occurred_at || 0))
      .slice(0, 10);

    if (top10.length) {
      if (y > 220) { doc.addPage(); y = margin; }
      y = sectionTitle('Recent Events — top 10', y);
      const cols = [
        { label: 'Date',     x: margin,       chars: 17 },
        { label: 'Location', x: margin + 34,  chars: 18 },
        { label: 'Cat.',     x: margin + 68,  chars: 12 },
        { label: 'Sev',      x: margin + 88,  chars: 3  },
        { label: 'Headline', x: margin + 96,  chars: 46 },
        { label: 'Source',   x: margin + 160, chars: 22 },
      ];
      const trunc = (s, n) => (!s ? '–' : s.length > n ? s.substring(0, n - 1) + '…' : s);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(6.5); doc.setTextColor(...C_LIGHT);
      cols.forEach(c => doc.text(c.label, c.x, y)); y += 4; rule(y); y += 4;
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(...C_BLACK);
      top10.forEach((ev, i) => {
        if (y > 272) { doc.addPage(); y = margin; }
        const ds = ev.occurred_at
          ? new Date(ev.occurred_at).toISOString().replace('T', ' ').substring(0, 16) + 'Z'
          : '–';
        doc.text(trunc(ds,                  cols[0].chars), cols[0].x, y);
        doc.text(trunc(ev.location_name||'',cols[1].chars), cols[1].x, y);
        doc.text(trunc(ev.category||'',     cols[2].chars), cols[2].x, y);
        doc.text(String(ev.severity || 1),                  cols[3].x, y);
        doc.text(trunc(ev.title||'',        cols[4].chars), cols[4].x, y);
        doc.text(trunc(ev.source_name||'',  cols[5].chars), cols[5].x, y);
        y += 5.5;
        if (i < top10.length - 1) rule(y - 1.5);
      });
      y += 8;
    }

    const briefingEl   = document.getElementById('briefing-content');
    const briefingText = briefingEl ? (briefingEl.innerText || briefingEl.textContent || '') : '';
    if (briefingText.trim()) {
      if (y > 240) { doc.addPage(); y = margin; }
      y = sectionTitle('AI Intelligence Briefing', y);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...C_BLACK);
      const lines = doc.splitTextToSize(briefingText.replace(/\n{3,}/g, '\n\n').trim(), contentW);
      lines.forEach(line => {
        if (y > 278) { doc.addPage(); y = margin; }
        doc.text(line, margin, y);
        y += line.trim() === '' ? 3 : 4.5;
      });
    }

    const total = doc.internal.getNumberOfPages();
    for (let p = 1; p <= total; p++) {
      doc.setPage(p); rule(287, 0.25);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(6.5); doc.setTextColor(...C_LIGHT);
      doc.text(`HorizonInt Intelligence Report  ·  ${utcStr}  ·  Page ${p} / ${total}`, margin, 292);
    }
    doc.save(`horizonint_${now.toISOString().split('T')[0]}.pdf`);

  } finally {
    if (btn) { btn.disabled = false; if (labelEl) labelEl.textContent = 'Export brief'; }
  }
}

// ── Hero resize ───────────────────────────────────────────────────────────────
function setupHeroResize() {
  const handle = document.getElementById('hero-resize');
  const main   = document.getElementById('main');
  if (!handle || !main) return;

  let dragging = false;
  let startY   = 0;
  let startH   = 0;

  handle.addEventListener('mousedown', e => {
    dragging = true;
    startY   = e.clientY;
    startH   = parseInt(getComputedStyle(main).getPropertyValue('--hero-h')) || 380;
    handle.classList.add('dragging');
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const delta  = e.clientY - startY;
    const mainH  = main.getBoundingClientRect().height;
    const newH   = Math.max(180, Math.min(mainH - 160, startH + delta));
    main.style.setProperty('--hero-h', `${newH}px`);
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    requestAnimationFrame(() => requestAnimationFrame(() => leafletMap?.invalidateSize()));
  });
}

// ── Panel collapse ────────────────────────────────────────────────────────────
function setupPanelCollapse() {
  document.querySelectorAll('.card-collapse-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.card');
      if (!card) return;
      const isCollapsing = !card.classList.contains('panel-collapsed');
      card.classList.toggle('panel-collapsed');
      btn.title = isCollapsing ? 'Expand panel' : 'Collapse panel';
      if (card.querySelector('#map')) {
        requestAnimationFrame(() => requestAnimationFrame(() => leafletMap?.invalidateSize()));
      }
    });
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────────
async function init() {
  startClock();
  initMap();
  setupFeedTabs();
  setupSearch();
  setupTweaks();
  setupPanelCollapse();
  setupHeroResize();

  document.querySelector('.tgl[data-toggle="heat"]')?.addEventListener('click', toggleHeatmap);
  document.querySelector('.tgl[data-toggle="arcs"]')?.addEventListener('click', toggleArcs);
  document.querySelector('.tgl[data-toggle="caps"]')?.addEventListener('click', toggleNeighborCaps);
  document.getElementById('btn-export')?.addEventListener('click', exportPDF);

  const [stats, briefing, articles, events, geojson] = await Promise.all([
    fetchJSON(`${DATA_BASE}/stats.json`),
    fetchJSON(`${DATA_BASE}/briefing.json`),
    fetchJSON(`${DATA_BASE}/articles.json`),
    fetchJSON(`${DATA_BASE}/events.json`),
    fetchJSON(`${DATA_BASE}/events.geojson`),
  ]);

  window.__cachedGeojson = geojson;

  renderStats(stats, articles);
  renderBriefing(briefing);
  renderFeed(articles);
  renderTimeline(events);
  renderMap(geojson);
  renderTicker(articles || []);
  updateThreatIndex(events || []);
  renderCategoryRows(articles);
  renderRegionBars(stats);
}

document.addEventListener('DOMContentLoaded', init);
