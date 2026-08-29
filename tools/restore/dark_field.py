#!/usr/bin/env python3
"""Bright debris on DARK ground: the fibres, hairs and streaks the dust pass refuses.

The dust detector rejects anything elongated, because a grey beard hair and a
scratch are the same signal in general. But that generality is what has been
leaving surface fibres and scratch-streaks on the film - the client circled them
by hand, and every one sat on a dark background.

Restricting to dark ground is what makes taking elongated shapes safe. On a dark
field, a near-white streak has almost nothing it could legitimately be: the
picture there is dark by definition, so a bright thin object lying across it is
on the emulsion, not in the scene. The same rule applied to a lit area would eat
whiskers and highlights, so this pass simply never looks there.

Deliberately calibrated to the client's stated tolerance: remove most of the
debris and accept an occasional wrong call, rather than leave it all behind.
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

# Tightened after the first run took 23.6% of the Kamala Nagar negatives and
# cost them 7-9% of their frame-wide grain. A print's dark area is genuinely
# blank; a negative's is full of hair, beard and foliage. The calm test below is
# what tells those apart, and it is applied DURING detection - bolting it on
# afterwards did not catch the right components.
DARK_MAX = 100          # local median above this is not "dark ground"
MIN_RISE = 20           # grey levels above the local median
MAX_AREA = 600
MAX_LEN = 70            # a longer streak is likely scene structure
CALM_MULT = 1.15        # surrounding film must be this calm, in units of grain


def build_mask(g8, sigma):
    f = g8.astype(np.float32)
    med = cv2.medianBlur(g8, 21)
    rise = f - med.astype(np.float32)
    bar = max(MIN_RISE, 2.2 * sigma)
    cand = ((rise > bar) & (med < DARK_MAX)).astype(np.uint8)

    # calm-ground test: measure the film's busy-ness with the candidates
    # themselves excluded, so a dense field of debris cannot make its own
    # surroundings look textured and thereby shield itself
    hp = np.abs(f - cv2.GaussianBlur(f, (0, 0), 1.5))
    hp[cand > 0] = 0
    w = np.ones_like(hp); w[cand > 0] = 0
    busy = cv2.boxFilter(hp, -1, (31, 31)) / np.maximum(cv2.boxFilter(w, -1, (31, 31)), 1e-6)
    cand[busy > CALM_MULT * sigma] = 0

    lab, n = ndi.label(cand, structure=np.ones((3, 3)))
    if n == 0:
        return np.zeros_like(cand)
    area = np.bincount(lab.ravel(), minlength=n + 1)
    keep = np.zeros(n + 1, bool)
    for i, sl in enumerate(ndi.find_objects(lab), 1):
        if sl is None:
            continue
        hh = sl[0].stop - sl[0].start
        ww = sl[1].stop - sl[1].start
        a = int(area[i])
        if a < 4 or a > MAX_AREA or max(hh, ww) > MAX_LEN:
            continue
        # elongated is ALLOWED here - that is the whole point of this pass
        keep[i] = True
    m = keep[lab].astype(np.uint8)
    return cv2.dilate(m, np.ones((3, 3), np.uint8)) * 255


def process(name):
    src = next((f"{IN}/{name}{e}" for e in (".tif", ".jpg") if os.path.exists(f"{IN}/{name}{e}")), None)
    dst = next((f"{OUT}/{name}_clean{e}" for e in (".tif", ".png") if os.path.exists(f"{OUT}/{name}_clean{e}")), None)
    if not src or not dst:
        print(f"{name}: missing"); return
    cur, dtype = despeckle.load(dst)
    cur8 = despeckle.to8(cur)
    g8 = cv2.cvtColor(cur8, cv2.COLOR_BGR2GRAY)
    sigma = float(engine.local_grain(g8, win=201).mean())
    mask = build_mask(g8, sigma)
    pct = 100.0 * (mask > 0).mean()
    if not mask.any():
        print(f"{name}: nothing found"); return

    saved = engine.BIG_DEFECT_PX
    engine.BIG_DEFECT_PX = 10 ** 9          # median fill only; no invented structure
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
    n = ndi.label(mask > 0)[1]
    print(f"{name:28s} {n:6d} pieces of debris | +{pct:6.3f}% | "
          f"outside identical: {np.array_equal(out[mask == 0], cur[mask == 0])}", flush=True)


if __name__ == "__main__":
    only = sys.argv[1] if len(sys.argv) > 1 else None
    for p in sorted(glob.glob(f"{OUT}/*_clean.*")):
        nm = os.path.basename(p).split("_clean")[0]
        if only and only not in nm:
            continue
        process(nm)
