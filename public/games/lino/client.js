// Lino client: real-time SVG board. Click a dot to anchor a line, then hover a
// second dot to see what connecting them costs. Building across an enemy line
// cuts it — the doomed lines flash red in the preview. First player to link
// both shrines wins.
//
// The board is much larger than it looks: the camera opens on all of it, and
// you drag and zoom (wheel/pinch, or the corner buttons) to work up close.
import { socket, els, app } from "../../shared/context.js";
import {
  BOARD_WIDTH,
  BOARD_HEIGHT,
  DEFAULT_SETTINGS,
  SETTING_RANGES,
  evaluateBuild,
  resolveDestruction,
  displayMoney,
  productionFor
} from "./rules.js";

// The pre-game setup screen. Order here is the order shown.
const SETTING_FIELDS = [
  {
    key: "brassPipes",
    label: "Brass pipes",
    hint: "A line that destroys another turns to brass: permanently indestructible, and an uncrossable wall."
  },
  {
    key: "requireLonger",
    label: "Cutting needs a longer line",
    hint: "A line may only destroy one shorter than itself."
  },
  {
    key: "allowOpponentDots",
    label: "Allow building on enemy dots",
    hint: "Off: dots the opponent holds are off-limits until you cut them free. Shrines are always open to both players."
  },
  {
    key: "allowSelfCross",
    label: "Allow crossing your own lines",
    hint: "Crossing your own network is free and destroys nothing."
  },
  {
    key: "destroyDots",
    label: "Destroyed lines take their dots",
    hint: "A cut also removes both end dots and the lines touching them — one level only."
  },
  {
    key: "showStrength",
    label: "Show pipe strength",
    hint: "Print each line's strength — the price to cut it — as a number along the pipe."
  },
  {
    key: "consumption",
    label: "Kills consume their victims",
    hint: "A line that cuts others absorbs their strength, becoming that much harder to cut. Killers keep hardening."
  }
];

const trimNum = (v) => (Number(v) % 1 === 0 ? String(Number(v)) : Number(v).toFixed(1));

// Economy dials, rendered as sliders below the toggles.
const SLIDER_FIELDS = [
  {
    key: "costScale",
    label: "Line cost",
    format: (v) => `${trimNum(v)} / 100`
  },
  {
    key: "incomePerNode",
    label: "Income per node",
    format: (v) => `$${Number(v).toFixed(2)}/s`
  },
  {
    key: "dotCount",
    label: "Dots on the board",
    format: (v) => trimNum(v)
  }
];

const SVG_NS = "http://www.w3.org/2000/svg";
const PLAYER_CLASSES = ["lino-p0", "lino-p1"];
const HOVER_PX = 20; // screen pixels — how close the cursor must be to light a dot
const MIN_VIEW_WIDTH = 55; // deepest zoom, in board units
const DRAG_SLOP_PX = 4; // movement below this still counts as a click, not a pan
const ZOOM_SENSITIVITY = 0.0016;
// Board units are multiplied by (unitsPerPixel * SIZE_REFERENCE) so art holds a
// constant pixel size. 6.6 is the px-per-unit the sizes below were drawn at.
const SIZE_REFERENCE = 6.6;
// …except right out at full board view, where constant-size dots would touch.
const MAX_ZOOM_SCALE = 1.25;

let linoState = null;
let selectedDotId = null;
let lastCursor = null;
let svg = null;
let linesLayer = null;
let previewLine = null;
let costLabel = null; // one shared cost readout, moved to the hovered dot
let dotEls = new Map(); // dotId -> <g>
let lineEls = new Map(); // lineId -> <line>
let highlighted = []; // dot/line elements currently carrying a preview class
let hud = null; // { mine, theirs, banner }
let pendingSetup = null; // { mode, onReady } while the setup screen is open
let chosenSettings = { ...DEFAULT_SETTINGS };

