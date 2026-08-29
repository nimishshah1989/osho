#!/usr/bin/env python3
"""A small web app for cleaning photos: upload, mark, clean, download, repeat.

  python3 serve.py [port] [access-code]

Open http://localhost:8000 (or share it - see the note at the bottom of this
docstring). The reviewer uploads a photo, paints RED over damage they want gone
and GREEN over anything that must never be touched, and clicks Clean. When it
finishes they compare before and after at full zoom and download the result. If
they are not satisfied they adjust the marks and clean again - the marks are
kept between runs, so each pass refines the last.

Built on the standard library alone. No Flask, no build step, nothing to install
beyond what the cleaning pipeline already needs, because every dependency here
is one more thing that can break on someone else's machine.

Cleaning a 29-megapixel scan takes minutes, which is far longer than a browser
will hold a request open, so work runs on a background thread and the page polls
for progress.

TO LET SOMEONE ELSE REACH IT, run a tunnel alongside it, e.g.
    cloudflared tunnel --url http://localhost:8000
and send them the URL it prints, plus the access code.
"""
import json
import os
import subprocess
import sys
import threading
import time
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import cv2

import despeckle
import clean_drop

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "uploads")
os.makedirs(ROOT, exist_ok=True)
JOBS = {}
LOCK = threading.Lock()
MAX_UPLOAD = 400 * 1024 * 1024


# ----------------------------------------------------------------- multipart
def parse_multipart(body, boundary):
    """Minimal multipart/form-data reader: {field name: (filename, bytes)}."""
    out = {}
    sep = b"--" + boundary
    for part in body.split(sep):
        if not part.strip() or part.startswith(b"--"):
            continue
        head, _, data = part.partition(b"\r\n\r\n")
        if not _:
            continue
        name = filename = None
        for line in head.split(b"\r\n"):
            if line.lower().startswith(b"content-disposition"):
                for bit in line.decode("utf-8", "replace").split(";"):
                    bit = bit.strip()
                    if bit.startswith("name="):
                        name = bit[5:].strip('"')
                    elif bit.startswith("filename="):
                        filename = bit[9:].strip('"')
        if name:
            out[name] = (filename, data.rstrip(b"\r\n"))
    return out


