"""Keyword search endpoint: phrase, NEAR, OR, prefix, title-filter, sort."""


def test_single_word_returns_ranked_events(app_client):
    r = app_client.get("/api/search?q=meditation")
    assert r.status_code == 200
    data = r.json()
    assert data["total"] >= 1
    titles = [e["title"] for e in data["events"]]
    assert any("Meditation" in t for t in titles)
    # Each event carries at least one paragraph hit with highlighted-able content
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
    # Covers both "silent" and "silence" via the stemmed prefix.
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
