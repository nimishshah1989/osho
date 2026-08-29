#!/usr/bin/env python3
"""Restore repairs whose amplitude is only grain-level.

The calm-ground pass admitted anything rising 2.3 sigma above its surroundings.
Ordinary film grain clears 2.3 sigma about 1% of the time, which on a 29MP frame
is roughly 300,000 grain peaks mistaken for dust - enough to make smooth skin
read as mottled, because removing the bright half of the grain leaves the dark
half behind.

Real dust stands far clearer of the film than that. Raising the bar to 3.5 sigma
cuts the grain false-positive rate to about 0.02% while leaving genuine specks -
which sit many sigma out - untouched. Repairs below the new bar have their
original pixels copied back exactly.
"""
import glob
import os
import sys

import numpy as np
import cv2
from scipy import ndimage as ndi

import despeckle
import engine

IN = os.path.expanduser("~/Downloads/Nimish-2a")
OUT = os.path.join(IN, "cleaned_engine")
RISE_SIGMA = 3.5
MIN_RISE = 20


def restore(name):
    src = next((f"{IN}/{name}{e}" for e in (".tif", ".jpg") if os.path.exists(f"{IN}/{name}{e}")), None)
    dst = next((f"{OUT}/{name}_clean{e}" for e in (".tif", ".png") if os.path.exists(f"{OUT}/{name}_clean{e}")), None)
    o, dtype = despeckle.load(src)
    c, _ = despeckle.load(dst)
    o8, c8 = despeckle.to8(o), despeckle.to8(c)
    og = cv2.cvtColor(o8, cv2.COLOR_BGR2GRAY).astype(np.float32)
    cg = cv2.cvtColor(despeckle.to8(c), cv2.COLOR_BGR2GRAY).astype(np.float32)
    changed = (np.abs(og - cg) > 2).astype(np.uint8)
    if not changed.any():
        print(f"{name}: no repairs"); return
    before = 100.0 * changed.mean()

    sigma = float(engine.local_grain(cv2.cvtColor(o8, cv2.COLOR_BGR2GRAY), win=201).mean())
    bar = max(MIN_RISE, RISE_SIGMA * sigma)
    med = cv2.medianBlur(cv2.cvtColor(o8, cv2.COLOR_BGR2GRAY), 21).astype(np.float32)
    rise = og - med

    lab, n = ndi.label(cv2.dilate(changed, np.ones((3, 3), np.uint8)))
    if n == 0:
        return
    # a component is kept only if its PEAK rise clears the new bar
    peak = ndi.maximum(rise, lab, index=np.arange(1, n + 1))
    weak = np.zeros(n + 1, bool)
    weak[1:] = np.asarray(peak) < bar
    undo = weak[lab] & (changed > 0)
    if not undo.any():
        print(f"{name:28s} {before:6.2f}% -> {before:6.2f}% (all repairs clear {bar:.0f} levels)"); return

    out = c.copy()
    out[undo] = o[undo]
    cv2.imwrite(dst, out)
    ng = cv2.cvtColor(despeckle.to8(out), cv2.COLOR_BGR2GRAY).astype(np.float32)
    after = 100.0 * (np.abs(og - ng) > 2).mean()
    print(f"{name:28s} {before:6.2f}% -> {after:6.2f}% | restored {int(weak[1:].sum())} grain-level "
          f"repairs (bar {bar:.0f} levels)", flush=True)


if __name__ == "__main__":
    only = sys.argv[1] if len(sys.argv) > 1 else None
    for p in sorted(glob.glob(f"{OUT}/*_clean.*")):
        nm = os.path.basename(p).split("_clean")[0]
        if only and only not in nm:
            continue
        restore(nm)
