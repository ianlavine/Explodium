// Flip Triples client: setup screen, board rendering, swap/flip animations,
// phase 2 banner, score panel, and the undo button.
import { socket, els, app, setBotThinking, prefersReducedMotion } from "../../shared/context.js";

const flipPhaseIndicator = document.getElementById("flip-phase-indicator");
const flipSetup = document.getElementById("flip-setup");
const flipColorPick = document.getElementById("flip-color-pick");
const flipPhase2Banner = document.getElementById("flip-phase2-banner");
const flipUndoBtn = document.getElementById("flip-undo-btn");
const flipDoubleBtn = document.getElementById("flip-double-btn");

let flipTriplesState = null;
let selectedFlipPiece = null;
let lastAnimatedMoveId = 0;
let flipSwapBusy = false;
let flipPhase2Pressed = false;
let lastTransitionId = 0;
let flipSetupDraft = null;
let lastFlipTurn = null;

const FLIP_BOARD_5X5 = { boardSize: "5x5", cols: 5, rows: 5, cells: 25, centerRow: 2, centerCol: 2, label: "5×5" };
const FLIP_BOARD_4X6 = { boardSize: "4x6", cols: 4, rows: 6, cells: 24, centerRow: null, centerCol: null, label: "4×6" };

function flipBoardPreset(boardSize) {
  return boardSize === "4x6" ? FLIP_BOARD_4X6 : FLIP_BOARD_5X5;
}

function isActive() {
  return app.currentGame?.id === "flip-triples";
}

function defaultFlipSetupDraft() {
  return {
    purple: false,
    yellow: false,
    rings: false,
    doubleMove: false
  };
}

// The setup screen only exposes a few toggles; everything else is fixed to the
// standard 4x6 basic game (9 scoring pieces each, unique swap on). Purple
// replaces a scoring piece per player; yellow only replaces a neutral.
function flipDraftToOptions(draft) {
  const purple = draft.purple ? 1 : 0;
  const yellow = draft.yellow ? 1 : 0;
  const rings = draft.rings ? 1 : 0; // one red + one blue ring
  return {
    boardSize: "4x6",
    // Rings replace a scoring-piece pair (one red + one blue), so the neutral
    // count is unchanged; purple likewise takes a scoring slot.
    playerPieces: 9 - purple - rings,
    purple,
    yellow,
    hopper: 0,
    rings,
    mode: "basic",
    extendedRule: "none",
    uniqueSwap: true,
    staticNeutrals: false,
    protectedMiddle: false,
    doubleMove: draft.doubleMove === true
  };
}

function getFlipPiece(row, col) {
  return flipTriplesState?.board?.[row]?.[col] ?? null;
}

function getFlipShape(piece) {
  if (!piece) return "";
  switch (piece.shape) {
    case "red-x":
      return `<span class="flip-symbol red-x" aria-hidden="true">×</span>`;
    case "blue-o":
      return `<span class="flip-symbol blue-o" aria-hidden="true"></span>`;
    case "purple":
      return `<span class="flip-symbol purple" aria-hidden="true"><span class="purple-ring"></span><span class="purple-x">×</span></span>`;
    case "yellow":
      return `<span class="flip-symbol yellow" aria-hidden="true"><span class="yellow-minus">−</span></span>`;
    case "hopper":
      return `<span class="flip-symbol hopper" aria-hidden="true">H</span>`;
    case "red-ring":
    case "blue-ring":
      // The ring's color lives on the piece's border (see .shape-*-ring in the
      // stylesheet); the face stays blank/white like a neutral.
      return "";
    default:
      return "";
  }
}

function isSelectableFlipPiece(piece) {
  if (
    !piece ||
    flipTriplesState?.gameOver ||
    flipTriplesState?.setup ||
    flipTriplesState?.pickingColor ||
    flipTriplesState?.pendingPhase2
  ) {
    return false;
  }
  return flipTriplesState?.phase === 2 ? piece.flipped : !piece.flipped;
}

function myFlipColor() {
  return flipTriplesState?.seatColors?.[app.myPlayerIndex] ?? null;
}

function ringColorOf(piece) {
  if (!piece) return null;
  return piece.shape === "red-ring" ? "red" : piece.shape === "blue-ring" ? "blue" : null;
}

