// Explodium: tile-placement game on a 14x14 board. Tiles project path markers
// along rows/columns/diagonals depending on their type; extension tiles double
// a tile's range and destroy tiles clear enemy tiles along the path.

const BOARD_SIZE = 14;
const TILE_TYPES = 5;
const TILES_PER_TYPE = 4;
const squareType = 1;
const diamondType = 0;
const circleType = 2;
const extensionType = 3;
const destroyType = 4;
const maxRangeSquare = 3;
const maxRangeDiamond = 3;
const maxRangeCircle = 2;

function getTile(cell) {
  if (!cell || typeof cell !== "object") return null;
  if ("player" in cell && "type" in cell) return cell;
  return cell.tile ?? null;
}

function getMarkers(cell) {
  if (!cell || typeof cell !== "object") return [];
  if ("markers" in cell && Array.isArray(cell.markers)) return cell.markers;
  return [];
}

function normalizeCell(board, r, c) {
  const cell = board[r][c];
  const existingTile = getTile(cell);
  if (!cell || typeof cell !== "object" || !("markers" in cell)) {
    board[r][c] = { tile: existingTile ?? null, markers: [] };
  } else if (!("tile" in cell)) {
    cell.tile = existingTile ?? null;
  }
  return board[r][c];
}

function recomputeMarkers(room) {
  const tiles = [];
  for (let r = 0; r < BOARD_SIZE; r += 1) {
    for (let c = 0; c < BOARD_SIZE; c += 1) {
      const cell = normalizeCell(room.board, r, c);
      const tile = getTile(cell);
      if (tile) {
        if (typeof tile.placedAt !== "number") {
          room.moveIndex += 1;
          tile.placedAt = room.moveIndex;
        }
        tile.rangeBoost = 1;
        tiles.push({ r, c, tile });
      }
      cell.markers = [];
    }
  }

  tiles.sort((a, b) => a.tile.placedAt - b.tile.placedAt);

  const normalizeMarkers = (markers) =>
    markers.map((marker) => (typeof marker === "number" ? { player: marker, filled: false } : marker));
  const hasBlockingNormal = (pathCells) =>
    pathCells.some(([r, c]) => {
      const cell = room.board[r][c];
      const tile = getTile(cell);
      if (tile) return true;
      const markers = normalizeMarkers(getMarkers(cell));
      return markers.length > 0;
    });
  const markCell = (r, c, player, filled = false) => {
    const cell = normalizeCell(room.board, r, c);
    const markers = normalizeMarkers(getMarkers(cell));
    const existing = markers.find((marker) => marker.player === player);
    if (existing) {
      if (filled) existing.filled = true;
    } else {
      markers.push({ player, filled });
    }
    cell.markers = markers;
  };

  for (let i = 0; i < tiles.length; i += 1) {
    const newEntry = tiles[i];
    const newTile = newEntry.tile;
    const currentNew = getTile(room.board[newEntry.r][newEntry.c]);
    if (!currentNew || currentNew.placedAt !== newTile.placedAt) continue;
    for (let j = 0; j < i; j += 1) {
      const travelerEntry = tiles[j];
      const traveler = travelerEntry.tile;
      const currentTraveler = getTile(room.board[travelerEntry.r][travelerEntry.c]);
      if (!currentTraveler || currentTraveler.placedAt !== traveler.placedAt) continue;
      if (traveler.player !== newTile.player) continue;
      if (traveler.type === destroyType || traveler.type === extensionType) continue;

      const dr = newEntry.r - travelerEntry.r;
      const dc = newEntry.c - travelerEntry.c;
      if (dr === 0 && dc === 0) continue;

      const rangeBoost = traveler.rangeBoost ?? 1;
      if (traveler.type === squareType) {
        const sameRow = dr === 0;
        const sameCol = dc === 0;
        const distance = sameRow ? Math.abs(dc) : sameCol ? Math.abs(dr) : null;
        if (distance === null || distance > maxRangeSquare * rangeBoost) continue;
        const stepR = sameRow ? 0 : dr > 0 ? 1 : -1;
        const stepC = sameCol ? 0 : dc > 0 ? 1 : -1;
        const path = [];
        let rr = travelerEntry.r + stepR;
        let cc = travelerEntry.c + stepC;
        while (rr !== newEntry.r || cc !== newEntry.c) {
          path.push([rr, cc]);
          rr += stepR;
          cc += stepC;
        }
        if (!path.length) {
          if (newTile.type === extensionType) traveler.rangeBoost = rangeBoost * 2;
          continue;
        }
        if (newTile.type === destroyType) {
          path.forEach(([r, c]) => {
            const cell = normalizeCell(room.board, r, c);
            const tile = getTile(cell);
            if (tile && tile.player !== newTile.player) {
              cell.tile = null;
            } else if (tile) {
              return;
            }
            const markers = normalizeMarkers(getMarkers(cell)).filter(
              (marker) => marker.player === newTile.player
            );
            cell.markers = markers;
            markCell(r, c, newTile.player, true);
          });
        } else {
          if (hasBlockingNormal(path)) continue;
          path.forEach(([r, c]) => {
            if (!getTile(room.board[r][c])) markCell(r, c, newTile.player);
          });
          if (newTile.type === extensionType) traveler.rangeBoost = rangeBoost * 2;
        }
      } else if (traveler.type === diamondType) {
        if (Math.abs(dr) !== Math.abs(dc)) continue;
        if (Math.abs(dr) > maxRangeDiamond * rangeBoost) continue;
        const stepR = dr > 0 ? 1 : -1;
        const stepC = dc > 0 ? 1 : -1;
        const path = [];
        let rr = travelerEntry.r + stepR;
        let cc = travelerEntry.c + stepC;
        while (rr !== newEntry.r || cc !== newEntry.c) {
          path.push([rr, cc]);
          rr += stepR;
          cc += stepC;
        }
        if (!path.length) {
          if (newTile.type === extensionType) traveler.rangeBoost = rangeBoost * 2;
          continue;
        }
        if (newTile.type === destroyType) {
          path.forEach(([r, c]) => {
            const cell = normalizeCell(room.board, r, c);
            const tile = getTile(cell);
            if (tile && tile.player !== newTile.player) {
              cell.tile = null;
            } else if (tile) {
              return;
            }
            const markers = normalizeMarkers(getMarkers(cell)).filter(
              (marker) => marker.player === newTile.player
            );
            cell.markers = markers;
            markCell(r, c, newTile.player, true);
          });
        } else {
          if (hasBlockingNormal(path)) continue;
          path.forEach(([r, c]) => {
            if (!getTile(room.board[r][c])) markCell(r, c, newTile.player);
          });
          if (newTile.type === extensionType) traveler.rangeBoost = rangeBoost * 2;
        }
      } else if (traveler.type === circleType) {
        const isOrth = dr === 0 || dc === 0;
        const isDiag = Math.abs(dr) === Math.abs(dc);
        if (!isOrth && !isDiag) continue;
        const distance = Math.max(Math.abs(dr), Math.abs(dc));
        if (distance > maxRangeCircle * rangeBoost) continue;
        const stepR = dr === 0 ? 0 : dr > 0 ? 1 : -1;
        const stepC = dc === 0 ? 0 : dc > 0 ? 1 : -1;
        const path = [];
        let rr = travelerEntry.r + stepR;
        let cc = travelerEntry.c + stepC;
        while (rr !== newEntry.r || cc !== newEntry.c) {
          path.push([rr, cc]);
          rr += stepR;
          cc += stepC;
        }
        if (!path.length) {
          if (newTile.type === extensionType) traveler.rangeBoost = rangeBoost * 2;
          continue;
        }
        if (newTile.type === destroyType) {
          path.forEach(([r, c]) => {
            const cell = normalizeCell(room.board, r, c);
            const tile = getTile(cell);
            if (tile && tile.player !== newTile.player) {
              cell.tile = null;
            } else if (tile) {
              return;
            }
            const markers = normalizeMarkers(getMarkers(cell)).filter(
              (marker) => marker.player === newTile.player
            );
            cell.markers = markers;
            markCell(r, c, newTile.player, true);
          });
        } else {
          if (hasBlockingNormal(path)) continue;
          path.forEach(([r, c]) => {
            if (!getTile(room.board[r][c])) markCell(r, c, newTile.player);
          });
          if (newTile.type === extensionType) traveler.rangeBoost = rangeBoost * 2;
        }
      }
    }
  }
}

