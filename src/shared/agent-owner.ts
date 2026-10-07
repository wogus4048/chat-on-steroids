import { z } from 'zod';

export const familyIdSchema = z.string().uuid().brand<'FamilyId'>();
export const principalIdSchema = z.string().uuid().brand<'PrincipalId'>();
export const requestIdSchema = z.string().uuid().brand<'RequestId'>();
export const reportIdSchema = z.string().uuid().brand<'ReportId'>();
export const receiptIdSchema = z.string().uuid().brand<'ReceiptId'>();
export type FamilyId = z.infer<typeof familyIdSchema>;
export type PrincipalId = z.infer<typeof principalIdSchema>;
export type RequestId = z.infer<typeof requestIdSchema>;
export type ReportId = z.infer<typeof reportIdSchema>;
export type ReceiptId = z.infer<typeof receiptIdSchema>;

export const agentOwnerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('chatgpt_conversation'), conversationId: z.string().min(1).max(256) }).strict(),
  z.object({ kind: z.literal('chatgpt_request'), requestId: z.string().min(1).max(256) }).strict(),
  z.object({ kind: z.literal('external_principal'), principalId: principalIdSchema }).strict()
]);
export type AgentOwner = z.infer<typeof agentOwnerSchema>;
/** Existing transport/page evidence; these fields never come from model arguments. */
export interface ChatGptCaller {
  kind?: 'chatgpt';
  conversationId?: string | null;
  requestId?: string | null;
  sessionId?: string | null;
  setupProfileId?: string | null;
  runId?: string;
}
declare const authenticatedExternal: unique symbol;
/** Nominal type plus runtime evidence checked by external-prime-auth at every admission. */
export interface ExternalCaller {
  readonly kind: 'external_principal';
  readonly principalId: PrincipalId;
  readonly policyRevision: number;
  readonly setupProfileId: string;
  readonly [authenticatedExternal]: true;
}
export type Caller = ChatGptCaller | ExternalCaller;
