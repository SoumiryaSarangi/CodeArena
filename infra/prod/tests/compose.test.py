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


class Telemetry(unittest.TestCase):
    """O-01: the collector is optional, private, and sees only the Grafana settings."""

    def test_the_collector_is_a_profile_service_so_up_never_starts_it_unconfigured(self):
        self.assertEqual(services["otelcol"]["profiles"], ["observability"])
        self.assertEqual(services["otelcol"]["restart"], "unless-stopped")

    def test_it_listens_on_the_private_address_only(self):
        self.assertEqual(ports("otelcol"), ["${API_PRIVATE_IP:?}:4318:4318"])

    def test_it_does_not_get_the_rest_of_prod_env(self):
        self.assertNotIn("env_file", services["otelcol"])
        self.assertEqual(
            sorted(services["otelcol"]["environment"]),
            ["GRAFANA_INSTANCE_ID", "GRAFANA_OTLP_ENDPOINT", "GRAFANA_TOKEN"],
        )

    def test_an_unconfigured_install_still_renders(self):
        # `${X:-}` rather than `${X:?}`: the compose file must parse before set-grafana.sh has run.
        for v in services["otelcol"]["environment"].values():
            self.assertTrue(v.endswith(":-}"), v)

    def test_the_image_is_pinned(self):
        self.assertRegex(services["otelcol"]["image"], r":\d+\.\d+\.\d+$")

    def test_the_config_has_no_secret_and_reads_the_environment(self):
        text = (PROD / "otelcol.yaml").read_text()
        for name in ("GRAFANA_INSTANCE_ID", "GRAFANA_TOKEN", "GRAFANA_OTLP_ENDPOINT"):
            self.assertIn("${env:" + name + "}", text)
        cfg = yaml.safe_load(text)
        self.assertEqual(cfg["receivers"]["otlp"]["protocols"]["http"]["endpoint"], "0.0.0.0:4318")
        self.assertIn("memory_limiter", cfg["service"]["pipelines"]["traces"]["processors"])
        self.assertEqual(sorted(cfg["service"]["pipelines"]), ["metrics", "traces"])


class PlagJob(unittest.TestCase):
    """PL-05: the plagiarism job is opt-in, isolated, and has only the service token."""

    def test_it_only_runs_when_asked_for(self):
        self.assertEqual(services["plag"]["profiles"], ["plag"])  # a plain `up` never starts it

    def test_it_gets_the_service_token_and_nothing_else_from_prod_env(self):
        svc = services["plag"]
        self.assertNotIn("env_file", svc)
        self.assertEqual(sorted(svc["environment"]), ["PLAG_SERVICE_TOKEN"])
        # NOT required here (see the compose file): the job exits 2 by itself without the token
        self.assertEqual(svc["environment"]["PLAG_SERVICE_TOKEN"], "${PLAG_SERVICE_TOKEN:-}")

    def test_it_reaches_the_api_only_and_publishes_nothing(self):
        svc = services["plag"]
        self.assertEqual(svc.get("ports", []), [])
        self.assertEqual(svc["command"], ["serve", "--api", "http://api:4000"])
        self.assertEqual(svc["depends_on"], {"api": {"condition": "service_healthy"}})

    def test_it_is_locked_down_and_cannot_starve_the_api(self):
        svc = services["plag"]
        self.assertTrue(svc["read_only"])
        self.assertEqual(svc["restart"], "unless-stopped")
        self.assertLessEqual(float(svc["cpus"]), 1.0)
        self.assertRegex(str(svc["mem_limit"]), r"^\d+[mg]$")
        self.assertNotIn("volumes", svc)  # no host or data volumes

    def test_the_image_is_chosen_by_the_operator_not_a_mutable_tag(self):
        self.assertTrue(services["plag"]["image"].startswith("${PLAG_IMAGE:-"))


