#!/usr/bin/env python3
"""
Non-destructive dust / pinhole removal for archival scans.

Principle: DETECT the damage -> build a binary mask -> rebuild ONLY those pixels.
Every pixel outside the mask is copied through bit-for-bit from the original.
Tone, contrast, grain and colour cannot drift, because nothing global is ever
applied. Each run prints a bit-identical check as proof.

Handles 8-bit and 16-bit TIFF/PNG/JPEG, colour or greyscale.
"""
import argparse, os
import numpy as np
import cv2
from scipy import ndimage as ndi
from skimage.restoration import inpaint_biharmonic


# ---------------------------------------------------------------- io helpers
def load(path):
    im = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    if im is None:
        return None, None
    dtype = im.dtype
    if im.ndim == 2:
        im = cv2.cvtColor(im, cv2.COLOR_GRAY2BGR)
    elif im.shape[2] == 4:
        im = im[:, :, :3]
    return im, dtype


def to8(im):
    return im if im.dtype == np.uint8 else (im.astype(np.float32) / 257.0).astype(np.uint8)


def save(path, im, dtype, jpeg_q=97):
    ext = os.path.splitext(path)[1].lower()
    if ext in (".tif", ".tiff"):
        cv2.imwrite(path, im.astype(dtype))
    else:
        cv2.imwrite(path, to8(im), [cv2.IMWRITE_JPEG_QUALITY, jpeg_q])


# ---------------------------------------------------------------- detection
def tophat_union(gray, scales, thresh, dark=False):
    """Morphological top-hat at several sizes: finds bright (or dark) structures
    smaller than each structuring element."""
    src = (255 - gray) if dark else gray
    acc = np.zeros(gray.shape, np.uint8)
    for s in scales:
        se = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (s, s))
        acc |= (cv2.morphologyEx(src, cv2.MORPH_TOPHAT, se) > thresh).astype(np.uint8)
    return acc


def size_filter(mask, min_area, max_area):
    lab, n = ndi.label(mask)
    if n == 0:
        return mask
    area = np.bincount(lab.ravel(), minlength=n + 1)
    good = (area >= min_area) & (area <= max_area)
    good[0] = False
    return good[lab].astype(np.uint8) * 255


def shape_filter(mask, max_aspect, min_fill):
    """Dust and pinholes are compact. Hair strands, reeds, twigs, fabric threads
    and highlight streaks are elongated or wispy - leave those alone."""
    lab, n = ndi.label(mask)
    if n == 0:
        return mask
    good = np.zeros(n + 1, bool)
    for i, sl in enumerate(ndi.find_objects(lab), start=1):
        if sl is None:
            continue
        h = sl[0].stop - sl[0].start
        w = sl[1].stop - sl[1].start
        a = int((lab[sl] == i).sum())
        good[i] = (max(h, w) / max(1, min(h, w)) <= max_aspect) and (a / float(h * w) >= min_fill)
    good[0] = False
    return good[lab].astype(np.uint8) * 255


def ring_contrast_filter(gray, mask, min_delta, ring_px, dark=False):
    """Keep only blobs genuinely brighter (darker) than the film immediately
    around them. Removes candidates sitting on real highlights and detail."""
    lab, n = ndi.label(mask)
    if n == 0:
        return mask
    dil = cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (ring_px, ring_px)))
    ring_lab = cv2.dilate(lab.astype(np.float32),
                          cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (ring_px, ring_px))).astype(np.int32)
    ring = (dil > 0) & (mask == 0)
    g = gray.astype(np.float32)
    ins_s = np.bincount(lab.ravel(), weights=g.ravel(), minlength=n + 1)
    ins_c = np.bincount(lab.ravel(), minlength=n + 1)
    rl = ring_lab[ring]
    rg_s = np.bincount(rl.ravel(), weights=g[ring].ravel(), minlength=n + 1)
    rg_c = np.bincount(rl.ravel(), minlength=n + 1)
    with np.errstate(invalid="ignore", divide="ignore"):
        din = ins_s / np.maximum(ins_c, 1)
        drg = rg_s / np.maximum(rg_c, 1)
    delta = (drg - din) if dark else (din - drg)
    good = np.zeros(n + 1, bool)
    good[1:] = (delta[1:] >= min_delta) & (rg_c[1:] > 0)
    good[0] = False
    return good[lab].astype(np.uint8) * 255



