const socket = io();

const screens = {
  home: document.getElementById("screen-home"),
  lobby: document.getElementById("screen-lobby"),
  game: document.getElementById("screen-game")
};

const playButton = document.getElementById("play-button");
const cancelButton = document.getElementById("cancel-button");
const exitButton = document.getElementById("exit-button");
const turnButton = document.getElementById("turn-button");

const lobbyStatus = document.getElementById("lobby-status");
const playerStatus = document.getElementById("player-status");
const playersNeeded = document.getElementById("players-needed");

const turnStatus = document.getElementById("turn-status");
const gameBoard = document.getElementById("game-board");

let roomId = null;
let myId = null;

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

socket.on("match_found", ({ roomId: newRoomId, turn }) => {
  roomId = newRoomId;
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

playButton.addEventListener("click", () => {
  setScreen("lobby");
  lobbyStatus.textContent = "Waiting for another player...";
  playerStatus.textContent = "Queued";
  playersNeeded.textContent = "1";
  socket.emit("join_queue");
});

cancelButton.addEventListener("click", () => {
  socket.emit("leave_queue");
  setScreen("home");
});

exitButton.addEventListener("click", () => {
  socket.emit("leave_queue");
  roomId = null;
  setScreen("home");
});

turnButton.addEventListener("click", () => {
  if (!roomId) return;
  socket.emit("take_turn", { roomId });
});
