#!/usr/bin/env python3
"""Export an OMEGA NNUE checkpoint to a compact little-endian browser binary."""
import argparse, pathlib, struct
import numpy as np
p=argparse.ArgumentParser(); p.add_argument('--model',default='training/omega-nnue-v2/omega-nnue-v2.npz'); p.add_argument('--out',default='public/omega-nnue-v2.bin'); a=p.parse_args()
with np.load(a.model,allow_pickle=False) as d:
 if str(d['architecture'].item())!='OMEGA-HalfKP-style-v1': raise SystemExit('Unsupported checkpoint architecture')
 e=d['embeddings'].astype('<f4'); b=d['accumulator_bias'].astype('<f4'); w=d['output_weights'].astype('<f4'); ob=np.asarray([d['output_bias']],dtype='<f4')
 if e.ndim!=2 or e.shape[0]!=40960 or b.shape!=(e.shape[1],) or w.shape!=(e.shape[1]*2,): raise SystemExit('Invalid checkpoint tensor dimensions')
out=pathlib.Path(a.out); out.parent.mkdir(parents=True,exist_ok=True); out.write_bytes(b'OMNN'+struct.pack('<III',1,e.shape[1],40960)+e.tobytes()+b.tobytes()+w.tobytes()+ob.tobytes()); print(f'Exported {out} ({out.stat().st_size} bytes)')
