// Where every cell is drawn, for both board shapes. Kept apart from the client
// so it has no DOM in it and can be checked directly against the engine's
// adjacency tables: the cells drawn touching a cell must be exactly the ones
// the rules call its neighbours, or the board lies about how it plays.
//
// Squares tile flush. Hexes are pointy-topped in offset rows — odd rows shift
// half a cell right, and each row sits three quarters of a hex below the one
// above, so the rows interlock. That overlap is what puts four diagonal
// neighbours within reach; without it they are just hexagons on a square grid.

export const SIZE = 10;
export const SQUARE_GAP = 4;
export const HEX_GAP = 3; // hexes read as a honeycomb with a tighter seam
// A pointy-top hexagon is this much taller than it is wide.
export const HEX_RATIO = 2 / Math.sqrt(3);
// The rows overlap by a quarter of a hex, so each step down is three quarters.
const ROW_STEP = 0.75;
// The seam between two rows runs at 60°, so a gap across it costs this much
// vertically rather than its full length.
const SEAM = Math.sqrt(3) / 2;

export const gapFor = (shape) => (shape === "hex" ? HEX_GAP : SQUARE_GAP);

// Everything needed to lay out and size a board of cells `width` px across.
export function metrics(shape, width) {
  const gap = gapFor(shape);
  if (shape === "hex") {
    const height = width * HEX_RATIO;
    const xStep = width + gap;
    const yStep = height * ROW_STEP + gap * SEAM;
    return {
      shape,
      width,
      height,
      xStep,
      yStep,
      indent: xStep / 2,
      boardWidth: (SIZE - 1) * xStep + xStep / 2 + width,
      boardHeight: (SIZE - 1) * yStep + height
    };
  }
  const step = width + gap;
  return {
    shape,
    width,
    height: width,
    xStep: step,
    yStep: step,
    indent: 0,
    boardWidth: (SIZE - 1) * step + width,
    boardHeight: (SIZE - 1) * step + width
  };
}

// Top-left corner of a cell's box, in board pixels.
export function positionOf(cell, m) {
  const row = Math.floor(cell / SIZE);
  return {
    x: (cell % SIZE) * m.xStep + (row % 2 ? m.indent : 0),
    y: row * m.yStep
  };
}

export function centerOf(cell, m) {
  const { x, y } = positionOf(cell, m);
  return { x: x + m.width / 2, y: y + m.height / 2 };
}

// Tokens sit inside their cell so the tile's colour still shows around them.
export const tokenSize = (m) => Math.round(m.width * 0.78);

// The largest cell width whose whole board still fits the space available —
// solved from the boardWidth/boardHeight above. Width and height are asked
// separately because a hex board is wider than it is tall, and squaring the
// box off would waste whichever side it did not need.
export function fitWidth(shape, availableWidth, availableHeight = availableWidth) {
  const gap = gapFor(shape);
  if (shape === "hex") {
    const byWidth = (availableWidth - (SIZE - 0.5) * gap) / (SIZE + 0.5);
    const byHeight =
      (availableHeight - (SIZE - 1) * gap * SEAM) / ((SIZE - 1) * ROW_STEP * HEX_RATIO + HEX_RATIO);
    return Math.min(byWidth, byHeight);
  }
  return Math.min(
    (availableWidth - (SIZE - 1) * gap) / SIZE,
    (availableHeight - (SIZE - 1) * gap) / SIZE
  );
}