export function createExplodiumGame({ io, rooms }) {
  function emitState(roomId, room) {
    io.to(roomId).emit("state_update", {
      board: room.board,
      hands: room.hands,
      turn: room.turn
    });
  }

  return {
    id: "explodium",
    supportsBot: false,

    createRoomState() {
      const board = Array.from({ length: BOARD_SIZE }, () =>
        Array.from({ length: BOARD_SIZE }, () => ({ tile: null, markers: [] }))
      );
      const hands = Array.from({ length: 2 }, () =>
        Array.from({ length: TILE_TYPES }, () => TILES_PER_TYPE)
      );
      return { board, hands, moveIndex: 0 };
    },

    emitState,

    registerHandlers(socket) {
      socket.on("place_tile", ({ roomId, row, col, type }) => {
        const room = rooms.get(roomId);
        if (!room) return;
        if (room.gameId !== "explodium") return;
        if (room.turn !== socket.id) return;
        if (row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) return;
        if (type < 0 || type >= TILE_TYPES) return;

        const playerIndex = room.players.indexOf(socket.id);
        if (playerIndex === -1) return;
        if (room.hands[playerIndex][type] <= 0) return;
        const existingCell = room.board[row][col];
        const existingTile =
          existingCell && typeof existingCell === "object" && "player" in existingCell && "type" in existingCell
            ? existingCell
            : existingCell?.tile ?? null;
        if (existingTile) return;
        if (existingCell && Array.isArray(existingCell.markers) && existingCell.markers.length > 0) return;
        if (!existingCell || typeof existingCell !== "object" || !("markers" in existingCell)) {
          room.board[row][col] = { tile: null, markers: [] };
        }

        room.moveIndex += 1;
        room.board[row][col].tile = { player: playerIndex, type, placedAt: room.moveIndex };
        room.hands[playerIndex][type] -= 1;
        recomputeMarkers(room);

        const [a, b] = room.players;
        room.turn = socket.id === a ? b : a;
        emitState(roomId, room);
        io.to(roomId).emit("turn_update", { turn: room.turn });
      });
    }
  };
}
