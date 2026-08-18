// Only 3 client: the 6x6 lattice, the three-color palette, and the score panel.
// Scoring triples are drawn as strokes through the three cell centres on an SVG
// overlay, so a run that scores for both sides (an all-purple one) shows two
// lines side by side.
import { socket, els, app, setBotThinking } from "../../shared/context.js";

const SIZE = 6;
const RED = 1;
const BLUE = 2;
const PURPLE = 3;
const COLOR_NAME = { [RED]: "red", [BLUE]: "blue", [PURPLE]: "purple" };
const SEAT_COLORS = [RED, BLUE];

let only3State = null;
let selectedColor = RED;
let pickedThisMatch = false;
let lastSeatSeen = null;

function isActive() {
  return app.currentGame?.id === "only-3";
}

// In solo play the single human drives both seats, so the seat that matters is
// whichever one is to move.
function mySeat() {
  if (!only3State) return 0;
  return app.isSoloGame ? only3State.toMove : app.myPlayerIndex ?? 0;
}

function myColor() {
  return SEAT_COLORS[mySeat()];
}

function canPlay() {
  if (!only3State || only3State.gameOver) return false;
  if (app.isSoloGame) return true;
  return only3State.toMove === (app.myPlayerIndex ?? 0);
}

function renderBoard() {
  if (!only3State) return;
  els.gameBoard.innerHTML = "";
  els.gameBoard.classList.remove("toy-battle-board", "flip-triples-board", "player-0", "player-1");
  els.gameBoard.classList.add("only-3-board");
  els.gameBoard.style.setProperty("--only3-pick", `var(--only3-${COLOR_NAME[selectedColor]})`);
  els.gameBoard.classList.toggle("locked", !canPlay());

  const playable = canPlay();
  for (let cell = 0; cell < SIZE * SIZE; cell += 1) {
    const value = only3State.board[cell];
    const button = document.createElement("button");
    button.type = "button";
    button.className = "only3-cell";
    button.dataset.cell = String(cell);
    button.disabled = value !== 0 || !playable;
    if (only3State.lastMove?.cell === cell) button.classList.add("last-move");

    const stone = document.createElement("span");
    stone.className = "only3-stone";
    if (value !== 0) stone.classList.add(COLOR_NAME[value]);
    button.appendChild(stone);
    els.gameBoard.appendChild(button);
  }

  els.gameBoard.appendChild(renderTripleOverlay());
}

function renderTripleOverlay() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "only3-triples");
  svg.setAttribute("viewBox", `0 0 ${SIZE} ${SIZE}`);
  svg.setAttribute("aria-hidden", "true");

  (only3State?.triples ?? []).forEach((triple) => {
    const [start, , end] = triple.cells;
    const x1 = (start % SIZE) + 0.5;
    const y1 = Math.floor(start / SIZE) + 0.5;
    const x2 = (end % SIZE) + 0.5;
    const y2 = Math.floor(end / SIZE) + 0.5;
    // Nudge the two colors to opposite sides of the run so a triple that scores
    // for both players shows as two parallel strokes rather than one.
    const length = Math.hypot(x2 - x1, y2 - y1) || 1;
    const offset = triple.color === "red" ? -0.075 : 0.075;
    const nx = (-(y2 - y1) / length) * offset;
    const ny = ((x2 - x1) / length) * offset;

    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", String(x1 + nx));
    line.setAttribute("y1", String(y1 + ny));
    line.setAttribute("x2", String(x2 + nx));
    line.setAttribute("y2", String(y2 + ny));
    line.setAttribute("class", `only3-triple-line ${triple.color}`);
    svg.appendChild(line);
  });
  return svg;
}

function renderPanel() {
  els.hand.innerHTML = "";
  els.hand.classList.remove("toy-rack", "flip-score", "player-0", "player-1");
  els.hand.classList.add("only-3-panel");
  if (!only3State) return;

  const scores = only3State.scores ?? { red: 0, blue: 0 };
  const stones = only3State.stones ?? { red: 0, blue: 0, purple: 0 };
  const leader = scores.red === scores.blue ? null : scores.red > scores.blue ? "red" : "blue";

  const scoreRow = document.createElement("div");
  scoreRow.className = "only3-scores";
  [
    { side: "red", score: scores.red, stones: stones.red },
    { side: "blue", score: scores.blue, stones: stones.blue }
  ].forEach(({ side, score, stones: own }) => {
    const box = document.createElement("div");
    box.className = `only3-score ${side}${leader === side ? " leading" : ""}`;
    box.innerHTML = `
      <span class="only3-score-dot"></span>
      <strong>${score}</strong>
      <small>${own} stones</small>
    `;
    scoreRow.appendChild(box);
  });
  els.hand.appendChild(scoreRow);

  const palette = document.createElement("div");
  palette.className = "only3-palette";
  const own = myColor();
  [RED, BLUE, PURPLE].forEach((color) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `only3-swatch ${COLOR_NAME[color]}${color === selectedColor ? " selected" : ""}`;
    button.dataset.color = String(color);
    button.disabled = !canPlay();
    const tag = color === own ? "yours" : color === PURPLE ? "neutral" : "theirs";
    button.innerHTML = `
      <span class="only3-swatch-dot"></span>
      <span class="only3-swatch-name">${COLOR_NAME[color]}</span>
      <small>${tag}</small>
    `;
    palette.appendChild(button);
  });
  els.hand.appendChild(palette);

  if (!only3State.gameOver) {
    const hint = document.createElement("p");
    hint.className = "only3-hint";
    hint.textContent =
      `${SIZE * SIZE - only3State.moveCount} squares left · exactly three in a row scores, four or more scores nothing · purple counts for both`;
    els.hand.appendChild(hint);
  }

  if (only3State.gameOver) {
    const banner = document.createElement("div");
    banner.className = `only3-winner ${only3State.winner}`;
    banner.textContent = winnerText();
    els.hand.appendChild(banner);

    const again = document.createElement("button");
    again.type = "button";
    again.className = "primary-btn only3-again";
    again.textContent = "Play again";
    els.hand.appendChild(again);
  }
}