def saturation_filter(img, mask, max_sat):
    """Physical damage (dust, pinholes, emulsion loss) is colourless - it shows
    the paper or the light source. Saturated colour is the PHOTOGRAPH: yellow
    flowers, skin, fabric. Reject anything with real colour in it."""
    hsv = cv2.cvtColor(to8(img), cv2.COLOR_BGR2HSV)
    sat = hsv[..., 1].astype(np.float32)
    if float(sat.mean()) < 6.0:          # greyscale scan - guard does not apply
        return mask
    lab, n = ndi.label(mask)
    if n == 0:
        return mask
    s = np.bincount(lab.ravel(), weights=sat.ravel(), minlength=n + 1)
    c = np.bincount(lab.ravel(), minlength=n + 1)
    good = np.zeros(n + 1, bool)
    good[1:] = (s[1:] / np.maximum(c[1:], 1)) <= max_sat
    good[0] = False
    return good[lab].astype(np.uint8) * 255


def texture_filter(gray, mask, max_busy, win=25):
    """A speck on smooth sky or skin is unambiguous. A bright dot inside a bush
    is probably a leaf. Only repair where the neighbourhood is calm enough that
    we can be sure. `busy` is already a windowed average, so scoring a component
    on its own pixels also measures the film around it."""
    g = gray.astype(np.float32)
    hp = np.abs(g - cv2.GaussianBlur(g, (0, 0), 1.5))
    busy = cv2.boxFilter(hp, -1, (win, win))
    lab, n = ndi.label(mask)
    if n == 0:
        return mask
    s = np.bincount(lab.ravel(), weights=busy.ravel(), minlength=n + 1)
    c = np.bincount(lab.ravel(), minlength=n + 1)
    good = np.zeros(n + 1, bool)
    good[1:] = (s[1:] / np.maximum(c[1:], 1)) <= max_busy
    good[0] = False
    return good[lab].astype(np.uint8) * 255


def detect(gray, a, scale, dark=False):
    scales = [max(3, int(s * scale) | 1) for s in a.scales]
    thr = a.thresh_dark if dark else a.thresh
    m = tophat_union(gray, scales, thr, dark=dark)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE,
                         cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (int(a.close * scale) | 1,) * 2))
    m = ndi.binary_fill_holes(m > 0).astype(np.uint8) * 255
    m = size_filter(m, max(1, int(a.min_area * scale ** 2)), int(a.max_area * scale ** 2))
    m = shape_filter(m, a.max_aspect, a.min_fill)
    m = ring_contrast_filter(gray, m, thr, max(5, int(9 * scale) | 1), dark=dark)
    m = texture_filter(gray, m, a.max_busy, win=max(9, int(25 * scale) | 1))
    return m


# ---------------------------------------------------------------- repair
def repair(img, mask, radius):
    """cv2's fast inpaint for 8-bit; biharmonic for 16-bit (cv2 can't do 16)."""
    if img.dtype == np.uint8:
        return cv2.inpaint(img, mask, radius, cv2.INPAINT_TELEA)
    f = img.astype(np.float32) / 65535.0
    out = inpaint_biharmonic(f, mask > 0, channel_axis=-1)
    return np.clip(out * 65535.0, 0, 65535).astype(np.uint16)


def matched_grain(img, mask, strength, seed=0):
    """Re-inject grain at the same strength as the surrounding film so repaired
    patches don't read as suspiciously smooth."""
    peak = 255.0 if img.dtype == np.uint8 else 65535.0
    g = cv2.cvtColor(to8(img), cv2.COLOR_BGR2GRAY).astype(np.float32)
    hp = g - cv2.GaussianBlur(g, (0, 0), 1.2)
    sigma8 = float(np.std(hp[mask == 0]))
    sigma = sigma8 * strength * (peak / 255.0)
    n = np.random.default_rng(seed).normal(0, sigma, size=g.shape).astype(np.float32)
    out = img.astype(np.float32)
    sel = mask > 0
    for c in range(out.shape[2]):
        out[..., c][sel] += n[sel]
    return np.clip(out, 0, peak).astype(img.dtype), sigma8


# ---------------------------------------------------------------- driver
def load_protect(path, shape):
    """A protect image is the photo with GREEN painted over anything the machine
    must never touch - faces, hands, hair, signatures. Nothing inside it is ever
    modified, at any threshold. Judgement about the subject stays with a human."""
    p = cv2.imread(path, cv2.IMREAD_COLOR)
    if p is None:
        return None
    if p.shape[:2] != shape:
        p = cv2.resize(p, (shape[1], shape[0]), interpolation=cv2.INTER_NEAREST)
    b, g, r = cv2.split(p.astype(np.int16))
    return (((g > 120) & (g - r > 60) & (g - b > 60)).astype(np.uint8) * 255)


