import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';

/**
 * Starts the OTel SDK when OTEL_EXPORTER_OTLP_ENDPOINT is set; otherwise the API (and tests)
 * run with the no-op global providers, so spans and metrics are still created but go nowhere.
 */
export function startTelemetry(endpoint: string | undefined) {
  if (!endpoint) return { shutdown: async () => {} };
  const base = endpoint.replace(/\/$/, '');
  const sdk = new NodeSDK({
    serviceName: 'api',
    traceExporter: new OTLPTraceExporter({ url: `${base}/v1/traces` }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${base}/v1/metrics` }),
      exportIntervalMillis: 10_000,
    }),
  });
  sdk.start();
  return { shutdown: () => sdk.shutdown() };
}