// A ring can only be flipped (led as the first piece) by the player of its
// color; either player may still slide it (select it second).
function canFlipRing(piece) {
  const ringColor = ringColorOf(piece);
  if (!ringColor) return true;
  if (app.isSoloGame) return true;
  return myFlipColor() === ringColor;
}

// The first piece in a swap is the one that flips, so it can never be protected,
// and a ring can only be flipped by the player of its color.
function canSelectFirstPiece(piece) {
  if (!isSelectableFlipPiece(piece)) return false;
  if (piece.protected) return false;
  if (!canFlipRing(piece)) return false;
  return true;
}

function flipSwapPairAllowed(first, second, settings = {}, toRow = null, toCol = null) {
  if (settings.uniqueSwap && first && first.shape === second.shape) return false;
  if (settings.staticNeutrals && second.shape === "neutral") return false;
  const preset = flipBoardPreset(settings.boardSize);
  if (
    settings.protectedMiddle &&
    preset.centerRow != null &&
    toRow === preset.centerRow &&
    toCol === preset.centerCol
  ) {
    return false;
  }
  return true;
}

function canSwapFlip(firstPos, secondPos) {
  const first = getFlipPiece(firstPos.row, firstPos.col);
  const second = getFlipPiece(secondPos.row, secondPos.col);
  if (!isSelectableFlipPiece(second)) return false;
  // A ring may be the sliding (second) piece for either player, so no ownership
  // check is needed here.
  if (
    !flipSwapPairAllowed(
      first,
      second,
      flipTriplesState?.settings ?? {},
      secondPos.row,
      secondPos.col
    )
  ) {
    return false;
  }
  const dist = Math.max(Math.abs(firstPos.row - secondPos.row), Math.abs(firstPos.col - secondPos.col));
  if (dist === 0) return false;
  if (second.shape === "hopper") return true; // a hopper can swap with any swappable piece
  return dist === 1;
}

function getFlipPhaseLabel() {
  if (flipTriplesState?.settings?.mode === "basic") return "Single phase";
  return flipTriplesState?.phase === 2 ? "Phase 2 (Black)" : "Phase 1 (White)";
}

function getFlipPhaseName() {
  return flipTriplesState?.phase === 2 ? "Phase 2" : "Phase 1";
}

function myFlipColorSuffix() {
  if (app.isSoloGame) return "";
  const color = myFlipColor();
  if (color === "red") return " · You are Red ×";
  if (color === "blue") return " · You are Blue ○";
  return "";
}

function updateFlipTriplesTurn(turn) {
  lastFlipTurn = turn;
  const isMyTurn = turn === app.myId || app.isSoloGame;
  els.turnStatus.textContent = `${getFlipPhaseLabel()} - ${
    isMyTurn ? "Your turn" : "Opponent's turn"
  }${myFlipColorSuffix()}`;
  setBotThinking(app.isBotGame && !isMyTurn);
  renderFlipDoubleBtn();
}

function renderFlipTriplesBoard() {
  if (!flipTriplesState) return;
  renderFlipPhaseIndicator();
  els.gameBoard.innerHTML = "";
  els.gameBoard.classList.remove("player-0", "player-1", "toy-battle-board");
  els.gameBoard.classList.add("flip-triples-board");
  const preset = flipBoardPreset(flipTriplesState.settings?.boardSize);
  els.gameBoard.style.setProperty("--flip-cols", String(preset.cols));
  els.gameBoard.classList.toggle("flip-board-4x6", preset.boardSize === "4x6");

  flipTriplesState.board.forEach((row, rowIndex) => {
    row.forEach((piece, colIndex) => {
      const button = document.createElement("button");
      button.type = "button";
      const classes = ["flip-piece", `shape-${piece.shape}`];
      if (piece.flipped) classes.push("flipped");
      if (piece.opportunity) classes.push("opportunity");
      if (piece.protected) classes.push("protected");
      if (piece.swapped) classes.push("swapped");
      button.className = classes.join(" ");
      if (selectedFlipPiece?.row === rowIndex && selectedFlipPiece?.col === colIndex) {
        button.classList.add("selected");
      }
      button.dataset.row = String(rowIndex);
      button.dataset.col = String(colIndex);
      // A ring is always at least a valid second (sliding) piece, so only fully
      // unselectable pieces are disabled; first-piece ownership is enforced on click.
      button.disabled = !isSelectableFlipPiece(piece);
      button.innerHTML = getFlipShape(piece);
      els.gameBoard.appendChild(button);
    });
  });
}

