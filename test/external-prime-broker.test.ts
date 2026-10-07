import { beforeEach, afterEach, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ safeStorage: {}, shell: { openExternal: async () => undefined } }));
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { createExternalPrincipal, authenticateExternal } from '../src/main/external-prime-auth.js';
import * as broker from '../src/main/agents.js';
import { makeTempDir, removeTempDir } from './helpers.js';
import type { ExternalCaller } from '../src/shared/agent-owner.js';
import { EXTERNAL_PRIME_LIMITS } from '../src/shared/external-prime.js';
import { familyIdSchema } from '../src/shared/agent-owner.js';
import { initSessionStore, createSession, flushSessions, resetSessionStoreForTests } from '../src/main/session/store.js';
import { observeRequestCorrelation, resetCorrelationRegistryForTests } from '../src/main/session/correlation.js';
let dir: string;
let a: ExternalCaller;
let b: ExternalCaller;
beforeEach(async () => {
  dir = await makeTempDir('titan-broker-'); initConfigPath(dir);
  initSessionStore(dir); resetCorrelationRegistryForTests();
  const config = defaultConfig();
  await saveConfig({ ...config, roots: [{ name: 'project', path: dir }], externalPrime: { enabled: true, principals: [] }, multiAgent: { ...config.multiAgent, enabled: true } });
  const input = { label: 'Codex', rootIds: ['project'], capabilities: ['read' as const], browserBinding: { kind: 'extension' as const, browserId: '0123456789abcdef' }, setupProfileId: 'default' };
  a = authenticateExternal((await createExternalPrincipal(input)).token);
  b = authenticateExternal((await createExternalPrincipal(input)).token);
  broker.restoreSwarm(null); broker.onSwarmPersistNow(async () => undefined);
});
afterEach(async () => { broker.restoreSwarm(null); broker.onSwarmPersistNow(null); await flushSessions(); resetSessionStoreForTests(); vi.restoreAllMocks(); await removeTempDir(dir); });

it('isolates external A, external B and Web GPT with matching worker names through restore', async () => {
  const spawn = (caller: ExternalCaller) => broker.stageSpawn({ caller, workers: [{ task: 'review' }] });
  const first = spawn(a); await broker.persistCriticalSwarmNow(); first.commit();
  const second = spawn(b); await broker.persistCriticalSwarmNow(); second.commit();
  const web = broker.stageSpawn({ caller: { conversationId: 'web-prime' }, workers: [{ task: 'review' }] });
  await broker.persistCriticalSwarmNow(); web.commit();
  expect(first.runId).not.toBe(second.runId);
  expect(broker.statusForCaller(a).runId).toBe(first.runId);
  expect(broker.statusForCaller(b).runId).toBe(second.runId);
  expect(broker.statusForCaller({ conversationId: 'web-prime' }).runId).toBe(web.runId);
  const snapshot = broker.snapshotSwarm();
  expect(snapshot?.version).toBe(8);
  broker.restoreSwarm(snapshot);
  expect(broker.statusForCaller(a).runId).toBe(first.runId);
  expect(broker.statusForCaller(b).runId).toBe(second.runId);
  expect(() => broker.statusForCaller({ ...a } as ExternalCaller)).toThrow();
});

it('keeps ordinary Web GPT snapshots v4–7 readable', () => {
  const staged = broker.stageSpawn({ caller: { conversationId: 'legacy' }, workers: [{ task: 'review' }] });
  staged.commit();
  const source = broker.snapshotSwarm()!;
  for (const version of [4, 5, 6, 7] as const) {
    broker.restoreSwarm({ ...source, version });
    expect(broker.statusForCaller({ conversationId: 'legacy' }).runId).toBe(staged.runId);
  }
});

it('selects external families separately from immutable auth evidence and rejects foreign addresses', async () => {
  const first = broker.stageSpawn({ caller: a, family: { new: true }, workers: [{ task: 'same task' }] });
  await broker.persistCriticalSwarmNow(); first.commit();
  const second = broker.stageSpawn({ caller: a, family: { new: true }, workers: [{ task: 'same task' }] });
  await broker.persistCriticalSwarmNow(); second.commit();
  expect(first.runId).not.toBe(second.runId);
  const familyId = familyIdSchema.parse(first.runId);
  expect(broker.resolveExternalFamily(a, familyId)).toMatchObject({ familyId, runId: first.runId });
  expect(() => broker.stageSpawn({ caller: b, family: { id: familyId }, workers: [{ task: 'intruder' }] })).toThrow();
  expect(() => broker.resolveExternalFamily(b, familyId)).toThrow();
  expect(() => broker.resolveExternalFamily({ ...a } as ExternalCaller, familyId)).toThrow();
});

