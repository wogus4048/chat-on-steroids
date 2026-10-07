import { z } from 'zod';
import { CAPABILITIES } from './types.js';
import { familyIdSchema, principalIdSchema, requestIdSchema, reportIdSchema, receiptIdSchema } from './agent-owner.js';

export const EXTERNAL_PRIME_LIMITS = Object.freeze({ principals: 16, familiesPerPrincipal: 64, ledgerRecordsPerPrincipal: 1000, httpBodyBytes: 256 * 1024, resultFileBytes: 1024 * 1024, resultPageBytes: 16384, listEnvelopeBytes: 65536, statusDefault: 50, statusMax: 100, reportsDefault: 10, reportsMax: 20, reportsTextChars: 32000, taskChars: 4000 });
/** Existing sandbox virtual root names, not new UUIDs or physical paths. */
export const workspaceRootIdSchema = z.string().min(1).max(32).regex(/^[a-z0-9][a-z0-9._-]*$/);
export const setupProfileIdSchema = z.string().min(1).max(64);
/** The companion's x-extension-browser identity, distinct from debugger browser UUIDs. */
export const extensionBrowserIdSchema = z.string().regex(/^[a-z0-9]{16,64}$/);
export const browserBindingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('extension'), browserId: extensionBrowserIdSchema }).strict(),
  z.object({ kind: z.literal('cos'), browserId: extensionBrowserIdSchema }).strict()
]);
export type ExternalBrowserBinding = z.infer<typeof browserBindingSchema>;
export const externalPrincipalInputSchema = z.object({ label: z.string().trim().min(1).max(80), rootIds: z.array(workspaceRootIdSchema).max(64).refine(ids => new Set(ids).size === ids.length), capabilities: z.array(z.enum(CAPABILITIES)).max(CAPABILITIES.length).refine(values => new Set(values).size === values.length), browserBinding: browserBindingSchema, setupProfileId: setupProfileIdSchema }).strict();
export const externalPrincipalSchema = externalPrincipalInputSchema.extend({ principalId: principalIdSchema, tokenHash: z.string().regex(/^[a-f0-9]{64}$/), policyRevision: z.number().int().min(1), revoked: z.boolean(), createdAt: z.number().int().nonnegative() }).strict();
export type ExternalPrincipal = z.infer<typeof externalPrincipalSchema>;
export type ExternalPrincipalInput = z.input<typeof externalPrincipalInputSchema>;
export const externalPrimeSettingsSchema = z.object({ enabled: z.boolean(), principals: z.array(externalPrincipalSchema).max(EXTERNAL_PRIME_LIMITS.principals).refine(rows => new Set(rows.map(row => row.principalId)).size === rows.length, 'Duplicate principal') }).strict();
export type ExternalPrimeSettings = z.infer<typeof externalPrimeSettingsSchema>;
export const DEFAULT_EXTERNAL_PRIME: ExternalPrimeSettings = { enabled: false, principals: [] };

