import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig, getConfig, initConfigPath, loadConfig, saveConfig } from '../src/main/config.js';
import { createExternalPrincipal, authenticateExternal, rotateExternalPrincipal, revokeExternalPrincipal, isExternalCallerAuthenticated } from '../src/main/external-prime-auth.js';
import { externalToolSchemas, externalResponseSchemas } from '../src/shared/external-prime.js';
import { makeTempDir, removeTempDir } from './helpers.js';
let dir: string;
const input = () => ({ label: 'Codex', rootIds: ['project'], capabilities: ['read' as const], browserBinding: { kind: 'extension' as const, browserId: '0123456789abcdef0123456789abcdef' }, setupProfileId: 'default' });
beforeEach(async () => {
  dir = await makeTempDir('titan-auth-'); initConfigPath(dir);
  const config = defaultConfig();
  await saveConfig({ ...config, roots: [{ name: 'project', path: dir }], externalPrime: { enabled: true, principals: [] } });
});
afterEach(async () => { vi.restoreAllMocks(); await removeTempDir(dir); });
describe('external principal durable identity', () => {
  it('authenticates repeated token, rejects wrong token and carries active evidence only on issued object', async () => {
    const issued = await createExternalPrincipal(input());
    const caller = authenticateExternal(issued.token);
    expect(caller).toMatchObject({ kind: 'external_principal', principalId: issued.principalId, policyRevision: 1 });
    expect(authenticateExternal(issued.token).principalId).toBe(issued.principalId);
    expect(() => authenticateExternal('wrong')).toThrow();
    expect(isExternalCallerAuthenticated(caller)).toBe(true);
    expect(isExternalCallerAuthenticated({ ...caller })).toBe(false);
    expect(isExternalCallerAuthenticated({ kind: 'external_principal', principalId: issued.principalId, policyRevision: 1 })).toBe(false);
    const disk = await fs.readFile(path.join(dir, 'config.json'), 'utf8');
    expect(disk).not.toContain(issued.token);
    expect(JSON.stringify(getConfig())).not.toContain(issued.token);
    await loadConfig(); expect(authenticateExternal(issued.token).principalId).toBe(issued.principalId);
  });
  it('rotation keeps identity and invalidates old token and authentication evidence; revoke persists', async () => {
    const issued = await createExternalPrincipal(input()); const oldCaller = authenticateExternal(issued.token);
    const rotated = await rotateExternalPrincipal(issued.principalId);
    expect(rotated.token).not.toBe(issued.token);
    expect(() => authenticateExternal(issued.token)).toThrow();
    expect(isExternalCallerAuthenticated(oldCaller)).toBe(false);
    expect(authenticateExternal(rotated.token).principalId).toBe(issued.principalId);
    await revokeExternalPrincipal(issued.principalId); await loadConfig();
    expect(() => authenticateExternal(rotated.token)).toThrow();
  });
  it('counts revoked connections against limit and refuses the seventeenth', async () => {
    const first = await createExternalPrincipal(input()); await revokeExternalPrincipal(first.principalId);
    for (let i = 1; i < 16; i++) await createExternalPrincipal(input());
    await expect(createExternalPrincipal(input())).rejects.toThrow();
    expect(getConfig().externalPrime.principals).toHaveLength(16);
  });
  it('rotation and revoke write failure preserve existing token, revision and disk', async () => {
    const issued = await createExternalPrincipal(input()); const caller = authenticateExternal(issued.token);
    const before = await fs.readFile(path.join(dir, 'config.json'), 'utf8');
    vi.spyOn(fs, 'rename').mockRejectedValue(new Error('disk refused'));
    await expect(rotateExternalPrincipal(issued.principalId)).rejects.toThrow();
    await expect(revokeExternalPrincipal(issued.principalId)).rejects.toThrow();
    expect(authenticateExternal(issued.token).policyRevision).toBe(1);
    expect(isExternalCallerAuthenticated(caller)).toBe(true);
    expect(await fs.readFile(path.join(dir, 'config.json'), 'utf8')).toBe(before);
  });
  it('creation write failure never activates a proposed principal', async () => {
    vi.spyOn(fs, 'rename').mockRejectedValue(new Error('disk refused'));
    await expect(createExternalPrincipal(input())).rejects.toThrow(); expect(getConfig().externalPrime.principals).toEqual([]);
  });
  it('disabled listener and invalid root, capability, profile or browser reject', async () => {
    for (const patch of [{ rootIds: ['missing'] }, { capabilities: ['invented'] }, { setupProfileId: 'missing' }, { browserBinding: { kind: 'extension', browserId: 'bad' } }]) {
      await expect(createExternalPrincipal({ ...input(), ...patch } as Parameters<typeof createExternalPrincipal>[0])).rejects.toThrow();
    }
    const issued = await createExternalPrincipal(input());
    await saveConfig({ ...getConfig(), externalPrime: { ...getConfig().externalPrime, enabled: false } });
    expect(() => authenticateExternal(issued.token)).toThrow();
  });
});
const id = randomUUID();
const wireInputs = {
  workers_status: {},
  workers_spawn: { request_id: id, family: { new: true }, task: 'Review', workspace_root_id: 'project' },
  workers_message: { request_id: id, family_id: id, worker_id: 'worker-1', message: 'Continue' },
  workers_reports: { family_id: id },
  workers_ack: { request_id: id, family_id: id, receipts: [{ report_id: id, revision: 1, delivery_receipt_id: id }] },
  workers_result: { family_id: id, result_id: id },
  workers_stop: { request_id: id, family_id: id, worker_id: 'worker-1' }
};
describe('seven strict external tool contracts', () => {
  it('accepts contracts and rejects caller impersonation/unknown fields on every tool', () => {
    for (const [name, args] of Object.entries(wireInputs)) {
      const schema = externalToolSchemas[name as keyof typeof externalToolSchemas];
      expect(schema.safeParse(args).success, name).toBe(true);
      expect(schema.safeParse({ ...args, principal_id: id }).success, name).toBe(false);
    }
    expect(externalToolSchemas.workers_message.parse(wireInputs.workers_message).resume).toBe(false);
    expect(externalToolSchemas.workers_reports.parse(wireInputs.workers_reports).limit).toBe(10);
    expect(externalToolSchemas.workers_result.parse(wireInputs.workers_result)).toMatchObject({ offset: 0, max_bytes: 16384 });
  });
  it('enforces required fields, UUID addresses, family exclusive selector and bounded pages/text', () => {
    for (const name of ['workers_spawn', 'workers_message', 'workers_ack', 'workers_stop'] as const) {
      const { request_id: _request, ...rest } = wireInputs[name]; expect(externalToolSchemas[name].safeParse(rest).success).toBe(false);
    }
    expect(externalToolSchemas.workers_spawn.safeParse({ ...wireInputs.workers_spawn, family: { new: true, id } }).success).toBe(false);
    expect(externalToolSchemas.workers_spawn.safeParse({ ...wireInputs.workers_spawn, family: { id } }).success).toBe(true);
    expect(externalToolSchemas.workers_spawn.safeParse({ ...wireInputs.workers_spawn, task: 'x'.repeat(4001) }).success).toBe(false);
    expect(externalToolSchemas.workers_status.safeParse({ family_id: 'bad' }).success).toBe(false);
    expect(externalToolSchemas.workers_reports.safeParse({ family_id: id, limit: 21 }).success).toBe(false);
    expect(externalToolSchemas.workers_ack.safeParse({ ...wireInputs.workers_ack, receipts: [] }).success).toBe(false);
    expect(externalToolSchemas.workers_result.safeParse({ family_id: id, max_bytes: 16385 }).success).toBe(false);
    expect(externalToolSchemas.workers_result.safeParse({ family_id: id, result_id: id, offset: -1 }).success).toBe(false);
  });
  it('validates operation-specific success and strict error envelopes', () => {
    const successes = {
      workers_status: { families: [{ family_id: id, run_id: id, workers: [{ worker_id: 'worker-1', status: 'active' }] }] },
      workers_spawn: { request_id: id, family_id: id, worker_id: 'worker-1', run_id: id, status: 'accepted' },
      workers_message: { request_id: id, family_id: id, worker_id: 'worker-1', status: 'accepted' },
      workers_reports: { reports: [{ report_id: id, revision: 1, worker_id: 'worker-1', summary: 'Done', delivery_receipt_id: id }], next_cursor: null },
      workers_ack: { request_id: id, family_id: id, acknowledged: [id], status: 'settled' },
      workers_result: { result_id: id, text: 'a', offset: 0, next_offset: 1, eof: true, total_bytes: 1, sha256: 'a'.repeat(64) },
      workers_stop: { request_id: id, family_id: id, worker_id: 'worker-1', status: 'accepted', admission: 'blocked', browser: 'unknown', processes: 'running' }
    };
    for (const [name, data] of Object.entries(successes)) {
      const schema = externalResponseSchemas[name as keyof typeof externalResponseSchemas];
      expect(schema.safeParse({ ok: true, data }).success, name).toBe(true);
      expect(schema.safeParse({ ok: true, data: { ...data, secret: 'no' } }).success, name).toBe(false);
      expect(schema.safeParse({ ok: false, error: { code: 'NOT_OWNED', message: 'Unavailable' }, request_id: id }).success, name).toBe(true);
      expect(schema.safeParse({ ok: false, error: { code: 'OTHER', message: 'bad' } }).success).toBe(false);
    }
  });
});

