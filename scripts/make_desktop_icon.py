#!/usr/bin/env python3
"""Generate the desktop app icon — a gold "O" (for Osho) on a black
rounded-square tile — at desktop/build-resources/icon.png (1024x1024).

electron-builder reads that PNG from its buildResources directory and
auto-generates the platform-specific .icns (macOS) and .ico (Windows)
at package time, so this single 1024 master is all we maintain.

Usage:
    pip install Pillow
    python3 scripts/make_desktop_icon.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

REPO = Path(__file__).resolve().parent.parent
OUT = REPO / "desktop" / "build-resources" / "icon.png"

S = 4                       # supersample factor for clean anti-aliasing
SZ = 1024 * S
GOLD = (212, 175, 55, 255)  # #d4af37 — the app gold
BLACK = (10, 8, 6, 255)     # near-black tile (#0a0806)


def main() -> None:
    img = Image.new("RGBA", (SZ, SZ), (0, 0, 0, 0))  # transparent corners
    d = ImageDraw.Draw(img)

    radius = int(0.21 * SZ)
    d.rounded_rectangle([0, 0, SZ - 1, SZ - 1], radius=radius, fill=BLACK)

    inset = int(0.045 * SZ)
    d.rounded_rectangle(
        [inset, inset, SZ - 1 - inset, SZ - 1 - inset],
        radius=int(radius * 0.78),
        outline=(212, 175, 55, 110),
        width=max(2, int(0.006 * SZ)),
    )

    # "O" with letterform stress: sides thicker than top/bottom.
    cx = cy = SZ // 2
    outer_r = int(0.300 * SZ)
    inner_rx = int(0.170 * SZ)
    inner_ry = int(0.205 * SZ)
    d.ellipse([cx - outer_r, cy - outer_r, cx + outer_r, cy + outer_r], fill=GOLD)
    d.ellipse([cx - inner_rx, cy - inner_ry, cx + inner_rx, cy + inner_ry], fill=BLACK)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    img.resize((1024, 1024), Image.LANCZOS).save(OUT)
    print(f"wrote {OUT.relative_to(REPO)}")


if __name__ == "__main__":
    main()
