"""Keyword search endpoint: phrase, NEAR, OR, prefix, title-filter, sort,
language filter, date range filter, hit counts, ranking, dedup."""


# ── Basic search ──────────────────────────────────────────

def test_single_word_returns_ranked_events(app_client):
    r = app_client.get("/api/search?q=meditation")
    assert r.status_code == 200
    data = r.json()
    assert data["total"] >= 1
    titles = [e["title"] for e in data["events"]]
    assert any("Meditation" in t for t in titles)
    assert data["events"][0]["hits"]
    assert "content" in data["events"][0]["hits"][0]


def test_exact_phrase(app_client):
    r = app_client.get('/api/search?q="become silent"')
    assert r.status_code == 200
    evs = r.json()["events"]
    assert any("Become silent" in h["content"] for e in evs for h in e["hits"])


def test_near_operator(app_client):
    r = app_client.get("/api/search?q=NEAR(silence awareness)")
    assert r.status_code == 200
    assert r.json()["total"] >= 1


def test_or_operator(app_client):
    r = app_client.get("/api/search?q=zen OR tantra")
    assert r.status_code == 200
    titles = [e["title"] for e in r.json()["events"]]
    assert any("Zen" in t for t in titles) or any("Tantra" in t for t in titles)


def test_prefix_wildcard(app_client):
    r = app_client.get("/api/search?q=silenc*")
    assert r.status_code == 200
    assert r.json()["total"] >= 1


def test_title_filter(app_client):
    r = app_client.get("/api/search?q=title:vigyan")
    assert r.status_code == 200
    titles = [e["title"] for e in r.json()["events"]]
    assert titles and all("Vigyan" in t for t in titles)


def test_sort_by_title(app_client):
    r = app_client.get("/api/search?q=meditation&sort=title")
    assert r.status_code == 200
    titles = [e["title"] for e in r.json()["events"]]
    assert titles == sorted(titles, key=str.lower)


def test_invalid_query_returns_400(app_client):
    r = app_client.get("/api/search?q=%22unclosed")
    assert r.status_code == 400


# ── Total hits & hit count per event ─────────────────────

def test_response_includes_total_hits(app_client):
    r = app_client.get("/api/search?q=meditation")
    data = r.json()
    assert "total_hits" in data
    assert data["total_hits"] >= data["total"]


def test_event_includes_hit_count(app_client):
    r = app_client.get("/api/search?q=meditation")
    data = r.json()
    for ev in data["events"]:
        assert "hit_count" in ev
        assert ev["hit_count"] >= 1
        assert ev["hit_count"] >= len(ev["hits"])


# ── Ranking: more hits → higher rank ─────────────────────

def test_nietzsche_ranking_favors_more_hits(app_client):
    """Light on the Path has 4+ Nietzsche paragraphs, The Messiah has 1.
    The event with more hits should rank higher (appear first)."""
    r = app_client.get("/api/search?q=Nietzsche")
    assert r.status_code == 200
    data = r.json()
    titles = [e["title"] for e in data["events"]]
    assert "Light on the Path ~ 29" in titles
    assert "The Messiah Vol 1 ~ 15" in titles
    lop_idx = titles.index("Light on the Path ~ 29")
    mes_idx = titles.index("The Messiah Vol 1 ~ 15")
    assert lop_idx < mes_idx, (
        f"Light on the Path (more Nietzsche hits) should rank above The Messiah, "
        f"but got positions {lop_idx} vs {mes_idx}"
    )


def test_nietzsche_hit_counts(app_client):
    """Verify hit counts reflect actual paragraph matches."""
    r = app_client.get("/api/search?q=Nietzsche")
    data = r.json()
    ev_map = {e["title"]: e for e in data["events"]}
    lop = ev_map["Light on the Path ~ 29"]
    mes = ev_map["The Messiah Vol 1 ~ 15"]
    assert lop["hit_count"] > mes["hit_count"]


# ── Proximity search ─────────────────────────────────────

