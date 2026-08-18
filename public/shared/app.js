// Lobby shell: home screen, matchmaking, and dispatch of socket events to the
// per-game client modules in ../games/<game-id>/client.js. Each module exposes:
//   id, name, hasBots?, soloOnly? - home screen metadata
//   handleState(payload, resetGameUi) -> bool - render a state_update it owns
//   handleTurn?(turn) -> bool  - intercept turn_update (Flip Triples phases)
//   clearState?()              - drop cached state when another game takes over
//   resetUi()                  - hide game-specific chrome
//   onMatchFound?/onOpponentLeft?/onExit? - lifecycle resets
//
// Those modules are LOADED ON DEMAND. Statically importing all nine cost the
// homepage ~740 KB of JavaScript and ~150 KB of CSS before it could paint, and
// every byte of it was a game the visitor hadn't chosen yet. The manifest below
// carries the only things the home screen actually needs — a name, an id and
// whether to list the game at all — and the client module plus its stylesheet
// arrive when a game is picked (or quietly on idle, so the click still feels
// instant). Everything downstream of that reads the real module, so behaviour
// flags like hasBots and openSetup stay where they always were.
import { socket, els, app, setScreen, setBotThinking, updateTurn } from "./context.js";

// `state` is the key a state_update carries when the payload belongs to this
// game; explodium is the fallback for a payload with none of them. `hidden`
// keeps a game off the home screen without unwiring it — the server will still
// deal it, it just isn't offered.
const GAMES = [
  { id: "explodium", name: "Explodium", export: "explodium", state: null, hidden: true },
  { id: "toy-battle", name: "Toy Battle", export: "toyBattle", state: "toyBattle", hidden: true },
  { id: "flip-triples", name: "Flip Triples", export: "flipTriples", state: "flipTriples" },
  { id: "truck-mania", name: "Truck Mania", export: "truckMania", state: "truckMania", hidden: true },
  { id: "uber-mania", name: "Uber Mania", export: "uberMania", state: "uberMania" },
  { id: "landmark-mania", name: "Landmark Mania", export: "landmarkMania", state: "landmarkMania", hidden: true },
  { id: "lino", name: "Lino", export: "lino", state: "lino", hidden: true },
  { id: "downstream", name: "Downstream", export: "downstream", state: "downstream", hidden: true },
  { id: "only-3", name: "Only 3", export: "only3", state: "only3", hidden: true }
];

const entryFor = (id) => GAMES.find((g) => g.id === id);

// Modules that have finished loading, in manifest order — the "all games" list
// every broadcast used to walk. A game that was never opened has no state to
// clear and no chrome to hide, so leaving it out is not just an optimisation.
const loadedGames = new Map();
const loading = new Map();
const loaded = () => GAMES.map((g) => loadedGames.get(g.id)).filter(Boolean);

// A game's stylesheet has to be in the document BEFORE its first render or the
// board flashes up unstyled, so the load waits on the link as well as the code.
function loadStyles(id) {
  const href = `/games/${id}/styles.css`;
  if (document.querySelector(`link[data-game-css="${id}"]`)) return Promise.resolve();
  return new Promise((resolve) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.dataset.gameCss = id;
    link.addEventListener("load", resolve);
    link.addEventListener("error", resolve); // a missing sheet shouldn't wedge the game
    document.head.appendChild(link);
  });
}

function loadGame(id) {
  const already = loadedGames.get(id);
  if (already) return Promise.resolve(already);
  let pending = loading.get(id);
  if (pending) return pending;
  const entry = entryFor(id);
  if (!entry) return Promise.resolve(null);
  pending = Promise.all([import(`../games/${id}/client.js`), loadStyles(id)])
    .then(([mod]) => {
      const game = mod[entry.export];
      if (game) loadedGames.set(id, game);
      return game ?? null;
    });
  loading.set(id, pending);
  return pending;
}

let soloPickerGame = null;

function resetGameUi() {
  loaded().forEach((game) => game.resetUi());
  setBotThinking(false);
}

socket.on("connect", () => {
  app.myId = socket.id;
});

// Socket traffic can land while a module is still in flight, so every handler
// that needs one runs on a single chain: awaiting the import here keeps state
// updates in the order the server sent them.
let dispatch = Promise.resolve();
const queue = (fn) => {
  dispatch = dispatch.then(fn).catch((err) => console.error(err));
};

socket.on("match_found", ({ roomId: newRoomId, turn, gameId, playerIndex }) => {
  app.roomId = newRoomId;
  app.myPlayerIndex = playerIndex ?? 0;
  const entry = gameId ? entryFor(gameId) : null;
  if (entry) {
    els.lobbyGameName.textContent = entry.name;
    els.gameTitle.textContent = entry.name;
  }
  els.lobbyStatus.textContent = "Match found! Launching game...";
  els.playerStatus.textContent = "Matched";
  els.playersNeeded.textContent = "0";
  queue(async () => {
    const matched = gameId ? await loadGame(gameId) : null;
    loaded().forEach((game) => game.onMatchFound?.());
    if (matched) app.currentGame = matched;
  });
  setTimeout(() => {
    setScreen("game");
    updateTurn(turn);
  }, 600);
});

// Games that render their own turn text (Flip Triples' phases, Only 3's
// side-to-move) claim the update by returning true from handleTurn.
socket.on("turn_update", ({ turn }) => {
  queue(() => {
    for (const game of loaded()) {
      if (game.handleTurn?.(turn)) return;
    }
    updateTurn(turn);
  });
});

