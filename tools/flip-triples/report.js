// Renders analysis/data.json into a self-contained HTML report
// (analysis/report.html). Invoked via `node tools/flip-triples/analyze.js report`.

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function pct(n, total) {
  return total > 0 ? (100 * n) / total : 0;
}

function fmtPct(v) {
  return `${Math.round(v)}%`;
}

// One 100%-stacked bar: left pole / tie / right pole, with a 50% reference
// line. Labels ride inside a segment only when it is wide enough; the tooltip
// and table carry the rest.
function segBar(parts, total, { refline = false, unit = "games" } = {}) {
  const seg = ({ cls, count, name }) => {
    const share = pct(count, total);
    if (share <= 0) return "";
    const label = share >= 16 ? `<span class="seg-label">${fmtPct(share)}</span>` : "";
    return (
      `<div class="seg ${cls}" style="width:${share.toFixed(2)}%" tabindex="0" ` +
      `data-tip="${esc(`${name}: ${count} of ${total} ${unit} (${share.toFixed(1)}%)`)}">${label}</div>`
    );
  };
  return (
    `<div class="track">` +
    parts.map(seg).join("") +
    (refline ? `<div class="refline" aria-hidden="true"></div>` : "") +
    `</div>`
  );
}

function stackedBar({ left, tie, right, total, leftName, tieName, rightName }) {
  return segBar(
    [
      { cls: "seg-left", count: left, name: leftName },
      { cls: "seg-tie", count: tie, name: tieName },
      { cls: "seg-right", count: right, name: rightName }
    ],
    total,
    { refline: true }
  );
}

function legend(items) {
  return (
    `<div class="legend">` +
    items.map(([cls, label]) => `<span class="key"><span class="swatch ${cls}"></span>${esc(label)}</span>`).join("") +
    `</div>`
  );
}

function ladderRows(data) {
  const rungOrder = data.ladder.rungs;
  const pairs = [...data.ladder.pairs].sort(
    (a, b) => rungOrder.indexOf(a.strong) - rungOrder.indexOf(b.strong)
  );
  return pairs;
}

function ladderSection(data) {
  const pairs = ladderRows(data);
  if (!pairs.length) return "<p class='note'>No ladder data yet.</p>";
  const rows = pairs
    .map((p) => {
      const bar = stackedBar({
        left: p.strongWins,
        tie: p.ties,
        right: p.weakWins,
        total: p.games,
        leftName: `${p.strong} (stronger) wins`,
        tieName: "ties",
        rightName: `${p.weak} (weaker) wins`
      });
      return (
        `<div class="row">` +
        `<div class="row-label">${esc(p.strong)} <span class="vs">vs</span> ${esc(p.weak)}</div>` +
        bar +
        `<div class="row-value">${p.strongWins}/${p.games}</div>` +
        `</div>`
      );
    })
    .join("");
  // A rung is "live" while the stronger side wins the clear majority of
  // decided games; the ladder has flattened once that share sits near 50%.
  const decisiveShares = pairs.map((p) => pct(p.strongWins, p.strongWins + p.weakWins));
  const live = decisiveShares.filter((s) => s > 55);
  const lo = Math.min(...decisiveShares);
  const hi = Math.max(...decisiveShares);
  const tail =
    live.length === pairs.length
      ? `Extra thinking stops mattering only when a rung's share sinks to ~50%, which hasn't happened yet on this chart.`
      : `Rungs near 50% are where extra thinking has stopped mattering.`;
  const summary =
    `<p class="reading"><strong>${live.length} of ${pairs.length} rungs are live</strong> — the ` +
    `bigger budget wins ${Math.round(lo)}–${Math.round(hi)}% of decided games per step. ${tail}</p>`;
  const table =
    `<details><summary>Data table</summary><table>` +
    `<tr><th>Matchup (stronger vs weaker)</th><th>Games</th><th>Stronger wins</th><th>Weaker wins</th><th>Ties</th><th>Stronger win rate</th></tr>` +
    pairs
      .map(
        (p) =>
          `<tr><td>${esc(p.strong)} vs ${esc(p.weak)}</td><td>${p.games}</td><td>${p.strongWins}</td>` +
          `<td>${p.weakWins}</td><td>${p.ties}</td><td>${pct(p.strongWins, p.games).toFixed(1)}%</td></tr>`
      )
      .join("") +
    `</table></details>`;
  return (
    legend([
      ["seg-left", "stronger budget wins"],
      ["seg-tie", "tie"],
      ["seg-right", "weaker budget wins"]
    ]) +
    `<div class="chart">${rows}</div>` +
    `<div class="axis"><span>0%</span><span class="axis-mid">50%</span><span>100%</span></div>` +
    summary +
    table
  );
}

