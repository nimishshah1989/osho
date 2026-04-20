"""Hierarchy endpoint + engine-status gate."""


def test_hierarchy_shape(app_client):
    r = app_client.get("/hierarchy")
    assert r.status_code == 200
    tree = r.json()
    assert isinstance(tree, dict)
    # Seeded fixture has events from 1973, 1974, 1984, 1988, 1989
    assert "1973" in tree or "1974" in tree
    sample_year = next(y for y in tree if y.isdigit())
    assert isinstance(tree[sample_year], dict)
    sample_series = next(iter(tree[sample_year]))
    assert isinstance(tree[sample_year][sample_series], list)
    # Each leaf is a string talk title
    assert all(isinstance(t, str) for t in tree[sample_year][sample_series])


def test_hierarchy_series_extraction(app_client):
    r = app_client.get("/hierarchy")
    tree = r.json()
    # "The Book of Secrets ~ 01" should be grouped under series "The Book of Secrets"
    found = False
    for year, series_map in tree.items():
        if "The Book of Secrets" in series_map:
            assert any("~ 01" in t for t in series_map["The Book of Secrets"])
            found = True
    assert found, f"expected series 'The Book of Secrets' in tree, got {list(tree)}"


def test_engine_status(app_client):
    r = app_client.get("/api/engine-status")
    assert r.status_code == 200
    data = r.json()
    for key in ("google_key_present", "openrouter_key_present", "searcher_warm"):
        assert key in data
        assert isinstance(data[key], bool)