# ------------------------------------------------------------------- cleaning
def run_job(job_id, photo_path, mask_bytes):
    job = JOBS[job_id]
    try:
        job["stage"] = "Reading the photograph"
        img, _ = despeckle.load(photo_path)
        if img is None:
            raise ValueError("that file could not be read as an image")
        h, w = img.shape[:2]

        if mask_bytes:
            job["stage"] = "Reading your marks"
            m = cv2.imdecode(np.frombuffer(mask_bytes, np.uint8), cv2.IMREAD_UNCHANGED)
            if m is not None:
                if m.ndim == 3 and m.shape[2] == 4:          # canvas alpha -> black elsewhere
                    a = m[..., 3:4] / 255.0
                    m = (m[..., :3] * a).astype(np.uint8)
                m = cv2.resize(m, (w, h), interpolation=cv2.INTER_NEAREST)
                stem = os.path.splitext(photo_path)[0]
                cv2.imwrite(f"{stem}{clean_drop.SUFFIX}.png", m)

        job["stage"] = "Cleaning - this takes a few minutes on a large scan"
        outdir = os.path.join(os.path.dirname(photo_path), "cleaned")
        # The heavy work runs in a separate process under a memory ceiling. On
        # the archive's server, where there is no swap and the live search site
        # shares the machine, that ceiling is what stops one large scan from
        # taking the website down with it. See photo_worker.py.
        here = os.path.dirname(os.path.abspath(__file__))
        stem = os.path.splitext(photo_path)[0]
        mpath = f"{stem}{clean_drop.SUFFIX}.png"
        cmd = [sys.executable, os.path.join(here, "photo_worker.py"), photo_path, outdir]
        if os.path.exists(mpath):
            cmd.append(mpath)
        with LOCK:                                   # one heavy job at a time
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=3600)
        if r.returncode != 0:
            msg = next((ln[len("WORKER_ERR "):] for ln in (r.stderr or "").splitlines()
                        if ln.startswith("WORKER_ERR")), "the cleaner failed")
            raise RuntimeError(msg)

        base = os.path.splitext(os.path.basename(photo_path))[0]
        result = next((os.path.join(outdir, base + "_clean" + e)
                       for e in (".tif", ".png") if os.path.exists(os.path.join(outdir, base + "_clean" + e))), None)
        if result is None:
            raise RuntimeError("the cleaner produced no output")

        job["stage"] = "Preparing the comparison"
        o8 = despeckle.to8(despeckle.load(photo_path)[0])
        c8 = despeckle.to8(despeckle.load(result)[0])
        d = cv2.absdiff(cv2.cvtColor(o8, cv2.COLOR_BGR2GRAY), cv2.cvtColor(c8, cv2.COLOR_BGR2GRAY)) > 2

        def prev(im, cap=1400):
            s = cap / max(im.shape[:2])
            if s < 1:
                im = cv2.resize(im, (int(im.shape[1] * s), int(im.shape[0] * s)), interpolation=cv2.INTER_AREA)
            return cv2.imencode(".jpg", im, [cv2.IMWRITE_JPEG_QUALITY, 88])[1].tobytes()

        # a 100% detail pair where the most repair happened - at page size a
        # 2-pixel speck is invisible whether or not it is still there
        sc = cv2.boxFilter(d.astype(np.float32), -1, (201, 201))
        y, x = np.unravel_index(np.argmax(sc), sc.shape)
        C = min(500, h, w)
        y0 = max(0, min(y - C // 2, h - C)); x0 = max(0, min(x - C // 2, w - C))

        job.update(stage="Done", done=True, pct=round(100 * float(d.mean()), 2),
                   result=result,
                   before=prev(o8), after=prev(c8),
                   zbefore=prev(o8[y0:y0+C, x0:x0+C], 500), zafter=prev(c8[y0:y0+C, x0:x0+C], 500))
    except Exception as e:
        traceback.print_exc()
        job.update(stage="Failed", done=True, error=str(e))


# --------------------------------------------------------------------- server
class App(BaseHTTPRequestHandler):
    server_version = "PhotoClean"
    # HTTP/1.1 is required, not cosmetic: browsers and curl send
    # "Expect: 100-continue" before a large multipart upload, and an HTTP/1.0
    # handler never answers it, so the connection dies before a single byte of
    # the photo arrives.
    protocol_version = "HTTP/1.1"

    def _send(self, code, ctype, body, extra=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        # This runs under a public domain but is private to the archivists:
        # keep it out of search engines and out of any referrer trail.
        self.send_header("X-Robots-Tag", "noindex, nofollow, noarchive")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            # the reviewer navigated away mid-response; nothing to recover
            return

    def _authed(self):
        """Every endpoint is gated, not just the upload.

        The access code guarded POST only, which meant anyone who guessed a job
        id on the public URL could have pulled down someone's photograph. The
        code is accepted once as ?code=... and then held in a cookie, so the
        reviewer types it a single time."""
        if not CODE:
            return True
        if self.headers.get("X-Code") == CODE:
            return True
        if f"code={CODE}" in (self.path or ""):
            return True
        cookie = self.headers.get("Cookie", "")
        return f"pc={CODE}" in cookie

    def _deny(self):
        self._send(403, "text/html; charset=utf-8",
                   "<!doctype html><meta charset=utf-8>"
                   "<style>body{font:16px/1.6 system-ui;margin:4rem auto;max-width:32rem;padding:0 1rem}</style>"
                   "<h2>Access code needed</h2>"
                   "<p>Open the link you were sent, including the part after <code>?code=</code>.</p>"
                   "<form method=get><input name=code placeholder='access code' "
                   "style='font:inherit;padding:.5rem'> <button style='font:inherit;padding:.5rem 1rem'>"
                   "Open</button></form>")

    def do_GET(self):
        p = self.path.split("?")[0]
        if p == "/robots.txt":
            return self._send(200, "text/plain", "User-agent: *\nDisallow: /\n")
        if not self._authed():
            return self._deny()
        if p == "/":
            cookie = {"Set-Cookie": f"pc={CODE}; Path=/; SameSite=Lax; Max-Age=604800"} if CODE else None
            return self._send(200, "text/html; charset=utf-8", PAGE, cookie)
        if p.startswith("/img/"):
            _, _, jid, which = p.split("/", 3)
            j = JOBS.get(jid)
            if not j or which not in j:
                return self._send(404, "text/plain", "not found")
            return self._send(200, "image/jpeg", j[which])
        if p.startswith("/status/"):
            j = JOBS.get(p.rsplit("/", 1)[1])
            if not j:
                return self._send(404, "application/json", '{"error":"unknown job"}')
            return self._send(200, "application/json", json.dumps(
                {k: j.get(k) for k in ("stage", "done", "pct", "error")}))
        if p == "/robots.txt":
            return self._send(200, "text/plain", "User-agent: *\nDisallow: /\n")
        if p.startswith("/download/"):
            j = JOBS.get(p.rsplit("/", 1)[1])
            if not j or not j.get("result"):
                return self._send(404, "text/plain", "not ready")
            with open(j["result"], "rb") as f:
                data = f.read()
            name = os.path.basename(j["result"])
            return self._send(200, "application/octet-stream", data,
                              {"Content-Disposition": f'attachment; filename="{name}"'})
        return self._send(404, "text/plain", "not found")

    def do_POST(self):
        if self.path.split("?")[0] != "/clean":
            return self._send(404, "text/plain", "not found")
        if not self._authed():
            return self._send(403, "application/json", '{"error":"access code missing or wrong"}')
        ctype = self.headers.get("Content-Type", "")
        if "boundary=" not in ctype:
            return self._send(400, "application/json", '{"error":"bad upload"}')
        n = int(self.headers.get("Content-Length", 0))
        if n > MAX_UPLOAD:
            return self._send(413, "application/json", '{"error":"file too large"}')
        body = self.rfile.read(n)
        parts = parse_multipart(body, ctype.split("boundary=")[1].strip().strip('"').encode())
        if "photo" not in parts or not parts["photo"][1]:
            return self._send(400, "application/json", '{"error":"no photo received"}')

        fname, data = parts["photo"]
        jid = uuid.uuid4().hex[:12]
        d = os.path.join(ROOT, jid)
        os.makedirs(d, exist_ok=True)
        safe = "".join(c for c in (fname or "photo.jpg") if c.isalnum() or c in " ._-()")[:100]
        path = os.path.join(d, safe or "photo.jpg")
        with open(path, "wb") as f:
            f.write(data)

        JOBS[jid] = {"stage": "Queued", "done": False}
        threading.Thread(target=run_job, args=(jid, path, parts.get("mask", (None, b""))[1]),
                         daemon=True).start()
        return self._send(200, "application/json", json.dumps({"job": jid}))

    def log_message(self, *a):
        pass


PAGE = r"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Photo cleaning</title>
<style>
:root{--paper:#EFEDE7;--card:#FBFAF7;--ink:#24252A;--dim:#6B675F;--line:#DAD6CD;--red:#C0392B;--green:#2E7D46}
@media(prefers-color-scheme:dark){:root{--paper:#191A1C;--card:#232326;--ink:#E9E7E1;--dim:#9B978E;--line:#38363B}}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);
 font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:1100px;margin:0 auto;padding:2rem 1.1rem 4rem}
h1{font-size:1.6rem;margin:0 0 .3rem}
p.lede{color:var(--dim);max-width:62ch;margin:0 0 1.6rem}
.card{background:var(--card);border:1px solid var(--line);padding:1.2rem;margin:0 0 1.2rem;border-radius:6px}
.row{display:flex;gap:.6rem;flex-wrap:wrap;align-items:center}
button,label.btn{font:inherit;padding:.55rem 1rem;border:1px solid var(--line);background:var(--paper);
 color:var(--ink);border-radius:5px;cursor:pointer}
button:hover,label.btn:hover{border-color:var(--dim)}
button:disabled{opacity:.45;cursor:default}
button.on{background:var(--ink);color:var(--paper);border-color:var(--ink)}
button.go{background:var(--ink);color:var(--paper);border-color:var(--ink);font-weight:600;padding:.7rem 1.6rem}
.swatch{width:.85rem;height:.85rem;border-radius:50%;display:inline-block;margin-right:.45rem;vertical-align:-1px}
#stage{position:relative;margin-top:1rem;overflow:auto;max-height:70vh;border:1px solid var(--line);background:#111}
#stage canvas{display:block;max-width:100%}
#paint{position:absolute;top:0;left:0;cursor:crosshair;touch-action:none}
.hint{color:var(--dim);font-size:.9rem;margin:.5rem 0 0}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:1rem}
@media(max-width:700px){.pair{grid-template-columns:1fr}}
.pair img{width:100%;border:1px solid var(--line);display:block}
figcaption{font-size:.75rem;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);margin-top:.35rem}
.bar{height:5px;background:var(--line);border-radius:3px;overflow:hidden;margin:.8rem 0}
.bar i{display:block;height:100%;width:35%;background:var(--ink);animation:sl 1.3s ease-in-out infinite}
@keyframes sl{0%{margin-left:-35%}100%{margin-left:100%}}
.err{color:var(--red)}
.pct{font-weight:600}
input[type=range]{vertical-align:middle}
</style></head><body><div class="wrap">
<h1>Photo cleaning</h1>
<p class="lede">Upload a photograph, mark the damage you want removed, and clean it. Compare the result,
download it, and if it is not right yet, adjust the marks and clean again.</p>

<div class="card">
  <div class="row">
    <label class="btn">Choose a photo<input id="file" type="file" accept="image/*,.tif,.tiff" hidden></label>
    <span id="fname" class="hint"></span>
  </div>

  <div id="tools" style="display:none">
    <div class="row" style="margin-top:1rem">
      <button id="bred" class="on"><span class="swatch" style="background:var(--red)"></span>Remove this</button>
      <button id="bgreen"><span class="swatch" style="background:var(--green)"></span>Never touch</button>
      <button id="berase">Erase marks</button>
      <span style="margin-left:.4rem">Brush <input id="size" type="range" min="6" max="90" value="30"></span>
      <button id="bclear">Clear all</button>
    </div>
    <p class="hint">Scribble roughly over the damage &mdash; the marks are only a guide to where to look,
    so going over clean film does no harm. Marking nothing at all is fine too; the cleaner will still
    do its normal pass.</p>
    <div id="stage"><canvas id="base"></canvas><canvas id="paint"></canvas></div>
    <div class="row" style="margin-top:1rem"><button id="go" class="go">Clean photo</button></div>
  </div>
</div>

<div id="work" class="card" style="display:none">
  <div id="stagetext">Working…</div><div class="bar"><i></i></div>
  <p class="hint">A large scan takes a few minutes. You can leave this page open.</p>
</div>

<div id="out" class="card" style="display:none">
  <div class="row" style="justify-content:space-between">
    <div><span class="pct" id="pct"></span> of the picture was repaired</div>
    <div class="row"><a id="dl"><button>Download cleaned photo</button></a>
      <button id="again">Adjust marks and clean again</button></div>
  </div>
  <h3 style="margin:1.2rem 0 .5rem;font-size:1rem">Close-up where most was repaired</h3>
  <div class="pair">
    <figure style="margin:0"><img id="zb"><figcaption>Before</figcaption></figure>
    <figure style="margin:0"><img id="za"><figcaption>After</figcaption></figure>
  </div>
  <h3 style="margin:1.4rem 0 .5rem;font-size:1rem">Whole picture</h3>
  <div class="pair">
    <figure style="margin:0"><img id="wb"><figcaption>Before</figcaption></figure>
    <figure style="margin:0"><img id="wa"><figcaption>After</figcaption></figure>
  </div>
  <p class="hint">The close-up is where the difference is visible. At whole-picture size a speck is two
  or three pixels across, so it looks the same either way.</p>
</div>

<div id="fail" class="card err" style="display:none"></div>
</div>
<script>
const $=s=>document.querySelector(s);
let file=null,mode='red',drawing=false,last=null,jid=null;
const base=$('#base'),paint=$('#paint'),bctx=base.getContext('2d'),pctx=paint.getContext('2d');

$('#file').onchange=e=>{
  file=e.target.files[0]; if(!file)return;
  $('#fname').textContent=file.name;
  const img=new Image();
  img.onload=()=>{
    const cap=1000, s=Math.min(1,cap/Math.max(img.width,img.height));
    const w=Math.round(img.width*s), h=Math.round(img.height*s);
    base.width=paint.width=w; base.height=paint.height=h;
    paint.style.width=base.style.width=w+'px';
    bctx.drawImage(img,0,0,w,h); pctx.clearRect(0,0,w,h);
    $('#tools').style.display='block'; $('#out').style.display='none';
  };
  img.onerror=()=>{ $('#fname').textContent=file.name+' (no preview - it will still be cleaned)';
    $('#tools').style.display='block'; base.width=paint.width=1; };
  img.src=URL.createObjectURL(file);
};

function setMode(m){mode=m;for(const b of ['bred','bgreen','berase'])$('#'+b).classList.remove('on');
  $({red:'#bred',green:'#bgreen',erase:'#berase'}[m]).classList.add('on');}
$('#bred').onclick=()=>setMode('red'); $('#bgreen').onclick=()=>setMode('green');
$('#berase').onclick=()=>setMode('erase');
$('#bclear').onclick=()=>pctx.clearRect(0,0,paint.width,paint.height);

function at(e){const r=paint.getBoundingClientRect();
  return {x:(e.clientX-r.left)*paint.width/r.width, y:(e.clientY-r.top)*paint.height/r.height};}
function stroke(a,b){
  pctx.globalCompositeOperation = mode==='erase'?'destination-out':'source-over';
  pctx.strokeStyle = mode==='green'?'#00C000':'#FF0000';
  pctx.lineWidth=+$('#size').value; pctx.lineCap=pctx.lineJoin='round';
  pctx.beginPath(); pctx.moveTo(a.x,a.y); pctx.lineTo(b.x,b.y); pctx.stroke();
}
paint.addEventListener('pointerdown',e=>{drawing=true;last=at(e);stroke(last,last);paint.setPointerCapture(e.pointerId);});
paint.addEventListener('pointermove',e=>{if(!drawing)return;const p=at(e);stroke(last,p);last=p;});
addEventListener('pointerup',()=>drawing=false);

$('#again').onclick=()=>{$('#out').style.display='none';window.scrollTo({top:0,behavior:'smooth'});};

$('#go').onclick=async()=>{
  if(!file){alert('Choose a photo first.');return;}
  $('#go').disabled=true; $('#fail').style.display='none';
  $('#out').style.display='none'; $('#work').style.display='block';
  $('#stagetext').textContent='Uploading…';
  const fd=new FormData(); fd.append('photo',file);
  const painted=pctx.getImageData(0,0,paint.width,paint.height).data.some((v,i)=>i%4===3&&v>0);
  if(painted){
    const blob=await new Promise(r=>paint.toBlob(r,'image/png'));
    fd.append('mask',blob,'mask.png');
  }
  let r;
  try{ r=await (await fetch('/clean',{method:'POST',body:fd})).json(); }
  catch(err){ return fail('The upload did not reach the server. Check the connection and try again.'); }
  if(r.error) return fail(r.error);
  jid=r.job; poll();
};
function fail(m){ $('#work').style.display='none'; $('#go').disabled=false;
  $('#fail').style.display='block'; $('#fail').textContent=m; }

async function poll(){
  let s;
  try{ s=await (await fetch('/status/'+jid)).json(); }
  catch(e){ return setTimeout(poll,3000); }
  $('#stagetext').textContent=s.stage||'Working…';
  if(!s.done) return setTimeout(poll,2000);
  $('#work').style.display='none'; $('#go').disabled=false;
  if(s.error) return fail('It could not be cleaned: '+s.error);
  $('#pct').textContent=(s.pct??0)+'%';
  $('#zb').src='/img/'+jid+'/zbefore'; $('#za').src='/img/'+jid+'/zafter';
  $('#wb').src='/img/'+jid+'/before';  $('#wa').src='/img/'+jid+'/after';
  $('#dl').href='/download/'+jid;
  $('#out').style.display='block';
  $('#out').scrollIntoView({behavior:'smooth'});
}
</script></body></html>"""

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    CODE = sys.argv[2] if len(sys.argv) > 2 else ""
    srv = ThreadingHTTPServer(("0.0.0.0", port), App)
    print(f"Photo cleaning app running at http://localhost:{port}")
    if CODE:
        print(f"Access code: {CODE}")
    print("Press Ctrl-C to stop.")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
        srv.server_close()
