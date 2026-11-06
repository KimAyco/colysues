// Map IDs and default dimensions mirror APIdatabase/seed_maps.php. Runtime map data is
// loaded from the game API; these bounds let rooms reject invalid joins before that data loads.
const FISHING_MAP_IDS = [
  "pond",
  "river",
  "ocean",
  "swamp",
  "alpine-lake",
  "pine-reservoir",
  "coral-reef",
  "arctic-bay",
  "mangrove-marsh",
  "volcanic-spring",
  "moonlit-lagoon",
  "waterfall-gorge",
  "canyon-stream",
  "crystal-cavern",
  "delta-wetlands",
];

const TILE = 16;
const MAPS = Object.fromEntries([
  ...FISHING_MAP_IDS.map((id) => [id, { w: 64, h: 40 }]),
  ["market", { w: 32, h: 24 }],
]);

const isMapId = (id) => typeof id === "string" && Object.prototype.hasOwnProperty.call(MAPS, id);

/** World size of a map in pixels. */
const mapBounds = (id) => ({ w: MAPS[id].w * TILE, h: MAPS[id].h * TILE });

module.exports = { TILE, MAPS, FISHING_MAP_IDS, isMapId, mapBounds };
