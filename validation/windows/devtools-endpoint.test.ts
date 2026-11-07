import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

import * as positive from './natural-chrome.ts';

const endpoint = 'ws://127.0.0.1:27683/devtools/browser/77b8a8c0-diagnostic';
const identity = {
  processId: 4321,
  creationDate: '/Date(1000)/',
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  commandLine:
    '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" ' +
    '--user-data-dir=C:\\Owned\\profile --remote-debugging-port=27683',
  profile: 'c:\\owned\\profile',
};
const child = { pid: identity.processId, exitCode: null, signalCode: null };
const childState = { spawnError: null };
const validSnapshot = () => ({
  connections: [
    {
      localAddress: '127.0.0.1',
      localPort: 27683,
      state: 'Listen',
      rawState: 2,
      owningProcess: identity.processId,
    },
  ],
  process: {
    ProcessId: identity.processId,
    CreationDate: identity.creationDate,
    ExecutablePath: identity.executablePath,
    CommandLine: identity.commandLine,
  },
});
type Snapshot = ReturnType<typeof validSnapshot>;
type BrowserType = Parameters<typeof positive.connectOwnedFixedPort>[0];
function firstListener(snapshot: Snapshot) {
  const listener = snapshot.connections[0];
  assert(listener);
  return listener;
}
const version = (value: string) =>
  Buffer.from(JSON.stringify({ Browser: 'Chrome/155.0.8059.85', webSocketDebuggerUrl: value }));

type RunPowerShell = NonNullable<
  NonNullable<Parameters<typeof positive.inspectFixedPort>[1]>['runPowerShell']
>;
function mockPortInspection(
  response: unknown,
  error: Error | null = null,
  stdoutOverride?: string,
  stderr = ''
) {
  const queries: string[] = [];
  const runPowerShell = ((
    executable: string,
    args: string[],
    options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void
  ) => {
    assert.equal(path.win32.basename(executable), 'powershell.exe');
    assert.equal(args.at(-2), '-EncodedCommand');
    const encoded = args.at(-1);
    assert(encoded);
    queries.push(Buffer.from(encoded, 'base64').toString('utf16le'));
    assert.deepEqual(options, {
      encoding: 'utf8',
      maxBuffer: 65_536,
      timeout: 3_000,
      windowsHide: true,
    });
    callback(error, stdoutOverride ?? '\uFEFF' + JSON.stringify(response), stderr);
  }) as unknown as RunPowerShell;
  return {
    queries,
    inspectPort: (processId?: number) => positive.inspectFixedPort(processId, { runPowerShell }),
  };
}

test('failed fixed-port subprocess retains bounded decoded output and original error identity', async () => {
  const cases = [
    {
      name: 'exit',
      error: Object.assign(new Error('child exited'), { code: 17, signal: null, killed: false }),
      stage: 'subprocess-execution',
      completeness: 'complete',
    },
    {
      name: 'timeout',
      error: Object.assign(new Error('command stopped'), {
        code: null,
        signal: 'SIGTERM',
        killed: true,
      }),
      stage: 'timeout',
      completeness: 'incomplete',
    },
    {
      name: 'overflow',
      error: Object.assign(new Error('stdout exceeded maxBuffer'), {
        code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        signal: null,
        killed: true,
      }),
      stage: 'output-collection',
      completeness: 'truncated',
    },
  ] as const;
  for (const { name, error, stage, completeness } of cases) {
    const stdout = name === 'overflow' ? 'A' + '😀'.repeat(20_000) : 'partial stdout';
    const stderr = 'partial stderr';
    const mock = mockPortInspection(null, error, stdout, stderr);
    const recorder = positive.createNaturalPortRecorder(mock.inspectPort);
    await assert.rejects(recorder.inspect(), (caught: unknown) => caught === error);
    const observation = recorder.observations()[0];
    assert(observation);
    assert.equal(observation.inspectionStatus, 'unavailable');
    assert.equal(observation.connectionCount, null);
    assert.equal(observation.connections, null);
    assert.equal(observation.process, null);
    const failure = observation.inspectionFailure as {
      stage: string;
      code: string | number | null;
      exitCode: number | null;
      killed: boolean | null;
      signal: string | null;
      collectionLimitExceeded: boolean;
      stdout: {
        decodedText: string;
        decodedUtf8Bytes: number;
        retainedUtf8Bytes: number;
        decodedTextSha256: string;
        completeness: string;
        originalBytes: string;
      };
      stderr: { decodedText: string; completeness: string; originalBytes: string };
    };
    assert.equal(failure.stage, stage);
    assert.equal(failure.code, error.code);
    assert.equal(failure.exitCode, typeof error.code === 'number' ? error.code : null);
    assert.equal(failure.killed, error.killed);
    assert.equal(failure.signal, error.signal);
    assert.equal(failure.collectionLimitExceeded, name === 'overflow');
    assert.equal(failure.stdout.completeness, completeness);
    assert.equal(failure.stdout.originalBytes, 'unavailable');
    assert.equal(failure.stdout.decodedUtf8Bytes, Buffer.byteLength(stdout));
    assert.equal(
      failure.stdout.decodedTextSha256,
      createHash('sha256').update(stdout).digest('hex')
    );
    assert(failure.stdout.retainedUtf8Bytes <= 384);
    assert.equal(Buffer.byteLength(failure.stdout.decodedText), failure.stdout.retainedUtf8Bytes);
    assert.equal(failure.stdout.decodedText, name === 'overflow' ? 'A' + '😀'.repeat(95) : stdout);
    assert.equal(failure.stderr.decodedText, stderr);
    assert.equal(failure.stderr.originalBytes, 'unavailable');
    assert.equal(failure.stderr.completeness, name === 'overflow' ? 'incomplete' : completeness);
  }
});

