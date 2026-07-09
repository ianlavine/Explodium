// Procedural abstract city map.
//
// Pipeline:
//  1. Build a rectilinear street grid. Two map corners are rounded into tangent
//     arcs so the border streets flow through them — specifically NOT
//     intersections. Prune interior walls (merging blocks) until the map has
//     roughly TARGET_INTERSECTIONS intersections. An intersection is any point
//     where streets with two distinct directions meet (X, T, corner junctions).
//  2. Add exactly one diagonal avenue (spanning multiple blocks, 27–63° slope)
//     and one curving street (leaves a street tangentially, bends 90° into a
//     different direction). Both are rejected if they would carve off a sliver —
//     a white region too thin to be a real block — or blow the budget.
//  3. Rasterize street centerlines into a coarse grid; clearance[cell] =
//     distance to the nearest street edge. Flood-fill open cells into regions —
//     the true blocks.
//  4. Place exactly TOTAL_BUILDINGS buildings. Blocks earn buildings in
//     proportion to their area (bigger block → more buildings). Each building is
//     shaped by its surroundings: rectangles sit ~parallel to the streets around
//     them; next to a diagonal or curve, a right triangle with its hypotenuse
//     ~parallel to that street. Sizes, tilt, and distance-from-street all jitter.

const MAP_W = 960;
const MAP_H = 720;
const STREET_W = 10;

// Two generation profiles: the classic board, and a denser one (smaller grid
// cells → more blocks; higher building budget + per-block cap) used by ticket
// mode, which needs room for 12 chore locations and 3 special buildings on top
// of the usual pickups/dropoffs.
const PROFILES = {
  classic: {
    minCell: 140, maxCell: 210,
    targetIntersections: 30, totalBuildings: 27,
    blockCap: 3, minRadius: 19, maxRadius: 66
  },
  dense: {
    minCell: 105, maxCell: 165,
    targetIntersections: 38, totalBuildings: 48,
    blockCap: 4, minRadius: 16, maxRadius: 54
  }
};

const GRID = 4; // rasterization cell size in px
const CLEARANCE_CAP = 72; // clearance beyond this doesn't matter for sizing
const SLIVER_CLEARANCE = 15; // regions thinner than this reject a street
const BUILDING_MARGIN = 5; // minimum gap between building and street edge
const BUILDING_GAP = 10; // gap between buildings in the same block
const MIN_INTERSECTIONS = 26; // 24 numbered octagons + the two square corners

function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function randBetween(rng, min, max) {
  return min + rng() * (max - min);
}

function randInt(rng, min, max) {
  return Math.floor(randBetween(rng, min, max + 1));
}

function pick(rng, items) {
  return items[Math.floor(rng() * items.length)];
}

function shuffle(rng, items) {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const k = Math.floor(rng() * (i + 1));
    [items[i], items[k]] = [items[k], items[i]];
  }
  return items;
}

// ---------------------------------------------------------------------------
// Street grid
// ---------------------------------------------------------------------------

function buildGridLines(rng, max, minCell, maxCell) {
  const lines = [0];
  while (lines[lines.length - 1] < max) {
    const step = randInt(rng, minCell, maxCell);
    const next = lines[lines.length - 1] + step;
    if (next >= max - minCell / 2) {
      lines.push(max);
      break;
    }
    lines.push(next);
  }
  if (lines[lines.length - 1] !== max) lines.push(max);
  return lines;
}

// walls.vertical[vi][j] = wall on vertical line vi between hLines[j] and j+1.
// walls.horizontal[hi][i] = wall on horizontal line hi between vLines[i] and i+1.
// Border lines stay intact; only interior walls are ever pruned.
function makeWalls(V, H) {
  return {
    vertical: Array.from({ length: V }, () => Array(H - 1).fill(true)),
    horizontal: Array.from({ length: H }, () => Array(V - 1).fill(true))
  };
}

function nodeCounts(walls, V, H, vi, hi) {
  let v = 0;
  let h = 0;
  if (hi > 0 && walls.vertical[vi][hi - 1]) v += 1;
  if (hi < H - 1 && walls.vertical[vi][hi]) v += 1;
  if (vi > 0 && walls.horizontal[hi][vi - 1]) h += 1;
  if (vi < V - 1 && walls.horizontal[hi][vi]) h += 1;
  return { v, h };
}