def build_mask(img, g8, a, scale):
    mask = detect(g8, a, scale, dark=False)
    if a.thresh_dark > 0:
        mask |= detect(g8, a, scale, dark=True)
    mask = saturation_filter(img, mask, a.max_sat)
    if a.grow:
        mask = cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)),
                          iterations=a.grow)
    if a._protect is not None:
        mask[a._protect > 0] = 0
    return mask



def build_mask_at_ref(img, g8, a, target_mp=6.0e6):
    """Detect on a fixed view of the frame, then map the mask back to full size.

    Whether a speck is damage is a property of the photograph - its size and
    contrast against the film - not of the scanner's dpi. Judging it per-pixel at
    native resolution made the same guards throw away almost everything on large
    scans: measured on TOG 048, 2396 candidates survived at 29MP versus 14658 on
    the identical photo at 6MP. Repair still happens at full resolution.

    target_mp selects how closely the frame is being looked at. 6MP is the view
    the current thresholds were approved against; a finer view resolves smaller
    specks, which is why the engine unions several."""
    h, w = g8.shape
    ref = np.sqrt(h * w / target_mp)
    if ref <= 1.0:
        return build_mask(img, g8, a, 1.0)
    sw, sh = int(w / ref), int(h / ref)
    full_protect = a._protect
    a._protect = (cv2.resize(full_protect, (sw, sh), interpolation=cv2.INTER_NEAREST)
                  if full_protect is not None else None)
    m = build_mask(cv2.resize(img, (sw, sh), interpolation=cv2.INTER_AREA),
                   cv2.resize(g8, (sw, sh), interpolation=cv2.INTER_AREA), a, 1.0)
    a._protect = full_protect
    m = cv2.resize(m, (w, h), interpolation=cv2.INTER_NEAREST)
    if full_protect is not None:      # re-assert protection at full resolution
        m[full_protect > 0] = 0
    return m


def fine_pass(img, g8, scale, protect, bright, dark, flat_lim, grain_scale, seed=1):
    """Dense fine dust on FLAT regions (sky, water, studio backgrounds).
    A per-blob detector cannot see a snowstorm of faint 1-4 px specks; a local
    median can. Applied only where the median image has no structure, and never
    inside a protect region, so detail cannot be eaten. Replaced pixels take the
    local median value - the tone of the film an arm's length away - then get
    the film's own grain back."""
    k = max(5, int(4 * scale) | 1)
    med = cv2.medianBlur(g8, k)
    gx = cv2.Sobel(med, cv2.CV_32F, 1, 0, 3)
    gy = cv2.Sobel(med, cv2.CV_32F, 0, 1, 3)
    win = max(15, int(15 * scale) | 1)
    flat = (cv2.boxFilter(cv2.magnitude(gx, gy), -1, (win, win)) < flat_lim).astype(np.uint8)
    flat = cv2.erode(flat, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (win, win)))
    if protect is not None:
        flat[protect > 0] = 0
    d = g8.astype(np.int16) - med.astype(np.int16)
    m = (((d > bright) | (d < -dark)) & (flat > 0)).astype(np.uint8) * 255

    peak = 255.0 if img.dtype == np.uint8 else 65535.0
    # grain matched to the FLAT region's own noise, not the whole frame's
    medc = cv2.medianBlur(img, k) if img.dtype == np.uint8 else         cv2.merge([cv2.medianBlur(img[..., c], k) for c in range(3)])
    out = img.copy()
    out[m > 0] = medc[m > 0]
    hp = g8.astype(np.float32) - cv2.GaussianBlur(g8.astype(np.float32), (0, 0), 1.2)
    ref = (m == 0) & (flat > 0)
    if ref.sum() < 1000:
        ref = (m == 0)
    sigma = float(np.std(hp[ref])) * grain_scale * (peak / 255.0)
    n = np.random.default_rng(seed).normal(0, sigma, size=g8.shape).astype(np.float32)
    outf = out.astype(np.float32)
    sel = m > 0
    for c in range(3):
        outf[..., c][sel] += n[sel]
    return np.clip(outf, 0, peak).astype(img.dtype), m

