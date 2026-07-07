// Truck Mania — city map, the clock, octagon signals, and saved custom maps.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { generateCityMap, randomizeOctagons, deriveSpots } from "./map.js";

const MAPS_FILE = fileURLToPath(new URL("./saved-maps.json", import.meta.url));
const MAP_W = 960;
const MAP_H = 720;

function loadSavedMaps() {
  try {
    const parsed = JSON.parse(fs.readFileSync(MAPS_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistSavedMaps(maps) {
  try {
    fs.writeFileSync(MAPS_FILE, JSON.stringify(maps, null, 2));
  } catch (err) {
    console.error("truck-mania: failed to persist maps:", err.message);
  }
}

// ---------------------------------------------------------------------------
// Sanitizing client-submitted maps
// ---------------------------------------------------------------------------

function num(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return Math.round(n * 10) / 10;
}

function sanitizePoints(raw, minPts, maxPts) {
  if (!Array.isArray(raw) || raw.length < minPts || raw.length > maxPts) return null;
  const pts = [];
  for (const p of raw) {
    const x = num(p?.[0], -60, MAP_W + 60);
    const y = num(p?.[1], -60, MAP_H + 60);
    if (x === null || y === null) return null;
    pts.push([x, y]);
  }
  return pts;
}

function sanitizeMap(raw) {
  if (!raw || !Array.isArray(raw.streets) || !Array.isArray(raw.blocks)) return null;
  if (!Array.isArray(raw.intersections)) return null;

  const streets = [];
  for (const s of raw.streets.slice(0, 300)) {
    if (s?.kind === "curve") {
      const vals = ["x0", "y0", "cx", "cy", "x1", "y1"].map((k) => num(s[k], -60, MAP_W + 60));
      if (vals.some((v) => v === null)) return null;
      const [x0, y0, cx, cy, x1, y1] = vals;
      streets.push({ kind: "curve", x0, y0, cx, cy, x1, y1, width: 10 });
    } else {
      const vals = ["x1", "y1", "x2", "y2"].map((k) => num(s[k], -60, MAP_W + 60));
      if (vals.some((v) => v === null)) return null;
      const [x1, y1, x2, y2] = vals;
      streets.push({ kind: "line", x1, y1, x2, y2, width: 10 });
    }
  }

  const intersections = [];
  for (const p of raw.intersections.slice(0, 80)) {
    const x = num(p?.x, -30, MAP_W + 30);
    const y = num(p?.y, -30, MAP_H + 30);
    if (x === null || y === null) return null;
    intersections.push({ x, y });
  }
  if (intersections.length < 24) return null;

  const rounded = { tl: 0, tr: 0, br: 0, bl: 0 };
  for (const k of ["tl", "tr", "br", "bl"]) {
    const v = num(raw.rounded?.[k], 0, 200);
    rounded[k] = v === null ? 0 : v;
  }

  const buildings = [];
  for (const block of raw.blocks) {
    for (const b of block?.buildings ?? []) {
      if (buildings.length >= 150) break;
      const color = /^#[0-9a-fA-F]{3,8}$/.test(b?.color) ? b.color : "#8f7e6b";
      const connectors = [];
      for (const c of (b?.connectors ?? []).slice(0, 6)) {
        const vals = ["x1", "y1", "x2", "y2"].map((k) => num(c?.[k], -60, MAP_W + 60));
        if (vals.some((v) => v === null)) continue;
        const [x1, y1, x2, y2] = vals;
        connectors.push({ x1, y1, x2, y2 });
      }
      const points = sanitizePoints(b?.points, 3, 8);
      if (!points) continue;
      buildings.push({ kind: "poly", color, points, connectors });
    }
  }

  const blocks = [{ id: "custom", area: 0, buildings }];
  return {
    seed: `custom-${Date.now()}`,
    width: MAP_W,
    height: MAP_H,
    streetWidth: 10,
    rounded,
    intersections,
    streets,
    blocks,
    spots: deriveSpots({ streets, blocks })
  };
}

// ---------------------------------------------------------------------------

// Set TRUCK_MANIA_SAVES=off (e.g. on the hosted deploy) to make the map list
// read-only: the editor still works, but "Save map" is hidden and rejected.
const savingEnabled = process.env.TRUCK_MANIA_SAVES !== "off";

// The seven package/dropoff colors: the six primary/secondary colors + brown.
const LOC_COLORS = ["#cf4a3c", "#e08a3c", "#e8c33c", "#4f9d57", "#4a72b0", "#8a5bb0", "#8f6b52"];
const GREY = "#aeb3ba"; // pickup buildings
const WHITE = "#f4f1ea"; // empty buildings

// Each dropoff color advances one column on the player board. Orange and brown
// (Locations / Abilities) are intentionally inert for now.
const COLOR_COLUMN = {
  "#e8c33c": "capacity",   // yellow
  "#4a72b0": "variety",    // blue
  "#4f9d57": "aversion",   // green
  "#cf4a3c": "agression",  // red
  "#8a5bb0": "timestones", // purple
  "#e08a3c": "locations",  // orange — inert
  "#8f6b52": "abilities"   // brown — inert
};
const ADVANCING = new Set(["capacity", "variety", "aversion", "agression", "timestones"]);
const PLAYER_COLORS = ["#3ac0c0", "#e0559c"]; // player identity colors (teal, pink)

const emptyColumns = () => ({
  capacity: 0, variety: 0, aversion: 0, agression: 0, timestones: 0, locations: 0, abilities: 0
});

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const k = Math.floor(Math.random() * (i + 1));
    [a[i], a[k]] = [a[k], a[i]];
  }
  return a;
}

const randColor = () => LOC_COLORS[Math.floor(Math.random() * LOC_COLORS.length)];

// Twelve dropoff colors: five colors appear twice, two appear once (all 7 used).
function dropoffColorBag() {
  const cols = shuffle(LOC_COLORS);
  const bag = [...cols.slice(0, 5), ...cols.slice(0, 5), cols[5], cols[6]];
  return shuffle(bag);
}

// Assign every building a role and recolor it: 12 dropoffs (colored, some colors
// shared), 15 pickups (grey; 6 "protected" with circle packages, the rest with
// square packages), the remainder empty white. Mutates the map in place.
let pkgSeq = 0;
function assignLocations(map) {
  const buildings = (map.blocks ?? []).flatMap((b) => b.buildings ?? []);
  buildings.forEach((b) => {
    b.role = "empty";
    b.color = WHITE;
    delete b.dropoffColor;
    delete b.protected;
    delete b.packages;
  });

  const order = shuffle(buildings);
  let cursor = 0;

  const dropoffN = Math.min(12, order.length);
  const bag = dropoffColorBag();
  for (let i = 0; i < dropoffN; i += 1) {
    const b = order[cursor++];
    b.role = "dropoff";
    b.dropoffColor = bag[i];
    b.color = bag[i];
  }

  const pickupN = Math.min(15, order.length - cursor);
  const pickups = order.slice(cursor, cursor + pickupN);
  cursor += pickupN;
  const protectedN = Math.min(6, pickupN);
  pickups.forEach((b, i) => {
    b.role = "pickup";
    b.color = GREY;
    b.protected = i < protectedN;
    b.packages = [];
  });

  // 6 circles: one on each protected pickup.
  for (let i = 0; i < protectedN; i += 1) {
    pickups[i].packages.push({ id: `pkg${pkgSeq++}`, shape: "circle", color: randColor() });
  }
  // 6 squares: on six random normal pickups (one each).
  const normals = shuffle(pickups.slice(protectedN));
  for (let i = 0; i < Math.min(6, normals.length); i += 1) {
    normals[i].packages.push({ id: `pkg${pkgSeq++}`, shape: "square", color: randColor() });
  }
}

function buildingByBid(map, bid) {
  for (const block of map.blocks ?? []) {
    for (const b of block.buildings ?? []) {
      if (b.bid === bid) return b;
    }
  }
  return null;
}

// The building the truck is currently parked at (via its spot), or null.
function truckBuilding(map, truck) {
  const spot = map.spots?.[truck?.spot];
  if (!spot) return null;
  return buildingByBid(map, spot.building);
}

export function createTruckManiaGame({ io, rooms }) {
  let savedMaps = loadSavedMaps();
  const mapsPayload = () => ({
    maps: savedMaps.map(({ id, name }) => ({ id, name })),
    canSave: savingEnabled
  });

  // Playable copy of a saved layout: fresh stoplights every time. Spots are
  // re-derived so maps saved before spots existed still get parking places.
  let hydrateCount = 0;
  function hydrate(savedMap) {
    const map = JSON.parse(JSON.stringify(savedMap));
    map.seed = `${map.seed}-${(hydrateCount += 1)}-${Date.now()}`;
    map.intersections = randomizeOctagons(map.intersections);
    map.spots = deriveSpots(map);
    return map;
  }

  // One truck for now (solo). Starts on a random parking spot, empty.
  function placeTrucks(map) {
    const spots = map.spots ?? [];
    if (!spots.length) return [];
    return [{ id: 0, player: 0, spot: Math.floor(Math.random() * spots.length), cargo: [] }];
  }

  // Assign fresh locations/packages, drop trucks, and reset the player boards.
  function setupBoard(room) {
    assignLocations(room.truckMania.map);
    room.truckMania.trucks = placeTrucks(room.truckMania.map);
    room.truckMania.players = room.truckMania.trucks.map((t, i) => ({
      color: PLAYER_COLORS[i % PLAYER_COLORS.length],
      name: `Player ${i + 1}`,
      columns: emptyColumns()
    }));
  }

  function emitState(roomId, room) {
    io.to(roomId).emit("state_update", {
      truckMania: {
        map: room.truckMania.map,
        hour: room.truckMania.hour,
        trucks: room.truckMania.trucks,
        players: room.truckMania.players
      },
      turn: room.turn
    });
  }

  function playerRoom(socket, roomId) {
    const room = rooms.get(roomId);
    if (!room || room.gameId !== "truck-mania") return null;
    if (!room.players.includes(socket.id)) return null;
    return room;
  }

  return {
    id: "truck-mania",

    createRoomState() {
      const map = generateCityMap();
      const state = { truckMania: { map, hour: null, trucks: [] } };
      setupBoard(state);
      return state;
    },

    emitState,

    registerHandlers(socket) {
      socket.on("truck_mania_list_maps", () => {
        socket.emit("truck_mania_maps", mapsPayload());
      });

      socket.on("truck_mania_regenerate", ({ roomId } = {}) => {
        const room = playerRoom(socket, roomId);
        if (!room) return;
        room.truckMania.map = generateCityMap();
        room.truckMania.hour = null;
        setupBoard(room);
        emitState(roomId, room);
      });

      socket.on("truck_mania_mix_up", ({ roomId } = {}) => {
        const room = playerRoom(socket, roomId);
        if (!room) return;
        const map = room.truckMania.map;
        map.intersections = randomizeOctagons(map.intersections);
        room.truckMania.hour = null;
        emitState(roomId, room);
      });

      socket.on("truck_mania_save_map", ({ roomId, name, map } = {}) => {
        if (!savingEnabled) return;
        const room = playerRoom(socket, roomId);
        if (!room) return;
        const clean = sanitizeMap(map);
        if (!clean) return;
        const entry = {
          id: `m${Date.now()}${Math.floor(Math.random() * 1000)}`,
          name: String(name || "Untitled").slice(0, 40),
          map: clean
        };
        savedMaps.push(entry);
        persistSavedMaps(savedMaps);
        room.truckMania.map = hydrate(entry.map);
        room.truckMania.hour = null;
        setupBoard(room);
        emitState(roomId, room);
        io.to(roomId).emit("truck_mania_maps", mapsPayload());
      });

      socket.on("truck_mania_load_map", ({ roomId, mapId } = {}) => {
        const room = playerRoom(socket, roomId);
        if (!room) return;
        const entry = savedMaps.find((m) => m.id === mapId);
        if (!entry) return;
        room.truckMania.map = hydrate(entry.map);
        room.truckMania.hour = null;
        setupBoard(room);
        emitState(roomId, room);
      });

      // Drive a truck to a new spot. Reachability rules come later; for now any
      // spot is a valid destination.
      socket.on("truck_mania_move_truck", ({ roomId, truckId = 0, spot } = {}) => {
        const room = playerRoom(socket, roomId);
        if (!room) return;
        const trucks = room.truckMania.trucks ?? [];
        const truck = trucks.find((t) => t.id === truckId);
        const spotCount = room.truckMania.map.spots?.length ?? 0;
        if (!truck || !Number.isInteger(spot) || spot < 0 || spot >= spotCount) return;
        if (truck.spot === spot) return;
        truck.spot = spot;
        emitState(roomId, room);
      });

      // Load a package: the truck must be parked at the pickup building holding
      // it; the package moves from the building onto the truck.
      socket.on("truck_mania_pickup", ({ roomId, truckId = 0, packageId } = {}) => {
        const room = playerRoom(socket, roomId);
        if (!room) return;
        const truck = (room.truckMania.trucks ?? []).find((t) => t.id === truckId);
        if (!truck) return;
        const building = truckBuilding(room.truckMania.map, truck);
        if (!building || building.role !== "pickup") return;
        const idx = (building.packages ?? []).findIndex((p) => p.id === packageId);
        if (idx === -1) return;
        const [pkg] = building.packages.splice(idx, 1);
        truck.cargo.push(pkg);
        emitState(roomId, room);
      });

      // Drop off a package: the truck must be at a dropoff whose color matches
      // the package; the package leaves the truck (delivered).
      socket.on("truck_mania_dropoff", ({ roomId, truckId = 0, packageId } = {}) => {
        const room = playerRoom(socket, roomId);
        if (!room) return;
        const truck = (room.truckMania.trucks ?? []).find((t) => t.id === truckId);
        if (!truck) return;
        const building = truckBuilding(room.truckMania.map, truck);
        if (!building || building.role !== "dropoff") return;
        const idx = (truck.cargo ?? []).findIndex((p) => p.id === packageId);
        if (idx === -1) return;
        if (truck.cargo[idx].color !== building.dropoffColor) return;
        truck.cargo.splice(idx, 1);

        // Advance the matching player-board column (orange/brown stay inert).
        const col = COLOR_COLUMN[building.dropoffColor];
        const player = room.truckMania.players?.[truck.player];
        if (player && ADVANCING.has(col)) {
          player.columns[col] = Math.min(5, player.columns[col] + 1);
        }
        emitState(roomId, room);
      });

      // Moving the hand to an hour swaps the colors of the two octagons
      // carrying that number (green <-> red).
      socket.on("truck_mania_set_hour", ({ roomId, hour } = {}) => {
        const room = playerRoom(socket, roomId);
        if (!room) return;
        if (!Number.isInteger(hour) || hour < 1 || hour > 12) return;
        if (room.truckMania.hour === hour) return;

        room.truckMania.hour = hour;
        for (const oct of room.truckMania.map.intersections) {
          if (oct.number === hour) {
            oct.color = oct.color === "green" ? "red" : "green";
          }
        }
        emitState(roomId, room);
      });
    }
  };
}
