// Flip Triples — metrics PLAYGROUND. A local, server-free board editor for
// eyeballing the eval metrics and checking the algorithms behave.
//
//   left-click  : cycle a tile  X -> O -> neutral
//   right-click : toggle the tile locked (black) / unflipped (white)
//   pick a metric: see its count and highlight the cells/lines it found
//
// Tiles reuse the real game's .flip-piece styling so it looks identical. All
// numbers come from metrics.js, which is cross-checked against the engine
// (tools/flip-triples/metrics-check.mjs), so what you see is what the bot scores.
import * as M from "./metrics.js";

const ROWS = 6;
const COLS = 4;
const CELLS = ROWS * COLS;
const geom = M.buildGeom(ROWS, COLS);

// Match the real board markup (getFlipShape/shape-* in client.js/styles.css).
const SHAPE_INFO = {
  [M.RED]: { cls: "shape-red-x", sym: '<span class="flip-symbol red-x" aria-hidden="true">×</span>' },
  [M.BLUE]: { cls: "shape-blue-o", sym: '<span class="flip-symbol blue-o" aria-hidden="true"></span>' },
  [M.NEUTRAL]: { cls: "shape-neutral", sym: "" }
};

let root = null;
let boardEl = null;
let readoutEl = null;
let metricBtns = [];
const shapes = new Uint8Array(CELLS);
const flipped = new Uint8Array(CELLS);
let activeMetric = null;

// Each metric returns { summary, cellClasses:Map, badges:Map }.
const METRICS = [
  {
    id: "perm-cells",
    label: "Permanent cells",
    run(state) {
      const mask = M.computePermanentMask(state);
      const cellClasses = new Map();
      let n = 0;
      for (let i = 0; i < CELLS; i += 1)
        if (mask[i]) {
          addClass(cellClasses, i, "pg-hl-perm");
          n += 1;
        }
      return { summary: `${n} permanent (frozen) cells`, cellClasses, badges: new Map() };
    }
  },
  triplesMetric("locked", "Locked triples", (st, T) => M.locateLockedTriples(st, T)),
  triplesMetric("soft", "Soft triples (all)", (st, T) => M.locateAllTriples(st, T)),
  triplesMetric("perm", "Permanent triples", (st, T) => M.locatePermanentTriples(st, T)),
  {
    id: "completion",
    label: "Completion spaces",
    run(state) {
      const cellClasses = new Map();
      const badges = new Map();
      const counts = {};
      for (const [T, tag] of [[M.RED, "x"], [M.BLUE, "o"]]) {
        const res = M.locateCompletionSpaces(state, T);
        counts[tag] = res.count;
        for (const sp of res.spaces) {
          addClass(cellClasses, sp.cell, `pg-hl-comp-${tag}`);
          if (sp.lines.length > 1) badges.set(sp.cell, `×${sp.lines.length}`);
          for (const s of sp.supports) addClass(cellClasses, s, "pg-hl-support");
        }
      }
      return { summary: `X ${counts.x}  ·  O ${counts.o}   (fork = ×N)`, cellClasses, badges };
    }
  }
];

// Triples share one shape: X hits tinted warm, O tinted cool.
function triplesMetric(id, label, locate) {
  return {
    id,
    label,
    run(state) {
      const cellClasses = new Map();
      const counts = {};
      for (const [T, cls, tag] of [[M.RED, "pg-hl-x", "x"], [M.BLUE, "pg-hl-o", "o"]]) {
        const res = locate(state, T);
        counts[tag] = res.count;
        for (const lineId of res.lines) for (const cell of geom.lines[lineId]) addClass(cellClasses, cell, cls);
      }
      return { summary: `X ${counts.x}  ·  O ${counts.o}`, cellClasses, badges: new Map() };
    }
  };
}

function addClass(map, cell, cls) {
  const arr = map.get(cell) ?? [];
  arr.push(cls);
  map.set(cell, arr);
}

// ---- board editing --------------------------------------------------------
const SHAPE_CYCLE = [M.RED, M.BLUE, M.NEUTRAL]; // X -> O -> neutral
function cycleShape(i) {
  shapes[i] = SHAPE_CYCLE[(SHAPE_CYCLE.indexOf(shapes[i]) + 1) % SHAPE_CYCLE.length];
}
function toggleLock(i) {
  flipped[i] = flipped[i] ? 0 : 1;
}

