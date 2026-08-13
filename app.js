// app.js — Shady Dayz: map UI, route generation, ranking.

const state = {
  start: null, // [lon, lat]
  routes: [],
  selectedId: null,
};

const els = {
  distance: document.getElementById("distance"),
  startTime: document.getElementById("startTime"),
  priority: document.getElementById("priority"),
  locateBtn: document.getElementById("locateBtn"),
  goBtn: document.getElementById("goBtn"),
  status: document.getElementById("status"),
  sunNote: document.getElementById("sunNote"),
  results: document.getElementById("results"),
};

const map = L.map("map").setView([39.5, -98.35], 4);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

const routeLayer = L.layerGroup().addTo(map);
let startMarker = null;

(function initTime() {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  els.startTime.value = now.toISOString().slice(0, 16);
})();

function setStatus(msg, isError = false) {
  els.status.textContent = msg;
  els.status.className = isError ? "error" : "";
}

function setStart(lonlat, zoom = true) {
  state.start = lonlat;
  if (startMarker) startMarker.remove();
  startMarker = L.marker([lonlat[1], lonlat[0]], { title: "Start" }).addTo(map);
  if (zoom) map.setView([lonlat[1], lonlat[0]], 14);
  els.goBtn.disabled = false;
  setStatus("");
}

map.on("click", (e) => setStart([e.latlng.lng, e.latlng.lat], false));

