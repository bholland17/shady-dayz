# Shady Dayz

A web app that finds running loops near you and ranks them by how shady they'll be at your run time.

## How it works

1. **Route generation** — [OpenRouteService](https://openrouteservice.org) round-trip routing generates ~10 realistic loop candidates on real streets and paths for your target distance. Loops by construction: no running around the block twenty times.
2. **Shade scoring** — for your start time, [SunCalc](https://github.com/mourner/suncalc) computes the sun's altitude. Tree cover (woods, forests, parks, tree rows, individual trees) comes from OpenStreetMap via the Overpass API. Each route is sampled every 40 m and each sample scores by the canopy it passes through or near — with low sun stretching how far tree shadows reach. Routes that double back on themselves get penalized.
3. **Ranking** — routes are sorted shadiest-first. Select one to see exactly which stretches are shady (green) vs. sunny (orange).

## Running locally

Any static file server works:

```bash
python3 -m http.server 8788
```

Then open http://localhost:8788.

## Configuration

`config.js` holds the OpenRouteService API key (free tier: 2,000 requests/day — each search uses ~10). Get your own at [openrouteservice.org/dev](https://openrouteservice.org/dev/). Note that in a static deployment the key is visible to anyone; regenerate it if abused.

## Roadmap

- **v2** — building-shadow modeling (footprints + heights + sun azimuth), smarter canopy weighting, route caching.
- **v3** — iOS app via Capacitor.
