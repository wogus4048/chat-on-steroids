import path from 'node:path';
import { promises as fs } from 'node:fs';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ safeStorage: {}, shell: {} }));
import { defaultConfig, getConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { createExternalPrincipal, authenticateExternal, revokeExternalPrincipal } from '../src/main/external-prime-auth.js';
import * as broker from '../src/main/agents.js';
import { conversationAccessRefusal } from '../src/main/session/conversation-access.js';
import { createRegistrar, dispatch, type ToolContext } from '../src/main/mcp/kernel.js';
import { registerCoreTools } from '../src/main/mcp/tools-core.js';
import { emptyEvidence, type CallContext } from '../src/main/mcp/call-context.js';
import { initSessionStore, flushSessions, resetSessionStoreForTests, createSession } from '../src/main/session/store.js';
import { makeTempDir, removeTempDir } from './helpers.js';
import { resetWorkspaces } from '../src/main/workspace.js';
let dir: string;
let principalId: string;
let ctx: ToolContext;
let caller: CallContext;
async function setup(strict: boolean) {
  const config = getConfig();
  await saveConfig({ ...config, multiAgent: { ...config.multiAgent, strictChatAllowlist: strict } });
}
beforeEach(async () => {
  dir = await makeTempDir('external-policy-'); initConfigPath(dir); initSessionStore(dir); resetWorkspaces();
  await fs.mkdir(path.join(dir, 'allowed')); await fs.mkdir(path.join(dir, 'other'));
  await fs.writeFile(path.join(dir, 'allowed', 'file.txt'), 'ALLOWED');
  await fs.writeFile(path.join(dir, 'other', 'secret.txt'), 'OTHER_ROOT_SECRET');
  await fs.symlink(path.join(dir, 'other'), path.join(dir, 'allowed', 'escape'));
  const config = defaultConfig();
  const roots = [{ name: 'allowed', path: path.join(dir, 'allowed') }, { name: 'other', path: path.join(dir, 'other') }];
  await saveConfig({ ...config, roots, externalPrime: { enabled: true, principals: [] }, multiAgent: { ...config.multiAgent, enabled: true } });
  const created = await createExternalPrincipal({ label: 'test', rootIds: ['allowed'], capabilities: ['read'], browserBinding: { kind: 'extension', browserId: 'testbrowser123456' }, setupProfileId: 'default' });
  principalId = created.principalId;
  broker.restoreSwarm(null); broker.onSwarmPersistNow(async () => undefined);
  const stage = broker.stageSpawn({ caller: authenticateExternal(created.token), externalPlacement: { workspaceRootId: 'allowed', browserBinding: { kind: 'extension', browserId: 'testbrowser123456' }, setupProfileId: 'default' }, workers: [{ task: 'policy test' }] });
  await broker.persistCriticalSwarmNow(); stage.commit();
  broker.bindConversation('worker-1', 'external-worker', stage.runId);
  const session = await createSession({ conversationId: 'external-worker' });
  caller = { startedAt: Date.now(), transportKey: null, agent: 'worker-1', caller: { transportKey: null, requestId: null, conversationId: 'external-worker', sessionId: session.id, setupProfileId: 'default' }, outcome: null, evidence: emptyEvidence() };
  ctx = { roots, caps: config.capabilities, readOnly: false, setupProfileId: 'default' };
});
afterEach(async () => { broker.restoreSwarm(null); broker.onSwarmPersistNow(null); await flushSessions(); resetSessionStoreForTests(); resetWorkspaces(); await removeTempDir(dir); });
function read(paths: string[]) { const reg = createRegistrar(null, ctx, 'core'); registerCoreTools(reg); return reg.invokeNested('read', { paths }, caller); }
for (const strict of [false, true]) {
  it(`allows external provenance in strict=${strict} without a copied worker Trust`, async () => {
    await setup(strict);
    expect(await conversationAccessRefusal('external-worker')).toBeNull();
    const result = await read(['/allowed/file.txt']);
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).toContain('ALLOWED');
  });
  it(`refuses another absolute root and symlink escape in strict=${strict}`, async () => {
    await setup(strict);
    for (const target of [path.join(dir, 'other', 'secret.txt'), '/allowed/escape/secret.txt']) {
      const result = await read([target]);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain('OTHER_ROOT_SECRET');
    }
  });
  it(`refuses revoked external owner on Core/Desktop/Plugins in strict=${strict}`, async () => {
    await setup(strict); await revokeExternalPrincipal(principalId);
    for (const surface of ['core', 'desktop', 'plugins'] as const) {
      let executed = false;
      const result = await dispatch('policy-test', {}, null, null, surface, async () => { executed = true; return { content: [] }; }, caller);
      expect(executed).toBe(false);
      expect(JSON.stringify(result)).toContain('ACCESS_REVOKED');
    }
  });
}
it('applies the read-only external capability projection to a registered command', async () => {
  const reg = createRegistrar(null, ctx, 'core'); registerCoreTools(reg);
  const result = await reg.invokeNested('exec_command', { cmd: 'printf SHOULD_NOT_EXECUTE', workdir: '/allowed' }, caller);
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toContain('TOOL_DISABLED');
});
it('restores the external default workspace from durable family placement', async () => {
  broker.restoreSwarm(broker.snapshotSwarm()); resetWorkspaces();
  const result = await read(['file.txt']);
  expect(result.isError).not.toBe(true);
  expect(JSON.stringify(result)).toContain('ALLOWED');
});
it('rejects an active owner plugin call even when read/command permissions exist', async () => {
  let executed = false;
  const result = await dispatch('plugin-tool', {}, null, null, 'plugins', async () => { executed = true; return { content: [] }; }, caller);
  expect(executed).toBe(false);
  expect(JSON.stringify(result)).toContain('ACCESS_REVOKED');
});
it('rejects revocation while a path realpath is awaited', async () => {
  const actual = fs.realpath.bind(fs);
  let resume!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const spy = vi.spyOn(fs, 'realpath').mockImplementation(async (target, options) => {
    if (String(target) === path.join(dir, 'allowed')) { entered(); await gate; }
    return actual(target, options as never);
  });
  try {
    const pending = read(['/allowed/file.txt']); await started;
    await revokeExternalPrincipal(principalId); resume();
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('ACCESS_REVOKED');
    expect(JSON.stringify(result)).not.toContain('ALLOWED');
  } finally { resume(); spy.mockRestore(); }
});
it('requires exact endpoint profile evidence for an external worker', async () => {
  caller.caller.setupProfileId = null;
  const result = await read(['/allowed/file.txt']);
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toContain('WORKER_CONNECTION_PROFILE_MISMATCH');
});
it('checks current command grant again after write_stdin waits for exact process custody', async () => {
  const ownership = await import('../src/main/codex/ownership.js');
  const recorder = await import('../src/main/session/recorder.js');
  const correlation = await import('../src/main/session/correlation.js');
  const { unifiedExecManager } = await import('../src/main/codex/manager.js');
  const config = getConfig();
  await saveConfig({ ...config, multiAgent: { ...config.multiAgent, allowUnattributedCalls: false }, externalPrime: { ...config.externalPrime, principals: config.externalPrime.principals.map(row => ({ ...row, capabilities: ['read', 'command'] })) } });
  const originalSession = caller.caller.sessionId!;
  caller.caller.sessionId = null; caller.caller.requestId = 'external-stdin-exact-proof';
  ownership.noteExecOwner(900001, originalSession);
  const write = vi.spyOn(unifiedExecManager, 'writeStdin');
  const lookup = vi.spyOn(recorder, 'awaitFreshCallOrigin').mockImplementation(async () => {
    await revokeExternalPrincipal(principalId);
    correlation.observeRequestCorrelation({ requestId: caller.caller.requestId!, conversationId: 'external-worker', sessionId: originalSession, messageId: 'stdin-proof', tool: 'write_stdin', observedAt: Date.now() });
    return null;
  });
  try {
    const reg = createRegistrar(null, ctx, 'core'); registerCoreTools(reg);
    const result = await reg.invokeNested('write_stdin', { session_id: 900001, chars: 'NEVER_SEND' }, caller);
    expect(lookup).toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('ACCESS_REVOKED');
    expect(write).not.toHaveBeenCalled();
  } finally { lookup.mockRestore(); write.mockRestore(); ownership.forgetExecOwner(900001); correlation.resetCorrelationRegistryForTests(); }
});
it('keeps numeric process IDs insufficient to access another session', async () => {
  const ownership = await import('../src/main/codex/ownership.js');
  const config = getConfig();
  await saveConfig({ ...config, externalPrime: { ...config.externalPrime, principals: config.externalPrime.principals.map(row => ({ ...row, capabilities: ['command'] })) } });
  ownership.noteExecOwner(900002, 'different-session');
  try {
    const reg = createRegistrar(null, ctx, 'core'); registerCoreTools(reg);
    const result = await reg.invokeNested('write_stdin', { session_id: 900002, chars: 'NEVER_SEND' }, caller);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('EXEC_SESSION_OWNER_MISMATCH');
  } finally { ownership.forgetExecOwner(900002); }
});
it('refuses an already queued Desktop browser action after external grant revocation', async () => {
  const { browserControl } = await import('../src/main/browser-control.js');
  const { registerDesktopTools } = await import('../src/main/mcp/tools-desktop.js');
  const config = getConfig();
  await saveConfig({ ...config, capabilities: { ...config.capabilities, screen: true }, externalPrime: { ...config.externalPrime, principals: config.externalPrime.principals.map(row => ({ ...row, capabilities: ['screen'] })) } });
  ctx = { ...ctx, caps: { ...ctx.caps, screen: true } };
  const browserId = crypto.randomUUID();
  browserControl.reset(); browserControl.poll(browserId, 'queue-test', true);
  const reg = createRegistrar(null, ctx, 'desktop'); registerDesktopTools(reg);
  const pending = reg.invokeNested('browser_tabs', { action: 'list', browserId }, caller);
  let offered!: ReturnType<typeof browserControl.poll>;
  try {
    await vi.waitFor(() => { offered = browserControl.poll(browserId, 'queue-test', true); expect(offered.requests).toHaveLength(1); });
    await revokeExternalPrincipal(principalId);
    const command = await browserControl.claim(browserId, offered.requests[0]!, offered.epoch);
    if (command) browserControl.result(browserId, command.id, offered.epoch, { value: 'WRONG_AUTHORITY_EXECUTED' });
    expect(command).toBeNull();
    const result = await pending;
    expect(result.isError).toBe(true);
  } finally { browserControl.reset(); await pending; }
});
it('keeps durable external worker origin fail-closed if live family provenance is missing', async () => {
  const { setSessionOrigin } = await import('../src/main/session/store.js');
  const owner = broker.workerPrimeOwner('external-worker');
  await setSessionOrigin(caller.caller.sessionId!, { kind: 'worker', owner: owner.owner!, familyId: owner.familyId!, fromSessionId: null, agentId: 'worker-1', task: 'policy test' }, 'external worker');
  broker.restoreSwarm(null);
  for (const surface of ['core', 'desktop', 'plugins'] as const) {
    let executed = false;
    const result = await dispatch('origin-policy', {}, null, null, surface, async () => { executed = true; return { content: [] }; }, caller);
    expect(executed).toBe(false);
    expect(JSON.stringify(result)).toContain('ACCESS_REVOKED');
  }
});
it('does not let a restored worker spend authority from a quarantined external ledger', async () => {
  const snapshot = broker.snapshotSwarm()!;
  snapshot.externalLedgerCorrupt = true;
  broker.restoreSwarm(snapshot);
  const result = await read(['/allowed/file.txt']);
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toContain('PERSISTENCE_FAILED');
});
it('keeps an explicit worker Block stronger than the external grant in either strict mode', async () => {
  const blocked = await import('../src/main/session/blocked-chats.js');
  blocked.setChatBlocked('external-worker', true);
  try {
    for (const strict of [false, true]) {
      await setup(strict);
      expect(await conversationAccessRefusal('external-worker')).toContain('CHAT_BLOCKED');
      expect((await read(['/allowed/file.txt'])).isError).toBe(true);
    }
  } finally { blocked.resetBlockedChatsForTests(); }
});
it('isolates simultaneous external calls sharing a single registered tool context', async () => {
  const created = await createExternalPrincipal({ label: 'second', rootIds: ['other'], capabilities: ['read'], browserBinding: { kind: 'extension', browserId: 'testbrowser123456' }, setupProfileId: 'default' });
  const stage = broker.stageSpawn({ caller: authenticateExternal(created.token), externalPlacement: { workspaceRootId: 'other', browserBinding: { kind: 'extension', browserId: 'testbrowser123456' }, setupProfileId: 'default' }, workers: [{ task: 'second worker' }] });
  await broker.persistCriticalSwarmNow(); stage.commit(); broker.bindConversation('worker-1', 'external-second', stage.runId);
  const session = await createSession({ conversationId: 'external-second' });
  const second = { ...caller, caller: { ...caller.caller, conversationId: 'external-second', sessionId: session.id } };
  const reg = createRegistrar(null, ctx, 'core'); registerCoreTools(reg);
  const [a, b, rejected] = await Promise.all([
    reg.invokeNested('read', { paths: ['/allowed/file.txt'] }, caller),
    reg.invokeNested('read', { paths: ['/other/secret.txt'] }, second),
    reg.invokeNested('read', { paths: ['/other/secret.txt'] }, caller)
  ]);
  expect(JSON.stringify(a)).toContain('ALLOWED'); expect(a.isError).not.toBe(true);
  expect(JSON.stringify(b)).toContain('OTHER_ROOT_SECRET'); expect(b.isError).not.toBe(true);
  expect(rejected.isError).toBe(true); expect(JSON.stringify(rejected)).not.toContain('OTHER_ROOT_SECRET');
  expect(ctx.roots).toHaveLength(2); expect(ctx.caps.command).toBe(true);
});
it('does not read or inject a managed Skill outside the external approved roots', async () => {
  const skills = await import('../src/main/skills.js');
  const { prepareSessionPrompt } = await import('../src/main/session/prompt.js');
  const { externalPlacementToolContext } = await import('../src/main/mcp/kernel.js');
  await skills.initSkillsPath(path.join(dir, 'managed'));
  const source = path.join(dir, 'outside.md');
  await fs.writeFile(source, '---\nname: Outside\ndescription: outside fixture\n---\nUNAPPROVED_SKILL_BODY');
  await skills.importSkillFile(source);
  const placement = broker.workerPrimeOwner('external-worker').externalPlacement!;
  const toolContext = () => externalPlacementToolContext(principalId, placement, ctx);
  const opened: string[] = [];
  const actual = fs.open.bind(fs);
  const spy = vi.spyOn(fs, 'open').mockImplementation(async (target, ...args) => { opened.push(String(target)); return actual(target, ...args); });
  try {
    let error: unknown;
    try { await prepareSessionPrompt('/outside', { workspace: async () => ({ virtual: '/allowed', real: path.join(dir, 'allowed') }), toolContext }); }
    catch (caught) { error = caught; }
    expect(opened).not.toContain(path.join(skills.skillsDirectory()!, 'outside', 'SKILL.md'));
    expect(error).toBeInstanceOf(Error);
  } finally { spy.mockRestore(); }
});
it('keeps selected managed Skills whose canonical files are inside the external grant', async () => {
  const skills = await import('../src/main/skills.js');
  const { prepareSessionPrompt } = await import('../src/main/session/prompt.js');
  const { externalPlacementToolContext } = await import('../src/main/mcp/kernel.js');
  await skills.initSkillsPath(path.join(dir, 'allowed'));
  const source = path.join(dir, 'allowed', 'inside.md');
  await fs.writeFile(source, '---\nname: Inside\ndescription: inside fixture\n---\nAPPROVED_SKILL_BODY');
  await skills.importSkillFile(source);
  const placement = broker.workerPrimeOwner('external-worker').externalPlacement!;
  const text = await prepareSessionPrompt('/inside', { workspace: async () => ({ virtual: '/allowed', real: path.join(dir, 'allowed') }), toolContext: () => externalPlacementToolContext(principalId, placement, ctx) });
  expect(text).toContain('APPROVED_SKILL_BODY');
  const catalog = skills.skillCatalogSnapshot().find(row => row.id === 'inside')!;
  const routed = await prepareSessionPrompt('Use the approved skill', { workspace: async () => ({ virtual: '/allowed', real: path.join(dir, 'allowed') }), toolContext: () => externalPlacementToolContext(principalId, placement, ctx), autoSkills: [{ id: 'inside', revision: catalog.revision }] });
  expect(routed).toContain('APPROVED_SKILL_BODY');
  await expect(prepareSessionPrompt('Use the approved skill', { workspace: async () => ({ virtual: '/allowed', real: path.join(dir, 'allowed') }), toolContext: () => externalPlacementToolContext(principalId, placement, ctx), autoSkills: [{ id: 'inside', revision: '0'.repeat(64) }] })).rejects.toThrow('changed after routing');
  const config = getConfig();
  await saveConfig({ ...config, externalPrime: { ...config.externalPrime, principals: config.externalPrime.principals.map(row => ({ ...row, capabilities: [] })) } });
  const actual = fs.open.bind(fs);
  const opened: string[] = [];
  const spy = vi.spyOn(fs, 'open').mockImplementation(async (target, ...args) => { opened.push(String(target)); return actual(target, ...args); });
  try {
    await expect(prepareSessionPrompt('/inside', { workspace: async () => ({ virtual: '/allowed', real: path.join(dir, 'allowed') }), toolContext: () => externalPlacementToolContext(principalId, placement, ctx) })).rejects.toThrow('unavailable');
    expect(opened).not.toContain(path.join(skills.skillsDirectory()!, 'inside', 'SKILL.md'));
  } finally { spy.mockRestore(); }
});