// --- camera -----------------------------------------------------------------
// The board is far larger than the window onto it. The camera is a centre point
// plus a width; the height falls out of the element's pixel aspect ratio, so
// the viewBox always matches the element exactly and nothing is letterboxed.
let camera = null; // { cx, cy, w }
let zoomScale = 1; // how much to inflate board-unit sizes at this zoom level
let panState = null; // { pointerId, lastX, lastY, moved }
let panned = false; // the click closing a drag must not also select a dot
let resizeObserver = null;

function isActive() {
  return app.currentGame?.id === "lino";
}

function mySeat() {
  return app.myPlayerIndex ?? 0;
}

function isOver() {
  return linoState?.winner !== null && linoState?.winner !== undefined;
}

function dotById(id) {
  return linoState?.dots.find((dot) => dot.id === id) ?? null;
}

function toBoardCoords(event) {
  const point = svg.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  return point.matrixTransform(svg.getScreenCTM().inverse());
}

function pixelSize() {
  const rect = svg?.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    return { width: BOARD_WIDTH, height: BOARD_HEIGHT };
  }
  return { width: rect.width, height: rect.height };
}

function aspectRatio() {
  const px = pixelSize();
  return px.width / px.height;
}

// The camera width at which the whole board fits inside the element — the same
// "meet" behaviour a plain viewBox would give, expressed as a zoom level. This
// is both the starting view and the furthest you can pull back.
function maxWidth() {
  return Math.max(BOARD_WIDTH, BOARD_HEIGHT * aspectRatio());
}

// Board units per screen pixel right now — used to keep hit radii, and the
// pan gesture, in screen terms rather than board terms.
function unitsPerPixel() {
  if (!camera) return 1;
  return camera.w / pixelSize().width;
}

function applyCamera() {
  if (!svg || !camera) return;
  camera.w = Math.min(maxWidth(), Math.max(MIN_VIEW_WIDTH, camera.w));
  const height = camera.w / aspectRatio();
  // Once the view is wider than the world there is nothing left to pan to, so
  // it locks to centre; otherwise the edges stop at the board's edges.
  const clamp = (centre, span, board) =>
    span >= board ? board / 2 : Math.min(board - span / 2, Math.max(span / 2, centre));
  camera.cx = clamp(camera.cx, camera.w, BOARD_WIDTH);
  camera.cy = clamp(camera.cy, height, BOARD_HEIGHT);

  svg.setAttribute(
    "viewBox",
    `${camera.cx - camera.w / 2} ${camera.cy - height / 2} ${camera.w} ${height}`
  );

  // Everything drawn in board units is multiplied by this so it holds a
  // constant size on screen as you zoom. SIZE_REFERENCE is picked so k lands
  // on 1 at the zoom the art was designed at; the cap keeps dots from merging
  // into a blob when the whole board is on screen at once.
  const next = Math.min(MAX_ZOOM_SCALE, Math.round(unitsPerPixel() * SIZE_REFERENCE * 100) / 100);
  if (next !== zoomScale) {
    zoomScale = next;
    svg.style.setProperty("--lino-k", String(zoomScale));
    scaleDots();
  }
}

// Circle radii are geometry, not style, so they can't ride on the CSS variable
// the way stroke widths and font sizes do.
function scaleDots() {
  dotEls.forEach(({ core, halo, shrine }) => {
    core.setAttribute("r", (shrine ? 2.4 : 1.6) * zoomScale);
    if (halo) halo.setAttribute("r", 3.6 * zoomScale);
  });
}

// The match opens on the whole board, which is also the reset target.
function resetCamera() {
  camera = { cx: BOARD_WIDTH / 2, cy: BOARD_HEIGHT / 2, w: maxWidth() };
  applyCamera();
}

// Zoom by `factor`, keeping the board point currently under (clientX, clientY)
// pinned to that same screen position.
function zoomAt(factor, clientX, clientY) {
  if (!camera) return;
  const rect = svg.getBoundingClientRect();
  const anchor = toBoardCoords({ clientX, clientY });
  const u = rect.width > 0 ? (clientX - rect.left) / rect.width - 0.5 : 0;
  const v = rect.height > 0 ? (clientY - rect.top) / rect.height - 0.5 : 0;

  camera.w = Math.min(maxWidth(), Math.max(MIN_VIEW_WIDTH, camera.w * factor));
  const height = camera.w / aspectRatio();
  camera.cx = anchor.x - u * camera.w;
  camera.cy = anchor.y - v * height;
  applyCamera();
}

