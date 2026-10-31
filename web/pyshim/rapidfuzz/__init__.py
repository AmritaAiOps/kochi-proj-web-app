"""Browser-only stand-in for rapidfuzz (no Pyodide build exists). Only
fuzz.ratio is used by the app; see fuzz.py. Never installed on the server/test
side -- there the real rapidfuzz is used."""
