const socket = io();

const screens = {
  home: document.getElementById("screen-home"),
  lobby: document.getElementById("screen-lobby"),
  game: document.getElementById("screen-game")
};

const gameList = document.getElementById("game-list");
const cancelButton = document.getElementById("cancel-button");
const exitButton = document.getElementById("exit-button");
const turnButton = document.getElementById("turn-button");

const lobbyStatus = document.getElementById("lobby-status");
const lobbyGameName = document.getElementById("lobby-game-name");
const playerStatus = document.getElementById("player-status");
const playersNeeded = document.getElementById("players-needed");

const gameTitle = document.getElementById("game-title");
const turnStatus = document.getElementById("turn-status");
const gameBoard = document.getElementById("game-board");

let roomId = null;
let myId = null;
let currentGame = null;

const games = [
  {
    id: "explodium",
    name: "Explodium",
    description: "Core test deck and quick turn flow."
  },
  {
    id: "midnight-market",
    name: "Midnight Market",
    description: "Trading, bluffing, and rapid rounds."
  },
  {
    id: "orbit-run",
    name: "Orbit Run",
    description: "Race prototype with tight turn swaps."
  }
];

function setScreen(name) {
  Object.values(screens).forEach((screen) => screen.classList.remove("screen-active"));
  screens[name].classList.add("screen-active");
}

function updateTurn(turnId) {
  const isMyTurn = turnId === myId;
  turnStatus.textContent = isMyTurn ? "Your turn" : "Opponent's turn";
  gameBoard.classList.toggle("dimmed", !isMyTurn);
  turnButton.disabled = !isMyTurn;
}

socket.on("connect", () => {
  myId = socket.id;
});

socket.on("match_found", ({ roomId: newRoomId, turn, gameId }) => {
  roomId = newRoomId;
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

socket.on("opponent_left", () => {
  roomId = null;
  turnStatus.textContent = "Opponent left. Back to home.";
  gameBoard.classList.add("dimmed");
  setTimeout(() => setScreen("home"), 900);
});

function renderGames() {
  gameList.innerHTML = "";
  games.forEach((game) => {
    const card = document.createElement("div");
    card.className = "game-card";
    card.innerHTML = `
      <h3>${game.name}</h3>
      <p>${game.description}</p>
      <button class="primary-btn" data-game-id="${game.id}">Play</button>
    `;
    gameList.appendChild(card);
  });
}

gameList.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (!target.dataset.gameId) return;

  const selected = games.find((game) => game.id === target.dataset.gameId);
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
  setScreen("home");
});

turnButton.addEventListener("click", () => {
  if (!roomId) return;
  socket.emit("take_turn", { roomId });
});

renderGames();
