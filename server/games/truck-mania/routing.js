// Server-side street routing for the AI drivers. This is a trimmed port of the
// client's graph/pathfinding: enough to find a route between two parking spots
// and count the red lights it crosses. The AI ignores the no-U-turn rule (it
// only needs to "basically" play), so this is a plain node Dijkstra.

const OCT_RADIUS = 13;

function streetToPolyline(street) {
  if (street.kind === "line") return [[street.x1, street.y1], [street.x2, street.y2]];
  const pts = [];
  for (let s = 0; s <= 20; s += 1) {
    const t = s / 20;
    const u = 1 - t;
    pts.push([
      u * u * street.x0 + 2 * u * t * street.cx + t * t * street.x1,
      u * u * street.y0 + 2 * u * t * street.cy + t * t * street.y1
    ]);
  }
  return pts;
}

function projectToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq ? ((px - x1) * dx + (py - y1) * dy) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  const x = x1 + t * dx;
  const y = y1 + t * dy;
  return { x, y, dist: Math.hypot(px - x, py - y) };
}

function dirBucket(dx, dy) {
  const deg = (((Math.atan2(dy, dx) * 180) / Math.PI + 180) % 180);
  return Math.round(deg / 15) % 12;
}

function segSegIntersection(a, b) {
  const rx = a[2] - a[0];
  const ry = a[3] - a[1];
  const sx = b[2] - b[0];
  const sy = b[3] - b[1];
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-9) return null;
  const qx = b[0] - a[0];
  const qy = b[1] - a[1];
  const t = (qx * sy - qy * sx) / denom;
  const u = (qx * ry - qy * rx) / denom;
  const eps = 1e-4;
  if (t < -eps || t > 1 + eps || u < -eps || u > 1 + eps) return null;
  return [a[0] + t * rx, a[1] + t * ry];
}

function findIntersections(streets) {
  const segs = [];
  streets.forEach((street, si) => {
    const pts = streetToPolyline(street);
    for (let p = 0; p < pts.length - 1; p += 1) {
      segs.push({ si, seg: [pts[p][0], pts[p][1], pts[p + 1][0], pts[p + 1][1]], dir: dirBucket(pts[p + 1][0] - pts[p][0], pts[p + 1][1] - pts[p][1]) });
    }
  });
  const points = [];
  for (let i = 0; i < segs.length; i += 1) {
    for (let j = i + 1; j < segs.length; j += 1) {
      if (segs[i].si === segs[j].si) continue;
      const p = segSegIntersection(segs[i].seg, segs[j].seg);
      if (!p) continue;
      let node = points.find((q) => (q.x - p[0]) ** 2 + (q.y - p[1]) ** 2 < 676);
      if (!node) {
        node = { x: p[0], y: p[1], dirs: new Set() };
        points.push(node);
      }
      node.dirs.add(segs[i].dir);
      node.dirs.add(segs[j].dir);
    }
  }
  return points
    .filter((n) => n.dirs.size >= 2)
    .map((n) => ({ x: Math.round(n.x), y: Math.round(n.y) }));
}

