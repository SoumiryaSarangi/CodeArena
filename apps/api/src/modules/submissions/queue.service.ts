import { randomBytes } from 'node:crypto';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { JudgeJob, type Lane } from '@codearena/contracts';
import { metrics, trace, type ObservableResult } from '@opentelemetry/api';
import type { Redis } from 'ioredis';
import { ProblemError } from '../../common/problem';
import { REDIS } from '../../redis/redis.module';
import { whenReady } from '../../redis/ready';
import { laneDepth } from './lane-depth';
import { uuidv7 } from '../../db/uuid';
import { TRACE_KEY_TTL_S, activeTraceparent, traceKey } from '../../telemetry/trace-context';

/** Key prefix for tests, so they never touch real queue keys. Production uses ''. */
export const QUEUE_KEY_PREFIX = Symbol('QUEUE_KEY_PREFIX');

const tracer = trace.getTracer('api');
const enqueued = metrics
  .getMeter('api')
  .createCounter('ca_queue_enqueued_total', { description: 'Judge jobs enqueued, by lane' });

/** What the caller supplies; the service stamps jobId, seq and enqueuedAt. */
export type EnqueueInput = Omit<JudgeJob, 'jobId' | 'seq' | 'enqueuedAt' | 'traceparent'> & {
  traceparent?: string;
};

export interface Enqueued {
  jobId: string;
  lane: Lane;
  /** Per-lane counter (`seq:{lane}`): monotonic, unique, never reused. */
  seq: number;
  /** Stream entry id in `jobs:{lane}`. */
  entryId: string;
}

// The job JSON must start with this exact text: the script swaps the 0 for the real counter.
const SEQ_PREFIX = '{"seq":0,';

// INCR and XADD happen in one script, so the counter and the stream order always agree even
// with many API instances enqueueing at once (a MULTI cannot feed INCR's result into XADD).
const ENQUEUE = `
local seq = redis.call('INCR', KEYS[1])
local body = '{"seq":' .. seq .. ',' .. string.sub(ARGV[1], ${SEQ_PREFIX.length + 1})
local id = redis.call('XADD', KEYS[2], '*', 'job', body)
return { seq, id }
`;

const LANES: Lane[] = ['contest', 'interactive', 'practice', 'rejudge'];
const depthGauge = metrics.getMeter('api').createObservableGauge('ca_queue_depth', {
  description: 'Jobs waiting in a lane (not yet read by a judge)',
});

@Injectable()
export class QueueService implements OnModuleDestroy {
  /** Observed on every metrics export; removed again when the service goes away. */
  private readonly observeDepth = async (r: ObservableResult) => {
    await Promise.all(
      LANES.map(async (lane) =>
        r.observe(await laneDepth(this.redis, this.prefix, lane), { lane }),
      ),
    );
  };

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(QUEUE_KEY_PREFIX) private readonly prefix: string,
  ) {
    depthGauge.addCallback(this.observeDepth);
  }

  onModuleDestroy() {
    depthGauge.removeCallback(this.observeDepth);
  }

  seqKey(lane: Lane) {
    return `${this.prefix}seq:${lane}`;
  }

  jobsKey(lane: Lane) {
    return `${this.prefix}jobs:${lane}`;
  }

  /**
   * Validates a job against the contract, then appends it to its lane stream
   * (`XADD jobs:{lane} job=<JudgeJob JSON>`, the wire format in SD-§7). A job
   * the worker would reject is refused here, before it takes a queue slot.
   */
  async enqueue(input: EnqueueInput): Promise<Enqueued> {
    return tracer.startActiveSpan('queue.enqueue', async (span) => {
      try {
        span.setAttributes({ lane: input.lane, 'submission.id': input.submissionId });
        const jobId = uuidv7();
        // `seq` is first so SEQ_PREFIX can be swapped in place; the real value is stamped in Redis.
        const candidate = {
          seq: 0,
          jobId,
          ...input,
          enqueuedAt: Date.now(),
          traceparent: input.traceparent ?? currentTraceparent(),
        };
        const parsed = JudgeJob.safeParse(candidate);
        if (!parsed.success) {
          throw new ProblemError(
            'validation',
            `Invalid judge job: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
          );
        }
        // Zod orders keys by schema, not by input, so put seq first explicitly.
        const body = JSON.stringify({ seq: 0, ...withoutSeq(parsed.data) });
        if (!body.startsWith(SEQ_PREFIX)) throw new Error('job JSON lost its seq-first layout');

        await whenReady(this.redis);
        // The result comes back without a trace id; this lets its handling rejoin the trace. Losing
        // it only splits the trace in two, so a failure here is not worth failing the enqueue.
        await this.redis
          .set(
            traceKey(this.prefix, parsed.data.submissionId, parsed.data.runVersion),
            parsed.data.traceparent,
            'EX',
            TRACE_KEY_TTL_S,
          )
          .catch(() => undefined);
        const [seq, entryId] = (await this.redis.eval(
          ENQUEUE,
          2,
          this.seqKey(input.lane),
          this.jobsKey(input.lane),
          body,
        )) as [number, string];
        enqueued.add(1, { lane: input.lane });
        span.setAttribute('seq', seq);
        return { jobId, lane: input.lane, seq, entryId };
      } catch (err) {
        span.recordException(err as Error);
        throw err;
      } finally {
        span.end();
      }
    });
  }
}

/** The job without its `seq` key, so the body can be rebuilt with `seq` first. */
function withoutSeq(job: JudgeJob): Omit<JudgeJob, 'seq'> {
  return Object.fromEntries(Object.entries(job).filter(([key]) => key !== 'seq')) as Omit<
    JudgeJob,
    'seq'
  >;
}

/** W3C traceparent of the active span, or a fresh random one when there is none. */
export function currentTraceparent(): string {
  return (
    activeTraceparent() ??
    `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01`
  );
}
