# OMEGA Chess AI — Training Lab

Reproducible training and evaluation tools for OMEGA Chess AI.

## Scope and safety gates
- Original experimental HalfKP-style scalar evaluator; not Stockfish NNUE architecture or weights.
- Training creates research checkpoints only. It does not automatically replace the live browser model.
- Promote a model only after independent held-out evaluation improves.
- Exact top-move agreement is not the same as playing strength. Also measure centipawn regret, tactical failures, fixed-node strength and paired self-play Elo.

## Requirements
Python 3.11+ and NumPy:
```bash
python -m pip install -r requirements.txt
```

## Dataset format
JSONL or gzip JSONL. Each usable row contains `fen`, `teacherScoreBound: "exact"`, `teacherScoreCp`, and preferably `openingFamily` or `openingEco`. Mate and non-exact rows are excluded. Keep test sets frozen and avoid position/opening leakage.

## Train
```bash
python scripts/train-omega-nnue.py --data path/to/exact-labels.jsonl.gz --out artifacts/experiment --epochs 30 --hidden 32 --learning-rate 0.008 --seed 20261117
```
Outputs include a compressed NPZ checkpoint and JSON/Markdown reports with split and model hash.

## Export
```bash
python scripts/export-omega-nnue.py --model artifacts/experiment/omega-nnue-v1.npz --out artifacts/omega-nnue.bin
```

Never overwrite a production model while experimenting. Review every report and run independent engine benchmarks before promotion.

## Current measured baseline (historical)
OMEGA classic + PVS recorded 526/1,000 exact top-1 matches (52.6%) at depth 3 against Stockfish 19 Lite, without giving OMEGA the teacher's best move. A 20% NNUE/classical blend scored 51.2% on the same sample and was rejected. A later candidate scored 47/100 and was also rejected. These are research results, not a claim about the deployed website or a 90% achievement.

## Reproducibility checklist
Record dataset SHA-256, model SHA-256, seed, hyperparameters, split, exact benchmark command, node budget and raw results.

## Cloud background arena training
The `.github/workflows/omega-background-training.yml` workflow opens the deployed OMEGA website in a headless browser and starts or resumes the Stockfish training arena. It runs in bounded sessions and resumes from the single central Supabase match counter. The workflow is only a scheduler/controller: the engine, training logic and authoritative learning memory remain in the OMEGA website and central cloud. It does not copy or maintain a second engine implementation.

This scheduled arena process updates adaptive move-ordering memory. It does **not** retrain neural-network weights, and its results must not be described as an NNUE training run. The workflow uses anonymous access already enabled for OMEGA; no service-role key or additional user account is required. Disable the workflow in the GitHub Actions tab to stop scheduled sessions.
