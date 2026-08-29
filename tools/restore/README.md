# Photo restoration tool

A private web tool for cleaning damage off archival photographs — dust, specks,
scratches, emulsion cracks and surface fibres. Built for the photo-biography
work, not for site visitors.

**It is deliberately invisible to the public.** It lives at `/restore/`, is not
linked from anywhere on the site, returns `403` without an access code, sends
`X-Robots-Tag: noindex, nofollow, noarchive`, and serves a `robots.txt` that
disallows everything. Nobody reaches it by browsing oshoarchives.com.

**It is temporary.** See *Removing it* below — three commands, no residue, and
nothing it touches is shared with the search site.

---

## What it does

An archivist uploads a photograph, paints **red** over damage to remove and
**green** over anything that must never be altered, and clicks Clean. They then
compare before and after — both at full zoom and whole-frame — download the
result, and if it is not right, adjust the marks and clean again.

The marks are a *guide to where to look*, not the repair itself: inside a red
scribble only pixels that genuinely stand out from the surrounding film get
rebuilt, so a generous, sloppy scribble over clean film changes nothing. That is
what makes the loop safe to iterate.

Nothing is regenerated. No tone, contrast or colour is altered anywhere. Every
pixel outside a repair is bit-for-bit the original, and each run checks that.

## Where it runs

- `osho-photo` under PM2, beside `osho-frontend`, so it restarts at boot via the
  existing `pm2-osho.service`
- Port **8010**, bound to localhost; reachable only through the nginx entry below
- Its own virtualenv at `/home/osho/photo-venv` — **nothing is installed
  system-wide**, so it cannot disturb the search backend's Python
- Uploads and results under `/home/osho/photo/`

## Why the memory cap matters

The server has **no swap** and runs the live search site. A 29-megapixel scan
plus a neural inpainting model can consume several gigabytes, and if memory runs
out Linux kills whichever process it judges worst — quite possibly the search
backend, taking oshoarchives.com down.

A `systemd` `MemoryMax` would normally prevent that, but setting one needs root.
Instead each cleaning job runs as a **separate process under a 3.5 GB
address-space limit** (`photo_worker.py`). If a job overruns, that job dies with
a clear message and the website never notices. Tune with `PHOTO_MEM_CAP_GB`.

Jobs are also serialised — one at a time — and OpenCV is held to two threads so
the photo work cannot starve the site of CPU.

## Installing

```bash
python3 -m venv /home/osho/photo-venv
/home/osho/photo-venv/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu
/home/osho/photo-venv/bin/pip install opencv-python-headless scikit-image scipy numpy certifi fire
/home/osho/photo-venv/bin/pip install simple-lama-inpainting --no-deps
mkdir -p /home/osho/photo/app /home/osho/photo/uploads
cp tools/restore/*.py /home/osho/photo/app/
cd /home/osho/photo/app && SSL_CERT_FILE=$(/home/osho/photo-venv/bin/python -m certifi) \
  pm2 start /home/osho/photo-venv/bin/python --name osho-photo \
  --cwd /home/osho/photo/app -- serve.py 8010 YOUR-ACCESS-CODE
pm2 save
```

Then add to the `oshoarchives.com` server block (needs root):

```nginx
location /restore/ {
    proxy_pass http://127.0.0.1:8010/;
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;      # a large scan takes minutes to clean
    client_max_body_size 400M;     # a 16-bit TIFF is 60-90 MB
}
```

`sudo nginx -t && sudo systemctl reload nginx`

The archivist then opens `https://oshoarchives.com/restore/?code=YOUR-ACCESS-CODE`.

## Removing it

When the photo-biography work is finished, remove it completely:

```bash
# 1. stop the service and forget it (it will not come back at boot)
pm2 delete osho-photo && pm2 save

# 2. delete the tool, its uploads and its virtualenv
rm -rf /home/osho/photo /home/osho/photo-venv /home/osho/.cache/torch

# 3. as root: delete the /restore/ location block from the nginx site, then
sudo nginx -t && sudo systemctl reload nginx
```

That is the whole footprint. It shares no database, no Python environment and no
code with the search site, so removing it cannot affect oshoarchives.com. To
check afterwards: `pm2 list` shows only `osho-frontend`, and
`curl -I https://oshoarchives.com/restore/` returns 404.

## Rotating or revoking access

The access code is the only thing protecting the tool. To change it, restart
with a new one — anyone holding the old link is locked out immediately:

```bash
pm2 delete osho-photo
cd /home/osho/photo/app && SSL_CERT_FILE=$(/home/osho/photo-venv/bin/python -m certifi) \
  pm2 start /home/osho/photo-venv/bin/python --name osho-photo \
  --cwd /home/osho/photo/app -- serve.py 8010 NEW-CODE
pm2 save
```

## Housekeeping

Uploads accumulate under `/home/osho/photo/uploads`. Clear ones older than a
fortnight:

```bash
find /home/osho/photo/uploads -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf {} +
```
