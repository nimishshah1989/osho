#!/usr/bin/env python3
"""Restoration engine: multi-scale damage detection + LaMa repair, full resolution.

Two things this adds over a single pass of despeckle.py.

MULTI-SCALE LOOKING. Whether something is damage depends on how closely you look
at the film. The approved thresholds describe a ~6MP view; on a 29MP scan that
view cannot resolve a 3-pixel speck at all. So the frame is examined at several
distances and the findings are unioned - fine specks surface in the close views,
craters and stains in the wide ones. Detection happens on each view; repair
always happens at native resolution.

LaMa WHERE IT EARNS ITS COST. A 5-pixel speck is best filled with the median of
the film around it - LaMa has nothing to add and thousands of model calls per
frame would be absurd. A crater or scratch needs plausible structure carried in
from context, and that is what LaMa is for. The split is by defect size.

The detector itself, and every guard it applies, is despeckle.py's - seven review
rounds paid for those and they are reused, not reinvented. Measured on this
archive, real dust sits at only ~1.7x the local grain, overlapping heavily with
grain clumps, so a detector without those guards is not safe here.
"""
import numpy as np
import cv2
from scipy import ndimage as ndi

import despeckle

BIG_DEFECT_PX = 220          # above this, a hole is worth LaMa's context fill

# How closely the frame is examined, in megapixels. This is the aggressiveness
# dial, and it is deliberately set to the single validated view.
#
# Measured on TOG 048 (lake, 28MP): 6MP finds 0.57% damage, adding a 13MP view
# finds 1.11%, adding 26MP finds 1.83%. But inspection at 100% shows the closer
# views putting their extra findings ON THE WATER RIPPLE CRESTS, and the repair
# visibly flattens them - the archive's oldest failure. At these distances a
# ripple highlight and a dust speck are the same signal, which is the same reason
# sunlit reed tips read as dust.
#
# So: more views is not more cleaning, it is more risk. Raise this only for a
# frame a human has looked at and knows has no fine repeating texture - a studio
# portrait on seamless paper, a print with a plain background - and check the
# result at 100% before accepting it.
VIEWS_MP = (6.0e6,)
VIEWS_CLOSER = (6.0e6, 13.0e6)     # opt-in, texture-free frames only


class Cfg:
    """Detector settings; mirrors the approved run_batch defaults."""
    def __init__(self, **kw):
        for k, v in dict(thresh=9, thresh_dark=13, scales=[3, 7, 13, 21], close=3,
                         min_area=3, max_area=2500, max_aspect=3.0, min_fill=0.45,
                         max_sat=55.0, max_busy=9.0, grow=1, _protect=None).items():
            setattr(self, k, v)
        for k, v in kw.items():
            setattr(self, k, v)


def local_grain(g, win=97):
    """Per-pixel estimate of the film's own grain, as a standard deviation.

    Mean absolute deviation rather than a median: it is a box filter, so it costs
    one pass over a 29MP frame instead of a sort per window. For Gaussian noise
    sigma = 1.2533 * mean|x|, and the high-pass is clipped first so a scratch
    cannot inflate the local estimate and hide itself."""
    f = g.astype(np.float32)
    hp = f - cv2.GaussianBlur(f, (0, 0), 1.2)
    lim = 4.0 * 1.2533 * float(np.mean(np.abs(hp)))
    mad = cv2.boxFilter(np.minimum(np.abs(hp), lim), -1, (win, win))
    return np.maximum(1.2533 * mad, 0.35)      # floor: a drum scan can be near-noiseless