function zoomCentre(factor) {
  const rect = svg.getBoundingClientRect();
  zoomAt(factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
}

function evaluate(toId) {
  return evaluateBuild({
    dots: linoState.dots,
    lines: linoState.lines,
    seat: mySeat(),
    money: linoState.money[mySeat()],
    fromId: selectedDotId,
    toId,
    settings: linoState.settings
  });
}

function clearSelection() {
  selectedDotId = null;
  updatePreview(lastCursor);
}

// The dot nearest the cursor, but only if the cursor is basically on top of it.
// The reach is a fixed number of *pixels*, so it feels the same at every zoom.
function hoveredDot(cursor) {
  if (!cursor) return null;
  let best = null;
  let bestDistance = HOVER_PX * unitsPerPixel();
  linoState.dots.forEach((dot) => {
    if (dot.id === selectedDotId) return;
    const gap = Math.hypot(dot.x - cursor.x, dot.y - cursor.y);
    if (gap <= bestDistance) {
      best = dot;
      bestDistance = gap;
    }
  });
  return best;
}

// Redraw the cursor-following preview, the single hovered cost label, and the
// red highlight on any enemy lines this build would cut.
function updatePreview(cursor) {
  if (!svg || !linoState) return;
  lastCursor = cursor;
  const origin = selectedDotId ? dotById(selectedDotId) : null;
  const live = origin && cursor && !isOver();

  if (!live) {
    previewLine.classList.add("hidden");
  } else {
    previewLine.classList.remove("hidden");
    previewLine.setAttribute("x1", origin.x);
    previewLine.setAttribute("y1", origin.y);
    previewLine.setAttribute("x2", cursor.x);
    previewLine.setAttribute("y2", cursor.y);
  }

  // Only the handful of elements we lit last time need clearing — sweeping
  // every dot would mean thousands of class writes per mouse move.
  highlighted.forEach((el) => el.classList.remove("lit", "blocked", "doomed", "selected"));
  highlighted = [];
  costLabel.classList.add("hidden");

  const selected = selectedDotId ? dotEls.get(selectedDotId) : null;
  if (selected) {
    selected.group.classList.add("selected");
    highlighted.push(selected.group);
  }

  const target = live ? hoveredDot(cursor) : null;
  if (!target) return;

  const result = evaluate(target.id);
  if (result.reason === "exists" || result.reason === "invalid") return;

  const el = dotEls.get(target.id);
  if (!el) return;
  el.group.classList.add("lit");
  if (!result.ok) el.group.classList.add("blocked");
  highlighted.push(el.group);

  costLabel.classList.remove("hidden");
  costLabel.classList.toggle("blocked", !result.ok);
  costLabel.setAttribute("x", target.x);
  costLabel.setAttribute("y", target.y - (target.shrine ? 4.4 : 3.2) * zoomScale);

  if (result.reason === "self-cross") {
    costLabel.textContent = "blocked";
  } else if (result.reason === "taken") {
    costLabel.textContent = "taken";
  } else if (result.reason === "brass") {
    costLabel.textContent = "brass wall";
  } else if (result.reason === "too-short") {
    costLabel.textContent = "too short";
  } else {
    costLabel.textContent = `$${result.cost}`;
  }

  // Show everything this build would take out, even if it's not yet
  // affordable — including the dots that fall with it under destroyDots.
  if (result.destroys.length) {
    const { lineIds, dotIds } = resolveDestruction({
      dots: linoState.dots,
      lines: linoState.lines,
      cutLineIds: result.destroys,
      settings: linoState.settings
    });
    lineIds.forEach((lineId) => {
      const line = lineEls.get(lineId);
      if (!line) return;
      line.classList.add("doomed");
      highlighted.push(line);
    });
    dotIds.forEach((dotId) => {
      const dot = dotEls.get(dotId);
      if (!dot) return;
      dot.group.classList.add("doomed");
      highlighted.push(dot.group);
    });
  }
}

function handleDotClick(dotId) {
  if (isOver()) return;
  if (!selectedDotId) {
    selectedDotId = dotId;
    updatePreview(lastCursor);
    return;
  }
  if (dotId === selectedDotId) {
    clearSelection();
    return;
  }
  const result = evaluate(dotId);
  if (result.ok) {
    socket.emit("lino_build", { roomId: app.roomId, fromId: selectedDotId, toId: dotId });
    clearSelection();
    return;
  }
  // Not a legal build — treat the click as re-anchoring to a new starting dot.
  selectedDotId = dotId;
  updatePreview(lastCursor);
}

function buildBoard() {
  els.gameBoard.innerHTML = "";
  els.gameBoard.classList.add("lino-board");
  els.gameBoard.classList.remove("toy-battle-board", "flip-triples-board", "player-0", "player-1");

  svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "lino-field");
  // The viewBox is the camera and is rewritten on every pan/zoom, so it is not
  // set here; applyCamera() installs it once the element has a size.
  svg.setAttribute("preserveAspectRatio", "none");

  linesLayer = document.createElementNS(SVG_NS, "g");
  svg.appendChild(linesLayer);

  previewLine = document.createElementNS(SVG_NS, "line");
  previewLine.setAttribute("class", `lino-preview ${PLAYER_CLASSES[mySeat()]} hidden`);
  svg.appendChild(previewLine);

  const dotsLayer = document.createElementNS(SVG_NS, "g");
  dotEls = new Map();
  highlighted = [];
  linoState.dots.forEach((dot) => {
    const group = document.createElementNS(SVG_NS, "g");
    group.setAttribute("class", `lino-dot${dot.shrine ? " shrine" : ""}`);

    let halo = null;
    if (dot.shrine) {
      halo = document.createElementNS(SVG_NS, "circle");
      halo.setAttribute("class", "lino-halo");
      halo.setAttribute("cx", dot.x);
      halo.setAttribute("cy", dot.y);
      group.appendChild(halo);
    }

    const core = document.createElementNS(SVG_NS, "circle");
    core.setAttribute("class", "lino-core");
    core.setAttribute("cx", dot.x);
    core.setAttribute("cy", dot.y);

    group.appendChild(core);
    dotsLayer.appendChild(group);
    dotEls.set(dot.id, { group, core, halo, shrine: !!dot.shrine });
  });
  svg.appendChild(dotsLayer);

  // One cost readout for the whole board, parked on whichever dot is hovered.
  costLabel = document.createElementNS(SVG_NS, "text");
  costLabel.setAttribute("class", "lino-cost hidden");
  svg.appendChild(costLabel);

  attachCameraControls();

  // Hit-testing is by proximity, not by SVG hit areas: zoomed out the dots
  // sit closer together than any sensible click target, and this way the dot
  // you click is always exactly the one the preview lit up.
  svg.addEventListener("click", (event) => {
    if (panned) {
      panned = false; // that click was the end of a drag
      return;
    }
    const target = hoveredDot(toBoardCoords(event));
    if (target) handleDotClick(target.id);
    else clearSelection();
  });

  els.gameBoard.appendChild(svg);
  els.gameBoard.appendChild(buildZoomControls());

  // Preserve the camera across rebuilds (destroyDots re-creates the board).
  if (camera) applyCamera();
  else resetCamera();
  scaleDots();

  resizeObserver?.disconnect();
  resizeObserver = new ResizeObserver(() => applyCamera());
  resizeObserver.observe(svg);
}