function getFlipPieceButton(row, col) {
  return els.gameBoard.querySelector(`.flip-piece[data-row="${row}"][data-col="${col}"]`);
}

function animateFlipSwap(move) {
  if (!move || !move.from || !move.to) return;
  if (prefersReducedMotion()) return;

  // After re-render: `to` cell holds the moved (first) piece, `from` cell holds
  // the piece it swapped with. Slide them out of each other's old positions.
  const movedBtn = getFlipPieceButton(move.to.row, move.to.col);
  const partnerBtn = getFlipPieceButton(move.from.row, move.from.col);
  if (!movedBtn || !partnerBtn) return;

  const movedRect = movedBtn.getBoundingClientRect();
  const partnerRect = partnerBtn.getBoundingClientRect();
  const dx = partnerRect.left - movedRect.left;
  const dy = partnerRect.top - movedRect.top;
  const len = Math.hypot(dx, dy) || 1;
  const bump = Math.min(28, len * 0.34);
  const px = (-dy / len) * bump;
  const py = (dx / len) * bump;

  flipSwapBusy = true;
  // Keep the moved piece showing its old color until it settles, so the recolor
  // reads as a distinct step after the slide.
  movedBtn.classList.add("swapping", "show-prev-color");
  partnerBtn.classList.add("swapping");

  const slideOptions = { duration: 360, easing: "cubic-bezier(0.45, 0, 0.2, 1)" };

  movedBtn.animate(
    [
      { transform: `translate(${dx}px, ${dy}px)` },
      { transform: `translate(${dx / 2 + px}px, ${dy / 2 + py}px)` },
      { transform: "translate(0px, 0px)" }
    ],
    slideOptions
  );

  const partnerSlide = partnerBtn.animate(
    [
      { transform: `translate(${-dx}px, ${-dy}px)` },
      { transform: `translate(${-dx / 2 - px}px, ${-dy / 2 - py}px)` },
      { transform: "translate(0px, 0px)" }
    ],
    slideOptions
  );

  partnerSlide.onfinish = () => {
    partnerBtn.classList.remove("swapping");
    movedBtn.classList.remove("swapping");
    playFlipRecolor(movedBtn);
  };
  partnerSlide.oncancel = () => {
    flipSwapBusy = false;
  };
}

function playFlipRecolor(button) {
  if (!button) {
    flipSwapBusy = false;
    return;
  }
  // Show the previous color, then flip edge-on and reveal the new color.
  button.classList.add("recoloring", "show-prev-color");
  const flip = button.animate(
    [
      { transform: "perspective(460px) rotateY(0deg)" },
      { transform: "perspective(460px) rotateY(90deg)" },
      { transform: "perspective(460px) rotateY(90deg)" },
      { transform: "perspective(460px) rotateY(0deg)" }
    ],
    { duration: 460, easing: "ease-in-out" }
  );
  const reveal = setTimeout(() => button.classList.remove("show-prev-color"), 220);
  flip.onfinish = () => {
    clearTimeout(reveal);
    button.classList.remove("recoloring", "show-prev-color");
    flipSwapBusy = false;
  };
  flip.oncancel = () => {
    clearTimeout(reveal);
    button.classList.remove("recoloring", "show-prev-color");
    flipSwapBusy = false;
  };
}

function renderFlipPhaseIndicator() {
  if (!flipTriplesState) {
    resetUi();
    return;
  }
  // The phase circle is only meaningful in the extended (two-phase) game.
  if (flipTriplesState.settings?.mode !== "extended") {
    flipPhaseIndicator.classList.add("hidden");
    flipPhaseIndicator.classList.remove("white-phase", "black-phase");
    return;
  }
  const isBlackPhase = flipTriplesState.phase === 2;
  flipPhaseIndicator.classList.remove("hidden", "white-phase", "black-phase");
  flipPhaseIndicator.classList.add(isBlackPhase ? "black-phase" : "white-phase");
  flipPhaseIndicator.textContent = getFlipPhaseName();
}