socket.on("state_update", (payload) => {
  const entry = GAMES.find((g) => g.state && payload[g.state]) ?? entryFor("explodium");
  queue(async () => {
    const handler = await loadGame(entry.id);
    if (!handler) return;
    loaded().forEach((game) => {
      if (game !== handler) game.clearState?.();
    });
    handler.handleState(payload, resetGameUi);
  });
});

socket.on("opponent_left", () => {
  app.roomId = null;
  queue(() => {
    loaded().forEach((game) => game.onOpponentLeft?.());
    resetGameUi();
  });
  els.turnStatus.textContent = "Opponent left. Back to home.";
  setTimeout(() => setScreen("home"), 900);
});

function renderGames() {
  els.gameList.innerHTML = "";
  const visibleGames = GAMES.filter((game) => !game.hidden);
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

// The Playground button belongs to whatever Flip Triples exports, which we
// don't have until its module is here — so the row grows the button once the
// idle prefetch (or a click) has brought the game in.
function addPlaygroundButton(id, game) {
  if (!game?.openPlayground) return;
  const row = els.gameList.querySelector(`.game-card[data-game-id="${id}"]`)?.parentElement;
  if (!row || row.querySelector(".playground-btn")) return;
  const pg = document.createElement("button");
  pg.className = "playground-btn";
  pg.type = "button";
  pg.dataset.gameId = id;
  pg.textContent = "Playground";
  row.appendChild(pg);
}

function startSoloGame(selected, options = {}) {
  app.currentGame = selected;
  app.activeGameOptions = options;
  app.isSoloGame = true;
  app.isBotGame = false;
  app.botLevel = null;
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

function startBotGame(selected, botLevel, options = {}) {
  app.currentGame = selected;
  app.activeGameOptions = options;
  app.isSoloGame = false;
  app.isBotGame = true;
  app.botLevel = botLevel;
  els.lobbyGameName.textContent = selected.name;
  els.gameTitle.textContent = selected.name;
  resetGameUi();
  setScreen("lobby");
  const label = selected.botName ?? BOT_LEVEL_NAMES[botLevel] ?? `Level ${botLevel} bot`;
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

// A click can be the first thing that needs a game's code, so the home screen
// says so while it comes down rather than looking dead for a moment.
let openingGame = null;

async function withGame(id, then) {
  if (openingGame) return;
  const card = els.gameList.querySelector(`.game-card[data-game-id="${id}"]`);
  const label = card?.textContent;
  openingGame = id;
  if (card && !loadedGames.has(id)) card.textContent = "Loading...";
  try {
    const game = await loadGame(id);
    if (game) then(game);
  } finally {
    if (card && label) card.textContent = label;
    openingGame = null;
  }
}

els.gameList.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  const playgroundButton = target.closest(".playground-btn");
  if (playgroundButton) {
    const id = playgroundButton.dataset.gameId;
    if (id) withGame(id, (game) => game.openPlayground?.());
    return;
  }

  const soloButton = target.closest(".solo-btn");
  if (soloButton) {
    const id = soloButton.dataset.gameId;
    if (!id) return;
    withGame(id, (selected) => {
      // Games with a setup screen own the whole flow: they collect their options
      // and pick the opponent, then hand back to us to actually start.
      if (selected.openSetup) {
        selected.openSetup({
          mode: "solo",
          onReady: (options, botLevel) =>
            botLevel === null || botLevel === undefined
              ? startSoloGame(selected, options)
              : startBotGame(selected, botLevel, options)
        });
      } else if (selected.hasBots) {
        openSoloPicker(selected);
      } else {
        startSoloGame(selected);
      }
    });
    return;
  }

  const card = target.closest(".game-card");
  if (!card || !card.dataset.gameId) return;
  withGame(card.dataset.gameId, (selected) => {
    if (selected.openSetup) {
      selected.openSetup({ mode: "queue", onReady: (options) => startQueue(selected, options) });
      return;
    }
    // Games seated with AI opponents (Downstream) have no two-player queue —
    // the card just starts a table.
    if (selected.soloOnly) {
      startSoloGame(selected);
      return;
    }
    startQueue(selected);
  });
});

function startQueue(selected, options = {}) {
  app.currentGame = selected;
  app.activeGameOptions = options;
  app.isSoloGame = false;
  app.isBotGame = false;
  app.botLevel = null;
  els.lobbyGameName.textContent = selected.name;
  els.gameTitle.textContent = selected.name;
  resetGameUi();
  setScreen("lobby");
  els.lobbyStatus.textContent = "Waiting for another player...";
  els.playerStatus.textContent = "Queued";
  els.playersNeeded.textContent = "1";
  socket.emit("join_queue", { gameId: selected.id, options: app.activeGameOptions });
}

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
  loaded().forEach((game) => game.onExit?.());
  app.isSoloGame = false;
  app.isBotGame = false;
  app.botLevel = null;
  app.activeGameOptions = {};
  resetGameUi();
  setScreen("home");
});

renderGames();

// Once the home screen is up and the connection is idle, quietly pull in the
// games actually on offer. First paint stays tiny, and by the time anyone has
// read the buttons their game is usually already here.
const prefetch = () => {
  GAMES.filter((g) => !g.hidden).forEach((g) => {
    loadGame(g.id).then((game) => addPlaygroundButton(g.id, game));
  });
};
if ("requestIdleCallback" in window) requestIdleCallback(prefetch, { timeout: 3000 });
else window.addEventListener("load", () => setTimeout(prefetch, 300));
