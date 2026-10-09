from pathlib import Path


VERSION_FILE = Path(__file__).resolve().parents[2] / "VERSION"
PRODUCT_VERSION = VERSION_FILE.read_text(encoding="utf-8").strip()

if not PRODUCT_VERSION:
    raise RuntimeError("VERSION must not be empty")