// A node stays valid if it remains a junction (≥3 streets) or a straight
// pass-through. Corners (an L where two streets jog) are what make pruned
// grids look like mazes instead of city streets, so they're not allowed.
function nodeStaysValid(v, h) {
  return v + h >= 3 || (v === 2 && h === 0) || (v === 0 && h === 2);
}

// Border streets, with the chosen corners rounded into tangent arcs so the two
// border roads flow into each other instead of meeting at an intersection.
function buildBorderStreets(rounded) {
  const { tl, tr, br, bl } = rounded;
  const streets = [
    { kind: "line", x1: tl, y1: 0, x2: MAP_W - tr, y2: 0, width: STREET_W },
    { kind: "line", x1: bl, y1: MAP_H, x2: MAP_W - br, y2: MAP_H, width: STREET_W },
    { kind: "line", x1: 0, y1: tl, x2: 0, y2: MAP_H - bl, width: STREET_W },
    { kind: "line", x1: MAP_W, y1: tr, x2: MAP_W, y2: MAP_H - br, width: STREET_W }
  ];
  if (tl) streets.push({ kind: "curve", x0: tl, y0: 0, cx: 0, cy: 0, x1: 0, y1: tl, width: STREET_W });
  if (tr) streets.push({ kind: "curve", x0: MAP_W - tr, y0: 0, cx: MAP_W, cy: 0, x1: MAP_W, y1: tr, width: STREET_W });
  if (br) streets.push({ kind: "curve", x0: MAP_W, y0: MAP_H - br, cx: MAP_W, cy: MAP_H, x1: MAP_W - br, y1: MAP_H, width: STREET_W });
  if (bl) streets.push({ kind: "curve", x0: 0, y0: MAP_H - bl, cx: 0, cy: MAP_H, x1: bl, y1: MAP_H, width: STREET_W });
  return streets;
}

// Merge surviving interior walls into maximal straight runs — one street each.
function buildInteriorStreets(walls, vLines, hLines) {
  const streets = [];
  const V = vLines.length;
  const H = hLines.length;
  for (let vi = 1; vi < V - 1; vi += 1) {
    let start = -1;
    for (let j = 0; j <= H - 1; j += 1) {
      const present = j < H - 1 && walls.vertical[vi][j];
      if (present && start === -1) start = j;
      else if (!present && start !== -1) {
        streets.push({
          kind: "line",
          x1: vLines[vi],
          y1: hLines[start],
          x2: vLines[vi],
          y2: hLines[j],
          width: STREET_W
        });
        start = -1;
      }
    }
  }
  for (let hi = 1; hi < H - 1; hi += 1) {
    let start = -1;
    for (let i = 0; i <= V - 1; i += 1) {
      const present = i < V - 1 && walls.horizontal[hi][i];
      if (present && start === -1) start = i;
      else if (!present && start !== -1) {
        streets.push({
          kind: "line",
          x1: vLines[start],
          y1: hLines[hi],
          x2: vLines[i],
          y2: hLines[hi],
          width: STREET_W
        });
        start = -1;
      }
    }
  }
  return streets;
}

// Grid nodes that still have both a vertical and a horizontal street incident —
// natural places for a diagonal or curve to start or end. Map corners are
// excluded: two of them are rounded and none should anchor an avenue.
function intersectionNodes(walls, vLines, hLines) {
  const V = vLines.length;
  const H = hLines.length;
  const nodes = [];
  for (let vi = 0; vi < V; vi += 1) {
    for (let hi = 0; hi < H; hi += 1) {
      if ((vi === 0 || vi === V - 1) && (hi === 0 || hi === H - 1)) continue;
      const vInc =
        (hi > 0 && walls.vertical[vi][hi - 1]) || (hi < H - 1 && walls.vertical[vi][hi]);
      const hInc =
        (vi > 0 && walls.horizontal[hi][vi - 1]) || (vi < V - 1 && walls.horizontal[hi][vi]);
      if (vInc && hInc) nodes.push({ vi, hi, x: vLines[vi], y: hLines[hi] });
    }
  }
  return nodes;
}

// ---------------------------------------------------------------------------
// Intersection counting
// ---------------------------------------------------------------------------

function streetToPolyline(street) {
  if (street.kind === "line") {
    return [[street.x1, street.y1], [street.x2, street.y2]];
  }
  const pts = [];
  const steps = 20;
  for (let s = 0; s <= steps; s += 1) {
    const t = s / steps;
    const u = 1 - t;
    pts.push([
      u * u * street.x0 + 2 * u * t * street.cx + t * t * street.x1,
      u * u * street.y0 + 2 * u * t * street.cy + t * t * street.y1
    ]);
  }
  return pts;
}