class CollabInstances(unittest.TestCase):
    """CP-03: two collab instances, opt-in, with the three variables they need and nothing else."""

    NAMES = ["collab1", "collab2"]

    def test_they_only_run_when_asked_for(self):
        for n in self.NAMES:
            self.assertEqual(services[n]["profiles"], ["collab"])

    def test_they_get_exactly_these_variables_and_no_env_file(self):
        for n in self.NAMES:
            svc = services[n]
            self.assertNotIn("env_file", svc, "prod.env holds the JWT key and the AI keys")
            self.assertEqual(
                sorted(svc["environment"]),
                ["API_URL", "COLLAB_INSTANCE", "COLLAB_SERVICE_TOKEN", "DATABASE_URL", "PORT", "REDIS_URL"],
            )
            for k in ("DATABASE_URL", "REDIS_URL", "COLLAB_SERVICE_TOKEN"):
                # optional with a default (see the plag job), never `:?`
                self.assertRegex(svc["environment"][k], r"^\$\{" + k + r":-\}$")
            self.assertEqual(svc["environment"]["API_URL"], "http://api:4000")

    def test_the_instances_differ_only_by_name(self):
        a, b = (services[n] for n in self.NAMES)
        self.assertEqual({k: v for k, v in a.items() if k != "environment"}, {k: v for k, v in b.items() if k != "environment"})
        self.assertEqual([a["environment"]["COLLAB_INSTANCE"], b["environment"]["COLLAB_INSTANCE"]], self.NAMES)
        self.assertEqual({k: v for k, v in a["environment"].items() if k != "COLLAB_INSTANCE"}, {k: v for k, v in b["environment"].items() if k != "COLLAB_INSTANCE"})

    def test_they_publish_nothing_and_are_locked_down(self):
        for n in self.NAMES:
            svc = services[n]
            self.assertEqual(svc.get("ports", []), [], "Caddy reaches them by service name")
            self.assertTrue(svc["read_only"])
            self.assertEqual(svc["restart"], "unless-stopped")
            self.assertNotIn("volumes", svc)
            self.assertRegex(str(svc["mem_limit"]), r"^\d+[mg]$")
            self.assertLessEqual(float(svc["cpus"]), 1.0)

    def test_they_wait_for_their_dependencies_and_get_time_to_flush_on_stop(self):
        for n in self.NAMES:
            svc = services[n]
            self.assertEqual(sorted(svc["depends_on"]), ["api", "postgres", "redis"])
            self.assertTrue(all(v == {"condition": "service_healthy"} for v in svc["depends_on"].values()))
            self.assertGreaterEqual(int(str(svc["stop_grace_period"]).rstrip("s")), 15)  # SIGTERM stores open documents
            self.assertIn("healthcheck", svc)

    def test_the_image_is_chosen_by_the_operator(self):
        for n in self.NAMES:
            self.assertTrue(services[n]["image"].startswith("${COLLAB_IMAGE:-"))


