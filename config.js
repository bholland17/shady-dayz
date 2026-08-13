// Configuration for Shady Dayz.
// The OpenRouteService key ships to the browser in any static deployment, so it
// is inherently public once the site is live. Free-tier keys are rate-limited
// per key; regenerate at https://openrouteservice.org/dev/ if it gets abused.
const CONFIG = {
  ORS_KEY: "eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6IjAzODljNWZiMGNmNDQ1YzlhOGE4M2U4NzkyNjMxMzg5IiwiaCI6Im11cm11cjY0In0=",
  ORS_URL: "https://api.openrouteservice.org/v2/directions/foot-walking/geojson",
  OVERPASS_URL: "https://overpass-api.de/api/interpreter",
  SEEDS: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  SAMPLE_STEP_M: 40,        // route sampling interval for shade scoring
  PACE_MIN_PER_MILE: 10,    // used to estimate mid-run time for sun position
  SUGGEST_THRESHOLD: 35,    // if the best route's shade % is below this, suggest drive-to spots
  SUGGEST_RADIUS_M: 8000,   // how far to look for shadier start points (~5 mi)
  PARALLEL_CANOPY_MAX_M: 13000, // above this run length, fetch canopy after routes (bbox too big)
};
