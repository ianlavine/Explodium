// Flip Triples client: setup screen, board rendering, swap/flip animations,
// phase 2 banner, score panel, and the undo button.
import { socket, els, app, setBotThinking, prefersReducedMotion } from "../../shared/context.js";
import { openPlayground } from "./playground.js";

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

// `defaultPieces` mirrors the server preset: scoring pieces per player on a
// fresh deal, the rest neutral (6x6: 14 + 14 + 8 neutral = 36).
const FLIP_BOARD_5X5 = { boardSize: "5x5", cols: 5, rows: 5, cells: 25, centerRow: 2, centerCol: 2, label: "5×5", defaultPieces: 9 };
const FLIP_BOARD_4X6 = { boardSize: "4x6", cols: 4, rows: 6, cells: 24, centerRow: null, centerCol: null, label: "4×6", defaultPieces: 9 };
const FLIP_BOARD_6X6 = { boardSize: "6x6", cols: 6, rows: 6, cells: 36, centerRow: null, centerCol: null, label: "6×6", defaultPieces: 14 };

function flipBoardPreset(boardSize) {
  if (boardSize === "6x6") return FLIP_BOARD_6X6;
  if (boardSize === "5x5") return FLIP_BOARD_5X5;
  return FLIP_BOARD_4X6;
}

function isActive() {
  return app.currentGame?.id === "flip-triples";
}

// 6x6 is dealt either 14 pieces each (8 neutral) or 13 each (10 neutral); the
// other boards have a single fixed piece count.
const FLIP_SIX_PIECE_CHOICES = [14, 13];

function flipSixPieces(draft) {
  return FLIP_SIX_PIECE_CHOICES.includes(draft?.sixPieces) ? draft.sixPieces : 14;
}

// Scoring pieces per player before purple/rings take their slots.
function flipBasePieces(draft) {
  const preset = flipBoardPreset(draft?.boardSize);
  return preset.boardSize === "6x6" ? flipSixPieces(draft) : preset.defaultPieces;
}

// Purple takes the place of one scoring piece per player. On 4x6 that is a
// single wildcard replacing one X (the spare slot becomes a neutral); on 6x6
// it is a pair, one purple for the X and one for the O, so the neutral count
// stays put.
function flipPurpleCount(draft) {
  if (!draft?.purple) return 0;
  return flipBoardPreset(draft.boardSize).boardSize === "6x6" ? 2 : 1;
}

// Reopen the setup card (a rematch) on the settings just played. `sixPieces` is
// the deal before purple/rings claimed their slots, i.e. the inverse of
// flipDraftToOptions.
function flipDraftFromSettings(settings) {
  const purple = (settings.purple ?? 0) > 0;
  const rings = settings.rings ?? 0;
  return {
    boardSize: flipBoardPreset(settings.boardSize).boardSize,
    sixPieces: (settings.playerPieces ?? 0) + (purple ? 1 : 0) + (rings > 0 ? 1 : 0),
    purple,
    yellow: (settings.yellow ?? 0) > 0,
    rings: rings > 0,
    doubleMove: settings.doubleMove === true,
    exactMode: settings.exactMode === true
  };
}

function defaultFlipSetupDraft() {
  return {
    boardSize: "4x6",
    sixPieces: 14,
    purple: false,
    yellow: false,
    rings: false,
    doubleMove: false,
    exactMode: true
  };
}

// The setup screen only exposes the board size, its piece count and a few
// toggles; everything else is fixed to the basic game (unique swap on). Purple
// replaces a scoring piece per player; yellow only replaces a neutral.
function flipDraftToOptions(draft) {
  const purple = flipPurpleCount(draft);
  const yellow = draft.yellow ? 1 : 0;
  const rings = draft.rings ? 1 : 0; // one red + one blue ring
  const preset = flipBoardPreset(draft.boardSize);
  return {
    boardSize: preset.boardSize,
    // Rings replace a scoring-piece pair (one red + one blue), so the neutral
    // count is unchanged; purple likewise takes one scoring slot per player.
    playerPieces: flipBasePieces(draft) - (draft.purple ? 1 : 0) - rings,
    purple,
    yellow,
    hopper: 0,
    rings,
    mode: "basic",
    extendedRule: "none",
    uniqueSwap: true,
    staticNeutrals: false,
    protectedMiddle: false,
    doubleMove: draft.doubleMove === true,
    exactMode: draft.exactMode === true
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
  els.gameBoard.classList.toggle("flip-board-6x6", preset.boardSize === "6x6");

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

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "flip-save-btn";
    saveBtn.textContent = "Save game";
    els.hand.appendChild(saveBtn);

    const loadBtn = document.createElement("button");
    loadBtn.type = "button";
    loadBtn.className = "flip-save-btn flip-load-btn";
    loadBtn.textContent = "Load saved game…";
    els.hand.appendChild(loadBtn);

    if (flipLoadError) {
      const error = document.createElement("p");
      error.className = "flip-load-error";
      error.textContent = flipLoadError;
      els.hand.appendChild(error);
    }
  }
}

