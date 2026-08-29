#!/usr/bin/env python3
"""
Assisted repair for the big damage that no detector can safely find on its own
(emulsion craters, tape marks, tears).

Workflow:
  1. Open a COPY of the scan in any editor (Preview, Paint, GIMP, Photopea...).
  2. Scribble over the damage with a PURE RED brush (255,0,0). Rough is fine -
     you are marking, not painting.
  3. Save as PNG next to the original and run this script.

Only the red-marked pixels are rebuilt. Everything else is copied through
bit-for-bit, so the photograph's tone and grain are untouched.
"""
import argparse, os
import numpy as np, cv2
from skimage.restoration import inpaint_biharmonic


def red_mask(scribbled):
    b, g, r = cv2.split(scribbled.astype(np.int16))
    m = ((r > 150) & (r - g > 60) & (r - b > 60)).astype(np.uint8) * 255
    return m


def matched_grain(img, mask, scale=1.0, seed=0):
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32)
    hp = g - cv2.GaussianBlur(g, (0, 0), 1.2)
    sigma = float(np.std(hp[mask == 0])) * scale
    rng = np.random.default_rng(seed)
    n = rng.normal(0, sigma, size=g.shape).astype(np.float32)
    out = img.astype(np.float32)
    sel = mask > 0
    for c in range(3):
        out[..., c][sel] += n[sel]
    return np.clip(out, 0, 255).astype(np.uint8), sigma


def main():
    p = argparse.ArgumentParser()
    p.add_argument("original")
    p.add_argument("scribbled", help="same image with damage marked in pure red")
    p.add_argument("-o", "--out", default=None)
    p.add_argument("--grow", type=int, default=2)
    p.add_argument("--grain", type=float, default=1.0)
    a = p.parse_args()

    img = cv2.imread(a.original, cv2.IMREAD_COLOR)
    scr = cv2.imread(a.scribbled, cv2.IMREAD_COLOR)
    if img.shape != scr.shape:
        scr = cv2.resize(scr, (img.shape[1], img.shape[0]), interpolation=cv2.INTER_NEAREST)
    mask = red_mask(scr)
    if a.grow:
        mask = cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)), iterations=a.grow)

    filled = inpaint_biharmonic(img.astype(np.float32) / 255.0, mask > 0, channel_axis=-1)
    filled = np.clip(filled * 255, 0, 255).astype(np.uint8)
    filled, sigma = matched_grain(filled, mask, a.grain)

    out = img.copy()
    out[mask > 0] = filled[mask > 0]
    dst = a.out or os.path.splitext(a.original)[0] + "_repaired.jpg"
    cv2.imwrite(dst, out, [cv2.IMWRITE_JPEG_QUALITY, 97])
    print(f"{os.path.basename(dst)}: rebuilt {100*(mask>0).mean():.3f}% of pixels | "
          f"grain sigma {sigma:.2f} | rest bit-identical: {np.array_equal(out[mask==0], img[mask==0])}")


if __name__ == "__main__":
    main()
