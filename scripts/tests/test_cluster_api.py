"""Cluster + search endpoint coverage."""


def test_clusters_themes(app_client):
    r = app_client.get("/api/clusters?lens=themes&limit=20")
    assert r.status_code == 200
    payload = r.json()
    assert payload["lens"] == "themes"
    assert isinstance(payload["clusters"], list)
    assert len(payload["clusters"]) >= 1
    for c in payload["clusters"]:
        assert "name" in c and "size" in c and "color" in c
        assert c["color"].startswith("#")


def test_clusters_timeline_buckets_by_era(app_client):
    r = app_client.get("/api/clusters?lens=timeline")
    assert r.status_code == 200
    names = [c["name"] for c in r.json()["clusters"]]
    assert any(n in {"Bombay", "Poona I", "Rajneeshpuram", "Poona II"} for n in names)


def test_clusters_geography_uses_location(app_client):
    r = app_client.get("/api/clusters?lens=geography")
    assert r.status_code == 200
    names = [c["name"] for c in r.json()["clusters"]]
    assert "Pune" in names or "Poona" in names or "Oregon" in names