function dirBucket(dx, dy) {
  const deg = ((Math.atan2(dy, dx) * 180) / Math.PI + 180) % 180;
  return Math.round(deg / 15) % 12;
}

function segSegIntersection(a, b) {
  const rx = a.x2 - a.x1;
  const ry = a.y2 - a.y1;
  const sx = b.x2 - b.x1;
  const sy = b.y2 - b.y1;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-9) return null; // parallel — never a point crossing
  const qx = b.x1 - a.x1;
  const qy = b.y1 - a.y1;
  const t = (qx * sy - qy * sx) / denom;
  const u = (qx * ry - qy * rx) / denom;
  const eps = 1e-4;
  if (t < -eps || t > 1 + eps || u < -eps || u > 1 + eps) return null;
  return [a.x1 + t * rx, a.y1 + t * ry];
}

// A point counts as an intersection when streets with at least two distinct
// directions meet there (X, T, and corner junctions alike). Tangent joins —
// like a rounded map corner or a street curving away — share a direction
// bucket, so they are not intersections.
function findIntersections(streets) {
  const segs = [];
  streets.forEach((street, si) => {
    const pts = streetToPolyline(street);
    for (let p = 0; p < pts.length - 1; p += 1) {
      const [x1, y1] = pts[p];
      const [x2, y2] = pts[p + 1];
      segs.push({ si, x1, y1, x2, y2, dir: dirBucket(x2 - x1, y2 - y1) });
    }
  });

  const points = [];
  for (let i = 0; i < segs.length; i += 1) {
    for (let j = i + 1; j < segs.length; j += 1) {
      if (segs[i].si === segs[j].si) continue;
      const p = segSegIntersection(segs[i], segs[j]);
      if (!p) continue;
      // Crossings closer than ~26px are one junction — also keeps two octagons
      // (radius 13) from ever overlapping.
      let node = points.find((q) => (q.x - p[0]) ** 2 + (q.y - p[1]) ** 2 < 676);
      if (!node) {
        node = { x: p[0], y: p[1], dirs: new Set() };
        points.push(node);
      }
      node.dirs.add(segs[i].dir);
      node.dirs.add(segs[j].dir);
    }
  }
  return points.filter((n) => n.dirs.size >= 2);
}

function countIntersections(streets) {
  return findIntersections(streets).length;
}

// Remove interior walls (merging blocks) until the intersection count drops to
// the target. A wall is only removable if both its endpoints stay valid nodes,
// so streets never dead-end mid-block or jog around corners.
function pruneGrid(rng, walls, vLines, hLines, borders, target) {
  const V = vLines.length;
  const H = hLines.length;
  const candidates = [];
  for (let vi = 1; vi < V - 1; vi += 1) {
    for (let j = 0; j < H - 1; j += 1) candidates.push({ type: "v", vi, j });
  }
  for (let hi = 1; hi < H - 1; hi += 1) {
    for (let i = 0; i < V - 1; i += 1) candidates.push({ type: "h", hi, i });
  }
  shuffle(rng, candidates);

  const countNow = () =>
    countIntersections([...borders, ...buildInteriorStreets(walls, vLines, hLines)]);

  let count = countNow();
  for (const cand of candidates) {
    if (count <= target) break;
    const ends =
      cand.type === "v"
        ? [[cand.vi, cand.j], [cand.vi, cand.j + 1]]
        : [[cand.i, cand.hi], [cand.i + 1, cand.hi]];
    const invalid = ends.some(([vi, hi]) => {
      const { v, h } = nodeCounts(walls, V, H, vi, hi);
      return !nodeStaysValid(cand.type === "v" ? v - 1 : v, cand.type === "h" ? h - 1 : h);
    });
    if (invalid) continue;
    if (cand.type === "v") walls.vertical[cand.vi][cand.j] = false;
    else walls.horizontal[cand.hi][cand.i] = false;
    count = countNow();
  }
  return count;
}

// ---------------------------------------------------------------------------
// Rasterization: clearance field + block regions
// ---------------------------------------------------------------------------

function collectSegments(streets) {
  const segs = [];
  for (const street of streets) {
    const pts = streetToPolyline(street);
    for (let p = 0; p < pts.length - 1; p += 1) {
      segs.push([pts[p][0], pts[p][1], pts[p + 1][0], pts[p + 1][1]]);
    }
  }
  return segs;
}

function distSqToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq ? ((px - x1) * dx + (py - y1) * dy) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  const ex = px - (x1 + t * dx);
  const ey = py - (y1 + t * dy);
  return ex * ex + ey * ey;
}

// clearance[cell] = distance from cell center to the nearest street *edge*
// (centerline distance minus half the street width), capped at CLEARANCE_CAP.
function buildClearanceField(segments, gw, gh) {
  const clearance = new Float32Array(gw * gh).fill(CLEARANCE_CAP);
  const reach = CLEARANCE_CAP + STREET_W / 2;

  for (const [x1, y1, x2, y2] of segments) {
    const gx0 = Math.max(0, Math.floor((Math.min(x1, x2) - reach) / GRID));
    const gx1 = Math.min(gw - 1, Math.ceil((Math.max(x1, x2) + reach) / GRID));
    const gy0 = Math.max(0, Math.floor((Math.min(y1, y2) - reach) / GRID));
    const gy1 = Math.min(gh - 1, Math.ceil((Math.max(y1, y2) + reach) / GRID));

    for (let gy = gy0; gy <= gy1; gy += 1) {
      const py = gy * GRID + GRID / 2;
      for (let gx = gx0; gx <= gx1; gx += 1) {
        const px = gx * GRID + GRID / 2;
        const d = Math.sqrt(distSqToSegment(px, py, x1, y1, x2, y2)) - STREET_W / 2;
        const idx = gy * gw + gx;
        if (d < clearance[idx]) clearance[idx] = Math.max(0, d);
      }
    }
  }
  return clearance;
}

// Flood-fill open cells (clearance > 0) into connected regions = city blocks.
function findRegions(clearance, gw, gh) {
  const labels = new Int32Array(gw * gh).fill(-1);
  const regions = [];
  const stack = [];

  for (let start = 0; start < gw * gh; start += 1) {
    if (labels[start] !== -1 || clearance[start] <= 0) continue;
    const id = regions.length;
    const cells = [];
    stack.push(start);
    labels[start] = id;
    while (stack.length) {
      const idx = stack.pop();
      cells.push(idx);
      const gx = idx % gw;
      const gy = (idx / gw) | 0;
      if (gx > 0) tryVisit(idx - 1);
      if (gx < gw - 1) tryVisit(idx + 1);
      if (gy > 0) tryVisit(idx - gw);
      if (gy < gh - 1) tryVisit(idx + gw);
    }
    regions.push(cells);
  }

  function tryVisit(idx) {
    if (labels[idx] === -1 && clearance[idx] > 0) {
      labels[idx] = regions.length;
      stack.push(idx);
    }
  }

  return regions;
}

// The little pocket outside a rounded corner's arc is not a city block.
function isCornerPocket(cells, gw, cornerZones) {
  if (!cornerZones.length) return false;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const idx of cells) {
    const px = (idx % gw) * GRID + GRID / 2;
    const py = ((idx / gw) | 0) * GRID + GRID / 2;
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }
  return cornerZones.some((z) => {
    const fx = Math.max(Math.abs(minX - z.x), Math.abs(maxX - z.x));
    const fy = Math.max(Math.abs(minY - z.y), Math.abs(maxY - z.y));
    return Math.hypot(fx, fy) <= z.reach;
  });
}

// Would this street set leave a white region too thin to be a real block?
function hasSliver(streets, gw, gh, cornerZones) {
  const clearance = buildClearanceField(collectSegments(streets), gw, gh);
  const regions = findRegions(clearance, gw, gh);
  return regions.some((cells) => {
    if (isCornerPocket(cells, gw, cornerZones)) return false;
    let maxC = 0;
    for (const idx of cells) {
      if (clearance[idx] > maxC) maxC = clearance[idx];
    }
    return maxC < SLIVER_CLEARANCE;
  });
}

// ---------------------------------------------------------------------------
// Diagonal avenue + curving street
// ---------------------------------------------------------------------------

// One diagonal avenue between two grid intersections at a 27–63° slope,
// spanning ≥2 cells in both directions so it crosses streets like a real
// avenue. Rejected if it would overshoot the budget or carve a sliver.
function addDiagonal(rng, streets, nodes, gw, gh, count, cornerZones, target) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const a = pick(rng, nodes);
    const b = pick(rng, nodes);
    if (Math.abs(a.vi - b.vi) < 2 || Math.abs(a.hi - b.hi) < 2) continue;
    const slope = (Math.atan2(Math.abs(b.y - a.y), Math.abs(b.x - a.x)) * 180) / Math.PI;
    if (slope < 27 || slope > 63) continue;

    const cand = { kind: "line", x1: a.x, y1: a.y, x2: b.x, y2: b.y, width: STREET_W };
    const next = [...streets, cand];
    const nextCount = countIntersections(next);
    if (nextCount > target - 2) continue; // leave room for the curve
    if (hasSliver(next, gw, gh, cornerZones)) continue;
    return { streets: next, count: nextCount, ends: [a, b] };
  }
  return { streets, count, ends: [] };
}

