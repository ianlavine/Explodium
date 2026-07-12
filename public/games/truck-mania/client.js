// Truck Mania client — city map, octagon signals, the clock, and the map editor.
import { socket, els, app, updateTurn } from "../../shared/context.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const GREEN = "#3d9a5f";
const RED = "#cf4a3c";
const OCT_RADIUS = 13;
const PALETTE = ["#c97b63", "#6b8f71", "#d4a056", "#7d8aa5", "#b8849f", "#8f7e6b"];
const TRUCK_SCALE = 1.45; // trucks (and the cargo riding in them) render this much larger
const TRUCK_SPEED = 200; // px per second — constant, regardless of route length

let mapState = null;
let hourState = null;
let octEls = [];
let handEl = null;
let dayNightEl = null; // the sun/moon + AM/PM readout above the clock
let boardMode = "play"; // "play" | "edit"
let savedMaps = [];
let canSaveMaps = true;
let mapsRequested = false;
let mapsMenuOpen = false; // the saved-maps drop-up in the control bar
let hoveredHour = null;
let flipping = false;

// Trucks + driving.
let trucksState = [];
const truckEls = {}; // id -> svg group
const cargoEls = {}; // id -> cargo sub-group inside the truck
const truckPos = {}; // id -> { x, y, angle }
const truckSpots = {}; // id -> last spot index rendered
const truckAnim = {}; // id -> rAF handle
const pendingRoutes = {}; // id -> { spot, path, endAngle } routed locally, awaiting server echo
let previewState = null; // { truckId, spot, routes:[{path,reds,endAngle}] } awaiting the player's pick
let stealSession = null; // { victimId, remaining } while parked on a robbable truck
let graphCache = null; // { seed, graph }

// Ticket-dice animation + drive deferral: the truck waits for the roll to
// finish before it moves, and everyone sees the roll.
let lastRollSeq = -1;
let diceAnimating = false;
let deferredDrives = []; // drives held until the dice animation ends
const pendingFlies = {}; // truckId -> fly events held until the truck arrives

// Turn + time-of-day state (mirrors the server).
let timeState = 0; // 0-23, 0 = midnight
let nightState = true; // theft window: 9pm–6am
let turnWhose = 0; // player index whose turn it is
let turnActed = false; // this turn's truck has picked up/delivered (movement locked)
let turnStolen = false; // this turn has performed a steal
let turnChangedTime = false; // this turn has changed the clock
let stealVictimId = null; // which truck was robbed this turn
let aiMoveState = null; // { truckId, path, endAngle } — an AI's chosen drive to animate

// Extra truck: the human may own two trucks but moves one per turn. `turnTruck`
// is the truck locked in as this turn's mover (null until they act);
// `selectedTruckId` is which of their trucks they're currently aiming.
let turnTruck = null;
let selectedTruckId = 0;

// Movement-selection mode: "auto" previews server-style routes to a clicked
// spot; "build" has the player click stop lights one at a time to hand-build
// the route. Purely a local UX choice — the move sent to the server is the
// same either way — so it can be flipped at any point, mid-match included.
let moveMode = "build";
let builder = null; // build-mode session; see refreshBuilder()
let lastTurnSeen = null; // last turn index we showed a toast for

// Global animation speed (×1 normal … ×3 fast), a room setting everyone
// shares. All JS durations divide by it; CSS transitions read --tm-mult.
let speedMult = 1;
// The control bar folds down to a corner button (End turn stays reachable);
// the preference sticks across sessions.
let controlsMin = localStorage.getItem("tmControlsMin") === "1";
let turnPickups = []; // this turn's pickups [{pkg, bid}] — the put-back rights
let clockQueue = []; // work (e.g. a dice roll) queued until the clock-flip animation ends
const STEAL_GAP = 44; // px a thief parks short of its victim (about a truck length)

// Ticket mode (settings.mode === "tickets"): no points — first to complete
// `columnsToWin` columns wins. Reds bank dice into a pool rolled at turn end;
// failed dice issue literal tickets pointing at chore locations.
let dicePoolState = 0; // dice banked this turn (ticket mode)
let pawnUsesState = 0; // pawn-shop conversions made this turn
let courtUsesState = 0; // courthouse removals made this turn

function isTicketMode() {
  return settingsState?.mode === "tickets";
}

// Suspension mode: ticket mode plus the rule that face-down tickets ground a
// player — no pickups or dropoffs until the pile flips up (only at turn end).
function isSuspensionMode() {
  return isTicketMode() && !!settingsState?.suspension;
}

function amSuspended() {
  return isSuspensionMode() && (myPlayer()?.ticketPileCount ?? 0) > 0;
}

// Fragility rule set (ticket mode): circles are fragile packages any location
// can hold — no variety rule; the Fragile column caps how many circles fit in
// a truck, and delivering one pays a choice of time stones or money.
function isFragilityMode() {
  return isTicketMode() && !!settingsState?.fragility;
}

// The numeric tracks that count toward the ticket-mode win.
const TICKET_TRACKS = ["capacity", "variety", "aversion", "agression", "timestones", "money"];
const FRAGILITY_TRACKS = ["capacity", "fragile", "aversion", "agression", "timestones", "money"];

function activeTracks() {
  return isFragilityMode() ? FRAGILITY_TRACKS : TICKET_TRACKS;
}

// How many letters fill the letters column (it completes like any other).
function lettersToWin() {
  return Math.max(1, settingsState?.lettersToWin ?? settingsState?.protectedCount ?? 1);
}

function completedColumnsOf(player) {
  let n = activeTracks().filter((c) => {
    const vals = columnValuesFor(c);
    return vals.length && (player?.columns?.[c] ?? 0) >= vals.length - 1;
  }).length;
  if ((player?.locations?.length ?? 0) >= lettersToWin()) n += 1;
  return n;
}

function hasAbil(id) {
  return !!myPlayer()?.abilities?.includes(id);
}

function myIndex() {
  return app.myPlayerIndex ?? 0;
}

function myTruckList() {
  return trucksState.filter((t) => t.player === myIndex());
}

function activeTruckId() {
  return turnTruck != null ? turnTruck : selectedTruckId;
}

function activeTruck() {
  return trucksState.find((t) => t.id === activeTruckId()) ?? myTruckList()[0] ?? null;
}

// Does a given truck (default the active one) share its spot with another?
// Off-board trucks (spot null) share nothing.
function truckShares(truck) {
  return !!truck && truck.spot != null &&
    trucksState.some((t) => t.id !== truck.id && t.spot === truck.spot);
}

// Trucks start off the board (spot null) and drive in through an edge light.
function isOffBoard(truck) {
  return !!truck && truck.spot == null;
}

function anyMyTruckShares() {
  return myTruckList().some((t) => truckShares(t));
}

function isMyTurn() {
  return turnWhose === (app.myPlayerIndex ?? 0);
}

// Packages: parcels sitting on pickup buildings or stacked in a truck's dock.
const pkgPos = {}; // package id -> last rendered world position (fly source)
const animatingPkgs = new Set(); // ids mid-flight, hidden from static renders
const CARGO_SIZE = 7;
const BLD_PKG_SIZE = 11;

// Player board: seven columns, each a color-linked track of six values. The
// last two (Locations / Abilities) are placeholders with no values yet.
let playersState = [];
let lastRollState = null; // most recent ticket roll: { player, dice, aversion, tickets }
let decksState = null; // { locations:{shown,remaining}, abilities:{shown,remaining} }
let winnerState = null; // player index who has reached the winning score, or null
let settingsState = null; // the room's tunable numbers (columns, packages, points…)
let savedSettingsList = []; // presets + saved versions, for the tuning menu
let canSaveSettings = true;
let tuneDraft = null; // string-field working copy while the tuning panel is open
let lastAttachedMapId = null; // map attached by the last applied/saved settings version

const ABILITY_LABELS = {
  uturn: "U-turn",
  "drive-by-pickup": "Drive-by pickup",
  "drive-by-dropoff": "Drive-by dropoff",
  "cheap-time": "Cheap time",
  "day-theft": "Day theft",
  "time-lord": "Time lord",
  "free-parking": "Free parking",
  "reverse-time": "Reverse time",
  "extra-truck": "Extra truck"
};
const ABILITY_ICONS = {
  uturn: "↩",
  "drive-by-pickup": "⇥",
  "drive-by-dropoff": "⤶",
  "cheap-time": "½",
  "day-theft": "☀",
  "time-lord": "⏳",
  "free-parking": "🅿",
  "reverse-time": "⏱",
  "extra-truck": "🚚"
};

// Abilities are no longer a board column — the owned ones render as proper
// cards beside the board (buildAbilityCards).
const PB_COLUMNS = [
  { id: "capacity", title: "Capacity", color: "#e8c33c", values: [2, 3, 4, 5, 6, 7] },
  { id: "variety", title: "Variety", color: "#4a72b0", values: [1, 2, 3, 4, 5, 6] },
  { id: "aversion", title: "Aversion", color: "#4f9d57", values: [1, 2, 3, 4, 5, 6] },
  { id: "agression", title: "Agression", color: "#cf4a3c", values: [0, 1, 2, 3, 4, 5] },
  { id: "timestones", title: "Time stones", color: "#8a5bb0", values: [2, 4, 6, 8, 10, 12] },
  { id: "locations", title: "Locations", color: "#e08a3c", values: [] }
];

// Ticket mode: brown feeds the Money column; orange grants letters directly —
// and the letters column completes (lettersToWin slots) like a numeric track.
const PB_COLUMNS_TICKETS = [
  { id: "capacity", title: "Capacity", color: "#e8c33c", values: [2, 3, 4, 5, 6, 7] },
  { id: "variety", title: "Variety", color: "#4a72b0", values: [1, 2, 3, 4, 5, 6] },
  { id: "aversion", title: "Aversion", color: "#4f9d57", values: [1, 2, 3, 4, 5, 6] },
  { id: "agression", title: "Agression", color: "#cf4a3c", values: [0, 1, 2, 3, 4, 5] },
  { id: "timestones", title: "Time stones", color: "#8a5bb0", values: [2, 4, 6, 8, 10, 12] },
  { id: "money", title: "Money", color: "#8f6b52", values: [2, 4, 6, 8, 10, 12] },
  { id: "locations", title: "Letters", color: "#e08a3c", values: [] }
];

// Fragility: no variety column — blue feeds Fragile capacity instead.
const PB_COLUMNS_FRAGILITY = PB_COLUMNS_TICKETS.map((c) =>
  c.id === "variety" ? { id: "fragile", title: "Fragile", color: "#4a72b0", values: [1, 2, 3, 4, 5, 6] } : c
);

function pbColumns() {
  if (!isTicketMode()) return PB_COLUMNS;
  return isFragilityMode() ? PB_COLUMNS_FRAGILITY : PB_COLUMNS_TICKETS;
}

function hexToRgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// Editor session: null when not editing.
let editor = null; // { buildings, undoStack, selected, addingConn, segments, scaleBase }
let dragCtx = null;

function isActive() {
  return app.currentGame?.id === "truck-mania";
}

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

// --------------------------------------------------------------------------
// Geometry helpers
// --------------------------------------------------------------------------

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

function collectSegments(streets) {
  const segs = [];
  for (const street of streets) {
    const pts = streetToPolyline(street);
    for (let p = 0; p < pts.length - 1; p += 1) {
      segs.push([pts[p][0], pts[p][1], pts[p + 1][0], pts[p + 1][1]]);
    }
  }
  return segs;
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

function nearestStreetPoint(segments, px, py) {
  let best = null;
  for (const [x1, y1, x2, y2] of segments) {
    const p = projectToSegment(px, py, x1, y1, x2, y2);
    if (!best || p.dist < best.dist) best = p;
  }
  return best;
}

function closestOnPoly(points, px, py) {
  let best = null;
  for (let i = 0; i < points.length; i += 1) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    const p = projectToSegment(px, py, x1, y1, x2, y2);
    if (!best || p.dist < best.dist) best = p;
  }
  return best;
}

function centroidOf(points) {
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p[0];
    y += p[1];
  }
  return [x / points.length, y / points.length];
}

function svgPoint(svg, event) {
  const pt = new DOMPoint(event.clientX, event.clientY);
  return pt.matrixTransform(svg.getScreenCTM().inverse());
}

// The board's fillable outline: the full rectangle, but with the two rounded
// corners cut by the same quadratic arcs the border streets trace.
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

// --- Live intersection finding (ported from map.js for the street editor) ---

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

// Points where streets of two distinct directions meet (X, T, corner alike).
function findIntersections(streets) {
  const segs = [];
  streets.forEach((street, si) => {
    const pts = streetToPolyline(street);
    for (let p = 0; p < pts.length - 1; p += 1) {
      segs.push({ si, seg: [pts[p][0], pts[p][1], pts[p + 1][0], pts[p + 1][1]], dir: dirBucket(pts[p + 1][0] - pts[p][0], pts[p + 1][1] - pts[p][1]) });
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

// Deal numbered octagons over the intersection points (preview colors — the
// server re-randomizes on save). Matches assignOctagons in map.js.
function assignOctagons(points, width) {
  const isCorner = (p) => (p.x < 20 || p.x > width - 20) && (p.y < 20 || p.y > 720 - 20);
  const eligible = points.filter((p) => !isCorner(p)).sort(() => Math.random() - 0.5);
  const corners = points.filter(isCorner);
  const octagons = [];
  eligible.forEach((p, i) => {
    let number = null;
    let color = Math.random() < 0.5 ? "green" : "red";
    if (i < 12) { number = i + 1; color = "green"; }
    else if (i < 24) { number = i - 11; color = "red"; }
    octagons.push({ x: p.x, y: p.y, number, color });
  });
  corners.forEach((p) => octagons.push({ x: p.x, y: p.y, number: null, color: Math.random() < 0.5 ? "green" : "red" }));
  return octagons;
}

// --------------------------------------------------------------------------
// Buildings + connector driveways (play mode)
// --------------------------------------------------------------------------

function appendBuilding(parent, building) {
  const cls = ["tm-building"];
  if (building.role === "ticket") cls.push("tm-bldg-ticket");
  if (building.role === "special") cls.push("tm-bldg-special");
  const g = svgEl("g", { class: cls.join(" "), "data-bldg": building.bid }, parent);

  (building.connectors ?? []).forEach((c) => {
    svgEl("line", {
      x1: c.x1, y1: c.y1, x2: c.x2, y2: c.y2,
      stroke: building.color,
      "stroke-width": 2
    }, g);
  });

  // Protected locations get a dark outline so they read as special.
  const shapeClass = building.protected ? "tm-protected" : "";
  if (building.points) {
    svgEl("polygon", { points: polygonToString(building.points), fill: building.color, class: shapeClass }, g);
  } else {
    const rect = svgEl("rect", {
      x: building.x, y: building.y, width: building.w, height: building.h,
      rx: 3,
      fill: building.color,
      class: shapeClass
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
      fill: building.color,
      class: "tm-connector-dot"
    }, g);
  });

  // The location letter, badged at the building's top-left corner.
  if (building.protected && building.letter) {
    const bb = buildingBBox(building);
    const bx = bb.minX + 8;
    const by = bb.minY + 8;
    const badge = svgEl("g", { class: "tm-loc-letter" }, g);
    svgEl("circle", { cx: bx, cy: by, r: 7.5, class: "tm-loc-letter-bg" }, badge);
    const t = svgEl("text", { x: bx, y: by, class: "tm-loc-letter-text" }, badge);
    t.textContent = building.letter;
  }

  // Ticket-mode themed places: chore locations and the three money sinks get
  // an icon + name so they read at a glance.
  if ((building.role === "ticket" || building.role === "special") && building.icon) {
    const [cx, cy] = buildingCentroid(building);
    const icon = svgEl("text", { x: cx, y: cy - 3, class: "tm-bldg-icon" }, g);
    icon.textContent = building.icon;
    const name = svgEl("text", { x: cx, y: cy + 10, class: "tm-bldg-name" }, g);
    name.textContent = building.name ?? "";
  }
}

// Axis-aligned bounds of a building (rect or poly), used to place its badge.
function buildingBBox(b) {
  let pts;
  if (b.points) {
    pts = b.points;
  } else {
    pts = [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]];
  }
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

// --------------------------------------------------------------------------
// Octagon signals
// --------------------------------------------------------------------------

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
    // Zoom wrapper: highlighted signs grow via CSS without disturbing the
    // translate above or the fold transform below.
    const zoom = svgEl("g", { class: "tm-oct-zoom" }, g);
    const flip = svgEl("g", { class: "tm-oct-flip" }, zoom);
    const shape = svgEl("polygon", {
      points: octagonPoints(OCT_RADIUS),
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
  // Mix-up rebuilds numbers too, so redraw the layer outright.
  const svg = els.gameBoard.querySelector(".tm-map");
  const layer = svg?.querySelector(".tm-octagons");
  if (!svg || !layer) return false;
  layer.remove();
  renderOctagons(svg);
  return true;
}

// --------------------------------------------------------------------------
// The clock
// --------------------------------------------------------------------------

// The hand normally sweeps clockwise, so rotation accumulates: going from 10
// to 2 turns forward through 12, never backwards. With the Reverse-time
// ability it takes whichever spin is fewer hours (the cheaper one).
let handDeg = 0;
function setHand() {
  if (!handEl) return;
  const target = ((hourState ?? 12) * 30) % 360;
  const cur = ((handDeg % 360) + 360) % 360;
  const cwSteps = ((target - cur) + 360) % 360;
  const ccwSteps = (360 - cwSteps) % 360;
  if (myPlayer()?.abilities?.includes("reverse-time") && ccwSteps < cwSteps) {
    handDeg -= ccwSteps;
  } else {
    handDeg += cwSteps;
  }
  handEl.style.transform = `rotate(${handDeg}deg)`;
}

// Ring the two octagons carrying this hour's number, so it's clear which
// stoplights a time change would flip.
function setHourHighlight(hour, on) {
  mapState.intersections.forEach((oct, i) => {
    if (oct.number === hour && octEls[i]) octEls[i].g.classList.toggle("tm-oct-hi", on);
  });
}

// A time change: the matching octagons grow (they already grew on hover), the
// hand swings, then — still big — each sign folds over slowly, one at a time,
// and only then do they shrink back to normal size.
function stagedTimeChange(hour) {
  flipping = true;
  const idx = [];
  mapState.intersections.forEach((oct, i) => {
    if (oct.number === hour) idx.push(i);
  });
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
      // Release whatever waited on the clock: a queued dice roll, then any
      // drives held back so the truck doesn't move mid-flip.
      const q = clockQueue;
      clockQueue = [];
      q.forEach((fn) => fn());
      if (!diceAnimating) runDeferredDrives();
      flushIdleFlies();
      updateTurnControls();
      refreshBuilder();
    }, delay + 650 / speedMult);
  }, 800 / speedMult);
}

// Each hour of clockwise sweep costs one time stone. Reverse-time lets a player
// take the cheaper of the two spin directions.
function hourCost(hour) {
  const cur = hourState ?? 12;
  const cw = (hour - cur + 12) % 12;
  let cost = hasAbil("reverse-time") ? Math.min(cw, (cur - hour + 12) % 12) : cw;
  if (hasAbil("cheap-time")) cost = Math.ceil(cost / 2); // half, rounded up
  return cost;
}

function renderClock() {
  const wrap = document.createElement("div");
  wrap.className = "tm-clock";

  dayNightEl = document.createElement("div");
  dayNightEl.className = "tm-clock-daynight";
  wrap.appendChild(dayNightEl);

  const svg = svgEl("svg", { viewBox: "0 0 200 200", role: "img", "aria-label": "Clock" });
  svgEl("circle", { cx: 100, cy: 100, r: 94, class: "tm-clock-face" }, svg);

  // Cost readout while hovering an hour: how many stones the sweep would take.
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
    const num = svgEl("text", { x, y, class: "tm-clock-num" }, hit);
    num.textContent = String(h);
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
    if (!hourElement || !app.roomId || !isActive() || editor || stealSession || !isMyTurn() || diceAnimating) return;
    if (turnChangedTime && !hasAbil("time-lord")) return; // time changes once per turn
    const hour = Number(hourElement.dataset.hour);
    const cost = hourCost(hour);
    if (!cost || cost > (myPlayer()?.timeStones ?? 0)) return; // can't afford (or same hour)
    socket.emit("truck_mania_set_hour", { roomId: app.roomId, hour });
  });

  els.gameBoard.appendChild(wrap);
  setHand();
  updateDayNight();
}

// Sun/moon + AM/PM readout above the clock; night tints it and is the theft
// window (9pm–6am).
function updateDayNight() {
  if (!dayNightEl) return;
  const face = hourState ?? 12;
  dayNightEl.innerHTML = "";
  const icon = document.createElement("span");
  icon.className = "tm-daynight-icon";
  icon.textContent = nightState ? "🌙" : "☀️";
  const label = document.createElement("span");
  label.className = "tm-daynight-label";
  label.textContent = `${face} ${timeState < 12 ? "AM" : "PM"}`;
  dayNightEl.append(icon, label);
  // Ticket mode: the dice banked this turn, rolled when the turn ends.
  if (isTicketMode() && dicePoolState > 0) {
    const pool = document.createElement("span");
    pool.className = "tm-pool-tag";
    pool.textContent = `🎲 ×${dicePoolState}`;
    pool.title = "Ticket dice — rolled when the turn ends";
    dayNightEl.appendChild(pool);
  }
  dayNightEl.classList.toggle("tm-night", nightState);
}

// --------------------------------------------------------------------------
// Street graph + driving
// --------------------------------------------------------------------------

// A routable graph of the streets: nodes at intersections, spots, and street
// ends; edges run along each street between consecutive nodes, carrying the
// polyline points between them so trucks follow curves.
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

// Dijkstra between the graph nodes nearest to the two points; returns the
// polyline the truck should drive, or a straight fallback if disconnected.
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
        prevEdge[e.to] = e; // oriented u -> e.to
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

// First (or last) well-defined direction along a polyline, as a unit vector.
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