it('retains external dormant families beyond Web GPT age and count pruning', async () => {
  for (let i = 0; i < 17; i++) {
    const stage = broker.stageSpawn({ caller: a, family: { new: true }, workers: [{ task: `task ${i}` }] });
    await broker.persistCriticalSwarmNow(); stage.commit();
    broker.bindConversation('worker-1', `external-worker-${i}`, stage.runId);
    broker.finishAgent({ conversationId: `external-worker-${i}` }, 'done');
    broker.releaseQuiescentRun({ allowPendingReports: true }, stage.runId);
  }
  const saved = broker.snapshotSwarm()!;
  expect(saved.dormantRuns).toHaveLength(17);
  for (const family of saved.dormantRuns!) family.parkedAt = Date.now() - 8 * 24 * 60 * 60_000;
  broker.restoreSwarm(saved);
  expect(broker.snapshotSwarm()?.dormantRuns).toHaveLength(17);
});

it('reattaches an already accepted provisional fleet to the external root while refusing direct worker spawn', async () => {
  const root = broker.stageSpawn({ caller: a, workers: [{ task: 'root worker' }] });
  await broker.persistCriticalSwarmNow(); root.commit();
  expect(broker.bindConversation('worker-1', 'owned-worker', root.runId)).toBe(true);
  const session = await createSession({ conversationId: 'owned-worker' });
  const provisional = broker.stageSpawn({ caller: { requestId: 'late-worker-request' }, workers: [{ task: 'accepted before proof' }] });
  await broker.persistCriticalSwarmNow(); provisional.commit();
  observeRequestCorrelation({ requestId: 'late-worker-request', conversationId: 'owned-worker', sessionId: session.id, messageId: 'proof', tool: 'agents', observedAt: Date.now() });
  await broker.reconcileAgentRequestOwners();
  expect(broker.resolveExternalFamily(a, familyIdSchema.parse(provisional.runId)).owner).toEqual({ kind: 'external_principal', principalId: a.principalId });
  expect(() => broker.stageSpawn({ caller: { conversationId: 'owned-worker' }, workers: [{ task: 'forbidden' }] })).toThrow();
  broker.restoreSwarm(broker.snapshotSwarm());
  expect(broker.resolveExternalFamily(a, familyIdSchema.parse(provisional.runId)).owner).toEqual({ kind: 'external_principal', principalId: a.principalId });
});

it('rejects missing, malformed and duplicate v8 family addresses instead of guessing ownership', () => {
  const first = broker.stageSpawn({ caller: a, workers: [{ task: 'first' }] }); first.commit();
  const second = broker.stageSpawn({ caller: b, workers: [{ task: 'second' }] }); second.commit();
  const source = broker.snapshotSwarm()!;
  for (const familyId of [undefined, 'malformed']) {
    const saved = structuredClone(source);
    saved.activeRuns![0]!.familyId = familyId as never;
    broker.restoreSwarm(saved);
    expect(broker.snapshotSwarm()?.activeRuns).toHaveLength(1);
  }
  const duplicate = structuredClone(source);
  duplicate.activeRuns![1]!.familyId = duplicate.activeRuns![0]!.familyId;
  broker.restoreSwarm(duplicate);
  expect(broker.snapshotSwarm()?.activeRuns).toHaveLength(1);
});

