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

let roomId = null;
let myId = null;
let currentGame = null;
let myPlayerIndex = null;
let selectedTileType = 0;
let boardState = [];
let handState = [];

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
  }
];

function setScreen(name) {
  Object.values(screens).forEach((screen) => screen.classList.remove("screen-active"));
  screens[name].classList.add("screen-active");
}

function updateTurn(turnId) {
  const isMyTurn = turnId === myId;
  turnStatus.textContent = isMyTurn ? "Your turn" : "Opponent's turn";
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
  updateTurn(turn);
});

socket.on("state_update", ({ board, hands, turn }) => {
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
  turnStatus.textContent = "Opponent left. Back to home.";
  setTimeout(() => setScreen("home"), 900);
});

function renderGames() {
  gameList.innerHTML = "";
  gameList.classList.add("single");
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

gameList.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const soloButton = target.closest(".solo-btn");
  if (soloButton) {
    const selected = games.find((game) => game.id === soloButton.dataset.gameId);
    if (!selected) return;
    currentGame = selected;
    lobbyGameName.textContent = selected.name;
    gameTitle.textContent = selected.name;
    setScreen("lobby");
    lobbyStatus.textContent = "Starting solo game...";
    playerStatus.textContent = "Solo";
    playersNeeded.textContent = "0";
    socket.emit("start_solo", { gameId: selected.id });
    return;
  }

  const card = target.closest(".game-card");
  if (!card || !card.dataset.gameId) return;
  const selected = games.find((game) => game.id === card.dataset.gameId);
  if (!selected) return;
  currentGame = selected;
  lobbyGameName.textContent = selected.name;
  gameTitle.textContent = selected.name;
  setScreen("lobby");
  lobbyStatus.textContent = "Waiting for another player...";
  playerStatus.textContent = "Queued";
  playersNeeded.textContent = "1";
  socket.emit("join_queue", { gameId: selected.id });
});

cancelButton.addEventListener("click", () => {
  if (currentGame) {
    socket.emit("leave_queue", { gameId: currentGame.id });
  }
  setScreen("home");
});

exitButton.addEventListener("click", () => {
  if (roomId) {
    socket.emit("leave_room", { roomId });
  } else if (currentGame) {
    socket.emit("leave_queue", { gameId: currentGame.id });
  }
  roomId = null;
  myPlayerIndex = null;
  boardState = [];
  handState = [];
  setScreen("home");
});

function renderHand() {
  handEl.innerHTML = "";
  handEl.classList.remove("player-0", "player-1");
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
  if (!Array.isArray(boardState) || boardState.length === 0) return;
  gameBoard.classList.remove("player-0", "player-1");
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

handEl.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
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
