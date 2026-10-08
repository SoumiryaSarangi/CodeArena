import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const read = (p: string) => readFileSync(`${root}${p}`, 'utf8');

/** Every `ca_*` metric name the API and the worker create (instrument names, as written in the code). */
function emitted(): Set<string> {
  const names = new Set<string>();
  const scan = (dir: string, ext: RegExp) => {
    for (const e of readdirSync(`${root}${dir}`, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name !== 'node_modules') scan(p, ext);
      } else if (ext.test(e.name) && !/\.test\./.test(e.name) && !/_test\.go$/.test(e.name)) {
        for (const m of read(p).matchAll(/['"`](ca_[a-z0-9_]+)['"`]/g)) names.add(m[1]!);
      }
    }
  };
  scan('apps/api/src', /\.ts$/);
  scan('apps/worker', /\.go$/);
  return names;
}

/** `ca_x_seconds_bucket` is series of the histogram `ca_x_seconds`. */
const instrumentOf = (series: string) => series.replace(/_(bucket|count|sum)$/, '');

const exprs = (): { where: string; expr: string }[] => {
  const out: { where: string; expr: string }[] = [];
  for (const f of readdirSync(`${root}infra/grafana/dashboards`)) {
    const d = JSON.parse(read(`infra/grafana/dashboards/${f}`)) as {
      panels: { title: string; targets: { expr: string }[] }[];
    };
    for (const p of d.panels)
      for (const t of p.targets) out.push({ where: `${f}: ${p.title}`, expr: t.expr });
  }
  const rules = JSON.parse(read('infra/grafana/alerts.json')) as {
    title: string;
    data: { model: { expr?: string } }[];
  }[];
  for (const r of rules)
    for (const d of r.data)
      if (d.model.expr) out.push({ where: `alert: ${r.title}`, expr: d.model.expr });
  return out;
};

describe('O-01: dashboards and alerts as code', () => {
  it('NFR-OBS-02: every metric a panel or an alert uses is emitted by the code', () => {
    const known = emitted();
    expect(known.size).toBeGreaterThan(20);
    for (const { where, expr } of exprs()) {
      const used = [...expr.matchAll(/\bca_[a-z0-9_]+/g)].map((m) => m[0]);
      expect(used.length, where).toBeGreaterThan(0);
      for (const u of used) expect(known.has(instrumentOf(u)), `${where} uses ${u}`).toBe(true);
    }
  });

  it('SD-§15.2: the metrics the design lists are all emitted', () => {
    const known = emitted();
    for (const m of [
      'ca_queue_depth',
      'ca_queue_wait_seconds',
      'ca_time_to_verdict_seconds',
      'ca_judge_busy_ratio',
      'ca_verdicts_total',
      'ca_board_update_seconds',
      'ca_sse_connections',
      'ca_http_request_seconds',
      'ca_queue_dlq_total',
      'ca_results_dlq_total',
    ]) {
      expect(known.has(m), m).toBe(true);
    }
  });

  it('SD-§15.3: the five alerts exist, each with a query, a reduce and a threshold step', () => {
    const rules = JSON.parse(read('infra/grafana/alerts.json')) as {
      uid: string;
      for: string;
      condition: string;
      data: { refId: string }[];
    }[];
    expect(rules.map((r) => r.uid).sort()).toEqual([
      'ca-5xx',
      'ca-board',
      'ca-dlq',
      'ca-no-judge',
      'ca-p95',
    ]);
    for (const r of rules) {
      expect(r.condition).toBe('C');
      expect(r.data.map((d) => d.refId)).toEqual(['A', 'B', 'C']);
    }
    expect(rules.find((r) => r.uid === 'ca-p95')!.for).toBe('2m');
  });

  it('dashboards have unique ids and titles, and every panel has a query', () => {
    const files = readdirSync(`${root}infra/grafana/dashboards`);
    const ds = files.map(
      (f) =>
        JSON.parse(read(`infra/grafana/dashboards/${f}`)) as {
          uid: string;
          title: string;
          panels: { targets: unknown[] }[];
        },
    );
    expect(new Set(ds.map((d) => d.uid)).size).toBe(ds.length);
    expect(new Set(ds.map((d) => d.title)).size).toBe(ds.length);
    for (const d of ds) for (const p of d.panels) expect(p.targets.length).toBeGreaterThan(0);
  });
});