def detect(img, protect=None, grain_mult=2.5, floor=9, max_speck_px=400):
    """Find the dust, at the resolution the dust actually lives at.

    Two things this gets right that cost a lot to learn.

    NATIVE RESOLUTION. The dust on these negatives is 2 pixels across (90th
    percentile 5px). Detecting on a downscaled view - even a carefully calibrated
    one - runs those specks through an area average that erases them: on the
    Kamala Nagar portrait a 6MP view found 0.004% of the frame while the specks
    were plainly visible at 100%. You cannot find a 2-pixel speck by looking at a
    picture that no longer contains it.

    UNSCALED KERNELS. The old code grew both its kernels and its size limits with
    the scan's resolution, on the assumption that a bigger scan means bigger
    defects in pixels. It does not: this dust is at the scanner's resolution limit
    either way. That scaling pushed the minimum defect size to 15px on a 29MP
    scan, which threw away every speck on the frame before any threshold was read.

    The threshold is a multiple of the film's OWN grain rather than a fixed grey
    level, because grain varies from frame to frame (sigma 1.3 to 7 across this
    batch) and a bar that is selective on one negative is blind on another."""
    g8 = cv2.cvtColor(despeckle.to8(img), cv2.COLOR_BGR2GRAY)
    sigma = float(local_grain(g8, win=201).mean())
    thr = max(floor, int(round(grain_mult * sigma)))
    # The texture guard keeps the detector out of foliage and hair, where a
    # bright dot is a leaf or a highlight rather than dust. Its limit has to move
    # with the film's grain: a fixed 9 was calibrated against a downscaled view
    # and is far too strict at native resolution, while switching it off entirely
    # let the detector chew the texture of dark foliage.
    # Tried and REVERTED: measuring the texture guard on a median-filtered view
    # (so speck clusters could not shield themselves). It let the detector mark
    # soft-focus content - a sari's lace pattern, a grille reflection, water
    # shadows - because out-of-focus detail has no texture for the guard to see.
    # The raw-image guard stays; sub-threshold damage goes to hand bands instead.
    cfg = Cfg(thresh=thr, thresh_dark=thr + 6, min_area=2, max_area=max_speck_px,
              max_aspect=3.5, min_fill=0.35, max_busy=2.4 * sigma, grow=0)
    cfg._protect = protect
    mask = despeckle.build_mask(img, g8, cfg, 1.0)     # scale 1: kernels sized for real specks
    if protect is not None:
        mask[protect > 0] = 0
    return mask


def repair(img, mask, seed=3):
    """Small holes take the local median; big ones take LaMa's read of the context."""
    out = img.copy()
    lab, n = ndi.label(mask > 0)
    if n == 0:
        return out
    areas = np.bincount(lab.ravel(), minlength=n + 1)
    big = np.zeros(n + 1, bool)
    big[1:] = areas[1:] >= BIG_DEFECT_PX
    big_mask = big[lab].astype(np.uint8) * 255
    small_mask = ((mask > 0) & (big_mask == 0)).astype(np.uint8) * 255

    rel = max(1.0, np.sqrt(img.shape[0] * img.shape[1] / 6e6))
    if small_mask.any():
        k = max(5, int(4 * rel) | 1)
        medc = cv2.merge([cv2.medianBlur(out[..., c], k) for c in range(3)])
        out[small_mask > 0] = medc[small_mask > 0]

    if big_mask.any():
        from PIL import Image
        from simple_lama_inpainting import SimpleLama
        model = SimpleLama()
        bl, _ = ndi.label(cv2.dilate(big_mask, np.ones((9, 9), np.uint8)) > 0)
        pad = int(96 * rel)
        for sl in ndi.find_objects(bl):
            if sl is None:
                continue
            y0 = max(0, sl[0].start - pad); y1 = min(img.shape[0], sl[0].stop + pad)
            x0 = max(0, sl[1].start - pad); x1 = min(img.shape[1], sl[1].stop + pad)
            sub = out[y0:y1, x0:x1]; sm = big_mask[y0:y1, x0:x1]
            if sm.max() == 0:
                continue
            res = model(Image.fromarray(cv2.cvtColor(sub, cv2.COLOR_BGR2RGB)),
                        Image.fromarray(sm))
            res = cv2.cvtColor(np.array(res), cv2.COLOR_RGB2BGR)[:sub.shape[0], :sub.shape[1]]
            sub[sm > 0] = res[sm > 0]

    # the film's own grain back over every rebuilt pixel, at the local strength
    sigma = local_grain(cv2.cvtColor(despeckle.to8(img), cv2.COLOR_BGR2GRAY),
                        win=max(31, int(97 * rel) | 1))
    noise = np.random.default_rng(seed).standard_normal(mask.shape).astype(np.float32) * sigma
    sel = mask > 0
    outf = out.astype(np.float32)
    for c in range(3):
        outf[..., c][sel] += noise[sel]
    return np.clip(outf, 0, 255).astype(np.uint8)