// Trucks never U-turn, so routing runs over directed arcs (edge + direction)
// instead of nodes: a transition at a node is legal only if it doesn't reverse
// back the way the truck came, and the first arc must roughly match the
// truck's current facing. Cost is lexicographic — red lights crossed first,
// distance second — so this returns the green-only route whenever one exists,
// otherwise the route through the fewest red lights.
const UTURN_COS = -0.966; // turns sharper than ~165° count as U-turns

// Returns up to two routes to the goal spot: the overall least-red, then
// shortest, route (facing whichever way it arrives), and the least-red route
// that arrives facing the *opposite* way — the truck could park either
// direction, so both are offered. Each is { path, reds, endAngle, endDir }.
function findRoutes(graph, ax, ay, headingDeg, bx, by, canUturn = false) {
  const start = nearestNode(graph, ax, ay);
  const goal = nearestNode(graph, bx, by);
  if (start < 0 || goal < 0 || start === goal) return [];

  // Red cost of driving an arc: every red octagon the truck brushes along it
  // (within an octagon radius of the driven polyline). Two octagons don't
  // count: one sitting beside the start or goal parking spot (the truck parks
  // shy of it, never crossing), and one at the arc's departure junction (it was
  // already tallied when the truck drove *into* that junction on the prior arc).
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
  const states = new Map(); // "node:arcIndex" -> best way to finish that arc

  const hx = Math.cos((headingDeg * Math.PI) / 180);
  const hy = Math.sin((headingDeg * Math.PI) / 180);
  (graph.adj[start] ?? []).forEach((e, k) => {
    if (!canUturn) {
      const [dx, dy] = polyDir(e.pts);
      if (dx * hx + dy * hy <= 0) return; // would have to reverse out of the spot
    }
    states.set(`${start}:${k}`, {
      e, key: `${start}:${k}`, reds: arcReds(e), dist: e.w, prevKey: null, done: false
    });
  });

  // Settle every arc-state (full Dijkstra over the directed arcs); we need the
  // goal's arrivals in both facings, not just the first one popped.
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
      if (!canUturn) {
        const outDir = polyDir(e2.pts);
        if (inDir[0] * outDir[0] + inDir[1] * outDir[1] < UTURN_COS) return;
      }
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

  // Stitch an arrival state's arc chain into one drivable polyline.
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

// The truck rotates to its heading. When that heading points leftward the
// naive rotation would put it upside down, so we mirror it vertically in its
// own frame — nose still points along travel, wheels stay on the underside.
function truckTransform(id) {
  const el = truckEls[id];
  const pos = truckPos[id];
  if (!el || !pos) return;
  const flipY = Math.cos((pos.angle * Math.PI) / 180) < 0 ? -TRUCK_SCALE : TRUCK_SCALE;
  el.setAttribute("transform", `translate(${pos.x} ${pos.y}) rotate(${pos.angle}) scale(${TRUCK_SCALE} ${flipY})`);
}

// Side-view flatbed: an open cargo dock at the back, a cab up front, two wheels.
// Drawn facing right; mirrored via the transform to face left.
function makeTruckShape(parent, bodyColor) {
  const g = svgEl("g", { class: "tm-truck" }, parent);
  const dark = "rgba(18,22,28,0.9)";

  // Open-top cargo dock (back / left).
  svgEl("rect", { x: -15, y: -8, width: 18, height: 13, rx: 1.5, fill: bodyColor, stroke: dark, "stroke-width": 1.5, class: "tm-truck-body" }, g);
  svgEl("rect", { x: -12.5, y: -6, width: 13, height: 5.5, rx: 1, fill: "rgba(20,24,30,0.32)" }, g); // open interior

  // Cab (front / right) with a slanted windshield.
  svgEl("path", { d: "M3 5 L3 -6 L10 -6 L14 -1 L14 5 Z", fill: bodyColor, stroke: dark, "stroke-width": 1.5, class: "tm-truck-body" }, g);
  svgEl("path", { d: "M9.7 -5 L13 -1 L9.7 -1 Z", fill: "#bfe0f0", stroke: dark, "stroke-width": 0.7 }, g); // windshield
  svgEl("circle", { cx: 13.6, cy: 3, r: 1.3, fill: "#f5d76e" }, g); // headlight

  // Wheels.
  for (const cx of [-9, 9]) {
    svgEl("circle", { cx, cy: 7, r: 4, fill: "#1c2027", stroke: "#000", "stroke-width": 0.6 }, g);
    svgEl("circle", { cx, cy: 7, r: 1.8, fill: "#5b6472" }, g);
  }
  // Cargo rides in the open dock and rotates with the truck.
  svgEl("g", { class: "tm-cargo" }, g);
  return g;
}

// Build one truck's SVG element into the trucks layer.
function addTruckEl(layer, t) {
  const color = playersState[t.player]?.color ?? "#f4c542";
  const g = makeTruckShape(layer, color);
  g.setAttribute("data-truck", t.id);
  if (isOffBoard(t)) g.style.display = "none"; // waiting in the garage up top
  if (t.player !== myIndex()) g.classList.add("tm-truck-foe"); // clickable steal target
  truckEls[t.id] = g;
  cargoEls[t.id] = g.querySelector(".tm-cargo");
  renderCargo(t.id);
  // Hovering a truck flashes its owner's aggression as a red number above it.
  g.addEventListener("mouseenter", () => showTruckAggr(t, layer));
  g.addEventListener("mouseleave", hideTruckAggr);
}

function renderTrucks(svg) {
  const layer = svgEl("g", { class: "tm-trucks" }, svg);
  Object.keys(truckEls).forEach((k) => delete truckEls[k]);
  Object.keys(cargoEls).forEach((k) => delete cargoEls[k]);
  trucksState.forEach((t) => addTruckEl(layer, t));
  renderTruckHighlight();
}

// Red aggression badge floating above a hovered truck.
function showTruckAggr(truck, layer) {
  hideTruckAggr();
  const pos = truckPos[truck.id];
  if (!pos) return;
  const aggr = columnValue("agression", playersState[truck.player]) ?? 0;
  const label = svgEl("text", {
    class: "tm-truck-aggr",
    x: pos.x,
    y: pos.y - 22,
    "text-anchor": "middle"
  }, layer);
  label.textContent = String(aggr);
}

function hideTruckAggr() {
  document.querySelector(".tm-truck-aggr")?.remove();
}

// When the human owns two trucks, glow the one they're currently aiming.
function renderTruckHighlight() {
  const many = myTruckList().length > 1;
  Object.entries(truckEls).forEach(([id, el]) => {
    el.classList.toggle("tm-truck-selected", many && Number(id) === activeTruckId());
  });
}

// Ticket mode: light up the chore locations named on my visible tickets, so
// the places to work them off are easy to spot on the board.
function renderTicketHighlights() {
  const svg = els.gameBoard.querySelector(".tm-map");
  if (!svg) return;
  svg.querySelectorAll(".tm-ticket-lit").forEach((el) => el.classList.remove("tm-ticket-lit"));
  if (!isTicketMode()) return;
  (myPlayer()?.tickets ?? []).forEach((t) => {
    svg.querySelector(`.tm-building[data-bldg="${t.loc}"]`)?.classList.add("tm-ticket-lit");
  });
}

// --------------------------------------------------------------------------
// Route preview: draw the candidate paths a click would take, for the player
// to pick from (or ignore by clicking a different spot).
// --------------------------------------------------------------------------

const CHEVRON_SPACING = 30; // px between direction chevrons along a path

// Cumulative arc-length at each polyline vertex.
function cumLengths(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i += 1) {
    cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  return cum;
}

// Total length of a polyline.
function pathLength(pts) {
  if (!pts || pts.length < 2) return 0;
  const cum = cumLengths(pts);
  return cum[cum.length - 1];
}

// Position + heading a distance d along the polyline.
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

// Number of leading polyline points the two paths share (identical geometry),
// so a common approach is drawn once and only the fork is split in two.
function sharedPrefixLen(a, b) {
  let k = 0;
  const n = Math.min(a.length, b.length);
  while (k < n && Math.abs(a[k][0] - b[k][0]) < 0.6 && Math.abs(a[k][1] - b[k][1]) < 0.6) k += 1;
  return k;
}

function polylineStr(pts) {
  return pts.map((p) => `${r1(p[0])},${r1(p[1])}`).join(" ");
}

const ROUTE_OFFSET = 7; // draw the path beside the road, not down its middle

// Shift a polyline sideways (to the right of travel) by `off`, using averaged
// segment normals so corners stay put.
function offsetPath(pts, off) {
  if (pts.length < 2) return pts.map((p) => p.slice());
  const normals = [];
  for (let i = 0; i < pts.length - 1; i += 1) {
    const dx = pts[i + 1][0] - pts[i][0];
    const dy = pts[i + 1][1] - pts[i][1];
    const len = Math.hypot(dx, dy) || 1;
    normals.push([-dy / len, dx / len]); // right-hand side in screen coords
  }
  return pts.map((p, i) => {
    const a = normals[Math.max(0, i - 1)];
    const b = normals[Math.min(normals.length - 1, i)];
    let nx = a[0] + b[0];
    let ny = a[1] + b[1];
    const nl = Math.hypot(nx, ny) || 1;
    return [p[0] + (nx / nl) * off, p[1] + (ny / nl) * off];
  });
}

// Chaikin corner-cutting: rounds the polyline into gentle curves.
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

// A path as it should be drawn: offset beside the road, corners rounded.
function dressPath(pts) {
  if (!pts || pts.length < 2) return pts ? pts.map((p) => p.slice()) : [];
  return chaikin(offsetPath(pts, ROUTE_OFFSET), 2);
}

function drawRouteLine(layer, pts, color, routeIdx, isStem = false) {
  if (pts.length < 2) return;
  const str = polylineStr(pts);
  const line = svgEl("polyline", { points: str, class: "tm-route-line", stroke: color }, layer);
  if (routeIdx != null) line.setAttribute("data-route-line", routeIdx);
  if (isStem) line.classList.add("tm-route-stem"); // shared approach: lights up for either route
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

// Red badge = how many red lights this route crosses, placed a little way into
// the route's own (post-fork) portion. The inner group scales on hover (the
// outer group owns the translate, so CSS can't scale it directly).
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

// Hovering a route's hit area lights up its line, the shared stem, and its
// red-count badge, so it's clear which option a click would take.
function setRouteHover(layer, idx, on) {
  layer.querySelectorAll(`[data-route-line="${idx}"], .tm-route-stem`).forEach((el) =>
    el.classList.toggle("tm-route-hover", on)
  );
  layer.querySelectorAll(`[data-route-badge="${idx}"]`).forEach((el) =>
    el.classList.toggle("tm-route-badge-hover", on)
  );
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

    // Clicking the shared stem (before the fork) is otherwise ambiguous —
    // default it to the shorter route. This is the only way to pick the short
    // route when the two paths don't fork until after the destination.
    const shorterIdx = pathLength(p0) <= pathLength(p1) ? 0 : 1;

    if (shared.length >= 2) {
      drawRouteLine(layer, shared, color, shorterIdx, true);
      drawChevrons(layer, shared, color);
    }
    drawRouteLine(layer, tail0, color, 0);
    drawRouteLine(layer, tail1, color, 1);
    drawChevrons(layer, tail0, color);
    drawChevrons(layer, tail1, color);
    // Badge sits on each fork; if there's no real fork (identical tails) both
    // still render, offset by their own geometry.
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

// Commit the chosen preview route: hand the truck the exact approved path (and
// arrival facing) so the server echo replays it, then clear the preview.
function commitRoute(routeIdx) {
  if (!previewState) return;
  const route = previewState.routes[routeIdx];
  const truck = trucksState.find((t) => t.id === previewState.truckId);
  if (!route || !truck) {
    clearPreview();
    return;
  }
  pendingRoutes[truck.id] = { spot: previewState.spot, path: route.path, endAngle: route.endAngle };
  const spot = previewState.spot;
  const reds = route.reds;
  clearPreview();
  socket.emit("truck_mania_move_truck", { roomId: app.roomId, truckId: truck.id, spot, reds });
}

// --------------------------------------------------------------------------
// Build mode: the player hand-builds a route by clicking stop lights one at a
// time, then ends it on a parking dot and hits Go. Only the final move is sent
// (and seen by others); every red light clicked adds a ticket die.
// --------------------------------------------------------------------------

// From a position + heading, the stop lights and parking dots reachable *next*:
// a Dijkstra over directed arcs (no U-turns, unless the player has the ability)
// that stops expanding at the first stop light it meets — you must click that
// light before going further — but passes straight through parking dots.
// `firstLeg` applies the strict leaving-a-parking-spot rule (no reversing out);
// later legs start at a junction, where left/right turns are legal — only true
// U-turns are barred. Returns { octs: [{index, path, endAngle}], spots: [...] }.
function manualChoices(px, py, headingDeg, canUturn, firstLeg = true) {
  const graph = getGraph();
  const res = { octs: [], spots: [] };
  const start = nearestNode(graph, px, py);
  if (start < 0) return res;

  const octs = mapState.intersections ?? [];
  const spots = mapState.spots ?? [];
  const octAtNode = graph.nodePts.map(([x, y]) => {
    for (let i = 0; i < octs.length; i += 1) {
      if (Math.hypot(octs[i].x - x, octs[i].y - y) < 15) return i;
    }
    return -1;
  });
  const spotAtNode = graph.nodePts.map(([x, y]) => {
    for (let i = 0; i < spots.length; i += 1) {
      if (Math.hypot(spots[i].x - x, spots[i].y - y) < 8) return i;
    }
    return -1;
  });

  const states = new Map(); // "node:arcIndex" -> best way to finish that arc
  const hx = Math.cos((headingDeg * Math.PI) / 180);
  const hy = Math.sin((headingDeg * Math.PI) / 180);
  (graph.adj[start] ?? []).forEach((e, k) => {
    if (!canUturn) {
      const [dx, dy] = polyDir(e.pts);
      const dot = dx * hx + dy * hy;
      // First leg: can't reverse out of the spot. Later legs start at a
      // junction, where turning left/right is fine — only U-turns are barred.
      if (firstLeg ? dot <= 0 : dot < UTURN_COS) return;
    }
    states.set(`${start}:${k}`, { e, key: `${start}:${k}`, dist: e.w, prevKey: null, done: false });
  });

  const octBest = new Map(); // octagon index -> first (shortest) arrival state
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
      continue; // a stop light gates the way — no expanding past it
    }
    const si = spotAtNode[v];
    if (si !== -1 && !spotBest.has(si)) spotBest.set(si, cur); // dots are passable
    const inDir = polyDir(cur.e.pts, true);
    (graph.adj[v] ?? []).forEach((e2, k2) => {
      if (!canUturn) {
        const outDir = polyDir(e2.pts);
        if (inDir[0] * outDir[0] + inDir[1] * outDir[1] < UTURN_COS) return;
      }
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

// Where the path-under-construction currently ends (position + heading).
function builderHead() {
  const w = builder.waypoints[builder.waypoints.length - 1];
  if (!w) {
    const p = truckPos[builder.truckId];
    return { x: p.x, y: p.y, angle: p.angle };
  }
  const last = w.path[w.path.length - 1];
  return { x: last[0], y: last[1], angle: w.endAngle };
}

// First click of an off-board turn: any stop light on the board's edge (all
// of them, if a hand-built map has none there). The synthesized leg drives in
// from just outside the border, so the entry light is clicked — and counted,
// if red — like any other light, and the head ends up facing inward: every
// light next to the entry is then a legal second click.
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

// Next-step choices from the head, with unpickable spots filtered out: the
// truck's own spot, and occupied spots unless the occupant is stealable.
function computeBuilderChoices() {
  if (builder.entry && builder.waypoints.length === 0) return entryChoices();
  const head = builderHead();
  const firstLeg = !builder.entry && builder.waypoints.length === 0;
  const c = manualChoices(head.x, head.y, head.angle, hasAbil("uturn"), firstLeg);
  const truck = trucksState.find((t) => t.id === builder.truckId);
  c.spots = c.spots.filter(({ index }) => {
    if (truck && truck.spot != null && index === truck.spot) return false;
    const occ = trucksState.find((t) => t.id !== builder.truckId && t.spot === index);
    if (!occ) return true;
    return occ.player !== myIndex() && canStealTarget(occ.id);
  });
  return c;
}

function builderFullPath() {
  let pts = [];
  builder.waypoints.forEach((w, k) => {
    pts = pts.concat(k === 0 ? w.path : w.path.slice(1));
  });
  return pts;
}

// Ticket dice the built path would roll: the red lights among the clicked
// ones, counted against current colors (a mid-build time change updates it).
function builderReds() {
  return builder.waypoints.filter(
    (w) => w.kind === "oct" && mapState.intersections[w.index]?.color === "red"
  ).length;
}

function builderAddOct(index) {
  const choice = builder.choices.octs.find((c) => c.index === index);
  if (!choice) return;
  builder.waypoints.push({ kind: "oct", index, path: choice.path, endAngle: choice.endAngle });
  builder.choices = computeBuilderChoices();
  renderBuild();
}

function builderAddSpot(index) {
  const choice = builder.choices.spots.find((c) => c.index === index);
  if (!choice) return;
  builder.waypoints.push({ kind: "spot", index, path: choice.path, endAngle: choice.endAngle });
  builder.done = true;
  builder.choices = { octs: [], spots: [] };
  renderBuild();
}

function builderUndo() {
  if (!builder?.waypoints.length) return;
  builder.waypoints.pop();
  builder.done = false;
  builder.choices = computeBuilderChoices();
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
  if (!builder?.done) return;
  const last = builder.waypoints[builder.waypoints.length - 1];
  const path = builderFullPath();
  const reds = Math.min(12, builderReds());
  pendingRoutes[builder.truckId] = { spot: last.index, path, endAngle: last.endAngle };
  const truckId = builder.truckId;
  builder = null;
  renderBuild();
  socket.emit("truck_mania_move_truck", { roomId: app.roomId, truckId, spot: last.index, reds });
}

// (Re)open the build session when it applies: build mode, our turn, movement
// still allowed, truck parked. Cleared otherwise. Safe to call at any point.
// A truck still off the board always builds its entry route here (even in
// auto route mode — there's no spot to click a preview from off the board).
function refreshBuilder() {
  const truck = activeTruck();
  const off = isOffBoard(truck);
  const eligible =
    (moveMode === "build" || off) && isActive() && !editor && app.roomId && boardMode === "play" &&
    isMyTurn() && !turnActed && winnerState == null && truck && !diceAnimating &&
    truckAnim[truck.id] == null && (off || truckPos[truck.id]);
  if (!eligible) {
    builder = null;
    renderBuild();
    return;
  }
  if (!builder || builder.truckId !== truck.id || builder.baseSpot !== truck.spot) {
    builder = {
      truckId: truck.id,
      baseSpot: truck.spot,
      entry: off, // first click picks an edge stop light to drive in through
      waypoints: [],
      done: false,
      choices: null
    };
    builder.choices = computeBuilderChoices();
  }
  renderBuild();
}

// Draw the build state: the growing arrow along the path so far, highlights on
// the currently clickable lights/dots, and the Undo / Restart / Go panel.
function renderBuild() {
  const svg = els.gameBoard.querySelector(".tm-map");
  els.gameBoard.querySelector(".tm-build-panel")?.remove();
  if (!svg) return;
  svg.querySelector(".tm-build")?.remove();
  svg.querySelectorAll(".tm-oct-choice").forEach((el) => el.classList.remove("tm-oct-choice"));
  svg.querySelectorAll(".tm-spot-choice").forEach((el) => el.classList.remove("tm-spot-choice"));
  svg.querySelectorAll(".tm-spot-picked").forEach((el) => el.classList.remove("tm-spot-picked"));
  if (!builder || boardMode !== "play") return;

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

  if (builder.done) {
    const last = builder.waypoints[builder.waypoints.length - 1];
    svg.querySelector(`.tm-spot[data-spot="${last.index}"]`)?.classList.add("tm-spot-picked");
  } else {
    builder.choices.octs.forEach((c) => octEls[c.index]?.g.classList.add("tm-oct-choice"));
    builder.choices.spots.forEach((c) =>
      svg.querySelector(`.tm-spot[data-spot="${c.index}"]`)?.classList.add("tm-spot-choice")
    );
  }
  renderBuildPanel();
}

function renderBuildPanel() {
  const panel = document.createElement("div");
  panel.className = "tm-build-panel";

  const dice = document.createElement("div");
  dice.className = "tm-build-dice";
  const reds = builderReds();
  for (let i = 0; i < Math.min(12, reds); i += 1) {
    const d = document.createElement("span");
    d.className = "tm-build-die";
    dice.appendChild(d);
  }
  panel.appendChild(dice);

  const hint = document.createElement("span");
  hint.className = "tm-build-hint";
  hint.textContent = builder.done
    ? ""
    : "";
  panel.appendChild(hint);

  const undoBtn = button("Undo", "");
  undoBtn.disabled = !builder.waypoints.length;
  undoBtn.addEventListener("click", builderUndo);
  panel.appendChild(undoBtn);

  const restartBtn = button("Restart", "");
  restartBtn.disabled = !builder.waypoints.length;
  restartBtn.addEventListener("click", builderRestart);
  panel.appendChild(restartBtn);

  if (builder.done) {
    const goBtn = button("Go", "", "primary-btn");
    goBtn.classList.add("tm-build-go");
    goBtn.addEventListener("click", builderGo);
    panel.appendChild(goBtn);
  }
  els.gameBoard.appendChild(panel);
}

// A parcel: a filled square or circle with a dark outline. Used on buildings,
// in the dock, and for the fly animation. Ticket-mode orange packages carry a
// letter — drawn on top when given.
function drawPackage(parent, shape, color, cx, cy, size, letter) {
  const el = shape === "circle"
    ? svgEl("circle", { cx, cy, r: size / 2, fill: color, class: "tm-pkg-shape" }, parent)
    : svgEl("rect", { x: cx - size / 2, y: cy - size / 2, width: size, height: size, rx: 1.5, fill: color, class: "tm-pkg-shape" }, parent);
  if (letter) {
    const t = svgEl("text", {
      x: cx, y: cy, class: "tm-pkg-letter", "font-size": Math.max(4, size * 0.62)
    }, parent);
    t.textContent = letter;
  }
  return el;
}

// Dock slot k, in the truck's local frame: two columns stacking upward.
function dockSlotLocal(k) {
  const col = k % 2;
  const row = Math.floor(k / 2);
  return [-10 + col * 7.5, 1.5 - row * 7.5];
}

function truckLocalToWorld(pos, lx, ly) {
  lx *= TRUCK_SCALE; // match the scale in truckTransform
  ly *= TRUCK_SCALE;
  const rad = (pos.angle * Math.PI) / 180;
  const y = Math.cos(rad) < 0 ? -ly : ly; // match the vertical flip in the transform
  return [
    pos.x + lx * Math.cos(rad) - y * Math.sin(rad),
    pos.y + lx * Math.sin(rad) + y * Math.cos(rad)
  ];
}

function renderCargo(id) {
  const layer = cargoEls[id];
  if (!layer) return;
  layer.innerHTML = "";
  const truck = trucksState.find((t) => t.id === id);
  if (!truck) return;
  let slot = 0;
  (truck.cargo ?? []).forEach((pkg) => {
    if (animatingPkgs.has(pkg.id)) return;
    const [lx, ly] = dockSlotLocal(slot);
    slot += 1;
    const shape = drawPackage(layer, pkg.shape, pkg.color, lx, ly, CARGO_SIZE, pkg.letter);
    shape.classList.add("tm-pkg-cargo");
    shape.setAttribute("data-pkg", pkg.id);
    shape.setAttribute("data-truck", id);
  });
}

// World position of the next free dock slot (where a picked-up parcel lands).
function nextDockWorld(id) {
  const truck = trucksState.find((t) => t.id === id);
  const used = (truck?.cargo ?? []).filter((p) => !animatingPkgs.has(p.id)).length;
  const [lx, ly] = dockSlotLocal(used);
  return truckLocalToWorld(truckPos[id] ?? { x: 0, y: 0, angle: 0 }, lx, ly);
}

// Place trucks at their spot (first sight) or drive them to a new one, and keep
// each truck's cargo stack in sync with server state.
function syncTrucks(trucks) {
  trucksState = trucks ?? [];
  // A truck that appeared mid-game (the Extra-truck card) has no element yet —
  // build one in place so it shows up without a full board rebuild.
  const layer = els.gameBoard.querySelector(".tm-map .tm-trucks");
  if (layer) {
    trucksState.forEach((t) => {
      if (!truckEls[t.id]) addTruckEl(layer, t);
    });
  }
  trucksState.forEach((t) => {
    // Still off the board: hidden here, shown as a garage truck under its
    // owner's score chip instead.
    if (t.spot == null) {
      if (truckEls[t.id]) truckEls[t.id].style.display = "none";
      return;
    }
    const spot = mapState.spots?.[t.spot];
    if (!spot || !truckEls[t.id]) return;
    truckEls[t.id].style.display = "";
    // Sharing a spot means a robbery in progress: the newcomer sits shy of the
    // occupant instead of stacking on top of it.
    const sharing = trucksState.some((o) => o.id !== t.id && o.spot === t.spot && o.id < t.id);
    const prev = truckSpots[t.id];
    if (prev == null) {
      // First placement: either a fresh board render (snap into place) or the
      // truck's drive in from off the board (animate its approved entry path).
      truckSpots[t.id] = t.spot;
      const pending = pendingRoutes[t.id];
      let entry = null;
      if (pending?.spot === t.spot) entry = pending;
      else if (aiMoveState && aiMoveState.truckId === t.id) entry = aiMoveState;
      delete pendingRoutes[t.id];
      if (entry?.path?.length >= 2) {
        const p0 = entry.path[0];
        const [dx, dy] = polyDir(entry.path);
        const occupied = trucksState.some((o) => o.id !== t.id && o.spot === t.spot);
        truckPos[t.id] = { x: p0[0], y: p0[1], angle: (Math.atan2(dy, dx) * 180) / Math.PI };
        truckTransform(t.id);
        startDrive(t.id, entry.path, entry.endAngle, occupied ? STEAL_GAP : 0);
        renderCargo(t.id);
        return;
      }
      let { x, y } = spot;
      if (sharing) {
        const rad = (spot.angle * Math.PI) / 180;
        x -= Math.cos(rad) * STEAL_GAP;
        y -= Math.sin(rad) * STEAL_GAP;
      }
      truckPos[t.id] = { x, y, angle: spot.angle };
      truckTransform(t.id);
    } else if (prev !== t.spot) {
      truckSpots[t.id] = t.spot;
      if (previewState?.truckId === t.id) clearPreview();
      const pending = pendingRoutes[t.id];
      delete pendingRoutes[t.id];
      // Prefer the exact route the mover took: the human's approved route, or
      // the AI's server-computed route. Both carry the true arrival facing, so
      // the truck never snaps around at the end. Fall back to a shortest path.
      let path;
      let endAngle;
      if (pending?.spot === t.spot) {
        path = pending.path;
        endAngle = pending.endAngle;
      } else if (aiMoveState && aiMoveState.truckId === t.id) {
        path = aiMoveState.path;
        endAngle = aiMoveState.endAngle;
      } else {
        const from = truckPos[t.id] || { x: spot.x, y: spot.y };
        path = findPath(getGraph(), from.x, from.y, spot.x, spot.y);
        endAngle = lastPathAngle(path, spot.angle);
      }
      const occupied = trucksState.some((o) => o.id !== t.id && o.spot === t.spot);
      startDrive(t.id, path, endAngle, occupied ? STEAL_GAP : 0);
    }
    renderCargo(t.id);
  });
}

// Start a truck's drive, or hold it while the dice roll / clock flip plays out
// so the truck doesn't move until those animations are over.
function startDrive(id, path, endAngle, stopShort = 0) {
  if (diceAnimating || flipping) {
    deferredDrives.push({ id, path, endAngle, stopShort });
    return;
  }
  driveTruck(id, path, endAngle, { stopShort, onArrive: () => onTruckArrive(id) });
}

function runDeferredDrives() {
  const list = deferredDrives;
  deferredDrives = [];
  list.forEach((d) =>
    driveTruck(d.id, d.path, d.endAngle, { stopShort: d.stopShort, onArrive: () => onTruckArrive(d.id) })
  );
}

// On arrival: fly in any packages this truck picked up/delivered mid-drive, and
// (for the human) offer a steal if it parked on a robbable truck. Ticket mode:
// parking at a special building opens its panel.
function onTruckArrive(id) {
  const evs = pendingFlies[id];
  if (evs) {
    delete pendingFlies[id];
    runPkgFlies(evs);
  }
  if (id === activeTruckId()) maybeOpenSteal();
  updateTurnControls(); // End turn re-enables once nothing is driving
  refreshBuilder();
  renderSpecialPanel();
}

// Travel direction at the end of a path (the truck's true arrival facing).
function lastPathAngle(path, fallback = 0) {
  if (!path || path.length < 2) return fallback;
  for (let i = path.length - 1; i > 0; i -= 1) {
    const dx = path[i][0] - path[i - 1][0];
    const dy = path[i][1] - path[i - 1][1];
    if (Math.hypot(dx, dy) > 0.01) return (Math.atan2(dy, dx) * 180) / Math.PI;
  }
  return fallback;
}

// After the human truck parks, offer a steal if it shares the spot with a
// weaker truck, it's night, it's our turn, and we haven't already robbed a
// different truck this turn.
function maybeOpenSteal() {
  clearSteal();
  // Night only, unless Day theft; one steal per turn; not after acting.
  if (!isMyTurn() || (!nightState && !hasAbil("day-theft")) || turnActed || turnStolen) return;
  const me = activeTruck();
  if (!me || me.spot == null) return;
  const myAggr = columnValue("agression", myPlayer());
  const victim = trucksState.find(
    (t) => t.id !== me.id && t.player !== myIndex() && t.spot === me.spot && (t.cargo?.length > 0) &&
      myAggr > columnValue("agression", playersState[t.player])
  );
  if (!victim) return;
  const diff = myAggr - columnValue("agression", playersState[victim.player]);
  stealSession = { victimId: victim.id, remaining: diff };
  renderCargo(victim.id);
  renderStealOverlay();
}

function clearSteal() {
  if (!stealSession) return;
  const victimId = stealSession.victimId;
  stealSession = null;
  els.gameBoard.querySelector(".tm-map .tm-steal")?.remove();
  truckEls[victimId]?.classList.remove("tm-steal-victim");
}

// The victim truck glows and a label above it shows steals left; clicking the
// truck (or a package in its dock) takes a package. The player leaves by moving.
function renderStealOverlay() {
  const svg = els.gameBoard.querySelector(".tm-map");
  if (!svg) return;
  svg.querySelector(".tm-steal")?.remove();
  if (!stealSession) return;
  const vp = truckPos[stealSession.victimId];
  if (!vp) return;
  truckEls[stealSession.victimId]?.classList.toggle("tm-steal-victim", stealSession.remaining > 0);
  const layer = svgEl("g", { class: "tm-steal" }, svg);
  const label = svgEl("g", { transform: `translate(${r1(vp.x)} ${r1(vp.y - 28)})` }, layer);
  svgEl("rect", { x: -46, y: -9, width: 92, height: 17, rx: 8, class: "tm-steal-label-bg" }, label);
  const lt = svgEl("text", { x: 0, y: 0, class: "tm-steal-label-text" }, label);
  lt.textContent = stealSession.remaining > 0 ? `Steal up to ${stealSession.remaining}` : "Move to continue";
}

// Take a package off the victim: optimistically move it locally for instant
// feedback (the server reconciles), decrement the steal budget.
function attemptSteal(pkgId) {
  if (!stealSession || stealSession.remaining <= 0) return;
  const me = activeTruck();
  const victim = trucksState.find((t) => t.id === stealSession.victimId);
  if (!me || !victim) return;
  const vIdx = (victim.cargo ?? []).findIndex((p) => p.id === pkgId);
  if (vIdx === -1) return;
  const pkg = victim.cargo[vIdx];

  const player = myPlayer();
  if (!canHoldPkg(me, player, pkg)) return;

  victim.cargo.splice(vIdx, 1);
  me.cargo.push(pkg);
  stealSession.remaining -= 1;
  socket.emit("truck_mania_steal", { roomId: app.roomId, truckId: me.id, victimTruckId: victim.id, packageId: pkgId });
  renderCargo(victim.id);
  renderCargo(me.id);
  renderStealOverlay();
}

// Clicking the glowing victim truck steals the first package we can hold.
function stealNextFromVictim() {
  if (!stealSession || stealSession.remaining <= 0) return;
  const me = activeTruck();
  const victim = trucksState.find((t) => t.id === stealSession.victimId);
  if (!me || !victim) return;
  const player = myPlayer();
  const pkg = (victim.cargo ?? []).find((p) => canHoldPkg(me, player, p));
  if (pkg) attemptSteal(pkg.id);
}

// Signed shortest angular difference a→b, in degrees (−180..180].
function angleDelta(a, b) {
  return ((b - a + 540) % 360) - 180;
}

// Animate a truck along a polyline at roughly constant speed. The heading eases
// toward the travel direction instead of snapping, so corners are taken as a
// gentle turn. opts.stopShort parks it that many px shy of the path's end (used
// to pull up behind a truck it's about to rob). Calls opts.onArrive on parking.
function driveTruck(id, path, endAngle, opts = {}) {
  if (truckAnim[id]) cancelAnimationFrame(truckAnim[id]);
  const cum = [0];
  for (let i = 1; i < path.length; i += 1) {
    cum.push(cum[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
  }
  const total = cum[cum.length - 1];
  const stopAt = Math.max(0, total - (opts.stopShort ?? 0));
  const last = path[path.length - 1];
  const park = () => {
    if (stopAt < total) {
      const s = sampleAlong(path, cum, stopAt);
      truckPos[id] = { x: s.x, y: s.y, angle: s.angle };
    } else {
      truckPos[id] = { x: last[0], y: last[1], angle: endAngle };
    }
    truckTransform(id);
  };
  if (stopAt < 1) {
    park();
    truckAnim[id] = null;
    opts.onArrive?.();
    return;
  }
  // Constant speed: no duration cap, so long routes take proportionally longer
  // instead of the truck silently speeding up.
  const duration = Math.max(250, (stopAt / TRUCK_SPEED) * 1000) / speedMult;
  const start = performance.now();

  const step = (now) => {
    const target = Math.min(stopAt, ((now - start) / duration) * stopAt);
    let i = 1;
    while (i < cum.length && cum[i] < target) i += 1;
    const a = path[i - 1];
    const b = path[Math.min(i, path.length - 1)];
    const segLen = (cum[i] ?? total) - cum[i - 1] || 1;
    const f = Math.max(0, Math.min(1, (target - cum[i - 1]) / segLen));
    const prev = truckPos[id]?.angle ?? 0;
    let angle = prev;
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 0.5) {
      const dir = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
      angle = prev + angleDelta(prev, dir) * 0.22; // ease into the turn
    }
    truckPos[id] = { x: a[0] + (b[0] - a[0]) * f, y: a[1] + (b[1] - a[1]) * f, angle };
    truckTransform(id);
    if (target < stopAt) {
      truckAnim[id] = requestAnimationFrame(step);
    } else {
      park();
      truckAnim[id] = null;
      opts.onArrive?.();
    }
  };
  truckAnim[id] = requestAnimationFrame(step);
}

// --------------------------------------------------------------------------
// Spots (parking places the player clicks to send a truck)
// --------------------------------------------------------------------------

function renderSpots(svg) {
  const layer = svgEl("g", { class: "tm-spots" }, svg);
  (mapState.spots ?? []).forEach((spot, i) => {
    const g = svgEl("g", { class: "tm-spot", "data-spot": i }, layer);
    svgEl("circle", { cx: spot.x, cy: spot.y, r: 9, class: "tm-spot-ring" }, g);
    svgEl("circle", { cx: spot.x, cy: spot.y, r: 11, class: "tm-spot-hit", fill: "transparent" }, g);
  });
}

// --------------------------------------------------------------------------
// Packages on pickup buildings + pickup/dropoff interactions
// --------------------------------------------------------------------------

function buildingsByBid() {
  const map = new Map();
  (mapState.blocks ?? []).forEach((block) => {
    (block.buildings ?? []).forEach((b) => map.set(b.bid, b));
  });
  return map;
}

function polyCentroid(points) {
  let x = 0;
  let y = 0;
  points.forEach((p) => {
    x += p[0];
    y += p[1];
  });
  return [x / points.length, y / points.length];
}

// Generated maps hold rect buildings (x/y/w/h, no points); edited maps hold
// polys. Centroid works for both.
function buildingCentroid(b) {
  if (b.points) return polyCentroid(b.points);
  return [b.x + b.w / 2, b.y + b.h / 2];
}

// Slot i of a building's 3-wide package grid, growing downward from the top row.
function bldPkgSlot(cx, cy, i) {
  const col = i % 3;
  const row = Math.floor(i / 3);
  return [cx + (col - 1) * (BLD_PKG_SIZE + 3), cy + (row - 0.5) * (BLD_PKG_SIZE + 3)];
}

function drawBuildingPackages(layer) {
  const DELIVERED = "#23272e"; // the flipped "black side"
  (mapState.blocks ?? []).forEach((block) => {
    (block.buildings ?? []).forEach((b) => {
      const [cx, cy] = buildingCentroid(b);
      // Dropoff capacity: a grey dotted square outline per slot, filled by
      // deliveries (circles land on a square slot too).
      if (b.role === "dropoff" && b.dropoffLimit) {
        for (let i = 0; i < b.dropoffLimit; i += 1) {
          const [px, py] = bldPkgSlot(cx, cy, i);
          svgEl("rect", {
            x: px - BLD_PKG_SIZE / 2, y: py - BLD_PKG_SIZE / 2,
            width: BLD_PKG_SIZE, height: BLD_PKG_SIZE, rx: 1.5,
            class: "tm-dropoff-slot"
          }, layer);
        }
      }
      const delivered = (b.delivered ?? []).filter((p) => !animatingPkgs.has(p.id));
      delivered.forEach((pkg, i) => {
        const [px, py] = bldPkgSlot(cx, cy, i);
        const g = svgEl("g", { class: "tm-pkg tm-pkg-delivered" }, layer);
        drawPackage(g, pkg.shape, DELIVERED, px, py, BLD_PKG_SIZE);
      });
      const pkgs = (b.packages ?? []).filter((p) => !animatingPkgs.has(p.id));
      pkgs.forEach((pkg, i) => {
        const [px, py] = bldPkgSlot(cx, cy, i);
        pkgPos[pkg.id] = [px, py];
        const g = svgEl("g", { class: "tm-pkg tm-pkg-building", "data-pkg": pkg.id, "data-bid": b.bid }, layer);
        drawPackage(g, pkg.shape, pkg.color, px, py, BLD_PKG_SIZE, pkg.letter);
      });
    });
  });
}

function renderBuildingPackages(svg) {
  drawBuildingPackages(svgEl("g", { class: "tm-bld-pkgs" }, svg));
}

// The bid of the building the active truck is currently parked at.
function truckBuildingBid() {
  const truck = activeTruck();
  const spot = truck ? mapState.spots?.[truck.spot] : null;
  return spot ? spot.building : null;
}

// Buildings the human's active truck can use: its spot's building, or — with
// Free parking — every building in the same block. Mirrors the server.
function usableBuildingsClient() {
  const truck = activeTruck();
  const spot = truck ? mapState.spots?.[truck.spot] : null;
  if (!spot) return [];
  const ownBid = spot.building;
  if (!hasAbil("free-parking")) {
    const b = buildingsByBid().get(ownBid);
    return b ? [b] : [];
  }
  const block = (mapState.blocks ?? []).find((bl) => (bl.buildings ?? []).some((b) => b.bid === ownBid));
  return block ? (block.buildings ?? []).slice() : [];
}

function usableBids() {
  return new Set(usableBuildingsClient().map((b) => b.bid));
}

// Temp parcel that flies from `from` to `to`, then runs onDone.
function flyPackage(shape, color, from, to, onDone, letter) {
  const svg = els.gameBoard.querySelector(".tm-map");
  if (!svg) {
    onDone?.();
    return;
  }
  let layer = svg.querySelector(".tm-fly");
  if (!layer) layer = svgEl("g", { class: "tm-fly" }, svg);
  const g = svgEl("g", {}, layer);
  drawPackage(g, shape, color, 0, 0, CARGO_SIZE + 1, letter);
  const dur = 360 / speedMult;
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / dur);
    const e = t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
    g.setAttribute("transform", `translate(${from[0] + (to[0] - from[0]) * e} ${from[1] + (to[1] - from[1]) * e})`);
    if (t < 1) requestAnimationFrame(step);
    else {
      g.remove();
      onDone?.();
    }
  };
  requestAnimationFrame(step);
}

// The value list for a column — from the room's tunable settings when present,
// else the classic defaults baked into PB_COLUMNS.
function columnValuesFor(colId) {
  const vals = settingsState?.columns?.[colId];
  if (Array.isArray(vals) && vals.length) return vals;
  return pbColumns().find((c) => c.id === colId)?.values ?? [];
}

// Current value of a player-board column (e.g. capacity 2→7), by its level.
function columnValue(colId, player) {
  const vals = columnValuesFor(colId);
  if (!vals.length) return undefined;
  return vals[Math.min(player?.columns?.[colId] ?? 0, vals.length - 1)];
}

// Mirrors the server's cargo limits so we never animate a doomed pickup or
// steal: capacity, then variety (distinct colors) — or, in fragility mode,
// the fragile slots circles take up (a circle uses a normal AND fragile slot).
function canHoldPkg(truck, player, pkg) {
  if ((truck.cargo?.length ?? 0) >= columnValue("capacity", player)) return false;
  if (isFragilityMode()) {
    return pkg.shape !== "circle" ||
      (truck.cargo ?? []).filter((p) => p.shape === "circle").length < columnValue("fragile", player);
  }
  const colors = new Set((truck.cargo ?? []).map((p) => p.color));
  return colors.has(pkg.color) || colors.size < columnValue("variety", player);
}

function attemptPickup(pkgId, bid) {
  const truck = activeTruck();
  if (!truck || truckShares(truck) || !usableBids().has(bid)) return;
  if (amSuspended()) return; // face-down tickets ground package work
  const building = buildingsByBid().get(bid);
  const pkg = building?.packages?.find((p) => p.id === pkgId);
  if (!pkg) return;

  // Mirror the server's limits so we don't animate a doomed pickup: locked
  // protected locations, then the cargo limits (capacity + variety/fragile).
  const player = playersState[truck.player] ?? myPlayer();
  if (building.protected && building.letter && !(player?.locations ?? []).includes(building.letter)) return;
  if (!canHoldPkg(truck, player, pkg)) return;

  const from = pkgPos[pkgId] || buildingCentroid(building);
  const to = nextDockWorld(truck.id);
  animatingPkgs.add(pkgId);
  renderBuildingPackagesRefresh();
  socket.emit("truck_mania_pickup", { roomId: app.roomId, truckId: truck.id, packageId: pkgId });
  flyPackage(pkg.shape, pkg.color, from, to, () => {
    animatingPkgs.delete(pkgId);
    renderCargo(truck.id);
    renderBuildingPackagesRefresh();
  }, pkg.letter);
}

// Fly a parcel to the dropoff slot, then flip it over to its black side —
// a permanent marker of a delivery at that location.
function animateDropoff(pkg, from, to, onDone) {
  const svg = els.gameBoard.querySelector(".tm-map");
  if (!svg) {
    onDone?.();
    return;
  }
  let layer = svg.querySelector(".tm-fly");
  if (!layer) layer = svgEl("g", { class: "tm-fly" }, svg);
  const g = svgEl("g", {}, layer);
  const shapeEl = drawPackage(g, pkg.shape, pkg.color, 0, 0, BLD_PKG_SIZE, pkg.letter);
  const flyDur = 360 / speedMult;
  const flipDur = 300 / speedMult;
  const start = performance.now();
  let flipped = false;

  const step = (now) => {
    const t = now - start;
    if (t < flyDur) {
      const p = t / flyDur;
      const e = p < 0.5 ? 2 * p * p : 1 - ((-2 * p + 2) ** 2) / 2;
      g.setAttribute("transform", `translate(${from[0] + (to[0] - from[0]) * e} ${from[1] + (to[1] - from[1]) * e})`);
    } else if (t < flyDur + flipDur) {
      const p = (t - flyDur) / flipDur;
      if (p >= 0.5 && !flipped) {
        flipped = true;
        shapeEl.setAttribute("fill", "#23272e");
      }
      g.setAttribute("transform", `translate(${to[0]} ${to[1]}) scale(${Math.abs(1 - 2 * p)} 1)`);
    } else {
      g.remove();
      onDone?.();
      return;
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function attemptDropoff(pkgId) {
  const truck = activeTruck();
  if (!truck || truckShares(truck)) return false;
  if (amSuspended()) return false; // face-down tickets ground package work
  const pkg = truck.cargo?.find((p) => p.id === pkgId);
  if (!pkg) return false;
  const building = usableBuildingsClient().find((b) =>
    b.role === "dropoff" && b.dropoffColor === pkg.color &&
    (b.delivered?.length ?? 0) < (b.dropoffLimit ?? Infinity));
  if (!building) return false;
  const from = truckLocalToWorld(truckPos[truck.id] ?? { x: 0, y: 0, angle: 0 }, ...dockSlotLocal(truck.cargo.indexOf(pkg)));
  const [cx, cy] = buildingCentroid(building);
  const slot = (building.delivered ?? []).filter((p) => !animatingPkgs.has(p.id)).length;
  const to = bldPkgSlot(cx, cy, slot);
  animatingPkgs.add(pkgId);
  renderCargo(truck.id);
  socket.emit("truck_mania_dropoff", { roomId: app.roomId, truckId: truck.id, packageId: pkgId });
  animateDropoff(pkg, from, to, () => {
    animatingPkgs.delete(pkgId);
    renderCargo(truck.id);
    renderBuildingPackagesRefresh();
  });
  return true;
}

// Regret a pickup: fly the package back onto the building it was just taken
// from. Only packages picked up this turn, and only while still parked there.
function attemptPutback(pkgId) {
  const truck = activeTruck();
  if (!truck || truckShares(truck)) return;
  const entry = turnPickups.find((e) => e.pkg === pkgId);
  if (!entry) return;
  const pkg = truck.cargo?.find((p) => p.id === pkgId);
  if (!pkg) return;
  const building = usableBuildingsClient().find((b) => b.bid === entry.bid && b.role === "pickup");
  if (!building) return;
  const from = truckLocalToWorld(truckPos[truck.id] ?? { x: 0, y: 0, angle: 0 }, ...dockSlotLocal(truck.cargo.indexOf(pkg)));
  const [cx, cy] = buildingCentroid(building);
  const slot = (building.packages ?? []).filter((p) => !animatingPkgs.has(p.id)).length;
  const to = bldPkgSlot(cx, cy, slot);
  animatingPkgs.add(pkgId);
  renderCargo(truck.id);
  socket.emit("truck_mania_putback", { roomId: app.roomId, truckId: truck.id, packageId: pkgId });
  flyPackage(pkg.shape, pkg.color, from, to, () => {
    animatingPkgs.delete(pkgId);
    renderCargo(truck.id);
    renderBuildingPackagesRefresh();
  }, pkg.letter);
}

// Snapshot where every package currently lives, so the next state can be diffed
// to animate other players' pickups/deliveries (ours already animate locally).
function snapshotPkgs() {
  const cargo = {};
  trucksState.forEach((t) => { cargo[t.id] = new Set((t.cargo ?? []).map((p) => p.id)); });
  const buildingPkg = new Map();
  const delivered = new Set();
  (mapState?.blocks ?? []).forEach((bl) => (bl.buildings ?? []).forEach((b) => {
    (b.packages ?? []).forEach((p) => buildingPkg.set(p.id, b.bid));
    (b.delivered ?? []).forEach((p) => delivered.add(p.id));
  }));
  return { cargo, buildingPkg, delivered };
}

// Packages that changed hands between `before` and the new state `tm`, that we
// aren't already animating ourselves — an AI pickup (building→truck) or
// delivery (truck→building).
function diffPkgEvents(before, tm) {
  const events = [];
  (tm.trucks ?? []).forEach((t) => {
    const oldSet = before.cargo[t.id] ?? new Set();
    (t.cargo ?? []).forEach((pkg) => {
      if (oldSet.has(pkg.id) || animatingPkgs.has(pkg.id)) return;
      if (before.buildingPkg.has(pkg.id)) {
        events.push({ type: "pickup", pkg, truckId: t.id, bid: before.buildingPkg.get(pkg.id) });
      } // else it was stolen from another truck — no fly
    });
  });
  (tm.map.blocks ?? []).forEach((bl) => (bl.buildings ?? []).forEach((b) => {
    (b.delivered ?? []).forEach((pkg) => {
      if (before.delivered.has(pkg.id) || animatingPkgs.has(pkg.id)) return;
      let fromTruck = null;
      for (const tid of Object.keys(before.cargo)) {
        if (before.cargo[tid].has(pkg.id)) fromTruck = Number(tid);
      }
      events.push({ type: "dropoff", pkg, truckId: fromTruck, bid: b.bid });
    });
  }));
  return events;
}

// Route diffed package flies: run them now if the truck is parked, or hold them
// until it arrives if it's driving (or about to, once the dice settle).
function dispatchFlies(events) {
  const byTruck = {};
  events.forEach((e) => (byTruck[e.truckId] ??= []).push(e));
  Object.entries(byTruck).forEach(([tid, evs]) => {
    const id = Number(tid);
    const moving = truckAnim[id] != null || diceAnimating || flipping ||
      deferredDrives.some((d) => d.id === id) || pendingFlies[id];
    if (moving) (pendingFlies[id] ??= []).push(...evs);
    else runPkgFlies(evs);
  });
}

// Flies held for a truck that isn't actually going to move (e.g. an AI that
// changed the clock, then acted in place): release them once the blocking
// animation ends.
function flushIdleFlies() {
  Object.keys(pendingFlies).forEach((k) => {
    const id = Number(k);
    if (truckAnim[id] == null && !deferredDrives.some((d) => d.id === id) &&
      !diceAnimating && !flipping) {
      const evs = pendingFlies[id];
      delete pendingFlies[id];
      runPkgFlies(evs);
    }
  });
}

// Fly each diffed package from its old home to its new one (staggered).
function runPkgFlies(events) {
  events.forEach((e, i) => {
    setTimeout(() => {
      if (!animatingPkgs.has(e.pkg.id)) return;
      const b = buildingsByBid().get(e.bid);
      if (e.type === "pickup") {
        const from = pkgPos[e.pkg.id] || (b ? buildingCentroid(b) : [0, 0]);
        const tp = truckPos[e.truckId] || { x: from[0], y: from[1] };
        flyPackage(e.pkg.shape, e.pkg.color, from, [tp.x, tp.y], () => {
          animatingPkgs.delete(e.pkg.id);
          renderCargo(e.truckId);
          renderBuildingPackagesRefresh();
        }, e.pkg.letter);
      } else {
        const tp = truckPos[e.truckId] || { x: 0, y: 0 };
        const [cx, cy] = b ? buildingCentroid(b) : [0, 0];
        const slot = (b?.delivered ?? []).filter((p) => !animatingPkgs.has(p.id)).length;
        animateDropoff(e.pkg, [tp.x, tp.y], bldPkgSlot(cx, cy, slot), () => {
          animatingPkgs.delete(e.pkg.id);
          renderCargo(e.truckId);
          renderBuildingPackagesRefresh();
        });
      }
    }, (i * 130) / speedMult);
  });
}

// Redraw just the building-package layer in place (above the buildings layer).
function renderBuildingPackagesRefresh() {
  const svg = els.gameBoard.querySelector(".tm-map");
  if (!svg) return;
  svg.querySelector(".tm-bld-pkgs")?.remove();
  const layer = svgEl("g", { class: "tm-bld-pkgs" });
  const blocks = svg.querySelector(".tm-blocks");
  if (blocks) blocks.after(layer);
  else svg.appendChild(layer);
  drawBuildingPackages(layer);
}

// Can the human steal from truck `vid` (would drive over and rob it)?
function canStealTarget(vid) {
  if ((!nightState && !hasAbil("day-theft")) || turnActed || turnStolen) return false;
  const victim = trucksState.find((t) => t.id === vid);
  if (!victim || !(victim.cargo?.length > 0)) return false;
  return columnValue("agression", myPlayer()) > columnValue("agression", playersState[victim.player]);
}

// Preview the routes to a spot index (or clear if not reachable / same spot).
function previewTo(spotIndex) {
  const truck = activeTruck();
  const dest = mapState.spots?.[spotIndex];
  const pos = truck ? truckPos[truck.id] : null;
  if (!truck || !dest || !pos || truck.spot === spotIndex) {
    clearPreview();
    return;
  }
  const canUturn = !!myPlayer()?.abilities?.includes("uturn");
  const routes = findRoutes(getGraph(), pos.x, pos.y, pos.angle, dest.x, dest.y, canUturn);
  if (!routes.length) {
    clearPreview();
    window.alert("No route: the truck can't reach that spot without a U-turn.");
    return;
  }
  previewState = { truckId: truck.id, spot: spotIndex, routes };
  renderRoutePreview();
}

function anyTruckAnimating() {
  return Object.values(truckAnim).some((h) => h != null);
}

function onBoardClick(event) {
  if (editor || !app.roomId || !isMyTurn() || diceAnimating || anyTruckAnimating()) return;

  // Steal from the truck we've pulled up behind: click the glowing truck to
  // take its next package, or a specific package in its dock.
  if (stealSession) {
    const victimPkg = event.target.closest?.(".tm-pkg-cargo");
    if (victimPkg && Number(victimPkg.dataset.truck) === stealSession.victimId) {
      attemptSteal(victimPkg.dataset.pkg);
      return;
    }
    const victimTruck = event.target.closest?.(".tm-truck");
    if (victimTruck && Number(victimTruck.dataset.truck) === stealSession.victimId) {
      stealNextFromVictim();
      return;
    }
  }

  // Deliver from the active truck's dock — or, if nothing here takes the
  // package, put a just-picked-up one back where it came from.
  const cargoPkg = event.target.closest?.(".tm-pkg-cargo");
  if (cargoPkg && Number(cargoPkg.dataset.truck) === activeTruckId()) {
    if (!attemptDropoff(cargoPkg.dataset.pkg)) attemptPutback(cargoPkg.dataset.pkg);
    return;
  }
  const bldPkg = event.target.closest?.(".tm-pkg-building");
  if (bldPkg) {
    attemptPickup(bldPkg.dataset.pkg, Number(bldPkg.dataset.bid));
    return;
  }

  // Build mode: clicks add to the path under construction. Anything that isn't
  // a legal next light/dot is ignored — a stray click never kills the path.
  // Entering from off the board always goes through the builder, whatever the
  // route mode.
  if (moveMode === "build" || builder?.entry) {
    if (!builder || turnActed) return;
    const octG = event.target.closest?.(".tm-oct");
    if (octG && octG.dataset.oct != null) {
      const i = Number(octG.dataset.oct);
      if (!builder.done && builder.choices.octs.some((c) => c.index === i)) builderAddOct(i);
      return;
    }
    const truckEl = event.target.closest?.(".tm-truck");
    if (truckEl && truckEl.dataset.truck != null) {
      const tid = Number(truckEl.dataset.truck);
      const clicked = trucksState.find((t) => t.id === tid);
      if (clicked?.player === myIndex()) {
        if ((turnTruck == null || turnTruck === tid) && tid !== selectedTruckId) {
          selectedTruckId = tid;
          renderTruckHighlight();
          refreshBuilder();
        }
        return;
      }
      // Clicking a robbable truck ends the path on its spot (the steal setup).
      if (!builder.done && clicked && builder.choices.spots.some((c) => c.index === clicked.spot)) {
        builderAddSpot(clicked.spot);
      }
      return;
    }
    const spotEl = event.target.closest?.(".tm-spot");
    if (spotEl && !builder.done) {
      const i = Number(spotEl.dataset.spot);
      if (builder.choices.spots.some((c) => c.index === i)) builderAddSpot(i);
    }
    return;
  }

  // Commit a previewed route.
  const routeEl = event.target.closest?.(".tm-route-hit");
  if (routeEl) {
    commitRoute(Number(routeEl.dataset.route));
    return;
  }

  // Click a truck: select one of your own (to aim it), or rob an opponent.
  const truckEl = event.target.closest?.(".tm-truck");
  if (truckEl && truckEl.dataset.truck != null) {
    const tid = Number(truckEl.dataset.truck);
    const clicked = trucksState.find((t) => t.id === tid);
    if (clicked?.player === myIndex()) {
      // Switch which truck you're aiming (unless one is already locked in).
      if ((turnTruck == null || turnTruck === tid) && tid !== selectedTruckId) {
        selectedTruckId = tid;
        clearPreview();
        renderTruckHighlight();
      }
      return;
    }
    if (!turnActed && canStealTarget(tid)) {
      previewTo(clicked?.spot);
      return;
    }
  }

  if (turnActed) {
    clearPreview();
    return; // movement is over for this turn
  }

  const spotEl = event.target.closest?.(".tm-spot");
  if (!spotEl) {
    clearPreview();
    return;
  }
  const spotIdx = Number(spotEl.dataset.spot);
  // A spot holds one truck; you can only reach an occupied one by stealing
  // (click the truck, not the spot).
  if (trucksState.some((t) => t.id !== activeTruckId() && t.spot === spotIdx)) {
    clearPreview();
    return;
  }
  previewTo(spotIdx);
}

// --------------------------------------------------------------------------
// Player board
// --------------------------------------------------------------------------

function myPlayer() {
  return playersState[app.myPlayerIndex] ?? playersState[0];
}

// Floating preview of a player's full board, shown while hovering their chip.
function showPlayerStatsTip(player, anchor) {
  hidePlayerStatsTip();
  const tip = document.createElement("div");
  tip.className = "tm-stats-tip";
  renderTimeStones(tip, player.timeStones ?? 0);
  if (isTicketMode()) {
    renderMoney(tip, player.money ?? 0);
    tip.appendChild(buildTicketsRow(player));
  }
  tip.appendChild(buildPlayerPanel(player));
  document.body.appendChild(tip);
  const r = anchor.getBoundingClientRect();
  const tw = tip.offsetWidth;
  let left = r.left + r.width / 2 - tw / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
  tip.style.left = `${left}px`;
  tip.style.top = `${r.bottom + 8}px`;
}

function hidePlayerStatsTip() {
  document.querySelector(".tm-stats-tip")?.remove();
}

// Scoreboard in the game header: every player as a color chip with their score.
// Hovering a chip previews that player's full board (stats).
function renderScoreboard() {
  const header = document.querySelector(".game-header");
  header?.querySelector(".tm-scoreboard")?.remove();
  hidePlayerStatsTip();
  if (!header || !playersState.length) return;
  const bar = document.createElement("div");
  bar.className = "tm-scoreboard";
  playersState.forEach((p, i) => {
    const chip = document.createElement("div");
    chip.className = "tm-score";
    chip.dataset.player = i;
    chip.style.setProperty("--pcolor", p.color);
    if (winnerState === i) chip.classList.add("tm-score-winner");
    // Light up whoever's turn it is, so it's obvious who is acting.
    if (winnerState == null && turnWhose === i) chip.classList.add("tm-score-turn");
    const dot = document.createElement("span");
    dot.className = "tm-score-dot";
    dot.style.background = p.color;
    const val = document.createElement("span");
    val.className = "tm-score-val";
    if (isTicketMode()) {
      // Race progress: completed columns out of the number needed to win.
      val.textContent = `${completedColumnsOf(p)}/${settingsState?.columnsToWin ?? 3}`;
      chip.append(dot, val);
      const owed = (p.tickets?.length ?? 0) + (p.ticketPileCount ?? 0);
      if (owed > 0) {
        const tk = document.createElement("span");
        tk.className = "tm-score-tickets";
        tk.textContent = `🎫${owed}`;
        chip.appendChild(tk);
      }
    } else {
      val.textContent = String(p.points ?? 0);
      chip.append(dot, val);
    }
    // Trucks that haven't entered the board yet wait in a little garage row
    // under their owner's chip.
    const garage = trucksState.filter((t) => t.player === i && t.spot == null);
    if (garage.length) {
      const g = document.createElement("div");
      g.className = "tm-score-garage";
      garage.forEach(() => {
        const svg = svgEl("svg", { viewBox: "-17 -13 34 24", class: "tm-garage-truck" });
        makeTruckShape(svg, p.color);
        g.appendChild(svg);
      });
      chip.appendChild(g);
    }
    chip.addEventListener("mouseenter", () => showPlayerStatsTip(p, chip));
    chip.addEventListener("mouseleave", hidePlayerStatsTip);
    bar.appendChild(chip);
  });
  header.appendChild(bar);
}

// The nine 3×3 pip positions lit for each die face.
const DIE_PIPS = {
  1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8]
};

function makeDieEl(d, settled, aversion) {
  const die = document.createElement("div");
  if (!settled) die.className = "tm-die tm-die-rolling";
  else die.className = `tm-die ${d > aversion ? "tm-die-ticket" : "tm-die-safe"}`;
  (DIE_PIPS[d] ?? []).forEach((pos) => {
    const pip = document.createElement("span");
    pip.className = "tm-pip";
    pip.style.gridArea = `${Math.floor(pos / 3) + 1} / ${(pos % 3) + 1}`;
    die.appendChild(pip);
  });
  return die;
}

function setDiceHead(head, roll, settled) {
  const who = playersState[roll.player]?.name ?? "Player";
  head.className = "tm-dice-head";
  if (!settled) {
    head.textContent = `${who} rolling…`;
  } else if (roll.tickets > 0) {
    if (roll.mode === "tickets") {
      // Ticket mode: no points — failed dice hand out literal tickets.
      head.textContent = `${who}: +${roll.tickets} ticket${roll.tickets > 1 ? "s" : ""} 🎫`;
    } else {
      const loss = roll.loss ?? roll.tickets;
      head.textContent = `${who}: ${roll.tickets} ticket${roll.tickets > 1 ? "s" : ""} · −${loss}`;
    }
    head.classList.add("tm-dice-bad");
  } else {
    head.textContent = `${who}: no tickets`;
    head.classList.add("tm-dice-good");
  }
}

function setDiceFaces(row, roll, faces, settled) {
  row.innerHTML = "";
  faces.forEach((d) => row.appendChild(makeDieEl(d, settled, roll.aversion)));
}

// Draw the dice panel under the clock. `faces` are the pip counts to show;
// while `settled` is false the dice are mid-roll (no ticket/safe coloring yet).
// `big` scales the whole panel up for the roll sequence. Shown for whoever
// rolled, to everyone.
function renderDicePanel(roll, faces, settled, big = false) {
  els.gameBoard.querySelector(".tm-dice")?.remove();
  if (!roll || !faces?.length) return;

  const wrap = document.createElement("div");
  wrap.className = `tm-dice${big ? " tm-dice-big" : ""}`;
  const head = document.createElement("div");
  setDiceHead(head, roll, settled);
  wrap.appendChild(head);

  const row = document.createElement("div");
  row.className = "tm-dice-row";
  setDiceFaces(row, roll, faces, settled);
  wrap.appendChild(row);
  els.gameBoard.appendChild(wrap);
}

// Static panel for the most recent roll (used on plain re-renders).
function renderDice() {
  if (diceAnimating) return; // the animation owns the panel
  const roll = lastRollState;
  if (!roll || !roll.dice?.length) {
    els.gameBoard.querySelector(".tm-dice")?.remove();
    return;
  }
  renderDicePanel(roll, roll.dice, true);
}

// The roll sequence, in beats: the dice grow and shake while tumbling, settle
// on the real faces (still big), then — if points were lost — a clear "−N"
// beat on the panel and the roller's score chip, and only then does onDone run
// (which releases the deferred truck drive). Keep the totals here in sync with
// the server's AI turn delays (game.js DICE_MS_*).
function animateDiceRoll(roll, onDone) {
  const n = roll.dice.length;
  const rnd = () => Array.from({ length: n }, () => 1 + Math.floor(Math.random() * 6));
  renderDicePanel(roll, rnd(), false, true); // panel built once, faces updated in place
  const wrap = els.gameBoard.querySelector(".tm-dice");
  const head = wrap?.querySelector(".tm-dice-head");
  const row = wrap?.querySelector(".tm-dice-row");
  let elapsed = 0;
  const iv = setInterval(() => {
    elapsed += 90;
    if (elapsed < 1300 / speedMult) {
      if (row) setDiceFaces(row, roll, rnd(), false);
    } else {
      clearInterval(iv);
      if (row) setDiceFaces(row, roll, roll.dice, true);
      if (head) setDiceHead(head, roll, true);
      const hasLoss = roll.tickets > 0;
      if (hasLoss) setTimeout(() => flashLoss(roll), 250 / speedMult);
      setTimeout(() => {
        els.gameBoard.querySelector(".tm-dice")?.classList.remove("tm-dice-big");
        onDone();
      }, (hasLoss ? 2100 : 900) / speedMult);
    }
  }, 90);
}

// The bad-roll beat: a big "−N" (points mode) or "+N 🎫" (ticket mode)
// popping off the dice panel, and the same figure flashing on the roller's
// scoreboard chip.
function flashLoss(roll) {
  const amount = roll.mode === "tickets" ? `+${roll.tickets} 🎫` : `−${roll.loss ?? roll.tickets}`;
  const wrap = els.gameBoard.querySelector(".tm-dice");
  if (wrap) {
    const loss = document.createElement("div");
    loss.className = "tm-dice-loss";
    loss.textContent = amount;
    wrap.appendChild(loss);
    setTimeout(() => loss.remove(), 1900);
  }
  const chip = document.querySelector(`.tm-scoreboard .tm-score[data-player="${roll.player}"]`);
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

// --------------------------------------------------------------------------
// Location / ability decks
// --------------------------------------------------------------------------

function makeDeckCard(deckId, card) {
  const c = document.createElement("div");
  c.className = `tm-card tm-card-${deckId}`;
  if (deckId === "locations") {
    c.textContent = card;
  } else {
    c.textContent = ABILITY_LABELS[card] ?? card;
  }
  return c;
}

// One deck: a face-down stack (draw random) plus its two face-up options. When
// the current player owes a draft of this deck, the stack and cards light up
// and become clickable.
function makeDeckRow(deckId, title, data, active) {
  const row = document.createElement("div");
  row.className = `tm-deck-row${active ? " tm-deck-active" : ""}`;

  const stack = document.createElement("div");
  stack.className = "tm-deck-stack";
  const name = document.createElement("span");
  name.className = "tm-deck-name";
  name.textContent = title;
  stack.appendChild(name);
  const count = document.createElement("span");
  count.className = "tm-deck-count";
  count.textContent = String(data?.remaining ?? 0);
  stack.appendChild(count);
  if (active && (data?.remaining ?? 0) > 0) {
    stack.dataset.draftDeck = deckId;
    stack.dataset.draftChoice = "random";
    stack.title = "Draw a random card";
  }
  row.appendChild(stack);

  const shown = document.createElement("div");
  shown.className = "tm-deck-shown";
  (data?.shown ?? []).forEach((card, i) => {
    const c = makeDeckCard(deckId, card);
    if (active) {
      c.dataset.draftDeck = deckId;
      c.dataset.draftChoice = `shown${i}`;
      c.classList.add("tm-card-pick");
    }
    shown.appendChild(c);
  });
  row.appendChild(shown);
  return row;
}

function renderDecks() {
  els.gameBoard.querySelector(".tm-decks")?.remove();
  if (!decksState || isTicketMode()) return; // no card decks in ticket mode
  const myDrafts = myPlayer()?.pendingDrafts ?? [];
  const panel = document.createElement("div");
  panel.className = "tm-decks";
  panel.appendChild(makeDeckRow("locations", "Locations", decksState.locations, myDrafts.includes("locations")));
  panel.appendChild(makeDeckRow("abilities", "Abilities", decksState.abilities, myDrafts.includes("abilities")));
  panel.addEventListener("click", (event) => {
    const el = event.target.closest?.("[data-draft-deck]");
    if (!el || !app.roomId) return;
    const deck = el.dataset.draftDeck;
    if (!(myPlayer()?.pendingDrafts ?? []).includes(deck)) return;
    socket.emit("truck_mania_draft", { roomId: app.roomId, deck, choice: el.dataset.draftChoice });
  });
  els.gameBoard.appendChild(panel);
}

// --------------------------------------------------------------------------
// Ticket-mode special locations: mechanic / pawn shop / courthouse. Parking at
// one opens its panel; every use ends the turn's movement (server-enforced).
// --------------------------------------------------------------------------

const TRACK_LABELS = {
  capacity: "Capacity", variety: "Variety", fragile: "Fragile cap.",
  aversion: "Aversion", agression: "Agression", timestones: "Time stones",
  money: "Money"
};

// The special building the human's active truck is parked at, if usable now.
function specialBuildingHere() {
  if (!isTicketMode() || !isMyTurn() || winnerState != null || !mapState) return null;
  const truck = activeTruck();
  if (!truck || truckShares(truck) || truckAnim[truck.id] != null) return null;
  const spot = mapState.spots?.[truck.spot];
  const b = spot != null ? buildingsByBid().get(spot.building) : null;
  return b && b.role === "special" ? b : null;
}

function renderSpecialPanel() {
  els.gameBoard.querySelector(".tm-special")?.remove();
  const b = specialBuildingHere();
  if (!b) return;
  const me = myPlayer();
  const money = me?.money ?? 0;
  const truck = activeTruck();

  const panel = document.createElement("div");
  panel.className = "tm-special";
  const head = document.createElement("div");
  head.className = "tm-special-head";
  head.textContent = `${b.icon ?? ""} ${b.name ?? ""}`;
  const purse = document.createElement("span");
  purse.className = "tm-special-purse";
  purse.textContent = `${money} 🪙`;
  head.appendChild(purse);
  panel.appendChild(head);

  if (b.special === "mechanic") {
    const costs = settingsState?.abilityCosts ?? {};
    const list = document.createElement("div");
    list.className = "tm-special-list";
    Object.keys(ABILITY_LABELS).forEach((id) => {
      const owned = (me?.abilities ?? []).includes(id);
      const cost = costs[id];
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ghost-btn tm-special-item";
      btn.textContent = owned
        ? `✓ ${ABILITY_ICONS[id]} ${ABILITY_LABELS[id]}`
        : `${ABILITY_ICONS[id]} ${ABILITY_LABELS[id]} · ${cost ?? "?"} 🪙`;
      btn.disabled = owned || !Number.isInteger(cost) || cost > money;
      if (owned) btn.classList.add("tm-special-owned");
      btn.addEventListener("click", () => {
        socket.emit("truck_mania_buy_ability", { roomId: app.roomId, truckId: truck.id, ability: id });
      });
      list.appendChild(btn);
    });
    panel.appendChild(list);
  } else if (b.special === "pawnshop") {
    const costs = settingsState?.pawnCosts ?? [2, 3, 4];
    const uses = pawnUsesState;
    const cost = costs[Math.min(uses, costs.length - 1)];
    const row = document.createElement("div");
    row.className = "tm-special-row";
    const mkSelect = (filter) => {
      const sel = document.createElement("select");
      sel.className = "tm-special-select";
      activeTracks().filter(filter).forEach((c) => {
        const opt = document.createElement("option");
        opt.value = c;
        opt.textContent = TRACK_LABELS[c];
        sel.appendChild(opt);
      });
      return sel;
    };
    const fromSel = mkSelect((c) => (me?.columns?.[c] ?? 0) > 0);
    const toSel = mkSelect((c) => {
      const vals = columnValuesFor(c);
      return vals.length && (me?.columns?.[c] ?? 0) < vals.length - 1;
    });
    const arrow = document.createElement("span");
    arrow.textContent = "→";
    const go = document.createElement("button");
    go.type = "button";
    go.className = "primary-btn tm-special-item";
    go.textContent = uses >= 3 ? "3 per turn max" : `Convert · ${cost} 🪙`;
    go.disabled = uses >= 3 || cost > money || !fromSel.options.length || !toSel.options.length;
    go.addEventListener("click", () => {
      if (fromSel.value && toSel.value && fromSel.value !== toSel.value) {
        socket.emit("truck_mania_pawn", {
          roomId: app.roomId, truckId: truck.id, from: fromSel.value, to: toSel.value
        });
      }
    });
    row.append(fromSel, arrow, toSel, go);
    panel.appendChild(row);
    const note = document.createElement("div");
    note.className = "tm-special-note";
    note.textContent = "Moves one upgrade step from one column to another.";
    panel.appendChild(note);
  } else if (b.special === "courthouse") {
    const costs = settingsState?.courtCosts ?? [2, 3, 4];
    const uses = courtUsesState;
    const cost = costs[Math.min(uses, costs.length - 1)];
    const list = document.createElement("div");
    list.className = "tm-special-list";
    const byBid = buildingsByBid();
    const tickets = me?.tickets ?? [];
    if (!tickets.length) {
      const empty = document.createElement("div");
      empty.className = "tm-special-note";
      empty.textContent = "No visible tickets to pay off.";
      list.appendChild(empty);
    }
    tickets.forEach((t) => {
      const loc = byBid.get(t.loc);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ghost-btn tm-special-item";
      btn.textContent = uses >= 3
        ? `${loc?.icon ?? "🎫"} ${loc?.name ?? "Ticket"} · 3 per turn max`
        : `${loc?.icon ?? "🎫"} ${loc?.name ?? "Ticket"} · pay ${cost} 🪙`;
      btn.disabled = uses >= 3 || cost > money;
      btn.addEventListener("click", () => {
        socket.emit("truck_mania_pay_ticket", { roomId: app.roomId, truckId: truck.id, ticketId: t.id });
      });
      list.appendChild(btn);
    });
    panel.appendChild(list);
  }

  els.gameBoard.appendChild(panel);
}

// Fragility: delivered fragile packages queue a bonus the player claims at
// their leisure — time stones or money, at the values snapshotted when the
// delivery happened. One offer shows at a time; picks resolve oldest-first.
function renderFragileBonus() {
  els.gameBoard.querySelector(".tm-fragile")?.remove();
  const pending = myPlayer()?.pendingFragile ?? [];
  if (!pending.length || winnerState != null) return;
  const b = pending[0];
  const panel = document.createElement("div");
  panel.className = "tm-special tm-fragile";
  const head = document.createElement("div");
  head.className = "tm-special-head";
  head.textContent = `◯ Fragile bonus${pending.length > 1 ? ` ×${pending.length}` : ""}`;
  panel.appendChild(head);
  const note = document.createElement("div");
  note.className = "tm-special-note";
  note.textContent = "A fragile delivery pays your pick:";
  panel.appendChild(note);
  const list = document.createElement("div");
  list.className = "tm-special-list";
  [["stones", `+${b.stones ?? 0} time stones`], ["money", `+${b.money ?? 0} 🪙`]].forEach(([choice, label]) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "primary-btn tm-special-item";
    btn.textContent = label;
    btn.addEventListener("click", () => {
      if (app.roomId) socket.emit("truck_mania_fragile_bonus", { roomId: app.roomId, choice });
    });
    list.appendChild(btn);
  });
  panel.appendChild(list);
  els.gameBoard.appendChild(panel);
}

// The stack of time stones sitting above the player board.
function renderTimeStones(parent, count) {
  const wrap = document.createElement("div");
  wrap.className = "tm-stones";
  const shown = Math.min(count, 14);
  for (let i = 0; i < shown; i += 1) {
    const svg = svgEl("svg", { viewBox: "0 0 20 20", class: "tm-stone" });
    svgEl("polygon", {
      points: "10,1 18,7 15,18 5,18 2,7",
      fill: "#8a5bb0",
      stroke: "rgba(18,22,28,0.6)",
      "stroke-width": 1.5
    }, svg);
    svgEl("polygon", { points: "10,4 14.5,7.5 10,11 5.5,7.5", fill: "rgba(255,255,255,0.35)" }, svg);
    wrap.appendChild(svg);
  }
  const label = document.createElement("span");
  label.className = "tm-stones-count";
  label.textContent = `× ${count}`;
  wrap.appendChild(label);
  parent.appendChild(wrap);
}

// The stack of money coins next to the time stones (ticket mode's currency).
function renderMoney(parent, count) {
  const wrap = document.createElement("div");
  wrap.className = "tm-stones tm-money";
  const shown = Math.min(count, 14);
  for (let i = 0; i < shown; i += 1) {
    const svg = svgEl("svg", { viewBox: "0 0 20 20", class: "tm-stone" });
    svgEl("circle", { cx: 10, cy: 10, r: 8.5, fill: "#d8a531", stroke: "rgba(18,22,28,0.6)", "stroke-width": 1.5 }, svg);
    svgEl("circle", { cx: 10, cy: 10, r: 5.2, fill: "none", stroke: "rgba(255,255,255,0.45)", "stroke-width": 1.2 }, svg);
    wrap.appendChild(svg);
  }
  const label = document.createElement("span");
  label.className = "tm-stones-count";
  label.textContent = `× ${count}`;
  wrap.appendChild(label);
  parent.appendChild(wrap);
}

// The player's visible ticket slots (count tunable via `visibleTickets`) +
// face-down pile (ticket mode). Each visible ticket names the chore location
// that clears it; face-down ones flip up only when the owner's turn ends.
function buildTicketsRow(player) {
  const row = document.createElement("div");
  row.className = "tm-tickets";
  const byBid = buildingsByBid();
  const slots = Math.max(1, settingsState?.visibleTickets ?? 3);
  for (let i = 0; i < slots; i += 1) {
    const t = (player.tickets ?? [])[i];
    const slot = document.createElement("div");
    slot.className = `tm-ticket${t ? " tm-ticket-filled" : ""}`;
    if (t) {
      const b = byBid.get(t.loc);
      slot.title = b?.name ?? "Ticket";
      const icon = document.createElement("span");
      icon.className = "tm-ticket-icon";
      icon.textContent = b?.icon ?? "🎫";
      const name = document.createElement("span");
      name.className = "tm-ticket-name";
      name.textContent = b?.name ?? "?";
      slot.append(icon, name);
    }
    row.appendChild(slot);
  }
  const pileN = player.ticketPileCount ?? 0;
  if (pileN > 0) {
    const pile = document.createElement("div");
    pile.className = "tm-ticket tm-ticket-pile";
    pile.title = "Face-down tickets — revealed when your turn ends";
    pile.textContent = `+${pileN}`;
    // Suspension mode: the backlog is what's grounding this player.
    if (isSuspensionMode()) {
      pile.classList.add("tm-ticket-suspended");
      pile.title = "Face-down tickets — suspended: no pickups or dropoffs until these flip up (at turn end)";
      const badge = document.createElement("span");
      badge.className = "tm-ticket-suspend-badge";
      badge.textContent = "🚫";
      pile.appendChild(badge);
    }
    row.appendChild(pile);
  }
  return row;
}

// Build the .tm-player-board element for any player (used for the human's own
// board and for the hover preview of an opponent's stats).
function buildPlayerBoard(me) {
  const board = document.createElement("div");
  board.className = "tm-player-board";

  const header = document.createElement("div");
  header.className = "tm-pb-header";
  header.style.background = me.color;
  header.textContent = me.name || "Player";
  board.appendChild(header);

  const grid = document.createElement("div");
  grid.className = "tm-pb-grid";
  pbColumns().forEach((col) => {
    const cur = me.columns?.[col.id] ?? 0;
    const c = document.createElement("div");
    c.className = "tm-pb-col";

    const title = document.createElement("div");
    title.className = "tm-pb-title";
    title.style.background = col.color;
    title.textContent = col.title;
    c.appendChild(title);

    // The locations column is qualitative: the letter tiles the player owns.
    // Ticket mode shows it as `lettersToWin` slots that fill up and complete
    // like a numeric track; point mode just lists what's owned.
    if (col.id === "locations") {
      const items = me.locations ?? [];
      if (isTicketMode()) {
        const need = lettersToWin();
        if (items.length >= need) {
          c.classList.add("tm-pb-complete");
          title.textContent = `✓ ${col.title}`;
        }
        const slots = Math.max(need, items.length);
        for (let i = 0; i < slots; i += 1) {
          const cell = document.createElement("div");
          cell.className = `tm-pb-cell ${items[i] ? "tm-pb-tile" : "tm-pb-empty"}`;
          cell.style.background = hexToRgba(col.color, items[i] ? 0.85 : 0.16);
          if (items[i]) cell.textContent = items[i];
          c.appendChild(cell);
        }
      } else if (!items.length) {
        const cell = document.createElement("div");
        cell.className = "tm-pb-cell tm-pb-empty";
        cell.style.background = hexToRgba(col.color, 0.16);
        c.appendChild(cell);
      } else {
        items.forEach((it) => {
          const cell = document.createElement("div");
          cell.className = "tm-pb-cell tm-pb-tile";
          cell.style.background = hexToRgba(col.color, 0.85);
          cell.textContent = it;
          c.appendChild(cell);
        });
      }
      grid.appendChild(c);
      return;
    }

    // Column lengths are tunable, so cells share a fixed column height:
    // longer columns get shorter blocks, shorter columns taller ones.
    const vals = columnValuesFor(col.id);
    const cellH = Math.max(13, Math.min(30, Math.round(150 / Math.max(1, vals.length))));
    const level = Math.min(cur, vals.length - 1);
    // Ticket mode's win condition: a fully upgraded column gets a ✓ crown.
    if (isTicketMode() && vals.length && level >= vals.length - 1) {
      c.classList.add("tm-pb-complete");
      title.textContent = `✓ ${col.title}`;
    }
    vals.forEach((val, i) => {
      const cell = document.createElement("div");
      cell.className = "tm-pb-cell";
      cell.style.height = `${cellH}px`;
      const isCurrent = i === level;
      cell.style.background = hexToRgba(col.color, isCurrent ? 0.95 : 0.22);
      cell.textContent = String(val);
      if (isCurrent) cell.classList.add("tm-pb-current");
      c.appendChild(cell);
    });
    grid.appendChild(c);
  });
  board.appendChild(grid);
  return board;
}

// Owned abilities as proper cards (icon + name — same idea as the mechanic's
// shop list), stacked to the left of the player board.
function buildAbilityCards(me) {
  const list = me.abilities ?? [];
  if (!list.length) return null;
  const panel = document.createElement("div");
  panel.className = "tm-ability-cards";
  list.forEach((id) => {
    const card = document.createElement("div");
    card.className = "tm-ability-card";
    const icon = document.createElement("span");
    icon.className = "tm-ability-card-icon";
    icon.textContent = ABILITY_ICONS[id] ?? "•";
    const name = document.createElement("span");
    name.className = "tm-ability-card-name";
    name.textContent = ABILITY_LABELS[id] ?? id;
    card.append(icon, name);
    panel.appendChild(card);
  });
  return panel;
}

// The board plus the ability cards beside it — shared by the player's own
// corner and the opponent hover preview.
function buildPlayerPanel(me) {
  const row = document.createElement("div");
  row.className = "tm-pb-row";
  const cards = buildAbilityCards(me);
  if (cards) row.appendChild(cards);
  row.appendChild(buildPlayerBoard(me));
  return row;
}

function renderPlayerBoard() {
  els.gameBoard.querySelector(".tm-pb-wrap")?.remove();
  const me = myPlayer();
  if (!me) return;

  const wrap = document.createElement("div");
  wrap.className = "tm-pb-wrap";
  renderTimeStones(wrap, me.timeStones ?? 0);
  if (isTicketMode()) {
    renderMoney(wrap, me.money ?? 0);
    wrap.appendChild(buildTicketsRow(me));
  }
  wrap.appendChild(buildPlayerPanel(me));
  els.gameBoard.appendChild(wrap);
}

// --------------------------------------------------------------------------
// Play-mode rendering
// --------------------------------------------------------------------------

function drawStreets(parent, streets, interactive = false) {
  const layer = svgEl("g", { class: "tm-streets" }, parent);
  streets.forEach((street, i) => {
    const common = {
      fill: "none",
      stroke: "currentColor",
      "stroke-width": street.width,
      "stroke-linecap": "round"
    };
    if (interactive) {
      common.class = "tm-e-street";
      common["data-street"] = i;
    }
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

function boardSvg() {
  const svg = svgEl("svg", {
    class: "tm-map",
    viewBox: `0 0 ${mapState.width} ${mapState.height}`,
    role: "img",
    "aria-label": "Truck Mania city map"
  });
  svgEl("path", {
    class: "tm-ground",
    d: boardOutlinePath(mapState.width, mapState.height, mapState.rounded)
  }, svg);
  return svg;
}

function renderMap() {
  if (!mapState) return;
  boardMode = "play";

  els.gameBoard.innerHTML = "";
  els.gameBoard.classList.remove("player-0", "player-1", "toy-battle-board", "flip-triples-board", "tm-editing");
  els.gameBoard.classList.add("truck-mania-board");

  const svg = boardSvg();
  drawStreets(svg, mapState.streets);
  const buildingsLayer = svgEl("g", { class: "tm-blocks" }, svg);
  mapState.blocks.forEach((block) => {
    block.buildings.forEach((building) => appendBuilding(buildingsLayer, building));
  });

  renderBuildingPackages(svg);
  renderSpots(svg);
  renderOctagons(svg);
  renderTrucks(svg);
  svg.addEventListener("click", onBoardClick);
  els.gameBoard.appendChild(svg);
  syncTrucks(trucksState);
  renderClock();
  renderPlayerBoard();
  renderScoreboard();
  renderDice();
  renderDecks();
  renderTicketHighlights();
  renderSpecialPanel();
  renderFragileBonus();
}

// --------------------------------------------------------------------------
// The editor
// --------------------------------------------------------------------------

function toPoly(b) {
  const connectors = (b.connectors ?? []).map((c) => ({ ...c }));
  if (b.points) {
    return { kind: "poly", color: b.color, points: b.points.map((p) => [p[0], p[1]]), connectors };
  }
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const a = ((b.rotation || 0) * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const points = [
    [-b.w / 2, -b.h / 2],
    [b.w / 2, -b.h / 2],
    [b.w / 2, b.h / 2],
    [-b.w / 2, b.h / 2]
  ].map(([x, y]) => [r1(cx + x * cos - y * sin), r1(cy + x * sin + y * cos)]);
  return { kind: "poly", color: b.color, points, connectors };
}

function enterEditor() {
  const streets = mapState.streets.map((s) => ({ ...s }));
  editor = {
    buildings: mapState.blocks.flatMap((b) => b.buildings).map(toPoly),
    streets,
    octagons: mapState.intersections.map((o) => ({ ...o })),
    undoStack: [],
    selected: -1,
    addingConn: false,
    streetMode: false,
    newStreet: null,
    segments: collectSegments(streets),
    scaleBase: null,
    saveName: null // the title box in the edit controls; ✓ saves under it
  };
  renderEditor();
  renderControls();
  els.turnStatus.textContent = "Editing map";
}

// After any street change: rebuild segments, re-find intersections, and re-deal
// the octagon preview over the new junctions.
function recomputeStreets() {
  editor.segments = collectSegments(editor.streets);
  const points = findIntersections(editor.streets);
  editor.octagons = assignOctagons(points, mapState.width);
}

function exitEditor() {
  editor = null;
  dragCtx = null;
  renderMap();
  renderControls();
  els.turnStatus.textContent = "City map";
}

function snapshot() {
  return JSON.stringify({
    buildings: editor.buildings,
    streets: editor.streets,
    octagons: editor.octagons
  });
}

function pushSnapshot(snap) {
  editor.undoStack.push(snap);
  if (editor.undoStack.length > 60) editor.undoStack.shift();
}

function pushUndo() {
  pushSnapshot(snapshot());
}

function undo() {
  const prev = editor.undoStack.pop();
  if (!prev) return;
  const state = JSON.parse(prev);
  editor.buildings = state.buildings;
  editor.streets = state.streets;
  editor.octagons = state.octagons;
  editor.segments = collectSegments(editor.streets);
  editor.selected = Math.min(editor.selected, editor.buildings.length - 1);
  editor.newStreet = null;
  editor.scaleBase = null;
  renderEditor();
  renderControls();
}

function attachConnector(b, ex, ey) {
  const a = closestOnPoly(b.points, ex, ey);
  return { x1: r1(a.x), y1: r1(a.y), x2: r1(ex), y2: r1(ey) };
}

// Snap a connector to the street: end sits at the street's edge on the line
// between the street centerline point and the building.
function makeConnector(b, sx, sy) {
  const a = closestOnPoly(b.points, sx, sy);
  const dx = a.x - sx;
  const dy = a.y - sy;
  const len = Math.hypot(dx, dy) || 1;
  const pull = mapState.streetWidth / 2 - 2;
  return attachConnector(b, sx + (dx / len) * pull, sy + (dy / len) * pull);
}

function refreshConnectors(b) {
  b.connectors = (b.connectors ?? []).map((c) => attachConnector(b, c.x2, c.y2));
}

function addBuilding(sides) {
  pushUndo();
  const cx = mapState.width / 2 + (Math.random() - 0.5) * 80;
  const cy = mapState.height / 2 + (Math.random() - 0.5) * 60;
  const color = PALETTE[Math.floor(Math.random() * PALETTE.length)];
  let points;
  if (sides === 3) {
    points = [0, 1, 2].map((k) => {
      const a = -Math.PI / 2 + (k * 2 * Math.PI) / 3;
      return [r1(cx + Math.cos(a) * 42), r1(cy + Math.sin(a) * 42)];
    });
  } else {
    points = [[-35, -35], [35, -35], [35, 35], [-35, 35]].map(([x, y]) => [r1(cx + x), r1(cy + y)]);
  }
  editor.buildings.push({ kind: "poly", color, points, connectors: [] });
  editor.selected = editor.buildings.length - 1;
  editor.addingConn = false;
  renderEditor();
  renderControls();
}

function deleteBuilding(idx) {
  pushUndo();
  editor.buildings.splice(idx, 1);
  if (editor.selected === idx) editor.selected = -1;
  else if (editor.selected > idx) editor.selected -= 1;
  renderEditor();
  renderControls();
}

function renderEditor() {
  boardMode = "edit";
  els.gameBoard.innerHTML = "";
  els.gameBoard.classList.remove("player-0", "player-1", "toy-battle-board", "flip-triples-board");
  els.gameBoard.classList.add("truck-mania-board", "tm-editing");
  octEls = [];
  handEl = null;

  const svg = boardSvg();
  svg.classList.add("tm-editor");
  if (editor.addingConn) svg.classList.add("tm-conn-mode");
  if (editor.streetMode) svg.classList.add("tm-street-mode");

  drawStreets(svg, editor.streets, editor.streetMode);

  const layer = svgEl("g", { class: `tm-blocks${editor.streetMode ? " tm-dim" : ""}` }, svg);
  editor.buildings.forEach((b, i) => {
    const g = svgEl("g", { class: "tm-building" }, layer);
    (b.connectors ?? []).forEach((c, k) => {
      svgEl("line", {
        x1: c.x1, y1: c.y1, x2: c.x2, y2: c.y2,
        stroke: b.color, "stroke-width": 2
      }, g);
      svgEl("circle", {
        cx: c.x2, cy: c.y2, r: 6,
        fill: b.color,
        class: "tm-e-dot",
        "data-idx": i,
        "data-conn": k
      }, g);
    });
    svgEl("polygon", {
      points: polygonToString(b.points),
      fill: b.color,
      class: `tm-e-body${i === editor.selected ? " tm-e-selected" : ""}`,
      "data-idx": i
    }, g);
    if (i === editor.selected && !editor.streetMode) {
      b.points.forEach(([x1, y1], k) => {
        const [x2, y2] = b.points[(k + 1) % b.points.length];
        svgEl("line", {
          x1, y1, x2, y2,
          class: "tm-e-edge",
          "data-idx": i,
          "data-edge": k
        }, g);
      });
      b.points.forEach(([x, y], k) => {
        svgEl("circle", {
          cx: x, cy: y, r: 6,
          class: "tm-e-corner",
          "data-idx": i,
          "data-corner": k
        }, g);
      });
    }
  });

  // Octagon preview: shows the stoplights reorganizing as streets change.
  const octLayer = svgEl("g", { class: "tm-octagons tm-oct-preview" }, svg);
  editor.octagons.forEach((oct) => {
    const g = svgEl("g", { class: "tm-oct", transform: `translate(${oct.x} ${oct.y})` }, octLayer);
    svgEl("polygon", { points: octagonPoints(OCT_RADIUS), fill: oct.color === "green" ? GREEN : RED }, g);
    if (oct.number != null) {
      const text = svgEl("text", { class: "tm-oct-num", x: 0, y: 0 }, g);
      text.textContent = String(oct.number);
    }
  });

  // Rubber band while drawing a new street.
  if (editor.streetMode && editor.newStreet) {
    const s = editor.newStreet;
    svgEl("line", {
      x1: s.x, y1: s.y, x2: s.mx ?? s.x, y2: s.my ?? s.y,
      class: "tm-new-street",
      "stroke-width": mapState.streetWidth
    }, svg);
    svgEl("circle", { cx: s.x, cy: s.y, r: 5, class: "tm-new-street-anchor" }, svg);
  }

  svg.addEventListener("pointerdown", onEditorPointerDown);
  svg.addEventListener("contextmenu", onEditorContextMenu);
  if (editor.streetMode && editor.newStreet) {
    svg.addEventListener("pointermove", onNewStreetMove);
  }
  els.gameBoard.appendChild(svg);
}

// Snap a point to a nearby street endpoint or centerline; else return as-is.
function snapStreetPoint(x, y, thresh = 16) {
  const ns = nearestStreetPoint(editor.segments, x, y);
  if (ns && ns.dist < thresh) return { x: r1(ns.x), y: r1(ns.y), onStreet: true };
  return { x: r1(x), y: r1(y), onStreet: false };
}

function onNewStreetMove(event) {
  if (!editor?.newStreet) return;
  const svg = els.gameBoard.querySelector(".tm-map");
  if (!svg) return;
  const p = svgPoint(svg, event);
  const line = svg.querySelector(".tm-new-street");
  if (line) {
    line.setAttribute("x2", p.x);
    line.setAttribute("y2", p.y);
  }
  editor.newStreet.mx = p.x;
  editor.newStreet.my = p.y;
}

function onEditorContextMenu(event) {
  event.preventDefault();
  if (editor.streetMode) {
    const street = event.target.closest(".tm-e-street");
    if (street) {
      pushUndo();
      editor.streets.splice(Number(street.dataset.street), 1);
      editor.newStreet = null;
      recomputeStreets();
      renderEditor();
      renderControls();
    }
    return;
  }
  const dot = event.target.closest(".tm-e-dot");
  if (dot) {
    pushUndo();
    editor.buildings[Number(dot.dataset.idx)].connectors.splice(Number(dot.dataset.conn), 1);
    renderEditor();
    return;
  }
  const body = event.target.closest(".tm-e-body");
  if (body) deleteBuilding(Number(body.dataset.idx));
}

function onEditorPointerDown(event) {
  if (event.button !== 0) return;
  const svg = event.currentTarget;
  const p = svgPoint(svg, event);

  if (editor.streetMode) {
    if (!editor.newStreet) {
      const start = snapStreetPoint(p.x, p.y);
      editor.newStreet = { x: start.x, y: start.y, mx: p.x, my: p.y };
      renderEditor();
      return;
    }
    // Second click finalizes — only if it lands on a street.
    const end = snapStreetPoint(p.x, p.y);
    const s = editor.newStreet;
    if (end.onStreet && (end.x !== s.x || end.y !== s.y)) {
      pushUndo();
      editor.streets.push({ kind: "line", x1: s.x, y1: s.y, x2: end.x, y2: end.y, width: mapState.streetWidth });
      editor.newStreet = null;
      recomputeStreets();
      renderControls();
    }
    renderEditor();
    return;
  }

  if (editor.addingConn) {
    editor.addingConn = false;
    const b = editor.buildings[editor.selected];
    const ns = b ? nearestStreetPoint(editor.segments, p.x, p.y) : null;
    if (b && ns && ns.dist < 70) {
      pushUndo();
      b.connectors = b.connectors ?? [];
      b.connectors.push(makeConnector(b, ns.x, ns.y));
    }
    renderEditor();
    renderControls();
    return;
  }

  const start = (type, extra) => {
    dragCtx = {
      type,
      startX: p.x,
      startY: p.y,
      snapshot: snapshot(),
      committed: false,
      ...extra
    };
    window.addEventListener("pointermove", onEditorPointerMove);
    window.addEventListener("pointerup", onEditorPointerUp, { once: true });
    event.preventDefault();
  };

  const dot = event.target.closest(".tm-e-dot");
  if (dot) {
    start("conn", { idx: Number(dot.dataset.idx), conn: Number(dot.dataset.conn) });
    return;
  }
  const corner = event.target.closest(".tm-e-corner");
  if (corner) {
    const idx = Number(corner.dataset.idx);
    start("corner", { idx, corner: Number(corner.dataset.corner), base: JSON.parse(JSON.stringify(editor.buildings[idx].points)) });
    return;
  }
  const edge = event.target.closest(".tm-e-edge");
  if (edge) {
    const idx = Number(edge.dataset.idx);
    start("edge", { idx, edge: Number(edge.dataset.edge), base: JSON.parse(JSON.stringify(editor.buildings[idx].points)) });
    return;
  }
  const body = event.target.closest(".tm-e-body");
  if (body) {
    const idx = Number(body.dataset.idx);
    if (editor.selected !== idx) {
      editor.selected = idx;
      editor.scaleBase = null;
      renderEditor();
      renderControls();
    }
    start("move", { idx, base: JSON.parse(JSON.stringify(editor.buildings[idx].points)) });
    return;
  }

  if (editor.selected !== -1) {
    editor.selected = -1;
    editor.scaleBase = null;
    renderEditor();
    renderControls();
  }
}

function onEditorPointerMove(event) {
  if (!dragCtx || !editor) return;
  const svg = els.gameBoard.querySelector(".tm-map");
  if (!svg) return;
  const p = svgPoint(svg, event);
  const dx = p.x - dragCtx.startX;
  const dy = p.y - dragCtx.startY;
  if (!dragCtx.committed && Math.hypot(dx, dy) > 1.5) {
    pushSnapshot(dragCtx.snapshot);
    dragCtx.committed = true;
  }
  if (!dragCtx.committed) return;

  const b = editor.buildings[dragCtx.idx];
  if (!b) return;

  if (dragCtx.type === "move") {
    b.points = dragCtx.base.map(([x, y]) => [r1(x + dx), r1(y + dy)]);
    refreshConnectors(b);
  } else if (dragCtx.type === "corner") {
    b.points = dragCtx.base.map((pt) => [pt[0], pt[1]]);
    b.points[dragCtx.corner] = [r1(dragCtx.base[dragCtx.corner][0] + dx), r1(dragCtx.base[dragCtx.corner][1] + dy)];
    refreshConnectors(b);
  } else if (dragCtx.type === "edge") {
    b.points = dragCtx.base.map((pt) => [pt[0], pt[1]]);
    const k = dragCtx.edge;
    const k2 = (k + 1) % b.points.length;
    b.points[k] = [r1(dragCtx.base[k][0] + dx), r1(dragCtx.base[k][1] + dy)];
    b.points[k2] = [r1(dragCtx.base[k2][0] + dx), r1(dragCtx.base[k2][1] + dy)];
    refreshConnectors(b);
  } else if (dragCtx.type === "conn") {
    const ns = nearestStreetPoint(editor.segments, p.x, p.y);
    if (ns && ns.dist < 90) {
      b.connectors[dragCtx.conn] = makeConnector(b, ns.x, ns.y);
    }
  }
  renderEditor();
}

function onEditorPointerUp() {
  window.removeEventListener("pointermove", onEditorPointerMove);
  dragCtx = null;
}

function applyScale(factor) {
  const b = editor?.buildings[editor.selected];
  if (!b) return;
  if (!editor.scaleBase) {
    pushUndo();
    editor.scaleBase = JSON.parse(JSON.stringify(b.points));
  }
  const [cx, cy] = centroidOf(editor.scaleBase);
  b.points = editor.scaleBase.map(([x, y]) => [r1(cx + (x - cx) * factor), r1(cy + (y - cy) * factor)]);
  refreshConnectors(b);
  renderEditor();
}

function saveMap() {
  if (editor.octagons.length < 24) {
    window.alert(`This map has ${editor.octagons.length} intersections. It needs at least 24 to be saved.`);
    return;
  }
  const name = (editor.saveName ?? "").trim() || `Map ${savedMaps.length + 1}`;
  socket.emit("truck_mania_save_map", {
    roomId: app.roomId,
    name,
    map: {
      streets: editor.streets,
      rounded: mapState.rounded,
      intersections: editor.octagons.map(({ x, y }) => ({ x, y })),
      blocks: [{ id: "custom", buildings: editor.buildings }]
    }
  });
  // The server answers with a state_update carrying the saved map.
  editor = null;
  dragCtx = null;
}

// --------------------------------------------------------------------------
// Tuning: edit every number in the game, save named versions (local runs
// only), and apply presets/saved versions mid-match.
// --------------------------------------------------------------------------

const TUNE_COLUMNS = [
  ["capacity", "Capacity"], ["variety", "Variety"], ["aversion", "Aversion"],
  ["agression", "Agression"], ["timestones", "Time stones"]
];
// Ticket settings carry both rule sets' columns (Variety and Fragile capacity)
// so flipping the rule dial mid-match never lacks numbers.
const TUNE_COLUMNS_TICKETS = [
  ["capacity", "Capacity"], ["variety", "Variety"], ["fragile", "Fragile capacity"],
  ["aversion", "Aversion"], ["agression", "Agression"], ["timestones", "Time stones"],
  ["money", "Money"]
];
const TUNE_COLORS = [
  ["#cf4a3c", "Red"], ["#e08a3c", "Orange"], ["#e8c33c", "Yellow"],
  ["#4f9d57", "Green"], ["#4a72b0", "Blue"], ["#8a5bb0", "Purple"], ["#8f6b52", "Brown"]
];

function tuneColumns() {
  return tuneDraft?.mode === "tickets" ? TUNE_COLUMNS_TICKETS : TUNE_COLUMNS;
}

function openTuning() {
  if (!settingsState) return;
  const ticket = isTicketMode();
  const squaresNow = TUNE_COLORS.reduce(
    (n, [hex]) => n + (settingsState.packages?.[hex]?.square ?? 0), 0
  );
  tuneDraft = {
    mode: ticket ? "tickets" : "points",
    columns: Object.fromEntries(
      (ticket ? TUNE_COLUMNS_TICKETS : TUNE_COLUMNS)
        .map(([id]) => [id, (settingsState.columns?.[id] ??
          (id === "fragile" ? [1, 2, 3, 4, 5, 6] : [])).join(", ")])
    ),
    // Attach a saved map to this version (null = NONE — the version leaves
    // whatever map is on the table alone). Remembers the session's last pick.
    mapId: savedMaps.some((m) => m.id === lastAttachedMapId) ? lastAttachedMapId : null,
    packages: Object.fromEntries(TUNE_COLORS.map(([hex]) => {
      const p = settingsState.packages?.[hex] ?? { square: 0, circle: 0 };
      return [hex, { square: String(p.square), circle: String(p.circle) }];
    })),
    protectedCount: String(settingsState.protectedCount ?? 6),
    perProtected: String(settingsState.perProtected ?? (ticket ? 8 : 6)),
    pickupCount: String(settingsState.pickupCount ?? Math.round(squaresNow / 6)),
    perPickup: String(settingsState.perPickup ?? 6),
    dropoffs: Object.fromEntries(TUNE_COLORS.map(([hex]) =>
      [hex, (settingsState.dropoffs?.[hex] ?? []).join(", ")]
    )),
    startingTimeStones: String(settingsState.startingTimeStones ?? 3),
    saveName: `Settings ${savedSettingsList.length + 1}`
  };
  if (ticket) {
    // Not editable here (the rule dials in the control bar own them) —
    // carried so a save doesn't drop the suspension/fragility rules.
    tuneDraft.suspension = !!settingsState.suspension;
    tuneDraft.fragility = !!settingsState.fragility;
    tuneDraft.startingMoney = String(settingsState.startingMoney ?? 2);
    tuneDraft.columnsToWin = String(settingsState.columnsToWin ?? 3);
    tuneDraft.ticketLocations = String(settingsState.ticketLocations ?? 12);
    tuneDraft.visibleTickets = String(settingsState.visibleTickets ?? 3);
    tuneDraft.lettersToWin = String(settingsState.lettersToWin ?? settingsState.protectedCount ?? 6);
    tuneDraft.perFail = String(settingsState.tickets?.perFail ?? 1);
    tuneDraft.abilityCosts = Object.fromEntries(
      Object.keys(ABILITY_LABELS).map((id) => [id, String(settingsState.abilityCosts?.[id] ?? 0)])
    );
    tuneDraft.pawnCosts = (settingsState.pawnCosts ?? [2, 3, 4]).join(", ");
    tuneDraft.courtCosts = (settingsState.courtCosts ?? [2, 3, 4]).join(", ");
    tuneDraft.blankGreen = String(settingsState.blankLights?.green ?? 5);
    tuneDraft.blankRed = String(settingsState.blankLights?.red ?? 5);
    tuneDraft.intersections = String(settingsState.intersections ??
      24 + (settingsState.blankLights?.green ?? 5) + (settingsState.blankLights?.red ?? 5));
  } else {
    tuneDraft.points = {
      square: String(settingsState.points?.square ?? 1),
      circle: String(settingsState.points?.circle ?? 2),
      ticket: String(settingsState.points?.ticket ?? 1)
    };
  }
  renderTuning();
}

function closeTuning() {
  tuneDraft = null;
  document.querySelector(".tm-tuning")?.remove();
}

// Parse the draft into a settings object + the list of everything that doesn't
// line up yet. Editing is free; only Save (and the issue list) cares.
function parseTuneDraft() {
  const issues = [];
  const ticket = tuneDraft.mode === "tickets";
  const intField = (raw, label, min, max) => {
    const v = Number(raw);
    if (!Number.isInteger(v) || v < min || v > max) {
      issues.push(`${label}: a whole number ${min}–${max}`);
    }
    return v | 0;
  };

  const columns = {};
  tuneColumns().forEach(([id, label]) => {
    const nums = tuneDraft.columns[id]
      .split(",").map((s) => s.trim()).filter((s) => s !== "").map(Number);
    if (!nums.length || nums.some((n) => !Number.isInteger(n) || n < 0 || n > 99)) {
      issues.push(`${label}: comma-separated whole numbers (0–99)`);
    } else if (nums.length < 2 || nums.length > 12) {
      issues.push(`${label}: needs 2–12 values`);
    }
    columns[id] = nums;
  });

  const packages = {};
  let circles = 0;
  let squares = 0;
  TUNE_COLORS.forEach(([hex, name]) => {
    const sq = Number(tuneDraft.packages[hex].square);
    const ci = Number(tuneDraft.packages[hex].circle);
    if (!Number.isInteger(sq) || sq < 0 || !Number.isInteger(ci) || ci < 0) {
      issues.push(`${name} packages: counts must be whole numbers`);
    }
    packages[hex] = { square: sq | 0, circle: ci | 0 };
    squares += sq | 0;
    circles += ci | 0;
  });

  const protectedCount = intField(tuneDraft.protectedCount, "Protected locations", 0, 12);
  const perProtected = intField(tuneDraft.perProtected, "Packages per protected", 1, 12);
  const pickupCount = intField(tuneDraft.pickupCount, "Normal pickups", 0, 60);
  const perPickup = intField(tuneDraft.perPickup, "Packages per pickup", 1, 12);
  const startingTimeStones = intField(tuneDraft.startingTimeStones, "Starting time stones", 0, 40);

  // The line-up rules (mirrored by the server before persisting): squares
  // fill the normal pickups exactly, circles the protected ones. Fragility
  // mixes the shapes freely, so only the combined total must fill every slot.
  const fragility = ticket && !!tuneDraft.fragility;
  if (fragility) {
    const want = pickupCount * perPickup + protectedCount * perProtected;
    if (squares + circles !== want) {
      issues.push(`Packages must total pickups × per + protected × per = ${want} (now ${squares + circles})`);
    }
  } else {
    if (squares !== pickupCount * perPickup) {
      issues.push(`Squares must total pickups × per pickup = ${pickupCount * perPickup} (now ${squares})`);
    }
    if (circles !== protectedCount * perProtected) {
      issues.push(`Circles must total protected × per protected = ${protectedCount * perProtected} (now ${circles})`);
    }
  }
  const orange = packages["#e08a3c"].square + packages["#e08a3c"].circle;
  if (ticket) {
    // Letters are dealt evenly over the orange packages.
    if (protectedCount > 0 ? orange % protectedCount !== 0 : orange !== 0) {
      issues.push(`Orange must divide evenly by protected locations (now ${orange} ÷ ${protectedCount})`);
    }
  } else if (orange !== protectedCount * 2) {
    issues.push(`Orange must total protected × 2 = ${protectedCount * 2} (now ${orange})`);
  }

  // Dropoffs: each number in a color's list is one dropoff building with that
  // capacity; a color's capacities must sum to its package total.
  const dropoffs = {};
  TUNE_COLORS.forEach(([hex, name]) => {
    const nums = (tuneDraft.dropoffs[hex] ?? "")
      .split(",").map((s) => s.trim()).filter((s) => s !== "").map(Number);
    if (nums.length > 8 || nums.some((n) => !Number.isInteger(n) || n < 1 || n > 90)) {
      issues.push(`${name} dropoffs: comma-separated whole numbers (1–90)`);
    }
    dropoffs[hex] = nums;
    const total = packages[hex].square + packages[hex].circle;
    const sum = nums.reduce((a, b) => a + (Number.isInteger(b) ? b : 0), 0);
    if (sum !== total) issues.push(`${name} dropoffs must sum to its ${total} packages (now ${sum})`);
  });

  const shared = {
    columns, packages, protectedCount, startingTimeStones,
    pickupCount, perPickup, perProtected, dropoffs
  };

  if (!ticket) {
    const points = {};
    [["square", "Square points"], ["circle", "Circle points"],
     ["ticket", "Ticket loss"]].forEach(([k, label]) => {
      const v = Number(tuneDraft.points[k]);
      if (!Number.isInteger(v) || v < 0) issues.push(`${label}: a whole number ≥ 0`);
      points[k] = v | 0;
    });
    return { settings: { ...shared, points }, issues };
  }

  const startingMoney = intField(tuneDraft.startingMoney, "Starting money", 0, 40);
  const columnsToWin = intField(tuneDraft.columnsToWin, "Columns to win", 1, 7);
  const ticketLocations = intField(tuneDraft.ticketLocations, "Ticket locations", 1, 12);
  const visibleTickets = intField(tuneDraft.visibleTickets, "Visible tickets", 1, 8);
  const lettersToWin = intField(tuneDraft.lettersToWin, "Letters to win", 1, 12);
  if (lettersToWin > Math.max(1, protectedCount)) {
    issues.push("Letters to win can't exceed the protected locations");
  }
  const perFail = intField(tuneDraft.perFail, "Tickets per failed die", 0, 6);
  const blankGreen = intField(tuneDraft.blankGreen, "Green blank lights", 0, 40);
  const blankRed = intField(tuneDraft.blankRed, "Red blank lights", 0, 40);
  const intersections = intField(tuneDraft.intersections, "Total intersections", 24, 44);
  // The stoplight math: the 24 numbered + the blanks make the total; the two
  // forced-green corners come on top and count toward neither.
  if (intersections !== 24 + blankGreen + blankRed) {
    issues.push(`Blanks must fit the total: 24 + ${blankGreen} green + ${blankRed} red = ${24 + blankGreen + blankRed} (total says ${intersections})`);
  }
  const abilityCosts = {};
  Object.keys(ABILITY_LABELS).forEach((id) => {
    abilityCosts[id] = intField(tuneDraft.abilityCosts[id], `${ABILITY_LABELS[id]} cost`, 0, 99);
  });
  const stepCosts = (raw, label) => {
    const nums = raw.split(",").map((s) => s.trim()).filter((s) => s !== "").map(Number);
    if (nums.length !== 3 || nums.some((n) => !Number.isInteger(n) || n < 0 || n > 99)) {
      issues.push(`${label}: exactly three whole numbers (1st, 2nd, 3rd use)`);
    }
    return nums;
  };
  const pawnCosts = stepCosts(tuneDraft.pawnCosts, "Pawn shop prices");
  const courtCosts = stepCosts(tuneDraft.courtCosts, "Courthouse prices");

  return {
    settings: {
      ...shared,
      mode: "tickets",
      suspension: !!tuneDraft.suspension,
      fragility: !!tuneDraft.fragility,
      startingMoney, columnsToWin, ticketLocations,
      visibleTickets, lettersToWin, intersections,
      tickets: { perFail },
      abilityCosts, pawnCosts, courtCosts,
      blankLights: { green: blankGreen, red: blankRed }
    },
    issues
  };
}

function tuneField(value, onInput, cls = "tm-tune-input") {
  const input = document.createElement("input");
  input.type = "text";
  input.className = cls;
  input.value = value;
  input.addEventListener("input", () => {
    onInput(input.value);
    updateTuneStatus();
  });
  return input;
}

// Per-color and grand package totals from the draft (0 for junk input).
function tunePackageTotals() {
  let squares = 0;
  let circles = 0;
  const rows = {};
  TUNE_COLORS.forEach(([hex]) => {
    const sq = Number(tuneDraft.packages[hex].square) || 0;
    const ci = Number(tuneDraft.packages[hex].circle) || 0;
    rows[hex] = sq + ci;
    squares += sq;
    circles += ci;
  });
  return { rows, squares, circles };
}

// Refresh the footer (issue list + Save enabled state) and every live total
// beside the package rows and dropoff lists.
function updateTuneStatus() {
  const panel = document.querySelector(".tm-tuning");
  if (!panel || !tuneDraft) return;
  const totals = tunePackageTotals();
  panel.querySelectorAll("[data-tune-total]").forEach((el) => {
    const key = el.dataset.tuneTotal;
    if (key === "squares") el.textContent = String(totals.squares);
    else if (key === "circles") el.textContent = String(totals.circles);
    else if (key === "all") el.textContent = String(totals.squares + totals.circles);
    else if (key.startsWith("row:")) el.textContent = String(totals.rows[key.slice(4)] ?? 0);
    else if (key.startsWith("drop:")) {
      const hex = key.slice(5);
      const sum = (tuneDraft.dropoffs[hex] ?? "")
        .split(",").map((s) => s.trim()).filter((s) => s !== "")
        .reduce((a, s) => a + (Number.isInteger(Number(s)) ? Number(s) : 0), 0);
      const need = totals.rows[hex] ?? 0;
      el.textContent = `${sum}/${need}`;
      el.classList.toggle("tm-tune-bad", sum !== need);
    }
  });
  const { issues } = parseTuneDraft();
  const box = panel.querySelector(".tm-tune-issues");
  box.innerHTML = "";
  if (issues.length) {
    issues.forEach((msg) => {
      const li = document.createElement("div");
      li.textContent = `• ${msg}`;
      box.appendChild(li);
    });
  } else {
    const ok = document.createElement("div");
    ok.className = "tm-tune-ok";
    ok.textContent = "✓ Everything lines up";
    box.appendChild(ok);
  }
  const saveBtn = panel.querySelector(".tm-tune-save");
  if (saveBtn) saveBtn.disabled = issues.length > 0;
}

function renderTuning() {
  document.querySelector(".tm-tuning")?.remove();
  if (!tuneDraft) return;
  const panel = document.createElement("div");
  panel.className = "tm-tuning";

  const title = document.createElement("div");
  title.className = "tm-tune-title";
  title.textContent = tuneDraft.mode === "tickets"
    ? `Game tuning — ${tuneDraft.fragility ? "Fragility" : "Ticket mode"}${tuneDraft.suspension ? " · Suspension" : ""}`
    : "Game tuning — Point mode";
  panel.appendChild(title);

  const section = (label) => {
    const h = document.createElement("div");
    h.className = "tm-tune-section";
    h.textContent = label;
    panel.appendChild(h);
  };
  const row = (label, ...els2) => {
    const r = document.createElement("div");
    r.className = "tm-tune-row";
    const l = document.createElement("span");
    l.className = "tm-tune-label";
    l.textContent = label;
    r.appendChild(l);
    els2.forEach((e) => r.appendChild(e));
    panel.appendChild(r);
    return r;
  };

  section("Board columns (first = start; count = column length)");
  tuneColumns().forEach(([id, label]) => {
    row(label, tuneField(tuneDraft.columns[id], (v) => { tuneDraft.columns[id] = v; }, "tm-tune-input tm-tune-list"));
  });

  // A little live total that updateTuneStatus keeps current.
  const totalSpan = (key) => {
    const s = document.createElement("span");
    s.className = "tm-tune-total";
    s.dataset.tuneTotal = key;
    return s;
  };

  section("Packages (squares / circles per color)");
  TUNE_COLORS.forEach(([hex, name]) => {
    const sq = tuneField(tuneDraft.packages[hex].square, (v) => { tuneDraft.packages[hex].square = v; }, "tm-tune-input tm-tune-num");
    const ci = tuneField(tuneDraft.packages[hex].circle, (v) => { tuneDraft.packages[hex].circle = v; }, "tm-tune-input tm-tune-num");
    const r = row(name, sq, ci, totalSpan(`row:${hex}`));
    const dot = document.createElement("span");
    dot.className = "tm-tune-dot";
    dot.style.background = hex;
    r.insertBefore(dot, r.firstChild);
  });
  {
    const r = row("Totals", totalSpan("squares"), totalSpan("circles"), totalSpan("all"));
    r.classList.add("tm-tune-totals");
  }

  // Fragility deals every location from one mixed bag, so the per-location
  // counts aren't shape-bound there.
  const frag = tuneDraft.mode === "tickets" && !!tuneDraft.fragility;
  section("Pickup locations");
  row("Normal pickups", tuneField(tuneDraft.pickupCount, (v) => { tuneDraft.pickupCount = v; }, "tm-tune-input tm-tune-num"));
  row(frag ? "Packages per normal" : "Squares per normal", tuneField(tuneDraft.perPickup, (v) => { tuneDraft.perPickup = v; }, "tm-tune-input tm-tune-num"));
  row("Protected locations", tuneField(tuneDraft.protectedCount, (v) => { tuneDraft.protectedCount = v; }, "tm-tune-input tm-tune-num"));
  row(frag ? "Packages per protected" : "Circles per protected", tuneField(tuneDraft.perProtected, (v) => { tuneDraft.perProtected = v; }, "tm-tune-input tm-tune-num"));

  section("Dropoffs (capacities, one building each — must sum to the color's packages)");
  TUNE_COLORS.forEach(([hex, name]) => {
    const r = row(name,
      tuneField(tuneDraft.dropoffs[hex], (v) => { tuneDraft.dropoffs[hex] = v; }, "tm-tune-input tm-tune-list"),
      totalSpan(`drop:${hex}`));
    const dot = document.createElement("span");
    dot.className = "tm-tune-dot";
    dot.style.background = hex;
    r.insertBefore(dot, r.firstChild);
  });

  section("Setup");
  row("Starting time stones", tuneField(tuneDraft.startingTimeStones, (v) => { tuneDraft.startingTimeStones = v; }, "tm-tune-input tm-tune-num"));

  if (tuneDraft.mode === "tickets") {
    row("Starting money", tuneField(tuneDraft.startingMoney, (v) => { tuneDraft.startingMoney = v; }, "tm-tune-input tm-tune-num"));
    row("Columns to win", tuneField(tuneDraft.columnsToWin, (v) => { tuneDraft.columnsToWin = v; }, "tm-tune-input tm-tune-num"));
    row("Letters to win", tuneField(tuneDraft.lettersToWin, (v) => { tuneDraft.lettersToWin = v; }, "tm-tune-input tm-tune-num"));
    row("Ticket locations", tuneField(tuneDraft.ticketLocations, (v) => { tuneDraft.ticketLocations = v; }, "tm-tune-input tm-tune-num"));
    row("Visible tickets", tuneField(tuneDraft.visibleTickets, (v) => { tuneDraft.visibleTickets = v; }, "tm-tune-input tm-tune-num"));

    section("Tickets");
    row("Issued per failed die", tuneField(tuneDraft.perFail, (v) => { tuneDraft.perFail = v; }, "tm-tune-input tm-tune-num"));

    section("Stoplights (24 numbered + blanks = total; 2 green corners on top)");
    row("Total intersections", tuneField(tuneDraft.intersections, (v) => { tuneDraft.intersections = v; }, "tm-tune-input tm-tune-num"));
    row("Green blanks", tuneField(tuneDraft.blankGreen, (v) => { tuneDraft.blankGreen = v; }, "tm-tune-input tm-tune-num"));
    row("Red blanks", tuneField(tuneDraft.blankRed, (v) => { tuneDraft.blankRed = v; }, "tm-tune-input tm-tune-num"));

    section("Mechanic — ability prices");
    Object.keys(ABILITY_LABELS).forEach((id) => {
      row(`${ABILITY_ICONS[id]} ${ABILITY_LABELS[id]}`,
        tuneField(tuneDraft.abilityCosts[id], (v) => { tuneDraft.abilityCosts[id] = v; }, "tm-tune-input tm-tune-num"));
    });

    section("Prices per use in one turn (1st, 2nd, 3rd)");
    row("Pawn shop", tuneField(tuneDraft.pawnCosts, (v) => { tuneDraft.pawnCosts = v; }, "tm-tune-input tm-tune-list"));
    row("Courthouse", tuneField(tuneDraft.courtCosts, (v) => { tuneDraft.courtCosts = v; }, "tm-tune-input tm-tune-list"));
  } else {
    section("Points");
    row("Square delivery", tuneField(tuneDraft.points.square, (v) => { tuneDraft.points.square = v; }, "tm-tune-input tm-tune-num"));
    row("Circle delivery", tuneField(tuneDraft.points.circle, (v) => { tuneDraft.points.circle = v; }, "tm-tune-input tm-tune-num"));
    row("Ticket loss", tuneField(tuneDraft.points.ticket, (v) => { tuneDraft.points.ticket = v; }, "tm-tune-input tm-tune-num"));
  }

  // The map this version plays on: pick a saved map (applying the version
  // then seats that map too) or NONE to leave the table's map alone.
  section("Attached map (loads with these settings)");
  {
    const r = document.createElement("div");
    r.className = "tm-tune-row";
    const mapSel = document.createElement("select");
    mapSel.className = "tm-special-select tm-tune-map";
    [["", "NONE — keep the current map"], ...savedMaps.map((m) => [m.id, m.name])]
      .forEach(([v, label]) => {
        const opt = document.createElement("option");
        opt.value = v;
        opt.textContent = label;
        mapSel.appendChild(opt);
      });
    mapSel.value = tuneDraft.mapId ?? "";
    mapSel.addEventListener("change", () => { tuneDraft.mapId = mapSel.value || null; });
    r.appendChild(mapSel);
    panel.appendChild(r);
  }

  // Saved versions: apply one, retitle it (green ✓ commits), or trash it
  // (inline Yes / No). Deleting/renaming is local-run only, like saving.
  // Each row hints at what applying it sets up: rules + attached map.
  section("Saved settings");
  panel.appendChild(buildSavedList({
    items: savedSettingsList.map((s) => ({
      ...s,
      hint: [
        s.mode === "tickets" ? (s.fragility ? "Fragility" : "Variety") : "Points",
        s.suspension ? "Susp." : null,
        s.mapId ? `🗺 ${savedMaps.find((m) => m.id === s.mapId)?.name ?? "?"}` : null
      ].filter(Boolean).join(" · ")
    })),
    canManage: canSaveSettings,
    loadLabel: "Apply",
    emptyText: "No saved settings yet — name and ✓ Save below.",
    onLoad: (id) => {
      lastAttachedMapId = savedSettingsList.find((s) => s.id === id)?.mapId ?? null;
      if (app.roomId) socket.emit("truck_mania_load_settings", { roomId: app.roomId, settingsId: id });
    },
    onRename: (id, name) => {
      if (app.roomId) socket.emit("truck_mania_rename_settings", { roomId: app.roomId, settingsId: id, name });
    },
    onDelete: (id) => {
      if (app.roomId) socket.emit("truck_mania_delete_settings", { roomId: app.roomId, settingsId: id });
    }
  }));

  const issues = document.createElement("div");
  issues.className = "tm-tune-issues";
  panel.appendChild(issues);

  const footer = document.createElement("div");
  footer.className = "tm-tune-footer";
  if (canSaveSettings) {
    // Name the version here, then hit the green ✓ to save it.
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "tm-saved-name tm-tune-name";
    nameInput.maxLength = 40;
    nameInput.placeholder = "Name these settings…";
    nameInput.value = tuneDraft.saveName ?? "";
    nameInput.addEventListener("input", () => { tuneDraft.saveName = nameInput.value; });
    footer.appendChild(nameInput);
    const saveBtn = button("✓ Save", "", "primary-btn tm-saved-ok");
    saveBtn.classList.add("tm-tune-save");
    saveBtn.title = "Save these numbers under the name on the left";
    saveBtn.addEventListener("click", () => {
      const parsed = parseTuneDraft();
      if (parsed.issues.length || !app.roomId) return;
      const name = (tuneDraft.saveName ?? "").trim() || `Settings ${savedSettingsList.length + 1}`;
      lastAttachedMapId = tuneDraft.mapId ?? null;
      socket.emit("truck_mania_save_settings", {
        roomId: app.roomId, name, settings: parsed.settings, mapId: tuneDraft.mapId ?? null
      });
    });
    footer.appendChild(saveBtn);
  }
  const closeBtn = button("Close", "");
  closeBtn.addEventListener("click", closeTuning);
  footer.appendChild(closeBtn);
  panel.appendChild(footer);

  document.body.appendChild(panel);
  updateTuneStatus();
}

socket.on("truck_mania_settings", ({ settings, canSave } = {}) => {
  savedSettingsList = Array.isArray(settings) ? settings : [];
  canSaveSettings = canSave !== false;
  if (tuneDraft) renderTuning(); // refresh the saved-versions list in place
});

// A save the server refused (usually a stale tab whose editor predates the
// current rules) — surface it in the issues box instead of failing silently.
socket.on("truck_mania_settings_error", ({ message } = {}) => {
  const box = document.querySelector(".tm-tuning .tm-tune-issues");
  if (!box) return;
  const li = document.createElement("div");
  li.textContent = `• ${message ?? "The server rejected these settings."}`;
  box.appendChild(li);
});

// --------------------------------------------------------------------------
// Controls
// --------------------------------------------------------------------------

function button(label, action, className = "ghost-btn") {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `${className} tm-btn`;
  btn.dataset.action = action;
  btn.textContent = label;
  return btn;
}

// A managed list of saved items (maps / settings). Every row: an editable
// title (type, then hit the green ✓ that appears), a load/apply button, and —
// on local runs only — a trash can that swaps the row to an inline
// are-you-sure (Yes / No). No browser prompt/confirm dialogs involved.
function buildSavedList({ items, canManage, loadLabel, emptyText, onLoad, onRename, onDelete }) {
  const panel = document.createElement("div");
  panel.className = "tm-saved-panel";
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "tm-saved-empty";
    empty.textContent = emptyText;
    panel.appendChild(empty);
    return panel;
  }
  items.forEach((item) => {
    const row = document.createElement("div");
    row.className = "tm-saved-row";

    const name = document.createElement("input");
    name.type = "text";
    name.className = "tm-saved-name";
    name.maxLength = 40;
    name.value = item.name;
    name.readOnly = !canManage;
    name.title = canManage ? "Type to rename, then hit the green ✓" : item.name;

    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "tm-btn tm-saved-ok";
    ok.textContent = "✓";
    ok.title = "Save the new name";
    ok.style.display = "none";
    name.addEventListener("input", () => {
      const dirty = canManage && name.value.trim() && name.value.trim() !== item.name;
      ok.style.display = dirty ? "" : "none";
    });
    name.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && ok.style.display !== "none") ok.click();
    });
    ok.addEventListener("click", () => onRename(item.id, name.value.trim()));

    const load = document.createElement("button");
    load.type = "button";
    load.className = "ghost-btn tm-btn tm-saved-load";
    load.textContent = loadLabel;
    load.addEventListener("click", () => onLoad(item.id));

    // Optional hint (settings rows: rules + attached map).
    let hint = null;
    if (item.hint) {
      hint = document.createElement("span");
      hint.className = "tm-saved-hint";
      hint.textContent = item.hint;
      hint.title = item.hint;
    }

    row.append(name, ok, ...(hint ? [hint] : []), load);

    if (canManage) {
      const del = document.createElement("button");
      del.type = "button";
      del.className = "ghost-btn tm-btn tm-saved-del";
      del.textContent = "🗑";
      del.title = `Delete “${item.name}”`;
      del.addEventListener("click", () => {
        row.classList.add("tm-saved-confirm");
        row.innerHTML = "";
        const q = document.createElement("span");
        q.className = "tm-saved-q";
        q.textContent = `Delete “${item.name}”?`;
        const yes = document.createElement("button");
        yes.type = "button";
        yes.className = "primary-btn tm-btn tm-saved-yes";
        yes.textContent = "Yes";
        yes.addEventListener("click", () => onDelete(item.id));
        const no = document.createElement("button");
        no.type = "button";
        no.className = "ghost-btn tm-btn tm-saved-no";
        no.textContent = "No";
        no.addEventListener("click", () => {
          row.classList.remove("tm-saved-confirm");
          row.innerHTML = "";
          row.append(name, ok, ...(hint ? [hint] : []), load, del);
        });
        row.append(q, yes, no);
      });
      row.appendChild(del);
    }
    panel.appendChild(row);
  });
  return panel;
}

function renderControls() {
  els.hand.innerHTML = "";
  els.hand.classList.remove("player-0", "player-1", "toy-rack", "flip-score");
  els.hand.classList.add("tm-controls");
  els.hand.classList.toggle("tm-controls-min", controlsMin && !editor);

  // Minimized: just a corner button to unfold, plus End turn so the game
  // stays playable. (The editor always shows its full toolbar.)
  if (controlsMin && !editor) {
    const openBtn = button("⚙", "togglebar");
    openBtn.title = "Show controls";
    els.hand.appendChild(openBtn);
    els.hand.appendChild(skipTurnButton());
    const endBtn = button(endTurnLabel(), "endturn", "primary-btn tm-end-turn");
    endBtn.disabled = !isMyTurn() || anyMyTruckShares() || diceAnimating || anyTruckAnimating() || flipping;
    els.hand.appendChild(endBtn);
    return;
  }

  if (!mapsRequested) {
    mapsRequested = true;
    socket.emit("truck_mania_list_maps");
    socket.emit("truck_mania_list_settings");
  }

  if (editor) {
    const streetBtn = button(editor.streetMode ? "Editing streets ✓" : "Edit streets", "streets");
    if (editor.streetMode) streetBtn.classList.add("tm-active");
    els.hand.appendChild(streetBtn);

    if (editor.streetMode) {
      const enough = editor.octagons.length >= 24;
      const note = document.createElement("span");
      note.className = `tm-street-note${enough ? "" : " tm-warn"}`;
      note.textContent = editor.newStreet
        ? "Click a street to finish · right-click a street to delete"
        : `${editor.octagons.length} intersections${enough ? "" : " — need 24 to save"}`;
      els.hand.appendChild(note);
    } else {
      els.hand.appendChild(button("▲ 3-side", "add3"));
      els.hand.appendChild(button("■ 4-side", "add4"));

      const connBtn = button("Connect", "addconn");
      if (editor.addingConn) connBtn.classList.add("tm-active");
      connBtn.disabled = editor.selected === -1;
      els.hand.appendChild(connBtn);

      const scaleWrap = document.createElement("label");
      scaleWrap.className = "tm-scale-wrap";
      scaleWrap.textContent = "Size";
      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = "40";
      slider.max = "220";
      slider.value = "100";
      slider.className = "tm-scale";
      slider.disabled = editor.selected === -1;
      slider.addEventListener("input", () => applyScale(Number(slider.value) / 100));
      slider.addEventListener("change", () => {
        editor.scaleBase = null;
        slider.value = "100";
      });
      scaleWrap.appendChild(slider);
      els.hand.appendChild(scaleWrap);
    }

    els.hand.appendChild(button("Undo", "undo", "primary-btn tm-undo"));
    if (canSaveMaps) {
      // Name the map right here, then hit the green ✓ to save it.
      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.className = "tm-saved-name tm-editor-name";
      nameInput.maxLength = 40;
      nameInput.placeholder = "Map name…";
      nameInput.value = editor.saveName ?? `Map ${savedMaps.length + 1}`;
      nameInput.addEventListener("input", () => { editor.saveName = nameInput.value; });
      els.hand.appendChild(nameInput);
      const saveBtn = button("✓ Save", "save", "primary-btn tm-saved-ok");
      saveBtn.title = "Save this map under the name on the left";
      saveBtn.disabled = editor.octagons.length < 24;
      els.hand.appendChild(saveBtn);
    }
    els.hand.appendChild(button("Exit", "exitedit"));
    return;
  }

  // Saved maps: a drop-up list — load one, retitle it (green ✓ commits), or
  // trash it (with an inline are-you-sure).
  const savedWrap = document.createElement("div");
  savedWrap.className = "tm-saved-wrap";
  const mapsBtn = button(`Saved maps (${savedMaps.length}) ${mapsMenuOpen ? "▾" : "▴"}`, "mapsmenu");
  if (mapsMenuOpen) mapsBtn.classList.add("tm-active");
  savedWrap.appendChild(mapsBtn);
  if (mapsMenuOpen) {
    savedWrap.appendChild(buildSavedList({
      items: savedMaps,
      canManage: canSaveMaps,
      loadLabel: "Load",
      emptyText: "No saved maps yet — Edit map, then ✓ Save.",
      onLoad: (id) => {
        mapsMenuOpen = false;
        socket.emit("truck_mania_load_map", { roomId: app.roomId, mapId: id });
      },
      onRename: (id, name) =>
        socket.emit("truck_mania_rename_map", { roomId: app.roomId, mapId: id, name }),
      onDelete: (id) =>
        socket.emit("truck_mania_delete_map", { roomId: app.roomId, mapId: id })
    }));
  }
  els.hand.appendChild(savedWrap);

  els.hand.appendChild(button("New map", "regen"));
  els.hand.appendChild(button("Mix up", "mixup"));
  els.hand.appendChild(button("Edit map", "edit"));
  els.hand.appendChild(button("Tuning", "tuning"));

  // The rule dials (ticket play is a given now; point mode still exists but
  // isn't offered here): Suspension on/off — face-down tickets ground your
  // pickups & dropoffs — and Variety vs Fragility. Variety is the classic
  // distinct-colors cargo rule; Fragility makes circles fragile packages:
  // any cargo mix goes, the Fragile column caps circles aboard, and each
  // fragile delivery pays a choice of time stones or money.
  const ruleSelect = (labelText, options, current, title, onPick) => {
    const wrap = document.createElement("label");
    wrap.className = "tm-mode-wrap";
    wrap.textContent = labelText;
    const sel = document.createElement("select");
    sel.className = "tm-mode-select";
    sel.title = title;
    options.forEach(([v, label]) => {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = label;
      if (current === v) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener("change", () => onPick(sel.value));
    wrap.appendChild(sel);
    els.hand.appendChild(wrap);
  };
  const emitRules = (susp, frag) => {
    if (!app.roomId) return;
    socket.emit("truck_mania_set_rules", { roomId: app.roomId, suspension: susp, fragility: frag });
  };
  ruleSelect(
    "Suspension",
    [["off", "Off"], ["on", "On"]],
    isSuspensionMode() ? "on" : "off",
    "Face-down tickets block pickups & dropoffs for the whole turn",
    (v) => emitRules(v === "on", isFragilityMode())
  );
  ruleSelect(
    "Rules",
    [["variety", "Variety"], ["fragility", "Fragility"]],
    isFragilityMode() ? "fragility" : "variety",
    "Variety: classic distinct-colors cargo rule. Fragility: circles are fragile — any mix goes, fragile capacity caps circles, and fragile deliveries pay stones or money.",
    (v) => emitRules(isSuspensionMode(), v === "fragility")
  );

  // AI opponents (0–3). Re-deals the board when changed.
  const aiWrap = document.createElement("label");
  aiWrap.className = "tm-ai-wrap";
  aiWrap.textContent = "AI";
  const aiSelect = document.createElement("select");
  aiSelect.className = "tm-ai-select";
  const currentAi = Math.max(0, (playersState.length || 1) - 1);
  for (let n = 0; n <= 3; n += 1) {
    const opt = document.createElement("option");
    opt.value = String(n);
    opt.textContent = String(n);
    if (n === currentAi) opt.selected = true;
    aiSelect.appendChild(opt);
  }
  aiSelect.addEventListener("change", () => {
    if (!app.roomId) return;
    socket.emit("truck_mania_set_opponents", { roomId: app.roomId, count: Number(aiSelect.value) });
  });
  aiWrap.appendChild(aiSelect);
  els.hand.appendChild(aiWrap);

  // Movement-selection mode: pick a previewed route, or hand-build one light
  // at a time. Switchable at any moment, mid-match included.
  const modeBtn = button(moveMode === "build" ? "Route: build" : "Route: auto", "routemode");
  if (moveMode === "build") modeBtn.classList.add("tm-active");
  els.hand.appendChild(modeBtn);

  // Animation speed dial (×1 … ×3), a room-wide setting usable mid-match.
  const speedWrap = document.createElement("label");
  speedWrap.className = "tm-speed-wrap";
  speedWrap.textContent = "Speed";
  const dial = document.createElement("input");
  dial.type = "range";
  dial.min = "1";
  dial.max = "3";
  dial.step = "0.5";
  dial.value = String(speedMult);
  dial.className = "tm-speed";
  const dialVal = document.createElement("span");
  dialVal.className = "tm-speed-val";
  dialVal.textContent = `×${speedMult}`;
  dial.addEventListener("input", () => {
    dialVal.textContent = `×${dial.value}`;
  });
  dial.addEventListener("change", () => {
    if (app.roomId) socket.emit("truck_mania_set_speed", { roomId: app.roomId, speed: Number(dial.value) });
  });
  speedWrap.append(dial, dialVal);
  els.hand.appendChild(speedWrap);

  els.hand.appendChild(skipTurnButton());

  const endBtn = button(endTurnLabel(), "endturn", "primary-btn tm-end-turn");
  endBtn.disabled = !isMyTurn() || anyMyTruckShares() || diceAnimating || anyTruckAnimating() || flipping;
  els.hand.appendChild(endBtn);

  const minBtn = button("⌄", "togglebar");
  minBtn.title = "Minimize controls";
  els.hand.appendChild(minBtn);
}

// Ticket mode: ending the turn rolls the banked dice — say so on the button.
function endTurnLabel() {
  return isTicketMode() && isMyTurn() && dicePoolState > 0
    ? `End turn · 🎲×${dicePoolState}`
    : "End turn";
}

// Skip the turn for a payout (ticket mode): only while nothing has been done
// yet — no move, pickup, dropoff, steal or special-building use. Changing the
// clock doesn't disqualify it. Pays BOTH the time-stone and money column values.
function canSkipTurn() {
  return isTicketMode() && isMyTurn() && winnerState == null &&
    turnTruck == null && !turnStolen && !turnActed && dicePoolState === 0;
}

function skipTurnLabel() {
  const me = myPlayer();
  return `Skip · +${columnValue("timestones", me) ?? 0}⬟ +${columnValue("money", me) ?? 0}🪙`;
}

// Build the Skip button (shown/hidden and relabeled by updateTurnControls).
function skipTurnButton() {
  const btn = button(skipTurnLabel(), "skipturn", "ghost-btn tm-skip-turn");
  btn.title = "Sit this turn out (changing the clock is still allowed) and collect your time-stone and money column values";
  btn.style.display = canSkipTurn() ? "" : "none";
  btn.disabled = anyMyTruckShares() || diceAnimating || anyTruckAnimating() || flipping;
  return btn;
}

// Light refresh of just the End-turn button's enabled state (called on every
// state update, without rebuilding the whole control bar). Also disabled while
// any truck is mid-drive or the clock is mid-flip, so a turn can't end before
// its animations have played out.
function updateTurnControls() {
  const btn = els.hand.querySelector(".tm-end-turn");
  if (btn) {
    btn.disabled = !isMyTurn() || anyMyTruckShares() || diceAnimating || anyTruckAnimating() || flipping;
    btn.textContent = endTurnLabel();
  }
  // The Skip offer disappears the moment the turn's first move/action lands.
  const skip = els.hand.querySelector(".tm-skip-turn");
  if (skip) {
    skip.style.display = canSkipTurn() ? "" : "none";
    skip.disabled = anyMyTruckShares() || diceAnimating || anyTruckAnimating() || flipping;
    skip.textContent = skipTurnLabel();
  }
}

// Reflect a (possibly remote) speed change on the dial + CSS transitions.
function applySpeed(sp) {
  if (sp === speedMult) return;
  speedMult = sp;
  document.body.style.setProperty("--tm-mult", String(sp));
  const dial = els.hand.querySelector(".tm-speed");
  if (dial) {
    dial.value = String(sp);
    const v = els.hand.querySelector(".tm-speed-val");
    if (v) v.textContent = `×${sp}`;
  }
}

// Brief banner marking the turn boundary: the old turn is over, this one's up.
function showTurnToast() {
  document.querySelector(".tm-turn-toast")?.remove();
  const p = playersState[turnWhose];
  const div = document.createElement("div");
  div.className = "tm-turn-toast";
  div.style.borderColor = p?.color ?? "#ffe17a";
  div.textContent = isMyTurn() ? "Your turn" : `${p?.name ?? "Opponent"}'s turn`;
  document.body.appendChild(div);
  setTimeout(() => div.remove(), 1900);
}

els.hand.addEventListener("click", (event) => {
  if (!isActive()) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  const btn = target.closest("[data-action]");
  if (!btn || btn.disabled || !app.roomId) return;

  switch (btn.dataset.action) {
    case "regen":
      socket.emit("truck_mania_regenerate", { roomId: app.roomId });
      break;
    case "mixup":
      socket.emit("truck_mania_mix_up", { roomId: app.roomId });
      break;
    case "endturn":
      socket.emit("truck_mania_end_turn", { roomId: app.roomId });
      break;
    case "skipturn":
      socket.emit("truck_mania_skip_turn", { roomId: app.roomId });
      break;
    case "routemode":
      moveMode = moveMode === "build" ? "auto" : "build";
      clearPreview();
      refreshBuilder();
      renderControls();
      break;
    case "tuning":
      if (tuneDraft) closeTuning();
      else openTuning();
      break;
    case "mapsmenu":
      mapsMenuOpen = !mapsMenuOpen;
      renderControls();
      break;
    case "togglebar":
      controlsMin = !controlsMin;
      localStorage.setItem("tmControlsMin", controlsMin ? "1" : "0");
      mapsMenuOpen = false;
      renderControls();
      break;
    case "edit":
      enterEditor();
      break;
    case "add3":
      addBuilding(3);
      break;
    case "add4":
      addBuilding(4);
      break;
    case "addconn":
      editor.addingConn = !editor.addingConn;
      renderEditor();
      renderControls();
      break;
    case "streets":
      editor.streetMode = !editor.streetMode;
      editor.addingConn = false;
      editor.newStreet = null;
      editor.selected = -1;
      renderEditor();
      renderControls();
      break;
    case "undo":
      undo();
      break;
    case "save":
      saveMap();
      break;
    case "exitedit":
      exitEditor();
      break;
    default:
      break;
  }
});

socket.on("truck_mania_maps", ({ maps, canSave } = {}) => {
  savedMaps = Array.isArray(maps) ? maps : [];
  canSaveMaps = canSave !== false;
  if (isActive() && !editor && els.hand.classList.contains("tm-controls")) renderControls();
});

// --------------------------------------------------------------------------

export const truckMania = {
  id: "truck-mania",
  name: "Truck Mania",
  description: "",

  handleState(payload, resetGameUi) {
    if (!payload.truckMania?.map) return false;
    resetGameUi();
    const tm = payload.truckMania;
    const beforePkgs = mapState ? snapshotPkgs() : null;
    const prevHour = hourState;
    hourState = tm.hour ?? null;
    timeState = tm.time ?? 0;
    nightState = !!tm.night;
    turnWhose = tm.turn ?? 0;
    turnActed = !!tm.turnState?.acted;
    turnStolen = !!tm.turnState?.stolen;
    turnChangedTime = !!tm.turnState?.changedTime;
    turnTruck = tm.turnState?.truck ?? null;
    stealVictimId = tm.turnState?.stealVictim ?? null;
    turnPickups = tm.turnState?.pickups ?? [];
    dicePoolState = tm.turnState?.dicePool ?? 0;
    pawnUsesState = tm.turnState?.pawnUses ?? 0;
    courtUsesState = tm.turnState?.courtUses ?? 0;
    aiMoveState = tm.aiMove ?? null;
    applySpeed(tm.speed ?? 1);
    // Reconcile the aimed truck: locked to the turn's mover once set, else keep
    // a valid selection among the player's trucks.
    const myIds = (tm.trucks ?? []).filter((t) => t.player === myIndex()).map((t) => t.id);
    if (turnTruck != null) selectedTruckId = turnTruck;
    else if (!myIds.includes(selectedTruckId)) selectedTruckId = myIds[0] ?? 0;
    playersState = tm.players ?? [];
    lastRollState = tm.lastRoll ?? null;
    decksState = tm.decks ?? null;
    winnerState = tm.winner ?? null;
    settingsState = tm.settings ?? settingsState;
    if (!isMyTurn()) {
      clearPreview();
      clearSteal();
    }

    if (editor && mapState && tm.map.seed === mapState.seed) {
      // Keep editing; the layout under edit hasn't been replaced.
      mapState = tm.map;
      updateTurn(payload.turn);
      return true;
    }
    if (editor) {
      editor = null;
      dragCtx = null;
    }

    const sameMap =
      boardMode === "play" && mapState && mapState.seed === tm.map.seed &&
      els.gameBoard.querySelector(".tm-map");

    if (sameMap) {
      const octLayoutChanged = mapState.intersections.some((o, i) => {
        const n = tm.map.intersections[i];
        return !n || n.x !== o.x || n.y !== o.y || n.number !== o.number;
      });
      mapState = tm.map;
      if (octLayoutChanged) {
        clearPreview(); // stale red counts
        refreshOctagonsHard();
        setHand();
      } else if (hourState != null && hourState !== prevHour) {
        clearPreview(); // lights flipped — previewed red counts no longer hold
        stagedTimeChange(hourState); // moves the hand, then flips one at a time
      } else {
        updateOctagons(tm.map);
        setHand();
      }
      updateDayNight();
      // A fresh ticket roll tumbles the dice for everyone; the mover's truck is
      // held (deferred drive) until the roll settles. If a clock flip is mid-
      // animation, the roll itself queues behind it: clock → dice → drive.
      const roll = tm.lastRoll;
      const newRoll = roll && roll.seq !== lastRollSeq && roll.dice?.length;
      if (roll) lastRollSeq = roll.seq;
      if (newRoll) {
        const startDice = () => {
          diceAnimating = true;
          updateTurnControls();
          refreshBuilder();
          animateDiceRoll(roll, () => {
            diceAnimating = false;
            runDeferredDrives();
            flushIdleFlies();
            updateTurnControls();
            refreshBuilder();
          });
        };
        if (flipping) clockQueue.push(startDice);
        else startDice();
      }
      // Animate other players' pickups/deliveries: hide the moved packages, let
      // syncTrucks/refresh render around them, then fly them in on arrival.
      const flyEvents = beforePkgs ? diffPkgEvents(beforePkgs, tm) : [];
      flyEvents.forEach((e) => animatingPkgs.add(e.pkg.id));
      syncTrucks(tm.trucks);
      renderTruckHighlight();
      renderBuildingPackagesRefresh();
      dispatchFlies(flyEvents);
      renderPlayerBoard();
      renderScoreboard();
      renderDice();
      renderDecks();
      renderTicketHighlights();
      renderSpecialPanel();
      renderFragileBonus();
      updateTurnControls(); // reflect turn/steal state on the End-turn button
      if (lastTurnSeen !== null && lastTurnSeen !== turnWhose && winnerState == null) {
        showTurnToast();
      }
      lastTurnSeen = turnWhose;
      refreshBuilder();
    } else {
      mapState = tm.map;
      previewState = null;
      stealSession = null;
      diceAnimating = false;
      flipping = false;
      clockQueue = [];
      deferredDrives = [];
      lastRollSeq = tm.lastRoll?.seq ?? lastRollSeq;
      Object.keys(pendingFlies).forEach((k) => delete pendingFlies[k]);
      Object.keys(truckSpots).forEach((k) => delete truckSpots[k]);
      Object.keys(truckPos).forEach((k) => delete truckPos[k]);
      Object.keys(pkgPos).forEach((k) => delete pkgPos[k]);
      animatingPkgs.clear();
      trucksState = tm.trucks ?? [];
      builder = null;
      renderMap();
      renderControls();
      lastTurnSeen = turnWhose;
      refreshBuilder();
    }

    if (winnerState != null) {
      const w = playersState[winnerState];
      const feat = isTicketMode()
        ? `${completedColumnsOf(w)} columns complete`
        : `${w?.points ?? ""} points`;
      els.turnStatus.textContent = winnerState === myIndex()
        ? `You win! ${feat}`
        : `${w?.name ?? "Opponent"} wins! ${feat}`;
    } else {
      // Columns done but tickets outstanding: say what's still in the way.
      const me = myPlayer();
      const ticketsLeft = (me?.tickets?.length ?? 0) + (me?.ticketPileCount ?? 0);
      const columnsDone = isTicketMode() && me &&
        completedColumnsOf(me) >= (settingsState?.columnsToWin ?? 3);
      els.turnStatus.textContent = isMyTurn()
        ? (amSuspended()
          ? "Your turn — 🚫 suspended: face-down tickets block pickups & dropoffs"
          : columnsDone && ticketsLeft > 0
            ? `Your turn — ✓ columns done, clear your ${ticketsLeft} 🎫 to win`
            : turnActed ? "Your turn — end when ready" : "Your turn")
        : `${playersState[turnWhose]?.name ?? "Opponent"}'s turn…`;
    }
    return true;
  },

  resetUi() {},

  clearState() {
    mapState = null;
    hourState = null;
    octEls = [];
    handEl = null;
    dayNightEl = null;
    editor = null;
    dragCtx = null;
    boardMode = "play";
    trucksState = [];
    playersState = [];
    graphCache = null;
    hoveredHour = null;
    flipping = false;
    handDeg = 0;
    previewState = null;
    stealSession = null;
    lastRollState = null;
    decksState = null;
    winnerState = null;
    timeState = 0;
    nightState = true;
    turnWhose = 0;
    turnActed = false;
    turnStolen = false;
    turnChangedTime = false;
    turnTruck = null;
    selectedTruckId = 0;
    stealVictimId = null;
    aiMoveState = null;
    lastRollSeq = -1;
    diceAnimating = false;
    deferredDrives = [];
    builder = null;
    lastTurnSeen = null;
    turnPickups = [];
    clockQueue = [];
    speedMult = 1;
    dicePoolState = 0;
    pawnUsesState = 0;
    courtUsesState = 0;
    mapsMenuOpen = false;
    document.body.style.removeProperty("--tm-mult");
    settingsState = null;
    closeTuning();
    Object.keys(pendingFlies).forEach((k) => delete pendingFlies[k]);
    playersState = [];
    document.querySelector(".game-header .tm-scoreboard")?.remove();
    document.querySelector(".tm-turn-toast")?.remove();
    animatingPkgs.clear();
    [truckEls, cargoEls, truckPos, truckSpots, pkgPos, pendingRoutes].forEach((o) =>
      Object.keys(o).forEach((k) => delete o[k])
    );
    Object.values(truckAnim).forEach((h) => h && cancelAnimationFrame(h));
    Object.keys(truckAnim).forEach((k) => delete truckAnim[k]);
  },

  onOpponentLeft() {},

  onExit() {
    this.clearState();
  }
};
