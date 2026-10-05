import pino from 'pino';
import type { Config } from '../config/config';

export const LOGGER = Symbol('LOGGER');

/** Structured JSON logs (NFR-OBS-03). Trace correlation is added per request by the HTTP middleware. */
export const createLogger = (config: Pick<Config, 'LOG_LEVEL'>) =>
  pino({ level: config.LOG_LEVEL, base: { service: 'api' } });