def test_politicians_mafia_proximity(app_client):
    """'politicians mafia' within 30 words should find both events."""
    r = app_client.get("/api/search?q=NEAR(politicians mafia, 30)")
    assert r.status_code == 200
    data = r.json()
    assert data["total"] >= 2, (
        f"Expected ≥2 events for 'politicians mafia' NEAR/30, got {data['total']}"
    )


def test_politicians_mafia_cross_paragraph_match(app_client):
    """When the two terms straddle a paragraph break but are within
    `near_dist` actual tokens of each other, the discourse should still
    match — FTS5's in-row NEAR cannot find this on its own.

    e2 has 'politicians' at the tail of seq 4 and 'mafia' at the head of
    seq 5; neither paragraph contains both words, so this event is only
    reachable via the cross-paragraph augmentation."""
    r = app_client.get("/api/search?q=NEAR(politicians mafia, 30)")
    data = r.json()
    titles = [e["title"] for e in data["events"]]
    assert "The Mustard Seed ~ 04" in titles, (
        "Cross-paragraph NEAR match should be returned via augmentation"
    )
    # p1 has both words in the same paragraph — FTS5 must still find it.
    assert "Light on the Path ~ 29" in titles


def test_politicians_mafia_cross_paragraph_no_false_positive(app_client):
    """A discourse where both words exist in adjacent paragraphs but are
    far apart in *tokens* must NOT match a tight NEAR. Regression guard
    for the old paragraph-index heuristic (commit 8c69841)."""
    r = app_client.get("/api/search?q=NEAR(politicians mafia, 30)")
    data = r.json()
    titles = [e["title"] for e in data["events"]]
    assert "Zen: The Quantum Leap ~ 02" not in titles, (
        "Discourse with both words in adjacent paragraphs but far apart "
        "in token distance should not match NEAR/30"
    )


def test_near_tight_distance_filters(app_client):
    """Distance 0 (adjacent) should be more restrictive."""
    r = app_client.get("/api/search?q=NEAR(politicians mafia, 0)")
    assert r.status_code == 200


# ── Hindi / Devanagari search ────────────────────────────

def test_hindi_exact_phrase(app_client):
    r = app_client.get('/api/search?q="नहीं वह तो ठीक"')
    assert r.status_code == 200
    data = r.json()
    assert data["total"] >= 1
    # Should match only once (Dekh Kabira Roya ~ 17), no duplicates
    event_ids = [e["event_id"] for e in data["events"]]
    assert len(event_ids) == len(set(event_ids)), "Duplicate event IDs in results"


def test_hindi_exact_phrase_no_duplicates(app_client):
    """The same event should not appear twice in results."""
    r = app_client.get('/api/search?q="नहीं वह तो ठीक"')
    data = r.json()
    titles = [e["title"] for e in data["events"]]
    for t in set(titles):
        count = titles.count(t)
        assert count == 1, f"Event '{t}' appears {count} times — expected exactly 1"


def test_hindi_all_words_search(app_client):
    """'धन धर्म विश्वास' in all-words mode should find Hindi events."""
    r = app_client.get("/api/search?q=धन धर्म विश्वास")
    assert r.status_code == 200
    data = r.json()
    assert data["total"] >= 2, (
        f"Expected ≥2 Hindi events for 'धन धर्म विश्वास', got {data['total']}"
    )


def test_hindi_phrase_correct_results(app_client):
    """Known phrase should return correct event."""
    r = app_client.get('/api/search?q="कहानियों से मुझे कुछ प्रेम है"')
    assert r.status_code == 200
    data = r.json()
    assert data["total"] >= 1
    titles = [e["title"] for e in data["events"]]
    assert any("Dekh Kabira Roya" in t for t in titles)


# ── Language filter ──────────────────────────────────────

def test_language_filter_hindi_only(app_client):
    """Filtering by Hindi should exclude English events."""
    r = app_client.get("/api/search?q=meditation&language=Hindi")
    assert r.status_code == 200
    data = r.json()
    # meditation is in English events, Hindi filter should find nothing or only Hindi
    for ev in data["events"]:
        assert ev.get("language") == "Hindi", (
            f"Expected only Hindi events, got"
            f" '{ev.get('language')}' for '{ev['title']}'"
        )


