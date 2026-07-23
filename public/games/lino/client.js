// Lino client: real-time SVG board. Click a dot to anchor a line, follow the
// mouse, and dots within range light up with the cost to link them. Money
// ticks in from the server every 0.5s via "lino_tick".
import { socket, els, app } from "../../shared/context.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const STATUS_LABEL = "Real-time — click a dot to start a line";
const PLAYER_CLASSES = ["lino-p0", "lino-p1"];
const HOVER_RADIUS = 5; // board units — how close the cursor must be to light a dot

let linoState = null;
let selectedDotId = null;
let svg = null;
let linesLayer = null;
let previewLine = null;
let dotEls = new Map(); // dotId -> { group, circle, label }
let moneyEls = null; // { mine, theirs }

function isActive() {
  return app.currentGame?.id === "lino";
}

function mySeat() {
  return app.myPlayerIndex ?? 0;
}

function dotById(id) {
  return linoState?.dots.find((dot) => dot.id === id) ?? null;
}

function hasLine(aId, bId) {
  return linoState.lines.some(
    (line) =>
      (line.from === aId && line.to === bId) || (line.from === bId && line.to === aId)
  );
}

function costBetween(a, b) {
  return Math.max(1, Math.ceil(Math.hypot(a.x - b.x, a.y - b.y) * linoState.costPerUnit));
}

function toBoardCoords(event) {
  const point = svg.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  return point.matrixTransform(svg.getScreenCTM().inverse());
}

function clearSelection() {
  selectedDotId = null;
  updatePreview(null);
}

// Refresh the cursor-following preview line and the hover cost labels. A dot
// only lights up (with its cost) when the cursor is right next to it.
// `cursor` is board coords, or null to hide everything.
function updatePreview(cursor) {
  if (!svg || !linoState) return;
  const origin = selectedDotId ? dotById(selectedDotId) : null;

  if (!origin || !cursor) {
    previewLine.classList.add("hidden");
  } else {
    previewLine.classList.remove("hidden");
    previewLine.setAttribute("x1", origin.x);
    previewLine.setAttribute("y1", origin.y);
    previewLine.setAttribute("x2", cursor.x);
    previewLine.setAttribute("y2", cursor.y);
  }

  const money = linoState.money[mySeat()];
  linoState.dots.forEach((dot) => {
    const el = dotEls.get(dot.id);
    if (!el) return;
    el.group.classList.toggle("selected", dot.id === selectedDotId);
    let lit = false;
    let affordable = false;
    if (
      origin &&
      cursor &&
      dot.id !== selectedDotId &&
      !hasLine(selectedDotId, dot.id) &&
      Math.hypot(dot.x - cursor.x, dot.y - cursor.y) <= HOVER_RADIUS
    ) {
      lit = true;
      const cost = costBetween(origin, dot);
      affordable = money >= cost;
      el.label.textContent = `$${cost}`;
    }
    el.group.classList.toggle("in-range", lit);
    el.group.classList.toggle("unaffordable", lit && !affordable);
    el.label.classList.toggle("hidden", !lit);
  });
}

function handleDotClick(dotId) {
  if (!selectedDotId) {
    selectedDotId = dotId;
    updatePreview(null);
    return;
  }
  if (dotId === selectedDotId) {
    clearSelection();
    return;
  }
  const origin = dotById(selectedDotId);
  const target = dotById(dotId);
  if (hasLine(selectedDotId, dotId)) return;
  if (linoState.money[mySeat()] < costBetween(origin, target)) return;
  socket.emit("lino_build", { roomId: app.roomId, fromId: selectedDotId, toId: dotId });
  clearSelection();
}