// Average points the stronger budget finishes ahead by (triple = 1 point,
// remaining white piece = 0.1). Only games played since margin tracking was
// added carry this data, so n is per-pair.
function marginSection(data) {
  const pairs = ladderRows(data).filter((p) => (p.diffGames ?? 0) > 0);
  if (!pairs.length) return "<p class='note'>No margin data yet.</p>";
  const values = pairs.map((p) => p.diffSum / p.diffGames);
  const axisMax = Math.max(0.5, Math.ceil(Math.max(...values) * 2) / 2);
  const rows = pairs
    .map((p, i) => {
      const v = values[i];
      const width = Math.max(0, Math.min(100, (v / axisMax) * 100));
      return (
        `<div class="row">` +
        `<div class="row-label">${esc(p.strong)} <span class="vs">vs</span> ${esc(p.weak)}</div>` +
        `<div class="track track-open">` +
        `<div class="seg seg-margin" style="width:${width.toFixed(2)}%" tabindex="0" ` +
        `data-tip="${esc(
          `${p.strong} beats ${p.weak} by ${v.toFixed(2)} points on average over ${p.diffGames} measured games`
        )}"></div></div>` +
        `<div class="row-value">${v >= 0 ? "+" : ""}${v.toFixed(2)} <span class="vs">n=${p.diffGames}</span></div>` +
        `</div>`
      );
    })
    .join("");
  const table =
    `<details><summary>Data table</summary><table>` +
    `<tr><th>Matchup</th><th>Measured games</th><th>Avg margin (points)</th></tr>` +
    pairs
      .map((p, i) => `<tr><td>${esc(p.strong)} vs ${esc(p.weak)}</td><td>${p.diffGames}</td><td>${values[i].toFixed(2)}</td></tr>`)
      .join("") +
    `</table></details>`;
  const summary =
    `<p class="reading">Scoring: each triple is 1 point, each of your surviving white pieces is 0.1 — ` +
    `whites top out at 0.9, so they can never outweigh a triple, exactly mirroring the real ` +
    `tie-break rule. A margin near 1.0 means the stronger side wins by about a full triple.</p>`;
  return (
    `<div class="chart">${rows}</div>` +
    `<div class="axis"><span>0 pts</span><span>${axisMax.toFixed(1)} pts</span></div>` +
    summary +
    table
  );
}

