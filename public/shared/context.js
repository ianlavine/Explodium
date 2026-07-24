// Shared client context: the socket, common DOM elements, and cross-screen
// state. Game modules import this and register themselves in app.js.

/* global io */
export const socket = io();

export const els = {
  screens: {
    home: document.getElementById("screen-home"),
    lobby: document.getElementById("screen-lobby"),
    game: document.getElementById("screen-game")
  },
  cancelButton: document.getElementById("cancel-button"),
  exitButton: document.getElementById("exit-button"),
  lobbyStatus: document.getElementById("lobby-status"),
  lobbyGameName: document.getElementById("lobby-game-name"),
  playerStatus: document.getElementById("player-status"),
  playersNeeded: document.getElementById("players-needed"),
  gameTitle: document.getElementById("game-title"),
  turnStatus: document.getElementById("turn-status"),
  botThinking: document.getElementById("bot-thinking"),
  gameBoard: document.getElementById("game-board"),
  hand: document.getElementById("hand"),
  gameList: document.getElementById("game-list"),
  soloPicker: document.getElementById("solo-picker"),
  soloPickerTitle: document.getElementById("solo-picker-title"),
  linoSetup: document.getElementById("lino-setup")
};

// Mutable session state shared between the lobby shell and game modules.
export const app = {
  roomId: null,
  myId: null,
  currentGame: null,
  activeGameOptions: {},
  myPlayerIndex: null,
  isSoloGame: false,
  isBotGame: false
};

export function setScreen(name) {
  Object.values(els.screens).forEach((screen) => screen.classList.remove("screen-active"));
  els.screens[name].classList.add("screen-active");
}

// Bouncing dots shown while the bot is picking its move (God bot thinks for
// several seconds, so the player needs a cue to wait).
export function setBotThinking(visible) {
  els.botThinking.classList.toggle("hidden", !visible);
}

export function updateTurn(turnId) {
  const isMyTurn = turnId === app.myId;
  els.turnStatus.textContent = isMyTurn ? "Your turn" : "Opponent's turn";
  setBotThinking(app.isBotGame && !isMyTurn);
}

export function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