function renderFlipTriplesScore() {
  els.hand.innerHTML = "";
  els.hand.classList.remove("player-0", "player-1", "toy-rack");
  els.hand.classList.add("flip-score");

  const scores = flipTriplesState?.scores ?? { red: 0, blue: 0 };
  const rows = [
    { side: "red", mark: "×", score: scores.red },
    { side: "blue", mark: '<span class="ring"></span>', score: scores.blue }
  ];
  const leader = scores.red === scores.blue ? null : scores.red > scores.blue ? "red" : "blue";
  rows.forEach(({ side, mark, score }) => {
    const row = document.createElement("div");
    row.className = `flip-score-row compact ${side}${leader === side ? " leading" : ""}`;
    row.innerHTML = `
      <span class="flip-score-mark">${mark}</span>
      <strong>${score}</strong>
    `;
    els.hand.appendChild(row);
  });

  if (flipTriplesState?.gameOver) {
    const winnerEl = document.createElement("div");
    const winner = flipTriplesState.winner;
    winnerEl.className = `flip-winner${winner === "red" ? " red" : winner === "blue" ? " blue" : ""}`;
    winnerEl.textContent = getFlipWinnerText();
    els.hand.appendChild(winnerEl);

    const replayBtn = document.createElement("button");
    replayBtn.type = "button";
    replayBtn.className = "primary-btn flip-replay-btn";
    replayBtn.textContent = "Play again";
    els.hand.appendChild(replayBtn);
  }
}

function getFlipWinnerText() {
  const winner =
    flipTriplesState?.winner ??
    (flipTriplesState?.scores?.red === flipTriplesState?.scores?.blue
      ? "tie"
      : flipTriplesState?.scores?.red > flipTriplesState?.scores?.blue
      ? "red"
      : "blue");
  if (winner === "red") return "Red X wins!";
  if (winner === "blue") return "Blue O wins!";
  return "Tie!";
}

function renderFlipSetup() {
  flipPhaseIndicator.classList.add("hidden");
  flipPhase2Banner.classList.add("hidden");
  if (!flipSetupDraft) {
    flipSetupDraft = flipTriplesState?.settings
      ? {
          purple: (flipTriplesState.settings.purple ?? 0) > 0,
          yellow: (flipTriplesState.settings.yellow ?? 0) > 0,
          rings: (flipTriplesState.settings.rings ?? 0) > 0,
          doubleMove: flipTriplesState.settings.doubleMove === true
        }
      : defaultFlipSetupDraft();
  }
  flipSetup.classList.remove("hidden");

  const draft = flipSetupDraft;
  flipSetup.innerHTML = `
    <div class="flip-setup-card">
      <h3>Game setup</h3>
      <div class="flip-option-toggles" role="group" aria-label="Optional pieces">
        <button type="button" class="flip-option-toggle${draft.purple ? " active" : ""}" data-toggle="purple">
          <span class="flip-option-title">Purple</span>
          <small>8 scoring pieces each; one neutral becomes a purple wildcard</small>
        </button>
        <button type="button" class="flip-option-toggle${draft.yellow ? " active" : ""}" data-toggle="yellow">
          <span class="flip-option-title">Yellow</span>
          <small>9 scoring pieces each; one neutral becomes a yellow wildcard that costs a point in any triple</small>
        </button>
        <button type="button" class="flip-option-toggle${draft.rings ? " active" : ""}" data-toggle="rings">
          <span class="flip-option-title">Ring pieces</span>
          <small>Adds a red and a blue ring: neutral-cored pieces that make triples out of neutrals for their color, flippable only by that color</small>
        </button>
        <button type="button" class="flip-option-toggle${draft.doubleMove ? " active" : ""}" data-toggle="doubleMove">
          <span class="flip-option-title">Double move</span>
          <small>Each player gets one Double: take two moves in a row, once per game</small>
        </button>
      </div>
      <button type="button" class="primary-btn flip-start-btn">Start game</button>
    </div>
  `;
}

