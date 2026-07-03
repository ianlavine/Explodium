const socket = io();

const screens = {
  home: document.getElementById("screen-home"),
  lobby: document.getElementById("screen-lobby"),
  game: document.getElementById("screen-game")
};

const cancelButton = document.getElementById("cancel-button");
const exitButton = document.getElementById("exit-button");

const lobbyStatus = document.getElementById("lobby-status");
const lobbyGameName = document.getElementById("lobby-game-name");
const playerStatus = document.getElementById("player-status");
const playersNeeded = document.getElementById("players-needed");

const gameTitle = document.getElementById("game-title");
const turnStatus = document.getElementById("turn-status");
const botThinking = document.getElementById("bot-thinking");
const gameBoard = document.getElementById("game-board");
const handEl = document.getElementById("hand");
const gameList = document.getElementById("game-list");
const flipPhaseIndicator = document.getElementById("flip-phase-indicator");
const flipSetup = document.getElementById("flip-setup");
const flipPhase2Banner = document.getElementById("flip-phase2-banner");
const flipUndoBtn = document.getElementById("flip-undo-btn");
const soloPicker = document.getElementById("solo-picker");
const soloPickerTitle = document.getElementById("solo-picker-title");

let soloPickerGame = null;

let roomId = null;
let myId = null;
let currentGame = null;
let activeGameOptions = {};
let myPlayerIndex = null;
let isSoloGame = false;
let isBotGame = false;
let selectedTileType = 0;
let boardState = [];
let handState = [];
let toyBattleState = null;
let selectedToyPieceId = null;
let flipTriplesState = null;
let selectedFlipPiece = null;
let lastAnimatedMoveId = 0;
let flipSwapBusy = false;
let flipPhase2Pressed = false;
let lastTransitionId = 0;
let flipSetupDraft = null;

const tileSvgs = {
  0: `<svg viewBox="0 0 100 100" aria-hidden="true" class="icon-diamond">
     <path d="M50 6 L70 30 L94 50 L70 70 L50 94 L30 70 L6 50 L30 30 Z" fill="none" stroke="currentColor" stroke-width="10" stroke-linejoin="round"/>
     <path d="M50 12 L65 32 L88 50 L65 68 L50 88 L35 68 L12 50 L35 32 Z" fill="currentColor" opacity="0.35"/>
     <text x="50" y="58" text-anchor="middle" font-size="34" font-weight="700" fill="rgba(255,255,255,0.9)" font-family="'Space Grotesk', sans-serif">3</text>
   </svg>`,
  1: `<svg viewBox="0 0 100 100" aria-hidden="true" class="icon-square">
     <rect x="12" y="12" width="76" height="76" rx="8" fill="currentColor"/>
     <rect x="20" y="20" width="60" height="60" rx="6" fill="none" stroke="rgba(255,255,255,0.65)" stroke-width="6"/>
     <text x="50" y="58" text-anchor="middle" font-size="34" font-weight="700" fill="rgba(255,255,255,0.9)" font-family="'Space Grotesk', sans-serif">3</text>
   </svg>`,
  3: `<svg viewBox="0 0 100 100" aria-hidden="true">
     <path d="M30 20 H70 V34 H46 V44 H66 V58 H46 V66 H70 V80 H30 Z" fill="currentColor"/>
   </svg>`,
  4: `<svg viewBox="0 0 100 100" aria-hidden="true">
     <path d="M30 18 H58
              C70 18 80 28 80 40
              C80 52 70 62 58 62 H30
              V18 Z
              M30 62 H56
              C70 62 82 72 82 84
              C82 96 70 100 56 100 H30 Z" fill="currentColor" transform="translate(0,-6)"/>
   </svg>`
};

const circleSvg = (value) => `<svg viewBox="0 0 100 100" aria-hidden="true" class="icon-circle">
  <circle cx="50" cy="50" r="40" fill="currentColor" />
  <circle cx="50" cy="50" r="32" fill="rgba(255,255,255,0.18)" />
  <text x="50" y="60" text-anchor="middle" font-size="40" font-weight="700" fill="rgba(255,255,255,0.92)" font-family="'Space Grotesk', sans-serif">${value}</text>
</svg>`;

function getScaledValue(base, rangeBoost) {
  return Math.max(1, Math.round(base * rangeBoost));
}

function getTileSvg(type, tile) {
  const rangeBoost = tile && typeof tile.rangeBoost === "number" ? tile.rangeBoost : 1;
  if (type === 0) {
    return tileSvgs[0].replace(">3</text>", `>${getScaledValue(3, rangeBoost)}</text>`);
  }
  if (type === 1) {
    return tileSvgs[1].replace(">3</text>", `>${getScaledValue(3, rangeBoost)}</text>`);
  }
  if (type === 2) {
    return circleSvg(getScaledValue(2, rangeBoost));
  }
  return tileSvgs[type] || "";
}