// Decided games split by HOW they were decided: triple counts differing vs
// triples tied and the white count settling it. Margins tracked per bucket.
function decidedSection(data) {
  const pairs = ladderRows(data).filter((p) => (p.splitGames ?? 0) > 0);
  if (!pairs.length) return "<p class='note'>No decision-type data yet.</p>";
  const rows = pairs
    .map((p) => {
      const tbAvg = p.tbWins ? p.tbDiffSum / p.tbWins : 0;
      const ntbAvg = p.tripleWins ? p.ntbDiffSum / p.tripleWins : 0;
      const splitTies = p.splitGames - p.tbWins - p.tripleWins;
      const bar = segBar(
        [
          {
            cls: "seg-own",
            count: p.tripleWins,
            name: `decided on triples (stronger side's avg margin ${ntbAvg.toFixed(2)} pts)`
          },
          {
            cls: "seg-opp",
            count: p.tbWins,
            name: `decided on the white tiebreak (stronger side's avg margin ${tbAvg.toFixed(2)} pts)`
          },
          { cls: "seg-neu", count: splitTies, name: "dead ties" }
        ],
        p.splitGames,
        { unit: "measured games" }
      );
      return (
        `<div class="row">` +
        `<div class="row-label">${esc(p.strong)} <span class="vs">vs</span> ${esc(p.weak)}</div>` +
        bar +
        `<div class="row-value"><span class="vs">n=${p.splitGames}</span></div>` +
        `</div>`
      );
    })
    .join("");
  const totals = pairs.reduce(
    (a, p) => ({ tb: a.tb + p.tbWins, tri: a.tri + p.tripleWins, n: a.n + p.splitGames }),
    { tb: 0, tri: 0, n: 0 }
  );
  const summary =
    `<p class="reading">Across all ${totals.n} measured games, ` +
    `<strong>${fmtPct(pct(totals.tb, totals.n))} were decided by the white tiebreak</strong> ` +
    `(triples dead even) and ${fmtPct(pct(totals.tri, totals.n))} on triple count. Tiebreak wins are ` +
    `worth at most 0.9 points by construction, so the two margin columns in the table are on ` +
    `different scales — compare counts across rungs, and margins within a column.</p>`;
  const table =
    `<details><summary>Data table</summary><table>` +
    `<tr><th>Matchup</th><th>Measured</th><th>Triple-decided</th><th>Avg margin</th>` +
    `<th>Tiebreak-decided</th><th>Avg margin</th><th>Ties</th></tr>` +
    pairs
      .map((p) => {
        const tbAvg = p.tbWins ? p.tbDiffSum / p.tbWins : null;
        const ntbAvg = p.tripleWins ? p.ntbDiffSum / p.tripleWins : null;
        return (
          `<tr><td>${esc(p.strong)} vs ${esc(p.weak)}</td><td>${p.splitGames}</td>` +
          `<td>${p.tripleWins}</td><td>${ntbAvg === null ? "—" : ntbAvg.toFixed(2)}</td>` +
          `<td>${p.tbWins}</td><td>${tbAvg === null ? "—" : tbAvg.toFixed(2)}</td>` +
          `<td>${p.splitGames - p.tbWins - p.tripleWins}</td></tr>`
        );
      })
      .join("") +
    `</table></details>`;
  return (
    legend([
      ["seg-own", "decided on triples"],
      ["seg-opp", "decided on white tiebreak"],
      ["seg-neu", "dead tie"]
    ]) +
    `<div class="chart">${rows}</div>` +
    summary +
    table
  );
}

function firstPlayerSection(data) {
  const runs = [...data.selfplay].sort((a, b) => a.ms - b.ms);
  if (!runs.length) return "<p class='note'>No self-play data yet.</p>";
  const rows = runs
    .map((r) => {
      const bar = stackedBar({
        left: r.blue,
        tie: r.tie,
        right: r.red,
        total: r.deals,
        leftName: "blue (moves first) wins",
        tieName: "ties",
        rightName: "red (moves second) wins"
      });
      return (
        `<div class="row">` +
        `<div class="row-label">${esc(`${r.ms}ms`)} <span class="vs">×${r.deals}</span></div>` +
        bar +
        `<div class="row-value">${fmtPct(pct(r.blue, r.deals))} first</div>` +
        `</div>`
      );
    })
    .join("");
  const totals = runs.reduce(
    (acc, r) => ({ blue: acc.blue + r.blue, red: acc.red + r.red, tie: acc.tie + r.tie, n: acc.n + r.deals }),
    { blue: 0, red: 0, tie: 0, n: 0 }
  );
  const blueShare = pct(totals.blue, totals.n);
  const redShare = pct(totals.red, totals.n);
  // 95% CI half-width on the first-player win share, in percentage points.
  const p = Math.min(Math.max(blueShare / 100, 0.0001), 0.9999);
  const ci = totals.n ? 100 * 1.96 * Math.sqrt((p * (1 - p)) / totals.n) : 0;
  const summary =
    `<p class="reading">Across all ${totals.n} equal-strength games, the first player (blue) won ` +
    `<strong>${blueShare.toFixed(1)}%</strong> vs the second player's ${redShare.toFixed(1)}% ` +
    `(±${ci.toFixed(1)} points at 95% confidence on the first-player share), with ` +
    `${pct(totals.tie, totals.n).toFixed(1)}% ties. A gap inside the confidence band reads as no meaningful advantage.</p>`;
  const table =
    `<details><summary>Data table</summary><table>` +
    `<tr><th>Budget per move</th><th>Games</th><th>Blue (1st) wins</th><th>Red (2nd) wins</th><th>Ties</th><th>Avg plies</th><th>Avg branching</th><th>Solved tail (plies)</th></tr>` +
    runs
      .map(
        (r) =>
          `<tr><td>${r.ms}ms</td><td>${r.deals}</td><td>${r.blue}</td><td>${r.red}</td><td>${r.tie}</td>` +
          `<td>${r.avgPlies}</td><td>${r.avgBranching}</td><td>${r.avgSolvedTailPlies ?? "—"}</td></tr>`
      )
      .join("") +
    `</table></details>`;
  return (
    legend([
      ["seg-left", "blue — moves first"],
      ["seg-tie", "tie"],
      ["seg-right", "red — moves second"]
    ]) +
    `<div class="chart">${rows}</div>` +
    `<div class="axis"><span>0%</span><span class="axis-mid">50%</span><span>100%</span></div>` +
    summary +
    table
  );
}