it('captures one exact acceptance and delays ordinary publication and other critical capture until commit', async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const writes: Array<broker.SwarmSnapshot | null> = [];
  const ordinary: Array<broker.SwarmSnapshot | null> = [];
  broker.onSwarmPersist(() => ordinary.push(broker.snapshotSwarm()));
  broker.onSwarmPersistNow(async snapshot => { writes.push(snapshot); entered(); await gate; });
  const accepted = broker.acceptStagedSwarmMutation(() => broker.stageSpawn({ caller: a, workers: [{ task: 'ordered' }] }));
  await started;
  expect(ordinary).toHaveLength(0);
  const drain = broker.persistCriticalSwarmNow();
  await Promise.resolve();
  expect(writes).toHaveLength(1);
  expect(broker.snapshotSwarm()).toBeNull();
  release();
  const result = await accepted;
  await drain;
  expect(writes).toHaveLength(1);
  expect(ordinary.at(-1)?.activeRuns?.[0]?.runId).toBe(result.runId);
  expect(writes[0]?.activeRuns?.[0]?.runId).toBe(result.runId);
  broker.onSwarmPersist(null);
});

it('rolls a failed exact proposal back before synchronously publishing a safe snapshot', async () => {
  const ordinary: Array<broker.SwarmSnapshot | null> = [];
  broker.onSwarmPersist(() => ordinary.push(broker.snapshotSwarm()));
  broker.onSwarmPersistNow(async () => { throw new Error('exact failure'); });
  await expect(broker.acceptStagedSwarmMutation(() => broker.stageSpawn({ caller: a, workers: [{ task: 'rejected' }] }))).rejects.toThrow('exact failure');
  expect(ordinary).toEqual([null]);
  expect(broker.snapshotSwarm()).toBeNull();
  broker.onSwarmPersist(null);
});

it('accepts concurrent identical requests once and replays their exact receipt after reset and restart', async () => {
  const requestId = (await import('../src/shared/agent-owner.js')).requestIdSchema.parse(crypto.randomUUID());
  let calls = 0;
  const factory = () => {
    calls++;
    const staged = broker.stageSpawn({ caller: a, family: { new: true }, workers: [{ task: 'dedup' }] });
    return { ...staged, value: { operation: 'workers_spawn' as const, receipt: { request_id: requestId, family_id: familyIdSchema.parse(staged.runId), worker_id: 'worker-1', run_id: staged.runId, status: 'accepted' as const } } };
  };
  const input = { operation: 'workers_spawn', task: 'dedup' };
  const [first, duplicate] = await Promise.all([broker.runExternalMutation(a, requestId, input, factory), broker.runExternalMutation(a, requestId, input, factory)]);
  expect(calls).toBe(1);
  expect(duplicate.value).toEqual(first.value);
  expect(duplicate.replayed).toBe(true);
  await expect(broker.runExternalMutation(a, requestId, { ...input, task: 'changed' }, factory)).rejects.toMatchObject({ code: 'REQUEST_ID_CONFLICT' });
  broker.resetSwarm();
  const tombstones = broker.snapshotSwarm()!;
  expect(tombstones.activeRuns).toHaveLength(0);
  expect(tombstones.externalLedgers?.[0]?.records[0]?.deletedAt).toEqual(expect.any(Number));
  broker.restoreSwarm(tombstones);
  expect(broker.getExternalReceipt(a, requestId)).toEqual(first.value);
  expect(broker.getExternalReceipt(b, requestId)).toBeNull();
  expect((await broker.runExternalMutation(a, requestId, input, factory)).value).toEqual(first.value);
  expect(calls).toBe(1);
});

it('preserves immutable external family placement through dormancy and restart', async () => {
  const placement = { workspaceRootId: 'project', browserBinding: { kind: 'extension' as const, browserId: '0123456789abcdef' }, setupProfileId: 'default' };
  const stage = await broker.acceptStagedSwarmMutation(() => broker.stageSpawn({ caller: a, family: { new: true }, externalPlacement: placement, workers: [{ task: 'placed' }] }));
  const familyId = familyIdSchema.parse(stage.runId);
  broker.bindConversation('worker-1', 'placed-worker', stage.runId);
  broker.finishAgent({ conversationId: 'placed-worker' }, 'done');
  broker.releaseQuiescentRun({ allowPendingReports: true }, stage.runId);
  broker.restoreSwarm(broker.snapshotSwarm());
  const resolved = broker.resolveExternalFamily(a, familyId);
  expect(resolved.placement).toEqual(placement);
  resolved.placement!.workspaceRootId = 'mutated';
  expect(broker.resolveExternalFamily(a, familyId).placement).toEqual(placement);
  expect(() => broker.stageSpawn({ caller: a, family: { id: familyId }, externalPlacement: { ...placement, workspaceRootId: 'different' }, workers: [{ task: 'move' }] })).toThrow();
});