describe('wire boundary compatibility', () => {
  it('keeps existing virtual root spelling and empty optional shared context', () => {
    expect(externalToolSchemas.workers_spawn.safeParse({ ...wireInputs.workers_spawn, workspace_root_id: 'my.repo', context: '' }).success).toBe(true);
    expect(externalToolSchemas.workers_spawn.safeParse({ ...wireInputs.workers_spawn, workspace_root_id: '_leading' }).success).toBe(false);
    expect(externalToolSchemas.workers_spawn.safeParse({ ...wireInputs.workers_spawn, workspace_root_id: 'a'.repeat(33) }).success).toBe(false);
  });
  it('rejects response page text beyond aggregate budget and invalid stop evidence', () => {
    const reports = Array.from({ length: 9 }, () => ({ report_id: id, revision: 1, worker_id: 'worker-1', summary: 'x'.repeat(4000), delivery_receipt_id: id }));
    expect(externalResponseSchemas.workers_reports.safeParse({ ok: true, data: { reports, next_cursor: null } }).success).toBe(false);
    expect(externalResponseSchemas.workers_stop.safeParse({ ok: true, data: { request_id: id, family_id: id, worker_id: 'worker-1', status: 'accepted', admission: 'allowed', browser: 'stopped', processes: 'settled' } }).success).toBe(false);
  });
  it('returns exact durable mutation receipt fields from status schema', () => {
    const data = { operation: 'workers_stop', receipt: { request_id: id, family_id: id, worker_id: 'worker-1', status: 'unknown', admission: 'blocked', browser: 'unknown', processes: 'unknown' } };
    expect(externalResponseSchemas.workers_status.safeParse({ ok: true, data }).success).toBe(true);
    expect(externalResponseSchemas.workers_status.safeParse({ ok: true, data: { operation: 'workers_spawn', receipt: data.receipt } }).success).toBe(false);
  });
  it('never serializes raw credential to logs and rejects raw-token config writes', async () => {
    const issued = await createExternalPrincipal(input());
    const { getLog } = await import('../src/main/logger.js');
    expect(JSON.stringify(getLog())).not.toContain(issued.token);
    const before = await fs.readFile(path.join(dir, 'config.json'), 'utf8');
    const bad = { ...getConfig(), externalPrime: { ...getConfig().externalPrime, principals: getConfig().externalPrime.principals.map(row => ({ ...row, token: issued.token })) } };
    await expect(saveConfig(bad)).rejects.toThrow();
    expect(await fs.readFile(path.join(dir, 'config.json'), 'utf8')).toBe(before);
  });
});