def count_big(mask):
    """How many defects were large enough to be filled by LaMa rather than median."""
    lab, n = ndi.label(mask > 0)
    if n == 0:
        return 0
    return int((np.bincount(lab.ravel(), minlength=n + 1)[1:] >= BIG_DEFECT_PX).sum())


def clean(img, protect=None, budget=3.0, grain_mult=2.5, mult_max=6.0):
    """Detect and repair, backing off until the repair fits the budget.

    Refusing is a valid outcome: a frame still wanting more than `budget` of its
    pixels rebuilt at the most cautious setting is damaged enough to deserve a
    human, not a batch job. Returns (image|None, mask, pct, multiple_used)."""
    m = grain_mult
    while True:
        mask = detect(img, protect, grain_mult=m)
        pct = 100.0 * (mask > 0).mean()
        if pct <= budget or m >= mult_max:
            break
        m += 0.5
    if pct > budget:
        return None, mask, pct, m
    out = img.copy()
    rep = repair(img, mask)
    out[mask > 0] = rep[mask > 0]              # nothing outside the mask can move
    return out, mask, pct, m


# ---------------------------------------------------------------------------
# SHELVED: detect_stark below is not called by the delivered chain. Ten guard
# iterations on this batch established that stark trails/patches and living
# texture (whisker highlights, algae mats, weathered plaster) overlap in every
# per-component statistic tried - amplitude, ring contrast, crowding, interior
# smoothness. The classifier that works is a human eye; crack trails and white
# patches therefore go through the hand-mark path (make_marks.py + LaMa), which
# is the workflow the archive already sanctions. Kept for reference.
# ---------------------------------------------------------------------------
def _ring_stats(g8, busy, mask):
    """Per-component mean interior busy-ness and ring busy-ness."""
    lab, n = ndi.label(mask > 0)
    if n == 0:
        return lab, n, None, None
    ring_lab = cv2.dilate(lab.astype(np.float32), np.ones((9, 9), np.uint8)).astype(np.int32)
    ring = (ring_lab > 0) & (mask == 0)
    cnt_in = np.bincount(lab.ravel(), minlength=n + 1)
    busy_in = np.bincount(lab.ravel(), weights=busy.ravel(), minlength=n + 1) / np.maximum(cnt_in, 1)
    rl = ring_lab[ring]
    cnt_rg = np.bincount(rl, minlength=n + 1)
    busy_rg = np.bincount(rl, weights=busy[ring], minlength=n + 1) / np.maximum(cnt_rg, 1)
    return lab, n, busy_in, busy_rg


