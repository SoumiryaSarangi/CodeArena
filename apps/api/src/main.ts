import { loadConfig } from './config/config';
import { startTelemetry } from './telemetry/otel';

// Telemetry first so instrumentation sees every later import.
const config = loadConfig();
const telemetry = startTelemetry(config.OTEL_EXPORTER_OTLP_ENDPOINT);

const { createApp } = await import('./app');
const app = await createApp(config);
await app.listen(config.PORT);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    void app.close().then(() => telemetry.shutdown());
  });
}
