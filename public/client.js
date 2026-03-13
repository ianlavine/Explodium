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
  games.forEach((game) => {
    const card = document.createElement("button");
    card.className = "game-card";
    card.type = "button";
    card.dataset.gameId = game.id;
    card.textContent = game.name;
    gameList.appendChild(card);
  });
}

gameList.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
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
      <div class="tile-icon type-${index}">${tileNames[index]}</div>
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
      const tile = boardState[row][col];
      if (tile) {
        cell.classList.add("occupied");
        const tileEl = document.createElement("div");
        tileEl.className = `tile player-${tile.player} type-${tile.type}`;
        tileEl.textContent = ["A", "B", "C", "D", "E"][tile.type] ?? "";
        cell.appendChild(tileEl);
      }
      gameBoard.appendChild(cell);
    }
  }
}

handEl.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const tileCard = target.closest(".tile-card");
  if (!tileCard) return;
  const type = Number(tileCard.dataset.type);
  if (Number.isNaN(type)) return;
  selectedTileType = type;
  renderHand();
});

gameBoard.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
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
