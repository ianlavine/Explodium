// Truck Mania client — city map, octagon signals, the clock, and the map editor.
import { socket, els, app, updateTurn } from "../../shared/context.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const GREEN = "#3d9a5f";
const RED = "#cf4a3c";
const OCT_RADIUS = 13;
const PALETTE = ["#c97b63", "#6b8f71", "#d4a056", "#7d8aa5", "#b8849f", "#8f7e6b"];

let mapState = null;
let hourState = null;
let octEls = [];
let handEl = null;
let boardMode = "play"; // "play" | "edit"
let savedMaps = [];
let canSaveMaps = true;
let mapsRequested = false;
let hoveredHour = null;
let flipping = false;

// Trucks + driving.
let trucksState = [];
const truckEls = {}; // id -> svg group
const cargoEls = {}; // id -> cargo sub-group inside the truck
const truckPos = {}; // id -> { x, y, angle }
const truckSpots = {}; // id -> last spot index rendered
const truckAnim = {}; // id -> rAF handle
let graphCache = null; // { seed, graph }

// Packages: parcels sitting on pickup buildings or stacked in a truck's dock.
const pkgPos = {}; // package id -> last rendered world position (fly source)
const animatingPkgs = new Set(); // ids mid-flight, hidden from static renders
const CARGO_SIZE = 7;
const BLD_PKG_SIZE = 11;

// Player board: seven columns, each a color-linked track of six values. The
// last two (Locations / Abilities) are placeholders with no values yet.
let playersState = [];
const PB_COLUMNS = [
  { id: "capacity", title: "Capacity", color: "#e8c33c", values: [2, 3, 4, 5, 6, 7] },
  { id: "variety", title: "Variety", color: "#4a72b0", values: [1, 2, 3, 4, 5, 6] },
  { id: "aversion", title: "Aversion", color: "#4f9d57", values: [1, 2, 3, 4, 5, 6] },
  { id: "agression", title: "Agression", color: "#cf4a3c", values: [0, 1, 2, 3, 4, 5] },
  { id: "timestones", title: "Time stones", color: "#8a5bb0", values: [2, 4, 6, 8, 10, 12] },
  { id: "locations", title: "Locations", color: "#e08a3c", values: [] },
  { id: "abilities", title: "Abilities", color: "#8f6b52", values: [] }
];

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
  const g = svgEl("g", { class: "tm-building" }, parent);

  (building.connectors ?? []).forEach((c) => {
    svgEl("line", {
      x1: c.x1, y1: c.y1, x2: c.x2, y2: c.y2,
      stroke: building.color,
      "stroke-width": 2
    }, g);
  });

  if (building.points) {
    svgEl("polygon", { points: polygonToString(building.points), fill: building.color }, g);
  } else {
    const rect = svgEl("rect", {
      x: building.x, y: building.y, width: building.w, height: building.h,
      rx: 3,
      fill: building.color
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
  mapState.intersections.forEach((oct) => {
    const g = svgEl("g", { class: "tm-oct", transform: `translate(${oct.x} ${oct.y})` }, layer);
    const flip = svgEl("g", { class: "tm-oct-flip" }, g);
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

function flipOctagon(entry, color) {
  const apply = () => {
    entry.flip.removeEventListener("transitionend", apply);
    entry.shape.setAttribute("fill", color === "green" ? GREEN : RED);
    entry.flip.classList.remove("tm-oct-folding");
  };
  entry.flip.addEventListener("transitionend", apply);
  entry.flip.classList.add("tm-oct-folding");
  setTimeout(apply, 300);
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

function setHand() {
  if (!handEl) return;
  const deg = hourState ? hourState * 30 : 0;
  handEl.style.transform = `rotate(${deg}deg)`;
}

// Ring the two octagons carrying this hour's number, so it's clear which
// stoplights a time change would flip.
function setHourHighlight(hour, on) {
  mapState.intersections.forEach((oct, i) => {
    if (oct.number === hour && octEls[i]) octEls[i].g.classList.toggle("tm-oct-hi", on);
  });
}

// A time change: the hand swings first, then the two matching octagons flip
// one at a time, with the highlight held through the whole sequence.
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
        flipOctagon(entry, mapState.intersections[i].color);
        entry.color = mapState.intersections[i].color;
      }, delay);
      delay += 520;
    });
    setTimeout(() => {
      flipping = false;
      if (hoveredHour !== hour) idx.forEach((i) => octEls[i]?.g.classList.remove("tm-oct-hi"));
    }, delay + 380);
  }, 540);
}

