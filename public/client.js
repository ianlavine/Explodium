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
const gameBoard = document.getElementById("game-board");
const handEl = document.getElementById("hand");
const gameList = document.getElementById("game-list");
const flipPhaseIndicator = document.getElementById("flip-phase-indicator");

let roomId = null;
let myId = null;
let currentGame = null;
let activeGameOptions = {};
let myPlayerIndex = null;
let selectedTileType = 0;
let boardState = [];
let handState = [];
let toyBattleState = null;
let selectedToyPieceId = null;
let flipTriplesState = null;
let selectedFlipPiece = null;

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

const FLIP_TRIPLES_DEFAULT_PLAYER_PIECES = 8;
const FLIP_TRIPLES_MAX_PLAYER_PIECES = 12;

function getFlipTriplesPlayerPieces() {
  const input = gameList.querySelector('[data-option-for="flip-triples"][name="playerPieces"]');
  const value = Number(input?.value);
  if (!Number.isInteger(value)) return FLIP_TRIPLES_DEFAULT_PLAYER_PIECES;
  return Math.min(Math.max(value, 0), FLIP_TRIPLES_MAX_PLAYER_PIECES);
}

function getGameOptions(gameId) {
  if (gameId === "flip-triples") {
    return { playerPieces: getFlipTriplesPlayerPieces() };
  }
  return {};
}

function resetGameUi() {
  flipPhaseIndicator.classList.add("hidden");
  flipPhaseIndicator.classList.remove("white-phase", "black-phase");
}

function setScreen(name) {
  Object.values(screens).forEach((screen) => screen.classList.remove("screen-active"));
  screens[name].classList.add("screen-active");
}

function updateTurn(turnId) {
  const isMyTurn = turnId === myId;
  turnStatus.textContent = isMyTurn ? "Your turn" : "Opponent's turn";
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
  if (flipTriplesState?.gameOver) return;
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
    selectedFlipPiece =
      selectedFlipPiece && isSelectableFlipPiece(getFlipPiece(selectedFlipPiece.row, selectedFlipPiece.col))
        ? selectedFlipPiece
        : null;
    renderFlipTriplesBoard();
    renderFlipTriplesScore();
    if (flipTriples.gameOver) {
      turnStatus.textContent = `Game over: Red X ${flipTriples.scores.red}, Blue O ${flipTriples.scores.blue}`;
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
    if (game.id === "flip-triples") {
      const options = document.createElement("label");
      options.className = "game-option";
      options.innerHTML = `
        <span>Player pieces</span>
        <input
          type="number"
          name="playerPieces"
          data-option-for="flip-triples"
          min="0"
          max="${FLIP_TRIPLES_MAX_PLAYER_PIECES}"
          value="${FLIP_TRIPLES_DEFAULT_PLAYER_PIECES}"
        />
      `;
      row.appendChild(options);
    }
    row.appendChild(solo);
    gameList.appendChild(row);
  });
}

gameList.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const soloButton = target.closest(".solo-btn");
  if (soloButton) {
    const selected = games.find((game) => game.id === soloButton.dataset.gameId);
    if (!selected) return;
    currentGame = selected;
    activeGameOptions = getGameOptions(selected.id);
    lobbyGameName.textContent = selected.name;
    gameTitle.textContent = selected.name;
    resetGameUi();
    setScreen("lobby");
    lobbyStatus.textContent = "Starting solo game...";
    playerStatus.textContent = "Solo";
    playersNeeded.textContent = "0";
    socket.emit("start_solo", { gameId: selected.id, options: activeGameOptions });
    return;
  }

  const card = target.closest(".game-card");
  if (!card || !card.dataset.gameId) return;
  const selected = games.find((game) => game.id === card.dataset.gameId);
  if (!selected) return;
  currentGame = selected;
  activeGameOptions = getGameOptions(selected.id);
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
  if (!piece || piece.shape === "neutral") return "";
  if (piece.shape === "red-x") {
    return `<span class="flip-symbol red-x" aria-hidden="true">×</span>`;
  }
  return `<span class="flip-symbol blue-o" aria-hidden="true"></span>`;
}