function renderFlipColorPick() {
  if (!flipTriplesState?.pickingColor) {
    flipColorPick.classList.add("hidden");
    flipColorPick.innerHTML = "";
    return;
  }
  flipColorPick.classList.remove("hidden");
  const amPicker = flipTriplesState.colorPicker === app.myPlayerIndex;
  if (amPicker) {
    flipColorPick.innerHTML = `
      <div class="flip-color-card">
        <strong>Choose your color</strong>
        <span>Your opponent makes the first move.</span>
        <div class="flip-color-options">
          <button type="button" class="flip-color-btn red" data-color="red"><span class="flip-color-mark">×</span> Red</button>
          <button type="button" class="flip-color-btn blue" data-color="blue"><span class="flip-color-mark ring"></span> Blue</button>
        </div>
      </div>
    `;
  } else {
    flipColorPick.innerHTML = `
      <div class="flip-color-card">
        <strong>Opponent is choosing a color…</strong>
        <span>You make the first move.</span>
      </div>
    `;
  }
}

function renderFlipDoubleBtn() {
  const state = flipTriplesState;
  const show =
    state &&
    !state.setup &&
    !state.pickingColor &&
    !state.pendingPhase2 &&
    !state.gameOver &&
    state.settings?.doubleMove === true &&
    !app.isSoloGame &&
    app.myPlayerIndex != null;
  flipDoubleBtn.classList.toggle("hidden", !show);
  if (!show) return;
  const seat = app.myPlayerIndex;
  const used = state.doubleUsed?.[seat] === true;
  const pendingMine = state.doublePending === seat;
  const myTurn = lastFlipTurn === app.myId;
  flipDoubleBtn.disabled = used || state.doublePending != null || !myTurn;
  flipDoubleBtn.textContent = pendingMine ? "Double active" : used ? "Double used" : "Double move";
  flipDoubleBtn.classList.toggle("active", pendingMine);
}

function renderFlipPhase2Banner() {
  if (!flipTriplesState?.pendingPhase2) {
    flipPhase2Banner.classList.add("hidden");
    flipPhase2Banner.innerHTML = "";
    return;
  }
  const readyCount = flipTriplesState.phase2ReadyCount ?? 0;
  const playerCount = flipTriplesState.playerCount ?? 1;
  const rule = flipTriplesState.settings?.extendedRule ?? "none";
  const ruleNote =
    rule === "ring"
      ? "Scoring rings will be revealed."
      : rule === "swap"
      ? "Unmoved white pieces will switch colors."
      : "Phase 2 will begin.";
  flipPhase2Banner.classList.remove("hidden");
  flipPhase2Banner.innerHTML = `
    <div class="flip-phase2-card">
      <strong>Phase 1 complete</strong>
      <span>${ruleNote}</span>
      <button type="button" class="primary-btn flip-ready-btn" ${flipPhase2Pressed ? "disabled" : ""}>
        ${flipPhase2Pressed ? `Waiting… (${readyCount}/${playerCount})` : "Start Phase 2"}
      </button>
    </div>
  `;
}

function animateFlipTransition() {
  if (prefersReducedMotion()) return;
  const buttons = els.gameBoard.querySelectorAll(".flip-piece.swapped, .flip-piece.opportunity");
  buttons.forEach((button, index) => {
    button.animate(
      [
        { transform: "scale(1)", filter: "brightness(1)" },
        { transform: "scale(1.16)", filter: "brightness(1.5)", offset: 0.5 },
        { transform: "scale(1)", filter: "brightness(1)" }
      ],
      { duration: 520, delay: Math.min(index * 45, 360), easing: "ease-in-out" }
    );
  });
}

function resetUi() {
  flipPhaseIndicator.classList.add("hidden");
  flipPhaseIndicator.classList.remove("white-phase", "black-phase");
  flipSetup.classList.add("hidden");
  flipSetup.innerHTML = "";
  flipColorPick.classList.add("hidden");
  flipColorPick.innerHTML = "";
  flipPhase2Banner.classList.add("hidden");
  flipPhase2Banner.innerHTML = "";
  flipUndoBtn.classList.add("hidden");
  flipDoubleBtn.classList.add("hidden");
}

flipUndoBtn.addEventListener("click", () => {
  if (!app.roomId || !isActive()) return;
  socket.emit("flip_triples_undo", { roomId: app.roomId });
});

