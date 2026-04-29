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
