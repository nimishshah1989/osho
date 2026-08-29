#!/usr/bin/env python3
"""Restore repairs that removed SOFT-EDGED content rather than dust.

Two adversarial review rounds independently found the same failure: soft,
grain-bearing, mid-brightness features - a specular highlight on a nose, sunlit
leaf highlights, a lit stem - were being removed as though they were dust. The
physics that separates them is edge sharpness, and it is measurable:

    softness = (peak_after_blur - background) / (peak - background)

A dust speck is 2-5px and hard-edged, so blurring collapses its peak and the
ratio is low. A specular highlight is a soft dome 15-30px wide whose peak barely
moves under the same blur, so the ratio is high. Reviewers measured real content
at 0.85-0.93 and dust well below that.

Because every pixel outside a repair is bit-identical to the original, a repair
can be undone exactly by copying those pixels back. Nothing is approximated.
"""
import os
import sys

import numpy as np
import cv2
from scipy import ndimage as ndi

import despeckle

IN = os.path.expanduser("~/Downloads/Nimish-2a")
OUT = os.path.join(IN, "cleaned_engine")
SOFT_MAX = 0.72        # above this the feature is a soft dome, i.e. content
BLUR = 2.5


def restore(name):
    src = next((f"{IN}/{name}{e}" for e in (".tif", ".jpg") if os.path.exists(f"{IN}/{name}{e}")), None)
    dst = next((f"{OUT}/{name}_clean{e}" for e in (".tif", ".png") if os.path.exists(f"{OUT}/{name}_clean{e}")), None)
    if not src or not dst:
        print(f"{name}: missing"); return
    o, dtype = despeckle.load(src)
    c, _ = despeckle.load(dst)
    o8, c8 = despeckle.to8(o), despeckle.to8(c)
    og = cv2.cvtColor(o8, cv2.COLOR_BGR2GRAY).astype(np.float32)
    cg = cv2.cvtColor(c8, cv2.COLOR_BGR2GRAY).astype(np.float32)

    changed = (np.abs(og - cg) > 2).astype(np.uint8)
    if not changed.any():
        print(f"{name}: no repairs"); return
    lab, n = ndi.label(cv2.dilate(changed, np.ones((3, 3), np.uint8)))
    blur = cv2.GaussianBlur(og, (0, 0), BLUR)

    undo = np.zeros(changed.shape, bool)
    soft = 0
    objs = ndi.find_objects(lab)
    for i, sl in enumerate(objs, 1):
        if sl is None:
            continue
        y0 = max(0, sl[0].start - 12); y1 = min(og.shape[0], sl[0].stop + 12)
        x0 = max(0, sl[1].start - 12); x1 = min(og.shape[1], sl[1].stop + 12)
        comp = (lab[y0:y1, x0:x1] == i)
        if comp.sum() < 4:
            continue
        ring = (~cv2.dilate(comp.astype(np.uint8), np.ones((9, 9), np.uint8)).astype(bool)) & \
               cv2.dilate(comp.astype(np.uint8), np.ones((21, 21), np.uint8)).astype(bool)
        sub_o = og[y0:y1, x0:x1]; sub_b = blur[y0:y1, x0:x1]
        if ring.sum() < 12:
            continue
        bg = float(np.median(sub_o[ring]))
        peak = float(sub_o[comp].max()); bpeak = float(sub_b[comp].max())
        dark = float(sub_o[comp].min()) < bg - 6 and peak < bg + 6
        if dark:
            continue                              # dark specks: leave repaired
        if peak - bg < 1e-6:
            continue
        softness = (bpeak - bg) / (peak - bg)
        if softness > SOFT_MAX:
            undo |= (lab == i) & (changed > 0)
            soft += 1

    if not undo.any():
        print(f"{name:28s} {n:5d} repairs, none soft-edged"); return
    out = c.copy()
    out[undo] = o[undo]                            # exact restoration, not a re-repair
    cv2.imwrite(dst, out)
    print(f"{name:28s} {n:5d} repairs | restored {soft} soft-edged "
          f"({100*undo.mean():.4f}% of frame) | now {100*((np.abs(og-cv2.cvtColor(despeckle.to8(out),cv2.COLOR_BGR2GRAY).astype(np.float32)))>2).mean():.3f}% corrected", flush=True)


if __name__ == "__main__":
    names = [os.path.basename(p).split("_clean")[0]
             for p in sorted(__import__("glob").glob(f"{OUT}/*_clean.*"))]
    only = sys.argv[1] if len(sys.argv) > 1 else None
    for nm in names:
        if only and only not in nm:
            continue
        restore(nm)
