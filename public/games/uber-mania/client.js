// Uber Mania — the second "Traffic Time" game. Shares Truck Mania's board
// language (and its tm- styles for the map, clock, routes and dice): the same
// generated streets and stop signs, the same clock + time stones, a die banked
// per red light crossed. What's new: no packages — the buildings are locations
// of four types grouped into tinted neighbourhoods, each with two circles a
// player can claim with a token for the location's reward; ride cards from
// uber pickups; and the stress bar beside the clock that the end-of-turn dice
// roll against (fails cost tokens).
import { socket, els, app } from "../../shared/context.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const GREEN = "#3d9a5f";
const RED = "#cf4a3c";
const OCT_RADIUS = 13;
const CAR_SCALE = 1.35;
const CAR_SPEED = 200; // px per second

const LOC_LABELS = {
  timestone: "Time stones", token: "Tokens", destress: "Destress",
  upgrade: "Upgrade spot", uber: "Uber pickup"
};
// The payout symbol shown inside a location's empty token circles.
const SLOT_SYMBOLS = { timestone: "⬟", token: "💰", destress: "🍵" };

const isDuplicateMode = () => settingsState?.rideMode === "duplicate";

// The upgrade types the roaming upgrade spawns as (ids match the server).
// The supply is a depleting deck: two copies of each of these, plus one
// neighbourhood upgrade per hood.
const UPGRADE_META = {
  uturn: { icon: "↩️", name: "U-turn", desc: "Your car can U-turn" },
  rightOnRed: { icon: "↪️", name: "Right on red", desc: "Right turns at red lights don't bank a die" },
  nearbyParking: { icon: "🅿️", name: "Nearby parking", desc: "Use any location in the block you parked at" },
  timeLord: { icon: "🧙", name: "Time lord", desc: "Change the time as often as you like each turn" },
  superCalm: { icon: "😌", name: "Super calm", desc: "Sleeping drops your marker all the way to 1–2" },
  extraCash: { icon: "💵", name: "Extra cash", desc: "One extra token whenever you collect tokens" },
  extraTime: { icon: "⏳", name: "Extra time", desc: "Two extra stones whenever you collect time stones" },
  extraRide: { icon: "🚕", name: "Extra ride", desc: "Hold an extra ride card" },
  timeAgnostic: { icon: "🌗", name: "Time agnostic", desc: "Timed locations open for you at any hour" },
  undercut: { icon: "⤵️", name: "Undercut", desc: "Full locations still take your token — it slips beneath the ones on top (no slot-unlock credit, reward as normal)" }
};
const myUpgrades = () => myPlayer()?.upgrades ?? [];
const hasUpgrade = (type) => myUpgrades().includes(type);
// How many upgrades I may hold right now (2 base; visits unlock 3 and 4).
const myUpgradeCap = () => Math.max(2, Math.min(4, myPlayer()?.upgradeCap ?? 2));

// Meta for any upgrade type — the fixed catalog above, or a neighbourhood
// upgrade ("hood:<id>"): end a turn parked in that hood and choose a reward.
const HOOD_REWARD_META = {
  token: { icon: "💰", text: "1 token" },
  destress: { icon: "🍵", text: "1 destress step" },
  stones: { icon: "⬟", text: "2 time stones" }
};
function upgradeMeta(type) {
  if (UPGRADE_META[type]) return UPGRADE_META[type];
  const m = /^hood:(\d+)$/.exec(type ?? "");
  if (m) {
    const hood = hoodsState.find((h) => h.id === Number(m[1]));
    return {
      icon: "🏘️",
      color: hood?.color,
      name: `${hood?.name ?? "Neighbourhood"} local`,
      desc: "End your turn in this color's neighbourhood and choose: 1 token, 1 destress step, or 2 time stones"
    };
  }
  return { icon: "⬛", name: type ?? "Upgrade", desc: "" };
}
// The hood id a "hood:<id>" upgrade points at, or null.
const hoodIdOf = (type) => {
  const m = /^hood:(\d+)$/.exec(type ?? "");
  return m ? Number(m[1]) : null;
};

// Timed locations (the timedPeriods setting). 3 — Morning, Afternoon, Night
// (morning 6am–noon, afternoon 1pm–8pm, night 9pm–5am). 2 — Day, Night (day
// 7am–6pm, night 7pm–6am, and a third of locations unrestricted). A timed
// location wears its badge top right and only opens while the clock sits
// inside its period. (Keep these in sync with the server.)
const PERIOD_SYMBOLS = { morning: "🌅", afternoon: "☀️", night: "🌙", day: "☀️" };
const periodOf = (t) => (t >= 6 && t <= 12 ? "morning" : t >= 13 && t <= 20 ? "afternoon" : "night");
const dayNightOf = (t) => (t >= 7 && t <= 18 ? "day" : "night");
// Is this location open right now under the room's timed scheme?
const locOpen = (b, t) =>
  !b.period || ((Number(settingsState?.timedPeriods) === 2 ? dayNightOf(t) : periodOf(t)) === b.period);

// Scheduled upgrade mode: six 4-hour windows over the day; each upgrade
// location only opens during its own (b.window). (Keep in sync with the
// server's windowOf.)
const UPGRADE_WINDOW_LABELS = ["1–4am", "5–8am", "9am–12pm", "1–4pm", "5–8pm", "9pm–12am"];
const upgradeWindowOf = (t) => Math.floor(((t + 23) % 24) / 4);
const isScheduledUpgrades = () => settingsState?.upgradeMode === "scheduled";
// The upgrade waiting at this location right now, or null — scheduled mode
// reads the building's own dealt upgrade, spawn mode the roaming one.
const upgradeTypeAt = (b) =>
  isScheduledUpgrades() ? (b.upgrade ?? null) : (upgradeAtState === b.bid ? upgradeTypeState : null);
// Scheduled mode: is this upgrade location outside its 4-hour window?
const upgradeWindowClosed = (b) =>
  isScheduledUpgrades() && b.window != null && !hasUpgrade("timeAgnostic") &&
  upgradeWindowOf(timeState) !== b.window;

// Is this hex color dark enough that text on it should go light?
function isDarkColor(hex) {
  const n = parseInt(String(hex).slice(1), 16);
  if (!Number.isFinite(n)) return false;
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b < 140;
}

// A darker shade of a hex color, for location outlines.
function darken(hex, f = 0.62) {
  const n = parseInt(hex.slice(1), 16);
  if (!Number.isFinite(n)) return hex;
  const r = Math.round(((n >> 16) & 255) * f);
  const g = Math.round(((n >> 8) & 255) * f);
  const b = Math.round((n & 255) * f);
  return `rgb(${r}, ${g}, ${b})`;
}

