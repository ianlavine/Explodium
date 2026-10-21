// Bluff Race client: Coup Path laid out round, as a table you play on by hand.
// Nothing here knows the rules -- the table moves its own pieces, makes its
// own claims and keeps its own score -- so this is just the components:
//
//   the board   -- the spaces, round a wavy loop that fills the screen (it
//                  dips in and out so more spaces fit than on a plain ring).
//                  One gap at the top, between the finish and the start.
//   the pieces  -- five stacks of three discs, one a life, one per colour;
//                  slim enough that four share a space. Charged, a stack is
//                  flipped over: that side has a lightning bolt on top.
//                  Drag a stack onto a space (or off the track, or into the
//                  lost lives); hover one and press F to flip it, D to take a
//                  disc off; click one for the same as buttons.
//   lost lives  -- five spots in the middle (three over two). A disc taken
//                  off a stack flies to its colour's spot and stacks up there.
//                  Click one to send it back to its stack (no stack on the
//                  board: it starts a new one on the start), or drag the lot
//                  onto the board. A game starts with every stack in here.
//   the die     -- below them. Click it, or hover it and press R.
//   the deck    -- beside it, lying sideways, always shuffled: a draw is a
//                  random card.
//                  Click it, or hover it and press D. A card drawn or
//                  returned flies between the deck and that player, for
//                  everyone.
//   your hand   -- in the notch under the bottom of the loop, face up to
//                  you only, peeking up from the edge; hover it and it rises.
//                  Click a card to show it to the table (and hide it again),
//                  or return it to the deck. A card the table can see is
//                  ringed in yellow under a SHOWING banner.
//   the others  -- seats are relative: everyone sees their own hand at the
//                  bottom and the (up to four) others in the corners -- the
//                  next seats round the table on the lower left, then the
//                  upper left, the upper right and the lower right -- small,
//                  face down, or face up for a card they're showing.
//
// Players have no colour -- the pieces are the table's. The log of who did
// what is behind the little round i in the top right, the controls behind
// the ? beside it: click to open, click anywhere else to close.
import { socket, els, app } from "../../shared/context.js";

const W = 1500; // the board's world, in its own units
const H = 800;

// The loop: r = 1 + DEPTH * w(LOBES * t + PHASE), stretched sideways by
// STRETCH, where w is a sine sharpened by SHARP (w = sign(sin) |sin|^SHARP:
// 1 is a plain wave, smaller is squarer -- the loop runs straight in and
// straight out, which packs the spaces closer and lets them be bigger). The
// spaces + 1 places sit evenly along it (the extra one is the gap at the
// top). Searched for the biggest spaces at 60 that keep the arms of the
// loop apart, the corner panels clear and room for the die and deck.
const LOBES = 6;
const DEPTH = 0.375;
const STRETCH = 1.8;
const SHARP = 0.4;
const PHASE = (3 * Math.PI) / 2;
const SPACE = 0.4; // a space's radius, as a share of the spacing
const PIECE = 0.36; // a piece's radius, as a share of a space's
const DISC = 0.62; // a disc's thickness, as a share of the piece's radius

const KIND = {
  S: { cls: "start", name: "Start" },
  F: { cls: "finish", name: "Finish" },
  R: { cls: "back", name: "Backward" },
  G: { cls: "fwd", name: "Forward" },
  Y: { cls: "bonus", name: "Bonus" },
  ".": { cls: "blank", name: "Blank" }
};

// The five piece colours, in the server's order (it names the seats).
const PIECE_COLORS = {
  Blue: { top: "#8fd0fa", side: "#4a98cf" },
  Black: { top: "#3a3f48", side: "#16191e" },
  Orange: { top: "#f7a04a", side: "#c2651c" },
  Purple: { top: "#9468f7", side: "#5c36bf" },
  Green: { top: "#1f7d4b", side: "#0e4a2b" }
};
const COLOR_ORDER = Object.keys(PIECE_COLORS);

// The five characters (Coup Path v10). The text is a reminder for the
// table, not something the page enforces.
const CHARS = {
  Sticky: { color: "#d94f4f", text: "Land on a red: stay where you are." },
  Zoomie: { color: "#27a05f", text: "Land on a green: roll again." },
  Magician: { color: "#2a87a0", text: "End on a blank: take a bonus, or swap places with anyone on a blank." },
  Thief: { color: "#454b58", text: "Spend your charge: steal a roll and move it now, as your own turn." },
  Sheriff: { color: "#c99716", text: "Block a Thief and take their charge." }
};

const ICON = {
  Sticky: `<path d="M0 -10 C6 -3 8 1 8 4 A8 8 0 0 1 -8 4 C-8 1 -6 -3 0 -10 Z" fill="currentColor"/>`,
  Zoomie: `<path d="M-9 -7 L-2 0 L-9 7 M0 -7 L7 0 L0 7" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`,
  Magician: `<path d="M-11 5 H11 V8.5 H-11 Z M-6.5 5 V-9 H6.5 V5 Z" fill="currentColor"/><rect x="-6.5" y="0" width="13" height="2.4" fill="#fff" opacity=".55"/>`,
  Thief: `<path fill-rule="evenodd" fill="currentColor" d="M-11 -3 C-6 -7.5 6 -7.5 11 -3 C11 4 5 5.5 2 2 C1 1 -1 1 -2 2 C-5 5.5 -11 4 -11 -3 Z M-6 -2 a2.6 2 0 1 0 0.01 0 Z M6 -2 a2.6 2 0 1 0 0.01 0 Z"/>`,
  Sheriff: `<path fill="currentColor" d="${star(10, 4.2)}"/>`
};

function star(R, r) {
  const pts = [];
  for (let i = 0; i < 10; i += 1) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const d = i % 2 ? r : R;
    pts.push(`${(d * Math.cos(a)).toFixed(2)} ${(d * Math.sin(a)).toFixed(2)}`);
  }
  return `M${pts.join(" L")} Z`;
}

const BOLT = "M2.5 -11 L-6 1.5 L-0.5 1.5 L-2.5 11 L6 -1.5 L0.5 -1.5 Z";
// A block arrow pointing along +x, centred on the origin.
const ARROW = "M-11 -5 L2 -5 L2 -11 L12 0 L2 11 L2 5 L-11 5 Z";
const EYE = `<svg viewBox="-12 -12 24 24" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M-11 0 C-6 -8 6 -8 11 0 C6 8 -6 8 -11 0 Z M0 -4.2 a4.2 4.2 0 1 0 0.01 0 Z"/></svg>`;
const PIPS = {
  1: [[0, 0]],
  2: [[-1, -1], [1, 1]],
  3: [[-1, -1], [0, 0], [1, 1]],
  4: [[-1, -1], [1, -1], [-1, 1], [1, 1]],
  5: [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]],
  6: [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]]
};

