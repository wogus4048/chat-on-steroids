import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import http from 'node:http';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (value: string) => Buffer.from(value),
    decryptStringAsync: async (buffer: Buffer) => ({ result: buffer.toString(), shouldReEncrypt: false })
  }, clipboard: {}, shell: {} }));
const { configureDevProfile } = await import('../src/main/dev-profile.js');
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('development companion binding', () => {
  async function companion(port: number, instanceId: string) {
    const root = temporaryRoot();
    vi.stubEnv('TITAN_COS_DEV_ROOT', root);
    vi.stubEnv('CLF_BRIDGE_PORTS', String(port));
    vi.stubEnv('TITAN_COS_DEV_INSTANCE', instanceId);
    const original = readFileSync('extension/background.js', 'utf8');
    const { extensionDir } = await import('../src/main/extension-path.js');
    const dir = extensionDir()!;
    expect(dir).toBe(path.join(root, 'extension'));
    expect(readFileSync('extension/background.js', 'utf8')).toBe(original);
    return readFileSync(path.join(dir, 'background.js'), 'utf8');
  }

  function transport(source: string, cachedPort: number, replies: Map<number, string>) {
    const requests: string[] = [];
    const globals = {
      chrome: { runtime: { getManifest: () => ({ version: '2.1.29' }) } },
      workerStampReady: Promise.resolve(), workerStampValue: '', browserId: '',
      port: cachedPort, portCheckedAt: Date.now(), portCompatible: true, token: 'cached-token',
      appVersion: '', appProtocol: 14, disconnected: false, connectionEpoch: 0,
      load: async () => {}, persist: async () => {}, latchAppDisconnect: async () => {},
      connectWakeSocket: () => {},
      scheduleRetry: () => {}, pairing: null, pairingEpoch: -1, pairingReconnect: false, pairingError: null,
      fetchBounded: async (input: string) => {
        requests.push(input);
        const url = new URL(input);
        return { ok: true, status: 200, json: async () => url.pathname === '/hello'
          ? { app: 'chat-on-steroids', bridge: 14, compatible: true, instanceId: replies.get(Number(url.port)) }
          : { token: 'new-token' } };
      },
      setTimeout, clearTimeout, URL, Date
    };
    const constants = source.slice(source.indexOf('const DEV_BINDING'), source.indexOf('const HELLO_TIMEOUT_MS'));
    const hello = source.slice(source.indexOf('async function hello('), source.indexOf('/**\n * Which build'));
    const headers = source.slice(source.indexOf('function versionHeaders('), source.indexOf('/**\n * Finds the app'));
    const discovery = source.slice(source.indexOf('let discoveryFlight'), source.indexOf('/**\n * Mirrors an explicit'));
    const call = source.slice(source.indexOf('async function call('), source.indexOf('/**\n * Gets this browser'));
    const pair = source.slice(source.indexOf('function provision('), source.indexOf('// -------------------------------------------------------------------- commands'));
    const ctx = vm.createContext(globals);
    const api = vm.runInContext(`${constants}\nconst HELLO_TIMEOUT_MS=1200, BRIDGE_PROTOCOL=14, PORT_TRUST_MS=30000, REQUEST_TIMEOUT_MS=10000;\n${hello}\n${headers}\n${discovery}\n${call}\n${pair}\n({call,discover,provision})`, ctx);
    return { api, requests };
  }

  it('ignores an original cached port and only sends commands to the matching development app', async () => {
    const source = await companion(18765, 'dev-one');
    const { api, requests } = transport(source, 8765, new Map([[8765, 'original'], [18765, 'dev-one']]));
    expect((await api.call('/commands')).ok).toBe(true);
    expect(requests).toContain('http://127.0.0.1:18765/commands');
    expect(requests.some(url => new URL(url).port === '8765')).toBe(false);
  });

  it('refuses a reused development port now owned by another instance before pair or commands', async () => {
    const source = await companion(18765, 'dev-one');
    const { api, requests } = transport(source, 18765, new Map([[18765, 'other']]));
    expect((await api.provision()).ok).toBe(false);
    expect((await api.call('/commands')).ok).toBe(false);
    expect(requests.every(url => new URL(url).pathname === '/hello')).toBe(true);
  });

  it('rejects default ports and malformed development bindings', async () => {
    const { readDevBinding } = await import('../src/main/dev-profile.js');
    expect(typeof readDevBinding).toBe('function');
    expect(() => readDevBinding({ TITAN_COS_DEV_ROOT: temporaryRoot(), CLF_BRIDGE_PORTS: '8765', TITAN_COS_DEV_INSTANCE: 'dev-one' })).toThrow();
    expect(() => readDevBinding({ TITAN_COS_DEV_ROOT: temporaryRoot(), CLF_BRIDGE_PORTS: '18765,18766', TITAN_COS_DEV_INSTANCE: 'dev-one' })).toThrow();
  });

  it('identifies the development bridge and rejects pairing without its binding while retaining bearer checks', async () => {
    const root = temporaryRoot();
    const { initConfigPath, saveConfig, defaultConfig } = await import('../src/main/config.js');
    const { initSecretsPath } = await import('../src/main/secrets.js');
    const { initDurableStore, flushDurable } = await import('../src/main/durable.js');
    const { initSessionStore, resetSessionStoreForTests } = await import('../src/main/session/store.js');
    const { startBridge, stopBridge } = await import('../src/main/bridge.js');
    initConfigPath(root); initSecretsPath(root); initDurableStore(root); initSessionStore(root);
    await saveConfig(defaultConfig());
    // Let the OS choose a free fixture port, then test that exact exclusive binding.
    const reservation = http.createServer();
    reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
    const selected = (reservation.address() as { port: number }).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    vi.stubEnv('TITAN_COS_DEV_ROOT', root);
    vi.stubEnv('CLF_BRIDGE_PORTS', String(selected));
    vi.stubEnv('TITAN_COS_DEV_INSTANCE', 'fixture');
    try {
      expect(await startBridge()).toBe(selected);
      const base = `http://127.0.0.1:${selected}`;
      const hello = await fetch(`${base}/hello`);
      expect((await hello.json()).instanceId).toBe('fixture');
      const noBinding = await fetch(`${base}/pair`, { method: 'POST' });
      expect(noBinding.status).toBe(403);
      const wrongBinding = await fetch(`${base}/pair`, { method: 'POST', headers: { 'x-titan-instance': 'other' } });
      expect(wrongBinding.status).toBe(403);
      const pairing = await fetch(`${base}/pair`, { method: 'POST', headers: {
        'x-titan-instance': 'fixture', 'x-extension-protocol': '14', 'content-type': 'application/json'
      }, body: '{}' });
      expect(pairing.status).toBe(200);
      expect((await pairing.json()).token).toBeTypeOf('string');
      expect((await fetch(`${base}/commands`, { headers: { 'x-titan-instance': 'fixture' } })).status).toBe(401);
    } finally {
      await stopBridge(); await flushDurable(); resetSessionStoreForTests();
    }
  });

  it('fails on a occupied dedicated bridge port without searching production ports', async () => {
    const occupied = http.createServer();
    occupied.listen(0, '127.0.0.1'); await once(occupied, 'listening');
    const port = (occupied.address() as { port: number }).port;
    vi.stubEnv('TITAN_COS_DEV_ROOT', temporaryRoot());
    vi.stubEnv('CLF_BRIDGE_PORTS', String(port));
    vi.stubEnv('TITAN_COS_DEV_INSTANCE', 'fixture');
    const { startBridge, bridgeStatus, stopBridge } = await import('../src/main/bridge.js');
    try {
      expect(await startBridge()).toBeNull();
      expect((await bridgeStatus()).error).toContain('EADDRINUSE');
    } finally {
      await stopBridge(); await new Promise<void>(resolve => occupied.close(() => resolve()));
    }
  });
});
function temporaryRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'titan-dev-'));
  roots.push(root);
  return root;
}
describe('explicit Titan development profile', () => {
  it('changes both storage paths before naming the app, without touching original userData', () => {
    const root = temporaryRoot();
    const originalUserData = path.join(root, 'original');
    const paths = { userData: originalUserData, sessionData: originalUserData };
    const names: string[] = [];
    configureDevProfile({
      setPath(name: 'userData' | 'sessionData', value: string) { paths[name] = value; },
      setName(name: string) { expect(paths.userData).not.toBe(originalUserData); names.push(name); }
    }, { root, packaged: false });
    expect(paths.userData).toBe(path.join(root, 'user-data'));
    expect(paths.sessionData).toBe(path.join(root, 'session-data'));
    expect(names).toEqual(['Titan COS Development']);
  });
  it('refuses packaged and relative development roots before any mutation', () => {
    const app = { setPath: vi.fn(), setName: vi.fn() };
    expect(() => configureDevProfile(app, { root: temporaryRoot(), packaged: true })).toThrow();
    expect(() => configureDevProfile(app, { root: 'relative', packaged: false })).toThrow();
    expect(app.setPath).not.toHaveBeenCalled();
  });
  it('rejects unsafe launcher arguments before starting Electron', () => {
    const relative = spawnSync(process.execPath, ['scripts/dev-titan.mjs', '--root', 'relative'], { encoding: 'utf8' });
    expect(relative.status).toBe(1);
    expect(relative.stderr).toContain('absolute root');
    const originalPort = spawnSync(process.execPath, ['scripts/dev-titan.mjs', '--port', '8765'], { encoding: 'utf8' });
    expect(originalPort.status).toBe(1);
    expect(originalPort.stderr).toContain('dedicated port');
  });
});
