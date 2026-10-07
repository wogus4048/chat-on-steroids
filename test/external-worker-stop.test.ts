import { beforeEach, afterEach, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ safeStorage: {}, shell: { openExternal: async () => undefined } }));
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { createExternalPrincipal, authenticateExternal } from '../src/main/external-prime-auth.js';
import * as broker from '../src/main/agents.js';
import * as service from '../src/main/external-prime-service.js';
import { makeTempDir, removeTempDir } from './helpers.js';
import type { ExternalCaller } from '../src/shared/agent-owner.js';
import { requestIdSchema } from '../src/shared/agent-owner.js';
import { initSessionStore, flushSessions, resetSessionStoreForTests } from '../src/main/session/store.js';
let dir: string, a: ExternalCaller;
let drop: () => void;
const browser = vi.fn();
const args = () => ({ request_id: requestIdSchema.parse(crypto.randomUUID()), family: { new: true as const }, task: 'review', workspace_root_id: 'project' });
beforeEach(async () => {
  dir = await makeTempDir('external-service-'); initConfigPath(dir); initSessionStore(dir);
  const config = defaultConfig();
  await saveConfig({ ...config, roots: [{ name: 'project', path: dir }], externalPrime: { enabled: true, principals: [] }, multiAgent: { ...config.multiAgent, enabled: true } });
  const input = { label: 'Codex', rootIds: ['project'], capabilities: ['read' as const], browserBinding: { kind: 'extension' as const, browserId: '0123456789abcdef' }, setupProfileId: 'default' };
  a = authenticateExternal((await createExternalPrincipal(input)).token);
  broker.restoreSwarm(null); broker.onSwarmPersistNow(async () => undefined); browser.mockClear(); drop = broker.onSpawnRequest(browser);
});
afterEach(async () => { drop(); broker.restoreSwarm(null); broker.onSwarmPersistNow(null); await flushSessions(); resetSessionStoreForTests(); vi.restoreAllMocks(); await removeTempDir(dir); });
it('durably stops an invited worker without inventing a conversation or publishing browser work', async () => {
  const worker = await service.spawnExternal(a, args()); browser.mockClear();
  const stop = await service.stopExternal(a, { request_id: requestIdSchema.parse(crypto.randomUUID()), family_id: worker.family_id, worker_id: worker.worker_id });
  expect(stop).toMatchObject({ admission: 'blocked', browser: 'unknown', processes: 'unknown' });
  expect(browser).not.toHaveBeenCalled();
  const info = broker.snapshotSwarm()!.activeRuns![0]!.agents.find(row => row.info.id === worker.worker_id)!.info;
  expect(info.externalStopIntent).toBeDefined(); expect(info.externalStopIntent!.conversationId).toBeUndefined();
  broker.restoreSwarm(broker.snapshotSwarm());
  await expect(service.messageExternal(a, { request_id: requestIdSchema.parse(crypto.randomUUID()), family_id: worker.family_id, worker_id: worker.worker_id, message: 'continue', resume: false })).rejects.toMatchObject({ code: 'ACCESS_REVOKED' });
});
it('keeps prior admission on persistence failure and fences stop resume ABA', async () => {
  const worker = await service.spawnExternal(a, args()); broker.bindConversation(worker.worker_id, 'stop-worker', worker.run_id);
  const policy = await import('../src/main/session/conversation-access.js');
  const old = policy.captureExternalWorkerAdmission('stop-worker')!;
  broker.onSwarmPersistNow(async () => { throw new Error('disk'); });
  await expect(service.stopExternal(a, { request_id: requestIdSchema.parse(crypto.randomUUID()), family_id: worker.family_id, worker_id: worker.worker_id })).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' });
  expect(() => old()).not.toThrow(); broker.onSwarmPersistNow(async () => undefined);
  await service.stopExternal(a, { request_id: requestIdSchema.parse(crypto.randomUUID()), family_id: worker.family_id, worker_id: worker.worker_id });
  expect(() => old()).toThrow();
  await service.messageExternal(a, { request_id: requestIdSchema.parse(crypto.randomUUID()), family_id: worker.family_id, worker_id: worker.worker_id, message: 'continue', resume: true });
  expect(() => old()).toThrow(); expect(() => policy.captureExternalWorkerAdmission('stop-worker')!()).not.toThrow();
});
it('publishes no speculative stop generation while its write is pending', async () => {
  const worker = await service.spawnExternal(a, args()); broker.bindConversation(worker.worker_id, 'pending-stop', worker.run_id);
  const policy = await import('../src/main/session/conversation-access.js'); const old = policy.captureExternalWorkerAdmission('pending-stop')!;
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); const ready = new Promise<void>(resolve => { started = resolve; });
  broker.onSwarmPersistNow(async () => { started(); await gate; });
  const pending = service.stopExternal(a, { request_id: requestIdSchema.parse(crypto.randomUUID()), family_id: worker.family_id, worker_id: worker.worker_id });
  await ready; expect(() => old()).not.toThrow(); expect(broker.workerPrimeOwner('pending-stop').stopIntent).toBeUndefined();
  release(); await pending; expect(() => old()).toThrow();
});
it('requires explicit resume before dormant reactivation and rolls back a failed resume write', async () => {
  const worker = await service.spawnExternal(a, args()); broker.bindConversation(worker.worker_id, 'dormant-stop', worker.run_id);
  broker.finishAgent({ conversationId: 'dormant-stop' }, 'done'); broker.releaseQuiescentRun();
  await service.stopExternal(a, { request_id: requestIdSchema.parse(crypto.randomUUID()), family_id: worker.family_id, worker_id: worker.worker_id });
  const before = broker.workerPrimeOwner('dormant-stop'); const wake = vi.fn(); const remove = broker.onReviveRequest(wake);
  const message = { request_id: requestIdSchema.parse(crypto.randomUUID()), family_id: worker.family_id, worker_id: worker.worker_id, message: 'new work', resume: false };
  await expect(service.messageExternal(a, message)).rejects.toMatchObject({ code: 'ACCESS_REVOKED' });
  expect(broker.workerPrimeOwner('dormant-stop')).toEqual(before); expect(wake).not.toHaveBeenCalled();
  broker.onSwarmPersistNow(async () => { throw new Error('disk'); });
  await expect(service.messageExternal(a, { ...message, resume: true })).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' });
  expect(broker.workerPrimeOwner('dormant-stop').admissionRevision).toBe(before.admissionRevision);
  expect(broker.workerPrimeOwner('dormant-stop').stopIntent).toEqual(before.stopIntent); expect(wake).not.toHaveBeenCalled(); remove();
});
it('keeps late finish and restart from restoring stopped execution authority', async () => {
  const worker = await service.spawnExternal(a, args()); broker.bindConversation(worker.worker_id, 'late-finish', worker.run_id);
  await service.stopExternal(a, { request_id: requestIdSchema.parse(crypto.randomUUID()), family_id: worker.family_id, worker_id: worker.worker_id });
  broker.finishAgent({ conversationId: 'late-finish' }, 'late result'); broker.restoreSwarm(broker.snapshotSwarm());
  const policy = await import('../src/main/session/conversation-access.js'); expect(() => policy.externalWorkerGrant('late-finish')).toThrow();
});
it('records historical native evidence durably without settling processes or changing resumed authority', async () => {
  const worker = await service.spawnExternal(a, args()); broker.bindConversation(worker.worker_id, 'historical-stop', worker.run_id);
  const request_id = requestIdSchema.parse(crypto.randomUUID());
  await service.stopExternal(a, { request_id, family_id: worker.family_id, worker_id: worker.worker_id });
  const old = broker.workerPrimeOwner('historical-stop');
  const binding = { principalId: a.principalId, familyId: worker.family_id, workerId: worker.worker_id, runId: old.runId!, conversationId: 'historical-stop', policyRevision: old.stopIntent!.ownerRevision, admissionRevision: old.admissionRevision!, stopId: request_id };
  await service.messageExternal(a, { request_id: requestIdSchema.parse(crypto.randomUUID()), family_id: worker.family_id, worker_id: worker.worker_id, message: 'next', resume: true });
  const current = broker.workerPrimeOwner('historical-stop');
  broker.onSwarmPersistNow(async () => { throw new Error('disk'); });
  await expect(broker.recordExternalStopEvidence(binding, { browser: 'stopped' })).rejects.toThrow();
  expect(broker.getExternalReceipt(a, request_id)?.receipt).toMatchObject({ browser: 'unknown', processes: 'unknown' });
  broker.onSwarmPersistNow(async () => undefined); await broker.recordExternalStopEvidence(binding, { browser: 'stopped', processes: 'running' });
  broker.restoreSwarm(broker.snapshotSwarm());
  expect(broker.getExternalReceipt(a, request_id)?.receipt).toMatchObject({ browser: 'stopped', processes: 'running', status: 'accepted' });
  expect(broker.workerPrimeOwner('historical-stop').admissionRevision).toBe(current.admissionRevision); expect(broker.workerPrimeOwner('historical-stop').stopIntent).toBeUndefined();
});
it('fails closed on duplicate worker conversation and invalid restored admission revision', async () => {
  const worker = await service.spawnExternal(a, args()); broker.bindConversation(worker.worker_id, 'duplicate-worker', worker.run_id);
  const snapshot = broker.snapshotSwarm()!; const family = snapshot.activeRuns![0]!;
  const row = family.agents.find(value => value.info.id === worker.worker_id)!;
  family.agents.push({ ...structuredClone(row), info: { ...row.info, id: 'worker-2' } }); broker.restoreSwarm(snapshot);
  expect(broker.workerPrimeOwner('duplicate-worker').owner).toBeUndefined();
  row.info.externalAdmissionRevision = Number.MAX_SAFE_INTEGER + 1; broker.restoreSwarm(snapshot);
  expect(() => service.statusExternal(a, {})).toThrow();
});
it('matches every external stop binding field and retains only the exact current intent', async () => {
  const worker = await service.spawnExternal(a, args()); broker.bindConversation(worker.worker_id, 'exact-binding', worker.run_id);
  const stopId = requestIdSchema.parse(crypto.randomUUID()); await service.stopExternal(a, { request_id: stopId, family_id: worker.family_id, worker_id: worker.worker_id });
  const owner = broker.workerPrimeOwner('exact-binding');
  const binding = { principalId: a.principalId, familyId: worker.family_id, workerId: worker.worker_id, runId: owner.runId!, conversationId: 'exact-binding', policyRevision: owner.stopIntent!.ownerRevision, admissionRevision: owner.admissionRevision!, stopId };
  expect(broker.externalStopBindingCurrent(binding)).toBe(true);
  for (const key of Object.keys(binding) as Array<keyof typeof binding>) {
    const changed = { ...binding, [key]: typeof binding[key] === 'number' ? Number(binding[key]) + 1 : crypto.randomUUID() };
    expect(broker.externalStopBindingCurrent(changed)).toBe(false);
  }
});