// The middle of the loop (measured clear of the innermost spaces): the lost
// lives spots, three over two, and below them the die and the deck.
const DIE_AT = { x: W / 2 - 95, y: H / 2 + 40 };
const DECK_AT = { x: W / 2 + 100, y: H / 2 + 40 }; // in line with the die
const TRAY_ROWS = [H / 2 - 92, H / 2 - 52]; // where the spots' stacks stand
const TRAY_STEP = 56;
// Where a stack dropped counts as dropped on the spots.
const TRAY = { x: W / 2 - 116, y: TRAY_ROWS[0] - 44, w: 232, h: TRAY_ROWS[1] - TRAY_ROWS[0] + 64 };
const DECK_W = 118; // the deck lies sideways
const DECK_H = 84;
// Your hand: cards this big (in board units), centred under the bottom of the
// loop, resting this far below the screen's edge until hovered.
const HAND = { x: W / 2, w: 108, h: 150, rest: 46, gap: 10, maxSpread: 250 };
// Where the other seats sit (board units): the empty corners round the loop,
// in order round the table from you; B is the bottom, for a watcher.
const SEAT_SLOTS = { LL: { x: 125, y: 650 }, UL: { x: 130, y: 135 }, UR: { x: 1370, y: 135 }, LR: { x: 1375, y: 630 }, B: { x: W / 2, y: 730 } };
const SLOT_ORDER = ["LL", "UL", "UR", "LR"];
const ROLL_MS = 750;
const FLY_MS = 520;
const DRAG_PX = 5;

let state = null;
let root = null;
let layout = null; // for state.board
let selected = null; // the card in your hand that's picked up
let menuFor = null; // the stack whose menu is open
let drag = null;
let shownRoll = null; // the die roll the page has finished showing
let rolling = null; // { n } while the die tumbles
let resetArmed = null;
let hover = { piece: null, deck: false, die: false }; // what's under the pointer
let logOpen = false;
let helpOpen = false;
let resizer = null;
let logSeen = 0; // the newest log line the open log has shown
let fxSeen = null; // the newest log line whose cards have flown
// Discs in the air: held back from where they're going until they land.
let pend = { board: {}, dead: {} };
// Colours just moved by this page's own drag, which shouldn't fly as well.
let quiet = {};

const isMine = () => app.currentGame?.id === "bluff-race";
const emit = (event, payload = {}) => {
  if (app.roomId) socket.emit(event, { roomId: app.roomId, ...payload });
};
const reduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const chip = (color, cls = "") => `<span class="ct-chip ${cls}" style="--top:${PIECE_COLORS[color].top};--side:${PIECE_COLORS[color].side}"></span>`;

// What the board shows: the table's counts, less discs still in the air.
const livesShown = (c) => Math.max(0, state.pieces[c].lives - (pend.board[c] ?? 0));
const deadShown = (c) => Math.max(0, state.dead[c] - (pend.dead[c] ?? 0));

// --- the board's shape -----------------------------------------------------------

