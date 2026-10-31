"""Single source of truth for where runtime files live. Everything is relative
to the project root: config/*.json, backend/data/*.json, the built frontend
(frontend/dist) and the default config/template all live in the repo.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

CONFIG_DIR = ROOT / "config"
DATA_DIR = ROOT / "backend" / "data"
FRONTEND_DIST = ROOT / "frontend" / "dist"

# Server-side scratch copy of each exported workbook; users get it as a browser download.
OUTPUT_DIR = ROOT / "data" / "outputs"


def build_output_path(report_date) -> Path:
    """The one place that decides where a Final Output workbook is written:
    OUTPUT_DIR/<Month YYYY>/Final Output - <dd-mm-yyyy>.xlsx. Re-running
    the same date overwrites that file rather than creating a duplicate."""
    month_dir = OUTPUT_DIR / report_date.strftime("%B %Y")
    month_dir.mkdir(parents=True, exist_ok=True)
    return month_dir / f"Final Output - {report_date.strftime('%d-%m-%Y')}.xlsx"


def ensure_runtime_files() -> None:
    """Create writable dirs."""
    for d in (CONFIG_DIR, DATA_DIR, OUTPUT_DIR):
        d.mkdir(parents=True, exist_ok=True)
