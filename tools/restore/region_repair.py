"""Human-marked region repair: aggressive detection INSIDE marked regions,
LaMa (big-mask inpainting) as the fill engine, film grain matched locally.
Pixels outside the detected damage are untouched even inside the region."""
import cv2, numpy as np, sys
from scipy import ndimage as ndi
from PIL import Image
from simple_lama_inpainting import SimpleLama

_lama=None
def lama():
    global _lama
    if _lama is None: _lama=SimpleLama()
    return _lama

def lama_fill(img, mask, pad=110):
    """Run LaMa per damage cluster on padded crops; paste only masked pixels."""
    out=img.copy()
    lab,n=ndi.label(cv2.dilate(mask,np.ones((25,25),np.uint8))>0)
    for sl in ndi.find_objects(lab):
        if sl is None: continue
        y0=max(0,sl[0].start-pad); y1=min(img.shape[0],sl[0].stop+pad)
        x0=max(0,sl[1].start-pad); x1=min(img.shape[1],sl[1].stop+pad)
        sub=out[y0:y1,x0:x1]; sm=mask[y0:y1,x0:x1]
        if sm.max()==0: continue
        res=lama()(Image.fromarray(cv2.cvtColor(sub,cv2.COLOR_BGR2RGB)),Image.fromarray(sm))
        res=cv2.cvtColor(np.array(res),cv2.COLOR_RGB2BGR)[:sub.shape[0],:sub.shape[1]]
        sub[sm>0]=res[sm>0]
    return out

def regrain(img, mask, region, scale=0.9, seed=5):
    g=cv2.cvtColor(img,cv2.COLOR_BGR2GRAY).astype(np.float32)
    hp=g-cv2.GaussianBlur(g,(0,0),1.2)
    ref=(mask==0)&(region>0)
    if ref.sum()<1000: ref=(mask==0)
    sig=float(np.std(hp[ref]))*scale
    nz=np.random.default_rng(seed).normal(0,sig,size=g.shape).astype(np.float32)
    out=img.astype(np.float32); sel=mask>0
    for c in range(3): out[...,c][sel]+=nz[sel]
    return np.clip(out,0,255).astype(np.uint8)

def detect_in_region(g8, region, tb, td, blob_max, edge_guard=None):
    med=cv2.medianBlur(g8,41)
    d=g8.astype(np.int16)-med.astype(np.int16)
    m=(((d>tb)|(d<-td))&(region>0)).astype(np.uint8)
    m=cv2.morphologyEx(m,cv2.MORPH_CLOSE,np.ones((7,7),np.uint8))
    m=ndi.binary_fill_holes(m>0).astype(np.uint8)
    lab,n=ndi.label(m)
    if n:
        area=np.bincount(lab.ravel()); good=np.zeros(n+1,bool)
        for i in range(1,n+1):
            good[i]=4<=area[i]<=blob_max
        m=good[lab].astype(np.uint8)
    if edge_guard is not None:   # protect strong real edges (faces, trees)
        gx=cv2.Sobel(med,cv2.CV_32F,1,0,3); gy=cv2.Sobel(med,cv2.CV_32F,0,1,3)
        m[cv2.magnitude(gx,gy)>edge_guard]=0
    return (m*255)

def fine_in_region(img, g8, region, tb, td, k=11, seed=7):
    med=cv2.medianBlur(g8,k)
    d=g8.astype(np.int16)-med.astype(np.int16)
    m=(((d>tb)|(d<-td))&(region>0)).astype(np.uint8)*255
    medc=cv2.merge([cv2.medianBlur(img[...,c],k) for c in range(3)])
    out=img.copy(); out[m>0]=medc[m>0]
    return regrain(out,m,region,0.8,seed),m