const games = [
  {
    id: "explodium",
    name: "Explodium",
    description: ""
  },
  {
    id: "toy-battle",
    name: "Toy Battle",
    description: ""
  },
  {
    id: "flip-triples",
    name: "Flip Triples",
    description: ""
  }
];

const FLIP_BOARD_5X5 = { boardSize: "5x5", cols: 5, rows: 5, cells: 25, centerRow: 2, centerCol: 2, label: "5×5" };
const FLIP_BOARD_4X6 = { boardSize: "4x6", cols: 4, rows: 6, cells: 24, centerRow: null, centerCol: null, label: "4×6" };

function flipBoardPreset(boardSize) {
  return boardSize === "4x6" ? FLIP_BOARD_4X6 : FLIP_BOARD_5X5;
}

function defaultFlipSetupDraft() {
  return {
    boardSize: "4x6",
    playerPieces: 9,
    purple: 0,
    hopper: 0,
    blocker: 0,
    mode: "basic",
    extendedRule: "none",
    uniqueSwap: true,
    staticNeutrals: false,
    protectedMiddle: false
  };
}

function resetGameUi() {
  flipPhaseIndicator.classList.add("hidden");
  flipPhaseIndicator.classList.remove("white-phase", "black-phase");
  flipSetup.classList.add("hidden");
  flipSetup.innerHTML = "";
  flipPhase2Banner.classList.add("hidden");
  flipPhase2Banner.innerHTML = "";
  flipUndoBtn.classList.add("hidden");
  setBotThinking(false);
}

function setScreen(name) {
  Object.values(screens).forEach((screen) => screen.classList.remove("screen-active"));
  screens[name].classList.add("screen-active");
}

// Bouncing dots shown while the bot is picking its move (God bot thinks for
// several seconds, so the player needs a cue to wait).
function setBotThinking(visible) {
  botThinking.classList.toggle("hidden", !visible);
}

function updateTurn(turnId) {
  const isMyTurn = turnId === myId;
  turnStatus.textContent = isMyTurn ? "Your turn" : "Opponent's turn";
  setBotThinking(isBotGame && !isMyTurn);
}

function isToyBattle() {
  return currentGame?.id === "toy-battle";
}

function isFlipTriples() {
  return currentGame?.id === "flip-triples";
}

socket.on("connect", () => {
  myId = socket.id;
});

socket.on("match_found", ({ roomId: newRoomId, turn, gameId, playerIndex }) => {
  roomId = newRoomId;
  myPlayerIndex = playerIndex ?? 0;
  flipSetupDraft = null;
  flipPhase2Pressed = false;
  lastTransitionId = 0;
  lastAnimatedMoveId = 0;
  selectedFlipPiece = null;
  flipSwapBusy = false;
  if (gameId) {
    const matched = games.find((game) => game.id === gameId);
    if (matched) {
      currentGame = matched;
      lobbyGameName.textContent = matched.name;
      gameTitle.textContent = matched.name;
    }
  }
  lobbyStatus.textContent = "Match found! Launching game...";
  playerStatus.textContent = "Matched";
  playersNeeded.textContent = "0";
  setTimeout(() => {
    setScreen("game");
    updateTurn(turn);
  }, 600);
});

socket.on("turn_update", ({ turn }) => {
  if (flipTriplesState?.gameOver || flipTriplesState?.setup || flipTriplesState?.pendingPhase2) return;
  if (isFlipTriples() && flipTriplesState) {
    updateFlipTriplesTurn(turn);
    return;
  }
  updateTurn(turn);
});

