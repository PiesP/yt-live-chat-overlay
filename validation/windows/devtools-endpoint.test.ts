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
  listeners: [
    {
      localAddress: '127.0.0.1',
      localPort: 27683,
      state: 'Listen',
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
  const listener = snapshot.listeners[0];
  assert(listener);
  return listener;
}
const version = (value: string) =>
  Buffer.from(JSON.stringify({ Browser: 'Chrome/155.0.8059.85', webSocketDebuggerUrl: value }));

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
      listeners: [],
      process: null,
    }),
  });
  for (const localAddress of ['127.0.0.1', '::1', '0.0.0.0']) {
    await assert.rejects(
      positive.assertFixedPortUnused({
        inspectPort: async () => ({
          listeners: [{ localAddress, localPort: 27683, state: 'Listen', owningProcess: 999 }],
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
        snapshot.listeners.push({ ...firstListener(snapshot) });
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
      inspectPort: async () => ({ ...validSnapshot(), listeners: [] }),
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

test('failure recorder bounds existing listener and CIM snapshots', async () => {
  let tick = 0;
  const huge = 'x'.repeat(100_000);
  const recorder = positive.createNaturalPortRecorder(
    async () => ({
      listeners: Array.from({ length: 20 }, () => ({
        localAddress: huge,
        localPort: 27683,
        state: 'Listen',
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
    assert.equal(observation.listenerCount, 20);
    assert.equal(observation.listenersTruncated, true);
    const listeners = observation.listeners as Array<{ localAddress: string }>;
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
    { listeners: [], process: null },
    validSnapshot(),
    { ...validSnapshot(), listeners: [] },
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
  const inspectionError = new Error('fixed-port CIM inspection timed out ' + 'x'.repeat(10_000));
  inspectionError.name = 'PortInspectionTimeout' + 'n'.repeat(1000);
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
        if (inspections === 1) return { listeners: [], process: null };
        if (inspections === 2) return validSnapshot();
        throw inspectionError;
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
  assert.equal(observations[2].listeners, null);
  assert.equal(observations[2].process, null);
  assert.equal(observations[2].inspectionError.name.length, 128);
  assert.equal(observations[2].inspectionError.message.length, 1024);
  assert.equal(evidence.errorType.length, 128);
  assert.equal(evidence.cleanup.processTreeExited, true);
});
