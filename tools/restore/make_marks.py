#!/usr/bin/env python3
"""Hand-marked region repair: the sanctioned red-scribble workflow, scripted.

A human (or Claude, with the result going to the uncle for approval) names
BANDS - tight rectangles around damage identified at 100% zoom. Inside each
band, pixels brighter than the band's own median trace the white marks; LaMa
fills them from the surrounding film; matched grain goes back on top.
Judgement lives in the band list; the code only traces what was pointed at.

Usage: python3 make_marks.py  (bands are per-frame tables in this file)
"""
import os
import sys

import numpy as np
import cv2
from scipy import ndimage as ndi

import despeckle
import engine

IN = os.path.expanduser("~/Downloads/Nimish-2a")
OUT = os.path.join(IN, "cleaned_engine")

# (y0, y1, x0, x1) native pixels; delta = how far above the band median a pixel
# must be to count as the mark being traced
FRAMES = {
    "Bombay, Cross Maidan (55).jpg": dict(delta=24, bands=[
        (425, 448, 497, 568), (425, 448, 606, 648), (470, 498, 772, 878),
        (468, 486, 688, 706), (662, 688, 606, 762), (662, 682, 850, 872),
        (660, 688, 940, 1005), (688, 712, 616, 704), (712, 734, 636, 776),
        (744, 778, 478, 545), (744, 778, 682, 835), (783, 803, 695, 785),
        (798, 822, 478, 645), (826, 852, 476, 706), (853, 882, 490, 626),
        (898, 928, 476, 585), (936, 962, 476, 566),
        (448, 498, 772, 915), (668, 695, 850, 1015), (800, 845, 700, 1015),
        (30, 130, 995, 1460), (425, 478, 1350, 1440),
        (612, 652, 640, 700), (652, 702, 612, 790), (612, 706, 792, 892),
        # NOTE: a blanket band over the dark background here was REVERTED - on a
        # scan with grain sigma 17 the bright-on-dark rule caught grain peaks and
        # softened the film (sigma 17.6 -> 15.4). Bands over open background must
        # stay tight around confirmed damage.
    ]),
    # B45: white scratch and specks on the dark unexposed film margin (left
    # edge as scanned). No photograph content lives there.
    "Bombay, Cross Maidan (45).jpg": dict(delta=20, bands=[
        (0, 780, 0, 88),
    ]),
    # KN001: the elbow squiggle and discrete white marks on the forearm the
    # dust pass's guards would not touch. The broad SOFT pale patches on the
    # skin are left - they are indistinguishable from lighting, uncle's call.
    "Kamala Nagar, Jabalpur 001.tif": dict(delta=14, bands=[
        (1805, 1862, 3015, 3110), (1782, 1808, 3095, 3205),
        (1826, 1876, 3145, 3265), (1468, 1495, 2810, 2870),
        (2072, 2102, 3070, 3098),
        (1750, 2060, 2680, 3320),
    ]),
    # A102: sharp white flecks and scratch lines on the soft dark hair mass.
    # The lit hair wisps are diffuse (they ARE the local median) so the trace
    # cannot touch them; bands stop well short of the brow, eye and cheek.
    "Album 1 102.tif": dict(delta=20, bands=[
        (150, 420, 540, 1900), (420, 1300, 540, 1880),
        (1300, 1650, 540, 1800), (1650, 1950, 540, 1400),
        (1950, 2250, 540, 1150),
    ]),
}


