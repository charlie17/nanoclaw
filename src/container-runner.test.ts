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

import {
  classifyOutput,
  isFailureSubtype,
  runContainerAgent,
  ContainerOutput,
} from './container-runner.js';
import type { RegisteredGroup } from './types.js';

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

// --- Impl-75 A1/A2: envelope routing ---

describe('classifyOutput (Impl-75 A1/A2)', () => {
  // The SEV-1 assertion. Pre-Impl-75 these two envelopes were byte-identical
  // ({status:'success', result:null}) and both routed to silence, which is how a
  // completed /wiki-ingest became indistinguishable from an idling agent.
  it('routes an empty-text result and a session-update DIFFERENTLY', () => {
    const emptyResult = classifyOutput(
      { kind: 'result', subtype: 'error_during_execution' },
      false,
    );
    const sessionUpdate = classifyOutput({ kind: 'session-update' }, false);

    expect(emptyResult).toBe('lost-reply');
    expect(sessionUpdate).toBe('heartbeat');
    expect(emptyResult).not.toBe(sessionUpdate);
  });

  it('treats a result with a success subtype but no text as a lost reply', () => {
    // The 2026-07-16 shape: the SDK ended the turn emitting no text at all.
    expect(classifyOutput({ kind: 'result', subtype: 'success' }, false)).toBe(
      'lost-reply',
    );
  });

  it('routes a result carrying text to delivery', () => {
    expect(classifyOutput({ kind: 'result', subtype: 'success' }, true)).toBe(
      'deliver',
    );
  });

  it('treats an internal-only reply (text stripped to empty) as a lost reply', () => {
    // Host strips <internal> blocks before this call; a reply that was nothing
    // but internal reasoning leaves no deliverable text and must not go silent.
    expect(classifyOutput({ kind: 'result' }, false)).toBe('lost-reply');
  });

  it('routes an ipc-consumed marker to its own path', () => {
    expect(classifyOutput({ kind: 'ipc-consumed' }, false)).toBe(
      'ipc-consumed',
    );
  });

  // Back-compat is load-bearing: host and agent-runner deploy independently.
  it('BACK-COMPAT: an envelope with no kind stays silent, exactly as pre-Impl-75', () => {
    expect(classifyOutput({}, false)).toBe('heartbeat');
  });

  it('BACK-COMPAT: an envelope with no kind but with text still delivers', () => {
    expect(classifyOutput({}, true)).toBe('deliver');
  });
});

describe('isFailureSubtype (Impl-75 A3)', () => {
  it('treats non-success SDK subtypes as failures', () => {
    expect(isFailureSubtype('error_during_execution')).toBe(true);
    expect(isFailureSubtype('error_max_turns')).toBe(true);
  });

  it('treats success as a non-failure', () => {
    expect(isFailureSubtype('success')).toBe(false);
  });

  it('BACK-COMPAT: an absent subtype (old runner) is not a failure', () => {
    expect(isFailureSubtype(undefined)).toBe(false);
  });
});

// --- Impl-75 A4: the reaper must not launder a lost turn into success ---

describe('container-runner reaper (Impl-75 A4)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves as error when reaped after only empty markers', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // The 2026-07-16 shape: a result marker carrying no text, then the benign
    // session-update heartbeat. Both set hadStreamingOutput; neither is a reply.
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: null,
      kind: 'result',
      subtype: 'error_during_execution',
    });
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: null,
      newSessionId: 'session-789',
      kind: 'session-update',
    });

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(1830000);
    fakeProc.emit('close', 137);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    // Pre-Impl-75 this asserted 'success' — the silent-loss bug.
    expect(result.status).toBe('error');
    expect(result.error).toContain('never produced a reply');
  });

  it('still resolves as success when a real reply preceded the reap', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is the finished report',
      newSessionId: 'session-abc',
      kind: 'result',
      subtype: 'success',
    });
    // A heartbeat after the reply must not undo the "agent spoke" fact.
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: null,
      newSessionId: 'session-abc',
      kind: 'session-update',
    });

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(1830000);
    fakeProc.emit('close', 137);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-abc');
  });

  it('treats whitespace-only result text as no reply', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: '   \n  ',
      kind: 'result',
      subtype: 'success',
    });

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(1830000);
    fakeProc.emit('close', 137);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
  });
});

// --- Impl-75 B1: an IPC-consume marker must reset the hard idle timer ---

describe('container-runner idle timer (Impl-75 B1)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('an ipc-consumed marker resets the hard timeout, sparing a message piped in late', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'first answer',
      kind: 'result',
      subtype: 'success',
    });
    await vi.advanceTimersByTimeAsync(10);

    // Live replay of 2026-07-16: the ping landed 57s before the reap deadline.
    await vi.advanceTimersByTimeAsync(1830000 - 57_000);

    // The agent consumes it and says so. This is the marker that did not exist.
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: null,
      kind: 'ipc-consumed',
    });
    await vi.advanceTimersByTimeAsync(10);

    // Past the ORIGINAL deadline — pre-Impl-75 the container was dead here.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fakeProc.kill).not.toHaveBeenCalled();

    // The agent now answers the piped message well after the old deadline.
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'answer to the piped message',
      kind: 'result',
      subtype: 'success',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'answer to the piped message' }),
    );
  });
});