def test_language_filter_english_only(app_client):
    r = app_client.get("/api/search?q=Nietzsche&language=English")
    assert r.status_code == 200
    data = r.json()
    assert data["total"] >= 1
    for ev in data["events"]:
        assert ev.get("language") == "English"


def test_language_filter_no_match(app_client):
    """Hindi search term with English filter should return nothing from Hindi corpus."""
    r = app_client.get("/api/search?q=Nietzsche&language=Hindi")
    data = r.json()
    assert data["total"] == 0


# ── translated_from / Original filter ────────────────────

def test_original_filter_excludes_translations(app_client):
    """`original=true` excludes records whose translated_from points at
    another language. In seed data, t1 (The Path of Meditation) is an
    English translation of a Hindi original and the only translated row."""
    r = app_client.get("/api/search?q=meditation&original=true")
    data = r.json()
    titles = [e["title"] for e in data["events"]]
    assert "The Path of Meditation (Translation)" not in titles, (
        "Translated record leaked through the original=true filter"
    )
    # Originals matching "meditation" in their *content* should still
    # come through. e1 has "Meditation is not concentration…" in seq 1.
    # (Pre-PR #45 this assertion also passed by matching titles like
    # "A Course on Meditation"; since multi-word / single-word non-phrase
    # queries no longer match titles, we anchor on a content match.)
    assert "The Book of Secrets ~ 01" in titles


def test_original_filter_combines_with_language(app_client):
    """`original=true&language=English` returns only English originals —
    no Hindi-originated translations into English."""
    r = app_client.get(
        "/api/search?q=meditation&language=English&original=true"
    )
    data = r.json()
    for ev in data["events"]:
        assert ev["language"] == "English"
    titles = [e["title"] for e in data["events"]]
    assert "The Path of Meditation (Translation)" not in titles


def test_original_filter_default_off(app_client):
    """Without the original flag, translated records appear normally —
    guards against silently flipping the default."""
    r = app_client.get("/api/search?q=meditation")
    titles = [e["title"] for e in r.json()["events"]]
    assert "The Path of Meditation (Translation)" in titles


# ── Title-exclusion for multi-word search (Sugit 2026-05-16) ─

def test_multi_word_search_excludes_title_only_matches(app_client):
    """A bag-of-words search for "Satyam Shivam" should NOT include the
    `Satyam Shivam Sundaram ~ NN` series via title match — only via
    content. Sugit's report: "It is including the title of the
    discourses also … getting all the titles does not give the
    results one is wanting to find." """
    r = app_client.get("/api/search?q=Satyam Shivam")
    titles = [e["title"] for e in r.json()["events"]]
    assert "Satyam Shivam Sundaram ~ 01" not in titles
    assert "Satyam Shivam Sundaram ~ 02" not in titles


def test_near_search_excludes_title_only_matches(app_client):
    """Same exclusion for NEAR queries."""
    r = app_client.get("/api/search?q=NEAR(Satyam Shivam, 30)")
    titles = [e["title"] for e in r.json()["events"]]
    assert "Satyam Shivam Sundaram ~ 01" not in titles


def test_apostrophe_all_words_does_not_crash(app_client):
    """#4 (Sugit 2026-05-31): a bare apostrophe in a bag-of-words query
    used to return "Invalid search syntax" (FTS5 `syntax error near '`).
    It must now return 200 and find the discourse whose content has the
    phrase."""
    r = app_client.get("/api/search?q=a new vision of women's liberation")
    assert r.status_code == 200, r.text
    titles = [e["title"] for e in r.json()["events"]]
    assert "The Mustard Seed ~ 04" in titles  # event e2, the apostrophe paragraph


def test_all_apostrophe_query_is_empty_not_crash(app_client):
    """An edge case of the #4 fix: a query that is nothing but apostrophes
    must not crash FTS5 with `syntax error near ")"`. It collapses to an
    empty query → graceful 400 'Empty query.', never a 500/syntax error."""
    r = app_client.get("/api/search?q='")
    assert r.status_code == 400
    assert "Empty query" in r.json().get("detail", "")