// --- Game export ------------------------------------------------------------
// A saved game holds three things: the deal it started from, the color pick
// (who chose and what they took), and the final position. That is enough to
// re-run the deal through the solver offline and see where the result came from.

const FLIP_SHAPE_CHAR = {
  "red-x": "R",
  "blue-o": "B",
  neutral: "N",
  purple: "P",
  yellow: "Y",
  hopper: "H",
  "red-ring": "r",
  "blue-ring": "b"
};

const FLIP_BOT_LEVEL_NAMES = {
  0: "Baby bot",
  1: "Level 1 bot",
  2: "Level 2 bot",
  3: "Level 3 bot",
  4: "God bot"
};

function flipShapesToString(shapeRows) {
  return shapeRows.map((row) => row.map((shape) => FLIP_SHAPE_CHAR[shape] ?? "?").join("")).join("");
}

function buildFlipSaveRecord() {
  const state = flipTriplesState;
  if (!state || !state.gameOver) return null;
  const preset = flipBoardPreset(state.settings?.boardSize);
  const startShapes = state.startShapes ?? state.board.map((row) => row.map((p) => p.shape));
  const finalShapes = state.board.map((row) => row.map((p) => p.shape));
  const finalFlipped = state.board.map((row) => row.map((p) => p.flipped === true));

  const mySeat = app.myPlayerIndex ?? null;
  // Against the bot the human is whichever seat isn't the bot's (seat 1).
  const opponentSeat = mySeat == null ? null : 1 - mySeat;
  const picker = state.colorPicker;
  const colorPick =
    picker == null || !state.seatColors
      ? null
      : {
          pickerSeat: picker,
          pickerIsMe: mySeat != null && picker === mySeat,
          pickedColor: state.seatColors[picker],
          firstMoverSeat: state.firstMover,
          firstMoverIsMe: mySeat != null && state.firstMover === mySeat
        };

  return {
    game: "flip-triples",
    formatVersion: 1,
    savedAt: new Date().toISOString(),
    settings: state.settings ?? null,
    board: { rows: preset.rows, cols: preset.cols },
    // Shape letters: R red ×, B blue ○, N neutral, P purple, Y yellow,
    // H hopper, r red ring, b blue ring — board read left-to-right, top-to-bottom.
    players: {
      mySeat,
      myColor: mySeat == null ? null : state.seatColors?.[mySeat] ?? null,
      opponent: app.isBotGame
        ? {
            seat: opponentSeat,
            type: "bot",
            level: app.botLevel ?? null,
            name: FLIP_BOT_LEVEL_NAMES[app.botLevel] ?? null
          }
        : { seat: opponentSeat, type: app.isSoloGame ? "self" : "human" },
      seatColors: state.seatColors ?? null
    },
    colorPick,
    start: { shapes: startShapes, string: flipShapesToString(startShapes) },
    final: {
      shapes: finalShapes,
      string: flipShapesToString(finalShapes),
      flipped: finalFlipped,
      phase: state.phase
    },
    result: {
      winner: state.winner ?? null,
      scores: state.scores ?? null,
      phaseScores: state.phaseScores ?? null,
      // null for a tie, or when there is no seat/color to judge from (solo play).
      iWon:
        mySeat != null && state.seatColors && state.winner && state.winner !== "tie"
          ? state.winner === state.seatColors[mySeat]
          : null
    }
  };
}

// --- Game import ------------------------------------------------------------
// The mirror of the export: a saved file can be loaded from the setup screen (or
// the game-over panel) to deal its exact opening board again, with the colors it
// was played with, so a game can be replayed and studied move by move.

const FLIP_CHAR_SHAPE = Object.fromEntries(
  Object.entries(FLIP_SHAPE_CHAR).map(([shape, char]) => [char, shape])
);

let flipLoadError = "";

const flipFileInput = document.createElement("input");
flipFileInput.type = "file";
flipFileInput.accept = "application/json,.json";
flipFileInput.style.display = "none";
document.body.appendChild(flipFileInput);

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}

