import { z } from 'zod';
import { Language } from './enums';

export const Role = z.enum(['user', 'setter', 'admin']).meta({ id: 'Role' });
export type Role = z.infer<typeof Role>;

/** FR-AUTH-03: 3–20 chars, starts with a letter, a–z 0–9 _ . */
export const HANDLE_RE = /^[a-z][a-z0-9_.]{2,19}$/;

/** Rejected regardless of availability (PRD US-1.2 AC2). Compared case-insensitively. */
export const RESERVED_HANDLES = [
  'about',
  'admin',
  'administrator',
  'api',
  'auth',
  'codearena',
  'contest',
  'contests',
  'help',
  'interview',
  'judge',
  'login',
  'logout',
  'me',
  'mod',
  'moderator',
  'null',
  'onboarding',
  'practice',
  'profile',
  'root',
  'rules',
  'settings',
  'setter',
  'signin',
  'signout',
  'staff',
  'status',
  'support',
  'system',
  'undefined',
] as const;

export const Handle = z
  .string()
  .regex(HANDLE_RE, 'Handles are 3–20 characters: a–z, 0–9, _ and ., starting with a letter.');

export const Me = z
  .object({
    id: z.string(),
    handle: z.string().nullable(),
    name: z.string().nullable(),
    email: z.string(),
    avatarUrl: z.string().nullable(),
    role: Role,
    rating: z.number().int(),
    defaultLanguage: Language.nullable(),
    /** The server's OWNER_EMAIL account: the only one that manages admin grants (FR-AUTH-13). */
    isOwner: z.boolean(),
  })
  .strict()
  .meta({ id: 'Me' });
export type Me = z.infer<typeof Me>;

export const PatchMe = z
  .object({ handle: Handle.optional(), defaultLanguage: Language.optional() })
  .strict()
  .refine((v) => v.handle !== undefined || v.defaultLanguage !== undefined, 'Nothing to update')
  .meta({ id: 'PatchMe' });
export type PatchMe = z.infer<typeof PatchMe>;

export const HandleAvailability = z
  .object({
    available: z.boolean(),
    reason: z.enum(['invalid', 'reserved', 'taken']).optional(),
  })
  .strict()
  .meta({ id: 'HandleAvailability' });
export type HandleAvailability = z.infer<typeof HandleAvailability>;

/** `expiresAt` is epoch ms, like every timestamp on the wire. */
export const AccessToken = z
  .object({ accessToken: z.string(), expiresAt: z.number().int() })
  .strict()
  .meta({ id: 'AccessToken' });
export type AccessToken = z.infer<typeof AccessToken>;

/** Topic grammar (SD-§10): `sys`, `admin:*`, `sub:{id}`, `contest:{id}:{stream}`. */
export const Topic = z
  .string()
  .max(128)
  .regex(
    /^(sys|admin:[a-z0-9:_-]+|sub:[0-9a-f-]{36}|room:[0-9a-f-]{36}|contest:[0-9a-f-]{36}:[a-z0-9:_-]+)$/,
    'Unknown topic',
  );

export const TicketRequest = z
  .union([
    z.object({ topics: z.array(Topic).min(1).max(20) }).strict(),
    z.object({ roomId: z.string().uuid() }).strict(),
  ])
  .meta({ id: 'TicketRequest' });
export type TicketRequest = z.infer<typeof TicketRequest>;

export const TicketResponse = z
  .object({ ticket: z.string(), expiresAt: z.number().int() })
  .strict()
  .meta({ id: 'TicketResponse' });
export type TicketResponse = z.infer<typeof TicketResponse>;
