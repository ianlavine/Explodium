// Uber Mania — the Traffic Time game about picking up passengers.
//
// The map, clock, routes, cars and dice all reuse Truck Mania's tm- styles and
// its board language: generated streets, numbered stop signs, a die banked per
// red light crossed. Everything with a ub- class is this game's own — the six
// district zones, the passenger board, the two tile piles, the errand corners
// and the star rating column.
//
// The rules, in one breath: six districts, one per player color, and the one
// matching your car is home. Take a passenger tile (a whole turn) and it lands
// on the lowest free number of your passenger board — 2, 3, 4, 5, with a bare 6
// that nothing covers. Drive them there to finish the ride. At the end of a
// turn every red light you ran throws a die, and a die is only safe if its face
// is still SHOWING on your board, so a full car is a dangerous car; each miss
// is half a star. Six errands wait, one in every district, each collectable
// only during that district's own section of the day.
//
// STATIC MODE is the same city with the dice taken out. The board becomes a
// four-deep QUEUE — deliver the far-left fare for a star, or reach over people
// and pay half a star a head — a red light is a flat whole star, there are three
// piles gated by your rating instead of two, and passengers come in three kinds
// (chill pays stones, tip pays points at the end, rush forgives one red). No
// errands, no home district. `mode` in the settings decides which one is live.
import { socket, els, app } from "../../shared/context.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const GREEN = "#3d9a5f";
const RED = "#cf4a3c";
const OCT_RADIUS = 13;
const CAR_SCALE = 1.35;
const CAR_SPEED = 200; // px per second — keep in sync with the server

// The passenger board. Squares over 2–5, a bare 6 that no tile can cover.
// (Server: BOARD_NUMBERS / FREE_NUMBER — keep in sync.)
const BOARD_NUMBERS = [2, 3, 4, 5];
const FREE_NUMBER = 6;
const MAX_PASSENGERS = BOARD_NUMBERS.length;
const RATING_MAX = 5;
// One seat per district — a player's color IS their home. (Server: MAX_SEATS.)
const MAX_SEATS = 6;

// A tile's symbol: what its back promises. Dice mode has two kinds, static mode
// three. (Server: TILE_BONUSES / STATIC_TYPES — keep in sync.)
// 🪙 is a SILVER coin at this size and reads as a grey blob on a colored tile;
// the money bag is the one that still says "money" at 30px.
const BONUS_ICON = { stones: "⬟", star: "⭐", chill: "⬟", tip: "💰", rush: "😡" };
const BONUS_TEXT = {
  stones: "4 time stones the moment you take it",
  star: "a whole star when you finish the ride",
  chill: "6 time stones the moment you take them",
  tip: "worth your final rating in points, once delivered",
  rush: "one red light free on the turn you drop them off"
};
const BONUS_NAME = { chill: "Chill", tip: "Tip", rush: "Rush" };

// The queue modes' board: four seats, and three slots that want 0, 2 and 4
// stars before they'll deal. (Server: STATIC_SLOTS / STATIC_PILE_RATING.)
const STATIC_SLOTS = 4;
const PRIORITY_STAR = 0.5; // only the fallback now — the table sets this
const SKIP_STAR_STEP = 0.5;
const RED_STAR_COST = 1;

// The three sections of the day. (Server: sectionOf — keep in sync.)
const SECTION_META = {
  morning: { name: "Morning", label: "1–8am", icon: "🌅" },
  work: { name: "Work", label: "9am–4pm", icon: "🏢" },
  evening: { name: "Evening", label: "5pm–midnight", icon: "🌆" }
};
const sectionOf = (t) => (t >= 1 && t <= 8 ? "morning" : t >= 9 && t <= 16 ? "work" : "evening");

// What gets stamped on a WAITING-mode errand token. These are read at about
// 14px on top of a colored disc, so they have to be single high-contrast
// shapes — SECTION_META's landscapes turn to mush at that size.
const SECTION_TOKEN = { morning: "☀️", work: "💼", evening: "🌙" };

// The three rulesets, in the order the Mode button walks through them.
// (Server: MODES — keep in sync.)
const MODES = ["dice", "static", "waiting"];
const MODE_NAME = { dice: "Dice", static: "Static", waiting: "Waiting" };
const MODE_BLURB = {
  dice: "Dice: passengers sit on numbered squares, and every red light you run throws a die against the numbers still showing.",
  static: "Static: no dice. Four passengers in a queue — deliver the left-hand one for a star, or pay half a star per head you reach over. Every red is a whole star.",
  waiting: "Waiting: you cannot pass a red at all — you stop and sit on it, and drive through on a later turn. A rushing fare buys you one red, but only on the way to them. Dropping somebody off ends the drive. Errands are back — one in every district — and the set pays 2, 5, 8, 11, 15, 20."
};

// Waiting mode's pickup slots: how many fares are on offer, and the rating each
// one asks for. The table sets both. (Server: slotGates / normalizeGates.)
const MIN_SLOTS = 2;
const MAX_SLOTS = 3;
const MAX_GATE = 5;
const DEFAULT_SLOT_GATES = [0, 2, 4];

// Half stars want one decimal, whole ones none.
const num = (v) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10));

// Is this hex color dark enough that text on it should go light?
function isDarkColor(hex) {
  const n = parseInt(String(hex).slice(1), 16);
  if (!Number.isFinite(n)) return false;
  return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) < 140;
}

// A darker shade of a hex color, for location outlines.
function darken(hex, f = 0.62) {
  const n = parseInt(String(hex).slice(1), 16);
  if (!Number.isFinite(n)) return hex;
  return `rgb(${Math.round(((n >> 16) & 255) * f)}, ${Math.round(((n >> 8) & 255) * f)}, ${Math.round((n & 255) * f)})`;
}