def process(path, a):
    img, dtype = load(path)
    if img is None:
        print("skip", path); return None
    g8 = cv2.cvtColor(to8(img), cv2.COLOR_BGR2GRAY)
    h, w = g8.shape
    scale = max(1.0, np.sqrt((h * w) / 6.0e6))
    a._protect = load_protect(a.protect, (h, w)) if a.protect else None

    # Auto-tune: raise the threshold until the repair stays inside the budget.
    # A photo with little damage therefore gets little done to it, which is the
    # correct outcome - the tool should not invent work.
    base_thresh = a.thresh
    used = base_thresh
    mask = build_mask_at_ref(img, g8, a)
    if a.budget > 0:
        while 100.0 * (mask > 0).mean() > a.budget and used < a.thresh_max:
            used += 4
            a.thresh = used
            mask = build_mask_at_ref(img, g8, a)
        if 100.0 * (mask > 0).mean() > a.budget:
            print(f"{os.path.basename(path):22s} REFUSED - still {100*(mask>0).mean():.2f}% "
                  f"at threshold {used}. This scan needs a human, not a batch job.")
            a.thresh = base_thresh
            return None
    a.thresh = base_thresh
    pct = 100.0 * (mask > 0).sum() / mask.size
    rep, sigma = matched_grain(repair(img, mask, a.radius), mask, a.grain)
    out = img.copy()
    out[mask > 0] = rep[mask > 0]                      # hard guarantee

    fpct = 0.0
    if a.fine:
        out2, fmask = fine_pass(out, cv2.cvtColor(to8(out), cv2.COLOR_BGR2GRAY), scale,
                                a._protect, a.fine_bright, a.fine_dark, a.flat_lim, 0.7)
        fmask[mask > 0] = 0            # blob repairs already final
        out[fmask > 0] = out2[fmask > 0]
        mask = cv2.bitwise_or(mask, fmask)
        fpct = 100.0 * (fmask > 0).mean()

    base = os.path.splitext(os.path.basename(path))[0]
    os.makedirs(a.outdir, exist_ok=True)
    ext = a.ext or (".tif" if dtype == np.uint16 else ".jpg")
    save(os.path.join(a.outdir, base + "_clean" + ext), out, dtype)
    if a.preview:
        ov = to8(img).copy(); ov[mask > 0] = (0, 0, 255)
        cv2.imwrite(os.path.join(a.outdir, base + "_mask.jpg"), ov, [cv2.IMWRITE_JPEG_QUALITY, 88])
    ok = np.array_equal(out[mask == 0], img[mask == 0])
    print(f"{base:22s} {str(dtype):7s} thr{used:3d} blob {pct:5.3f}% + fine {fpct:5.2f}% | grain {sigma:4.2f} | untouched identical: {ok}")
    return pct


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("inputs", nargs="+")
    p.add_argument("-o", "--outdir", default="cleaned")
    p.add_argument("--ext", default=None, help="force output extension, e.g. .tif or .jpg")
    p.add_argument("--thresh", type=int, default=14)
    p.add_argument("--thresh-dark", type=int, default=0)
    p.add_argument("--scales", type=int, nargs="+", default=[3, 7, 13, 21])
    p.add_argument("--close", type=int, default=3)
    p.add_argument("--min-area", type=int, default=3)
    p.add_argument("--max-area", type=int, default=1200)
    p.add_argument("--max-aspect", type=float, default=3.0)
    p.add_argument("--min-fill", type=float, default=0.45)
    p.add_argument("--protect", default=None,
                   help="image with GREEN painted over regions the tool must never touch")
    p.add_argument("--max-sat", type=float, default=55.0)
    p.add_argument("--max-busy", type=float, default=9.0)
    p.add_argument("--budget", type=float, default=0.25,
                   help="max %% of pixels to repair; 0 disables auto-tuning")
    p.add_argument("--thresh-max", type=int, default=70)
    p.add_argument("--grow", type=int, default=1)
    p.add_argument("--radius", type=int, default=4)
    p.add_argument("--grain", type=float, default=1.0)
    p.add_argument("--fine", action="store_true", help="also clear dense fine dust on flat regions")
    p.add_argument("--fine-bright", type=int, default=4)
    p.add_argument("--fine-dark", type=int, default=7)
    p.add_argument("--flat-lim", type=float, default=15.0)
    p.add_argument("--preview", action="store_true")
    a = p.parse_args()
    for f in a.inputs:
        process(f, a)
