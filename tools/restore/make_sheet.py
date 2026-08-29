#!/usr/bin/env python3
"""Plain before/after sheet: every frame, two pictures side by side, no interaction."""
import base64, glob, os, sys
import cv2, numpy as np
sys.path.insert(0, "/Users/nimishshah/Downloads/kit")
import despeckle

IN = sys.argv[1]
CLD = sys.argv[2]
SP = sys.argv[2]

def enc(im, cap=900, q=82):
    h, w = im.shape[:2]
    s = cap / max(h, w)
    if s < 1:
        im = cv2.resize(im, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA)
    ok, b = cv2.imencode(".jpg", im, [cv2.IMWRITE_JPEG_QUALITY, q])
    return "data:image/jpeg;base64," + base64.b64encode(b).decode()

rows = []
for cp in sorted(glob.glob(f"{CLD}/*_clean.*")):
    base = os.path.basename(cp).split("_clean")[0]
    op = next((f"{IN}/{base}{e}" for e in (".tif", ".jpg") if os.path.exists(f"{IN}/{base}{e}")), None)
    if not op:
        continue
    o, _ = despeckle.load(op); c, _ = despeckle.load(cp)
    o8, c8 = despeckle.to8(o), despeckle.to8(c)
    d = cv2.absdiff(cv2.cvtColor(o8, cv2.COLOR_BGR2GRAY), cv2.cvtColor(c8, cv2.COLOR_BGR2GRAY)) > 2
    # 100% detail: the two spots where most repair happened. A speck is 2px on a
    # 5400px scan, so the whole-frame view cannot show this work - only these can.
    dm = d.astype(np.float32)
    sc = cv2.boxFilter(dm, -1, (201, 201)); C = 420
    zooms = []
    for i in range(2):
        y, x = np.unravel_index(np.argmax(sc), sc.shape)
        if sc[y, x] <= 0:
            break
        y0 = min(max(0, y - C // 2), o8.shape[0] - C); x0 = min(max(0, x - C // 2), o8.shape[1] - C)
        y0, x0 = max(0, y0), max(0, x0)
        sc[max(0, y - C):y + C, max(0, x - C):x + C] = 0
        zooms.append(f'''<div class="pair zoom">
    <figure><img src="{enc(o8[y0:y0+C, x0:x0+C], 420, 90)}" alt="detail before"><figcaption>Before &mdash; 100% detail</figcaption></figure>
    <figure><img src="{enc(c8[y0:y0+C, x0:x0+C], 420, 90)}" alt="detail after"><figcaption>After &mdash; 100% detail</figcaption></figure>
  </div>''')
    rows.append(f'''<section>
  <h2>{base} <span class="pct">{100*d.mean():.2f}% of pixels repaired</span></h2>
  <div class="pair">
    <figure><img src="{enc(o8)}" alt="{base} before"><figcaption>Before &mdash; whole frame</figcaption></figure>
    <figure><img src="{enc(c8)}" alt="{base} after"><figcaption>After &mdash; whole frame</figcaption></figure>
  </div>
  {''.join(zooms)}
</section>''')
    print(base, "done", flush=True)

html = f'''<title>Osho Archive Before and After</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600&family=Newsreader:opsz,wght@6..72,400&family=IBM+Plex+Mono:wght@400&display=swap">
<style>
:root {{ --paper:#EFEDE7; --card:#FBFAF7; --ink:#24252A; --dim:#6B675F; --line:#DAD6CD; }}
@media (prefers-color-scheme: dark) {{
  :root:not([data-theme="light"]) {{ --paper:#191A1C; --card:#232326; --ink:#E9E7E1; --dim:#9B978E; --line:#38363B; }}
}}
:root[data-theme="dark"] {{ --paper:#191A1C; --card:#232326; --ink:#E9E7E1; --dim:#9B978E; --line:#38363B; }}
* {{ box-sizing:border-box; }}
body {{ background:var(--paper); color:var(--ink); margin:0;
  font-family:"Newsreader",Georgia,serif; font-size:1.05rem; line-height:1.6; }}
.wrap {{ max-width:1180px; margin:0 auto; padding:2.6rem 1.2rem 4rem; }}
h1 {{ font-family:"Archivo",system-ui,sans-serif; font-weight:600; font-size:1.9rem; margin:0 0 .4rem; }}
.lede {{ max-width:62ch; color:var(--dim); margin:0 0 2.2rem; }}
section {{ background:var(--card); border:1px solid var(--line); padding:1.2rem; margin:0 0 1.6rem; }}
h2 {{ font-family:"IBM Plex Mono",ui-monospace,monospace; font-weight:400; font-size:1rem;
  margin:0 0 .9rem; display:flex; justify-content:space-between; align-items:baseline;
  gap:1rem; flex-wrap:wrap; border-bottom:1px solid var(--line); padding-bottom:.55rem; }}
.pct {{ font-family:"Archivo",system-ui,sans-serif; font-size:.72rem; letter-spacing:.07em;
  text-transform:uppercase; color:var(--dim); }}
.pair {{ display:grid; grid-template-columns:1fr 1fr; gap:1rem; }}
.zoom {{ margin-top:1rem; padding-top:1rem; border-top:1px dashed var(--line); }}
@media (max-width:720px) {{ .pair {{ grid-template-columns:1fr; }} }}
figure {{ margin:0; }}
figure img {{ display:block; width:100%; height:auto; border:1px solid var(--line); background:#000; }}
figcaption {{ font-family:"Archivo",system-ui,sans-serif; font-size:.7rem; letter-spacing:.1em;
  text-transform:uppercase; color:var(--dim); margin-top:.4rem; }}
footer {{ color:var(--dim); font-size:.95rem; max-width:64ch; margin-top:2rem; }}
</style>
<div class="wrap">
<h1>Cleaned photographs</h1>
<p class="lede">Left is the original scan, right is the cleaned version.</p>
<p class="lede"><strong>Look at the 100% details under each frame, not the whole frame.</strong> The
damage being removed is dust: a speck is two or three pixels across on a scan five thousand pixels
wide, so at page size it is invisible whether it is there or not. The detail pairs are shown at full
resolution, at the two spots on each frame where the most repair happened - that is where the
difference is visible. Nothing has been regenerated and no tone, contrast or colour has been changed
anywhere; film grain in every untouched area is identical to the original.</p>
{''.join(rows)}
<footer><p>Originals are unmodified on disk. Cleaned files live alongside them in a separate folder.
Percentages are the share of pixels that changed.</p></footer>
</div>
'''
out = os.path.join(SP, "results.html")
open(out, "w").write(html)
print(out, f"{os.path.getsize(out)/1e6:.2f} MB")
