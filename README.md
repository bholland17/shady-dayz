# Shady Dayz

A web app that finds running loops near you and ranks them by how shady they'll be at your run time.

## How it works

1. **Route generation** — [OpenRouteService](https://openrouteservice.org) round-trip routing generates ~10 realistic loop candidates on real streets and paths for your target distance. Loops by construction: no running around the block twenty times.
2. **Shade scoring** — [SunCalc](https://github.com/mourner/suncalc) computes the sun's altitude and azimuth at each point of the run (based on a 10 min/mile pace, so the sun moves as you do). Tree cover (woods, forests, parks, tree rows, individual trees) and building footprints with heights come from OpenStreetMap via the Overpass API. Each route is sampled every 40 m; a sample is shaded if it passes through/near canopy or if a building between it and the sun is tall enough for its shadow to reach. Low sun stretches shadow reach. Routes that double back on themselves get penalized.
3. **Ranking** — sort by total shade, shade early in the run, or shade late in the run. Every route card shows a start-to-finish shade profile strip, and selecting a route paints its shady (green) vs. sunny (orange) stretches on the map.

## Running locally

Any static file server works:

```bash
python3 -m http.server 8788
```

Then open http://localhost:8788.

## Configuration

`config.js` holds the OpenRouteService API key (free tier: 2,000 requests/day — each search uses ~10). Get your own at [openrouteservice.org/dev](https://openrouteservice.org/dev/). Note that in a static deployment the key is visible to anyone; regenerate it if abused.

## Roadmap

- Satellite-derived canopy data (OSM street-tree coverage is sparse in many neighborhoods, so scores skew low).
- iOS app via Capacitor.
