// Truck Mania — city map, the clock, octagon signals, and saved custom maps.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { generateCityMap, randomizeOctagons, deriveSpots } from "./map.js";
import { buildStreetGraph, findPath, redsOnPath, findRouteDirected } from "./routing.js";

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

// A hard, fixed count of each package color across all pickups (90 total = 15
// pickups × 6).
const PACKAGE_COUNTS = {
  "#8f6b52": 10, // brown
  "#4a72b0": 10, // blue
  "#cf4a3c": 10, // red
  "#e08a3c": 12, // orange
  "#e8c33c": 15, // yellow
  "#8a5bb0": 18, // purple
  "#4f9d57": 15  // green
};

// Dropoff locations and their capacities. Every color has two (limits summing
// to its package count) except brown and red, which have one. 12 total.
const DROPOFF_SPEC = [
  ["#8f6b52", 10], ["#cf4a3c", 10],                 // brown, red
  ["#4a72b0", 6], ["#4a72b0", 4],                   // blue
  ["#e08a3c", 8], ["#e08a3c", 4],                   // orange
  ["#e8c33c", 10], ["#e8c33c", 5],                  // yellow
  ["#4f9d57", 10], ["#4f9d57", 5],                  // green
  ["#8a5bb0", 12], ["#8a5bb0", 6]                   // purple
];

// A purple delivery pays out the player's current Time-stones level, then the
// level advances. Mirrors the client's Time stones column: 2, 4, 6, 8, 10, 12.
const TIMESTONE_AWARDS = [2, 4, 6, 8, 10, 12];
const STARTING_TIMESTONES = 3;

// Player-board column values, indexed by the column's current level (0–5).
// Yellow = how many packages a truck can carry, blue = how many distinct
// package colors it can carry at once, green = the number a ticket die must
// come in at or under to be averted.
const COLUMN_VALUES = {
  capacity: [2, 3, 4, 5, 6, 7],
  variety: [1, 2, 3, 4, 5, 6],
  aversion: [1, 2, 3, 4, 5, 6],
  agression: [0, 1, 2, 3, 4, 5]
};

// A delivered package scores points by its shape.
const SHAPE_POINTS = { circle: 4, square: 2 };

// The clock is a 24-hour value (0 = midnight). The game starts at midnight, so
// it starts at night. Night — the only time theft is allowed — is 9pm to 6am
// inclusive.
const START_TIME = 0;
const faceHour = (t) => ((t + 11) % 12) + 1; // 0 -> 12, 13 -> 1, 24h -> face 1-12
const isNight = (t) => t >= 21 || t <= 6;
// Rush hours (7–9am, 4–6pm): every ticket costs double.
const isRushHour = (t) => (t >= 7 && t <= 9) || (t >= 16 && t <= 18);
const freshTurnState = () => ({ acted: false, stolen: false, stealVictim: null, changedTime: false, truck: null });

// Locations deck: two of each letter A–F (12 tiles). Each letter unlocks its
// matching protected location. Abilities deck: two fixed cards, always the only
// two on offer, and they don't deplete.
const LOCATION_LETTERS = ["A", "B", "C", "D", "E", "F"];
// The ability deck (one of each, shuffled, top two on offer). Reverse-time is
// kept working in the clock code but is intentionally left out of the deck.
const ABILITY_CARDS = [
  "uturn", "drive-by-pickup", "drive-by-dropoff", "cheap-time",
  "day-theft", "swerve", "time-lord", "free-parking", "reverse-time", "extra-truck"
];
const buildLocationDeck = () => shuffle(LOCATION_LETTERS.flatMap((l) => [l, l]));
const buildAbilityDeck = () => shuffle(ABILITY_CARDS.slice());

const hasAbility = (player, id) => !!player?.abilities?.includes(id);

// Take one card from a face-up-two deck: a shown card, or a random hidden one.
function drawFromDeck(d, choice) {
  if (!d.length) return null;
  if (choice === "shown0") return d.splice(0, 1)[0];
  if (choice === "shown1") return d.splice(Math.min(1, d.length - 1), 1)[0];
  const j = d.length > 2 ? 2 + Math.floor(Math.random() * (d.length - 2)) : Math.floor(Math.random() * d.length);
  return d.splice(j, 1)[0];
}