it('quarantines damaged external ledgers across restart without discarding Web GPT families', async () => {
  const web = broker.stageSpawn({ caller: { conversationId: 'healthy-web' }, workers: [{ task: 'keep' }] }); web.commit();
  const saved = broker.snapshotSwarm()!;
  saved.externalLedgers = [{ principalId: a.principalId, records: [{ requestId: crypto.randomUUID(), broken: true } as never] }];
  broker.restoreSwarm(saved);
  expect(() => broker.statusForCaller(a)).toThrow();
  expect(broker.statusForCaller({ conversationId: 'healthy-web' }).runId).toBe(web.runId);
  expect(() => broker.statusForCaller(b)).not.toThrow();
  broker.restoreSwarm(broker.snapshotSwarm());
  expect(() => broker.statusForCaller(a)).toThrow();
  const missing = broker.snapshotSwarm()!;
  delete missing.externalLedgers;
  broker.restoreSwarm(missing);
  expect(() => broker.statusForCaller(b)).toThrow();
  expect(broker.statusForCaller({ conversationId: 'healthy-web' }).runId).toBe(web.runId);
});

it('fails closed after a durable proposal loses commit authority without overwriting or rolling it back', async () => {
  let saved: broker.SwarmSnapshot | null = null;
  const ordinary = vi.fn();
  const rollback = vi.fn();
  broker.onSwarmPersist(ordinary);
  broker.onSwarmPersistNow(async snapshot => { saved = structuredClone(snapshot); });
  await expect(broker.acceptStagedSwarmMutation(() => {
    const staged = broker.stageSpawn({ caller: a, workers: [{ task: 'durable-before-crash' }] });
    return { ...staged, commit: () => false, rollback };
  })).rejects.toThrow();
  expect(rollback).not.toHaveBeenCalled();
  expect(ordinary).not.toHaveBeenCalled();
  const next = vi.fn(() => broker.stageSpawn({ caller: b, workers: [{ task: 'must refuse' }] }));
  await expect(broker.acceptStagedSwarmMutation(next)).rejects.toThrow();
  expect(next).not.toHaveBeenCalled();
  broker.onSwarmPersist(null);
  broker.restoreSwarm(saved);
  expect(broker.swarmStateForCaller(a).agents).toHaveLength(2);
});

it('keeps a full ledger replayable across key rotation and clears it only by revoked local disposal', async () => {
  const { requestIdSchema } = await import('../src/shared/agent-owner.js');
  const { rotateExternalPrincipal, revokeExternalPrincipal } = await import('../src/main/external-prime-auth.js');
  const requestId = requestIdSchema.parse(crypto.randomUUID());
  const initial = await broker.runExternalMutation(a, requestId, { operation: 'workers_spawn', task: 'limit' }, () => {
    const stage = broker.stageSpawn({ caller: a, workers: [{ task: 'limit' }] });
    return { ...stage, value: { operation: 'workers_spawn' as const, receipt: { request_id: requestId, family_id: familyIdSchema.parse(stage.runId), worker_id: 'worker-1', run_id: stage.runId, status: 'accepted' as const } } };
  });
  broker.resetSwarm();
  const saved = broker.snapshotSwarm()!;
  const row = saved.externalLedgers![0]!.records[0]!;
  saved.externalLedgers![0]!.records = Array.from({ length: EXTERNAL_PRIME_LIMITS.ledgerRecordsPerPrincipal }, (_, i) => {
    const id = i === 0 ? requestId : requestIdSchema.parse(crypto.randomUUID());
    return { ...row, requestId: id, receipt: { ...row.receipt, receipt: { ...row.receipt.receipt, request_id: id } } } as typeof row;
  });
  broker.restoreSwarm(saved);
  const factory = vi.fn(() => { throw new Error('must not run'); });
  await expect(broker.runExternalMutation(a, requestIdSchema.parse(crypto.randomUUID()), { operation: 'workers_spawn' }, factory)).rejects.toMatchObject({ code: 'CAPACITY_EXCEEDED' });
  expect(factory).not.toHaveBeenCalled();
  a = authenticateExternal((await rotateExternalPrincipal(a.principalId)).token);
  expect((await broker.runExternalMutation(a, requestId, { operation: 'workers_spawn', task: 'limit' }, factory)).value).toEqual(initial.value);
  await expect(broker.disposeExternalPrincipalState(a.principalId)).rejects.toThrow();
  await revokeExternalPrincipal(a.principalId);
  await broker.disposeExternalPrincipalState(a.principalId);
  expect(broker.snapshotSwarm()?.externalLedgers ?? []).toHaveLength(0);
});

