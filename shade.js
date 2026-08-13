// shade.js — shade data fetch (trees + buildings) and per-sample shade scoring.
//
// Shade model (v2): a route sample point counts as shaded when it sits inside
// or near mapped tree cover, OR when a building stands between it and the sun
// and is tall enough for its shadow to reach. Sun altitude and azimuth are
// computed per sample from the runner's estimated position in time, so a long
// run's shade profile shifts as the sun moves.

const CANOPY_WEIGHTS = {
  wood: 1.0,      // natural=wood, landuse=forest — full canopy
  park: 0.45,     // leisure=park/garden — partial, patchy cover
  treeRow: 0.85,  // natural=tree_row — street tree lines
  tree: 0.7,      // individual mapped trees
};

const BUILDING = {
  defaultHeight: 6,   // meters, when OSM has no height/levels tag (~2 stories)
  metersPerLevel: 3.2,
  maxShadowReach: 90, // cap probe distance toward the sun
  fetchAround: 70,    // fetch buildings within this many meters of a route
};

const M_PER_DEG_LAT = 111320;

function metersPerDegLon(lat) {
  return M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}

// Great-enough distance in meters between two [lon, lat] points (equirectangular).
function distMeters(a, b) {
  const mLon = metersPerDegLon((a[1] + b[1]) / 2);
  const dx = (a[0] - b[0]) * mLon;
  const dy = (a[1] - b[1]) * M_PER_DEG_LAT;
  return Math.sqrt(dx * dx + dy * dy);
}

// Resample a [lon,lat] polyline at a fixed interval in meters.
function samplePoints(coords, stepM) {
  const out = [coords[0]];
  let carry = 0;
  for (let i = 1; i < coords.length; i++) {
    let a = coords[i - 1];
    const b = coords[i];
    let seg = distMeters(a, b);
    while (carry + seg >= stepM) {
      const need = stepM - carry;
      const t = need / seg;
      a = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      out.push(a);
      seg -= need;
      carry = 0;
    }
    carry += seg;
  }
  return out;
}

// Fraction of the route that doubles back on itself: samples that pass within
// 20 m of a non-adjacent part of the route (ring distance > 12 samples).
function overlapFraction(samples) {
  const n = samples.length;
  if (n < 30) return 0;
  let hits = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const ring = Math.min(j - i, n - (j - i));
      if (ring <= 12) continue;
      if (distMeters(samples[i], samples[j]) < 20) {
        hits++;
        break;
      }
    }
  }
  return hits / n;
}

function bboxOf(coords) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [lon, lat] of coords) {
    if (lon < b[0]) b[0] = lon;
    if (lat < b[1]) b[1] = lat;
    if (lon > b[2]) b[2] = lon;
    if (lat > b[3]) b[3] = lat;
  }
  return b;
}

function bboxExpand(b, meters, lat) {
  const dLon = meters / metersPerDegLon(lat);
  const dLat = meters / M_PER_DEG_LAT;
  return [b[0] - dLon, b[1] - dLat, b[2] + dLon, b[3] + dLat];
}

function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function distToPolylineMeters(pt, line, cutoffM) {
  const mLon = metersPerDegLon(pt[1]);
  const px = pt[0] * mLon;
  const py = pt[1] * M_PER_DEG_LAT;
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const ax = line[i - 1][0] * mLon, ay = line[i - 1][1] * M_PER_DEG_LAT;
    const bx = line[i][0] * mLon, by = line[i][1] * M_PER_DEG_LAT;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const ex = ax + t * dx - px, ey = ay + t * dy - py;
    const d = Math.sqrt(ex * ex + ey * ey);
    if (d < best) best = d;
    if (best < cutoffM) return best;
  }
  return best;
}

function buildingHeight(tags) {
  const h = parseFloat(tags.height || tags["building:height"]);
  if (h > 0) return Math.min(h, 150);
  const lv = parseFloat(tags["building:levels"]);
  if (lv > 0) return Math.min(lv * BUILDING.metersPerLevel, 150);
  return BUILDING.defaultHeight;
}

