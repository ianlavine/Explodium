# Value-net trainer for flip-triples.
#
#   .venv/bin/python train.py [--data data/positions.jsonl] [--epochs 40]
#                             [--hidden 128] [--out weights.json]
#
# Input: JSONL from gen-positions.js. Each position becomes 145 binary
# features: cell*6 + state (state = shape + 3*flipped; shapes R=0 B=1 N=2,
# matching solver.js codes) plus feature 144 = 1.0 when red (side 1) is to
# move. Label y = exact solved margin (sv) when available, else the game
# outcome margin (z); both red-perspective points (triple=1, white=0.1).
# Training target is tanh(y / SCALE); solved labels get 2x sample weight.
#
# Augmentation (x8): the 4x6 board's symmetry group {id, h-flip, v-flip, 180}
# crossed with the color swap (R<->B everywhere, side flipped, label negated) —
# the color swap teaches red/blue antisymmetry directly.
#
# Split is by game seed (positions within a game are correlated). Reported
# gate metric: sign accuracy on held-out exactly-solved positions — the
# hand-weight linear fit reached 68%, so beat that before bothering with A/B.
#
# Export: weights.json {arch, scale, w1 (input-major 145x[hidden]), b1, w2,
# b2, w3, b3} consumed by the sparse forward pass in solver.js netEval.
import argparse
import json
import math
import os
import numpy as np
import torch
import torch.nn as nn

ROWS, COLS = 6, 4
CELLS = ROWS * COLS
N_STATES = 6
N_FEATURES = CELLS * N_STATES + 1  # +1 side-to-move
SCALE = 2.0  # target = tanh(margin / SCALE)

SHAPE_OF_CHAR = {"R": 0, "B": 1, "N": 2, "r": 3, "b": 4, "n": 5}


def cell_permutations():
    """Index permutations for the board symmetry group {id, h, v, hv}."""
    perms = []
    for hflip in (False, True):
        for vflip in (False, True):
            p = np.empty(CELLS, dtype=np.int64)
            for i in range(CELLS):
                r, c = divmod(i, COLS)
                r2 = ROWS - 1 - r if vflip else r
                c2 = COLS - 1 - c if hflip else c
                p[i] = r2 * COLS + c2
            perms.append(p)
    return perms


# Color swap: R<->B (0<->1), r<->b (3<->4), neutrals fixed.
COLOR_SWAP = np.array([1, 0, 2, 4, 3, 5], dtype=np.int64)


def load_positions(path):
    boards, sides, labels, weights, seeds = [], [], [], [], []
    with open(path) as f:
        for line in f:
            rec = json.loads(line)
            states = np.array([SHAPE_OF_CHAR[ch] for ch in rec["board"]], dtype=np.int64)
            boards.append(states)
            sides.append(rec["side"])
            if rec["solved"]:
                labels.append(rec["sv"])
                weights.append(2.0)
            else:
                labels.append(rec["z"])
                weights.append(1.0)
            seeds.append(rec["seed"])
    return (
        np.stack(boards),
        np.array(sides, dtype=np.int64),
        np.array(labels, dtype=np.float32),
        np.array(weights, dtype=np.float32),
        np.array(seeds, dtype=np.int64),
    )


def augment(boards, sides, labels, weights):
    """8x: 4 board symmetries x optional color swap (negates label, flips side)."""
    out_b, out_s, out_l, out_w = [], [], [], []
    for perm in cell_permutations():
        permuted = boards[:, perm]
        for swap in (False, True):
            if swap:
                out_b.append(COLOR_SWAP[permuted])
                out_s.append(1 - sides)
                out_l.append(-labels)
            else:
                out_b.append(permuted)
                out_s.append(sides)
                out_l.append(labels)
            out_w.append(weights)
    return (
        np.concatenate(out_b),
        np.concatenate(out_s),
        np.concatenate(out_l),
        np.concatenate(out_w),
    )


def to_dense(boards, sides):
    n = boards.shape[0]
    x = np.zeros((n, N_FEATURES), dtype=np.float32)
    rows = np.repeat(np.arange(n), CELLS)
    cols = (np.tile(np.arange(CELLS), n) * N_STATES + boards.reshape(-1)).astype(np.int64)
    x[rows, cols] = 1.0
    x[:, N_FEATURES - 1] = sides
    return x