// One street that curves into a different direction: it leaves node A tangent
// to one axis and arrives at node B heading along the other, sweeping through
// the blocks in between like a road bending 90°.
function addCurve(rng, streets, nodes, gw, gh, count, cornerZones, usedNodes, target) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const a = pick(rng, nodes);
    const b = pick(rng, nodes);
    const dvi = Math.abs(a.vi - b.vi);
    const dhi = Math.abs(a.hi - b.hi);
    if (dvi < 1 || dhi < 1 || dvi + dhi < 3) continue;
    if (usedNodes.some((n) => (n.vi === a.vi && n.hi === a.hi) || (n.vi === b.vi && n.hi === b.hi))) {
      continue;
    }

    const control = rng() < 0.5 ? [b.x, a.y] : [a.x, b.y];
    const cand = {
      kind: "curve",
      x0: a.x,
      y0: a.y,
      cx: control[0],
      cy: control[1],
      x1: b.x,
      y1: b.y,
      width: STREET_W
    };
    const next = [...streets, cand];
    const nextCount = countIntersections(next);
    if (nextCount > target) continue; // hard ceiling
    if (hasSliver(next, gw, gh, cornerZones)) continue;
    return { streets: next, count: nextCount };
  }
  return { streets, count };
}

// ---------------------------------------------------------------------------
// Building placement
// ---------------------------------------------------------------------------

// Direction of and normal to the street nearest to (px, py).
function nearestStreetInfo(segments, px, py) {
  let bestD = Infinity;
  let best = null;
  for (const [x1, y1, x2, y2] of segments) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq ? ((px - x1) * dx + (py - y1) * dy) / lenSq : 0;
    t = Math.max(0, Math.min(1, t));
    const qx = x1 + t * dx;
    const qy = y1 + t * dy;
    const d = (px - qx) ** 2 + (py - qy) ** 2;
    if (d < bestD) {
      bestD = d;
      best = { qx, qy, dx, dy };
    }
  }
  const angle = Math.atan2(best.dy, best.dx);
  let nx = px - best.qx;
  let ny = py - best.qy;
  const nl = Math.hypot(nx, ny) || 1;
  return { angle, nx: nx / nl, ny: ny / nl };
}