flipDoubleBtn.addEventListener("click", () => {
  if (!app.roomId || !isActive()) return;
  socket.emit("flip_triples_double", { roomId: app.roomId });
});

flipColorPick.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const btn = target.closest(".flip-color-btn[data-color]");
  if (!btn || !app.roomId || !isActive()) return;
  socket.emit("flip_triples_pick_color", { roomId: app.roomId, color: btn.dataset.color });
});

els.hand.addEventListener("click", (event) => {
  if (!isActive()) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  const replayBtn = target.closest(".flip-replay-btn");
  if (replayBtn && app.roomId && flipTriplesState?.gameOver) {
    // Same settings, fresh shuffle — the server re-randomizes the layout.
    socket.emit("flip_triples_start", { roomId: app.roomId, options: { ...flipTriplesState.settings } });
  }
});

els.gameBoard.addEventListener("click", (event) => {
  if (!isActive()) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (flipSwapBusy) return;
  if (
    !app.roomId ||
    flipTriplesState?.setup ||
    flipTriplesState?.pickingColor ||
    flipTriplesState?.pendingPhase2 ||
    flipTriplesState?.gameOver
  ) {
    return;
  }
  const pieceButton = target.closest(".flip-piece");
  if (!pieceButton) return;
  const row = Number(pieceButton.dataset.row);
  const col = Number(pieceButton.dataset.col);
  if (Number.isNaN(row) || Number.isNaN(col)) return;
  const piece = getFlipPiece(row, col);

  if (!selectedFlipPiece) {
    if (!canSelectFirstPiece(piece)) return; // protected/uncontrollable pieces can't lead a swap
    selectedFlipPiece = { row, col };
    renderFlipTriplesBoard();
    return;
  }

  const first = selectedFlipPiece;
  if (first.row === row && first.col === col) {
    selectedFlipPiece = null;
    renderFlipTriplesBoard();
    return;
  }

  if (canSwapFlip(first, { row, col })) {
    selectedFlipPiece = null;
    socket.emit("flip_triples_swap", { roomId: app.roomId, from: first, to: { row, col } });
    return;
  }

  selectedFlipPiece = canSelectFirstPiece(piece) ? { row, col } : null;
  renderFlipTriplesBoard();
});

flipSetup.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element) || !flipSetupDraft) return;

  const optionToggle = target.closest(".flip-option-toggle[data-toggle]");
  if (optionToggle) {
    const key = optionToggle.dataset.toggle;
    if (key === "purple" || key === "yellow" || key === "rings" || key === "doubleMove") {
      flipSetupDraft[key] = !flipSetupDraft[key];
      renderFlipSetup();
    }
    return;
  }

  const startBtn = target.closest(".flip-start-btn");
  if (startBtn) {
    if (!app.roomId) return;
    socket.emit("flip_triples_start", { roomId: app.roomId, options: flipDraftToOptions(flipSetupDraft) });
  }
});

flipPhase2Banner.addEventListener("click", (event) => {
  const button = event.target.closest(".flip-ready-btn");
  if (!button || !app.roomId || flipPhase2Pressed) return;
  flipPhase2Pressed = true;
  socket.emit("flip_triples_ready", { roomId: app.roomId });
  renderFlipPhase2Banner();
});