// A lighter tint of a hex color (mixed toward white), for location fills.
function lighten(hex, f = 0.6) {
  const n = parseInt(String(hex).slice(1), 16);
  if (!Number.isFinite(n)) return hex;
  const mix = (c) => Math.round(c + (255 - c) * f);
  return `rgb(${mix((n >> 16) & 255)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
}

// THE district look, in one place. A location's lot is a wash of its district's
// color inside a strong border of it, and a passenger tile is painted the same
// way — a tile back has to read as the same color as the streets it sends you
// to, so both go through here rather than each picking their own shade.
const lotFill = (hex) => lighten(hex, 0.5);
const lotEdge = (hex) => darken(hex, 0.78);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let mapState = null;
let districtsState = [];
let hourState = null;
let octEls = [];
let dayNightEl = null;
let handEl = null;
let hoveredHour = null;
let flipping = false;

let carsState = [];
const carEls = {}; // truck id -> svg group
const carPos = {}; // id -> { x, y, angle }
const carSpots = {}; // id -> last spot index rendered
const carAnim = {}; // id -> rAF handle
const pendingRoutes = {}; // id -> { spot, path, endAngle } awaiting server echo
const carUndoPose = {}; // id -> where the car stood before its current drive
let previewState = null; // { truckId, spot, routes } awaiting the player's pick
let graphCache = null;

let lastRollSeq = -1;
let diceAnimating = false;
let deferredDrives = [];
let clockQueue = [];

let timeState = 1;
let sectionState = "morning";
let elapsedState = 0;
let turnWhose = 0;
let turnActed = false;
// The last drive left the turn open — it stopped somewhere ordinary — so this
// driver may pull away again. Only a red light or a completed drop-off/errand
// clears it. (Server: turnState.carryOn.)
let turnCarryOn = false;
let turnChangedTime = false;
let turnDrew = false;
let turnUndo = null;
let turnTruck = null;
let dicePoolState = 0;
// How the player picks a route: "build" walks it stop light by stop light,
// "auto" offers the cheapest one or two routes to a clicked parking spot. Local
// to this browser; an off-board car always builds its way in.
let moveMode = localStorage.getItem("ubMoveMode") === "auto" ? "auto" : "build";
let builder = null;
let lastTurnSeen = null;
let speedMult = 1;

let playersState = [];
let pilesState = [];
let modeState = "waiting";
let slotsState = MAX_PASSENGERS;
let deckLeftState = null; // waiting: tiles left in the shared deck
let preTimeState = true; // table rule: the clock must be set BEFORE you act
let multiMoveState = false; // table rule: not even a drop-off ends the drive
// Slot layout: "two-four" = three slots at 0/2/4 stars that slide down when one
// is taken; "three" = two slots at 0 and 3 that don't slide, each refilled where
// it stands.
let slotGatesState = DEFAULT_SLOT_GATES.slice();
let priorityStarState = PRIORITY_STAR; // what the front of the queue pays
let startStarsState = 2;               // what everyone opens on
let lastTollState = null; // static: the red-light bill for the turn just ended
let lastTollSeq = -1;
let lastRollState = null;
let funRollState = null;
let lastFunSeq = -1;
let winnerState = null;
let resultsState = null;
let resultsDismissed = false;
let settingsState = null;
let aiMoveState = null; // { truckId, path, endAngle } — an AI's drive to animate
let snapCarState = null; // { truckId, spot, facing } — a car to put back, no drive
let maxAiState = 5;

function isActive() {
  return app.currentGame?.id === "uber-mania";
}

function myIndex() {
  return app.myPlayerIndex ?? 0;
}

function myPlayer() {
  return playersState[myIndex()] ?? playersState[0];
}

function seatName(i) {
  return i === myIndex() ? "You" : playersState[i]?.name ?? "Opponent";
}

function isMyTurn() {
  return isActive() && turnWhose === myIndex();
}

function myCar() {
  return carsState.find((t) => t.player === myIndex()) ?? null;
}

function activeTruckId() {
  return myCar()?.id ?? 0;
}

function isOffBoard(car) {
  return !!car && car.spot == null && car.light == null;
}

// Where a car is standing, and the key that says whether it has MOVED. Waiting
// mode gives a car two kinds of place — a kerb or a stop light it's waiting at
// — so everything that used to compare `spot` compares this instead.
function carPlace(t) {
  if (!t || !mapState) return null;
  if (t.spot != null) {
    const s = mapState.spots?.[t.spot];
    return s ? { key: `s${t.spot}`, kind: "spot", x: s.x, y: s.y, angle: s.angle } : null;
  }
  if (t.light != null) {
    const o = mapState.intersections?.[t.light];
    if (!o) return null;
    const a = ((t.facing ?? 0) * Math.PI) / 180;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const w = mapState.width ?? 960;
    const h = mapState.height ?? 720;
    // The car queues up behind the sign ALONG ITS OWN HEADING, and nowhere
    // else: the across-the-street coordinate is the street's, so it is never
    // touched. (Nudging it was what slid a car waiting on a border street off
    // its own road and into the gardens beside it.)
    const inset = (v, hi) => v >= CAR_NOSE && v <= hi - CAR_NOSE;
    const onBoard = (d) =>
      (Math.abs(dx) < 0.01 || inset(o.x - dx * d, w)) &&
      (Math.abs(dy) < 0.01 || inset(o.y - dy * d, h));
    // At an EDGE light there is no road behind to queue on — the car drove in
    // from outside the board — so it takes the same distance PAST the sign
    // instead. Either way it sits on its own street with the number readable.
    const back = LIGHT_NOSE();
    const d = onBoard(back) ? back : -back;
    const slide = (v, dir, hi) =>
      (Math.abs(dir) < 0.01 ? v : Math.max(CAR_NOSE, Math.min(hi - CAR_NOSE, v)));
    return {
      key: `l${t.light}`, kind: "light", light: t.light,
      x: slide(o.x - dx * d, dx, w),
      y: slide(o.y - dy * d, dy, h),
      angle: t.facing ?? 0, cx: o.x, cy: o.y
    };
  }
  return null;
}

// Cut `back` px off the end of a path — a car stopping at a light stops with
// its nose there, not its middle.
function trimPathEnd(path, back) {
  if (!Array.isArray(path) || path.length < 2 || back <= 0) return path;
  const out = path.map((p) => p.slice());
  let left = back;
  while (out.length >= 2 && left > 0) {
    const a = out[out.length - 2];
    const b = out[out.length - 1];
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (seg > left) {
      const f = (seg - left) / seg;
      out[out.length - 1] = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
      return out;
    }
    left -= seg;
    out.pop();
  }
  return out.length >= 2 ? out : path;
}

// The right rail. Everything that isn't the map or the tray lives in it, in a
// fixed order, so each panel can redraw on its own without the others moving:
// settings, the driver chips, the rating column beside the clock, the dice.
function ensureRail() {
  let rail = els.gameBoard.querySelector(".ub-rail");
  if (!rail) {
    rail = document.createElement("div");
    rail.className = "ub-rail";
    ["controls", "scores", "meters", "dice", "tray"].forEach((slot) => {
      const el = document.createElement("div");
      el.className = `ub-rail-slot ub-rail-${slot}`;
      rail.appendChild(el);
    });
    els.gameBoard.appendChild(rail);
  }
  return rail;
}

const railSlot = (name) => ensureRail().querySelector(`.ub-rail-${name}`);

function districtOf(id) {
  return districtsState.find((d) => d.id === id) ?? null;
}

const isStatic = () => modeState === "static";
const isWaiting = () => modeState === "waiting";
// Static + waiting share the four-deep queue, the three kinds and the scoring.
const queueMode = () => modeState !== "dice";
// Dice + waiting share the errands.
const hasErrands = () => modeState !== "static";
// What a finished set of errands pays in waiting mode, indexed by how many you
// collected — the whole six is 20. (Server: ERRAND_LADDER.)
const ERRAND_LADDER = [0, 2, 5, 8, 11, 15, 20];
const errandLadder = (n) =>
  ERRAND_LADDER[Math.max(0, Math.min(ERRAND_LADDER.length - 1, n))];
const maxPassengers = () => slotsState || (queueMode() ? STATIC_SLOTS : MAX_PASSENGERS);

// Waiting mode parks cars ON the stop signs, so they have to be big enough to
// hold one. (The route graph doesn't care — this is purely how big it's drawn.)
const octRadius = () => (isWaiting() ? 19 : OCT_RADIUS);
// Roughly how far the car's nose reaches ahead of the point it's drawn at.
const CAR_NOSE = 20;
// How far behind the octagon's CENTRE a waiting car sits, measured BACK ALONG
// the heading it arrived on. The number needs about 9px of clear radius and the
// car's nose reaches CAR_NOSE ahead of its anchor, so anything past ~28 keeps
// the sign readable; sitting further back than it needs to only risks the car
// reaching behind a corner it just turned.
const LIGHT_NOSE = () => octRadius() + 14;

// Static mode: what delivering the fare in this slot does to your rating —
// a whole star for the one at the front, half a star off per head behind it.
function slotStarDelta(slot) {
  return slot === 0 ? priorityStarState : -slot * SKIP_STAR_STEP;
}

const starDeltaText = (d) => (d >= 0 ? `+${num(d)}★` : `−${num(-d)}★`);

const nextMode = () => MODES[(MODES.indexOf(modeState) + 1) % MODES.length];
const slotLabel = () => `Slots: ${slotGatesState.length}`;
// The count button just flips between the two sizes. Growing invents a gate for
// the new slot — two stars above the dearest, which keeps the row a ladder —
// and shrinking drops the dearest one. Gates live on the half-star grid, same
// as ratings do.
const nextSlotGates = () =>
  slotGatesState.length >= MAX_SLOTS
    ? slotGatesState.slice(0, MIN_SLOTS)
    : slotGatesState.concat(Math.min(MAX_GATE, (slotGatesState[slotGatesState.length - 1] ?? 0) + 2));
const SLOT_BLURB = () =>
  slotGatesState.length > MIN_SLOTS
    ? "Three fares on offer, and they're a river: take one and the ones above it slide down, so emptying the cheap slot is what feeds the dear ones.\n\nClick for two."
    : "Two fares on offer, and nothing slides — whichever you take is refilled where it stands and the other is left exactly as it was.\n\nClick for three.";
const emitSlotGates = (gates) => {
  if (!app.roomId) return;
  socket.emit("uber_mania_set_slot_gates", { roomId: app.roomId, gates });
};
// Delivering the front of the queue: half a star, or a whole one.
const nextTopFare = () => (priorityStarState === 1 ? 0.5 : 1);
const topFareLabel = () => `Top fare: ${priorityStarState === 1 ? "1★" : "½★"}`;
const TOP_FARE_BLURB = () =>
  `Delivering the fare at the FRONT of your queue is worth ${priorityStarState === 1 ? "a whole star" : "half a star"}. Reaching over anybody still costs half a star a head either way.\n\nClick for ${nextTopFare() === 1 ? "a whole star" : "half a star"}.`;

// The numbers still visible on a player's board (server sends them, but the
// tray recomputes locally so a hover preview can be honest).
function showingFor(player) {
  const covered = new Set((player?.passengers ?? []).map((t) => BOARD_NUMBERS[t.slot]));
  const out = BOARD_NUMBERS.filter((n) => !covered.has(n));
  out.push(FREE_NUMBER);
  return out;
}

// ---------------------------------------------------------------------------
// SVG + geometry helpers
// ---------------------------------------------------------------------------

function svgEl(name, attrs, parent) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  if (parent) parent.appendChild(el);
  return el;
}

function polygonToString(points) {
  return points.map(([x, y]) => `${x},${y}`).join(" ");
}

function r1(v) {
  return Math.round(v * 10) / 10;
}

function streetToPolyline(street) {
  if (street.kind === "line") {
    return [[street.x1, street.y1], [street.x2, street.y2]];
  }
  const pts = [];
  for (let s = 0; s <= 20; s += 1) {
    const t = s / 20;
    const u = 1 - t;
    pts.push([
      u * u * street.x0 + 2 * u * t * street.cx + t * t * street.x1,
      u * u * street.y0 + 2 * u * t * street.cy + t * t * street.y1
    ]);
  }
  return pts;
}

function projectToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq ? ((px - x1) * dx + (py - y1) * dy) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  const x = x1 + t * dx;
  const y = y1 + t * dy;
  return { x, y, dist: Math.hypot(px - x, py - y) };
}

function boardOutlinePath(width, height, rounded = {}) {
  const { tl = 0, tr = 0, br = 0, bl = 0 } = rounded;
  const d = [];
  d.push(`M ${tl} 0`);
  d.push(tr ? `L ${width - tr} 0 Q ${width} 0 ${width} ${tr}` : `L ${width} 0`);
  d.push(br ? `L ${width} ${height - br} Q ${width} ${height} ${width - br} ${height}` : `L ${width} ${height}`);
  d.push(bl ? `L ${bl} ${height} Q 0 ${height} 0 ${height - bl}` : `L 0 ${height}`);
  d.push(tl ? `L 0 ${tl} Q 0 0 ${tl} 0` : `L 0 0`);
  d.push("Z");
  return d.join(" ");
}

function dirBucket(dx, dy) {
  const deg = (((Math.atan2(dy, dx) * 180) / Math.PI + 180) % 180);
  return Math.round(deg / 15) % 12;
}

function segSegIntersection(a, b) {
  const rx = a[2] - a[0];
  const ry = a[3] - a[1];
  const sx = b[2] - b[0];
  const sy = b[3] - b[1];
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-9) return null;
  const qx = b[0] - a[0];
  const qy = b[1] - a[1];
  const t = (qx * sy - qy * sx) / denom;
  const u = (qx * ry - qy * rx) / denom;
  const eps = 1e-4;
  if (t < -eps || t > 1 + eps || u < -eps || u > 1 + eps) return null;
  return [a[0] + t * rx, a[1] + t * ry];
}

function findIntersections(streets) {
  const segs = [];
  streets.forEach((street, si) => {
    const pts = streetToPolyline(street);
    for (let p = 0; p < pts.length - 1; p += 1) {
      segs.push({
        si,
        seg: [pts[p][0], pts[p][1], pts[p + 1][0], pts[p + 1][1]],
        dir: dirBucket(pts[p + 1][0] - pts[p][0], pts[p + 1][1] - pts[p][1])
      });
    }
  });

  const points = [];
  for (let i = 0; i < segs.length; i += 1) {
    for (let j = i + 1; j < segs.length; j += 1) {
      if (segs[i].si === segs[j].si) continue;
      const p = segSegIntersection(segs[i].seg, segs[j].seg);
      if (!p) continue;
      let node = points.find((q) => (q.x - p[0]) ** 2 + (q.y - p[1]) ** 2 < 676);
      if (!node) {
        node = { x: p[0], y: p[1], dirs: new Set() };
        points.push(node);
      }
      node.dirs.add(segs[i].dir);
      node.dirs.add(segs[j].dir);
    }
  }
  return points
    .filter((n) => n.dirs.size >= 2)
    .map((n) => ({ x: Math.round(n.x), y: Math.round(n.y) }));
}

// ---------------------------------------------------------------------------
// Building geometry
// ---------------------------------------------------------------------------

function buildingCorners(b) {
  if (b.points) return b.points.map((p) => p.slice());
  return [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]];
}

function buildingCentroid(b) {
  const pts = buildingCorners(b);
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p[0];
    y += p[1];
  }
  return [x / pts.length, y / pts.length];
}

function buildingBBox(b) {
  const pts = buildingCorners(b);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

function buildingByBid(bid) {
  for (const block of mapState?.blocks ?? []) {
    for (const b of block.buildings ?? []) {
      if (b.bid === bid) return b;
    }
  }
  return null;
}

// The ground between the streets, painted by district. The map carries each
// block pre-cut into rectangles that tile it exactly and stop at the kerb, so
// this can never paint over a road — it's what makes the six districts read as
// places rather than as a scatter of colored lots.
function renderDistrictBlocks(svgArg = null) {
  const svg = svgArg ?? els.gameBoard.querySelector(".tm-map");
  svg?.querySelector(".ub-district-blocks")?.remove();
  if (!svg || !mapState) return;
  const blocksLayer = svg.querySelector(".tm-blocks");
  const layer = svgEl("g", { class: "ub-district-blocks" });
  svg.insertBefore(layer, blocksLayer ?? null);
  for (const block of mapState.blocks ?? []) {
    if (!Array.isArray(block.rects) || !block.rects.length) continue;
    const tally = new Map();
    for (const b of block.buildings ?? []) {
      if (b.role !== "loc" || b.district == null) continue;
      tally.set(b.district, (tally.get(b.district) ?? 0) + 1);
    }
    if (!tally.size) continue;
    let district = null;
    let best = 0;
    for (const [id, n] of tally) {
      if (n > best) {
        best = n;
        district = id;
      }
    }
    const color = districtOf(district)?.color;
    if (!color) continue;
    for (const [x, y, w, h] of block.rects) {
      svgEl("rect", { x, y, width: w, height: h, fill: color, class: "ub-district-block" }, layer);
    }
  }
}

// ---------------------------------------------------------------------------
// Buildings. Every location wears its district's color: a light wash inside,
// the full color on the border. Its name runs across the top, its picture sits
// big underneath, and the errand corners tuck into the bottom right.
// ---------------------------------------------------------------------------

function appendBuilding(parent, building) {
  const isLoc = building.role === "loc";
  const cls = ["tm-building", "ub-building"];
  if (isLoc) cls.push("ub-loc");
  const g = svgEl("g", { class: cls.join(" "), "data-bldg": building.bid }, parent);

  const base = isLoc ? (districtOf(building.district)?.color ?? building.color) : building.color;
  const fill = isLoc ? lotFill(base) : base;
  const edge = isLoc ? lotEdge(base) : base;
  if (isLoc) g.style.setProperty("--ub-stroke", edge);

  (building.connectors ?? []).forEach((c) => {
    svgEl("line", {
      x1: c.x1, y1: c.y1, x2: c.x2, y2: c.y2, stroke: edge, "stroke-width": 2
    }, g);
  });

  if (building.points) {
    svgEl("polygon", { points: polygonToString(building.points), fill }, g);
  } else {
    const rect = svgEl("rect", {
      x: building.x, y: building.y, width: building.w, height: building.h, rx: 3, fill
    }, g);
    if (building.rotation) {
      rect.setAttribute(
        "transform",
        `rotate(${building.rotation} ${building.x + building.w / 2} ${building.y + building.h / 2})`
      );
    }
  }

  (building.connectors ?? []).forEach((c) => {
    const dx = c.x2 - c.x1;
    const dy = c.y2 - c.y1;
    const len = Math.hypot(dx, dy) || 1;
    svgEl("circle", {
      cx: c.x2 + (dx / len) * 2.5,
      cy: c.y2 + (dy / len) * 2.5,
      r: 3.5,
      fill: edge,
      class: "tm-connector-dot"
    }, g);
  });

  if (!isLoc) return;

  const [cx] = buildingCentroid(building);
  const bb = buildingBBox(building);
  const w = bb.maxX - bb.minX;
  const h = bb.maxY - bb.minY;

  // The title takes as much of the lot as its own length allows, so a "Bank"
  // reads big and an "Elementary School" still fits on one line.
  const label = building.name ?? "";
  const nameSize = Math.max(6.5, Math.min(12, (w - 7) / Math.max(3, label.length * 0.56)));
  const name = svgEl("text", { x: cx, y: bb.minY + nameSize + 2, class: "ub-loc-name" }, g);
  name.style.fontSize = `${r1(nameSize)}px`;
  name.textContent = label;
  if (isDarkColor(fill)) name.style.fill = "rgba(247, 244, 238, 0.95)";

  const top = bb.minY + nameSize + 5;
  const icon = svgEl("text", { x: cx, y: (top + bb.maxY) / 2, class: "ub-loc-emoji" }, g);
  icon.style.fontSize = `${Math.max(16, Math.min(46, w * 0.62, (bb.maxY - top) * 0.84))}px`;
  icon.textContent = building.emoji ?? "📍";

  // The errand tokens are state, so refreshLocations fills them in.
  svgEl("g", { class: "ub-loc-errands" }, g);
  svgEl("title", {}, g);
}

// Where the errand tokens sit: a row hugging the bottom-right corner. They're
// drawn last, so a big one lies over the picture the way a wooden disc lies on
// a board — which is the point of them being this size.
function errandGeometry(b, count) {
  const bb = buildingBBox(b);
  const r = Math.max(4, Math.min(13,
    (bb.maxX - bb.minX - 6) / (2.15 * Math.max(1, count)),
    (bb.maxY - bb.minY) * 0.3));
  const y = bb.maxY - r - 3;
  const right = bb.maxX - r - 3;
  return {
    r,
    centers: Array.from({ length: count }, (_, i) => [right - (count - 1 - i) * (2 * r + 2), y])
  };
}

// Redraw the state that sits on top of the buildings: just the errand tokens
// and the hover text.
//
// Deliberately NOT here: any hint about where you're supposed to be driving.
// A fare tile names its district and its address, and finding that address on
// the board is the player's job — same as it would be across a table. So no
// glow on a fare's destination, no pin marking which square of your board it
// rides on, and no pulse on an errand whose district happens to be open.
function refreshLocations() {
  const svg = els.gameBoard.querySelector(".tm-map");
  if (!svg || !mapState) return;
  const me = myIndex();
  const now = sectionState;

  (mapState.blocks ?? []).forEach((bl) => (bl.buildings ?? []).forEach((b) => {
    if (b.role !== "loc") return;
    const g = svg.querySelector(`.tm-building[data-bldg="${b.bid}"]`);
    if (!g) return;
    const district = districtOf(b.district);

    // The errand tokens: one disc per player who still owes a chore here, in
    // their own color. Nothing distinguishes an open one from a shut one —
    // knowing whether you can collect it right now means reading the clock.
    const errG = g.querySelector(".ub-loc-errands");
    if (errG) {
      errG.innerHTML = "";
      const seats = b.errands ?? [];
      if (seats.length) {
        const geom = errandGeometry(b, seats.length);
        seats.forEach((seat, i) => {
          const [x, y] = geom.centers[i];
          const c = svgEl("circle", {
            cx: r1(x), cy: r1(y), r: r1(geom.r), class: "ub-errand"
          }, errG);
          c.style.fill = playersState[seat]?.color ?? "#888";
          if (seat === me) c.classList.add("ub-errand-mine");
          // Waiting mode stamps each disc with WHEN it can be run — the whole
          // errand rule is the hour, so the token has to say it.
          if (isWaiting() && district) {
            const mark = svgEl("text", {
              x: r1(x), y: r1(y + geom.r * 0.36), class: "ub-errand-mark"
            }, errG);
            mark.style.fontSize = `${r1(geom.r * 1.15)}px`;
            mark.textContent = SECTION_TOKEN[district.section] ?? "";
          }
        });
      }
    }

    const t = g.querySelector("title");
    if (t) {
      const bits = [`${b.name} — ${district?.name ?? "district"}`];
      if (district) {
        const meta = SECTION_META[district.section];
        bits.push(`${meta.icon} ${meta.name} district (${meta.label})${district.section === now ? " — open now" : ""}`);
      }
      if ((b.errands ?? []).includes(me)) bits.push("One of your errands is here");
      t.textContent = bits.join("\n");
    }
  }));
}

// ---------------------------------------------------------------------------
// Octagon signals
// ---------------------------------------------------------------------------

function octagonPoints(r) {
  const pts = [];
  for (let k = 0; k < 8; k += 1) {
    const a = ((22.5 + k * 45) * Math.PI) / 180;
    pts.push([Math.sin(a) * r, -Math.cos(a) * r]);
  }
  return polygonToString(pts);
}

function renderOctagons(parent) {
  octEls = [];
  const layer = svgEl("g", { class: "tm-octagons" }, parent);
  mapState.intersections.forEach((oct, i) => {
    const g = svgEl("g", { class: "tm-oct", "data-oct": i, transform: `translate(${oct.x} ${oct.y})` }, layer);
    const zoom = svgEl("g", { class: "tm-oct-zoom" }, g);
    const flip = svgEl("g", { class: "tm-oct-flip" }, zoom);
    const shape = svgEl("polygon", {
      points: octagonPoints(octRadius()),
      fill: oct.color === "green" ? GREEN : RED
    }, flip);
    if (oct.number != null) {
      const text = svgEl("text", { class: "tm-oct-num", x: 0, y: 0 }, flip);
      text.textContent = String(oct.number);
    }
    octEls.push({ g, flip, shape, color: oct.color });
  });
}

function flipOctagon(entry, color, slow = false) {
  const dur = (slow ? 500 : 300) / speedMult;
  if (slow) entry.flip.classList.add("tm-oct-slow");
  const apply = () => {
    entry.flip.removeEventListener("transitionend", apply);
    entry.shape.setAttribute("fill", color === "green" ? GREEN : RED);
    entry.flip.classList.remove("tm-oct-folding");
    if (slow) setTimeout(() => entry.flip.classList.remove("tm-oct-slow"), dur + 80);
  };
  entry.flip.addEventListener("transitionend", apply);
  entry.flip.classList.add("tm-oct-folding");
  setTimeout(apply, dur);
}

function updateOctagons(newMap) {
  newMap.intersections.forEach((oct, i) => {
    const entry = octEls[i];
    if (!entry) return;
    if (entry.color !== oct.color) {
      entry.color = oct.color;
      flipOctagon(entry, oct.color);
    }
  });
}

function refreshOctagonsHard() {
  const svg = els.gameBoard.querySelector(".tm-map");
  const layer = svg?.querySelector(".tm-octagons");
  if (!svg || !layer) return false;
  layer.remove();
  renderOctagons(svg);
  return true;
}

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

let handDeg = 0;
function setHand() {
  if (!handEl) return;
  const target = ((hourState ?? 12) * 30) % 360;
  const cur = ((handDeg % 360) + 360) % 360;
  handDeg += ((target - cur) + 360) % 360; // the hand only sweeps clockwise
  handEl.style.transform = `rotate(${handDeg}deg)`;
}

function setHourHighlight(hour, on) {
  mapState.intersections.forEach((oct, i) => {
    if (oct.number === hour && octEls[i]) octEls[i].g.classList.toggle("tm-oct-hi", on);
  });
}

function stagedTimeChange(hour, idxOverride = null) {
  flipping = true;
  const idx = idxOverride ? idxOverride.slice() : [];
  if (!idxOverride) {
    mapState.intersections.forEach((oct, i) => {
      if (oct.number === hour) idx.push(i);
    });
  }
  idx.forEach((i) => octEls[i]?.g.classList.add("tm-oct-hi"));
  setHand();

  setTimeout(() => {
    let delay = 0;
    idx.forEach((i) => {
      setTimeout(() => {
        const entry = octEls[i];
        if (!entry) return;
        flipOctagon(entry, mapState.intersections[i].color, true);
        entry.color = mapState.intersections[i].color;
      }, delay);
      delay += 1050 / speedMult;
    });
    setTimeout(() => {
      flipping = false;
      if (hoveredHour !== hour) idx.forEach((i) => octEls[i]?.g.classList.remove("tm-oct-hi"));
      const q = clockQueue;
      clockQueue = [];
      q.forEach((fn) => fn());
      if (!diceAnimating) runDeferredDrives();
      updateTurnControls();
      refreshBuilder();
    }, delay + 650 / speedMult);
  }, 800 / speedMult);
}

function hourCost(hour) {
  const cur = hourState ?? 12;
  return (hour - cur + 12) % 12;
}

function canChangeTime() {
  // One clock change a turn — but waiting mode lets you spend it on a turn you
  // took a passenger, where the other two make you choose. PRE-TIME, when the
  // table has it on, demands it happen before anything else the turn does.
  // (Server: clockAllowed — keep in sync.)
  return isMyTurn() && winnerState == null && !turnChangedTime &&
    (isWaiting() || !turnDrew) && !(preTimeState && turnActed) && !diceAnimating;
}

function renderClock() {
  const slot = railSlot("meters");
  slot.querySelector(".tm-clock")?.remove();
  const wrap = document.createElement("div");
  wrap.className = "tm-clock ub-clock";

  dayNightEl = document.createElement("div");
  dayNightEl.className = "tm-clock-daynight";
  wrap.appendChild(dayNightEl);

  const svg = svgEl("svg", { viewBox: "0 0 200 200", role: "img", "aria-label": "Clock" });
  svgEl("circle", { cx: 100, cy: 100, r: 94, class: "tm-clock-face" }, svg);

  const costEl = svgEl("text", { x: 100, y: 138, class: "tm-clock-cost" }, svg);
  const showCost = (h) => {
    const cost = hourCost(h);
    const stones = myPlayer()?.timeStones ?? 0;
    costEl.textContent = cost ? `−${cost} ◆` : "";
    costEl.classList.toggle("tm-cost-over", cost > stones);
  };

  for (let h = 1; h <= 12; h += 1) {
    const a = (h * 30 * Math.PI) / 180;
    const x = 100 + Math.sin(a) * 72;
    const y = 100 - Math.cos(a) * 72;
    const hit = svgEl("g", { class: "tm-clock-hour", "data-hour": h }, svg);
    svgEl("circle", { cx: x, cy: y, r: 15, class: "tm-clock-hit" }, hit);
    const n = svgEl("text", { x, y, class: "tm-clock-num" }, hit);
    n.textContent = String(h);
    hit.addEventListener("mouseenter", () => {
      hoveredHour = h;
      showCost(h);
      if (!flipping) setHourHighlight(h, true);
    });
    hit.addEventListener("mouseleave", () => {
      hoveredHour = null;
      costEl.textContent = "";
      if (!flipping) setHourHighlight(h, false);
    });
  }

  handEl = svgEl("g", { class: "tm-clock-hand" }, svg);
  svgEl("line", { x1: 100, y1: 100, x2: 100, y2: 42 }, handEl);
  svgEl("circle", { cx: 100, cy: 100, r: 5, class: "tm-clock-pin" }, svg);

  wrap.appendChild(svg);
  wrap.addEventListener("click", (event) => {
    const hourElement = event.target.closest("[data-hour]");
    if (!hourElement || !app.roomId || !canChangeTime()) return;
    const hour = Number(hourElement.dataset.hour);
    const cost = hourCost(hour);
    if (!cost || cost > (myPlayer()?.timeStones ?? 0)) return;
    socket.emit("uber_mania_set_hour", { roomId: app.roomId, hour });
  });

  slot.appendChild(wrap);
  setHand();
  updateDayNight();
  renderRatingBar();
}

function updateDayNight() {
  if (!dayNightEl) return;
  const face = hourState ?? 12;
  dayNightEl.innerHTML = "";

  // No sun/moon: nothing in this game turns on whether it's dark out, and a
  // second time-of-day symbol beside the SECTION tag only reads as a rule.
  const label = document.createElement("span");
  label.className = "tm-daynight-label";
  label.textContent = `${face} ${timeState < 12 ? "AM" : "PM"}`;
  dayNightEl.append(label);

  // Which section of the day is running: it's what every errand waits on.
  const sec = SECTION_META[sectionState] ?? SECTION_META.morning;
  const sectionTag = document.createElement("span");
  sectionTag.className = `ub-section-tag ub-section-${sectionState}`;
  sectionTag.textContent = `${sec.icon} ${sec.name}`;
  sectionTag.title = `${sec.name} — ${sec.label}. Only ${sec.name.toLowerCase()} districts hand over their errands now.`;
  dayNightEl.appendChild(sectionTag);

  const totalDays = settingsState?.days ?? 3;
  const day = Math.min(totalDays, Math.floor(elapsedState / 24) + 1);
  const dayTag = document.createElement("span");
  dayTag.className = "ub-day-tag";
  dayTag.textContent = `Day ${day}/${totalDays}`;
  const hoursLeft = totalDays * 24 - elapsedState;
  dayTag.title = winnerState != null
    ? "The days are over"
    : `${Math.max(0, hoursLeft)}h left — the game is scored once they run out`;
  if (hoursLeft <= 12 && winnerState == null) dayTag.classList.add("ub-day-late");
  dayNightEl.appendChild(dayTag);

  if (dicePoolState > 0) {
    const pool = document.createElement("span");
    pool.className = "tm-pool-tag";
    pool.textContent = `🎲 ×${dicePoolState}`;
    pool.title = "One die per red light run — thrown when the turn ends";
    dayNightEl.appendChild(pool);
  }
  // No night styling either: recolouring the bar after dark is the same
  // misleading hint as the moon was, since nothing in the game turns on it.
}

// The five points of a star, as an SVG polygon centred on (cx, cy).
function starPoints(cx, cy, r) {
  const pts = [];
  for (let i = 0; i < 10; i += 1) {
    const rad = i % 2 === 0 ? r : r * 0.42;
    const a = (-90 + i * 36) * (Math.PI / 180);
    pts.push(`${r1(cx + rad * Math.cos(a))},${r1(cy + rad * Math.sin(a))}`);
  }
  return pts.join(" ");
}

// The rating column beside the clock: five stars filled from the bottom up to
// MY rating, with a waist line through each one (that's the half), and every
// driver's marker pinned at their own. Each full star is a point at every
// day's end, so this is the running score everyone can read.
function renderRatingBar() {
  const slot = railSlot("meters");
  slot.querySelector(".ub-rating")?.remove();
  if (!playersState.length) return;
  const max = Math.max(1, settingsState?.ratingMax ?? RATING_MAX);
  const wrap = document.createElement("div");
  wrap.className = "ub-rating";
  const title = document.createElement("div");
  title.className = "ub-rail-title";
  title.textContent = "RATING";
  wrap.appendChild(title);

  const cell = 22;
  const W = 30;
  const H = cell * max;
  const svg = svgEl("svg", {
    class: "ub-rating-stars",
    viewBox: `0 0 ${W + 30} ${H + 2}`,
    width: W + 30,
    height: H + 2
  });
  const defs = svgEl("defs", {}, svg);
  const grad = svgEl("linearGradient", { id: "ub-star-half", x1: "0", y1: "1", x2: "0", y2: "0" }, defs);
  svgEl("stop", { offset: "0%", "stop-color": "#f0d68a" }, grad);
  svgEl("stop", { offset: "50%", "stop-color": "#f0d68a" }, grad);
  svgEl("stop", { offset: "50%", "stop-color": "transparent" }, grad);
  svgEl("stop", { offset: "100%", "stop-color": "transparent" }, grad);

  const mine = Math.max(0, Math.min(max, myPlayer()?.rating ?? 0));
  const cx = W / 2 + 1;

  // Where each slot starts dealing, PRINTED on the rating column — one line per
  // gate, the same line whether you've reached it or not. Your stars are drawn
  // up the same column, so reading one against the other is the player's job,
  // exactly as it is at a table.
  if (queueMode()) {
    pilesState.forEach((pile) => {
      if (!pile.need) return;
      const y = 1 + H - pile.need * cell;
      const gate = svgEl("line", {
        x1: 1, y1: r1(y), x2: W + 1, y2: r1(y), class: "ub-rating-gate"
      }, svg);
      svgEl("title", {}, gate).textContent =
        `A slot opens at ${num(pile.need)} stars`;
    });
  }

  for (let k = 1; k <= max; k += 1) {
    const cy = 1 + H - (k - 0.5) * cell;
    const full = mine >= k;
    const half = !full && mine >= k - 0.5;
    const star = svgEl("polygon", { points: starPoints(cx, cy, cell * 0.46), class: "ub-star" }, svg);
    if (full) star.style.fill = "#f0d68a";
    else if (half) star.style.fill = "url(#ub-star-half)";
    svgEl("line", {
      x1: cx - cell * 0.5, y1: r1(cy), x2: cx + cell * 0.5, y2: r1(cy), class: "ub-star-waist"
    }, svg);
  }

  playersState.forEach((p, i) => {
    const r = Math.max(0, Math.min(max, p.rating ?? 0));
    const y = 1 + H - r * cell;
    const g = svgEl("g", { class: "ub-rating-pin" }, svg);
    svgEl("line", {
      x1: cx - cell * 0.55, y1: r1(y), x2: W + 6 + i * 4, y2: r1(y),
      class: "ub-rating-pin-line", stroke: p.color
    }, g);
    const dot = svgEl("circle", {
      cx: W + 6 + i * 4, cy: r1(y), r: i === myIndex() ? 4 : 3,
      class: i === myIndex() ? "ub-rating-dot ub-rating-dot-mine" : "ub-rating-dot"
    }, g);
    dot.style.fill = p.color;
    // Waiting mode pays no wage at a day's end, so don't promise one: there a
    // rating is worth the tips it multiplies and the slots it opens.
    svgEl("title", {}, g).textContent = isWaiting()
      ? `${seatName(i)} — ${num(r)} star${r === 1 ? "" : "s"}: every tip they've delivered is worth ${Math.floor(r)} at the end`
      : `${seatName(i)} — ${num(r)} star${r === 1 ? "" : "s"}, worth ${Math.floor(r)} a day`;
  });

  wrap.appendChild(svg);
  slot.insertBefore(wrap, slot.firstChild);
}

