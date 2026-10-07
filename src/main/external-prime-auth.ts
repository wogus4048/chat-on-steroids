import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { ExternalCaller } from '../shared/agent-owner.js';
import { principalIdSchema } from '../shared/agent-owner.js';
import { EXTERNAL_PRIME_LIMITS, externalPrincipalInputSchema, type ExternalErrorCode, type ExternalPrincipalInput, type ExternalPrincipal } from '../shared/external-prime.js';
import { getConfig, updateConfig } from './config.js';

const issuedCallers = new WeakMap<object, { principalId: string; revision: number; tokenHash: string }>();
export class ExternalPrimeError extends Error {
  constructor(readonly code: ExternalErrorCode, message: string) { super(message); this.name = 'ExternalPrimeError'; }
}
const hashToken = (token: string) => createHash('sha256').update(token, 'utf8').digest();
const newToken = () => randomBytes(32).toString('base64url');

/** Credentials are returned only here/rotation, never stored in config or logged. */
export async function createExternalPrincipal(raw: ExternalPrincipalInput): Promise<{ principalId: ExternalCaller['principalId']; token: string }> {
  const input = externalPrincipalInputSchema.parse(raw);
  const principalId = principalIdSchema.parse(randomUUID()); const token = newToken();
  await updateConfig(config => {
    if (config.externalPrime.principals.length >= EXTERNAL_PRIME_LIMITS.principals) throw new ExternalPrimeError('CAPACITY_EXCEEDED', 'External connection limit reached');
    if (input.rootIds.some(id => !config.roots.some(root => root.name === id))) throw new ExternalPrimeError('INVALID_ARGUMENT', 'Approved root unavailable');
    const currentProfile = config.tunnel.profileId ?? 'default';
    if (input.setupProfileId !== currentProfile && !config.setupProfiles?.some(profile => profile.id === input.setupProfileId)) throw new ExternalPrimeError('INVALID_ARGUMENT', 'Setup profile unavailable');
    return { ...config, externalPrime: { ...config.externalPrime, principals: [...config.externalPrime.principals, { ...input, principalId, tokenHash: hashToken(token).toString('hex'), policyRevision: 1, revoked: false, createdAt: Date.now() }] } };
  });
  return { principalId, token };
}

export function authenticateExternal(token: string): ExternalCaller {
  // Bound work before hashing; all refused credentials expose the same outcome.
  if (!getConfig().externalPrime.enabled || typeof token !== 'string' || token.length !== 43 || !/^[A-Za-z0-9_-]+$/.test(token)) throw new ExternalPrimeError('UNAUTHENTICATED', 'External authentication required');
  const hash = hashToken(token); let match: ExternalPrincipal | undefined;
  // Compare every record using the same fixed digest size; no raw credential is retained.
  for (const principal of getConfig().externalPrime.principals) {
    const equal = timingSafeEqual(hash, Buffer.from(principal.tokenHash, 'hex'));
    if (equal && !principal.revoked) match = principal;
  }
  if (!match) throw new ExternalPrimeError('UNAUTHENTICATED', 'External authentication required');
  const caller = Object.freeze({ kind: 'external_principal' as const, principalId: match.principalId, policyRevision: match.policyRevision, setupProfileId: match.setupProfileId }) as ExternalCaller;
  issuedCallers.set(caller, { principalId: match.principalId, revision: match.policyRevision, tokenHash: match.tokenHash });
  return caller;
}

/** A cloned/model-created object cannot borrow the active transport authentication proof. */
export function isExternalCallerAuthenticated(caller: unknown): caller is ExternalCaller {
  if (typeof caller !== 'object' || caller === null || !getConfig().externalPrime.enabled) return false;
  const proof = issuedCallers.get(caller); if (!proof) return false;
  const principal = getConfig().externalPrime.principals.find(row => row.principalId === proof.principalId);
  return !!principal && !principal.revoked && principal.policyRevision === proof.revision && principal.tokenHash === proof.tokenHash;
}

export async function rotateExternalPrincipal(id: string): Promise<{ token: string }> {
  const principalId = principalIdSchema.parse(id); const token = newToken();
  await updateConfig(config => {
    const record = config.externalPrime.principals.find(row => row.principalId === principalId);
    if (!record || record.revoked) throw new ExternalPrimeError('NOT_FOUND', 'External connection unavailable');
    return { ...config, externalPrime: { ...config.externalPrime, principals: config.externalPrime.principals.map(row => row === record ? { ...row, tokenHash: hashToken(token).toString('hex'), policyRevision: row.policyRevision + 1 } : row) } };
  });
  return { token };
}

export async function revokeExternalPrincipal(id: string): Promise<void> {
  const principalId = principalIdSchema.parse(id);
  await updateConfig(config => {
    const record = config.externalPrime.principals.find(row => row.principalId === principalId);
    if (!record) throw new ExternalPrimeError('NOT_FOUND', 'External connection unavailable');
    return { ...config, externalPrime: { ...config.externalPrime, principals: config.externalPrime.principals.map(row => row === record && !row.revoked ? { ...row, revoked: true, policyRevision: row.policyRevision + 1 } : row) } };
  });
}