test('invalid JSON and schema retain their complete decoded outputs without a false snapshot', async () => {
  for (const [stage, stdout] of [
    ['json-parsing', '{invalid json'],
    ['schema-validation', '{"connections":null,"process":null}'],
  ]) {
    const mock = mockPortInspection(null, null, stdout, 'PowerShell warning');
    const recorder = positive.createNaturalPortRecorder(mock.inspectPort);
    await assert.rejects(recorder.inspect());
    const observation = recorder.observations()[0];
    assert(observation);
    assert.equal(observation.inspectionStatus, 'unavailable');
    assert.equal(observation.connections, null);
    assert.equal(observation.process, null);
    const failure = observation.inspectionFailure as {
      stage: string;
      stdout: { decodedText: string; completeness: string; originalBytes: string };
      stderr: { decodedText: string; completeness: string };
    };
    assert.equal(failure.stage, stage);
    assert.equal(failure.stdout.decodedText, stdout);
    assert.equal(failure.stdout.completeness, 'complete');
    assert.equal(failure.stdout.originalBytes, 'unavailable');
    assert.equal(failure.stderr.decodedText, 'PowerShell warning');
    assert.equal(failure.stderr.completeness, 'complete');
  }
});

test('sixteen failed inspections and the existing Chrome stderr tail fit the failure receipt cap', async () => {
  const error = Object.assign(new Error('stdout exceeded maxBuffer'), {
    code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    killed: true,
  });
  const mock = mockPortInspection(null, error, '\u0000'.repeat(70_000), '\u0001'.repeat(70_000));
  const recorder = positive.createNaturalPortRecorder(mock.inspectPort);
  for (let index = 0; index < 16; index++) {
    await assert.rejects(recorder.inspect(), (caught: unknown) => caught === error);
  }
  const observations = recorder.observations();
  assert.equal(observations.length, 16);
  const receipt = JSON.stringify(
    {
      schemaVersion: 1,
      kind: 'natural-chrome-launch',
      status: 'failed',
      errorType: 'Error',
      diagnostic: {
        stage: 'preconnect',
        discoveryBrowserVersion: 'Chrome/156.0.8078.80',
        attachedBrowserVersion: null,
        childAtFailure: {
          pid: 4321,
          exitCode: null,
          signalCode: null,
          spawnErrorName: null,
          spawnErrorMessage: null,
        },
        chromeStderr: {
          totalBytes: 64 * 1024,
          retainedTailBytes: 64 * 1024,
          retainedTailSha256: 'a'.repeat(64),
          retainedTailBase64: Buffer.alloc(64 * 1024).toString('base64'),
        },
        portObservations: observations,
      },
      cleanup: { processTreeExited: true, errorCount: 0 },
    },
    null,
    2
  );
  assert(Buffer.byteLength(receipt, 'utf8') <= 192 * 1024);
});

test('emitted fixed-port query preserves unnamed raw state instead of claiming absence', async () => {
  const row = { ...firstListener(validSnapshot()), state: '', rawState: 0 };
  const response = { ...validSnapshot(), connections: [row] };
  const mock = mockPortInspection(response);
  const recorder = positive.createNaturalPortRecorder(mock.inspectPort);
  assert.deepEqual(await recorder.inspect(identity.processId), response);
  assert.equal(mock.queries.length, 1);
  const query = mock.queries[0];
  assert(query);
  assert.match(query, /Get-NetTCPConnection\s+-ErrorAction Stop/u);
  assert.doesNotMatch(query, /-State\b/iu);
  assert.match(query, /LocalPort -eq 27683/u);
  assert.match(query, /rawState=\$_.CimInstanceProperties\['State'\]\.Value/u);
  assert.match(query, /ProcessId = 4321/u);
  const observation = recorder.observations()[0];
  assert(observation);
  assert.equal(observation.inspectionStatus, 'unavailable');
  assert.equal(observation.listenerCount, 0);
  assert.equal(observation.connectionCount, 1);
  assert.deepEqual(observation.connections, [row]);
});

