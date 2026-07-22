// Truck Mania — city map, the clock, octagon signals, and saved custom maps.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
// The map generator + routing live in ../traffic-time — the shared core of the
// "Traffic Time" games (Truck Mania, Uber Mania).
import { generateCityMap, randomizeOctagons, deriveSpots, setBlankLights } from "../traffic-time/map.js";
import { buildStreetGraph, findPath, redsOnPath, findRouteDirected } from "../traffic-time/routing.js";

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
const GREY = "#c2c7cd"; // pickup buildings (kept light so locked ones contrast)
const WHITE = "#f4f1ea"; // empty buildings

// Each dropoff color advances one column on the player board. In point mode
// orange/brown queue card drafts; in ticket mode blue grants the letter
// printed on the package, orange feeds the money column and brown the
// variety/fragile column (see columnForColor).
const COLOR_COLUMN = {
  "#e8c33c": "capacity",   // yellow
  "#4a72b0": "variety",    // blue
  "#4f9d57": "aversion",   // green
  "#cf4a3c": "agression",  // red
  "#8a5bb0": "timestones", // purple
  "#e08a3c": "locations",  // orange — points: draft a location tile
  "#8f6b52": "abilities"   // brown  — points: draft an ability card
};
const ADVANCING = new Set(["capacity", "variety", "aversion", "agression", "timestones"]);
// The numeric tracks per mode; completing `columnsToWin` of them wins ticket mode.
const POINT_TRACKS = ["capacity", "variety", "aversion", "agression", "timestones"];
const TICKET_TRACKS = [...POINT_TRACKS, "money"];
// Fragility (a ticket-mode rule set): the variety rule is gone — any cargo
// combo goes — and circles are fragile packages limited by the fragile-
// capacity column instead.
const FRAGILITY_TRACKS = ["capacity", "fragile", "aversion", "agression", "timestones", "money"];
// Every column a ticket settings object carries (both rule sets' tracks), so
// flipping Variety ⇄ Fragility mid-match never lacks numbers. `letters` is the
// blue column under the Choosing rule: each value is 0 or 1 — 1 means that
// upgrade step grants a pick of any still-locked protected location.
const TICKET_COLUMNS = ["capacity", "variety", "fragile", "aversion", "agression", "timestones", "money", "letters"];

// Chore locations tickets send players to (ticket mode). Purely thematic —
// each is just a place on the board with no packages.
const TICKET_THEMES = [
  { name: "Elders Home", icon: "👵" },
  { name: "City Park", icon: "🌳" },
  { name: "Food Bank", icon: "🥫" },
  { name: "Animal Shelter", icon: "🐕" },
  { name: "Library", icon: "📚" },
  { name: "School", icon: "🏫" },
  { name: "Soup Kitchen", icon: "🍲" },
  { name: "Recycling", icon: "♻️" },
  { name: "Garden", icon: "🌱" },
  { name: "Car Wash", icon: "🧽" },
  { name: "Youth Center", icon: "🏀" },
  { name: "Beach Cleanup", icon: "🐚" }
];
const TICKET_LOC_COLOR = "#cfdde8";

// The three money sinks (ticket mode). Parking at one opens its panel; using
// it ends the turn's movement like a pickup/dropoff would.
const SPECIAL_BUILDINGS = [
  { kind: "mechanic", name: "Mechanic", icon: "🔧", color: "#5f7d95" },
  { kind: "pawnshop", name: "Pawn Shop", icon: "🪙", color: "#c9a24b" },
  { kind: "courthouse", name: "Courthouse", icon: "⚖️", color: "#8d93a6" }
];

// ---------------------------------------------------------------------------
// Tunable game settings. Everything numeric a table-tinkerer would want lives
// in one settings object per room: the player-board columns (each a list of
// values — first is the starting value, the list's length is the column's
// length), package counts per color split square/circle, how many protected
// locations there are, starting time stones, and the point values. Presets and
// locally-saved versions can be applied mid-match (the board re-deals).
// ---------------------------------------------------------------------------

const BASE_SETTINGS = {
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
  // Points for delivering each shape, and lost per ticket.
  points: { square: 1, circle: 2, ticket: 1 }
};

// Ticket mode: no points. First to fully upgrade `columnsToWin` columns —
// while holding zero tickets (visible or face-down) — wins.
// Reds crossed pile dice into a pool rolled at turn end; each failed die
// issues literal tickets (chores at one of the 12 themed locations). Orange
// feeds the money column — the currency spent at the mechanic / pawn shop /
// courthouse. Blue packages carry a letter and unlock it on delivery. Brown
// feeds variety (or fragile capacity under Fragility).
const BASE_TICKET_SETTINGS = {
  mode: "tickets",
  // Suspension rule: a player holding any face-down tickets may not pick up
  // or drop off packages. The pile only flips up at turn end, so a backlog
  // blocks package progress all turn. Lives in the tuning/saved settings.
  suspension: false,
  // Fragility rule set: circles are fragile packages any location can hold —
  // no variety rule; the fragile column caps how many circles fit the truck,
  // and delivering one pays the player's choice of time stones or money.
  fragility: false,
  // Free rule set: no cargo-mix rule at all — brown is out of the game
  // entirely (no column, no packages, no dropoffs; its tuning numbers are
  // kept but ignored), circles are plain packages, purple/orange deliveries
  // pay nothing, and instead each turn opens with the player's choice of time
  // stones or money at their current column values.
  free: false,
  // Choosing rule: blue packages carry no letters — letters is a real board
  // column instead (pawn-shop swappable, completes like any other). Its values
  // are 0/1 flags: a 1 step lets the player unlock any locked location.
  choosing: false,
  // Keep going: after ending movement at a terminal stop, a player may pay
  // `keepGoingCost` time stones to reopen movement (and another time change)
  // this turn. While on, the two drive-by abilities are out of the game.
  keepGoing: false,
  keepGoingCost: 3,
  // Timed packages: every circle package is stamped with a random clock-face
  // number (1–12) and can only be delivered when the clock reads that number
  // ±1 (AM/PM agnostic — only the face number matters; 12 wraps to 1).
  // Delivering one also pays `timedReward` money on top of its usual payout.
  timedPackages: false,
  timedReward: 2,
  // Day only activities: the three special buildings (mechanic / pawn shop /
  // courthouse) can only be used during the day — closed at night.
  dayOnlyActivities: false,
  columns: {
    capacity: [2, 3, 4, 5, 6, 7],
    variety: [1, 2, 3, 4, 5, 6],
    fragile: [1, 2, 3, 4, 5, 6],
    aversion: [1, 2, 3, 4, 5, 6],
    agression: [0, 1, 2, 3, 4, 5],
    timestones: [2, 4, 6, 8, 10, 12],
    money: [2, 4, 6, 8, 10, 12],
    letters: [0, 1, 1, 1, 1, 1, 1]
  },
  // Circles fill the protected locations (8 each in this mode); squares the
  // normal pickups (6 each); blue (the letters color) divides evenly by the
  // protected-location count.
  packages: {
    "#8f6b52": { square: 8, circle: 8 },   // brown  — variety (16)
    "#4a72b0": { square: 12, circle: 0 },  // blue   — letters (12)
    "#cf4a3c": { square: 8, circle: 6 },   // red    — agression (14)
    "#e08a3c": { square: 8, circle: 8 },   // orange — money (16)
    "#e8c33c": { square: 10, circle: 8 },  // yellow — capacity (18)
    "#4f9d57": { square: 10, circle: 8 },  // green  — aversion (18)
    "#8a5bb0": { square: 10, circle: 10 }  // purple — timestones (20)
  },
  protectedCount: 6,
  startingTimeStones: 3,
  startingMoney: 2,
  columnsToWin: 3,
  // Tickets issued per failed die.
  tickets: { perFail: 1 },
  ticketLocations: 12,
  abilityCosts: {
    uturn: 3, "drive-by-pickup": 4, "drive-by-dropoff": 4, "cheap-time": 4,
    "day-theft": 5, "time-lord": 5, "free-parking": 6,
    "reverse-time": 3, "extra-truck": 8
  },
  // Price of the 1st / 2nd / 3rd use in a single turn.
  pawnCosts: [2, 3, 4],
  courtCosts: [2, 3, 4],
  // Of the unnumbered stoplights, how many start green and how many red
  // (leftovers beyond green+red stay a coin flip).
  blankLights: { green: 5, red: 5 }
};

const modeOf = (s) => (s?.mode === "tickets" ? "tickets" : "points");

const cloneSettings = (s) => JSON.parse(JSON.stringify(s));

// Fill in fields added after a settings object was saved, deriving fitting
// values from the numbers it already carries — old saved versions keep
// working without edits. Returns a completed copy.
function migrateSettings(s) {
  const out = cloneSettings(s);
  const ticket = modeOf(out) === "tickets";
  let squares = 0;
  let circles = 0;
  for (const color of LOC_COLORS) {
    const p = out.packages?.[color] ?? {};
    squares += p.square ?? 0;
    circles += p.circle ?? 0;
  }
  // Pickup shape: how many normal pickups there are and how many packages
  // each normal/protected location holds (the old rules hardcoded 6 and 8).
  out.perProtected ??= ticket ? 8 : 6;
  out.perPickup ??= 6;
  out.pickupCount ??= Math.max(0, Math.round(squares / (out.perPickup || 6)));
  // Dropoffs: per color, a list of capacities (one dropoff building each).
  // Old versions derived them from the package counts — bake that in. The
  // spec must be computed before `out.dropoffs` exists, or dropoffSpecFrom
  // would read the still-empty lists instead of deriving.
  if (!out.dropoffs) {
    const spec = dropoffSpecFrom(out);
    out.dropoffs = Object.fromEntries(LOC_COLORS.map((c) => [c, []]));
    for (const [color, cap] of spec) out.dropoffs[color].push(cap);
  }
  if (ticket) {
    out.suspension ??= false;
    out.fragility ??= false;
    out.free ??= false;
    out.choosing ??= false;
    out.keepGoing ??= false;
    out.keepGoingCost ??= 3;
    out.timedPackages ??= false;
    out.timedReward ??= 2;
    out.dayOnlyActivities ??= false;
    (out.columns ??= {}).fragile ??= [1, 2, 3, 4, 5, 6];
    out.columns.letters ??= [0, 1, 1, 1, 1, 1, 1];
    out.blankLights ??= { green: 5, red: 5 };
    // Total stoplights the map should carry (24 numbered + the blanks) — the
    // four light-free corners sit on top of this count.
    out.intersections ??= 24 + (out.blankLights.green ?? 5) + (out.blankLights.red ?? 5);
    out.visibleTickets ??= 3;
    // Letters (orange deliveries) count as one more completable column.
    out.lettersToWin ??= Math.max(1, out.protectedCount ?? 6);
  }
  return out;
}

const DEFAULT_SETTINGS = migrateSettings(BASE_SETTINGS);
const DEFAULT_TICKET_SETTINGS = migrateSettings(BASE_TICKET_SETTINGS);

// Letters available to protected locations, in unlock-tile order.
const LETTER_POOL = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"];
const settingsLetters = (settings) =>
  LETTER_POOL.slice(0, Math.min(LETTER_POOL.length, settings.protectedCount));