els.locateBtn.addEventListener("click", () => {
  if (!navigator.geolocation) {
    setStatus("Geolocation is not available — click the map instead.", true);
    return;
  }
  setStatus("Locating…");
  navigator.geolocation.getCurrentPosition(
    (pos) => setStart([pos.coords.longitude, pos.coords.latitude]),
    (err) => setStatus(`Could not get your location (${err.message}) — click the map instead.`, true),
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

els.goBtn.addEventListener("click", generate);

els.priority.addEventListener("change", () => {
  if (!state.routes.length) return;
  rankRoutes();
  renderResults();
});

async function fetchRoundTrip(start, meters, seed) {
  const res = await fetch(CONFIG.ORS_URL, {
    method: "POST",
    headers: {
      Authorization: CONFIG.ORS_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      coordinates: [start],
      options: {
        round_trip: { length: Math.round(meters), points: 3 + (seed % 3), seed },
      },
      instructions: false,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ORS ${res.status}: ${body.slice(0, 200)}`);
  }
  const geo = await res.json();
  const feat = geo.features && geo.features[0];
  if (!feat) throw new Error("ORS returned no route");
  return {
    coords: feat.geometry.coordinates, // [lon, lat] pairs
    meters: feat.properties.summary.distance,
  };
}

async function fetchCandidates(start, meters) {
  const settled = await Promise.allSettled(
    CONFIG.SEEDS.map((seed) => fetchRoundTrip(start, meters, seed))
  );
  const seen = new Set();
  const out = [];
  const errors = [];
  for (const r of settled) {
    if (r.status === "rejected") {
      errors.push(r.reason.message);
      continue;
    }
    const c = r.value;
    let cLon = 0, cLat = 0;
    for (const [lon, lat] of c.coords) {
      cLon += lon;
      cLat += lat;
    }
    cLon /= c.coords.length;
    cLat /= c.coords.length;
    const key = `${Math.round(c.meters / 150)}:${Math.round(cLon * 2000)}:${Math.round(cLat * 2000)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  if (!out.length && errors.length) throw new Error(errors[0]);
  return out;
}

function bboxOfRoutes(candidates) {
  let b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const c of candidates) {
    const cb = bboxOf(c.coords);
    b = [Math.min(b[0], cb[0]), Math.min(b[1], cb[1]), Math.max(b[2], cb[2]), Math.max(b[3], cb[3])];
  }
  return bboxExpand(b, 150, (b[1] + b[3]) / 2);
}

// Weighted shade score for the chosen priority: "early" weights the first
// miles most, "late" the last, "total" weights everything equally.
function rankScoreFor(route, mode) {
  const v = route.shadeVals;
  const n = v.length;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const w = mode === "early" ? n - i : mode === "late" ? i + 1 : 1;
    num += v[i] * w;
    den += w;
  }
  return (num / den) * 100 - 25 * (route.overlapPct / 100);
}

function rankRoutes() {
  const mode = els.priority.value;
  for (const r of state.routes) r.rankScore = rankScoreFor(r, mode);
  state.routes.sort((a, b) => b.rankScore - a.rankScore);
}

async function generate() {
  const miles = parseFloat(els.distance.value);
  if (!state.start || !miles) return;
  const meters = miles * 1609.34;
  const startAt = els.startTime.value ? new Date(els.startTime.value) : new Date();
  const speedMps = 1609.34 / (CONFIG.PACE_MIN_PER_MILE * 60);

  els.goBtn.disabled = true;
  routeLayer.clearLayers();
  els.results.innerHTML = "";
  els.sunNote.textContent = "";
  state.routes = [];
  state.selectedId = null;

  try {
    setStatus("Generating loop routes…");
    const candidates = await fetchCandidates(state.start, meters);
    if (!candidates.length) {
      throw new Error("No routes found here — try a different start point or distance.");
    }

    setStatus(`Found ${candidates.length} loops. Fetching trees and buildings…`);
    const shadeData = await fetchShadeData(bboxOfRoutes(candidates), candidates);

    setStatus("Scoring shade…");
    const midRun = new Date(startAt.getTime() + (miles * CONFIG.PACE_MIN_PER_MILE * 60000) / 2);
    const midSun = SunCalc.getPosition(midRun, state.start[1], state.start[0]);
    if (midSun.altitude <= 0) {
      els.sunNote.textContent =
        "The sun is down for most of that run — dark stretches count as fully shaded.";
    }

    state.routes = candidates.map((c, i) => {
      const samples = samplePoints(c.coords, CONFIG.SAMPLE_STEP_M);
      const sunPos = samples.map((pt, si) => {
        const t = new Date(startAt.getTime() + ((si * CONFIG.SAMPLE_STEP_M) / speedMps) * 1000);
        return SunCalc.getPosition(t, pt[1], pt[0]);
      });
      const shadeVals = scoreSamples(samples, shadeData, sunPos);
      const shadePct = (shadeVals.reduce((a, v) => a + v, 0) / shadeVals.length) * 100;
      const overlap = overlapFraction(samples);
      return {
        id: i,
        coords: c.coords,
        miles: c.meters / 1609.34,
        samples,
        shadeVals,
        shadePct,
        overlapPct: overlap * 100,
        rankScore: 0,
      };
    });
    rankRoutes();

    renderResults();
    setStatus("");
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    els.goBtn.disabled = false;
  }
}

const SHADE_LOW = [232, 89, 12]; // sunny orange
const SHADE_HIGH = [43, 138, 62]; // shady green

function shadeColor(v) {
  const c = SHADE_LOW.map((lo, i) => Math.round(lo + (SHADE_HIGH[i] - lo) * v));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// Average shadeVals into nBuckets values for the profile strip.
function bucketize(vals, nBuckets) {
  const out = [];
  for (let b = 0; b < nBuckets; b++) {
    const lo = Math.floor((b * vals.length) / nBuckets);
    const hi = Math.max(lo + 1, Math.floor(((b + 1) * vals.length) / nBuckets));
    let sum = 0;
    for (let i = lo; i < hi; i++) sum += vals[i];
    out.push(sum / (hi - lo));
  }
  return out;
}

function renderResults() {
  routeLayer.clearLayers();
  els.results.innerHTML = "";

  const letters = "ABCDEFGHIJ";
  let bounds = null;

  state.routes.forEach((route, rank) => {
    const latlngs = route.coords.map(([lon, lat]) => [lat, lon]);
    if (route.id === state.selectedId) {
      // Selected route: draw shade-colored segments between samples.
      for (let i = 1; i < route.samples.length; i++) {
        const seg = [
          [route.samples[i - 1][1], route.samples[i - 1][0]],
          [route.samples[i][1], route.samples[i][0]],
        ];
        L.polyline(seg, {
          color: shadeColor((route.shadeVals[i - 1] + route.shadeVals[i]) / 2),
          weight: 6,
          opacity: 0.95,
        }).addTo(routeLayer);
      }
    } else {
      L.polyline(latlngs, { color: "#6b7280", weight: 3, opacity: 0.55 })
        .on("click", () => selectRoute(route.id))
        .addTo(routeLayer);
    }
    const rb = L.latLngBounds(latlngs);
    bounds = bounds ? bounds.extend(rb) : rb;

    const runMin = route.miles * CONFIG.PACE_MIN_PER_MILE;
    const sunMin = Math.round((1 - route.shadePct / 100) * runMin);
    const strip = bucketize(route.shadeVals, 60)
      .map((v) => `<span style="background:${shadeColor(v)}"></span>`)
      .join("");
    const overlapNote =
      route.overlapPct > 25
        ? ` · <span class="warn">repeats ${route.overlapPct.toFixed(0)}% of its path</span>`
        : "";

    const card = document.createElement("div");
    card.className = "card" + (route.id === state.selectedId ? " selected" : "");
    card.innerHTML = `
      <div class="card-top">
        <span class="route-name">Route ${letters[rank]}</span>
        <span class="shade-pct">${route.shadePct.toFixed(0)}% shade</span>
      </div>
      <div class="profile">${strip}</div>
      <div class="profile-caption"><span>start</span><span>finish</span></div>
      <div class="card-meta">${route.miles.toFixed(1)} mi · ≈${sunMin} min in direct sun${overlapNote}</div>`;
    card.addEventListener("click", () => selectRoute(route.id));
    els.results.appendChild(card);
  });

  if (bounds && state.selectedId === null) map.fitBounds(bounds, { padding: [30, 30] });
}

function selectRoute(id) {
  state.selectedId = state.selectedId === id ? null : id;
  renderResults();
}
