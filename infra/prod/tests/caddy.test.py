"""Runs the real Caddyfile in front of a fake API and checks the edge behaviour (D-02).

Needs a Caddy binary: CADDY_BIN=/path/to/caddy python3 infra/prod/tests/caddy.test.py
(skipped, loudly, when there is none; CI downloads one). Only two things are changed from the real
file, to run without Docker or TLS: the site address becomes a local plain-HTTP port, and the
upstream `api:4000` becomes the fake API on localhost.
"""
import gzip
import http.client
import json
import os
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

CADDY = os.environ.get("CADDY_BIN") or shutil.which("caddy")
PROD = Path(__file__).resolve().parent.parent
EDGE, UPSTREAM = 18080, 14000
WEB_ORIGIN = "https://web.example.test"


class FakeApi(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def do_GET(self):
        if self.path.startswith("/api/sse"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(b"retry: 3000\n\n")
            self.wfile.flush()
            time.sleep(2.0)  # a buffering proxy would hold the first bytes back this long
            self.wfile.write(b"event: x\ndata: late\n\n")
            self.wfile.flush()
            return
        body = json.dumps({"path": self.path, "headers": dict(self.headers), "pad": "x" * 4000}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Server", "fake-api/1.0")
        self.end_headers()
        self.wfile.write(body)


def wait_port(port, timeout=15):
    end = time.time() + timeout
    while time.time() < end:
        with socket.socket() as s:
            s.settimeout(0.3)
            if s.connect_ex(("127.0.0.1", port)) == 0:
                return True
        time.sleep(0.2)
    return False


def get(path, headers=None):
    c = http.client.HTTPConnection("127.0.0.1", EDGE, timeout=10)
    c.request("GET", path, headers=headers or {})
    return c, c.getresponse()


@unittest.skipUnless(CADDY, "no Caddy binary: set CADDY_BIN (CI downloads one)")
class Edge(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", UPSTREAM), FakeApi)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        text = (PROD / "Caddyfile").read_text().replace("api:4000", f"127.0.0.1:{UPSTREAM}")
        cls.tmp = tempfile.mkdtemp()
        cfg = Path(cls.tmp) / "Caddyfile"
        cfg.write_text("{\n\tadmin off\n}\n\n" + text)
        env = {**os.environ, "API_HOST": f":{EDGE}", "WEB_ORIGIN": WEB_ORIGIN, "XDG_DATA_HOME": cls.tmp, "XDG_CONFIG_HOME": cls.tmp}
        cls.proc = subprocess.Popen([CADDY, "run", "--config", str(cfg), "--adapter", "caddyfile"], env=env,
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        if not wait_port(EDGE):
            cls.proc.kill()
            raise RuntimeError("caddy did not start:\n" + cls.proc.stdout.read().decode()[-2000:])

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        cls.proc.wait(timeout=10)
        cls.server.shutdown()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_api_requests_reach_the_api_with_their_path(self):
        c, r = get("/api/problems?limit=2")
        body = json.loads(r.read())
        self.assertEqual(r.status, 200)
        self.assertEqual(body["path"], "/api/problems?limit=2")
        c.close()

    def test_the_visitor_address_reaches_the_api_and_cannot_be_forged(self):
        # TRUST_PROXY=1 makes the API believe the last X-Forwarded-For entry: that is only safe if the
        # proxy writes it itself and drops what the client sent.
        c, r = get("/api/x", {"X-Forwarded-For": "6.6.6.6"})
        xff = json.loads(r.read())["headers"].get("X-Forwarded-For", "")
        self.assertNotIn("6.6.6.6", xff, "a client-supplied address must not be passed on")
        self.assertEqual(xff, "127.0.0.1")
        c.close()

    def test_responses_are_compressed(self):
        c, r = get("/api/x", {"Accept-Encoding": "gzip"})
        self.assertEqual(r.getheader("Content-Encoding"), "gzip")
        self.assertEqual(json.loads(gzip.decompress(r.read()))["path"], "/api/x")
        c.close()

    def test_the_realtime_stream_arrives_immediately_uncompressed_with_cors(self):
        start = time.time()
        c, r = get("/api/sse?ticket=t&topics=sys", {"Accept-Encoding": "gzip", "Origin": WEB_ORIGIN})
        first = r.read1(100)  # whatever has arrived so far: "retry: 3000"
        elapsed = time.time() - start
        self.assertEqual(first.strip(), b"retry: 3000")
        self.assertLess(elapsed, 1.0, f"first bytes took {elapsed:.1f}s: the proxy is buffering the stream")
        self.assertEqual(r.getheader("Access-Control-Allow-Origin"), WEB_ORIGIN)
        self.assertEqual(r.getheader("Vary"), "Origin")
        self.assertIsNone(r.getheader("Content-Encoding"), "the stream must not be compressed")
        self.assertIn("text/event-stream", r.getheader("Content-Type"))
        c.close()

    def test_cors_is_only_for_the_stream(self):
        c, r = get("/api/problems", {"Origin": WEB_ORIGIN})
        self.assertIsNone(r.getheader("Access-Control-Allow-Origin"))
        r.read()
        c.close()

    def test_security_headers_and_no_server_banner(self):
        c, r = get("/api/x")
        self.assertIn("max-age", r.getheader("Strict-Transport-Security"))
        self.assertEqual(r.getheader("X-Content-Type-Options"), "nosniff")
        self.assertIsNone(r.getheader("Server"), "the upstream's Server header must not leak")
        r.read()
        c.close()

    def test_the_pad_route_answers_503_until_it_exists(self):
        c, r = get("/collab/room-1")
        self.assertEqual(r.status, 503)
        r.read()
        c.close()

    def test_the_root_and_unknown_paths_do_not_reach_the_api(self):
        c, r = get("/")
        self.assertEqual((r.status, r.read()), (200, b"CodeArena API"))
        c.close()
        c, r = get("/not-an-api-path")
        self.assertEqual(r.read(), b"CodeArena API")  # never forwarded upstream
        c.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