// ---------------------------------------------------------------------------
// Street graph + routing (same rules as the other Traffic Time games)
// ---------------------------------------------------------------------------

function buildStreetGraph(streets, spots) {
  const nodePts = [];
  const nodeIds = new Map();
  const nodeId = (x, y) => {
    const k = `${Math.round(x)},${Math.round(y)}`;
    if (nodeIds.has(k)) return nodeIds.get(k);
    const id = nodePts.length;
    nodeIds.set(k, id);
    nodePts.push([x, y]);
    return id;
  };
  const adj = [];
  const addEdge = (a, b, w, pts) => {
    if (a === b) return;
    (adj[a] ||= []).push({ to: b, w, pts });
    (adj[b] ||= []).push({ to: a, w, pts: pts.slice().reverse() });
  };

  const pois = [
    ...findIntersections(streets).map((p) => [p.x, p.y]),
    ...spots.map((s) => [s.x, s.y])
  ];

  for (const street of streets) {
    const poly = streetToPolyline(street);
    const cum = [0];
    for (let i = 1; i < poly.length; i += 1) {
      cum.push(cum[i - 1] + Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]));
    }
    const consider = [...pois, poly[0], poly[poly.length - 1]];
    const onStreet = [];
    for (const [px, py] of consider) {
      let bestD = Infinity;
      let bestParam = 0;
      let bestPt = null;
      for (let i = 0; i < poly.length - 1; i += 1) {
        const pr = projectToSegment(px, py, poly[i][0], poly[i][1], poly[i + 1][0], poly[i + 1][1]);
        if (pr.dist < bestD) {
          bestD = pr.dist;
          bestParam = cum[i] + Math.hypot(pr.x - poly[i][0], pr.y - poly[i][1]);
          bestPt = [pr.x, pr.y];
        }
      }
      if (bestD < 5) onStreet.push({ param: bestParam, pt: bestPt });
    }
    onStreet.sort((a, b) => a.param - b.param);
    const uniq = [];
    for (const o of onStreet) {
      if (!uniq.length || o.param - uniq[uniq.length - 1].param > 0.5) uniq.push(o);
    }
    for (let i = 0; i < uniq.length - 1; i += 1) {
      const A = uniq[i];
      const B = uniq[i + 1];
      const pts = [A.pt];
      for (let j = 0; j < poly.length; j += 1) {
        if (cum[j] > A.param + 0.1 && cum[j] < B.param - 0.1) pts.push(poly[j]);
      }
      pts.push(B.pt);
      addEdge(nodeId(A.pt[0], A.pt[1]), nodeId(B.pt[0], B.pt[1]), B.param - A.param, pts);
    }
  }
  return { nodePts, adj };
}

function getGraph() {
  if (!graphCache || graphCache.seed !== mapState.seed) {
    graphCache = { seed: mapState.seed, graph: buildStreetGraph(mapState.streets, mapState.spots ?? []) };
  }
  return graphCache.graph;
}