it('selects one of several external families for messages without modifying caller identity', async () => {
  const first = await broker.acceptStagedSwarmMutation(() => broker.stageSpawn({ caller: a, family: { new: true }, workers: [{ task: 'first' }] }));
  const second = await broker.acceptStagedSwarmMutation(() => broker.stageSpawn({ caller: a, family: { new: true }, workers: [{ task: 'second' }] }));
  await broker.acceptStagedSwarmMutation(() => broker.stageMessages(a, [{ to: 'worker-1', text: 'only first' }], familyIdSchema.parse(first.runId)));
  const snapshot = broker.snapshotSwarm()!;
  expect(snapshot.activeRuns!.find(row => row.runId === first.runId)!.agents.find(row => row.info.id === 'worker-1')!.queue.map(row => row.text)).toEqual(['only first']);
  expect(snapshot.activeRuns!.find(row => row.runId === second.runId)!.agents.find(row => row.info.id === 'worker-1')!.queue).toEqual([]);
});

it.each([false, true])('orders UI clear after an external proposal whose exact write fails=%s', async (failWrite) => {
  const { requestIdSchema } = await import('../src/shared/agent-owner.js');
  const requestId = requestIdSchema.parse(crypto.randomUUID());
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const disk: Array<broker.SwarmSnapshot | null> = [];
  let first = true, runId = '';
  broker.onSwarmPersistNow(async value => {
    if (first) { first = false; enter(); await held; if (failWrite) throw new Error('held failure'); }
    disk.push(structuredClone(value));
  });
  const acceptance = broker.runExternalMutation(a, requestId, { operation: 'workers_spawn' }, () => {
    const staged = broker.stageSpawn({ caller: a, workers: [{ task: 'race' }] }); runId = staged.runId;
    return { ...staged, value: { operation: 'workers_spawn' as const, receipt: { request_id: requestId, family_id: familyIdSchema.parse(runId), worker_id: 'worker-1', run_id: runId, status: 'accepted' as const } } };
  });
  const outcome = acceptance.then(value => ({ value }), error => ({ error }));
  await entered;
  const clear = vi.fn(() => broker.clearAgent('prime', runId));
  const clearing = broker.mutateSwarm(clear);
  await Promise.resolve();
  expect(clear).not.toHaveBeenCalled();
  expect(broker.getExternalReceipt(a, requestId)).toBeNull();
  release();
  const result = await outcome;
  await clearing;
  expect('error' in result).toBe(failWrite);
  expect(broker.requestWorkerBootstraps(['worker-1'], runId)).toBe(0);
  if (failWrite) {
    expect(broker.getExternalReceipt(a, requestId)).toBeNull();
    expect(disk.every(value => !(value?.externalLedgers?.[0]?.records.length))).toBe(true);
  } else {
    expect(disk[0]?.activeRuns?.[0]?.agents.some(row => row.info.id === 'worker-1')).toBe(true);
    expect(disk[0]?.externalLedgers?.[0]?.records[0]?.requestId).toBe(requestId);
    broker.restoreSwarm(disk.at(-1)!);
    expect(broker.getExternalReceipt(a, requestId)?.operation).toBe('workers_spawn');
  }
});