// A lighter tint of a hex color (mixed toward white), for location fills —
// the full-strength color stays on the border.
function lighten(hex, f = 0.6) {
  const n = parseInt(String(hex).slice(1), 16);
  if (!Number.isFinite(n)) return hex;
  const mix = (c) => Math.round(c + (255 - c) * f);
  return `rgb(${mix((n >> 16) & 255)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let mapState = null;
let hoodsState = [];
let hourState = null;
let octEls = [];
let handEl = null;
let dayNightEl = null;
let hoveredHour = null;
let flipping = false;

let carsState = [];
const carEls = {}; // truck id -> svg group
const carPos = {}; // id -> { x, y, angle }
const carSpots = {}; // id -> last spot index rendered
const carAnim = {}; // id -> rAF handle
const pendingRoutes = {}; // id -> { spot, path, endAngle } awaiting server echo
let previewState = null; // { truckId, spot, routes } awaiting the player's pick
let graphCache = null;

let lastRollSeq = -1;
let diceAnimating = false;
let deferredDrives = [];
let clockQueue = [];

let timeState = 0;
let nightState = true;
let elapsedState = 0; // hours the clock has moved — the day counter
let turnWhose = 0;
let turnActed = false;
let turnChangedTime = false;
let turnDestressed = false;
let turnKeptGoing = false;
let turnUndo = null;
let turnTruck = null;
let dicePoolState = 0;
let moveMode = "build";
let builder = null;
let lastTurnSeen = null;
let speedMult = 1;
let controlsMin = localStorage.getItem("umControlsMin") === "1";
// Visual-only building size: 1 draws the lots wall to wall as generated,
// lower shrinks each one around its center so more open ground shows. Local
// to this client — sliding it mid-game touches nothing but pixels.
let buildingScale = (() => {
  const v = Number(localStorage.getItem("umBuildingScale"));
  return v >= 0.55 && v <= 1 ? v : 1;
})();

let playersState = [];
let lastRollState = null;
let winnerState = null;
let aiMoveState = null; // { truckId, path, endAngle } — an AI's drive to animate
let maxAiState = 3; // free AI seats — bounds the AI-count picker
let upgradeAtState = null; // bid of the upgrade location holding the roaming upgrade
let upgradeTypeState = null; // which upgrade type is sitting there
let upgradeDeckCountState = 0; // upgrades left in the depleting supply deck
let upgradeChampionsState = []; // seats that filled all four slots, in order
let funRollState = null; // { seq, player, face } — the no-dice consolation roll
let lastFunSeq = -1;
let resultsState = null; // end-game scoring breakdown, once the days run out
let resultsDismissed = false; // the player closed the chart overlay
let settingsState = null;
let tuneDraft = null; // working copy while the tuning panel is open
let tuneName = ""; // the name the next save will carry
let savedTunings = []; // [{ id, name }] from the server
let canSaveTunings = true;
let tuningsRequested = false;

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
  return !!car && car.spot == null;
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

// ---------------------------------------------------------------------------
// Building geometry
// ---------------------------------------------------------------------------

// A rect building as drawn under the building-size slider: scaled around its
// center. (Polygon buildings — the classic generator's triangles — skip the
// slider and draw as-is.)
function drawnRect(b) {
  const s = buildingScale;
  const w = b.w * s;
  const h = b.h * s;
  return { x: b.x + (b.w - w) / 2, y: b.y + (b.h - h) / 2, w, h };
}

function buildingCorners(b) {
  if (b.points) return b.points.map((p) => p.slice());
  const r = drawnRect(b);
  return [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]];
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

// ---------------------------------------------------------------------------
// Buildings. Locations wear their neighbourhood's color with a darker outline
// of the same. Token-circle locations show their name and two circles carrying
// the payout symbol; uber pickups show one big landmark emoji.
// ---------------------------------------------------------------------------

function appendBuilding(parent, building) {
  const cls = ["tm-building", "um-building"];
  if (building.role === "loc") cls.push("um-loc", `um-loc-${building.locType}`);
  const g = svgEl("g", { class: cls.join(" "), "data-bldg": building.bid }, parent);
  // Locations: a light tint of the neighbourhood color inside, the full color
  // on the border (via a CSS variable, so the highlight states can still win).
  const isLoc = building.role === "loc";
  const fillColor = isLoc ? lighten(building.color) : building.color;
  if (isLoc) g.style.setProperty("--um-stroke", building.color);

  (building.connectors ?? []).forEach((c) => {
    const [x1, y1] = connectorStart(building, c);
    svgEl("line", {
      x1, y1, x2: c.x2, y2: c.y2,
      stroke: building.color,
      "stroke-width": 2
    }, g);
  });

  if (building.points) {
    svgEl("polygon", { points: polygonToString(building.points), fill: fillColor }, g);
  } else {
    const dr = drawnRect(building);
    const rect = svgEl("rect", {
      x: dr.x, y: dr.y, width: dr.w, height: dr.h,
      rx: 3,
      fill: fillColor
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

  if (building.role === "loc" && building.locType === "uber") {
    // A landmark: one big emoji, no circles, no board name.
    const [cx, cy] = buildingCentroid(building);
    const icon = svgEl("text", { x: cx, y: cy + 1, class: "um-loc-emoji" }, g);
    icon.textContent = building.emoji ?? "🚕";
  } else if (building.role === "loc" && building.locType === "upgrade") {
    // Upgrade spot: no name, no imagery — just the upgrade square, big
    // enough to fill most of the lot. Solid black while an upgrade sits
    // here, a faint outline while dead. Scheduled mode wears its 4-hour
    // window along the square's top edge. (Duplicate mode leaves room for
    // the identifying corner emoji.)
    const [cx, cy] = buildingCentroid(building);
    const bb = buildingBBox(building);
    const side = Math.max(
      14,
      Math.min(bb.maxX - bb.minX, bb.maxY - bb.minY) - (isDuplicateMode() ? 26 : 12)
    );
    svgEl("rect", {
      x: cx - side / 2, y: cy - side / 2, width: side, height: side, rx: 3,
      class: "um-upgrade-sq"
    }, g);
    // The waiting upgrade's icon, filled in by refreshLocations — sized to
    // the square.
    const icon = svgEl("text", { x: cx, y: cy + side * 0.06, class: "um-upgrade-icon" }, g);
    icon.style.fontSize = `${Math.max(10, Math.round(side * 0.4))}px`;
    if (building.window != null) {
      const label = svgEl("text", { x: cx, y: cy - side / 2 + 7.5, class: "um-upgrade-window" }, g);
      label.textContent = UPGRADE_WINDOW_LABELS[building.window] ?? "";
    }
    appendLocEmoji(g, building);
  } else if (building.role === "loc") {
    const [cx, cy] = buildingCentroid(building);
    const dup = isDuplicateMode();
    if (dup) {
      // Duplicate mode keeps the name up top — ride cards point at the
      // location by name and emoji.
      const name = svgEl("text", { x: cx, y: cy - 12, class: "um-loc-name" }, g);
      name.textContent = building.name ?? "";
      if (isDarkColor(fillColor)) name.style.fill = "rgba(247, 244, 238, 0.95)";
    }
    // Ride-2 / ride-pickup: no name, no imagery — just the two big token
    // circles carrying the payout symbol, replaced by the claimer's color
    // once taken. (Duplicate mode: its compact single circle under the name.)
    const slots = svgEl("g", { class: "um-loc-slots" }, g);
    const slotArr = building.slots ?? [null, null];
    const single = slotArr.length === 1;
    const geom = slotGeometry(building);
    slotArr.forEach((owner, i) => {
      const [x, y] = geom.centers[i] ?? [cx, cy];
      const c = svgEl("circle", {
        cx: x, cy: y, r: geom.r,
        class: dup ? (single ? "um-slot um-slot-big" : "um-slot") : "um-slot um-slot-xl"
      }, slots);
      const sym = svgEl("text", {
        x, y: y + 0.5,
        class: dup && single ? "um-slot-sym um-slot-sym-big" : "um-slot-sym"
      }, slots);
      if (!dup) sym.style.fontSize = `${geom.sym}px`;
      sym.textContent = SLOT_SYMBOLS[building.locType] ?? "";
      if (owner != null) {
        c.style.fill = playersState[owner]?.color ?? "#888";
        c.classList.add("um-slot-taken");
        sym.style.display = "none";
      }
    });
    if (building.period) {
      // Timed locations: the visiting-period badge, top right.
      const bb = buildingBBox(building);
      const badge = svgEl("text", { x: bb.maxX - 10, y: bb.minY + 10, class: "um-loc-period" }, g);
      badge.textContent = PERIOD_SYMBOLS[building.period] ?? "";
    }
    // Undercut tokens land here as small dots beneath the circles
    // (refreshLocations fills it in).
    svgEl("g", { class: "um-loc-under" }, g);
    appendLocEmoji(g, building);
  }
}

// Token-circle layout, shared by the initial draw and refreshLocations.
// Duplicate mode keeps its compact circle(s) under the location name; the
// other ride modes fill the lot with big centered circles and nothing else.
function slotGeometry(b) {
  const [cx, cy] = buildingCentroid(b);
  const count = (b.slots ?? [null, null]).length;
  if (isDuplicateMode()) {
    return {
      r: 10,
      sym: count === 1 ? 12 : 11,
      underY: cy + (count === 1 ? 21 : 20),
      centers: count === 1 ? [[cx, cy + 6]] : [[cx - 11, cy + 6], [cx + 11, cy + 6]]
    };
  }
  const bb = buildingBBox(b);
  const r = Math.max(6, Math.min(
    15,
    (bb.maxX - bb.minX - 8) / (2.2 * count),
    (bb.maxY - bb.minY - 8) / 2.6
  ));
  return {
    r,
    sym: Math.max(9, Math.round(r * 1.05)),
    underY: cy + r + 5.5,
    centers: Array.from({ length: count }, (_, i) => [cx + (i - (count - 1) / 2) * (2 * r + 3), cy])
  };
}

// A connector's building end, once the rect is drawn scaled: the edge retreats
// toward the center, so the driveway grows inward to still reach it. The
// street end never moves — parking spots are game state.
function connectorStart(b, c) {
  if (buildingScale >= 1 || b.points || !b.w) return [c.x1, c.y1];
  const dx = c.x2 - c.x1;
  const dy = c.y2 - c.y1;
  const len = Math.hypot(dx, dy) || 1;
  const ext = ((1 - buildingScale) / 2) * (Math.abs(dx) > Math.abs(dy) ? b.w : b.h);
  return [c.x1 - (dx / len) * ext, c.y1 - (dy / len) * ext];
}

// Duplicate mode gives every location its own emoji (the ride cards point by
// picture) — worn big in the building's top-left corner: it's the location's
// identity on the board, so it reads before the circle does.
function appendLocEmoji(g, building) {
  if (!building.emoji || building.locType === "uber") return;
  const bb = buildingBBox(building);
  const t = svgEl("text", { x: bb.minX + 13, y: bb.minY + 12, class: "um-loc-emoji-corner" }, g);
  t.textContent = building.emoji;
}

// Redraw the whole buildings layer at the current building-size dial —
// geometry only, every bit of game state re-applies via refreshLocations.
function applyBuildingScale() {
  const layer = els.gameBoard.querySelector(".tm-map .tm-blocks");
  if (!layer || !mapState) return;
  layer.innerHTML = "";
  (mapState.blocks ?? []).forEach((block) => {
    (block.buildings ?? []).forEach((building) => appendBuilding(layer, building));
  });
  refreshLocations();
}

// Redraw just the token circles + placeable glow (state changes, same map).
function refreshLocations() {
  const svg = els.gameBoard.querySelector(".tm-map");
  if (!svg || !mapState) return;
  const canSet = new Set(placeableBids());
  (mapState.blocks ?? []).forEach((bl) => (bl.buildings ?? []).forEach((b) => {
    if (b.role !== "loc") return;
    const g = svg.querySelector(`.tm-building[data-bldg="${b.bid}"]`);
    if (!g) return;
    const slotsG = g.querySelector(".um-loc-slots");
    if (slotsG) {
      const circles = slotsG.querySelectorAll(".um-slot");
      const syms = slotsG.querySelectorAll(".um-slot-sym");
      (b.slots ?? []).forEach((owner, i) => {
        const c = circles[i];
        if (!c) return;
        if (owner != null) {
          c.style.fill = playersState[owner]?.color ?? "#888";
          c.classList.add("um-slot-taken");
          if (syms[i]) syms[i].style.display = "none";
        } else {
          c.style.removeProperty("fill");
          c.classList.remove("um-slot-taken");
          if (syms[i]) syms[i].style.removeProperty("display");
        }
      });
    }
    // Undercut tokens: small dots beneath the circles, in claimer colors.
    const underG = g.querySelector(".um-loc-under");
    if (underG) {
      underG.innerHTML = "";
      const under = b.under ?? [];
      if (under.length) {
        const [ucx] = buildingCentroid(b);
        const { underY } = slotGeometry(b);
        under.forEach((seat, k) => {
          svgEl("circle", {
            cx: ucx + (k - (under.length - 1) / 2) * 9,
            cy: underY,
            r: 3.2,
            class: "um-under-dot",
            fill: playersState[seat]?.color ?? "#888"
          }, underG);
        });
      }
    }
    g.classList.toggle("um-loc-can", canSet.has(b.bid));
    g.classList.toggle("um-loc-complete", completableBid() === b.bid);
    let offtime = !locOpen(b, timeState);
    if (b.locType === "upgrade") {
      const type = upgradeTypeAt(b);
      g.classList.toggle("um-upgrade-active", type != null);
      const meta = type != null ? upgradeMeta(type) : null;
      const icon = g.querySelector(".um-upgrade-icon");
      if (icon) icon.textContent = meta?.icon ?? "";
      // A hood upgrade paints the square its neighbourhood's color.
      const sq = g.querySelector(".um-upgrade-sq");
      if (sq) {
        if (meta?.color) sq.style.fill = meta.color;
        else sq.style.removeProperty("fill");
      }
      // Scheduled mode: a still-waiting upgrade reads muted outside its
      // 4-hour window.
      if (type != null && upgradeWindowClosed(b)) offtime = true;
    }
    g.classList.toggle("um-loc-offtime", offtime);
  }));
  renderRideHighlights();
}

// Could the player use this particular location (rules only — parking is the
// caller's problem)?
function canUseLoc(b) {
  if (!b || b.role !== "loc") return false;
  if (b.locType === "uber") {
    // Ride-pickup mode: free and unlimited — always usable. Ride-2 mode:
    // pure destinations, nothing to click (arriving completes cards itself).
    return (settingsState?.rideMode ?? "ride-2") === "ride-pickup";
  }
  if (b.locType === "upgrade") {
    // Free to grab — but only where an upgrade actually sits (scheduled
    // mode: the location's own, inside its 4-hour window; spawn mode: the
    // roaming one), and only with a free slot on my player board.
    return upgradeTypeAt(b) != null && !upgradeWindowClosed(b) &&
      myUpgrades().length < myUpgradeCap();
  }
  if (!Array.isArray(b.slots)) return false;
  if (b.locType === "destress" && turnKeptGoing) return false; // no calming after rushing
  if (!hasUpgrade("timeAgnostic") && !locOpen(b, timeState)) return false; // closed this period
  // One token per player per location — on top or beneath.
  if (b.slots.includes(myIndex()) || (b.under ?? []).includes(myIndex())) return false;
  // Full circles still take an undercut token (it slips in beneath).
  if (!b.slots.includes(null) && !hasUpgrade("undercut")) return false;
  if ((myPlayer()?.tokens ?? 0) < 1) return false;
  return true;
}

// Every location the player could use right now: normally just the parked
// building — with the nearby-parking upgrade, any location in its block.
function placeableBids() {
  if (!isMyTurn() || turnActed || winnerState != null || diceAnimating) return [];
  const car = myCar();
  if (!car || car.spot == null || carAnim[car.id] != null) return [];
  const spot = mapState?.spots?.[car.spot];
  if (!spot) return [];
  const b0 = buildingByBid(spot.building);
  if (!b0) return [];
  let cands = [b0];
  if (hasUpgrade("nearbyParking")) {
    const block = (mapState.blocks ?? [])
      .find((bl) => (bl.buildings ?? []).some((x) => x.bid === b0.bid));
    if (block?.buildings?.length) cands = block.buildings;
  }
  return cands.filter(canUseLoc).map((b) => b.bid);
}

function placeableBid() {
  return placeableBids()[0] ?? null;
}

// Duplicate mode: the location the player could complete a ride at right now
// (or null) — parked there with a matching face-up card, turn not yet acted.
function completableBid() {
  if (!isDuplicateMode()) return null;
  if (!isMyTurn() || turnActed || winnerState != null || diceAnimating) return null;
  const car = myCar();
  if (!car || car.spot == null || carAnim[car.id] != null) return null;
  const spot = mapState?.spots?.[car.spot];
  if (!spot) return null;
  const b = buildingByBid(spot.building);
  if (!b || b.role !== "loc") return null;
  const match = (myPlayer()?.rides ?? []).some((r) => r.loc === b.bid && !r.faceDown);
  return match ? b.bid : null;
}

function buildingByBid(bid) {
  for (const block of mapState?.blocks ?? []) {
    for (const b of block.buildings ?? []) {
      if (b.bid === bid) return b;
    }
  }
  return null;
}

// Light up the destinations of my open ride cards.
function renderRideHighlights() {
  const svg = els.gameBoard.querySelector(".tm-map");
  if (!svg) return;
  svg.querySelectorAll(".um-ride-lit").forEach((el) => el.classList.remove("um-ride-lit"));
  (myPlayer()?.rides ?? []).forEach((r) => {
    if (r.faceDown) return; // hidden until the turn ends
    svg.querySelector(`.tm-building[data-bldg="${r.loc}"]`)?.classList.add("um-ride-lit");
  });
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
  const svg = els.gameBoard.querySelector(".tm-map");
  const layer = svg?.querySelector(".tm-octagons");
  if (!svg || !layer) return false;
  layer.remove();
  renderOctagons(svg);
  return true;
}

// ---------------------------------------------------------------------------
// The clock (+ stress bar beside it)
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

function renderClock() {
  const wrap = document.createElement("div");
  wrap.className = "tm-clock";

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
    if (!hourElement || !app.roomId || !isActive() || !isMyTurn() || diceAnimating) return;
    if (turnChangedTime && !hasUpgrade("timeLord")) return; // once per turn (time lords excepted)
    const hour = Number(hourElement.dataset.hour);
    const cost = hourCost(hour);
    if (!cost || cost > (myPlayer()?.timeStones ?? 0)) return;
    socket.emit("uber_mania_set_hour", { roomId: app.roomId, hour });
  });

  els.gameBoard.appendChild(wrap);
  setHand();
  updateDayNight();
  renderStressBar();
}

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
  // The day counter: the game ends after the settings' days have run out.
  const totalDays = settingsState?.days ?? 3;
  const day = Math.min(totalDays, Math.floor(elapsedState / 24) + 1);
  const dayTag = document.createElement("span");
  dayTag.className = "um-day-tag";
  dayTag.textContent = `Day ${day}/${totalDays}`;
  const hoursLeft = totalDays * 24 - elapsedState;
  dayTag.title = winnerState != null
    ? "The days are over"
    : `${Math.max(0, hoursLeft)}h left — the game is scored once they run out`;
  if (hoursLeft <= 12 && winnerState == null) dayTag.classList.add("um-day-late");
  dayNightEl.appendChild(dayTag);
  if (dicePoolState > 0) {
    const pool = document.createElement("span");
    pool.className = "tm-pool-tag";
    pool.textContent = `🎲 ×${dicePoolState}`;
    pool.title = "Stress dice — rolled when the turn ends";
    dayNightEl.appendChild(pool);
  }
  dayNightEl.classList.toggle("tm-night", nightState);
}

// The stress bar: 1 at the top, 6 at the bottom, every player's marker in a
// gap between two numbers. A die at or under the number ABOVE your marker is
// safe; destress moves the marker one gap down (more safe numbers).
function renderStressBar() {
  els.gameBoard.querySelector(".um-stress")?.remove();
  if (!playersState.length) return;
  const wrap = document.createElement("div");
  wrap.className = "um-stress";
  const title = document.createElement("div");
  title.className = "um-stress-title";
  title.textContent = "STRESS";
  wrap.appendChild(title);
  const bar = document.createElement("div");
  bar.className = "um-stress-bar";
  for (let n = 1; n <= 6; n += 1) {
    const cell = document.createElement("div");
    cell.className = "um-stress-num";
    cell.style.top = `${((n - 1) / 5) * 100}%`;
    cell.textContent = String(n);
    bar.appendChild(cell);
  }
  playersState.forEach((p, i) => {
    const s = Math.max(1, Math.min(5, p.stress ?? 3));
    const marker = document.createElement("span");
    marker.className = "um-stress-marker";
    if (i === myIndex()) marker.classList.add("um-stress-mine");
    marker.style.background = p.color;
    marker.style.top = `${((s - 0.5) / 5) * 100}%`;
    marker.style.left = `${5 + i * 12}px`;
    marker.title = `${seatName(i)} — safe rolls: 1–${s}`;
    bar.appendChild(marker);
  });
  wrap.appendChild(bar);
  els.gameBoard.appendChild(wrap);
}

// ---------------------------------------------------------------------------
// Street graph + routing (same rules as Truck Mania: no U-turns)
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

// Screen y points down, so a positive heading change is clockwise — a right
// turn. Between ~25° and ~155° reads as a genuine right turn (not straight,
// not a U-turn).
function isRightTurn(inAngle, outAngle) {
  let turn = outAngle - inAngle;
  while (turn > 180) turn -= 360;
  while (turn < -180) turn += 360;
  return turn > 25 && turn < 155;
}

// Reds along a route path, forgiving right turns (the right-on-red upgrade):
// same red selection as findRoutes' arcReds — every red light on the path,
// except ones hugging the start or destination.
function routeRedsRightOnRed(path, ax, ay, bx, by) {
  if (!path || path.length < 2) return 0;
  const REACH = OCT_RADIUS;
  const cum = cumLengths(path);
  let n = 0;
  for (const o of mapState?.intersections ?? []) {
    if (o.color !== "red") continue;
    if (Math.hypot(o.x - ax, o.y - ay) < REACH || Math.hypot(o.x - bx, o.y - by) < REACH) continue;
    // Closest approach of the path to this light.
    let bestD = Infinity;
    let bestS = 0;
    for (let i = 0; i < path.length - 1; i += 1) {
      const dx = path[i + 1][0] - path[i][0];
      const dy = path[i + 1][1] - path[i][1];
      const lenSq = dx * dx + dy * dy;
      let t = lenSq ? ((o.x - path[i][0]) * dx + (o.y - path[i][1]) * dy) / lenSq : 0;
      t = Math.max(0, Math.min(1, t));
      const px = path[i][0] + t * dx;
      const py = path[i][1] + t * dy;
      const d = Math.hypot(o.x - px, o.y - py);
      if (d < bestD) {
        bestD = d;
        bestS = cum[i] + Math.sqrt(lenSq) * t;
      }
    }
    if (bestD >= REACH) continue; // not on the path
    const inA = sampleAlong(path, cum, Math.max(0, bestS - 16)).angle;
    const outA = sampleAlong(path, cum, Math.min(cum[cum.length - 1], bestS + 16)).angle;
    if (!isRightTurn(inA, outA)) n += 1;
  }
  return n;
}

// Up to two candidate routes (arriving in either facing); each is
// { path, reds, endAngle, endDir }. Lexicographic cost: reds, then distance.
// `canUturn` (the U-turn upgrade) opens reversing out of the spot and
// about-turns at junctions.
function findRoutes(graph, ax, ay, headingDeg, bx, by, canUturn = false) {
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
    if (!canUturn) {
      const [dx, dy] = polyDir(e.pts);
      if (dx * hx + dy * hy <= 0) return; // no reversing out of the spot
    }
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
  const g = svgEl("g", { class: "um-car" }, parent);
  const dark = "rgba(18,22,28,0.9)";
  // Body: long hood and windshield on the right — the nose points at +x, the
  // direction the movement transform rotates toward.
  svgEl("path", {
    d: "M14 4 L14 -2 Q13 -4 10 -4 L6 -4 L2 -9 L-7 -9 L-11 -4 Q-14 -4 -14 -1 L-14 4 Z",
    fill: bodyColor, stroke: dark, "stroke-width": 1.5, class: "um-car-body"
  }, g);
  // Windows.
  svgEl("path", { d: "M1 -8 L4.5 -4 L-1 -4 L-1 -8 Z", fill: "#bfe0f0", stroke: dark, "stroke-width": 0.7 }, g);
  svgEl("path", { d: "M-3 -8 L-6.5 -8 L-9.5 -4 L-3 -4 Z", fill: "#bfe0f0", stroke: dark, "stroke-width": 0.7 }, g);
  // Headlight.
  svgEl("circle", { cx: 13.4, cy: 1, r: 1.2, fill: "#f5d76e" }, g);
  // Wheels.
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
  if (isOffBoard(t)) g.style.display = "none"; // waiting in the garage up top
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
    if (t.spot == null) {
      if (carEls[t.id]) carEls[t.id].style.display = "none";
      delete carSpots[t.id];
      delete carPos[t.id];
      delete pendingRoutes[t.id];
      return;
    }
    const spot = mapState.spots?.[t.spot];
    if (!spot || !carEls[t.id]) return;
    carEls[t.id].style.display = "";
    const prev = carSpots[t.id];
    if (prev == null) {
      // First placement: a fresh render (snap) or the drive in from off-board
      // (the human's approved entry route, or the AI's server-computed one).
      carSpots[t.id] = t.spot;
      const pending = pendingRoutes[t.id];
      let entry = null;
      if (pending?.spot === t.spot) entry = pending;
      else if (aiMoveState && aiMoveState.truckId === t.id) entry = aiMoveState;
      delete pendingRoutes[t.id];
      if (entry?.path?.length >= 2) {
        const p0 = entry.path[0];
        const [dx, dy] = polyDir(entry.path);
        carPos[t.id] = { x: p0[0], y: p0[1], angle: (Math.atan2(dy, dx) * 180) / Math.PI };
        carTransform(t.id);
        startDrive(t.id, entry.path, entry.endAngle);
        return;
      }
      carPos[t.id] = { x: spot.x, y: spot.y, angle: spot.angle };
      carTransform(t.id);
    } else if (prev !== t.spot) {
      carSpots[t.id] = t.spot;
      if (previewState?.truckId === t.id) clearPreview();
      const pending = pendingRoutes[t.id];
      delete pendingRoutes[t.id];
      let path;
      let endAngle;
      if (pending?.spot === t.spot) {
        path = pending.path;
        endAngle = pending.endAngle;
      } else if (aiMoveState && aiMoveState.truckId === t.id) {
        path = aiMoveState.path;
        endAngle = aiMoveState.endAngle;
      } else {
        const from = carPos[t.id] || { x: spot.x, y: spot.y };
        path = findPath(getGraph(), from.x, from.y, spot.x, spot.y);
        endAngle = lastPathAngle(path, spot.angle);
      }
      startDrive(t.id, path, endAngle);
    }
  });
}

function startDrive(id, path, endAngle) {
  if (diceAnimating || flipping) {
    deferredDrives.push({ id, path, endAngle });
    return;
  }
  driveCar(id, path, endAngle, () => onCarArrive(id));
}

function runDeferredDrives() {
  const list = deferredDrives;
  deferredDrives = [];
  list.forEach((d) => driveCar(d.id, d.path, d.endAngle, () => onCarArrive(d.id)));
}

function onCarArrive() {
  updateTurnControls();
  refreshBuilder();
  refreshLocations(); // the parked-at location may now glow placeable
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
// Route preview (auto mode)
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
    let nx = a[0] + b[0];
    let ny = a[1] + b[1];
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
  pendingRoutes[car.id] = { spot: previewState.spot, path: route.path, endAngle: route.endAngle };
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
  const routes = findRoutes(getGraph(), pos.x, pos.y, pos.angle, dest.x, dest.y, hasUpgrade("uturn"));
  if (!routes.length) {
    clearPreview();
    window.alert("No route: the car can't reach that spot without a U-turn.");
    return;
  }
  if (hasUpgrade("rightOnRed")) {
    // Right on red: recount each route's dies, forgiving right turns.
    routes.forEach((r) => {
      r.reds = routeRedsRightOnRed(r.path, pos.x, pos.y, dest.x, dest.y);
    });
  }
  previewState = { truckId: car.id, spot: spotIndex, routes };
  renderRoutePreview();
}

// ---------------------------------------------------------------------------
// Build mode: hand-build a route one stop light at a time.
// ---------------------------------------------------------------------------

function manualChoices(px, py, headingDeg, canUturn = false, firstLeg = true) {
  const graph = getGraph();
  const res = { octs: [], spots: [] };
  const start = nearestNode(graph, px, py);
  if (start < 0) return res;

  const octs = mapState.intersections ?? [];
  const spots = mapState.spots ?? [];
  // Each octagon gates at its single NEAREST node only. Matching every node
  // within reach used to swallow whole corridors: a parking spot's node a
  // pixel past a light read as "arrived at that light" and stopped the
  // expansion, leaving the next light down the street unclickable.
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
    if (!canUturn) {
      const [dx, dy] = polyDir(e.pts);
      const dot = dx * hx + dy * hy;
      // First leg: can't reverse out of the spot. Later legs start at a
      // junction, where turning left/right is fine — only U-turns are barred.
      if (firstLeg ? dot <= 0 : dot < UTURN_COS) return;
    }
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

function builderHead() {
  const w = builder.waypoints[builder.waypoints.length - 1];
  if (!w) {
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
  const firstLeg = !builder.entry && builder.waypoints.length === 0;
  const c = manualChoices(head.x, head.y, head.angle, hasUpgrade("uturn"), firstLeg);
  const car = carsState.find((t) => t.id === builder.truckId);
  c.spots = c.spots.filter(({ index }) => {
    if (car && car.spot != null && index === car.spot) return false;
    return !carsState.some((t) => t.id !== builder.truckId && t.spot === index);
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

function builderReds() {
  const ror = hasUpgrade("rightOnRed");
  let n = 0;
  builder.waypoints.forEach((w, i) => {
    if (w.kind !== "oct" || mapState.intersections[w.index]?.color !== "red") return;
    if (ror) {
      // Right on red is free — readable once the leg OUT of the light is
      // built (until then the red counts, and the tally drops on the turn).
      const next = builder.waypoints[i + 1];
      if (next?.path?.length >= 2) {
        const p = next.path;
        let outA = w.endAngle;
        for (let k = 1; k < p.length; k += 1) {
          const dx = p[k][0] - p[0][0];
          const dy = p[k][1] - p[0][1];
          if (Math.hypot(dx, dy) > 2) {
            outA = (Math.atan2(dy, dx) * 180) / Math.PI;
            break;
          }
        }
        if (isRightTurn(w.endAngle, outA)) return;
      }
    }
    n += 1;
  });
  return n;
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
  socket.emit("uber_mania_move_truck", { roomId: app.roomId, truckId, spot: last.index, reds });
}

function refreshBuilder() {
  const car = myCar();
  const off = isOffBoard(car);
  const eligible =
    (moveMode === "build" || off) && isActive() && app.roomId &&
    isMyTurn() && !turnActed && winnerState == null && car && !diceAnimating &&
    carAnim[car.id] == null && (off || carPos[car.id]);
  if (!eligible) {
    builder = null;
    renderBuild();
    return;
  }
  if (!builder || builder.truckId !== car.id || builder.baseSpot !== car.spot) {
    builder = {
      truckId: car.id,
      baseSpot: car.spot,
      entry: off,
      waypoints: [],
      done: false,
      choices: null
    };
    builder.choices = computeBuilderChoices();
  }
  renderBuild();
}

function renderBuild() {
  const svg = els.gameBoard.querySelector(".tm-map");
  if (!svg) return;
  svg.querySelector(".tm-build")?.remove();
  svg.querySelectorAll(".tm-oct-choice").forEach((el) => el.classList.remove("tm-oct-choice"));
  svg.querySelectorAll(".tm-spot-choice").forEach((el) => el.classList.remove("tm-spot-choice"));
  svg.querySelectorAll(".tm-spot-picked").forEach((el) => el.classList.remove("tm-spot-picked"));
  if (!builder) {
    renderBuildPanel(); // clears the action bar's builder slot
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

  if (builder.done) {
    const last = builder.waypoints[builder.waypoints.length - 1];
    svg.querySelector(`.tm-spot[data-spot="${last.index}"]`)?.classList.add("tm-spot-picked");
    // The Go button floats just past the arrow, in the direction it points.
    if (full.length >= 2) {
      const dressed = dressPath(full);
      const end = dressed[dressed.length - 1];
      const cum = cumLengths(dressed);
      const tip = sampleAlong(dressed, cum, Math.max(0, cum[cum.length - 1] - 0.5));
      const rad = (tip.angle * Math.PI) / 180;
      const gx = Math.max(34, Math.min((mapState.width ?? 960) - 34, end[0] + Math.cos(rad) * 34));
      const gy = Math.max(20, Math.min((mapState.height ?? 720) - 20, end[1] + Math.sin(rad) * 34));
      const go = svgEl("g", { class: "um-go", transform: `translate(${r1(gx)} ${r1(gy)})` }, layer);
      // See-through: just a colored border and the text, so nothing under it
      // is hidden. Stroke rides as a presentation attribute so :hover can win.
      svgEl("rect", { x: -24, y: -13, width: 48, height: 26, rx: 13, stroke: color, class: "um-go-bg" }, go);
      const t = svgEl("text", { x: 0, y: 1, class: "um-go-text" }, go);
      t.textContent = "GO";
      go.addEventListener("click", (e) => {
        e.stopPropagation();
        builderGo();
      });
    }
  } else {
    builder.choices.octs.forEach((c) => octEls[c.index]?.g.classList.add("tm-oct-choice"));
    builder.choices.spots.forEach((c) =>
      svg.querySelector(`.tm-spot[data-spot="${c.index}"]`)?.classList.add("tm-spot-choice")
    );
  }
  renderBuildPanel();
}

// The builder's controls live in the bottom-right action bar, next to
// Leave Game (ensureActionBar owns the container).
function renderBuildPanel() {
  const slot = ensureActionBar()?.querySelector(".um-actions-build");
  if (!slot) return;
  slot.innerHTML = "";
  if (!builder) return;

  const dice = document.createElement("span");
  dice.className = "tm-build-dice";
  const reds = builderReds();
  for (let i = 0; i < Math.min(12, reds); i += 1) {
    const d = document.createElement("span");
    d.className = "tm-build-die";
    dice.appendChild(d);
  }
  slot.appendChild(dice);

  const undoBtn = button("Undo", "");
  undoBtn.disabled = !builder.waypoints.length;
  undoBtn.addEventListener("click", builderUndo);
  slot.appendChild(undoBtn);

  const restartBtn = button("Restart", "");
  restartBtn.disabled = !builder.waypoints.length;
  restartBtn.addEventListener("click", builderRestart);
  slot.appendChild(restartBtn);
  // Go lives on the board itself, floating past the route arrow.
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

  // Use the glowing location the car is parked at. Duplicate mode splits the
  // click: the big circle visits (places a token), anywhere else on the
  // building completes a matching ride — one or the other, never both. Other
  // modes: any click on the location places.
  const locEl = event.target.closest?.(".um-loc-can, .um-loc-complete");
  if (locEl) {
    const bid = Number(locEl.getAttribute("data-bldg"));
    if (isDuplicateMode()) {
      const onCircle = !!event.target.closest?.(".um-slot, .um-upgrade-sq");
      if (onCircle && placeableBids().includes(bid)) {
        socket.emit("uber_mania_place_token", { roomId: app.roomId, truckId: activeTruckId(), bid });
      } else if (!onCircle && completableBid() === bid) {
        socket.emit("uber_mania_complete_ride", { roomId: app.roomId, truckId: activeTruckId() });
      }
      return;
    }
    if (placeableBids().includes(bid)) {
      socket.emit("uber_mania_place_token", { roomId: app.roomId, truckId: activeTruckId(), bid });
    }
    return;
  }

  // Build mode (and every off-board entry): clicks grow the path.
  if (moveMode === "build" || builder?.entry) {
    if (!builder || turnActed) return;
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

  // Commit a previewed route.
  const routeEl = event.target.closest?.(".tm-route-hit");
  if (routeEl) {
    commitRoute(Number(routeEl.dataset.route));
    return;
  }

  if (turnActed) {
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
// Scoreboard + player panel
// ---------------------------------------------------------------------------

function renderScoreboard() {
  const header = document.querySelector(".game-header");
  header?.querySelector(".tm-scoreboard")?.remove();
  if (!header || !playersState.length) return;
  const bar = document.createElement("div");
  bar.className = "tm-scoreboard";
  playersState.forEach((p, i) => {
    const chip = document.createElement("div");
    chip.className = "tm-score";
    chip.dataset.player = i;
    chip.style.setProperty("--pcolor", p.color);
    if (winnerState === i) chip.classList.add("tm-score-winner");
    if (winnerState == null && turnWhose === i) chip.classList.add("tm-score-turn");
    const dot = document.createElement("span");
    dot.className = "tm-score-dot";
    dot.style.background = p.color;
    const val = document.createElement("span");
    val.className = "tm-score-val";
    val.textContent = String(p.tokens ?? 0);
    val.title = "Tokens in hand";
    chip.append(dot, val);
    if ((p.ridesCompleted ?? 0) > 0 || (p.rides?.length ?? 0) > 0) {
      const rd = document.createElement("span");
      rd.className = "tm-score-tickets";
      rd.textContent = `🚕${p.ridesCompleted ?? 0}`;
      rd.title = "Rides completed";
      chip.appendChild(rd);
    }
    if (Array.isArray(p.upgrades) && p.upgrades.length) {
      const up = document.createElement("span");
      up.className = "tm-score-tickets";
      up.textContent = `⬛${p.upgrades.length}`;
      up.title = `Upgrades: ${p.upgrades.map((t) => upgradeMeta(t).name).join(", ")}`;
      chip.appendChild(up);
    }
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
  header.appendChild(bar);
}

// Bottom-right panel: my tokens, time stones, and open ride cards.
function renderPlayerPanel() {
  els.gameBoard.querySelector(".um-panel")?.remove();
  const me = myPlayer();
  if (!me) return;

  const wrap = document.createElement("div");
  wrap.className = "um-panel";

  const stats = document.createElement("div");
  stats.className = "um-panel-stats";

  const tokens = document.createElement("div");
  tokens.className = "um-stat";
  const tokDot = document.createElement("span");
  tokDot.className = "um-token-dot";
  tokDot.style.background = me.color;
  const tokVal = document.createElement("span");
  tokVal.className = "um-stat-val";
  tokVal.textContent = `×${me.tokens ?? 0}`;
  tokens.append(tokDot, tokVal);
  tokens.title = "Tokens — placed on locations, paid on failed stress dice";
  stats.appendChild(tokens);

  const stones = document.createElement("div");
  stones.className = "um-stat um-stat-stones";
  stones.textContent = `⬟ ×${me.timeStones ?? 0}`;
  stones.title = "Time stones — one per hour of moving the clock";
  stats.appendChild(stones);

  const stress = document.createElement("div");
  stress.className = "um-stat";
  stress.textContent = `😰 1–${Math.max(1, Math.min(5, me.stress ?? 3))} safe`;
  stress.title = "Stress — end-of-turn dice at or under this are fine, over it costs a token";
  stats.appendChild(stress);

  const redLost = document.createElement("div");
  redLost.className = "um-stat um-stat-red";
  redLost.textContent = `🚦 −${me.redTokensLost ?? 0}`;
  redLost.title = "Tokens lost to red-light dice so far — the player who loses the most is docked points at game end, the least gains them";
  stats.appendChild(redLost);

  wrap.appendChild(stats);

  // My upgrade board: four slots. Held upgrades fill from the left; the
  // third slot unlocks with a token in every neighbourhood, the fourth with
  // two in every neighbourhood. Filling all four banks the race points
  // (7 for the first player, then 5, 3, 1).
  {
    const row = document.createElement("div");
    row.className = "um-upgrades-row";
    const cap = myUpgradeCap();
    for (let i = 0; i < 4; i += 1) {
      const t = me.upgrades?.[i];
      if (t) {
        const meta = upgradeMeta(t);
        const chip = document.createElement("span");
        chip.className = "um-upgrade-chip";
        chip.textContent = `${meta.icon} ${meta.name}`;
        chip.title = meta.desc;
        if (meta.color) chip.style.borderColor = meta.color;
        row.appendChild(chip);
      } else {
        const slot = document.createElement("span");
        const locked = i >= cap;
        slot.className = `um-upgrade-chip um-upgrade-slot${locked ? " um-upgrade-locked" : ""}`;
        slot.textContent = locked ? "🔒" : "···";
        slot.title = locked
          ? (i === 2
            ? "Locked — place a token in every neighbourhood to unlock this upgrade slot"
            : "Locked — place tokens in two locations of every neighbourhood to unlock this upgrade slot")
          : "An open upgrade slot — fill all four for bonus points (first to do it: 7, then 5, 3, 1)";
        row.appendChild(slot);
      }
    }
    const deck = document.createElement("span");
    deck.className = "um-upgrade-deck";
    deck.textContent = `🂠×${upgradeDeckCountState}`;
    deck.title = isScheduledUpgrades()
      ? "Upgrades still waiting on the board — each opens only during its location's 4-hour window, and none come back"
      : "Upgrades left in the supply — every type has two copies (neighbourhood locals one) and none come back";
    row.appendChild(deck);
    wrap.appendChild(row);
  }

  // Open ride cards: painted the destination's neighbourhood color, with the
  // place name up top and its landmark emoji big in the middle. Hovering
  // lights the destination up on the board.
  if (me.rides?.length) {
    const row = document.createElement("div");
    row.className = "um-rides";
    me.rides.forEach((r) => {
      if (r.faceDown) {
        // Drawn this turn: a card back — the destination stays hidden (and
        // the card inert) until the turn ends and it flips up.
        const card = document.createElement("div");
        card.className = "um-ride-card um-ride-facedown";
        const name = document.createElement("div");
        name.className = "um-ride-name";
        name.textContent = "New ride";
        const emoji = document.createElement("div");
        emoji.className = "um-ride-emoji";
        emoji.textContent = "❓";
        card.append(name, emoji);
        card.title = "Flips face up when your turn ends";
        row.appendChild(card);
        return;
      }
      const b = buildingByBid(r.loc);
      const hood = hoodsState.find((h) => h.id === b?.hood);
      const card = document.createElement("div");
      card.className = "um-ride-card";
      if (hood) {
        // Same treatment as the buildings: light tint inside, full color border.
        card.style.setProperty("--hood", lighten(hood.color));
        card.style.setProperty("--hood-dark", hood.color);
      }
      const name = document.createElement("div");
      name.className = "um-ride-name";
      name.textContent = b?.name ?? "?";
      const emoji = document.createElement("div");
      emoji.className = "um-ride-emoji";
      // Duplicate-mode destinations are circle locations: show their payout
      // symbol in place of a landmark emoji.
      emoji.textContent = b?.emoji ?? SLOT_SYMBOLS[b?.locType] ?? "🚕";
      card.append(name, emoji);
      card.title = `Drive to ${b?.name ?? "this location"} to complete the ride`;
      card.addEventListener("mouseenter", () => {
        els.gameBoard.querySelector(`.tm-building[data-bldg="${r.loc}"]`)?.classList.add("um-ride-hover");
      });
      card.addEventListener("mouseleave", () => {
        els.gameBoard.querySelector(`.tm-building[data-bldg="${r.loc}"]`)?.classList.remove("um-ride-hover");
      });
      row.appendChild(card);
    });
    wrap.appendChild(row);
  }

  els.gameBoard.appendChild(wrap);
}

// ---------------------------------------------------------------------------
// Dice
// ---------------------------------------------------------------------------

const DIE_PIPS = {
  1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8]
};

function makeDieEl(d, settled, threshold) {
  const die = document.createElement("div");
  if (!settled) die.className = "tm-die tm-die-rolling";
  else die.className = `tm-die ${d > threshold ? "tm-die-ticket" : "tm-die-safe"}`;
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
  } else if (roll.tickets > 0) {
    head.textContent = `${who}: too stressed! −${roll.loss ?? roll.tickets} token${(roll.loss ?? roll.tickets) === 1 ? "" : "s"}`;
    head.classList.add("tm-dice-bad");
  } else {
    head.textContent = `${who}: stress held`;
    head.classList.add("tm-dice-good");
  }
}

function setDiceFaces(row, roll, faces, settled) {
  row.innerHTML = "";
  faces.forEach((d) => row.appendChild(makeDieEl(d, settled, roll.aversion)));
}

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

function renderDice() {
  if (diceAnimating) return;
  const roll = lastRollState;
  if (!roll || !roll.dice?.length) {
    els.gameBoard.querySelector(".tm-dice")?.remove();
    return;
  }
  renderDicePanel(roll, roll.dice, true);
}

function animateDiceRoll(roll, onDone) {
  const n = roll.dice.length;
  const rnd = () => Array.from({ length: n }, () => 1 + Math.floor(Math.random() * 6));
  renderDicePanel(roll, rnd(), false, true);
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

function flashLoss(roll) {
  const amount = `−${roll.loss ?? roll.tickets} ●`;
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

// ---------------------------------------------------------------------------
// Controls + tuning
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
  return isMyTurn() && dicePoolState > 0 ? `End turn · 🎲×${dicePoolState}` : "End turn";
}

// Welfare: skip the turn — before doing anything with it — for a token and
// some time stones.
function canSkipTurn() {
  return isMyTurn() && winnerState == null && turnTruck == null && !turnActed &&
    dicePoolState === 0;
}

function skipTurnLabel() {
  const s = settingsState;
  return `Welfare · +${s?.welfareTokens ?? 1}● +${s?.welfareStones ?? 2}⬟`;
}

function skipTurnButton() {
  const btn = button(skipTurnLabel(), "skipturn", "ghost-btn um-skip-turn");
  btn.title = "Sit this turn out and collect welfare: tokens and time stones";
  btn.style.display = canSkipTurn() ? "" : "none";
  btn.disabled = diceAnimating || anyCarAnimating() || flipping;
  return btn;
}

// Sleep: only at night (7pm–6am), and — like welfare — only in place of the
// whole turn: no movement, no location. Stress drops all the way down and
// the clock can sweep forward up to 4 hours for free.
function canSleep() {
  return isMyTurn() && winnerState == null && turnTruck == null && !turnActed &&
    dicePoolState === 0 && (timeState >= 19 || timeState <= 6);
}

function sleepButton() {
  const wrap = document.createElement("span");
  wrap.className = "um-sleep-wrap";
  const btn = button(`😴 Sleep · calm to ${hasUpgrade("superCalm") ? "1–2" : "2–3"}`, "", "ghost-btn um-sleep");
  btn.title = "Sit the turn out to sleep (night only): stress drops all the way down, and the clock can sweep forward for free";
  const sel = document.createElement("select");
  sel.className = "um-sleep-hours";
  for (let h = 0; h <= 4; h += 1) {
    const opt = document.createElement("option");
    opt.value = String(h);
    opt.textContent = `+${h}h`;
    sel.appendChild(opt);
  }
  sel.title = "Hours to sweep the clock forward for free while sleeping";
  btn.addEventListener("click", () => {
    if (btn.disabled || !app.roomId) return;
    const hours = Number(sel.value) || 0;
    withHoodChoices((hoodChoices) =>
      socket.emit("uber_mania_sleep", { roomId: app.roomId, hours, hoodChoices }));
  });
  wrap.append(btn, sel);
  wrap.style.display = canSleep() ? "" : "none";
  return wrap;
}

// How many neighbourhood bonuses ending the turn here would pay: my
// "hood:<id>" upgrades matching the hood my car is parked in.
function myHoodBonusCount() {
  const car = myCar();
  if (!car || car.spot == null) return 0;
  const b = buildingByBid(mapState?.spots?.[car.spot]?.building);
  if (!b || b.hood == null) return 0;
  return myUpgrades().filter((t) => hoodIdOf(t) === b.hood).length;
}

// Every way a turn can end (End turn, welfare, sleep) runs through here: when
// neighbourhood bonuses are due, a small chooser collects one reward pick per
// matching upgrade before the ending is sent; otherwise it sends right away.
function withHoodChoices(send) {
  const count = myHoodBonusCount();
  if (count < 1) {
    send([]);
    return;
  }
  els.gameBoard.querySelector(".um-hood-choice")?.remove();
  const picks = [];
  const overlay = document.createElement("div");
  overlay.className = "um-hood-choice";
  const panel = document.createElement("div");
  panel.className = "um-hood-choice-panel";
  const title = document.createElement("div");
  title.className = "um-hood-choice-title";
  const setTitle = () => {
    title.textContent = count > 1
      ? `🏘️ Neighbourhood bonus ${picks.length + 1}/${count} — choose your reward`
      : "🏘️ Neighbourhood bonus — choose your reward";
  };
  setTitle();
  panel.appendChild(title);
  const row = document.createElement("div");
  row.className = "um-hood-choice-row";
  [["token", "💰 1 token"], ["destress", "🍵 1 destress"], ["stones", "⬟ 2 time stones"]].forEach(([value, label]) => {
    const btn = button(label, "", "ghost-btn");
    btn.addEventListener("click", () => {
      picks.push(value);
      if (picks.length >= count) {
        overlay.remove();
        send(picks);
      } else {
        setTitle();
      }
    });
    row.appendChild(btn);
  });
  panel.appendChild(row);
  const cancel = button("Cancel", "", "ghost-btn um-hood-cancel");
  cancel.addEventListener("click", () => overlay.remove());
  panel.appendChild(cancel);
  overlay.appendChild(panel);
  els.gameBoard.appendChild(overlay);
}

// The fun die: a turn that banked no stress dice (and wasn't sat out) ends
// on this instead — a floating banner that tumbles through the three faces
// (same beat as the stress-dice roll) before settling on what it paid.
const FUN_FACE_TEXT = {
  token: "+1 token 💰",
  destress: "−1 stress 🍵",
  stones: "+2 time stones ⬟"
};
const FUN_FACES = ["token", "destress", "stones"];
const FUN_FACE_ICONS = { token: "💰", destress: "🍵", stones: "⬟" };

// The fun die rolls like the stress dice, in the same spot: a grown panel on
// the right where one die shakes through the three faces until it lands.
function showFunRoll(roll) {
  document.querySelector(".um-fun-dice")?.remove();
  const wrap = document.createElement("div");
  wrap.className = "um-fun-dice";
  wrap.style.borderColor = playersState[roll.player]?.color ?? "rgba(255, 255, 255, 0.14)";
  const who = seatName(roll.player);
  const head = document.createElement("div");
  head.className = "tm-dice-head";
  head.textContent = `${who} rolling the fun die…`;
  const row = document.createElement("div");
  row.className = "tm-dice-row";
  const die = document.createElement("div");
  die.className = "tm-die um-fun-die tm-die-rolling";
  let i = Math.floor(Math.random() * FUN_FACES.length);
  die.textContent = FUN_FACE_ICONS[FUN_FACES[i]];
  row.appendChild(die);
  wrap.append(head, row);
  els.gameBoard.appendChild(wrap);
  let elapsed = 0;
  const iv = setInterval(() => {
    if (!wrap.isConnected) {
      clearInterval(iv);
      return;
    }
    elapsed += 90;
    if (elapsed < 1300 / speedMult) {
      i = (i + 1) % FUN_FACES.length;
      die.textContent = FUN_FACE_ICONS[FUN_FACES[i]];
    } else {
      clearInterval(iv);
      die.textContent = FUN_FACE_ICONS[roll.face] ?? "🎲";
      die.classList.remove("tm-die-rolling");
      die.classList.add("tm-die-safe");
      head.textContent = `${who}: ${FUN_FACE_TEXT[roll.face] ?? roll.face}`;
      head.classList.add("tm-dice-good");
      wrap.classList.add("um-fun-done");
      setTimeout(() => wrap.remove(), 1800 / speedMult);
    }
  }, 90);
}

// Keep going: after movement has ended, take on one stress level to reopen
// movement (and another time change). Barred at max stress or after a
// destress location this turn (destressing forces the turn to end).
function canKeepGoing() {
  return isMyTurn() && winnerState == null && turnActed && !turnDestressed &&
    (myPlayer()?.stress ?? 3) > 1;
}

function keepGoingButton() {
  const btn = button("Keep going · +stress 😰", "", "ghost-btn um-keep-going");
  btn.title = "Take on one stress level (one fewer safe die number) to keep moving — and change time again — this turn";
  btn.style.display = canKeepGoing() ? "" : "none";
  btn.disabled = diceAnimating || anyCarAnimating() || flipping;
  btn.addEventListener("click", () => {
    if (!btn.disabled && app.roomId) socket.emit("uber_mania_keep_going", { roomId: app.roomId });
  });
  return btn;
}

function canUndoTurn() {
  return isMyTurn() && winnerState == null && !!turnUndo;
}

function undoTurnLabel() {
  return turnUndo?.kind === "time" ? "↩ Undo time" : "↩ Undo move";
}


// The bottom-right action bar, sitting next to Leave Game in the shared game
// footer: the route builder's Undo / Restart / Go, the one-step turn undo,
// and End turn — the buttons a turn actually runs on, kept small.
function ensureActionBar() {
  const footer = document.querySelector(".game-footer");
  if (!footer) return null;
  let bar = footer.querySelector(".um-actions");
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "um-actions";

    const buildSlot = document.createElement("span");
    buildSlot.className = "um-actions-build";
    bar.appendChild(buildSlot);

    const undoBtn = button(undoTurnLabel(), "", "ghost-btn tm-undo-turn");
    undoBtn.addEventListener("click", () => {
      if (!undoBtn.disabled && app.roomId) socket.emit("uber_mania_undo", { roomId: app.roomId });
    });
    bar.appendChild(undoBtn);

    bar.appendChild(keepGoingButton());

    const endBtn = button(endTurnLabel(), "", "primary-btn tm-end-turn");
    endBtn.addEventListener("click", () => {
      if (endBtn.disabled || !app.roomId) return;
      // Neighbourhood bonuses are chosen before the turn actually ends.
      withHoodChoices((hoodChoices) =>
        socket.emit("uber_mania_end_turn", { roomId: app.roomId, hoodChoices }));
    });
    bar.appendChild(endBtn);

    footer.insertBefore(bar, footer.firstChild);
  }
  return bar;
}

function removeActionBar() {
  document.querySelector(".game-footer .um-actions")?.remove();
}

// The settings bar (bottom left): compact by default, collapsible to a ⚙.
// The contextual Welfare / Keep going offers stay visible either way.
function renderControls() {
  els.hand.innerHTML = "";
  els.hand.classList.remove("player-0", "player-1", "toy-rack", "flip-score", "tm-controls-min");
  els.hand.classList.add("tm-controls", "um-controls");
  els.hand.classList.toggle("um-controls-min", controlsMin);

  if (controlsMin) {
    const openBtn = button("⚙", "togglebar");
    openBtn.title = "Show settings";
    els.hand.appendChild(openBtn);
    els.hand.appendChild(skipTurnButton());
    els.hand.appendChild(sleepButton());
    ensureActionBar();
    updateTurnControls();
    renderTuning();
    return;
  }

  const minBtn = button("⌄", "togglebar");
  minBtn.title = "Minimize settings";
  els.hand.appendChild(minBtn);

  els.hand.appendChild(button("New map", "regen"));
  els.hand.appendChild(button("Mix up", "mixup"));

  // Blank stoplights on top of the guaranteed 24 numbered ones. Picking a new
  // count regenerates the map with exactly that many lights (corners carry
  // none), so this re-deals the board.
  const lightsWrap = document.createElement("span");
  lightsWrap.className = "um-lights-wrap";
  lightsWrap.title = "Extra blank stoplights beyond the 24 numbered — changing re-deals the board";
  const lightInput = (key, symbol) => {
    const lab = document.createElement("label");
    lab.className = "um-light";
    lab.textContent = symbol;
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.max = "30";
    input.className = "um-light-input";
    input.value = String(settingsState?.blankLights?.[key] ?? 6);
    input.addEventListener("change", () => {
      if (!app.roomId || !settingsState) return;
      const next = JSON.parse(JSON.stringify(settingsState));
      (next.blankLights ??= {})[key] = Number(input.value);
      socket.emit("uber_mania_tune", { roomId: app.roomId, settings: next });
    });
    lab.appendChild(input);
    return lab;
  };
  lightsWrap.append(lightInput("green", "🟢"), lightInput("red", "🔴"));
  els.hand.appendChild(lightsWrap);

  const modeBtn = button(moveMode === "build" ? "Route: build" : "Route: auto", "routemode");
  if (moveMode === "build") modeBtn.classList.add("tm-active");
  els.hand.appendChild(modeBtn);

  const tuneBtn = button("Tuning", "tuning");
  if (tuneDraft) tuneBtn.classList.add("tm-active");
  els.hand.appendChild(tuneBtn);

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
    if (app.roomId) socket.emit("uber_mania_set_speed", { roomId: app.roomId, speed: Number(dial.value) });
  });
  speedWrap.append(dial, dialVal);
  els.hand.appendChild(speedWrap);

  // Building size — visual only: 100% packs the lots wall to wall (as
  // generated), lower shrinks them around their centers for more open
  // ground. Never sent to the server, so it's safe to slide mid-game.
  const sizeWrap = document.createElement("label");
  sizeWrap.className = "tm-speed-wrap um-bsize-wrap";
  sizeWrap.textContent = "Lots";
  sizeWrap.title = "Building size (visual only) — slide any time, the game doesn't notice";
  const size = document.createElement("input");
  size.type = "range";
  size.min = "55";
  size.max = "100";
  size.step = "5";
  size.value = String(Math.round(buildingScale * 100));
  size.className = "tm-speed um-bsize";
  const sizeVal = document.createElement("span");
  sizeVal.className = "tm-speed-val";
  sizeVal.textContent = `${Math.round(buildingScale * 100)}%`;
  size.addEventListener("input", () => {
    buildingScale = Number(size.value) / 100;
    sizeVal.textContent = `${size.value}%`;
    localStorage.setItem("umBuildingScale", String(buildingScale));
    applyBuildingScale();
  });
  sizeWrap.append(size, sizeVal);
  els.hand.appendChild(sizeWrap);

  // AI opponents (0 up to the free seats). Re-deals the board when changed.
  const aiWrap = document.createElement("label");
  aiWrap.className = "tm-ai-wrap";
  aiWrap.textContent = "AI";
  const aiSelect = document.createElement("select");
  aiSelect.className = "tm-ai-select";
  const currentAi = playersState.filter((p) => p.isAI).length;
  for (let n = 0; n <= maxAiState; n += 1) {
    const opt = document.createElement("option");
    opt.value = String(n);
    opt.textContent = String(n);
    if (n === currentAi) opt.selected = true;
    aiSelect.appendChild(opt);
  }
  aiSelect.addEventListener("change", () => {
    if (!app.roomId) return;
    socket.emit("uber_mania_set_opponents", { roomId: app.roomId, count: Number(aiSelect.value) });
  });
  aiWrap.appendChild(aiSelect);
  els.hand.appendChild(aiWrap);

  els.hand.appendChild(skipTurnButton());
  els.hand.appendChild(sleepButton());

  ensureActionBar();
  updateTurnControls();
  renderTuning();
}

function updateTurnControls() {
  const bar = document.querySelector(".game-footer .um-actions");
  const btn = bar?.querySelector(".tm-end-turn");
  if (btn) {
    btn.disabled = !isMyTurn() || winnerState != null || diceAnimating || anyCarAnimating() || flipping;
    btn.textContent = endTurnLabel();
  }
  const ub = bar?.querySelector(".tm-undo-turn");
  if (ub) {
    ub.style.display = canUndoTurn() ? "" : "none";
    ub.disabled = diceAnimating || anyCarAnimating() || flipping;
    ub.textContent = undoTurnLabel();
  }
  const kg = bar?.querySelector(".um-keep-going");
  if (kg) {
    kg.style.display = canKeepGoing() ? "" : "none";
    kg.disabled = diceAnimating || anyCarAnimating() || flipping;
  }
  const sk = els.hand.querySelector(".um-skip-turn");
  if (sk) {
    sk.style.display = canSkipTurn() ? "" : "none";
    sk.disabled = diceAnimating || anyCarAnimating() || flipping;
    sk.textContent = skipTurnLabel();
  }
  const sw = els.hand.querySelector(".um-sleep-wrap");
  if (sw) {
    sw.style.display = canSleep() ? "" : "none";
    const sb = sw.querySelector(".um-sleep");
    if (sb) {
      sb.disabled = diceAnimating || anyCarAnimating() || flipping;
      sb.textContent = `😴 Sleep · calm to ${hasUpgrade("superCalm") ? "1–2" : "2–3"}`;
    }
  }
}

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

// The end-of-game chart: every player's scoring breakdown, shown to everyone
// once the days run out (after the final dice roll settles).
function renderResults() {
  els.gameBoard.querySelector(".um-results")?.remove();
  if (!resultsState || winnerState == null || resultsDismissed || diceAnimating) return;

  const overlay = document.createElement("div");
  overlay.className = "um-results";
  const panel = document.createElement("div");
  panel.className = "um-results-panel";

  const winners = resultsState.winners ?? [];
  const title = document.createElement("div");
  title.className = "um-results-title";
  title.textContent = winners.length > 1
    ? `It's a tie — ${winners.map((i) => seatName(i)).join(" & ")}!`
    : winners.includes(myIndex())
    ? "🏆 You win!"
    : `🏆 ${seatName(winners[0] ?? 0)} wins!`;
  panel.appendChild(title);

  const sub = document.createElement("div");
  sub.className = "um-results-sub";
  sub.textContent = `The ${settingsState?.days ?? 3} days are over`;
  panel.appendChild(sub);

  const table = document.createElement("table");
  table.className = "um-results-table";
  const head = document.createElement("tr");
  ["", "Rides", "Upgrades", "🚦 Tokens lost", "Total"].forEach((h) => {
    const th = document.createElement("th");
    th.textContent = h;
    head.appendChild(th);
  });
  table.appendChild(head);

  (resultsState.perPlayer ?? []).forEach((r, i) => {
    const p = playersState[i];
    const tr = document.createElement("tr");
    if (winners.includes(i)) tr.classList.add("um-results-winner");

    const name = document.createElement("td");
    name.className = "um-results-name";
    const dot = document.createElement("span");
    dot.className = "um-token-dot";
    dot.style.background = p?.color ?? "#888";
    const nm = document.createElement("span");
    nm.textContent = seatName(i);
    name.append(dot, nm);
    tr.appendChild(name);

    const rides = document.createElement("td");
    rides.innerHTML = `${r.rides} <span class="um-results-pts">+${r.ridePts}</span>`;
    tr.appendChild(rides);

    const ups = document.createElement("td");
    ups.innerHTML = `${r.upgrades ?? 0} <span class="um-results-pts">+${r.upgradePts ?? 0}</span>`;
    tr.appendChild(ups);

    const red = document.createElement("td");
    const adj = r.redAdj > 0 ? `+${r.redAdj}` : String(r.redAdj);
    red.innerHTML = `${r.redLost} <span class="um-results-pts ${r.redAdj < 0 ? "um-results-neg" : r.redAdj > 0 ? "um-results-pos" : ""}">${r.redAdj === 0 ? "±0" : adj}</span>`;
    tr.appendChild(red);

    const total = document.createElement("td");
    total.className = "um-results-total";
    total.textContent = String(r.total);
    tr.appendChild(total);

    table.appendChild(tr);
  });
  panel.appendChild(table);

  const hint = document.createElement("div");
  hint.className = "um-results-hint";
  const s = settingsState;
  hint.textContent = `Points: ${s?.ridePoints ?? 2} per ride · 7/5/3/1 for filling all four upgrade slots (in finishing order) · ±${s?.redPenalty ?? 3} for least/most tokens lost to red lights`;
  panel.appendChild(hint);

  const actions = document.createElement("div");
  actions.className = "um-results-actions";
  const closeBtn = button("Close", "", "ghost-btn");
  closeBtn.addEventListener("click", () => {
    resultsDismissed = true;
    overlay.remove();
  });
  const againBtn = button("New game", "", "primary-btn");
  againBtn.addEventListener("click", () => {
    resultsDismissed = false;
    socket.emit("uber_mania_regenerate", { roomId: app.roomId });
  });
  actions.append(closeBtn, againBtn);
  panel.appendChild(actions);

  overlay.appendChild(panel);
  els.gameBoard.appendChild(overlay);
}

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

