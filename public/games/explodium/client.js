// Explodium client: 14x14 tile-placement board and the hand of tile cards.
import { socket, els, app, updateTurn } from "../../shared/context.js";

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

function isActive() {
  // Explodium is the fallback renderer for any room without a dedicated module.
  return app.currentGame?.id !== "toy-battle" && app.currentGame?.id !== "flip-triples";
}

function renderHand() {
  els.hand.innerHTML = "";
  els.hand.classList.remove("player-0", "player-1", "toy-rack", "flip-score");
  if (app.myPlayerIndex !== null) {
    els.hand.classList.add(`player-${app.myPlayerIndex}`);
  }
  handState.forEach((count, index) => {
    const card = document.createElement("div");
    card.className = `tile-card${index === selectedTileType ? " selected" : ""}`;
    card.dataset.type = String(index);
    card.innerHTML = `
      <span class="tile-count">${count}</span>
      <div class="tile-icon type-${index}">${getTileSvg(index, null)}</div>
    `;
    els.hand.appendChild(card);
  });
}

function renderBoard() {
  if (!Array.isArray(boardState) || boardState.length === 0) return;
  els.gameBoard.classList.remove("player-0", "player-1", "toy-battle-board", "flip-triples-board");
  if (app.myPlayerIndex !== null) {
    els.gameBoard.classList.add(`player-${app.myPlayerIndex}`);
  }
  els.gameBoard.innerHTML = "";
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
      els.gameBoard.appendChild(cell);
    }
  }
}

els.hand.addEventListener("click", (event) => {
  if (!isActive()) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  const tileCard = target.closest(".tile-card");
  if (!tileCard) return;
  const type = Number(tileCard.dataset.type);
  if (Number.isNaN(type)) return;
  selectedTileType = type;
  renderHand();
});

els.gameBoard.addEventListener("click", (event) => {
  if (!isActive()) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  const cell = target.closest(".board-cell");
  if (!cell) return;
  if (!app.roomId) return;
  const row = Number(cell.dataset.row);
  const col = Number(cell.dataset.col);
  if (Number.isNaN(row) || Number.isNaN(col)) return;
  socket.emit("place_tile", {
    roomId: app.roomId,
    row,
    col,
    type: selectedTileType
  });
});

export const explodium = {
  id: "explodium",
  name: "Explodium",
  description: "",
  hidden: true,

  // Fallback handler: consumes any state_update carrying a board/hands payload.
  handleState({ board, hands, turn }, resetGameUi) {
    resetGameUi();
    boardState = board;
    handState = hands[app.myPlayerIndex] || [0, 0, 0, 0, 0];
    renderBoard();
    renderHand();
    updateTurn(turn);
    return true;
  },

  resetUi() {},

  clearState() {
    boardState = [];
    handState = [];
  },

  onOpponentLeft() {
    boardState = [];
    handState = [];
  },

  onExit() {
    boardState = [];
    handState = [];
  }
};