export const EXTERNAL_ERROR_CODES = ['INVALID_ARGUMENT', 'UNAUTHENTICATED', 'NOT_OWNED', 'NOT_FOUND', 'ACCESS_REVOKED', 'REQUEST_ID_CONFLICT', 'CAPACITY_EXCEEDED', 'BROWSER_UNAVAILABLE', 'PERSISTENCE_FAILED', 'RESULT_UNAVAILABLE', 'INTERNAL_ERROR'] as const;
export type ExternalErrorCode = typeof EXTERNAL_ERROR_CODES[number];
export const externalErrorSchema = z.object({ ok: z.literal(false), error: z.object({ code: z.enum(EXTERNAL_ERROR_CODES), message: z.string().min(1).max(1000) }).strict(), request_id: requestIdSchema.optional() }).strict();
export const mutationStatusSchema = z.enum(['accepted', 'unknown', 'settled']);
const workerId = z.string().regex(/^worker-[1-9][0-9]*$/).max(80);
const text = z.string().trim().min(1).max(EXTERNAL_PRIME_LIMITS.taskChars);
const cursor = z.string().min(1).max(2048);
const uuid = z.string().uuid();
const revision = z.number().int().min(1);
const familySelector = z.union([z.object({ new: z.literal(true) }).strict(), z.object({ id: familyIdSchema }).strict()]);
export const externalToolSchemas = {
  workers_status: z.object({ family_id: familyIdSchema.optional(), request_id: requestIdSchema.optional(), cursor: cursor.optional(), limit: z.number().int().min(1).max(100).optional() }).strict()
    .refine(value => value.request_id === undefined || (value.family_id === undefined && value.cursor === undefined && value.limit === undefined), 'Receipt lookup excludes family and pagination'),
  workers_spawn: z.object({ request_id: requestIdSchema, family: familySelector, task: text, context: z.string().max(EXTERNAL_PRIME_LIMITS.taskChars).optional(), model: z.string().trim().min(1).max(80).optional(), workspace_root_id: workspaceRootIdSchema }).strict(),
  workers_message: z.object({ request_id: requestIdSchema, family_id: familyIdSchema, worker_id: workerId, message: text, resume: z.boolean().default(false) }).strict(),
  workers_reports: z.object({ family_id: familyIdSchema, cursor: cursor.optional(), limit: z.number().int().min(1).max(20).default(10) }).strict(),
  workers_ack: z.object({ request_id: requestIdSchema, family_id: familyIdSchema, receipts: z.array(z.object({ report_id: reportIdSchema, revision, delivery_receipt_id: receiptIdSchema }).strict()).min(1).max(20) }).strict(),
  workers_result: z.object({ family_id: familyIdSchema, result_id: uuid, offset: z.number().int().nonnegative().default(0), max_bytes: z.number().int().min(1).max(16384).default(16384) }).strict(),
  workers_stop: z.object({ request_id: requestIdSchema, family_id: familyIdSchema, worker_id: workerId }).strict()
};
export type ExternalToolName = keyof typeof externalToolSchemas;
export type ExternalInputs = { [K in ExternalToolName]: z.infer<typeof externalToolSchemas[K]> };
export const spawnReceiptSchema = z.object({ request_id: requestIdSchema, family_id: familyIdSchema, worker_id: workerId, run_id: uuid, status: mutationStatusSchema }).strict();
export const messageReceiptSchema = z.object({ request_id: requestIdSchema, family_id: familyIdSchema, worker_id: workerId, status: mutationStatusSchema }).strict();
export const ackReceiptSchema = z.object({ request_id: requestIdSchema, family_id: familyIdSchema, acknowledged: z.array(reportIdSchema).max(20), status: mutationStatusSchema }).strict();
export const stopReceiptSchema = messageReceiptSchema.extend({ admission: z.literal('blocked'), browser: z.enum(['stopped', 'not_running', 'unknown']), processes: z.enum(['settled', 'running', 'unknown']) }).strict();
export const externalMutationReceiptSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('workers_spawn'), receipt: spawnReceiptSchema }).strict(),
  z.object({ operation: z.literal('workers_message'), receipt: messageReceiptSchema }).strict(),
  z.object({ operation: z.literal('workers_ack'), receipt: ackReceiptSchema }).strict(),
  z.object({ operation: z.literal('workers_stop'), receipt: stopReceiptSchema }).strict()
]);
export type ExternalMutationReceipt = z.infer<typeof externalMutationReceiptSchema>;
const fitsListEnvelope = (value: unknown) => new TextEncoder().encode(JSON.stringify({ ok: true, data: value })).byteLength <= EXTERNAL_PRIME_LIMITS.listEnvelopeBytes;
const workerSummary = z.object({ worker_id: workerId, status: z.enum(['invited', 'active', 'sleeping', 'waking', 'detached', 'failed', 'finished']), task: text.optional(), conversation_id: z.string().min(1).max(256).nullable().optional() }).strict();
export const resultReferenceSchema = z.object({ result_id: uuid, total_bytes: z.number().int().nonnegative().max(EXTERNAL_PRIME_LIMITS.resultFileBytes), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const externalDataSchemas = {
  workers_status: z.union([z.object({ families: z.array(z.object({ family_id: familyIdSchema, run_id: uuid, workers: z.array(workerSummary).max(EXTERNAL_PRIME_LIMITS.statusMax) }).strict()).max(EXTERNAL_PRIME_LIMITS.familiesPerPrincipal), next_cursor: cursor.nullable() }).strict().refine(value => value.families.reduce((n, row) => n + row.workers.length, 0) <= EXTERNAL_PRIME_LIMITS.statusMax), externalMutationReceiptSchema]).refine(fitsListEnvelope, 'Status envelope exceeds limit'),
  workers_spawn: spawnReceiptSchema,
  workers_message: messageReceiptSchema,
  workers_reports: z.object({ reports: z.array(z.object({ report_id: reportIdSchema, revision, worker_id: workerId, summary: z.string().max(4000), summary_truncated: z.boolean(), result: resultReferenceSchema.optional(), delivery_receipt_id: receiptIdSchema }).strict()).max(20), next_cursor: cursor.nullable() }).strict().refine(value => value.reports.reduce((sum, report) => sum + report.summary.length, 0) <= 32000, 'Report page text exceeds limit').refine(fitsListEnvelope, 'Report envelope exceeds limit'),
  workers_ack: ackReceiptSchema,
  workers_result: z.object({ result_id: uuid, text: z.string().max(16384), offset: z.number().int().nonnegative(), next_offset: z.number().int().nonnegative(), eof: z.boolean(), total_bytes: z.number().int().nonnegative().max(EXTERNAL_PRIME_LIMITS.resultFileBytes), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().refine(value => {
    const bytes = new TextEncoder().encode(value.text).byteLength;
    return bytes <= EXTERNAL_PRIME_LIMITS.resultPageBytes && value.next_offset === value.offset + bytes && value.next_offset <= value.total_bytes && value.eof === (value.next_offset === value.total_bytes);
  }, 'Invalid result byte range'),
  workers_stop: stopReceiptSchema
};
function envelope<S extends z.ZodType>(schema: S) { return z.union([z.object({ ok: z.literal(true), data: schema }).strict(), externalErrorSchema]); }
export const externalResponseSchemas = {
  workers_status: envelope(externalDataSchemas.workers_status), workers_spawn: envelope(spawnReceiptSchema), workers_message: envelope(messageReceiptSchema), workers_reports: envelope(externalDataSchemas.workers_reports), workers_ack: envelope(ackReceiptSchema), workers_result: envelope(externalDataSchemas.workers_result), workers_stop: envelope(stopReceiptSchema)
};
export type ExternalOutputs = { [K in ExternalToolName]: z.infer<typeof externalDataSchemas[K]> };
export type ExternalResponses = { [K in ExternalToolName]: z.infer<typeof externalResponseSchemas[K]> };

export type SpawnArgs = ExternalInputs["workers_spawn"];
export type MessageArgs = ExternalInputs["workers_message"];
export type StatusArgs = ExternalInputs["workers_status"];
export type ReportQuery = ExternalInputs["workers_reports"];
export type AckArgs = ExternalInputs["workers_ack"];
export type SpawnReceipt = ExternalOutputs["workers_spawn"];
export type MessageReceipt = ExternalOutputs["workers_message"];
export type StatusResult = ExternalOutputs["workers_status"];
export type ReportPage = ExternalOutputs["workers_reports"];
export type AckReceipt = ExternalOutputs["workers_ack"];

export type StopArgs = ExternalInputs['workers_stop'];
export type StopReceipt = ExternalOutputs['workers_stop'];
export const externalStopBindingSchema = z.object({ principalId: principalIdSchema, familyId: familyIdSchema,
  workerId: workerId, runId: uuid, conversationId: z.string().min(1).max(256), policyRevision: z.number().int().positive(),
  admissionRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), stopId: requestIdSchema }).strict();
export type ExternalStopBinding = z.infer<typeof externalStopBindingSchema>;