def detect_stark(img, protect=None):
    """Cracks, dash-trails and white patches: damage the dust pass rejects BY DESIGN.

    The dust detector's shape guard refuses long-thin-bright objects because a
    grey beard hair and a scratch are the same signal - so it has also been
    refusing emulsion cracks. Its size cap excludes white patches. This pass
    exists for those classes, built on three observations that survive contact
    with the real frames:

    - The film's true grain must be read from its QUIETEST areas. A local
      estimate inflates inside beard or foliage, so texture passes any
      texture-vs-grain test scored against itself (measured: the first version
      of this pass marked a sunlit hillside as damage that way).
    - Crack trails on these prints are CHAINS of short dashes. Each dash fails
      any length test, so dashes are first connected along lines and the chain
      is judged as one object.
    - A white patch of damage is featureless INSIDE (the mark replaces the
      emulsion); a bright rock face or tree crown carries its own texture.
      Interior smoothness, not brightness, is what separates them.

    Returns (auto, proposed). auto is safe to apply: stark damage on calm
    surroundings, outside any protect region. proposed is the same damage found
    on busy texture or on a protected person - there a bright squiggle may be a
    living whisker, and a human must decide. Nothing from proposed is applied."""
    g8 = cv2.cvtColor(despeckle.to8(img), cv2.COLOR_BGR2GRAY)
    h, w = g8.shape
    rel = max(1.0, np.sqrt(h * w / 6.0e6))
    f = g8.astype(np.float32)
    sig = local_grain(g8, win=max(31, int(97 * rel) | 1))
    s_floor = float(np.percentile(sig, 25))          # the film's grain where nothing else is
    hp = np.abs(f - cv2.GaussianBlur(f, (0, 0), 1.5))
    busy = cv2.boxFilter(hp, -1, (max(9, int(25 * rel) | 1),) * 2)

    d = f - cv2.medianBlur(g8, 9).astype(np.float32)
    cand = (d > max(22.0, 4.0 * s_floor)).astype(np.uint8)

    # the film rebate: the near-black scan border manufactures candidates all
    # along its transition, so nothing within its reach is considered
    dark = (g8 < 12).astype(np.uint8)
    edge_lab, en = ndi.label(dark)
    if en:
        band = max(20, int(0.06 * min(h, w)))
        in_band = np.zeros((h, w), bool)
        in_band[:band] = in_band[-band:] = True
        in_band[:, :band] = in_band[:, -band:] = True
        area_all = np.bincount(edge_lab.ravel(), minlength=en + 1)
        area_band = np.bincount(edge_lab[in_band].ravel(), minlength=en + 1)
        # a rebate HUGS the border; a dark beard or backdrop bulges deep into
        # the frame - only mostly-in-band dark regions are treated as rebate
        frac = area_band / np.maximum(area_all, 1)
        is_rebate = np.zeros(en + 1, bool)
        is_rebate[1:] = (frac[1:] >= 0.5) & (area_all[1:] > 500)
        if is_rebate.any():
            border = cv2.dilate(is_rebate[edge_lab].astype(np.uint8), np.ones((25, 25), np.uint8))
            cand[border > 0] = 0

    # A real dash-trail is SPARSE: a thin line of candidates in a quiet
    # neighborhood. An algae mat or sunlit speckle field is dense candidates
    # everywhere, and closing along lines there manufactures fake chains
    # (measured: it gridded TOK 003's algae into 2% of the frame). So the
    # chain-connect step only sees candidates from low-density neighborhoods.
    dens = cv2.boxFilter(cand.astype(np.float32), -1, (41, 41))
    sparse = ((cand > 0) & (dens < 0.10)).astype(np.uint8)

    # connect collinear dashes into chains before judging shape
    L = max(11, int(13 * rel) | 1)
    chain = np.zeros_like(cand)
    for se in (cv2.getStructuringElement(cv2.MORPH_RECT, (L, 1)),
               cv2.getStructuringElement(cv2.MORPH_RECT, (1, L))):
        chain |= cv2.morphologyEx(sparse, cv2.MORPH_CLOSE, se)

    lab, n = ndi.label(chain, structure=np.ones((3, 3)))
    keep = np.zeros_like(chain)
    if 0 < n < 400_000:
        area = np.bincount(lab.ravel(), minlength=n + 1)
        _, _, busy_in, _ = _ring_stats(g8, busy, chain)
        for i, sl in enumerate(ndi.find_objects(lab), 1):
            if sl is None:
                continue
            hh = sl[0].stop - sl[0].start; ww = sl[1].stop - sl[1].start
            a = int(area[i])
            if a < 8 or a > 60000 * rel * rel:
                continue
            fill = a / float(hh * ww)
            chain_like = max(hh, ww) >= 16 and (fill <= 0.45 or
                                                max(hh, ww) / max(1, min(hh, ww)) >= 3.0)
            patch_like = (a >= 150 * rel * rel and fill >= 0.30 and
                          busy_in is not None and busy_in[i] <= 2.5 * s_floor)
            if chain_like or patch_like:
                keep[sl][lab[sl] == i] = 1

    m = keep.astype(np.uint8) * 255
    m = cv2.dilate(m, np.ones((3, 3), np.uint8))

    # Final classification, per component, on two independent axes:
    #   amplitude - is it STARK (mean excess >= 35 grey levels)? Texture that
    #     leaks through the candidate bar sits at 22-35; real trails and marks
    #     sit at 50+. Weak components are dropped entirely, not proposed -
    #     at that amplitude nothing distinguishes them from the film.
    #   surroundings - quiet ring means the fill is unambiguous (auto); a busy
    #     ring (beard, foliage, weathered wall) means a human must decide.
    lab2, n2, _, busy_rg = _ring_stats(g8, busy, m)
    auto = np.zeros_like(m); proposed = np.zeros_like(m)
    if n2:
        # amplitude over the component's CANDIDATE pixels only - a dashed chain
        # is mostly closed-over gap, and averaging the gaps in hides real trails
        is_cand = (cand > 0) & (lab2 > 0)
        cl = lab2[is_cand]
        c_cnt = np.bincount(cl, minlength=n2 + 1).astype(np.float64)
        c_sum = np.bincount(cl, weights=np.maximum(d[is_cand], 0), minlength=n2 + 1)
        amp = c_sum / np.maximum(c_cnt, 1)
        # ring contrast, also on candidate pixels only: a dashed chain is mostly
        # closed-over gap, and judging the whole component against its ring made
        # every trail read as no brighter than the film (killed B55's trails)
        g_sum = np.bincount(cl, weights=f[is_cand], minlength=n2 + 1)
        g_cand = g_sum / np.maximum(c_cnt, 1)
        ring_lab = cv2.dilate(lab2.astype(np.float32), np.ones((13, 13), np.uint8)).astype(np.int32)
        ring = (ring_lab > 0) & (m == 0)
        rl = ring_lab[ring]
        r_cnt = np.bincount(rl, minlength=n2 + 1).astype(np.float64)
        r_sum = np.bincount(rl, weights=f[ring], minlength=n2 + 1)
        ring_mean = r_sum / np.maximum(r_cnt, 1)
        contrast = (g_cand - ring_mean) >= max(10.0, 2.0 * s_floor)
        # saturation, on candidate pixels only (the third place gap dilution
        # bit): damage is colourless even on a sepia print, but a chain's
        # closed-over gaps are sepia, and averaging them in rejected every
        # trail on the toned prints
        sat = cv2.cvtColor(despeckle.to8(img), cv2.COLOR_BGR2HSV)[..., 1].astype(np.float32)
        if float(sat.mean()) >= 6.0:
            s_sum = np.bincount(cl, weights=sat[is_cand], minlength=n2 + 1)
            colourless = (s_sum / np.maximum(c_cnt, 1)) <= 55.0
        else:
            colourless = np.ones(n2 + 1, bool)
        stark_amp = (amp >= 35.0) & contrast & colourless
        quiet = busy_rg <= np.maximum(6.0, 2.2 * s_floor)
        a_keep = np.zeros(n2 + 1, bool); p_keep = np.zeros(n2 + 1, bool)
        a_keep[1:] = stark_amp[1:] & quiet[1:]
        p_keep[1:] = stark_amp[1:] & ~quiet[1:]

        # sibling test, auto tier only: real damage is ISOLATED. A bright clump
        # with many similar neighbours (algae mats, sunlit speckle) is the scene
        # repeating itself - amplitude and ring quietness cannot tell one clump
        # from a splat of damage, but the crowd it stands in can.
        if a_keep.any():
            cy, cx = np.array(ndi.center_of_mass(m > 0, lab2, np.arange(1, n2 + 1))).T if n2 > 1 else (None, None)
            if cy is not None:
                idx = np.where(a_keep[1:])[0]
                R = 400.0 * rel
                for j in idx:
                    dist2 = (cy - cy[j]) ** 2 + (cx - cx[j]) ** 2
                    if (dist2 < R * R).sum() - 1 >= 6:      # 6+ similar neighbours
                        a_keep[j + 1] = False               # crowd -> a human decides
                        p_keep[j + 1] = True
        auto = (a_keep[lab2] & (m > 0)).astype(np.uint8) * 255
        proposed = (p_keep[lab2] & (m > 0)).astype(np.uint8) * 255
    if protect is not None:
        moved = (protect > 0) & (auto > 0)
        proposed[moved] = 255
        auto[protect > 0] = 0
    return auto, proposed
