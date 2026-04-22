/* ── HorizonInt — Main App ───────────────────────────────────────────────── */

// Self-hosted backend via Cloudflare Tunnel — replace with your actual tunnel domain.
const SELF_HOSTED_API = 'https://horizon.n8n-xpert.online';

const DATA_BASE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
  ? './data'
  : `${SELF_HOSTED_API}/data`;

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
const BUCHAREST = [44.4268, 26.1025];

const NEIGHBOR_CAPITALS = {
  ua: { name: 'Kyiv',     coords: [50.4501, 30.5234] },
  md: { name: 'Chișinău', coords: [47.0105, 28.8638] },
  hu: { name: 'Budapest', coords: [47.4979, 19.0402] },
  rs: { name: 'Belgrade', coords: [44.8176, 20.4569] },
  bg: { name: 'Sofia',    coords: [42.6977, 23.3219] },
};

// ── State ─────────────────────────────────────────────────────────────────────
let activeCategory    = 'all';
let activeNeighbor    = null;
let leafletMap        = null;
let mapLayerGroup     = null;
let heatLayer         = null;
let arcLayerGroup     = null;
let neighborCapsLayer = null;
let heatActive        = false;
let arcsActive        = false;
let neighborCapsActive = false;
let allArticles       = [];
let allEvents         = [];

// ── UTC + Romania Clock ────────────────────────────────────────────────────────
function startClock() {
  const roFmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Bucharest',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const roOffsetFmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Bucharest',
    timeZoneName: 'shortOffset',
  });

  function tick() {
    const now = new Date();
    const hh = String(now.getUTCHours()).padStart(2, '0');
    const mm = String(now.getUTCMinutes()).padStart(2, '0');
    const ss = String(now.getUTCSeconds()).padStart(2, '0');
    const roTime = roFmt.format(now);
    const offsetPart = roOffsetFmt.formatToParts(now).find(p => p.type === 'timeZoneName')?.value || 'EET';
    document.getElementById('utc-clock').innerHTML =
      `${hh}:${mm}:${ss} <span class="clock-label">UTC</span>` +
      `<span class="clock-sep">|</span>` +
      `${roTime} <span class="clock-label">RO&nbsp;${offsetPart}</span>`;
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
  const labels = { direct: 'RO Direct', economic: 'RO Economic', security: 'RO Security' };
  return labels[impact] || null;
}

// ── Stats + Neighbor Strip ────────────────────────────────────────────────────
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
  renderNeighborStrip(stats);
}

function renderNeighborStrip(stats) {
  if (!stats) return;
  const na  = stats.neighbor_activity    || {};
  const ri  = stats.romania_impact_counts || {};

  const neighbors = ['ua', 'md', 'hu', 'rs', 'bg', 'nato', 'energy'];
  const maxCount  = Math.max(1, ...neighbors.map(k => na[k] || 0));

  neighbors.forEach(k => {
    const countEl = document.getElementById(`nc-${k}`);
    if (countEl) countEl.textContent = na[k] ?? 0;

    const chip = document.querySelector(`.neighbor-chip[data-neighbor="${k}"]`);
    if (chip) {
      const intensity = ((na[k] || 0) / maxCount).toFixed(2);
      chip.style.setProperty('--chip-intensity', intensity);
    }
  });

  ['direct', 'security', 'economic'].forEach(type => {
    const el = document.getElementById(`ri-count-${type}`);
    if (el) el.textContent = ri[type] ?? 0;
  });
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
    if (briefing.article_count) parts.push(`${briefing.article_count} articles analysed`);
    if (briefing.generated_at)  parts.push(relativeTime(briefing.generated_at));
    meta.textContent = parts.join(' · ');
  }
}

