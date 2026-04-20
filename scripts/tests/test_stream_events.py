"""O2 gate: /stream emits event:wisdom chunks, event:citation entries, and a final event:retrieved id list."""


def _parse_sse(raw: str):
    events = []
    for block in raw.strip().split("\n\n"):
        if not block.strip():
            continue
        evt = {"event": None, "data": None}
        for line in block.splitlines():
            if line.startswith("event:"):
                evt["event"] = line.split(":", 1)[1].strip()
            elif line.startswith("data:"):
                evt["data"] = line.split(":", 1)[1].strip()
        events.append(evt)
    return events


def test_stream_emits_wisdom_and_citation_events(app_client):
    with app_client.stream("POST", "/stream", json={"query": "what is meditation?"}) as resp:
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")
        body = b"".join(resp.iter_bytes()).decode("utf-8")

    events = _parse_sse(body)
    kinds = [e["event"] for e in events]

    assert "wisdom" in kinds, f"no wisdom event in stream: {kinds}"
    assert "citation" in kinds, f"no citation event in stream: {kinds}"
    assert "retrieved" in kinds, f"no retrieved event in stream: {kinds}"
    assert kinds[-1] == "done", f"last event should be done, got {kinds[-1]}"

    wisdom_chunks = [e for e in events if e["event"] == "wisdom"]
    assert len(wisdom_chunks) >= 1

    citations = [e for e in events if e["event"] == "citation"]
    assert len(citations) >= 1
    import json
    first = json.loads(citations[0]["data"])
    for key in ("title", "date", "location"):
        assert key in first


def test_stream_citations_are_deduped(app_client):
    with app_client.stream("POST", "/stream", json={"query": "love"}) as resp:
        body = b"".join(resp.iter_bytes()).decode("utf-8")
    events = _parse_sse(body)
    import json
    cites = [json.loads(e["data"]) for e in events if e["event"] == "citation"]
    titles = [c["title"] for c in cites]
    assert len(titles) == len(set(titles)), "citations should be deduped by (title,date)"
