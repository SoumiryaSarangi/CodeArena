/**
 * Runs the verdict consumer on its own (no HTTP server): `tsx results-cli.ts`.
 * Used by tests/chaos/kill-worker.sh; handy for debugging a stuck queue.
 * Reads DATABASE_URL and REDIS_URL from the environment; stops on SIGINT/SIGTERM.
 */
import { Redis } from 'ioredis';
import pino from 'pino';
import { loadConfig } from '../../config/config';
import { connect } from '../../db/client';
import { ResultsConsumer } from './results.consumer';
import { ResultsProcessor } from './results.processor';

const config = loadConfig({ ...process.env, NODE_ENV: 'development', RESULT_CONSUMER: 'on' });
const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const { pool, db } = connect(config.DATABASE_URL);
const redis = new Redis(config.REDIS_URL);
redis.on('error', () => {});
const processor = new ResultsProcessor(db, redis, '', log);
const consumer = new ResultsConsumer(redis, '', processor, log, config, { blockMs: 200 });

consumer.start();
log.info('results consumer started');

const shutdown = async () => {
  await consumer.stop();
  redis.disconnect();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
