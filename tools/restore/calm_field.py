#!/usr/bin/env python3
"""Debris on CALM ground of any brightness - the gap the dark-field pass left.

The dark-field pass only looked at dark ground, on the reasoning that a bright
streak there has nothing it could legitimately be. That reasoning was about
EMPTINESS, not darkness, and restricting it to dark ground left the client
circling dust specks in TOG 017's bright sky and in the mid-tone crowd of
Bombay 45 - both plainly damage, both invisible to a dark-only rule.

So the gate is calmness, measured against the frame's own grain, at any
brightness. Two extra guards make that safe where darkness previously stood in:

  - HARD EDGES. A specular highlight is a soft dome whose peak survives a blur;
    a speck is hard-edged and collapses. Reviewers measured real highlights at
    0.85-0.93 on this ratio, so anything that soft is refused. This is what
    stops the pass erasing a highlight on skin, water or a lit leaf.
  - The candidates are excluded when measuring calmness, so a dense field of
    debris cannot make its own neighbourhood look textured and hide inside it.
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


def set_paths(src, dst):
    """Point this pass at a different folder pair (the drop tool needs this)."""
    global IN, OUT
    IN, OUT = src, dst

MIN_RISE = 16          # grey levels above local median
RISE_SIGMA = 2.3       # ...or this multiple of the film's grain, whichever is larger
CALM_MULT = 1.15       # surroundings must be this calm, in units of grain
MAX_AREA = 500
MAX_LEN = 60
SOFT_MAX = 0.70        # blurred-peak / raw-peak; above this it is a soft dome, i.e. content


def build_mask(g8, sigma):
    f = g8.astype(np.float32)
    med = cv2.medianBlur(g8, 21).astype(np.float32)
    rise = f - med
    bar = max(MIN_RISE, RISE_SIGMA * sigma)
    cand = (rise > bar).astype(np.uint8)
    if not cand.any():
        return np.zeros_like(cand)

    hp = np.abs(f - cv2.GaussianBlur(f, (0, 0), 1.5))
    hp[cand > 0] = 0
    w = np.ones_like(hp); w[cand > 0] = 0
    busy = cv2.boxFilter(hp, -1, (31, 31)) / np.maximum(cv2.boxFilter(w, -1, (31, 31)), 1e-6)
    cand[busy > CALM_MULT * sigma] = 0
    if not cand.any():
        return cand

    blur = cv2.GaussianBlur(f, (0, 0), 2.5)
    lab, n = ndi.label(cand, structure=np.ones((3, 3)))
    if n == 0:
        return cand
    area = np.bincount(lab.ravel(), minlength=n + 1)
    keep = np.zeros(n + 1, bool)
    for i, sl in enumerate(ndi.find_objects(lab), 1):
        if sl is None:
            continue
        hh = sl[0].stop - sl[0].start
        ww = sl[1].stop - sl[1].start
        a = int(area[i])
        if a < 3 or a > MAX_AREA or max(hh, ww) > MAX_LEN:
            continue
        comp = lab[sl] == i
        bg = float(np.median(med[sl][comp]))
        peak = float(f[sl][comp].max())
        if peak - bg < 1e-6:
            continue
        if (float(blur[sl][comp].max()) - bg) / (peak - bg) > SOFT_MAX:
            continue                       # soft dome: a highlight, not damage
        keep[i] = True
    return cv2.dilate(keep[lab].astype(np.uint8), np.ones((3, 3), np.uint8)) * 255


def process(name):
    src = next((f"{IN}/{name}{e}" for e in (".tif", ".jpg") if os.path.exists(f"{IN}/{name}{e}")), None)
    dst = next((f"{OUT}/{name}_clean{e}" for e in (".tif", ".png") if os.path.exists(f"{OUT}/{name}_clean{e}")), None)
    cur, dtype = despeckle.load(dst)
    cur8 = despeckle.to8(cur)
    g8 = cv2.cvtColor(cur8, cv2.COLOR_BGR2GRAY)
    sigma = float(engine.local_grain(g8, win=201).mean())
    mask = build_mask(g8, sigma)
    if not mask.any():
        print(f"{name}: nothing found"); return
    saved = engine.BIG_DEFECT_PX
    engine.BIG_DEFECT_PX = 10 ** 9
    try:
        rep8 = engine.repair(cur8, mask)
    finally:
        engine.BIG_DEFECT_PX = saved
    out8 = cur8.copy(); out8[mask > 0] = rep8[mask > 0]
    if dtype == np.uint16:
        d = out8.astype(np.float32) - cur8.astype(np.float32)
        out = np.clip(cur.astype(np.float32) + d * 257.0, 0, 65535).astype(np.uint16)
        out[mask == 0] = cur[mask == 0]
    else:
        out = cur.copy(); out[mask > 0] = out8[mask > 0]
    cv2.imwrite(dst, out)
    print(f"{name:28s} {ndi.label(mask>0)[1]:6d} specks | +{100*(mask>0).mean():6.3f}% | "
          f"outside identical: {np.array_equal(out[mask==0], cur[mask==0])}", flush=True)


if __name__ == "__main__":
    only = sys.argv[1] if len(sys.argv) > 1 else None
    for p in sorted(glob.glob(f"{OUT}/*_clean.*")):
        nm = os.path.basename(p).split("_clean")[0]
        if only and only not in nm:
            continue
        process(nm)