// The tuning drop-up: the room's numbers, applied with a re-deal.
const TUNE_FIELDS = [
  ["timeStoneReward", "Time stone reward"],
  ["tokenReward", "Token reward"],
  ["startingTokens", "Starting tokens"],
  ["startingTimeStones", "Starting time stones"],
  ["startingStress", "Starting stress (1–5)"],
  ["tokensPerFail", "Tokens per failed die"],
  ["neighbourhoods", "Neighbourhoods"],
  ["days", "Days until game end"],
  ["ridePoints", "Points per ride"],
  ["redPenalty", "Red-light swing (±)"],
  ["welfareTokens", "Welfare tokens"],
  ["welfareStones", "Welfare time stones"]
];
const TUNE_LOC_FIELDS = [
  ["timestone", "⏳ Time stone locations"],
  ["token", "💰 Token locations"],
  ["destress", "🍵 Destress locations"],
  ["upgrade", "⬛ Upgrade locations"],
  ["uber", "🚕 Uber pickups"]
];
// Blank stoplights beyond the guaranteed 24 numbered (corners carry none).
const TUNE_LIGHT_FIELDS = [
  ["green", "🟢 Green blank lights"],
  ["red", "🔴 Red blank lights"]
];

function openTuning() {
  if (!settingsState) return;
  tuneDraft = JSON.parse(JSON.stringify(settingsState));
  tuneName = "";
  if (!tuningsRequested) {
    tuningsRequested = true;
    socket.emit("uber_mania_list_settings");
  }
  renderControls();
}