def test_apostrophe_phrase_still_works(app_client):
    """The quoted-phrase form already worked (FTS5 accepts an apostrophe
    inside a string) — guard that the #4 fix didn't change it. Assert it
    still *finds* the discourse, not merely that it returns 200, so a
    regression that drops the phrase match is caught."""
    r = app_client.get('/api/search?q="women\'s liberation"')
    assert r.status_code == 200, r.text
    titles = [e["title"] for e in r.json()["events"]]
    assert "The Mustard Seed ~ 04" in titles


def test_hindi_or_expanded_query_parses(app_client):
    """#5 (Sugit 2026-05-31): the frontend's Stemmed-mode Hindi OR-expansion
    emits group-AND-group, e.g. `(अनंत OR अनन्त) AND (मौन OR मौं)`. The
    *broken* (space-joined) form `(a OR b) (c OR d)` crashed FTS5 with
    `syntax error near "("`; the *fixed* AND-joined form must parse. We
    assert the real group-AND-group shape the frontend produces returns
    200, and (as a negative control of the regression boundary) that the
    space-joined shape would still error."""
    # The fixed shape buildHindiFtsQuery now emits — group AND group:
    r = app_client.get("/api/search?q=(अनंत OR अनन्त) AND (मौन OR मौं)")
    assert r.status_code == 200, r.text
    # Negative control: the broken space-joined shape still errors, proving
    # the AND-join is load-bearing (not that any query happens to pass).
    r_bad = app_client.get("/api/search?q=(अनंत OR अनन्त) (मौन OR मौं)")
    assert r_bad.status_code == 400


def test_phrase_search_still_matches_titles(app_client):
    """Phrase mode is the explicit "find me anywhere" mode, including
    titles — this is how a user looks up a series by name."""
    r = app_client.get('/api/search?q="Satyam Shivam"')
    titles = [e["title"] for e in r.json()["events"]]
    assert "Satyam Shivam Sundaram ~ 01" in titles
    assert "Satyam Shivam Sundaram ~ 02" in titles


def test_explicit_title_filter_still_works(app_client):
    """The `title:` shortcut is unaffected — it remains the way to
    deliberately search the title column."""
    r = app_client.get("/api/search?q=title:Satyam")
    titles = [e["title"] for e in r.json()["events"]]
    assert "Satyam Shivam Sundaram ~ 01" in titles


def test_multiword_still_finds_content_matches(app_client):
    """Sanity: the title-exclusion fix doesn't break ordinary searches.
    "techniques meditation" appears in e3's content; the search must
    still return it."""
    r = app_client.get("/api/search?q=techniques meditation")
    titles = [e["title"] for e in r.json()["events"]]
    assert "Vigyan Bhairav Tantra ~ 12" in titles


# ── Stemmed vs exact (Sugit 2026-05-16) ──────────────────

def test_stemmed_default_matches_inflections(app_client):
    """Default search applies porter stemming — searching for "teach"
    finds the paragraph that only contains "teaching"."""
    r = app_client.get("/api/search?q=teach")
    titles = [e["title"] for e in r.json()["events"]]
    # e1 has the "teaching of the masters" seed paragraph.
    assert "The Book of Secrets ~ 01" in titles


def test_exact_skips_inflections(app_client):
    """Same query with exact=true should NOT match "teaching" because
    the un-stemmed index treats them as different tokens."""
    r = app_client.get("/api/search?q=teach&exact=true")
    titles = [e["title"] for e in r.json()["events"]]
    assert "The Book of Secrets ~ 01" not in titles


def test_exact_still_finds_literal_word(app_client):
    """Exact mode is *narrower*, not broken — searching for "teaching"
    in exact mode still finds the paragraph with "teaching"."""
    r = app_client.get("/api/search?q=teaching&exact=true")
    titles = [e["title"] for e in r.json()["events"]]
    assert "The Book of Secrets ~ 01" in titles