function nearestNode(graph, x, y) {
  let best = -1;
  let bestD = Infinity;
  graph.nodePts.forEach((p, i) => {
    const d = (p[0] - x) ** 2 + (p[1] - y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

function findPath(graph, ax, ay, bx, by) {
  const start = nearestNode(graph, ax, ay);
  const goal = nearestNode(graph, bx, by);
  if (start < 0 || goal < 0) return [[ax, ay], [bx, by]];

  const n = graph.nodePts.length;
  const dist = new Array(n).fill(Infinity);
  const prev = new Array(n).fill(-1);
  const prevEdge = new Array(n).fill(null);
  const done = new Array(n).fill(false);
  dist[start] = 0;

  for (let iter = 0; iter < n; iter += 1) {
    let u = -1;
    let ud = Infinity;
    for (let i = 0; i < n; i += 1) {
      if (!done[i] && dist[i] < ud) {
        ud = dist[i];
        u = i;
      }
    }
    if (u === -1 || u === goal) break;
    done[u] = true;
    for (const e of graph.adj[u] ?? []) {
      const nd = dist[u] + e.w;
      if (nd < dist[e.to]) {
        dist[e.to] = nd;
        prev[e.to] = u;
        prevEdge[e.to] = e;
      }
    }
  }
  if (dist[goal] === Infinity) return [[ax, ay], [bx, by]];

  const order = [];
  for (let u = goal; u !== -1; u = prev[u]) order.push(u);
  order.reverse();
  const pts = [graph.nodePts[order[0]].slice()];
  for (let i = 1; i < order.length; i += 1) {
    const e = prevEdge[order[i]];
    for (let k = 1; k < e.pts.length; k += 1) pts.push(e.pts[k].slice());
  }
  return pts;
}

function polyDir(pts, fromEnd = false) {
  if (fromEnd) {
    for (let i = pts.length - 1; i > 0; i -= 1) {
      const dx = pts[i][0] - pts[i - 1][0];
      const dy = pts[i][1] - pts[i - 1][1];
      const len = Math.hypot(dx, dy);
      if (len > 0.01) return [dx / len, dy / len];
    }
  } else {
    for (let i = 1; i < pts.length; i += 1) {
      const dx = pts[i][0] - pts[0][0];
      const dy = pts[i][1] - pts[0][1];
      const len = Math.hypot(dx, dy);
      if (len > 0.01) return [dx / len, dy / len];
    }
  }
  return [1, 0];
}

const UTURN_COS = -0.966;

// Up to two candidate routes (arriving in either facing); each is
// { path, reds, endAngle, endDir }. Lexicographic cost: reds, then distance.
function findRoutes(graph, ax, ay, headingDeg, bx, by) {
  const start = nearestNode(graph, ax, ay);
  const goal = nearestNode(graph, bx, by);
  if (start < 0 || goal < 0 || start === goal) return [];

  const RED_REACH = OCT_RADIUS;
  const redOcts = (mapState.intersections ?? [])
    .filter((o) => o.color === "red")
    .filter((o) =>
      Math.hypot(o.x - ax, o.y - ay) >= RED_REACH && Math.hypot(o.x - bx, o.y - by) >= RED_REACH
    );
  const arcReds = (e) => {
    let n = 0;
    const [sx, sy] = e.pts[0];
    for (const o of redOcts) {
      if (Math.hypot(o.x - sx, o.y - sy) < RED_REACH) continue;
      for (let i = 0; i < e.pts.length - 1; i += 1) {
        const pr = projectToSegment(o.x, o.y, e.pts[i][0], e.pts[i][1], e.pts[i + 1][0], e.pts[i + 1][1]);
        if (pr.dist < RED_REACH) {
          n += 1;
          break;
        }
      }
    }
    return n;
  };

  const better = (a, b) => a.reds < b.reds || (a.reds === b.reds && a.dist < b.dist);
  const states = new Map();

  const hx = Math.cos((headingDeg * Math.PI) / 180);
  const hy = Math.sin((headingDeg * Math.PI) / 180);
  (graph.adj[start] ?? []).forEach((e, k) => {
    const [dx, dy] = polyDir(e.pts);
    if (dx * hx + dy * hy <= 0) return; // no reversing out of the spot
    states.set(`${start}:${k}`, {
      e, key: `${start}:${k}`, reds: arcReds(e), dist: e.w, prevKey: null, done: false
    });
  });

  for (;;) {
    let cur = null;
    for (const s of states.values()) {
      if (!s.done && (!cur || better(s, cur))) cur = s;
    }
    if (!cur) break;
    cur.done = true;
    const v = cur.e.to;
    const inDir = polyDir(cur.e.pts, true);
    (graph.adj[v] ?? []).forEach((e2, k2) => {
      const outDir = polyDir(e2.pts);
      if (inDir[0] * outDir[0] + inDir[1] * outDir[1] < UTURN_COS) return;
      const key2 = `${v}:${k2}`;
      const old = states.get(key2);
      const cand = {
        e: e2,
        key: key2,
        reds: cur.reds + arcReds(e2),
        dist: cur.dist + e2.w,
        prevKey: cur.key,
        done: false
      };
      if (!old || (!old.done && better(cand, old))) states.set(key2, cand);
    });
  }

  const build = (s) => {
    const chain = [];
    for (let st = s; st; st = st.prevKey ? states.get(st.prevKey) : null) chain.push(st);
    chain.reverse();
    const pts = [chain[0].e.pts[0].slice()];
    for (const st of chain) {
      for (let i = 1; i < st.e.pts.length; i += 1) pts.push(st.e.pts[i].slice());
    }
    const endDir = polyDir(s.e.pts, true);
    return {
      path: pts,
      reds: s.reds,
      endDir,
      endAngle: (Math.atan2(endDir[1], endDir[0]) * 180) / Math.PI
    };
  };

  const arrivals = [...states.values()].filter((s) => s.e.to === goal);
  if (!arrivals.length) return [];
  arrivals.sort((a, b) => (better(a, b) ? -1 : 1));

  const routeA = build(arrivals[0]);
  const opp = arrivals.find((s) => {
    const d = polyDir(s.e.pts, true);
    return d[0] * routeA.endDir[0] + d[1] * routeA.endDir[1] < 0;
  });
  return opp ? [routeA, build(opp)] : [routeA];
}

// ---------------------------------------------------------------------------
// Cars
// ---------------------------------------------------------------------------

function carTransform(id) {
  const el = carEls[id];
  const pos = carPos[id];
  if (!el || !pos) return;
  const flipY = Math.cos((pos.angle * Math.PI) / 180) < 0 ? -CAR_SCALE : CAR_SCALE;
  el.setAttribute("transform", `translate(${pos.x} ${pos.y}) rotate(${pos.angle}) scale(${CAR_SCALE} ${flipY})`);
}

// A little side-view sedan, drawn facing right (mirrored via the transform).
function makeCarShape(parent, bodyColor) {
  const g = svgEl("g", { class: "ub-car" }, parent);
  const dark = "rgba(18,22,28,0.9)";
  svgEl("path", {
    d: "M14 4 L14 -2 Q13 -4 10 -4 L6 -4 L2 -9 L-7 -9 L-11 -4 Q-14 -4 -14 -1 L-14 4 Z",
    fill: bodyColor, stroke: dark, "stroke-width": 1.5, class: "ub-car-body"
  }, g);
  svgEl("path", { d: "M1 -8 L4.5 -4 L-1 -4 L-1 -8 Z", fill: "#bfe0f0", stroke: dark, "stroke-width": 0.7 }, g);
  svgEl("path", { d: "M-3 -8 L-6.5 -8 L-9.5 -4 L-3 -4 Z", fill: "#bfe0f0", stroke: dark, "stroke-width": 0.7 }, g);
  svgEl("circle", { cx: 13.4, cy: 1, r: 1.2, fill: "#f5d76e" }, g);
  for (const cx of [-8, 8]) {
    svgEl("circle", { cx, cy: 5, r: 3.6, fill: "#1c2027", stroke: "#000", "stroke-width": 0.6 }, g);
    svgEl("circle", { cx, cy: 5, r: 1.6, fill: "#5b6472" }, g);
  }
  return g;
}

function addCarEl(layer, t) {
  const color = playersState[t.player]?.color ?? "#f4c542";
  const g = makeCarShape(layer, color);
  g.setAttribute("data-truck", t.id);
  if (isOffBoard(t)) g.style.display = "none"; // waiting in the garage
  carEls[t.id] = g;
}

function renderCars(svg) {
  const layer = svgEl("g", { class: "tm-trucks" }, svg);
  Object.keys(carEls).forEach((k) => delete carEls[k]);
  carsState.forEach((t) => addCarEl(layer, t));
}

function syncCars(cars) {
  carsState = cars ?? [];
  const layer = els.gameBoard.querySelector(".tm-map .tm-trucks");
  if (layer) {
    carsState.forEach((t) => {
      if (!carEls[t.id]) addCarEl(layer, t);
    });
  }
  carsState.forEach((t) => {
    const place = carPlace(t);
    if (!place) {
      if (snapCarState?.truckId === t.id && carAnim[t.id]) {
        cancelAnimationFrame(carAnim[t.id]);
        carAnim[t.id] = null;
      }
      if (carEls[t.id]) carEls[t.id].style.display = "none";
      delete carSpots[t.id];
      delete carPos[t.id];
      delete pendingRoutes[t.id];
      return;
    }
    if (!carEls[t.id]) return;
    carEls[t.id].style.display = "";
    // A car stopping at a light stops NOSE-first, so its drive ends short — and
    // lands exactly where carPlace says it stands, clamp and all.
    const dress = (p) => {
      if (place.kind !== "light") return p;
      const cut = trimPathEnd(p, LIGHT_NOSE()).map((q) => q.slice());
      cut[cut.length - 1] = [place.x, place.y];
      return cut;
    };
    // An undone drive: the car was never there, so it doesn't drive back — it
    // is simply where it was, facing the way it was.
    if (snapCarState?.truckId === t.id && placeKeyOf(snapCarState) === place.key) {
      if (carAnim[t.id]) {
        cancelAnimationFrame(carAnim[t.id]);
        carAnim[t.id] = null;
      }
      deferredDrives = deferredDrives.filter((d) => d.id !== t.id);
      delete pendingRoutes[t.id];
      carSpots[t.id] = place.key;
      const was = carUndoPose[t.id];
      carPos[t.id] = was?.key === place.key
        ? { x: was.x, y: was.y, angle: was.angle }
        : { x: place.x, y: place.y, angle: snapCarState.facing ?? place.angle };
      delete carUndoPose[t.id];
      carTransform(t.id);
      if (previewState?.truckId === t.id) clearPreview();
      return;
    }
    const prev = carSpots[t.id];
    if (prev == null) {
      carSpots[t.id] = place.key;
      const pending = pendingRoutes[t.id];
      let entry = null;
      if (pending?.key === place.key) entry = pending;
      else if (aiMoveState && aiMoveState.truckId === t.id) entry = aiMoveState;
      delete pendingRoutes[t.id];
      if (entry?.path?.length >= 2) {
        carUndoPose[t.id] = { key: null };
        const path = dress(entry.path);
        const p0 = path[0];
        const [dx, dy] = polyDir(path);
        carPos[t.id] = { x: p0[0], y: p0[1], angle: (Math.atan2(dy, dx) * 180) / Math.PI };
        carTransform(t.id);
        startDrive(t.id, path, entry.endAngle);
        return;
      }
      carPos[t.id] = { x: place.x, y: place.y, angle: place.angle };
      carTransform(t.id);
    } else if (prev !== place.key) {
      const here = carPos[t.id];
      carUndoPose[t.id] = here
        ? { key: prev, x: here.x, y: here.y, angle: here.angle }
        : { key: prev };
      carSpots[t.id] = place.key;
      if (previewState?.truckId === t.id) clearPreview();
      const pending = pendingRoutes[t.id];
      delete pendingRoutes[t.id];
      let path;
      let endAngle;
      if (pending?.key === place.key) {
        path = dress(pending.path);
        endAngle = pending.endAngle;
      } else if (aiMoveState && aiMoveState.truckId === t.id) {
        path = dress(aiMoveState.path);
        endAngle = aiMoveState.endAngle;
      } else {
        const from = carPos[t.id] || { x: place.x, y: place.y };
        path = findPath(getGraph(), from.x, from.y, place.x, place.y);
        endAngle = lastPathAngle(path, place.angle);
      }
      startDrive(t.id, path, endAngle);
    }
  });
}

const placeKeyOf = (o) =>
  (o?.light != null ? `l${o.light}` : o?.spot != null ? `s${o.spot}` : null);

function startDrive(id, path, endAngle) {
  if (diceAnimating || flipping) {
    deferredDrives.push({ id, path, endAngle });
    return;
  }
  driveCar(id, path, endAngle, () => onCarArrive());
}

function runDeferredDrives() {
  const list = deferredDrives;
  deferredDrives = [];
  list.forEach((d) => driveCar(d.id, d.path, d.endAngle, () => onCarArrive()));
}

function onCarArrive() {
  updateTurnControls();
  refreshBuilder();
  refreshLocations();
  setTurnStatus();
}

function lastPathAngle(path, fallback = 0) {
  if (!path || path.length < 2) return fallback;
  for (let i = path.length - 1; i > 0; i -= 1) {
    const dx = path[i][0] - path[i - 1][0];
    const dy = path[i][1] - path[i - 1][1];
    if (Math.hypot(dx, dy) > 0.01) return (Math.atan2(dy, dx) * 180) / Math.PI;
  }
  return fallback;
}

function angleDelta(a, b) {
  return ((b - a + 540) % 360) - 180;
}

function driveCar(id, path, endAngle, onArrive) {
  if (carAnim[id]) cancelAnimationFrame(carAnim[id]);
  const cum = [0];
  for (let i = 1; i < path.length; i += 1) {
    cum.push(cum[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
  }
  const total = cum[cum.length - 1];
  const last = path[path.length - 1];
  const park = () => {
    carPos[id] = { x: last[0], y: last[1], angle: endAngle };
    carTransform(id);
  };
  if (total < 1) {
    park();
    carAnim[id] = null;
    onArrive?.();
    return;
  }
  const duration = Math.max(250, (total / CAR_SPEED) * 1000) / speedMult;
  const start = performance.now();

  const step = (now) => {
    const target = Math.min(total, ((now - start) / duration) * total);
    let i = 1;
    while (i < cum.length && cum[i] < target) i += 1;
    const a = path[i - 1];
    const b = path[Math.min(i, path.length - 1)];
    const segLen = (cum[i] ?? total) - cum[i - 1] || 1;
    const f = Math.max(0, Math.min(1, (target - cum[i - 1]) / segLen));
    const prev = carPos[id]?.angle ?? 0;
    let angle = prev;
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 0.5) {
      const dir = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
      angle = prev + angleDelta(prev, dir) * 0.22;
    }
    carPos[id] = { x: a[0] + (b[0] - a[0]) * f, y: a[1] + (b[1] - a[1]) * f, angle };
    carTransform(id);
    if (target < total) {
      carAnim[id] = requestAnimationFrame(step);
    } else {
      park();
      carAnim[id] = null;
      onArrive?.();
    }
  };
  carAnim[id] = requestAnimationFrame(step);
}

function anyCarAnimating() {
  return Object.values(carAnim).some((h) => h != null);
}

// ---------------------------------------------------------------------------
// Route preview
// ---------------------------------------------------------------------------

const CHEVRON_SPACING = 30;

function cumLengths(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i += 1) {
    cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  return cum;
}

function pathLength(pts) {
  if (!pts || pts.length < 2) return 0;
  const cum = cumLengths(pts);
  return cum[cum.length - 1];
}

function sampleAlong(pts, cum, d) {
  let i = 1;
  while (i < cum.length && cum[i] < d) i += 1;
  const a = pts[i - 1];
  const b = pts[Math.min(i, pts.length - 1)];
  const seg = (cum[Math.min(i, cum.length - 1)] - cum[i - 1]) || 1;
  const f = Math.max(0, Math.min(1, (d - cum[i - 1]) / seg));
  return {
    x: a[0] + (b[0] - a[0]) * f,
    y: a[1] + (b[1] - a[1]) * f,
    angle: (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI
  };
}

function sharedPrefixLen(a, b) {
  let k = 0;
  const n = Math.min(a.length, b.length);
  while (k < n && Math.abs(a[k][0] - b[k][0]) < 0.6 && Math.abs(a[k][1] - b[k][1]) < 0.6) k += 1;
  return k;
}

function polylineStr(pts) {
  return pts.map((p) => `${r1(p[0])},${r1(p[1])}`).join(" ");
}

const ROUTE_OFFSET = 7;

function offsetPath(pts, off) {
  if (pts.length < 2) return pts.map((p) => p.slice());
  const normals = [];
  for (let i = 0; i < pts.length - 1; i += 1) {
    const dx = pts[i + 1][0] - pts[i][0];
    const dy = pts[i + 1][1] - pts[i][1];
    const len = Math.hypot(dx, dy) || 1;
    normals.push([-dy / len, dx / len]);
  }
  return pts.map((p, i) => {
    const a = normals[Math.max(0, i - 1)];
    const b = normals[Math.min(normals.length - 1, i)];
    const nx = a[0] + b[0];
    const ny = a[1] + b[1];
    const nl = Math.hypot(nx, ny) || 1;
    return [p[0] + (nx / nl) * off, p[1] + (ny / nl) * off];
  });
}

function chaikin(pts, iters = 2) {
  let p = pts;
  for (let k = 0; k < iters && p.length >= 3; k += 1) {
    const q = [p[0]];
    for (let i = 0; i < p.length - 1; i += 1) {
      const a = p[i];
      const b = p[i + 1];
      q.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
      q.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    q.push(p[p.length - 1]);
    p = q;
  }
  return p;
}

function dressPath(pts) {
  if (!pts || pts.length < 2) return pts ? pts.map((p) => p.slice()) : [];
  return chaikin(offsetPath(pts, ROUTE_OFFSET), 2);
}

function drawRouteLine(layer, pts, color, routeIdx, isStem = false) {
  if (pts.length < 2) return;
  const str = polylineStr(pts);
  const line = svgEl("polyline", { points: str, class: "tm-route-line", stroke: color }, layer);
  if (routeIdx != null) line.setAttribute("data-route-line", routeIdx);
  if (isStem) line.classList.add("tm-route-stem");
  const hit = svgEl("polyline", { points: str, class: "tm-route-hit" }, layer);
  if (routeIdx != null) hit.setAttribute("data-route", routeIdx);
}

function drawChevrons(layer, pts, color) {
  const cum = cumLengths(pts);
  const total = cum[cum.length - 1];
  for (let d = CHEVRON_SPACING * 0.7; d < total - 3; d += CHEVRON_SPACING) {
    const s = sampleAlong(pts, cum, d);
    const g = svgEl("g", {
      class: "tm-chev",
      transform: `translate(${r1(s.x)} ${r1(s.y)}) rotate(${Math.round(s.angle)})`
    }, layer);
    svgEl("polyline", { points: "-3.5,-4 1.5,0 -3.5,4", stroke: color, class: "tm-chev-mark" }, g);
  }
}

function drawRedBadge(layer, pts, reds, routeIdx) {
  const cum = cumLengths(pts);
  const at = sampleAlong(pts, cum, Math.min(22, cum[cum.length - 1] * 0.45));
  const g = svgEl("g", { class: "tm-route-badge", transform: `translate(${r1(at.x)} ${r1(at.y)})` }, layer);
  const inner = svgEl("g", { class: "tm-route-badge-inner" }, g);
  if (routeIdx != null) inner.setAttribute("data-route-badge", routeIdx);
  svgEl("circle", { cx: 0, cy: 0, r: 9, class: "tm-route-badge-bg" }, inner);
  const t = svgEl("text", { x: 0, y: 0, class: "tm-route-badge-num" }, inner);
  t.textContent = String(reds);
}

function setRouteHover(layer, idx, on) {
  layer.querySelectorAll(`[data-route-line="${idx}"], .tm-route-stem`).forEach((el) =>
    el.classList.toggle("tm-route-hover", on));
  layer.querySelectorAll(`[data-route-badge="${idx}"]`).forEach((el) =>
    el.classList.toggle("tm-route-badge-hover", on));
}

function wireRouteHover(layer) {
  layer.querySelectorAll(".tm-route-hit").forEach((hit) => {
    const idx = hit.dataset.route;
    if (idx == null) return;
    hit.addEventListener("mouseenter", () => setRouteHover(layer, idx, true));
    hit.addEventListener("mouseleave", () => setRouteHover(layer, idx, false));
  });
}

function clearPreview() {
  previewState = null;
  els.gameBoard.querySelector(".tm-map .tm-route-preview")?.remove();
}

function renderRoutePreview() {
  const svg = els.gameBoard.querySelector(".tm-map");
  if (!svg) return;
  svg.querySelector(".tm-route-preview")?.remove();
  if (!previewState) return;

  const color = myPlayer()?.color ?? "#3ac0c0";
  const layer = svgEl("g", { class: "tm-route-preview" }, svg);
  const routes = previewState.routes;

  if (routes.length === 2) {
    const p0 = routes[0].path;
    const p1 = routes[1].path;
    const split = Math.max(1, sharedPrefixLen(p0, p1));
    const connect = split - 1;
    const shared = dressPath(p0.slice(0, split));
    const tail0 = dressPath(p0.slice(connect));
    const tail1 = dressPath(p1.slice(connect));
    const shorterIdx = pathLength(p0) <= pathLength(p1) ? 0 : 1;

    if (shared.length >= 2) {
      drawRouteLine(layer, shared, color, shorterIdx, true);
      drawChevrons(layer, shared, color);
    }
    drawRouteLine(layer, tail0, color, 0);
    drawRouteLine(layer, tail1, color, 1);
    drawChevrons(layer, tail0, color);
    drawChevrons(layer, tail1, color);
    drawRedBadge(layer, tail0.length >= 2 ? tail0 : dressPath(p0), routes[0].reds, 0);
    drawRedBadge(layer, tail1.length >= 2 ? tail1 : dressPath(p1), routes[1].reds, 1);
  } else if (routes.length === 1) {
    const dressed = dressPath(routes[0].path);
    drawRouteLine(layer, dressed, color, 0);
    drawChevrons(layer, dressed, color);
    drawRedBadge(layer, dressed, routes[0].reds, 0);
  }
  wireRouteHover(layer);
}

function commitRoute(routeIdx) {
  if (!previewState) return;
  const route = previewState.routes[routeIdx];
  const car = carsState.find((t) => t.id === previewState.truckId);
  if (!route || !car) {
    clearPreview();
    return;
  }
  pendingRoutes[car.id] = {
    key: `s${previewState.spot}`, path: route.path, endAngle: route.endAngle
  };
  const spot = previewState.spot;
  const reds = route.reds;
  clearPreview();
  socket.emit("uber_mania_move_truck", { roomId: app.roomId, truckId: car.id, spot, reds });
}

function previewTo(spotIndex) {
  const car = myCar();
  const dest = mapState.spots?.[spotIndex];
  const pos = car ? carPos[car.id] : null;
  if (!car || !dest || !pos || car.spot === spotIndex) {
    clearPreview();
    return;
  }
  const routes = findRoutes(getGraph(), pos.x, pos.y, pos.angle, dest.x, dest.y);
  if (!routes.length) {
    clearPreview();
    return;
  }
  previewState = { truckId: car.id, spot: spotIndex, routes };
  renderRoutePreview();
}

// ---------------------------------------------------------------------------
// Build mode: hand-build a route one stop light at a time.
// ---------------------------------------------------------------------------

// `leave` says how the first edge out of the starting point is judged:
//   "driveway" — forward only, you can't reverse out of a parking space
//   "junction" — anything but a U-turn, you're sitting in an intersection
//   "either"   — both ways along the street, you're pulling out of a space
// The third exists because a parked car is DRAWN at its space's own angle, not
// at the heading it arrived on: with "driveway" that made every space on a
// street leavable in one direction only, whichever way the map happened to
// have drawn that street, and every space behind you stayed unclickable.
function manualChoices(px, py, headingDeg, leave = "driveway") {
  const graph = getGraph();
  const res = { octs: [], spots: [] };
  const start = nearestNode(graph, px, py);
  if (start < 0) return res;

  const octs = mapState.intersections ?? [];
  const spots = mapState.spots ?? [];
  // Each octagon gates at its single NEAREST node only.
  const octAtNode = graph.nodePts.map(() => -1);
  octs.forEach((o, i) => {
    let best = -1;
    let bd = Infinity;
    graph.nodePts.forEach(([x, y], n) => {
      const d = Math.hypot(o.x - x, o.y - y);
      if (d < bd) {
        bd = d;
        best = n;
      }
    });
    if (best !== -1 && bd < 15) octAtNode[best] = i;
  });
  const spotAtNode = graph.nodePts.map(([x, y]) => {
    for (let i = 0; i < spots.length; i += 1) {
      if (Math.hypot(spots[i].x - x, spots[i].y - y) < 8) return i;
    }
    return -1;
  });

  const states = new Map();
  const hx = Math.cos((headingDeg * Math.PI) / 180);
  const hy = Math.sin((headingDeg * Math.PI) / 180);
  (graph.adj[start] ?? []).forEach((e, k) => {
    const [dx, dy] = polyDir(e.pts);
    const dot = dx * hx + dy * hy;
    if (leave === "driveway" ? dot <= 0 : leave === "junction" && dot < UTURN_COS) return;
    states.set(`${start}:${k}`, { e, key: `${start}:${k}`, dist: e.w, prevKey: null, done: false });
  });

  const octBest = new Map();
  const spotBest = new Map();
  for (;;) {
    let cur = null;
    for (const s of states.values()) {
      if (!s.done && (!cur || s.dist < cur.dist)) cur = s;
    }
    if (!cur) break;
    cur.done = true;
    const v = cur.e.to;
    const oi = octAtNode[v];
    if (oi !== -1) {
      if (!octBest.has(oi)) octBest.set(oi, cur);
      continue;
    }
    const si = spotAtNode[v];
    if (si !== -1 && !spotBest.has(si)) spotBest.set(si, cur);
    const inDir = polyDir(cur.e.pts, true);
    (graph.adj[v] ?? []).forEach((e2, k2) => {
      const outDir = polyDir(e2.pts);
      if (inDir[0] * outDir[0] + inDir[1] * outDir[1] < UTURN_COS) return;
      const key2 = `${v}:${k2}`;
      const old = states.get(key2);
      const cand = { e: e2, key: key2, dist: cur.dist + e2.w, prevKey: cur.key, done: false };
      if (!old || (!old.done && cand.dist < old.dist)) states.set(key2, cand);
    });
  }

  const buildLeg = (s) => {
    const chain = [];
    for (let st = s; st; st = st.prevKey ? states.get(st.prevKey) : null) chain.push(st);
    chain.reverse();
    const pts = [chain[0].e.pts[0].slice()];
    for (const st of chain) {
      for (let i = 1; i < st.e.pts.length; i += 1) pts.push(st.e.pts[i].slice());
    }
    const d = polyDir(s.e.pts, true);
    return { path: pts, endAngle: (Math.atan2(d[1], d[0]) * 180) / Math.PI };
  };

  octBest.forEach((s, i) => res.octs.push({ index: i, ...buildLeg(s) }));
  spotBest.forEach((s, i) => res.spots.push({ index: i, ...buildLeg(s) }));
  return res;
}

function builderHead() {
  const w = builder.waypoints[builder.waypoints.length - 1];
  if (!w) {
    // A car waiting at a light routes from the OCTAGON, not from where its body
    // is parked behind it — otherwise the search starts at the wrong node.
    const car = carsState.find((t) => t.id === builder.truckId);
    const place = carPlace(car);
    if (place?.kind === "light") return { x: place.cx, y: place.cy, angle: place.angle };
    const p = carPos[builder.truckId];
    return { x: p.x, y: p.y, angle: p.angle };
  }
  const last = w.path[w.path.length - 1];
  return { x: last[0], y: last[1], angle: w.endAngle };
}

// First click of an off-board turn: an edge stop light to drive in through.
function entryChoices() {
  const octs = mapState.intersections ?? [];
  const w = mapState.width ?? 960;
  const h = mapState.height ?? 720;
  const PAD = 20;
  let idxs = octs
    .map((_, i) => i)
    .filter((i) => {
      const o = octs[i];
      return o.x < PAD || o.x > w - PAD || o.y < PAD || o.y > h - PAD;
    });
  if (!idxs.length) idxs = octs.map((_, i) => i);
  const res = { octs: [], spots: [] };
  idxs.forEach((i) => {
    const o = octs[i];
    let dx = 0;
    let dy = 0;
    if (o.x < PAD) dx = 1;
    else if (o.x > w - PAD) dx = -1;
    if (o.y < PAD) dy = 1;
    else if (o.y > h - PAD) dy = -1;
    if (!dx && !dy) {
      dx = w / 2 - o.x;
      dy = h / 2 - o.y;
    }
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    res.octs.push({
      index: i,
      path: [[o.x - dx * 46, o.y - dy * 46], [o.x, o.y]],
      endAngle: (Math.atan2(dy, dx) * 180) / Math.PI
    });
  });
  return res;
}

function computeBuilderChoices() {
  if (builder.entry && builder.waypoints.length === 0) return entryChoices();
  const head = builderHead();
  // "First leg" is the can't-reverse-out-of-a-driveway rule, so it belongs to
  // KERBS only — and in waiting mode a kerb can be a stop on the way, so it
  // applies again every time the route calls somewhere. A car waiting AT A
  // LIGHT is sitting in a junction, where the ordinary rule applies instead:
  // straight, left or right, but no U-turn. Treating it as a driveway is what
  // made a car pulling away from a red able to go one way only.
  const car = carsState.find((t) => t.id === builder.truckId);
  const standing = builder.waypoints.length === 0 && !builder.entry;
  let leave = "junction";
  if (standing && car?.light == null) {
    // Parked at a kerb. Waiting mode lets you pull out either way — see
    // manualChoices — while the other modes keep the no-reversing rule.
    leave = isWaiting() ? "either" : "driveway";
  }
  const c = manualChoices(head.x, head.y, head.angle, leave);
  const called = new Set(builder.waypoints.filter((w) => w.kind === "spot").map((w) => w.index));
  c.spots = c.spots.filter(({ index }) => {
    if (car && car.spot != null && index === car.spot) return false;
    if (called.has(index)) return false; // already called there this trip
    return !carsState.some((t) => t.id !== builder.truckId && t.spot === index);
  });
  // Stop lights are NOT exclusive: a red holds up everyone who meets it, and
  // whether somebody else is already sat there is no business of yours. (Kerbs
  // still are — two cars can't take one parking space.)
  return c;
}

// Every rushing fare still sitting in the car. Each one buys the right to sail
// through one red — but only ON THE WAY TO THEM, which is enforced by builderCanGo.
function rushAboard() {
  return (myPlayer()?.passengers ?? []).filter((t) => !t.done && t.bonus === "rush");
}

// Reds this route actually goes THROUGH. Whether a red was CROSSED isn't a
// decision to be made at the light — it's just where the route ends up. Every
// red the route carries on past was crossed; a red at the very END is one the
// car is sitting on, and sitting on it is free. So clicking a red with a
// rushing fare aboard commits to nothing: press Go and you waited there, keep
// clicking and you ran it.
function builderRedsCrossed() {
  if (!builder) return 0;
  const last = builder.waypoints.length - 1;
  return builder.waypoints.filter((w, i) =>
    i !== last && w.kind === "oct" && mapState.intersections[w.index]?.color === "red").length;
}

// Is this the end of the drive? A kerb where somebody got out or an errand was
// run, or a red with no rushing fare left to wave you through it.
function builderStopsAt(w) {
  if (!w) return false;
  if (w.kind === "spot") return spotStops(w.index);
  return mapState?.intersections?.[w.index]?.color === "red" &&
    rushAboard().length <= builderRedsCrossed();
}

// Does stopping at this kerb let somebody out? A drop-off ends the drive.
function spotDelivers(index) {
  const bid = mapState?.spots?.[index]?.building;
  if (bid == null) return false;
  return (myPlayer()?.passengers ?? []).some((t) => !t.done && t.loc === bid);
}

// Would stopping here collect one of YOUR errands? Only during that district's
// own section of the day — the rest of the time the token just sits there.
function spotRunsErrand(index) {
  const bid = mapState?.spots?.[index]?.building;
  if (bid == null) return false;
  const b = buildingByBid(bid);
  if (!b || !(b.errands ?? []).includes(myIndex())) return false;
  return districtOf(b.district)?.section === sectionState;
}

// The three things that end a drive: somebody got out, you ran an errand, or a
// red stopped you. Pulling in anywhere else is just a pause — drive on. Under
// multi-move only the red is left: you can unload the whole car in one trip.
const spotStops = (index) =>
  !multiMoveState && (spotDelivers(index) || spotRunsErrand(index));

// GO is offered the moment there's anywhere to go — in waiting mode you stop
// where you like. The one catch is the rush rule: a route that ran a red is
// only legal if it finishes at a rushing passenger's address. The other modes
// need the car to have picked a kerb.
function builderCanGo() {
  if (!builder) return false;
  if (!isWaiting()) return builder.done;
  if (!builder.waypoints.length) return false;
  if (builderRedsCrossed() === 0) return true;
  const last = builder.waypoints[builder.waypoints.length - 1];
  if (last.kind !== "spot") return false;
  const bid = mapState?.spots?.[last.index]?.building;
  return rushAboard().some((t) => t.loc === bid);
}

function builderFullPath() {
  let pts = [];
  builder.waypoints.forEach((w, k) => {
    pts = pts.concat(k === 0 ? w.path : w.path.slice(1));
  });
  return pts;
}

function builderReds() {
  let n = 0;
  builder.waypoints.forEach((w) => {
    if (w.kind === "oct" && mapState.intersections[w.index]?.color === "red") n += 1;
  });
  return n;
}

function builderAddOct(index) {
  const choice = builder.choices.octs.find((c) => c.index === index);
  if (!choice) return;
  const wp = { kind: "oct", index, path: choice.path, endAngle: choice.endAngle };
  builder.waypoints.push(wp);
  // Waiting mode: a red is a wall, unless there's a rushing fare aboard to wave
  // you through. With one, the route stays open AND Go stays on offer — you
  // choose by what you do next, not by answering a question here.
  builder.done = isWaiting() && builderStopsAt(wp);
  builder.choices = builder.done ? { octs: [], spots: [] } : computeBuilderChoices();
  renderBuild();
}

function builderAddSpot(index) {
  const choice = builder.choices.spots.find((c) => c.index === index);
  if (!choice) return;
  // Whether this stop lets somebody out has to be read BEFORE the waypoint is
  // pushed, or nothing has changed yet anyway — but read it first for clarity.
  const stops = spotStops(index);
  builder.waypoints.push({ kind: "spot", index, path: choice.path, endAngle: choice.endAngle });
  // In waiting mode, pulling in somewhere that isn't a drop-off or an errand is
  // just a pause — the car drives on.
  if (isWaiting() && !stops) {
    builder.choices = computeBuilderChoices();
  } else {
    builder.done = true;
    builder.choices = { octs: [], spots: [] };
  }
  renderBuild();
}

function builderUndo() {
  if (!builder?.waypoints.length) return;
  builder.waypoints.pop();
  // Backing up onto a red you never had a pass for is still a stop; backing up
  // onto a drop-off is still the end of the drive.
  const last = builder.waypoints[builder.waypoints.length - 1];
  builder.done = isWaiting() && builderStopsAt(last);
  builder.choices = builder.done ? { octs: [], spots: [] } : computeBuilderChoices();
  renderBuild();
}

function builderRestart() {
  if (!builder) return;
  builder.waypoints = [];
  builder.done = false;
  builder.choices = computeBuilderChoices();
  renderBuild();
}

function builderGo() {
  if (!builderCanGo()) return;
  const last = builder.waypoints[builder.waypoints.length - 1];
  const path = builderFullPath();
  const truckId = builder.truckId;

  if (isWaiting()) {
    // The whole route matters, not just its end: every kerb it called at is a
    // stop, and it finishes at an address, at a drop-off, or on a light.
    const calls = builder.waypoints.filter((w) => w.kind === "spot").map((w) => w.index);
    const endSpot = last.kind === "spot" ? last.index : null;
    const endLight = last.kind === "oct" ? last.index : null;
    const visited = endSpot != null ? calls.slice(0, -1) : calls;
    // Read the reds BEFORE the builder is torn down.
    const crossed = builderRedsCrossed();
    pendingRoutes[truckId] = {
      key: endLight != null ? `l${endLight}` : `s${endSpot}`, path, endAngle: last.endAngle
    };
    builder = null;
    renderBuild();
    socket.emit("uber_mania_move_truck", {
      roomId: app.roomId, truckId, spot: endSpot, light: endLight, visited,
      reds: crossed,
      // The heading the route finished on. A car waiting at a light is drawn
      // backed up along it and pulls away along it next turn, so the server has
      // to be told — nothing else on the board records which way it's pointing.
      facing: last.endAngle
    });
    return;
  }

  const reds = Math.min(12, builderReds());
  pendingRoutes[truckId] = { key: `s${last.index}`, path, endAngle: last.endAngle };
  builder = null;
  renderBuild();
  socket.emit("uber_mania_move_truck", { roomId: app.roomId, truckId, spot: last.index, reds });
}

function refreshBuilder() {
  const car = myCar();
  const off = isOffBoard(car);
  // Waiting mode is builder-only: stopping at a red is a step-by-step decision,
  // and an auto route that can't know where it will be stopped is no use.
  const eligible =
    (moveMode === "build" || off || isWaiting()) &&
    isActive() && app.roomId && isMyTurn() && (!turnActed || turnCarryOn) && !turnDrew &&
    winnerState == null && car && !diceAnimating &&
    carAnim[car.id] == null && (off || carPos[car.id]);
  if (!eligible) {
    builder = null;
    renderBuild();
    return;
  }
  const baseKey = placeKeyOf(car);
  if (!builder || builder.truckId !== car.id || builder.baseSpot !== baseKey) {
    builder = {
      truckId: car.id,
      baseSpot: baseKey,
      entry: off,
      waypoints: [],
      done: false,
      choices: null
    };
    builder.choices = computeBuilderChoices();
  }
  renderBuild();
}

// Where to hang the GO badge. It used to sit dead ahead of the route's tip,
// which is exactly where the next kerb or stop light is — so GO covered the
// choice you wanted and swallowed the click, driving off instead of carrying
// on. That's felt worst in waiting mode, where GO is on offer from the first
// waypoint onward. Try a ring of placements and take the one furthest from
// anything still clickable, preferring the sides over straight ahead.
const GO_R = 26; // the badge is 48x26 — treat it as a disc for clearance
function goBadgePlace(end, angleDeg) {
  const spots = mapState.spots ?? [];
  const octs = mapState.intersections ?? [];
  const live = [
    ...(builder?.choices?.spots ?? []).map(({ index }) => ({ p: spots[index], r: 11 })),
    ...(builder?.choices?.octs ?? []).map(({ index }) => ({ p: octs[index], r: octRadius() }))
  ].filter((c) => c.p);
  const w = mapState.width ?? 960;
  const h = mapState.height ?? 720;
  // Sides first, then behind, then ahead — ahead is where the route is going.
  const turns = [90, -90, 135, -135, 180, 45, -45, 0];
  let best = null;
  turns.forEach((turn, k) => {
    for (const dist of [34, 48, 62]) {
      const rad = ((angleDeg + turn) * Math.PI) / 180;
      const x = Math.max(GO_R, Math.min(w - GO_R, end[0] + Math.cos(rad) * dist));
      const y = Math.max(14, Math.min(h - 14, end[1] + Math.sin(rad) * dist));
      let clear = Infinity;
      for (const c of live) clear = Math.min(clear, Math.hypot(c.p.x - x, c.p.y - y) - (GO_R + c.r));
      // Anything clear of every choice is good enough; among the rest take the
      // roomiest. The tiny per-preference nudge only breaks ties.
      const v = Math.min(clear, 0) - k * 0.01 - (dist - 34) * 0.02;
      if (!best || v > best.v) best = { x, y, v };
    }
  });
  return best ?? { x: end[0], y: end[1] };
}

function renderBuild() {
  const svg = els.gameBoard.querySelector(".tm-map");
  if (!svg) return;
  svg.querySelector(".tm-build")?.remove();
  svg.querySelectorAll(".tm-oct-choice").forEach((el) => el.classList.remove("tm-oct-choice"));
  svg.querySelectorAll(".tm-spot-choice").forEach((el) => el.classList.remove("tm-spot-choice"));
  svg.querySelectorAll(".tm-spot-picked").forEach((el) => el.classList.remove("tm-spot-picked"));
  svg.querySelectorAll(".ub-oct-wait").forEach((el) => el.classList.remove("ub-oct-wait"));
  if (!builder) {
    renderBuildPanel();
    return;
  }

  const color = myPlayer()?.color ?? "#3ac0c0";
  const layer = svgEl("g", { class: "tm-build" }, svg);

  const full = builderFullPath();
  if (full.length >= 2) {
    const dressed = dressPath(full);
    svgEl("polyline", { points: polylineStr(dressed), class: "tm-build-line", stroke: color }, layer);
    drawChevrons(layer, dressed, color);
    const end = dressed[dressed.length - 1];
    const cum = cumLengths(dressed);
    const tip = sampleAlong(dressed, cum, Math.max(0, cum[cum.length - 1] - 0.5));
    const g = svgEl("g", {
      class: "tm-build-arrow",
      transform: `translate(${r1(end[0])} ${r1(end[1])}) rotate(${Math.round(tip.angle)})`
    }, layer);
    svgEl("polygon", {
      points: "-2,-6.5 11,0 -2,6.5",
      fill: color,
      stroke: "rgba(18,22,28,0.6)",
      "stroke-width": 1
    }, g);
  }

  // Mark every kerb the route calls at — in waiting mode there can be several,
  // and each is a drop-off rather than the end of the trip.
  builder.waypoints.forEach((w) => {
    if (w.kind === "spot") {
      svg.querySelector(`.tm-spot[data-spot="${w.index}"]`)?.classList.add("tm-spot-picked");
    }
  });
  // The red that stopped you, wearing the fact that it did.
  const last = builder.waypoints[builder.waypoints.length - 1];
  const sitting = isWaiting() && last?.kind === "oct" &&
    mapState.intersections[last.index]?.color === "red";
  if (sitting) octEls[last.index]?.g.classList.add("ub-oct-wait");

  if (builderCanGo() && full.length >= 2) {
    const dressed = dressPath(full);
    const end = dressed[dressed.length - 1];
    const cum = cumLengths(dressed);
    const tip = sampleAlong(dressed, cum, Math.max(0, cum[cum.length - 1] - 0.5));
    const { x: gx, y: gy } = goBadgePlace(end, tip.angle);
    const go = svgEl("g", { class: "ub-go", transform: `translate(${r1(gx)} ${r1(gy)})` }, layer);
    svgEl("rect", { x: -24, y: -13, width: 48, height: 26, rx: 13, stroke: color, class: "ub-go-bg" }, go);
    const t = svgEl("text", { x: 0, y: 1, class: "ub-go-text" }, go);
    t.textContent = "GO";
    go.addEventListener("click", (e) => {
      e.stopPropagation();
      builderGo();
    });
  }
  // Waiting mode offers GO and the next step at once — you stop when you choose
  // to. The other modes are done the moment they've picked a kerb.
  if (!builder.done) {
    builder.choices.octs.forEach((c) => octEls[c.index]?.g.classList.add("tm-oct-choice"));
    builder.choices.spots.forEach((c) =>
      svg.querySelector(`.tm-spot[data-spot="${c.index}"]`)?.classList.add("tm-spot-choice"));
  }
  renderBuildPanel();
}

// The builder's controls live in the bottom-right action bar.
function renderBuildPanel() {
  const slot = ensureActionBar()?.querySelector(".ub-actions-build");
  if (!slot) return;
  slot.innerHTML = "";
  if (!builder) return;

  if (isWaiting()) {
    // No dice to bank here. What a rushing fare buys is the right to run a red
    // ON THE WAY TO THEM — so once you've run one, the route is stuck until it
    // reaches one of their addresses, and the note has to say so.
    const note = document.createElement("span");
    note.className = "ub-build-note";
    const rush = rushAboard();
    const crossed = builderRedsCrossed();
    const last = builder.waypoints[builder.waypoints.length - 1];
    const onRed = last?.kind === "oct" && mapState.intersections[last.index]?.color === "red";
    if (crossed > 0 && !builderCanGo()) {
      note.textContent = "😡 Ran a red — finish at a rush fare";
      note.classList.add("ub-build-note-stop");
    } else if (onRed && !builder.done) {
      // Sitting on it and running it are both still open — Go waits here, and
      // carrying on spends the rushing fare's pass.
      note.textContent = "Go to wait here, or drive on to a rush fare";
      note.classList.add("ub-build-note-free");
    } else if (builder.done && last?.kind === "oct") {
      note.textContent = "Stopping at the red";
      note.classList.add("ub-build-note-stop");
    } else if (builder.done) {
      note.textContent = last?.kind === "spot" && spotDelivers(last.index)
        ? "Dropping off — that ends the drive"
        : "Errand run — that ends the drive";
      note.classList.add("ub-build-note-free");
    } else if (rush.length > crossed) {
      note.textContent = `😡 ${rush.length - crossed} red free, to reach them`;
      note.classList.add("ub-build-note-free");
    } else {
      note.textContent = "Next red stops you";
    }
    slot.appendChild(note);
  } else {
    const dice = document.createElement("span");
    dice.className = "tm-build-dice";
    const reds = builderReds();
    for (let i = 0; i < Math.min(12, reds); i += 1) {
      const d = document.createElement("span");
      d.className = "tm-build-die";
      dice.appendChild(d);
    }
    slot.appendChild(dice);
  }

  // A GO here as well as on the map: the badge floats near the route's tip and
  // can always end up somewhere awkward, and there has to be one place to
  // commit a route that nothing can ever sit on top of.
  const goBtn = button("Go", "");
  goBtn.className += " ub-go-btn";
  goBtn.disabled = !builderCanGo();
  goBtn.addEventListener("click", builderGo);
  slot.appendChild(goBtn);

  const undoBtn = button("Undo", "");
  undoBtn.disabled = !builder.waypoints.length;
  undoBtn.addEventListener("click", builderUndo);
  slot.appendChild(undoBtn);

  const restartBtn = button("Restart", "");
  restartBtn.disabled = !builder.waypoints.length;
  restartBtn.addEventListener("click", builderRestart);
  slot.appendChild(restartBtn);
}

// ---------------------------------------------------------------------------
// Spots + board clicks
// ---------------------------------------------------------------------------

function renderSpots(svg) {
  const layer = svgEl("g", { class: "tm-spots" }, svg);
  (mapState.spots ?? []).forEach((spot, i) => {
    const g = svgEl("g", { class: "tm-spot", "data-spot": i }, layer);
    svgEl("circle", { cx: spot.x, cy: spot.y, r: 9, class: "tm-spot-ring" }, g);
    svgEl("circle", { cx: spot.x, cy: spot.y, r: 11, class: "tm-spot-hit", fill: "transparent" }, g);
  });
}

function onBoardClick(event) {
  if (!app.roomId || !isMyTurn() || winnerState != null || diceAnimating || anyCarAnimating()) return;

  // Build mode (and every off-board entry): clicks grow the route.
  if (builder) {
    if (turnActed && !turnCarryOn) return;
    const octG = event.target.closest?.(".tm-oct");
    if (octG && octG.dataset.oct != null) {
      const i = Number(octG.dataset.oct);
      if (!builder.done && builder.choices.octs.some((c) => c.index === i)) builderAddOct(i);
      return;
    }
    const spotEl = event.target.closest?.(".tm-spot");
    if (spotEl && !builder.done) {
      const i = Number(spotEl.dataset.spot);
      if (builder.choices.spots.some((c) => c.index === i)) builderAddSpot(i);
    }
    return;
  }

  // Auto mode: click a parking spot to see the route(s), click a route to take it.
  const routeEl = event.target.closest?.(".tm-route-hit");
  if (routeEl) {
    commitRoute(Number(routeEl.dataset.route));
    return;
  }
  if (turnActed || turnDrew) {
    clearPreview();
    return;
  }
  const spotEl = event.target.closest?.(".tm-spot");
  if (!spotEl) {
    clearPreview();
    return;
  }
  const spotIdx = Number(spotEl.dataset.spot);
  if (carsState.some((t) => t.id !== activeTruckId() && t.spot === spotIdx)) {
    clearPreview();
    return;
  }
  previewTo(spotIdx);
}

// ---------------------------------------------------------------------------
// Scoreboard
// ---------------------------------------------------------------------------

function renderScoreboard() {
  const slot = railSlot("scores");
  slot.innerHTML = "";
  if (!playersState.length) return;
  const bar = document.createElement("div");
  bar.className = "tm-scoreboard ub-scoreboard";
  playersState.forEach((p, i) => {
    const chip = document.createElement("div");
    chip.className = "tm-score ub-score";
    chip.dataset.player = i;
    chip.style.setProperty("--pcolor", p.color);
    if (winnerState != null && (resultsState?.winners ?? [winnerState]).includes(i)) {
      chip.classList.add("tm-score-winner");
    }
    if (winnerState == null && turnWhose === i) chip.classList.add("tm-score-turn");

    const dot = document.createElement("span");
    dot.className = "tm-score-dot";
    dot.style.background = p.color;
    chip.appendChild(dot);

    const nm = document.createElement("span");
    nm.className = "ub-score-name";
    nm.textContent = p.name ?? seatName(i);
    chip.appendChild(nm);

    // A chip says WHO, and how their errands are going. Points, rating, rides
    // and tips are all deliberately absent: the rating column beside the clock
    // already carries the stars, and the rest is running-total bookkeeping that
    // nobody needs at a glance. It's all still one hover away, in the peek card.
    if (hasErrands()) chip.appendChild(errandPile(p, i));

    chip.appendChild(playerPeek(p, i));
    chip.classList.add("ub-score-hover");

    const garage = carsState.filter((t) => t.player === i && t.spot == null);
    if (garage.length) {
      const g = document.createElement("div");
      g.className = "tm-score-garage";
      garage.forEach(() => {
        const svg = svgEl("svg", { viewBox: "-17 -13 34 24", class: "tm-garage-truck" });
        makeCarShape(svg, p.color);
        g.appendChild(svg);
      });
      chip.appendChild(g);
    }
    bar.appendChild(chip);
  });
  slot.appendChild(bar);
}

// The errand discs a driver has picked up off the board, stacked in front of
// them. In dice mode each one still out there is worth −2 at the end; in
// waiting mode the ones you GOT pay off a rising ladder. Either way the empty
// space in the pile is the message as much as the discs are.
function errandPile(p, seat) {
  const done = p.errandsDone ?? 0;
  const left = (p.errands ?? []).length;
  const wrap = document.createElement("span");
  wrap.className = "ub-discs";
  for (let i = 0; i < done; i += 1) {
    const disc = document.createElement("span");
    disc.className = "ub-disc";
    disc.style.background = p.color;
    wrap.appendChild(disc);
  }
  for (let i = 0; i < left; i += 1) {
    const gap = document.createElement("span");
    gap.className = "ub-disc ub-disc-open";
    wrap.appendChild(gap);
  }
  wrap.title = isWaiting()
    ? `${seatName(seat)} has collected ${done} errand disc${done === 1 ? "" : "s"} — worth ${errandLadder(done)} at the end${left ? `, ${errandLadder(done + left)} for all ${done + left}` : ""}`
    : left
      ? `${seatName(seat)} has collected ${done} errand disc${done === 1 ? "" : "s"}; ${left} still on the board, worth −${left * (settingsState?.errandPenalty ?? 2)} at the end`
      : `${seatName(seat)} has collected every errand disc`;
  if (!left && done) wrap.classList.add("ub-discs-full");
  return wrap;
}

// Everything about a driver you have to hover for: home district, stones,
// errands left, rides per district and how full their car is.
function playerPeek(p, seat) {
  const card = document.createElement("div");
  card.className = "ub-peek";

  const head = document.createElement("div");
  head.className = "ub-peek-head";
  const home = districtOf(p.home);
  head.innerHTML = "";
  const swatch = document.createElement("span");
  swatch.className = "ub-peek-swatch";
  swatch.style.background = p.color;
  head.appendChild(swatch);
  const title = document.createElement("strong");
  // Static mode has no home district, so the driver is just a driver.
  title.textContent = isStatic()
    ? p.name ?? seatName(seat)
    : `${p.name ?? seatName(seat)} — ${home?.name ?? "?"}`;
  // In waiting mode the home district pays nothing — it's only the color of
  // your car — so it's labelled rather than presented as a prize.
  if (isWaiting()) title.textContent += " (home)";
  head.appendChild(title);
  card.appendChild(head);

  // The chips themselves only carry a name and an errand pile now, so this card
  // is where every running total lives.
  const rows = [
    ["Time stones", `⬟ ${p.timeStones ?? 0}`],
    ["Rating", `${num(p.rating ?? 0)} ★`],
    ["Day points", String(p.points ?? 0)],
    ["Passengers", `${(p.passengers ?? []).length}/${maxPassengers()}`],
    ["Rides done", String(p.ridesCompleted ?? 0)]
  ];
  if (queueMode()) rows.push(["Tips banked", String(p.tipsDelivered ?? 0)]);
  rows.push(hasErrands()
    ? ["Errands left", String((p.errands ?? []).length)]
    : ["Reached over", String(p.skipped ?? 0)]);
  const grid = document.createElement("div");
  grid.className = "ub-peek-grid";
  rows.forEach(([k, v]) => {
    const a = document.createElement("span");
    a.className = "ub-peek-k";
    a.textContent = k;
    const b = document.createElement("span");
    b.className = "ub-peek-v";
    b.textContent = v;
    grid.append(a, b);
  });
  card.appendChild(grid);

  // Rides per district — the all-six bonus and the regular bonus both read off
  // this, so it's worth being able to see at a glance.
  const spread = document.createElement("div");
  spread.className = "ub-peek-spread";
  districtsState.forEach((d) => {
    const cell = document.createElement("span");
    cell.className = "ub-peek-cell";
    const n = p.ridesByDistrict?.[d.id] ?? 0;
    cell.style.setProperty("--dcolor", d.color);
    cell.textContent = String(n);
    // Only dice mode waives the regular bonus in your own district — the queue
    // modes count it everywhere, so the mark has to follow the scoring.
    const isHome = hasErrands() && d.id === p.home;
    const counts = queueMode() || d.id !== p.home;
    if (n > 0) cell.classList.add("ub-peek-cell-on");
    if (counts && n >= 3) cell.classList.add("ub-peek-cell-regular");
    if (isHome) cell.classList.add("ub-peek-cell-home");
    cell.title = `${d.name}${isHome ? " (home)" : ""} — ${n} ride${n === 1 ? "" : "s"}`;
    spread.appendChild(cell);
  });
  card.appendChild(spread);
  return card;
}

// ---------------------------------------------------------------------------
// The tray: the two tile piles and this player's passenger board. It sits at
// the foot of the right rail, right above Leave Game — the place a player's own
// board belongs. Errands aren't listed here at all: the discs live on the map
// (that's where you go and get them) and the ones you've collected pile up on
// your scoreboard chip.
// ---------------------------------------------------------------------------

function canDrawTile() {
  return isMyTurn() && winnerState == null && !turnActed && !turnDrew &&
    // Waiting mode lets the clock and a passenger share a turn.
    (isWaiting() || !turnChangedTime) &&
    turnTruck == null && !diceAnimating && !anyCarAnimating() &&
    (myPlayer()?.passengers?.length ?? 0) < maxPassengers();
}

// Static mode: is this pile's rating requirement met? (Server: pileLocked.)
function pileLocked(pile) {
  return queueMode() && (myPlayer()?.rating ?? 0) < (pile?.need ?? 0);
}

// Your time stones, standing to the left of the seats. They're the only thing
// you spend, and in waiting mode they're the only way to turn a red green — so
// the count belongs on the mat, not buried in a hover.
function stonesBadge(player) {
  const n = player?.timeStones ?? 0;
  const el = document.createElement("div");
  el.className = "ub-stones";
  const icon = document.createElement("span");
  icon.className = "ub-stones-icon";
  icon.textContent = "⬟";
  const count = document.createElement("span");
  count.className = "ub-stones-count";
  count.textContent = String(n);
  el.append(icon, count);
  el.title = `${n} time stone${n === 1 ? "" : "s"} — one per hour you push the clock forward`;
  if (n <= 1) el.classList.add("ub-stones-low");
  return el;
}

// Beside your own mat: every fare you've delivered, as a swatch in the color of
// the district it went to — so the two spread bonuses (a ride in all six, three
// rides for a regular) are something you can SEE rather than count. The tips you
// hold ride along at the bottom, since what they're worth depends on the stars
// you finish with.
function deliveryPeek(player) {
  const wrap = document.createElement("span");
  wrap.className = "ub-mine";
  const total = player?.ridesCompleted ?? 0;
  const label = document.createElement("span");
  label.className = "ub-mine-label";
  label.textContent = `🚕 ${total}`;
  wrap.appendChild(label);

  const card = document.createElement("div");
  card.className = "ub-mine-card";
  const head = document.createElement("div");
  head.className = "ub-mine-head";
  head.textContent = total
    ? `${total} fare${total === 1 ? "" : "s"} delivered`
    : "No fares delivered yet";
  card.appendChild(head);

  const grid = document.createElement("div");
  grid.className = "ub-mine-grid";
  districtsState.forEach((d) => {
    const n = player?.ridesByDistrict?.[d.id] ?? 0;
    const name = document.createElement("span");
    name.className = n ? "ub-mine-name" : "ub-mine-name ub-mine-none";
    name.textContent = d.name;
    const dots = document.createElement("span");
    dots.className = "ub-mine-dots";
    for (let i = 0; i < n; i += 1) {
      const s = document.createElement("span");
      s.className = "ub-mine-dot";
      s.style.background = d.color;
      dots.appendChild(s);
    }
    // The regular bonus wants three, so show what's still missing.
    for (let i = n; i < 3; i += 1) {
      const s = document.createElement("span");
      s.className = "ub-mine-dot ub-mine-dot-open";
      dots.appendChild(s);
    }
    if (n >= 3) dots.classList.add("ub-mine-regular");
    grid.append(name, dots);
  });
  card.appendChild(grid);

  if (queueMode()) {
    const tips = document.createElement("div");
    tips.className = "ub-mine-tips";
    const n = player?.tipsDelivered ?? 0;
    tips.textContent = n
      ? `${BONUS_ICON.tip} ${n} tip${n === 1 ? "" : "s"} — ${n} × your full stars at the end`
      : `${BONUS_ICON.tip} No tip fares delivered yet`;
    card.appendChild(tips);
  }
  wrap.appendChild(card);
  wrap.title = "Hover: every fare you've delivered, by district";
  return wrap;
}

// A tile — a pile's back or a passenger on your board — wears exactly the paint
// its district's lots wear, so you can carry the color from your hand to the map
// by eye.
function paintTile(el, color) {
  const base = color ?? "#8d867b";
  el.style.setProperty("--tile", lotFill(base));
  el.style.setProperty("--tile-edge", lotEdge(base));
}

function renderTray() {
  const slot = railSlot("tray");
  slot.innerHTML = "";
  if (!playersState.length) return;
  const player = myPlayer();
  const wrap = document.createElement("div");
  wrap.className = "ub-tray";

  // --- the two piles ---
  const piles = document.createElement("div");
  piles.className = "ub-piles";
  const pilesTitle = document.createElement("div");
  pilesTitle.className = "ub-tray-title";
  pilesTitle.textContent = "PASSENGERS";
  // Waiting mode deals from ONE deck into three slots, so the count belongs to
  // the row rather than to any slot in it.
  if (isWaiting() && deckLeftState != null) {
    const left = document.createElement("span");
    left.className = "ub-deck-left";
    left.textContent = `deck ${deckLeftState}`;
    left.title = pilesState.length > MIN_SLOTS
      ? "Take a slot and the ones above it slide down; a fresh tile comes off the deck into the dearest slot"
      : "Take a slot and it's refilled off the deck where it stands — the other one is left alone";
    pilesTitle.appendChild(left);
  }
  piles.appendChild(pilesTitle);
  const pileRow = document.createElement("div");
  pileRow.className = "ub-pile-row";
  const drawable = canDrawTile();
  if (pilesState.length > 2) pileRow.classList.add("ub-pile-row-three");
  pilesState.forEach((pile, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ub-pile";
    // A slot your rating can't open looks EXACTLY like one it can — the board
    // doesn't tell you what you may pick up any more than a wooden table would.
    // The star it asks for is printed on its face and that is the whole hint.
    // So no dimming and no disabled attribute (which dims it too); the click
    // just doesn't do anything, and the server refuses it as well.
    const locked = pileLocked(pile);
    if (!pile.left || !drawable) btn.classList.add("ub-pile-off");
    btn.disabled = !pile.left || !drawable;
    if (pile.top) {
      const d = districtOf(pile.top.district);
      paintTile(btn, d?.color);
      const sym = document.createElement("span");
      sym.className = "ub-pile-sym";
      sym.textContent = BONUS_ICON[pile.top.bonus] ?? "?";
      btn.appendChild(sym);
      const label = document.createElement("span");
      label.className = "ub-pile-label";
      label.textContent = d?.name ?? "";
      btn.appendChild(label);
      const kind = BONUS_NAME[pile.top.bonus];
      btn.title = locked
        ? `${kind ?? "A fare"} into ${d?.name ?? "a district"} — but this slot only deals at ${num(pile.need)} stars, and you have ${num(myPlayer()?.rating ?? 0)}.`
        : `Top of pile ${i + 1}: ${kind ? `a ${kind.toLowerCase()} fare` : "a fare"} into ${d?.name ?? "a district"} — ${BONUS_TEXT[pile.top.bonus] ?? ""}. Taking it is your whole turn.`;
    } else {
      btn.classList.add("ub-pile-empty");
      btn.textContent = "empty";
      btn.title = "This pile is finished";
    }
    // The stack depth is only a thing when the slot IS a stack.
    if (!isWaiting()) {
      const count = document.createElement("span");
      count.className = "ub-pile-count";
      count.textContent = String(pile.left);
      btn.appendChild(count);
    }
    // The rating each pile asks for, worn on its face — the better fares are
    // behind a rating you have to have earned first.
    if (queueMode()) {
      const need = document.createElement("span");
      need.className = "ub-pile-need";
      // Nothing on the first slot: a slot with no rating on it is open, and
      // saying so is noise.
      if (pile.need) {
        need.textContent = `${num(pile.need)}★`;
        btn.appendChild(need);
      }
    }
    btn.addEventListener("click", () => {
      if (btn.disabled || locked || !app.roomId) return;
      socket.emit("uber_mania_draw_tile", { roomId: app.roomId, pile: i });
    });
    pileRow.appendChild(btn);
  });
  piles.appendChild(pileRow);
  wrap.appendChild(piles);

  // --- the passenger board ---
  const board = document.createElement("div");
  board.className = "ub-board";
  const boardTitle = document.createElement("div");
  boardTitle.className = "ub-tray-title";
  boardTitle.textContent = queueMode() ? "YOUR QUEUE" : "YOUR BOARD";
  boardTitle.appendChild(deliveryPeek(player));
  board.appendChild(boardTitle);
  if (queueMode()) {
    buildQueue(board, player);
    wrap.appendChild(board);
    slot.appendChild(wrap);
    return;
  }
  const row = document.createElement("div");
  row.className = "ub-board-row";
  row.appendChild(stonesBadge(player));

  const bySlot = new Map((player?.passengers ?? []).map((t) => [t.slot, t]));
  BOARD_NUMBERS.forEach((n, slotIdx) => {
    const cell = document.createElement("div");
    cell.className = "ub-slot";
    const tile = bySlot.get(slotIdx);
    if (tile) {
      const d = districtOf(tile.district);
      const dest = buildingByBid(tile.loc);
      cell.classList.add("ub-slot-filled");
      paintTile(cell, d?.color);
      if (tile.done) cell.classList.add("ub-slot-done");
      const top = document.createElement("div");
      top.className = "ub-slot-top";
      top.textContent = `${BONUS_ICON[tile.bonus] ?? ""} ${d?.name ?? ""}`;
      const pic = document.createElement("div");
      pic.className = "ub-slot-emoji";
      pic.textContent = dest?.emoji ?? "📍";
      const name = document.createElement("div");
      name.className = "ub-slot-dest";
      name.textContent = dest?.name ?? "…";
      cell.append(top, pic, name);
      cell.title = tile.done
        ? `Delivered — ${dest?.name ?? ""}. The tile comes off once this turn's dice are thrown, which is why ${n} is still covered.`
        : `Fare to ${dest?.name ?? "?"} in ${d?.name ?? "?"} — ${BONUS_TEXT[tile.bonus] ?? ""}. It sits on ${n}, so ${n} is not safe on the dice.`;
    } else {
      const digit = document.createElement("span");
      digit.className = "ub-slot-num";
      digit.textContent = String(n);
      cell.appendChild(digit);
      cell.title = `${n} is showing — a die that lands on it is safe`;
    }
    row.appendChild(cell);
  });

  // The bare 6: no square, and nothing can ever cover it.
  const free = document.createElement("div");
  free.className = "ub-free";
  const freeNum = document.createElement("span");
  freeNum.className = "ub-slot-num";
  freeNum.textContent = String(FREE_NUMBER);
  free.appendChild(freeNum);
  free.title = "The 6 has no square — it is always showing, whatever you're carrying";
  row.appendChild(free);
  board.appendChild(row);

  const showing = showingFor(player);
  const hint = document.createElement("div");
  hint.className = "ub-board-hint";
  hint.textContent = `Safe rolls: ${showing.join(", ")}`;
  hint.title = "Every red light you run throws a die. A die is safe only on a number still showing; anything else costs half a star.";
  if (showing.length <= 2) hint.classList.add("ub-board-hint-hot");
  board.appendChild(hint);
  wrap.appendChild(board);

  slot.appendChild(wrap);
}

// The queue modes' board: four places in a line, and the line is the rule. The
// leftmost is the priority fare — deliver that one and you gain a star; deliver
// anyone else and it costs half a star for every head you reached over. Each
// tile wears what delivering it would do, because that number is the whole
// decision and it changes every time the queue closes up.
function buildQueue(board, player) {
  const held = [...(player?.passengers ?? [])].sort((a, b) => a.slot - b.slot);
  const row = document.createElement("div");
  row.className = "ub-board-row ub-queue-row";
  row.appendChild(stonesBadge(player));

  for (let i = 0; i < maxPassengers(); i += 1) {
    const cell = document.createElement("div");
    cell.className = "ub-slot ub-queue-slot";
    if (i === 0) cell.classList.add("ub-queue-first");
    const tile = held[i];
    if (!tile) {
      cell.classList.add("ub-queue-empty");
      cell.title = i === 0
        ? "Empty — the next fare you take becomes the priority"
        : "Empty — a fare taken now joins the back of the queue here";
      row.appendChild(cell);
      continue;
    }
    const d = districtOf(tile.district);
    const dest = buildingByBid(tile.loc);
    cell.classList.add("ub-slot-filled");
    paintTile(cell, d?.color);
    if (tile.done) cell.classList.add("ub-slot-done");

    // Five tiles have to fit where four did, so the district's NAME comes off
    // the queue tile — its color already says which one, and the address is the
    // thing you're actually hunting for.
    const kindIcon = document.createElement("div");
    kindIcon.className = "ub-queue-kind";
    kindIcon.textContent = BONUS_ICON[tile.bonus] ?? "";
    const pic = document.createElement("div");
    pic.className = "ub-slot-emoji";
    pic.textContent = dest?.emoji ?? "📍";
    const name = document.createElement("div");
    name.className = "ub-slot-dest";
    name.textContent = dest?.name ?? "…";

    const delta = slotStarDelta(i);
    const tag = document.createElement("div");
    tag.className = `ub-queue-tag${delta >= 0 ? " ub-queue-tag-good" : " ub-queue-tag-bad"}`;
    tag.textContent = starDeltaText(delta);
    cell.append(kindIcon, pic, name, tag);

    const kind = BONUS_NAME[tile.bonus];
    const reach = i === 0
      ? `They're at the front of the queue, so dropping them off is ${priorityStarState === 1 ? "a whole star" : "half a star"}.`
      : `Dropping them off means reaching over ${i} passenger${i === 1 ? "" : "s"} — ${num(i * SKIP_STAR_STEP)} stars off.`;
    cell.title = tile.done
      ? `Delivered — ${dest?.name ?? ""}. The queue closes up when you end your turn.`
      : `${kind ?? "Fare"} to ${dest?.name ?? "?"} in ${d?.name ?? "?"} — ${BONUS_TEXT[tile.bonus] ?? ""}. ${reach}`;
    row.appendChild(cell);
  }
  board.appendChild(row);

  const hint = document.createElement("div");
  hint.className = "ub-board-hint";
  const riding = held.filter((t) => !t.done).length;
  const rush = held.filter((t) => t.bonus === "rush" && !t.done).length;
  if (isWaiting()) {
    // Nothing is billed in waiting mode — the two things that can cost you a
    // star are the queue and an errand run with a full car.
    hint.textContent = riding
      ? `An errand now costs ${num(riding * SKIP_STAR_STEP)}★ — ${riding} aboard`
      : "Empty car: errands are free right now";
    hint.title = "Running one of your errands annoys everybody still riding: half a star each. Red lights cost nothing here — they just stop you.";
    if (riding >= 3) hint.classList.add("ub-board-hint-hot");
    else if (!riding) hint.classList.add("ub-board-hint-good");
    board.appendChild(hint);
    return;
  }
  // The running bill only means anything on your own turn.
  const reds = isMyTurn() ? dicePoolState : 0;
  const free = held.filter((t) => t.bonus === "rush" && t.done).length;
  const charged = Math.max(0, reds - free);
  hint.textContent = reds > 0
    ? `${reds} red${reds === 1 ? "" : "s"} run${free ? `, ${free} waved through` : ""} — −${charged * RED_STAR_COST}★ at end of turn`
    : rush
    ? `${rush} rush fare${rush === 1 ? "" : "s"} aboard — each waves one red through`
    : "Every red light is a whole star. Left is priority.";
  hint.title = "Reds are charged when you end your turn. Each rush passenger you drop off that turn forgives one of them.";
  if (charged > 0) hint.classList.add("ub-board-hint-hot");
  board.appendChild(hint);
}

// ---------------------------------------------------------------------------
// Dice
// ---------------------------------------------------------------------------

const DIE_PIPS = {
  1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8]
};

function makeDieEl(d, settled, safeSet) {
  const die = document.createElement("div");
  if (!settled) die.className = "tm-die tm-die-rolling";
  else die.className = `tm-die ${safeSet.has(d) ? "tm-die-safe" : "tm-die-ticket"}`;
  (DIE_PIPS[d] ?? []).forEach((pos) => {
    const pip = document.createElement("span");
    pip.className = "tm-pip";
    pip.style.gridArea = `${Math.floor(pos / 3) + 1} / ${(pos % 3) + 1}`;
    die.appendChild(pip);
  });
  return die;
}

function setDiceHead(head, roll, settled) {
  const who = seatName(roll.player);
  head.className = "tm-dice-head";
  if (!settled) {
    head.textContent = `${who} rolling…`;
    return;
  }
  if (roll.fails > 0) {
    head.textContent = `${who}: missed ×${roll.fails} — −${num(roll.fails * 0.5)}★`;
    head.classList.add("tm-dice-bad");
  } else {
    head.textContent = `${who}: all safe`;
    head.classList.add("tm-dice-good");
  }
}

function setDiceFaces(row, faces, settled, safeSet) {
  row.innerHTML = "";
  faces.forEach((d) => row.appendChild(makeDieEl(d, settled, safeSet)));
}

function renderDicePanel(roll, faces, settled, big = false) {
  const slot = railSlot("dice");
  slot.innerHTML = "";
  if (!roll || !faces?.length) return;
  const safeSet = new Set(roll.showing ?? []);

  const wrap = document.createElement("div");
  wrap.className = `tm-dice ub-dice${big ? " tm-dice-big" : ""}`;
  const head = document.createElement("div");
  setDiceHead(head, roll, settled);
  wrap.appendChild(head);

  const row = document.createElement("div");
  row.className = "tm-dice-row";
  setDiceFaces(row, faces, settled, safeSet);
  wrap.appendChild(row);

  const sub = document.createElement("div");
  sub.className = "ub-dice-sub";
  sub.textContent = `showing ${(roll.showing ?? []).join(", ")}`;
  wrap.appendChild(sub);

  slot.appendChild(wrap);
}

function renderDice() {
  if (diceAnimating) return;
  if (queueMode()) {
    renderTollPanel(lastTollState);
    return;
  }
  const roll = lastRollState;
  if (!roll || !roll.dice?.length) {
    railSlot("dice").innerHTML = "";
    return;
  }
  renderDicePanel(roll, roll.dice, true);
}

// Static mode's stand-in for the dice: nothing is rolled, so this is just the
// bill for the reds that turn — how many were run, how many a rush passenger
// waved through, and what it cost.
function renderTollPanel(toll, big = false) {
  const slot = railSlot("dice");
  slot.innerHTML = "";
  if (!toll || !toll.reds) return;
  const wrap = document.createElement("div");
  wrap.className = `tm-dice ub-dice ub-toll${big ? " tm-dice-big" : ""}`;

  const head = document.createElement("div");
  head.className = `tm-dice-head ${toll.charged > 0 ? "tm-dice-bad" : "tm-dice-good"}`;
  head.textContent = toll.charged > 0
    ? `${seatName(toll.player)}: ran ${toll.reds} red${toll.reds === 1 ? "" : "s"} — −${num(toll.charged * RED_STAR_COST)}★`
    : `${seatName(toll.player)}: waved through`;
  wrap.appendChild(head);

  const row = document.createElement("div");
  row.className = "ub-toll-row";
  for (let i = 0; i < toll.reds; i += 1) {
    const light = document.createElement("span");
    // The forgiven ones are the last off the bill, so they read as the ones
    // the rush passengers covered.
    light.className = i < toll.charged ? "ub-toll-light" : "ub-toll-light ub-toll-free";
    light.textContent = i < toll.charged ? "●" : "😡";
    row.appendChild(light);
  }
  wrap.appendChild(row);

  const sub = document.createElement("div");
  sub.className = "ub-dice-sub";
  sub.textContent = toll.forgiven
    ? `${toll.forgiven} forgiven by rush fares`
    : "a whole star per red";
  wrap.appendChild(sub);

  slot.appendChild(wrap);
}

// The toll has no roll to watch, so it just lands and then flashes the loss on
// the driver's chip the same way a bad roll does.
function showToll(toll, onDone) {
  renderTollPanel(toll, true);
  if (toll.charged > 0) {
    setTimeout(() => flashLoss(toll.player, toll.charged * RED_STAR_COST), 200 / speedMult);
  }
  setTimeout(() => {
    els.gameBoard.querySelector(".tm-dice")?.classList.remove("tm-dice-big");
    onDone();
  }, (toll.charged > 0 ? 1900 : 1000) / speedMult);
}

function animateDiceRoll(roll, onDone) {
  const n = roll.dice.length;
  const safeSet = new Set(roll.showing ?? []);
  const rnd = () => Array.from({ length: n }, () => 1 + Math.floor(Math.random() * 6));
  renderDicePanel(roll, rnd(), false, true);
  const wrap = els.gameBoard.querySelector(".tm-dice");
  const head = wrap?.querySelector(".tm-dice-head");
  const row = wrap?.querySelector(".tm-dice-row");
  let elapsed = 0;
  const iv = setInterval(() => {
    elapsed += 90;
    if (elapsed < 1300 / speedMult) {
      if (row) setDiceFaces(row, rnd(), false, safeSet);
    } else {
      clearInterval(iv);
      if (row) setDiceFaces(row, roll.dice, true, safeSet);
      if (head) setDiceHead(head, roll, true);
      const hasLoss = roll.fails > 0;
      if (hasLoss) setTimeout(() => flashLoss(roll.player, roll.fails * 0.5), 250 / speedMult);
      setTimeout(() => {
        els.gameBoard.querySelector(".tm-dice")?.classList.remove("tm-dice-big");
        onDone();
      }, (hasLoss ? 2100 : 900) / speedMult);
    }
  }, 90);
}

function flashLoss(seat, stars) {
  const amount = `−${num(stars)}★`;
  const wrap = els.gameBoard.querySelector(".tm-dice");
  if (wrap) {
    const loss = document.createElement("div");
    loss.className = "tm-dice-loss";
    loss.textContent = amount;
    wrap.appendChild(loss);
    setTimeout(() => loss.remove(), 1900);
  }
  const chip = document.querySelector(`.tm-scoreboard .tm-score[data-player="${seat}"]`);
  if (chip) {
    chip.classList.add("tm-score-hit");
    const f = document.createElement("span");
    f.className = "tm-score-float";
    f.textContent = amount;
    chip.appendChild(f);
    setTimeout(() => {
      chip.classList.remove("tm-score-hit");
      f.remove();
    }, 1700);
  }
}

// The fun die: a driving turn that ran no reds gets one of two faces.
const FUN_FACE = {
  stones: { icon: "⬟", text: "Fun die: 2 time stones" },
  star: { icon: "⭐", text: "Fun die: half a star" }
};

function showFunRoll(roll) {
  document.querySelector(".ub-fun")?.remove();
  const face = FUN_FACE[roll.face];
  if (!face) return;
  const el = document.createElement("div");
  el.className = "ub-fun";
  const who = document.createElement("span");
  who.className = "ub-fun-who";
  who.textContent = seatName(roll.player);
  const icon = document.createElement("span");
  icon.className = "ub-fun-icon";
  icon.textContent = face.icon;
  const text = document.createElement("span");
  text.textContent = face.text;
  el.append(who, icon, text);
  document.body.appendChild(el);
  setTimeout(() => el.classList.add("ub-fun-out"), 1700 / speedMult);
  setTimeout(() => el.remove(), 2300 / speedMult);
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function button(label, action, className = "ghost-btn") {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `${className} tm-btn`;
  btn.dataset.action = action;
  btn.textContent = label;
  return btn;
}

function endTurnLabel() {
  if (!isMyTurn() || dicePoolState <= 0) return "End turn";
  if (!queueMode()) return `End turn · 🎲×${dicePoolState}`;
  // Static mode: the bill is already known, so the button says what it is.
  const free = (myPlayer()?.passengers ?? []).filter((t) => t.done && t.bonus === "rush").length;
  const charged = Math.max(0, dicePoolState - free);
  return charged > 0 ? `End turn · −${num(charged * RED_STAR_COST)}★` : "End turn · waved through";
}

function canUndoTurn() {
  return isMyTurn() && winnerState == null && turnUndo != null && !diceAnimating;
}

function undoTurnLabel() {
  return turnUndo?.kind === "time" ? "Undo clock" : "Undo drive";
}

function ensureActionBar() {
  const footer = document.querySelector(".game-footer");
  if (!footer) return null;
  let bar = footer.querySelector(".ub-actions");
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "ub-actions";

    const buildSlot = document.createElement("span");
    buildSlot.className = "ub-actions-build";
    bar.appendChild(buildSlot);

    const undoBtn = button(undoTurnLabel(), "", "ghost-btn ub-undo-turn");
    undoBtn.addEventListener("click", () => {
      if (!undoBtn.disabled && app.roomId) socket.emit("uber_mania_undo", { roomId: app.roomId });
    });
    bar.appendChild(undoBtn);

    const endBtn = button(endTurnLabel(), "", "primary-btn ub-end-turn");
    endBtn.addEventListener("click", () => {
      if (endBtn.disabled || !app.roomId) return;
      socket.emit("uber_mania_end_turn", { roomId: app.roomId });
    });
    bar.appendChild(endBtn);

    footer.insertBefore(bar, footer.firstChild);
  }
  return bar;
}

function removeActionBar() {
  document.querySelector(".game-footer .ub-actions")?.remove();
}

// The settings bar, top of the right rail: a new city, a reshuffle of the
// lights, how many AI share the table, and the animation speed.
function renderControls() {
  const slot = railSlot("controls");
  slot.innerHTML = "";
  const bar = document.createElement("div");
  bar.className = "ub-controls";

  bar.appendChild(button("New city", "regen"));
  bar.appendChild(button("Mix lights", "mixup"));

  const pre = button(preTimeState ? "Pre-time: on" : "Pre-time: off", "pretime");
  pre.title = preTimeState
    ? "On: the clock is something you set BEFORE your turn. Once you've driven or taken a passenger the hand is locked."
    : "Off: you can move the clock at any point in your turn. Turn on to make it a decision you commit to first.";
  if (preTimeState) pre.classList.add("ub-opt-on");
  bar.appendChild(pre);

  // Waiting mode is the only ruleset where a drive can be truncated part-way,
  // so it's the only one this rule has anything to say about.
  if (isWaiting()) {
    const multi = button(multiMoveState ? "Multi-move: on" : "Multi-move: off", "multimove");
    multi.title = multiMoveState
      ? "On: dropping off and running errands no longer end your drive — only a red light stops you."
      : "Off: a drop-off or an errand ends your drive where it happened. You can still make as many drives as you like before that — pulling over is only a pause.";
    if (multiMoveState) multi.classList.add("ub-opt-on");
    bar.appendChild(multi);

    const slots = button(slotLabel(), "slots");
    slots.title = SLOT_BLURB();
    bar.appendChild(slots);

    // One select per slot: what that slot asks for before it will deal. A gate
    // is not part of the deal, so changing one leaves the table exactly as it
    // is — only adding or dropping a slot deals the row again.
    const gateWrap = document.createElement("label");
    gateWrap.className = "ub-ai-wrap ub-gates";
    gateWrap.append("Needs");
    slotGatesState.forEach((gate, i) => {
      const sel = document.createElement("select");
      sel.className = "ub-ai ub-gate";
      sel.dataset.slot = String(i);
      // Half stars as well as whole ones: a rating moves in halves, so a gate
      // sitting between two of them is a real setting.
      for (let v = 0; v <= MAX_GATE; v += 0.5) {
        const opt = document.createElement("option");
        opt.value = String(v);
        opt.textContent = `${num(v)}★`;
        if (v === gate) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.title = `What slot ${i + 1} asks of your rating before it will deal. Changing it doesn't re-deal the table.`;
      sel.addEventListener("change", () => {
        const next = slotGatesState.slice();
        next[i] = Number(sel.value);
        emitSlotGates(next);
      });
      gateWrap.appendChild(sel);
    });
    bar.appendChild(gateWrap);
  }

  // What the front of the queue pays, and what everyone opens on. Both belong
  // to the queue's star economy, so both ride with it.
  if (queueMode()) {
    const top = button(topFareLabel(), "topfare");
    top.title = TOP_FARE_BLURB();
    bar.appendChild(top);

    const startWrap = document.createElement("label");
    startWrap.className = "ub-ai-wrap";
    startWrap.append("Start ★");
    const stars = document.createElement("select");
    stars.className = "ub-ai ub-start-stars";
    // Half stars as well as whole ones, 0 through 5 — the table picks where
    // everyone opens, and the server rounds to the same half steps.
    for (let v = 0; v <= MAX_GATE; v += 0.5) {
      const opt = document.createElement("option");
      opt.value = String(v);
      opt.textContent = `${num(v)}★`;
      if (v === startStarsState) opt.selected = true;
      stars.appendChild(opt);
    }
    stars.title = "What every driver's rating opens on. Changing it re-deals the table.";
    stars.addEventListener("change", () => {
      if (!app.roomId) return;
      socket.emit("uber_mania_set_start_stars", { roomId: app.roomId, stars: Number(stars.value) });
    });
    startWrap.appendChild(stars);
    bar.appendChild(startWrap);
  }

  const rules = button(`Mode: ${MODE_NAME[modeState] ?? "Dice"}`, "rules");
  rules.title = `${MODE_BLURB[modeState] ?? ""}\n\nClick to switch to ${MODE_NAME[nextMode()]} — which re-deals the table.`;
  bar.appendChild(rules);

  // Waiting mode has no auto option — where you'll be stopped isn't knowable
  // until you've walked the route, so the builder is the only way to drive.
  if (!isWaiting()) {
    const modeBtn = button(moveMode === "build" ? "Route: build" : "Route: auto", "mode");
    modeBtn.title = "Build walks the route stop light by stop light. Auto offers the cheapest route(s) to a parking spot you click. A car still in the garage always builds its way in.";
    bar.appendChild(modeBtn);
  }

  const aiWrap = document.createElement("label");
  aiWrap.className = "ub-ai-wrap";
  aiWrap.append("AI");
  const ai = document.createElement("select");
  ai.className = "ub-ai";
  // maxAi is the free seats, so the humans at the table are the rest of them.
  const humans = Math.max(1, MAX_SEATS - maxAiState);
  const aiNow = Math.max(0, (playersState.length || humans) - humans);
  for (let n = 0; n <= Math.max(0, maxAiState); n += 1) {
    const opt = document.createElement("option");
    opt.value = String(n);
    opt.textContent = String(n);
    if (n === aiNow) opt.selected = true;
    ai.appendChild(opt);
  }
  ai.addEventListener("change", () => {
    if (!app.roomId) return;
    socket.emit("uber_mania_set_opponents", { roomId: app.roomId, count: Number(ai.value) });
  });
  aiWrap.appendChild(ai);
  bar.appendChild(aiWrap);

  const speedWrap = document.createElement("label");
  speedWrap.className = "ub-speed-wrap";
  speedWrap.append("Speed");
  const speed = document.createElement("input");
  speed.type = "range";
  speed.className = "ub-speed";
  speed.min = "1";
  speed.max = "3";
  speed.step = "0.5";
  speed.value = String(speedMult);
  const val = document.createElement("span");
  val.className = "ub-speed-val";
  val.textContent = `×${speedMult}`;
  speed.addEventListener("input", () => {
    val.textContent = `×${speed.value}`;
    if (app.roomId) socket.emit("uber_mania_set_speed", { roomId: app.roomId, speed: Number(speed.value) });
  });
  speedWrap.append(speed, val);
  bar.appendChild(speedWrap);

  bar.addEventListener("click", (event) => {
    const btn = event.target.closest?.("[data-action]");
    if (!btn || !app.roomId) return;
    if (btn.dataset.action === "regen") socket.emit("uber_mania_regenerate", { roomId: app.roomId });
    if (btn.dataset.action === "mixup") socket.emit("uber_mania_mix_up", { roomId: app.roomId });
    if (btn.dataset.action === "pretime") {
      socket.emit("uber_mania_set_pretime", { roomId: app.roomId, on: !preTimeState });
    }
    if (btn.dataset.action === "multimove") {
      socket.emit("uber_mania_set_multimove", { roomId: app.roomId, on: !multiMoveState });
    }
    if (btn.dataset.action === "slots") emitSlotGates(nextSlotGates());
    if (btn.dataset.action === "topfare") {
      socket.emit("uber_mania_set_priority_star", { roomId: app.roomId, value: nextTopFare() });
    }
    if (btn.dataset.action === "rules") {
      socket.emit("uber_mania_set_mode", { roomId: app.roomId, mode: nextMode() });
    }
    if (btn.dataset.action === "mode") {
      moveMode = moveMode === "build" ? "auto" : "build";
      localStorage.setItem("ubMoveMode", moveMode);
      btn.textContent = moveMode === "build" ? "Route: build" : "Route: auto";
      clearPreview();
      refreshBuilder();
    }
  });

  slot.appendChild(bar);
  ensureActionBar();
  updateTurnControls();
}

// The settings bar is only built when the board is, so a toggle that doesn't
// change the map — Pre-time — would never repaint its own label. Refresh the
// labels in place on every state update instead.
function syncControlLabels() {
  const pre = els.gameBoard.querySelector('.ub-controls [data-action="pretime"]');
  if (pre) {
    pre.textContent = preTimeState ? "Pre-time: on" : "Pre-time: off";
    pre.classList.toggle("ub-opt-on", preTimeState);
  }
  const multi = els.gameBoard.querySelector('.ub-controls [data-action="multimove"]');
  if (multi) {
    multi.textContent = multiMoveState ? "Multi-move: on" : "Multi-move: off";
    multi.classList.toggle("ub-opt-on", multiMoveState);
  }
  const slots = els.gameBoard.querySelector('.ub-controls [data-action="slots"]');
  if (slots) {
    slots.textContent = slotLabel();
    slots.title = SLOT_BLURB();
  }
  // A gate change doesn't re-deal, so the settings bar isn't rebuilt — the
  // selects have to be walked back into line here.
  const gates = els.gameBoard.querySelectorAll(".ub-controls .ub-gate");
  if (gates.length === slotGatesState.length) {
    gates.forEach((sel, i) => {
      if (Number(sel.value) !== slotGatesState[i]) sel.value = String(slotGatesState[i]);
    });
  } else if (gates.length) {
    renderControls();
  }
  const top = els.gameBoard.querySelector('.ub-controls [data-action="topfare"]');
  if (top) {
    top.textContent = topFareLabel();
    top.title = TOP_FARE_BLURB();
  }
  const stars = els.gameBoard.querySelector(".ub-controls .ub-start-stars");
  if (stars && Number(stars.value) !== startStarsState) stars.value = String(startStarsState);
  const rules = els.gameBoard.querySelector('.ub-controls [data-action="rules"]');
  if (rules) rules.textContent = `Mode: ${MODE_NAME[modeState] ?? "Dice"}`;
}

function updateTurnControls() {
  const bar = document.querySelector(".game-footer .ub-actions");
  const btn = bar?.querySelector(".ub-end-turn");
  const busy = diceAnimating || anyCarAnimating() || flipping;
  if (btn) {
    btn.disabled = !isMyTurn() || winnerState != null || busy;
    btn.textContent = endTurnLabel();
  }
  const ub = bar?.querySelector(".ub-undo-turn");
  if (ub) {
    ub.style.display = canUndoTurn() ? "" : "none";
    ub.disabled = busy;
    ub.textContent = undoTurnLabel();
  }
}

function applySpeed(sp) {
  if (sp === speedMult) return;
  speedMult = sp;
  document.body.style.setProperty("--tm-mult", String(sp));
  const dial = els.gameBoard.querySelector(".ub-speed");
  if (dial) {
    dial.value = String(sp);
    const v = els.gameBoard.querySelector(".ub-speed-val");
    if (v) v.textContent = `×${sp}`;
  }
}

// ---------------------------------------------------------------------------
// End-game chart
// ---------------------------------------------------------------------------

const RESULT_COLUMNS = [
  ["daily", "Stars", "Banked at the end of each day: a point for every FULL star you were holding, plus one for each night parked in your home district"],
  ["ridePoints", "Rides", "A point per fare delivered"],
  ["allDistricts", "All six", "Two for having driven a fare into every district"],
  ["regularPoints", "Regular", "Two for every district that isn't home where you finished three rides"],
  ["errandPenalty", "Errands", "Two off for every errand left standing"]
];

const STATIC_RESULT_COLUMNS = [
  ["daily", "Stars", "Banked at the end of each day: a point for every FULL star you were holding"],
  ["ridePoints", "Rides", "Three points per fare delivered"],
  ["tipPoints", "Tips", "Every tip fare delivered, times your full stars at the end"],
  ["allDistricts", "All six", "Five for having driven a fare into every district"],
  ["regularPoints", "Regular", "Five for every district you finished three rides in"]
];

// No wage column here: waiting mode pays nothing for the stars you hold at the
// end of a day. A rating is worth points only through the tips it multiplies.
const WAITING_RESULT_COLUMNS = [
  ["ridePoints", "Rides", "Three points per fare delivered"],
  ["tipPoints", "Tips", "Every tip fare delivered, times your full stars at the end"],
  ["errandPoints", "Errands", "What your finished errands pay: 2, 5, 8, 11, 15, 20 for one through six"],
  ["allDistricts", "All six", "Five for having driven a fare into every district"],
  ["regularPoints", "Regular", "Five for every district you finished three rides in"]
];

const resultColumns = () =>
  (isWaiting() ? WAITING_RESULT_COLUMNS : isStatic() ? STATIC_RESULT_COLUMNS : RESULT_COLUMNS);

// How the night actually went, under the scoring: none of it is worth points,
// which is exactly why it's a separate table — reading it next to the totals is
// how you find out whether the winner drove well or just got a clean run.
function driveLog() {
  const wrap = document.createElement("div");
  wrap.className = "ub-log";
  const h = document.createElement("div");
  h.className = "ub-log-title";
  h.textContent = "ALONG THE WAY";
  wrap.appendChild(h);

  const cols = [
    ["redsWaited", "Reds waited at", "Turns that ended sat at a red light, going nowhere"],
    ["clockChanges", "Clock changes", "Times this driver pushed the hand round"],
    ["stonesSpent", "Stones spent", "Time stones burned on the clock, all game"]
  ];
  // Only waiting mode makes you sit at reds; the others charge for them instead.
  const live = isWaiting() ? cols : cols.slice(1);

  const table = document.createElement("table");
  table.className = "ub-results-table ub-log-table";
  const thead = document.createElement("thead");
  const hr = document.createElement("tr");
  ["Driver", ...live.map(([, label]) => label)].forEach((label, i) => {
    const th = document.createElement("th");
    th.textContent = label;
    if (i > 0) th.title = live[i - 1]?.[2] ?? "";
    hr.appendChild(th);
  });
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  [...(resultsState?.rows ?? [])].sort((a, b) => b.total - a.total).forEach((row) => {
    const tr = document.createElement("tr");
    const who = document.createElement("td");
    who.className = "ub-results-who";
    const dot = document.createElement("span");
    dot.className = "ub-results-dot";
    dot.style.background = row.color;
    who.append(dot, row.name);
    tr.appendChild(who);
    live.forEach(([key]) => {
      const td = document.createElement("td");
      td.textContent = String(row[key] ?? 0);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function renderResults() {
  els.gameBoard.querySelector(".ub-results")?.remove();
  if (!resultsState || winnerState == null || resultsDismissed || diceAnimating) return;

  const overlay = document.createElement("div");
  overlay.className = "ub-results";
  const panel = document.createElement("div");
  panel.className = "ub-results-card";

  const h = document.createElement("h3");
  const winners = resultsState.winners ?? [];
  h.textContent = winners.length > 1
    ? `Tie — ${winners.map((i) => seatName(i)).join(" & ")}`
    : winners.includes(myIndex())
    ? "You win!"
    : `${seatName(winners[0])} wins`;
  panel.appendChild(h);

  const columns = resultColumns();
  const table = document.createElement("table");
  table.className = "ub-results-table";
  const thead = document.createElement("thead");
  const hr = document.createElement("tr");
  ["Driver", ...columns.map(([, label]) => label), "Total"].forEach((label, i) => {
    const th = document.createElement("th");
    th.textContent = label;
    if (i > 0) th.title = columns[i - 1]?.[2] ?? "";
    hr.appendChild(th);
  });
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  [...resultsState.rows].sort((a, b) => b.total - a.total).forEach((row) => {
    const tr = document.createElement("tr");
    if (winners.includes(row.seat)) tr.className = "ub-results-win";
    const who = document.createElement("td");
    who.className = "ub-results-who";
    const dot = document.createElement("span");
    dot.className = "ub-results-dot";
    dot.style.background = row.color;
    who.append(dot, row.homeName ? `${row.name} · ${row.homeName}` : row.name);
    tr.appendChild(who);
    columns.forEach(([key]) => {
      const td = document.createElement("td");
      const v = row[key] ?? 0;
      td.textContent = key === "errandPenalty" ? (v ? `−${v}` : "0") : String(v);
      if (key === "errandPenalty" && v) td.className = "ub-results-neg";
      if (key === "tipPoints") td.title = `${row.tips ?? 0} tip fares × ${Math.floor(row.rating ?? 0)} stars`;
      tr.appendChild(td);
    });
    const total = document.createElement("td");
    total.className = "ub-results-total";
    total.textContent = String(row.total);
    tr.appendChild(total);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  panel.appendChild(table);

  // Nothing below here scores anything — it's the log of how the night went.
  panel.appendChild(driveLog());

  const note = document.createElement("p");
  note.className = "ub-results-note";
  note.textContent = "Ties break on rides delivered, then on rating.";
  panel.appendChild(note);

  const close = button("Close", "", "ghost-btn");
  close.addEventListener("click", () => {
    resultsDismissed = true;
    overlay.remove();
  });
  panel.appendChild(close);

  overlay.appendChild(panel);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) {
      resultsDismissed = true;
      overlay.remove();
    }
  });
  els.gameBoard.appendChild(overlay);
}

// ---------------------------------------------------------------------------
// Map render + state handling
// ---------------------------------------------------------------------------

function boardSvg() {
  const svg = svgEl("svg", {
    class: "tm-map",
    viewBox: `0 0 ${mapState.width} ${mapState.height}`,
    role: "img",
    "aria-label": "Uber Mania city map"
  });
  svgEl("path", {
    class: "tm-ground",
    d: boardOutlinePath(mapState.width, mapState.height, mapState.rounded)
  }, svg);
  return svg;
}

function drawStreets(parent, streets) {
  const layer = svgEl("g", { class: "tm-streets" }, parent);
  streets.forEach((street) => {
    const common = {
      fill: "none",
      stroke: "currentColor",
      "stroke-width": street.width,
      "stroke-linecap": "round"
    };
    if (street.kind === "curve") {
      svgEl("path", {
        d: `M ${street.x0} ${street.y0} Q ${street.cx} ${street.cy} ${street.x1} ${street.y1}`,
        ...common
      }, layer);
      return;
    }
    svgEl("line", { x1: street.x1, y1: street.y1, x2: street.x2, y2: street.y2, ...common }, layer);
  });
}

function renderMap() {
  if (!mapState) return;

  els.gameBoard.innerHTML = "";
  els.gameBoard.classList.remove("player-0", "player-1", "toy-battle-board", "flip-triples-board", "tm-editing");
  els.gameBoard.classList.add("truck-mania-board", "ub-board-el");
  // The shared hand strip belongs to other games; this one keeps its board in
  // the rail, so make sure nothing is left sitting under the map.
  els.hand.innerHTML = "";

  const svg = boardSvg();
  drawStreets(svg, mapState.streets);
  const buildingsLayer = svgEl("g", { class: "tm-blocks" }, svg);
  mapState.blocks.forEach((block) => {
    block.buildings.forEach((building) => appendBuilding(buildingsLayer, building));
  });
  renderDistrictBlocks(svg);

  renderSpots(svg);
  renderOctagons(svg);
  renderCars(svg);
  svg.addEventListener("click", onBoardClick);
  els.gameBoard.appendChild(svg);
  syncCars(carsState);
  renderClock();
  renderScoreboard();
  renderTray();
  renderDice();
  refreshLocations();
}

function setTurnStatus() {
  if (winnerState != null) {
    const winners = resultsState?.winners ?? [winnerState];
    els.turnStatus.textContent = winners.length > 1
      ? `Game over — tie: ${winners.map((i) => seatName(i)).join(" & ")}`
      : winners.includes(myIndex())
      ? "Game over — you win!"
      : `Game over — ${seatName(winners[0])} wins!`;
    return;
  }
  if (!isMyTurn()) {
    els.turnStatus.textContent = `${playersState[turnWhose]?.name ?? "Opponent"}'s turn…`;
    return;
  }
  if (turnDrew) {
    els.turnStatus.textContent = "Passenger picked up — end your turn";
    return;
  }
  if (turnActed) {
    const car = myCar();
    const b = car && car.spot != null ? buildingByBid(mapState?.spots?.[car.spot]?.building) : null;
    const dropped = (myPlayer()?.passengers ?? []).filter((t) => t.done);
    const atLight = isWaiting() && car?.light != null;
    // The turn is still open — that stop finished nothing, or multi-move says
    // finishing something doesn't matter — so say so rather than telling
    // somebody who can still drive to end their turn.
    if (turnCarryOn) {
      const where = b?.name ?? "the address";
      els.turnStatus.textContent = canChangeTime()
        ? `Stopped at ${where} — drive on, change the clock, or end your turn`
        : `Stopped at ${where} — drive on, or end your turn`;
      return;
    }
    if (!dropped.length) {
      els.turnStatus.textContent = atLight
        ? "Stopped at the red — end your turn and drive through it on your next one"
        : "Parked — end your turn";
      return;
    }
    if (!queueMode()) {
      els.turnStatus.textContent =
        `Dropped off at ${b?.name ?? "the address"} — end your turn to throw the dice`;
      return;
    }
    const delta = slotStarDelta(Math.min(...dropped.map((t) => t.slot)));
    const where = atLight ? "stopped at the red" : `parked at ${b?.name ?? "the address"}`;
    els.turnStatus.textContent = isWaiting()
      ? `Dropped ${dropped.length} off, ${where} — ${starDeltaText(delta)} when you end your turn`
      : `Dropped off at ${b?.name ?? "the address"} — ${starDeltaText(delta)} when you end your turn`;
    return;
  }
  const car = myCar();
  if (isOffBoard(car)) {
    els.turnStatus.textContent = "Your turn — pick an edge stop light to drive in through, or take a passenger";
    return;
  }
  if (isWaiting()) {
    els.turnStatus.textContent = car?.light != null
      ? "Waiting at the light — drive straight through it, or take a passenger"
      : "Your turn — drive until you drop somebody off, a red stops you, or you choose to stop";
    return;
  }
  els.turnStatus.textContent = "Your turn — build a route, or take a passenger from a pile";
}

function teardownChrome() {
  document.body.classList.remove("ub-mode");
  document.body.classList.remove("ub-waiting");
  removeActionBar();
}

export const uberMania = {
  id: "uber-mania",
  name: "Uber Mania",
  description: "",
  soloOnly: false,

  handleState(payload, resetGameUi) {
    if (!payload.uberMania?.map) return false;
    resetGameUi();
    document.body.classList.add("ub-mode");
    const um = payload.uberMania;
    const prevHour = hourState;
    hourState = um.hour ?? null;
    timeState = um.time ?? 0;
    sectionState = um.section ?? sectionOf(timeState);
    elapsedState = um.elapsed ?? 0;
    turnWhose = um.turn ?? 0;
    turnActed = !!um.turnState?.acted;
    turnCarryOn = !!um.turnState?.carryOn;
    turnChangedTime = !!um.turnState?.changedTime;
    turnDrew = !!um.turnState?.drew;
    turnUndo = um.turnState?.undo ?? null;
    turnTruck = um.turnState?.truck ?? null;
    dicePoolState = um.turnState?.dicePool ?? 0;
    aiMoveState = um.aiMove ?? null;
    snapCarState = um.snapCar ?? null;
    maxAiState = um.maxAi ?? 5;
    funRollState = um.funRoll ?? null;
    applySpeed(um.speed ?? 1);
    playersState = um.players ?? [];
    districtsState = um.districts ?? [];
    pilesState = um.piles ?? [];
    modeState = um.mode ?? "dice";
    slotsState = um.slots ?? (modeState === "dice" ? MAX_PASSENGERS : STATIC_SLOTS);
    deckLeftState = um.deckLeft ?? null;
    preTimeState = !!um.preTime;
    multiMoveState = !!um.multiMove;
    slotGatesState = Array.isArray(um.slotGates) && um.slotGates.length
      ? um.slotGates.slice()
      : DEFAULT_SLOT_GATES.slice();
    priorityStarState = Number.isFinite(um.priorityStar) ? um.priorityStar : PRIORITY_STAR;
    startStarsState = Number.isFinite(um.startStars) ? um.startStars : 2;
    // Waiting mode's stop signs have to be big enough to park a car on.
    document.body.classList.toggle("ub-waiting", modeState === "waiting");
    lastRollState = um.lastRoll ?? null;
    lastTollState = um.lastToll ?? null;
    winnerState = um.winner ?? null;
    if (um.results && !resultsState) resultsDismissed = false;
    resultsState = um.results ?? null;
    settingsState = um.settings ?? settingsState;
    if (!isMyTurn()) clearPreview();

    const sameMap = mapState && mapState.seed === um.map.seed &&
      els.gameBoard.querySelector(".tm-map");

    if (sameMap) {
      const octLayoutChanged = mapState.intersections.some((o, i) => {
        const n = um.map.intersections[i];
        return !n || n.x !== o.x || n.y !== o.y || n.number !== o.number;
      });
      const prevOctColors = mapState.intersections.map((o) => o.color);
      mapState = um.map;
      if (octLayoutChanged) {
        clearPreview();
        refreshOctagonsHard();
        setHand();
      } else if (hourState != null && hourState !== prevHour) {
        clearPreview();
        const changed = [];
        mapState.intersections.forEach((o, i) => {
          if (o.color !== prevOctColors[i]) changed.push(i);
        });
        stagedTimeChange(hourState, changed.length ? changed : null);
      } else {
        updateOctagons(um.map);
        setHand();
      }
      updateDayNight();
      renderRatingBar();

      // The dice (or, in static mode, the red-light bill) hold the turn open
      // until they've been seen — same gate either way.
      const roll = um.lastRoll;
      const toll = um.lastToll;
      const newRoll = roll && roll.seq !== lastRollSeq && roll.dice?.length;
      const newToll = toll && toll.seq !== lastTollSeq && toll.reds > 0;
      if (roll) lastRollSeq = roll.seq;
      if (toll) lastTollSeq = toll.seq;
      if (newRoll || newToll) {
        const settle = (done) =>
          (newRoll ? animateDiceRoll(roll, done) : showToll(toll, done));
        const start = () => {
          diceAnimating = true;
          updateTurnControls();
          refreshBuilder();
          settle(() => {
            diceAnimating = false;
            runDeferredDrives();
            updateTurnControls();
            refreshBuilder();
            renderResults();
          });
        };
        if (flipping) clockQueue.push(start);
        else start();
      }
      if (funRollState && funRollState.seq !== lastFunSeq) {
        lastFunSeq = funRollState.seq;
        showFunRoll(funRollState);
      }
      syncCars(um.trucks);
      syncControlLabels();
      renderScoreboard();
      renderTray();
      renderDice();
      refreshLocations();
      renderResults();
      updateTurnControls();
      if (lastTurnSeen !== null && lastTurnSeen !== turnWhose && winnerState == null) {
        showTurnToast();
      }
      lastTurnSeen = turnWhose;
      refreshBuilder();
    } else {
      mapState = um.map;
      previewState = null;
      diceAnimating = false;
      flipping = false;
      clockQueue = [];
      deferredDrives = [];
      lastRollSeq = um.lastRoll?.seq ?? lastRollSeq;
      lastTollSeq = um.lastToll?.seq ?? lastTollSeq;
      lastFunSeq = um.funRoll?.seq ?? lastFunSeq;
      Object.keys(carSpots).forEach((k) => delete carSpots[k]);
      Object.keys(carPos).forEach((k) => delete carPos[k]);
      Object.keys(carUndoPose).forEach((k) => delete carUndoPose[k]);
      carsState = um.trucks ?? [];
      builder = null;
      renderMap();
      renderControls();
      renderResults();
      lastTurnSeen = turnWhose;
      refreshBuilder();
    }

    setTurnStatus();
    return true;
  },

  resetUi() {},

  clearState() {
    mapState = null;
    districtsState = [];
    pilesState = [];
    hourState = null;
    octEls = [];
    handEl = null;
    dayNightEl = null;
    carsState = [];
    playersState = [];
    graphCache = null;
    hoveredHour = null;
    flipping = false;
    handDeg = 0;
    previewState = null;
    lastRollState = null;
    lastTollState = null;
    lastTollSeq = -1;
    modeState = "waiting";
    slotsState = STATIC_SLOTS;
    deckLeftState = null;
    preTimeState = true;
    multiMoveState = false;
    slotGatesState = DEFAULT_SLOT_GATES.slice();
    priorityStarState = PRIORITY_STAR;
    startStarsState = 2;
    winnerState = null;
    timeState = 1;
    sectionState = "morning";
    elapsedState = 0;
    turnWhose = 0;
    turnActed = false;
    turnCarryOn = false;
    turnChangedTime = false;
    turnDrew = false;
    turnUndo = null;
    turnTruck = null;
    resultsState = null;
    resultsDismissed = false;
    aiMoveState = null;
    snapCarState = null;
    maxAiState = 5;
    funRollState = null;
    lastFunSeq = -1;
    lastRollSeq = -1;
    diceAnimating = false;
    deferredDrives = [];
    clockQueue = [];
    builder = null;
    lastTurnSeen = null;
    speedMult = 1;
    dicePoolState = 0;
    settingsState = null;
    els.gameBoard.classList.remove("ub-board-el");
    teardownChrome();
    document.body.style.removeProperty("--tm-mult");
    document.querySelector(".ub-turn-toast")?.remove();
    document.querySelector(".ub-fun")?.remove();
    [carEls, carPos, carSpots, pendingRoutes, carUndoPose].forEach((o) =>
      Object.keys(o).forEach((k) => delete o[k]));
    Object.values(carAnim).forEach((h) => h && cancelAnimationFrame(h));
    Object.keys(carAnim).forEach((k) => delete carAnim[k]);
  },

  onOpponentLeft() {
    teardownChrome();
  },

  onExit() {
    this.clearState();
  }
};

// A quiet banner when the turn passes, so an AI table is followable.
function showTurnToast() {
  document.querySelector(".ub-turn-toast")?.remove();
  const p = playersState[turnWhose];
  if (!p) return;
  const el = document.createElement("div");
  el.className = "ub-turn-toast";
  el.style.setProperty("--pcolor", p.color);
  el.textContent = turnWhose === myIndex() ? "Your turn" : `${p.name}'s turn`;
  document.body.appendChild(el);
  setTimeout(() => el.classList.add("ub-toast-out"), 1100 / speedMult);
  setTimeout(() => el.remove(), 1700 / speedMult);
}