function intIn(v, min, max) {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

// Shared sanitizing for the parts both modes have: the numeric columns, the
// per-color package counts, the pickup shape (how many normal/protected
// locations and how many packages each holds) and the per-color dropoff
// capacity lists. Returns null when malformed or when the counts don't line
// up: squares must exactly fill the normal pickups, circles the protected
// ones (under fragility/free the shapes mix freely, so only the combined
// total must fill every slot), and each color's dropoff capacities must sum
// to its package total. `skipBrown` (the Free rule set) keeps brown's numbers
// but leaves them out of every line-up check — brown isn't in that game.
function sanitizeCore(raw, trackCols, fragility = false, skipBrown = false) {
  const columns = {};
  for (const col of trackCols) {
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
    if (skipBrown && color === "#8f6b52") continue; // stored, but not in play
    circles += ci;
    squares += sq;
  }
  const protectedCount = intIn(raw.protectedCount, 0, LETTER_POOL.length);
  const startingTimeStones = intIn(raw.startingTimeStones, 0, 40);
  const pickupCount = intIn(raw.pickupCount, 0, 60);
  const perPickup = intIn(raw.perPickup, 1, 12);
  const perProtected = intIn(raw.perProtected, 1, 12);
  if ([protectedCount, startingTimeStones, pickupCount, perPickup, perProtected].some((v) => v === null)) {
    return null;
  }
  if (fragility) {
    if (squares + circles !== pickupCount * perPickup + protectedCount * perProtected) return null;
  } else {
    if (squares !== pickupCount * perPickup) return null;
    if (circles !== protectedCount * perProtected) return null;
  }
  const dropoffs = {};
  for (const color of LOC_COLORS) {
    const arr = raw.dropoffs?.[color];
    if (!Array.isArray(arr) || arr.length > 8) return null;
    const clean = arr.map((v) => intIn(v, 1, 90));
    if (clean.some((v) => v === null)) return null;
    const total = packages[color].square + packages[color].circle;
    if (!(skipBrown && color === "#8f6b52") &&
      clean.reduce((a, b) => a + b, 0) !== total) return null;
    dropoffs[color] = clean;
  }
  return {
    columns, packages, circles, squares, protectedCount, startingTimeStones,
    pickupCount, perPickup, perProtected, dropoffs
  };
}

// Validate + normalize a client-submitted settings object. Returns null when
// anything is malformed or the counts don't line up (the same rules the
// client's editor shows before enabling Save). Submissions from clients
// predating newer fields get them derived first (same as saved-version
// migration), so a stale tab can still save.
function sanitizeSettings(raw) {
  if (!raw || typeof raw !== "object") return null;
  const filled = migrateSettings(raw);
  return filled.mode === "tickets" ? sanitizeTicketSettings(filled) : sanitizePointSettings(filled);
}

function sanitizePointSettings(raw) {
  const core = sanitizeCore(raw, POINT_TRACKS);
  if (!core) return null;
  const {
    columns, packages, circles, squares, protectedCount, startingTimeStones,
    pickupCount, perPickup, perProtected, dropoffs
  } = core;
  const points = {};
  for (const k of ["square", "circle", "ticket"]) {
    const v = intIn(raw.points?.[k], 0, 20);
    if (v === null) return null;
    points[k] = v;
  }
  // Orange feeds the location deck (2 tiles per protected letter).
  const orange = packages["#e08a3c"].square + packages["#e08a3c"].circle;
  if (orange !== protectedCount * 2) return null;
  if (squares + circles < 6) return null;
  return {
    columns, packages, protectedCount, startingTimeStones, points,
    pickupCount, perPickup, perProtected, dropoffs
  };
}

function sanitizeTicketSettings(raw) {
  // Free wins if a malformed submission claims both rule sets.
  const free = raw.free === true;
  const fragility = !free && raw.fragility === true;
  const choosing = raw.choosing === true;
  // Under Fragility AND Free the shapes mix freely, so the package dealing
  // (and its line-up check) works from one combined total. Free also drops
  // brown from the math entirely — it isn't in that game.
  const core = sanitizeCore(raw, TICKET_COLUMNS, fragility || free, free);
  if (!core) return null;
  // The letters column is 0/1 flags (1 = that upgrade grants a location pick).
  if (core.columns.letters.some((v) => v !== 0 && v !== 1)) return null;
  const {
    columns, packages, circles, squares, protectedCount, startingTimeStones,
    pickupCount, perPickup, perProtected, dropoffs
  } = core;
  const startingMoney = intIn(raw.startingMoney, 0, 40);
  // Letters are one more completable column beside the numeric tracks.
  const columnsToWin = intIn(raw.columnsToWin, 1, TICKET_TRACKS.length + 1);
  const ticketLocations = intIn(raw.ticketLocations, 1, TICKET_THEMES.length);
  const perFail = intIn(raw.tickets?.perFail, 0, 6);
  const visibleTickets = intIn(raw.visibleTickets, 1, 8);
  const lettersToWin = intIn(raw.lettersToWin, 1, LETTER_POOL.length);
  const intersections = intIn(raw.intersections, 24, 44);
  if ([startingMoney, columnsToWin, ticketLocations, perFail,
       visibleTickets, lettersToWin, intersections].some((v) => v === null)) {
    return null;
  }
  const abilityCosts = {};
  for (const id of ABILITY_CARDS) {
    const v = intIn(raw.abilityCosts?.[id], 0, 99);
    if (v === null) return null;
    abilityCosts[id] = v;
  }
  const stepCosts = (arr) => {
    if (!Array.isArray(arr) || arr.length !== 3) return null;
    const clean = arr.map((v) => intIn(v, 0, 99));
    return clean.some((v) => v === null) ? null : clean;
  };
  const pawnCosts = stepCosts(raw.pawnCosts);
  const courtCosts = stepCosts(raw.courtCosts);
  if (!pawnCosts || !courtCosts) return null;
  const keepGoingCost = intIn(raw.keepGoingCost, 0, 40);
  if (keepGoingCost === null) return null;
  const timedReward = intIn(raw.timedReward, 0, 40);
  if (timedReward === null) return null;
  const green = intIn(raw.blankLights?.green, 0, 40);
  const red = intIn(raw.blankLights?.red, 0, 40);
  if (green === null || red === null) return null;
  // The stoplight math: the 24 numbered plus the blanks make up the total (the
  // four light-free corners come on top and count toward neither).
  if (intersections !== 24 + green + red) return null;
  // Blue packages carry the letters, dealt evenly — so their total must
  // divide by the protected-location count. Under Choosing nothing is printed
  // on them, so any blue count goes.
  const letterPkgs = packages["#4a72b0"].square + packages["#4a72b0"].circle;
  if (!choosing && (protectedCount > 0 ? letterPkgs % protectedCount !== 0 : letterPkgs !== 0)) return null;
  if (lettersToWin > Math.max(1, protectedCount)) return null;
  if (squares + circles < 6) return null;
  return {
    mode: "tickets",
    suspension: raw.suspension === true,
    fragility,
    free,
    choosing,
    keepGoing: raw.keepGoing === true,
    keepGoingCost,
    timedPackages: raw.timedPackages === true,
    timedReward,
    dayOnlyActivities: raw.dayOnlyActivities === true,
    columns, packages, protectedCount, startingTimeStones,
    pickupCount, perPickup, perProtected, dropoffs,
    startingMoney, columnsToWin, ticketLocations,
    visibleTickets, lettersToWin, intersections,
    tickets: { perFail },
    abilityCosts, pawnCosts, courtCosts,
    blankLights: { green, red }
  };
}

// Dropoff locations: one [color, capacity] per entry in the settings'
// per-color capacity lists. Settings saved before the lists existed fall back
// to the classic derivation — brown and red get one dropoff holding
// everything; every other color two, split ⌊⅔⌋ / rest.
function dropoffSpecFrom(settings) {
  // Free rules: brown is out of the game — no brown dropoffs get seated.
  const skipBrown = settings.free === true;
  if (settings.dropoffs) {
    const spec = [];
    for (const color of LOC_COLORS) {
      if (skipBrown && color === "#8f6b52") continue;
      for (const cap of settings.dropoffs[color] ?? []) {
        if (cap > 0) spec.push([color, cap]);
      }
    }
    return spec;
  }
  const spec = [];
  for (const [color, counts] of Object.entries(settings.packages)) {
    if (skipBrown && color === "#8f6b52") continue;
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
// Per-turn flags. `pickups` logs this stop's pickups ({pkg, bid, drive, acted})
// so a regretted one can be put back; `driveByPickupBid`/`driveByDropoffBid`
// lock each drive-by ability to ONE building per turn — any number of
// pickups/dropoffs there stay free, acting anywhere else ends movement.
// `actedByDrop` records that a dropoff (not a pickup) ended movement, so
// put-backs can't reopen it. Ticket mode adds: `dicePool` (a die per red
// crossed, rolled at turn end) and `pawnUses`/`courtUses` (each use in a turn
// has its own price).
const freshTurnState = () => ({
  acted: false, stolen: false, stealVictim: null, changedTime: false, truck: null,
  pickups: [], driveByPickupBid: null, driveByDropoffBid: null, actedByDrop: false,
  dicePool: 0, pawnUses: 0, courtUses: 0,
  startChoice: null, // Free rules: the turn-opening stones/money pick, once made
  keptGoing: false, // Keep going: movement was reopened at least once this turn
  aiLegs: 0, // AI only: keep-going continuations taken this turn (loop guard)
  aiLockTruck: null, // AI only: once it acts, keep going continues THIS truck
  // One-step undo (ticket mode): the turn's latest still-revocable action —
  // { kind: "move", ... } or { kind: "time", ... } — cleared the moment the
  // location is used or anything else happens.
  undo: null,
  skipped: false // the turn was sat out for the skip payout
});

// Locations deck: two of each protected letter. Each letter unlocks its
// matching protected location.
// The ability deck (one of each, shuffled, top two on offer). Reverse-time is
// kept working in the clock code but is intentionally left out of the deck.
const ABILITY_CARDS = [
  "uturn", "drive-by-pickup", "drive-by-dropoff", "cheap-time",
  "day-theft", "time-lord", "free-parking", "reverse-time", "extra-truck"
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
// One seat per color: the room's humans hold the first seats, AI fill in
// behind — a solo room can face up to 3 AI, a two-human room up to 2. Solo
// rooms list the same socket twice, hence the Set (and the floor of 1 covers
// a board dealt before the lobby has filled the seats).
const humanCount = (room) => Math.max(1, new Set(room.players ?? []).size);
const maxAiFor = (room) => PLAYER_COLORS.length - humanCount(room);
// When drafting an ability, the AI takes whichever of the two shown ranks first.
const AI_ABILITY_PREF = [
  "extra-truck", "free-parking", "drive-by-dropoff", "drive-by-pickup",
  "day-theft", "cheap-time", "time-lord", "uturn", "reverse-time"
];

// How many stones an AI will spend on one clock flip. Stones exist to be
// spent dodging reds (and the ticket roll behind them), so the budget scales
// with the pile: a small stash still empties to duck a red, a big stash funds
// long sweeps rather than sitting idle. Capped at 11 (half the clock).
function aiTimeBudget(player) {
  const s = player.timeStones ?? 0;
  if (s <= 0) return 0;
  return Math.min(11, Math.max(4, Math.floor(s * 0.6)));
}

const emptyColumns = () => ({
  capacity: 0, variety: 0, fragile: 0, aversion: 0, agression: 0, timestones: 0,
  money: 0, letters: 0, locations: 0, abilities: 0
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

// Assign every building a role and recolor it per the settings: dropoffs (a
// color + capacity per entry in the settings' dropoff lists), pickups (grey;
// the protected ones hold `perProtected` circles, the `pickupCount` normal
// ones `perPickup` squares, colored from the bags), rest empty white. Ticket
// mode also seats the three special buildings (mechanic / pawn shop /
// courthouse), the themed chore locations, and prints letters on the orange
// packages. Mutates in place.
let pkgSeq = 0;
function assignLocations(map, settings) {
  const ticketMode = modeOf(settings) === "tickets";
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
    delete b.special;
    delete b.name;
    delete b.icon;
  });

  // Buildings without a driveway have no parking spot, so nothing playable
  // may land on one — shuffle the reachable ones to the front.
  const reachable = shuffle(buildings.filter((b) => (b.connectors ?? []).length > 0));
  const order = [...reachable, ...buildings.filter((b) => !(b.connectors ?? []).length)];
  let cursor = 0;
  const usable = reachable.length;

  // Ticket mode: the three money sinks come first — the mode is unplayable
  // without a courthouse/mechanic.
  if (ticketMode) {
    for (const spec of SPECIAL_BUILDINGS) {
      if (cursor >= usable) break;
      const b = order[cursor++];
      b.role = "special";
      b.special = spec.kind;
      b.name = spec.name;
      b.icon = spec.icon;
      b.color = spec.color;
    }
  }

  const spec = shuffle(dropoffSpecFrom(settings));
  const dropoffN = Math.min(spec.length, usable - cursor);
  for (let i = 0; i < dropoffN; i += 1) {
    const b = order[cursor++];
    b.role = "dropoff";
    b.dropoffColor = spec[i][0];
    b.dropoffLimit = spec[i][1];
    b.color = spec[i][0];
    b.delivered = []; // flipped-to-black packages dropped here
  }

  // Fragility/Free: shapes are unrelated to protection — every location deals
  // from one mixed bag, so any building can hold any blend of squares and
  // circles. Free also drops brown packages from the game entirely.
  const mixedShapes = ticketMode && (settings.fragility === true || settings.free === true);
  const pkgCounts = ticketMode && settings.free === true
    ? Object.fromEntries(Object.entries(settings.packages).filter(([c]) => c !== "#8f6b52"))
    : settings.packages;
  const squareBag = packageColorBag("square", pkgCounts);
  const circleBag = packageColorBag("circle", pkgCounts);
  const mixedBag = mixedShapes
    ? shuffle([
        ...squareBag.map((color) => ({ shape: "square", color })),
        ...circleBag.map((color) => ({ shape: "circle", color }))
      ])
    : null;
  // Timed packages: every circle is stamped with a random clock-face number.
  const timed = ticketMode && settings.timedPackages === true;
  const makePkg = (shape, color) => {
    const p = { id: `pkg${pkgSeq++}`, shape, color };
    if (timed && shape === "circle") p.time = 1 + Math.floor(Math.random() * 12);
    return p;
  };
  const perProtected = settings.perProtected ?? (ticketMode ? 8 : 6);
  const perPickup = settings.perPickup ?? 6;
  const wantPickups = settings.protectedCount +
    (settings.pickupCount ?? Math.floor(squareBag.length / perPickup));
  let remaining = Math.max(0, usable - cursor);
  // Ticket mode reserves about a third of what's left for chore locations, so
  // small maps still get somewhere to work tickets off.
  const ticketWant = ticketMode ? Math.min(settings.ticketLocations ?? 12, TICKET_THEMES.length) : 0;
  const ticketReserve = ticketMode ? Math.min(ticketWant, Math.floor(remaining / 3)) : 0;
  const pickupN = Math.min(wantPickups, remaining - ticketReserve);
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
    // (points mode) or delivered orange package (ticket mode) unlocks it.
    if (b.protected) b.letter = letters[li++];
    const shape = b.protected ? "circle" : "square";
    const bag = b.protected ? circleBag : squareBag;
    // A dry bag leaves the slot empty rather than inventing a package (e.g.
    // Free dropping brown from settings whose counts assumed it).
    b.packages = Array.from({ length: b.protected ? perProtected : perPickup }, () => {
      if (mixedShapes) {
        const entry = mixedBag.pop();
        return entry ? makePkg(entry.shape, entry.color) : null;
      }
      const color = bag.pop();
      return color ? makePkg(shape, color) : null;
    }).filter(Boolean);
  });

  if (ticketMode) {
    // Chore locations: no packages, just a themed place tickets point at.
    const themes = shuffle(TICKET_THEMES.slice());
    const ticketN = Math.min(ticketWant, usable - cursor, themes.length);
    for (let i = 0; i < ticketN; i += 1) {
      const b = order[cursor++];
      b.role = "ticket";
      b.name = themes[i].name;
      b.icon = themes[i].icon;
      b.color = TICKET_LOC_COLOR;
    }

    // Print letters on the blue packages, dealt evenly (the settings check
    // that the blue total divides by the protected-location count). Under
    // Choosing the packages stay blank — blue advances the letters column
    // and the player picks which location to unlock.
    if (settings.choosing === true) return;
    const letterPkgs = [];
    for (const b of pickups) {
      for (const p of b.packages) if (p.color === "#4a72b0") letterPkgs.push(p);
    }
    const letterTotal = (settings.packages?.["#4a72b0"]?.square ?? 0) +
      (settings.packages?.["#4a72b0"]?.circle ?? 0);
    const copies = settings.protectedCount > 0
      ? Math.max(1, Math.round(letterTotal / settings.protectedCount))
      : 0;
    const letterDeck = shuffle(
      settingsLetters(settings).flatMap((l) => Array(copies).fill(l))
    );
    letterPkgs.forEach((p, i) => {
      p.letter = letterDeck.length ? letterDeck[i % letterDeck.length] : null;
    });
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

export function createTruckManiaGame({ io, rooms }) {
  let savedMaps = loadSavedMaps();
  const mapsPayload = () => ({
    maps: savedMaps.map(({ id, name }) => ({ id, name })),
    canSave: savingEnabled
  });

  // Saved versions predating newer fields get them filled in (derived from
  // what they already carry) and written back, so nothing saved is lost.
  let savedSettings = loadSavedSettings().map((e) => ({ ...e, settings: migrateSettings(e.settings) }));
  if (savingEnabled && JSON.stringify(savedSettings) !== JSON.stringify(loadSavedSettings())) {
    persistSavedSettings(savedSettings);
  }
  // Each saved version also names the map it plays on (`mapId`, null = NONE:
  // the version doesn't care which map is on the table) and carries rule hints
  // so the list can label what applying it would set up.
  const settingsPayload = () => ({
    settings: savedSettings.map(({ id, name, mapId, settings }) => ({
      id,
      name,
      mapId: mapId ?? null,
      mode: modeOf(settings),
      suspension: settings?.suspension === true,
      fragility: settings?.fragility === true,
      free: settings?.free === true,
      choosing: settings?.choosing === true,
      keepGoing: settings?.keepGoing === true,
      timedPackages: settings?.timedPackages === true,
      dayOnlyActivities: settings?.dayOnlyActivities === true
    })),
    canSave: savingEnabled
  });

  // The room's live settings, and value lookups against them. Columns are
  // indexed by the player's current level, clamped to the column's length.
  const S = (room) => room.truckMania.settings ?? DEFAULT_SETTINGS;
  const isTicket = (room) => modeOf(S(room)) === "tickets";
  // Fragility rule set: circles are fragile packages (see BASE_TICKET_SETTINGS).
  const isFragility = (room) => isTicket(room) && !!S(room).fragility;
  // Free rule set: no cargo-mix rule, no delivery payouts — the turn opens
  // with a stones-or-money pick instead (see BASE_TICKET_SETTINGS).
  const isFree = (room) => isTicket(room) && !!S(room).free;
  // Choosing rule: letters is a real 0/1-flag column — each 1 step grants a
  // pick of any locked protected location (no letters on the packages).
  const isChoosing = (room) => isTicket(room) && !!S(room).choosing;
  // Keep going: pay to reopen movement after a terminal stop. While on, the
  // two drive-by abilities are out of the game entirely.
  const keepGoingOn = (room) => isTicket(room) && !!S(room).keepGoing;
  // Timed packages: circles carry a clock-face number and only drop off when
  // the clock reads it ±1 (AM/PM agnostic — the face number is all that
  // matters; 12 wraps to 1). Day only activities: the special buildings close
  // at night.
  const isTimed = (room) => isTicket(room) && !!S(room).timedPackages;
  const dayOnly = (room) => isTicket(room) && !!S(room).dayOnlyActivities;
  // Circular distance between two clock-face numbers (1–12): 12 and 1 are 1
  // apart, so an 8 covers 7/8/9 and a 1 covers 12/1/2.
  const faceGap = (a, b) => {
    const d = Math.abs(a - b) % 12;
    return Math.min(d, 12 - d);
  };
  const timedDropoffOk = (room, pkg) => {
    if (!isTimed(room) || pkg?.shape !== "circle" || pkg.time == null) return true;
    return faceGap(faceHour(room.truckMania.time ?? START_TIME), pkg.time) <= 1;
  };
  // The special buildings are shut at night when Day only activities is on.
  const specialsOpen = (room) => !dayOnly(room) || !isNight(room.truckMania.time ?? START_TIME);
  const abilityBarred = (room, id) =>
    keepGoingOn(room) && (id === "drive-by-pickup" || id === "drive-by-dropoff");
  // One owner per ability: each is a single card in the deck — once bought it
  // belongs to that player and no one else may buy it.
  const abilityOwned = (room, id) =>
    (room.truckMania.players ?? []).some((p) => p.abilities?.includes(id));
  // Free rules: the turn's opening stones-or-money pick must happen before
  // anything else (moving, package work, the clock, specials, ending).
  const startPickPending = (room, seat) => {
    if (!isFree(room)) return false;
    const p = room.truckMania.players?.[seat];
    if (!p || p.isAI) return false;
    return !room.truckMania.turnState?.startChoice;
  };
  // Suspension rule: a face-down ticket backlog grounds the player's package
  // work — no pickups or dropoffs until the pile flips up (only at turn end).
  const suspended = (room, player) =>
    isTicket(room) && !!S(room).suspension && (player?.ticketPile?.length ?? 0) > 0;
  const colValue = (room, player, col) => {
    const vals = S(room).columns[col] ?? DEFAULT_SETTINGS.columns[col] ??
      DEFAULT_TICKET_SETTINGS.columns[col] ?? [0];
    return vals[Math.min(player?.columns?.[col] ?? 0, vals.length - 1)];
  };
  const maxLevel = (room, col) => (S(room).columns[col]?.length ?? 6) - 1;
  const shapePts = (room, shape) =>
    shape === "circle" ? S(room).points.circle : S(room).points.square;
  // What a delivered color does in this room's mode: ticket mode reroutes
  // blue to "letters" (the letter on the package), orange to "money" and
  // brown to variety (the fragile-capacity column under Fragility; under
  // Free brown isn't dealt at all, so it never comes up).
  const columnForColor = (room, color) => {
    if (isTicket(room)) {
      if (color === "#4a72b0") return "letters";
      if (color === "#e08a3c") return "money";
      if (color === "#8f6b52") return isFragility(room) ? "fragile" : "variety";
    }
    return COLOR_COLUMN[color];
  };
  // Under Choosing the letters column joins the numeric tracks outright —
  // pawn-shop swappable and completed at its top step like the rest. Under
  // Free the variety (brown) column doesn't exist at all.
  const tracksFor = (room) => {
    if (!isTicket(room)) return POINT_TRACKS;
    let base = isFragility(room) ? FRAGILITY_TRACKS : TICKET_TRACKS;
    if (isFree(room)) base = base.filter((c) => c !== "variety");
    return isChoosing(room) ? [...base, "letters"] : base;
  };
  // Ticket-mode win: how many columns this player has completed — the numeric
  // tracks, plus (outside Choosing, where letters already count as a numeric
  // track) the letters column once `lettersToWin` letters are unlocked.
  const completedColumns = (room, player) => {
    let n = tracksFor(room).filter((c) => (player?.columns?.[c] ?? 0) >= maxLevel(room, c)).length;
    if (isTicket(room) && !isChoosing(room)) {
      const need = S(room).lettersToWin ?? S(room).protectedCount ?? 0;
      if (need > 0 && (player?.locations?.length ?? 0) >= need) n += 1;
    }
    return n;
  };
  // Winning takes both: `columnsToWin` completed columns AND a clean record —
  // no visible tickets and no face-down pile. Called wherever either half can
  // change (column advances, letter unlocks, ticket clears).
  const checkTicketWin = (room, playerIdx) => {
    if (!isTicket(room) || room.truckMania.winner != null) return;
    const p = room.truckMania.players?.[playerIdx];
    if (!p || completedColumns(room, p) < (S(room).columnsToWin ?? 3)) return;
    if ((p.tickets?.length ?? 0) > 0 || (p.ticketPile?.length ?? 0) > 0) return;
    room.truckMania.winner = playerIdx;
  };

  // Map-shaping options derived from the settings: the exact stoplight count
  // (the blank-light split assumes it) and enough buildings to seat every
  // dropoff, pickup, special and chore location, plus a few empties.
  function genOpts(settings) {
    const ticket = modeOf(settings) === "tickets";
    const dropoffN = dropoffSpecFrom(settings).length;
    const squares = LOC_COLORS.reduce((n, c) => n + (settings.packages?.[c]?.square ?? 0), 0);
    const pickupN = (settings.protectedCount ?? 0) +
      (settings.pickupCount ?? Math.floor(squares / 6));
    const choreN = ticket ? Math.min(settings.ticketLocations ?? 12, TICKET_THEMES.length) : 0;
    const specialN = ticket ? SPECIAL_BUILDINGS.length : 0;
    const opts = { dense: ticket, buildings: dropoffN + pickupN + choreN + specialN + 4 };
    if (ticket && Number.isInteger(settings.intersections)) {
      opts.intersections = settings.intersections; // the light-free corners come on top
    }
    return opts;
  }

  // Does the map on the table satisfy what the settings ask of it? When it
  // doesn't (stoplight count off, or not enough reachable buildings), applying
  // the settings regenerates the board.
  function mapFits(map, settings) {
    if (modeOf(settings) !== "tickets") return true;
    const wantLights = Number.isInteger(settings.intersections) ? settings.intersections : null;
    if (wantLights !== null && (map.intersections?.length ?? 0) !== wantLights) return false;
    const reachable = (map.blocks ?? []).flatMap((b) => b.buildings ?? [])
      .filter((b) => (b.connectors ?? []).length > 0).length;
    return reachable >= genOpts(settings).buildings - 4;
  }

  // Put a settings version on the table: apply the numbers, seat the attached
  // saved map when the version names one (NONE = keep whatever map is up,
  // unless it no longer fits the numbers), and re-deal the board.
  function applySettingsToRoom(room, settings, mapId) {
    const modeChanged = modeOf(S(room)) !== modeOf(settings);
    room.truckMania.settings = cloneSettings(settings);
    const attached = savedMaps.find((m) => m.id === mapId);
    if (attached) {
      room.truckMania.map = hydrate(attached.map);
    } else if (modeChanged || !mapFits(room.truckMania.map, settings)) {
      room.truckMania.map = generateCityMap(Date.now(), genOpts(settings));
    }
    setupBoard(room);
    room.truckMania.map.seed = `${room.truckMania.map.seed}-t${Date.now()}`;
  }

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

  // Humans hold the first seats, AI the rest. Trucks start off the board
  // (spot null), lined up under their owner's score chip; each drives in
  // through an edge stoplight on its first move. `facing` (degrees) tracks
  // arrival heading so AI routing obeys the no-U-turn rule the same way the
  // humans' does — meaningless until the truck has entered.
  function placeTrucks(count) {
    return Array.from({ length: count }, (_, i) => ({
      id: i, player: i, spot: null, cargo: [], facing: 0
    }));
  }

  // Where an off-board truck may enter: the stoplights sitting on the map's
  // border streets. Hand-edited maps without any edge light fall back to every
  // light, so entry is never impossible.
  const EDGE_PAD = 20;
  function edgeLights(map) {
    const w = map.width ?? MAP_W;
    const h = map.height ?? MAP_H;
    const all = map.intersections ?? [];
    const edge = all.filter((o) =>
      o.x < EDGE_PAD || o.x > w - EDGE_PAD || o.y < EDGE_PAD || o.y > h - EDGE_PAD);
    return edge.length ? edge : all;
  }

  // Unit vector pointing from an entry light into the board.
  function inwardDir(map, o) {
    const w = map.width ?? MAP_W;
    const h = map.height ?? MAP_H;
    let dx = 0;
    let dy = 0;
    if (o.x < EDGE_PAD) dx = 1;
    else if (o.x > w - EDGE_PAD) dx = -1;
    if (o.y < EDGE_PAD) dy = 1;
    else if (o.y > h - EDGE_PAD) dy = -1;
    if (!dx && !dy) {
      dx = w / 2 - o.x;
      dy = h / 2 - o.y;
    }
    const len = Math.hypot(dx, dy) || 1;
    return [dx / len, dy / len];
  }

  // Assign fresh locations/packages, drop trucks, and reset the player boards.
  function setupBoard(room) {
    const settings = S(room);
    const ticketMode = modeOf(settings) === "tickets";
    const humans = humanCount(room);
    const maxAi = maxAiFor(room);
    const aiCount = Math.max(0, Math.min(maxAi, room.truckMania.aiCount ?? maxAi));
    room.truckMania.aiCount = aiCount;
    assignLocations(room.truckMania.map, settings);
    if (ticketMode) {
      setBlankLights(
        room.truckMania.map.intersections,
        settings.blankLights?.green ?? 5,
        settings.blankLights?.red ?? 5
      );
    }
    room.truckMania.trucks = placeTrucks(humans + aiCount);
    room.truckMania.players = room.truckMania.trucks.map((t, i) => ({
      color: PLAYER_COLORS[i % PLAYER_COLORS.length],
      // A lone human is just "You"; with more, seats get names both screens
      // can agree on (each client shows its own seat as "You" locally).
      name: i >= humans ? `AI ${i - humans + 1}` : humans === 1 ? "You" : `P${i + 1}`,
      isAI: i >= humans,
      columns: emptyColumns(),
      timeStones: settings.startingTimeStones,
      money: settings.startingMoney ?? 0,
      points: STARTING_POINTS,
      locations: [], // unlocked letters (location tiles / delivered oranges)
      abilities: [], // owned ability ids
      pendingDrafts: [], // queued "locations"/"abilities" draws awaiting a pick
      pendingFragile: [], // fragile-delivery bonuses awaiting a stones/money pick
      pendingPicks: 0, // Choosing: location unlocks awaiting a board click
      tickets: [], // visible tickets, up to 3: { id, loc: building bid }
      ticketPile: [] // face-down overflow, flipped up when the turn ends
    }));
    room.truckMania.lastRoll = null;
    room.truckMania.ticketSeq = 0;
    room.truckMania.locationDeck = ticketMode ? [] : buildLocationDeck(settings);
    room.truckMania.abilityDeck = ticketMode ? [] : buildAbilityDeck();
    room.truckMania.aiGraph = null; // rebuilt lazily against the current map
    room.truckMania.time = START_TIME;
    room.truckMania.turn = 0; // player index whose turn it is; 0 is the first human
    room.truckMania.turnState = freshTurnState();
    room.truckMania.aiMove = null; // transient: an AI's chosen path, for the client to animate
    room.truckMania.aiActor = null; // which of an AI's trucks is acting this turn
    room.truckMania.aiStealPlan = null; // { thiefId, victimId } when a turn is a steal
    room.truckMania.aiContinue = null; // second-leg destination after a chore stopover
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
        turn: room.truckMania.turn ?? 0,
        turnState: room.truckMania.turnState ?? freshTurnState(),
        winner: room.truckMania.winner ?? null,
        maxAi: maxAiFor(room), // free seats — bounds the AI-count picker
        speed: roomSpeed(room),
        settings: S(room),
        aiMove: room.truckMania.aiMove ?? null,
        trucks: room.truckMania.trucks,
        // Face-down tickets stay hidden (even from their owner) — only the
        // pile's size goes out.
        players: (room.truckMania.players ?? []).map((p) => {
          const { ticketPile, ...rest } = p;
          return { ...rest, ticketPileCount: ticketPile?.length ?? 0 };
        }),
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

  // The seat (player index) a socket holds: humans occupy the first seats in
  // room.players order. Solo rooms list the same socket twice, so indexOf
  // still lands on 0.
  const seatOf = (room, socket) => room.players.indexOf(socket.id);

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
    if (suspended(room, player)) return null;
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
    if (player && !canLoadPkg(room, player, truck, pkg)) return null;
    building.packages.splice(idx, 1);
    truck.cargo.push(pkg);
    return building;
  }

  // Unload one package at a matching dropoff; returns the building it landed
  // on (truthy) or false.
  function tryDropoff(room, truck, packageId) {
    const idx = (truck.cargo ?? []).findIndex((p) => p.id === packageId);
    if (idx === -1) return false;
    const pkg = truck.cargo[idx];
    const player = room.truckMania.players?.[truck.player];
    if (suspended(room, player)) return false;
    // Timed packages only drop off when the clock reads their number ±1.
    if (!timedDropoffOk(room, pkg)) return false;
    const building = usableBuildings(room.truckMania.map, truck, player)
      .find((b) => b.role === "dropoff" && b.dropoffColor === pkg.color &&
        (b.delivered?.length ?? 0) < (b.dropoffLimit ?? Infinity));
    if (!building) return false;
    truck.cargo.splice(idx, 1);
    const delivered = pkg;
    (building.delivered ??= []).push(delivered);

    const col = columnForColor(room, building.dropoffColor);
    if (isTicket(room)) {
      // No points. Circles and squares alike are worth one column step; orange
      // grants the letter printed on the package; brown pays out money (the
      // level's value) and advances the money column, mirroring time stones.
      // Fragility flips the payouts around: purple/brown upgrades pay nothing —
      // instead every fragile (circle) delivery offers the player's choice of
      // time stones or money at the current column values.
      if (player) {
        const fragility = isFragility(room);
        // Free: no delivery payouts at all — the turn-opening stones-or-money
        // pick replaces them, and circles are just packages.
        const noPayout = fragility || isFree(room);
        if (fragility && delivered.shape === "circle") {
          grantFragileBonus(room, player);
        }
        // Timed packages: delivering one pays its money reward on top of
        // whatever the delivery does (independent of the rule set).
        if (isTimed(room) && delivered.shape === "circle" && delivered.time != null) {
          player.money = (player.money ?? 0) + (S(room).timedReward ?? 2);
        }
        if (col === "letters") {
          if (isChoosing(room)) {
            // Choosing: orange advances the letters column like any other
            // track; a step whose flag is 1 grants a pick of a locked location.
            const next = Math.min(maxLevel(room, "letters"), (player.columns.letters ?? 0) + 1);
            if (next > (player.columns.letters ?? 0)) {
              player.columns.letters = next;
              if ((S(room).columns.letters?.[next] ?? 0) >= 1) grantLocationPick(room, player);
              checkTicketWin(room, truck.player);
            }
          } else if (delivered.letter) {
            // Repeats count: every orange delivery fills a letters-column slot,
            // duplicate letter or not (the letter still unlocks its location).
            player.locations.push(delivered.letter);
            checkTicketWin(room, truck.player); // letters are a completable column
          }
        } else {
          if (!noPayout && col === "timestones") player.timeStones += colValue(room, player, "timestones");
          if (!noPayout && col === "money") player.money += colValue(room, player, "money");
          player.columns[col] = Math.min(maxLevel(room, col), player.columns[col] + 1);
          checkTicketWin(room, truck.player);
        }
      }
      return building;
    }

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
    return building;
  }

  // Skip payout (ticket mode): sitting a turn out — no moving, no package
  // work, no stealing; changing the clock is still fine — pays the player
  // BOTH column values: their time stones level and their money level.
  function paySkip(room, player) {
    player.timeStones += colValue(room, player, "timestones");
    player.money = (player.money ?? 0) + colValue(room, player, "money");
  }

  // Fragility: a delivered fragile package pays time stones OR money — the
  // deliverer's pick — at the current column values, snapshotted here so a
  // later upgrade doesn't change an offer already on the table. Humans get a
  // queued choice; the AI takes stones while short on them, else the bigger pot.
  function grantFragileBonus(room, player) {
    const stones = colValue(room, player, "timestones");
    const money = colValue(room, player, "money");
    if (player.isAI) {
      if ((player.timeStones ?? 0) < 4 || stones >= money) player.timeStones += stones;
      else player.money += money;
      return;
    }
    (player.pendingFragile ??= []).push({ stones, money });
  }

  // Choosing: a 1-flag letters step grants a pick of any still-locked
  // protected location. Humans get a queued pick (resolved by clicking a lit
  // building); the AI takes the best locked letter — a stocked one if any.
  function grantLocationPick(room, player) {
    const locked = settingsLetters(S(room)).filter((l) => !player.locations.includes(l));
    if (!locked.length) return; // everything already unlocked — nothing to pick
    if (player.isAI) {
      const buildings = (room.truckMania.map.blocks ?? []).flatMap((bl) => bl.buildings ?? []);
      const stocked = locked.find((l) => buildings.some((b) =>
        b.role === "pickup" && b.protected && b.letter === l && (b.packages?.length ?? 0) > 0));
      player.locations.push(stocked ?? locked[0]);
      return;
    }
    player.pendingPicks = (player.pendingPicks ?? 0) + 1;
  }

  // Is this truck parked on the same spot as any other truck? (Off-board
  // trucks share nothing — null spots must not match each other.)
  function sharesSpot(room, truck) {
    if (truck.spot == null) return false;
    return (room.truckMania.trucks ?? []).some((t) => t.id !== truck.id && t.spot === truck.spot);
  }

  // Resolve a human's acting truck for this action: it must belong to that
  // human's seat, and — since only one truck may act per turn — must match
  // the truck already active this turn, if any.
  function humanTruck(room, seat, truckId) {
    const t = (room.truckMania.trucks ?? []).find((x) => x.id === truckId);
    if (!t || t.player !== seat) return null;
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

  // The building the truck's parking spot belongs to (its own, not the block).
  function buildingAtTruck(room, truck) {
    const spot = room.truckMania.map.spots?.[truck.spot];
    return spot ? buildingByBid(room.truckMania.map, spot.building) : null;
  }

  // Ticket mode: arriving at a chore location works off every matching
  // visible ticket at once — duplicates clear together. Doesn't end movement,
  // so drive on and still pick up / drop off.
  function resolveTicketAt(room, truck, player) {
    if (!player?.tickets?.length) return;
    const b = buildingAtTruck(room, truck);
    if (!b || b.role !== "ticket") return;
    player.tickets = player.tickets.filter((t) => t.loc !== b.bid);
    checkTicketWin(room, truck.player); // clearing the last ticket can seal a win
  }

  // Park the truck at a spot. Point mode rolls one ticket die per red crossed
  // right away (a die over the player's aversion costs a point; points can go
  // negative). Ticket mode instead banks a die per red into the turn's pool,
  // rolled when the turn ends.
  function applyMove(room, truck, spot, reds) {
    truck.spot = spot;
    const player = room.truckMania.players?.[truck.player];
    const n = Number.isInteger(reds) ? Math.max(0, Math.min(12, reds)) : 0;
    if (isTicket(room)) {
      const ts = room.truckMania.turnState;
      ts.dicePool = Math.min(12, (ts.dicePool ?? 0) + n);
      room.truckMania.lastRoll = null;
      resolveTicketAt(room, truck, player);
      return;
    }
    if (player && n > 0) {
      const aversion = colValue(room, player, "aversion");
      const dice = Array.from({ length: n }, () => 1 + Math.floor(Math.random() * 6));
      const tickets = dice.filter((d) => d > aversion).length;
      const loss = tickets * S(room).points.ticket;
      player.points -= loss; // may go negative
      room.truckMania.rollSeq = (room.truckMania.rollSeq || 0) + 1;
      room.truckMania.lastRoll = { seq: room.truckMania.rollSeq, player: truck.player, dice, aversion, tickets, loss };
    } else {
      room.truckMania.lastRoll = null;
    }
  }

  // Bids of the chore locations on the current map.
  function ticketLocationBids(map) {
    return (map.blocks ?? []).flatMap((bl) => bl.buildings ?? [])
      .filter((b) => b.role === "ticket")
      .map((b) => b.bid);
  }

  // Flip face-down tickets into free visible slots (only ever at turn end).
  // The slot count is tunable (`visibleTickets`).
  function flipUpTickets(room, player) {
    const slots = S(room).visibleTickets ?? 3;
    while ((player.tickets?.length ?? 0) < slots && player.ticketPile?.length) {
      player.tickets.push(player.ticketPile.shift());
    }
  }

  // Ticket mode's end-of-turn beat: roll the banked dice; every die over the
  // player's aversion issues tickets, each pointing at a random chore
  // location. New tickets join the face-down pile, then the pile flips into
  // free slots — so fresh tickets are only seen next turn. Returns how long
  // clients will animate the roll (0 when nothing rolled).
  function rollTicketDice(room, playerIdx) {
    if (!isTicket(room)) return 0;
    const player = room.truckMania.players?.[playerIdx];
    const ts = room.truckMania.turnState;
    const n = Math.max(0, Math.min(12, ts?.dicePool ?? 0));
    let ms = 0;
    if (player && n > 0 && room.truckMania.winner == null) {
      const aversion = colValue(room, player, "aversion");
      const dice = Array.from({ length: n }, () => 1 + Math.floor(Math.random() * 6));
      const fails = dice.filter((d) => d > aversion).length;
      const issued = fails * (S(room).tickets?.perFail ?? 1);
      const locs = ticketLocationBids(room.truckMania.map);
      for (let i = 0; i < issued && locs.length; i += 1) {
        room.truckMania.ticketSeq = (room.truckMania.ticketSeq ?? 0) + 1;
        player.ticketPile.push({
          id: `t${room.truckMania.ticketSeq}`,
          loc: locs[Math.floor(Math.random() * locs.length)]
        });
      }
      room.truckMania.rollSeq = (room.truckMania.rollSeq || 0) + 1;
      room.truckMania.lastRoll = {
        seq: room.truckMania.rollSeq, player: playerIdx, dice, aversion,
        tickets: issued, mode: "tickets"
      };
      ms = diceMsFor(room.truckMania.lastRoll);
    } else {
      room.truckMania.lastRoll = null;
    }
    if (player) flipUpTickets(room, player);
    return ms;
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
  const roomSpeed = (room) => Math.min(3, Math.max(1, room.truckMania.speed ?? 3));

  const aiTimers = new Map(); // roomId -> pending setTimeout handle

  function clearAiTimer(roomId) {
    const t = aiTimers.get(roomId);
    if (t) {
      clearTimeout(t);
      aiTimers.delete(roomId);
    }
  }

  // Hand the turn to the next player, resetting the per-turn flags. If that
  // player is an AI, schedule its turn. `extraMs` delays the next AI turn past
  // whatever the previous turn still has animating (the end-of-turn roll).
  function advanceTurn(roomId, extraMs = 0) {
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
    room.truckMania.aiContinue = null;
    emitState(roomId, room);
    if (room.truckMania.players[room.truckMania.turn]?.isAI) {
      clearAiTimer(roomId);
      aiTimers.set(roomId, setTimeout(() => runAiTurn(roomId), (AI_TURN_GAP_MS + extraMs) / roomSpeed(room)));
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
    const aiPlayer = room.truckMania.players?.[idx];
    if (!aiPlayer?.isAI) return;
    // Free rules: the turn opens with the stones-or-money pick, before all
    // else — the AI takes stones while short on them, else the bigger pot.
    if (isFree(room) && !room.truckMania.turnState.startChoice) {
      const stones = colValue(room, aiPlayer, "timestones");
      const money = colValue(room, aiPlayer, "money");
      if ((aiPlayer.timeStones ?? 0) < 4 || stones >= money) {
        aiPlayer.timeStones += stones;
        room.truckMania.turnState.startChoice = "stones";
      } else {
        aiPlayer.money = (aiPlayer.money ?? 0) + money;
        room.truckMania.turnState.startChoice = "money";
      }
    }
    aiRunLeg(roomId, idx);
  }

  // One move+act leg of an AI turn, timed so each beat waits out the client
  // animations it triggers. After acting, the AI may pay to Keep going and run
  // another leg (aiMaybeKeepGoing); otherwise the turn's dice roll and the
  // hand-off happen. Keep going lets a stone-rich AI chain several stops in a
  // single turn, the way a human would.
  function aiRunLeg(roomId, idx) {
    const room = rooms.get(roomId);
    if (!room || room.gameId !== "truck-mania") return;
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
      aiTimers.set(roomId, setTimeout(() => {
        const r2 = rooms.get(roomId);
        if (!r2 || r2.gameId !== "truck-mania") return;
        // Keep going: pay to reopen movement and run another leg when a good
        // next stop is worth it. Otherwise end the turn (roll the banked dice).
        if (r2.truckMania.winner == null && aiMaybeKeepGoing(r2, idx)) {
          emitState(roomId, r2);
          clearAiTimer(roomId);
          aiTimers.set(roomId, setTimeout(() => aiRunLeg(roomId, idx), AI_TURN_GAP_MS / roomSpeed(r2)));
          return;
        }
        const rollMs = rollTicketDice(r2, idx);
        advanceTurn(roomId, rollMs);
      }, endDelay));
    }, actDelay));
  }

  // Keep going (AI): once movement has ended, decide whether paying the stone
  // cost to reopen it is worth it — a worthwhile next stop the acting truck can
  // reach, especially when the way there is green or a package it's carrying
  // can be delivered right now. Pays and resets the turn's movement flags when
  // it commits, so the next leg drives on. Bounded per turn and by a small
  // stone reserve so the AI never strands itself broke.
  function aiMaybeKeepGoing(room, idx) {
    if (!keepGoingOn(room)) return false;
    const ts = room.truckMania.turnState;
    // (The AI never sets ts.acted — it acts through the shared core — so the
    // gate is the skip flag and the per-turn cap, not ts.acted.)
    if (ts.skipped) return false;
    if ((ts.aiLegs ?? 0) >= 4) return false; // cap continuations per turn
    const player = room.truckMania.players?.[idx];
    const cost = S(room).keepGoingCost ?? 3;
    // Keep a small reserve so keep going doesn't leave the AI unable to dodge
    // reds next turn.
    if (!player || (player.timeStones ?? 0) < cost + 2) return false;

    // Keep going continues the SAME truck that just acted — the human rule.
    const actorId = room.truckMania.aiActor;
    const truck = (room.truckMania.trucks ?? []).find((t) => t.id === actorId && t.player === idx);
    if (!truck || truck.spot == null) return false;

    const map = room.truckMania.map;
    const spots = map.spots ?? [];
    const graph = getAiGraph(room);
    const canUturn = hasAbility(player, "uturn");

    // Best next destination for that truck, scored value-minus-risk on the
    // real route — the move phase's own yardstick.
    let best = null;
    const occupied = new Set(room.truckMania.trucks.filter((t) => t.id !== truck.id).map((t) => t.spot));
    for (const c of aiCandidates(room, truck, player, occupied)) {
      if (c.kind !== "move" || c.spot === truck.spot) continue;
      const here = spots[truck.spot];
      const dest = spots[c.spot];
      const route = findRouteDirected(
        graph, map.intersections, here.x, here.y, truck.facing ?? here.angle, dest.x, dest.y, canUturn
      );
      const reds = route ? route.reds : 2;
      const score = c.value - ticketRisk(room, player, reds) - c.d * 0.0005;
      if (!best || score > best.score) best = { score, reds };
    }
    if (!best) return false;

    // Commit when the next stop clearly beats the stone cost. A green way there
    // is cheap, so a modest stop is enough; crossing reds demands a richer one.
    const threshold = cost * 0.12 + (best.reds === 0 ? 0.8 : 1.7);
    if (best.score <= threshold) return false;

    player.timeStones -= cost;
    ts.acted = false;
    ts.actedByDrop = false;
    ts.pickups = [];
    ts.changedTime = false; // the clock opens up again too
    ts.keptGoing = true;
    ts.aiLegs = (ts.aiLegs ?? 0) + 1;
    ts.aiLockTruck = actorId; // the next leg drives this same truck
    return true;
  }

  function getAiGraph(room) {
    const map = room.truckMania.map;
    const cache = room.truckMania.aiGraph;
    if (cache && cache.seed === map.seed) return cache.graph;
    const graph = buildStreetGraph(map.streets, map.spots ?? []);
    room.truckMania.aiGraph = { seed: map.seed, graph };
    return graph;
  }

  // How many fragile packages (circles) a truck is holding.
  const fragileCount = (truck) => (truck.cargo ?? []).filter((p) => p.shape === "circle").length;

  // The cargo-mix rule for one more package, capacity aside: variety mode
  // limits distinct colors; fragility mode instead caps circles at the
  // fragile-capacity column (a circle takes a normal slot AND a fragile slot);
  // free mode has no mix rule at all — capacity is the only limit.
  function canCarryPkg(room, player, truck, pkg) {
    if (isFree(room)) return true;
    if (isFragility(room)) {
      return pkg.shape !== "circle" || fragileCount(truck) < colValue(room, player, "fragile");
    }
    const colors = new Set((truck.cargo ?? []).map((p) => p.color));
    return colors.has(pkg.color) || colors.size < colValue(room, player, "variety");
  }

  // The full load check: room in the hold plus the cargo-mix rule.
  function canLoadPkg(room, player, truck, pkg) {
    return (truck.cargo?.length ?? 0) < colValue(room, player, "capacity") &&
      canCarryPkg(room, player, truck, pkg);
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
  // biggest net gain, then the cheapest change. Plays by the exact human rules
  // (truck_mania_set_hour): at most one change per turn unless Time lord, the
  // hand sweeps clockwise unless Reverse-time takes the shorter spin, and
  // Cheap-time halves the stone cost — so the AI can never do more than a human
  // could from the same board.
  function maybeAiChangeTime(room, player, numbers, greens = []) {
    const ts = room.truckMania.turnState;
    if (ts.changedTime && !hasAbility(player, "time-lord")) return false; // once per turn
    const budget = aiTimeBudget(player);
    if (!numbers.length || budget <= 0) return false;
    const redCount = {};
    numbers.forEach((n) => { redCount[n] = (redCount[n] || 0) + 1; });
    const greenCount = {};
    greens.forEach((n) => { greenCount[n] = (greenCount[n] || 0) + 1; });
    const t = room.truckMania.time ?? START_TIME;
    const curPos = t % 12;
    const reverse = hasAbility(player, "reverse-time");
    const cheap = hasAbility(player, "cheap-time");
    // The human cost for sweeping the hand to `num`, and which way it goes.
    const costOf = (num) => {
      const cw = (num % 12 - curPos + 12) % 12;
      const ccw = (12 - cw) % 12;
      let cost = reverse ? Math.min(cw, ccw) : cw;
      if (cheap) cost = Math.ceil(cost / 2);
      return { cost, cw, ccw };
    };
    let best = null;
    for (const num of Object.keys(redCount).map(Number)) {
      const gain = redCount[num] - (greenCount[num] || 0);
      if (gain <= 0) continue; // flipping would just trade reds around
      const { cost, cw, ccw } = costOf(num);
      if (cw === 0) continue; // hand already there — no flip
      if (cost >= 1 && cost <= budget && cost <= player.timeStones) {
        if (!best || gain > best.gain || (gain === best.gain && cost < best.cost)) {
          best = { num, cost, gain, cw, ccw };
        }
      }
    }
    if (!best) return false;
    player.timeStones -= best.cost;
    room.truckMania.time = reverse && best.ccw < best.cw
      ? (t - best.ccw + 24) % 24
      : (t + best.cw) % 24;
    for (const oct of room.truckMania.map.intersections) {
      if (oct.number === best.num) oct.color = oct.color === "green" ? "red" : "green";
    }
    ts.changedTime = true;
    return true;
  }

  // Total length of a polyline, for drive-animation pacing.
  function pathLen(path) {
    let len = 0;
    for (let i = 1; i < path.length; i += 1) {
      len += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
    }
    return len;
  }

  // Drive an off-board truck onto the board: in through an entry light near
  // the destination, with a short off-board lead-in so clients animate the
  // arrival from beyond the border. The entry light counts like any other
  // light on the way (red = a die); lights near the destination stay exempt
  // as usual. Tries a few nearby lights and a few entry headings (straight in
  // or turning onto the border street) and keeps the least-red route.
  function aiEnterTruck(room, truck, player, destSpotIdx) {
    const map = room.truckMania.map;
    const dest = (map.spots ?? [])[destSpotIdx];
    if (!dest) return false;
    const graph = getAiGraph(room);
    const canUturn = hasAbility(player, "uturn");
    const lights = [...edgeLights(map)].sort((a, b) =>
      Math.hypot(a.x - dest.x, a.y - dest.y) - Math.hypot(b.x - dest.x, b.y - dest.y));
    let best = null;
    for (const light of lights.slice(0, 4)) {
      const [ix, iy] = inwardDir(map, light);
      const inward = (Math.atan2(iy, ix) * 180) / Math.PI;
      for (const heading of [inward, inward - 90, inward + 90]) {
        const route = findRouteDirected(
          graph, map.intersections, light.x, light.y, heading, dest.x, dest.y, canUturn
        );
        if (!route) continue;
        const reds = route.reds + (light.color === "red" ? 1 : 0);
        const len = pathLen(route.path);
        if (!best || reds < best.reds || (reds === best.reds && len < best.len)) {
          best = { light, ix, iy, route, reds, len };
        }
      }
    }
    if (!best) return false;
    const path = [
      [best.light.x - best.ix * 46, best.light.y - best.iy * 46],
      ...best.route.path
    ];
    truck.facing = best.route.endAngle;
    applyMove(room, truck, destSpotIdx, best.reds);
    room.truckMania.aiMove = { truckId: truck.id, path, endAngle: best.route.endAngle };
    room.truckMania.driveMs = Math.max(450, (pathLen(path) / TRUCK_SPEED) * 1000) + 300;
    return true;
  }

  // Drive `truck` from its current spot to `destSpotIdx`, greening a red on the
  // way if affordable, then applying the move (rolling tickets) and recording
  // the path for the client. Returns whether it drove. Shared by the move beat
  // and a steal's getaway. Off-board trucks enter from the edge instead.
  function aiDriveTruckTo(room, truck, player, destSpotIdx) {
    if (truck.spot == null) return aiEnterTruck(room, truck, player, destSpotIdx);
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

  // Worth of eventually delivering one package. Point mode: its points plus
  // the value of the column its color advances (engine columns matter most
  // while low). Ticket mode: pure column progress — nearly-complete columns
  // run hot because completing three wins.
  function deliveryValue(room, player, color, shape) {
    const col = columnForColor(room, color);
    const lvl = player.columns[col] ?? 0;
    if (isTicket(room)) {
      const fragility = isFragility(room);
      const free = isFree(room);
      // Fragility: a delivered circle also pays stones or money on top.
      // Timed packages: a delivered timed circle pays its money reward on top.
      const fragileBonus = fragility && shape === "circle"
        ? 0.15 * Math.max(colValue(room, player, "timestones"), colValue(room, player, "money"))
        : 0;
      const timedBonus = isTimed(room) && shape === "circle"
        ? 0.15 * (S(room).timedReward ?? 2)
        : 0;
      const extra = fragileBonus + timedBonus;
      // Outside Choosing, letters isn't a numeric column — a delivery just
      // unlocks the printed letter. Under Choosing it falls through and is
      // scored like any other track (its payout being the location picks).
      if (col === "letters" && !isChoosing(room)) return 1.0 + extra;
      const max = Math.max(1, maxLevel(room, col));
      if (lvl >= max) return 0.2 + extra; // column already complete
      let v = 1;
      // Purple/orange pay nothing per upgrade under fragility/free — under
      // fragility only circles do, under free the turn-opening pick does.
      if (col === "timestones") v += fragility || free ? 0 : 0.15 * colValue(room, player, "timestones");
      else if (col === "money") v += fragility || free ? 0 : 0.15 * colValue(room, player, "money");
      else if (col === "capacity") v += lvl < 2 ? 1.2 : lvl < 4 ? 0.6 : 0.1;
      // Under Free the brown column unlocks nothing — only its completion counts.
      else if (col === "variety" || col === "fragile") v += free ? 0 : lvl < 2 ? 1.0 : lvl < 4 ? 0.5 : 0.1;
      else if (col === "aversion") v += lvl < 3 ? 0.7 : 0.2;
      else if (col === "agression") v += lvl < 3 ? 0.4 : 0.1;
      v += (lvl / max) * 1.5; // race to top out the column
      return v + extra;
    }
    let v = shapePts(room, shape);
    if (col === "timestones") v += 0.25 * colValue(room, player, "timestones");
    else if (col === "capacity") v += lvl < 2 ? 1.5 : lvl < 4 ? 0.8 : 0.2;
    else if (col === "variety") v += lvl < 2 ? 1.3 : lvl < 4 ? 0.7 : 0.2;
    else if (col === "aversion") v += lvl < 3 ? 0.9 : 0.3;
    else if (col === "agression") v += lvl < 3 ? 0.6 : 0.2;
    else if (col === "locations") v += 1.0; // draws a location tile
    else if (col === "abilities") v += 1.3; // draws an ability card
    return v;
  }

  // Expected cost of crossing `reds` red lights now: per-die ticket odds from
  // aversion. Point mode counts lost points; ticket mode counts issued
  // tickets (each roughly a chore trip).
  function ticketRisk(room, player, reds) {
    if (!reds) return 0;
    const aversion = colValue(room, player, "aversion");
    const perTicket = isTicket(room)
      ? (S(room).tickets?.perFail ?? 1) * 0.9
      : S(room).points.ticket;
    return reds * ((6 - aversion) / 6) * perTicket;
  }

  // Worth of parking at a pickup: simulate the greedy load (capacity, variety,
  // locked letters, dead colors respected), best packages first.
  function pickupValue(room, truck, player, b) {
    if (b.role !== "pickup" || suspended(room, player)) return 0;
    if (b.protected && b.letter && !(player.locations ?? []).includes(b.letter)) return 0;
    const map = room.truckMania.map;
    let space = colValue(room, player, "capacity") - (truck.cargo?.length ?? 0);
    if (space <= 0) return 0;
    const fragility = isFragility(room);
    const free = isFree(room);
    const variety = colValue(room, player, "variety");
    const colors = new Set((truck.cargo ?? []).map((p) => p.color));
    let fragileSpace = fragility
      ? colValue(room, player, "fragile") - fragileCount(truck)
      : Infinity;
    const pkgs = (b.packages ?? [])
      .filter((p) => colorDeliverable(map, p.color))
      .sort((a, c) => deliveryValue(room, player, c.color, c.shape) - deliveryValue(room, player, a.color, a.shape));
    let v = 0;
    for (const p of pkgs) {
      if (space <= 0) break;
      if (free) {
        // no cargo-mix rule
      } else if (fragility) {
        if (p.shape === "circle") {
          if (fragileSpace <= 0) continue;
          fragileSpace -= 1;
        }
      } else if (!colors.has(p.color)) {
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
    if (b.role !== "dropoff" || suspended(room, player)) return 0;
    const space = (b.dropoffLimit ?? Infinity) - (b.delivered?.length ?? 0);
    if (space <= 0) return 0;
    // Timed circles that the clock doesn't allow right now can't be delivered
    // here yet — don't value a trip on them.
    const matching = (truck.cargo ?? [])
      .filter((p) => p.color === b.dropoffColor && timedDropoffOk(room, p)).slice(0, space);
    if (!matching.length) return 0;
    let v = 0;
    let pts = 0;
    for (const p of matching) {
      v += deliveryValue(room, player, p.color, p.shape);
      if (!isTicket(room)) pts += shapePts(room, p.shape);
    }
    if (isTicket(room)) {
      // Would these deliveries top out a column? That's a win-condition step.
      // (Under Choosing, letters is a real column and counts too.)
      const col = columnForColor(room, b.dropoffColor);
      if ((col !== "letters" || isChoosing(room)) &&
        (player.columns[col] ?? 0) + matching.length >= maxLevel(room, col)) {
        v += 3;
      }
    } else if (player.points + pts >= WINNING_POINTS) {
      v += 8; // clinches the win
    }
    return v;
  }

  // Ticket mode: what a special building is worth visiting for right now.
  function specialValue(room, player, b) {
    if (!specialsOpen(room)) return 0; // Day only activities: shut at night
    if (b.special === "mechanic") {
      const costs = S(room).abilityCosts ?? {};
      const affordable = ABILITY_CARDS.some((id) =>
        !abilityOwned(room, id) && !abilityBarred(room, id) &&
        Number.isInteger(costs[id]) && (player.money ?? 0) >= costs[id]);
      return affordable ? 1.6 : 0;
    }
    if (b.special === "courthouse") {
      const cost = (S(room).courtCosts ?? [2, 3, 4])[0];
      return (player.tickets?.length ?? 0) >= 2 && (player.money ?? 0) >= cost ? 1.0 : 0;
    }
    return 0; // the AI leaves the pawn shop to the humans
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
      const fragility = isFragility(room);
      const free = isFree(room);
      const variety = colValue(room, player, "variety");
      const colors = new Set((thief.cargo ?? []).map((p) => p.color));
      let fragileSpace = fragility
        ? colValue(room, player, "fragile") - fragileCount(thief)
        : Infinity;
      let space = capacity - (thief.cargo?.length ?? 0);
      let taken = 0;
      let value = 0;
      const opts = (v.cargo ?? [])
        .filter((p) => colorDeliverable(map, p.color))
        .sort((a, c) => deliveryValue(room, player, c.color, c.shape) - deliveryValue(room, player, a.color, a.shape));
      for (const p of opts) {
        if (taken >= gap || space <= 0) break;
        if (free) {
          // no cargo-mix rule
        } else if (fragility) {
          if (p.shape === "circle") {
            if (fragileSpace <= 0) continue;
            fragileSpace -= 1;
          }
        } else if (!colors.has(p.color)) {
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
  // { kind, spot, d, value, victim? }. An off-board truck measures distance
  // from the nearest entry light and can't line up a steal on the way in.
  function aiCandidates(room, truck, player, occupied) {
    const map = room.truckMania.map;
    const spots = map.spots ?? [];
    const here = truck.spot != null ? spots[truck.spot] : null;
    if (truck.spot != null && !here) return [];
    const entries = here ? null : edgeLights(map);
    if (!here && !entries.length) return [];
    const distTo = (s) => (here
      ? Math.hypot(s.x - here.x, s.y - here.y)
      : Math.min(...entries.map((o) => Math.hypot(s.x - o.x, s.y - o.y))));
    const out = [];
    spots.forEach((s, i) => {
      if (i !== truck.spot && occupied?.has(i)) return;
      const b = buildingByBid(map, s.building);
      if (!b) return;
      let value = 0;
      if (b.role === "pickup") value = pickupValue(room, truck, player, b);
      else if (b.role === "dropoff") value = dropoffValue(room, truck, player, b);
      else if (isTicket(room) && b.role === "ticket") {
        // Chores resolve on arrival, so only driving there counts — staying
        // put doesn't work a ticket off. Duplicates all clear at once, and
        // tickets are debt the AI should take seriously.
        const matching = (player.tickets ?? []).filter((t) => t.loc === b.bid).length;
        if (i !== truck.spot && matching > 0) value = 1.8 * matching;
      } else if (isTicket(room) && b.role === "special") {
        value = specialValue(room, player, b);
      }
      if (value <= 0) return;
      out.push({ kind: "move", spot: i, d: distTo(s), value });
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
    // Keep going continues the same truck that acted (the human rule), so once
    // it's locked, only that truck is in play.
    const lock = room.truckMania.turnState.aiLockTruck;
    const myTrucks = (room.truckMania.trucks ?? [])
      .filter((t) => t.player === idx && (lock == null || t.id === lock));
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
    if (!cands.length && !isTicket(room)) return false;
    cands.sort((a, b) => (b.value - b.d * 0.0005) - (a.value - a.d * 0.0005));

    let best = null;
    for (const c of cands.slice(0, 6)) {
      let score;
      if (c.spot === c.truck.spot) {
        score = c.value; // already parked there — no drive, no tickets
      } else if (c.truck.spot == null) {
        // Entering from the edge: assume roughly one light on the way in.
        score = c.value - ticketRisk(room, player, 1) - c.d * 0.0005;
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

    // Sitting the turn out pays the stone+money column values (ticket mode) —
    // take the payout when nothing on the board beats it. Not on a keep-going
    // continuation, though: the turn already acted, so there's no skip to pay
    // (and paying again would double-dip the payout).
    if (isTicket(room) && !room.truckMania.turnState.keptGoing) {
      const skipValue = 0.15 *
        (colValue(room, player, "timestones") + colValue(room, player, "money"));
      if (!best || best.score < skipValue) {
        paySkip(room, player);
        room.truckMania.turnState.skipped = true;
        return false;
      }
    }
    if (!best) return false;

    room.truckMania.aiActor = best.truck.id;
    if (best.spot === best.truck.spot) {
      room.truckMania.aiStealPlan = null;
      return false; // act in place
    }

    // Work tickets off en route: parking at a chore location clears its
    // tickets without ending the turn, so if one sits near the way to the
    // chosen target, stop there first — the act beat drives the second leg
    // (aiContinue) and acts at the real target as usual.
    if (best.kind === "move" && best.truck.spot != null && (player.tickets?.length ?? 0) > 0) {
      const here = spots[best.truck.spot];
      const dest = spots[best.spot];
      const occupied = new Set(
        room.truckMania.trucks.filter((t) => t.id !== best.truck.id).map((t) => t.spot)
      );
      const direct = Math.hypot(dest.x - here.x, dest.y - here.y);
      let via = null;
      spots.forEach((s, i) => {
        if (i === best.truck.spot || i === best.spot || occupied.has(i)) return;
        const b = buildingByBid(map, s.building);
        if (!b || b.role !== "ticket") return;
        const n = (player.tickets ?? []).filter((t) => t.loc === b.bid).length;
        if (!n) return;
        const detour = Math.hypot(s.x - here.x, s.y - here.y) +
          Math.hypot(dest.x - s.x, dest.y - s.y) - direct;
        // Each ticket cleared buys more willingness to swing by.
        if (detour > 150 + 150 * n) return;
        if (!via || n > via.n || (n === via.n && detour < via.detour)) via = { spot: i, n, detour };
      });
      if (via && aiDriveTruckTo(room, best.truck, player, via.spot)) {
        room.truckMania.aiContinue = best.spot;
        room.truckMania.aiStealPlan = null;
        return true;
      }
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
        .filter((p) => canCarryPkg(room, player, thief, p))
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
  // shared spot (returns true — the getaway needs to animate). For a chore
  // stopover, drive the second leg to the real target first. Then work every
  // usable building (the whole block with Free parking): unload first to free
  // capacity, then load the best packages available.
  function aiActPhase(room, idx) {
    if (room.truckMania.turnState?.skipped) return false; // sat out for the payout
    const actorId = room.truckMania.aiActor;
    const trucks = room.truckMania.trucks ?? [];
    const truck = trucks.find((t) => t.id === actorId && t.player === idx) ??
      trucks.find((t) => t.player === idx);
    const player = room.truckMania.players?.[idx];
    if (!truck || !player) return false;

    const plan = room.truckMania.aiStealPlan;
    const cont = room.truckMania.aiContinue;
    room.truckMania.aiContinue = null;
    let droveOn = false;
    if (plan && plan.thiefId === truck.id) {
      room.truckMania.aiStealPlan = null;
      aiStealFrom(room, truck, player, plan.victimId);
      // Stealing isn't turn-ending: drive off the shared spot, then fall
      // through and act at the landing spot like any other stop — deliver
      // the loot, even.
      droveOn = aiRelocate(room, truck, player);
      if (!droveOn) return false; // stuck sharing the spot — acting there is illegal
    } else if (cont != null && cont !== truck.spot) {
      // Second leg of a chore stopover: the move beat parked at a ticket
      // location (clearing it on arrival); drive on to the real target now
      // and act there. Returning true gives the drive time to animate.
      droveOn = aiDriveTruckTo(room, truck, player, cont);
    }

    const map = room.truckMania.map;

    // Ticket mode: spend money where it's parked. Mechanic — buy the best
    // affordable abilities; courthouse — pay off visible tickets (1st/2nd/3rd
    // each at their own price). Day only activities: skip when it's night.
    if (isTicket(room) && specialsOpen(room)) {
      const here = buildingAtTruck(room, truck);
      if (here?.role === "special" && here.special === "mechanic") {
        const costs = S(room).abilityCosts ?? {};
        for (let guard = 0; guard < ABILITY_CARDS.length; guard += 1) {
          const pick = AI_ABILITY_PREF.find((id) =>
            !abilityOwned(room, id) && !abilityBarred(room, id) &&
            Number.isInteger(costs[id]) && (player.money ?? 0) >= costs[id]);
          if (!pick) break;
          player.money -= costs[pick];
          player.abilities.push(pick);
          if (pick === "extra-truck") spawnExtraTruck(room, idx);
        }
      } else if (here?.role === "special" && here.special === "courthouse") {
        const ts = room.truckMania.turnState;
        const costs = S(room).courtCosts ?? [2, 3, 4];
        while ((ts.courtUses ?? 0) < 3 && (player.tickets?.length ?? 0) > 0) {
          const cost = costs[Math.min(ts.courtUses ?? 0, costs.length - 1)];
          if ((player.money ?? 0) < cost) break;
          player.money -= cost;
          player.tickets.shift();
          ts.courtUses = (ts.courtUses ?? 0) + 1;
        }
        checkTicketWin(room, idx); // paying off the last ticket can seal a win
      }
    }

    const buildings = usableBuildings(map, truck, player);
    for (const b of buildings) {
      if (b.role !== "dropoff") continue;
      for (let guard = 0; guard < 12; guard += 1) {
        // Skip timed circles the clock doesn't allow yet, so one blocked
        // package can't stop a deliverable one behind it.
        const pkg = (truck.cargo ?? [])
          .find((p) => p.color === b.dropoffColor && timedDropoffOk(room, p));
        if (!pkg || !tryDropoff(room, truck, pkg.id)) break;
      }
    }
    for (const b of buildings) {
      if (b.role !== "pickup") continue;
      for (let guard = 0; guard < 12; guard += 1) {
        if (truck.cargo.length >= colValue(room, player, "capacity")) break;
        const pkgs = (b.packages ?? [])
          .filter((p) => canCarryPkg(room, player, truck, p) && colorDeliverable(map, p.color))
          .sort((a, c) => deliveryValue(room, player, c.color, c.shape) - deliveryValue(room, player, a.color, a.shape));
        if (!pkgs.length || !tryPickup(room, truck, pkgs[0].id)) break;
      }
    }
    return droveOn;
  }

  // Resolve any card drafts the AI has queued from deliveries: unlock a useful
  // location letter, or take the higher-ranked of the two shown abilities. Keeps
  // the decks in sync the same way a human draft does.
  function aiResolveDrafts(room, idx) {
    if (isTicket(room)) return; // no card decks in ticket mode
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
      // New rooms open on the most recently saved tuning and its attached map
      // (the latest saved map when the version says NONE); only when nothing
      // is saved do the ticket defaults and a fresh generation kick in.
      const latest = savedSettings[savedSettings.length - 1];
      const settings = cloneSettings(latest?.settings ?? DEFAULT_TICKET_SETTINGS);
      const lastMap = savedMaps.find((m) => m.id === latest?.mapId) ?? savedMaps[savedMaps.length - 1];
      const map = lastMap ? hydrate(lastMap.map) : generateCityMap(Date.now(), genOpts(settings));
      const state = {
        truckMania: { map, time: START_TIME, trucks: [], settings }
      };
      setupBoard(state);
      return state;
    },

    // createRoomState deals before the lobby has filled the seats, so a
    // two-human room starts dealt for one. Re-deal once the player list is
    // known so every human gets a truck (and the AI count fits the free seats).
    onRoomCreated(roomId, room) {
      if (humanCount(room) > 1) setupBoard(room);
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
      // room — the board re-deals under the new numbers. `mapId` attaches a
      // saved map to the version (null/unknown = NONE), and the attached map
      // is seated right away, same as a later load would.
      socket.on("truck_mania_save_settings", ({ roomId, name, settings, mapId } = {}) => {
        if (!savingEnabled) return;
        const room = playerRoom(socket, roomId);
        if (!room) return;
        const clean = sanitizeSettings(settings);
        if (!clean) {
          // Never fail silently — the usual cause is a stale tab whose editor
          // predates the current rules.
          socket.emit("truck_mania_settings_error", {
            message: "The server rejected these settings — the numbers don't line up with the current rules. If this keeps happening, reload the page."
          });
          return;
        }
        const entry = {
          id: `s${Date.now()}${Math.floor(Math.random() * 1000)}`,
          name: String(name || "Untitled").slice(0, 40),
          mapId: savedMaps.find((m) => m.id === mapId)?.id ?? null,
          settings: clean
        };
        savedSettings.push(entry);
        persistSavedSettings(savedSettings);
        clearAiTimer(roomId);
        applySettingsToRoom(room, clean, entry.mapId);
        emitState(roomId, room);
        io.to(roomId).emit("truck_mania_settings", settingsPayload());
      });

      // Apply a saved settings version to this room (re-deals). The version's
      // attached map (when it names one) comes with it.
      socket.on("truck_mania_load_settings", ({ roomId, settingsId } = {}) => {
        const room = playerRoom(socket, roomId);
        if (!room) return;
        const entry = savedSettings.find((s) => s.id === settingsId);
        if (!entry) return;
        clearAiTimer(roomId);
        applySettingsToRoom(room, entry.settings, entry.mapId);
        emitState(roomId, room);
      });

      socket.on("truck_mania_regenerate", ({ roomId } = {}) => {
        const room = playerRoom(socket, roomId);
        if (!room) return;
        clearAiTimer(roomId);
        room.truckMania.map = generateCityMap(Date.now(), genOpts(S(room)));
        setupBoard(room);
        emitState(roomId, room);
      });

      socket.on("truck_mania_mix_up", ({ roomId } = {}) => {
        const room = playerRoom(socket, roomId);
        if (!room) return;
        const map = room.truckMania.map;
        map.intersections = randomizeOctagons(map.intersections);
        if (isTicket(room)) {
          const bl = S(room).blankLights ?? {};
          setBlankLights(map.intersections, bl.green ?? 5, bl.red ?? 5);
        }
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

      // Manage the saved-map list (local runs only, same as saving). Deleting
      // a map that's currently on the table doesn't disturb the match — rooms
      // play on their own hydrated copy.
      socket.on("truck_mania_delete_map", ({ roomId, mapId } = {}) => {
        if (!savingEnabled) return;
        if (!playerRoom(socket, roomId)) return;
        const i = savedMaps.findIndex((m) => m.id === mapId);
        if (i === -1) return;
        savedMaps.splice(i, 1);
        persistSavedMaps(savedMaps);
        io.to(roomId).emit("truck_mania_maps", mapsPayload());
      });

      socket.on("truck_mania_rename_map", ({ roomId, mapId, name } = {}) => {
        if (!savingEnabled) return;
        if (!playerRoom(socket, roomId)) return;
        const entry = savedMaps.find((m) => m.id === mapId);
        const clean = String(name ?? "").trim().slice(0, 40);
        if (!entry || !clean) return;
        entry.name = clean;
        persistSavedMaps(savedMaps);
        io.to(roomId).emit("truck_mania_maps", mapsPayload());
      });

      // Same management for saved settings. Presets aren't in savedSettings,
      // so they can't be renamed or deleted.
      socket.on("truck_mania_delete_settings", ({ roomId, settingsId } = {}) => {
        if (!savingEnabled) return;
        if (!playerRoom(socket, roomId)) return;
        const i = savedSettings.findIndex((s) => s.id === settingsId);
        if (i === -1) return;
        savedSettings.splice(i, 1);
        persistSavedSettings(savedSettings);
        io.to(roomId).emit("truck_mania_settings", settingsPayload());
      });

      socket.on("truck_mania_rename_settings", ({ roomId, settingsId, name } = {}) => {
        if (!savingEnabled) return;
        if (!playerRoom(socket, roomId)) return;
        const entry = savedSettings.find((s) => s.id === settingsId);
        const clean = String(name ?? "").trim().slice(0, 40);
        if (!entry || !clean) return;
        entry.name = clean;
        persistSavedSettings(savedSettings);
        io.to(roomId).emit("truck_mania_settings", settingsPayload());
      });

      // Drive one of the player's trucks to a new spot. Only on their turn,
      // and only before it has acted (a pickup/delivery ends movement). Moving
      // onto another truck's spot is allowed — that's how a steal is set up. The
      // client routes and reports how many red lights the path crosses; each red
      // rolls a ticket die.
      socket.on("truck_mania_move_truck", ({ roomId, truckId = 0, spot, reds } = {}) => {
        const room = playerRoom(socket, roomId);
        if (!room) return;
        const seat = seatOf(room, socket);
        if (room.truckMania.turn !== seat || room.truckMania.turnState.acted) return;
        if (startPickPending(room, seat)) return;
        const truck = humanTruck(room, seat, truckId);
        const spotCount = room.truckMania.map.spots?.length ?? 0;
        if (!truck || !Number.isInteger(spot) || spot < 0 || spot >= spotCount) return;
        if (truck.spot === spot) return;

        // A spot can hold only one truck. You may drive onto an occupied spot
        // only to steal: night (or Day theft), higher aggression, not already
        // robbed this turn. (Your own other truck can't be robbed, so it blocks.)
        const occupant = (room.truckMania.trucks ?? []).find((t) => t.id !== truck.id && t.spot === spot);
        if (occupant) {
          const ts = room.truckMania.turnState;
          const meP = room.truckMania.players?.[seat];
          const occP = room.truckMania.players?.[occupant.player];
          const canRob = !ts.stolen && (isNight(room.truckMania.time) || hasAbility(meP, "day-theft")) &&
            meP && occP &&
            colValue(room, meP, "agression") > colValue(room, occP, "agression");
          if (!canRob) return;
        }

        const ts = room.truckMania.turnState;
        // One-step undo (ticket mode): snapshot everything this move changes —
        // spot, facing, the turn's truck lock, banked dice, and the tickets as
        // they stand (arriving at a chore location clears matching ones, and
        // an undo has to bring those back).
        ts.undo = isTicket(room) ? {
          kind: "move",
          truckId: truck.id,
          prevSpot: truck.spot,
          prevFacing: truck.facing ?? 0,
          prevTurnTruck: ts.truck ?? null,
          prevDicePool: ts.dicePool ?? 0,
          prevTickets: (room.truckMania.players?.[seat]?.tickets ?? []).map((t) => ({ ...t }))
        } : null;
        ts.truck = truck.id;
        ts.pickups = []; // driving away forfeits put-backs
        applyMove(room, truck, spot, reds);
        emitState(roomId, room);
      });

      // Load a package onto the player's truck. Normally ends the turn's
      // movement; Drive-by pickup exempts every pickup at one building per
      // turn. Blocked while sharing a spot.
      socket.on("truck_mania_pickup", ({ roomId, truckId = 0, packageId } = {}) => {
        const room = playerRoom(socket, roomId);
        const seat = room ? seatOf(room, socket) : -1;
        if (!room || room.truckMania.turn !== seat || room.truckMania.winner != null) return;
        if (startPickPending(room, seat)) return;
        const truck = humanTruck(room, seat, truckId);
        if (!truck || sharesSpot(room, truck)) return;
        const building = tryPickup(room, truck, packageId);
        if (building) {
          const ts = room.truckMania.turnState;
          ts.truck = truck.id;
          // Drive-by pickup: any number of pickups at ONE building per turn
          // stay free — the first drive-by locks in the building; picking up
          // anywhere else ends movement as usual. (Keep going bars drive-bys.)
          const driveBy = !keepGoingOn(room) &&
            hasAbility(room.truckMania.players?.[seat], "drive-by-pickup") &&
            (ts.driveByPickupBid == null || ts.driveByPickupBid === building.bid);
          if (driveBy) ts.driveByPickupBid = building.bid;
          else ts.acted = true;
          ts.pickups.push({ pkg: packageId, bid: building.bid, drive: driveBy });
          ts.undo = null; // the location is used — the move can't come back
          emitState(roomId, room);
        }
      });

      // Put a package picked up this turn back onto the building it came from.
      // Only while still parked there — regret, not remote returns. Restores
      // whatever the pickup consumed (the drive-by, or the movement lock).
      socket.on("truck_mania_putback", ({ roomId, truckId = 0, packageId } = {}) => {
        const room = playerRoom(socket, roomId);
        const seat = room ? seatOf(room, socket) : -1;
        if (!room || room.truckMania.turn !== seat || room.truckMania.winner != null) return;
        const truck = humanTruck(room, seat, truckId);
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
        if (entry.drive) {
          // Regretting the last drive-by pickup frees the ability to lock a
          // different building this turn.
          if (!ts.pickups.some((e) => e.drive)) ts.driveByPickupBid = null;
        } else {
          ts.acted = ts.pickups.some((e) => !e.drive) || ts.actedByDrop;
        }
        emitState(roomId, room);
      });

      // Drop off a package from the player's truck at a matching dropoff.
      // Drive-by dropoff exempts every dropoff at one building per turn.
      socket.on("truck_mania_dropoff", ({ roomId, truckId = 0, packageId } = {}) => {
        const room = playerRoom(socket, roomId);
        const seat = room ? seatOf(room, socket) : -1;
        if (!room || room.truckMania.turn !== seat || room.truckMania.winner != null) return;
        if (startPickPending(room, seat)) return;
        const truck = humanTruck(room, seat, truckId);
        if (!truck || sharesSpot(room, truck)) return;
        const dropBuilding = tryDropoff(room, truck, packageId);
        if (dropBuilding) {
          const ts = room.truckMania.turnState;
          ts.truck = truck.id;
          // Drive-by dropoff: any number of dropoffs at ONE building per turn
          // stay free — the first drive-by locks in the building. (Keep going
          // bars drive-bys.)
          const driveBy = !keepGoingOn(room) &&
            hasAbility(room.truckMania.players?.[seat], "drive-by-dropoff") &&
            (ts.driveByDropoffBid == null || ts.driveByDropoffBid === dropBuilding.bid);
          if (driveBy) ts.driveByDropoffBid = dropBuilding.bid;
          else {
            ts.acted = true;
            ts.actedByDrop = true;
          }
          // A delivered package can't come back.
          const li = ts.pickups.findIndex((e) => e.pkg === packageId);
          if (li !== -1) ts.pickups.splice(li, 1);
          ts.undo = null; // the location is used — the move can't come back
          emitState(roomId, room);
        }
      });

      // End the player's turn. Blocked while any of the player's trucks shares a
      // spot with another truck — you can't end on the same space as another.
      // Ticket mode rolls the turn's banked dice here.
      socket.on("truck_mania_end_turn", ({ roomId } = {}) => {
        const room = playerRoom(socket, roomId);
        const seat = room ? seatOf(room, socket) : -1;
        if (!room || room.truckMania.turn !== seat || room.truckMania.winner != null) return;
        if (startPickPending(room, seat)) return;
        const mine = (room.truckMania.trucks ?? []).filter((t) => t.player === seat);
        if (mine.some((t) => sharesSpot(room, t))) return;
        const rollMs = rollTicketDice(room, seat);
        advanceTurn(roomId, rollMs);
      });

      // Free rules: the turn-opening pick — time stones or money at the
      // player's current column values. Must land before anything else the
      // turn could do (the other handlers check startPickPending).
      socket.on("truck_mania_start_pick", ({ roomId, choice } = {}) => {
        const room = playerRoom(socket, roomId);
        const seat = room ? seatOf(room, socket) : -1;
        if (!room || room.truckMania.turn !== seat || room.truckMania.winner != null) return;
        if (!isFree(room)) return;
        const ts = room.truckMania.turnState;
        if (ts.startChoice) return;
        const player = room.truckMania.players?.[seat];
        if (!player || !["stones", "money"].includes(choice)) return;
        if (choice === "stones") player.timeStones += colValue(room, player, "timestones");
        else player.money = (player.money ?? 0) + colValue(room, player, "money");
        ts.startChoice = choice;
        emitState(roomId, room);
      });

      // Keep going (when the option is on): after movement has ended at a
      // terminal stop, pay `keepGoingCost` time stones to reopen movement —
      // and another clock change — for the same truck this turn. Repeatable.
      socket.on("truck_mania_keep_going", ({ roomId } = {}) => {
        const room = playerRoom(socket, roomId);
        const seat = room ? seatOf(room, socket) : -1;
        if (!room || room.truckMania.turn !== seat || room.truckMania.winner != null) return;
        if (!keepGoingOn(room)) return;
        if (startPickPending(room, seat)) return;
        const ts = room.truckMania.turnState;
        if (!ts.acted) return;
        const player = room.truckMania.players?.[seat];
        const cost = S(room).keepGoingCost ?? 3;
        if (!player || (player.timeStones ?? 0) < cost) return;
        player.timeStones -= cost;
        ts.acted = false;
        ts.actedByDrop = false;
        ts.pickups = []; // put-back rights don't survive the payment
        ts.changedTime = false; // the clock opens up again too
        ts.keptGoing = true;
        ts.undo = null; // the paid-for continuation commits everything before it
        emitState(roomId, room);
      });

      // One-step undo (ticket mode): take back the turn's latest revocable
      // action. A move — the truck returns to where it started (off the board
      // again for an undone entry), banked dice un-bank, and tickets cleared
      // on arrival come back (working a chore off doesn't count as "using" a
      // location). Or a time change — the hand sweeps back, the flipped lights
      // flip again, and the stones are refunded. Using the location (pickup,
      // dropoff, steal, special) or paying to keep going clears it.
      socket.on("truck_mania_undo", ({ roomId } = {}) => {
        const room = playerRoom(socket, roomId);
        const seat = room ? seatOf(room, socket) : -1;
        if (!room || room.truckMania.turn !== seat || room.truckMania.winner != null) return;
        if (!isTicket(room)) return;
        const ts = room.truckMania.turnState;
        const undo = ts.undo;
        const player = room.truckMania.players?.[seat];
        if (!undo || !player) return;
        if (undo.kind === "move") {
          if (ts.acted || ts.stolen) return; // belt & braces — both clear the undo
          const truck = (room.truckMania.trucks ?? [])
            .find((t) => t.id === undo.truckId && t.player === seat);
          if (!truck) return;
          truck.spot = undo.prevSpot; // null puts an undone entry back off-board
          truck.facing = undo.prevFacing;
          ts.truck = undo.prevTurnTruck;
          ts.dicePool = undo.prevDicePool;
          if (Array.isArray(undo.prevTickets)) player.tickets = undo.prevTickets;
          room.truckMania.lastRoll = null;
        } else if (undo.kind === "time") {
          room.truckMania.time = undo.prevTime;
          player.timeStones += undo.cost;
          for (const oct of room.truckMania.map.intersections) {
            if (oct.number === undo.hour) oct.color = oct.color === "green" ? "red" : "green";
          }
          ts.changedTime = false;
        }
        ts.undo = null;
        emitState(roomId, room);
      });

      // Skip the turn for the payout (ticket mode): allowed only while nothing
      // has been done yet — no move, no pickup/dropoff/steal, no special-
      // building use. A clock change doesn't disqualify it. Pays the time-
      // stone + money column values, then ends the turn like end_turn would
      // (face-down tickets still flip up).
      socket.on("truck_mania_skip_turn", ({ roomId } = {}) => {
        const room = playerRoom(socket, roomId);
        const seat = room ? seatOf(room, socket) : -1;
        if (!room || room.truckMania.turn !== seat || room.truckMania.winner != null) return;
        if (!isTicket(room)) return;
        if (startPickPending(room, seat)) return;
        const ts = room.truckMania.turnState;
        if (ts.truck != null || ts.stolen || ts.acted) return;
        const mine = (room.truckMania.trucks ?? []).filter((t) => t.player === seat);
        if (mine.some((t) => sharesSpot(room, t))) return;
        const player = room.truckMania.players?.[seat];
        if (player) paySkip(room, player);
        ts.skipped = true;
        const rollMs = rollTicketDice(room, seat);
        advanceTurn(roomId, rollMs);
      });

      // ---- Ticket-mode special locations (all end the turn's movement) ----

      // The player's truck parked (alone) at a given special building, or null.
      const specialTruck = (room, seat, truckId, kind) => {
        if (!isTicket(room) || room.truckMania.turn !== seat || room.truckMania.winner != null) return null;
        if (startPickPending(room, seat)) return null;
        if (!specialsOpen(room)) return null; // Day only activities: shut at night
        const truck = humanTruck(room, seat, truckId);
        if (!truck || sharesSpot(room, truck)) return null;
        const b = buildingAtTruck(room, truck);
        return b && b.role === "special" && b.special === kind ? truck : null;
      };
      const endMovementAt = (room, truck) => {
        const ts = room.truckMania.turnState;
        ts.truck = truck.id;
        ts.acted = true;
        ts.actedByDrop = true; // can't be reopened by put-backs
        ts.undo = null; // the location is used — nothing to take back now
      };

      // Mechanic: buy any unowned ability for its configured price. Buy as
      // many in one stop as the money allows.
      socket.on("truck_mania_buy_ability", ({ roomId, truckId = 0, ability } = {}) => {
        const room = playerRoom(socket, roomId);
        if (!room) return;
        const seat = seatOf(room, socket);
        const truck = specialTruck(room, seat, truckId, "mechanic");
        const player = room.truckMania.players?.[seat];
        if (!truck || !player) return;
        // Each ability is a single card: once anyone owns it, it's off the
        // shelf for everyone else. Drive-bys leave the game under Keep going.
        if (!ABILITY_CARDS.includes(ability) || abilityOwned(room, ability)) return;
        if (abilityBarred(room, ability)) return;
        const cost = S(room).abilityCosts?.[ability];
        if (!Number.isInteger(cost) || (player.money ?? 0) < cost) return;
        player.money -= cost;
        player.abilities.push(ability);
        if (ability === "extra-truck") spawnExtraTruck(room, seat);
        endMovementAt(room, truck);
        emitState(roomId, room);
      });

      // Pawn shop: pay to move one upgrade step from one column to another.
      // The 1st/2nd/3rd conversion in a turn each has its own price.
      socket.on("truck_mania_pawn", ({ roomId, truckId = 0, from, to } = {}) => {
        const room = playerRoom(socket, roomId);
        if (!room) return;
        const seat = seatOf(room, socket);
        const truck = specialTruck(room, seat, truckId, "pawnshop");
        const player = room.truckMania.players?.[seat];
        if (!truck || !player) return;
        const ts = room.truckMania.turnState;
        const uses = ts.pawnUses ?? 0;
        if (uses >= 3) return;
        const tracks = tracksFor(room);
        if (!tracks.includes(from) || !tracks.includes(to) || from === to) return;
        const costs = S(room).pawnCosts ?? [2, 3, 4];
        const cost = costs[Math.min(uses, costs.length - 1)];
        if ((player.money ?? 0) < cost) return;
        if ((player.columns[from] ?? 0) < 1) return;
        if ((player.columns[to] ?? 0) >= maxLevel(room, to)) return;
        player.money -= cost;
        player.columns[from] -= 1;
        player.columns[to] += 1;
        ts.pawnUses = uses + 1;
        endMovementAt(room, truck);
        checkTicketWin(room, seat);
        emitState(roomId, room);
      });

      // Courthouse: pay to tear up a visible ticket. The 1st/2nd/3rd removal
      // in a turn each has its own price. Face-down tickets can't be paid off.
      socket.on("truck_mania_pay_ticket", ({ roomId, truckId = 0, ticketId } = {}) => {
        const room = playerRoom(socket, roomId);
        if (!room) return;
        const seat = seatOf(room, socket);
        const truck = specialTruck(room, seat, truckId, "courthouse");
        const player = room.truckMania.players?.[seat];
        if (!truck || !player) return;
        const ts = room.truckMania.turnState;
        const uses = ts.courtUses ?? 0;
        if (uses >= 3) return;
        const costs = S(room).courtCosts ?? [2, 3, 4];
        const cost = costs[Math.min(uses, costs.length - 1)];
        if ((player.money ?? 0) < cost) return;
        const i = (player.tickets ?? []).findIndex((t) => t.id === ticketId);
        if (i === -1) return;
        player.money -= cost;
        player.tickets.splice(i, 1); // the freed slot stays empty until turn end
        ts.courtUses = uses + 1;
        endMovementAt(room, truck);
        checkTicketWin(room, seat); // paying off the last ticket can seal a win
        emitState(roomId, room);
      });

      // Cash a fragile-delivery bonus (fragility rule set): the player picks
      // time stones or money from the oldest offer in their queue. Allowed at
      // any time — the amounts were snapshotted when the delivery happened.
      socket.on("truck_mania_fragile_bonus", ({ roomId, choice } = {}) => {
        const room = playerRoom(socket, roomId);
        if (!room) return;
        const idx = room.players.indexOf(socket.id);
        const players = room.truckMania.players ?? [];
        const player = players[idx] ?? players[0];
        if (!player?.pendingFragile?.length || !["stones", "money"].includes(choice)) return;
        const bonus = player.pendingFragile.shift();
        if (choice === "stones") player.timeStones += bonus.stones ?? 0;
        else player.money = (player.money ?? 0) + (bonus.money ?? 0);
        emitState(roomId, room);
      });

      // Resolve a queued location pick (Choosing rule): the player clicks a
      // still-locked protected location on the board to unlock its letter.
      // Allowed at any time, like the fragile bonus — the pick was earned when
      // the letters column stepped onto a 1.
      socket.on("truck_mania_pick_location", ({ roomId, letter } = {}) => {
        const room = playerRoom(socket, roomId);
        if (!room || !isChoosing(room)) return;
        const idx = room.players.indexOf(socket.id);
        const players = room.truckMania.players ?? [];
        const player = players[idx] ?? players[0];
        if (!player || (player.pendingPicks ?? 0) <= 0) return;
        if (!settingsLetters(S(room)).includes(letter)) return;
        if (player.locations.includes(letter)) return;
        player.locations.push(letter);
        player.pendingPicks -= 1;
        emitState(roomId, room);
      });

      // The rule dials (Suspension, Variety/Fragility/Free, Keep going) live
      // in the tuning panel now — they're part of each saved settings version
      // and arrive via truck_mania_save_settings / truck_mania_load_settings.

      // Switch between point mode (classic), ticket mode, and suspension mode
      // (tickets + the face-down-tickets-ground-you rule): applies the most
      // recently saved settings of that mode (that mode's defaults when none
      // are saved) and generates a fitting map. Tickets ⇄ Suspension share a
      // board, so that switch just flips the rule without re-dealing.
      socket.on("truck_mania_set_mode", ({ roomId, mode } = {}) => {
        const room = playerRoom(socket, roomId);
        if (!room || !["points", "tickets", "suspension"].includes(mode)) return;
        const base = mode === "points" ? "points" : "tickets";
        const wantSuspension = mode === "suspension";
        if (modeOf(S(room)) === base) {
          if (base === "points" || !!S(room).suspension === wantSuspension) return;
          room.truckMania.settings = { ...cloneSettings(S(room)), suspension: wantSuspension };
          emitState(roomId, room);
          return;
        }
        clearAiTimer(roomId);
        const latest = [...savedSettings].reverse().find((e) => modeOf(e.settings) === base);
        const settings = cloneSettings(
          latest?.settings ?? (base === "tickets" ? DEFAULT_TICKET_SETTINGS : DEFAULT_SETTINGS)
        );
        if (base === "tickets") settings.suspension = wantSuspension;
        room.truckMania.settings = settings;
        room.truckMania.map = generateCityMap(Date.now(), genOpts(S(room)));
        setupBoard(room);
        emitState(roomId, room);
      });

      // Move the clock hand to a face hour, swapping the colors of the two
      // octagons carrying that number (green <-> red) and advancing the time of
      // day. The hand normally sweeps clockwise (one stone per hour, AM/PM flips
      // as it passes 12); Reverse-time lets a player take the cheaper spin. Only
      // on the acting player's own turn.
      socket.on("truck_mania_set_hour", ({ roomId, hour } = {}) => {
        const room = playerRoom(socket, roomId);
        const seat = room ? seatOf(room, socket) : -1;
        if (!room || room.truckMania.turn !== seat || room.truckMania.winner != null) return;
        if (startPickPending(room, seat)) return; // Free: pick first, clock after
        if (!Number.isInteger(hour) || hour < 1 || hour > 12) return;

        const t = room.truckMania.time ?? START_TIME;
        const curPos = t % 12;
        const targetPos = hour % 12; // 12 -> 0
        if (targetPos === curPos) return; // hand already there

        const player = room.truckMania.players?.[seat];
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
        // One-step undo (ticket mode): the change can be taken back — hand,
        // lights and stones — until anything else happens.
        ts.undo = isTicket(room) ? { kind: "time", prevTime: t, hour, cost } : null;
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
        const seat = room ? seatOf(room, socket) : -1;
        if (!room || room.truckMania.turn !== seat || room.truckMania.winner != null) return;
        if (startPickPending(room, seat)) return;
        const ts = room.truckMania.turnState;
        if (ts.acted) return;
        if (ts.stolen && ts.stealVictim !== victimTruckId) return; // one victim per turn
        const trucks = room.truckMania.trucks ?? [];
        const thief = humanTruck(room, seat, truckId);
        const victim = trucks.find((t) => t.id === victimTruckId);
        if (!thief || !victim || victim.id === thief.id) return;
        if (thief.spot == null || thief.spot !== victim.spot) return;
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
        if (!canLoadPkg(room, thiefP, thief, pkg)) return;
        victim.cargo.splice(idx, 1);
        thief.cargo.push(pkg);
        ts.stolen = true;
        ts.stealVictim = victimTruckId;
        ts.truck = thief.id;
        ts.undo = null; // robbing commits the move that set it up
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

      // Choose how many AI opponents (0 up to the free seats: 3 solo, 2 with
      // two humans). Re-deals the board (fresh turn back to the first human)
      // with that many trucks. Bumps the seed so the client fully rebuilds
      // (new truck set).
      socket.on("truck_mania_set_opponents", ({ roomId, count } = {}) => {
        const room = playerRoom(socket, roomId);
        if (!room) return;
        clearAiTimer(roomId);
        const n = Math.max(0, Math.min(maxAiFor(room), Number(count) | 0));
        room.truckMania.aiCount = n;
        setupBoard(room);
        room.truckMania.map.seed = `${room.truckMania.map.seed}-o${n}-${Date.now()}`;
        emitState(roomId, room);
      });
    }
  };
}