socket.on("state_update", ({ board, hands, turn, toyBattle, flipTriples }) => {
  if (toyBattle) {
    resetGameUi();
    toyBattleState = toyBattle;
    flipTriplesState = null;
    boardState = [];
    handState = toyBattle.rack || [];
    if (!handState.some((piece) => piece.id === selectedToyPieceId)) {
      selectedToyPieceId = handState[0]?.id ?? null;
    }
    renderToyBattleBoard();
    renderToyBattleRack();
    updateTurn(turn);
    return;
  }

  if (flipTriples) {
    flipTriplesState = flipTriples;
    toyBattleState = null;
    boardState = [];
    handState = [];

    if (flipTriples.setup) {
      selectedFlipPiece = null;
      flipPhase2Pressed = false;
      lastAnimatedMoveId = 0;
      lastTransitionId = 0;
      gameBoard.innerHTML = "";
      flipPhaseIndicator.classList.add("hidden");
      flipPhase2Banner.classList.add("hidden");
      flipUndoBtn.classList.add("hidden");
      handEl.innerHTML = "";
      handEl.classList.remove("player-0", "player-1", "toy-rack", "flip-score");
      renderFlipSetup();
      turnStatus.textContent = "Game setup";
      return;
    }

    flipSetup.classList.add("hidden");
    flipSetup.innerHTML = "";

    selectedFlipPiece =
      selectedFlipPiece && canSelectFirstPiece(getFlipPiece(selectedFlipPiece.row, selectedFlipPiece.col))
        ? selectedFlipPiece
        : null;

    const move = flipTriples.lastMove;
    const moveId = typeof flipTriples.moveId === "number" ? flipTriples.moveId : 0;
    if (moveId === 0) lastAnimatedMoveId = 0;
    if (moveId < lastAnimatedMoveId) lastAnimatedMoveId = moveId; // an undo rewound the move count
    const shouldAnimateMove = move && moveId > lastAnimatedMoveId;
    if (shouldAnimateMove) lastAnimatedMoveId = moveId;

    const canUndo = !!flipTriples.undoBy && flipTriples.undoBy === myId;
    flipUndoBtn.classList.toggle("hidden", !canUndo);

    const transitionId = flipTriples.transitionId || 0;
    if (transitionId === 0) lastTransitionId = 0;
    const shouldAnimateTransition = transitionId > lastTransitionId;
    if (shouldAnimateTransition) lastTransitionId = transitionId;

    if (!flipTriples.pendingPhase2) flipPhase2Pressed = false;

    renderFlipTriplesBoard();
    renderFlipTriplesScore();
    renderFlipPhase2Banner();

    if (shouldAnimateMove) animateFlipSwap(move);
    if (shouldAnimateTransition) animateFlipTransition();

    if (flipTriples.gameOver) {
      turnStatus.textContent = `Game over - ${getFlipWinnerText()} (${flipTriples.scores.red}-${flipTriples.scores.blue})`;
      setBotThinking(false);
    } else if (flipTriples.pendingPhase2) {
      turnStatus.textContent = "Phase 1 complete";
      setBotThinking(false);
    } else {
      updateFlipTriplesTurn(turn);
    }
    return;
  }

  toyBattleState = null;
  flipTriplesState = null;
  resetGameUi();
  boardState = board;
  handState = hands[myPlayerIndex] || [0, 0, 0, 0, 0];
  renderBoard();
  renderHand();
  updateTurn(turn);
});

socket.on("opponent_left", () => {
  roomId = null;
  boardState = [];
  handState = [];
  lastAnimatedMoveId = 0;
  flipSwapBusy = false;
  flipPhase2Pressed = false;
  lastTransitionId = 0;
  flipSetupDraft = null;
  resetGameUi();
  turnStatus.textContent = "Opponent left. Back to home.";
  setTimeout(() => setScreen("home"), 900);
});

function renderGames() {
  gameList.innerHTML = "";
  gameList.classList.toggle("single", games.length === 1);
  games.forEach((game) => {
    const row = document.createElement("div");
    row.className = "game-row";

    const card = document.createElement("button");
    card.className = "game-card";
    card.type = "button";
    card.dataset.gameId = game.id;
    card.textContent = game.name;

    const solo = document.createElement("button");
    solo.className = "solo-btn";
    solo.type = "button";
    solo.dataset.gameId = game.id;
    solo.textContent = "Solo";

    row.appendChild(card);
    row.appendChild(solo);
    gameList.appendChild(row);
  });
}

// Games that offer AI opponents when playing solo.
function gameHasBots(game) {
  return game?.id === "flip-triples";
}

function startSoloGame(selected) {
  currentGame = selected;
  activeGameOptions = {};
  isSoloGame = true;
  isBotGame = false;
  lobbyGameName.textContent = selected.name;
  gameTitle.textContent = selected.name;
  resetGameUi();
  setScreen("lobby");
  lobbyStatus.textContent = "Starting solo game...";
  playerStatus.textContent = "Solo";
  playersNeeded.textContent = "0";
  socket.emit("start_solo", { gameId: selected.id, options: activeGameOptions });
}

const BOT_LEVEL_NAMES = { 0: "Baby bot", 1: "Level 1 bot", 2: "Level 2 bot", 3: "Level 3 bot", 4: "God bot" };