// ── News Feed (dual-panel: RO Impact + World) ─────────────────────────────────
function buildFeedItem(art) {
  const el = document.createElement('div');
  el.className = 'feed-item';
  el.dataset.cat      = art.category || 'other';
  el.dataset.neighbor = art.neighbor_country || 'other';

  const color  = catColor(art.category);
  const roTag  = romaniaLabel(art.romania_impact);
  const roHtml = roTag ? `<span class="romania-tag">${roTag}</span>` : '';
  const nc     = art.neighbor_country;
  const ncHtml = (nc && nc !== 'other')
    ? `<span class="neighbor-tag nc-${nc}">${nc.toUpperCase()}</span>`
    : '';

  el.innerHTML = `
    <div class="feed-item-title">${escHtml(art.title)}</div>
    <div class="feed-item-meta">
      <span class="cat-badge" style="--badge-color:${color}">${art.category || 'other'}</span>
      <span class="feed-dot"></span>
      <span class="feed-source">${escHtml(art.source_name || '')}</span>
      <span class="feed-dot"></span>
      <span class="feed-time">${relativeTime(art.published_at)}</span>
      ${roHtml}${ncHtml}
    </div>`;

  el.addEventListener('click', () => {
    if (art.url) window.open(art.url, '_blank', 'noopener');
  });
  return el;
}

function renderFeed(articles) {
  allArticles = articles || [];
  const roList    = document.getElementById('ro-feed-list');
  const worldList = document.getElementById('world-feed-list');
  const countEl   = document.getElementById('ro-feed-count');

  if (!roList || !worldList) return;

  const roArticles    = allArticles.filter(a => a.romania_impact && a.romania_impact !== 'none');
  const worldArticles = allArticles.filter(a => !a.romania_impact || a.romania_impact === 'none');

  roList.innerHTML    = '';
  worldList.innerHTML = '';

  if (!allArticles.length) {
    roList.innerHTML = '<p class="empty-state">No articles loaded yet.</p>';
    return;
  }

  const fragRO    = document.createDocumentFragment();
  const fragWorld = document.createDocumentFragment();
  roArticles.forEach(a    => fragRO.appendChild(buildFeedItem(a)));
  worldArticles.forEach(a => fragWorld.appendChild(buildFeedItem(a)));
  roList.appendChild(fragRO);
  worldList.appendChild(fragWorld);

  if (countEl) countEl.textContent = `${roArticles.length} RO-relevant`;
  applyAllFilters();
}

// ── Event Timeline ────────────────────────────────────────────────────────────
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
  applyAllFilters();
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
  addLegend();

  // Romania polygon outline (static file, loaded once)
  fetch(`${DATA_BASE}/romania.geojson`)
    .then(r => r.ok ? r.json() : null)
    .then(geojson => {
      if (!geojson) return;
      L.geoJSON(geojson, {
        style: {
          color: '#facc15', weight: 2, opacity: 0.6,
          fillColor: '#facc15', fillOpacity: 0.04,
          dashArray: '5 4',
        },
        interactive: false,
      }).addTo(leafletMap);
    })
    .catch(() => {});
}

function addLegend() {
  const legend = L.control({ position: 'bottomright' });
  legend.onAdd = () => {
    const div = L.DomUtil.create('div', 'map-legend');
    const cats = Object.entries(CATEGORY_COLORS).filter(([k]) => k !== 'other');
    div.innerHTML =
      `<div class="legend-section-title">Categories</div>` +
      cats.map(([cat, color]) =>
        `<div class="legend-row"><span class="legend-dot" style="background:${color}"></span><span>${cat}</span></div>`
      ).join('') +
      `<div class="legend-section-title">Severity</div>
       <div class="legend-sev">
         <span class="legend-sev-item"><svg width="10" height="10"><circle cx="5" cy="5" r="4.5" fill="#6b7280"/></svg>&nbsp;1</span>
         <span class="legend-sev-item"><svg width="16" height="16"><circle cx="8" cy="8" r="7.5" fill="#6b7280"/></svg>&nbsp;2</span>
         <span class="legend-sev-item"><svg width="24" height="24"><circle cx="12" cy="12" r="11.5" fill="#6b7280"/></svg>&nbsp;3</span>
       </div>`;
    return div;
  };
  legend.addTo(leafletMap);
}

function toggleHeatmap() {
  if (!window.__cachedGeojson) return;
  const btn = document.getElementById('btn-heat');
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
    btn?.classList.add('active');
  } else {
    if (heatLayer) { leafletMap.removeLayer(heatLayer); heatLayer = null; }
    btn?.classList.remove('active');
  }
}