const MOVE_PHASES = ["early", "mid", "late"];

function movesSection(data) {
  const runs = [...(data.moveProfile ?? [])].sort((a, b) => a.ms - b.ms);
  if (!runs.length) return "<p class='note'>No move-tracking data yet.</p>";

  const phaseTotals = (run, phase) => {
    const c = run.counts[phase];
    const piece = {
      own: c.own.corner + c.own.edge + c.own.middle,
      opponent: c.opponent.corner + c.opponent.edge + c.opponent.middle,
      neutral: c.neutral.corner + c.neutral.edge + c.neutral.middle
    };
    const zone = {
      corner: c.own.corner + c.opponent.corner + c.neutral.corner,
      edge: c.own.edge + c.opponent.edge + c.neutral.edge,
      middle: c.own.middle + c.opponent.middle + c.neutral.middle
    };
    const total = piece.own + piece.opponent + piece.neutral;
    return { piece, zone, total };
  };

  const groups = runs
    .map((run) => {
      const rows = MOVE_PHASES.map((phase) => {
        const { piece, zone, total } = phaseTotals(run, phase);
        const pieceBar = segBar(
          [
            { cls: "seg-own", count: piece.own, name: "flipped own piece" },
            { cls: "seg-opp", count: piece.opponent, name: "flipped opponent's piece" },
            { cls: "seg-neu", count: piece.neutral, name: "flipped a neutral" }
          ],
          total,
          { unit: `${phase}-game moves` }
        );
        const zoneBar = segBar(
          [
            { cls: "seg-corner", count: zone.corner, name: "landed in a corner" },
            { cls: "seg-edge", count: zone.edge, name: "landed on an edge" },
            { cls: "seg-middle", count: zone.middle, name: "landed in the middle" }
          ],
          total,
          { unit: `${phase}-game moves` }
        );
        return (
          `<div class="row row-duo"><div class="row-label">${phase}</div>` +
          pieceBar + zoneBar + `</div>`
        );
      }).join("");
      return `<div class="duo-group"><h3>${esc(`${run.ms}ms`)} <span class="vs">×${run.deals} games · ${run.moves} moves</span></h3>${rows}</div>`;
    })
    .join("");

  const strongest = runs[runs.length - 1];
  const early = phaseTotals(strongest, "early");
  const late = phaseTotals(strongest, "late");
  const summary =
    `<p class="reading">At the strongest budget tracked (${strongest.ms}ms), ` +
    `<strong>${fmtPct(pct(early.piece.own, early.total))}</strong> of early-game flips are the mover's ` +
    `own pieces, falling to ${fmtPct(pct(late.piece.own, late.total))} late — endgames shift toward ` +
    `locking opponent pieces and spending neutrals. For landing zones, the board is 4 corner / 12 edge / ` +
    `8 middle cells, so a "no preference" baseline is 17% / 50% / 33%.</p>`;

  const table =
    `<details><summary>Data table</summary><table>` +
    `<tr><th>Budget</th><th>Phase</th><th>Own</th><th>Opponent</th><th>Neutral</th>` +
    `<th>Corner</th><th>Edge</th><th>Middle</th><th>Moves</th></tr>` +
    runs
      .map((run) =>
        MOVE_PHASES.map((phase) => {
          const { piece, zone, total } = phaseTotals(run, phase);
          const cell = (v) => `<td>${v} (${pct(v, total).toFixed(0)}%)</td>`;
          return (
            `<tr><td>${run.ms}ms</td><td>${phase}</td>` +
            cell(piece.own) + cell(piece.opponent) + cell(piece.neutral) +
            cell(zone.corner) + cell(zone.edge) + cell(zone.middle) +
            `<td>${total}</td></tr>`
          );
        }).join("")
      )
      .join("") +
    `</table></details>`;

  const legends =
    `<div class="row row-duo legend-row"><div class="row-label"></div>` +
    legend([
      ["seg-own", "own piece"],
      ["seg-opp", "opponent's"],
      ["seg-neu", "neutral"]
    ]) +
    legend([
      ["seg-corner", "corner"],
      ["seg-edge", "edge"],
      ["seg-middle", "middle"]
    ]) +
    `</div>`;

  return legends + groups + summary + table;
}