function closeTuning() {
  tuneDraft = null;
  els.gameBoard.querySelector(".um-tune")?.remove();
}

// The saved-tunings list inside the panel: apply, rename (type, then hit the
// green ✓), and a two-click delete.
function buildTuningList() {
  const list = document.createElement("div");
  list.className = "um-tune-saved";
  savedTunings.forEach((item) => {
    const row = document.createElement("div");
    row.className = "um-tune-saved-row";

    const name = document.createElement("input");
    name.type = "text";
    name.className = "um-tune-name";
    name.maxLength = 40;
    name.value = item.name;
    name.readOnly = !canSaveTunings;
    name.title = canSaveTunings ? "Type to rename, then hit the green ✓" : item.name;

    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "tm-btn um-tune-ok";
    ok.textContent = "✓";
    ok.title = "Save the new name";
    ok.style.display = "none";
    name.addEventListener("input", () => {
      const dirty = canSaveTunings && name.value.trim() && name.value.trim() !== item.name;
      ok.style.display = dirty ? "" : "none";
    });
    name.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && ok.style.display !== "none") ok.click();
    });
    ok.addEventListener("click", () => {
      socket.emit("uber_mania_rename_settings", { roomId: app.roomId, settingsId: item.id, name: name.value.trim() });
    });

    const apply = document.createElement("button");
    apply.type = "button";
    apply.className = "ghost-btn tm-btn";
    apply.textContent = "Apply";
    apply.title = "Apply this tuning (re-deals the board)";
    apply.addEventListener("click", () => {
      socket.emit("uber_mania_load_settings", { roomId: app.roomId, settingsId: item.id });
      closeTuning();
      renderControls();
    });

    row.append(name, ok, apply);

    if (canSaveTunings) {
      const del = document.createElement("button");
      del.type = "button";
      del.className = "ghost-btn tm-btn um-tune-del";
      del.textContent = "🗑";
      del.title = `Delete “${item.name}”`;
      del.addEventListener("click", () => {
        if (del.dataset.armed) {
          socket.emit("uber_mania_delete_settings", { roomId: app.roomId, settingsId: item.id });
          return;
        }
        del.dataset.armed = "1";
        del.textContent = "Sure?";
        setTimeout(() => {
          delete del.dataset.armed;
          del.textContent = "🗑";
        }, 2500);
      });
      row.appendChild(del);
    }
    list.appendChild(row);
  });
  return list;
}

