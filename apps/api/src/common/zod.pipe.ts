import { type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

/** Validates a body/query against a Zod schema; unknown fields are rejected by `.strict()` schemas. */
export class ZodPipe<T extends z.ZodType> implements PipeTransform {
  constructor(private readonly schema: T) {}
  transform(value: unknown): z.infer<T> {
    return this.schema.parse(value); // ZodError is mapped to 400 by ProblemFilter
  }
}