// Always reads winner-first, so "Red wins 5-4" can never look like a loss.
function winnerText() {
  if (!only3State) return "";
  const { winner, scores, stones } = only3State;
  if (winner === "draw") return `Draw — ${scores.red}-${scores.blue} triples and the same stone count`;
  const side = winner === "red" ? "Red" : "Blue";
  const won = winner === "red" ? scores.red : scores.blue;
  const lost = winner === "red" ? scores.blue : scores.red;
  if (won === lost) {
    const own = winner === "red" ? stones.red : stones.blue;
    const other = winner === "red" ? stones.blue : stones.red;
    return `${side} takes the tiebreak at ${won}-${lost} triples — fewer own stones (${own} vs ${other})`;
  }
  return `${side} wins ${won}-${lost} on triples`;
}

function updateOnly3Turn() {
  if (!only3State) return;
  if (only3State.gameOver) {
    els.turnStatus.textContent = `Game over — ${winnerText()}`;
    setBotThinking(false);
    return;
  }
  const side = only3State.toMove === 0 ? "Red" : "Blue";
  const mine = canPlay();
  els.turnStatus.textContent = app.isSoloGame
    ? `${side} to move`
    : mine
    ? `Your turn — ${side}`
    : `Opponent's turn — ${side}`;
  setBotThinking(app.isBotGame && !mine);
}

els.hand.addEventListener("click", (event) => {
  if (!isActive() || !only3State) return;
  const target = event.target;
  if (!(target instanceof Element)) return;

  if (target.closest(".only3-again")) {
    if (app.roomId) socket.emit("only_3_restart", { roomId: app.roomId });
    return;
  }

  const swatch = target.closest(".only3-swatch");
  if (!swatch) return;
  selectedColor = Number(swatch.dataset.color);
  pickedThisMatch = true;
  renderBoard();
  renderPanel();
});

els.gameBoard.addEventListener("click", (event) => {
  if (!isActive() || !only3State || only3State.gameOver) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  const cellButton = target.closest(".only3-cell");
  if (!cellButton || !app.roomId) return;
  const cell = Number(cellButton.dataset.cell);
  if (only3State.board[cell] !== 0 || !canPlay()) return;
  socket.emit("only_3_place", { roomId: app.roomId, cell, color: selectedColor });
});

// 1/2/3 pick red/blue/purple without leaving the board.
window.addEventListener("keydown", (event) => {
  if (!isActive() || !only3State || only3State.gameOver) return;
  const color = { 1: RED, 2: BLUE, 3: PURPLE }[event.key];
  if (!color) return;
  selectedColor = color;
  pickedThisMatch = true;
  renderBoard();
  renderPanel();
});

function resetUi() {
  els.gameBoard.classList.remove("only-3-board", "locked");
  els.gameBoard.style.removeProperty("--only3-pick");
  els.hand.classList.remove("only-3-panel");
}

export const only3 = {
  id: "only-3",
  name: "Only 3",
  hasBots: true,

  handleState(payload, resetGameUi) {
    if (!payload.only3) return false;
    const fresh = !only3State || payload.only3.moveCount < only3State.moveCount;
    only3State = payload.only3;
    // Solo play alternates sides on one screen, so a hand-picked color applies
    // to that turn only and the default returns to the new seat's own color.
    if (fresh || (app.isSoloGame && only3State.toMove !== lastSeatSeen)) pickedThisMatch = false;
    lastSeatSeen = only3State.toMove;
    if (!pickedThisMatch) selectedColor = myColor();
    resetGameUi();
    renderBoard();
    renderPanel();
    updateOnly3Turn();
    return true;
  },

  handleTurn() {
    if (!isActive() || !only3State) return false;
    updateOnly3Turn();
    return true;
  },

  clearState() {
    only3State = null;
  },

  resetUi,

  onMatchFound() {
    pickedThisMatch = false;
  },

  onOpponentLeft() {
    only3State = null;
  },

  onExit() {
    only3State = null;
    pickedThisMatch = false;
    lastSeatSeen = null;
    selectedColor = RED;
  }
};