// 1,000 near-perfect games (both sides full-strength solver, 5s/move,
// provably perfect endgames): who wins, by how much, and whether the random
// setup predicts it.
function setupLuckSection(data) {
  const s = data.setupLuck;
  if (!s) return "<p class='note'>No solved-game batch yet.</p>";
  const firstShare = pct(s.first, s.n);
  const winnerBar = stackedBar({
    left: s.first,
    tie: s.ties,
    right: s.second,
    total: s.n,
    leftName: "first player wins",
    tieName: "dead ties",
    rightName: "second player wins"
  });

  const histTotal = Object.values(s.hist).reduce((a, b) => a + b, 0);
  const maxCount = Math.max(...Object.values(s.hist));
  const histRows = [];
  for (let b = 3; b >= -3; b -= 1) {
    const count = s.hist[b] ?? 0;
    const width = (100 * count) / maxCount;
    const cls = b > 0 ? "seg-left" : b < 0 ? "seg-right" : "seg-tie";
    const label =
      b === 3 ? "+3 or more" : b === -3 ? "−3 or less" : `${b > 0 ? "+" : b < 0 ? "−" : ""}${Math.abs(b)}`;
    histRows.push(
      `<div class="row">` +
        `<div class="row-label">${label}</div>` +
        `<div class="track track-open"><div class="seg ${cls}" style="width:${width.toFixed(1)}%" tabindex="0" ` +
        `data-tip="${esc(`margin ≈ ${label} points (first minus second): ${count} of ${histTotal} games (${pct(count, histTotal).toFixed(1)}%)`)}"></div></div>` +
        `<div class="row-value">${count}</div>` +
        `</div>`
    );
  }

  const bucketTable =
    `<details><summary>Setup-feature table</summary><table>` +
    `<tr><th>Starting-arrangement bucket</th><th>Games</th><th>First-player win rate</th></tr>` +
    s.tripleBuckets
      .map((b) => `<tr><td>${esc(b.label)}</td><td>${b.n}</td><td>${b.firstWinPct.toFixed(1)}%</td></tr>`)
      .join("") +
    `</table></details>`;

  return (
    legend([
      ["seg-left", "first player (moves first)"],
      ["seg-tie", "tie"],
      ["seg-right", "second player"]
    ]) +
    `<div class="chart">${winnerBar ? `<div class="row"><div class="row-label">all ${s.n} games</div>${winnerBar}<div class="row-value">${fmtPct(firstShare)} first</div></div>` : ""}</div>` +
    `<h3 class="hist-head">Final margin distribution (points, first minus second)</h3>` +
    `<div class="chart">${histRows.join("")}</div>` +
    `<p class="reading">Under near-perfect play the <strong>first player wins ${firstShare.toFixed(1)}%</strong> ` +
    `(mean margin +${s.meanDiff.toFixed(2)} pts, sd ${s.sdDiff.toFixed(2)}) — the seat matters. The setup, ` +
    `surprisingly, barely does: visible arrangement features (starting triples, adjacent pairs, middle ` +
    `occupancy) explain only <strong>~${s.featureR2}%</strong> of the margin, and first-player win rates are ` +
    `flat across setup buckets (see table). Every game in this batch was played provably perfectly for its ` +
    `last ~${s.avgSolvedTailPlies} plies. The randomness adds variance — not a legible pre-decided advantage.</p>` +
    bucketTable
  );
}

