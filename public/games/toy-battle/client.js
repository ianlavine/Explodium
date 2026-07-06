// Toy Battle client: node-graph board and the rack of drawable pieces.
import { socket, els, app, updateTurn } from "../../shared/context.js";

let toyBattleState = null;
let rackState = [];
let selectedToyPieceId = null;

function isActive() {
  return app.currentGame?.id === "toy-battle";
}

function getToyNodePosition(node) {
  return {
    x: 8 + node.col * 10.5,
    y: 6 + node.row * 14.666
  };
}

function renderToyBattleBoard() {
  if (!toyBattleState) return;
  els.gameBoard.innerHTML = "";
  els.gameBoard.classList.remove("player-0", "player-1", "flip-triples-board");
  els.gameBoard.classList.add("toy-battle-board");

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
  els.gameBoard.appendChild(svg);

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
    els.gameBoard.appendChild(button);
  });
}

function renderToyBattleRack() {
  els.hand.innerHTML = "";
  els.hand.classList.remove("player-0", "player-1", "flip-score");
  els.hand.classList.add("toy-rack");

  rackState.forEach((piece) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `toy-piece${piece.id === selectedToyPieceId ? " selected" : ""}`;
    button.dataset.pieceId = piece.id;
    button.textContent = piece.name;
    els.hand.appendChild(button);
  });

  const drawButton = document.createElement("button");
  drawButton.type = "button";
  drawButton.className = "draw-pieces";
  drawButton.textContent = `Draw 2 (${toyBattleState?.deckCount ?? 0})`;
  drawButton.disabled = !toyBattleState || toyBattleState.deckCount <= 0;
  els.hand.appendChild(drawButton);
}

els.hand.addEventListener("click", (event) => {
  if (!isActive()) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  const drawButton = target.closest(".draw-pieces");
  if (drawButton) {
    if (app.roomId) socket.emit("toy_battle_draw", { roomId: app.roomId });
    return;
  }

  const pieceButton = target.closest(".toy-piece");
  if (!pieceButton) return;
  selectedToyPieceId = pieceButton.dataset.pieceId || null;
  renderToyBattleRack();
});

els.gameBoard.addEventListener("click", (event) => {
  if (!isActive()) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  const node = target.closest(".toy-node");
  if (!node || !app.roomId || !selectedToyPieceId) return;
  socket.emit("toy_battle_place", {
    roomId: app.roomId,
    nodeId: node.dataset.nodeId,
    pieceId: selectedToyPieceId
  });
});

export const toyBattle = {
  id: "toy-battle",
  name: "Toy Battle",
  description: "",
  hidden: true,

  handleState(payload, resetGameUi) {
    if (!payload.toyBattle) return false;
    resetGameUi();
    toyBattleState = payload.toyBattle;
    rackState = payload.toyBattle.rack || [];
    if (!rackState.some((piece) => piece.id === selectedToyPieceId)) {
      selectedToyPieceId = rackState[0]?.id ?? null;
    }
    renderToyBattleBoard();
    renderToyBattleRack();
    updateTurn(payload.turn);
    return true;
  },

  resetUi() {},

  clearState() {
    toyBattleState = null;
    rackState = [];
  },

  onOpponentLeft() {},

  onExit() {
    toyBattleState = null;
    rackState = [];
    selectedToyPieceId = null;
  }
};
