"""Bundle the Python backend + config into frontend/public/pyapp.zip, which the
browser's Pyodide worker unpacks to /app. Run from the repo root (npm run build
does this)."""
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "frontend" / "public" / "pyapp.zip"


def files():
    for path in (ROOT / "backend").rglob("*"):
        rel = path.relative_to(ROOT)
        if path.is_file() and "tests" not in rel.parts and "__pycache__" not in rel.parts and path.suffix in (".py", ".json"):
            yield path, rel
    for path in (ROOT / "config").glob("*"):
        if path.is_file() and path.name != "settings.json":
            yield path, path.relative_to(ROOT)
    shim = ROOT / "web" / "pyshim"
    for path in shim.rglob("*.py"):
        yield path, path.relative_to(shim)  # rapidfuzz/ at the archive root


if __name__ == "__main__":
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as zf:
        for path, rel in sorted(files()):
            zf.write(path, rel.as_posix())
    print(f"wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size // 1024} KB)")