test('unsupported or malformed parsed rows stop preflight, HTTP and CDP without retry', async () => {
  const listener = firstListener(validSnapshot());
  const rows: unknown[] = [
    { ...listener, state: '', rawState: 0 },
    { ...listener, state: '0', rawState: 0 },
    { ...listener, state: 0, rawState: 0 },
    { ...listener, state: 'Unknown', rawState: 999 },
    { ...listener, rawState: 0 },
    { ...listener, localPort: '27683' },
    { ...listener, owningProcess: null },
    { ...listener, localAddress: null },
    { ...listener, localAddress: 'invalid-address' },
    null,
  ];
  for (const row of rows) {
    const mock = mockPortInspection({ ...validSnapshot(), connections: [listener, row] });
    const recorder = positive.createNaturalPortRecorder(mock.inspectPort);
    await assert.rejects(
      positive.assertFixedPortUnused({ inspectPort: recorder.inspect }),
      /inspection unavailable or unsupported/
    );
    let requests = 0;
    await assert.rejects(
      positive.readOwnedFixedPortEndpoint(child, childState, identity, {
        inspectPort: recorder.inspect,
        fetchVersion: async () => {
          requests++;
          return version(endpoint);
        },
        sleep: async () => {
          throw new Error('Unexpected retry');
        },
      }),
      /inspection unavailable or unsupported/
    );
    await assert.rejects(
      positive.connectOwnedFixedPort(
        {
          connectOverCDP: async () => {
            requests++;
          },
        } as unknown as BrowserType,
        endpoint,
        child,
        childState,
        identity,
        { inspectPort: recorder.inspect }
      ),
      /inspection unavailable or unsupported/
    );
    assert.equal(requests, 0);
    assert.equal(mock.queries.length, 3);
    for (const observation of recorder.observations()) {
      assert.equal(observation.inspectionStatus, 'unavailable');
      assert.equal(observation.listenerCount, 1);
      assert.equal(observation.connectionCount, 2);
    }
  }
});

test('parsed complete empty inspection and unavailable inspection remain distinct', async () => {
  const empty = mockPortInspection({ connections: [], process: null });
  const recorder = positive.createNaturalPortRecorder(empty.inspectPort);
  await positive.assertFixedPortUnused({ inspectPort: recorder.inspect });
  assert.equal(recorder.observations()[0]?.inspectionStatus, 'complete');
  assert.equal(recorder.observations()[0]?.listenerCount, 0);
  assert.equal(recorder.observations()[0]?.connectionCount, 0);
  for (const mock of [
    mockPortInspection({ connections: null, process: null }),
    mockPortInspection(null, new Error('TCP inspection unavailable')),
  ]) {
    const failed = positive.createNaturalPortRecorder(mock.inspectPort);
    await assert.rejects(positive.assertFixedPortUnused({ inspectPort: failed.inspect }));
    const observation = failed.observations()[0];
    assert(observation);
    assert.equal(observation.inspectionStatus, 'unavailable');
    assert.equal(observation.listenerCount, null);
    assert.equal(observation.connectionCount, null);
    assert.equal(observation.connections, null);
  }
});

test('parsed named non-listening connections do not inflate listener count or block strict listener', async () => {
  const listener = firstListener(validSnapshot());
  const mock = mockPortInspection({
    ...validSnapshot(),
    connections: [{ ...listener, state: 'Established', rawState: 5 }, listener],
  });
  const recorder = positive.createNaturalPortRecorder(mock.inspectPort);
  assert.equal(
    await positive.readOwnedFixedPortEndpoint(child, childState, identity, {
      inspectPort: recorder.inspect,
      fetchVersion: async () => version(endpoint),
    }),
    endpoint
  );
  assert.equal(recorder.observations()[0]?.inspectionStatus, 'complete');
  assert.equal(recorder.observations()[0]?.listenerCount, 1);
  assert.equal(recorder.observations()[0]?.connectionCount, 2);
});

type RequestVersion = NonNullable<
  NonNullable<Parameters<typeof positive.fetchFixedVersion>[0]>['requestVersion']
>;
function mockVersionRequest({
  statusCode = 200,
  headers = {},
  chunks = [version(endpoint)],
  complete = true,
  closeEarly = false,
  neverReply = false,
}: {
  statusCode?: number;
  headers?: Record<string, string>;
  chunks?: Buffer[];
  complete?: boolean;
  closeEarly?: boolean;
  neverReply?: boolean;
} = {}) {
  const calls: unknown[] = [];
  const destroys: Error[] = [];
  const requestVersion = ((options: unknown, callback: (response: EventEmitter) => void) => {
    calls.push(options);
    const client = Object.assign(new EventEmitter(), {
      end() {
        if (neverReply) return;
        queueMicrotask(() => {
          const response = Object.assign(new EventEmitter(), { statusCode, headers, complete });
          callback(response);
          for (const chunk of chunks) response.emit('data', chunk);
          response.emit(closeEarly ? 'close' : 'end');
        });
      },
      destroy(error: Error) {
        destroys.push(error);
        client.emit('error', error);
        return client;
      },
    });
    return client;
  }) as RequestVersion;
  return { requestVersion, calls, destroys };
}

test('native fixed HTTP request uses only the declared loopback path and accepts bounded bytes', async () => {
  const mock = mockVersionRequest();
  assert.deepEqual(await positive.fetchFixedVersion(mock), version(endpoint));
  assert.deepEqual(mock.calls, [
    {
      protocol: 'http:',
      hostname: '127.0.0.1',
      family: 4,
      port: 27683,
      path: '/json/version',
      method: 'GET',
      agent: false,
    },
  ]);
  assert.deepEqual(mock.destroys, []);
});

test('native fixed HTTP request rejects redirects, oversized bodies and early close', async () => {
  const cases = [
    [
      mockVersionRequest({ statusCode: 302, headers: { location: 'http://elsewhere/' } }),
      /not HTTP 200/,
    ],
    [mockVersionRequest({ headers: { 'content-length': '4097' } }), /byte cap/],
    [mockVersionRequest({ chunks: [Buffer.alloc(4097)] }), /byte cap/],
    [mockVersionRequest({ complete: false, closeEarly: true }), /ended early/],
  ] as const;
  for (const [mock, expected] of cases) {
    await assert.rejects(positive.fetchFixedVersion(mock), expected);
    assert.equal(mock.calls.length, 1);
    if (mock.destroys.length > 0) assert.equal(mock.destroys.length, 1);
  }
});

