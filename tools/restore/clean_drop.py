#!/usr/bin/env python3
"""Drop-folder cleaner: put photos in, get cleaned photos and a proof sheet out.

  python3 clean_drop.py <folder>

Everything in <folder> is cleaned into <folder>/cleaned, and a before/after sheet
is written to <folder>/cleaned/results.html. Originals are never modified.

MARKING. To point the tool at specific damage, open a photo in Preview (or any
editor), scribble over the damage in RED, and save a copy next to the original
named "<same name> marks.<ext>" - for example "Album 1 047 marks.png". Then:

  RED   - clean hard here. Inside a red mark the tool drops to a much lower
          threshold, so faint marks it would normally leave are taken.
  GREEN - never touch. Nothing inside a green mark is altered, at any setting.

The marks image only needs to be the same picture at any size; it is scaled to
fit. Scribbles do not need to be accurate - they are search regions, and inside
one only pixels that actually stand out from the surrounding film are rebuilt,
so a generous scribble over clean film changes nothing.
"""
import glob
import os
import sys

import numpy as np
import cv2

import despeckle
import engine
import dark_field
import calm_field
import stark_marks

SUFFIX = " marks"


def load_marks(path, shape):
    """Return (red, green) masks from a marked-up copy, or (None, None)."""
    stem, ext = os.path.splitext(path)
    for cand in (f"{stem}{SUFFIX}.png", f"{stem}{SUFFIX}.jpg", f"{stem}{SUFFIX}.jpeg",
                 f"{stem}{SUFFIX}.PNG", f"{stem}{SUFFIX}.JPG"):
        if os.path.exists(cand):
            m = cv2.imread(cand, cv2.IMREAD_COLOR)
            if m is None:
                continue
            if m.shape[:2] != shape:
                m = cv2.resize(m, (shape[1], shape[0]), interpolation=cv2.INTER_NEAREST)
            b, g, r = cv2.split(m.astype(np.int16))
            red = ((r > 110) & (r - g > 55) & (r - b > 55)).astype(np.uint8) * 255
            green = ((g > 110) & (g - r > 55) & (g - b > 55)).astype(np.uint8) * 255
            k = np.ones((9, 9), np.uint8)
            return cv2.dilate(red, k), cv2.dilate(green, k)
    return None, None


def marked_pass(cur8, red, sigma):
    """Inside a red scribble, take anything clearly above the local film."""
    g8 = cv2.cvtColor(cur8, cv2.COLOR_BGR2GRAY)
    med = cv2.medianBlur(g8, 21).astype(np.float32)
    rise = g8.astype(np.float32) - med
    bar = max(10.0, 2.0 * sigma)
    m = (((rise > bar) | (rise < -bar - 4)) & (red > 0)).astype(np.uint8)
    m = despeckle.size_filter(m * 255, 3, 4000)
    return cv2.dilate(m, np.ones((3, 3), np.uint8))


def apply(dst, cur, dtype, cur8, mask):
    rep8 = engine.repair(cur8, mask)
    out8 = cur8.copy(); out8[mask > 0] = rep8[mask > 0]
    if dtype == np.uint16:
        d = out8.astype(np.float32) - cur8.astype(np.float32)
        out = np.clip(cur.astype(np.float32) + d * 257.0, 0, 65535).astype(np.uint16)
        out[mask == 0] = cur[mask == 0]
    else:
        out = cur.copy(); out[mask > 0] = out8[mask > 0]
    cv2.imwrite(dst, out)
    return out


def process(path, outdir):
    base = os.path.splitext(os.path.basename(path))[0]
    if base.endswith(SUFFIX):
        return None
    img, dtype = despeckle.load(path)
    if img is None:
        print(f"  {base}: unreadable, skipped"); return None
    img8 = despeckle.to8(img)
    red, green = load_marks(path, img8.shape[:2])

    out8, mask, pct, _ = engine.clean(img8, protect=green, budget=3.0)
    if out8 is None:
        out8, mask = img8.copy(), np.zeros(img8.shape[:2], np.uint8)

    ext = ".tif" if dtype == np.uint16 else ".png"
    dst = os.path.join(outdir, base + "_clean" + ext)
    os.makedirs(outdir, exist_ok=True)
    if dtype == np.uint16:
        d = out8.astype(np.float32) - img8.astype(np.float32)
        out = np.clip(img.astype(np.float32) + d * 257.0, 0, 65535).astype(np.uint16)
        out[mask == 0] = img[mask == 0]
    else:
        out = img.copy(); out[mask > 0] = out8[mask > 0]
    cv2.imwrite(dst, out)

    # the automatic debris passes. They must be pointed at THIS folder - they
    # default to the project's own batch folder, and left unset they silently
    # cleaned the wrong pictures.
    folder = os.path.dirname(os.path.abspath(path))
    for mod in (dark_field, calm_field, stark_marks):
        mod.set_paths(folder, outdir)
    for fn, label in ((dark_field.process, "debris"), (calm_field.process, "specks"),
                      (stark_marks.process, "stark")):
        try:
            fn(base)
        except Exception as e:                      # one pass failing must not lose the file
            print(f"  {base}: {label} pass skipped ({e})")

    cur, dtype2 = despeckle.load(dst)
    cur8 = despeckle.to8(cur)
    if green is not None:
        og = img if dtype == np.uint16 else img
        cur[green > 0] = og[green > 0]              # honour protect absolutely
        cv2.imwrite(dst, cur)
        cur8 = despeckle.to8(cur)
    if red is not None and red.any():
        sigma = float(engine.local_grain(cv2.cvtColor(cur8, cv2.COLOR_BGR2GRAY), win=201).mean())
        mm = marked_pass(cur8, red, sigma)
        if green is not None:
            mm[green > 0] = 0
        if mm.any():
            cur = apply(dst, cur, dtype2, cur8, mm)
            print(f"  {base}: marked areas cleaned ({100*(mm>0).mean():.3f}% of frame)")

    fin, _ = despeckle.load(dst)
    a = cv2.cvtColor(despeckle.to8(img), cv2.COLOR_BGR2GRAY)
    b = cv2.cvtColor(despeckle.to8(fin), cv2.COLOR_BGR2GRAY)
    changed = 100.0 * (cv2.absdiff(a, b) > 2).mean()
    print(f"  {base}: {changed:.2f}% repaired" + ("  [marked]" if red is not None else ""), flush=True)
    return base


if __name__ == "__main__":
    folder = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else ".")
    outdir = os.path.join(folder, "cleaned")
    files = sorted(sum([glob.glob(os.path.join(folder, e)) for e in
                        ("*.tif", "*.tiff", "*.TIF", "*.jpg", "*.jpeg", "*.JPG", "*.png")], []))
    files = [f for f in files if not os.path.splitext(os.path.basename(f))[0].endswith(SUFFIX)]
    print(f"Cleaning {len(files)} photo(s) from {folder}\n")
    for f in files:
        process(f, outdir)
    os.system(f'python3 "{os.path.join(os.path.dirname(os.path.abspath(__file__)), "make_sheet.py")}" '
              f'"{folder}" "{outdir}"')
    print(f"\nDone. Cleaned files and results.html are in:\n  {outdir}")