// Wheel to zoom (trackpad pinch arrives here as a ctrl-wheel), drag to pan.
// A drag shorter than DRAG_SLOP_PX still counts as a click so tapping a dot
// never gets swallowed.
function attachCameraControls() {
  svg.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const step = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      zoomAt(Math.exp(step * ZOOM_SENSITIVITY), event.clientX, event.clientY);
      updatePreview(lastCursor);
    },
    { passive: false }
  );

  svg.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 && event.button !== 1) return;
    panned = false;
    panState = { pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY, moved: 0 };
    svg.setPointerCapture(event.pointerId);
  });

  svg.addEventListener("pointermove", (event) => {
    if (!linoState) return;
    if (panState && panState.pointerId === event.pointerId) {
      const dx = event.clientX - panState.lastX;
      const dy = event.clientY - panState.lastY;
      panState.lastX = event.clientX;
      panState.lastY = event.clientY;
      panState.moved += Math.hypot(dx, dy);
      if (panState.moved > DRAG_SLOP_PX) {
        const unit = unitsPerPixel();
        camera.cx -= dx * unit;
        camera.cy -= dy * unit;
        svg.classList.add("panning");
        applyCamera();
        // Fall through: the cursor is over a different board point now, so the
        // preview has to be re-read against the new camera or it drifts.
      }
    }
    updatePreview(toBoardCoords(event));
  });

  // Only a real pointerup arms the click guard: a cancelled gesture never
  // produces a click, so the flag would linger and eat the next real one.
  const endPan = (event, dragged) => {
    if (!panState || panState.pointerId !== event.pointerId) return;
    panned = dragged && panState.moved > DRAG_SLOP_PX;
    svg.classList.remove("panning");
    svg.releasePointerCapture?.(event.pointerId);
    panState = null;
  };
  svg.addEventListener("pointerup", (event) => endPan(event, true));
  svg.addEventListener("pointercancel", (event) => endPan(event, false));

  svg.addEventListener("pointerleave", () => {
    if (!panState) updatePreview(null);
  });
}