export function buildStreetGraph(streets, spots) {
  const nodePts = [];
  const nodeIds = new Map();
  const nodeId = (x, y) => {
    const k = `${Math.round(x)},${Math.round(y)}`;
    if (nodeIds.has(k)) return nodeIds.get(k);
    const id = nodePts.length;
    nodeIds.set(k, id);
    nodePts.push([x, y]);
    return id;
  };
  const adj = [];
  const addEdge = (a, b, w, pts) => {
    if (a === b) return;
    (adj[a] ||= []).push({ to: b, w, pts });
    (adj[b] ||= []).push({ to: a, w, pts: pts.slice().reverse() });
  };

  const pois = [
    ...findIntersections(streets).map((p) => [p.x, p.y]),
    ...spots.map((s) => [s.x, s.y])
  ];

  for (const street of streets) {
    const poly = streetToPolyline(street);
    const cum = [0];
    for (let i = 1; i < poly.length; i += 1) {
      cum.push(cum[i - 1] + Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]));
    }
    const consider = [...pois, poly[0], poly[poly.length - 1]];
    const onStreet = [];
    for (const [px, py] of consider) {
      let bestD = Infinity;
      let bestParam = 0;
      let bestPt = null;
      for (let i = 0; i < poly.length - 1; i += 1) {
        const pr = projectToSegment(px, py, poly[i][0], poly[i][1], poly[i + 1][0], poly[i + 1][1]);
        if (pr.dist < bestD) {
          bestD = pr.dist;
          bestParam = cum[i] + Math.hypot(pr.x - poly[i][0], pr.y - poly[i][1]);
          bestPt = [pr.x, pr.y];
        }
      }
      if (bestD < 5) onStreet.push({ param: bestParam, pt: bestPt });
    }
    onStreet.sort((a, b) => a.param - b.param);
    const uniq = [];
    for (const o of onStreet) {
      if (!uniq.length || o.param - uniq[uniq.length - 1].param > 0.5) uniq.push(o);
    }
    for (let i = 0; i < uniq.length - 1; i += 1) {
      const A = uniq[i];
      const B = uniq[i + 1];
      const pts = [A.pt];
      for (let j = 0; j < poly.length; j += 1) {
        if (cum[j] > A.param + 0.1 && cum[j] < B.param - 0.1) pts.push(poly[j]);
      }
      pts.push(B.pt);
      addEdge(nodeId(A.pt[0], A.pt[1]), nodeId(B.pt[0], B.pt[1]), B.param - A.param, pts);
    }
  }
  return { nodePts, adj };
}

