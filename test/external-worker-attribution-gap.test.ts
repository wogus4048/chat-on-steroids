/** EXPECTED RED custody probe requested by controller; no product fix inferred here. */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ safeStorage: { isAsyncEncryptionAvailable: async () => true,
  getSelectedStorageBackend: () => 'unknown', encryptStringAsync: async (value: string) => Buffer.from(value),
  decryptStringAsync: async (value: Buffer) => ({ result: value.toString(), shouldReEncrypt: false }) }, shell: {} }));
vi.mock('../src/main/browser-startup.js', () => ({ wakeBrowserUrl: async () => undefined }));
import { defaultConfig, getConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initSecretsPath, resetSecretsCacheForTests } from '../src/main/secrets.js';
import { initDurableStore, writeDurableNow, flushDurable } from '../src/main/durable.js';
import { initSessionStore, getSession, flushSessions, resetSessionStoreForTests } from '../src/main/session/store.js';
import { createExternalPrincipal, authenticateExternal } from '../src/main/external-prime-auth.js';
import { requestIdSchema } from '../src/shared/agent-owner.js';
import * as broker from '../src/main/agents.js';
import * as bridge from '../src/main/bridge.js';
import * as service from '../src/main/external-prime-service.js';
import { createRegistrar, type ToolContext } from '../src/main/mcp/kernel.js';
import { registerCoreTools } from '../src/main/mcp/tools-core.js';
import { emptyEvidence, type CallContext } from '../src/main/mcp/call-context.js';
import { APP_VERSION, BRIDGE_PROTOCOL } from '../src/main/version.js';
import { makeTempDir, removeTempDir } from './helpers.js';
let dir: string, base: string, token: string;
const browser = '0123456789abcdef';
async function request(route: string, body: unknown, authenticated = true) {
  const response = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json',
    origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', 'x-extension-version': APP_VERSION,
    'x-extension-protocol': String(BRIDGE_PROTOCOL), 'x-extension-browser': browser, 'x-extension-host': 'browser',
    ...(authenticated ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
}
beforeEach(async () => {
  dir = await makeTempDir('external-attribution-gap-'); initConfigPath(dir); initSecretsPath(dir); initDurableStore(dir); initSessionStore(dir);
  await fs.writeFile(path.join(dir, 'fixture-secret.txt'), 'ONLY_TEMP_FIXTURE_SECRET');
  const config = defaultConfig(); await saveConfig({ ...config, roots: [{ name: 'project', path: dir }],
    ui: { ...config.ui, autoContinue: false }, externalPrime: { enabled: true, principals: [] },
    multiAgent: { ...config.multiAgent, enabled: true, strictChatAllowlist: false, allowUnattributedCalls: true } });
  broker.restoreSwarm(null); broker.onSwarmPersistNow((snapshot, options) => writeDurableNow('swarm', snapshot, options));
  const port = await bridge.startBridge(); expect(port).not.toBeNull(); base = `http://127.0.0.1:${port}`;
  bridge.setBrowserOpener(async () => undefined); token = (await request('/pair', {}, false)).body.token;
});
afterEach(async () => { await bridge.stopBridge(); bridge.resetBridgeForTests(); broker.restoreSwarm(null); broker.onSwarmPersistNow(null);
  await flushDurable(); await flushSessions(); resetSessionStoreForTests(); resetSecretsCacheForTests(); await removeTempDir(dir); });
async function handedThenStopped() {
  const caller = authenticateExternal((await createExternalPrincipal({ label: 'fixture', rootIds: ['project'], capabilities: ['read'],
    browserBinding: { kind: 'extension', browserId: browser }, setupProfileId: 'default' })).token);
  const worker = await service.spawnExternal(caller, { request_id: requestIdSchema.parse(crypto.randomUUID()), family: { new: true }, task: 'fixture read', workspace_root_id: 'project' });
  const command = bridge.pendingCommands().find(row => row.what.startsWith(`worker:${worker.run_id}:${worker.worker_id}`))!;
  expect(command).toBeTruthy(); expect((await request('/commands/redeem', { id: command.id, client: 'gap-page' })).status).toBe(200);
  await service.stopExternal(caller, { request_id: requestIdSchema.parse(crypto.randomUUID()), family_id: worker.family_id, worker_id: worker.worker_id });
  return { worker, command };
}
function readFixture(requestId: string, conversationId: string | null, sessionId: string | null) {
  const config = getConfig(); const ctx: ToolContext = { roots: config.roots, caps: config.capabilities, readOnly: false, setupProfileId: 'default' };
  const call: CallContext = { startedAt: Date.now(), transportKey: requestId, agent: null,
    caller: { transportKey: requestId, requestId, conversationId, sessionId, setupProfileId: 'default' },
    allowUnattributed: true, outcome: null, evidence: emptyEvidence() };
  const reg = createRegistrar(null, ctx, 'core'); registerCoreTools(reg);
  return reg.invokeNested('read', { paths: [path.join(dir, 'fixture-secret.txt')] }, call);
}
it('EXPECTED RED: handed stopped worker correlation must retain fail-closed external provenance before read', async () => {
  const { worker, command } = await handedThenStopped(); const conversationId = crypto.randomUUID(); const requestId = crypto.randomUUID();
  const proof = await request('/correlations', { conversationId, agent: worker.worker_id, agentCommandId: command.id,
    calls: [{ messageId: 'gap-call', tool: 'read', order: 0, answered: false, requestId, createTime: Date.now() / 1000 }] });
  const summary = proof.body.sessionId ? await getSession(proof.body.sessionId) : null;
  const result = await readFixture(requestId, conversationId, summary?.id ?? null);
  console.info('attribution-gap diagnostic', { response: proof.status, confirmed: proof.body.confirmed, origin: summary?.origin ?? null,
    owner: broker.workerPrimeOwner(conversationId).owner ?? null, isError: result.isError ?? false, leakedFixture: JSON.stringify(result).includes('ONLY_TEMP_FIXTURE_SECRET') });
  // Actual read result is the meaningful evidence; trace facts accompany its expected refusal.
  expect({ response: proof.status, confirmed: proof.body.confirmed, origin: summary?.origin, owner: broker.workerPrimeOwner(conversationId).owner,
    isError: result.isError, leakedFixture: JSON.stringify(result).includes('ONLY_TEMP_FIXTURE_SECRET') }).toMatchObject({ isError: true, leakedFixture: false });
});
it('EXPECTED RED: first absolute read without identity must not bypass an outstanding stopped external opening', async () => {
  await handedThenStopped(); const result = await readFixture(crypto.randomUUID(), null, null);
  expect({ isError: result.isError, leakedFixture: JSON.stringify(result).includes('ONLY_TEMP_FIXTURE_SECRET') }).toMatchObject({ isError: true, leakedFixture: false });
});
