#!/usr/bin/env python3
"""Train an original, compact HalfKP-style OMEGA NNUE from exact Stockfish labels.

This is a research prototype: one shared sparse piece/king embedding table,
side-relative white/black accumulators, clipped-ReLU output and a scalar value.
It is not Stockfish's architecture or weights and is not wired into live play.
"""
import argparse, gzip, hashlib, json, math, time
from pathlib import Path
import numpy as np

PIECE_TYPES = {"p": 0, "n": 1, "b": 2, "r": 3, "q": 4}
FEATURES = 64 * 10 * 64
DEFAULT_HIDDEN = 16


def fen_board(fen):
    fields = fen.split()
    if len(fields) != 6 or fields[1] not in ("w", "b"):
        raise ValueError(f"Invalid six-field FEN: {fen!r}")
    board = []
    for row in fields[0].split("/"):
        expanded = []
        for ch in row:
            if ch.isdigit() and ch in "12345678": expanded.extend(["."] * int(ch))
            elif ch in "PNBRQKpnbrqk": expanded.append(ch)
            else: raise ValueError(f"Invalid FEN board character: {ch!r}")
        if len(expanded) != 8: raise ValueError("FEN rank must contain eight squares")
        board.extend(expanded)
    if len(board) != 64: raise ValueError("FEN must contain eight ranks")
    return board, fields


def perspective_features(board, perspective):
    """Return sparse HalfKP-style indices, canonicalized to the perspective."""
    own_king = "K" if perspective == "w" else "k"
    try: king_sq = board.index(own_king)
    except ValueError as exc: raise ValueError("Position is missing a king") from exc
    if perspective == "b": king_sq = king_sq ^ 56
    result = []
    for square, piece in enumerate(board):
        if piece == "." or piece.lower() == "k": continue
        friendly = piece.isupper() if perspective == "w" else piece.islower()
        ptype = PIECE_TYPES[piece.lower()] + (0 if friendly else 5)
        oriented_sq = square if perspective == "w" else square ^ 56
        result.append(king_sq * 640 + ptype * 64 + oriented_sq)
    return np.asarray(result, dtype=np.int32)


def encode_fen(fen):
    board, fields = fen_board(fen)
    return perspective_features(board, "w"), perspective_features(board, "b"), fields[1]


def load_rows(path):
    opener = gzip.open if str(path).endswith(".gz") else open
    rows, rejected = [], {"non_exact_or_mate": 0}
    with opener(path, "rt", encoding="utf-8") as stream:
        for line_no, line in enumerate(stream, 1):
            if not line.strip(): continue
            row = json.loads(line)
            if row.get("teacherScoreBound") != "exact" or row.get("teacherScoreCp") is None or row.get("teacherScoreMate") is not None:
                rejected["non_exact_or_mate"] += 1; continue
            try:
                white, black, turn = encode_fen(row["fen"])
                cp = float(row["teacherScoreCp"])
                if not math.isfinite(cp): raise ValueError("non-finite score")
            except Exception as exc:
                raise ValueError(f"Invalid row {line_no}: {exc}") from exc
            # Collector records scores from side-to-move perspective.
            rows.append((white, black, cp, str(row.get("openingFamily") or row.get("openingEco") or "unknown"), turn))
    if len(rows) < 100: raise ValueError(f"Need at least 100 usable exact-score positions; found {len(rows)}")
    return rows, rejected


def split_rows(rows, validation_fraction=0.2):
    families = sorted({r[3] for r in rows})
    if len(families) < 2: raise ValueError("Need at least two opening families for a leakage-resistant split")
    # Stable family holdout; no positions from a held-out family enter training.
    held = set(families[::5])
    if len(held) == len(families): held = {families[-1]}
    train = [r for r in rows if r[3] not in held]
    valid = [r for r in rows if r[3] in held]
    if not train or not valid: raise ValueError("Opening-family split produced an empty partition")
    return train, valid, sorted(held)


def batch_forward(batch, embeddings, bias, out_w, out_b):
    # Per-position sum of sparse feature embeddings, for both king perspectives.
    n = len(batch)
    acc = np.broadcast_to(bias, (n, 2, len(bias))).copy()
    for i, (white, black, *_rest) in enumerate(batch):
        acc[i, 0] += embeddings[white].sum(axis=0)
        acc[i, 1] += embeddings[black].sum(axis=0)
    clipped = np.clip(acc, 0.0, 1.0)
    joined = clipped.reshape(n, -1)
    pred = joined @ out_w + out_b
    return pred, acc, clipped, joined


def evaluate(rows, params):
    emb, bias, out_w, out_b = params
    preds = []
    targets = []
    for start in range(0, len(rows), 256):
        batch = rows[start:start+256]
        pred, *_ = batch_forward(batch, emb, bias, out_w, out_b)
        preds.extend(pred.tolist())
        targets.extend([math.tanh((r[2] if r[4] == "w" else -r[2]) / 600.0) for r in batch])
    p, t = np.asarray(preds), np.asarray(targets)
    return {"mse": float(np.mean((p-t)**2)), "mae_scaled": float(np.mean(np.abs(p-t))),
            "mae_cp_approx": float(np.mean(np.abs(np.arctanh(np.clip(p, -0.999, 0.999)) - np.arctanh(np.clip(t, -0.999, 0.999)))) * 600.0)}