it('restores ACK and stop receipt payloads and inbox/worker metadata without reconstructing them from hashes', async () => {
  const { requestIdSchema, reportIdSchema, receiptIdSchema } = await import('../src/shared/agent-owner.js');
  const spawned = await broker.acceptStagedSwarmMutation(() => broker.stageSpawn({ caller: a, workers: [{ task: 'metadata' }] }));
  const familyId = familyIdSchema.parse(spawned.runId);
  const ackId = requestIdSchema.parse(crypto.randomUUID()), stopId = requestIdSchema.parse(crypto.randomUUID());
  const ack = { operation: 'workers_ack' as const, receipt: { request_id: ackId, family_id: familyId, acknowledged: [reportIdSchema.parse(crypto.randomUUID())], status: 'accepted' as const } };
  const stop = { operation: 'workers_stop' as const, receipt: { request_id: stopId, family_id: familyId, worker_id: 'worker-1', status: 'accepted' as const, admission: 'blocked' as const, browser: 'unknown' as const, processes: 'running' as const } };
  for (const value of [ack, stop]) await broker.runExternalMutation(a, value.receipt.request_id, { operation: value.operation }, () => ({ value, commit: () => undefined, rollback: () => undefined }));
  broker.bindConversation('worker-1', 'metadata-worker', spawned.runId);
  broker.finishAgent({ conversationId: 'metadata-worker' }, 'result');
  const snapshot = broker.snapshotSwarm()!;
  const worker = snapshot.activeRuns![0]!.agents.find(row => row.info.id === 'worker-1')!;
  worker.info.externalStopIntent = { id: stopId, ownerRevision: a.policyRevision, runId: spawned.runId, conversationId: 'metadata-worker', turnId: 'turn-exact', createdAt: Date.now() };
  const report = snapshot.activeRuns![0]!.agents.find(row => row.info.id === 'prime')!.queue[0]!;
  report.externalDelivery = { id: receiptIdSchema.parse(crypto.randomUUID()), revision: 3, deliveredAt: Date.now() };
  broker.restoreSwarm(snapshot);
  expect(broker.getExternalReceipt(a, ackId)).toEqual(ack);
  expect(broker.getExternalReceipt(a, stopId)).toEqual(stop);
  const restored = broker.snapshotSwarm()!;
  const restoredFamily = [...(restored.activeRuns ?? []), ...(restored.dormantRuns ?? [])][0]!;
  expect(restoredFamily.agents.find(row => row.info.id === 'worker-1')!.info.externalStopIntent).toEqual(worker.info.externalStopIntent);
  expect(restoredFamily.agents.find(row => row.info.id === 'prime')!.queue[0]!.externalDelivery).toEqual(report.externalDelivery);
  const corrupt = structuredClone(restored);
  [...(corrupt.activeRuns ?? []), ...(corrupt.dormantRuns ?? [])][0]!.agents.find(row => row.info.id === 'worker-1')!.info.externalStopIntent!.ownerRevision = -1;
  broker.restoreSwarm(corrupt);
  expect(() => broker.getExternalReceipt(a, stopId)).toThrow();
});

it('awaits recorder attribution behind a paused finish without a recorder/broker lock cycle', async () => {
  const { recordToolCall, setCallAttributionListener, resetRecorderForTests } = await import('../src/main/session/recorder.js');
  const spawned = await broker.acceptStagedSwarmMutation(() => broker.stageSpawn({ caller: a, workers: [{ task: 'callback' }] }));
  expect(broker.bindConversation('worker-1', 'callback-worker', spawned.runId)).toBe(true);
  expect(broker.agentInfoForOwnedConversation('callback-worker')).not.toBeNull();
  const session = await createSession({ conversationId: 'callback-worker' });
  let enter!: () => void, release!: () => void, notify!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const callback = new Promise<void>(resolve => { notify = resolve; });
  let first = true, recorded = false;
  broker.onSwarmPersistNow(async () => { if (first) { first = false; enter(); await held; } });
  setCallAttributionListener(async () => { notify(); await broker.mutateSwarm(() => broker.noteAgentContextTokens('callback-worker', broker.WORKER_CONTEXT_CEILING_TOKENS)); });
  try {
    const finishing = broker.acceptStagedSwarmMutation(() => broker.stageWorkerConversationFinish('callback-worker', 'done'));
    await entered;
    const recording = recordToolCall({ tool: 'read', args: {}, content: [{ type: 'text', text: 'ok' }], outcome: 'ok', durationMs: 1, startedAt: Date.now(), conversationId: 'callback-worker', sessionId: session.id }).then(value => { recorded = true; return value; });
    await callback;
    expect(recorded).toBe(false);
    release();
    await Promise.all([finishing, recording]);
    expect(broker.snapshotSwarm()!.activeRuns![0]!.agents.find(row => row.info.id === 'worker-1')!.info).toMatchObject({ state: 'finished', revivable: false, contextTokens: broker.WORKER_CONTEXT_CEILING_TOKENS });
  } finally { release(); setCallAttributionListener(null); resetRecorderForTests(); }
});

