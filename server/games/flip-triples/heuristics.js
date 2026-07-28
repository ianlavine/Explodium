// Named heuristics for Flip Triples' leaf eval.
//
// Each heuristic is a dictionary of FEATURE -> WEIGHT. The leaf score is
//     Σ  weight * (red_count − blue_count)   for that feature
// (see weightedEval in solver.js). A weight of 0 — or an omitted key — turns a
// feature off. Play with these and add your own; the face-off tool
// (eval-faceoff.js) runs any two by name:  --a classic --b frozen.
//
// Features:
//   lockedTriples     3-in-a-rows whose cells are all locked (banked)   (+carry)
//   softTriples       any current 3-in-a-row, even if a piece can leave
//   permanentTriples  3-in-a-rows whose cells are all permanent (⊇ locked) (+carry)
//   completionSpaces  one-move threats to LOCK a permanent triple
//   completionSpacesHot  completionSpaces, but tempo-aware: the mover's threats
//                     count full, the idle side's are discounted (blockable)
//   whitePieces       your unflipped pieces (the tiebreak currency)
//   tempo             small side-to-move nudge (+ if red to move)

export const HEURISTICS = {
  // "old" — the current, deployed hand eval.
  classic: {
    lockedTriples: 2000,
    softTriples: 250,
    whitePieces: 10
  },

  basic: {
    lockedTriples: 2000,
    whitePieces: 10
  },

  basic2: {
    permanentTriples: 2000,
    whitePieces: 10
  },

  basic3: {
    lockedTriples: 2000,
    completionSpaces: 250,
    whitePieces: 10
  },

  // basic3, but with tempo-aware completion spaces.
  basic3hot: {
    lockedTriples: 2000,
    completionSpacesHot: 250,
    whitePieces: 10
  },

  updatedclassic: {
    permanentTriples: 2000,
    softTriples: 250,
    whitePieces: 10
  },

  // "new" — permanence-based: banked permanent triples + threats to make them.
  frozen: {
    permanentTriples: 2000,
    completionSpaces: 250,
    whitePieces: 10
  }

  // ---- add your own below, then pit it with --a <name> --b <name> ----
  // hybrid: {
  //   permanentTriples: 2000,
  //   completionSpaces: 250,
  //   softTriples: 100, // keep a little "progress" gradient
  //   whitePieces: 10
  // },
};

// The full feature list, for display / validation.
export const FEATURE_KEYS = [
  "lockedTriples",
  "softTriples",
  "permanentTriples",
  "completionSpaces",
  "completionSpacesHot",
  "whitePieces",
  "tempo"
];

// A one-line description of a heuristic's weights (for logs).
export function describe(w) {
  return FEATURE_KEYS.filter((k) => w[k]).map((k) => `${k} ${w[k]}`).join(", ") || "(empty)";
}
