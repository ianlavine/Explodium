// Truck Mania — city map, the clock, octagon signals, and saved custom maps.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { generateCityMap, randomizeOctagons, deriveSpots } from "./map.js";
import { buildStreetGraph, findPath, redsOnPath, findRouteDirected } from "./routing.js";

const MAPS_FILE = fileURLToPath(new URL("./saved-maps.json", import.meta.url));
const SETTINGS_FILE = fileURLToPath(new URL("./saved-settings.json", import.meta.url));
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

function loadSavedSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistSavedSettings(list) {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(list, null, 2));
  } catch (err) {
    console.error("truck-mania: failed to persist settings:", err.message);
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

// ---------------------------------------------------------------------------
// Tunable game settings. Everything numeric a table-tinkerer would want lives
// in one settings object per room: the player-board columns (each a list of
// values — first is the starting value, the list's length is the column's
// length), package counts per color split square/circle, how many protected
// locations there are, starting time stones, and the point values. Presets and
// locally-saved versions can be applied mid-match (the board re-deals).
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS = {
  // Player-board columns, indexed by the column's current level.
  // capacity = packages a truck can carry, variety = distinct colors at once,
  // aversion = the number a ticket die must come in at or under to be averted,
  // agression = steals allowed against weaker trucks, timestones = the payout
  // a purple delivery makes at that level.
  columns: {
    capacity: [2, 3, 4, 5, 6, 7],
    variety: [1, 2, 3, 4, 5, 6],
    aversion: [1, 2, 3, 4, 5, 6],
    agression: [0, 1, 2, 3, 4, 5],
    timestones: [2, 4, 6, 8, 10, 12]
  },
  // Package counts per color by shape. Squares fill the normal pickups (six
  // per building), circles the protected ones — so circles must total
  // protectedCount × 6, squares must divide by 6, and orange (the locations
  // color) must total protectedCount × 2 (two location tiles per letter).
  packages: {
    "#8f6b52": { square: 4, circle: 6 },  // brown  — abilities (10)
    "#4a72b0": { square: 5, circle: 5 },  // blue   — variety (10)
    "#cf4a3c": { square: 5, circle: 5 },  // red    — agression (10)
    "#e08a3c": { square: 12, circle: 0 }, // orange — locations (12)
    "#e8c33c": { square: 9, circle: 6 },  // yellow — capacity (15)
    "#4f9d57": { square: 9, circle: 6 },  // green  — aversion (15)
    "#8a5bb0": { square: 10, circle: 8 }  // purple — timestones (18)
  },
  protectedCount: 6,
  startingTimeStones: 3,
  // Points for delivering each shape, and lost per ticket (rush = rush hour).
  points: { square: 1, circle: 2, ticket: 1, rushTicket: 2 }
};

// Ready-made variants selectable from the tuning menu alongside saved ones.
const SETTING_PRESETS = [
  { id: "preset-classic", name: "★ Classic", settings: DEFAULT_SETTINGS },
  {
    id: "preset-sprint",
    name: "★ Sprint",
    // Shorter columns, fewer packages, richer stones — a quicker game.
    settings: {
      columns: {
        capacity: [3, 4, 6, 7],
        variety: [2, 3, 4, 6],
        aversion: [2, 3, 4, 6],
        agression: [0, 2, 3, 5],
        timestones: [4, 6, 8, 12]
      },
      packages: {
        "#8f6b52": { square: 4, circle: 4 },
        "#4a72b0": { square: 4, circle: 4 },
        "#cf4a3c": { square: 4, circle: 4 },
        "#e08a3c": { square: 8, circle: 0 },
        "#e8c33c": { square: 6, circle: 4 },
        "#4f9d57": { square: 6, circle: 4 },
        "#8a5bb0": { square: 10, circle: 4 }
      },
      protectedCount: 4,
      startingTimeStones: 5,
      points: { square: 1, circle: 2, ticket: 1, rushTicket: 2 }
    }
  },
  {
    id: "preset-gridlock",
    name: "★ Gridlock",
    // Classic board, but tickets hurt — manage the lights or bleed points.
    settings: {
      ...DEFAULT_SETTINGS,
      startingTimeStones: 6,
      points: { square: 1, circle: 2, ticket: 2, rushTicket: 4 }
    }
  }
];

const cloneSettings = (s) => JSON.parse(JSON.stringify(s));

// Letters available to protected locations, in unlock-tile order.
const LETTER_POOL = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"];
const settingsLetters = (settings) =>
  LETTER_POOL.slice(0, Math.min(LETTER_POOL.length, settings.protectedCount));

function intIn(v, min, max) {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

// Validate + normalize a client-submitted settings object. Returns null when
// anything is malformed or the counts don't line up (the same rules the
// client's editor shows before enabling Save).
function sanitizeSettings(raw) {
  if (!raw || typeof raw !== "object") return null;
  const columns = {};
  for (const col of ["capacity", "variety", "aversion", "agression", "timestones"]) {
    const arr = raw.columns?.[col];
    if (!Array.isArray(arr) || arr.length < 2 || arr.length > 12) return null;
    const clean = arr.map((v) => intIn(v, 0, 99));
    if (clean.some((v) => v === null)) return null;
    columns[col] = clean;
  }
  const packages = {};
  let circles = 0;
  let squares = 0;
  for (const color of LOC_COLORS) {
    const p = raw.packages?.[color];
    const sq = intIn(p?.square, 0, 90);
    const ci = intIn(p?.circle, 0, 90);
    if (sq === null || ci === null) return null;
    packages[color] = { square: sq, circle: ci };
    circles += ci;
    squares += sq;
  }
  const protectedCount = intIn(raw.protectedCount, 0, LETTER_POOL.length);
  const startingTimeStones = intIn(raw.startingTimeStones, 0, 40);
  if (protectedCount === null || startingTimeStones === null) return null;
  const points = {};
  for (const k of ["square", "circle", "ticket", "rushTicket"]) {
    const v = intIn(raw.points?.[k], 0, 20);
    if (v === null) return null;
    points[k] = v;
  }
  // The line-up rules: protected locations hold exactly the circles (6 each),
  // normal pickups hold the squares (6 each), and orange feeds the location
  // deck (2 tiles per protected letter).
  if (circles !== protectedCount * 6) return null;
  if (squares % 6 !== 0) return null;
  const orange = packages["#e08a3c"].square + packages["#e08a3c"].circle;
  if (orange !== protectedCount * 2) return null;
  if (squares + circles < 6) return null;
  return { columns, packages, protectedCount, startingTimeStones, points };
}

// Dropoff locations derived from the package counts: brown and red get one
// dropoff holding everything; every other color gets two, split ⌊⅔⌋ / rest
// (matches the classic table exactly).
function dropoffSpecFrom(settings) {
  const spec = [];
  for (const [color, counts] of Object.entries(settings.packages)) {
    const total = (counts.square ?? 0) + (counts.circle ?? 0);
    if (total <= 0) continue;
    if (color === "#8f6b52" || color === "#cf4a3c") {
      spec.push([color, total]);
    } else {
      const a = Math.floor((total * 2) / 3);
      const b = total - a;
      if (a > 0) spec.push([color, a]);
      if (b > 0) spec.push([color, b]);
    }
  }
  return spec;
}

// Players start with a small buffer of points and race to the target total.
const STARTING_POINTS = 5;
const WINNING_POINTS = 25;

// The clock is a 24-hour value (0 = midnight). The game starts at midnight, so
// it starts at night. Night — the only time theft is allowed — is 9pm to 6am
// inclusive.
const START_TIME = 0;
const faceHour = (t) => ((t + 11) % 12) + 1; // 0 -> 12, 13 -> 1, 24h -> face 1-12
const isNight = (t) => t >= 21 || t <= 6;
// Rush hours (7–9am, 4–6pm): every ticket costs double.
const isRushHour = (t) => (t >= 7 && t <= 9) || (t >= 16 && t <= 18);
// Per-turn flags. `pickups` logs this stop's pickups ({pkg, bid, drive, acted})
// so a regretted one can be put back; `driveByPickup`/`driveByDropoff` mark the
// one free drive-by action each ability allows per turn; `actedByDrop` records
// that a dropoff (not a pickup) ended movement, so put-backs can't reopen it.
const freshTurnState = () => ({
  acted: false, stolen: false, stealVictim: null, changedTime: false, truck: null,
  pickups: [], driveByPickup: false, driveByDropoff: false, actedByDrop: false
});

// Locations deck: two of each protected letter. Each letter unlocks its
// matching protected location.
// The ability deck (one of each, shuffled, top two on offer). Reverse-time is
// kept working in the clock code but is intentionally left out of the deck.
const ABILITY_CARDS = [
  "uturn", "drive-by-pickup", "drive-by-dropoff", "cheap-time",
  "day-theft", "swerve", "time-lord", "free-parking", "reverse-time", "extra-truck"
];
const buildLocationDeck = (settings) => shuffle(settingsLetters(settings).flatMap((l) => [l, l]));
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
// When drafting an ability, the AI takes whichever of the two shown ranks first.
const AI_ABILITY_PREF = [
  "extra-truck", "free-parking", "drive-by-dropoff", "drive-by-pickup",
  "day-theft", "cheap-time", "time-lord", "swerve", "uturn", "reverse-time"
];

// How many stones an AI will spend on one clock flip: cheap flips only while
// poor, up to three hours' worth once it's flush.
function aiTimeBudget(player) {
  if (player.timeStones >= 8) return 3;
  if (player.timeStones >= 4) return 2;
  return player.timeStones >= 1 ? 1 : 0;
}

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

// A shuffled bag of package colors for one shape, from the settings' per-color
// counts (squares fill normal pickups, circles the protected ones).
function packageColorBag(shape, packages) {
  const bag = [];
  for (const [color, counts] of Object.entries(packages)) {
    for (let i = 0; i < (counts[shape] ?? 0); i += 1) bag.push(color);
  }
  return shuffle(bag);
}

// Assign every building a role and recolor it per the settings: dropoffs (each
// a color + a capacity derived from the counts), pickups (grey; the protected
// ones hold circles, the rest squares — six packages each, colored from the
// bags), rest empty white. Mutates in place.
let pkgSeq = 0;
function assignLocations(map, settings) {
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

  const spec = shuffle(dropoffSpecFrom(settings));
  const dropoffN = Math.min(spec.length, order.length);
  for (let i = 0; i < dropoffN; i += 1) {
    const b = order[cursor++];
    b.role = "dropoff";
    b.dropoffColor = spec[i][0];
    b.dropoffLimit = spec[i][1];
    b.color = spec[i][0];
    b.delivered = []; // flipped-to-black packages dropped here
  }

  const squareBag = packageColorBag("square", settings.packages);
  const circleBag = packageColorBag("circle", settings.packages);
  const wantPickups = settings.protectedCount + Math.floor(squareBag.length / 6);
  const pickupN = Math.min(wantPickups, order.length - cursor);
  const pickups = order.slice(cursor, cursor + pickupN);
  cursor += pickupN;
  const protectedN = Math.min(settings.protectedCount, pickupN);
  const letters = shuffle(settingsLetters(settings));
  let li = 0;
  pickups.forEach((b, i) => {
    b.role = "pickup";
    b.color = GREY;
    b.protected = i < protectedN;
    // Each protected location carries a letter; the matching location tile
    // unlocks pickups there.
    if (b.protected) b.letter = letters[li++];
    const shape = b.protected ? "circle" : "square";
    const bag = b.protected ? circleBag : squareBag;
    b.packages = Array.from({ length: 6 }, () => ({
      id: `pkg${pkgSeq++}`,
      shape,
      color: bag.pop() ?? LOC_COLORS[0]
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

export function createTruckManiaGame({ io, rooms }) {
  let savedMaps = loadSavedMaps();
  const mapsPayload = () => ({
    maps: savedMaps.map(({ id, name }) => ({ id, name })),
    canSave: savingEnabled
  });

  let savedSettings = loadSavedSettings();
  const settingsPayload = () => ({
    settings: [
      ...SETTING_PRESETS.map(({ id, name }) => ({ id, name })),
      ...savedSettings.map(({ id, name }) => ({ id, name }))
    ],
    canSave: savingEnabled
  });

  // The room's live settings, and value lookups against them. Columns are
  // indexed by the player's current level, clamped to the column's length.
  const S = (room) => room.truckMania.settings ?? DEFAULT_SETTINGS;
  const colValue = (room, player, col) => {
    const vals = S(room).columns[col] ?? DEFAULT_SETTINGS.columns[col];
    return vals[Math.min(player?.columns?.[col] ?? 0, vals.length - 1)];
  };
  const maxLevel = (room, col) => (S(room).columns[col]?.length ?? 6) - 1;
  const shapePts = (room, shape) =>
    shape === "circle" ? S(room).points.circle : S(room).points.square;

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
    const settings = S(room);
    const aiCount = Math.max(0, Math.min(MAX_AI, room.truckMania.aiCount ?? 0));
    room.truckMania.aiCount = aiCount;
    assignLocations(room.truckMania.map, settings);
    room.truckMania.trucks = placeTrucks(room.truckMania.map, aiCount + 1);
    room.truckMania.players = room.truckMania.trucks.map((t, i) => ({
      color: PLAYER_COLORS[i % PLAYER_COLORS.length],
      name: i === 0 ? "You" : `AI ${i}`,
      isAI: i !== 0,
      columns: emptyColumns(),
      timeStones: settings.startingTimeStones,
      points: STARTING_POINTS,
      locations: [], // unlocked letters (location tiles on the board)
      abilities: [], // owned ability ids
      pendingDrafts: [] // queued "locations"/"abilities" draws awaiting a pick
    }));
    room.truckMania.lastRoll = null;
    room.truckMania.locationDeck = buildLocationDeck(settings);
    room.truckMania.abilityDeck = buildAbilityDeck();
    room.truckMania.aiGraph = null; // rebuilt lazily against the current map
    room.truckMania.time = START_TIME;
    room.truckMania.turn = 0; // player index whose turn it is; 0 is the human
    room.truckMania.turnState = freshTurnState();
    room.truckMania.aiMove = null; // transient: an AI's chosen path, for the client to animate
    room.truckMania.aiActor = null; // which of an AI's trucks is acting this turn
    room.truckMania.aiStealPlan = null; // { thiefId, victimId } when a turn is a steal
    room.truckMania.winner = null; // player index once someone reaches WINNING_POINTS
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
        winner: room.truckMania.winner ?? null,
        speed: roomSpeed(room),
        settings: S(room),
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

  // Load a package; returns the building it came from (truthy) or null.
  function tryPickup(room, truck, packageId) {
    const player = room.truckMania.players?.[truck.player];
    let building = null;
    let idx = -1;
    for (const b of usableBuildings(room.truckMania.map, truck, player)) {
      if (b.role !== "pickup") continue;
      const i = (b.packages ?? []).findIndex((p) => p.id === packageId);
      if (i !== -1) { building = b; idx = i; break; }
    }
    if (!building) return null;
    const pkg = building.packages[idx];
    if (building.protected && building.letter && !(player?.locations ?? []).includes(building.letter)) {
      return null;
    }
    if (player) {
      if ((truck.cargo?.length ?? 0) >= colValue(room, player, "capacity")) return null;
      const variety = colValue(room, player, "variety");
      const colors = new Set((truck.cargo ?? []).map((p) => p.color));
      if (!colors.has(pkg.color) && colors.size >= variety) return null;
    }
    building.packages.splice(idx, 1);
    truck.cargo.push(pkg);
    return building;
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
    if (player) {
      player.points += shapePts(room, delivered.shape);
      if (player.points >= WINNING_POINTS && room.truckMania.winner == null) {
        room.truckMania.winner = truck.player;
      }
    }
    if (player && ADVANCING.has(col)) {
      if (col === "timestones") {
        player.timeStones += colValue(room, player, "timestones");
      }
      player.columns[col] = Math.min(maxLevel(room, col), player.columns[col] + 1);
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
      const aversion = colValue(room, player, "aversion");
      const dice = Array.from({ length: n }, () => 1 + Math.floor(Math.random() * 6));
      const tickets = dice.filter((d) => d > aversion).length;
      const rush = isRushHour(room.truckMania.time);
      const loss = tickets * (rush ? S(room).points.rushTicket : S(room).points.ticket);
      player.points -= loss; // may go negative
      room.truckMania.rollSeq = (room.truckMania.rollSeq || 0) + 1;
      room.truckMania.lastRoll = { seq: room.truckMania.rollSeq, player: truck.player, dice, aversion, tickets, loss, rush };
    } else {
      room.truckMania.lastRoll = null;
    }
  }

  // ---- Turn order + AI drivers ---------------------------------------------

  // Client animation pacing, mirrored here so an AI turn's beats wait out what
  // the players are watching. Keep in sync with client.js: TRUCK_SPEED, the
  // animateDiceRoll totals (1300ms tumble + 2100/900ms settle-and-loss beat),
  // and stagedTimeChange (~3.6s). All of it scales by the room's speed dial.
  const TRUCK_SPEED = 200; // px per second
  const DICE_MS_LOSS = 3700; // roll that cost points: tumble + "−N" beat
  const DICE_MS_SAFE = 2500; // roll with no tickets
  const CLOCK_MS = 3600; // staged time change: hand sweep + two slow flips
  const AI_TURN_GAP_MS = 1000; // breather between one turn ending and an AI starting

  const diceMsFor = (roll) => (roll ? (roll.tickets > 0 ? DICE_MS_LOSS : DICE_MS_SAFE) : 0);
  const roomSpeed = (room) => Math.min(3, Math.max(1, room.truckMania.speed ?? 1));

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
    // Someone hit the target: freeze the turn order and let the client show it.
    if (room.truckMania.winner != null) {
      emitState(roomId, room);
      return;
    }
    const n = room.truckMania.players?.length ?? 1;
    room.truckMania.turn = ((room.truckMania.turn ?? 0) + 1) % n;
    room.truckMania.turnState = freshTurnState();
    room.truckMania.aiMove = null;
    room.truckMania.aiActor = null;
    room.truckMania.aiStealPlan = null;
    emitState(roomId, room);
    if (room.truckMania.players[room.truckMania.turn]?.isAI) {
      clearAiTimer(roomId);
      aiTimers.set(roomId, setTimeout(() => runAiTurn(roomId), AI_TURN_GAP_MS / roomSpeed(room)));
    }
  }

  // An AI turn plays in two beats so the human can watch: first it drives to a
  // destination (emit, animate), then a moment later it acts there and ends its
  // turn. Each beat's delay covers the animations it triggers on the clients —
  // the dice sequence (when reds were crossed) plus the drive itself, whose
  // duration is computed from the actual path length so a long drive is never
  // cut short by the next turn starting. AI don't steal from each other.
  function runAiTurn(roomId) {
    const room = rooms.get(roomId);
    if (!room || room.gameId !== "truck-mania") return;
    const idx = room.truckMania.turn;
    if (!room.truckMania.players?.[idx]?.isAI) return;
    room.truckMania.clockMs = 0;
    const moved = aiMovePhase(room, idx);
    emitState(roomId, room);
    clearAiTimer(roomId);
    const driveMs = moved ? Math.ceil(room.truckMania.driveMs ?? 1800) : 0;
    // Clients play the beats in order — clock flip, dice, drive — so the act
    // beat waits for all three, scaled by the room's speed dial.
    const actDelay = moved
      ? ((room.truckMania.clockMs ?? 0) + diceMsFor(room.truckMania.lastRoll) + driveMs + 500) / roomSpeed(room)
      : 250;
    aiTimers.set(roomId, setTimeout(() => {
      const r = rooms.get(roomId);
      if (!r || r.gameId !== "truck-mania") return;
      const rollBefore = r.truckMania.lastRoll;
      r.truckMania.clockMs = 0;
      // aiActPhase returns true when it drove again (a steal's getaway); give
      // that second drive time to animate before the turn passes.
      const relocated = aiActPhase(r, idx);
      aiResolveDrafts(r, idx);
      emitState(roomId, r);
      clearAiTimer(roomId);
      const rollAfter = r.truckMania.lastRoll;
      const rolledAgain = relocated && rollAfter && rollAfter !== rollBefore;
      const endDelay = (relocated
        ? (r.truckMania.clockMs ?? 0) + (rolledAgain ? diceMsFor(rollAfter) : 0) +
          Math.ceil(r.truckMania.driveMs ?? 1800) + 500
        : 700) / roomSpeed(r);
      aiTimers.set(roomId, setTimeout(() => advanceTurn(roomId), endDelay));
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

  function canCarryColor(room, player, truck, color) {
    const variety = colValue(room, player, "variety");
    const colors = new Set((truck.cargo ?? []).map((p) => p.color));
    return colors.has(color) || colors.size < variety;
  }

  function lastSegAngle(path) {
    for (let i = path.length - 1; i > 0; i -= 1) {
      const dx = path[i][0] - path[i - 1][0];
      const dy = path[i][1] - path[i - 1][1];
      if (Math.hypot(dx, dy) > 0.01) return (Math.atan2(dy, dx) * 180) / Math.PI;
    }
    return 0;
  }

  // Clock change that nets the AI fewer reds on its path, within its stone
  // budget. Both octagons carrying a number flip together, so a number only
  // helps when more of its reds than its greens sit on the path. Prefers the
  // biggest net gain, then the cheapest sweep.
  function maybeAiChangeTime(room, player, numbers, greens = []) {
    const budget = aiTimeBudget(player);
    if (!numbers.length || budget <= 0) return false;
    const redCount = {};
    numbers.forEach((n) => { redCount[n] = (redCount[n] || 0) + 1; });
    const greenCount = {};
    greens.forEach((n) => { greenCount[n] = (greenCount[n] || 0) + 1; });
    const t = room.truckMania.time ?? START_TIME;
    const curPos = t % 12;
    let best = null;
    for (const num of Object.keys(redCount).map(Number)) {
      const gain = redCount[num] - (greenCount[num] || 0);
      if (gain <= 0) continue; // flipping would just trade reds around
      const steps = (num % 12 - curPos + 12) % 12;
      if (steps >= 1 && steps <= budget && steps <= player.timeStones) {
        if (!best || gain > best.gain || (gain === best.gain && steps < best.steps)) {
          best = { num, steps, gain };
        }
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

  // Drive `truck` from its current spot to `destSpotIdx`, greening a red on the
  // way if affordable, then applying the move (rolling tickets) and recording
  // the path for the client. Returns whether it drove. Shared by the move beat
  // and a steal's getaway.
  function aiDriveTruckTo(room, truck, player, destSpotIdx) {
    const map = room.truckMania.map;
    const spots = map.spots ?? [];
    const here = spots[truck.spot];
    const dest = spots[destSpotIdx];
    if (!here || !dest || destSpotIdx === truck.spot) return false;
    const graph = getAiGraph(room);
    const heading = truck.facing ?? here.angle;
    const canUturn = hasAbility(player, "uturn");

    let route = findRouteDirected(graph, map.intersections, here.x, here.y, heading, dest.x, dest.y, canUturn);
    const flip = () => {
      const rd = redsOnPath(route ? route.path : [], map.intersections, [here.x, here.y], [dest.x, dest.y]);
      const did = rd.count > 0 && maybeAiChangeTime(room, player, rd.numbers, rd.greens);
      // The clients animate the flip (hand sweep + slow folds) before anything
      // else this beat; the turn pacing must wait it out.
      if (did) room.truckMania.clockMs = CLOCK_MS;
      return did;
    };
    if (route && route.reds > 0 && flip()) {
      route = findRouteDirected(graph, map.intersections, here.x, here.y, heading, dest.x, dest.y, canUturn) || route;
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
      if (rd.count > 0 && maybeAiChangeTime(room, player, rd.numbers, rd.greens)) {
        room.truckMania.clockMs = CLOCK_MS;
      }
      redCount = redsOnPath(path, map.intersections, [here.x, here.y], [dest.x, dest.y]).count;
      endAngle = lastSegAngle(path);
    }

    truck.facing = endAngle;
    applyMove(room, truck, destSpotIdx, redCount);
    room.truckMania.aiMove = { truckId: truck.id, path, endAngle };
    // How long the clients will spend animating this drive (constant speed).
    let len = 0;
    for (let i = 1; i < path.length; i += 1) {
      len += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
    }
    room.truckMania.driveMs = Math.max(450, (len / TRUCK_SPEED) * 1000) + 300;
    return true;
  }

  // ---- AI valuation ---------------------------------------------------------
  // The AI scores what a destination is worth in ~points, then subtracts the
  // expected ticket loss of actually driving there. Deliveries are worth their
  // shape points plus what the color's board column unlocks (capacity/variety
  // early, time-stone payouts, card drafts); pickups are discounted deliveries.

  // Does any dropoff still have room for this color? Picking up a color with
  // nowhere to go is dead cargo.
  function colorDeliverable(map, color) {
    return (map.blocks ?? []).some((bl) => (bl.buildings ?? []).some((b) =>
      b.role === "dropoff" && b.dropoffColor === color &&
      (b.delivered?.length ?? 0) < (b.dropoffLimit ?? Infinity)));
  }

  // Worth of eventually delivering one package: its points, plus the value of
  // the column its color advances. Engine columns matter most while low.
  function deliveryValue(room, player, color, shape) {
    let v = shapePts(room, shape);
    const col = COLOR_COLUMN[color];
    const lvl = player.columns[col] ?? 0;
    if (col === "timestones") v += 0.25 * colValue(room, player, "timestones");
    else if (col === "capacity") v += lvl < 2 ? 1.5 : lvl < 4 ? 0.8 : 0.2;
    else if (col === "variety") v += lvl < 2 ? 1.3 : lvl < 4 ? 0.7 : 0.2;
    else if (col === "aversion") v += lvl < 3 ? 0.9 : 0.3;
    else if (col === "agression") v += lvl < 3 ? 0.6 : 0.2;
    else if (col === "locations") v += 1.0; // draws a location tile
    else if (col === "abilities") v += 1.3; // draws an ability card
    return v;
  }

  // Expected points lost to tickets when crossing `reds` red lights now:
  // per-die ticket odds from aversion, doubled in rush hour, zero with Swerve.
  function ticketRisk(room, player, reds) {
    if (!reds) return 0;
    const rush = isRushHour(room.truckMania.time);
    if (rush && hasAbility(player, "swerve")) return 0;
    const aversion = colValue(room, player, "aversion");
    const perTicket = rush ? S(room).points.rushTicket : S(room).points.ticket;
    return reds * ((6 - aversion) / 6) * perTicket;
  }

  // Worth of parking at a pickup: simulate the greedy load (capacity, variety,
  // locked letters, dead colors respected), best packages first.
  function pickupValue(room, truck, player, b) {
    if (b.role !== "pickup") return 0;
    if (b.protected && b.letter && !(player.locations ?? []).includes(b.letter)) return 0;
    const map = room.truckMania.map;
    let space = colValue(room, player, "capacity") - (truck.cargo?.length ?? 0);
    if (space <= 0) return 0;
    const variety = colValue(room, player, "variety");
    const colors = new Set((truck.cargo ?? []).map((p) => p.color));
    const pkgs = (b.packages ?? [])
      .filter((p) => colorDeliverable(map, p.color))
      .sort((a, c) => deliveryValue(room, player, c.color, c.shape) - deliveryValue(room, player, a.color, a.shape));
    let v = 0;
    for (const p of pkgs) {
      if (space <= 0) break;
      if (!colors.has(p.color)) {
        if (colors.size >= variety) continue;
        colors.add(p.color);
      }
      v += 0.85 * deliveryValue(room, player, p.color, p.shape); // still needs a delivery trip
      space -= 1;
    }
    return v;
  }

  // Worth of parking at a dropoff: everything in the hold it can unload there,
  // with a big bonus when the points would win the game outright.
  function dropoffValue(room, truck, player, b) {
    if (b.role !== "dropoff") return 0;
    const space = (b.dropoffLimit ?? Infinity) - (b.delivered?.length ?? 0);
    if (space <= 0) return 0;
    const matching = (truck.cargo ?? []).filter((p) => p.color === b.dropoffColor).slice(0, space);
    if (!matching.length) return 0;
    let v = 0;
    let pts = 0;
    for (const p of matching) {
      v += deliveryValue(room, player, p.color, p.shape);
      pts += shapePts(room, p.shape);
    }
    if (player.points + pts >= WINNING_POINTS) v += 8; // clinches the win
    return v;
  }

  // Best robbable victim by haul value: night (or Day theft), higher
  // aggression, and the victim carries deliverable colors the thief can hold.
  // Simulates the take (best packages first, up to the aggression gap).
  function aiStealTarget(room, thief, player) {
    const t = room.truckMania.time ?? START_TIME;
    if (!isNight(t) && !hasAbility(player, "day-theft")) return null;
    const capacity = colValue(room, player, "capacity");
    if ((thief.cargo?.length ?? 0) >= capacity) return null;
    const myAggr = colValue(room, player, "agression");
    const map = room.truckMania.map;
    const spots = map.spots ?? [];
    const here = spots[thief.spot];
    if (!here) return null;
    let best = null;
    for (const v of room.truckMania.trucks ?? []) {
      if (v.player === thief.player) continue;
      const vp = room.truckMania.players?.[v.player];
      if (!vp) continue;
      const gap = myAggr - colValue(room, vp, "agression");
      if (gap <= 0) continue;
      const vs = spots[v.spot];
      if (!vs) continue;
      const variety = colValue(room, player, "variety");
      const colors = new Set((thief.cargo ?? []).map((p) => p.color));
      let space = capacity - (thief.cargo?.length ?? 0);
      let taken = 0;
      let value = 0;
      const opts = (v.cargo ?? [])
        .filter((p) => colorDeliverable(map, p.color))
        .sort((a, c) => deliveryValue(room, player, c.color, c.shape) - deliveryValue(room, player, a.color, a.shape));
      for (const p of opts) {
        if (taken >= gap || space <= 0) break;
        if (!colors.has(p.color)) {
          if (colors.size >= variety) continue;
          colors.add(p.color);
        }
        value += 0.9 * deliveryValue(room, player, p.color, p.shape) + 0.4; // haul + denying a rival
        taken += 1;
        space -= 1;
      }
      if (value <= 0) continue;
      const d = Math.hypot(vs.x - here.x, vs.y - here.y);
      if (!best || value - d * 0.0005 > best.value - best.d * 0.0005) {
        best = { kind: "steal", spot: v.spot, d, value, victim: v };
      }
    }
    return best;
  }

  // Every worthwhile destination for one truck: usable pickups/dropoffs on free
  // spots (its own spot included, at distance 0), plus the best steal. Each is
  // { kind, spot, d, value, victim? }.
  function aiCandidates(room, truck, player, occupied) {
    const map = room.truckMania.map;
    const spots = map.spots ?? [];
    const here = spots[truck.spot];
    if (!here) return [];
    const out = [];
    spots.forEach((s, i) => {
      if (i !== truck.spot && occupied?.has(i)) return;
      const b = buildingByBid(map, s.building);
      if (!b) return;
      const value = b.role === "pickup"
        ? pickupValue(room, truck, player, b)
        : dropoffValue(room, truck, player, b);
      if (value <= 0) return;
      out.push({ kind: "move", spot: i, d: Math.hypot(s.x - here.x, s.y - here.y), value });
    });
    const steal = aiStealTarget(room, truck, player);
    if (steal) out.push(steal);
    return out;
  }

  // Beat one of an AI turn: across all of the AI's trucks, rank every candidate
  // by value, then re-score the leaders against the real route's red lights
  // (expected ticket loss) and drive the winner there. If the best thing is the
  // spot a truck is already on, it stays and acts in place. Records which truck
  // acts and any steal plan for beat two.
  function aiMovePhase(room, idx) {
    const player = room.truckMania.players?.[idx];
    const myTrucks = (room.truckMania.trucks ?? []).filter((t) => t.player === idx);
    if (!player || !myTrucks.length) return false;
    const map = room.truckMania.map;
    const spots = map.spots ?? [];
    const graph = getAiGraph(room);
    const canUturn = hasAbility(player, "uturn");

    const cands = [];
    for (const truck of myTrucks) {
      const occupied = new Set(room.truckMania.trucks.filter((t) => t.id !== truck.id).map((t) => t.spot));
      for (const c of aiCandidates(room, truck, player, occupied)) cands.push({ ...c, truck });
    }
    if (!cands.length) return false;
    cands.sort((a, b) => (b.value - b.d * 0.0005) - (a.value - a.d * 0.0005));

    let best = null;
    for (const c of cands.slice(0, 6)) {
      let score;
      if (c.spot === c.truck.spot) {
        score = c.value; // already parked there — no drive, no tickets
      } else {
        const here = spots[c.truck.spot];
        const dest = spots[c.spot];
        const route = findRouteDirected(
          graph, map.intersections, here.x, here.y,
          c.truck.facing ?? here.angle, dest.x, dest.y, canUturn
        );
        const reds = route ? route.reds : 2; // pessimistic guess for the fallback path
        score = c.value - ticketRisk(room, player, reds) - c.d * 0.0005;
      }
      if (!best || score > best.score) best = { ...c, score };
    }
    if (!best) return false;

    room.truckMania.aiActor = best.truck.id;
    if (best.spot === best.truck.spot) {
      room.truckMania.aiStealPlan = null;
      return false; // act in place
    }
    if (!aiDriveTruckTo(room, best.truck, player, best.spot)) return false;
    room.truckMania.aiStealPlan =
      best.kind === "steal" ? { thiefId: best.truck.id, victimId: best.victim.id } : null;
    return true;
  }

  // Take up to the aggression gap in packages from a victim sharing the
  // thief's spot — most valuable, still-deliverable colors first.
  function aiStealFrom(room, thief, player, victimId) {
    const victim = (room.truckMania.trucks ?? []).find((t) => t.id === victimId);
    if (!victim || thief.spot !== victim.spot) return;
    const vp = room.truckMania.players?.[victim.player];
    if (!vp) return;
    const gap = colValue(room, player, "agression") - colValue(room, vp, "agression");
    if (gap <= 0) return;
    const map = room.truckMania.map;
    const capacity = colValue(room, player, "capacity");
    let taken = 0;
    for (let guard = 0; guard < 12 && taken < gap; guard += 1) {
      if ((thief.cargo?.length ?? 0) >= capacity) break;
      const opts = (victim.cargo ?? [])
        .filter((p) => canCarryColor(room, player, thief, p.color))
        .sort((a, c) =>
          (colorDeliverable(map, c.color) ? deliveryValue(room, player, c.color, c.shape) : 0) -
          (colorDeliverable(map, a.color) ? deliveryValue(room, player, a.color, a.shape) : 0));
      if (!opts.length) break;
      const i = victim.cargo.indexOf(opts[0]);
      thief.cargo.push(victim.cargo.splice(i, 1)[0]);
      taken += 1;
    }
  }

  // Drive a thief off a shared spot after robbing: to its most valuable next
  // destination if one is free, else the nearest free spot. Returns whether it
  // drove.
  function aiRelocate(room, truck, player) {
    const map = room.truckMania.map;
    const spots = map.spots ?? [];
    const here = spots[truck.spot];
    if (!here) return false;
    const occupied = new Set(room.truckMania.trucks.filter((t) => t.id !== truck.id).map((t) => t.spot));
    const cands = aiCandidates(room, truck, player, occupied)
      .filter((c) => c.kind === "move" && c.spot !== truck.spot)
      .sort((a, b) => (b.value - b.d * 0.0005) - (a.value - a.d * 0.0005));
    let destSpot = cands[0]?.spot ?? null;
    if (destSpot == null) {
      let bestFree = null;
      spots.forEach((s, i) => {
        if (occupied.has(i) || i === truck.spot) return;
        const d = (s.x - here.x) ** 2 + (s.y - here.y) ** 2;
        if (!bestFree || d < bestFree.d) bestFree = { d, spot: i };
      });
      destSpot = bestFree?.spot ?? null;
    }
    if (destSpot == null) return false;
    return aiDriveTruckTo(room, truck, player, destSpot);
  }

  // Beat two of an AI turn: for a steal turn, rob the victim then drive off the
  // shared spot (returns true — the getaway needs to animate). Otherwise work
  // every usable building (the whole block with Free parking): unload first to
  // free capacity, then load the best packages available.
  function aiActPhase(room, idx) {
    const actorId = room.truckMania.aiActor;
    const trucks = room.truckMania.trucks ?? [];
    const truck = trucks.find((t) => t.id === actorId && t.player === idx) ??
      trucks.find((t) => t.player === idx);
    const player = room.truckMania.players?.[idx];
    if (!truck || !player) return false;

    const plan = room.truckMania.aiStealPlan;
    if (plan && plan.thiefId === truck.id) {
      room.truckMania.aiStealPlan = null;
      aiStealFrom(room, truck, player, plan.victimId);
      return aiRelocate(room, truck, player);
    }

    const map = room.truckMania.map;
    const buildings = usableBuildings(map, truck, player);
    for (const b of buildings) {
      if (b.role !== "dropoff") continue;
      for (let guard = 0; guard < 12; guard += 1) {
        const pkg = (truck.cargo ?? []).find((p) => p.color === b.dropoffColor);
        if (!pkg || !tryDropoff(room, truck, pkg.id)) break;
      }
    }
    for (const b of buildings) {
      if (b.role !== "pickup") continue;
      for (let guard = 0; guard < 12; guard += 1) {
        if (truck.cargo.length >= colValue(room, player, "capacity")) break;
        const pkgs = (b.packages ?? [])
          .filter((p) => canCarryColor(room, player, truck, p.color) && colorDeliverable(map, p.color))
          .sort((a, c) => deliveryValue(room, player, c.color, c.shape) - deliveryValue(room, player, a.color, a.shape));
        if (!pkgs.length || !tryPickup(room, truck, pkgs[0].id)) break;
      }
    }
    return false;
  }

  // Resolve any card drafts the AI has queued from deliveries: unlock a useful
  // location letter, or take the higher-ranked of the two shown abilities. Keeps
  // the decks in sync the same way a human draft does.
  function aiResolveDrafts(room, idx) {
    const player = room.truckMania.players?.[idx];
    if (!player?.pendingDrafts?.length) return;
    const map = room.truckMania.map;
    const buildings = (map.blocks ?? []).flatMap((bl) => bl.buildings ?? []);
    const usefulLetter = (letter) => buildings.some((b) =>
      b.role === "pickup" && b.protected && b.letter === letter && (b.packages?.length ?? 0) > 0);

    let guard = 0;
    while (player.pendingDrafts.length && guard++ < 20) {
      const deck = player.pendingDrafts.shift();
      if (deck === "locations") {
        const d = room.truckMania.locationDeck ?? [];
        // Prefer a shown letter that unlocks a stocked location the AI doesn't
        // already hold; if neither shown helps, gamble on a hidden card.
        const fresh = (l) => l != null && usefulLetter(l) && !player.locations.includes(l);
        let choice = "random";
        if (fresh(d[0])) choice = "shown0";
        else if (fresh(d[1])) choice = "shown1";
        else if (d.length <= 2) choice = "shown0"; // nothing hidden left
        const card = drawFromDeck(d, choice);
        if (card) player.locations.push(card); // duplicate letters are harmless
      } else if (deck === "abilities") {
        const d = room.truckMania.abilityDeck ?? [];
        const rank = (c) => {
          const i = AI_ABILITY_PREF.indexOf(c);
          return i === -1 ? 99 : i;
        };
        const choice = d[1] != null && rank(d[1]) < rank(d[0]) ? "shown1" : "shown0";
        const card = drawFromDeck(d, choice);
        if (card === "extra-truck") {
          spawnExtraTruck(room, idx);
          if (!player.abilities.includes(card)) player.abilities.push(card);
        } else if (card && !player.abilities.includes(card)) {
          player.abilities.push(card);
        }
      }
    }
  }

  return {
    id: "truck-mania",

    createRoomState() {
      const map = generateCityMap();
      const state = {
        truckMania: { map, time: START_TIME, trucks: [], settings: cloneSettings(DEFAULT_SETTINGS) }
      };
      setupBoard(state);
      return state;
    },

    emitState,

    registerHandlers(socket) {
      socket.on("truck_mania_list_maps", () => {
        socket.emit("truck_mania_maps", mapsPayload());
      });

      socket.on("truck_mania_list_settings", () => {
        socket.emit("truck_mania_settings", settingsPayload());
      });

      // Save a named settings version (local runs only), then apply it to this
      // room — the board re-deals under the new numbers.
      socket.on("truck_mania_save_settings", ({ roomId, name, settings } = {}) => {
        if (!savingEnabled) return;
        const room = playerRoom(socket, roomId);
        if (!room) return;
        const clean = sanitizeSettings(settings);
        if (!clean) return;
        const entry = {
          id: `s${Date.now()}${Math.floor(Math.random() * 1000)}`,
          name: String(name || "Untitled").slice(0, 40),
          settings: clean
        };
        savedSettings.push(entry);
        persistSavedSettings(savedSettings);
        clearAiTimer(roomId);
        room.truckMania.settings = cloneSettings(clean);
        setupBoard(room);
        room.truckMania.map.seed = `${room.truckMania.map.seed}-t${Date.now()}`;
        emitState(roomId, room);
        io.to(roomId).emit("truck_mania_settings", settingsPayload());
      });

      // Apply a preset or saved settings version to this room (re-deals).
      socket.on("truck_mania_load_settings", ({ roomId, settingsId } = {}) => {
        const room = playerRoom(socket, roomId);
        if (!room) return;
        const entry = SETTING_PRESETS.find((p) => p.id === settingsId) ??
          savedSettings.find((s) => s.id === settingsId);
        if (!entry) return;
        clearAiTimer(roomId);
        room.truckMania.settings = cloneSettings(entry.settings);
        setupBoard(room);
        room.truckMania.map.seed = `${room.truckMania.map.seed}-t${Date.now()}`;
        emitState(roomId, room);
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
            colValue(room, meP, "agression") > colValue(room, occP, "agression");
          if (!canRob) return;
        }

        room.truckMania.turnState.truck = truck.id;
        room.truckMania.turnState.pickups = []; // driving away forfeits put-backs
        applyMove(room, truck, spot, reds);
        emitState(roomId, room);
      });

      // Load a package onto the human's truck. Normally ends the turn's
      // movement; Drive-by pickup exempts the first pickup of the turn (one
      // drive-by per turn at most). Blocked while sharing a spot.
      socket.on("truck_mania_pickup", ({ roomId, truckId = 0, packageId } = {}) => {
        const room = playerRoom(socket, roomId);
        if (!room || room.truckMania.turn !== 0 || room.truckMania.winner != null) return;
        const truck = humanTruck(room, truckId);
        if (!truck || sharesSpot(room, truck)) return;
        const building = tryPickup(room, truck, packageId);
        if (building) {
          const ts = room.truckMania.turnState;
          ts.truck = truck.id;
          const driveBy = hasAbility(room.truckMania.players?.[0], "drive-by-pickup") && !ts.driveByPickup;
          if (driveBy) ts.driveByPickup = true;
          else ts.acted = true;
          ts.pickups.push({ pkg: packageId, bid: building.bid, drive: driveBy });
          emitState(roomId, room);
        }
      });

      // Put a package picked up this turn back onto the building it came from.
      // Only while still parked there — regret, not remote returns. Restores
      // whatever the pickup consumed (the drive-by, or the movement lock).
      socket.on("truck_mania_putback", ({ roomId, truckId = 0, packageId } = {}) => {
        const room = playerRoom(socket, roomId);
        if (!room || room.truckMania.turn !== 0 || room.truckMania.winner != null) return;
        const truck = humanTruck(room, truckId);
        if (!truck || sharesSpot(room, truck)) return;
        const ts = room.truckMania.turnState;
        const li = ts.pickups.findIndex((e) => e.pkg === packageId);
        if (li === -1) return;
        const entry = ts.pickups[li];
        const ci = (truck.cargo ?? []).findIndex((p) => p.id === packageId);
        if (ci === -1) return;
        const player = room.truckMania.players?.[truck.player];
        const building = usableBuildings(room.truckMania.map, truck, player)
          .find((b) => b.bid === entry.bid && b.role === "pickup");
        if (!building) return;
        (building.packages ??= []).push(truck.cargo.splice(ci, 1)[0]);
        ts.pickups.splice(li, 1);
        if (entry.drive) ts.driveByPickup = false;
        else ts.acted = ts.pickups.some((e) => !e.drive) || ts.actedByDrop;
        emitState(roomId, room);
      });

      // Drop off a package from the human's truck at a matching dropoff.
      // Drive-by dropoff exempts the first dropoff of the turn, same rule.
      socket.on("truck_mania_dropoff", ({ roomId, truckId = 0, packageId } = {}) => {
        const room = playerRoom(socket, roomId);
        if (!room || room.truckMania.turn !== 0 || room.truckMania.winner != null) return;
        const truck = humanTruck(room, truckId);
        if (!truck || sharesSpot(room, truck)) return;
        if (tryDropoff(room, truck, packageId)) {
          const ts = room.truckMania.turnState;
          ts.truck = truck.id;
          const driveBy = hasAbility(room.truckMania.players?.[0], "drive-by-dropoff") && !ts.driveByDropoff;
          if (driveBy) ts.driveByDropoff = true;
          else {
            ts.acted = true;
            ts.actedByDrop = true;
          }
          // A delivered package can't come back.
          const li = ts.pickups.findIndex((e) => e.pkg === packageId);
          if (li !== -1) ts.pickups.splice(li, 1);
          emitState(roomId, room);
        }
      });

      // End the human's turn. Blocked while any of the player's trucks shares a
      // spot with another truck — you can't end on the same space as another.
      socket.on("truck_mania_end_turn", ({ roomId } = {}) => {
        const room = playerRoom(socket, roomId);
        if (!room || room.truckMania.turn !== 0 || room.truckMania.winner != null) return;
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
        if (!room || room.truckMania.turn !== 0 || room.truckMania.winner != null) return;
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
        if (!room || room.truckMania.turn !== 0 || room.truckMania.winner != null) return;
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
        if (!(colValue(room, thiefP, "agression") > colValue(room, victimP, "agression"))) {
          return;
        }
        const idx = (victim.cargo ?? []).findIndex((p) => p.id === packageId);
        if (idx === -1) return;
        const pkg = victim.cargo[idx];
        if ((thief.cargo?.length ?? 0) >= colValue(room, thiefP, "capacity")) return;
        const variety = colValue(room, thiefP, "variety");
        const colors = new Set((thief.cargo ?? []).map((p) => p.color));
        if (!colors.has(pkg.color) && colors.size >= variety) return;
        victim.cargo.splice(idx, 1);
        thief.cargo.push(pkg);
        ts.stolen = true;
        ts.stealVictim = victimTruckId;
        ts.truck = thief.id;
        emitState(roomId, room);
      });

      // The animation speed dial: ×1 to ×3 in half steps, shared by the room
      // and changeable at any time. Scales client animations and the AI's
      // turn pacing alike.
      socket.on("truck_mania_set_speed", ({ roomId, speed } = {}) => {
        const room = playerRoom(socket, roomId);
        if (!room) return;
        const s = Number(speed);
        if (!Number.isFinite(s)) return;
        room.truckMania.speed = Math.min(3, Math.max(1, Math.round(s * 2) / 2));
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