def test_stemmed_collapses_hindi_anusvara_variants(app_client):
    """Default (normalised) index treats nasal+virama and anusvara as the
    same token. h1 has 'अनन्त' and h2 has 'अनंत'; a query for either
    spelling returns both."""
    for q in ("अनन्त", "अनंत"):
        r = app_client.get(f"/api/search?q={q}")
        titles = [e["title"] for e in r.json()["events"]]
        assert "Dekh Kabira Roya ~ 17" in titles, f"{q!r} missed h1"
        assert "Dhammapada ~ 03" in titles, f"{q!r} missed h2"


def test_exact_keeps_hindi_anusvara_variants_distinct(app_client):
    """With exact=true the two spellings index as different tokens."""
    r = app_client.get("/api/search?q=अनन्त&exact=true")
    titles = [e["title"] for e in r.json()["events"]]
    assert "Dekh Kabira Roya ~ 17" in titles
    assert "Dhammapada ~ 03" not in titles, (
        "Exact 'अनन्त' should not match the paragraph spelled 'अनंत'"
    )


# ── Date range filter ────────────────────────────────────

def test_date_from_filter(app_client):
    """date_from=1985 should exclude pre-1985 events."""
    r = app_client.get("/api/search?q=Nietzsche&date_from=1985")
    assert r.status_code == 200
    data = r.json()
    for ev in data["events"]:
        assert ev["date"] >= "1985", f"Event '{ev['title']}' date {ev['date']} < 1985"


def test_date_to_filter(app_client):
    """date_to=1980 should exclude post-1980 events."""
    r = app_client.get("/api/search?q=meditation&date_to=1980")
    assert r.status_code == 200
    data = r.json()
    for ev in data["events"]:
        assert ev["date"] <= "1980-12-31", (
            f"Event '{ev['title']}' date {ev['date']} > 1980"
        )


def test_date_range_combined(app_client):
    r = app_client.get("/api/search?q=meditation&date_from=1984&date_to=1989")
    assert r.status_code == 200
    data = r.json()
    for ev in data["events"]:
        year = ev["date"][:4]
        assert 1984 <= int(year) <= 1989


# ── Multi-year archivist dates (Sugit 2026-05-27) ────────────────────


def _titles(r):
    return [ev["title"] for ev in r.json()["events"]]


# ── Multi-word NEAR cross-paragraph (Sugit 2026-05-31) ──────────────


def test_three_word_near_finds_cross_paragraph_match(app_client):
    """`enlightenment trust love` within 20 must find the case where the
    three words straddle a paragraph break — exactly what FTS5's in-row
    NEAR misses and the 2-word-only augmentation refused to handle."""
    r = app_client.get(
        "/api/search?q=NEAR(enlightenment%20trust%20love%2C%2020)"
    )
    assert r.status_code == 200
    titles = [ev["title"] for ev in r.json()["events"]]
    # The seed parks the three words across p2's paragraphs 30 and 31.
    assert "The Messiah Vol 1 ~ 15" in titles


def test_three_word_near_respects_distance(app_client):
    """The same trio at a very tight distance must NOT match — the
    augmentation has to honour the user's `near_dist`, not just find
    'words exist in adjacent paragraphs'."""
    r = app_client.get(
        "/api/search?q=NEAR(enlightenment%20trust%20love%2C%202)"
    )
    assert r.status_code == 200
    titles = [ev["title"] for ev in r.json()["events"]]
    assert "The Messiah Vol 1 ~ 15" not in titles


# ── Record-level All-words / Within-N (OCTP semantics) ───────────────


def test_all_words_matches_across_paragraphs(app_client):
    """#7 — All-words is RECORD-level: a discourse with the three query
    words in three DIFFERENT paragraphs must match. FTS5's per-row AND
    cannot find this; record-level matching must. bd1 (The Buddha Disease
    ~ 14) seeds love / intelligence / awareness in seqs 1 / 5 / 9."""
    r = app_client.get("/api/search?q=love intelligence awareness")
    assert r.status_code == 200
    titles = [e["title"] for e in r.json()["events"]]
    assert "The Buddha Disease ~ 14" in titles


