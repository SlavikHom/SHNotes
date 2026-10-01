"""Preview the built site with correct JavaScript module MIME types on Windows."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import argparse
from urllib.parse import urlsplit

class Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm"}
    prefix = "/"

    def do_GET(self):
        if not urlsplit(self.path).path.startswith(self.prefix):
            self.send_error(404)
            return
        super().do_GET()

    def translate_path(self, path):
        return super().translate_path("/" + path[len(self.prefix):] if path.startswith(self.prefix) else path)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=4318)
    parser.add_argument("--prefix", default="/")
    args = parser.parse_args()
    Handler.prefix = "/" + args.prefix.strip("/") + "/" if args.prefix.strip("/") else "/"
    root = Path(__file__).resolve().parents[1] / "_site"
    if not (root / "index.html").exists():
        raise SystemExit("Build first: python site/build.py")
    print(f"SH Notes preview: http://127.0.0.1:{args.port}{Handler.prefix}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", args.port), partial(Handler, directory=str(root))).serve_forever()