export const flipTriples = {
  id: "flip-triples",
  name: "Flip Triples",
  description: "",
  hasBots: true,

  onMatchFound() {
    flipSetupDraft = null;
    flipPhase2Pressed = false;
    lastTransitionId = 0;
    lastAnimatedMoveId = 0;
    selectedFlipPiece = null;
    flipSwapBusy = false;
    lastFlipTurn = null;
  },

  handleState(payload) {
    const flip = payload.flipTriples;
    if (!flip) return false;
    flipTriplesState = flip;

    if (flip.setup) {
      selectedFlipPiece = null;
      flipPhase2Pressed = false;
      lastAnimatedMoveId = 0;
      lastTransitionId = 0;
      els.gameBoard.innerHTML = "";
      flipPhaseIndicator.classList.add("hidden");
      flipColorPick.classList.add("hidden");
      flipPhase2Banner.classList.add("hidden");
      flipUndoBtn.classList.add("hidden");
      flipDoubleBtn.classList.add("hidden");
      els.hand.innerHTML = "";
      els.hand.classList.remove("player-0", "player-1", "toy-rack", "flip-score");
      renderFlipSetup();
      els.turnStatus.textContent = "Game setup";
      return true;
    }

    flipSetup.classList.add("hidden");
    flipSetup.innerHTML = "";

    // Color-pick pre-game: show the board (disabled) plus the color chooser.
    if (flip.pickingColor) {
      lastFlipTurn = null;
      selectedFlipPiece = null;
      lastAnimatedMoveId = typeof flip.moveId === "number" ? flip.moveId : 0;
      lastTransitionId = flip.transitionId || 0;
      renderFlipTriplesBoard();
      renderFlipTriplesScore();
      renderFlipColorPick();
      flipPhase2Banner.classList.add("hidden");
      flipUndoBtn.classList.add("hidden");
      renderFlipDoubleBtn();
      els.turnStatus.textContent =
        flip.colorPicker === app.myPlayerIndex ? "Choose your color" : "Opponent is choosing a color";
      setBotThinking(false);
      return true;
    }
    flipColorPick.classList.add("hidden");
    flipColorPick.innerHTML = "";

    selectedFlipPiece =
      selectedFlipPiece && canSelectFirstPiece(getFlipPiece(selectedFlipPiece.row, selectedFlipPiece.col))
        ? selectedFlipPiece
        : null;

    const move = flip.lastMove;
    const moveId = typeof flip.moveId === "number" ? flip.moveId : 0;
    if (moveId === 0) lastAnimatedMoveId = 0;
    if (moveId < lastAnimatedMoveId) lastAnimatedMoveId = moveId; // an undo rewound the move count
    const shouldAnimateMove = move && moveId > lastAnimatedMoveId;
    if (shouldAnimateMove) lastAnimatedMoveId = moveId;

    const canUndo = !!flip.undoBy && flip.undoBy === app.myId;
    flipUndoBtn.classList.toggle("hidden", !canUndo);

    const transitionId = flip.transitionId || 0;
    if (transitionId === 0) lastTransitionId = 0;
    const shouldAnimateTransition = transitionId > lastTransitionId;
    if (shouldAnimateTransition) lastTransitionId = transitionId;

    if (!flip.pendingPhase2) flipPhase2Pressed = false;

    renderFlipTriplesBoard();
    renderFlipTriplesScore();
    renderFlipPhase2Banner();
    renderFlipDoubleBtn();

    if (shouldAnimateMove) animateFlipSwap(move);
    if (shouldAnimateTransition) animateFlipTransition();

    if (flip.gameOver) {
      els.turnStatus.textContent = `Game over - ${getFlipWinnerText()} (${flip.scores.red}-${flip.scores.blue})`;
      setBotThinking(false);
    } else if (flip.pendingPhase2) {
      els.turnStatus.textContent = "Phase 1 complete";
      setBotThinking(false);
    } else {
      updateFlipTriplesTurn(payload.turn);
    }
    return true;
  },

  // Returns true when the turn update has been handled (or suppressed).
  handleTurn(turn) {
    if (
      flipTriplesState?.gameOver ||
      flipTriplesState?.setup ||
      flipTriplesState?.pickingColor ||
      flipTriplesState?.pendingPhase2
    ) {
      return true;
    }
    if (isActive() && flipTriplesState) {
      updateFlipTriplesTurn(turn);
      return true;
    }
    return false;
  },

  // Called by other games' state handlers via resetGameUi so stale flip state
  // never suppresses their turn updates.
  clearState() {
    flipTriplesState = null;
  },

  resetUi,

  onOpponentLeft() {
    lastAnimatedMoveId = 0;
    flipSwapBusy = false;
    flipPhase2Pressed = false;
    lastTransitionId = 0;
    flipSetupDraft = null;
  },

  onExit() {
    flipTriplesState = null;
    selectedFlipPiece = null;
    lastAnimatedMoveId = 0;
    flipSwapBusy = false;
    flipPhase2Pressed = false;
    lastTransitionId = 0;
    flipSetupDraft = null;
    lastFlipTurn = null;
  }
};