function startBotGame(selected, botLevel) {
  currentGame = selected;
  activeGameOptions = {};
  isSoloGame = false;
  isBotGame = true;
  lobbyGameName.textContent = selected.name;
  gameTitle.textContent = selected.name;
  resetGameUi();
  setScreen("lobby");
  const label = BOT_LEVEL_NAMES[botLevel] ?? `Level ${botLevel} bot`;
  lobbyStatus.textContent = `Starting game vs ${label}...`;
  playerStatus.textContent = `Vs ${label}`;
  playersNeeded.textContent = "0";
  socket.emit("start_bot", { gameId: selected.id, options: activeGameOptions, botLevel });
}

function openSoloPicker(selected) {
  soloPickerGame = selected;
  if (soloPickerTitle) soloPickerTitle.textContent = `${selected.name} — Solo`;
  soloPicker.classList.remove("hidden");
}

function closeSoloPicker() {
  soloPickerGame = null;
  soloPicker.classList.add("hidden");
}

soloPicker.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target === soloPicker || target.closest(".solo-picker-cancel")) {
    closeSoloPicker();
    return;
  }
  const option = target.closest(".solo-opt");
  if (!option || !soloPickerGame) return;
  const selected = soloPickerGame;
  const bot = option.dataset.bot;
  closeSoloPicker();
  if (bot !== undefined && bot !== "none" && !Number.isNaN(Number(bot))) {
    startBotGame(selected, Number(bot));
  } else {
    startSoloGame(selected);
  }
});

gameList.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  const soloButton = target.closest(".solo-btn");
  if (soloButton) {
    const selected = games.find((game) => game.id === soloButton.dataset.gameId);
    if (!selected) return;
    if (gameHasBots(selected)) {
      openSoloPicker(selected);
    } else {
      startSoloGame(selected);
    }
    return;
  }

  const card = target.closest(".game-card");
  if (!card || !card.dataset.gameId) return;
  const selected = games.find((game) => game.id === card.dataset.gameId);
  if (!selected) return;
  currentGame = selected;
  activeGameOptions = {};
  isSoloGame = false;
  isBotGame = false;
  lobbyGameName.textContent = selected.name;
  gameTitle.textContent = selected.name;
  resetGameUi();
  setScreen("lobby");
  lobbyStatus.textContent = "Waiting for another player...";
  playerStatus.textContent = "Queued";
  playersNeeded.textContent = "1";
  socket.emit("join_queue", { gameId: selected.id, options: activeGameOptions });
});

cancelButton.addEventListener("click", () => {
  if (currentGame) {
    socket.emit("leave_queue", { gameId: currentGame.id, options: activeGameOptions });
  }
  activeGameOptions = {};
  resetGameUi();
  setScreen("home");
});

flipUndoBtn.addEventListener("click", () => {
  if (!roomId || !isFlipTriples()) return;
  socket.emit("flip_triples_undo", { roomId });
});

exitButton.addEventListener("click", () => {
  if (roomId) {
    socket.emit("leave_room", { roomId });
  } else if (currentGame) {
    socket.emit("leave_queue", { gameId: currentGame.id, options: activeGameOptions });
  }
  roomId = null;
  myPlayerIndex = null;
  boardState = [];
  handState = [];
  toyBattleState = null;
  selectedToyPieceId = null;
  flipTriplesState = null;
  selectedFlipPiece = null;
  lastAnimatedMoveId = 0;
  flipSwapBusy = false;
  flipPhase2Pressed = false;
  lastTransitionId = 0;
  flipSetupDraft = null;
  isSoloGame = false;
  activeGameOptions = {};
  resetGameUi();
  setScreen("home");
});

function renderHand() {
  if (isToyBattle()) {
    renderToyBattleRack();
    return;
  }
  if (isFlipTriples()) {
    renderFlipTriplesScore();
    return;
  }

  handEl.innerHTML = "";
  handEl.classList.remove("player-0", "player-1", "toy-rack", "flip-score");
  if (myPlayerIndex !== null) {
    handEl.classList.add(`player-${myPlayerIndex}`);
  }
  const tileNames = ["A", "B", "C", "D", "E"];
  handState.forEach((count, index) => {
    const card = document.createElement("div");
    card.className = `tile-card${index === selectedTileType ? " selected" : ""}`;
    card.dataset.type = String(index);
    card.innerHTML = `
      <span class="tile-count">${count}</span>
      <div class="tile-icon type-${index}">${getTileSvg(index, null)}</div>
    `;
    handEl.appendChild(card);
  });
}