class ValueNet(nn.Module):
    def __init__(self, hidden=128, hidden2=32):
        super().__init__()
        self.l1 = nn.Linear(N_FEATURES, hidden)
        self.l2 = nn.Linear(hidden, hidden2)
        self.l3 = nn.Linear(hidden2, 1)

    def forward(self, x):
        h = torch.clamp(self.l1(x), 0.0, 1.0)  # clipped ReLU, NNUE-style
        h = torch.relu(self.l2(h))
        return torch.tanh(self.l3(h)).squeeze(-1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=os.path.join(os.path.dirname(__file__), "data/positions.jsonl"))
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "weights.json"))
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--hidden", type=int, default=128)
    ap.add_argument("--hidden2", type=int, default=32)
    ap.add_argument("--batch", type=int, default=1024)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--val-frac", type=float, default=0.1)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()

    torch.manual_seed(args.seed)
    rng = np.random.default_rng(args.seed)

    boards, sides, labels, weights, seeds = load_positions(args.data)
    n_raw = len(labels)
    uniq_seeds = np.unique(seeds)
    rng.shuffle(uniq_seeds)
    n_val_seeds = max(1, int(len(uniq_seeds) * args.val_frac))
    val_seed_set = set(uniq_seeds[:n_val_seeds].tolist())
    val_mask = np.array([s in val_seed_set for s in seeds])
    solved_mask = weights > 1.5
    print(
        f"loaded {n_raw} positions from {len(uniq_seeds)} games "
        f"({solved_mask.sum()} exactly solved); val: {val_mask.sum()} positions from {n_val_seeds} games"
    )

    tr_b, tr_s, tr_l, tr_w = augment(
        boards[~val_mask], sides[~val_mask], labels[~val_mask], weights[~val_mask]
    )
    x_val = torch.from_numpy(to_dense(boards[val_mask], sides[val_mask]))
    t_val = torch.from_numpy(np.tanh(labels[val_mask] / SCALE))
    # Gate metric set: held-out, exactly solved, decisive (sign carries meaning).
    gate_mask = val_mask & solved_mask & (labels != 0)
    x_gate = torch.from_numpy(to_dense(boards[gate_mask], sides[gate_mask]))
    y_gate_sign = torch.from_numpy(np.sign(labels[gate_mask]).astype(np.float32))

    x_tr = torch.from_numpy(to_dense(tr_b, tr_s))
    t_tr = torch.from_numpy(np.tanh(tr_l / SCALE))
    w_tr = torch.from_numpy(tr_w)
    print(f"train: {len(t_tr)} rows after 8x augmentation")

    model = ValueNet(args.hidden, args.hidden2)
    opt = torch.optim.Adam(model.parameters(), lr=args.lr)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=args.epochs)

    n_tr = len(t_tr)
    best_val = math.inf
    best_state = None
    for epoch in range(1, args.epochs + 1):
        model.train()
        order = torch.randperm(n_tr)
        total = 0.0
        for i in range(0, n_tr, args.batch):
            idx = order[i : i + args.batch]
            pred = model(x_tr[idx])
            loss = (w_tr[idx] * (pred - t_tr[idx]) ** 2).mean()
            opt.zero_grad()
            loss.backward()
            opt.step()
            total += loss.item() * len(idx)
        sched.step()

        model.eval()
        with torch.no_grad():
            val_mse = ((model(x_val) - t_val) ** 2).mean().item()
            gate_pred = model(x_gate)
            sign_acc = (torch.sign(gate_pred) == y_gate_sign).float().mean().item()
        marker = ""
        if val_mse < best_val:
            best_val = val_mse
            best_state = {k: v.clone() for k, v in model.state_dict().items()}
            marker = " *"
        print(
            f"epoch {epoch:3d}  train {total / n_tr:.5f}  val {val_mse:.5f}  "
            f"solved-sign-acc {100 * sign_acc:.1f}%{marker}"
        )

    model.load_state_dict(best_state)
    model.eval()
    with torch.no_grad():
        sign_acc = (torch.sign(model(x_gate)) == y_gate_sign).float().mean().item()
    print(f"\nbest val mse {best_val:.5f}; held-out solved sign accuracy {100 * sign_acc:.1f}% "
          f"(linear-fit benchmark: 68%)")

    sd = {k: v.numpy() for k, v in model.state_dict().items()}
    export = {
        "arch": [N_FEATURES, args.hidden, args.hidden2, 1],
        "scale": SCALE,
        # w1 input-major: row f = hidden-vector added when feature f is active.
        "w1": sd["l1.weight"].T.reshape(-1).round(6).tolist(),
        "b1": sd["l1.bias"].round(6).tolist(),
        "w2": sd["l2.weight"].reshape(-1).round(6).tolist(),
        "b2": sd["l2.bias"].round(6).tolist(),
        "w3": sd["l3.weight"].reshape(-1).round(6).tolist(),
        "b3": sd["l3.bias"].round(6).tolist(),
    }
    with open(args.out, "w") as f:
        json.dump(export, f)
    print(f"wrote {args.out} ({os.path.getsize(args.out) // 1024} KB)")


if __name__ == "__main__":
    main()