function renderTuning() {
  els.gameBoard.querySelector(".um-tune")?.remove();
  if (!tuneDraft) return;
  const panel = document.createElement("div");
  panel.className = "um-tune";

  const title = document.createElement("div");
  title.className = "um-tune-title";
  title.textContent = "Uber Mania tuning — applying re-deals the board";
  panel.appendChild(title);

  if (savedTunings.length) panel.appendChild(buildTuningList());

  const grid = document.createElement("div");
  grid.className = "um-tune-grid";
  // Ride mode: ride-2 (start with two cards, completions replaced) or
  // ride-pickup (the original rule — any uber pickup deals a card).
  const modeLab = document.createElement("label");
  modeLab.className = "um-tune-row";
  const modeSpan = document.createElement("span");
  modeSpan.textContent = "🚕 Ride mode";
  const modeSel = document.createElement("select");
  modeSel.className = "um-tune-input";
  [["ride-2", "Ride 2"], ["ride-pickup", "Ride pickup"], ["duplicate", "Duplicate"]].forEach(([value, label]) => {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    modeSel.appendChild(opt);
  });
  modeSel.value = ["ride-pickup", "duplicate"].includes(tuneDraft.rideMode) ? tuneDraft.rideMode : "ride-2";
  // A mode switch re-renders the panel: the uber row greys in duplicate.
  modeSel.addEventListener("change", () => {
    tuneDraft.rideMode = modeSel.value;
    renderTuning();
  });
  modeLab.append(modeSpan, modeSel);
  grid.appendChild(modeLab);

  // Upgrade mode: spawn (the one roaming upgrade, respawning when taken) or
  // scheduled (every upgrade location dealt one up front, each behind its
  // own 4-hour window, no respawns).
  const upLab = document.createElement("label");
  upLab.className = "um-tune-row";
  const upSpan = document.createElement("span");
  upSpan.textContent = "⬛ Upgrade mode";
  const upSel = document.createElement("select");
  upSel.className = "um-tune-input";
  [["spawn", "Spawn"], ["scheduled", "Scheduled"]].forEach(([value, label]) => {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    upSel.appendChild(opt);
  });
  upSel.value = tuneDraft.upgradeMode === "scheduled" ? "scheduled" : "spawn";
  upSel.title = "Spawn: one roaming upgrade, a random new one appears when it's taken. Scheduled: every upgrade location shows one from the start, each only usable during its own 4-hour window";
  upSel.addEventListener("change", () => { tuneDraft.upgradeMode = upSel.value; });
  upLab.append(upSpan, upSel);
  grid.appendChild(upLab);

  // Timed locations: off, or the three visiting periods.
  const timedLab = document.createElement("label");
  timedLab.className = "um-tune-row";
  const timedSpan = document.createElement("span");
  timedSpan.textContent = "🌅 Timed locations";
  const timedSel = document.createElement("select");
  timedSel.className = "um-tune-input";
  [["0", "None"], ["2", "Day, Night"], ["3", "Morning, Afternoon, Night"]].forEach(([value, label]) => {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    timedSel.appendChild(opt);
  });
  timedSel.value = [2, 3].includes(Number(tuneDraft.timedPeriods)) ? String(tuneDraft.timedPeriods) : "0";
  // A scheme switch re-renders the panel: the day/night counts below only
  // come alive under Day, Night.
  timedSel.addEventListener("change", () => {
    tuneDraft.timedPeriods = Number(timedSel.value);
    renderTuning();
  });
  timedLab.append(timedSpan, timedSel);
  grid.appendChild(timedLab);

  const addField = (label, value, onInput, disabled = false) => {
    const lab = document.createElement("label");
    lab.className = disabled ? "um-tune-row um-tune-off" : "um-tune-row";
    const span = document.createElement("span");
    span.textContent = label;
    const input = document.createElement("input");
    input.type = "number";
    input.className = "um-tune-input";
    input.value = String(value);
    input.disabled = disabled;
    input.addEventListener("input", () => onInput(input.value));
    lab.append(span, input);
    grid.appendChild(lab);
  };
  // Day / Night location counts — only alive under the Day, Night scheme.
  // Leftover circle locations become neither: open at any hour.
  const dayNight = Number(tuneDraft.timedPeriods) === 2;
  addField("☀️ Day locations", tuneDraft.dayLocations ?? 11, (v) => {
    tuneDraft.dayLocations = Number(v);
  }, !dayNight);
  addField("🌙 Night locations", tuneDraft.nightLocations ?? 11, (v) => {
    tuneDraft.nightLocations = Number(v);
  }, !dayNight);
  // In duplicate mode every location is a ride location, so the uber pickup
  // row goes grey — the count isn't dealt.
  const dupDraft = tuneDraft.rideMode === "duplicate";
  const totalEl = document.createElement("span");
  const locTotal = () => TUNE_LOC_FIELDS.reduce((n, [key]) =>
    n + (dupDraft && key === "uber" ? 0 : Number(tuneDraft.locations?.[key]) || 0), 0);
  const updateTotal = () => { totalEl.textContent = String(locTotal()); };
  TUNE_LOC_FIELDS.forEach(([key, label]) => {
    addField(label, tuneDraft.locations?.[key] ?? 0, (v) => {
      (tuneDraft.locations ??= {})[key] = Number(v);
      updateTotal();
    }, dupDraft && key === "uber");
  });
  // The running total of locations that will actually be dealt.
  const totalLab = document.createElement("div");
  totalLab.className = "um-tune-row um-tune-total";
  const totalSpan = document.createElement("span");
  totalSpan.textContent = "Σ Locations total";
  updateTotal();
  totalLab.append(totalSpan, totalEl);
  grid.appendChild(totalLab);
  TUNE_LIGHT_FIELDS.forEach(([key, label]) => {
    addField(label, tuneDraft.blankLights?.[key] ?? 6, (v) => {
      (tuneDraft.blankLights ??= {})[key] = Number(v);
    });
  });
  TUNE_FIELDS.forEach(([key, label]) => {
    addField(label, tuneDraft[key] ?? 0, (v) => {
      tuneDraft[key] = Number(v);
    });
  });
  panel.appendChild(grid);

  const actions = document.createElement("div");
  actions.className = "um-tune-actions";
  if (canSaveTunings) {
    // Name it here, then Save — the version persists and applies right away.
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "um-tune-name um-tune-savename";
    nameInput.maxLength = 40;
    nameInput.placeholder = "Tuning name…";
    nameInput.value = tuneName || `Tuning ${savedTunings.length + 1}`;
    nameInput.addEventListener("input", () => { tuneName = nameInput.value; });
    const save = button("✓ Save", "", "primary-btn");
    save.title = "Save this tuning under the name on the left and apply it (re-deals)";
    save.addEventListener("click", () => {
      socket.emit("uber_mania_save_settings", {
        roomId: app.roomId,
        name: nameInput.value.trim() || `Tuning ${savedTunings.length + 1}`,
        settings: tuneDraft
      });
      closeTuning();
      renderControls();
    });
    actions.append(nameInput, save);
  }
  const apply = button("Apply · re-deal", "", "primary-btn");
  apply.addEventListener("click", () => {
    socket.emit("uber_mania_tune", { roomId: app.roomId, settings: tuneDraft });
    closeTuning();
    renderControls();
  });
  const cancel = button("Cancel", "");
  cancel.addEventListener("click", () => {
    closeTuning();
    renderControls();
  });
  actions.append(apply, cancel);
  panel.appendChild(actions);

  els.gameBoard.appendChild(panel);
}

