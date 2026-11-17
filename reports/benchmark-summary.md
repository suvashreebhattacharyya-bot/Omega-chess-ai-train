# OMEGA benchmark summary

- Test reference: Stockfish 19 Lite WASM, 100,000 nodes per position.
- OMEGA search: depth 3, no teacher best move supplied.
- Classic + PVS: 526/1,000 exact top-1 = 52.6%.
- 20% NNUE/classical blend: 512/1,000 exact top-1 = 51.2%.
- The hybrid was rejected; classic + PVS remains the better measured configuration.
- Both runs reported 100% legal moves.
- Exact top-1 agreement is not an Elo rating and should be supplemented with fixed-node regret and paired self-play.
