// Bug Game bot lab: a fast board for evaluating thousands of candidate moves.
//
// The real engine (server/games/bug-game/engine.js) stays the referee — every
// move a bot makes goes through it, so an illegal move fails loudly. This file
// is only for LOOKING: the table as flat typed arrays, built once per decision,
// with moves tried in place and taken back.
//
//   sym[i]  what the top card shows: -1 no card, 0 empty, 1-4 bug S/R/P/G,
//           5 rock, 6 sprout
//   tok[i]  0 none, 1 poop, 2 rock token, 3+b baby of bug b
//   vis(i)  the bug showing there (a baby counts, a token hides a card bug)
import * as E from "../engine.js";

export const N = 200;
export const OFF = 100;
export const idx = (x, y) => (y + OFF) * N + (x + OFF);
export const xOf = (i) => (i % N) - OFF;
export const yOf = (i) => Math.floor(i / N) - OFF;
const LIMIT = 80;

export const BUG_INDEX = { S: 0, R: 1, P: 2, G: 3 };
const CODE = { ".": 0, S: 1, R: 2, P: 3, G: 4, X: 5, L: 6 };
export const EMPTY = 0;
export const ROCK = 5;
export const SPROUT = 6;
export const T_POOP = 1;
export const T_ROCK = 2;
export const T_BABY = 3;

// Every distinct orientation of every card: { rot, mirror, w, h, codes }.
export const VARIANTS = E.CARDS.map((_, card) => {
  const seen = new Set();
  const out = [];
  for (const mirror of [false, true]) {
    for (let rot = 0; rot < 4; rot += 1) {
      const g = E.oriented(card, rot, mirror);
      const sig = g.map((r) => r.join("")).join("/");
      if (seen.has(sig)) continue;
      seen.add(sig);
      const h = g.length;
      const w = g[0].length;
      const codes = new Int8Array(w * h);
      for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) codes[y * w + x] = CODE[g[y][x]];
      out.push({ rot, mirror, w, h, codes });
    }
  }
  return out;
});

// The 8 turns and mirrors of each dance as cell offsets (dx, dy) from 0,0.
export const DANCE_SHAPES = E.DANCES.map((d) => {
  const shapes = [];
  const seen = new Set();
  let cells = d.cells.map(([r, c]) => [c, r]);
  for (let m = 0; m < 2; m += 1) {
    for (let r = 0; r < 4; r += 1) {
      const minX = Math.min(...cells.map((p) => p[0]));
      const minY = Math.min(...cells.map((p) => p[1]));
      const s = cells.map(([x, y]) => [x - minX, y - minY]).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
      const sig = s.map((p) => p.join(",")).join(";");
      if (!seen.has(sig)) {
        seen.add(sig);
        // As flat index offsets too, for the hot loop.
        shapes.push({ cells: s, offs: s.map(([x, y]) => y * N + x) });
      }
      cells = cells.map(([x, y]) => [-y, x]);
    }
    cells = cells.map(([x, y]) => [-x, y]);
  }
  return shapes;
});

const SIDE = [1, -1, N, -N];

export class Board {
  constructor() {
    this.sym = new Int8Array(N * N);
    this.tok = new Int8Array(N * N);
    this.poopAdj = new Uint8Array(N * N); // how many poop tokens touch this cell
    this.near = new Uint8Array(N * N); // board, or sharing a side with it
    this.stamp = new Int32Array(N * N);
    this.stampN = 0;
    this.stack = new Int32Array(N * N);
  }

