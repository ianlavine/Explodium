// Lobby shell: home screen, matchmaking, and dispatch of socket events to the
// per-game client modules in ../games/<game-id>/client.js. Each module exposes:
//   id, name, hidden?, hasBots? - home screen metadata
//   handleState(payload, resetGameUi) -> bool - render a state_update it owns
//   handleTurn?(turn) -> bool  - intercept turn_update (Flip Triples phases)
//   clearState?()              - drop cached state when another game takes over
//   resetUi()                  - hide game-specific chrome
//   onMatchFound?/onOpponentLeft?/onExit? - lifecycle resets
import { socket, els, app, setScreen, setBotThinking, updateTurn } from "./context.js";
import { explodium } from "../games/explodium/client.js";
import { toyBattle } from "../games/toy-battle/client.js";
import { flipTriples } from "../games/flip-triples/client.js";

const games = [explodium, toyBattle, flipTriples];

let soloPickerGame = null;

function resetGameUi() {
  games.forEach((game) => game.resetUi());
  setBotThinking(false);
}

socket.on("connect", () => {
  app.myId = socket.id;
});

socket.on("match_found", ({ roomId: newRoomId, turn, gameId, playerIndex }) => {
  app.roomId = newRoomId;
  app.myPlayerIndex = playerIndex ?? 0;
  games.forEach((game) => game.onMatchFound?.());
  if (gameId) {
    const matched = games.find((game) => game.id === gameId);
    if (matched) {
      app.currentGame = matched;
      els.lobbyGameName.textContent = matched.name;
      els.gameTitle.textContent = matched.name;
    }
  }
  els.lobbyStatus.textContent = "Match found! Launching game...";
  els.playerStatus.textContent = "Matched";
  els.playersNeeded.textContent = "0";
  setTimeout(() => {
    setScreen("game");
    updateTurn(turn);
  }, 600);
});

socket.on("turn_update", ({ turn }) => {
  if (flipTriples.handleTurn(turn)) return;
  updateTurn(turn);
});

socket.on("state_update", (payload) => {
  const handler = payload.toyBattle ? toyBattle : payload.flipTriples ? flipTriples : explodium;
  games.forEach((game) => {
    if (game !== handler) game.clearState?.();
  });
  handler.handleState(payload, resetGameUi);
});

socket.on("opponent_left", () => {
  app.roomId = null;
  games.forEach((game) => game.onOpponentLeft?.());
  resetGameUi();
  els.turnStatus.textContent = "Opponent left. Back to home.";
  setTimeout(() => setScreen("home"), 900);
});

function renderGames() {
  els.gameList.innerHTML = "";
  const visibleGames = games.filter((game) => !game.hidden);
  els.gameList.classList.toggle("single", visibleGames.length === 1);
  visibleGames.forEach((game) => {
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
    els.gameList.appendChild(row);
  });
}

function startSoloGame(selected) {
  app.currentGame = selected;
  app.activeGameOptions = {};
  app.isSoloGame = true;
  app.isBotGame = false;
  els.lobbyGameName.textContent = selected.name;
  els.gameTitle.textContent = selected.name;
  resetGameUi();
  setScreen("lobby");
  els.lobbyStatus.textContent = "Starting solo game...";
  els.playerStatus.textContent = "Solo";
  els.playersNeeded.textContent = "0";
  socket.emit("start_solo", { gameId: selected.id, options: app.activeGameOptions });
}

const BOT_LEVEL_NAMES = { 0: "Baby bot", 1: "Level 1 bot", 2: "Level 2 bot", 3: "Level 3 bot", 4: "God bot" };

function startBotGame(selected, botLevel) {
  app.currentGame = selected;
  app.activeGameOptions = {};
  app.isSoloGame = false;
  app.isBotGame = true;
  els.lobbyGameName.textContent = selected.name;
  els.gameTitle.textContent = selected.name;
  resetGameUi();
  setScreen("lobby");
  const label = BOT_LEVEL_NAMES[botLevel] ?? `Level ${botLevel} bot`;
  els.lobbyStatus.textContent = `Starting game vs ${label}...`;
  els.playerStatus.textContent = `Vs ${label}`;
  els.playersNeeded.textContent = "0";
  socket.emit("start_bot", { gameId: selected.id, options: app.activeGameOptions, botLevel });
}

function openSoloPicker(selected) {
  soloPickerGame = selected;
  if (els.soloPickerTitle) els.soloPickerTitle.textContent = `${selected.name} — Solo`;
  els.soloPicker.classList.remove("hidden");
}

function closeSoloPicker() {
  soloPickerGame = null;
  els.soloPicker.classList.add("hidden");
}

els.soloPicker.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target === els.soloPicker || target.closest(".solo-picker-cancel")) {
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

els.gameList.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  const soloButton = target.closest(".solo-btn");
  if (soloButton) {
    const selected = games.find((game) => game.id === soloButton.dataset.gameId);
    if (!selected) return;
    if (selected.hasBots) {
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
  app.currentGame = selected;
  app.activeGameOptions = {};
  app.isSoloGame = false;
  app.isBotGame = false;
  els.lobbyGameName.textContent = selected.name;
  els.gameTitle.textContent = selected.name;
  resetGameUi();
  setScreen("lobby");
  els.lobbyStatus.textContent = "Waiting for another player...";
  els.playerStatus.textContent = "Queued";
  els.playersNeeded.textContent = "1";
  socket.emit("join_queue", { gameId: selected.id, options: app.activeGameOptions });
});

els.cancelButton.addEventListener("click", () => {
  if (app.currentGame) {
    socket.emit("leave_queue", { gameId: app.currentGame.id, options: app.activeGameOptions });
  }
  app.activeGameOptions = {};
  resetGameUi();
  setScreen("home");
});

els.exitButton.addEventListener("click", () => {
  if (app.roomId) {
    socket.emit("leave_room", { roomId: app.roomId });
  } else if (app.currentGame) {
    socket.emit("leave_queue", { gameId: app.currentGame.id, options: app.activeGameOptions });
  }
  app.roomId = null;
  app.myPlayerIndex = null;
  games.forEach((game) => game.onExit?.());
  app.isSoloGame = false;
  app.activeGameOptions = {};
  resetGameUi();
  setScreen("home");
});

renderGames();