// The public Overpass server allows ~2 concurrent slots per IP, so a burst of
// queries can bounce with 429 — one polite retry covers that.
async function overpassElements(query, attempt = 0) {
  let res;
  try {
    res = await fetch(CONFIG.OVERPASS_URL, {
      method: "POST",
      body: "data=" + encodeURIComponent(query),
    });
  } catch (err) {
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 3000));
      return overpassElements(query, attempt + 1);
    }
    throw err;
  }
  if (!res.ok) {
    if (attempt < 2 && (res.status === 429 || res.status === 504)) {
      await new Promise((r) => setTimeout(r, 3000));
      return overpassElements(query, attempt + 1);
    }
    throw new Error(`Map data request failed (${res.status}). Try again in a minute.`);
  }
  return (await res.json()).elements || [];
}

// Tree cover for a [minLon,minLat,maxLon,maxLat] bbox. Independent of the
// generated routes, so it can run in parallel with route generation.
function fetchCanopyElements(bbox) {
  const bb = `${bbox[1]},${bbox[0]},${bbox[3]},${bbox[2]}`; // south,west,north,east
  return overpassElements(`[out:json][timeout:40];
(
  way["natural"~"^(wood|tree_row)$"](${bb});
  relation["natural"="wood"](${bb});
  way["landuse"="forest"](${bb});
  relation["landuse"="forest"](${bb});
  way["leisure"~"^(park|garden)$"](${bb});
  node["natural"="tree"](${bb});
);
out geom;`);
}

// Buildings in the routes' bounding box. A plain bbox query hits Overpass's
// spatial index and returns in seconds where around-polyline filters take
// minutes; tiny sheds/garages are dropped client-side in parseShadeData.
function fetchBuildingElements(candidates) {
  let b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const c of candidates) {
    const cb = bboxOf(c.coords);
    b = [Math.min(b[0], cb[0]), Math.min(b[1], cb[1]), Math.max(b[2], cb[2]), Math.max(b[3], cb[3])];
  }
  b = bboxExpand(b, BUILDING.fetchAround, (b[1] + b[3]) / 2);
  return overpassElements(`[out:json][timeout:40];
way["building"](${b[1]},${b[0]},${b[3]},${b[2]});
out geom;`);
}

// Large named woods/forests/parks within radiusM of start — candidates for a
// shadier drive-to start point. The length() filter keeps only features with
// a substantial perimeter, so pocket parks don't make the list.
async function fetchShadySpots(start, radiusM) {
  const around = `around:${radiusM},${start[1].toFixed(5)},${start[0].toFixed(5)}`;
  const els = await overpassElements(`[out:json][timeout:25];
(
  way["natural"="wood"]["name"](${around})(if: length() > 1200);
  way["landuse"="forest"]["name"](${around})(if: length() > 1200);
  way["leisure"="park"]["name"](${around})(if: length() > 1200);
  relation["natural"="wood"]["name"](${around})(if: length() > 1500);
  relation["landuse"="forest"]["name"](${around})(if: length() > 1500);
  relation["leisure"="park"]["name"](${around})(if: length() > 1500);
);
out tags center;`);
  const seen = new Set();
  const spots = [];
  for (const el of els) {
    const c = el.center || (el.lat != null ? { lat: el.lat, lon: el.lon } : null);
    if (!c || !el.tags || !el.tags.name || seen.has(el.tags.name)) continue;
    seen.add(el.tags.name);
    const isWood = el.tags.natural === "wood" || el.tags.landuse === "forest";
    const lonlat = [c.lon, c.lat];
    spots.push({
      name: el.tags.name,
      type: isWood ? "woods" : "park",
      lonlat,
      distM: distMeters(start, lonlat),
    });
  }
  spots.sort((a, b) => (a.type === b.type ? a.distM - b.distM : a.type === "woods" ? -1 : 1));
  return spots;
}