test('native fixed HTTP request destroys an unresponsive request at its deadline', async () => {
  const mock = mockVersionRequest({ neverReply: true });
  await assert.rejects(positive.fetchFixedVersion(mock), /deadline exceeded/);
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.destroys.length, 1);
});

test('fixed launch port and every busy listener are rejected', async () => {
  const profile = 'C:\\Owned\\profile';
  const changed = positive.naturalChromeArguments(profile);
  assert.deepEqual(changed, [
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=27683',
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    '--enable-unsafe-extension-debugging',
    '--mute-audio',
    '--lang=en-US',
    '--window-size=1280,720',
    'about:blank',
  ]);
  assert.equal(changed.filter((value) => value === '--remote-debugging-port=27683').length, 1);
  await positive.assertFixedPortUnused({
    inspectPort: async () => ({
      connections: [],
      process: null,
    }),
  });
  for (const localAddress of ['127.0.0.1', '::1', '0.0.0.0']) {
    await assert.rejects(
      positive.assertFixedPortUnused({
        inspectPort: async () => ({
          connections: [
            { localAddress, localPort: 27683, state: 'Listen', rawState: 2, owningProcess: 999 },
          ],
          process: null,
        }),
      }),
      /already in use/
    );
  }
});

test('no HTTP request precedes exact listener and current CIM ownership', async () => {
  const cases: [string, (snapshot: Snapshot) => void][] = [
    [
      'wrong-pid',
      (snapshot) => {
        firstListener(snapshot).owningProcess = 999;
      },
    ],
    [
      'wrong-creation',
      (snapshot) => {
        snapshot.process.CreationDate = '/Date(2000)/';
      },
    ],
    [
      'wrong-executable',
      (snapshot) => {
        snapshot.process.ExecutablePath = 'C:\\Other\\chrome.exe';
      },
    ],
    [
      'wrong-command-profile',
      (snapshot) => {
        snapshot.process.CommandLine = snapshot.process.CommandLine.replace(
          'C:\\Owned\\profile',
          'C:\\Other\\profile'
        );
      },
    ],
    [
      'ipv6-only',
      (snapshot) => {
        firstListener(snapshot).localAddress = '::1';
      },
    ],
    [
      'wildcard',
      (snapshot) => {
        firstListener(snapshot).localAddress = '0.0.0.0';
      },
    ],
    [
      'multiple',
      (snapshot) => {
        snapshot.connections.push({ ...firstListener(snapshot) });
      },
    ],
  ];
  for (const [name, change] of cases) {
    const snapshot = validSnapshot();
    change(snapshot);
    let http = 0;
    await assert.rejects(
      positive.readOwnedFixedPortEndpoint(child, childState, identity, {
        inspectPort: async () => snapshot,
        fetchVersion: async () => {
          http++;
          return version(endpoint);
        },
        timeoutMs: 10,
      }),
      { name: 'AssertionError' },
      name
    );
    assert.equal(http, 0, name);
  }
  let absentHttp = 0;
  await assert.rejects(
    positive.readOwnedFixedPortEndpoint(child, childState, identity, {
      inspectPort: async () => ({ ...validSnapshot(), connections: [] }),
      fetchVersion: async () => {
        absentHttp++;
        return version(endpoint);
      },
      sleep: async () => {},
      timeoutMs: 1,
    }),
    /Timed out waiting/
  );
  assert.equal(absentHttp, 0);
});

test('untrusted JSON and raw endpoint variants cannot reach WebSocket connection', async () => {
  const malformed = [
    Buffer.from('{'),
    Buffer.alloc(4097),
    Buffer.from('[]'),
    version('ws://localhost:27683/devtools/browser/id'),
    version('ws://127.0.0.1:27684/devtools/browser/id'),
    version('wss://127.0.0.1:27683/devtools/browser/id'),
    version('ws://127.0.0.1:27683/devtools/browser/%69d'),
    version('ws://user@127.0.0.1:27683/devtools/browser/id'),
    version('ws://127.0.0.1:27683/devtools/browser/id?x=1'),
    version('ws://127.0.0.1:27683/devtools/browser/id#fragment'),
  ];
  for (const body of malformed) {
    let http = 0,
      connect = 0;
    await assert.rejects(async () => {
      const discovered = await positive.readOwnedFixedPortEndpoint(child, childState, identity, {
        inspectPort: async () => validSnapshot(),
        fetchVersion: async () => {
          http++;
          return body;
        },
        timeoutMs: 10,
      });
      await positive.connectOwnedFixedPort(
        {
          connectOverCDP: async () => {
            connect++;
            throw new Error('Unexpected connect');
          },
        } as unknown as BrowserType,
        discovered,
        child,
        childState,
        identity,
        { inspectPort: async () => validSnapshot() }
      );
    });
    assert.equal(http, 1);
    assert.equal(connect, 0);
  }
  await assert.rejects(
    positive.readOwnedFixedPortEndpoint(child, childState, identity, {
      inspectPort: async () => validSnapshot(),
      fetchVersion: async () => {
        throw new Error('fixed HTTP deadline');
      },
      timeoutMs: 10,
    }),
    /deadline/
  );
});