def train(rows, hidden=DEFAULT_HIDDEN, epochs=8, batch_size=128, learning_rate=0.015, seed=20261115):
    rng = np.random.default_rng(seed)
    emb = rng.normal(0, 0.015, (FEATURES, hidden)).astype(np.float32)
    bias = np.zeros(hidden, dtype=np.float32)
    out_w = rng.normal(0, 0.03, (hidden*2,)).astype(np.float32)
    out_b = np.float32(0.0)
    m = [np.zeros_like(emb), np.zeros_like(bias), np.zeros_like(out_w), np.zeros((), dtype=np.float32)]
    v = [np.zeros_like(emb), np.zeros_like(bias), np.zeros_like(out_w), np.zeros((), dtype=np.float32)]
    step = 0
    for epoch in range(epochs):
        order = rng.permutation(len(rows))
        for start in range(0, len(order), batch_size):
            batch = [rows[int(i)] for i in order[start:start+batch_size]]
            target = np.asarray([math.tanh((r[2] if r[4] == "w" else -r[2]) / 600.0) for r in batch], dtype=np.float32)
            pred, acc, clipped, joined = batch_forward(batch, emb, bias, out_w, out_b)
            grad = (2.0 / len(batch)) * (pred - target)
            g_out_w = joined.T @ grad
            g_out_b = np.sum(grad)
            g_joined = grad[:, None] * out_w[None, :]
            g_acc = g_joined.reshape(len(batch), 2, hidden) * ((acc > 0.0) & (acc < 1.0))
            g_bias = g_acc.sum(axis=(0, 1))
            g_emb = np.zeros_like(emb)
            for i, (white, black, *_rest) in enumerate(batch):
                np.add.at(g_emb, white, g_acc[i, 0])
                np.add.at(g_emb, black, g_acc[i, 1])
            grads = [g_emb, g_bias, g_out_w, np.asarray(g_out_b, dtype=np.float32)]
            step += 1
            for j, (param, grad_param) in enumerate(zip([emb, bias, out_w, out_b], grads)):
                m[j] = 0.9*m[j] + 0.1*grad_param
                v[j] = 0.999*v[j] + 0.001*(grad_param*grad_param)
                mhat = m[j] / (1.0 - 0.9**step)
                vhat = v[j] / (1.0 - 0.999**step)
                updated = param - learning_rate*mhat/(np.sqrt(vhat)+1e-8)
                if j == 0: emb = updated
                elif j == 1: bias = updated
                elif j == 2: out_w = updated
                else: out_b = np.float32(updated)
    return emb, bias, out_w, out_b


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', default='training/stockfish19-500games-2026-11-09/stockfish19-500games.positions.jsonl.gz')
    ap.add_argument('--out', default='training/omega-nnue-v1')
    ap.add_argument('--epochs', type=int, default=8)
    ap.add_argument('--hidden', type=int, default=DEFAULT_HIDDEN)
    ap.add_argument('--batch-size', type=int, default=128)
    ap.add_argument('--learning-rate', type=float, default=0.015)
    ap.add_argument('--seed', type=int, default=20261115)
    args = ap.parse_args()
    if not 1 <= args.hidden <= 128 or not 1 <= args.epochs <= 100: ap.error('hidden must be 1..128 and epochs 1..100')
    started = time.time()
    rows, rejected = load_rows(args.data)
    train_rows, valid_rows, held = split_rows(rows)
    zero = {"mse": float(np.mean([math.tanh((r[2] if r[4] == "w" else -r[2])/600.0)**2 for r in valid_rows])),
            "mae_scaled": float(np.mean([abs(math.tanh((r[2] if r[4] == "w" else -r[2])/600.0)) for r in valid_rows]))}
    params = train(train_rows, args.hidden, args.epochs, args.batch_size, args.learning_rate, args.seed)
    metrics = evaluate(valid_rows, params)
    out = Path(args.out); out.mkdir(parents=True, exist_ok=True)
    model_path = out / 'omega-nnue-v1.npz'
    np.savez_compressed(model_path, embeddings=params[0], accumulator_bias=params[1], output_weights=params[2], output_bias=params[3], architecture=np.asarray('OMEGA-HalfKP-style-v1'), hidden=np.asarray(args.hidden))
    digest = hashlib.sha256(model_path.read_bytes()).hexdigest()
    report = {"architecture":"OMEGA-HalfKP-style-v1", "feature_count":FEATURES, "hidden":args.hidden,
              "training_positions":len(train_rows), "validation_positions":len(valid_rows),
              "held_out_opening_families":held, "rejected":rejected, "baseline_zero_value":zero,
              "validation":metrics, "model_sha256":digest, "model_bytes":model_path.stat().st_size,
              "epochs":args.epochs, "batch_size":args.batch_size, "learning_rate":args.learning_rate,
              "elapsed_seconds":round(time.time()-started,2), "live_engine_integrated":False}
    (out/'REPORT.json').write_text(json.dumps(report, indent=2)+'\n')
    (out/'REPORT.md').write_text('# OMEGA NNUE v1 training report\n\n'+ '\n'.join(f'- **{k}:** {v}' for k,v in report.items())+'\n')
    print(json.dumps(report, indent=2))

if __name__ == '__main__': main()
