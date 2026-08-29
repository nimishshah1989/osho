#!/usr/bin/env python3
"""Apply the 100%-zoom damage survey as repair bands.

Each surveyed box is a SEARCH REGION, not a repair: inside it, only pixels that
actually stand out from their own local surroundings are rebuilt. A box placed on
clean film therefore changes nothing, which is what makes a large surveyed list
safe to apply in bulk.

Three guards earn their place here:
  - on a person, only COMPACT blobs are taken, so a lit beard or hair strand
    (long, thin, wispy) survives while a round fleck goes;
  - a box whose trace lights up more than a quarter of its own area is REFUSED,
    because real damage is sparse inside its box and a flood means the box
    landed on content (white cloth, a highlight);
  - dark specks are traced the other way round, below the local median.
"""
import json
import os
import sys

import numpy as np
import cv2
from scipy import ndimage as ndi

import despeckle
import engine

IN = os.path.expanduser("~/Downloads/Nimish-2a")
OUT = os.path.join(IN, "cleaned_engine")
SURVEY = ("/private/tmp/claude-501/-Users-nimishshah-Downloads-kit/"
          "b4307189-b61c-4715-8519-8610cf9f01e3/scratchpad/survey.json")
DELTA = 15
# Rebuilt after adversarial review found 33 serious defects at the previous
# settings: rectangular grain-stripped blocks, erased nose and leaf highlights,
# beard hair stripped in bands, water sparkle wiped out. Every limit below is a
# direct consequence of one of those failures.
MAX_BOX = 170          # was 900: big boxes let the trace carve visible blocks
FLOOD_FRAC = 0.06      # was 0.25: damage is SPARSE inside its box
MAX_COMP_AREA = 120    # was 900: a 25px-wide nose highlight is not dust
MAX_COMP_DIM = 16      # was 60
MIN_SIGMA = 3.0        # the blob must clear the film's own grain by this much


def trace_box(g8, box, dark, compact, sigma):
    y0, y1, x0, x1 = box
    h, w = g8.shape
    y0, x0 = max(0, y0), max(0, x0)
    y1, x1 = min(h, y1), min(w, x1)
    if y1 - y0 < 3 or x1 - x0 < 3:
        return None
    py0, px0 = max(0, y0 - 24), max(0, x0 - 24)
    py1, px1 = min(h, y1 + 24), min(w, x1 + 24)
    ctx = g8[py0:py1, px0:px1]
    med = cv2.medianBlur(ctx, 25)
    d = med.astype(np.int16) - ctx.astype(np.int16) if dark else ctx.astype(np.int16) - med.astype(np.int16)
    mm = (d > max(DELTA, MIN_SIGMA * sigma)).astype(np.uint8)
    if not dark:
        mm |= ((ctx > 150) & (med < 105)).astype(np.uint8)

    lab, n = ndi.label(mm)
    if n:
        area = np.bincount(lab.ravel(), minlength=n + 1)
        ok = np.zeros(n + 1, bool)
        for i, sl in enumerate(ndi.find_objects(lab), 1):
            if sl is None:
                continue
            hh = sl[0].stop - sl[0].start
            ww = sl[1].stop - sl[1].start
            good = area[i] <= MAX_COMP_AREA and max(hh, ww) <= MAX_COMP_DIM
            if good and compact:
                aspect = max(hh, ww) / max(1, min(hh, ww))
                fill = area[i] / float(max(1, hh * ww))
                good = aspect <= 2.6 and fill >= 0.45 and max(hh, ww) <= 26
            ok[i] = good
        mm = ok[lab].astype(np.uint8)

    sub = mm[y0 - py0:y1 - py0, x0 - px0:x1 - px0]
    if sub.mean() > FLOOD_FRAC:            # box landed on content, not damage
        return None
    full = np.zeros((h, w), np.uint8)
    full[y0:y1, x0:x1] = sub
    return full


def process(name, boxes):
    src = next((f"{IN}/{name}{e}" for e in (".tif", ".jpg") if os.path.exists(f"{IN}/{name}{e}")), None)
    dst = next((f"{OUT}/{name}_clean{e}" for e in (".tif", ".png", ".jpg")
                if os.path.exists(f"{OUT}/{name}_clean{e}")), None)
    if not src or not dst:
        print(f"{name}: missing files"); return
    cur, dtype = despeckle.load(dst)
    cur8 = despeckle.to8(cur)
    g8 = cv2.cvtColor(cur8, cv2.COLOR_BGR2GRAY)
    sigma = float(engine.local_grain(g8, win=201).mean())

    mask = np.zeros(g8.shape, np.uint8)
    used = refused = 0
    for b in boxes:
        if not b.get("certain"):
            continue
        box = (int(b["y0"]), int(b["y1"]), int(b["x0"]), int(b["x1"]))
        if (box[1] - box[0]) > MAX_BOX or (box[3] - box[2]) > MAX_BOX:
            refused += 1; continue
        m = trace_box(g8, box, b["kind"] == "dark_speck", bool(b.get("on_subject")), sigma)
        if m is None:
            refused += 1; continue
        mask |= m
        used += 1
    mask = cv2.dilate(mask, np.ones((3, 3), np.uint8)) * 255
    pct = 100.0 * (mask > 0).mean()
    if not mask.any():
        print(f"{name}: nothing to repair"); return

    # LaMa is disabled for surveyed repairs: on merged masks it repainted whole
    # blocks of canopy and wall. Only the local median fills these now, which is
    # correct for dust-sized holes and cannot invent structure.
    saved = engine.BIG_DEFECT_PX
    engine.BIG_DEFECT_PX = 10 ** 9
    try:
        rep8 = engine.repair(cur8, mask)
    finally:
        engine.BIG_DEFECT_PX = saved
    out8 = cur8.copy(); out8[mask > 0] = rep8[mask > 0]

    if dtype == np.uint16:
        delta = out8.astype(np.float32) - cur8.astype(np.float32)
        out = np.clip(cur.astype(np.float32) + delta * 257.0, 0, 65535).astype(np.uint16)
        out[mask == 0] = cur[mask == 0]
    else:
        out = cur.copy()
        out[mask > 0] = out8[mask > 0]
    cv2.imwrite(dst, out)
    ok = np.array_equal(out[mask == 0], cur[mask == 0])
    print(f"{name:28s} boxes {used:3d} used / {refused:3d} refused | +{pct:5.3f}% repaired | "
          f"outside identical: {ok}", flush=True)


if __name__ == "__main__":
    survey = json.load(open(SURVEY))
    only = sys.argv[1] if len(sys.argv) > 1 else None
    for name, boxes in survey.items():
        if only and only not in name:
            continue
        process(name, boxes)
