"""Compare a longer search on the exact persisted dispatch snapshot."""
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path.cwd()))
from fastapi.testclient import TestClient
from app.main import app

def main():
    root = Path("benchmarks/ui_dispatch_quality_20261118")
    payload = json.loads((root / "input.json").read_text(encoding="utf-8"))
    payload["search_time_seconds"] = 60
    payload["max_time_seconds"] = 120
    started = time.perf_counter()
    response = TestClient(app, raise_server_exceptions=False).post("/optimize-fleet/candidates", json=payload)
    record = dict(search_seconds=60, elapsed_seconds=time.perf_counter()-started, http_status=response.status_code,
                  response=response.json() if response.status_code == 200 else response.text)
    (root / "search_60s.json").write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
    print("SAVED", response.status_code, record["elapsed_seconds"], flush=True)

if __name__ == "__main__":
    main()