it('retains malformed external family worker fences in the same snapshot without TTL downgrade', async () => {
  const stage = await broker.acceptStagedSwarmMutation(() => broker.stageSpawn({ caller: a, workers: [{ task: 'quarantine' }] }));
  broker.bindConversation('worker-1', 'quarantined-worker', stage.runId);
  const saved = broker.snapshotSwarm()!;
  saved.activeRuns![0]!.familyId = 'invalid' as never;
  broker.restoreSwarm(saved);
  const fence = broker.retiredWorkerForConversation('quarantined-worker');
  expect(fence?.quarantine).toBe(true);
  expect(broker.snapshotRetiredWorkers().workers).toHaveLength(0);
  broker.resetSwarm();
  const retained = broker.snapshotSwarm()!;
  retained.quarantinedWorkers![0]!.retiredAt = 1;
  broker.restoreSwarm(retained);
  broker.restoreRetiredWorkers({ version: 1, savedAt: Date.now(), workers: [{ id: 'worker-1', conversationId: 'quarantined-worker', reason: 'ordinary expiry', retiredAt: Date.now() }] });
  expect(broker.retiredWorkerForConversation('quarantined-worker')?.quarantine).toBe(true);
  const corrupt = broker.snapshotSwarm()!;
  corrupt.quarantinedWorkers![0]!.conversationId = '';
  expect(() => broker.restoreSwarm(corrupt)).toThrow();
});

it.each(['bootstrap failure', 'feature disable', 'prime close'] as const)('serializes a Web GPT message with %s across its exact write', async (action) => {
  const caller = { conversationId: 'race-web-prime' };
  const initial = await broker.acceptStagedSwarmMutation(() => broker.stageSpawn({ caller, workers: [{ task: 'web race' }] }));
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  const snapshots: Array<broker.SwarmSnapshot | null> = [];
  broker.onSwarmPersistNow(async snapshot => { snapshots.push(structuredClone(snapshot)); if (first) { first = false; enter(); await held; } });
  const message = broker.acceptStagedSwarmMutation(() => broker.stageMessages(caller, [{ to: 'worker-1', text: 'accepted before teardown' }]));
  await entered;
  const mutation = vi.fn(() => {
    if (action === 'bootstrap failure') broker.failAgent('worker-1', 'bootstrap failed', undefined, {}, initial.runId);
    else if (action === 'feature disable') broker.pauseSwarmForDisable();
    else broker.primeConversationGone('race-web-prime');
  });
  const teardown = broker.mutateSwarm(mutation);
  await Promise.resolve(); expect(mutation).not.toHaveBeenCalled();
  release(); await message; await teardown;
  expect(snapshots[0]!.activeRuns![0]!.agents.find(row => row.info.id === 'worker-1')!.queue.map(row => row.text)).toContain('accepted before teardown');
});

it('does not capture a queued Web GPT stage when the preceding external exact write fails', async () => {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  broker.onSwarmPersistNow(async () => { if (first) { first = false; enter(); await held; throw new Error('first fails'); } });
  const external = broker.acceptStagedSwarmMutation(() => broker.stageSpawn({ caller: a, workers: [{ task: 'fail' }] })).catch(error => error);
  await entered;
  const factory = vi.fn(() => broker.stageSpawn({ caller: { conversationId: 'queued-web' }, workers: [{ task: 'succeed' }] }));
  const web = broker.acceptStagedSwarmMutation(factory);
  await Promise.resolve(); expect(factory).not.toHaveBeenCalled();
  release(); expect(await external).toMatchObject({ message: 'first fails' }); await web;
  expect(broker.snapshotSwarm()!.activeRuns).toHaveLength(1);
  expect(broker.snapshotSwarm()!.activeRuns![0]!.owner).toEqual({ kind: 'chatgpt_conversation', conversationId: 'queued-web' });
});

