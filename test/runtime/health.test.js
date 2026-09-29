'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');

const { waitForHealth } = require('../../src/main/runtime/health.js');

const URL_UNDER_TEST = 'http://127.0.0.1:1/?token=abc';

for (const statusCode of [200, 303, 401]) {
  test(`resolves on any HTTP response (status ${statusCode})`, async () => {
    let calls = 0;
    const response = { statusCode };
    const result = await waitForHealth(URL_UNDER_TEST, {
      timeoutMs: 500,
      request: (url, onResponse) => {
        calls += 1;
        onResponse(response);
        return null;
      },
    });

    assert.equal(result, response);
    assert.equal(calls, 1);
  });
}

test('retries connection errors until a response arrives', async () => {
  let calls = 0;
  const response = { statusCode: 401 };
  const result = await waitForHealth(URL_UNDER_TEST, {
    timeoutMs: 1000,
    intervalMs: 5,
    request: (url, onResponse, onError) => {
      calls += 1;
      if (calls < 3) setImmediate(() => onError(new Error('ECONNREFUSED')));
      else setImmediate(() => onResponse(response));
      return null;
    },
  });

  assert.equal(result, response);
  assert.equal(calls, 3);
});

test('retries errors emitted by the returned request object', async () => {
  let calls = 0;
  const result = await waitForHealth(URL_UNDER_TEST, {
    timeoutMs: 1000,
    intervalMs: 5,
    request: (url, onResponse) => {
      calls += 1;
      const request = new EventEmitter();
      request.destroy = () => {};
      if (calls < 2) setImmediate(() => request.emit('error', new Error('socket hang up')));
      else setImmediate(() => onResponse({ statusCode: 303 }));
      return request;
    },
  });

  assert.equal(calls, 2);
  assert.equal(result.statusCode, 303);
});

test('ignores duplicate error emissions while a retry is already pending', async () => {
  let calls = 0;
  const result = await waitForHealth(URL_UNDER_TEST, {
    timeoutMs: 500,
    intervalMs: 10,
    request: (url, onResponse, onError) => {
      calls += 1;
      if (calls === 1) {
        onError(new Error('first failure'));
        onError(new Error('duplicate failure'));
      } else {
        setImmediate(() => onResponse({ statusCode: 200 }));
      }
      return null;
    },
  });

  assert.equal(result.statusCode, 200);
  assert.equal(calls, 2);
});

test('rejects after timeout when every attempt fails with a connection error', async () => {
  let calls = 0;
  await assert.rejects(
    waitForHealth(URL_UNDER_TEST, {
      timeoutMs: 40,
      intervalMs: 5,
      request: (url, onResponse, onError) => {
        calls += 1;
        onError(new Error('ECONNREFUSED'));
        return null;
      },
    }),
    (error) => {
      assert.match(error.message, /timed out/i);
      assert.match(error.message, /ECONNREFUSED/);
      return true;
    },
  );
  assert.ok(calls >= 2, `expected retries, saw ${calls}`);
});

test('rejects after timeout when the request never answers', async () => {
  let destroyed = 0;
  await assert.rejects(
    waitForHealth(URL_UNDER_TEST, {
      timeoutMs: 30,
      request: () => ({
        destroy() {
          destroyed += 1;
        },
      }),
    }),
    /timed out/i,
  );
  assert.equal(destroyed, 1);
});

test('uses the real http request seam against a loopback server', async () => {
  const server = http.createServer((request, response) => {
    response.statusCode = 303;
    response.setHeader('location', '/');
    response.end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address();
  try {
    const response = await waitForHealth(`http://127.0.0.1:${port}/?token=abc`, {
      timeoutMs: 2000,
      intervalMs: 20,
    });
    assert.equal(response.statusCode, 303);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('real request seam retries connection failures until timeout', async () => {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));

  await assert.rejects(
    waitForHealth(`http://127.0.0.1:${port}/`, { timeoutMs: 100, intervalMs: 10 }),
    /timed out/i,
  );
});