function renderClock() {
  const wrap = document.createElement("div");
  wrap.className = "tm-clock";

  const svg = svgEl("svg", { viewBox: "0 0 200 200", role: "img", "aria-label": "Clock" });
  svgEl("circle", { cx: 100, cy: 100, r: 94, class: "tm-clock-face" }, svg);

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
      if (!flipping) setHourHighlight(h, true);
    });
    hit.addEventListener("mouseleave", () => {
      hoveredHour = null;
      if (!flipping) setHourHighlight(h, false);
    });
  }

  handEl = svgEl("g", { class: "tm-clock-hand" }, svg);
  svgEl("line", { x1: 100, y1: 100, x2: 100, y2: 42 }, handEl);
  svgEl("circle", { cx: 100, cy: 100, r: 5, class: "tm-clock-pin" }, svg);

  wrap.appendChild(svg);
  wrap.addEventListener("click", (event) => {
    const hourElement = event.target.closest("[data-hour]");
    if (!hourElement || !app.roomId || !isActive() || editor) return;
    socket.emit("truck_mania_set_hour", {
      roomId: app.roomId,
      hour: Number(hourElement.dataset.hour)
    });
  });

  els.gameBoard.appendChild(wrap);
  setHand();
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

// The truck rotates to its heading. When that heading points leftward the
// naive rotation would put it upside down, so we mirror it vertically in its
// own frame — nose still points along travel, wheels stay on the underside.
function truckTransform(id) {
  const el = truckEls[id];
  const pos = truckPos[id];
  if (!el || !pos) return;
  const flip = Math.cos((pos.angle * Math.PI) / 180) < 0 ? " scale(1 -1)" : "";
  el.setAttribute("transform", `translate(${pos.x} ${pos.y}) rotate(${pos.angle})${flip}`);
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

function renderTrucks(svg) {
  const layer = svgEl("g", { class: "tm-trucks" }, svg);
  Object.keys(truckEls).forEach((k) => delete truckEls[k]);
  Object.keys(cargoEls).forEach((k) => delete cargoEls[k]);
  trucksState.forEach((t) => {
    const g = makeTruckShape(layer, "#f4c542");
    truckEls[t.id] = g;
    cargoEls[t.id] = g.querySelector(".tm-cargo");
    renderCargo(t.id);
  });
}

// A parcel: a filled square or circle with a dark outline. Used on buildings,
// in the dock, and for the fly animation.
function drawPackage(parent, shape, color, cx, cy, size) {
  if (shape === "circle") {
    return svgEl("circle", { cx, cy, r: size / 2, fill: color, class: "tm-pkg-shape" }, parent);
  }
  return svgEl("rect", { x: cx - size / 2, y: cy - size / 2, width: size, height: size, rx: 1.5, fill: color, class: "tm-pkg-shape" }, parent);
}

// Dock slot k, in the truck's local frame: two columns stacking upward.
function dockSlotLocal(k) {
  const col = k % 2;
  const row = Math.floor(k / 2);
  return [-10 + col * 7.5, 1.5 - row * 7.5];
}

function truckLocalToWorld(pos, lx, ly) {
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
    const shape = drawPackage(layer, pkg.shape, pkg.color, lx, ly, CARGO_SIZE);
    shape.classList.add("tm-pkg-cargo");
    shape.setAttribute("data-pkg", pkg.id);
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
  trucksState.forEach((t) => {
    const spot = mapState.spots?.[t.spot];
    if (!spot || !truckEls[t.id]) return;
    const prev = truckSpots[t.id];
    if (prev == null) {
      truckPos[t.id] = { x: spot.x, y: spot.y, angle: spot.angle };
      truckSpots[t.id] = t.spot;
      truckTransform(t.id);
    } else if (prev !== t.spot) {
      truckSpots[t.id] = t.spot;
      const from = truckPos[t.id] || { x: spot.x, y: spot.y };
      const path = findPath(getGraph(), from.x, from.y, spot.x, spot.y);
      driveTruck(t.id, path, spot.angle);
    }
    renderCargo(t.id);
  });
}

// Animate a truck along a polyline at roughly constant speed, rotating it to
// each segment's heading. Settles to the destination's street angle at the end.
function driveTruck(id, path, endAngle) {
  if (truckAnim[id]) cancelAnimationFrame(truckAnim[id]);
  const cum = [0];
  for (let i = 1; i < path.length; i += 1) {
    cum.push(cum[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
  }
  const total = cum[cum.length - 1];
  const last = path[path.length - 1];
  if (total < 1) {
    truckPos[id] = { x: last[0], y: last[1], angle: endAngle };
    truckTransform(id);
    return;
  }
  const speed = 240; // px per second
  const duration = Math.min(4200, Math.max(450, (total / speed) * 1000));
  const start = performance.now();

  const step = (now) => {
    const p = Math.min(1, (now - start) / duration);
    const target = p * total;
    let i = 1;
    while (i < cum.length && cum[i] < target) i += 1;
    const a = path[i - 1];
    const b = path[Math.min(i, path.length - 1)];
    const segLen = (cum[i] ?? total) - cum[i - 1] || 1;
    const f = Math.max(0, Math.min(1, (target - cum[i - 1]) / segLen));
    const x = a[0] + (b[0] - a[0]) * f;
    const y = a[1] + (b[1] - a[1]) * f;
    let angle = truckPos[id]?.angle ?? 0;
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 0.5) {
      angle = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
    }
    truckPos[id] = { x, y, angle };
    truckTransform(id);
    if (p < 1) {
      truckAnim[id] = requestAnimationFrame(step);
    } else {
      truckPos[id] = { x: last[0], y: last[1], angle };
      truckTransform(id);
      truckAnim[id] = null;
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
        drawPackage(g, pkg.shape, pkg.color, px, py, BLD_PKG_SIZE);
      });
    });
  });
}