function buildZoomControls() {
  const box = document.createElement("div");
  box.className = "lino-zoom";
  const buttons = [
    { label: "+", title: "Zoom in", run: () => zoomCentre(1 / 1.35) },
    { label: "−", title: "Zoom out", run: () => zoomCentre(1.35) },
    { label: "⌂", title: "Reset view", run: () => resetCamera() }
  ];
  buttons.forEach(({ label, title, run }) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.title = title;
    button.addEventListener("click", run);
    box.appendChild(button);
  });
  return box;
}

function renderLines() {
  linesLayer.innerHTML = "";
  lineEls = new Map();
  linoState.lines.forEach((line) => {
    const from = dotById(line.from);
    const to = dotById(line.to);
    if (!from || !to) return;
    const setCoords = (el) => {
      el.setAttribute("x1", from.x);
      el.setAttribute("y1", from.y);
      el.setAttribute("x2", to.x);
      el.setAttribute("y2", to.y);
    };
    // Brass reads as a metal casing: a gold jacket under the owner's color.
    if (line.brass) {
      const casing = document.createElementNS(SVG_NS, "line");
      casing.setAttribute("class", "lino-brass-casing");
      setCoords(casing);
      linesLayer.appendChild(casing);
    }
    const el = document.createElementNS(SVG_NS, "line");
    el.setAttribute("class", `lino-line ${PLAYER_CLASSES[line.player]}${line.brass ? " brass" : ""}`);
    setCoords(el);
    linesLayer.appendChild(el);
    lineEls.set(line.id, el);

    // Strength readout: the price to cut this line, drawn parallel to it and
    // nudged just off the pipe. Brass can't be cut at any price, so mark it ∞.
    if (linoState.settings?.showStrength) {
      const mx = (from.x + to.x) / 2;
      const my = (from.y + to.y) / 2;
      let angle = (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
      if (angle > 90) angle -= 180;
      else if (angle < -90) angle += 180; // keep the text upright
      const strength = document.createElementNS(SVG_NS, "text");
      strength.setAttribute("class", `lino-strength ${PLAYER_CLASSES[line.player]}`);
      strength.setAttribute("x", mx);
      strength.setAttribute("y", my - 1.5);
      strength.setAttribute("transform", `rotate(${angle} ${mx} ${my})`);
      strength.textContent = line.brass ? "∞" : line.cost;
      linesLayer.appendChild(strength);
    }
  });
}

function buildHud() {
  els.hand.innerHTML = "";
  els.hand.classList.add("lino-hud");
  els.hand.classList.remove("toy-rack", "flip-score", "player-0", "player-1");

  const mine = document.createElement("div");
  mine.className = `lino-money ${PLAYER_CLASSES[mySeat()]}`;
  els.hand.appendChild(mine);

  let theirs = null;
  if (!app.isSoloGame) {
    theirs = document.createElement("div");
    theirs.className = `lino-money ${PLAYER_CLASSES[1 - mySeat()]}`;
    els.hand.appendChild(theirs);
  }

  const banner = document.createElement("div");
  banner.className = "lino-banner hidden";
  els.hand.appendChild(banner);

  hud = { mine, theirs, banner };
  renderHud();
}

// Two stats per player: money in the bank (whole dollars, always rounded
// down) and production, the dollars per second that money is growing by.
function statsFor(seat) {
  const production =
    linoState.production?.[seat] ??
    productionFor(linoState.lines, seat, linoState.settings);
  return {
    money: displayMoney(linoState.money[seat]),
    // Up to two decimals, without the trailing zeros ("1", "2.4", "0.65").
    production: String(Math.round(production * 100) / 100)
  };
}

function renderHud() {
  if (!hud || !linoState) return;
  const seat = mySeat();
  const mine = statsFor(seat);
  hud.mine.innerHTML = `<strong>You $${mine.money}</strong><small>+$${mine.production}/s</small>`;
  if (hud.theirs) {
    const foe = statsFor(1 - seat);
    hud.theirs.innerHTML = `<strong>Opponent $${foe.money}</strong><small>+$${foe.production}/s</small>`;
  }

  if (isOver()) {
    hud.banner.classList.remove("hidden");
    const iWon = linoState.winner === seat;
    hud.banner.classList.toggle("win", iWon);
    hud.banner.textContent = iWon
      ? "Shrines connected — you win!"
      : "Opponent connected the shrines.";
  } else {
    hud.banner.classList.add("hidden");
  }

  els.turnStatus.textContent = isOver()
    ? "Game over"
    : "Race to connect the two shrines";
}

// A single AI opponent — it always plays its best game.
const OPPONENTS = [
  { label: "Play alone", bot: "none" },
  { label: "Play the AI", bot: "0" }
];

function closeSetup() {
  pendingSetup = null;
  els.linoSetup.classList.add("hidden");
}

function renderSetup() {
  const optionsBox = els.linoSetup.querySelector(".lino-options");
  optionsBox.innerHTML = "";
  SETTING_FIELDS.forEach((field) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `lino-option${chosenSettings[field.key] ? " on" : ""}`;
    row.dataset.key = field.key;
    row.setAttribute("aria-pressed", String(!!chosenSettings[field.key]));

    const text = document.createElement("span");
    text.className = "lino-option-text";
    const label = document.createElement("strong");
    label.textContent = field.label;
    const hint = document.createElement("small");
    hint.textContent = field.hint;
    text.append(label, hint);

    const toggle = document.createElement("span");
    toggle.className = "lino-toggle";
    toggle.textContent = chosenSettings[field.key] ? "On" : "Off";

    row.append(text, toggle);
    optionsBox.appendChild(row);
  });

  SLIDER_FIELDS.forEach((field) => {
    const range = SETTING_RANGES[field.key];
    const row = document.createElement("div");
    row.className = "lino-slider";

    const top = document.createElement("div");
    top.className = "lino-slider-top";
    const label = document.createElement("strong");
    label.textContent = field.label;
    const value = document.createElement("span");
    value.className = "lino-slider-value";
    value.textContent = field.format(chosenSettings[field.key]);
    top.append(label, value);

    const input = document.createElement("input");
    input.type = "range";
    input.min = String(range.min);
    input.max = String(range.max);
    input.step = String(range.step);
    input.value = String(chosenSettings[field.key]);
    input.addEventListener("input", () => {
      chosenSettings[field.key] = Number(input.value);
      value.textContent = field.format(chosenSettings[field.key]);
    });

    row.append(top, input);
    optionsBox.appendChild(row);
  });

  const playBox = els.linoSetup.querySelector(".lino-setup-play");
  playBox.innerHTML = "";
  if (pendingSetup?.mode === "solo") {
    const caption = document.createElement("p");
    caption.className = "modal-sub";
    caption.textContent = "Pick an opponent to start";
    playBox.appendChild(caption);
    const grid = document.createElement("div");
    grid.className = "lino-opponents";
    OPPONENTS.forEach((opponent) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "lino-play-btn";
      button.dataset.bot = opponent.bot;
      button.textContent = opponent.label;
      grid.appendChild(button);
    });
    playBox.appendChild(grid);
  } else {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "lino-play-btn primary";
    button.dataset.bot = "queue";
    button.textContent = "Play — find a match";
    playBox.appendChild(button);
  }
}

