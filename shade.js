// shade.js — canopy data fetch and shade scoring.
//
// Shade model (v1): a route sample point counts as shaded when it sits inside
// or near mapped tree cover from OpenStreetMap. The sun's altitude at run time
// stretches how far a tree's shadow reaches (low sun = longer shadows).
// Building shadows are planned for v2.

const CANOPY_WEIGHTS = {
  wood: 1.0,      // natural=wood, landuse=forest — full canopy
  park: 0.45,     // leisure=park/garden — partial, patchy cover
  treeRow: 0.85,  // natural=tree_row — street tree lines
  tree: 0.7,      // individual mapped trees
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

// Fetch tree cover from Overpass for a [minLon,minLat,maxLon,maxLat] bbox.
async function fetchCanopy(bbox) {
  const bb = `${bbox[1]},${bbox[0]},${bbox[3]},${bbox[2]}`; // south,west,north,east
  const query = `[out:json][timeout:30];
(
  way["natural"~"^(wood|tree_row)$"](${bb});
  relation["natural"="wood"](${bb});
  way["landuse"="forest"](${bb});
  relation["landuse"="forest"](${bb});
  way["leisure"~"^(park|garden)$"](${bb});
  node["natural"="tree"](${bb});
);
out geom;`;
  const res = await fetch(CONFIG.OVERPASS_URL, {
    method: "POST",
    body: "data=" + encodeURIComponent(query),
  });
  if (!res.ok) throw new Error(`Tree data request failed (${res.status}). Try again in a minute.`);
  const json = await res.json();
  return parseCanopy(json.elements || []);
}

function parseCanopy(elements) {
  const canopy = { polygons: [], lines: [], points: [] };

  const addPolygon = (coords, weight) => {
    if (coords.length < 3) return;
    canopy.polygons.push({ ring: coords, weight, bbox: bboxOf(coords) });
  };

  for (const el of elements) {
    const tags = el.tags || {};
    const isWood = tags.natural === "wood" || tags.landuse === "forest";
    const isPark = tags.leisure === "park" || tags.leisure === "garden";

    if (el.type === "node" && tags.natural === "tree") {
      canopy.points.push([el.lon, el.lat]);
    } else if (el.type === "way" && el.geometry) {
      const coords = el.geometry.map((g) => [g.lon, g.lat]);
      if (tags.natural === "tree_row") {
        canopy.lines.push({ line: coords, bbox: bboxOf(coords) });
      } else if (isWood) {
        addPolygon(coords, CANOPY_WEIGHTS.wood);
      } else if (isPark) {
        addPolygon(coords, CANOPY_WEIGHTS.park);
      }
    } else if (el.type === "relation" && el.members) {
      // Multipolygon woods/forests: treat each outer ring as its own polygon.
      // Inner holes are ignored in v1 — a small overestimate of cover.
      for (const m of el.members) {
        if (m.role === "outer" && m.geometry) {
          addPolygon(m.geometry.map((g) => [g.lon, g.lat]), CANOPY_WEIGHTS.wood);
        }
      }
    }
  }
  return canopy;
}

// Shade value 0..1 for each sample point. sunAltitudeRad stretches the reach of
// tree/tree-row shadows: reach multiplier 1x (high sun) up to 3x (low sun).
function scoreSamples(samples, canopy, sunAltitudeRad) {
  const reach =
    sunAltitudeRad > 0
      ? Math.min(3, Math.max(1, 1 / Math.tan(Math.max(sunAltitudeRad, 0.05))))
      : 1.5;
  const rowDist = 12 * reach;
  const treeDist = 9 * reach;

  return samples.map((pt) => {
    let s = 0;
    for (const poly of canopy.polygons) {
      if (poly.weight <= s) continue;
      const b = poly.bbox;
      if (pt[0] < b[0] || pt[0] > b[2] || pt[1] < b[1] || pt[1] > b[3]) continue;
      if (pointInRing(pt, poly.ring)) s = Math.max(s, poly.weight);
      if (s >= 1) return s;
    }
    if (s < CANOPY_WEIGHTS.treeRow) {
      for (const row of canopy.lines) {
        const b = bboxExpand(row.bbox, rowDist, pt[1]);
        if (pt[0] < b[0] || pt[0] > b[2] || pt[1] < b[1] || pt[1] > b[3]) continue;
        if (distToPolylineMeters(pt, row.line, rowDist) < rowDist) {
          s = Math.max(s, CANOPY_WEIGHTS.treeRow);
          break;
        }
      }
    }
    if (s < CANOPY_WEIGHTS.tree) {
      for (const tree of canopy.points) {
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
