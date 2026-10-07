import { beforeEach, afterEach, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ safeStorage: {}, shell: { openExternal: async () => undefined } }));
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { createExternalPrincipal, authenticateExternal, revokeExternalPrincipal } from '../src/main/external-prime-auth.js';
import * as broker from '../src/main/agents.js';
import * as service from '../src/main/external-prime-service.js';
import { makeTempDir, removeTempDir } from './helpers.js';
import type { ExternalCaller } from '../src/shared/agent-owner.js';
import { familyIdSchema, requestIdSchema } from '../src/shared/agent-owner.js';
import { initSessionStore, createSession, flushSessions, resetSessionStoreForTests } from '../src/main/session/store.js';
import { EXTERNAL_PRIME_LIMITS, externalResponseSchemas } from '../src/shared/external-prime.js';
let dir: string, a: ExternalCaller, b: ExternalCaller;
let drop: () => void;
const browser = vi.fn();
const args = () => ({ request_id: requestIdSchema.parse(crypto.randomUUID()), family: { new: true as const }, task: 'review', workspace_root_id: 'project' });
beforeEach(async () => {
  dir = await makeTempDir('external-service-'); initConfigPath(dir); initSessionStore(dir);
  const config = defaultConfig();
  await saveConfig({ ...config, roots: [{ name: 'project', path: dir }], externalPrime: { enabled: true, principals: [] }, multiAgent: { ...config.multiAgent, enabled: true } });
  const input = { label: 'Codex', rootIds: ['project'], capabilities: ['read' as const], browserBinding: { kind: 'extension' as const, browserId: '0123456789abcdef' }, setupProfileId: 'default' };
  a = authenticateExternal((await createExternalPrincipal(input)).token); b = authenticateExternal((await createExternalPrincipal(input)).token);
  broker.restoreSwarm(null); broker.onSwarmPersistNow(async () => undefined); browser.mockClear(); drop = broker.onSpawnRequest(browser);
});
afterEach(async () => { drop(); broker.restoreSwarm(null); broker.onSwarmPersistNow(null); await flushSessions(); resetSessionStoreForTests(); vi.restoreAllMocks(); await removeTempDir(dir); });
it('publishes only durable spawn and never republishes a replay', async () => {
  const input = args(); broker.onSwarmPersistNow(async () => { throw new Error('disk'); });
  await expect(service.spawnExternal(a, input)).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' }); expect(browser).not.toHaveBeenCalled();
  broker.onSwarmPersistNow(async () => undefined);
  const accepted = await service.spawnExternal(a, input); expect(browser).toHaveBeenCalledTimes(1);
  expect(await service.spawnExternal(a, input)).toEqual(accepted); expect(browser).toHaveBeenCalledTimes(1);
  await expect(service.spawnExternal(a, { ...input, context: 'changed' })).rejects.toMatchObject({ code: 'REQUEST_ID_CONFLICT' });
});
it('wakes an ordinary sleeper in its existing conversation and refuses foreign families', async () => {
  const receipt = await service.spawnExternal(a, args()); broker.bindConversation(receipt.worker_id, 'existing-worker', receipt.run_id);
  broker.finishAgent({ conversationId: 'existing-worker' }, 'done');
  const input = { request_id: requestIdSchema.parse(crypto.randomUUID()), family_id: receipt.family_id, worker_id: receipt.worker_id, message: 'continue', resume: false };
  const wake = vi.fn(); const remove = broker.onReviveRequest(wake);
  await service.messageExternal(a, input); expect(wake).toHaveBeenCalledTimes(1); expect(broker.agentConversation(receipt.worker_id, wake.mock.calls[0]![0][0].runId)).toBe('existing-worker');
  await expect(service.messageExternal(b, { ...input, request_id: requestIdSchema.parse(crypto.randomUUID()) })).rejects.toMatchObject({ code: 'NOT_OWNED' }); remove();
});
it('reads without inference ACK, converges concurrent delivery and acknowledges after restart', async () => {
  const spawned = await service.spawnExternal(a, args()); broker.bindConversation(spawned.worker_id, 'report-worker', spawned.run_id);
  broker.finishAgent({ conversationId: 'report-worker' }, 'done');
  const query = { family_id: spawned.family_id, limit: 10 };
  const [first, second] = await Promise.all([service.reportsExternal(a, query), service.reportsExternal(a, query)]);
  expect(first).toEqual(second); expect(first.reports).toHaveLength(1);
  expect(broker.acknowledgeOffersForCaller(a)?.messages ?? []).toHaveLength(0);
  expect((await service.reportsExternal(a, query)).reports).toHaveLength(1);
  broker.restoreSwarm(broker.snapshotSwarm());
  const row = first.reports[0]!;
  const input = { request_id: requestIdSchema.parse(crypto.randomUUID()), family_id: spawned.family_id, receipts: [{ report_id: row.report_id, revision: row.revision, delivery_receipt_id: row.delivery_receipt_id }] };
  await expect(service.ackExternal(b, input)).rejects.toMatchObject({ code: 'NOT_OWNED' });
  await expect(service.ackExternal(a, { ...input, receipts: [{ ...input.receipts[0]!, revision: row.revision + 1 }] })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  expect((await service.ackExternal(a, input)).acknowledged).toEqual([row.report_id]);
  broker.restoreSwarm(broker.snapshotSwarm());
  expect(service.statusExternal(a, { request_id: input.request_id })).toMatchObject({ operation: 'workers_ack' });
  expect((await service.reportsExternal(a, query)).reports).toHaveLength(0);
});
it('never exposes report identity on failed persistence and refuses revoked reads', async () => {
  const spawned = await service.spawnExternal(a, args()); broker.bindConversation(spawned.worker_id, 'failure-worker', spawned.run_id); broker.finishAgent({ conversationId: 'failure-worker' }, 'done');
  broker.onSwarmPersistNow(async () => { throw new Error('disk'); });
  await expect(service.reportsExternal(a, { family_id: spawned.family_id, limit: 10 })).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' });
  await revokeExternalPrincipal(a.principalId);
  expect(() => service.statusExternal(a, {})).toThrow();
});
it('pages complete topology and rejects forged and stale cursors', async () => {
  for (let i = 0; i < 3; i++) await service.spawnExternal(a, args());
  const first = service.statusExternal(a, { limit: 1 }); if (!('families' in first)) throw new Error('list');
  expect(first.families).toHaveLength(1); expect(first.next_cursor).toEqual(expect.any(String));
  const second = service.statusExternal(a, { limit: 1, cursor: first.next_cursor! }); expect(second).not.toEqual(first);
  expect(() => service.statusExternal(b, { cursor: first.next_cursor! })).toThrow();
  await service.spawnExternal(a, args()); expect(() => service.statusExternal(a, { cursor: first.next_cursor! })).toThrow();
  expect(() => service.statusExternal(a, { family_id: familyIdSchema.parse(crypto.randomUUID()) })).toThrow();
});
it('retains complete membership above the concurrency limit without task previews', async () => {
  const spawned = await service.spawnExternal(a, args()); const snapshot = broker.snapshotSwarm()!;
  const family = snapshot.activeRuns![0]!; const worker = family.agents.find(row => row.info.role === 'worker')!;
  family.agents = [family.agents.find(row => row.info.role === 'prime')!, ...Array.from({ length: 137 }, (_, index) => ({ ...structuredClone(worker), info: { ...worker.info, id: `worker-${index + 1}`, task: 'x'.repeat(4000), state: 'sleeping' as const } }))];
  broker.restoreSwarm(snapshot);
  let cursor: string | undefined, count = 0;
  do {
    const page = service.statusExternal(a, { family_id: spawned.family_id, cursor, limit: 50 }); if (!('families' in page)) throw new Error('list');
    const envelope = { ok: true as const, data: page }; expect(externalResponseSchemas.workers_status.safeParse(envelope).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(envelope))).toBeLessThanOrEqual(EXTERNAL_PRIME_LIMITS.listEnvelopeBytes);
    count += page.families.flatMap(row => row.workers).length; expect(JSON.stringify(page)).not.toContain('task'); cursor = page.next_cursor ?? undefined;
  } while (cursor);
  expect(count).toBe(137);
});
it('bounds escaped report pages, preserves original text and exposes summary shortening', async () => {
  const spawned = await service.spawnExternal(a, args()); broker.bindConversation(spawned.worker_id, 'large-worker', spawned.run_id);
  for (let i = 0; i < 7; i++) broker.sendMessage({ conversationId: 'large-worker' }, 'prime', '\u0001'.repeat(4000));
  broker.finishAgent({ conversationId: 'large-worker' }, '😀'.repeat(2000));
  const before = broker.snapshotSwarm()!;
  const originals = before.activeRuns![0]!.agents.find(row => row.info.role === 'prime')!.queue.map(row => row.text);
  let cursor: string | undefined, count = 0, shortened = false;
  do {
    const page = await service.reportsExternal(a, { family_id: spawned.family_id, cursor, limit: 20 });
    expect(page.reports.length).toBeGreaterThan(0); expect(Buffer.byteLength(JSON.stringify({ ok: true, data: page }))).toBeLessThanOrEqual(65536);
    shortened ||= page.reports.some(row => row.summary_truncated); count += page.reports.length; cursor = page.next_cursor ?? undefined;
  } while (cursor);
  expect(count).toBe(8); expect(shortened).toBe(true);
  expect(broker.snapshotSwarm()!.activeRuns![0]!.agents.find(row => row.info.role === 'prime')!.queue.map(row => row.text)).toEqual(originals);
});
it.each(['missing', 'duplicate', 'revision', 'acked'] as const)('quarantines incoherent restored report authority: %s', async damage => {
  const spawned = await service.spawnExternal(a, args()); broker.bindConversation(spawned.worker_id, 'corrupt-worker', spawned.run_id); broker.finishAgent({ conversationId: 'corrupt-worker' }, 'done');
  await service.reportsExternal(a, { family_id: spawned.family_id, limit: 10 });
  const snapshot = broker.snapshotSwarm()!; const family = [...snapshot.activeRuns!, ...snapshot.dormantRuns!][0]!;
  const prime = family.agents.find(row => row.info.role === 'prime')!; const row = prime.queue[0]!;
  if (damage === 'missing') delete row.externalReport;
  if (damage === 'duplicate') prime.queue.push(structuredClone(row));
  if (damage === 'revision') row.externalDelivery!.revision++;
  if (damage === 'acked') row.externalDelivery!.ackedAt = Date.now();
  broker.restoreSwarm(snapshot);
  expect(() => service.statusExternal(a, {})).toThrow();
});
it('does not implicitly acknowledge an external report through ordinary broker inference', async () => {
  const spawned = await service.spawnExternal(a, args()); broker.bindConversation(spawned.worker_id, 'inference-worker', spawned.run_id); broker.finishAgent({ conversationId: 'inference-worker' }, 'done');
  await service.reportsExternal(a, { family_id: spawned.family_id, limit: 10 });
  expect(broker.offerMessagesForCaller(a)).toBeNull(); expect(broker.acknowledgeOffersForCaller(a)).toBeNull();
  expect((await service.reportsExternal(a, { family_id: spawned.family_id, limit: 10 })).reports).toHaveLength(1);
});
it('rechecks authentication after exact write without claiming the durable worker was rolled back', async () => {
  let release!: () => void; let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); const ready = new Promise<void>(resolve => { started = resolve; });
  broker.onSwarmPersistNow(async () => { started(); await gate; }); const input = args();
  const pending = service.spawnExternal(a, input); const refused = expect(pending).rejects.toMatchObject({ code: 'ACCESS_REVOKED' });
  await ready; await revokeExternalPrincipal(a.principalId); release(); await refused;
  expect(browser).not.toHaveBeenCalled(); expect(broker.snapshotSwarm()!.externalLedgers![0]!.records[0]!.requestId).toBe(input.request_id);
});
it('remeasures the durable session ceiling before waking a sleeper', async () => {
  const spawned = await service.spawnExternal(a, args()); broker.bindConversation(spawned.worker_id, 'ceiling-worker', spawned.run_id); broker.finishAgent({ conversationId: 'ceiling-worker' }, 'done');
  const session = await createSession({ conversationId: 'ceiling-worker' });
  // Session metadata is the existing authoritative measured context owner.
  const store = await import('../src/main/session/store.js');
  vi.spyOn(store, 'findSessionByConversation').mockResolvedValue({ ...session, contextTokens: 400000 });
  const wake = vi.fn(); const remove = broker.onReviveRequest(wake);
  await expect(service.messageExternal(a, { request_id: requestIdSchema.parse(crypto.randomUUID()), family_id: spawned.family_id, worker_id: spawned.worker_id, message: 'new work', resume: false })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  expect(wake).not.toHaveBeenCalled(); remove();
});
it('keeps a rejected or in-flight ACK invisible and validates a batch before any retirement', async () => {
  const spawned = await service.spawnExternal(a, args()); broker.bindConversation(spawned.worker_id, 'atomic-worker', spawned.run_id);
  broker.sendMessage({ conversationId: 'atomic-worker' }, 'prime', 'message'); broker.finishAgent({ conversationId: 'atomic-worker' }, 'done');
  const page = await service.reportsExternal(a, { family_id: spawned.family_id, limit: 10 });
  const receipts = page.reports.map(row => ({ report_id: row.report_id, revision: row.revision, delivery_receipt_id: row.delivery_receipt_id }));
  const input = { request_id: requestIdSchema.parse(crypto.randomUUID()), family_id: spawned.family_id, receipts };
  await expect(service.ackExternal(a, { ...input, receipts: [receipts[0]!, { ...receipts[1]!, revision: 9 }] })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  expect((await service.reportsExternal(a, { family_id: spawned.family_id, limit: 10 })).reports).toHaveLength(2);
  let reject!: (error: Error) => void, started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  broker.onSwarmPersistNow(async () => { started(); await new Promise<void>((_, no) => { reject = no; }); });
  const pending = service.ackExternal(a, input); const rejected = expect(pending).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' }); await ready;
  expect(broker.snapshotSwarm()!.activeRuns![0]!.agents.find(row => row.info.id === 'prime')!.queue.every(row => row.ackedAt === null)).toBe(true);
  reject(new Error('disk')); await rejected;
  broker.onSwarmPersistNow(async () => undefined);
  expect((await service.reportsExternal(a, { family_id: spawned.family_id, limit: 10 })).reports).toHaveLength(2);
  expect(broker.getExternalReceipt(a, input.request_id)).toBeNull();
});
it('keeps status cursor valid across lifecycle and run incarnation changes', async () => {
  const first = await service.spawnExternal(a, args()); await service.spawnExternal(a, args());
  const page = service.statusExternal(a, { limit: 1 }); if (!('families' in page)) throw new Error('list');
  broker.bindConversation(first.worker_id, 'cursor-worker', first.run_id); broker.finishAgent({ conversationId: 'cursor-worker' }, 'done'); broker.releaseQuiescentRun({}, first.run_id);
  await service.messageExternal(a, { request_id: requestIdSchema.parse(crypto.randomUUID()), family_id: first.family_id, worker_id: first.worker_id, message: 'wake', resume: false });
  expect(() => service.statusExternal(a, { limit: 1, cursor: page.next_cursor! })).not.toThrow();
});
it('replays durable receipts after family deletion and checks all normalized inputs', async () => {
  const input = args(); const receipt = await service.spawnExternal(a, { ...input, context: undefined }); broker.resetSwarm();
  expect(await service.spawnExternal(a, input)).toEqual(receipt); expect(browser).toHaveBeenCalledTimes(1);
  await expect(service.spawnExternal(a, { ...input, model: 'different' })).rejects.toMatchObject({ code: 'REQUEST_ID_CONFLICT' });
});