function renderBoard() {
  if (isToyBattle()) {
    renderToyBattleBoard();
    return;
  }
  if (isFlipTriples()) {
    renderFlipTriplesBoard();
    return;
  }

  if (!Array.isArray(boardState) || boardState.length === 0) return;
  gameBoard.classList.remove("player-0", "player-1", "toy-battle-board", "flip-triples-board");
  if (myPlayerIndex !== null) {
    gameBoard.classList.add(`player-${myPlayerIndex}`);
  }
  gameBoard.innerHTML = "";
  for (let row = 0; row < boardState.length; row += 1) {
    for (let col = 0; col < boardState[row].length; col += 1) {
      const cell = document.createElement("div");
      cell.className = "board-cell";
      cell.dataset.row = String(row);
      cell.dataset.col = String(col);
      const cellState = boardState[row][col];
      const tile =
        cellState && typeof cellState === "object" && "player" in cellState && "type" in cellState
          ? cellState
          : cellState?.tile ?? null;
      const rawMarkers = Array.isArray(cellState?.markers) ? cellState.markers : [];
      const markers = rawMarkers.map((marker) =>
        typeof marker === "number" ? { player: marker, filled: false } : marker
      );
      if (markers.length && !tile) {
        const markerWrap = document.createElement("div");
        markerWrap.className = "path-markers";
        markers.forEach((markerData) => {
          const marker = document.createElement("span");
          marker.className = `path-marker player-${markerData.player}${
            markerData.filled ? " filled" : ""
          }`;
          markerWrap.appendChild(marker);
        });
        cell.appendChild(markerWrap);
      }
      if (tile) {
        cell.classList.add("occupied");
        const tileEl = document.createElement("div");
        tileEl.className = `tile player-${tile.player} type-${tile.type}`;
        tileEl.innerHTML = getTileSvg(tile.type, tile);
        cell.appendChild(tileEl);
      }
      gameBoard.appendChild(cell);
    }
  }
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
    case "hopper":
      return `<span class="flip-symbol hopper" aria-hidden="true">H</span>`;
    default:
      return "";
  }
}

function isSelectableFlipPiece(piece) {
  if (!piece || flipTriplesState?.gameOver || flipTriplesState?.setup || flipTriplesState?.pendingPhase2) {
    return false;
  }
  return flipTriplesState?.phase === 2 ? piece.flipped : !piece.flipped;
}

function canControlBlocker(piece) {
  if (piece.shape !== "blocker") return true;
  if (isSoloGame) return true;
  return piece.owner === myPlayerIndex;
}

