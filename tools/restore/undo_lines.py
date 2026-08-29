#!/usr/bin/env python3
"""Restore repairs that sit on LONG CONTINUOUS bright structures.

Allowing elongated shapes is what finally cleared the client's circled fibres,
and it is also what let the passes cut into thin bright things that belong to
the photograph: a monument's sunlit corner clipped into segments, filaments in
Kamala Nagar 002 erased end to end.

Length alone cannot separate them, because a long structure gets cut into short
pieces that each pass a length limit. What separates them is CONTINUATION: a
scratch or fibre ends, while a monument edge or a wire keeps going. So the
original is opened with long line elements at several angles - an operation only
genuinely extended structures survive - and any repair touching one is undone.
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
LINE_LEN = 65          # only a genuinely extended structure survives this
ANGLES = (0, 30, 60, 90, 120, 150)


def long_structures(g8, sigma):
    f = g8.astype(np.float32)
    rise = f - cv2.medianBlur(g8, 31).astype(np.float32)
    bright = (rise > max(10.0, 1.6 * sigma)).astype(np.uint8)
    acc = np.zeros_like(bright)
    for a in ANGLES:
        se = cv2.getStructuringElement(cv2.MORPH_RECT, (LINE_LEN, 1))
        if a:
            M = cv2.getRotationMatrix2D((LINE_LEN / 2, 0.5), a, 1.0)
            se = cv2.warpAffine(se, M, (LINE_LEN, LINE_LEN), flags=cv2.INTER_NEAREST)
        if se.sum() == 0:
            continue
        acc |= cv2.morphologyEx(bright, cv2.MORPH_OPEN, se)
    # a tight collar only. A generous one reached beyond the structure and
    # swallowed nearby speck repairs that had nothing to do with it.
    return cv2.dilate(acc, np.ones((3, 3), np.uint8))


def restore(name):
    src = next((f"{IN}/{name}{e}" for e in (".tif", ".jpg") if os.path.exists(f"{IN}/{name}{e}")), None)
    dst = next((f"{OUT}/{name}_clean{e}" for e in (".tif", ".png") if os.path.exists(f"{OUT}/{name}_clean{e}")), None)
    o, dtype = despeckle.load(src)
    c, _ = despeckle.load(dst)
    o8 = despeckle.to8(o)
    og = cv2.cvtColor(o8, cv2.COLOR_BGR2GRAY).astype(np.float32)
    cg = cv2.cvtColor(despeckle.to8(c), cv2.COLOR_BGR2GRAY).astype(np.float32)
    changed = (np.abs(og - cg) > 2).astype(np.uint8)
    if not changed.any():
        print(f"{name}: no repairs"); return
    before = 100.0 * changed.mean()

    sigma = float(engine.local_grain(cv2.cvtColor(o8, cv2.COLOR_BGR2GRAY), win=201).mean())
    lines = long_structures(cv2.cvtColor(o8, cv2.COLOR_BGR2GRAY), sigma)

    # Restore only the pixels that actually sit ON a continuous structure.
    # Judging whole connected components was the bug: dust clusters merge into
    # sprawling components, so one pixel brushing a line undid thousands of
    # legitimate repairs - it put the client's circled dash-trails straight back.
    undo = (lines > 0) & (changed > 0)
    if not undo.any():
        print(f"{name:28s} {before:6.2f}% -> {before:6.2f}% (no repairs on long structures)"); return

    out = c.copy()
    out[undo] = o[undo]
    cv2.imwrite(dst, out)
    ng = cv2.cvtColor(despeckle.to8(out), cv2.COLOR_BGR2GRAY).astype(np.float32)
    after = 100.0 * (np.abs(og - ng) > 2).mean()
    print(f"{name:28s} {before:6.2f}% -> {after:6.2f}% | restored "
          f"{100*undo.mean():.3f}% of frame sitting on continuous structure", flush=True)


if __name__ == "__main__":
    only = sys.argv[1] if len(sys.argv) > 1 else None
    for p in sorted(glob.glob(f"{OUT}/*_clean.*")):
        nm = os.path.basename(p).split("_clean")[0]
        if only and only not in nm:
            continue
        restore(nm)