// Prefer the structured rows; fall back to the compact letter string so a
// hand-written file only needs `board` + `start.string`.
function flipShapesFromRecord(record) {
  const shapes = record?.start?.shapes;
  if (Array.isArray(shapes)) return shapes;
  const string = record?.start?.string;
  const rows = record?.board?.rows;
  const cols = record?.board?.cols;
  if (typeof string !== "string" || !Number.isInteger(rows) || !Number.isInteger(cols)) return null;
  if (string.length !== rows * cols) return null;
  const out = [];
  for (let row = 0; row < rows; row += 1) {
    out.push([...string.slice(row * cols, (row + 1) * cols)].map((char) => FLIP_CHAR_SHAPE[char]));
  }
  return out;
}

// Throws an Error whose message is shown to the player.
function flipOptionsFromSave(record) {
  if (!record || record.game !== "flip-triples") throw new Error("Not a Flip Triples save file.");
  const shapes = flipShapesFromRecord(record);
  if (!Array.isArray(shapes) || shapes.length === 0) throw new Error("File has no starting board.");
  const rows = shapes.length;
  const cols = Array.isArray(shapes[0]) ? shapes[0].length : 0;
  const wellFormed = shapes.every(
    (row) => Array.isArray(row) && row.length === cols && row.every((shape) => FLIP_SHAPE_CHAR[shape])
  );
  if (!wellFormed) throw new Error("Starting board is malformed.");
  const boardSize =
    rows === 6 && cols === 4
      ? "4x6"
      : rows === 5 && cols === 5
      ? "5x5"
      : rows === 6 && cols === 6
      ? "6x6"
      : null;
  if (!boardSize) throw new Error(`Unsupported board size (${rows}×${cols}).`);

  const options = { ...(record.settings ?? {}), boardSize, startShapes: shapes };

  // Replay the colors this game was played with, mapped onto my current seat, so
  // the color pick is skipped and the rematch is the same game.
  const myColor = record.players?.myColor;
  if (myColor === "red" || myColor === "blue") {
    const mySeat = app.myPlayerIndex ?? 0;
    const seatColors = [null, null];
    seatColors[mySeat] = myColor;
    seatColors[1 - mySeat] = myColor === "red" ? "blue" : "red";
    options.seatColors = seatColors;
    const pick = record.colorPick ?? {};
    options.colorPicker = pick.pickerIsMe === false ? 1 - mySeat : mySeat;
    options.firstMover =
      pick.firstMoverIsMe === true
        ? mySeat
        : pick.firstMoverIsMe === false
        ? 1 - mySeat
        : 1 - options.colorPicker;
  }
  return options;
}

function showFlipLoadError(message) {
  flipLoadError = message;
  if (flipTriplesState?.setup) renderFlipSetup();
  else if (flipTriplesState?.gameOver) renderFlipTriplesScore();
}

function loadFlipSaveFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let options;
    try {
      options = flipOptionsFromSave(JSON.parse(String(reader.result)));
    } catch (err) {
      showFlipLoadError(err instanceof SyntaxError ? "That file isn't valid JSON." : err.message);
      return;
    }
    flipLoadError = "";
    socket.emit("flip_triples_start", { roomId: app.roomId, options });
  };
  reader.onerror = () => showFlipLoadError("Could not read that file.");
  reader.readAsText(file);
}

flipFileInput.addEventListener("change", () => {
  const file = flipFileInput.files?.[0];
  flipFileInput.value = ""; // so re-picking the same file fires another change
  if (!file || !isActive() || !app.roomId) return;
  loadFlipSaveFile(file);
});

