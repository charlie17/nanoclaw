import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  TIMEZONE: 'America/Los_Angeles',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Mock container-runtime
vi.mock('./container-runtime.js', () => ({
  CONTAINER_RUNTIME_BIN: 'docker',
  CONTAINER_HOST_GATEWAY: 'host.docker.internal',
  hostGatewayArgs: () => [],
  readonlyMountArgs: (h: string, c: string) => ['-v', `${h}:${c}:ro`],
  stopContainer: vi.fn(),
}));

// Mock credential-proxy
vi.mock('./credential-proxy.js', () => ({
  detectAuthMode: vi.fn(() => 'api-key'),
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

import { runContainerAgent, ContainerOutput } from './container-runner.js';
import type { RegisteredGroup } from './types.js';
import { spawn } from 'child_process';
import fs from 'fs';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });
});

describe('per-folder spawn lock (D-V58)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(spawn).mockReset();
    vi.mocked(spawn).mockImplementation(() => fakeProc as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('D-V58-G1a: serializes concurrent calls for the same group.folder', async () => {
    const proc1 = createFakeProcess();
    const proc2 = createFakeProcess();
    // Deterministically: first spawn → proc1, second spawn → proc2
    vi.mocked(spawn).mockImplementationOnce(() => proc1 as any).mockImplementationOnce(() => proc2 as any);

    const p1 = runContainerAgent(testGroup, testInput, () => {});
    const p2 = runContainerAgent(testGroup, testInput, () => {});

    // Flush microtasks: p1 acquires lock + spawns proc1; p2 blocks on lock
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(spawn).mock.calls.length).toBe(1);

    // Complete p1 — triggers lock release → p2 acquires lock and spawns proc2
    emitOutputMarker(proc1, { status: 'success', result: 'r1', newSessionId: 's1' });
    await vi.advanceTimersByTimeAsync(10);
    proc1.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await p1;

    // p2 has now spawned (in the microtask chain triggered by p1's lock release)
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(spawn).mock.calls.length).toBe(2);

    // Complete p2
    emitOutputMarker(proc2, { status: 'success', result: 'r2', newSessionId: 's2' });
    await vi.advanceTimersByTimeAsync(10);
    proc2.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    const r2 = await p2;
    expect(r2.status).toBe('success');
  });

  it('D-V58-G1b: runs concurrent calls for different group.folders in parallel', async () => {
    const proc1 = createFakeProcess();
    const proc2 = createFakeProcess();
    let spawnCall = 0;
    vi.mocked(spawn).mockImplementation(() => (spawnCall++ === 0 ? proc1 : proc2) as any);

    const groupA: RegisteredGroup = { ...testGroup, folder: 'folder-a' };
    const groupB: RegisteredGroup = { ...testGroup, folder: 'folder-b' };
    const inputA = { ...testInput, groupFolder: 'folder-a' };
    const inputB = { ...testInput, groupFolder: 'folder-b' };

    const p1 = runContainerAgent(groupA, inputA, () => {});
    const p2 = runContainerAgent(groupB, inputB, () => {});

    // Both should have acquired their own lock and spawned without waiting
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(spawn).mock.calls.length).toBe(2);

    // Clean up both
    emitOutputMarker(proc1, { status: 'success', result: 'a' });
    emitOutputMarker(proc2, { status: 'success', result: 'b' });
    await vi.advanceTimersByTimeAsync(10);
    proc1.emit('close', 0);
    proc2.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await Promise.all([p1, p2]);
  });

  it('D-V58-G1c: releases lock when setup throws synchronously', async () => {
    const throwGroup: RegisteredGroup = { ...testGroup, folder: 'throw-folder' };
    const throwInput = { ...testInput, groupFolder: 'throw-folder' };

    // Make mkdirSync throw once to trigger a sync throw inside the try block
    vi.mocked(fs.mkdirSync as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('EACCES: permission denied');
    });

    // First call rejects due to the throw; finally must still release the lock
    await expect(runContainerAgent(throwGroup, throwInput, () => {})).rejects.toThrow('EACCES');

    // Lock released — a subsequent same-folder call should not deadlock
    const proc = createFakeProcess();
    fakeProc = proc;
    const p = runContainerAgent(throwGroup, throwInput, () => {});
    await vi.advanceTimersByTimeAsync(0);
    emitOutputMarker(proc, { status: 'success', result: 'recovered' });
    await vi.advanceTimersByTimeAsync(10);
    proc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    expect((await p).status).toBe('success');
  });

  it('D-V58-G1d: releases lock after async error exit (non-zero container exit code)', async () => {
    const errGroup: RegisteredGroup = { ...testGroup, folder: 'error-folder' };
    const errInput = { ...testInput, groupFolder: 'error-folder' };

    // First call: container exits with non-zero code → resolves with status:'error'
    const p1 = runContainerAgent(errGroup, errInput, () => {});
    await vi.advanceTimersByTimeAsync(0);
    fakeProc.emit('close', 1);
    await vi.advanceTimersByTimeAsync(10);
    const r1 = await p1;
    expect(r1.status).toBe('error');

    // Lock released — second same-folder call should proceed
    const proc2 = createFakeProcess();
    fakeProc = proc2;
    const p2 = runContainerAgent(errGroup, errInput, () => {});
    await vi.advanceTimersByTimeAsync(0);
    emitOutputMarker(proc2, { status: 'success', result: 'ok' });
    await vi.advanceTimersByTimeAsync(10);
    proc2.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    expect((await p2).status).toBe('success');
  });
});
