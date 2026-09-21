"""Preview the built site with correct JavaScript module MIME types on Windows."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

class Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm"}

if __name__ == "__main__":
    root = Path(__file__).resolve().parents[1] / "_site"
    if not (root / "index.html").exists():
        raise SystemExit("Build first: python site/build.py")
    print("SH Notes preview: http://127.0.0.1:4318", flush=True)
    ThreadingHTTPServer(("127.0.0.1", 4318), partial(Handler, directory=str(root))).serve_forever()
