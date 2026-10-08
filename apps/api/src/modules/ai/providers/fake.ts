import { type Provider, ProviderError, type Usage } from '../types';

export type FakeStep =
  | string
  | { text: string; usage?: Usage }
  | { error: number; retryAfterMs?: number }
  | ((model: string) => string);

/** A scripted provider for tests and local runs without keys: answers (or fails) step by step. */
export class FakeProvider implements Provider {
  readonly name = 'fake' as const;
  readonly calls: { model: string; messages: Parameters<Provider['complete']>[1]['messages'] }[] =
    [];
  private i = 0;

  /** `steps` are used in order; the last one repeats. */
  constructor(private readonly steps: FakeStep[] = ['ok']) {}

  async complete(
    model: string,
    req: Parameters<Provider['complete']>[1],
  ): ReturnType<Provider['complete']> {
    this.calls.push({ model, messages: req.messages });
    const step = this.steps[Math.min(this.i++, this.steps.length - 1)]!;
    if (typeof step === 'function') return { text: step(model), usage: estimate(req, step(model)) };
    if (typeof step === 'string') return { text: step, usage: estimate(req, step) };
    if ('error' in step)
      throw new ProviderError(`fake ${step.error}`, step.error, step.retryAfterMs);
    return { text: step.text, usage: step.usage ?? estimate(req, step.text) };
  }
}

const estimate = (req: Parameters<Provider['complete']>[1], out: string): Usage => ({
  inputTokens: Math.ceil(req.messages.reduce((n, m) => n + m.content.length, 0) / 4),
  outputTokens: Math.ceil(out.length / 4),
});
