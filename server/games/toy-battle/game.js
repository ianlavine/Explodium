// Toy Battle: piece-placement prototype on a randomly generated node graph.
import { shuffle } from "../../lib/util.js";

const TOY_BATTLE_TYPES = ["Kwak", "Skully", "Cap'n", "Jumbo", "Hook", "XB-42", "Star", "Roxy"];

function createToyBattleDeck() {
  return shuffle(
    TOY_BATTLE_TYPES.flatMap((name) =>
      Array.from({ length: 3 }, (_, copy) => ({
        id: `${name.toLowerCase().replace(/[^a-z0-9]/g, "")}-${copy}`,
        name
      }))
    )
  );
}

function createToyBattleBoard() {
  const nodes = [];
  const nodeByPosition = new Map();
  const addNode = (row, col, base = null) => {
    const key = `${row}-${col}`;
    if (nodeByPosition.has(key)) return nodeByPosition.get(key);
    const node = {
      id: `n-${row}-${col}`,
      row,
      col,
      base,
      piece: null
    };
    nodes.push(node);
    nodeByPosition.set(key, node);
    return node;
  };

  addNode(0, 4, "blue");
  addNode(6, 4, "red");
  for (let row = 1; row <= 5; row += 1) {
    addNode(row, 4);
    for (let col = 0; col <= 8; col += 1) {
      if (col === 4) continue;
      if (Math.random() < 0.42) addNode(row, col);
    }
  }

  const edges = [];
  const edgeKeys = new Set();
  const addEdge = (a, b) => {
    if (!a || !b || a.id === b.id) return;
    const key = [a.id, b.id].sort().join(":");
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ from: a.id, to: b.id });
  };

  for (let row = 0; row < 6; row += 1) {
    addEdge(nodeByPosition.get(`${row}-4`), nodeByPosition.get(`${row + 1}-4`));
  }

  nodes.forEach((node) => {
    nodes.forEach((other) => {
      const rowGap = Math.abs(node.row - other.row);
      const colGap = Math.abs(node.col - other.col);
      if (rowGap + colGap === 0) return;
      if (rowGap <= 1 && colGap <= 2 && rowGap + colGap <= 2 && Math.random() < 0.5) {
        addEdge(node, other);
      }
    });
  });

  return { nodes, edges };
}

function createToyBattleState() {
  const deck = createToyBattleDeck();
  return {
    ...createToyBattleBoard(),
    deck,
    rack: deck.splice(0, 3)
  };
}

export function createToyBattleGame({ io, rooms }) {
  function emitState(roomId, room) {
    io.to(roomId).emit("state_update", {
      toyBattle: {
        nodes: room.toyBattle.nodes,
        edges: room.toyBattle.edges,
        rack: room.toyBattle.rack,
        deckCount: room.toyBattle.deck.length
      },
      turn: room.turn
    });
  }

  return {
    id: "toy-battle",

    createRoomState() {
      return { toyBattle: createToyBattleState() };
    },

    emitState,

    registerHandlers(socket) {
      socket.on("toy_battle_place", ({ roomId, nodeId, pieceId } = {}) => {
        const room = rooms.get(roomId);
        if (!room || room.gameId !== "toy-battle") return;
        if (room.turn !== socket.id) return;
        const node = room.toyBattle.nodes.find((candidate) => candidate.id === nodeId);
        if (!node || node.base || node.piece) return;
        const pieceIndex = room.toyBattle.rack.findIndex((piece) => piece.id === pieceId);
        if (pieceIndex === -1) return;
        const [piece] = room.toyBattle.rack.splice(pieceIndex, 1);
        node.piece = { ...piece, player: 0 };
        emitState(roomId, room);
      });

      socket.on("toy_battle_draw", ({ roomId } = {}) => {
        const room = rooms.get(roomId);
        if (!room || room.gameId !== "toy-battle") return;
        if (room.turn !== socket.id) return;
        const drawn = room.toyBattle.deck.splice(0, 2);
        room.toyBattle.rack.push(...drawn);
        emitState(roomId, room);
      });
    }
  };
}
