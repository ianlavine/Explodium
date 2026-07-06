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
    octEls.push({ flip, shape, color: oct.color });
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

  renderOctagons(svg);
  els.gameBoard.appendChild(svg);
  renderClock();
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
    hourState = tm.hour ?? null;

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
      if (octLayoutChanged) refreshOctagonsHard();
      else updateOctagons(tm.map);
      setHand();
    } else {
      mapState = tm.map;
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
  },

  onOpponentLeft() {},

  onExit() {
    this.clearState();
  }
};
