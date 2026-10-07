import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(() => {
    throw new Error('desktop helper must not start');
  }),
  readText: vi.fn(() => 'clipboard-value'),
  writeText: vi.fn()
}));

vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('electron', () => ({
  clipboard: {
    readText: mocks.readText,
    writeText: mocks.writeText
  }
}));

import { act } from '../src/main/computer/index.js';

describe('desktop local-only action path', () => {
  beforeEach(() => {
    mocks.spawn.mockClear();
    mocks.readText.mockClear();
    mocks.writeText.mockClear();
  });

  it('runs clipboard-only work without starting the PowerShell desktop helper', async () => {
    const result = await act([
      { type: 'write_clipboard', text: 'next' },
      { type: 'wait', ms: 0 },
      { type: 'read_clipboard' }
    ]);

    expect(mocks.writeText).toHaveBeenCalledWith('next');
    expect(result.clipboard).toEqual(['clipboard-value']);
    expect(result.cursor).toBeNull();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('preflights semantic refs before an earlier clipboard action can mutate state', async () => {
    await expect(
      act([
        { type: 'write_clipboard', text: 'must-not-land' },
        { type: 'click_ref', ref: 'g999_e999_999' }
      ])
    ).rejects.toThrow(/UNKNOWN_UI_REF|STALE_REF/);

    expect(mocks.writeText).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});

it('refuses queued clipboard work after its caller admission is revoked', async () => {
  const { runInCallContext, emptyEvidence } = await import('../src/main/mcp/call-context.js');
  let revoked = false;
  const context = { startedAt: Date.now(), transportKey: null, agent: null, caller: { transportKey: null, requestId: null, conversationId: 'queue-owner' }, outcome: null, evidence: emptyEvidence(), admission: () => { if (revoked) throw new Error('ACCESS_REVOKED'); } };
  const first = act([{ type: 'wait', ms: 20 }]);
  const pending = runInCallContext(context, () => act([{ type: 'write_clipboard', text: 'MUST_NOT_LAND' }]));
  const rejected = expect(pending).rejects.toThrow('ACCESS_REVOKED');
  revoked = true;
  await first; await rejected;
  expect(mocks.writeText).not.toHaveBeenCalled();
  expect(mocks.spawn).not.toHaveBeenCalled();
});
it('rechecks clipboard admission after a dispatched local wait and keeps partial results', async () => {
  const { runInCallContext, emptyEvidence } = await import('../src/main/mcp/call-context.js');
  let revoked = false;
  const context = { startedAt: Date.now(), transportKey: null, agent: null, caller: { transportKey: null, requestId: null, conversationId: 'wait-owner' }, outcome: null, evidence: emptyEvidence(), admission: () => { if (revoked) throw new Error('ACCESS_REVOKED'); } };
  const pending = runInCallContext(context, () => act([{ type: 'wait', ms: 20 }, { type: 'write_clipboard', text: 'MUST_NOT_LAND' }]));
  const rejected = expect(pending).rejects.toMatchObject({ completedCount: 1 });
  await Promise.resolve(); await Promise.resolve(); revoked = true;
  await rejected;
  expect(mocks.writeText).not.toHaveBeenCalled();
});