describe('result response byte contract', () => {
  it('rejects UTF-8 overflow even when character count fits and incoherent byte ranges', () => {
    const data = { result_id: id, text: '가'.repeat(6000), offset: 0, next_offset: 18000, eof: false, total_bytes: 20000, sha256: 'a'.repeat(64) };
    expect(externalResponseSchemas.workers_result.safeParse({ ok: true, data }).success).toBe(false);
    const small = { ...data, text: '가', offset: 0, next_offset: 3, eof: true, total_bytes: 3 };
    expect(externalResponseSchemas.workers_result.safeParse({ ok: true, data: small }).success).toBe(true);
    expect(externalResponseSchemas.workers_result.safeParse({ ok: true, data: { ...small, next_offset: 2 } }).success).toBe(false);
    expect(externalResponseSchemas.workers_result.safeParse({ ok: true, data: { ...small, eof: false } }).success).toBe(false);
  });
});

describe('status selection contract', () => {
  it('accepts no selector or one selector and rejects both selectors', () => {
    const schema = externalToolSchemas.workers_status;
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ family_id: id }).success).toBe(true);
    expect(schema.safeParse({ request_id: id }).success).toBe(true);
    expect(schema.safeParse({ family_id: id, request_id: id }).success).toBe(false);
  });
});