function saveFlipGame() {
  const record = buildFlipSaveRecord();
  if (!record) return;
  const stamp = record.savedAt.replace(/[:.]/g, "-").slice(0, 19);
  const outcome =
    record.result.iWon === true ? "win" : record.result.iWon === false ? "loss" : record.result.winner ?? "game";
  const blob = new Blob([JSON.stringify(record, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `flip-triples-${stamp}-${outcome}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
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
      ? flipDraftFromSettings(flipTriplesState.settings)
      : defaultFlipSetupDraft();
  }
  flipSetup.classList.remove("hidden");

  const draft = flipSetupDraft;
  const preset = flipBoardPreset(draft.boardSize);
  const is6x6 = preset.boardSize === "6x6";
  const base = flipBasePieces(draft);
  const boardChoices = [FLIP_BOARD_4X6, FLIP_BOARD_6X6]
    .map(
      (option) => `
        <button type="button" class="flip-board-btn${
          option.boardSize === preset.boardSize ? " active" : ""
        }" data-board="${option.boardSize}">
          <span class="flip-option-title">${option.label}</span>
          <small>${
            option.boardSize === "6x6"
              ? `${FLIP_SIX_PIECE_CHOICES.join(" or ")} each`
              : `${option.defaultPieces} each + ${option.cells - option.defaultPieces * 2} neutral`
          }</small>
        </button>`
    )
    .join("");
  // 6x6 alone offers a choice of deal, so its piece-count row only appears
  // once that board is picked.
  const sixChoices = is6x6
    ? `
      <div class="flip-board-choices" role="group" aria-label="Pieces per player">
        ${FLIP_SIX_PIECE_CHOICES.map(
          (count) => `
          <button type="button" class="flip-board-btn${
            count === base ? " active" : ""
          }" data-six-pieces="${count}">
            <span class="flip-option-title">${count} each</span>
            <small>${FLIP_BOARD_6X6.cells - count * 2} neutral</small>
          </button>`
        ).join("")}
      </div>`
    : "";
  flipSetup.innerHTML = `
    <div class="flip-setup-card">
      <h3>Game setup</h3>
      <div class="flip-board-choices" role="group" aria-label="Board size">
        ${boardChoices}
      </div>
      ${sixChoices}
      <div class="flip-option-toggles" role="group" aria-label="Optional pieces">
        <button type="button" class="flip-option-toggle${draft.purple ? " active" : ""}" data-toggle="purple">
          <span class="flip-option-title">Purple</span>
          <small>${base - 1} scoring pieces each; ${
            is6x6
              ? "one X and one O become purple wildcards"
              : "one neutral becomes a purple wildcard"
          }</small>
        </button>
        <button type="button" class="flip-option-toggle${draft.yellow ? " active" : ""}" data-toggle="yellow">
          <span class="flip-option-title">Yellow</span>
          <small>${base} scoring pieces each; one neutral becomes a yellow wildcard that costs a point in any triple</small>
        </button>
        <button type="button" class="flip-option-toggle${draft.rings ? " active" : ""}" data-toggle="rings">
          <span class="flip-option-title">Ring pieces</span>
          <small>Adds a red and a blue ring: neutral-cored pieces that make triples out of neutrals for their color, flippable only by that color</small>
        </button>
        <button type="button" class="flip-option-toggle${draft.doubleMove ? " active" : ""}" data-toggle="doubleMove">
          <span class="flip-option-title">Double move</span>
          <small>Each player gets one Double: take two moves in a row, once per game</small>
        </button>
        <button type="button" class="flip-option-toggle${draft.exactMode ? " active" : ""}" data-toggle="exactMode">
          <span class="flip-option-title">Exact mode</span>
          <small>Only runs of exactly three score. Four, five or six in a row are no longer multiple triples — they are worth nothing at all</small>
        </button>
      </div>
      <button type="button" class="primary-btn flip-start-btn">Start game</button>
      <button type="button" class="flip-load-btn">Load saved game…</button>
      <small class="flip-load-hint">Deals the exact opening board from a saved .json instead of a random one</small>
      ${flipLoadError ? `<p class="flip-load-error">${escapeHtml(flipLoadError)}</p>` : ""}
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
  if (target.closest(".flip-load-btn")) {
    flipFileInput.click();
    return;
  }
  const saveBtn = target.closest(".flip-save-btn");
  if (saveBtn && flipTriplesState?.gameOver) {
    saveFlipGame();
    return;
  }
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

  const boardBtn = target.closest(".flip-board-btn[data-board]");
  if (boardBtn) {
    flipSetupDraft.boardSize = flipBoardPreset(boardBtn.dataset.board).boardSize;
    renderFlipSetup();
    return;
  }

  const sixBtn = target.closest(".flip-board-btn[data-six-pieces]");
  if (sixBtn) {
    const count = Number(sixBtn.dataset.sixPieces);
    if (FLIP_SIX_PIECE_CHOICES.includes(count)) {
      flipSetupDraft.sixPieces = count;
      renderFlipSetup();
    }
    return;
  }

  const optionToggle = target.closest(".flip-option-toggle[data-toggle]");
  if (optionToggle) {
    const key = optionToggle.dataset.toggle;
    if (
      key === "purple" ||
      key === "yellow" ||
      key === "rings" ||
      key === "doubleMove" ||
      key === "exactMode"
    ) {
      flipSetupDraft[key] = !flipSetupDraft[key];
      renderFlipSetup();
    }
    return;
  }

  if (target.closest(".flip-load-btn")) {
    if (!app.roomId) return;
    flipFileInput.click();
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
  openPlayground,

  onMatchFound() {
    flipSetupDraft = null;
    flipLoadError = "";
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
    flipLoadError = "";
    selectedFlipPiece = null;
    lastAnimatedMoveId = 0;
    flipSwapBusy = false;
    flipPhase2Pressed = false;
    lastTransitionId = 0;
    flipSetupDraft = null;
    lastFlipTurn = null;
  }
};
