"""O4 gate: /api/clusters returns named clusters per lens; /api/particle/{id} returns content + context."""


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
    # At least one valid era name present
    assert any(n in {"Bombay", "Poona I", "Rajneeshpuram", "Poona II"} for n in names)


def test_clusters_geography_uses_location(app_client):
    r = app_client.get("/api/clusters?lens=geography")
    assert r.status_code == 200
    names = [c["name"] for c in r.json()["clusters"]]
    assert "Pune" in names or "Poona" in names or "Oregon" in names


def test_particle_returns_content_and_context(app_client):
    r = app_client.get("/api/particle/1")
    assert r.status_code == 200
    data = r.json()
    assert data["id"] == 1
    assert data["content"].startswith("Meditation")
    assert data["event"]["title"].startswith("The Book of Secrets")
    assert isinstance(data["context"], list)
    assert len(data["context"]) >= 1


def test_particle_404(app_client):
    r = app_client.get("/api/particle/9999")
    assert r.status_code == 404