test('one valid owned endpoint checks identity after HTTP and immediately before one connect', async () => {
  const order: string[] = [];
  const inspected = async () => {
    order.push('owner');
    return validSnapshot();
  };
  const discovered = await positive.readOwnedFixedPortEndpoint(child, childState, identity, {
    inspectPort: inspected,
    fetchVersion: async () => {
      order.push('http');
      return version(endpoint);
    },
    timeoutMs: 10,
  });
  assert.equal(discovered, endpoint);
  const chromium = {
    connectOverCDP: async (url: string, options: unknown) => {
      order.push('connect');
      assert.equal(url, endpoint);
      assert.deepEqual(options, { noDefaults: true, isLocal: true, timeout: 10_000 });
      return { connected: true };
    },
  };
  assert.deepEqual(
    await positive.connectOwnedFixedPort(
      chromium as unknown as BrowserType,
      discovered,
      child,
      childState,
      identity,
      { inspectPort: inspected }
    ),
    { connected: true }
  );
  assert.deepEqual(order, ['owner', 'http', 'owner', 'connect']);
  const changed = validSnapshot();
  changed.process.CreationDate = '/Date(2000)/';
  let rejectedConnects = 0;
  await assert.rejects(
    positive.connectOwnedFixedPort(
      {
        connectOverCDP: async () => {
          rejectedConnects++;
          throw new Error('Unexpected connect');
        },
      } as unknown as BrowserType,
      endpoint,
      child,
      childState,
      identity,
      { inspectPort: async () => changed }
    )
  );
  assert.equal(rejectedConnects, 0);
});

test('unidentified child cleanup preserves its profile when tree exit is uncertain', async () => {
  let removals = 0;
  const result = await positive.cleanupFailedNaturalChrome(
    {
      child: { pid: 4321, exitCode: null, signalCode: null, kill: () => false, once: () => {} },
      childState,
      browserProcessIdentity: null,
      profile: 'C:\\Owned\\profile',
      root: 'C:\\Owned',
    },
    {
      stopChild: async () => ({ exited: false, errors: [] }),
      removeProfile: async () => {
        removals++;
      },
    }
  );
  assert.equal(result.cleanup.profilePreserved, true);
  assert.equal(result.cleanup.processTreeExited, false);
  assert.equal(removals, 0);
});

test('actual launcher retains unavailable preflight evidence before creating the task-owned natural Chrome profile or process', async () => {
  const listener = firstListener(validSnapshot());
  const unavailable = new Error('TCP provider unavailable');
  const overflowing = Object.assign(new Error('stdout exceeded maxBuffer'), {
    code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    killed: true,
  });
  const cases = [
    mockPortInspection({ connections: [{ ...listener, state: '', rawState: 0 }], process: null }),
    mockPortInspection({ connections: [{ ...listener, owningProcess: null }], process: null }),
    mockPortInspection(null, unavailable),
    mockPortInspection(null, overflowing, '\u0000'.repeat(70_000), '\u0001'.repeat(70_000)),
  ];
  for (const [index, mock] of cases.entries()) {
    const calls: string[] = [];
    let receipt = '';
    let originalError: unknown;
    const unexpected = (name: string) => () => {
      calls.push(name);
      throw new Error(`Unexpected ${name}`);
    };
    const sandbox = {
      assert,
      Buffer,
      JSON,
      Error,
      AggregateError,
      join: path.join,
      FAILURE_RECEIPT_MAX_BYTES: 192 * 1024,
      boundedEvidenceText: (value: unknown, limit: number) =>
        typeof value === 'string' ? value.slice(0, limit) : null,
      createNaturalPortRecorder: () => positive.createNaturalPortRecorder(mock.inspectPort),
      discoverInstalledChrome: async () => {
        calls.push('discovery');
        return { executablePath: identity.executablePath, browserVersion: '155.0.8059.85' };
      },
      assertFixedPortUnused: async (
        options: Parameters<typeof positive.assertFixedPortUnused>[0]
      ) => {
        calls.push('preflight');
        try {
          await positive.assertFixedPortUnused(options);
        } catch (error) {
          originalError = error;
          throw error;
        }
      },
      mkdtemp: unexpected('profile'),
      spawn: unexpected('spawn'),
      readOwnedFixedPortEndpoint: unexpected('http'),
      connectOwnedFixedPort: unexpected('cdp'),
      cleanupFailedNaturalChrome: unexpected('process-cleanup'),
      removeOwnedChromeProfile: unexpected('profile-cleanup'),
      writeFile: async (file: string, contents: string) => {
        calls.push('failure-evidence');
        assert.equal(path.basename(file), 'natural-chrome-launch-result.json');
        receipt = contents;
      },
    };
    const launch = runInNewContext(`(${positive.launchOwnedNaturalChrome.toString()})`, sandbox);
    await assert.rejects(
      launch({ chromium: {}, root: 'C:\\Owned', output: 'C:\\Owned\\out' }),
      (error: unknown) => error === originalError
    );
    assert(originalError);
    if (index === 2) assert.equal(originalError, unavailable);
    if (index === 3) assert.equal(originalError, overflowing);
    assert.deepEqual(calls, ['discovery', 'preflight', 'failure-evidence']);
    assert.equal(mock.queries.length, 1);
    assert(Buffer.byteLength(receipt, 'utf8') <= 192 * 1024);
    const evidence = JSON.parse(receipt);
    assert.equal(evidence.status, 'failed');
    assert.equal(evidence.diagnostic.stage, 'fixed-port-preflight');
    assert.equal(evidence.diagnostic.discoveryBrowserVersion, '155.0.8059.85');
    assert.equal(evidence.diagnostic.attachedBrowserVersion, null);
    assert.equal(evidence.diagnostic.childAtFailure, null);
    assert.equal(evidence.diagnostic.chromeStderr, null);
    assert.deepEqual(evidence.cleanup, { errorCount: 0 });
    const observations = evidence.diagnostic.portObservations;
    assert.equal(observations.length, 1);
    assert.equal(observations[0].inspectionStatus, 'unavailable');
    assert.equal(observations[0].requestedProcessId, null);
    assert.equal(observations[0].process, null);
    if (index < 2) {
      assert.equal(observations[0].connectionCount, 1);
      assert.equal(observations[0].listenerCount, 0);
      assert.equal(observations[0].connections[0].rawState, index === 0 ? 0 : 2);
      assert.equal(observations[0].connections[0].state, index === 0 ? '' : 'Listen');
    } else {
      assert.equal(observations[0].connectionCount, null);
      assert.equal(observations[0].listenerCount, null);
      assert.equal(observations[0].connections, null);
      assert.equal(
        observations[0].inspectionError.message,
        index === 2 ? unavailable.message : overflowing.message
      );
      if (index === 3) {
        assert.equal(observations[0].inspectionFailure.stage, 'output-collection');
        assert.equal(observations[0].inspectionFailure.stdout.completeness, 'truncated');
        assert.equal(observations[0].inspectionFailure.stderr.completeness, 'truncated');
        assert.equal(observations[0].inspectionFailure.stdout.originalBytes, 'unavailable');
      }
    }
  }
});

