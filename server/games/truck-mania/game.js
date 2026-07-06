// Truck Mania — city map, the clock, octagon signals, and saved custom maps.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { generateCityMap, randomizeOctagons } from "./map.js";

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

  return {
    seed: `custom-${Date.now()}`,
    width: MAP_W,
    height: MAP_H,
    streetWidth: 10,
    rounded,
    intersections,
    streets,
    blocks: [{ id: "custom", area: 0, buildings }]
  };
}

// ---------------------------------------------------------------------------

// Set TRUCK_MANIA_SAVES=off (e.g. on the hosted deploy) to make the map list
// read-only: the editor still works, but "Save map" is hidden and rejected.
const savingEnabled = process.env.TRUCK_MANIA_SAVES !== "off";

export function createTruckManiaGame({ io, rooms }) {
  let savedMaps = loadSavedMaps();
  const mapsPayload = () => ({
    maps: savedMaps.map(({ id, name }) => ({ id, name })),
    canSave: savingEnabled
  });

  // Playable copy of a saved layout: fresh stoplights every time.
  let hydrateCount = 0;
  function hydrate(savedMap) {
    const map = JSON.parse(JSON.stringify(savedMap));
    map.seed = `${map.seed}-${(hydrateCount += 1)}-${Date.now()}`;
    map.intersections = randomizeOctagons(map.intersections);
    return map;
  }

  function emitState(roomId, room) {
    io.to(roomId).emit("state_update", {
      truckMania: {
        map: room.truckMania.map,
        hour: room.truckMania.hour
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
      return {
        truckMania: {
          map: generateCityMap(),
          hour: null
        }
      };
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