def band_mask(g8, bands, delta, compact_only=False):
    """Trace against the LOCAL median, never the band's: a band that spans dark
    beard and bright skin has a low overall median, and a global rule floods the
    whole bright side (measured: it waxed a fingertip)."""
    m = np.zeros_like(g8)
    for y0, y1, x0, x1 in bands:
        py0, px0 = max(0, y0 - 24), max(0, x0 - 24)
        ctx = g8[py0:y1 + 24, px0:x1 + 24]
        med = cv2.medianBlur(ctx, 25)
        d = ctx.astype(np.int16) - med.astype(np.int16)
        mm = (d > delta).astype(np.uint8)
        # white damage on near-black ground: absolute rule - nothing on dark
        # beard is legitimately this bright except exposed paper
        mm |= ((ctx > 150) & (med < 105)).astype(np.uint8)
        # a traced dash is SMALL and SHORT; the bright side of a hard edge
        # (fingertip against beard) also clears a local median, but floods as
        # one big tall component - size-guard it out (it waxed a fingertip)
        lab, n = ndi.label(mm)
        if n:
            area = np.bincount(lab.ravel(), minlength=n + 1)
            ok = np.zeros(n + 1, bool)
            for i, sl in enumerate(ndi.find_objects(lab), 1):
                if sl is None:
                    continue
                hh = sl[0].stop - sl[0].start
                ww = sl[1].stop - sl[1].start
                ok[i] = area[i] <= 500 and hh <= 22
                if ok[i] and compact_only:
                    # On a beard or hair mass a lit strand is long, thin and
                    # wispy; a damage fleck is a compact blob. Requiring
                    # compactness is what lets the specks go without the hair
                    # going with them.
                    aspect = max(hh, ww) / max(1, min(hh, ww))
                    fill = area[i] / float(max(1, hh * ww))
                    ok[i] = aspect <= 2.6 and fill >= 0.45 and max(hh, ww) <= 26
            mm = ok[lab].astype(np.uint8)
        m[y0:y1, x0:x1] = mm[y0 - py0:y1 - py0, x0 - px0:x1 - px0]
    m = cv2.dilate(m, np.ones((3, 3), np.uint8))
    return m * 255


def repair_lama(img8, mask):
    """LaMa for every marked component - these are hand marks, context fill is
    the point (matches region_repair.py's behaviour)."""
    saved = engine.BIG_DEFECT_PX
    engine.BIG_DEFECT_PX = 12          # force LaMa on all but the tiniest bits
    try:
        return engine.repair(img8, mask)
    finally:
        engine.BIG_DEFECT_PX = saved


def process(fname, spec):
    base = os.path.splitext(fname)[0]
    src = os.path.join(IN, fname)
    img, dtype = despeckle.load(src)
    img8 = despeckle.to8(img)
    g8 = cv2.cvtColor(img8, cv2.COLOR_BGR2GRAY)
    mask = band_mask(g8, spec["bands"], spec["delta"], spec.get("compact_only", False))
    # zones where damage and living detail coincide - left for the uncle's own
    # hand pass rather than risked (when in doubt, leave the damage)
    for y0, y1, x0, x1 in spec.get("exclude", []):
        mask[y0:y1, x0:x1] = 0
    pct = 100.0 * (mask > 0).mean()

    ext = ".tif" if dtype == np.uint16 else ".png"
    clean_path = os.path.join(OUT, base + "_clean" + ext)
    cur, cur_dtype = despeckle.load(clean_path)     # dust pass already applied
    cur8 = despeckle.to8(cur)
    rep8 = repair_lama(cur8, mask)
    out8 = cur8.copy()
    out8[mask > 0] = rep8[mask > 0]

    if cur_dtype == np.uint16:
        delta = out8.astype(np.float32) - cur8.astype(np.float32)
        out = np.clip(cur.astype(np.float32) + delta * 257.0, 0, 65535).astype(np.uint16)
        out[mask == 0] = cur[mask == 0]
        cv2.imwrite(clean_path, out)
    else:
        out = cur.copy()
        out[mask > 0] = out8[mask > 0]
        cv2.imwrite(clean_path, out)
    ok = np.array_equal(out[mask == 0], cur[mask == 0])
    print(f"{base}: hand-marked {pct:.3f}% across {len(spec['bands'])} bands | "
          f"outside marks identical: {ok}")


if __name__ == "__main__":
    only = sys.argv[1] if len(sys.argv) > 1 else None
    for fname, spec in FRAMES.items():
        if only and only not in fname:
            continue
        process(fname, spec)