def test_record_level_ignores_meta_only_matches(app_client):
    """Record-level All-words must NOT count a discourse that contains the
    query words ONLY in a metadata paragraph (title row / "event page in
    sannyas.wiki" marker). e3 (Vigyan) has "page"/"sannyas" only in its
    seq-2 meta paragraph, so `page sannyas` must return 0 discourses and 0
    hits — not 1 discourse with an empty snippet (the bug where the
    intersection counted meta matches while the display filtered them)."""
    r = app_client.get("/api/search?q=page sannyas")
    assert r.status_code == 200
    data = r.json()
    assert data["total"] == 0
    assert data["total_hits"] == 0


def test_within_n_is_subset_of_all_words(app_client):
    """#6 — Within-N events and total_hits must each be a (non-strict)
    subset of the All-words results for the same query. This is the
    regression lock that keeps Within-N from over-reporting more than
    All-words ever could."""
    allw = app_client.get("/api/search?q=love intelligence awareness").json()
    near = app_client.get(
        "/api/search?q=NEAR(love%20intelligence%20awareness%2C%20100)"
    ).json()
    assert near["total"] <= allw["total"], (
        f"Within-100 total {near['total']} > All-words total {allw['total']}"
    )
    assert near["total_hits"] <= allw["total_hits"], (
        f"Within-100 total_hits {near['total_hits']} > "
        f"All-words total_hits {allw['total_hits']}"
    )


def test_within_n_total_is_windowed_not_all_words(app_client):
    """Regression for the 2026-05-31 NEAR-counting bug: Within-N's `total`
    must be the number of discourses that PASSED the proximity window, not
    the All-words intersection (records containing the words anywhere).
    `love intelligence awareness` All-words finds bd1; the same trio
    Within-2 is far too tight to match, so Within-2 total must be 0 even
    though the All-words total is >= 1."""
    allw = app_client.get("/api/search?q=love intelligence awareness").json()
    tight = app_client.get(
        "/api/search?q=NEAR(love%20intelligence%20awareness%2C%202)"
    ).json()
    assert allw["total"] >= 1
    assert tight["total"] == 0, (
        f"Within-2 should match nothing but reported total={tight['total']} "
        "— NEAR is leaking the All-words intersection count again."
    )
    assert tight["total_hits"] == 0


def test_within_n_counts_one_passage_per_discourse(app_client):
    """Within-N reports one hit per qualifying discourse (the proximity
    passage), so total == total_hits and every returned event has
    hit_count == 1 — this is what makes the prod numbers match OCTP
    (politicians/mafia → 2, enlightenment/trust/love → 5)."""
    d = app_client.get("/api/search?q=NEAR(politicians%20mafia%2C%2030)").json()
    assert d["total"] == d["total_hits"]
    assert d["total"] >= 1
    for ev in d["events"]:
        assert ev["hit_count"] == 1


def test_within_n_exact_cross_paragraph(app_client):
    """#2 — Within-N exact-mode finds a match whose words straddle a
    paragraph break (record-level token span), and respects the distance:
    found at a generous N, NOT found at N=1. n2 (The Long Pilgrimage ~ 07)
    seeds alpha / bravo / charlie across the seq 10/11 break (span = 8)."""
    found = app_client.get(
        "/api/search?q=NEAR(alpha%20bravo%20charlie%2C%2020)&exact=true"
    ).json()
    assert "The Long Pilgrimage ~ 07" in [e["title"] for e in found["events"]]

    tight = app_client.get(
        "/api/search?q=NEAR(alpha%20bravo%20charlie%2C%201)&exact=true"
    ).json()
    assert "The Long Pilgrimage ~ 07" not in [e["title"] for e in tight["events"]]


def test_phrase_equal_to_title_counts_only_content_hits(app_client):
    """#3 — A phrase that equals a discourse TITLE must NOT inflate the
    hit count to one-per-paragraph (the title rides on every paragraph's
    FTS row). wl1's title is the phrase but only TWO of its five
    paragraphs contain it; the reported hit_count must be 2, not 5."""
    r = app_client.get(
        '/api/search?q="a new vision of women\'s liberation"'
    )
    assert r.status_code == 200, r.text
    ev_map = {e["title"]: e for e in r.json()["events"]}
    wl = ev_map.get("A New Vision of Women's Liberation ~ 01")
    assert wl is not None, "discourse with the phrase in its title not returned"
    assert wl["hit_count"] == 2, (
        f"Expected 2 content hits (not one-per-paragraph), got {wl['hit_count']}"
    )