class RendersLikeADeploy(unittest.TestCase):
    """The deploy runs Compose with API_IMAGE (and prod.env) and nothing else. Compose evaluates `${X:?}` for every
    service, even those in an inactive profile, so one service that needs another variable breaks every deploy: this renders
    the real file the way deploy.sh does. (It once would have: the plag job asked for PLAG_IMAGE.)"""

    ENV = (
        "API_HOST=api.example.test\nWEB_ORIGIN=https://web.example.test\nAPI_PRIVATE_IP=10.20.1.4\n"
        "POSTGRES_PASSWORD=x\nREDIS_ADMIN_PASSWORD=x\nREDIS_API_PASSWORD=x\nREDIS_JUDGE_PASSWORD=x\n"
        "S3_API_ACCESS_KEY=x\nS3_API_SECRET_KEY=x\nS3_JUDGE_ACCESS_KEY=x\nS3_JUDGE_SECRET_KEY=x\n"
    )

    def render(self, *args, extra_env=None):
        import os
        import subprocess
        import tempfile

        if subprocess.run(["docker", "compose", "version"], capture_output=True).returncode != 0:
            self.skipTest("docker compose is not installed")
        with tempfile.TemporaryDirectory() as tmp:
            # laid out like /opt/codearena: the compose file and prod.env side by side (services read `env_file: prod.env`)
            env_file = Path(tmp) / "prod.env"
            env_file.write_text(self.ENV)
            (Path(tmp) / "docker-compose.yml").write_text((PROD / "docker-compose.yml").read_text())
            env = {**os.environ, "API_IMAGE": "ghcr.io/x/y@sha256:" + "0" * 64, **(extra_env or {})}
            for k in ("PLAG_IMAGE", "PLAG_SERVICE_TOKEN"):
                if not (extra_env and k in extra_env):
                    env.pop(k, None)
            return subprocess.run(
                ["docker", "compose", "--env-file", str(env_file), "-f", str(Path(tmp) / "docker-compose.yml"), *args],
                capture_output=True, text=True, env=env, cwd=tmp,
            )  # fmt: skip

    def test_a_normal_deploy_renders_without_any_plag_variable(self):
        r = self.render("config", "--services")
        self.assertEqual(r.returncode, 0, r.stderr)
        names = r.stdout.split()
        self.assertIn("api", names)
        self.assertNotIn("plag", names)  # and the job is not part of it
        self.assertNotIn("collab1", names)  # nor are the pad instances
        self.assertNotIn("collab2", names)

    def test_the_collab_profile_renders_with_defaults_and_passes_only_its_variables(self):
        r = self.render("--profile", "collab", "config", "--services")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue({"collab1", "collab2"} <= set(r.stdout.split()))
        r = self.render(
            "--profile", "collab", "config", "--format", "json",
            extra_env={"COLLAB_IMAGE": "ghcr.io/x/codearena-collab@sha256:" + "2" * 64, "COLLAB_SERVICE_TOKEN": "c" * 48},
        )  # fmt: skip
        self.assertEqual(r.returncode, 0, r.stderr)
        rendered = json.loads(r.stdout)["services"]
        for n in ("collab1", "collab2"):
            env = rendered[n]["environment"]
            self.assertEqual(env["COLLAB_SERVICE_TOKEN"], "c" * 48)
            self.assertTrue(env["DATABASE_URL"] == "" or env["DATABASE_URL"].startswith("postgres"))
            self.assertNotIn("JWT_PRIVATE_KEY", env)
            self.assertTrue(rendered[n]["image"].startswith("ghcr.io/x/codearena-collab@sha256:"))

    def test_the_plag_profile_renders_with_its_defaults_and_with_real_values(self):
        r = self.render("--profile", "plag", "config", "--services")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("plag", r.stdout.split())
        r = self.render(
            "--profile", "plag", "config",
            extra_env={"PLAG_IMAGE": "ghcr.io/x/codearena-plag@sha256:" + "1" * 64, "PLAG_SERVICE_TOKEN": "t" * 48},
        )  # fmt: skip
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("ghcr.io/x/codearena-plag@sha256:", r.stdout)

    def test_every_service_with_a_profile_renders_when_only_the_deploy_variables_are_set(self):
        for profile in ("tools", "observability", "plag", "collab"):
            r = self.render("--profile", profile, "config", "--services")
            self.assertEqual(r.returncode, 0, f"{profile}: {r.stderr}")


class LoadTest(unittest.TestCase):
    """O-03: the load-test data tool exists on the server but never starts by itself."""

    def test_the_tool_is_a_one_off_in_the_tools_profile(self):
        svc = services["loadtest"]
        self.assertEqual(svc["profiles"], ["tools"])
        self.assertEqual(svc["restart"], "no")
        self.assertEqual(svc["environment"]["LOAD_TEST"], "on")
        self.assertNotIn("ports", svc)

    def test_it_runs_the_load_cli_from_the_api_image(self):
        svc = services["loadtest"]
        self.assertEqual(svc["image"], services["api"]["image"].replace("is set by deploy.sh", "is set by prod.sh"))
        self.assertIn("src/modules/load/load-cli.ts", svc["entrypoint"])


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

    def test_the_pad_is_routed_by_room_id_to_two_instances_with_a_friendly_503_when_none_runs(self):
        pad = self.block("/collab/*")
        self.assertIn("lb_policy uri_hash", pad)
        self.assertIn("collab1:1234 collab2:1234", pad)
        self.assertIn("health_uri", pad)  # a dead instance is skipped
        self.assertIn("lb_try_duration", pad)
        self.assertRegex(caddyfile, r"handle_errors\s*\{[^}]*/collab/\*[^}]*503")

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
