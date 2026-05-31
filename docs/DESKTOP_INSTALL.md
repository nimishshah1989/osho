# Installing Osho Archives on your computer

The desktop app contains the **entire archive inside it** — every discourse,
fully searchable, in English and Hindi. Once installed it works **completely
offline**: no internet needed, ever, after the first setup.

There are two files. Download the one for your computer:

| Your computer | File to download |
|---|---|
| **Mac** (MacBook, iMac) | `Osho Archives-1.0.0.dmg` |
| **Windows** (PC, laptop) | `Osho Archives Setup 1.0.0.exe` |

The file is large (about **600 MB**) because the whole archive travels inside
it. Let it download fully before opening.

---

## One thing to expect first

This app is **not yet signed** with a paid Apple/Microsoft certificate, so the
first time you open it your computer shows a safety warning. **This is normal**
— it appears for any app that isn't bought from the Apple or Microsoft store.
The steps below get you past it in a few seconds. You only do this **once**.

---

## On a Mac

1. Double-click the downloaded **`.dmg`** file.
2. A window opens — drag the **Osho Archives** icon onto the **Applications**
   folder shown beside it.
3. Open **Applications** and double-click **Osho Archives**.
4. You'll see one of two warnings — follow whichever applies:

### 4a. *"Osho Archives is damaged and can't be opened. You should move it to the Trash."*

This is the prompt you'll most likely see on a recent Mac (especially Apple
Silicon — M1, M2, M3). The app is **not** damaged — macOS marks every app
downloaded via a browser with a "downloaded from the internet" flag, and on
unsigned apps it shows this stronger warning instead of the friendlier
"unidentified developer" one. You bypass it once and then it opens normally
forever after.

- Click **Cancel** (do **not** click "Move to Trash").
- Open the **Terminal** app (Spotlight: ⌘-Space, type *Terminal*, press Enter).
- Copy and paste this line exactly, then press Enter:

  ```
  xattr -dr com.apple.quarantine "/Applications/Osho Archives.app"
  ```

- Now double-click **Osho Archives** in your Applications folder. It opens.

### 4b. *"Apple could not verify Osho Archives is free of malware."*

If you see this milder prompt instead:

- Click **Done** (do not click "Move to Trash").
- Open **System Settings → Privacy & Security**. Scroll down — you'll see a
  line that says *"Osho Archives was blocked"* with an **Open Anyway** button.
  Click **Open Anyway**.
- Confirm **Open Anyway** once more, and enter your Mac password if asked.

That's it. From now on it opens normally with a double-click, like any app.

> On the very first launch the app spends a minute or two unpacking the
> archive onto your Mac — you'll see a "Setting up…" screen. Let it finish.
> After that, every launch is instant and works with the internet off.

---

## On Windows

1. Double-click the downloaded **`.exe`** file.
2. Windows may show a blue box: *"Windows protected your PC"*.
   Click the small **More info** link inside it.
3. A **Run anyway** button appears — click it.
4. The installer runs; follow the prompts (just keep clicking next/install).
5. Launch **Osho Archives** from the Start menu or desktop shortcut.

> On the very first launch the app spends a minute or two unpacking the
> archive onto your PC — you'll see a "Setting up…" screen. Let it finish.
> After that, every launch is instant and works with the internet off.

---

## Frequently asked

**Is the warning a sign something is wrong?**
No. It only means the app wasn't purchased through the official app stores.
The steps above are the standard way to open any independent app.

**Do I need internet?**
Only for the one-time download. After the "Setting up…" screen finishes the
first time, the app works fully offline forever.

**How much space does it use?**
About 600 MB for the installer, and roughly 2 GB once the archive is unpacked
inside the app.

**How do I update to a newer archive?**
Download the newest installer when we share it and install over the top — your
old copy is replaced. (Automatic updates may come later.)

**It still won't open / I'm stuck.**
Write to us and tell us exactly what the screen says — we'll walk you through it.
