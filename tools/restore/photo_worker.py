#!/usr/bin/env python3
"""Run one cleaning job under a hard memory ceiling.

  python3 photo_worker.py <photo> <outdir> [mask.png]

This exists because the archive's server has no swap and also runs the live
search site. Without a ceiling, a large scan can exhaust memory, and Linux then
kills whichever process it judges worst - which may well be the search backend,
taking oshoarchives.com down.

A systemd MemoryMax would normally provide that ceiling, but setting one needs
root. An address-space rlimit set here gives the same protection from inside the
job: if this process overruns, THIS process dies with a clear message and the
website never notices.

The OpenCV thread count is capped for the same reason - the photo work must not
starve the search backend of CPU.
"""
import os
import resource
import sys

CAP_BYTES = int(float(os.environ.get("PHOTO_MEM_CAP_GB", "3.5")) * 1024 ** 3)


def main():
    photo, outdir = sys.argv[1], sys.argv[2]
    mask = sys.argv[3] if len(sys.argv) > 3 else None

    resource.setrlimit(resource.RLIMIT_AS, (CAP_BYTES, CAP_BYTES))

    import cv2
    cv2.setNumThreads(2)
    import despeckle
    import clean_drop

    if mask and os.path.exists(mask):
        img, _ = despeckle.load(photo)
        if img is not None:
            m = cv2.imread(mask, cv2.IMREAD_UNCHANGED)
            if m is not None:
                if m.ndim == 3 and m.shape[2] == 4:
                    a = m[..., 3:4] / 255.0
                    m = (m[..., :3] * a).astype("uint8")
                m = cv2.resize(m, (img.shape[1], img.shape[0]), interpolation=cv2.INTER_NEAREST)
                cv2.imwrite(os.path.splitext(photo)[0] + clean_drop.SUFFIX + ".png", m)

    clean_drop.process(photo, outdir)
    print("WORKER_OK")


if __name__ == "__main__":
    try:
        main()
    except MemoryError:
        print("WORKER_ERR this photograph needs more memory than the server allows for one "
              "job; try uploading a smaller version of it", file=sys.stderr)
        sys.exit(2)
    except Exception as exc:
        print(f"WORKER_ERR {exc}", file=sys.stderr)
        sys.exit(1)