function renderBuildingPackages(svg) {
  drawBuildingPackages(svgEl("g", { class: "tm-bld-pkgs" }, svg));
}

// The bid of the building the player's truck is currently parked at.
function truckBuildingBid() {
  const truck = trucksState[0];
  const spot = truck ? mapState.spots?.[truck.spot] : null;
  return spot ? spot.building : null;
}

// Temp parcel that flies from `from` to `to`, then runs onDone.
function flyPackage(shape, color, from, to, onDone) {
  const svg = els.gameBoard.querySelector(".tm-map");
  if (!svg) {
    onDone?.();
    return;
  }
  let layer = svg.querySelector(".tm-fly");
  if (!layer) layer = svgEl("g", { class: "tm-fly" }, svg);
  const g = svgEl("g", {}, layer);
  drawPackage(g, shape, color, 0, 0, CARGO_SIZE + 1);
  const dur = 360;
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

function attemptPickup(pkgId, bid) {
  const truck = trucksState[0];
  if (!truck || truckBuildingBid() !== bid) return;
  const building = buildingsByBid().get(bid);
  const pkg = building?.packages?.find((p) => p.id === pkgId);
  if (!pkg) return;
  const from = pkgPos[pkgId] || buildingCentroid(building);
  const to = nextDockWorld(truck.id);
  animatingPkgs.add(pkgId);
  renderBuildingPackagesRefresh();
  socket.emit("truck_mania_pickup", { roomId: app.roomId, truckId: truck.id, packageId: pkgId });
  flyPackage(pkg.shape, pkg.color, from, to, () => {
    animatingPkgs.delete(pkgId);
    renderCargo(truck.id);
    renderBuildingPackagesRefresh();
  });
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
  const shapeEl = drawPackage(g, pkg.shape, pkg.color, 0, 0, BLD_PKG_SIZE);
  const flyDur = 360;
  const flipDur = 300;
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
  const truck = trucksState[0];
  if (!truck) return;
  const building = buildingsByBid().get(truckBuildingBid());
  if (!building || building.role !== "dropoff") return;
  const pkg = truck.cargo?.find((p) => p.id === pkgId);
  if (!pkg || pkg.color !== building.dropoffColor) return;
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

function onBoardClick(event) {
  if (editor || !app.roomId) return;
  const cargoPkg = event.target.closest?.(".tm-pkg-cargo");
  if (cargoPkg) {
    attemptDropoff(cargoPkg.dataset.pkg);
    return;
  }
  const bldPkg = event.target.closest?.(".tm-pkg-building");
  if (bldPkg) {
    attemptPickup(bldPkg.dataset.pkg, Number(bldPkg.dataset.bid));
    return;
  }
  const spotEl = event.target.closest?.(".tm-spot");
  if (!spotEl) return;
  const spot = Number(spotEl.dataset.spot);
  const truck = trucksState[0];
  if (!truck || truck.spot === spot) return;
  socket.emit("truck_mania_move_truck", { roomId: app.roomId, truckId: truck.id, spot });
}

// --------------------------------------------------------------------------
// Player board
// --------------------------------------------------------------------------

function renderPlayerBoard() {
  els.gameBoard.querySelector(".tm-player-board")?.remove();
  const me = playersState[app.myPlayerIndex] ?? playersState[0];
  if (!me) return;

  const board = document.createElement("div");
  board.className = "tm-player-board";

  const header = document.createElement("div");
  header.className = "tm-pb-header";
  header.style.background = me.color;
  header.textContent = me.name || "Player";
  board.appendChild(header);

  const grid = document.createElement("div");
  grid.className = "tm-pb-grid";
  PB_COLUMNS.forEach((col) => {
    const cur = me.columns?.[col.id] ?? 0;
    const c = document.createElement("div");
    c.className = "tm-pb-col";

    const title = document.createElement("div");
    title.className = "tm-pb-title";
    title.style.background = col.color;
    title.textContent = col.title;
    c.appendChild(title);

    for (let i = 0; i < 6; i += 1) {
      const cell = document.createElement("div");
      cell.className = "tm-pb-cell";
      const val = col.values[i];
      const isCurrent = val != null && i === cur;
      cell.style.background = hexToRgba(col.color, isCurrent ? 0.95 : 0.22);
      if (val != null) cell.textContent = String(val);
      if (isCurrent) cell.classList.add("tm-pb-current");
      c.appendChild(cell);
    }
    grid.appendChild(c);
  });
  board.appendChild(grid);
  els.gameBoard.appendChild(board);
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
    scaleBase: null
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
  const name = window.prompt("Name this map:", `Map ${savedMaps.length + 1}`);
  if (name === null) return;
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

function renderControls() {
  els.hand.innerHTML = "";
  els.hand.classList.remove("player-0", "player-1", "toy-rack", "flip-score");
  els.hand.classList.add("tm-controls");

  if (!mapsRequested) {
    mapsRequested = true;
    socket.emit("truck_mania_list_maps");
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
      const saveBtn = button("Save map", "save", "primary-btn");
      saveBtn.disabled = editor.octagons.length < 24;
      els.hand.appendChild(saveBtn);
    }
    els.hand.appendChild(button("Exit", "exitedit"));
    return;
  }

  const select = document.createElement("select");
  select.className = "tm-map-select";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = savedMaps.length ? "Saved maps…" : "No saved maps";
  select.appendChild(placeholder);
  savedMaps.forEach((m) => {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.name;
    select.appendChild(opt);
  });
  select.disabled = !savedMaps.length;
  els.hand.appendChild(select);

  els.hand.appendChild(button("Load", "load", "primary-btn"));
  els.hand.appendChild(button("New map", "regen"));
  els.hand.appendChild(button("Mix up", "mixup"));
  els.hand.appendChild(button("Edit map", "edit"));
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
    case "load": {
      const select = els.hand.querySelector(".tm-map-select");
      if (select?.value) {
        socket.emit("truck_mania_load_map", { roomId: app.roomId, mapId: select.value });
      }
      break;
    }
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
    const prevHour = hourState;
    hourState = tm.hour ?? null;
    playersState = tm.players ?? [];

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
        refreshOctagonsHard();
        setHand();
      } else if (hourState != null && hourState !== prevHour) {
        stagedTimeChange(hourState); // moves the hand, then flips one at a time
      } else {
        updateOctagons(tm.map);
        setHand();
      }
      syncTrucks(tm.trucks);
      renderBuildingPackagesRefresh();
      renderPlayerBoard();
    } else {
      mapState = tm.map;
      Object.keys(truckSpots).forEach((k) => delete truckSpots[k]);
      Object.keys(truckPos).forEach((k) => delete truckPos[k]);
      Object.keys(pkgPos).forEach((k) => delete pkgPos[k]);
      animatingPkgs.clear();
      trucksState = tm.trucks ?? [];
      renderMap();
      renderControls();
    }

    els.turnStatus.textContent = "City map";
    updateTurn(payload.turn);
    return true;
  },

  resetUi() {},

  clearState() {
    mapState = null;
    hourState = null;
    octEls = [];
    handEl = null;
    editor = null;
    dragCtx = null;
    boardMode = "play";
    trucksState = [];
    playersState = [];
    graphCache = null;
    hoveredHour = null;
    flipping = false;
    animatingPkgs.clear();
    [truckEls, cargoEls, truckPos, truckSpots, pkgPos].forEach((o) =>
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