const PLAYER_COLORS = ["#3ac0c0", "#e0559c", "#e0a13a", "#7b6fe0"]; // teal, pink, amber, violet
const MAX_AI = 3;
const AI_TIME_MAX_COST = 2;     // an AI only spends time stones on a cheap flip

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

// A shuffled bag of package colors matching the fixed per-color counts.
function packageColorBag() {
  const bag = [];
  for (const [color, count] of Object.entries(PACKAGE_COUNTS)) {
    for (let i = 0; i < count; i += 1) bag.push(color);
  }
  return shuffle(bag);
}

// Assign every building a role and recolor it: 12 dropoffs (each a color + a
// capacity), 15 pickups (grey; 6 "protected" hold circles, 9 normal hold
// squares — six packages each, colored from the fixed bag), rest empty white.
// Mutates in place.
let pkgSeq = 0;
function assignLocations(map) {
  const buildings = (map.blocks ?? []).flatMap((b) => b.buildings ?? []);
  buildings.forEach((b) => {
    b.role = "empty";
    b.color = WHITE;
    delete b.dropoffColor;
    delete b.dropoffLimit;
    delete b.protected;
    delete b.packages;
    delete b.delivered;
    delete b.letter;
  });

  const order = shuffle(buildings);
  let cursor = 0;

  const spec = shuffle(DROPOFF_SPEC.slice());
  const dropoffN = Math.min(spec.length, order.length);
  for (let i = 0; i < dropoffN; i += 1) {
    const b = order[cursor++];
    b.role = "dropoff";
    b.dropoffColor = spec[i][0];
    b.dropoffLimit = spec[i][1];
    b.color = spec[i][0];
    b.delivered = []; // flipped-to-black packages dropped here
  }

  const pickupN = Math.min(15, order.length - cursor);
  const pickups = order.slice(cursor, cursor + pickupN);
  cursor += pickupN;
  const protectedN = Math.min(6, pickupN);
  const letters = shuffle(LOCATION_LETTERS.slice());
  let li = 0;
  const colorBag = packageColorBag();
  pickups.forEach((b, i) => {
    b.role = "pickup";
    b.color = GREY;
    b.protected = i < protectedN;
    // Each protected location carries a letter; the matching location tile
    // unlocks pickups there.
    if (b.protected) b.letter = letters[li++];
    const shape = b.protected ? "circle" : "square";
    b.packages = Array.from({ length: 6 }, () => ({
      id: `pkg${pkgSeq++}`,
      shape,
      color: colorBag.pop() ?? LOC_COLORS[0]
    }));
  });
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

  // Player 0 is the human; players 1..aiCount are AI. Trucks start on distinct
  // random parking spots, empty.
  function placeTrucks(map, count) {
    const spots = map.spots ?? [];
    if (!spots.length) return [];
    const order = shuffle(spots.map((_, i) => i));
    const trucks = [];
    for (let i = 0; i < count && i < order.length; i += 1) {
      // `facing` (degrees) tracks arrival heading so AI routing obeys the
      // no-U-turn rule the same way the human's does.
      trucks.push({ id: i, player: i, spot: order[i], cargo: [], facing: spots[order[i]].angle });
    }
    return trucks;
  }

  // Assign fresh locations/packages, drop trucks, and reset the player boards.
  function setupBoard(room) {
    const aiCount = Math.max(0, Math.min(MAX_AI, room.truckMania.aiCount ?? 0));
    room.truckMania.aiCount = aiCount;
    assignLocations(room.truckMania.map);
    room.truckMania.trucks = placeTrucks(room.truckMania.map, aiCount + 1);
    room.truckMania.players = room.truckMania.trucks.map((t, i) => ({
      color: PLAYER_COLORS[i % PLAYER_COLORS.length],
      name: i === 0 ? "You" : `AI ${i}`,
      isAI: i !== 0,
      columns: emptyColumns(),
      timeStones: STARTING_TIMESTONES,
      points: 0,
      locations: [], // unlocked letters (location tiles on the board)
      abilities: [], // owned ability ids
      pendingDrafts: [] // queued "locations"/"abilities" draws awaiting a pick
    }));
    room.truckMania.lastRoll = null;
    room.truckMania.locationDeck = buildLocationDeck();
    room.truckMania.abilityDeck = buildAbilityDeck();
    room.truckMania.aiGraph = null; // rebuilt lazily against the current map
    room.truckMania.time = START_TIME;
    room.truckMania.turn = 0; // player index whose turn it is; 0 is the human
    room.truckMania.turnState = freshTurnState();
    room.truckMania.aiMove = null; // transient: an AI's chosen path, for the client to animate
  }

  function emitState(roomId, room) {
    const time = room.truckMania.time ?? START_TIME;
    io.to(roomId).emit("state_update", {
      truckMania: {
        map: room.truckMania.map,
        hour: faceHour(time), // 1-12 clock-face hour, for the hand + octagons
        time, // 0-23, for AM/PM + day/night
        night: isNight(time),
        rush: isRushHour(time),
        turn: room.truckMania.turn ?? 0,
        turnState: room.truckMania.turnState ?? freshTurnState(),
        aiMove: room.truckMania.aiMove ?? null,
        trucks: room.truckMania.trucks,
        players: room.truckMania.players,
        lastRoll: room.truckMania.lastRoll ?? null,
        decks: {
          locations: {
            shown: (room.truckMania.locationDeck ?? []).slice(0, 2),
            remaining: (room.truckMania.locationDeck ?? []).length
          },
          abilities: {
            shown: (room.truckMania.abilityDeck ?? []).slice(0, 2),
            remaining: (room.truckMania.abilityDeck ?? []).length
          }
        }
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

  // ---- Shared action core (used by both the socket handlers and the AI) ----

  // Buildings the truck can pick up from / drop off at: normally just the one
  // its spot belongs to, but with Free parking, every building in the same block
  // (the map's building group the parked building belongs to).
  function usableBuildings(map, truck, player) {
    const spot = map.spots?.[truck.spot];
    if (!spot) return [];
    const ownBid = spot.building;
    if (!hasAbility(player, "free-parking")) {
      const b = buildingByBid(map, ownBid);
      return b ? [b] : [];
    }
    const block = (map.blocks ?? []).find((bl) => (bl.buildings ?? []).some((b) => b.bid === ownBid));
    return block ? (block.buildings ?? []).slice() : [];
  }

  function tryPickup(room, truck, packageId) {
    const player = room.truckMania.players?.[truck.player];
    let building = null;
    let idx = -1;
    for (const b of usableBuildings(room.truckMania.map, truck, player)) {
      if (b.role !== "pickup") continue;
      const i = (b.packages ?? []).findIndex((p) => p.id === packageId);
      if (i !== -1) { building = b; idx = i; break; }
    }
    if (!building) return false;
    const pkg = building.packages[idx];
    if (building.protected && building.letter && !(player?.locations ?? []).includes(building.letter)) {
      return false;
    }
    if (player) {
      const capacity = COLUMN_VALUES.capacity[player.columns.capacity];
      if ((truck.cargo?.length ?? 0) >= capacity) return false;
      const variety = COLUMN_VALUES.variety[player.columns.variety];
      const colors = new Set((truck.cargo ?? []).map((p) => p.color));
      if (!colors.has(pkg.color) && colors.size >= variety) return false;
    }
    building.packages.splice(idx, 1);
    truck.cargo.push(pkg);
    return true;
  }

  function tryDropoff(room, truck, packageId) {
    const idx = (truck.cargo ?? []).findIndex((p) => p.id === packageId);
    if (idx === -1) return false;
    const pkg = truck.cargo[idx];
    const player = room.truckMania.players?.[truck.player];
    const building = usableBuildings(room.truckMania.map, truck, player)
      .find((b) => b.role === "dropoff" && b.dropoffColor === pkg.color &&
        (b.delivered?.length ?? 0) < (b.dropoffLimit ?? Infinity));
    if (!building) return false;
    truck.cargo.splice(idx, 1);
    const delivered = pkg;
    (building.delivered ??= []).push(delivered);

    const col = COLOR_COLUMN[building.dropoffColor];
    if (player) player.points += SHAPE_POINTS[delivered.shape] ?? 2;
    if (player && ADVANCING.has(col)) {
      if (col === "timestones") {
        player.timeStones += TIMESTONE_AWARDS[Math.min(5, player.columns.timestones)];
      }
      player.columns[col] = Math.min(5, player.columns[col] + 1);
    } else if (player && col === "locations") {
      player.pendingDrafts.push("locations");
    } else if (player && col === "abilities") {
      player.pendingDrafts.push("abilities");
    }
    return true;
  }

  // Is this truck parked on the same spot as any other truck?
  function sharesSpot(room, truck) {
    return (room.truckMania.trucks ?? []).some((t) => t.id !== truck.id && t.spot === truck.spot);
  }

  // Resolve the human's acting truck for this action: it must belong to the
  // human (player 0), and — since only one truck may act per turn — must match
  // the truck already active this turn, if any.
  function humanTruck(room, truckId) {
    const t = (room.truckMania.trucks ?? []).find((x) => x.id === truckId);
    if (!t || t.player !== 0) return null;
    const ts = room.truckMania.turnState;
    if (ts.truck !== null && ts.truck !== truckId) return null;
    return t;
  }

  // Extra truck: drop a second truck for the player on a random free spot. It
  // shares the player's stats (which live on the player, not the truck).
  function spawnExtraTruck(room, playerIdx) {
    const map = room.truckMania.map;
    const spots = map.spots ?? [];
    const occupied = new Set(room.truckMania.trucks.map((t) => t.spot));
    const free = [];
    spots.forEach((s, i) => { if (!occupied.has(i)) free.push(i); });
    if (!free.length) return;
    const spotIdx = free[Math.floor(Math.random() * free.length)];
    const id = Math.max(...room.truckMania.trucks.map((t) => t.id)) + 1;
    room.truckMania.trucks.push({ id, player: playerIdx, spot: spotIdx, cargo: [], facing: spots[spotIdx].angle });
  }

  // Park the truck at a spot and roll one ticket die per red crossed. A ticket
  // (die over the player's aversion) costs a point — two during rush hour.
  // Points can go negative.
  function applyMove(room, truck, spot, reds) {
    truck.spot = spot;
    const player = room.truckMania.players?.[truck.player];
    let n = Number.isInteger(reds) ? Math.max(0, Math.min(12, reds)) : 0;
    // Swerve: during rush hour, blow past reds with no roll at all.
    if (n > 0 && isRushHour(room.truckMania.time) && hasAbility(player, "swerve")) n = 0;
    if (player && n > 0) {
      const aversion = COLUMN_VALUES.aversion[player.columns.aversion];
      const dice = Array.from({ length: n }, () => 1 + Math.floor(Math.random() * 6));
      const tickets = dice.filter((d) => d > aversion).length;
      const rush = isRushHour(room.truckMania.time);
      const loss = tickets * (rush ? 2 : 1);
      player.points -= loss; // may go negative
      room.truckMania.rollSeq = (room.truckMania.rollSeq || 0) + 1;
      room.truckMania.lastRoll = { seq: room.truckMania.rollSeq, player: truck.player, dice, aversion, tickets, loss, rush };
    } else {
      room.truckMania.lastRoll = null;
    }
  }

  // ---- Turn order + AI drivers ---------------------------------------------

  const aiTimers = new Map(); // roomId -> pending setTimeout handle

  function clearAiTimer(roomId) {
    const t = aiTimers.get(roomId);
    if (t) {
      clearTimeout(t);
      aiTimers.delete(roomId);
    }
  }

  // Hand the turn to the next player, resetting the per-turn flags. If that
  // player is an AI, schedule its turn.
  function advanceTurn(roomId) {
    const room = rooms.get(roomId);
    if (!room || room.gameId !== "truck-mania") return;
    const n = room.truckMania.players?.length ?? 1;
    room.truckMania.turn = ((room.truckMania.turn ?? 0) + 1) % n;
    room.truckMania.turnState = freshTurnState();
    room.truckMania.aiMove = null;
    emitState(roomId, room);
    if (room.truckMania.players[room.truckMania.turn]?.isAI) {
      clearAiTimer(roomId);
      aiTimers.set(roomId, setTimeout(() => runAiTurn(roomId), 700));
    }
  }

  // An AI turn plays in two beats so the human can watch: first it drives to a
  // destination (emit, animate), then a moment later it acts there and ends its
  // turn. AI don't steal.
  function runAiTurn(roomId) {
    const room = rooms.get(roomId);
    if (!room || room.gameId !== "truck-mania") return;
    const idx = room.truckMania.turn;
    if (!room.truckMania.players?.[idx]?.isAI) return;
    const moved = aiMovePhase(room, idx);
    emitState(roomId, room);
    clearAiTimer(roomId);
    // Wait out the client's animations before acting: dice roll (~1.4s) when a
    // ticket was rolled, then the drive.
    const rolled = !!room.truckMania.lastRoll;
    const actDelay = moved ? (rolled ? 3200 : 1800) : 250;
    aiTimers.set(roomId, setTimeout(() => {
      const r = rooms.get(roomId);
      if (!r || r.gameId !== "truck-mania") return;
      aiActPhase(r, idx);
      emitState(roomId, r);
      clearAiTimer(roomId);
      aiTimers.set(roomId, setTimeout(() => advanceTurn(roomId), 550));
    }, actDelay));
  }

  function getAiGraph(room) {
    const map = room.truckMania.map;
    const cache = room.truckMania.aiGraph;
    if (cache && cache.seed === map.seed) return cache.graph;
    const graph = buildStreetGraph(map.streets, map.spots ?? []);
    room.truckMania.aiGraph = { seed: map.seed, graph };
    return graph;
  }

  function canCarryColor(player, truck, color) {
    const variety = COLUMN_VALUES.variety[player.columns.variety];
    const colors = new Set((truck.cargo ?? []).map((p) => p.color));
    return colors.has(color) || colors.size < variety;
  }

  // Nearest free parking spot (straight-line) whose building satisfies
  // predicate. Occupied spots are skipped so an AI never targets one.
  function nearestBuildingSpot(map, here, predicate, occupied) {
    let best = null;
    (map.spots ?? []).forEach((s, i) => {
      if (occupied?.has(i)) return;
      const b = buildingByBid(map, s.building);
      if (!b || !predicate(b)) return;
      const d = (s.x - here.x) ** 2 + (s.y - here.y) ** 2;
      if (!best || d < best.d) best = { d, spot: i };
    });
    return best;
  }

  function lastSegAngle(path) {
    for (let i = path.length - 1; i > 0; i -= 1) {
      const dx = path[i][0] - path[i - 1][0];
      const dy = path[i][1] - path[i - 1][1];
      if (Math.hypot(dx, dy) > 0.01) return (Math.atan2(dy, dx) * 180) / Math.PI;
    }
    return 0;
  }

  // Cheapest clockwise clock change that turns a red on the AI's path green,
  // within its stone budget. Flips it (advancing the time of day) if worthwhile.
  function maybeAiChangeTime(room, player, numbers) {
    if (!numbers.length || player.timeStones <= 0) return false;
    const t = room.truckMania.time ?? START_TIME;
    const curPos = t % 12;
    let best = null;
    for (const num of numbers) {
      const steps = (num % 12 - curPos + 12) % 12;
      if (steps >= 1 && steps <= AI_TIME_MAX_COST && steps <= player.timeStones) {
        if (!best || steps < best.steps) best = { num, steps };
      }
    }
    if (!best) return false;
    player.timeStones -= best.steps;
    room.truckMania.time = (t + best.steps) % 24;
    for (const oct of room.truckMania.map.intersections) {
      if (oct.number === best.num) oct.color = oct.color === "green" ? "red" : "green";
    }
    return true;
  }

  // Beat one of an AI turn: drive to the nearest free pickup (when it has room)
  // or matching dropoff (when full), following the no-U-turn rule and sending
  // the chosen path to the client. Returns whether it moved.
  function aiMovePhase(room, idx) {
    const map = room.truckMania.map;
    const truck = room.truckMania.trucks?.find((t) => t.player === idx);
    const player = room.truckMania.players?.[idx];
    if (!truck || !player) return false;
    const spots = map.spots ?? [];
    const here = spots[truck.spot];
    if (!here) return false;
    const occupied = new Set(room.truckMania.trucks.filter((t) => t.id !== truck.id).map((t) => t.spot));
    const capacity = COLUMN_VALUES.capacity[player.columns.capacity];
    const full = truck.cargo.length >= capacity;

    let target = null;
    if (!full) {
      target = nearestBuildingSpot(map, here, (b) =>
        b.role === "pickup" && !b.protected && (b.packages?.length ?? 0) > 0 &&
        b.packages.some((p) => canCarryColor(player, truck, p.color)), occupied);
    }
    if (!target && truck.cargo.length > 0) {
      const cargoColors = new Set(truck.cargo.map((p) => p.color));
      target = nearestBuildingSpot(map, here, (b) => b.role === "dropoff" && cargoColors.has(b.dropoffColor), occupied);
    }
    if (!target || target.spot === truck.spot) return false;

    const dest = spots[target.spot];
    const graph = getAiGraph(room);
    const heading = truck.facing ?? here.angle;

    let route = findRouteDirected(graph, map.intersections, here.x, here.y, heading, dest.x, dest.y);
    // Optionally green a red on the path, then re-route so the sent path is
    // consistent with the lights the client will see.
    const flip = () => {
      const rd = redsOnPath(route ? route.path : [], map.intersections, [here.x, here.y], [dest.x, dest.y]);
      return rd.count > 0 && maybeAiChangeTime(room, player, rd.numbers);
    };
    if (route && route.reds > 0 && flip()) {
      route = findRouteDirected(graph, map.intersections, here.x, here.y, heading, dest.x, dest.y) || route;
    }

    let path;
    let endAngle;
    let redCount;
    if (route) {
      ({ path, endAngle } = route);
      redCount = route.reds;
    } else {
      // No no-U-turn route (rare): fall back to a plain shortest path.
      path = findPath(graph, here.x, here.y, dest.x, dest.y);
      if (!path) return false;
      const rd = redsOnPath(path, map.intersections, [here.x, here.y], [dest.x, dest.y]);
      if (rd.count > 0) maybeAiChangeTime(room, player, rd.numbers);
      redCount = redsOnPath(path, map.intersections, [here.x, here.y], [dest.x, dest.y]).count;
      endAngle = lastSegAngle(path);
    }

    truck.facing = endAngle;
    applyMove(room, truck, target.spot, redCount);
    room.truckMania.aiMove = { truckId: truck.id, path, endAngle };
    return true;
  }

  // Beat two of an AI turn: pick up / drop off everything it can at its spot.
  function aiActPhase(room, idx) {
    const truck = room.truckMania.trucks?.find((t) => t.player === idx);
    const player = room.truckMania.players?.[idx];
    if (!truck || !player) return;
    const b = truckBuilding(room.truckMania.map, truck);
    if (!b) return;
    for (let guard = 0; guard < 12; guard += 1) {
      if (b.role === "pickup") {
        const capacity = COLUMN_VALUES.capacity[player.columns.capacity];
        if (truck.cargo.length >= capacity) break;
        const pkg = (b.packages ?? []).find((p) => canCarryColor(player, truck, p.color));
        if (!pkg || !tryPickup(room, truck, pkg.id)) break;
      } else if (b.role === "dropoff") {
        const pkg = (truck.cargo ?? []).find((p) => p.color === b.dropoffColor);
        if (!pkg || !tryDropoff(room, truck, pkg.id)) break;
      } else {
        break;
      }
    }
  }

  return {
    id: "truck-mania",

    createRoomState() {
      const map = generateCityMap();
      const state = { truckMania: { map, time: START_TIME, trucks: [] } };
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
        clearAiTimer(roomId);
        room.truckMania.map = generateCityMap();
        setupBoard(room);
        emitState(roomId, room);
      });

      socket.on("truck_mania_mix_up", ({ roomId } = {}) => {
        const room = playerRoom(socket, roomId);
        if (!room) return;
        const map = room.truckMania.map;
        map.intersections = randomizeOctagons(map.intersections);
        room.truckMania.time = START_TIME;
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
        clearAiTimer(roomId);
        room.truckMania.map = hydrate(entry.map);
        setupBoard(room);
        emitState(roomId, room);
        io.to(roomId).emit("truck_mania_maps", mapsPayload());
      });

      socket.on("truck_mania_load_map", ({ roomId, mapId } = {}) => {
        const room = playerRoom(socket, roomId);
        if (!room) return;
        const entry = savedMaps.find((m) => m.id === mapId);
        if (!entry) return;
        clearAiTimer(roomId);
        room.truckMania.map = hydrate(entry.map);
        setupBoard(room);
        emitState(roomId, room);
      });

      // Drive the human's truck (id 0) to a new spot. Only on the human's turn,
      // and only before it has acted (a pickup/delivery ends movement). Moving
      // onto another truck's spot is allowed — that's how a steal is set up. The
      // client routes and reports how many red lights the path crosses; each red
      // rolls a ticket die.
      socket.on("truck_mania_move_truck", ({ roomId, truckId = 0, spot, reds } = {}) => {
        const room = playerRoom(socket, roomId);
        if (!room) return;
        if (room.truckMania.turn !== 0 || room.truckMania.turnState.acted) return;
        const truck = humanTruck(room, truckId);
        const spotCount = room.truckMania.map.spots?.length ?? 0;
        if (!truck || !Number.isInteger(spot) || spot < 0 || spot >= spotCount) return;
        if (truck.spot === spot) return;

        // A spot can hold only one truck. You may drive onto an occupied spot
        // only to steal: night (or Day theft), higher aggression, not already
        // robbed this turn. (Your own other truck can't be robbed, so it blocks.)
        const occupant = (room.truckMania.trucks ?? []).find((t) => t.id !== truck.id && t.spot === spot);
        if (occupant) {
          const ts = room.truckMania.turnState;
          const meP = room.truckMania.players?.[0];
          const occP = room.truckMania.players?.[occupant.player];
          const canRob = !ts.stolen && (isNight(room.truckMania.time) || hasAbility(meP, "day-theft")) &&
            meP && occP &&
            COLUMN_VALUES.agression[meP.columns.agression] > COLUMN_VALUES.agression[occP.columns.agression];
          if (!canRob) return;
        }

        room.truckMania.turnState.truck = truck.id;
        applyMove(room, truck, spot, reds);
        emitState(roomId, room);
      });

      // Load a package onto the human's truck. Normally ends the turn's movement
      // (Drive-by pickup keeps it going), and is blocked while sharing a spot.
      socket.on("truck_mania_pickup", ({ roomId, truckId = 0, packageId } = {}) => {
        const room = playerRoom(socket, roomId);
        if (!room || room.truckMania.turn !== 0) return;
        const truck = humanTruck(room, truckId);
        if (!truck || sharesSpot(room, truck)) return;
        if (tryPickup(room, truck, packageId)) {
          const ts = room.truckMania.turnState;
          ts.truck = truck.id;
          if (!hasAbility(room.truckMania.players?.[0], "drive-by-pickup")) ts.acted = true;
          emitState(roomId, room);
        }
      });

      // Drop off a package from the human's truck at a matching dropoff.
      // Drive-by dropoff keeps movement going.
      socket.on("truck_mania_dropoff", ({ roomId, truckId = 0, packageId } = {}) => {
        const room = playerRoom(socket, roomId);
        if (!room || room.truckMania.turn !== 0) return;
        const truck = humanTruck(room, truckId);
        if (!truck || sharesSpot(room, truck)) return;
        if (tryDropoff(room, truck, packageId)) {
          const ts = room.truckMania.turnState;
          ts.truck = truck.id;
          if (!hasAbility(room.truckMania.players?.[0], "drive-by-dropoff")) ts.acted = true;
          emitState(roomId, room);
        }
      });

      // End the human's turn. Blocked while any of the player's trucks shares a
      // spot with another truck — you can't end on the same space as another.
      socket.on("truck_mania_end_turn", ({ roomId } = {}) => {
        const room = playerRoom(socket, roomId);
        if (!room || room.truckMania.turn !== 0) return;
        const mine = (room.truckMania.trucks ?? []).filter((t) => t.player === 0);
        if (mine.some((t) => sharesSpot(room, t))) return;
        advanceTurn(roomId);
      });

      // Move the clock hand to a face hour, swapping the colors of the two
      // octagons carrying that number (green <-> red) and advancing the time of
      // day. The hand normally sweeps clockwise (one stone per hour, AM/PM flips
      // as it passes 12); Reverse-time lets a player take the cheaper spin. Only
      // on the human's turn.
      socket.on("truck_mania_set_hour", ({ roomId, hour } = {}) => {
        const room = playerRoom(socket, roomId);
        if (!room || room.truckMania.turn !== 0) return;
        if (!Number.isInteger(hour) || hour < 1 || hour > 12) return;

        const t = room.truckMania.time ?? START_TIME;
        const curPos = t % 12;
        const targetPos = hour % 12; // 12 -> 0
        if (targetPos === curPos) return; // hand already there

        const idx = room.players.indexOf(socket.id);
        const players = room.truckMania.players ?? [];
        const player = players[idx] ?? players[0];
        const ts = room.truckMania.turnState;
        // Time normally changes once per turn; Time lord lifts that cap.
        if (ts.changedTime && !hasAbility(player, "time-lord")) return;
        const cw = (targetPos - curPos + 12) % 12;
        const ccw = 12 - cw;
        const reverse = hasAbility(player, "reverse-time");
        let cost = reverse ? Math.min(cw, ccw) : cw;
        if (hasAbility(player, "cheap-time")) cost = Math.ceil(cost / 2); // half, rounded up
        if (!player || player.timeStones < cost) return;
        player.timeStones -= cost;
        ts.changedTime = true;

        room.truckMania.time = reverse && ccw < cw ? (t - ccw + 24) % 24 : (t + cw) % 24;
        for (const oct of room.truckMania.map.intersections) {
          if (oct.number === hour) {
            oct.color = oct.color === "green" ? "red" : "green";
          }
        }
        emitState(roomId, room);
      });

      // Resolve a queued card draft: take one of the two shown cards, or a
      // random hidden one. Both decks deplete.
      socket.on("truck_mania_draft", ({ roomId, deck, choice } = {}) => {
        const room = playerRoom(socket, roomId);
        if (!room) return;
        const idx = room.players.indexOf(socket.id);
        const players = room.truckMania.players ?? [];
        const player = players[idx] ?? players[0];
        if (!player) return;
        const qpos = player.pendingDrafts.indexOf(deck);
        if (qpos === -1) return;

        if (deck === "locations") {
          const card = drawFromDeck(room.truckMania.locationDeck ?? [], choice);
          if (card) player.locations.push(card);
        } else if (deck === "abilities") {
          const card = drawFromDeck(room.truckMania.abilityDeck ?? [], choice);
          if (card === "extra-truck") {
            spawnExtraTruck(room, players.indexOf(player));
            if (!player.abilities.includes(card)) player.abilities.push(card);
          } else if (card && !player.abilities.includes(card)) {
            player.abilities.push(card);
          }
        } else {
          return;
        }

        player.pendingDrafts.splice(qpos, 1);
        emitState(roomId, room);
      });

      // Steal a package from a truck the human has driven onto (same spot).
      // Night only, once per turn (a single victim, but any number of its
      // packages up to the aggression gap — the count is client-enforced), and
      // only before the turn's movement has ended. Stealing does not end
      // movement, but the thief must then move off the shared spot to continue.
      socket.on("truck_mania_steal", ({ roomId, truckId = 0, victimTruckId, packageId } = {}) => {
        const room = playerRoom(socket, roomId);
        if (!room || room.truckMania.turn !== 0) return;
        const ts = room.truckMania.turnState;
        if (ts.acted) return;
        if (ts.stolen && ts.stealVictim !== victimTruckId) return; // one victim per turn
        const trucks = room.truckMania.trucks ?? [];
        const thief = humanTruck(room, truckId);
        const victim = trucks.find((t) => t.id === victimTruckId);
        if (!thief || !victim || victim.id === thief.id || thief.spot !== victim.spot) return;
        const players = room.truckMania.players ?? [];
        const thiefP = players[thief.player];
        const victimP = players[victim.player];
        if (!thiefP || !victimP) return;
        // Night only, unless the thief has Day theft.
        if (!isNight(room.truckMania.time) && !hasAbility(thiefP, "day-theft")) return;
        if (!(COLUMN_VALUES.agression[thiefP.columns.agression] > COLUMN_VALUES.agression[victimP.columns.agression])) {
          return;
        }
        const idx = (victim.cargo ?? []).findIndex((p) => p.id === packageId);
        if (idx === -1) return;
        const pkg = victim.cargo[idx];
        const capacity = COLUMN_VALUES.capacity[thiefP.columns.capacity];
        if ((thief.cargo?.length ?? 0) >= capacity) return;
        const variety = COLUMN_VALUES.variety[thiefP.columns.variety];
        const colors = new Set((thief.cargo ?? []).map((p) => p.color));
        if (!colors.has(pkg.color) && colors.size >= variety) return;
        victim.cargo.splice(idx, 1);
        thief.cargo.push(pkg);
        ts.stolen = true;
        ts.stealVictim = victimTruckId;
        ts.truck = thief.id;
        emitState(roomId, room);
      });

      // Choose how many AI opponents (0–3). Re-deals the board (fresh turn back
      // to the human) with that many trucks. Bumps the seed so the client fully
      // rebuilds (new truck set).
      socket.on("truck_mania_set_opponents", ({ roomId, count } = {}) => {
        const room = playerRoom(socket, roomId);
        if (!room) return;
        clearAiTimer(roomId);
        const n = Math.max(0, Math.min(MAX_AI, Number(count) | 0));
        room.truckMania.aiCount = n;
        setupBoard(room);
        room.truckMania.map.seed = `${room.truckMania.map.seed}-o${n}-${Date.now()}`;
        emitState(roomId, room);
      });
    }
  };
}