test('actual launcher refuses a connected browser if final listener ownership drifts', async () => {
  const calls: string[] = [];
  const context = { setDefaultTimeout: () => {}, setDefaultNavigationTimeout: () => {} };
  const attached = {
    contexts: () => [context],
    newBrowserCDPSession: async () => ({ send: async () => ({}) }),
    version: () => '155.0.8059.85',
  };
  const childProcess = Object.assign(new EventEmitter(), {
    pid: identity.processId,
    exitCode: null,
    signalCode: null,
    stderr: new EventEmitter(),
  });
  const sandbox = {
    assert,
    Buffer,
    createHash,
    AggregateError,
    JSON,
    Error,
    Reflect,
    join: path.join,
    STDERR_LIMIT_BYTES: 65_536,
    FAILURE_RECEIPT_MAX_BYTES: 192 * 1024,
    FIXED_DEBUG_PORT: 27_683,
    boundedEvidenceText: (value: unknown, limit: number) =>
      typeof value === 'string' ? value.slice(0, limit) : null,
    createNaturalPortRecorder: () =>
      positive.createNaturalPortRecorder(async () => validSnapshot()),
    discoverInstalledChrome: async () => ({
      executablePath: identity.executablePath,
      browserVersion: '155.0.8059.85',
    }),
    assertFixedPortUnused: async () => {
      calls.push('port-unused');
    },
    mkdtemp: async () => 'C:\\Owned\\profile',
    spawn: (_exe: string, args: string[]) => {
      calls.push('spawn');
      assert(args.includes('--remote-debugging-port=27683'));
      return childProcess;
    },
    naturalChromeArguments: positive.naturalChromeArguments,
    removeOwnedChromeProfile: async () => {
      throw new Error('unexpected profile removal');
    },
    captureSpawnedChromeIdentity: async () => identity,
    readOwnedFixedPortEndpoint: async () => {
      calls.push('http');
      return endpoint;
    },
    connectOwnedFixedPort: async () => {
      calls.push('connect');
      return attached;
    },
    readOwnedBrowserProcessId: () => identity.processId,
    captureOwnedChromeProcess: async () => identity,
    verifyOwnedFixedPort: async () => {
      calls.push('post-connect-owner');
      return false;
    },
    cleanupFailedNaturalChrome: async (resources: {
      browserProcessIdentity: unknown;
      profile: string;
    }) => {
      calls.push('owned-cleanup');
      assert.equal(resources.browserProcessIdentity, identity);
      assert.equal(resources.profile, 'C:\\Owned\\profile');
      return { cleanup: { profilePreserved: true, processTreeExited: false }, errors: [] };
    },
    writeFile: async (_file: string, contents: string) => {
      calls.push('failure-evidence');
      const evidence = JSON.parse(contents);
      assert.equal(evidence.status, 'failed');
      assert.equal(evidence.cleanup.profilePreserved, true);
    },
  };
  const launch = runInNewContext(`(${positive.launchOwnedNaturalChrome.toString()})`, sandbox);
  await assert.rejects(
    launch({
      chromium: {},
      root: 'C:\\Owned',
      output: 'C:\\Owned\\out',
      checkpoint: async () => {},
    }),
    /listener changed after CDP verification/
  );
  assert.deepEqual(calls, [
    'port-unused',
    'spawn',
    'http',
    'connect',
    'post-connect-owner',
    'owned-cleanup',
    'failure-evidence',
  ]);
});