els.linoSetup.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target === els.linoSetup || target.closest(".lino-setup-cancel")) {
    closeSetup();
    return;
  }

  const option = target.closest(".lino-option");
  if (option?.dataset.key) {
    chosenSettings[option.dataset.key] = !chosenSettings[option.dataset.key];
    renderSetup();
    return;
  }

  const play = target.closest(".lino-play-btn");
  if (!play || !pendingSetup) return;
  const { onReady } = pendingSetup;
  const choice = play.dataset.bot;
  closeSetup();
  const options = { settings: { ...chosenSettings } };
  onReady(options, choice === "queue" || choice === "none" ? null : Number(choice));
});

socket.on("lino_tick", ({ money, groups, production } = {}) => {
  if (!isActive() || !linoState || !money) return;
  linoState.money = money;
  if (groups) linoState.groups = groups;
  if (production) linoState.production = production;
  renderHud();
  // Affordability may have just changed — refresh the hovered cost label.
  updatePreview(lastCursor);
});

export const lino = {
  id: "lino",
  name: "Lino",
  description: "",
  hasBots: true,
  botName: "the AI", // single-strength bot; shown in the lobby status line

  // The shell hands the whole pre-game flow over to us: rule toggles plus
  // opponent choice, then we call back to start the match.
  openSetup({ mode, onReady }) {
    pendingSetup = { mode, onReady };
    renderSetup();
    els.linoSetup.classList.remove("hidden");
  },

  handleState(payload, resetGameUi) {
    if (!payload.lino) return false;
    const firstRender = !linoState || !svg || !els.gameBoard.contains(svg);
    // Dots vanish when destroyDots is on, so the field has to be rebuilt.
    const dotsChanged = !firstRender && payload.lino.dots.length !== linoState.dots.length;
    linoState = payload.lino;
    if (firstRender) {
      resetGameUi();
      buildBoard();
      buildHud();
    } else if (dotsChanged) {
      buildBoard();
    }
    if (selectedDotId && !dotById(selectedDotId)) selectedDotId = null;
    renderLines();
    renderHud();
    updatePreview(lastCursor);
    return true;
  },

  resetUi() {
    els.gameBoard.classList.remove("lino-board");
    els.hand.classList.remove("lino-hud");
  },

  clearState() {
    resizeObserver?.disconnect();
    resizeObserver = null;
    linoState = null;
    svg = null;
    selectedDotId = null;
    lastCursor = null;
    hud = null;
    camera = null; // next match starts on the default view again
    panState = null;
    panned = false;
    zoomScale = 1;
    costLabel = null;
    highlighted = [];
    dotEls = new Map();
    lineEls = new Map();
  },

  onMatchFound() {
    this.clearState();
  },

  onOpponentLeft() {
    this.clearState();
  },

  onExit() {
    this.clearState();
  }
};
