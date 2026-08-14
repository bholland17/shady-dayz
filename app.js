// app.js — Shady Dayz: map UI, route generation, ranking, route detail.

const state = {
  start: null, // [lon, lat]
  routes: [],
  selectedId: null,
  shadeData: null, // canopy + buildings from the last search, for re-scoring variants
  startAt: null,
};

const els = {
  address: document.getElementById("address"),
  addrBtn: document.getElementById("addrBtn"),
  distance: document.getElementById("distance"),
  startTime: document.getElementById("startTime"),
  priority: document.getElementById("priority"),
  optQuiet: document.getElementById("optQuiet"),
  optGreen: document.getElementById("optGreen"),
  optSteps: document.getElementById("optSteps"),
  gpxFile: document.getElementById("gpxFile"),
  legend: document.getElementById("legend"),
  locateBtn: document.getElementById("locateBtn"),
  goBtn: document.getElementById("goBtn"),
  status: document.getElementById("status"),
  sunNote: document.getElementById("sunNote"),
  results: document.getElementById("results"),
  suggest: document.getElementById("suggest"),
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

async function geocode(query) {
  // A bare 5-digit zip is ambiguous worldwide (Germany, France, Ukraine…) —
  // bias those to the US; anything with words geocodes unbiased.
  const usZip = /^\d{5}(-\d{4})?$/.test(query) ? "&countrycodes=us" : "";
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1${usZip}&q=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Address lookup failed — try again in a moment.");
  const arr = await res.json();
  if (!arr.length) throw new Error("Couldn't find that address or zip.");
  return { lonlat: [parseFloat(arr[0].lon), parseFloat(arr[0].lat)], label: arr[0].display_name };
}

async function setStartFromAddress() {
  const q = els.address.value.trim();
  if (!q) return;
  setStatus("Looking up address…");
  try {
    const hit = await geocode(q);
    setStart(hit.lonlat);
    setStatus(`Start set: ${hit.label.split(",").slice(0, 3).join(",")}`);
  } catch (err) {
    setStatus(err.message, true);
  }
}

els.addrBtn.addEventListener("click", setStartFromAddress);
els.address.addEventListener("keydown", (e) => {
  if (e.key === "Enter") setStartFromAddress();
});

els.goBtn.addEventListener("click", generate);

els.priority.addEventListener("change", () => {
  if (!state.routes.length) return;
  rankRoutes();
  renderResults();
});

els.gpxFile.addEventListener("change", async () => {
  const file = els.gpxFile.files[0];
  if (!file) return;
  try {
    await scoreGpxText(await file.text(), file.name);
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    els.gpxFile.value = "";
  }
});

// Route preference checkboxes map to ORS walking-profile options.
function orsRouteOptions() {
  const opts = {};
  if (els.optSteps.checked) opts.avoid_features = ["steps"];
  const weightings = {};
  if (els.optQuiet.checked) weightings.quiet = 0.8;
  if (els.optGreen.checked) weightings.green = 0.8;
  if (Object.keys(weightings).length) opts.profile_params = { weightings };
  return opts;
}

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
        ...orsRouteOptions(),
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

function clearResultsUI() {
  routeLayer.clearLayers();
  els.results.innerHTML = "";
  els.suggest.innerHTML = "";
  els.sunNote.textContent = "";
  state.routes = [];
  state.selectedId = null;
}

// Shared tail of every search: parse shade data, score, note sunrise/sunset,
// rank and render. runMiles drives the sun-note window and pace math.
function finishScoring(candidates, canopyEls, buildingEls, startAt, runMiles, { suggest = true } = {}) {
  const shadeData = parseShadeData(canopyEls.concat(buildingEls));
  state.shadeData = shadeData;
  state.startAt = startAt;
  const speedMps = 1609.34 / (CONFIG.PACE_MIN_PER_MILE * 60);

  const endRun = new Date(startAt.getTime() + runMiles * CONFIG.PACE_MIN_PER_MILE * 60000);
  const anchor = candidates[0].coords[0];
  const altStart = SunCalc.getPosition(startAt, anchor[1], anchor[0]).altitude;
  const altEnd = SunCalc.getPosition(endRun, anchor[1], anchor[0]).altitude;
  if (altStart <= 0 && altEnd <= 0) {
    els.sunNote.textContent =
      "The sun is down for this entire run — everything counts as full shade.";
  } else if (altStart > 0 && altEnd <= 0) {
    els.sunNote.textContent =
      "The sun sets during this run — the final stretch counts as full shade.";
  } else if (altStart <= 0 && altEnd > 0) {
    els.sunNote.textContent =
      "The sun rises during this run — the opening stretch counts as full shade.";
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
      label: c.label,
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
  if (suggest && state.routes[0].shadePct < CONFIG.SUGGEST_THRESHOLD) suggestShadySpots();
}

async function generate() {
  const miles = parseFloat(els.distance.value);
  if (!state.start || !miles) return;
  const meters = miles * 1609.34;
  const startAt = els.startTime.value ? new Date(els.startTime.value) : new Date();

  els.goBtn.disabled = true;
  clearResultsUI();

  try {
    let candidates, canopyEls;
    if (meters <= CONFIG.PARALLEL_CANOPY_MAX_M) {
      // A round trip can't stray farther than half its length from the start,
      // so tree cover for that circle can download while routes generate.
      setStatus("Generating loops and fetching tree cover…");
      const pt = state.start;
      const canopyBbox = bboxExpand([pt[0], pt[1], pt[0], pt[1]], meters * 0.5 + 150, pt[1]);
      [candidates, canopyEls] = await Promise.all([
        fetchCandidates(state.start, meters),
        fetchCanopyElements(canopyBbox),
      ]);
    } else {
      setStatus("Generating loop routes…");
      candidates = await fetchCandidates(state.start, meters);
      setStatus("Fetching tree cover…");
      canopyEls = await fetchCanopyElements(bboxOfRoutes(candidates));
    }
    if (!candidates.length) {
      throw new Error("No routes found here — try a different start point or distance.");
    }

    setStatus(`Found ${candidates.length} loops. Fetching buildings…`);
    const buildingEls = await fetchBuildingElements(candidates);
    finishScoring(candidates, canopyEls, buildingEls, startAt, miles);
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    els.goBtn.disabled = false;
  }
}

// Score an uploaded GPX course (race route) with the same shade model.
async function scoreGpxText(text, filename) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  const coords = [...doc.querySelectorAll("trkpt, rtept")]
    .map((p) => [parseFloat(p.getAttribute("lon")), parseFloat(p.getAttribute("lat"))])
    .filter((c) => isFinite(c[0]) && isFinite(c[1]));
  if (coords.length < 2) throw new Error("No track points found in that GPX file.");
  let meters = 0;
  for (let i = 1; i < coords.length; i++) meters += distMeters(coords[i - 1], coords[i]);
  const miles = meters / 1609.34;
  const label = filename.replace(/\.gpx$/i, "");
  const startAt = els.startTime.value ? new Date(els.startTime.value) : new Date();

  els.goBtn.disabled = true;
  clearResultsUI();
  setStart(coords[0], false);
  try {
    setStatus(`Scoring “${label}” (${miles.toFixed(1)} mi)…`);
    const candidates = [{ coords, meters, label }];
    const canopyEls = await fetchCanopyElements(bboxOfRoutes(candidates));
    const buildingEls = await fetchBuildingElements(candidates);
    finishScoring(candidates, canopyEls, buildingEls, startAt, miles, { suggest: false });
    selectRoute(0);
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    els.goBtn.disabled = false;
  }
}

const SHADE_LOW = [245, 158, 11]; // full sun — warm amber
const SHADE_HIGH = [61, 75, 102]; // full shade — cool slate (shadow), distinct from grey route lines

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

// Re-score a route run in reverse and/or with a shifted start time, against
// the shade data already in memory. Cheap: no network.
function scoreVariant(route, { reverse = false, shiftMin = 0 } = {}) {
  const samples = reverse ? [...route.samples].reverse() : route.samples;
  const t0 = new Date(state.startAt.getTime() + shiftMin * 60000);
  const speedMps = 1609.34 / (CONFIG.PACE_MIN_PER_MILE * 60);
  const sunPos = samples.map((pt, si) => {
    const t = new Date(t0.getTime() + ((si * CONFIG.SAMPLE_STEP_M) / speedMps) * 1000);
    return SunCalc.getPosition(t, pt[1], pt[0]);
  });
  const vals = scoreSamples(samples, state.shadeData, sunPos);
  return (vals.reduce((a, v) => a + v, 0) / vals.length) * 100;
}

function improvementTips(route) {
  if (!state.shadeData || !state.startAt) return [];
  const tips = [];
  const base = route.shadePct;
  const rev = scoreVariant(route, { reverse: true });
  if (rev - base >= 5) {
    tips.push(`Run the loop in the other direction: ${base.toFixed(0)}% → ${rev.toFixed(0)}% shade.`);
  }
  for (const shift of [-60, 60]) {
    const p = scoreVariant(route, { shiftMin: shift });
    if (p - base >= 8) {
      tips.push(
        `Start an hour ${shift < 0 ? "earlier" : "later"}: ${base.toFixed(0)}% → ${p.toFixed(0)}% shade.`
      );
    }
  }
  return tips;
}

// Expanded detail for the selected route: per-mile shade, the longest sunny
// stretch, and computed ways to make the same route shadier.
function buildDetail(route) {
  const d = document.createElement("div");
  d.className = "detail";
  const stepM = CONFIG.SAMPLE_STEP_M;

  const perMile = [];
  route.shadeVals.forEach((v, i) => {
    const m = Math.floor((i * stepM) / 1609.34);
    (perMile[m] = perMile[m] || []).push(v);
  });
  const miles = document.createElement("div");
  miles.className = "miles";
  perMile.forEach((vals, m) => {
    const pct = (vals.reduce((a, v) => a + v, 0) / vals.length) * 100;
    const row = document.createElement("div");
    row.className = "mile-row";
    row.innerHTML = `<span class="mile-label">Mi ${m + 1}</span><div class="mile-bar"><div style="width:${pct.toFixed(0)}%; background:${shadeColor(pct / 100)}"></div></div><span class="mile-pct">${pct.toFixed(0)}%</span>`;
    miles.appendChild(row);
  });
  d.appendChild(miles);

  let cur = 0, best = 0, bestEnd = 0;
  route.shadeVals.forEach((v, i) => {
    if (v < 0.4) {
      cur++;
      if (cur > best) {
        best = cur;
        bestEnd = i;
      }
    } else cur = 0;
  });
  if (best * stepM > 500) {
    const note = document.createElement("p");
    note.className = "detail-note";
    note.textContent = `Longest sunny stretch: ${((best * stepM) / 1609.34).toFixed(1)} mi around mile ${(((bestEnd - best / 2) * stepM) / 1609.34).toFixed(1)}.`;
    d.appendChild(note);
  }

  const tips = improvementTips(route);
  const tipHead = document.createElement("p");
  tipHead.className = "detail-note";
  if (tips.length) {
    tipHead.textContent = "Make it shadier:";
    d.appendChild(tipHead);
    const ul = document.createElement("ul");
    ul.className = "tips";
    for (const t of tips) {
      const li = document.createElement("li");
      li.textContent = t;
      ul.appendChild(li);
    }
    d.appendChild(ul);
  } else {
    tipHead.textContent = "Reversing the loop or shifting the start an hour doesn't beat this plan.";
    d.appendChild(tipHead);
  }
  return d;
}

function renderResults() {
  routeLayer.clearLayers();
  els.results.innerHTML = "";
  els.legend.hidden = !state.routes.length;

  const letters = "ABCDEFGHIJ";
  let bounds = null;
  let selectedBounds = null;

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
      selectedBounds = L.latLngBounds(latlngs);
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
        <span class="route-name"></span>
        <span class="shade-pct">${route.shadePct.toFixed(0)}% shade</span>
      </div>
      <div class="profile">${strip}</div>
      <div class="profile-caption"><span>start</span><span>finish</span></div>
      <div class="card-meta">${route.miles.toFixed(1)} mi · ≈${sunMin} min in direct sun${overlapNote}</div>`;
    card.querySelector(".route-name").textContent = route.label || `Route ${letters[rank]}`;
    card.addEventListener("click", () => selectRoute(route.id));
    if (route.id === state.selectedId) card.appendChild(buildDetail(route));
    els.results.appendChild(card);
  });

  if (selectedBounds) map.fitBounds(selectedBounds, { padding: [40, 40] });
  else if (bounds && state.selectedId === null) map.fitBounds(bounds, { padding: [30, 30] });
}

function selectRoute(id) {
  state.selectedId = state.selectedId === id ? null : id;
  renderResults();
}

// When local routes score poorly, find big named woods/parks a short drive
// away, estimate the shade around each one, and offer only the spots that
// meaningfully beat the best local route. Clicking one re-runs the search.
async function suggestShadySpots() {
  const origin = state.start;
  const bestPct = state.routes[0].shadePct;
  els.suggest.textContent =
    "Not much shade around here — checking whether nearby parks and woods would do better…";
  try {
    const candidates = (await fetchShadySpots(origin, CONFIG.SUGGEST_RADIUS_M))
      .filter((s) => s.distM > 1000)
      .slice(0, CONFIG.SUGGEST_MAX_CANDIDATES);
    if (!candidates.length || origin !== state.start) {
      els.suggest.innerHTML = "";
      return;
    }

    const spotEls = await fetchSpotCanopyElements(candidates, CONFIG.SUGGEST_EST_RADIUS_M + 100);
    const spotData = parseShadeData(spotEls);
    const miles = parseFloat(els.distance.value) || 5;
    const startAt = els.startTime.value ? new Date(els.startTime.value) : new Date();
    const midRun = new Date(startAt.getTime() + (miles * CONFIG.PACE_MIN_PER_MILE * 60000) / 2);
    for (const s of candidates) {
      s.estPct = estimateSpotShade(s, spotData, midRun, CONFIG.SUGGEST_EST_RADIUS_M);
    }

    const winners = candidates
      .filter((s) => s.estPct >= bestPct + CONFIG.SUGGEST_MARGIN)
      .sort((a, b) => b.estPct - a.estPct)
      .slice(0, 4);
    els.suggest.innerHTML = "";
    if (origin !== state.start) return;
    if (!winners.length) {
      els.suggest.textContent =
        "Shade is thin here, and no park or woods within a short drive looks meaningfully shadier at that time. Running earlier or later may help more than driving.";
      return;
    }

    const head = document.createElement("p");
    head.className = "suggest-head";
    head.textContent = `Not much shade around here — these spots look meaningfully shadier than your best route (${bestPct.toFixed(0)}%). Click one to search from there:`;
    els.suggest.appendChild(head);

    for (const s of winners) {
      const div = document.createElement("div");
      div.className = "spot";
      const name = document.createElement("span");
      name.className = "spot-name";
      name.textContent = s.name;
      const meta = document.createElement("span");
      meta.className = "spot-meta";
      meta.textContent = `est. ~${s.estPct.toFixed(0)}% shade · ${(s.distM / 1609.34).toFixed(1)} mi ${compassDir(origin, s.lonlat)}`;
      div.append(name, meta);
      div.addEventListener("click", () => {
        setStart(s.lonlat);
        generate();
      });
      els.suggest.appendChild(div);
    }
  } catch {
    els.suggest.textContent =
      "Shade is thin here — couldn't check for shadier spots nearby right now, try again in a minute.";
  }
}