test('failure recorder bounds all connection rows while counting listeners before truncation', async () => {
  let tick = 0;
  const huge = 'x'.repeat(100_000);
  const recorder = positive.createNaturalPortRecorder(
    async () => ({
      connections: Array.from({ length: 20 }, (_, index) => ({
        localAddress: index === 0 ? huge : '127.0.0.1',
        localPort: 27683,
        state: index < 10 ? 'Established' : 'Listen',
        rawState: index < 10 ? 5 : 2,
        owningProcess: identity.processId,
      })),
      process: { ...validSnapshot().process, CommandLine: huge },
    }),
    () => tick++
  );
  for (let index = 0; index < 40; index++) await recorder.inspect(identity.processId);
  const retained = recorder.observations();
  assert.equal(retained.length, 16);
  assert.equal(retained[0]?.atEpochMs, 24);
  for (const observation of retained) {
    assert.equal(observation.inspectionStatus, 'unavailable');
    assert.equal(observation.listenerCount, 10);
    assert.equal(observation.connectionCount, 20);
    assert.equal(observation.connectionsTruncated, true);
    const listeners = observation.connections as Array<{ localAddress: string }>;
    assert.equal(listeners.length, 8);
    assert.equal(listeners[0]?.localAddress.length, 128);
    const process = observation.process as {
      CommandLine: string;
      commandLineTruncated: boolean;
      commandLineSha256: string;
    };
    assert.equal(process.CommandLine.length, 2048);
    assert.equal(process.commandLineTruncated, true);
    assert.equal(process.commandLineSha256, createHash('sha256').update(huge).digest('hex'));
  }
  assert(Buffer.byteLength(JSON.stringify(retained), 'utf8') < 90_000);
  const worstCaseReceipt = JSON.stringify(
    {
      diagnostic: {
        portObservations: retained,
        chromeStderr: { retainedTailBase64: Buffer.alloc(65_536).toString('base64') },
      },
    },
    null,
    2
  );
  assert(Buffer.byteLength(worstCaseReceipt, 'utf8') <= 192 * 1024);
});

test('negative preconnect snapshot is retained before CDP and cleanup still runs', async () => {
  const snapshots = [
    { connections: [], process: null },
    validSnapshot(),
    { ...validSnapshot(), connections: [] },
  ];
  let connections = 0;
  let cleanups = 0;
  let receipt = '';
  const childProcess = Object.assign(new EventEmitter(), {
    pid: identity.processId,
    exitCode: null,
    signalCode: null,
    stderr: new EventEmitter(),
  });
  const stderr = Buffer.alloc(70 * 1024, 0x41);
  const sandbox = {
    assert,
    Buffer,
    createHash,
    JSON,
    Error,
    AggregateError,
    join: path.join,
    STDERR_LIMIT_BYTES: 65_536,
    FAILURE_RECEIPT_MAX_BYTES: 192 * 1024,
    FIXED_DEBUG_PORT: 27_683,
    boundedEvidenceText: (value: unknown, limit: number) =>
      typeof value === 'string' ? value.slice(0, limit) : null,
    createNaturalPortRecorder: () =>
      positive.createNaturalPortRecorder(async () => {
        const next = snapshots.shift();
        assert(next, 'Unexpected additional port inspection');
        return next;
      }),
    discoverInstalledChrome: async () => ({
      executablePath: identity.executablePath,
      browserVersion: '155.0.8059.85',
    }),
    assertFixedPortUnused: positive.assertFixedPortUnused,
    mkdtemp: async () => 'C:\\Owned\\profile',
    spawn: () => {
      queueMicrotask(() => childProcess.stderr.emit('data', stderr));
      return childProcess;
    },
    naturalChromeArguments: positive.naturalChromeArguments,
    captureSpawnedChromeIdentity: async () => identity,
    readOwnedFixedPortEndpoint: async (
      child: typeof childProcess,
      childState: { spawnError: Error | null },
      owned: typeof identity,
      options: { inspectPort: (processId?: number) => Promise<Snapshot> }
    ) => {
      assert.equal(
        await positive.verifyOwnedFixedPort(child, childState, owned, {
          inspectPort: options.inspectPort,
        }),
        true
      );
      return endpoint;
    },
    connectOwnedFixedPort: positive.connectOwnedFixedPort,
    cleanupFailedNaturalChrome: async () => {
      cleanups++;
      return { cleanup: { processIdentityCaptured: true, processTreeExited: true }, errors: [] };
    },
    writeFile: async (_file: string, contents: string) => {
      receipt = contents;
    },
  };
  const launch = runInNewContext(`(${positive.launchOwnedNaturalChrome.toString()})`, sandbox);
  await assert.rejects(
    launch({
      chromium: { connectOverCDP: async () => connections++ },
      root: 'C:\\Owned',
      output: 'C:\\Owned\\out',
      checkpoint: async () => {},
    }),
    /listener disappeared before connect/
  );
  assert.equal(connections, 0);
  assert.equal(cleanups, 1);
  assert.equal(snapshots.length, 0);
  assert(Buffer.byteLength(receipt, 'utf8') <= 192 * 1024);
  const evidence = JSON.parse(receipt);
  assert.equal(evidence.status, 'failed');
  assert.equal(evidence.diagnostic.stage, 'preconnect');
  assert.equal(evidence.diagnostic.discoveryBrowserVersion, '155.0.8059.85');
  assert.equal(evidence.diagnostic.childAtFailure.pid, identity.processId);
  assert.equal(evidence.diagnostic.childAtFailure.exitCode, null);
  assert.deepEqual(
    evidence.diagnostic.portObservations.map(
      (observation: { stage: string; listenerCount: number }) => [
        observation.stage,
        observation.listenerCount,
      ]
    ),
    [
      ['fixed-port-preflight', 0],
      ['devtools-endpoint', 1],
      ['preconnect', 0],
    ]
  );
  assert.equal(evidence.diagnostic.portObservations[2].process.ProcessId, identity.processId);
  assert.equal(evidence.diagnostic.chromeStderr.totalBytes, stderr.length);
  assert.equal(evidence.diagnostic.chromeStderr.retainedTailBytes, 65_536);
  assert.equal(
    evidence.diagnostic.chromeStderr.retainedTailSha256,
    createHash('sha256').update(stderr.subarray(-65_536)).digest('hex')
  );
  assert.equal(evidence.cleanup.processTreeExited, true);
});