socket.on("uber_mania_settings", ({ settings, canSave } = {}) => {
  savedTunings = Array.isArray(settings) ? settings : [];
  canSaveTunings = canSave !== false;
  if (tuneDraft && isActive()) renderTuning(); // refresh the open panel's list
});

socket.on("uber_mania_settings_error", ({ message } = {}) => {
  if (isActive() && message) window.alert(message);
});

els.hand.addEventListener("click", (event) => {
  if (!isActive()) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  const btn = target.closest("[data-action]");
  if (!btn || btn.disabled || !app.roomId) return;

  switch (btn.dataset.action) {
    case "regen":
      socket.emit("uber_mania_regenerate", { roomId: app.roomId });
      break;
    case "mixup":
      socket.emit("uber_mania_mix_up", { roomId: app.roomId });
      break;
    case "togglebar":
      controlsMin = !controlsMin;
      localStorage.setItem("umControlsMin", controlsMin ? "1" : "0");
      renderControls();
      break;
    case "skipturn":
      withHoodChoices((hoodChoices) =>
        socket.emit("uber_mania_skip_turn", { roomId: app.roomId, hoodChoices }));
      break;
    case "routemode":
      moveMode = moveMode === "build" ? "auto" : "build";
      clearPreview();
      refreshBuilder();
      renderControls();
      break;
    case "tuning":
      if (tuneDraft) {
        closeTuning();
        renderControls();
      } else {
        openTuning();
      }
      break;
    default:
      break;
  }
});

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
  els.gameBoard.classList.add("truck-mania-board", "um-board");

  const svg = boardSvg();
  drawStreets(svg, mapState.streets);
  const buildingsLayer = svgEl("g", { class: "tm-blocks" }, svg);
  mapState.blocks.forEach((block) => {
    block.buildings.forEach((building) => appendBuilding(buildingsLayer, building));
  });

  renderSpots(svg);
  renderOctagons(svg);
  renderCars(svg);
  svg.addEventListener("click", onBoardClick);
  els.gameBoard.appendChild(svg);
  syncCars(carsState);
  renderClock();
  renderScoreboard();
  renderPlayerPanel();
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
  if (turnActed) {
    els.turnStatus.textContent = "Your turn — end when ready";
  } else if (placeableBid() != null || completableBid() != null) {
    const canVisit = placeableBid() != null;
    const canComplete = completableBid() != null;
    const b = buildingByBid(placeableBid() ?? completableBid());
    els.turnStatus.textContent = canVisit && canComplete
      ? `Your turn — click the circle to visit ${b?.name ?? "the location"}, or elsewhere on it to complete your ride`
      : canComplete
      ? `Your turn — click ${b?.name ?? "the location"} to complete your ride`
      : b?.locType === "uber"
      ? `Your turn — click ${b.name ?? "the Uber pickup"} to take a ride card`
      : b?.locType === "upgrade"
      ? `Your turn — click the upgrade at ${b.name ?? "this spot"} to grab it`
      : `Your turn — click the ${LOC_LABELS[b?.locType] ?? "location"} to place a token`;
  } else {
    // Parked at a duplicate-mode location that's just closed for the period?
    // Say when it opens.
    const car = myCar();
    const b = car && car.spot != null && !turnActed
      ? buildingByBid(mapState?.spots?.[car.spot]?.building)
      : null;
    const PERIOD_PHRASES = {
      morning: "in the morning", afternoon: "in the afternoon",
      night: "at night", day: "during the day"
    };
    els.turnStatus.textContent =
      b && !locOpen(b, timeState) && Array.isArray(b.slots) && b.slots.includes(null)
        ? `Your turn — ${b.name ?? "this location"} only opens ${PERIOD_PHRASES[b.period] ?? `in the ${b.period}`} ${PERIOD_SYMBOLS[b.period] ?? ""}`
        : b && b.locType === "upgrade" && upgradeTypeAt(b) != null && upgradeWindowClosed(b)
        ? `Your turn — this upgrade spot only opens ${UPGRADE_WINDOW_LABELS[b.window] ?? "later"}`
        : "Your turn";
  }
}