// The first piece in a swap is the one that flips, so it can never be protected,
// and a blocker can only be moved by its owner.
function canSelectFirstPiece(piece) {
  if (!isSelectableFlipPiece(piece)) return false;
  if (piece.protected) return false;
  if (!canControlBlocker(piece)) return false;
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
  if (!canControlBlocker(second)) return false;
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

function updateFlipTriplesTurn(turn) {
  const isMyTurn = turn === myId || isSoloGame;
  turnStatus.textContent = `${getFlipPhaseLabel()} - ${isMyTurn ? "Your turn" : "Opponent's turn"}`;
  setBotThinking(isBotGame && !isMyTurn);
}

function renderFlipTriplesBoard() {
  if (!flipTriplesState) return;
  renderFlipPhaseIndicator();
  gameBoard.innerHTML = "";
  gameBoard.classList.remove("player-0", "player-1", "toy-battle-board");
  gameBoard.classList.add("flip-triples-board");
  const preset = flipBoardPreset(flipTriplesState.settings?.boardSize);
  gameBoard.style.setProperty("--flip-cols", String(preset.cols));
  gameBoard.classList.toggle("flip-board-4x6", preset.boardSize === "4x6");

  flipTriplesState.board.forEach((row, rowIndex) => {
    row.forEach((piece, colIndex) => {
      const button = document.createElement("button");
      button.type = "button";
      const classes = ["flip-piece", `shape-${piece.shape}`];
      if (piece.flipped) classes.push("flipped");
      if (piece.opportunity) classes.push("opportunity");
      if (piece.protected) classes.push("protected");
      if (piece.shape === "blocker") classes.push(`blocker owner-${piece.owner}`);
      if (piece.swapped) classes.push("swapped");
      button.className = classes.join(" ");
      if (selectedFlipPiece?.row === rowIndex && selectedFlipPiece?.col === colIndex) {
        button.classList.add("selected");
      }
      button.dataset.row = String(rowIndex);
      button.dataset.col = String(colIndex);
      button.disabled = !isSelectableFlipPiece(piece) || !canControlBlocker(piece);
      button.innerHTML = getFlipShape(piece);
      gameBoard.appendChild(button);
    });
  });
}

function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function getFlipPieceButton(row, col) {
  return gameBoard.querySelector(`.flip-piece[data-row="${row}"][data-col="${col}"]`);
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
    resetGameUi();
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
  handEl.innerHTML = "";
  handEl.classList.remove("player-0", "player-1", "toy-rack");
  handEl.classList.add("flip-score");

  const scores = flipTriplesState?.scores ?? { red: 0, blue: 0 };
  const rows = [
    { side: "red", label: "Red X", mark: "×", score: scores.red },
    { side: "blue", label: "Blue O", mark: '<span class="ring"></span>', score: scores.blue }
  ];
  const leader = scores.red === scores.blue ? null : scores.red > scores.blue ? "red" : "blue";
  rows.forEach(({ side, label, mark, score }) => {
    const row = document.createElement("div");
    row.className = `flip-score-row ${side}${leader === side ? " leading" : ""}`;
    row.innerHTML = `
      <span class="flip-score-label">
        <span class="flip-score-mark">${mark}</span>
        <span>${label}</span>
      </span>
      <strong>${score}</strong>
    `;
    handEl.appendChild(row);
  });

  if (flipTriplesState?.gameOver) {
    const winnerEl = document.createElement("div");
    const winner = flipTriplesState.winner;
    winnerEl.className = `flip-winner${winner === "red" ? " red" : winner === "blue" ? " blue" : ""}`;
    winnerEl.textContent = getFlipWinnerText();
    handEl.appendChild(winnerEl);
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
          boardSize: flipTriplesState.settings.boardSize ?? "4x6",
          playerPieces: flipTriplesState.settings.playerPieces ?? 9,
          purple: flipTriplesState.settings.purple ?? 0,
          hopper: flipTriplesState.settings.hopper ?? 0,
          blocker: flipTriplesState.settings.blocker ?? 0,
          mode: flipTriplesState.settings.mode ?? "basic",
          extendedRule: flipTriplesState.settings.extendedRule ?? "none",
          uniqueSwap: flipTriplesState.settings.uniqueSwap ?? true,
          staticNeutrals: flipTriplesState.settings.staticNeutrals ?? false,
          protectedMiddle: flipTriplesState.settings.protectedMiddle ?? false
        }
      : defaultFlipSetupDraft();
  }
  flipSetup.classList.remove("hidden");

  const draft = flipSetupDraft;
  const preset = flipBoardPreset(draft.boardSize);
  const maxPlayerPieces = Math.floor(preset.cells / 2);
  const used = draft.playerPieces * 2 + draft.purple + draft.hopper + draft.blocker;
  const neutral = preset.cells - used;
  const overflow = neutral < 0;
  const middleDisabled = draft.boardSize === "4x6";

  flipSetup.innerHTML = `
    <div class="flip-setup-card">
      <h3>Game setup</h3>
      <div class="flip-board-size-toggle" role="group" aria-label="Board size">
        <button type="button" class="flip-board-size-btn${draft.boardSize === "5x5" ? " active" : ""}" data-board-size="5x5">5×5</button>
        <button type="button" class="flip-board-size-btn${draft.boardSize === "4x6" ? " active" : ""}" data-board-size="4x6">4×6</button>
      </div>
      <div class="flip-setup-grid">
        <label class="flip-field">
          <span>Player pieces (each)</span>
          <input type="number" data-setting="playerPieces" min="0" max="${maxPlayerPieces}" value="${draft.playerPieces}" />
        </label>
        <label class="flip-field">
          <span>Purple</span>
          <input type="number" data-setting="purple" min="0" max="${preset.cells}" value="${draft.purple}" />
        </label>
        <label class="flip-field">
          <span>Hopper</span>
          <input type="number" data-setting="hopper" min="0" max="${preset.cells}" value="${draft.hopper}" />
        </label>
        <label class="flip-field">
          <span>Blockers</span>
          <input type="number" data-setting="blocker" min="0" max="${preset.cells}" step="2" value="${draft.blocker}" />
        </label>
      </div>

      <div class="flip-setup-modes">
        <div class="flip-mode-toggle" role="group" aria-label="Game mode">
          <button type="button" class="flip-mode-btn${draft.mode === "basic" ? " active" : ""}" data-mode="basic">Basic</button>
          <button type="button" class="flip-mode-btn${draft.mode === "extended" ? " active" : ""}" data-mode="extended">Extended</button>
        </div>
        <div class="flip-rule-toggle${draft.mode === "extended" ? "" : " disabled"}" role="group" aria-label="Extended rule">
          ${["none", "ring", "swap"]
            .map(
              (rule) =>
                `<button type="button" class="flip-rule-btn${
                  draft.extendedRule === rule ? " active" : ""
                }" data-rule="${rule}" ${draft.mode === "extended" ? "" : "disabled"}>${
                  rule === "none" ? "None" : rule === "ring" ? "Ring" : "Swap"
                }</button>`
            )
            .join("")}
        </div>
      </div>

      <div class="flip-option-toggles" role="group" aria-label="Optional rules">
        <button type="button" class="flip-option-toggle${draft.uniqueSwap ? " active" : ""}" data-toggle="uniqueSwap">
          <span class="flip-option-title">Unique Swap</span>
          <small>Swapped pieces must be different shapes</small>
        </button>
        <button type="button" class="flip-option-toggle${draft.staticNeutrals ? " active" : ""}" data-toggle="staticNeutrals">
          <span class="flip-option-title">Static Neutrals</span>
          <small>Neutrals must flip; they never slide</small>
        </button>
        <button type="button" class="flip-option-toggle${draft.protectedMiddle ? " active" : ""}${middleDisabled ? " disabled" : ""}" data-toggle="protectedMiddle"${middleDisabled ? " disabled" : ""}>
          <span class="flip-option-title">Protected Middle</span>
          <small>${
            middleDisabled
              ? "Not available on 4×6 — there is no center square"
              : "Nothing can flip into the center; select the middle first"
          }</small>
        </button>
      </div>

      <p class="flip-setup-summary${overflow ? " error" : ""}">
        ${
          overflow
            ? `Too many pieces for the ${preset.label} board — reduce some.`
            : `Neutral pieces: ${neutral} (of ${preset.cells})`
        }
      </p>
      <button type="button" class="primary-btn flip-start-btn" ${overflow ? "disabled" : ""}>Start game</button>
    </div>
  `;
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
  const buttons = gameBoard.querySelectorAll(".flip-piece.swapped, .flip-piece.opportunity");
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

