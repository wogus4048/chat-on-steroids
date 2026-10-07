import { it, expect, vi } from 'vitest';
vi.mock('electron', () => ({ safeStorage: {}, shell: { openExternal: async () => undefined } }));
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { createExternalPrincipal, authenticateExternal } from '../src/main/external-prime-auth.js';
import * as broker from '../src/main/agents.js';
import { EXTERNAL_PRIME_LIMITS } from '../src/shared/external-prime.js';
import { familyIdSchema, requestIdSchema, reportIdSchema } from '../src/shared/agent-owner.js';
import { initDurableStore, writeDurableNow, resetDurableForTests } from '../src/main/durable.js';
import { makeTempDir, removeTempDir } from './helpers.js';

it.skipIf(process.env.COS_RUN_LEDGER_PERF !== '1')('measures acceptance at the maximum principal and record counts', async () => {
  const recordsPerPrincipal = EXTERNAL_PRIME_LIMITS.ledgerRecordsPerPrincipal;
  const dir = await makeTempDir('titan-ledger-perf-');
  try {
    initConfigPath(dir); initDurableStore(dir); broker.resetAgentsForTests();
    const config = defaultConfig();
    await saveConfig({ ...config, roots: [{ name: 'project', path: dir }], externalPrime: { enabled: true, principals: [] }, multiAgent: { ...config.multiAgent, enabled: true } });
    const caller = authenticateExternal((await createExternalPrincipal({ label: 'perf', rootIds: ['project'], capabilities: ['read'], browserBinding: { kind: 'extension', browserId: '0123456789abcdef' }, setupProfileId: 'default' })).token);
    const spawn = broker.stageSpawn({ caller, workers: [{ task: 'fixture' }] }); spawn.commit();
    const snapshot = broker.snapshotSwarm()!;
    const familyId = familyIdSchema.parse(spawn.runId);
    const reports = Array.from({ length: 20 }, () => reportIdSchema.parse(randomUUID()));
    snapshot.externalLedgers = Array.from({ length: 16 }, (_, principal) => ({ principalId: principal === 0 ? caller.principalId : randomUUID(), records: Array.from({ length: principal === 0 ? recordsPerPrincipal - 1 : recordsPerPrincipal }, () => {
      const requestId = requestIdSchema.parse(randomUUID());
      return { requestId, operation: 'workers_ack' as const, inputHash: 'a'.repeat(64), familyId, status: 'accepted' as const, createdAt: Date.now(), deletedAt: Date.now(), receipt: { operation: 'workers_ack' as const, receipt: { request_id: requestId, family_id: familyId, acknowledged: reports, status: 'accepted' as const } } };
    }) }));
    broker.restoreSwarm(snapshot);
    const recordBytes = Buffer.byteLength(JSON.stringify(snapshot.externalLedgers[0]!.records[0]));
    let writeMs = 0, bytes = 0, maxLagMs = 0;
    let last = performance.now();
    const interval = setInterval(() => { const now = performance.now(); maxLagMs = Math.max(maxLagMs, now - last - 1); last = now; }, 1);
    broker.onSwarmPersistNow(async (value, options) => {
      bytes = Buffer.byteLength(JSON.stringify(value));
      const start = performance.now(); await writeDurableNow('swarm', value, options); writeMs = performance.now() - start;
    });
    const before = process.memoryUsage();
    const requestId = requestIdSchema.parse(randomUUID());
    const start = performance.now();
    await broker.runExternalMutation(caller, requestId, { operation: 'workers_ack', reports }, () => ({ value: { operation: 'workers_ack', receipt: { request_id: requestId, family_id: familyId, acknowledged: reports, status: 'accepted' } }, commit: () => undefined, rollback: () => undefined }));
    const acceptanceMs = performance.now() - start;
    await new Promise(resolve => setImmediate(resolve)); clearInterval(interval);
    const after = process.memoryUsage();
    console.log('ledger_perf', JSON.stringify({ principals: 16, records: recordsPerPrincipal * 16, recordBytes, snapshotBytes: bytes, acceptanceMs, writeMs, maxLagMs, rssBefore: before.rss, rssAfter: after.rss, heapBefore: before.heapUsed, heapAfter: after.heapUsed }));
    expect(acceptanceMs).toBeLessThan(30000);
  } finally { broker.resetAgentsForTests(); resetDurableForTests(); await removeTempDir(dir); }
}, 120000);
