// Lino client: real-time SVG board. Click a dot to anchor a line, then hover a
// second dot to see what connecting them costs. Building across an enemy line
// cuts it — the doomed lines flash red in the preview. First player to link
// both shrines wins.
import { socket, els, app } from "../../shared/context.js";
import {
  BOARD_WIDTH,
  BOARD_HEIGHT,
  DEFAULT_SETTINGS,
  SETTING_RANGES,
  evaluateBuild,
  resolveDestruction
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
    key: "baseIncomeSecs",
    label: "Base income ($1)",
    format: (v) => `every ${trimNum(v)}s`
  },
  {
    key: "groupIncomeSecs",
    label: "Network income",
    format: (v) => `every ${trimNum(v)}s`
  },
  {
    key: "dotCount",
    label: "Dots on the board",
    format: (v) => trimNum(v)
  }
];

const SVG_NS = "http://www.w3.org/2000/svg";
const PLAYER_CLASSES = ["lino-p0", "lino-p1"];
const HOVER_RADIUS = 5; // board units — how close the cursor must be to light a dot

let linoState = null;
let selectedDotId = null;
let lastCursor = null;
let svg = null;
let linesLayer = null;
let previewLine = null;
let dotEls = new Map(); // dotId -> { group, label }
let lineEls = new Map(); // lineId -> <line>
let hud = null; // { mine, theirs, banner }
let pendingSetup = null; // { mode, onReady } while the setup screen is open
let chosenSettings = { ...DEFAULT_SETTINGS };

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
function hoveredDot(cursor) {
  if (!cursor) return null;
  let best = null;
  let bestDistance = HOVER_RADIUS;
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

  dotEls.forEach(({ group, label }, dotId) => {
    group.classList.toggle("selected", dotId === selectedDotId);
    group.classList.remove("lit", "blocked", "doomed");
    label.classList.add("hidden");
  });
  lineEls.forEach((el) => el.classList.remove("doomed"));

  const target = live ? hoveredDot(cursor) : null;
  if (!target) return;

  const result = evaluate(target.id);
  if (result.reason === "exists" || result.reason === "invalid") return;

  const el = dotEls.get(target.id);
  if (!el) return;
  el.group.classList.add("lit");
  el.group.classList.toggle("blocked", !result.ok);
  el.label.classList.remove("hidden");

  if (result.reason === "self-cross") {
    el.label.textContent = "blocked";
  } else if (result.reason === "taken") {
    el.label.textContent = "taken";
  } else if (result.reason === "brass") {
    el.label.textContent = "brass wall";
  } else if (result.reason === "too-short") {
    el.label.textContent = "too short";
  } else {
    el.label.textContent = `$${result.cost}`;
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
    lineIds.forEach((lineId) => lineEls.get(lineId)?.classList.add("doomed"));
    dotIds.forEach((dotId) => dotEls.get(dotId)?.group.classList.add("doomed"));
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
  svg.setAttribute("viewBox", `0 0 ${BOARD_WIDTH} ${BOARD_HEIGHT}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

  linesLayer = document.createElementNS(SVG_NS, "g");
  svg.appendChild(linesLayer);

  previewLine = document.createElementNS(SVG_NS, "line");
  previewLine.setAttribute("class", `lino-preview ${PLAYER_CLASSES[mySeat()]} hidden`);
  svg.appendChild(previewLine);

  dotEls = new Map();
  linoState.dots.forEach((dot) => {
    const group = document.createElementNS(SVG_NS, "g");
    group.setAttribute("class", `lino-dot${dot.shrine ? " shrine" : ""}`);
    group.dataset.dotId = dot.id;

    // Oversized invisible circle so dots are easy to click.
    const hit = document.createElementNS(SVG_NS, "circle");
    hit.setAttribute("class", "lino-hit");
    hit.setAttribute("cx", dot.x);
    hit.setAttribute("cy", dot.y);
    hit.setAttribute("r", 4);

    if (dot.shrine) {
      const halo = document.createElementNS(SVG_NS, "circle");
      halo.setAttribute("class", "lino-halo");
      halo.setAttribute("cx", dot.x);
      halo.setAttribute("cy", dot.y);
      halo.setAttribute("r", 3.6);
      group.appendChild(halo);
    }

    const core = document.createElementNS(SVG_NS, "circle");
    core.setAttribute("class", "lino-core");
    core.setAttribute("cx", dot.x);
    core.setAttribute("cy", dot.y);
    core.setAttribute("r", dot.shrine ? 2.4 : 1.6);

    const label = document.createElementNS(SVG_NS, "text");
    label.setAttribute("class", "lino-cost hidden");
    label.setAttribute("x", dot.x);
    label.setAttribute("y", dot.y - (dot.shrine ? 4.4 : 3.2));

    group.appendChild(hit);
    group.appendChild(core);
    group.appendChild(label);
    svg.appendChild(group);
    dotEls.set(dot.id, { group, label });
  });

  svg.addEventListener("mousemove", (event) => {
    if (!linoState) return;
    updatePreview(toBoardCoords(event));
  });

  svg.addEventListener("mouseleave", () => updatePreview(null));

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

function renderHud() {
  if (!hud || !linoState) return;
  const seat = mySeat();
  const groups = linoState.groups || [0, 0];
  const per = trimNum(linoState.settings?.groupIncomeSecs ?? DEFAULT_SETTINGS.groupIncomeSecs);
  hud.mine.innerHTML = `<strong>You $${linoState.money[seat]}</strong><small>group ${groups[seat]} · +${groups[seat]}/${per}s</small>`;
  if (hud.theirs) {
    const foe = 1 - seat;
    hud.theirs.innerHTML = `<strong>Opponent $${linoState.money[foe]}</strong><small>group ${groups[foe]} · +${groups[foe]}/${per}s</small>`;
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

socket.on("lino_tick", ({ money, groups } = {}) => {
  if (!isActive() || !linoState || !money) return;
  linoState.money = money;
  if (groups) linoState.groups = groups;
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
    linoState = null;
    svg = null;
    selectedDotId = null;
    lastCursor = null;
    hud = null;
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