// Tree cover in a small box around each candidate spot, fetched as one query.
function fetchSpotCanopyElements(spots, radiusM) {
  const clauses = spots
    .map((s) => {
      const p = s.lonlat;
      const b = bboxExpand([p[0], p[1], p[0], p[1]], radiusM, p[1]);
      const bb = `${b[1]},${b[0]},${b[3]},${b[2]}`;
      return `  way["natural"~"^(wood|tree_row)$"](${bb});
  relation["natural"="wood"](${bb});
  way["landuse"="forest"](${bb});
  relation["landuse"="forest"](${bb});
  way["leisure"~"^(park|garden)$"](${bb});
  node["natural"="tree"](${bb});`;
    })
    .join("\n");
  return overpassElements(`[out:json][timeout:30];
(
${clauses}
);
out geom;`);
}

function gridAround(lonlat, radiusM, stepM) {
  const pts = [];
  const mLon = metersPerDegLon(lonlat[1]);
  for (let dy = -radiusM; dy <= radiusM; dy += stepM) {
    for (let dx = -radiusM; dx <= radiusM; dx += stepM) {
      if (dx * dx + dy * dy <= radiusM * radiusM) {
        pts.push([lonlat[0] + dx / mLon, lonlat[1] + dy / M_PER_DEG_LAT]);
      }
    }
  }
  return pts;
}

// Estimated shade % of the area around a spot: a sampling grid scored against
// tree cover only. Buildings are ignored — the point of driving out is trees,
// and it keeps the query light — so the estimate runs conservative.
function estimateSpotShade(spot, data, when, radiusM) {
  const pts = gridAround(spot.lonlat, radiusM, 75);
  const sun = SunCalc.getPosition(when, spot.lonlat[1], spot.lonlat[0]);
  const vals = scoreSamples(pts, data, pts.map(() => sun));
  return (vals.reduce((a, v) => a + v, 0) / vals.length) * 100;
}

function compassDir(from, to) {
  const dx = (to[0] - from[0]) * metersPerDegLon(from[1]);
  const dy = (to[1] - from[1]) * M_PER_DEG_LAT;
  const dirs = ["E", "NE", "N", "NW", "W", "SW", "S", "SE"];
  const a = Math.atan2(dy, dx);
  return dirs[Math.round(((a + 2 * Math.PI) % (2 * Math.PI)) / (Math.PI / 4)) % 8];
}

function parseShadeData(elements) {
  const data = {
    polygons: [],
    lines: [],
    points: [],
    buildings: [],
    grid: new Map(),
    cellDeg: 0.0008, // ~70-90 m grid cells for the building index
    maxBuildingHeight: 0,
  };

  const addPolygon = (coords, weight) => {
    if (coords.length < 3) return;
    data.polygons.push({ ring: coords, weight, bbox: bboxOf(coords) });
  };

  for (const el of elements) {
    const tags = el.tags || {};
    const isWood = tags.natural === "wood" || tags.landuse === "forest";
    const isPark = tags.leisure === "park" || tags.leisure === "garden";

    if (el.type === "node" && tags.natural === "tree") {
      data.points.push([el.lon, el.lat]);
    } else if (el.type === "way" && el.geometry) {
      const coords = el.geometry.map((g) => [g.lon, g.lat]);
      if (tags.building) {
        const bb = bboxOf(coords);
        // Skip sheds/garages: footprint under ~12x12 m never shades a road.
        const lat = (bb[1] + bb[3]) / 2;
        if ((bb[2] - bb[0]) * metersPerDegLon(lat) < 12 && (bb[3] - bb[1]) * M_PER_DEG_LAT < 12) continue;
        const height = buildingHeight(tags);
        data.buildings.push({ ring: coords, bbox: bb, height });
        if (height > data.maxBuildingHeight) data.maxBuildingHeight = height;
      } else if (tags.natural === "tree_row") {
        data.lines.push({ line: coords, bbox: bboxOf(coords) });
      } else if (isWood) {
        addPolygon(coords, CANOPY_WEIGHTS.wood);
      } else if (isPark) {
        addPolygon(coords, CANOPY_WEIGHTS.park);
      }
    } else if (el.type === "relation" && el.members) {
      // Multipolygon woods/forests: treat each outer ring as its own polygon.
      // Inner holes are ignored — a small overestimate of cover.
      for (const m of el.members) {
        if (m.role === "outer" && m.geometry) {
          addPolygon(m.geometry.map((g) => [g.lon, g.lat]), CANOPY_WEIGHTS.wood);
        }
      }
    }
  }

  // Spatial index: every grid cell a building's bbox touches points at it.
  data.buildings.forEach((b, idx) => {
    const [minLon, minLat, maxLon, maxLat] = b.bbox;
    const c = data.cellDeg;
    for (let i = Math.floor(minLon / c); i <= Math.floor(maxLon / c); i++) {
      for (let j = Math.floor(minLat / c); j <= Math.floor(maxLat / c); j++) {
        const key = i + ":" + j;
        let cell = data.grid.get(key);
        if (!cell) data.grid.set(key, (cell = []));
        cell.push(idx);
      }
    }
  });
  return data;
}

