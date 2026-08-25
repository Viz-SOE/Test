// SLK Locator — app logic
//
// Loads two small data files instead of one giant inline <script>:
//   roads.json     - road id/name table (tiny)
//   roaddata.bin    - all GPS points, packed as raw typed arrays (~6MB)
//
// Why: the original build embedded ~497,000 points as one huge JS array
// literal inside the page's single <script> tag (~25MB of source text).
// That has to be fully downloaded AND parsed by the JS engine before any
// code on the page can run, blocking first paint. Mobile Safari (all iOS
// browsers use the same WebKit/JavaScriptCore engine, including "Chrome"
// and "Firefox" on iOS) parses huge literal arrays noticeably slower and
// with more memory overhead than desktop/Android Chrome's V8 — on a phone
// that shows up as a long, silent, unresponsive "frozen" tab, and on
// constrained devices can exceed Safari's per-tab memory ceiling entirely,
// which silently reloads/blanks the page.
//
// Fetching a plain binary buffer sidesteps JS/JSON parsing almost
// completely: the bytes are wrapped directly by typed array views, no
// tokenizing, no per-point object/array allocation. It also lets the page
// paint immediately and show real load progress, and lets a service worker
// cache the data so the app keeps working with no signal after the first
// successful load (see sw.js).

(function () {
  'use strict';

  // ---- DOM refs (cached once) ----
  const els = {
    roadName: document.getElementById('roadName'),
    slkValue: document.getElementById('slkValue'),
    matchDist: document.getElementById('matchDist'),
    curCoord: document.getElementById('curCoord'),
    curAccuracy: document.getElementById('curAccuracy'),
    lastUpdate: document.getElementById('lastUpdate'),
    fixCount: document.getElementById('fixCount'),
    dotSecure: document.getElementById('dotSecure'),
    txtSecure: document.getElementById('txtSecure'),
    dotGeo: document.getElementById('dotGeo'),
    txtGeo: document.getElementById('txtGeo'),
    dotWatch: document.getElementById('dotWatch'),
    txtWatch: document.getElementById('txtWatch'),
    startBtn: document.getElementById('startBtn'),
    stopBtn: document.getElementById('stopBtn'),
    dataStatus: document.getElementById('dataStatus'),
    dataStatusDetail: document.getElementById('dataStatusDetail'),
    dataStatusBar: document.getElementById('dataStatusBar'),
  };

  function setDot(dotEl, state) { // state: 'ok' | 'bad' | 'live' | ''
    dotEl.className = 'dot' + (state ? ' ' + state : '');
  }

  // ---- Secure context / geolocation support checks (independent of data load) ----
  if (window.isSecureContext) {
    setDot(els.dotSecure, 'ok');
    els.txtSecure.textContent = 'secure context: yes';
  } else {
    setDot(els.dotSecure, 'bad');
    els.txtSecure.textContent = 'secure context: NO — geolocation will likely be blocked here';
  }
  const geoSupported = 'geolocation' in navigator;
  setDot(els.dotGeo, geoSupported ? 'ok' : 'bad');
  els.txtGeo.textContent = geoSupported ? 'geolocation: supported' : 'geolocation: not supported';

  // Buttons start disabled until data finishes loading.
  els.startBtn.disabled = true;
  els.stopBtn.disabled = true;

  // ---- Fetch with progress, using ReadableStream when available ----
  async function fetchWithProgress(url, onProgress) {
    const resp = await fetch(url, { cache: 'no-cache' });
    if (!resp.ok) throw new Error(`${url}: HTTP ${resp.status}`);

    const total = Number(resp.headers.get('Content-Length')) || 0;
    if (!resp.body || !resp.body.getReader) {
      // Fallback for browsers without streaming fetch bodies.
      const buf = await resp.arrayBuffer();
      onProgress(buf.byteLength, buf.byteLength || total);
      return buf;
    }

    const reader = resp.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      onProgress(received, total);
    }
    const out = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
    return out.buffer;
  }

  function setStatus(mainText, detailText, ok) {
    els.dataStatus.querySelector('b').textContent = mainText;
    els.dataStatusDetail.textContent = detailText;
    els.dataStatus.className = 'footnote' + (ok === true ? ' status-ok' : ok === false ? ' status-bad' : '');
  }

  function setProgress(received, total) {
    if (total > 0) {
      const pct = Math.min(100, Math.round((received / total) * 100));
      els.dataStatusBar.style.width = pct + '%';
      els.dataStatusDetail.textContent = `${(received / 1e6).toFixed(1)} MB / ${(total / 1e6).toFixed(1)} MB (${pct}%)`;
    } else {
      els.dataStatusDetail.textContent = `${(received / 1e6).toFixed(1)} MB…`;
    }
  }

  // ---- Decode roaddata.bin ----
  // Layout (little-endian), all sections at aligned offsets:
  //   [0:4]              Uint32   N  (point count)
  //   [4 : 4+2N]         Uint16[N]  roadCode
  //   [4+2N : 4+4N]      Uint16[N]  slk in centi-km (slk_km * 100, rounded)
  //   [4+4N : 4+8N]      Float32[N] longitude (degrees)
  //   [4+8N : 4+12N]     Float32[N] latitude (degrees)
  function decodeRoadData(buf) {
    const dv = new DataView(buf);
    const n = dv.getUint32(0, true);
    let off = 4;
    const roadCode = new Uint16Array(buf, off, n); off += n * 2;
    const slkCenti = new Uint16Array(buf, off, n); off += n * 2;
    const lon = new Float32Array(buf, off, n); off += n * 4;
    const lat = new Float32Array(buf, off, n); off += n * 4;
    return { n, roadCode, slkCenti, lon, lat };
  }

  // ---- Numeric code -> roads[] entry ----
  // roadData stores each point's road as a plain integer. Purely numeric ids
  // are used as-is; ids beginning with 'Z' map to 1000 + numeric suffix
  // (e.g. Z001 -> 1001); ids beginning with 'H' map to 3000 + numeric suffix
  // (e.g. H008 -> 3008). Same scheme as the original single-file build.
  function buildRoadsByCode(roads) {
    const map = Object.create(null);
    roads.forEach(r => {
      let code;
      if (/^\d+$/.test(r.id)) code = parseInt(r.id, 10);
      else if (r.id[0] === 'Z') code = 1000 + parseInt(r.id.slice(1), 10);
      else if (r.id[0] === 'H') code = 3000 + parseInt(r.id.slice(1), 10);
      map[code] = r;
    });
    return map;
  }

  // ---- Spatial index (grid bucket of point *indices*, not point objects) ----
  const CELL_SIZE_DEG = 0.001; // ~111m lat, ~93m lon at this latitude
  const CELL_SIZE_METERS_APPROX = CELL_SIZE_DEG * 111000;

  function buildSpatialIndex(lon, lat, n) {
    const index = new Map();
    for (let i = 0; i < n; i++) {
      const cellLat = Math.floor(lat[i] / CELL_SIZE_DEG);
      const cellLon = Math.floor(lon[i] / CELL_SIZE_DEG);
      const key = cellLat + '_' + cellLon;
      let bucket = index.get(key);
      if (!bucket) { bucket = []; index.set(key, bucket); }
      bucket.push(i);
    }
    return index;
  }

  function haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function formatSlk(valueKm) {
    const [intPart, decPart] = valueKm.toFixed(2).split('.');
    return intPart.padStart(2, '0') + '.' + decPart;
  }

  // ---- App bootstrap ----
  async function main() {
    let roads, roadPoints, spatialIndex, roadsByCode;

    try {
      setStatus('Loading road data…', 'fetching roads.json…');
      const roadsResp = await fetch('roads.json', { cache: 'no-cache' });
      if (!roadsResp.ok) throw new Error(`roads.json: HTTP ${roadsResp.status}`);
      roads = await roadsResp.json();

      setStatus('Loading road data…', 'fetching roaddata.bin…');
      const buf = await fetchWithProgress('roaddata.bin', setProgress);

      setStatus('Loading road data…', 'indexing points…');
      roadPoints = decodeRoadData(buf);
      roadsByCode = buildRoadsByCode(roads);
      spatialIndex = buildSpatialIndex(roadPoints.lon, roadPoints.lat, roadPoints.n);

      setStatus('Road data loaded', `${roadPoints.n.toLocaleString()} points · ${roads.length} roads`, true);
      els.startBtn.disabled = !geoSupported;
    } catch (err) {
      setStatus('Failed to load road data', err.message + ' — check connection and reload', false);
      return;
    }

    function nearestPoint(lat, lon) {
      const baseCellLat = Math.floor(lat / CELL_SIZE_DEG);
      const baseCellLon = Math.floor(lon / CELL_SIZE_DEG);
      let bestIdx = -1, bestDist = Infinity;
      const MAX_RING = 6;

      for (let ring = 0; ring <= MAX_RING; ring++) {
        for (let dLat = -ring; dLat <= ring; dLat++) {
          for (let dLon = -ring; dLon <= ring; dLon++) {
            if (ring > 0 && Math.abs(dLat) !== ring && Math.abs(dLon) !== ring) continue;
            const bucket = spatialIndex.get((baseCellLat + dLat) + '_' + (baseCellLon + dLon));
            if (!bucket) continue;
            for (const i of bucket) {
              const d = haversineMeters(lat, lon, roadPoints.lat[i], roadPoints.lon[i]);
              if (d < bestDist) { bestDist = d; bestIdx = i; }
            }
          }
        }
        if (bestIdx !== -1 && bestDist <= ring * CELL_SIZE_METERS_APPROX) break;
      }
      return { idx: bestIdx, distance: bestDist };
    }

    let fixCount = 0;
    let watchId = null;

    function renderFix(lat, lon, accuracy) {
      fixCount++;
      const { idx, distance } = nearestPoint(lat, lon);

      if (idx === -1) {
        els.roadName.textContent = '— no nearby road data —';
        els.slkValue.textContent = '00.00';
        els.matchDist.textContent = '—';
      } else {
        const road = roadsByCode[roadPoints.roadCode[idx]];
        els.roadName.textContent = road ? `${road.name} (${road.id})` : `(unknown road code ${roadPoints.roadCode[idx]})`;
        els.slkValue.textContent = formatSlk(roadPoints.slkCenti[idx] / 100);
        els.matchDist.textContent = distance < 1000 ? distance.toFixed(1) + ' m' : (distance / 1000).toFixed(2) + ' km';
      }

      els.curCoord.textContent = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
      els.curAccuracy.textContent = accuracy != null ? `± ${Math.round(accuracy)} m` : '—';
      els.lastUpdate.textContent = new Date().toLocaleTimeString();
      els.fixCount.textContent = fixCount;
    }

    els.startBtn.addEventListener('click', () => {
      if (!geoSupported) return;
      setDot(els.dotWatch, 'live');
      els.txtWatch.textContent = 'watching…';
      els.startBtn.disabled = true;
      els.stopBtn.disabled = false;

      watchId = navigator.geolocation.watchPosition(
        pos => renderFix(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy),
        err => {
          setDot(els.dotWatch, 'bad');
          els.txtWatch.textContent = 'error: ' + err.message;
        },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
      );
    });

    els.stopBtn.addEventListener('click', () => {
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      setDot(els.dotWatch, '');
      els.txtWatch.textContent = 'stopped';
      els.startBtn.disabled = false;
      els.stopBtn.disabled = true;
    });
  }

  main();

  // ---- Service worker: caches the app shell + data so it works with no
  // signal after the first successful load. Registration failure (e.g.
  // unsupported browser, or served over plain http) is non-fatal — the
  // app still works online, it just won't survive a reload with no signal.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(err => {
        console.warn('Service worker registration failed:', err);
      });
    });
  }
})();