  // Rebuild from the engine's state. `owners[b]` is the seat playing bug b, or -1.
  load(state) {
    this.state = state;
    this.sym.fill(-1);
    this.tok.fill(0);
    this.poopAdj.fill(0);
    this.near.fill(0);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of state.placed) {
      const v = VARIANTS[p.card].find((q) => q.rot === p.rot && q.mirror === !!p.mirror) ?? variantOf(p);
      for (let dy = 0; dy < v.h; dy += 1) {
        for (let dx = 0; dx < v.w; dx += 1) this.sym[idx(p.x + dx, p.y + dy)] = v.codes[dy * v.w + dx];
      }
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + v.w - 1);
      maxY = Math.max(maxY, p.y + v.h - 1);
    }
    for (const t of state.tokens) {
      const i = idx(t.x, t.y);
      this.tok[i] = t.type === "poop" ? T_POOP : t.type === "rock" ? T_ROCK : T_BABY + BUG_INDEX[t.bug];
      if (t.type === "poop") for (const s of SIDE) this.poopAdj[i + s] += 1;
      minX = Math.min(minX, t.x);
      minY = Math.min(minY, t.y);
      maxX = Math.max(maxX, t.x);
      maxY = Math.max(maxY, t.y);
    }
    Object.assign(this, { minX, minY, maxX, maxY });
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const i = idx(x, y);
        if (this.sym[i] >= 0 || this.tok[i]) {
          this.near[i] = 1;
          for (const s of SIDE) this.near[i + s] = 1;
        }
      }
    }
    this.owners = [-1, -1, -1, -1];
    state.seats.forEach((s, seat) => {
      this.owners[BUG_INDEX[s.bug]] = seat;
    });
    this.cells = [[], [], [], []];
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const i = idx(x, y);
        const b = this.vis(i);
        if (b >= 0) this.cells[b].push(i);
      }
    }
    return this;
  }

  vis(i) {
    const t = this.tok[i];
    if (t >= T_BABY) return t - T_BABY;
    if (t) return -1;
    const c = this.sym[i];
    return c >= 1 && c <= 4 ? c - 1 : -1;
  }

  // --- scoring ---------------------------------------------------------------

  // Score of bug b from a list of the cells it shows on (list must be exact).
  scoreList(b, list) {
    let poop = 0;
    for (let k = 0; k < list.length; k += 1) if (this.poopAdj[list[k]]) poop += 2;
    return list.length + poop + this.groupScore(b, list);
  }

  // (number of groups of 2+) x (size of the biggest), orthogonal.
  groupScore(b, list) {
    const st = ++this.stampN;
    const stamp = this.stamp;
    const stack = this.stack;
    let groups = 0;
    let biggest = 0;
    for (let k = 0; k < list.length; k += 1) {
      const start = list[k];
      if (stamp[start] === st) continue;
      stamp[start] = st;
      let top = 0;
      stack[top++] = start;
      let size = 0;
      while (top) {
        const i = stack[--top];
        size += 1;
        for (let s = 0; s < 4; s += 1) {
          const n = i + SIDE[s];
          if (stamp[n] !== st && this.vis(n) === b) {
            stamp[n] = st;
            stack[top++] = n;
          }
        }
      }
      if (size >= 2) {
        groups += 1;
        if (size > biggest) biggest = size;
      }
    }
    return groups * biggest;
  }

  score(b) {
    return this.scoreList(b, this.cells[b]);
  }

  // The best partial match of a dance for bug b: the most pattern cells any one
  // placement of it has covered by b. `list` = the cells b shows on.
  danceProgress(b, dance, list = this.cells[b]) {
    let best = 0;
    const need = E.DANCES[dance].cells.length;
    for (const shape of DANCE_SHAPES[dance]) {
      const offs = shape.offs;
      for (let k = 0; k < list.length; k += 1) {
        const c = list[k];
        for (let p = 0; p < offs.length; p += 1) {
          const anchor = c - offs[p];
          let hit = 0;
          for (let q = 0; q < offs.length; q += 1) if (this.vis(anchor + offs[q]) === b) hit += 1;
          if (hit > best) {
            best = hit;
            if (best === need) return best;
          }
        }
      }
    }
    return best;
  }

  // --- moves -----------------------------------------------------------------

  // Every legal placement of a card: [{ v, x, y }].
  cardMoves(card) {
    const out = [];
    for (const v of VARIANTS[card]) {
      for (let y = this.minY - v.h; y <= this.maxY + 1; y += 1) {
        if (Math.abs(y) > LIMIT) continue;
        for (let x = this.minX - v.w; x <= this.maxX + 1; x += 1) {
          if (Math.abs(x) > LIMIT) continue;
          if (this.cardFits(v, x, y)) out.push({ v, x, y });
        }
      }
    }
    return out;
  }

  // cardMoves without building the list: fn(v, x, y) for each legal one.
  eachCardMove(card, fn) {
    for (const v of VARIANTS[card]) {
      for (let y = this.minY - v.h; y <= this.maxY + 1; y += 1) {
        if (Math.abs(y) > LIMIT) continue;
        for (let x = this.minX - v.w; x <= this.maxX + 1; x += 1) {
          if (Math.abs(x) > LIMIT) continue;
          if (this.cardFits(v, x, y)) fn(v, x, y);
        }
      }
    }
  }

  cardFits(v, x, y) {
    let connected = false;
    for (let dy = 0; dy < v.h; dy += 1) {
      const row = idx(x, y + dy);
      for (let dx = 0; dx < v.w; dx += 1) {
        const i = row + dx;
        if (this.tok[i] || this.sym[i] === ROCK) return false;
        if (this.near[i]) connected = true;
      }
    }
    return connected;
  }

  // Lay a card in place; returns what's needed to take it back, plus which
  // bugs it touched and what it earned bug `me` (sprouts eaten, own bugs bred).
  applyCard(v, x, y, me) {
    const undo = [];
    let touched = 0; // bitmask of bugs gained or lost
    let ate = 0;
    let bred = 0;
    for (let dy = 0; dy < v.h; dy += 1) {
      const row = idx(x, y + dy);
      for (let dx = 0; dx < v.w; dx += 1) {
        const i = row + dx;
        const old = this.sym[i];
        const now = v.codes[dy * v.w + dx];
        undo.push(i, old);
        if (old >= 1 && old <= 4) touched |= 1 << (old - 1);
        if (now >= 1 && now <= 4) {
          touched |= 1 << (now - 1);
          if (now - 1 === me) {
            if (old === SPROUT) ate += 1;
            else if (old === now) bred += 1;
          }
        }
        this.sym[i] = now;
      }
    }
    return { undo, touched, ate, bred };
  }

  revert(undo) {
    for (let k = undo.length - 2; k >= 0; k -= 2) this.sym[undo[k]] = undo[k + 1];
  }

  // The exact cell list for bug b after a card was applied: the old list minus
  // what's covered, plus the new cells.
  listAfterCard(b, v, x, y) {
    const out = [];
    const st = ++this.stampN;
    const list = this.cells[b];
    for (let k = 0; k < list.length; k += 1) {
      const i = list[k];
      this.stamp[i] = st;
      if (this.vis(i) === b) out.push(i);
    }
    for (let dy = 0; dy < v.h; dy += 1) {
      const row = idx(x, y + dy);
      for (let dx = 0; dx < v.w; dx += 1) {
        const i = row + dx;
        if (v.codes[dy * v.w + dx] === b + 1 && this.stamp[i] !== st) out.push(i);
      }
    }
    return out;
  }

  // Cells a token may go on for `seat`: free board cells not showing another
  // player's bug, and empty cells beside the board.
  tokenCells(seat) {
    const out = [];
    for (let y = this.minY - 1; y <= this.maxY + 1; y += 1) {
      if (Math.abs(y) > LIMIT) continue;
      for (let x = this.minX - 1; x <= this.maxX + 1; x += 1) {
        if (Math.abs(x) > LIMIT) continue;
        const i = idx(x, y);
        if (this.tok[i]) continue;
        const c = this.sym[i];
        if (c < 0) {
          if (this.near[i]) out.push(i);
          continue;
        }
        if (c >= 1 && c <= 4) {
          const owner = this.owners[c - 1];
          if (owner !== -1 && owner !== seat) continue;
        }
        out.push(i);
      }
    }
    return out;
  }

  // Put a token down in place (type T_POOP / T_ROCK / T_BABY+b); returns the
  // bugs it touched. Take it back with removeToken.
  placeToken(i, t) {
    let touched = 0;
    const was = this.vis(i);
    if (was >= 0) touched |= 1 << was;
    this.tok[i] = t;
    if (t === T_POOP) {
      for (const s of SIDE) {
        this.poopAdj[i + s] += 1;
        const n = this.vis(i + s);
        if (n >= 0) touched |= 1 << n;
      }
    }
    if (t >= T_BABY) touched |= 1 << (t - T_BABY);
    return touched;
  }

  removeToken(i) {
    if (this.tok[i] === T_POOP) for (const s of SIDE) this.poopAdj[i + s] -= 1;
    this.tok[i] = 0;
  }

  // Bug b's exact list after a token went on cell i.
  listAfterToken(b, i) {
    const out = [];
    for (const c of this.cells[b]) if (c !== i) out.push(c);
    if (this.vis(i) === b) out.push(i);
    return out;
  }
}

function variantOf(p) {
  // An orientation identical to another one was deduplicated; rebuild it.
  const g = E.oriented(p.card, p.rot, p.mirror);
  const h = g.length;
  const w = g[0].length;
  const codes = new Int8Array(w * h);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) codes[y * w + x] = CODE[g[y][x]];
  return { rot: p.rot, mirror: !!p.mirror, w, h, codes };
}
