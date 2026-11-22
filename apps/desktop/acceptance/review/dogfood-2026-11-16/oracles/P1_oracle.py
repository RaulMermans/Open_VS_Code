import os, sys, unittest, urllib.error
from unittest.mock import patch
sys.path.insert(0, os.path.join(sys.argv[1], "src"))
from reeprov_client import ReeprovClient

def delays(**kwargs):
    slept = []
    client = ReeprovClient(ingest_key="k", max_retries=2, **kwargs)
    with patch("urllib.request.urlopen", side_effect=urllib.error.URLError("down")), patch("time.sleep", side_effect=slept.append):
        client._post("/x", {})
    return [round(d, 6) for d in slept]

os.environ.pop("REEPROV_BACKOFF_BASE", None)
assert delays() == [0.05, 0.1], delays()
assert delays(backoff_base=0.1) == [0.1, 0.2], delays(backoff_base=0.1)
os.environ["REEPROV_BACKOFF_BASE"] = "0.2"
assert delays() == [0.2, 0.4], delays()
assert delays(backoff_base=0.1) == [0.1, 0.2], "explicit argument wins over the environment"
print("P1 oracle OK")