function randomBoard() {
  const bag = [];
  for (let i = 0; i < 9; i += 1) bag.push(M.RED, M.BLUE);
  while (bag.length < CELLS) bag.push(M.NEUTRAL);
  for (let i = bag.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  for (let i = 0; i < CELLS; i += 1) {
    shapes[i] = bag[i];
    flipped[i] = Math.random() < 0.35 ? 1 : 0; // some locked, for interesting metrics
  }
}
function clearBoard() {
  shapes.fill(M.NEUTRAL);
  flipped.fill(0);
}

// ---- rendering ------------------------------------------------------------
function render() {
  const state = M.makeState(shapes, flipped, geom);
  const result = activeMetric ? activeMetric.run(state) : null;
  for (let i = 0; i < CELLS; i += 1) {
    const btn = boardEl.children[i];
    const info = SHAPE_INFO[shapes[i]];
    btn.className = `flip-piece ${info.cls}${flipped[i] ? " flipped" : ""}`;
    const classes = result?.cellClasses.get(i);
    if (classes) btn.classList.add(...classes);
    const badge = result?.badges.get(i);
    btn.innerHTML = info.sym + (badge ? `<span class="pg-badge">${badge}</span>` : "");
  }
  readoutEl.textContent = result ? result.summary : "Pick a metric to count & highlight";
  metricBtns.forEach((b) => b.classList.toggle("active", activeMetric && b.dataset.id === activeMetric.id));
}

function build() {
  root = document.createElement("div");
  root.id = "flip-playground";
  root.className = "modal-overlay hidden";
  root.innerHTML = `
    <div class="modal-card pg-card">
      <h3>Flip Triples — Metrics Playground</h3>
      <p class="modal-sub">left-click: cycle × / ◯ / neutral &nbsp;·&nbsp; right-click: lock / unlock a tile</p>
      <div class="pg-layout">
        <div class="board flip-triples-board flip-board-4x6 pg-board" role="grid"></div>
        <div class="pg-side">
          <div class="pg-readout">Pick a metric to count &amp; highlight</div>
          <div class="pg-metrics"></div>
          <div class="pg-actions">
            <button type="button" class="ghost-btn" data-act="random">🎲 Random</button>
            <button type="button" class="ghost-btn" data-act="clear">Clear</button>
          </div>
          <div class="pg-legend">
            <span><i class="lg white"></i> unflipped (white)</span>
            <span><i class="lg black"></i> locked (black)</span>
            <span><i class="lg xchip">×</i> X = red</span>
            <span><i class="lg ochip"></i> O = blue</span>
          </div>
        </div>
      </div>
      <button type="button" class="ghost-btn pg-close">Close</button>
    </div>`;
  document.body.appendChild(root);

  boardEl = root.querySelector(".pg-board");
  readoutEl = root.querySelector(".pg-readout");
  for (let i = 0; i < CELLS; i += 1) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "flip-piece shape-neutral";
    btn.dataset.i = String(i);
    boardEl.appendChild(btn);
  }

  const metricsWrap = root.querySelector(".pg-metrics");
  metricBtns = METRICS.map((m) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ghost-btn pg-metric";
    b.dataset.id = m.id;
    b.textContent = m.label;
    metricsWrap.appendChild(b);
    return b;
  });

  // events
  boardEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".flip-piece");
    if (!btn) return;
    cycleShape(Number(btn.dataset.i));
    render();
  });
  boardEl.addEventListener("contextmenu", (e) => {
    const btn = e.target.closest(".flip-piece");
    if (!btn) return;
    e.preventDefault();
    toggleLock(Number(btn.dataset.i));
    render();
  });
  metricsWrap.addEventListener("click", (e) => {
    const b = e.target.closest(".pg-metric");
    if (!b) return;
    const m = METRICS.find((x) => x.id === b.dataset.id);
    activeMetric = activeMetric === m ? null : m; // toggle off if same
    render();
  });
  root.querySelector('[data-act="random"]').addEventListener("click", () => {
    randomBoard();
    render();
  });
  root.querySelector('[data-act="clear"]').addEventListener("click", () => {
    clearBoard();
    render();
  });
  const close = () => root.classList.add("hidden");
  root.querySelector(".pg-close").addEventListener("click", close);
  root.addEventListener("click", (e) => {
    if (e.target === root) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !root.classList.contains("hidden")) close();
  });

  randomBoard();
}

export function openPlayground() {
  if (!root) build();
  root.classList.remove("hidden");
  render();
}