# ── Language code/name alias tolerance (Sugit 2026-05-31) ───────────


def test_language_filter_accepts_iso_code(app_client):
    """If the DB ever stored `en` instead of `English` (the 2026-05-31
    regression), passing `?language=English` must still match."""
    r = app_client.get("/api/search?q=meditation&language=English")
    assert r.status_code == 200
    assert r.json()["total"] > 0


def test_language_filter_accepts_full_name_when_db_has_codes(app_client):
    """And the symmetric case: passing `?language=en` must work too."""
    r = app_client.get("/api/search?q=meditation&language=en")
    assert r.status_code == 200
    assert r.json()["total"] > 0


# ── Multi-year date filter (existing tests below) ────────────────────


def test_multiyear_date_first_year_matches(app_client):
    """A `1971/1972 ?` record must come back when filtering by 1971."""
    r = app_client.get("/api/search?q=meditation&date_from=1971&date_to=1971")
    assert r.status_code == 200
    assert "The Dimensionless Dimension ~ 02" in _titles(r)


def test_multiyear_date_second_year_matches(app_client):
    """The "to" year on the right of `/` must match too."""
    r = app_client.get("/api/search?q=meditation&date_from=1972&date_to=1972")
    assert r.status_code == 200
    assert "The Dimensionless Dimension ~ 02" in _titles(r)


def test_multiyear_date_range_overlap_matches(app_client):
    """Any query range that overlaps the record's [first, last] years matches."""
    r = app_client.get("/api/search?q=meditation&date_from=1971&date_to=1972")
    assert "The Dimensionless Dimension ~ 02" in _titles(r)
    r = app_client.get("/api/search?q=meditation&date_from=1970&date_to=1973")
    assert "The Dimensionless Dimension ~ 02" in _titles(r)


def test_multiyear_date_outside_range_excluded(app_client):
    """A record covering 1971-1972 must NOT show up for a 1980-1985 filter."""
    r = app_client.get("/api/search?q=meditation&date_from=1980&date_to=1985")
    assert "The Dimensionless Dimension ~ 02" not in _titles(r)
    # And not for years strictly before either.
    r = app_client.get("/api/search?q=meditation&date_from=1960&date_to=1970")
    assert "The Dimensionless Dimension ~ 02" not in _titles(r)


def test_date_range_endpoint_includes_second_year_of_slash_date(app_client):
    """`/api/date-range` must report 1972 (not 1971) as the contributing
    upper bound for `1971/1972 ?`, so the UI slider can reach years the
    corpus actually covers."""
    r = app_client.get("/api/date-range")
    assert r.status_code == 200
    data = r.json()
    # The seed's overall max is 1989 (e5); we just need to confirm dd1's
    # 1972 doesn't get truncated to 1971 by the SUBSTR(date,1,4) shortcut.
    assert data["min_year"] is not None
    assert data["max_year"] is not None
    # min year in seed is 1971 (from "1971/1972 ?"); confirm it isn't lost.
    assert data["min_year"] == "1971"


# ── Shailendra text stripping ────────────────────────────

def test_shailendra_text_stripped_from_search_results(app_client):
    """'source: Shailendra's Hindi collection' should be stripped from content."""
    r = app_client.get("/api/search?q=प्रवचन महत्वपूर्ण")
    data = r.json()
    for ev in data["events"]:
        for hit in ev["hits"]:
            assert "Shailendra" not in hit["content"], (
                f"Shailendra text not stripped: {hit['content'][:100]}"
            )


def test_shailendra_text_stripped_from_discourse(app_client):
    """Full discourse should also have Shailendra text stripped."""
    r = app_client.get("/api/discourse?event_id=h3")
    assert r.status_code == 200
    data = r.json()
    for p in data["paragraphs"]:
        assert "Shailendra" not in p["content"], (
            f"Shailendra text not stripped in discourse: {p['content'][:100]}"
        )