function toggleArcs() {
  if (!window.__cachedGeojson) return;
  const btn = document.getElementById('btn-arcs');
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
      radius: 6, color: '#facc15', fillColor: '#facc15',
      fillOpacity: 0.9, weight: 2,
    }).bindPopup('<div class="popup-title">Bucharest, Romania</div>').addTo(arcLayerGroup);
    btn?.classList.add('active');
  } else {
    if (arcLayerGroup) { arcLayerGroup.remove(); arcLayerGroup = null; }
    btn?.classList.remove('active');
  }
}

function toggleNeighborCaps() {
  const btn = document.getElementById('btn-neighbor-caps');
  neighborCapsActive = !neighborCapsActive;
  if (neighborCapsActive) {
    neighborCapsLayer = L.layerGroup().addTo(leafletMap);

    // Bucharest marker
    L.circleMarker(BUCHAREST, {
      radius: 9, color: '#facc15', fillColor: '#facc15',
      fillOpacity: 0.9, weight: 2,
    }).bindPopup('<div class="popup-title">Bucharest, Romania</div>').addTo(neighborCapsLayer);

    // Each neighbor capital: marker + arc from Bucharest
    Object.entries(NEIGHBOR_CAPITALS).forEach(([code, cap]) => {
      L.circleMarker(cap.coords, {
        radius: 7, color: '#facc15', fillColor: '#facc15',
        fillOpacity: 0.3, weight: 2, dashArray: '3 3',
      })
        .bindPopup(`<div class="popup-title">${cap.name}</div><div class="popup-loc">${code.toUpperCase()}</div>`)
        .addTo(neighborCapsLayer);

      L.polyline([BUCHAREST, cap.coords], {
        color: '#facc15', weight: 1.5, opacity: 0.4, dashArray: '6 5',
      }).addTo(neighborCapsLayer);
    });

    btn?.classList.add('active');
  } else {
    if (neighborCapsLayer) { neighborCapsLayer.remove(); neighborCapsLayer = null; }
    btn?.classList.remove('active');
  }
}

