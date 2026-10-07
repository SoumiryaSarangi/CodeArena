"""Structural tests for the production Compose, Caddy and S3 files (D-02).

Docker is not needed: these check the properties that matter for safety, so an edit that exposes
Postgres, widens the judge's storage key or breaks the realtime route fails in CI.
Run: python3 infra/prod/tests/compose.test.py
"""
import json
import re
import unittest
from pathlib import Path

import yaml

PROD = Path(__file__).resolve().parent.parent
compose = yaml.safe_load((PROD / "docker-compose.yml").read_text())
services = compose["services"]
caddyfile = (PROD / "Caddyfile").read_text()
s3_tmpl = (PROD / "s3.json.tmpl").read_text()


def ports(name):
    return [str(p) for p in services[name].get("ports", [])]


class Compose(unittest.TestCase):
    def test_postgres_is_not_published(self):
        self.assertEqual(ports("postgres"), [], "Postgres must only be reachable inside the Compose network")

    def test_redis_and_storage_listen_on_the_private_address_only(self):
        for name, port in (("redis", "6379"), ("s3", "8333")):
            self.assertEqual(len(ports(name)), 1)
            self.assertTrue(ports(name)[0].startswith("${API_PRIVATE_IP"), f"{name} must bind the private IP, not 0.0.0.0")
            self.assertTrue(ports(name)[0].endswith(f"{port}:{port}"))

    def test_the_api_port_is_loopback_only(self):
        self.assertEqual(ports("api"), ["127.0.0.1:4000:4000"])

    def test_only_caddy_is_public(self):
        public = [n for n in services if any(not re.match(r"^(127\.0\.0\.1|\$\{API_PRIVATE_IP)", p) for p in ports(n))]
        self.assertEqual(public, ["caddy"])
        self.assertEqual(sorted(ports("caddy")), ["443:443", "443:443/udp", "80:80"])

    def test_the_api_runs_the_digest_the_deploy_script_gives_it(self):
        for name in ("api", "migrate"):
            self.assertTrue(services[name]["image"].startswith("${API_IMAGE"), name)

    def test_no_mutable_latest_tags(self):
        for name, svc in services.items():
            image = svc["image"]
            self.assertFalse(image.endswith(":latest"), f"{name}: {image}")
        # Services pinned to a major or exact version, so an upstream release cannot surprise a deploy.
        for name in ("postgres", "redis", "s3", "caddy"):
            self.assertRegex(services[name]["image"], r":\d", f"{name} should be version-pinned")

    def test_no_secret_is_written_into_the_file(self):
        text = (PROD / "docker-compose.yml").read_text()
        for line in text.splitlines():
            if re.search(r"(PASSWORD|SECRET|ACCESS_KEY)\s*:", line):
                self.assertIn("${", line, f"hard-coded secret? {line.strip()}")

    def test_long_running_services_restart_and_the_api_is_checked(self):
        for name in ("caddy", "api", "postgres", "redis", "s3"):
            self.assertEqual(services[name]["restart"], "unless-stopped", name)
        self.assertIn("healthcheck", services["api"])
        for name in ("postgres", "redis", "s3"):
            self.assertIn("healthcheck", services[name], name)

    def test_start_order(self):
        self.assertEqual(services["caddy"]["depends_on"]["api"]["condition"], "service_healthy")
        for dep in ("postgres", "redis", "s3"):
            self.assertEqual(services["api"]["depends_on"][dep]["condition"], "service_healthy")
        self.assertEqual(services["migrate"]["depends_on"]["postgres"]["condition"], "service_healthy")

    def test_one_off_tools_are_not_started_by_up(self):
        for name in ("migrate", "s3-init"):
            self.assertEqual(services[name]["profiles"], ["tools"])
            self.assertEqual(services[name]["restart"], "no")
        # node directly, never through pnpm (it reinstalls dependencies, which the container user cannot do)
        self.assertEqual(services["migrate"]["command"], ["node", "--import", "tsx", "src/db/cli.ts", "migrate"])

    def test_the_api_reads_its_settings_from_prod_env(self):
        for name in ("api", "migrate"):
            self.assertEqual(services[name]["env_file"], "prod.env")

    def test_data_lives_in_named_volumes(self):
        for v in ("pgdata", "redisdata", "s3data", "caddy_data"):
            self.assertIn(v, compose["volumes"])


class S3Identities(unittest.TestCase):
    def test_the_judge_key_can_only_read_and_list(self):
        ids = json.loads(s3_tmpl)["identities"]
        by_name = {i["name"]: i for i in ids}
        self.assertEqual(set(by_name), {"api", "judge"})
        self.assertEqual(sorted(by_name["judge"]["actions"]), ["List", "Read"], "ADR-009: judges read tests, nothing else")
        self.assertIn("Write", by_name["api"]["actions"])

    def test_two_different_credentials(self):
        ids = json.loads(s3_tmpl)["identities"]
        keys = {i["credentials"][0]["accessKey"] for i in ids}
        self.assertEqual(len(keys), 2)
        self.assertEqual(keys, {"__API_AK__", "__JUDGE_AK__"})


class Caddy(unittest.TestCase):
    def block(self, matcher):
        m = re.search(r"handle\s+" + re.escape(matcher) + r"\s*\{(.*?)\n\t\}", caddyfile, re.S)
        self.assertIsNotNone(m, f"no handle block for {matcher}")
        return m.group(1)

    def test_the_stream_is_not_buffered_or_compressed_and_has_cors_for_the_web_origin(self):
        sse = self.block("@sse")
        self.assertIn("flush_interval -1", sse)
        self.assertNotIn("encode", sse)
        self.assertIn('Access-Control-Allow-Origin "{$WEB_ORIGIN}"', sse)
        self.assertIn("reverse_proxy api:4000", sse)

    def test_cors_is_only_on_the_stream(self):
        api = self.block("/api/*")
        self.assertNotIn("Access-Control-Allow-Origin", api)
        self.assertNotIn("*", re.findall(r"Access-Control-Allow-Origin\s+\"([^\"]*)\"", caddyfile))

    def test_security_headers(self):
        self.assertIn("Strict-Transport-Security", caddyfile)
        self.assertIn('X-Content-Type-Options "nosniff"', caddyfile)
        self.assertIn("-Server", caddyfile)

    def test_the_pad_route_is_prepared_but_answers_503_until_it_exists(self):
        self.assertIn("503", self.block("/collab/*"))
        self.assertIn("lb_policy uri_hash", caddyfile)  # documented for when the instances exist

    def test_no_directive_can_render_empty(self):
        # An optional environment value in a directive that needs an argument (`email {$X:}` with X
        # unset) is a syntax error and Caddy then refuses to start: found by running Caddy in CI.
        for m in re.finditer(r"^\s*(\w[\w-]*)\s+\{\$[A-Z_]+:\}\s*$", caddyfile, re.M):
            self.fail(f"directive '{m.group(1)}' has an optional value that can be empty")
        self.assertNotIn("ACME_EMAIL", caddyfile)

    def test_the_site_name_comes_from_the_environment(self):
        self.assertIn("{$API_HOST} {", caddyfile)


if __name__ == "__main__":
    unittest.main(verbosity=2)