// Shape a building to its surroundings, fitting inside the circle (cx, cy, r).
// Next to an axis-aligned street: a rectangle ~parallel to it, sized and tilted
// with some randomness. Next to a diagonal or curve: a right triangle with its
// hypotenuse ~parallel to that street and the right angle pointing away.
function makeBuilding(rng, cx, cy, r, palette, info) {
  const color = pick(rng, palette);
  const deg = (((info.angle * 180) / Math.PI) % 180 + 180) % 180;
  const offAxis = Math.min(deg, Math.abs(deg - 90), 180 - deg);

  if (offAxis > 15) {
    const theta = info.angle + randBetween(rng, -0.06, 0.06);
    const ux = Math.cos(theta);
    const uy = Math.sin(theta);
    // Normal pointing from the street toward the building center.
    let nx = -uy;
    let ny = ux;
    if (nx * info.nx + ny * info.ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    const p = randBetween(rng, 0.3, 0.4); // hypotenuse offset toward street
    const qMax = Math.sqrt(0.96 ** 2 - p * p) - p;
    const q = qMax * randBetween(rng, 0.9, 1); // right-angle corner away
    const half = (p + q) * r;
    return {
      kind: "triangle",
      color,
      points: [
        [cx - nx * p * r + ux * half, cy - ny * p * r + uy * half],
        [cx - nx * p * r - ux * half, cy - ny * p * r - uy * half],
        [cx + nx * q * r, cy + ny * q * r]
      ]
    };
  }

  const rd = r * randBetween(rng, 0.85, 0.98);
  const phi = randBetween(rng, 0.5, 1.07); // aspect: ~2:1 wide to ~1:2 tall
  const w = 2 * rd * Math.cos(phi);
  const h = 2 * rd * Math.sin(phi);
  const rotation = randBetween(rng, -3.5, 3.5); // a tad off kilter
  return { kind: "rect", color, rotation, x: cx - w / 2, y: cy - h / 2, w, h };
}

// Place one building in the block. The site is picked with jitter — any cell
// nearly as roomy as the best one qualifies — so margins vary building to
// building. Returns false when nothing fits anymore.
function placeOne(rng, block, clearance, gw, segments, palette, cfg) {
  let bestFit = 0;
  const fits = [];
  for (const idx of block.cells) {
    let fit = clearance[idx] - BUILDING_MARGIN - GRID * 0.75;
    if (fit < cfg.minRadius) continue;
    const gx = (idx % gw) * GRID + GRID / 2;
    const gy = ((idx / gw) | 0) * GRID + GRID / 2;
    for (const placed of block.placed) {
      const d = Math.hypot(gx - placed.cx, gy - placed.cy) - placed.r - BUILDING_GAP;
      if (d < fit) fit = d;
    }
    if (fit < cfg.minRadius) continue;
    fits.push({ idx, fit });
    if (fit > bestFit) bestFit = fit;
  }
  if (!fits.length) return false;

  const pool = fits.filter((f) => f.fit >= Math.max(cfg.minRadius, bestFit * 0.85));
  const chosen = pick(rng, pool);
  const cx = (chosen.idx % gw) * GRID + GRID / 2;
  const cy = ((chosen.idx / gw) | 0) * GRID + GRID / 2;
  const r = Math.min(chosen.fit, cfg.maxRadius);
  const info = nearestStreetInfo(segments, cx, cy);
  block.placed.push({ cx, cy, r });
  block.buildings.push(makeBuilding(rng, cx, cy, r, palette, info));
  return true;
}

// Hand out exactly cfg.totalBuildings buildings. Every block that can hold one
// gets one (biggest first); the rest go to the block with the most area per
// building so far (bigger block → more buildings). Soft cap of cfg.blockCap per
// block; lifted only if every other block is full.
function placeAllBuildings(rng, blocks, clearance, gw, segments, palette, cfg) {
  let placedTotal = 0;
  const byArea = [...blocks].sort((a, b) => b.areaPx - a.areaPx);
  for (const block of byArea) {
    if (placedTotal >= cfg.totalBuildings) break;
    if (placeOne(rng, block, clearance, gw, segments, palette, cfg)) placedTotal += 1;
    else block.exhausted = true;
  }
  while (placedTotal < cfg.totalBuildings) {
    let cand = null;
    let bestScore = -1;
    for (const capped of [false, true]) {
      for (const block of blocks) {
        if (block.exhausted) continue;
        if (!capped && block.buildings.length >= cfg.blockCap) continue;
        const score = block.areaPx / (block.buildings.length + 1);
        if (score > bestScore) {
          bestScore = score;
          cand = block;
        }
      }
      if (cand) break;
    }
    if (!cand) break;
    if (placeOne(rng, cand, clearance, gw, segments, palette, cfg)) placedTotal += 1;
    else cand.exhausted = true;
  }
  return placedTotal;
}

// ---------------------------------------------------------------------------
// Connector lines: tiny driveways from buildings to the streets around them
// ---------------------------------------------------------------------------

function buildingEdges(building) {
  let corners;
  if (building.kind === "triangle") {
    corners = building.points;
  } else {
    const cx = building.x + building.w / 2;
    const cy = building.y + building.h / 2;
    const a = ((building.rotation || 0) * Math.PI) / 180;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    corners = [
      [-building.w / 2, -building.h / 2],
      [building.w / 2, -building.h / 2],
      [building.w / 2, building.h / 2],
      [-building.w / 2, building.h / 2]
    ].map(([x, y]) => [cx + x * cos - y * sin, cy + x * sin + y * cos]);
  }
  const ccx = corners.reduce((s, p) => s + p[0], 0) / corners.length;
  const ccy = corners.reduce((s, p) => s + p[1], 0) / corners.length;

  return corners.map((p, i) => {
    const q = corners[(i + 1) % corners.length];
    const mx = (p[0] + q[0]) / 2;
    const my = (p[1] + q[1]) / 2;
    let nx = q[1] - p[1];
    let ny = p[0] - q[0];
    const nl = Math.hypot(nx, ny) || 1;
    nx /= nl;
    ny /= nl;
    if (nx * (mx - ccx) + ny * (my - ccy) < 0) {
      nx = -nx;
      ny = -ny;
    }
    return { mx, my, nx, ny };
  });
}

// March each edge's outward normal until it hits a street; keep the rays that
// reach one unobstructed, then connect only a random subset of them — a
// building never plugs into every street it could see.
function buildingConnectors(rng, building, blockPlaced, self, segments) {
  const candidates = [];
  for (const edge of buildingEdges(building)) {
    let hit = null;
    for (let t = 4; t <= 70; t += 2) {
      const px = edge.mx + edge.nx * t;
      const py = edge.my + edge.ny * t;
      if (px < 0 || px > MAP_W || py < 0 || py > MAP_H) break;
      let dMin = Infinity;
      for (const [x1, y1, x2, y2] of segments) {
        const d = distSqToSegment(px, py, x1, y1, x2, y2);
        if (d < dMin) dMin = d;
      }
      if (Math.sqrt(dMin) <= STREET_W / 2 - 1) {
        hit = { x: px, y: py };
        break;
      }
    }
    if (!hit) continue;

    const blocked = blockPlaced.some((p) => {
      if (p === self) return false;
      return distSqToSegment(p.cx, p.cy, edge.mx, edge.my, hit.x, hit.y) < (p.r * 0.9) ** 2;
    });
    if (blocked) continue;

    candidates.push({
      x1: Math.round(edge.mx * 10) / 10,
      y1: Math.round(edge.my * 10) / 10,
      x2: Math.round(hit.x * 10) / 10,
      y2: Math.round(hit.y * 10) / 10
    });
  }

  if (!candidates.length) return [];
  shuffle(rng, candidates);
  const keep = Math.max(1, candidates.length - randInt(rng, 1, 2));
  return candidates.slice(0, keep);
}

// ---------------------------------------------------------------------------
// Octagon signals at intersections
// ---------------------------------------------------------------------------

// 24 intersections get numbered octagons — every number 1–12 appears once in
// green and once in red. Leftovers (and the two square map corners) are
// permanently green or red with no number. Assignment is randomized.
export function assignOctagons(rng, points) {
  const isMapCorner = (p) =>
    (p.x < 20 || p.x > MAP_W - 20) && (p.y < 20 || p.y > MAP_H - 20);

  const eligible = shuffle(rng, points.filter((p) => !isMapCorner(p)));
  const corners = points.filter((p) => isMapCorner(p));

  const octagons = [];
  for (let i = 0; i < eligible.length; i += 1) {
    const p = eligible[i];
    let number = null;
    let color = rng() < 0.5 ? "green" : "red";
    if (i < 12) {
      number = i + 1;
      color = "green";
    } else if (i < 24) {
      number = i - 11;
      color = "red";
    }
    octagons.push({ x: Math.round(p.x), y: Math.round(p.y), number, color });
  }
  for (const p of corners) {
    octagons.push({
      x: Math.round(p.x),
      y: Math.round(p.y),
      number: null,
      color: rng() < 0.5 ? "green" : "red"
    });
  }
  return octagons;
}

// Reshuffle the stoplights over the same intersection positions — numbers and
// colors are dealt fresh, the map layout is untouched.
export function randomizeOctagons(octagons) {
  return assignOctagons(() => Math.random(), octagons.map(({ x, y }) => ({ x, y })));
}

// Recolor the blank (unnumbered) stoplights in place: of the blanks, `green`
// become green and `red` become red (dealt in a random order); any blanks past
// green+red stay a coin flip. The 24 numbered signs are untouched.
export function setBlankLights(octagons, green, red) {
  const blanks = octagons.filter((o) => o.number == null);
  for (let i = blanks.length - 1; i > 0; i -= 1) {
    const k = Math.floor(Math.random() * (i + 1));
    [blanks[i], blanks[k]] = [blanks[k], blanks[i]];
  }
  blanks.forEach((o, i) => {
    if (i < green) o.color = "green";
    else if (i < green + red) o.color = "red";
    else o.color = Math.random() < 0.5 ? "green" : "red";
  });
  return octagons;
}

// A "spot" is a parking place where a truck sits: the street-end of a building
// connector. Its facing is parallel to the street it sits on.
export function deriveSpots(map) {
  const segs = collectSegments(map.streets);
  const spots = [];
  let bid = 0;
  for (const block of map.blocks ?? []) {
    for (const b of block.buildings ?? []) {
      b.bid = bid; // stable index, same order client and server flatten in
      bid += 1;
      for (const c of b.connectors ?? []) {
        let best = null;
        let bestD = Infinity;
        for (const seg of segs) {
          const d = distSqToSegment(c.x2, c.y2, seg[0], seg[1], seg[2], seg[3]);
          if (d < bestD) {
            bestD = d;
            best = seg;
          }
        }
        const angle = best ? Math.atan2(best[3] - best[1], best[2] - best[0]) : 0;
        spots.push({
          x: c.x2,
          y: c.y2,
          angle: Math.round((angle * 180) / Math.PI),
          building: b.bid
        });
      }
    }
  }
  return spots;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function generateCityMap(seed = Date.now(), { dense = false } = {}) {
  const cfg = dense ? PROFILES.dense : PROFILES.classic;
  const rng = mulberry32(Number(seed) || 1);
  // Regenerate until there are enough intersections for the 24 numbered
  // octagons (plus the square corners). Nearly always succeeds first try.
  let map = generateOnce(rng, seed, cfg);
  for (let attempt = 0; attempt < 8 && map.intersections.length < MIN_INTERSECTIONS; attempt += 1) {
    map = generateOnce(rng, seed, cfg);
  }
  return map;
}

function generateOnce(rng, seed, cfg) {
  const vLines = buildGridLines(rng, MAP_W, cfg.minCell, cfg.maxCell);
  const hLines = buildGridLines(rng, MAP_H, cfg.minCell, cfg.maxCell);
  const walls = makeWalls(vLines.length, hLines.length);
  const gw = Math.ceil(MAP_W / GRID);
  const gh = Math.ceil(MAP_H / GRID);

  // Round two of the four map corners.
  const rounded = { tl: 0, tr: 0, br: 0, bl: 0 };
  const cornerKeys = shuffle(rng, ["tl", "tr", "br", "bl"]).slice(0, 2);
  cornerKeys.forEach((k) => {
    rounded[k] = randBetween(rng, 64, 100);
  });
  const cornerZones = cornerKeys.map((k) => ({
    x: k === "tl" || k === "bl" ? 0 : MAP_W,
    y: k === "tl" || k === "tr" ? 0 : MAP_H,
    reach: rounded[k] * 1.4
  }));

  const borders = buildBorderStreets(rounded);

  // Leave the diagonal and the curve headroom to bring the count back up.
  pruneGrid(rng, walls, vLines, hLines, borders, cfg.targetIntersections - randInt(rng, 4, 6));

  let streets = [...borders, ...buildInteriorStreets(walls, vLines, hLines)];
  let count = countIntersections(streets);
  const nodes = intersectionNodes(walls, vLines, hLines);

  let diagonalEnds = [];
  ({ streets, count, ends: diagonalEnds } = addDiagonal(rng, streets, nodes, gw, gh, count, cornerZones, cfg.targetIntersections));
  ({ streets, count } = addCurve(rng, streets, nodes, gw, gh, count, cornerZones, diagonalEnds, cfg.targetIntersections));

  const segments = collectSegments(streets);
  const clearance = buildClearanceField(segments, gw, gh);
  const regions = findRegions(clearance, gw, gh);

  const blocks = regions
    .filter((cells) => !isCornerPocket(cells, gw, cornerZones))
    .map((cells) => ({
      cells,
      areaPx: cells.length * GRID * GRID,
      placed: [],
      buildings: [],
      exhausted: false
    }));

  const palette = ["#c97b63", "#6b8f71", "#d4a056", "#7d8aa5", "#b8849f", "#8f7e6b"];
  placeAllBuildings(rng, blocks, clearance, gw, segments, palette, cfg);

  for (const block of blocks) {
    block.buildings.forEach((building, i) => {
      building.connectors = buildingConnectors(
        rng,
        building,
        block.placed,
        block.placed[i],
        segments
      );
    });
  }

  const outBlocks = blocks
    .filter((b) => b.buildings.length)
    .map((b, i) => ({ id: `block-${i}`, area: Math.round(b.areaPx), buildings: b.buildings }));

  return {
    seed,
    width: MAP_W,
    height: MAP_H,
    streetWidth: STREET_W,
    rounded: { tl: Math.round(rounded.tl), tr: Math.round(rounded.tr), br: Math.round(rounded.br), bl: Math.round(rounded.bl) },
    intersections: assignOctagons(rng, findIntersections(streets)),
    streets,
    blocks: outBlocks,
    spots: deriveSpots({ streets, blocks: outBlocks })
  };
}