it('refuses a v8 family container whose worker identities cannot be recovered', () => {
  const stage = broker.stageSpawn({ caller: a, workers: [{ task: 'corrupt identity' }] }); stage.commit();
  const saved = broker.snapshotSwarm()!;
  saved.activeRuns![0] = null as never;
  expect(() => broker.restoreSwarm(saved)).toThrow('Corrupt worker family identity');
});


it.each(['activeRuns', 'dormantRuns'] as const)('refuses missing or malformed v8 %s before clearing existing authority', (key) => {
  const stage = broker.stageSpawn({ caller: a, workers: [{ task: 'known authority' }] }); stage.commit();
  broker.bindConversation('worker-1', 'known-authority-worker', stage.runId);
  const original = broker.snapshotSwarm()!;
  for (const value of [undefined, null, {}, 'lost']) {
    const damaged = structuredClone(original); (damaged as any)[key] = value;
    const unchanged = structuredClone(damaged);
    expect(() => broker.restoreSwarm(damaged)).toThrow('Corrupt swarm authority envelope');
    expect(damaged).toEqual(unchanged);
    expect(broker.isWorkerConversation('known-authority-worker')).toBe(true);
  }
});

it.each(['missing id', 'duplicate id', 'bad role', 'bad conversation'] as const)('refuses lossy external worker restoration: %s', (damage) => {
  const stage = broker.stageSpawn({ caller: a, workers: [{ task: 'known authority' }] }); stage.commit();
  broker.bindConversation('worker-1', 'known-authority-worker', stage.runId);
  const saved = broker.snapshotSwarm()!;
  const rows = saved.activeRuns![0]!.agents;
  const worker = rows.find(row => row.info.role === 'worker')!;
  if (damage === 'missing id') delete (worker.info as any).id;
  if (damage === 'duplicate id') rows.push(structuredClone(worker));
  if (damage === 'bad role') (worker.info as any).role = 'other';
  if (damage === 'bad conversation') (worker.info as any).conversationId = {};
  const original = structuredClone(saved);
  expect(() => broker.restoreSwarm(saved)).toThrow('Corrupt external worker identity');
  expect(saved).toEqual(original);
  expect(broker.isWorkerConversation('known-authority-worker')).toBe(true);
});


it.each([{ clear: false, external: true }, { clear: true, external: true }, { clear: false, external: false }, { clear: true, external: false }])('orders late custody after an in-flight snapshot and rechecks queued authority: %j', async ({ clear, external }) => {
  const root = broker.stageSpawn({ caller: external ? a : { conversationId: 'custody-prime' }, workers: [{ task: 'root' }] }); root.commit();
  broker.bindConversation('worker-1', 'custody-worker', root.runId);
  const summary = await createSession({ conversationId: 'custody-worker' });
  const provisional = broker.stageSpawn({ caller: { requestId: 'custody-request' }, workers: [{ task: 'provisional' }] }); provisional.commit();
  const store = await import('../src/main/session/store.js');
  const session = await store.getSession(summary.id);
  vi.spyOn(store, 'getSession').mockResolvedValue(session);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const writes: Array<broker.SwarmSnapshot | null> = [];
  broker.onSwarmPersistNow(async snapshot => { writes.push(structuredClone(snapshot)); if (writes.length === 1) { enter(); await held; } });
  const barrier = broker.persistCriticalSwarmNow(); await entered;
  const cleared = clear ? broker.mutateSwarm(() => broker.resetSwarm()) : Promise.resolve();
  observeRequestCorrelation({ requestId: 'custody-request', conversationId: 'custody-worker', sessionId: summary.id, messageId: 'proof', tool: 'agents', observedAt: Date.now() });
  const reconcile = broker.reconcileAgentRequestOwners();
  await Promise.resolve(); await Promise.resolve();
  const during = broker.snapshotSwarm()!.activeRuns!.find(row => row.runId === provisional.runId)!.owner;
  release(); await barrier; await cleared; await reconcile;
  expect(during).toEqual({ kind: 'chatgpt_request', requestId: 'custody-request' });
  if (clear) expect(writes.at(-1)?.activeRuns ?? []).toHaveLength(0);
  else expect(writes.at(-1)!.activeRuns!.find(row => row.runId === provisional.runId)!.owner).toEqual(external ? { kind: 'external_principal', principalId: a.principalId } : { kind: 'chatgpt_conversation', conversationId: 'custody-prime' });
});