function getToyNodePosition(node) {
  return {
    x: 8 + node.col * 10.5,
    y: 6 + node.row * 14.666
  };
}

function renderToyBattleBoard() {
  if (!toyBattleState) return;
  gameBoard.innerHTML = "";
  gameBoard.classList.remove("player-0", "player-1", "flip-triples-board");
  gameBoard.classList.add("toy-battle-board");

  const nodesById = new Map(toyBattleState.nodes.map((node) => [node.id, node]));
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "toy-edges");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("aria-hidden", "true");

  toyBattleState.edges.forEach((edge) => {
    const from = nodesById.get(edge.from);
    const to = nodesById.get(edge.to);
    if (!from || !to) return;
    const start = getToyNodePosition(from);
    const end = getToyNodePosition(to);
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", String(start.x));
    line.setAttribute("y1", String(start.y));
    line.setAttribute("x2", String(end.x));
    line.setAttribute("y2", String(end.y));
    svg.appendChild(line);
  });
  gameBoard.appendChild(svg);

  toyBattleState.nodes.forEach((node) => {
    const position = getToyNodePosition(node);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "toy-node";
    button.dataset.nodeId = node.id;
    button.style.left = `${position.x}%`;
    button.style.top = `${position.y}%`;
    if (node.base) button.classList.add(`base-${node.base}`);
    if (node.piece) button.classList.add("occupied");
    button.textContent = node.piece?.name || "";
    gameBoard.appendChild(button);
  });
}

function renderToyBattleRack() {
  handEl.innerHTML = "";
  handEl.classList.remove("player-0", "player-1", "flip-score");
  handEl.classList.add("toy-rack");

  handState.forEach((piece) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `toy-piece${piece.id === selectedToyPieceId ? " selected" : ""}`;
    button.dataset.pieceId = piece.id;
    button.textContent = piece.name;
    handEl.appendChild(button);
  });

  const drawButton = document.createElement("button");
  drawButton.type = "button";
  drawButton.className = "draw-pieces";
  drawButton.textContent = `Draw 2 (${toyBattleState?.deckCount ?? 0})`;
  drawButton.disabled = !toyBattleState || toyBattleState.deckCount <= 0;
  handEl.appendChild(drawButton);
}

handEl.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (isToyBattle()) {
    const drawButton = target.closest(".draw-pieces");
    if (drawButton) {
      if (roomId) socket.emit("toy_battle_draw", { roomId });
      return;
    }

    const pieceButton = target.closest(".toy-piece");
    if (!pieceButton) return;
    selectedToyPieceId = pieceButton.dataset.pieceId || null;
    renderToyBattleRack();
    return;
  }
  if (isFlipTriples()) return;

  const tileCard = target.closest(".tile-card");
  if (!tileCard) return;
  const type = Number(tileCard.dataset.type);
  if (Number.isNaN(type)) return;
  selectedTileType = type;
  renderHand();
});

