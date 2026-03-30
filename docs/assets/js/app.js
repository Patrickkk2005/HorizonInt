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

// ── State ─────────────────────────────────────────────────────────────────────
let activeCategory = 'all';
let leafletMap     = null;
let mapLayerGroup  = null;
let heatLayer      = null;
let arcLayerGroup  = null;
let heatActive     = false;
let arcsActive     = false;
let allArticles    = [];
let allEvents      = [];

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
    // Extract offset label (e.g. "GMT+3") for display
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
  addLegend();
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
        // Marker dot on Bucharest end (once, but layerGroup deduplication is fine here)
      });
    // Mark Bucharest
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

    // Pulsing ring for sev-3 events
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

    // Romania impact → dashed yellow ring behind the marker
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

  // Auto-fit to all markers on first render
  if (!window.__mapFit && bounds.length) {
    leafletMap.fitBounds(bounds, { padding: [30, 30], maxZoom: 4 });
    window.__mapFit = true;
  }

  // Refresh heatmap if active
  if (heatActive && heatLayer) {
    leafletMap.removeLayer(heatLayer);
    heatLayer = null;
    heatActive = false;
    toggleHeatmap();
  }
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

// ── PDF Export ────────────────────────────────────────────────────────────────
async function exportPDF() {
  const btn = document.getElementById('btn-export');
  const labelEl = btn?.querySelector('.export-btn-label');
  if (btn) { btn.disabled = true; if (labelEl) labelEl.textContent = 'GENERATING…'; }

  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });

    const pageW    = 210;
    const margin   = 15;
    const contentW = pageW - margin * 2;
    let y = margin;

    const now        = new Date();
    const utcStr     = now.toUTCString();
    const filterLabel = activeCategory === 'all'
      ? 'All Categories'
      : activeCategory.charAt(0).toUpperCase() + activeCategory.slice(1);

    // ── Page header ───────────────────────────────────────────────────────────
    doc.setFillColor(10, 12, 16);
    doc.rect(0, 0, pageW, 32, 'F');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(16);
    doc.setTextColor(240, 244, 255);
    doc.text('HORIZONINT', margin, y + 8);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(180, 185, 200);
    doc.text('Geopolitical Intelligence Report', margin, y + 15);

    doc.setFontSize(7.5);
    doc.setTextColor(107, 114, 128);
    doc.text(`Generated: ${utcStr}`, margin, y + 21);
    doc.text(`Active filter: ${filterLabel}`, margin, y + 27);

    // Separator line
    doc.setDrawColor(30, 34, 48);
    doc.setLineWidth(0.4);
    doc.line(margin, y + 30, pageW - margin, y + 30);
    y = y + 35;

    // ── Summary statistics ────────────────────────────────────────────────────
    const visArticles = allArticles.filter(a => activeCategory === 'all' || a.category === activeCategory);
    const visEvents   = allEvents.filter(e => activeCategory === 'all' || e.category === activeCategory);

    const catCounts = {};
    visArticles.forEach(a => {
      const cat = a.category || 'other';
      catCounts[cat] = (catCounts[cat] || 0) + 1;
    });

    const locCounts = {};
    visEvents.forEach(e => {
      if (e.location_name) locCounts[e.location_name] = (locCounts[e.location_name] || 0) + 1;
    });
    const top5Locs = Object.entries(locCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const topCats  = Object.entries(catCounts).sort((a, b) => b[1] - a[1]).slice(0, 6);

    doc.setFillColor(17, 19, 24);
    doc.rect(margin, y, contentW, 30, 'F');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(250, 204, 21);
    doc.text('SUMMARY STATISTICS', margin + 4, y + 6);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(212, 217, 232);
    doc.text(
      `Articles: ${allArticles.length.toLocaleString()} total  |  ${visArticles.length.toLocaleString()} visible`,
      margin + 4, y + 13
    );
    doc.text(
      `Events: ${allEvents.length.toLocaleString()} total  |  ${visEvents.length.toLocaleString()} visible`,
      margin + 4, y + 19
    );

    if (topCats.length) {
      const catStr = topCats.map(([c, n]) => `${c} (${n})`).join('  ·  ');
      doc.text(`Category breakdown: ${catStr}`, margin + 4, y + 25);
    }
    if (top5Locs.length) {
      const locStr = top5Locs.map(([l, n]) => `${l} (${n})`).join('  ·  ');
      doc.setTextColor(180, 185, 200);
      doc.text(`Top locations: ${locStr}`, margin + 4, y + 30);
    }

    y += 35;

    // ── Map capture ───────────────────────────────────────────────────────────
    let mapCaptured = false;
    try {
      const mapEl = document.getElementById('map');
      if (mapEl && window.html2canvas) {
        const canvas = await window.html2canvas(mapEl, {
          useCORS: true,
          allowTaint: false,
          logging: false,
          scale: 1.5,
        });
        const imgData = canvas.toDataURL('image/jpeg', 0.82);
        const rawH    = Math.round(contentW * canvas.height / canvas.width);
        const imgH    = Math.min(rawH, 72);

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8);
        doc.setTextColor(250, 204, 21);
        doc.text('GLOBAL EVENT MAP', margin, y + 5);
        y += 8;

        doc.addImage(imgData, 'JPEG', margin, y, contentW, imgH);
        y += imgH + 6;
        mapCaptured = true;
      }
    } catch (_err) {
      // CORS or canvas error — skip gracefully
    }

    if (!mapCaptured) {
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(7.5);
      doc.setTextColor(107, 114, 128);
      doc.text('[Map image unavailable — tile layer CORS restriction prevents capture]', margin, y + 5);
      y += 11;
    }

    // ── Events table ──────────────────────────────────────────────────────────
    const top10 = [...visEvents]
      .sort((a, b) => new Date(b.occurred_at || 0) - new Date(a.occurred_at || 0))
      .slice(0, 10);

    if (top10.length) {
      if (y > 218) { doc.addPage(); y = margin; }

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      doc.setTextColor(250, 204, 21);
      doc.text('RECENT EVENTS — TOP 10 VISIBLE', margin, y + 5);
      y += 9;

      // Column definitions (x = absolute, w = max chars hint)
      const cols = [
        { label: 'Date (UTC)',  x: margin,       w: 28 },
        { label: 'Location',    x: margin + 28,  w: 28 },
        { label: 'Category',    x: margin + 58,  w: 20 },
        { label: 'Sev',         x: margin + 80,  w: 7  },
        { label: 'Headline',    x: margin + 89,  w: 68 },
        { label: 'Source',      x: margin + 159, w: 31 },
      ];

      // Header row
      doc.setFillColor(22, 25, 32);
      doc.rect(margin, y, contentW, 6, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(6.5);
      doc.setTextColor(180, 185, 200);
      cols.forEach(c => doc.text(c.label, c.x + 1, y + 4));
      y += 7;

      const trunc = (s, n) => {
        if (!s) return '–';
        return s.length > n ? s.substring(0, n - 1) + '…' : s;
      };

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(6.5);

      top10.forEach((ev, i) => {
        if (y > 272) { doc.addPage(); y = margin; }
        const rowH = 6.5;
        if (i % 2 === 0) {
          doc.setFillColor(17, 19, 24);
          doc.rect(margin, y - 0.5, contentW, rowH, 'F');
        }
        doc.setTextColor(212, 217, 232);

        const dateStr = ev.occurred_at
          ? new Date(ev.occurred_at).toISOString().replace('T', ' ').substring(0, 16) + 'Z'
          : '–';

        doc.text(trunc(dateStr, 19),                cols[0].x + 1, y + 4);
        doc.text(trunc(ev.location_name || '', 18), cols[1].x + 1, y + 4);
        doc.text(trunc(ev.category || '', 13),      cols[2].x + 1, y + 4);
        doc.text(String(ev.severity || 1),          cols[3].x + 1, y + 4);
        doc.text(trunc(ev.title || '', 44),         cols[4].x + 1, y + 4);
        doc.text(trunc(ev.source_name || '', 20),   cols[5].x + 1, y + 4);

        y += rowH;
      });
      y += 6;
    }

    // ── AI briefing ───────────────────────────────────────────────────────────
    const briefingEl   = document.getElementById('briefing-content');
    const briefingText = briefingEl ? (briefingEl.innerText || briefingEl.textContent || '') : '';

    if (briefingText.trim()) {
      if (y > 240) { doc.addPage(); y = margin; }

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      doc.setTextColor(250, 204, 21);
      doc.text('AI INTELLIGENCE BRIEFING', margin, y + 5);
      y += 10;

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor(212, 217, 232);

      const cleaned = briefingText.replace(/\n{3,}/g, '\n\n').trim();
      const lines   = doc.splitTextToSize(cleaned, contentW);
      lines.forEach(line => {
        if (y > 278) { doc.addPage(); y = margin; }
        doc.text(line, margin, y);
        y += 4;
      });
    }

    // ── Footer on every page ──────────────────────────────────────────────────
    const totalPages = doc.internal.getNumberOfPages();
    for (let p = 1; p <= totalPages; p++) {
      doc.setPage(p);
      doc.setDrawColor(30, 34, 48);
      doc.setLineWidth(0.3);
      doc.line(margin, 287, pageW - margin, 287);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(6.5);
      doc.setTextColor(107, 114, 128);
      doc.text(
        `HORIZONINT Intelligence Report  ·  ${utcStr}  ·  Page ${p} / ${totalPages}`,
        margin, 292
      );
    }

    const filename = `horizonint_report_${now.toISOString().split('T')[0]}.pdf`;
    doc.save(filename);

  } finally {
    if (btn) { btn.disabled = false; if (labelEl) labelEl.textContent = 'EXPORT PDF'; }
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────
async function init() {
  startClock();
  setupFilters();
  initMap();
  document.getElementById('btn-heat')?.addEventListener('click', toggleHeatmap);
  document.getElementById('btn-arcs')?.addEventListener('click', toggleArcs);
  document.getElementById('btn-export')?.addEventListener('click', exportPDF);

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
