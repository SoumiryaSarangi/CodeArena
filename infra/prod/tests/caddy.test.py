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

    def do_POST(self):
        n = int(self.headers.get("Content-Length", "0"))
        got = 0
        while got < n:
            chunk = self.rfile.read(min(65536, n - got))
            if not chunk:
                break
            got += len(chunk)
        body = json.dumps({"path": self.path, "received": got, "method": "POST"}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

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

    def test_package_upload_has_cors_for_the_web_origin_only_and_carries_a_big_body(self):
        # The preflight a browser sends before a cross-origin POST with an Authorization header.
        c = http.client.HTTPConnection("127.0.0.1", EDGE, timeout=10)
        c.request("OPTIONS", "/api/admin/problems/packages", headers={
            "Origin": WEB_ORIGIN, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization"})
        r = c.getresponse()
        r.read()
        self.assertEqual(r.status, 204)
        self.assertEqual(r.getheader("Access-Control-Allow-Origin"), WEB_ORIGIN)
        self.assertIn("Authorization", r.getheader("Access-Control-Allow-Headers"))
        self.assertEqual(r.getheader("Access-Control-Allow-Methods"), "GET, POST")
        c.close()
        # The tests of a problem are downloaded the same way (they can be as large as the upload).
        c = http.client.HTTPConnection("127.0.0.1", EDGE, timeout=10)
        c.request("OPTIONS", "/api/admin/problem-versions/abc/tests.tar", headers={
            "Origin": WEB_ORIGIN, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization"})
        r = c.getresponse()
        r.read()
        self.assertEqual((r.status, r.getheader("Access-Control-Allow-Origin")), (204, WEB_ORIGIN))
        self.assertIn("Content-Disposition", r.getheader("Access-Control-Expose-Headers"))
        c.close()
        # A 12 MB upload is proxied whole, with the CORS header on the answer.
        size = 12 * 1024 * 1024
        c = http.client.HTTPConnection("127.0.0.1", EDGE, timeout=30)
        c.request("POST", "/api/admin/problems/packages", body=b"x" * size, headers={
            "Origin": WEB_ORIGIN, "Authorization": "Bearer t", "Content-Type": "multipart/form-data; boundary=b"})
        r = c.getresponse()
        body = json.loads(r.read())
        self.assertEqual((r.status, body["received"], body["path"]), (200, size, "/api/admin/problems/packages"))
        self.assertEqual(r.getheader("Access-Control-Allow-Origin"), WEB_ORIGIN)
        c.close()

    def test_other_admin_routes_get_no_cors(self):
        c = http.client.HTTPConnection("127.0.0.1", EDGE, timeout=10)
        c.request("OPTIONS", "/api/admin/problems", headers={"Origin": WEB_ORIGIN, "Access-Control-Request-Method": "GET"})
        r = c.getresponse()
        r.read()
        self.assertIsNone(r.getheader("Access-Control-Allow-Origin"))
        c.close()
        c, r = get("/api/admin/problems", {"Origin": WEB_ORIGIN})
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

    def test_the_pad_route_answers_a_friendly_503_while_no_instance_runs(self):
        # `collab1`/`collab2` do not exist here, exactly like production before the collab profile is started.
        start = time.time()
        c, r = get("/collab/room-1")
        self.assertEqual((r.status, r.read()), (503, b"The collaborative pad is not available right now."))
        self.assertLess(time.time() - start, 8, "it should give up after the retry window, not hang")
        c.close()

    def test_internal_service_routes_are_not_reachable_from_outside(self):
        # The collab servers call /api/internal/* on the API over the private network; the edge answers as if it did not exist.
        for method in ("GET", "POST"):
            c = http.client.HTTPConnection("127.0.0.1", EDGE, timeout=10)
            c.request(method, "/api/internal/rooms/3f2a0000-0000-4000-8000-000000000000/authorize", body="{}" if method == "POST" else None,
                      headers={"X-Service-Token": "x" * 40})
            r = c.getresponse()
            self.assertEqual((r.status, r.read()), (404, b"Not found"), method)
            c.close()
        c, r = get("/api/internals-are-not-a-thing")  # only the internal prefix is blocked, other API paths still pass
        self.assertEqual(r.status, 200)
        r.read()
        c.close()

    def test_the_root_and_unknown_paths_do_not_reach_the_api(self):
        c, r = get("/")
        self.assertEqual((r.status, r.read()), (200, b"CodeArena API"))
        c.close()
        c, r = get("/not-an-api-path")
        self.assertEqual(r.read(), b"CodeArena API")  # never forwarded upstream
        c.close()


class FakeCollab(BaseHTTPRequestHandler):
    """One collab instance: says who it is, and does a bare WebSocket handshake plus echo for /collab/ws."""

    name = "?"

    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.headers.get("Upgrade", "").lower() == "websocket":
            import base64
            import hashlib

            key = self.headers["Sec-WebSocket-Key"]
            accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
            self.send_response(101, "Switching Protocols")
            self.send_header("Upgrade", "websocket")
            self.send_header("Connection", "Upgrade")
            self.send_header("Sec-WebSocket-Accept", accept)
            self.end_headers()
            self.wfile.flush()
            while True:  # echo whatever arrives on the upgraded connection
                data = self.connection.recv(4096)
                if not data:
                    break
                self.connection.sendall(data)
            self.close_connection = True
            return
        body = json.dumps({"instance": self.name, "path": self.path}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


@unittest.skipUnless(CADDY, "no Caddy binary: set CADDY_BIN (CI downloads one)")
class CollabRouting(unittest.TestCase):
    """CP-03: rooms are routed by URI hash to one of two instances, a dead instance is skipped, WebSockets pass through.
    Tests are numbered because they stop instances one after the other."""

    PORT = 18081
    UP = (14101, 14102)

    @classmethod
    def setUpClass(cls):
        cls.servers = []
        for i, port in enumerate(cls.UP):
            handler = type(f"Collab{i}", (FakeCollab,), {"name": f"collab{i + 1}"})
            srv = ThreadingHTTPServer(("127.0.0.1", port), handler)
            srv.daemon_threads = True
            threading.Thread(target=srv.serve_forever, daemon=True).start()
            cls.servers.append(srv)
        cls.tmp = tempfile.mkdtemp()
        cfg = Path(cls.tmp) / "Caddyfile"
        cfg.write_text("{\n\tadmin off\n}\n\n" + (PROD / "Caddyfile").read_text())
        env = {
            **os.environ,
            "API_HOST": f":{cls.PORT}",
            "WEB_ORIGIN": WEB_ORIGIN,
            "COLLAB_UPSTREAMS": " ".join(f"127.0.0.1:{p}" for p in cls.UP),
            "XDG_DATA_HOME": cls.tmp,
            "XDG_CONFIG_HOME": cls.tmp,
        }
        cls.proc = subprocess.Popen([CADDY, "run", "--config", str(cfg), "--adapter", "caddyfile"], env=env,
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        if not wait_port(cls.PORT):
            cls.proc.kill()
            raise RuntimeError("caddy did not start:\n" + cls.proc.stdout.read().decode()[-2000:])

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        cls.proc.wait(timeout=10)
        for s in cls.servers:
            try:
                s.shutdown()
            except Exception:
                pass
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def ask(self, room):
        c = http.client.HTTPConnection("127.0.0.1", self.PORT, timeout=15)
        c.request("GET", f"/collab/{room}")
        r = c.getresponse()
        body = r.read()
        c.close()
        return r.status, body

    rooms = [f"3f2a{n:04d}-0000-4000-8000-00000000{n:04d}" for n in range(60)]

    def test_1_the_same_room_always_reaches_the_same_instance_and_rooms_spread_over_both(self):
        owner = {}
        for room in self.rooms:
            seen = set()
            for _ in range(5):
                status, body = self.ask(room)
                self.assertEqual(status, 200)
                seen.add(json.loads(body)["instance"])
            self.assertEqual(len(seen), 1, f"room {room} moved between instances: {seen}")
            owner[room] = seen.pop()
        type(self).owner = owner
        counts = {n: list(owner.values()).count(n) for n in ("collab1", "collab2")}
        self.assertGreaterEqual(min(counts.values()), 10, f"rooms are not spread over both instances: {counts}")

    def test_2_a_websocket_upgrade_passes_through_and_stays_open(self):
        key = "dGhlIHNhbXBsZSBub25jZQ=="
        with socket.create_connection(("127.0.0.1", self.PORT), timeout=10) as s:
            s.sendall(
                (
                    f"GET /collab/{self.rooms[0]} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                    f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
                ).encode()
            )
            head = b""
            while b"\r\n\r\n" not in head:
                head += s.recv(1024)
            self.assertTrue(head.startswith(b"HTTP/1.1 101"), head[:80])
            self.assertIn(b"s3pPLMBiTxaQ9kYGzzhZRbK+xOo=", head)  # the accept value for that key
            s.sendall(b"ping-through-the-edge")
            self.assertEqual(s.recv(100), b"ping-through-the-edge")

    def test_3_when_one_instance_dies_its_rooms_move_to_the_other_and_every_request_succeeds(self):
        self.servers[1].shutdown()
        self.servers[1].server_close()  # collab2 is gone: connections to it are refused
        for room in self.rooms:
            status, body = self.ask(room)
            self.assertEqual(status, 200, f"room {room} failed after collab2 died")
            self.assertEqual(json.loads(body)["instance"], "collab1")
        # rooms that were already on collab1 did not move
        for room, name in self.owner.items():
            if name == "collab1":
                self.assertEqual(json.loads(self.ask(room)[1])["instance"], "collab1")

    def test_4_with_no_instance_left_the_answer_is_the_friendly_503(self):
        self.servers[0].shutdown()
        self.servers[0].server_close()
        status, body = self.ask(self.rooms[0])
        self.assertEqual((status, body), (503, b"The collaborative pad is not available right now."))


if __name__ == "__main__":
    unittest.main(verbosity=2)