function tiles(data) {
  const runs = data.selfplay;
  const totalGames =
    runs.reduce((a, r) => a + r.deals, 0) +
    data.ladder.pairs.reduce((a, p) => a + p.games, 0) +
    (data.moveProfile ?? []).reduce((a, r) => a + r.deals, 0);
  const w = (sel) => {
    const num = runs.reduce((a, r) => a + sel(r) * r.deals, 0);
    const den = runs.reduce((a, r) => a + r.deals, 0);
    return den ? num / den : null;
  };
  const avgPlies = w((r) => r.avgPlies);
  const avgBranch = w((r) => r.avgBranching);
  const tail = w((r) => r.avgSolvedTailPlies ?? 0);
  const tile = (label, value, sub) =>
    `<div class="tile"><div class="tile-label">${esc(label)}</div>` +
    `<div class="tile-value">${esc(value)}</div><div class="tile-sub">${esc(sub)}</div></div>`;
  return (
    `<div class="tiles">` +
    tile("Games in dataset", String(totalGames), "solver vs solver, random deals") +
    tile("Game length", avgPlies ? avgPlies.toFixed(1) : "—", "average plies (moves total)") +
    tile("Branching factor", avgBranch ? avgBranch.toFixed(1) : "—", "average legal moves per turn") +
    tile("Solved endgame", tail ? `last ${tail.toFixed(1)}` : "—", "plies played provably perfectly") +
    `</div>`
  );
}

