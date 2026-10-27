import assert from 'node:assert/strict';
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
    AggregateError,
    JSON,
    Error,
    Reflect,
    join: path.join,
    STDERR_LIMIT_BYTES: 65_536,
    FIXED_DEBUG_PORT: 27_683,
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
