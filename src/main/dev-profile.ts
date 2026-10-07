import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

export const devRoot = process.env.TITAN_COS_DEV_ROOT;

export function readDevBinding(env: NodeJS.ProcessEnv = process.env): { root: string; port: number; instanceId: string } | null {
  if (!env.TITAN_COS_DEV_ROOT) return null;
  const root = env.TITAN_COS_DEV_ROOT;
  const port = Number(env.CLF_BRIDGE_PORTS);
  const instanceId = env.TITAN_COS_DEV_INSTANCE ?? '';
  if (!path.isAbsolute(root) || !/^\d+$/.test(env.CLF_BRIDGE_PORTS ?? '') ||
    !Number.isInteger(port) || port < 1024 || port > 65535 || (port >= 8765 && port <= 8769) ||
    !/^[A-Za-z0-9_-]{1,80}$/.test(instanceId)) {
    throw new Error('Titan development requires an absolute root, one dedicated port outside 8765–8769, and an instance ID.');
  }
  return { root, port, instanceId };
}

/** Must run before other main-process imports and the single-instance lock. */
export function configureDevProfile(application: {
  setPath(name: 'userData' | 'sessionData', value: string): void;
  setName(name: string): void;
}, options: { root: string; packaged: boolean }): void {
  if (options.packaged) throw new Error('Titan development arguments are forbidden in packaged applications.');
  if (!options.root || !path.isAbsolute(options.root)) throw new Error('Titan development root must be absolute.');
  const userData = path.join(options.root, 'user-data');
  const sessionData = path.join(options.root, 'session-data');
  mkdirSync(userData, { recursive: true });
  mkdirSync(sessionData, { recursive: true });
  application.setPath('userData', userData);
  application.setPath('sessionData', sessionData);
  application.setName('Titan COS Development');
}

if (devRoot) {
  readDevBinding();
  configureDevProfile(app, { root: devRoot, packaged: app.isPackaged });
}
