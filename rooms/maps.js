// The fishing game's maps. Keep in sync with game/src/data/maps.ts (`size` there is in 16px tiles).
const TILE = 16;

const MAPS = {
  pond: { w: 72, h: 52 },
  river: { w: 80, h: 48 },
  ocean: { w: 80, h: 56 },
  swamp: { w: 72, h: 56 },
};

const isMapId = (id) => typeof id === "string" && Object.prototype.hasOwnProperty.call(MAPS, id);

/** World size of a map in pixels. */
const mapBounds = (id) => ({ w: MAPS[id].w * TILE, h: MAPS[id].h * TILE });

module.exports = { TILE, MAPS, isMapId, mapBounds };