test('rejected preconnect inspection retains its bounded error before cleanup', async () => {
  const inspectionError = Object.assign(
    new Error('fixed-port CIM inspection timed out ' + 'x'.repeat(10_000)),
    { code: null, signal: 'SIGTERM', killed: true }
  );
  inspectionError.name = 'PortInspectionTimeout' + 'n'.repeat(1000);
  const failedInspection = mockPortInspection(
    null,
    inspectionError,
    'partial stdout',
    'partial stderr'
  );
  let inspections = 0;
  let connections = 0;
  let cleanups = 0;
  let receipt = '';
  const childProcess = Object.assign(new EventEmitter(), {
    pid: identity.processId,
    exitCode: null,
    signalCode: null,
    stderr: new EventEmitter(),
  });
  const sandbox = {
    assert,
    Buffer,
    createHash,
    JSON,
    Error,
    AggregateError,
    join: path.join,
    STDERR_LIMIT_BYTES: 65_536,
    FAILURE_RECEIPT_MAX_BYTES: 192 * 1024,
    FIXED_DEBUG_PORT: 27_683,
    boundedEvidenceText: (value: unknown, limit: number) =>
      typeof value === 'string' ? value.slice(0, limit) : null,
    createNaturalPortRecorder: () =>
      positive.createNaturalPortRecorder(async () => {
        inspections++;
        if (inspections === 1) return { connections: [], process: null };
        if (inspections === 2) return validSnapshot();
        return failedInspection.inspectPort();
      }),
    discoverInstalledChrome: async () => ({
      executablePath: identity.executablePath,
      browserVersion: '155.0.8059.85',
    }),
    assertFixedPortUnused: positive.assertFixedPortUnused,
    mkdtemp: async () => 'C:\\Owned\\profile',
    spawn: () => childProcess,
    naturalChromeArguments: positive.naturalChromeArguments,
    captureSpawnedChromeIdentity: async () => identity,
    readOwnedFixedPortEndpoint: async (
      child: typeof childProcess,
      childState: { spawnError: Error | null },
      owned: typeof identity,
      options: { inspectPort: (processId?: number) => Promise<Snapshot> }
    ) => {
      assert.equal(
        await positive.verifyOwnedFixedPort(child, childState, owned, {
          inspectPort: options.inspectPort,
        }),
        true
      );
      return endpoint;
    },
    connectOwnedFixedPort: positive.connectOwnedFixedPort,
    cleanupFailedNaturalChrome: async () => {
      cleanups++;
      return { cleanup: { processIdentityCaptured: true, processTreeExited: true }, errors: [] };
    },
    writeFile: async (_file: string, contents: string) => {
      receipt = contents;
    },
  };
  const launch = runInNewContext(`(${positive.launchOwnedNaturalChrome.toString()})`, sandbox);
  await assert.rejects(
    launch({
      chromium: { connectOverCDP: async () => connections++ },
      root: 'C:\\Owned',
      output: 'C:\\Owned\\out',
      checkpoint: async () => {},
    }),
    (error: unknown) => error === inspectionError
  );
  assert.equal(inspections, 3);
  assert.equal(connections, 0);
  assert.equal(cleanups, 1);
  assert(Buffer.byteLength(receipt, 'utf8') <= 192 * 1024);
  const evidence = JSON.parse(receipt);
  assert.equal(evidence.diagnostic.stage, 'preconnect');
  const observations = evidence.diagnostic.portObservations;
  assert.deepEqual(
    observations.map((observation: { listenerCount: number | null }) => observation.listenerCount),
    [0, 1, null]
  );
  assert.equal(observations[2].requestedProcessId, identity.processId);
  assert.equal(observations[2].connections, null);
  assert.equal(observations[2].process, null);
  assert.equal(observations[2].inspectionError.name.length, 128);
  assert.equal(observations[2].inspectionError.message.length, 1024);
  assert.equal(observations[2].inspectionFailure.stage, 'timeout');
  assert.equal(observations[2].inspectionFailure.stdout.decodedText, 'partial stdout');
  assert.equal(observations[2].inspectionFailure.stderr.decodedText, 'partial stderr');
  assert.equal(failedInspection.queries.length, 1);
  assert.equal(evidence.errorType.length, 128);
  assert.equal(evidence.cleanup.processTreeExited, true);
});
