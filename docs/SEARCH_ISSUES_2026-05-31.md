# Search issues — Sugit/Anuragi review (logged 2026-05-31)

Status legend: ⬜ open · 🔍 root-caused · 🛠️ fix in progress · ✅ fixed+verified-on-prod

Each issue records: the exact reproduction, the confirmed current behaviour on
oshoarchives.com, the root cause, the fix, and prod verification.

---

## #1 — Hindi UI + Lang=English returned nothing
**Status: ✅ fixed (PR #81, verified on prod 2026-05-31)** — Sugit confirmed.
Root cause: `events.language` held ISO codes (`en`/`hi`) not full names; filter
compared against `English`. Fixed with alias tolerance + data normalisation.

---

## #2 — Multi-word NEAR, EXACT spelling, misses cross-paragraph matches
Repro: `enlightenment trust love` Within 20, **Spelling=Exact**.
- OshoArchives: **2 discourses · 2 hits**. OCTP: **5**.
- Stemmed: 9 discourses · 11 hits, but Sugit reports those are all *within one
  paragraph* — i.e. the cross-paragraph augmentation isn't actually contributing.
Confirmed on prod: exact=1 → total=2; stemmed → total=9.
**Status: 🔍 (see Root cause: record-vs-paragraph, shared with #6/#7)**

---

## #3 — Title words inflate hit counts massively
Repro: `"a new vision of women's liberation"` Exact phrase.
- OshoArchives: **4 discourses · 156 hits**. Should be **4 · 8** (2 paras/disc).
- Same for any word that also appears in a title (roots, wings, satyam, shivam,
  sundaram, notes, madman…). Makes scrolling to real hits painful.
Confirmed on prod: total=4, total_hits=156.
**Status: 🔍** — the FTS row carries the discourse title on EVERY paragraph
(columns `title` / `title_search`), so a title match counts once per paragraph.

---

## #4 — Apostrophe / multi-word in All-words or NEAR → "Invalid search syntax"
Repro: `a new vision of women's liberation`, Match=All words (or Within N).
Confirmed on prod: returns `{"detail": ...}` non-result (Invalid search syntax).
**Status: 🔍** — the `'` in `women's` breaks the FTS5 MATCH grammar.

---

## #5 — Hindi + Spelling=Stemmed → "Invalid search syntax"
Repro: `परमात्मा की तरफ जिसे जाना`, All words.
- Exact: 18 discourses, 19 hits. Stemmed: "Invalid search syntax".
Suggestion from Sugit: if not fixable, disable Stemmed in the UI for Hindi input.
**Status: ⬜ to reproduce in-container**

---

## #6 — "Within 100 words" finds MORE hits than "All words"
Repro: `love intelligence awareness`.
- All words (exact): 26 (Sugit) / now 54 on prod. Within 100: 88 disc · 306
  (Sugit) / 320 disc · 1306 on prod. OCTP Within-100: 52 hits.
Logically All-words (anywhere in record) should be a superset of Within-100.
Confirmed on prod: All=54, Within100=320 — inverted.
**Status: 🔍 (record-vs-paragraph + augmentation over-count)**

---

## #7 — "All words" misses records whose words span paragraphs
Repro: `love intelligence awareness`, All words. OCTP (emulated via Within-10000)
finds 250 hits incl. *The Buddha Disease ~ 14*, which has all three words but is
NOT returned by OshoArchives.
Confirmed on prod: Buddha Disease ~ 14 absent from All-words results.
**Status: 🔍** — "All words" (FTS5 AND) matches within a single paragraph row;
OCTP treats it as all-words-anywhere-in-the-record.

---

## #8 — Left results list scrollbar not clamped to viewport
The left results column's scroll area has a fixed height taller than the window,
so the scroll handle runs off the bottom. The right matches pane behaves
correctly (resizes with the window).
**Status: ⬜ CSS — to locate the results-list container height rule**

---

## Cross-cutting root cause (#2, #6, #7)

The corpus is indexed one **FTS5 row per paragraph**. OCTP — the reference the
archivists compare against — treats All-words and Within-N as **record-level**
(the whole discourse). So:
- All-words misses records whose words are split across paragraphs (#7).
- Within-N's cross-paragraph augmentation is a partial patch (adjacent pairs
  only), inconsistent across exact/stemmed (#2), and its counting inflates
  totals beyond All-words (#6).
This is an architecture decision, not a one-line fix — see the plan section in
the PR / discussion before implementing.