function nearestNode(graph, x, y) {
  let best = -1;
  let bestD = Infinity;
  graph.nodePts.forEach((p, i) => {
    const d = (p[0] - x) ** 2 + (p[1] - y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

// Shortest driveable polyline between the two points, or null if disconnected.
export function findPath(graph, ax, ay, bx, by) {
  const start = nearestNode(graph, ax, ay);
  const goal = nearestNode(graph, bx, by);
  if (start < 0 || goal < 0) return null;
  if (start === goal) return [[ax, ay], [bx, by]];

  const n = graph.nodePts.length;
  const dist = new Array(n).fill(Infinity);
  const prev = new Array(n).fill(-1);
  const prevEdge = new Array(n).fill(null);
  const done = new Array(n).fill(false);
  dist[start] = 0;

  for (let iter = 0; iter < n; iter += 1) {
    let u = -1;
    let ud = Infinity;
    for (let i = 0; i < n; i += 1) {
      if (!done[i] && dist[i] < ud) {
        ud = dist[i];
        u = i;
      }
    }
    if (u === -1 || u === goal) break;
    done[u] = true;
    for (const e of graph.adj[u] ?? []) {
      const nd = dist[u] + e.w;
      if (nd < dist[e.to]) {
        dist[e.to] = nd;
        prev[e.to] = u;
        prevEdge[e.to] = e;
      }
    }
  }
  if (dist[goal] === Infinity) return null;

  const order = [];
  for (let u = goal; u !== -1; u = prev[u]) order.push(u);
  order.reverse();
  const pts = [graph.nodePts[order[0]].slice()];
  for (let i = 1; i < order.length; i += 1) {
    const e = prevEdge[order[i]];
    for (let k = 1; k < e.pts.length; k += 1) pts.push(e.pts[k].slice());
  }
  return pts;
}

// First (or last) unit direction along a polyline.
function polyDir(pts, fromEnd = false) {
  if (fromEnd) {
    for (let i = pts.length - 1; i > 0; i -= 1) {
      const dx = pts[i][0] - pts[i - 1][0];
      const dy = pts[i][1] - pts[i - 1][1];
      const len = Math.hypot(dx, dy);
      if (len > 0.01) return [dx / len, dy / len];
    }
  } else {
    for (let i = 1; i < pts.length; i += 1) {
      const dx = pts[i][0] - pts[0][0];
      const dy = pts[i][1] - pts[0][1];
      const len = Math.hypot(dx, dy);
      if (len > 0.01) return [dx / len, dy / len];
    }
  }
  return [1, 0];
}

const UTURN_COS = -0.966; // turns sharper than ~165° count as U-turns

// Directed, no-U-turn route from a heading to a goal, minimizing red lights then
// distance (same rules the human's client uses). Returns { path, reds, endAngle }
// or null if the goal can't be reached without a U-turn.
export function findRouteDirected(graph, intersections, ax, ay, headingDeg, bx, by) {
  const start = nearestNode(graph, ax, ay);
  const goal = nearestNode(graph, bx, by);
  if (start < 0 || goal < 0 || start === goal) return null;

  const RED_REACH = OCT_RADIUS;
  const redOcts = (intersections ?? [])
    .filter((o) => o.color === "red")
    .filter((o) =>
      Math.hypot(o.x - ax, o.y - ay) >= RED_REACH && Math.hypot(o.x - bx, o.y - by) >= RED_REACH
    );
  const arcReds = (e) => {
    let n = 0;
    const [sx, sy] = e.pts[0];
    for (const o of redOcts) {
      if (Math.hypot(o.x - sx, o.y - sy) < RED_REACH) continue;
      for (let i = 0; i < e.pts.length - 1; i += 1) {
        const pr = projectToSegment(o.x, o.y, e.pts[i][0], e.pts[i][1], e.pts[i + 1][0], e.pts[i + 1][1]);
        if (pr.dist < RED_REACH) {
          n += 1;
          break;
        }
      }
    }
    return n;
  };

  const better = (a, b) => a.reds < b.reds || (a.reds === b.reds && a.dist < b.dist);
  const states = new Map();
  const hx = Math.cos((headingDeg * Math.PI) / 180);
  const hy = Math.sin((headingDeg * Math.PI) / 180);
  (graph.adj[start] ?? []).forEach((e, k) => {
    const [dx, dy] = polyDir(e.pts);
    if (dx * hx + dy * hy <= 0) return; // can't reverse out of the spot
    states.set(`${start}:${k}`, { e, key: `${start}:${k}`, reds: arcReds(e), dist: e.w, prevKey: null, done: false });
  });

  for (;;) {
    let cur = null;
    for (const s of states.values()) {
      if (!s.done && (!cur || better(s, cur))) cur = s;
    }
    if (!cur) break;
    cur.done = true;
    const v = cur.e.to;
    const inDir = polyDir(cur.e.pts, true);
    (graph.adj[v] ?? []).forEach((e2, k2) => {
      const outDir = polyDir(e2.pts);
      if (inDir[0] * outDir[0] + inDir[1] * outDir[1] < UTURN_COS) return;
      const key2 = `${v}:${k2}`;
      const old = states.get(key2);
      const cand = { e: e2, key: key2, reds: cur.reds + arcReds(e2), dist: cur.dist + e2.w, prevKey: cur.key, done: false };
      if (!old || (!old.done && better(cand, old))) states.set(key2, cand);
    });
  }

  const arrivals = [...states.values()].filter((s) => s.e.to === goal);
  if (!arrivals.length) return null;
  arrivals.sort((a, b) => (better(a, b) ? -1 : 1));
  const best = arrivals[0];
  const chain = [];
  for (let st = best; st; st = st.prevKey ? states.get(st.prevKey) : null) chain.push(st);
  chain.reverse();
  const pts = [chain[0].e.pts[0].slice()];
  for (const st of chain) {
    for (let i = 1; i < st.e.pts.length; i += 1) pts.push(st.e.pts[i].slice());
  }
  const endDir = polyDir(best.e.pts, true);
  return { path: pts, reds: best.reds, endAngle: (Math.atan2(endDir[1], endDir[0]) * 180) / Math.PI };
}

// Red lights the path crosses (within an octagon radius of the polyline),
// ignoring any beside the start/end spot. Returns the total count plus the
// hour numbers of the numbered ones (which a clock change could flip).
export function redsOnPath(path, intersections, startPt, endPt) {
  const reds = (intersections ?? []).filter((o) => o.color === "red");
  let count = 0;
  const numbers = [];
  for (const o of reds) {
    if (Math.hypot(o.x - startPt[0], o.y - startPt[1]) < OCT_RADIUS) continue;
    if (Math.hypot(o.x - endPt[0], o.y - endPt[1]) < OCT_RADIUS) continue;
    let hit = false;
    for (let i = 0; i < path.length - 1; i += 1) {
      const pr = projectToSegment(o.x, o.y, path[i][0], path[i][1], path[i + 1][0], path[i + 1][1]);
      if (pr.dist < OCT_RADIUS) {
        hit = true;
        break;
      }
    }
    if (hit) {
      count += 1;
      if (o.number != null) numbers.push(o.number);
    }
  }
  return { count, numbers };
}