export function generateReport(data) {
  const updated = data.updated ? new Date(data.updated).toISOString().slice(0, 10) : "—";
  const s = data.settings ?? {};
  return `<title>Flip Triples — Depth Report</title>
<style>
  :root {
    --page: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e;
    --muted: #898781; --grid: #e1e0d9; --baseline: #c3c2b7;
    --blue: #2a78d6; --red: #e34948; --tie: #dbdad3; --tie-ink: #52514e;
    --own: #4a3aa7; --opp: #eb6834;
    --z1: #86b6ef; --z2: #2a78d6; --z3: #104281;
    --ring: rgba(11, 11, 11, 0.1);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --page: #0d0d0d; --surface: #1a1a19; --ink: #ffffff; --ink-2: #c3c2b7;
      --muted: #898781; --grid: #2c2c2a; --baseline: #383835;
      --blue: #3987e5; --red: #e66767; --tie: #383835; --tie-ink: #c3c2b7;
      --own: #9085e9; --opp: #d95926;
      --z1: #9ec5f4; --z2: #3987e5; --z3: #184f95;
      --ring: rgba(255, 255, 255, 0.1);
    }
  }
  body { background: var(--page); color: var(--ink); margin: 0;
    font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
  .wrap { max-width: 860px; margin: 0 auto; padding: 40px 20px 72px; }
  header { margin-bottom: 28px; }
  .eyebrow { font: 600 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
    letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted); }
  h1 { font-size: 27px; line-height: 1.2; margin: 10px 0 6px; letter-spacing: -0.01em; text-wrap: balance; }
  .sub { color: var(--ink-2); margin: 0; max-width: 62ch; }
  .meta { color: var(--muted); font-size: 13px; margin-top: 6px; }
  section { background: var(--surface); border: 1px solid var(--ring); border-radius: 10px;
    padding: 22px 24px 18px; margin-top: 22px; }
  h2 { font-size: 17px; margin: 0 0 2px; }
  .h2-sub { color: var(--ink-2); font-size: 13.5px; margin: 0 0 16px; max-width: 68ch; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-top: 22px; }
  .tile { background: var(--surface); border: 1px solid var(--ring); border-radius: 10px; padding: 14px 16px; }
  .tile-label { font-size: 12.5px; color: var(--ink-2); }
  .tile-value { font-size: 30px; font-weight: 600; margin: 2px 0; }
  .tile-sub { font-size: 12px; color: var(--muted); }
  .legend { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 14px; font-size: 12.5px; color: var(--ink-2); }
  .key { display: inline-flex; align-items: center; gap: 6px; }
  .swatch { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
  .swatch.seg-left { background: var(--blue); }
  .swatch.seg-tie { background: var(--tie); border: 1px solid var(--baseline); }
  .swatch.seg-right { background: var(--red); }
  .chart { display: flex; flex-direction: column; gap: 12px; }
  .row { display: grid; grid-template-columns: 150px 1fr 76px; align-items: center; gap: 12px; }
  .row-label { font-size: 13px; color: var(--ink-2); text-align: right;
    font-variant-numeric: tabular-nums; }
  .vs { color: var(--muted); font-size: 11.5px; }
  .row-value { font-size: 12.5px; color: var(--ink-2); font-variant-numeric: tabular-nums; }
  .track { position: relative; display: flex; gap: 2px; height: 20px; border-radius: 4px; overflow: hidden; }
  .seg { height: 100%; min-width: 0; display: flex; align-items: center; }
  .seg:focus-visible { outline: 2px solid var(--ink); outline-offset: 1px; }
  .seg-left { background: var(--blue); justify-content: flex-start; }
  .seg-tie { background: var(--tie); justify-content: center; }
  .seg-right { background: var(--red); justify-content: flex-end; }
  .seg-label { font-size: 11px; font-weight: 600; color: #fff; padding: 0 7px; }
  .seg-tie .seg-label { color: var(--tie-ink); }
  .seg-own { background: var(--own); }
  .seg-opp { background: var(--opp); }
  .seg-opp .seg-label { color: #2b1204; }
  .seg-neu { background: var(--tie); }
  .seg-neu .seg-label { color: var(--tie-ink); }
  .seg-corner { background: var(--z1); }
  .seg-corner .seg-label { color: #0b2c55; }
  .seg-edge { background: var(--z2); }
  .seg-middle { background: var(--z3); }
  .swatch.seg-own { background: var(--own); }
  .swatch.seg-opp { background: var(--opp); }
  .swatch.seg-neu { background: var(--tie); border: 1px solid var(--baseline); }
  .swatch.seg-corner { background: var(--z1); }
  .swatch.seg-edge { background: var(--z2); }
  .swatch.seg-middle { background: var(--z3); }
  .track-open { background: transparent; }
  .seg-margin { background: var(--blue); border-radius: 0 4px 4px 0; }
  .row-duo { grid-template-columns: 64px 1fr 1fr; }
  .legend-row .legend { margin-bottom: 2px; }
  .duo-group { margin-top: 14px; display: flex; flex-direction: column; gap: 10px; }
  .duo-group h3 { font-size: 13.5px; margin: 0 0 2px; }
  .hist-head { font-size: 13.5px; margin: 18px 0 10px; }
  .refline { position: absolute; left: 50%; top: -3px; bottom: -3px; width: 1px;
    background: var(--baseline); pointer-events: none; }
  .axis { display: flex; justify-content: space-between; margin: 8px 0 4px;
    padding: 0 76px 0 162px; font-size: 11px; color: var(--muted);
    font-variant-numeric: tabular-nums; }
  .reading { color: var(--ink-2); font-size: 13.5px; max-width: 68ch; margin: 14px 0 4px; }
  details { margin-top: 10px; }
  summary { font-size: 12.5px; color: var(--muted); cursor: pointer; }
  table { border-collapse: collapse; margin-top: 10px; font-size: 12.5px; width: 100%; }
  th { text-align: left; color: var(--ink-2); font-weight: 600; }
  th, td { padding: 5px 12px 5px 0; border-bottom: 1px solid var(--grid);
    font-variant-numeric: tabular-nums; }
  .note { color: var(--muted); }
  .method { color: var(--muted); font-size: 12.5px; max-width: 72ch; }
  .method code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace;
    background: var(--surface); border: 1px solid var(--ring); border-radius: 4px; padding: 1px 5px; }
  #tip { position: fixed; z-index: 10; background: var(--ink); color: var(--page);
    font-size: 12px; padding: 5px 9px; border-radius: 6px; pointer-events: none;
    max-width: 280px; display: none; }
  @media (max-width: 620px) {
    .row { grid-template-columns: 1fr; gap: 4px; }
    .row-label { text-align: left; }
    .axis { padding: 0; }
  }
</style>
<div class="wrap">
  <header>
    <div class="eyebrow">Explodium · Flip Triples · analysis</div>
    <h1>How deep is the default game?</h1>
    <p class="sub">Solver-measured data for the default setup: ${esc(s.board ?? "4x6")},
      ${esc(s.pieces ?? "9 + 9 + 6 neutral")}, unique swap on, ties broken by
      ${esc(s.tiebreak ?? "remaining white pieces")}. Agents are the same alpha-beta solver
      given different time budgets per move.</p>
    <p class="meta">Data updated ${esc(updated)} · regenerate with <code>node tools/flip-triples/analyze.js report</code></p>
  </header>

  ${tiles(data)}

  <section>
    <h2>Skill ladder — when does thinking longer stop paying off?</h2>
    <p class="h2-sub">Each bar is a match between adjacent time budgets (colors swapped every
      other game). While the stronger budget keeps winning well above the 50% line, the game
      still rewards deeper play at that level.</p>
    ${ladderSection(data)}
  </section>

  <section>
    <h2>Winning margin per rung</h2>
    <p class="h2-sub">Not just whether the stronger budget wins, but by how much: the average
      final-score gap (stronger minus weaker) across measured games, both seats played equally.</p>
    ${marginSection(data)}
  </section>

  <section>
    <h2>How games get decided — triples vs the white tiebreak</h2>
    <p class="h2-sub">Each decided game either had a triple-count gap, or dead-even triples with
      the surviving white pieces settling it. Hover a segment for that bucket's average margin.</p>
    ${decidedSection(data)}
  </section>

  <section>
    <h2>First-player advantage</h2>
    <p class="h2-sub">Equal-strength solver vs solver on random deals. Blue always moves
      first, as in the real game.</p>
    ${firstPlayerSection(data)}
  </section>

  <section>
    <h2>Setup luck — does the deal decide the game?</h2>
    <p class="h2-sub">1,000 random deals played by the full-strength solver on both sides
      (5s/move, no blunders, provably perfect endgames): the winner split, the margin
      distribution, and how little the starting arrangement predicts.</p>
    ${setupLuckSection(data)}
  </section>

  <section>
    <h2>Move anatomy — what gets flipped, and where</h2>
    <p class="h2-sub">Every move locks one piece. Left bars: whose piece the mover locked
      (its own, the opponent's, or a neutral). Right bars: which board zone the locked piece
      landed in. Split by game phase — the first, middle, and last third of each game.</p>
    ${movesSection(data)}
  </section>

  <section>
    <h2 class="sr">Method</h2>
    <p class="method">Method: every agent is the same iterative-deepening alpha-beta solver
      (flip-solver.js); a rung is a per-move time budget, and "random" plays uniformly random
      legal moves. Deals are seeded and reproducible. Add data with
      <code>node tools/flip-triples/analyze.js ladder --json analysis/data.json</code> or
      <code>node tools/flip-triples/analyze.js selfplay --json analysis/data.json</code>, then rebuild this page
      with <code>node tools/flip-triples/analyze.js report</code>.</p>
  </section>
</div>
<div id="tip" role="status"></div>
<script>
  const tip = document.getElementById("tip");
  function show(el) {
    tip.textContent = el.dataset.tip;
    tip.style.display = "block";
    const r = el.getBoundingClientRect();
    const tr = tip.getBoundingClientRect();
    tip.style.left = Math.max(8, Math.min(innerWidth - tr.width - 8, r.left + r.width / 2 - tr.width / 2)) + "px";
    tip.style.top = Math.max(8, r.top - tr.height - 8) + "px";
  }
  function hide() { tip.style.display = "none"; }
  document.querySelectorAll(".seg").forEach((el) => {
    el.addEventListener("mouseenter", () => show(el));
    el.addEventListener("mouseleave", hide);
    el.addEventListener("focus", () => show(el));
    el.addEventListener("blur", hide);
  });
</script>
`;
}