function isSelectableFlipPiece(piece) {
  if (!piece || flipTriplesState?.gameOver) return false;
  return flipTriplesState?.phase === 2 ? piece.flipped : !piece.flipped;
}

function getFlipPhaseName() {
  return flipTriplesState?.phase === 2 ? "Black phase" : "White phase";
}

function updateFlipTriplesTurn(turn) {
  const isMyTurn = turn === myId;
  turnStatus.textContent = `${getFlipPhaseName()} - ${isMyTurn ? "Your turn" : "Opponent's turn"}`;
}

function renderFlipTriplesBoard() {
  if (!flipTriplesState) return;
  renderFlipPhaseIndicator();
  gameBoard.innerHTML = "";
  gameBoard.classList.remove("player-0", "player-1", "toy-battle-board");
  gameBoard.classList.add("flip-triples-board");

  flipTriplesState.board.forEach((row, rowIndex) => {
    row.forEach((piece, colIndex) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `flip-piece${piece.flipped ? " flipped" : ""}${
        piece.opportunity ? " opportunity" : ""
      }`;
      if (selectedFlipPiece?.row === rowIndex && selectedFlipPiece?.col === colIndex) {
        button.classList.add("selected");
      }
      button.dataset.row = String(rowIndex);
      button.dataset.col = String(colIndex);
      button.disabled = !isSelectableFlipPiece(piece);
      button.innerHTML = getFlipShape(piece);
      gameBoard.appendChild(button);
    });
  });
}

function renderFlipPhaseIndicator() {
  if (!flipTriplesState) {
    resetGameUi();
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
  const phaseScores = flipTriplesState?.phaseScores ?? {
    phase1: { red: 0, blue: 0 },
    phase2: { red: 0, blue: 0 },
    bonus: { red: 0, blue: 0 }
  };
  const rows = [
    ["Red X", scores.red],
    ["Blue O", scores.blue]
  ];
  rows.forEach(([label, score]) => {
    const row = document.createElement("div");
    row.className = "flip-score-row";
    row.innerHTML = `<span>${label}</span><strong>${score}</strong>`;
    handEl.appendChild(row);
  });

  const note = document.createElement("div");
  note.className = "flip-score-note";
  note.textContent = flipTriplesState?.gameOver ? "Final score" : getFlipPhaseName();
  handEl.appendChild(note);

  const detail = document.createElement("div");
  detail.className = "flip-score-detail";
  const settings = flipTriplesState?.settings;
  detail.innerHTML = `
    <span>Phase 1 ${phaseScores.phase1.red}-${phaseScores.phase1.blue}</span>
    <span>Phase 2 ${phaseScores.phase2.red}-${phaseScores.phase2.blue}</span>
    <span>Bonus ${phaseScores.bonus.red}-${phaseScores.bonus.blue}</span>
    ${
      settings
        ? `<span>Pieces ${settings.playerPieces}-${settings.playerPieces}, Neutral ${settings.neutralPieces}</span>`
        : ""
    }
  `;
  handEl.appendChild(detail);
}

function areTouching(a, b) {
  return Math.max(Math.abs(a.row - b.row), Math.abs(a.col - b.col)) === 1;
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
    const pieceButton = target.closest(".flip-piece");
    if (!pieceButton || !roomId || flipTriplesState?.gameOver) return;
    const row = Number(pieceButton.dataset.row);
    const col = Number(pieceButton.dataset.col);
    if (Number.isNaN(row) || Number.isNaN(col)) return;
    const piece = getFlipPiece(row, col);
    if (!isSelectableFlipPiece(piece)) return;

    if (!selectedFlipPiece) {
      selectedFlipPiece = { row, col };
      renderFlipTriplesBoard();
      return;
    }

    const first = selectedFlipPiece;
    selectedFlipPiece = null;
    if (first.row === row && first.col === col) {
      renderFlipTriplesBoard();
      return;
    }
    if (!areTouching(first, { row, col })) {
      selectedFlipPiece = { row, col };
      renderFlipTriplesBoard();
      return;
    }

    socket.emit("flip_triples_swap", {
      roomId,
      from: first,
      to: { row, col }
    });
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

renderGames();
