"""Round-4 polish: scratch removal + iterated fine dust with transplanted grain."""
import cv2, numpy as np
from scipy import ndimage as ndi
import region_repair as rr

def scratch_mask(g, thr=8, length=27, min_aspect=3.5, max_area=60000, protect=None):
    """Long thin bright OR dark lines at any angle: linear top-hat union."""
    acc=np.zeros_like(g)
    for ang in range(0,180,15):
        se=cv2.getStructuringElement(cv2.MORPH_RECT,(length,1))
        M=cv2.getRotationMatrix2D((length//2,0),ang,1)
        se=cv2.warpAffine(se,M,(length,length),flags=cv2.INTER_NEAREST)
        if se.sum()<3: continue
        th=cv2.morphologyEx(g,cv2.MORPH_TOPHAT,se)
        bh=cv2.morphologyEx(g,cv2.MORPH_BLACKHAT,se)
        acc|=((th>thr)|(bh>thr)).astype(np.uint8)
    acc=cv2.morphologyEx(acc,cv2.MORPH_CLOSE,np.ones((5,5),np.uint8))
    lb,n=ndi.label(acc)
    keep=np.zeros_like(acc)
    for i,sl in enumerate(ndi.find_objects(lb),1):
        if sl is None: continue
        hh=sl[0].stop-sl[0].start; ww=sl[1].stop-sl[1].start
        a=int((lb[sl]==i).sum())
        if a<40 or a>max_area: continue
        aspect=max(hh,ww)/max(1,min(hh,ww))
        fill=a/float(hh*ww)
        if (aspect>=min_aspect and fill<0.5) or (fill<0.15 and a>=120):  # straight OR curled thin line
            keep[sl][lb[sl]==i]=1
    if protect is not None: keep[protect>0]=0
    return cv2.dilate(keep,np.ones((5,5),np.uint8))*255

def transplant_grain(img, mask, flat, seed=0):
    """Replace synthetic-smooth repairs with the photo's OWN grain, sampled
    from clean flat areas. Authentic texture, zero invention of content."""
    g=cv2.cvtColor(img,cv2.COLOR_BGR2GRAY).astype(np.float32)
    base=cv2.GaussianBlur(g,(0,0),1.2)
    hp=g-base
    donor_ok=(mask==0)&(flat>0)
    rng=np.random.default_rng(seed)
    out=img.astype(np.float32)
    todo=(mask>0)
    filled=np.zeros_like(todo)
    for _ in range(24):
        if not todo.any(): break
        dy,dx=int(rng.integers(-300,300)),int(rng.integers(-300,300))
        hp_s=np.roll(np.roll(hp,dy,0),dx,1)
        ok_s=np.roll(np.roll(donor_ok,dy,0),dx,1)
        sel=todo&ok_s&~filled
        for c in range(3): out[...,c][sel]+= hp_s[sel]
        filled|=sel; todo&=~filled
    return np.clip(out,0,255).astype(np.uint8)

def flatzone(g, flat_lim=15):
    """Where the film is smooth enough to rebuild. Measured on a fixed ~6MP view of
    the frame: a per-pixel gradient shrinks as resolution grows (the same edge is
    spread over more pixels), so a fixed flat_lim judged at native size opens ever
    wider on big scans - 27% of a 29MP frame vs 2% of the same photo at 6MP, which
    is how skin, plaster and water got rebuilt as 'flat paper'."""
    h,w=g.shape
    ref=np.sqrt(h*w/6e6)
    gg=cv2.resize(g,(int(w/ref),int(h/ref)),interpolation=cv2.INTER_AREA) if ref>1 else g
    med=cv2.medianBlur(gg,5)
    gx=cv2.Sobel(med,cv2.CV_32F,1,0,3); gy=cv2.Sobel(med,cv2.CV_32F,0,1,3)
    flat=(cv2.boxFilter(cv2.magnitude(gx,gy),-1,(15,15))<flat_lim).astype(np.uint8)
    flat=cv2.erode(flat,np.ones((7,7),np.uint8))
    return cv2.resize(flat,(w,h),interpolation=cv2.INTER_NEAREST) if ref>1 else flat

def fine_iter(img, iters=3, bright=4, dark=6, flat_lim=15, protect=None, seed=9):
    h,w=img.shape[:2]; scale=max(1.0,np.sqrt(h*w/6e6))
    total=np.zeros((h,w),np.uint8)
    for it in range(iters):
        g=cv2.cvtColor(img,cv2.COLOR_BGR2GRAY)
        flat=flatzone(g,flat_lim)
        if protect is not None: flat[protect>0]=0
        k=max(5,int((4+2*it)*scale)|1)          # widen the net each round
        med=cv2.medianBlur(g,k)
        d=g.astype(np.int16)-med.astype(np.int16)
        m=(((d>bright)|(d<-dark))&(flat>0)).astype(np.uint8)*255
        if (m>0).sum()==0: break
        medc=cv2.merge([cv2.medianBlur(img[...,c],k) for c in range(3)])
        img=img.copy(); img[m>0]=medc[m>0]
        img=transplant_grain(img,m,flat,seed+it)
        total|=m
    return img,total

def speck_pass(img, exclude, bright=7, dark=9, max_area_6mp=80, seed=17):
    """Tiny compact anomalies in TEXTURED areas. Component size is capped so
    ripples, algae, foliage (all far larger) cannot be touched.

    Detected on a fixed ~6MP view: bright/dark are grey levels against a local
    median, and at native resolution a big scan's own film grain clears them, so
    the pass medianed away the photograph instead of specks on it - measured at
    78% of a 29MP frame. Repair still happens at full resolution."""
    h,w=img.shape[:2]
    ref=np.sqrt(h*w/6e6)
    img_s=cv2.resize(img,(int(w/ref),int(h/ref)),interpolation=cv2.INTER_AREA) if ref>1 else img
    ex_s=cv2.resize(exclude,(int(w/ref),int(h/ref)),interpolation=cv2.INTER_NEAREST) if ref>1 else exclude
    g=cv2.cvtColor(img_s,cv2.COLOR_BGR2GRAY)
    # a speck has to clear the film's OWN grain, not a fixed grey level: these
    # negatives carry grain sigma ~5-7, which by itself cleared a flat 8/10 bar.
    # The floor keeps low-grain scans behaving exactly as they were approved.
    hp=g.astype(np.float32)-cv2.GaussianBlur(g.astype(np.float32),(0,0),1.2)
    grain=4.0*1.4826*float(np.median(np.abs(hp)))
    tb,td=max(bright,grain),max(dark,grain)
    med=cv2.medianBlur(g,5)
    d=g.astype(np.int16)-med.astype(np.int16)
    m=(((d>tb)|(d<-td))&(ex_s==0)).astype(np.uint8)
    lb,n=ndi.label(m)
    if n:
        area=np.bincount(lb.ravel())
        good=np.zeros(n+1,bool)
        good[1:]=(area[1:]>=3)&(area[1:]<=max_area_6mp)
        m=good[lb].astype(np.uint8)
    m=cv2.dilate(m,np.ones((3,3),np.uint8))
    m=(cv2.resize(m,(w,h),interpolation=cv2.INTER_NEAREST) if ref>1 else m)*255
    k=max(5,int(4*ref)|1)
    medc=cv2.merge([cv2.medianBlur(img[...,c],k) for c in range(3)])
    out=img.copy(); out[m>0]=medc[m>0]
    return transplant_grain(out,m,(exclude==0).astype(np.uint8),seed),m

def blotch_pass(img, kscales=(31,61), bright=3.0, dark=4.0, flat_lim=10,
                min_area=60, max_area=40000, iters=3, seed=23):
    """Soft mid-scale blotches on flat areas: too big for the speck pass, too
    faint for the blob pass. Detect against wide medians, fill from the same
    median, wear the film's own grain. Iterates until nothing is found."""
    total=None
    for it in range(iters):
        g=cv2.cvtColor(img,cv2.COLOR_BGR2GRAY)
        h,w=g.shape; scale=max(1.0,np.sqrt(h*w/6e6))
        flat=flatzone(g,flat_lim)
        if total is None: total=np.zeros((h,w),np.uint8)
        found=np.zeros((h,w),np.uint8)
        for k0 in kscales:
            k=int(k0*scale)|1
            med=cv2.medianBlur(g,k)
            d=g.astype(np.float32)-cv2.GaussianBlur(med.astype(np.float32),(0,0),3)
            m=(((d>bright)|(d<-dark))&(flat>0)).astype(np.uint8)
            m=cv2.morphologyEx(m,cv2.MORPH_CLOSE,np.ones((9,9),np.uint8))
            lb,n=ndi.label(m)
            if n:
                area=np.bincount(lb.ravel())
                good=np.zeros(n+1,bool)
                good[1:]=(area[1:]>=min_area*scale*scale)&(area[1:]<=max_area*scale*scale)
                m=good[lb].astype(np.uint8)
            m=cv2.dilate(m,np.ones((7,7),np.uint8))
            if m.any():
                medc=cv2.merge([cv2.medianBlur(img[...,c],k) for c in range(3)])
                sel=(m>0)&(found==0)
                img=img.copy(); img[sel]=medc[sel]
                found|=m
        if not found.any(): break
        img=transplant_grain(img,found*255,flat,seed+it)
        total|=found
    return img,total*255

def flatten_flat(img, flat_lim=10, K0=101, seed=41):
    """Reconstruction of flat zones: out = large-scale base + clean grain.
    Mid-frequency content (= every blotch, pinhole halo, mottle) is dropped
    wholesale inside the flat gate; gradients and grain survive; nothing
    outside the gate is touched."""
    g=cv2.cvtColor(img,cv2.COLOR_BGR2GRAY)
    h,w=g.shape; scale=max(1.0,np.sqrt(h*w/6e6))
    flat=flatzone(g,flat_lim)
    if not flat.any(): return img,flat
    K=int(K0*scale)|1
    base=cv2.medianBlur(g,K).astype(np.float32)
    base=cv2.GaussianBlur(base,(0,0),8)
    hp=g.astype(np.float32)-cv2.GaussianBlur(g.astype(np.float32),(0,0),1.2)
    sig=1.4826*np.median(np.abs(hp[flat>0]))          # robust grain sigma
    lim=2.5*max(sig,0.5)
    hp_clean=np.clip(hp,-lim,lim)
    outg=base+hp_clean
    delta=outg-g.astype(np.float32)
    feather=cv2.GaussianBlur((flat>0).astype(np.float32),(0,0),6)
    out=img.astype(np.float32)
    for c in range(3): out[...,c]+=delta*feather
    return np.clip(out,0,255).astype(np.uint8), flat
