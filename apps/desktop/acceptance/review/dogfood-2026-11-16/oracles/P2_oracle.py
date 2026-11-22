import os, sys
sys.path.insert(0, os.path.join(sys.argv[1], "src"))
from reeprov_client.canonical import canonical_json
assert canonical_json(1.0) == "1", canonical_json(1.0)
assert canonical_json({"b": 2.0, "a": [1.5, 3.0]}) == '{"a":[1.5,3],"b":2}', canonical_json({"b": 2.0, "a": [1.5, 3.0]})
assert canonical_json(1e22) == "1e+22", canonical_json(1e22)
print("P2 oracle OK")