gameBoard.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (isToyBattle()) {
    const node = target.closest(".toy-node");
    if (!node || !roomId || !selectedToyPieceId) return;
    socket.emit("toy_battle_place", {
      roomId,
      nodeId: node.dataset.nodeId,
      pieceId: selectedToyPieceId
    });
    return;
  }
  if (isFlipTriples()) {
    if (flipSwapBusy) return;
    if (
      !roomId ||
      flipTriplesState?.setup ||
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
      socket.emit("flip_triples_swap", { roomId, from: first, to: { row, col } });
      return;
    }

    selectedFlipPiece = canSelectFirstPiece(piece) ? { row, col } : null;
    renderFlipTriplesBoard();
    return;
  }

  const cell = target.closest(".board-cell");
  if (!cell) return;
  if (!roomId) return;
  const row = Number(cell.dataset.row);
  const col = Number(cell.dataset.col);
  if (Number.isNaN(row) || Number.isNaN(col)) return;
  socket.emit("place_tile", {
    roomId,
    row,
    col,
    type: selectedTileType
  });
});

function updateFlipSetupSummary() {
  const draft = flipSetupDraft;
  if (!draft) return;
  const preset = flipBoardPreset(draft.boardSize);
  const maxPlayerPieces = Math.floor(preset.cells / 2);
  const used = draft.playerPieces * 2 + draft.purple + draft.hopper + draft.blocker;
  const neutral = preset.cells - used;
  const overflow = neutral < 0;
  const summary = flipSetup.querySelector(".flip-setup-summary");
  const startBtn = flipSetup.querySelector(".flip-start-btn");
  if (summary) {
    summary.classList.toggle("error", overflow);
    summary.textContent = overflow
      ? `Too many pieces for the ${preset.label} board — reduce some.`
      : `Neutral pieces: ${neutral} (of ${preset.cells})`;
  }
  if (startBtn) startBtn.disabled = overflow;

  flipSetup.querySelectorAll("input[data-setting='playerPieces']").forEach((input) => {
    input.max = String(maxPlayerPieces);
  });
  flipSetup.querySelectorAll("input[data-setting='purple'], input[data-setting='hopper'], input[data-setting='blocker']").forEach((input) => {
    input.max = String(preset.cells);
  });
}

flipSetup.addEventListener("input", (event) => {
  const input = event.target.closest("input[data-setting]");
  if (!input || !flipSetupDraft) return;
  const key = input.dataset.setting;
  const preset = flipBoardPreset(flipSetupDraft.boardSize);
  const maxPlayerPieces = Math.floor(preset.cells / 2);
  let value = parseInt(input.value, 10);
  if (!Number.isInteger(value) || value < 0) value = 0;
  if (key === "playerPieces") value = Math.min(value, maxPlayerPieces);
  if (key === "blocker") value -= value % 2;
  value = Math.min(value, preset.cells);
  flipSetupDraft[key] = value;
  updateFlipSetupSummary();
});

flipSetup.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element) || !flipSetupDraft) return;

  const modeBtn = target.closest(".flip-mode-btn");
  if (modeBtn) {
    flipSetupDraft.mode = modeBtn.dataset.mode === "extended" ? "extended" : "basic";
    renderFlipSetup();
    return;
  }

  const ruleBtn = target.closest(".flip-rule-btn");
  if (ruleBtn && flipSetupDraft.mode === "extended") {
    flipSetupDraft.extendedRule = ruleBtn.dataset.rule || "none";
    renderFlipSetup();
    return;
  }

  const boardSizeBtn = target.closest(".flip-board-size-btn");
  if (boardSizeBtn) {
    flipSetupDraft.boardSize = boardSizeBtn.dataset.boardSize === "4x6" ? "4x6" : "5x5";
    if (flipSetupDraft.boardSize === "4x6") flipSetupDraft.protectedMiddle = false;
    renderFlipSetup();
    return;
  }

  const optionToggle = target.closest(".flip-option-toggle[data-toggle]");
  if (optionToggle) {
    if (optionToggle.classList.contains("disabled")) return;
    const key = optionToggle.dataset.toggle;
    if (key === "uniqueSwap" || key === "staticNeutrals" || key === "protectedMiddle") {
      flipSetupDraft[key] = !flipSetupDraft[key];
      renderFlipSetup();
    }
    return;
  }

  const startBtn = target.closest(".flip-start-btn");
  if (startBtn) {
    if (!roomId) return;
    socket.emit("flip_triples_start", { roomId, options: { ...flipSetupDraft } });
  }
});

flipPhase2Banner.addEventListener("click", (event) => {
  const button = event.target.closest(".flip-ready-btn");
  if (!button || !roomId || flipPhase2Pressed) return;
  flipPhase2Pressed = true;
  socket.emit("flip_triples_ready", { roomId });
  renderFlipPhase2Banner();
});

renderGames();
