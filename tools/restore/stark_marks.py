#!/usr/bin/env python3
"""Stark bright marks on dark ground, regardless of how busy the ground is.

Everything else in this pipeline refuses to work on textured ground, because
there a bright dot is usually a highlight on hair or a leaf. That refusal is why
the emulsion streaks lying across the beard survived every pass - the beard is
texture, so nothing would touch it.

Amplitude is what separates them there, and the gap is wide. Measured on the
beard the client circled: hair highlights sit ~23 grey levels above the local
median (85th percentile of the whole region), while the streaks sit at ~100.
A bar at 75 sits in empty space between the two populations, so it takes the
damage and leaves the hair - which no shape or texture test could do here.

Because this is the one pass that works on people and texture, it is kept
deliberately narrow: high amplitude, small objects, and dark ground only.
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

MIN_RISE = 75          # grey levels above local median; hair highlights sit near 23
DARK_MAX = 130         # only on dark ground, where the picture cannot be this bright
MAX_AREA = 900
MAX_LEN = 80


def build_mask(g8):
    f = g8.astype(np.float32)
    med = cv2.medianBlur(g8, 21).astype(np.float32)
    cand = ((f - med > MIN_RISE) & (med < DARK_MAX)).astype(np.uint8)
    if not cand.any():
        return cand
    lab, n = ndi.label(cand, structure=np.ones((3, 3)))
    area = np.bincount(lab.ravel(), minlength=n + 1)
    keep = np.zeros(n + 1, bool)
    for i, sl in enumerate(ndi.find_objects(lab), 1):
        if sl is None:
            continue
        hh = sl[0].stop - sl[0].start
        ww = sl[1].stop - sl[1].start
        keep[i] = 3 <= area[i] <= MAX_AREA and max(hh, ww) <= MAX_LEN
    return cv2.dilate(keep[lab].astype(np.uint8), np.ones((3, 3), np.uint8)) * 255


def process(name):
    dst = next((f"{OUT}/{name}_clean{e}" for e in (".tif", ".png") if os.path.exists(f"{OUT}/{name}_clean{e}")), None)
    cur, dtype = despeckle.load(dst)
    cur8 = despeckle.to8(cur)
    mask = build_mask(cv2.cvtColor(cur8, cv2.COLOR_BGR2GRAY))
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
    print(f"{name:28s} {ndi.label(mask>0)[1]:5d} stark marks | +{100*(mask>0).mean():6.3f}% | "
          f"outside identical: {np.array_equal(out[mask==0], cur[mask==0])}", flush=True)


if __name__ == "__main__":
    only = sys.argv[1] if len(sys.argv) > 1 else None
    for p in sorted(glob.glob(f"{OUT}/*_clean.*")):
        nm = os.path.basename(p).split("_clean")[0]
        if only and only not in nm:
            continue
        process(nm)