function makeLayout(board) {
  const n = board.length;
  const N = 4000;
  const pts = [];
  const cum = [0];
  for (let i = 0; i <= N; i += 1) {
    const t = (i / N) * 2 * Math.PI;
    const w = Math.sin(LOBES * t + PHASE);
    const r = 1 + DEPTH * Math.sign(w) * Math.abs(w) ** SHARP;
    pts.push([STRETCH * r * Math.sin(t), -r * Math.cos(t)]);
    if (i) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  const L = cum[N];
  const step = L / (n + 1);
  const raw = [];
  for (let k = 1, j = 0; k <= n; k += 1) {
    const target = k * step;
    while (cum[j + 1] < target) j += 1;
    const f = (target - cum[j]) / (cum[j + 1] - cum[j] || 1);
    const [x0, y0] = pts[j];
    const [x1, y1] = pts[j + 1];
    const d = Math.hypot(x1 - x0, y1 - y0) || 1;
    raw.push({ x: x0 + (x1 - x0) * f, y: y0 + (y1 - y0) * f, tx: (x1 - x0) / d, ty: (y1 - y0) / d });
  }
  let mx = 0;
  let my = 0;
  for (const p of raw) {
    mx = Math.max(mx, Math.abs(p.x));
    my = Math.max(my, Math.abs(p.y));
  }
  const scale = Math.min(W / 2 / (mx + 0.62 * step), H / 2 / (my + 0.62 * step));
  const spacing = step * scale;
  const spots = [null, ...raw.map((p) => ({ x: W / 2 + p.x * scale, y: H / 2 + p.y * scale, tx: p.tx, ty: p.ty }))];
  return { board, n, spots, spacing, r: SPACE * spacing, pr: PIECE * SPACE * spacing };
}

// --- drawing ---------------------------------------------------------------------

function spacesSvg() {
  const { board, spots, r } = layout;
  const out = [];
  for (let t = 1; t <= layout.n; t += 1) {
    const s = spots[t];
    const code = board[t - 1];
    const k = KIND[code];
    const deg = (Math.atan2(s.ty, s.tx) * 180) / Math.PI;
    let mark = "";
    if (code === "R") mark = `<path d="${ARROW}" class="ct-mark" transform="rotate(${(deg + 180).toFixed(1)}) scale(${(r / 22).toFixed(3)})"/>`;
    else if (code === "G") mark = `<path d="${ARROW}" class="ct-mark" transform="rotate(${deg.toFixed(1)}) scale(${(r / 22).toFixed(3)})"/>`;
    else if (code === "Y") mark = `<text class="ct-q" font-size="${(r * 1.15).toFixed(1)}">?</text>`;
    else if (code === "S") mark = `<text class="ct-end-word" font-size="${(r * 0.42).toFixed(1)}">START</text>`;
    else if (code === "F") mark = `<rect x="${(-r * 0.62).toFixed(1)}" y="${(-r * 0.26).toFixed(1)}" width="${(r * 1.24).toFixed(1)}" height="${(r * 0.52).toFixed(1)}" rx="4" class="ct-end-tag"/><text class="ct-end-word on-tag" font-size="${(r * 0.36).toFixed(1)}">FINISH</text>`;
    // The number sits just outside the loop (the traversal is clockwise, so
    // the left-hand normal points out).
    const nx = s.ty;
    const ny = -s.tx;
    const off = r + 9;
    out.push(`<g class="ct-space ${k.cls}" data-t="${t}">
        <g transform="translate(${s.x.toFixed(1)} ${s.y.toFixed(1)})">
          <circle class="ct-space-edge" r="${r.toFixed(1)}" cy="4"/>
          <circle class="ct-space-face" r="${r.toFixed(1)}"/>
          ${mark}
        </g>
        <text class="ct-num" x="${(s.x + nx * off).toFixed(1)}" y="${(s.y + ny * off).toFixed(1)}">${t}</text>
      </g>`);
  }
  return out.join("");
}

// A slim stack of n discs seen from a little above, standing on the origin;
// with `bolt`, the side with the lightning on it is up.
const stackHeight = (n) => n * DISC * layout.pr;

function shadowSvg() {
  const rx = layout.pr;
  return `<ellipse class="ct-piece-shadow" cx="1.5" cy="${(rx * 0.2).toFixed(1)}" rx="${(rx * 1.1).toFixed(1)}" ry="${(rx * 0.6).toFixed(1)}"/>`;
}

function stackSvg(n, color, bolt) {
  const c = PIECE_COLORS[color] ?? PIECE_COLORS.Black;
  const rx = layout.pr;
  const ry = rx * 0.55;
  const th = rx * DISC;
  const parts = [];
  for (let i = 0; i < n; i += 1) {
    const y0 = -i * th;
    const y1 = y0 - th;
    parts.push(
      `<path d="M${-rx} ${y1} L${-rx} ${y0} A${rx} ${ry} 0 0 0 ${rx} ${y0} L${rx} ${y1} Z" fill="${c.side}" class="ct-disc-side"/>`,
      `<ellipse cy="${y1.toFixed(1)}" rx="${rx.toFixed(1)}" ry="${ry.toFixed(1)}" fill="${c.top}" class="ct-disc-top"/>`
    );
  }
  if (bolt && n > 0) {
    parts.push(`<path d="${BOLT}" class="ct-bolt" transform="translate(0 ${(-stackHeight(n)).toFixed(1)}) scale(${(rx / 15).toFixed(3)}, ${(ry / 12).toFixed(3)})"/>`);
  }
  return parts.join("");
}

// Turn a stack over: it lifts, turns edge-on, and comes down the other way
// up. The drawing swaps at the halfway point.
function flipStack(g, color) {
  const body = g.querySelector(".ct-piece-body");
  const draw = () => stackSvg(livesShown(color), color, state.pieces[color].charged);
  if (!body.animate || reduced()) {
    body.innerHTML = draw();
    return;
  }
  body.style.transformOrigin = `0px ${(-stackHeight(livesShown(color)) / 2).toFixed(1)}px`;
  body.animate(
    [
      { transform: "translateY(0) scaleY(1)" },
      { transform: "translateY(-26px) scaleY(0.04)", offset: 0.5 },
      { transform: "translateY(0) scaleY(1)" }
    ],
    { duration: 440, easing: "ease-in-out" }
  );
  setTimeout(() => {
    if (body.isConnected && state) body.innerHTML = draw();
  }, 220);
}

// Stacks sharing a space stand side by side on it (offsets in space radii).
const CLUSTER = {
  1: [[0, 0.1]],
  2: [[-0.42, 0.12], [0.42, 0.12]],
  3: [[-0.42, 0.3], [0.42, 0.3], [0, -0.2]],
  4: [[-0.4, -0.16], [0.4, -0.16], [-0.4, 0.32], [0.4, 0.32]],
  5: [[-0.42, -0.2], [0.42, -0.2], [-0.5, 0.3], [0, 0.32], [0.5, 0.3]]
};

// Where each colour's stack on the board stands, for the colours `has` says
// have one.
function stackPlaces(has) {
  const bySpace = new Map();
  const places = new Map();
  for (const color of COLOR_ORDER) {
    if (!has(color)) continue;
    const p = state.pieces[color];
    if (p.space != null && layout.spots[p.space]) {
      if (!bySpace.has(p.space)) bySpace.set(p.space, []);
      bySpace.get(p.space).push(color);
    } else {
      places.set(color, { x: p.x ?? W / 2, y: p.y ?? H / 2 });
    }
  }
  for (const [space, colors] of bySpace) {
    const spot = layout.spots[space];
    const at = CLUSTER[Math.min(colors.length, 5)];
    colors.forEach((color, i) => {
      const [dx, dy] = at[i % at.length];
      places.set(color, { x: spot.x + dx * layout.r, y: spot.y + dy * layout.r });
    });
  }
  return places;
}

// Three spots on top, two below, set between them.
function traySlot(color) {
  const i = COLOR_ORDER.indexOf(color);
  return i < 3 ? { x: W / 2 + (i - 1) * TRAY_STEP, y: TRAY_ROWS[0] } : { x: W / 2 + (i - 3.5) * TRAY_STEP, y: TRAY_ROWS[1] };
}
const inTray = (x, y) => x >= TRAY.x && x <= TRAY.x + TRAY.w && y >= TRAY.y && y <= TRAY.y + TRAY.h;

// Every stack: those on the board ("b") and those in the tray ("d"), keyed
// so a stack keeps its element (and slides) from one update to the next.
function renderPieces() {
  const layer = root.querySelector(".ct-pieces");
  const places = stackPlaces((c) => livesShown(c) > 0);
  const want = new Map();
  for (const [color, at] of places) want.set(`b-${color}`, { kind: "b", color, ...at });
  for (const color of COLOR_ORDER) if (deadShown(color) > 0) want.set(`d-${color}`, { kind: "d", color, ...traySlot(color) });

  const have = new Map([...layer.children].map((g) => [g.dataset.id, g]));
  for (const [id, g] of have) if (!want.has(id)) g.remove();
  const order = [...want.entries()].sort((a, b) => a[1].y - b[1].y);
  for (const [id, it] of order) {
    let g = have.get(id);
    if (!g) {
      g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      g.setAttribute("class", `ct-piece ${it.kind === "d" ? "dead" : "live"}`);
      g.dataset.id = id;
      g.dataset.kind = it.kind;
      g.dataset.color = it.color;
      g.innerHTML = `${shadowSvg()}<g class="ct-piece-body"></g>`;
      g.style.transform = `translate(${it.x}px, ${it.y}px)`;
    }
    const n = it.kind === "b" ? livesShown(it.color) : deadShown(it.color);
    const charged = it.kind === "b" && state.pieces[it.color].charged;
    const key = `${n}|${charged}|${layout.pr}`;
    if (g.dataset.key !== key) {
      // Only the charge changed: the stack was turned over.
      const [was, wasCharged, pr] = (g.dataset.key ?? "").split("|");
      g.dataset.key = key;
      if (it.kind === "b" && was === String(n) && pr === String(layout.pr) && wasCharged !== String(charged)) flipStack(g, it.color);
      else g.querySelector(".ct-piece-body").innerHTML = stackSvg(n, it.color, charged);
    }
    g.setAttribute(
      "aria-label",
      it.kind === "b" ? `${it.color}'s stack, ${n} ${n === 1 ? "life" : "lives"}${charged ? ", charged" : ""}` : `${it.color}'s lost lives, ${n}`
    );
    if (drag?.id !== id) g.style.transform = `translate(${it.x}px, ${it.y}px)`;
    layer.appendChild(g); // re-appending keeps the paint order
  }
  if (drag) {
    const g = layer.querySelector(`[data-id="${drag.id}"]`);
    if (g) layer.appendChild(g);
  }
}

// One disc flying from one stack top to another, in a little arc.
function flyDisc(color, from, to, delay, done) {
  const layer = root.querySelector(".ct-flights");
  const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
  g.setAttribute("class", "ct-flying");
  g.innerHTML = stackSvg(1, color, false);
  g.style.transform = `translate(${from.x}px, ${from.y}px)`;
  layer.appendChild(g);
  const mid = { x: (from.x + to.x) / 2, y: Math.min(from.y, to.y) - 70 };
  const anim = g.animate(
    [
      { transform: `translate(${from.x}px, ${from.y}px)` },
      { transform: `translate(${mid.x}px, ${mid.y}px)`, offset: 0.5 },
      { transform: `translate(${to.x}px, ${to.y}px)` }
    ],
    { duration: FLY_MS, delay, easing: "ease-in-out", fill: "backwards" }
  );
  anim.onfinish = () => {
    g.remove();
    done();
  };
}

// Discs that moved between a stack and the tray since the last update fly
// there, for everyone. `prev` is the table as this page last drew it.
function flyDiscs(prev, prevPlaces) {
  if (!prev || reduced() || !layout || prev.board !== state.board) return;
  const now = Date.now();
  const places = stackPlaces((c) => state.pieces[c].lives > 0);
  for (const c of COLOR_ORDER) {
    if (quiet[c] > now) continue;
    const pl = prev.pieces[c].lives;
    const nl = state.pieces[c].lives;
    const pd = prev.dead[c];
    const nd = state.dead[c];
    const slot = traySlot(c);
    let k = 0;
    let to;
    let from;
    let into;
    if (nl < pl && nd > pd) {
      k = Math.min(pl - nl, nd - pd);
      const at = prevPlaces.get(c) ?? slot;
      from = (i) => ({ x: at.x, y: at.y - stackHeight(pl - 1 - i) });
      to = (i) => ({ x: slot.x, y: slot.y - stackHeight(pd + i) });
      into = "dead";
    } else if (nd < pd && nl > pl) {
      k = Math.min(pd - nd, nl - pl);
      const at = places.get(c) ?? slot;
      from = (i) => ({ x: slot.x, y: slot.y - stackHeight(pd - 1 - i) });
      to = (i) => ({ x: at.x, y: at.y - stackHeight(pl + i) });
      into = "board";
    }
    for (let i = 0; i < k; i += 1) {
      pend[into][c] = (pend[into][c] ?? 0) + 1;
      flyDisc(c, from(i), to(i), i * 110, () => {
        pend[into][c] = Math.max(0, (pend[into][c] ?? 1) - 1);
        if (root && state) renderPieces();
      });
    }
  }
}

function dieFace(v) {
  const pip = 9.5;
  return (PIPS[v] ?? PIPS[1]).map(([x, y]) => `<circle cx="${x * 18}" cy="${y * 18}" r="${v === 1 ? pip * 1.25 : pip / 1.35}" class="ct-pip${v === 1 ? " one" : ""}"/>`).join("");
}

function renderDie(face, tilt = 0, dx = 0, dy = 0) {
  const g = root.querySelector(".ct-die-body");
  g.style.transform = `translate(${dx}px, ${dy}px) rotate(${tilt}deg)`;
  g.querySelector(".ct-pips").innerHTML = dieFace(face);
}

// A new roll tumbles for a moment before it lands; the log holds the result
// back until then.
function showDie() {
  const d = state.die;
  if (shownRoll === null) shownRoll = d.n;
  if (d.n !== shownRoll && !rolling) {
    if (reduced()) {
      shownRoll = d.n;
    } else {
      const started = performance.now();
      let last = 0;
      rolling = { n: d.n };
      const tick = (now) => {
        if (!root || !rolling) return;
        const u = (now - started) / ROLL_MS;
        if (u >= 1) {
          rolling = null;
          shownRoll = state.die.n;
          renderDie(state.die.value);
          renderLog();
          return;
        }
        if (now - last > 65) {
          last = now;
          const f = 1 + Math.floor(Math.random() * 6);
          renderDie(f, (Math.random() - 0.5) * 50 * (1 - u), (Math.random() - 0.5) * 14 * (1 - u), -Math.sin(u * Math.PI * 3) * 10 * (1 - u));
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      renderDie(1 + Math.floor(Math.random() * 6), 20);
      return;
    }
  }
  if (!rolling) renderDie(d.value);
}

function renderDeck() {
  const g = root.querySelector(".ct-deck-cards");
  const n = state.deckCount;
  if (!n) {
    g.innerHTML = `<rect class="ct-deck-empty" x="${-DECK_W / 2}" y="${-DECK_H / 2}" width="${DECK_W}" height="${DECK_H}" rx="9"/>
      <text class="ct-deck-empty-word">Empty</text>`;
  } else {
    const layers = Math.min(n, 6);
    const out = [];
    for (let i = layers - 1; i >= 0; i -= 1) {
      out.push(`<g transform="translate(${-i * 1.6} ${-i * 2.4})">${cardBack(DECK_W, DECK_H, i === 0)}</g>`);
    }
    g.innerHTML = out.join("");
  }
  g.setAttribute("aria-label", `Draw a card (${n} left)`);
}

function cardBack(w, h, top) {
  return `<rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="9" class="ct-back"/>
    ${top ? `<rect x="${-w / 2 + 6}" y="${-h / 2 + 6}" width="${w - 12}" height="${h - 12}" rx="6" class="ct-back-inner"/>
    <circle r="17" class="ct-back-ring"/><path d="${BOLT}" class="ct-back-bolt" transform="rotate(90) scale(1.05)"/>` : ""}`;
}

function cardFace(card, cls = "") {
  const c = CHARS[card.char];
  return `<div class="ct-card ${cls}" style="--c:${c.color}" data-card="${card.id}">
      <span class="ct-card-name">${card.char}</span>
      <svg class="ct-card-icon" viewBox="-12 -12 24 24" aria-hidden="true">${ICON[card.char]}</svg>
      <span class="ct-card-text">${c.text}</span>
      ${card.up ? `<span class="ct-card-up">${EYE}Showing</span>` : ""}
    </div>`;
}

// The screen box a card flies to or from for a seat: your own hand, or where
// that seat sits round the board.
function seatBox(n) {
  if (n === state.me) {
    const cards = root.querySelectorAll(".ct-myhand .ct-card");
    return (cards[cards.length - 1] ?? root.querySelector(".ct-myhand")).getBoundingClientRect();
  }
  return (root.querySelector(`.ct-opp[data-seat="${n}"] .ct-opp-cards`) ?? root.querySelector(".ct-stage")).getBoundingClientRect();
}

function flyCard(fromBox, toBox, delay) {
  const el = document.createElement("div");
  el.className = "ct-fly-card";
  root.appendChild(el);
  const w = 56;
  const h = 78;
  const ax = fromBox.left + fromBox.width / 2 - w / 2;
  const ay = fromBox.top + fromBox.height / 2 - h / 2;
  const bx = toBox.left + toBox.width / 2 - w / 2;
  const by = toBox.top + toBox.height / 2 - h / 2;
  el.style.left = `${ax}px`;
  el.style.top = `${ay}px`;
  const anim = el.animate(
    [
      { transform: "translate(0, 0) rotate(0deg) scale(1)", opacity: 1 },
      { transform: `translate(${(bx - ax) / 2}px, ${(by - ay) / 2 - 40}px) rotate(-10deg) scale(1.12)`, opacity: 1, offset: 0.5 },
      { transform: `translate(${bx - ax}px, ${by - ay}px) rotate(0deg) scale(0.9)`, opacity: 0.85 }
    ],
    { duration: FLY_MS + 80, delay, easing: "ease-in-out", fill: "backwards" }
  );
  anim.onfinish = () => el.remove();
}

// Cards drawn (or dealt) and returned since the last update fly between the
// deck and those players.
function flyCards() {
  const fresh = state.log.filter((l) => l.n > fxSeen);
  if (state.log.length) fxSeen = Math.max(fxSeen, state.log[state.log.length - 1].n);
  if (reduced()) return;
  const deck = root.querySelector(".ct-deck-cards").getBoundingClientRect();
  for (const l of fresh) {
    (l.draw ?? []).forEach((n, i) => flyCard(deck, seatBox(n), i * 140));
    if (l.back) flyCard(seatBox(l.back), deck, 0);
  }
}

// The board's frame on the screen: px per board unit, and where its corner is
// inside the stage.
function frame() {
  const svg = root.querySelector(".ct-svg");
  const ctm = svg.getScreenCTM();
  const box = root.querySelector(".ct-stage").getBoundingClientRect();
  if (!ctm) return { u: 1, ox: 0, oy: 0 };
  return { u: ctm.a, ox: ctm.e - box.left, oy: ctm.f - box.top };
}

// The other seats, each in its corner, counted round the table from yours.
// A watcher sees everyone, starting from the bottom.
function seatsAround() {
  const seats = [...state.seats].sort((a, b) => a.n - b.n);
  if (state.me == null) return seats.slice(0, 5).map((s, i) => [s, ["B", ...SLOT_ORDER][i]]);
  const i = seats.findIndex((s) => s.n === state.me);
  const others = [...seats.slice(i + 1), ...seats.slice(0, i)];
  return others.slice(0, 4).map((s, k) => [s, SLOT_ORDER[k]]);
}

function renderOthers(f) {
  const out = seatsAround().map(([s, slot]) => {
    const at = SEAT_SLOTS[slot];
    const backs = Array.from({ length: s.handCount - s.shown.length }, () => `<i class="ct-opp-back"></i>`).join("");
    const shown = s.shown
      .map((x) => `<i class="ct-opp-up" style="--c:${CHARS[x.char].color}"><svg viewBox="-12 -12 24 24" aria-hidden="true">${ICON[x.char]}</svg><b>${x.char}</b></i>`)
      .join("");
    return `<div class="ct-opp${s.away ? " away" : ""}" data-seat="${s.n}" style="left:${(f.ox + at.x * f.u).toFixed(1)}px;top:${(f.oy + at.y * f.u).toFixed(1)}px">
        <div class="ct-opp-cards">${shown}${backs}</div>
        <span class="ct-opp-name">Player ${s.n}${s.away ? " · away" : ""}</span>
      </div>`;
  });
  root.querySelector(".ct-opps").innerHTML = out.join("");
}

function renderLog() {
  const box = root.querySelector(".ct-log");
  const lines = state.log.filter((l) => !(rolling && l.roll === rolling.n));
  const newest = lines.length ? lines[lines.length - 1].n : 0;
  if (logOpen) logSeen = newest;
  const info = root.querySelector(".ct-info");
  info.classList.toggle("fresh", !logOpen && newest > logSeen);
  info.classList.toggle("on", logOpen);
  info.setAttribute("aria-expanded", String(logOpen));
  root.querySelector(".ct-logbox").hidden = !logOpen;
  box.innerHTML = lines.length
    ? lines
        .slice(-9)
        .reverse()
        .map((l) => {
          const who = l.text.match(/^(\w+)\b/)?.[1];
          return `<li${PIECE_COLORS[who] ? ` style="--c:${PIECE_COLORS[who].top}"` : ""}>${esc(l.text)}</li>`;
        })
        .join("")
    : `<li class="ct-note">Nothing yet.</li>`;
}

// Your hand, fanned a little, under the bottom of the loop.
function renderHand(f) {
  const hand = root.querySelector(".ct-myhand");
  hand.style.left = `${(f.ox + HAND.x * f.u).toFixed(1)}px`;
  if (state.me == null) {
    hand.innerHTML = "";
    return;
  }
  if (selected != null && !state.hand.some((h) => h.id === selected)) selected = null;
  hand.classList.toggle("raised", selected != null);
  const k = state.hand.length;
  const step = k <= 2 ? HAND.w + HAND.gap : Math.min(HAND.w + HAND.gap, (HAND.maxSpread - HAND.w) / (k - 1));
  const span = HAND.w + step * (k - 1);
  hand.innerHTML = state.hand
    .map((card, i) => {
      const on = card.id === selected;
      const tilt = on || k < 2 ? 0 : (i - (k - 1) / 2) * 4;
      const left = (-span / 2 + i * step) * f.u;
      const actions = on
        ? `<div class="ct-card-acts" role="group" aria-label="${card.char}">
            <button type="button" class="ct-btn" data-act="show" data-up="${card.up ? 0 : 1}">${card.up ? "Hide from table" : "Show to table"}</button>
            <button type="button" class="ct-btn" data-act="return">Return to deck</button>
          </div>`
        : "";
      return `<div class="ct-slot${on ? " on" : ""}" style="left:${left.toFixed(1)}px;transform:rotate(${tilt}deg);z-index:${on ? 20 : i + 1}">${cardFace(card, card.up ? "up" : "")}${actions}</div>`;
    })
    .join("");
}

// Everything that sits on the board's frame rather than in it.
function renderHands() {
  const f = frame();
  root.style.setProperty("--u", f.u.toFixed(4));
  renderHand(f);
  renderOthers(f);
}

function renderHelp() {
  root.querySelector(".ct-help").classList.toggle("on", helpOpen);
  root.querySelector(".ct-help").setAttribute("aria-expanded", String(helpOpen));
  root.querySelector(".ct-helpbox").hidden = !helpOpen;
}

function renderMenu() {
  const pop = root.querySelector(".ct-pop");
  const p = menuFor ? state.pieces[menuFor.color] : null;
  if (!p || p.lives <= 0) {
    pop.hidden = true;
    menuFor = null;
    return;
  }
  const color = menuFor.color;
  pop.hidden = false;
  pop.style.left = `${menuFor.x}px`;
  pop.style.top = `${menuFor.y}px`;
  pop.innerHTML = `<h4>${chip(color)}${color} stack</h4>
    <p class="ct-note">${p.lives} ${p.lives === 1 ? "life" : "lives"}${p.charged ? " · charged" : ""}${p.space ? ` · space ${p.space}` : " · off the track"}</p>
    <div class="ct-pop-row">
      <button type="button" class="ct-btn" data-pact="lose">Take a life off <kbd>D</kbd></button>
      <button type="button" class="ct-btn bolt" data-pact="charge">${p.charged ? "Flip back" : "Flip over"} <kbd>F</kbd></button>
    </div>
    <div class="ct-pop-row">
      <button type="button" class="ct-btn" data-pact="start" ${p.space === 1 ? "disabled" : ""}>Back to start</button>
    </div>`;
}

function render() {
  if (!layout || layout.board !== state.board) {
    layout = makeLayout(state.board);
    root.querySelector(".ct-spaces").innerHTML = spacesSvg();
    root.querySelector(".ct-pieces").innerHTML = "";
  }
  renderPieces();
  showDie();
  renderDeck();
  renderLog();
  renderHelp();
  renderHands();
  renderMenu();
}

// --- the page --------------------------------------------------------------------

function mount() {
  root = document.createElement("div");
  root.className = "ct-root";
  const slots = COLOR_ORDER.map((c) => {
    const s = traySlot(c);
    return `<ellipse class="ct-tray-spot" cx="${s.x}" cy="${s.y}" rx="15" ry="8"/>`;
  }).join("");
  root.innerHTML = `
    <div class="ct-stage">
      <svg class="ct-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" aria-label="Bluff Race board">
        <defs>
          <pattern id="ct-checker" width="10" height="10" patternUnits="userSpaceOnUse">
            <rect width="10" height="10" fill="#f8fafc"/><rect width="5" height="5" fill="#111827"/><rect x="5" y="5" width="5" height="5" fill="#111827"/>
          </pattern>
          <pattern id="ct-weave" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="8" height="8" fill="#22305f"/><rect width="4" height="8" fill="#26376b"/>
          </pattern>
        </defs>
        <g class="ct-spaces"></g>
        <circle class="ct-target" r="0" hidden/>
        <g class="ct-tray">
          <rect x="${TRAY.x}" y="${TRAY.y}" width="${TRAY.w}" height="${TRAY.h}" rx="16" class="ct-tray-bed"/>
          ${slots}
        </g>
        <g class="ct-die" transform="translate(${DIE_AT.x} ${DIE_AT.y})" role="button" tabindex="0" aria-label="Roll the die">
          <ellipse class="ct-die-shadow" cx="4" cy="44" rx="44" ry="11"/>
          <g class="ct-die-body">
            <rect class="ct-die-edge" x="-37" y="-33" width="74" height="74" rx="15"/>
            <rect class="ct-die-face" x="-37" y="-37" width="74" height="74" rx="15"/>
            <g class="ct-pips"></g>
          </g>
        </g>
        <g class="ct-deck" transform="translate(${DECK_AT.x} ${DECK_AT.y})">
          <g class="ct-deck-cards" role="button" tabindex="0" aria-label="Draw a card"></g>
        </g>
        <g class="ct-pieces"></g>
        <g class="ct-flights"></g>
      </svg>
      <div class="ct-opps"></div>
      <div class="ct-myhand"></div>
      <button type="button" class="ct-help" aria-label="Controls" aria-expanded="false">?</button>
      <button type="button" class="ct-info" aria-label="Table log" aria-expanded="false">i</button>
      <div class="ct-panel ct-helpbox" hidden>
        <h3>Controls</h3>
        <p>Drag a stack to move it. Hover it: <kbd>F</kbd> flips it over (charge), <kbd>D</kbd> takes a life off.</p>
        <p>Click a lost life to send it back. Drag the lost lives onto the board.</p>
        <p>Hover the die: <kbd>R</kbd> rolls. Hover the deck: <kbd>D</kbd> draws.</p>
        <p>Click a card in your hand to show it or return it.</p>
      </div>
      <div class="ct-panel ct-logbox" hidden><h3>Table log</h3><ul class="ct-log"></ul></div>
      <div class="ct-tools">
        <button type="button" class="ct-btn" data-act="board">Board…</button>
        <button type="button" class="ct-btn" data-act="reset">Reset table</button>
        <button type="button" class="ct-btn" data-act="leave">Leave</button>
      </div>
      <div class="ct-pop" hidden></div>
      <div class="ct-modal" hidden></div>
    </div>`;
  els.gameBoard.classList.add("ct-host");
  els.gameBoard.appendChild(root);
  wire();
  // The hands sit on the board's frame, so they follow the window's size.
  resizer = new ResizeObserver(() => root && state && renderHands());
  resizer.observe(root.querySelector(".ct-stage"));
}

function unmount() {
  rolling = null;
  resizer?.disconnect();
  resizer = null;
  helpOpen = false;
  root?.remove();
  root = null;
  layout = null;
  drag = null;
  menuFor = null;
  hover = { piece: null, deck: false, die: false };
  logOpen = false;
  pend = { board: {}, dead: {} };
  els.gameBoard.classList.remove("ct-host");
}

function toWorld(event) {
  const svg = root.querySelector(".ct-svg");
  const pt = svg.createSVGPoint();
  pt.x = event.clientX;
  pt.y = event.clientY;
  return pt.matrixTransform(svg.getScreenCTM().inverse());
}

// The space a dropped stack lands on: the nearest one, if it's close.
function spaceNear(x, y) {
  let best = null;
  let bestD = layout.spacing * 0.62;
  for (let t = 1; t <= layout.n; t += 1) {
    const s = layout.spots[t];
    const d = Math.hypot(s.x - x, s.y - y);
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  return best;
}

// Under a dragged stack: the space it would land on, or the tray.
function showTarget(x, y) {
  const ring = root.querySelector(".ct-target");
  const tray = root.querySelector(".ct-tray");
  const overTray = x != null && drag?.kind === "b" && inTray(x, y);
  tray.classList.toggle("drop", overTray);
  const t = x == null || overTray ? null : spaceNear(x, y);
  if (!t) {
    ring.setAttribute("hidden", "");
    return;
  }
  const s = layout.spots[t];
  ring.removeAttribute("hidden");
  ring.setAttribute("cx", s.x);
  ring.setAttribute("cy", s.y);
  ring.setAttribute("r", layout.r + 6);
}

function closeModal() {
  root.querySelector(".ct-modal").hidden = true;
}

function editorBoard() {
  try {
    const saved = JSON.parse(localStorage.getItem("cp-board") ?? "null");
    return typeof saved?.code === "string" ? saved.code : null;
  } catch {
    return null;
  }
}

function openBoardDialog() {
  const modal = root.querySelector(".ct-modal");
  const mine = editorBoard();
  modal.hidden = false;
  modal.innerHTML = `<div class="ct-dialog" role="dialog" aria-label="Change the board">
      <h3>Board</h3>
      <p class="ct-note">One letter a space: S start, R backward, G forward, Y bonus, . blank, F finish. It changes the board for the whole table.</p>
      <textarea id="ct-code" spellcheck="false" rows="3">${esc(state.board)}</textarea>
      <p class="ct-note ct-code-msg"></p>
      <div class="ct-pop-row">
        <button type="button" class="ct-btn primary" data-mact="use">Use this board</button>
        ${mine ? `<button type="button" class="ct-btn" data-mact="mine">Use my editor board</button>` : ""}
        <button type="button" class="ct-btn" data-mact="default">Default board</button>
        <button type="button" class="ct-btn" data-mact="cancel">Cancel</button>
      </div>
    </div>`;
}

const DEFAULT_BOARD = "SG.YRRYG.YYR.RYR.GRY..Y.G..GYG.GR.R.G.R.YGY.RYYR.GY.RY.RGYRF";
const validBoard = (code) => {
  const s = String(code).replace(/\s+/g, "").toUpperCase();
  return s.length >= 20 && s.length <= 80 && [...s.slice(1, -1)].every((c) => "RGY.".includes(c)) ? s : null;
};

// Stop this page's own drag from flying as well, for a moment.
const hush = (color) => (quiet[color] = Date.now() + 1500);

function dropStack(d) {
  const c = d.color;
  const p = state.pieces[c];
  const overTray = inTray(d.x, d.y);
  const t = overTray ? null : spaceNear(d.x, d.y);
  const to = t ? { space: t } : { x: Math.round(d.x), y: Math.round(d.y) };
  // Changed here at once; the server's copy follows.
  if (d.kind === "b") {
    if (overTray) {
      hush(c);
      state.dead[c] += p.lives;
      state.pieces[c] = { ...p, lives: 0, charged: false };
      emit("bluff_race_bury", { color: c });
    } else {
      state.pieces[c] = { ...p, space: t ?? null, x: t ? null : to.x, y: t ? null : to.y };
      emit("bluff_race_move", { color: c, ...to });
    }
  } else if (!overTray) {
    hush(c);
    const k = state.dead[c];
    state.dead[c] = 0;
    state.pieces[c] = { ...p, lives: p.lives + k, charged: p.lives ? p.charged : false, space: t ?? null, x: t ? null : to.x, y: t ? null : to.y };
    emit("bluff_race_raise", { color: c, ...to });
  }
  renderPieces();
}

function wire() {
  const svg = root.querySelector(".ct-svg");

  // Clicking the die or the deck shouldn't focus it (and draw a box round it).
  svg.addEventListener("mousedown", (event) => {
    if (event.target.closest?.(".ct-die, .ct-deck-cards")) event.preventDefault();
  });

  svg.addEventListener("pointerdown", (event) => {
    const piece = event.target.closest?.(".ct-piece");
    if (!piece || event.button !== 0 || !state.me) return;
    event.preventDefault();
    const w = toWorld(event);
    const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(piece.style.transform);
    const px = m ? Number(m[1]) : w.x;
    const py = m ? Number(m[2]) : w.y;
    drag = {
      id: piece.dataset.id,
      kind: piece.dataset.kind,
      color: piece.dataset.color,
      el: piece,
      sx: event.clientX,
      sy: event.clientY,
      ox: px - w.x,
      oy: py - w.y,
      moved: false
    };
    svg.setPointerCapture?.(event.pointerId);
  });

  // What the pointer is over, for the keys that act on it.
  svg.addEventListener("pointerover", (event) => {
    if (drag) return;
    const el = event.target instanceof Element ? event.target : null;
    const piece = el?.closest(".ct-piece.live");
    hover = { piece: piece?.dataset.color ?? null, deck: !!el?.closest(".ct-deck-cards"), die: !!el?.closest(".ct-die") };
  });
  svg.addEventListener("pointerleave", () => {
    hover = { piece: null, deck: false, die: false };
  });

  svg.addEventListener("pointermove", (event) => {
    if (!drag) return;
    if (!drag.moved && Math.hypot(event.clientX - drag.sx, event.clientY - drag.sy) < DRAG_PX) return;
    if (!drag.moved) {
      drag.moved = true;
      menuFor = null;
      renderMenu();
      drag.el.classList.add("lifted");
      root.querySelector(".ct-pieces").appendChild(drag.el);
    }
    const w = toWorld(event);
    drag.x = Math.max(0, Math.min(W, w.x + drag.ox));
    drag.y = Math.max(0, Math.min(H, w.y + drag.oy));
    drag.el.style.transform = `translate(${drag.x}px, ${drag.y}px) scale(1.08)`;
    showTarget(drag.x, drag.y);
  });

  const endDrag = (event) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    d.el.classList.remove("lifted");
    showTarget(null);
    if (d.moved) return dropStack(d);
    if (event.type === "pointercancel") return;
    // A click: a lost life goes back to its stack; a stack opens its menu.
    if (d.kind === "d") return emit("bluff_race_revive", { color: d.color });
    const box = root.querySelector(".ct-stage").getBoundingClientRect();
    menuFor = { color: d.color, x: event.clientX - box.left, y: event.clientY - box.top };
    renderMenu();
  };
  svg.addEventListener("pointerup", endDrag);
  svg.addEventListener("pointercancel", endDrag);

  const act = (name) => {
    if (name === "roll") return rolling || emit("bluff_race_roll");
    if (name === "draw") return emit("bluff_race_draw");
  };

  root.addEventListener("click", (event) => {
    const el = event.target instanceof Element ? event.target : null;
    // The log: the i opens and closes it; a click anywhere else closes it.
    if (el?.closest(".ct-info")) {
      logOpen = !logOpen;
      helpOpen = false;
      renderLog();
      renderHelp();
      return;
    }
    if (el?.closest(".ct-help")) {
      helpOpen = !helpOpen;
      logOpen = false;
      renderLog();
      renderHelp();
      return;
    }
    if (logOpen && !el?.closest(".ct-logbox")) {
      logOpen = false;
      renderLog();
    }
    if (helpOpen && !el?.closest(".ct-helpbox")) {
      helpOpen = false;
      renderHelp();
    }
    // Stacks answer to the pointer handlers above.
    if (!el || el.closest(".ct-piece")) return;
    if (el.closest(".ct-die")) return act("roll");
    if (el.closest(".ct-deck-cards")) return act("draw");

    const pact = el.closest("[data-pact]");
    if (pact && menuFor) {
      const color = menuFor.color;
      const p = state.pieces[color];
      if (pact.dataset.pact === "lose") emit("bluff_race_lose", { color });
      else if (pact.dataset.pact === "charge") emit("bluff_race_charge", { color, on: !p.charged });
      else if (pact.dataset.pact === "start") emit("bluff_race_move", { color, space: 1 });
      return;
    }

    const mact = el.closest("[data-mact]");
    if (mact) {
      const msg = root.querySelector(".ct-code-msg");
      const pick = { use: () => root.querySelector("#ct-code").value, mine: editorBoard, default: () => DEFAULT_BOARD }[mact.dataset.mact];
      if (!pick) return closeModal();
      const code = validBoard(pick() ?? "");
      if (!code) {
        msg.textContent = "That isn't a board code: 20 to 80 letters, each R, G, Y or . between the start and the finish.";
        return;
      }
      emit("bluff_race_board", { code });
      closeModal();
      return;
    }

    const btn = el.closest("[data-act]");
    if (btn) {
      const a = btn.dataset.act;
      if (a === "show") return emit("bluff_race_show", { card: selected, up: btn.dataset.up === "1" });
      if (a === "return") {
        emit("bluff_race_return", { card: selected });
        selected = null;
        return;
      }
      if (a === "board") return openBoardDialog();
      if (a === "leave") return els.exitButton.click();
      if (a === "reset") {
        if (resetArmed) {
          clearTimeout(resetArmed);
          resetArmed = null;
          btn.textContent = "Reset table";
          btn.classList.remove("armed");
          selected = null;
          return emit("bluff_race_reset");
        }
        btn.textContent = "Click again to reset";
        btn.classList.add("armed");
        resetArmed = setTimeout(() => {
          resetArmed = null;
          btn.textContent = "Reset table";
          btn.classList.remove("armed");
        }, 3000);
        return;
      }
    }

    const card = el.closest(".ct-myhand .ct-card");
    if (card) {
      const id = Number(card.dataset.card);
      selected = selected === id ? null : id;
      renderHands();
      return;
    }

    // A click anywhere else puts things down.
    if (menuFor && !el.closest(".ct-pop")) {
      menuFor = null;
      renderMenu();
    }
    if (selected != null && !el.closest(".ct-myhand")) {
      selected = null;
      renderHands();
    }
  });

  root.addEventListener("keydown", (event) => {
    if ((event.key === "Enter" || event.key === " ") && event.target.closest?.("[role=button]")) {
      event.preventDefault();
      event.target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
  });
}

// Keys act on what the pointer is over: R the die, D the deck (draw) or a
// stack (a life off), F a stack (flip it). Escape puts things down. Not
// while typing.
function onKey(event) {
  if (!root || !state || !isMine()) return;
  if (event.target.closest?.("input, textarea") || event.metaKey || event.ctrlKey || event.altKey) return;
  const k = event.key.toLowerCase();
  if (k === "escape") {
    menuFor = null;
    selected = null;
    logOpen = false;
    helpOpen = false;
    closeModal();
    renderMenu();
    renderHands();
    renderLog();
    renderHelp();
    return;
  }
  if (drag || !state.me) return;
  if (k === "r" && hover.die && !rolling) emit("bluff_race_roll");
  else if (k === "d" && hover.deck) emit("bluff_race_draw");
  else if (k === "d" && hover.piece && state.pieces[hover.piece]?.lives > 0) emit("bluff_race_lose", { color: hover.piece });
  else if (k === "f" && hover.piece && state.pieces[hover.piece]?.lives > 0) {
    emit("bluff_race_charge", { color: hover.piece, on: !state.pieces[hover.piece].charged });
  }
}
window.addEventListener("keydown", onKey);

// The seat this browser sits in: a key kept here, so a refresh sits you
// back down with your own hand.
function seatKey() {
  try {
    let key = localStorage.getItem("br-seat-key");
    if (!key) {
      key = Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem("br-seat-key", key);
    }
    return key;
  } catch {
    return "";
  }
}

function reset() {
  unmount();
  state = null;
  selected = null;
  shownRoll = null;
  rolling = null;
  logSeen = 0;
  fxSeen = null;
  quiet = {};
}

export const bluffRace = {
  id: "bluff-race",
  name: "Bluff Race",
  // Opening it sits you down at the one table.
  soloOnly: true,
  openSetup({ onReady }) {
    onReady({ key: seatKey() });
  },

  handleState(payload, resetGameUi) {
    if (!payload.bluffRace) return false;
    const next = payload.bluffRace;
    const prev = state && state.roomId === next.roomId ? state : null;
    if (!prev) {
      shownRoll = null;
      fxSeen = next.log.length ? next.log[next.log.length - 1].n : 0;
      logSeen = fxSeen;
    }
    // Where the stacks stood before this update, for discs that leave them.
    const prevPlaces = prev && layout ? stackPlaces((c) => prev.pieces[c].lives > 0) : null;
    state = next;
    app.roomId = state.roomId;
    if (!root || !root.isConnected) {
      if (root) unmount();
      resetGameUi();
      els.gameBoard.innerHTML = "";
      els.hand.innerHTML = "";
      mount();
    }
    flyDiscs(prev, prevPlaces);
    render();
    flyCards();
    return true;
  },

  handleTurn() {
    return isMine() && !!state;
  },

  clearState() {
    reset();
  },

  resetUi() {
    unmount();
  },
  onMatchFound: reset,
  onOpponentLeft: reset,
  onExit: reset
};