// Is this point in a building's shadow? Probe from the point toward the sun;
// a building hit at distance d shades the point if height > d * tan(altitude).
function inBuildingShadow(pt, sun, data) {
  if (!data.buildings.length) return false;
  const tanAlt = Math.tan(sun.altitude);
  const maxReach = Math.min(BUILDING.maxShadowReach, data.maxBuildingHeight / tanAlt);
  if (maxReach < 3) return false;
  const mLon = metersPerDegLon(pt[1]);
  // SunCalc azimuth: 0 = south, +PI/2 = west. Unit vector toward the sun.
  const dirE = -Math.sin(sun.azimuth);
  const dirN = -Math.cos(sun.azimuth);
  const c = data.cellDeg;
  for (let d = 4; d <= maxReach; d += 6) {
    const probe = [pt[0] + (dirE * d) / mLon, pt[1] + (dirN * d) / M_PER_DEG_LAT];
    const cell = data.grid.get(Math.floor(probe[0] / c) + ":" + Math.floor(probe[1] / c));
    if (!cell) continue;
    for (const bi of cell) {
      const b = data.buildings[bi];
      if (b.height < d * tanAlt) continue;
      const bb = b.bbox;
      if (probe[0] < bb[0] || probe[0] > bb[2] || probe[1] < bb[1] || probe[1] > bb[3]) continue;
      if (pointInRing(probe, b.ring)) return true;
    }
  }
  return false;
}

// Shade value 0..1 per sample. sunPos[i] is the SunCalc position at the
// runner's estimated time at that sample. Night samples count as fully shaded.
function scoreSamples(samples, data, sunPos) {
  return samples.map((pt, i) => {
    const sun = sunPos[i];
    if (sun.altitude <= 0) return 1;

    const reach = Math.min(3, Math.max(1, 1 / Math.tan(Math.max(sun.altitude, 0.05))));
    const rowDist = 12 * reach;
    const treeDist = 9 * reach;

    let s = 0;
    for (const poly of data.polygons) {
      if (poly.weight <= s) continue;
      const b = poly.bbox;
      if (pt[0] < b[0] || pt[0] > b[2] || pt[1] < b[1] || pt[1] > b[3]) continue;
      if (pointInRing(pt, poly.ring)) s = Math.max(s, poly.weight);
      if (s >= 1) return s;
    }
    if (inBuildingShadow(pt, sun, data)) return 1;
    if (s < CANOPY_WEIGHTS.treeRow) {
      for (const row of data.lines) {
        const b = bboxExpand(row.bbox, rowDist, pt[1]);
        if (pt[0] < b[0] || pt[0] > b[2] || pt[1] < b[1] || pt[1] > b[3]) continue;
        if (distToPolylineMeters(pt, row.line, rowDist) < rowDist) {
          s = Math.max(s, CANOPY_WEIGHTS.treeRow);
          break;
        }
      }
    }
    if (s < CANOPY_WEIGHTS.tree) {
      for (const tree of data.points) {
        if (Math.abs(tree[1] - pt[1]) * M_PER_DEG_LAT > treeDist) continue;
        if (distMeters(tree, pt) < treeDist) {
          s = Math.max(s, CANOPY_WEIGHTS.tree);
          break;
        }
      }
    }
    return s;
  });
}