function renderMap(geojson) {
  if (!leafletMap || !mapLayerGroup) return;
  mapLayerGroup.clearLayers();

  const features = geojson?.features || [];
  if (!features.length) return;

  const bounds = [];

  features.forEach(feat => {
    const props = feat.properties || {};
    const [lng, lat] = feat.geometry?.coordinates || [0, 0];
    if (!lat && !lng) return;

    bounds.push([lat, lng]);

    const cat    = props.category || 'other';
    const color  = catColor(cat);
    const radius = SEVERITY_RADII[props.severity] || 5;

    if ((props.severity || 1) >= 3) {
      L.marker([lat, lng], {
        icon: L.divIcon({
          className: '',
          html: `<div class="pulse-ring" style="--ring-color:${color}"></div>`,
          iconSize: [32, 32],
          iconAnchor: [16, 16],
        }),
        interactive: false,
        zIndexOffset: -100,
      }).addTo(mapLayerGroup);
    }

    if (['direct', 'economic', 'security'].includes(props.romania_impact)) {
      L.circleMarker([lat, lng], {
        radius:    radius + 5,
        color:     '#facc15',
        weight:    2,
        dashArray: '5 4',
        fill:      false,
        opacity:   0.85,
      }).addTo(mapLayerGroup);
    }

    const marker = L.circleMarker([lat, lng], {
      radius,
      color,
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

  if (!window.__mapFit && bounds.length) {
    leafletMap.fitBounds(bounds, { padding: [30, 30], maxZoom: 4 });
    window.__mapFit = true;
  }

  if (heatActive && heatLayer) {
    leafletMap.removeLayer(heatLayer);
    heatLayer = null;
    heatActive = false;
    toggleHeatmap();
  }
}

// ── Filters (category + neighbor) ────────────────────────────────────────────
function applyAllFilters() {
  document.querySelectorAll('.feed-item').forEach(el => {
    const catMatch = activeCategory === 'all' || el.dataset.cat === activeCategory;
    const nbMatch  = !activeNeighbor || el.dataset.neighbor === activeNeighbor;
    el.classList.toggle('hidden', !(catMatch && nbMatch));
  });

  document.querySelectorAll('.timeline-item').forEach(el => {
    el.classList.toggle('hidden',
      activeCategory !== 'all' && el.dataset.cat !== activeCategory);
  });

  if (leafletMap && mapLayerGroup && window.__cachedGeojson) {
    const filtered = {
      ...window.__cachedGeojson,
      features: window.__cachedGeojson.features.filter(f => {
        return activeCategory === 'all' || f.properties?.category === activeCategory;
      }),
    };
    renderMap(filtered);
  }
}

function setupFilters() {
  document.querySelectorAll('.cat-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeCategory = btn.dataset.cat;
      applyAllFilters();
    });
  });
}

function setupNeighborFilter() {
  document.querySelectorAll('.neighbor-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const nb = chip.dataset.neighbor;
      if (activeNeighbor === nb) {
        activeNeighbor = null;
        chip.classList.remove('active');
      } else {
        document.querySelectorAll('.neighbor-chip').forEach(c => c.classList.remove('active'));
        activeNeighbor = nb;
        chip.classList.add('active');
      }
      applyAllFilters();
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

// ── PDF Export ────────────────────────────────────────────────────────────────
async function exportPDF() {
  const btn = document.getElementById('btn-export');
  const labelEl = btn?.querySelector('.export-btn-label');
  if (btn) { btn.disabled = true; if (labelEl) labelEl.textContent = 'GENERATING…'; }

  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });

    const pageW    = 210;
    const margin   = 18;
    const contentW = pageW - margin * 2;
    let y = margin;

    const C_BLACK = [20, 20, 24];
    const C_MID   = [80, 85, 100];
    const C_LIGHT = [140, 145, 158];
    const C_RULE  = [220, 222, 228];

    const now         = new Date();
    const utcStr      = now.toUTCString();
    const filterLabel = activeCategory === 'all'
      ? 'All Categories'
      : activeCategory.charAt(0).toUpperCase() + activeCategory.slice(1);

    const rule = (yPos, weight = 0.25) => {
      doc.setDrawColor(...C_RULE);
      doc.setLineWidth(weight);
      doc.line(margin, yPos, pageW - margin, yPos);
    };

    const sectionTitle = (label, yPos) => {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7);
      doc.setTextColor(...C_LIGHT);
      doc.text(label.toUpperCase(), margin, yPos);
      rule(yPos + 2);
      return yPos + 7;
    };

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(20);
    doc.setTextColor(...C_BLACK);
    doc.text('HorizonInt', margin, y + 8);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(...C_MID);
    doc.text('Romania Geopolitical Intelligence Report', margin, y + 15);

    doc.setFontSize(7.5);
    doc.setTextColor(...C_LIGHT);
    doc.text(`${utcStr}  ·  Filter: ${filterLabel}`, margin, y + 21);

    rule(y + 26, 0.5);
    y += 32;

    const visArticles = allArticles.filter(a => activeCategory === 'all' || a.category === activeCategory);
    const visEvents   = allEvents.filter(e => activeCategory === 'all' || e.category === activeCategory);
    const roCount     = visArticles.filter(a => a.romania_impact && a.romania_impact !== 'none').length;

    const catCounts = {};
    visArticles.forEach(a => { const c = a.category || 'other'; catCounts[c] = (catCounts[c] || 0) + 1; });

    const locCounts = {};
    visEvents.forEach(e => { if (e.location_name) locCounts[e.location_name] = (locCounts[e.location_name] || 0) + 1; });

    const topCats  = Object.entries(catCounts).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const top5Locs = Object.entries(locCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);

    y = sectionTitle('Summary', y);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...C_BLACK);
    doc.text(`Articles: ${visArticles.length.toLocaleString()} total  ·  RO-relevant: ${roCount}`, margin, y);
    doc.text(`Events: ${visEvents.length.toLocaleString()}`, margin + 110, y);
    y += 6;

    if (topCats.length) {
      doc.setFontSize(7.5);
      doc.setTextColor(...C_MID);
      doc.text('By category:  ' + topCats.map(([c, n]) => `${c} (${n})`).join('  ·  '), margin, y);
      y += 5;
    }
    if (top5Locs.length) {
      doc.setFontSize(7.5);
      doc.setTextColor(...C_MID);
      doc.text('Top locations:  ' + top5Locs.map(([l, n]) => `${l} (${n})`).join('  ·  '), margin, y);
      y += 5;
    }
    y += 6;

    const top10 = [...visEvents]
      .sort((a, b) => new Date(b.occurred_at || 0) - new Date(a.occurred_at || 0))
      .slice(0, 10);

    if (top10.length) {
      if (y > 220) { doc.addPage(); y = margin; }
      y = sectionTitle('Recent Events — top 10', y);

      const cols = [
        { label: 'Date (UTC)',  x: margin,       chars: 17 },
        { label: 'Location',    x: margin + 34,  chars: 18 },
        { label: 'Cat.',        x: margin + 68,  chars: 12 },
        { label: 'Sev',         x: margin + 88,  chars: 3  },
        { label: 'Headline',    x: margin + 96,  chars: 46 },
        { label: 'Source',      x: margin + 160, chars: 22 },
      ];

      const trunc = (s, n) => (!s ? '–' : s.length > n ? s.substring(0, n - 1) + '…' : s);

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(6.5);
      doc.setTextColor(...C_LIGHT);
      cols.forEach(c => doc.text(c.label, c.x, y));
      y += 4;
      rule(y);
      y += 4;

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      doc.setTextColor(...C_BLACK);

      top10.forEach((ev, i) => {
        if (y > 272) { doc.addPage(); y = margin; }
        const dateStr = ev.occurred_at
          ? new Date(ev.occurred_at).toISOString().replace('T', ' ').substring(0, 16) + 'Z'
          : '–';
        doc.text(trunc(dateStr, cols[0].chars),                cols[0].x, y);
        doc.text(trunc(ev.location_name || '', cols[1].chars), cols[1].x, y);
        doc.text(trunc(ev.category || '', cols[2].chars),      cols[2].x, y);
        doc.text(String(ev.severity || 1),                     cols[3].x, y);
        doc.text(trunc(ev.title || '', cols[4].chars),         cols[4].x, y);
        doc.text(trunc(ev.source_name || '', cols[5].chars),   cols[5].x, y);
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

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(...C_BLACK);

      const cleaned = briefingText.replace(/\n{3,}/g, '\n\n').trim();
      const lines   = doc.splitTextToSize(cleaned, contentW);
      lines.forEach(line => {
        if (y > 278) { doc.addPage(); y = margin; }
        doc.text(line, margin, y);
        y += line.trim() === '' ? 3 : 4.5;
      });
    }

    const totalPages = doc.internal.getNumberOfPages();
    for (let p = 1; p <= totalPages; p++) {
      doc.setPage(p);
      rule(287, 0.25);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(6.5);
      doc.setTextColor(...C_LIGHT);
      doc.text(`HorizonInt Intelligence Report  ·  ${utcStr}  ·  Page ${p} / ${totalPages}`, margin, 292);
    }

    doc.save(`horizonint_${now.toISOString().split('T')[0]}.pdf`);

  } finally {
    if (btn) { btn.disabled = false; if (labelEl) labelEl.textContent = 'EXPORT PDF'; }
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────
async function init() {
  startClock();
  setupFilters();
  setupNeighborFilter();
  initMap();
  document.getElementById('btn-heat')?.addEventListener('click', toggleHeatmap);
  document.getElementById('btn-arcs')?.addEventListener('click', toggleArcs);
  document.getElementById('btn-neighbor-caps')?.addEventListener('click', toggleNeighborCaps);
  document.getElementById('btn-export')?.addEventListener('click', exportPDF);

  const [stats, briefing, articles, events, geojson] = await Promise.all([
    fetchJSON(`${DATA_BASE}/stats.json`),
    fetchJSON(`${DATA_BASE}/briefing.json`),
    fetchJSON(`${DATA_BASE}/articles.json`),
    fetchJSON(`${DATA_BASE}/events.json`),
    fetchJSON(`${DATA_BASE}/events.geojson`),
  ]);

  window.__cachedGeojson = geojson;

  renderStats(stats);
  renderBriefing(briefing);
  renderFeed(articles);
  renderTimeline(events);
  renderMap(geojson);
}

document.addEventListener('DOMContentLoaded', init);
