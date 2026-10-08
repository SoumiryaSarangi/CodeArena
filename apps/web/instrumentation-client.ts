import { startSentry } from '@/lib/sentry';

// Runs before the app is interactive (Next instrumentation-client). Does nothing without a DSN.
startSentry(process.env.NEXT_PUBLIC_SENTRY_DSN, process.env.NODE_ENV);