# ── Metadata paragraph filtering ─────────────────────────

def test_seq_zero_excluded_from_hits(app_client):
    """Sequence 0 (title row) should not appear in display hits."""
    r = app_client.get("/api/search?q=vigyan")
    data = r.json()
    for ev in data["events"]:
        for hit in ev["hits"]:
            assert hit["sequence_number"] != 0, (
                f"Seq 0 (title row) should be filtered: "
                f"'{hit['content'][:60]}'"
            )


def test_sannyas_wiki_boilerplate_excluded(app_client):
    """'event page in sannyas.wiki:' boilerplate excluded from hits."""
    r = app_client.get("/api/search?q=vigyan")
    data = r.json()
    for ev in data["events"]:
        for hit in ev["hits"]:
            assert not hit["content"].lower().startswith(
                "event page in sannyas"
            ), (
                f"sannyas.wiki boilerplate in hits: "
                f"'{hit['content'][:60]}'"
            )


# ── Languages endpoint ───────────────────────────────────

def test_languages_endpoint(app_client):
    r = app_client.get("/api/languages")
    assert r.status_code == 200
    langs = r.json()["languages"]
    assert "English" in langs
    assert "Hindi" in langs


# ── Date range endpoint ──────────────────────────────────

def test_date_range_endpoint(app_client):
    r = app_client.get("/api/date-range")
    assert r.status_code == 200
    data = r.json()
    assert data["min_year"] is not None
    assert data["max_year"] is not None
    assert int(data["min_year"]) <= int(data["max_year"])


# ── Discourse endpoint ───────────────────────────────────

def test_discourse_includes_language(app_client):
    r = app_client.get("/api/discourse?event_id=h1")
    assert r.status_code == 200
    data = r.json()
    assert data["event"]["language"] == "Hindi"


def test_discourse_by_title(app_client):
    r = app_client.get("/api/discourse?title=Zen: The Quantum Leap ~ 02")
    assert r.status_code == 200
    assert r.json()["event"]["title"] == "Zen: The Quantum Leap ~ 02"


def test_discourse_not_found(app_client):
    r = app_client.get("/api/discourse?event_id=nonexistent")
    assert r.status_code == 404


def test_discourse_near_highlights_only_window_paragraphs(app_client):
    """Bug 11b: NEAR query on the discourse endpoint must highlight only the
    paragraphs forming the proximity window, not every paragraph containing
    any of the search words.

    Seed event e2 has 'politicians' in seq 4 and 'mafia' in seq 5 — a
    cross-paragraph NEAR. FTS5's in-paragraph NEAR finds nothing; the
    _near_hl_for_discourse fallback must kick in and restrict hl to those two
    paragraphs.  The other paragraphs (seq 7: love/alchemy, seq 60:
    women's liberation) must NOT have hl markers.
    """
    r = app_client.get("/api/discourse?event_id=e2&q=NEAR(politicians mafia, 30)")
    assert r.status_code == 200
    paras = r.json()["paragraphs"]
    hl_seqs = [p["sequence_number"] for p in paras if p.get("hl")]
    assert set(hl_seqs) == {4, 5}, (
        f"Expected only the window paragraphs (seq 4,5) highlighted, got {hl_seqs}"
    )


def test_discourse_near_single_paragraph_highlights_correct(app_client):
    """When both NEAR words appear in the same paragraph, the standard FTS5
    NEAR highlight must be used — only that paragraph gets hl, not the whole
    discourse.

    Seed event p1 has 'politicians' and 'mafia' together in seq 20.  The
    Nietzsche paragraphs (seq 1, 3, 7, 12) must be unhighlighted.
    """
    r = app_client.get("/api/discourse?event_id=p1&q=NEAR(politicians mafia, 30)")
    assert r.status_code == 200
    paras = r.json()["paragraphs"]
    hl_seqs = [p["sequence_number"] for p in paras if p.get("hl")]
    assert hl_seqs == [20], (
        f"Expected only seq 20 highlighted, got {hl_seqs}"
    )