// Undo everything the uber layout does to the shared chrome (body class, the
// footer action bar) — run whenever another game takes over or the player
// leaves.
function teardownChrome() {
  document.body.classList.remove("um-mode");
  removeActionBar();
}

export const uberMania = {
  id: "uber-mania",
  name: "Uber Mania",
  description: "",

  handleState(payload, resetGameUi) {
    if (!payload.uberMania?.map) return false;
    resetGameUi();
    document.body.classList.add("um-mode"); // the uber layout owns the screen
    const um = payload.uberMania;
    const prevHour = hourState;
    hourState = um.hour ?? null;
    timeState = um.time ?? 0;
    nightState = !!um.night;
    elapsedState = um.elapsed ?? 0;
    turnWhose = um.turn ?? 0;
    turnActed = !!um.turnState?.acted;
    turnChangedTime = !!um.turnState?.changedTime;
    turnDestressed = !!um.turnState?.destressed;
    turnKeptGoing = !!um.turnState?.keptGoing;
    turnUndo = um.turnState?.undo ?? null;
    turnTruck = um.turnState?.truck ?? null;
    dicePoolState = um.turnState?.dicePool ?? 0;
    aiMoveState = um.aiMove ?? null;
    maxAiState = um.maxAi ?? 3;
    upgradeAtState = um.upgradeAt ?? null;
    upgradeTypeState = um.upgradeType ?? null;
    upgradeDeckCountState = um.upgradeDeckCount ?? 0;
    upgradeChampionsState = um.upgradeChampions ?? [];
    funRollState = um.funRoll ?? null;
    applySpeed(um.speed ?? 1);
    playersState = um.players ?? [];
    hoodsState = um.hoods ?? [];
    lastRollState = um.lastRoll ?? null;
    winnerState = um.winner ?? null;
    if (um.results && !resultsState) resultsDismissed = false; // fresh game end — show the chart
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
      renderStressBar();

      const roll = um.lastRoll;
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
            updateTurnControls();
            refreshBuilder();
            renderResults(); // the end-game chart waits out the final roll
          });
        };
        if (flipping) clockQueue.push(startDice);
        else startDice();
      }
      // The fun die (a no-dice turn's consolation roll): banner on a new seq.
      if (funRollState && funRollState.seq !== lastFunSeq) {
        lastFunSeq = funRollState.seq;
        showFunRoll(funRollState);
      }
      syncCars(um.trucks);
      renderScoreboard();
      renderPlayerPanel();
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
      lastFunSeq = um.funRoll?.seq ?? lastFunSeq; // no banner on a fresh render
      Object.keys(carSpots).forEach((k) => delete carSpots[k]);
      Object.keys(carPos).forEach((k) => delete carPos[k]);
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
    hoodsState = [];
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
    winnerState = null;
    timeState = 0;
    nightState = true;
    elapsedState = 0;
    turnWhose = 0;
    turnActed = false;
    turnChangedTime = false;
    turnDestressed = false;
    turnKeptGoing = false;
    turnUndo = null;
    turnTruck = null;
    resultsState = null;
    resultsDismissed = false;
    aiMoveState = null;
    maxAiState = 3;
    upgradeAtState = null;
    upgradeTypeState = null;
    upgradeDeckCountState = 0;
    upgradeChampionsState = [];
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
    tuneDraft = null;
    els.gameBoard.classList.remove("um-board");
    els.gameBoard.querySelector(".um-tune")?.remove();
    teardownChrome();
    document.body.style.removeProperty("--tm-mult");
    document.querySelector(".game-header .tm-scoreboard")?.remove();
    document.querySelector(".tm-turn-toast")?.remove();
    document.querySelector(".um-fun-dice")?.remove();
    [carEls, carPos, carSpots, pendingRoutes].forEach((o) =>
      Object.keys(o).forEach((k) => delete o[k])
    );
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