function buildBoard() {
  els.gameBoard.innerHTML = "";
  els.gameBoard.classList.add("lino-board");
  els.gameBoard.classList.remove("toy-battle-board", "flip-triples-board", "player-0", "player-1");

  svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "lino-field");
  svg.setAttribute("viewBox", "0 0 160 100");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

  linesLayer = document.createElementNS(SVG_NS, "g");
  svg.appendChild(linesLayer);

  previewLine = document.createElementNS(SVG_NS, "line");
  previewLine.setAttribute("class", `lino-preview ${PLAYER_CLASSES[mySeat()]} hidden`);
  svg.appendChild(previewLine);

  dotEls = new Map();
  linoState.dots.forEach((dot) => {
    const group = document.createElementNS(SVG_NS, "g");
    group.setAttribute("class", "lino-dot");
    group.dataset.dotId = dot.id;

    // Oversized invisible circle so dots are easy to click.
    const hit = document.createElementNS(SVG_NS, "circle");
    hit.setAttribute("class", "lino-hit");
    hit.setAttribute("cx", dot.x);
    hit.setAttribute("cy", dot.y);
    hit.setAttribute("r", 4);

    const circle = document.createElementNS(SVG_NS, "circle");
    circle.setAttribute("class", "lino-core");
    circle.setAttribute("cx", dot.x);
    circle.setAttribute("cy", dot.y);
    circle.setAttribute("r", 1.6);

    const label = document.createElementNS(SVG_NS, "text");
    label.setAttribute("class", "lino-cost hidden");
    label.setAttribute("x", dot.x);
    label.setAttribute("y", dot.y - 3.2);

    group.appendChild(hit);
    group.appendChild(circle);
    group.appendChild(label);
    svg.appendChild(group);
    dotEls.set(dot.id, { group, circle, label });
  });

  svg.addEventListener("mousemove", (event) => {
    if (!selectedDotId) return;
    updatePreview(toBoardCoords(event));
  });

  svg.addEventListener("click", (event) => {
    const dotGroup = event.target.closest?.(".lino-dot");
    if (dotGroup) {
      handleDotClick(dotGroup.dataset.dotId);
    } else {
      clearSelection();
    }
  });

  els.gameBoard.appendChild(svg);
}

function renderLines() {
  linesLayer.innerHTML = "";
  linoState.lines.forEach((line) => {
    const from = dotById(line.from);
    const to = dotById(line.to);
    if (!from || !to) return;
    const el = document.createElementNS(SVG_NS, "line");
    el.setAttribute("class", `lino-line ${PLAYER_CLASSES[line.player]}`);
    el.setAttribute("x1", from.x);
    el.setAttribute("y1", from.y);
    el.setAttribute("x2", to.x);
    el.setAttribute("y2", to.y);
    linesLayer.appendChild(el);
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
  moneyEls = { mine, theirs };
  renderMoney();
}

function renderMoney() {
  if (!moneyEls || !linoState) return;
  const seat = mySeat();
  moneyEls.mine.textContent = `You $${linoState.money[seat]}`;
  if (moneyEls.theirs) {
    moneyEls.theirs.textContent = `Opponent $${linoState.money[1 - seat]}`;
  }
}

socket.on("lino_tick", ({ money } = {}) => {
  if (!isActive() || !linoState || !money) return;
  linoState.money = money;
  renderMoney();
  // The shell's turn text doesn't apply to a real-time game; keep it overridden.
  els.turnStatus.textContent = STATUS_LABEL;
});

export const lino = {
  id: "lino",
  name: "Lino",
  description: "",

  handleState(payload, resetGameUi) {
    if (!payload.lino) return false;
    const firstRender = !linoState || !svg || !els.gameBoard.contains(svg);
    linoState = payload.lino;
    if (firstRender) {
      resetGameUi();
      buildBoard();
      buildHud();
    }
    renderLines();
    renderMoney();
    updatePreview(null);
    els.turnStatus.textContent = STATUS_LABEL;
    return true;
  },

  resetUi() {
    els.gameBoard.classList.remove("lino-board");
    els.hand.classList.remove("lino-hud");
  },

  clearState() {
    linoState = null;
    svg = null;
    selectedDotId = null;
    moneyEls = null;
    dotEls = new Map();
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
