import { z } from 'zod';
import catalogueData from './catalogue.json' with { type: 'json' };

export const CATALOGUE_VERSION = '2026.4';

export interface CatalogueRecord {
  id: string;
  displayName: string;
  category: 'male' | 'neutral';
}

export interface CatalogueSource {
  name: string;
  url: string;
  license: string;
}

const typedCatalogue = catalogueData as {
  version: string;
  generatedAt: string;
  sources: CatalogueSource[];
  names: CatalogueRecord[];
};

export const catalogue = typedCatalogue.names;
export const catalogueSources = typedCatalogue.sources;

export const displayNameSchema = z
  .string()
  .trim()
  .min(1, 'Enter a name.')
  .max(40, 'Use 40 characters or fewer.');

export const customNameSchema = z
  .string()
  .trim()
  .min(1, 'Enter a baby name.')
  .max(40, 'Use 40 characters or fewer.')
  .regex(
    /^[\p{L}\p{M}][\p{L}\p{M}'’.-]*(?: [\p{L}\p{M}][\p{L}\p{M}'’.-]*)*$/u,
    'Use letters, spaces, apostrophes, hyphens, or periods.',
  );

export const decisionValueSchema = z.enum(['like', 'pass']);
export type DecisionValue = z.infer<typeof decisionValueSchema>;

export const candidateNameSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
});
export type CandidateName = z.infer<typeof candidateNameSchema>;

export const decisionSchema = z.object({
  nameId: z.string().min(1),
  value: decisionValueSchema,
  updatedAt: z.string(),
});
export type Decision = z.infer<typeof decisionSchema>;

export const matchSchema = z.object({
  nameId: z.string().min(1),
  matchedAt: z.string(),
});
export type Match = z.infer<typeof matchSchema>;

export const participantSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  role: z.enum(['creator', 'partner']),
});
export type Participant = z.infer<typeof participantSchema>;

export const bootstrapPayloadSchema = z.object({
  catalogueVersion: z.string(),
  revision: z.number().int().nonnegative(),
  lastSequence: z.number().int().nonnegative().default(0),
  room: z.object({
    publicCode: z.string(),
    partnerConnected: z.boolean(),
  }),
  participant: participantSchema,
  partnerName: z.string().nullable(),
  names: z.array(candidateNameSchema),
  queue: z.array(z.string()),
  decisions: z.array(decisionSchema),
  matches: z.array(matchSchema),
  shortlist: z.array(z.string()),
  addedByMe: z.array(z.string()),
});
export type BootstrapPayload = z.infer<typeof bootstrapPayloadSchema>;

const operationBaseSchema = z.object({
  operationId: z.string().uuid(),
  sequence: z.number().int().positive(),
  clientCreatedAt: z.string().datetime().optional(),
});

export const syncOperationSchema = z.discriminatedUnion('kind', [
  operationBaseSchema.extend({
    kind: z.literal('decision.set'),
    nameId: z.string().min(1),
    value: decisionValueSchema,
  }),
  operationBaseSchema.extend({
    kind: z.literal('decision.clear'),
    nameId: z.string().min(1),
  }),
  operationBaseSchema.extend({
    kind: z.literal('customName.add'),
    nameId: z.string().uuid(),
    displayName: customNameSchema,
  }),
  operationBaseSchema.extend({
    kind: z.literal('shortlist.set'),
    nameId: z.string().min(1),
    shortlisted: z.boolean(),
  }),
]);
export type SyncOperation = z.infer<typeof syncOperationSchema>;

export const createRoomRequestSchema = z.object({
  displayName: displayNameSchema,
});

export const joinRoomRequestSchema = z.object({
  inviteToken: z.string().min(24).max(256),
  pin: z.string().regex(/^\d{6}$/, 'Enter the six-digit PIN.'),
  displayName: displayNameSchema,
});

export const recoverRequestSchema = z.object({
  roomCode: z.string().trim().min(6).max(16),
  recoveryCode: z.string().trim().min(20).max(128),
});

export const syncRequestSchema = z.object({
  participantId: z.string().uuid().optional(),
  revision: z.number().int().nonnegative(),
  // Keep accepting larger payloads from already-installed clients. Current clients
  // send smaller batches, but an offline phone may still be running an older build.
  operations: z.array(syncOperationSchema).max(2000),
});

export interface RoomCredentials {
  roomCode: string;
  recoveryCode: string;
}

export interface CreateRoomResponse {
  bootstrap: BootstrapPayload;
  inviteToken: string;
  pin: string;
  recoveryCode: string;
}

export interface JoinRoomResponse {
  bootstrap: BootstrapPayload;
  recoveryCode: string;
}

export interface RecoverRoomResponse {
  bootstrap: BootstrapPayload;
}

export interface OperationError {
  operationId: string;
  message: string;
}

export interface SyncResponse {
  bootstrap: BootstrapPayload;
  acknowledged: string[];
  rejected: OperationError[];
}

export interface ApiErrorBody {
  message: string;
  issues?: string[];
}

export function normalizeName(value: string): string {
  return value.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}
