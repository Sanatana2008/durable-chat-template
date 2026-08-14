import assert from 'node:assert/strict';

const ALERT_RUNTIME_STORAGE_KEY = 'alert_runtime_v2';
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

let realFetchCalls = 0;
let finnhubWebSocketConstructions = 0;
let fakeEmailCalls = 0;

globalThis.fetch = async () => {
  realFetchCalls += 1;
  throw new Error('FAIL real global fetch was called');
};

class ForbiddenWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static READY_STATE_OPEN = 1;

  constructor() {
    finnhubWebSocketConstructions += 1;
    throw new Error('FAIL Finnhub WebSocket was constructed');
  }
}

globalThis.WebSocket = ForbiddenWebSocket;
globalThis.DurableObject = class {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
};

const { Chat } = await import('./src/server/index.ts');

function clone(value) {
  return structuredClone(value);
}

class FakeStorage {
  values = new Map();
  alarms = [];

  async get(key) {
    return clone(this.values.get(key));
  }

  async put(key, value) {
    this.values.set(key, clone(value));
  }

  async setAlarm(value) {
    this.alarms.push(value instanceof Date ? value.getTime() : value);
  }

  async getAlarm() {
    return this.alarms.length > 0 ? this.alarms[this.alarms.length - 1] : null;
  }

  async deleteAlarm() {
    this.alarms = [];
  }
}

function createContext(storage) {
  return {
    storage,
    getWebSockets: () => [],
    blockConcurrencyWhile: async (callback) => callback(),
  };
}

async function createHarness({ storage = new FakeStorage(), now = 1_000_000, outcomes = [], initialize = true } = {}) {
  let currentTime = now;
  const events = [];
  const emailBodies = [];
  let emailCalls = 0;
  const remainingOutcomes = [...outcomes];
  const chat = new Chat(createContext(storage), {});

  chat.broadcast = (payload) => {
    events.push(JSON.parse(String(payload)));
  };
  chat.clock = () => currentTime;
  chat.emailSender = async (subject, text) => {
    emailCalls += 1;
    fakeEmailCalls += 1;
    emailBodies.push({ subject, text });
    const outcome = remainingOutcomes.shift() ?? { type: 'success' };
    if (outcome.type === 'success') {
      return outcome.messageId ?? `fake-message-${emailCalls}`;
    }
    throw new Error(`Gmail API HTTP ${outcome.status}: fake failure`);
  };

  if (initialize) {
    await chat.onAlarm();
  }

  return {
    chat,
    storage,
    events,
    emailBodies,
    get emailCalls() {
      return emailCalls;
    },
    get now() {
      return currentTime;
    },
    setNow(value) {
      currentTime = value;
    },
  };
}

async function runtime(harness) {
  return await harness.storage.get(ALERT_RUNTIME_STORAGE_KEY);
}

function deliveries(runtimeState) {
  return Object.values(runtimeState?.deliveries ?? {});
}

function deliveryFor(runtimeState, triggerId) {
  return runtimeState.deliveries[triggerId];
}

function eventsOf(harness, type) {
  return harness.events.filter((event) => event.type === type);
}

async function configureAlert(harness, below = 100, above = 120, enabled = true) {
  await harness.chat.setAlert('AAPL', below, above, enabled);
}

async function trade(harness, price, timestamp = harness.now) {
  await harness.chat.processPriceAlert({
    symbol: 'AAPL',
    price,
    volume: 1,
    timestamp,
  });
}

async function expectScenario(name, callback) {
  await callback();
  console.log(`PASS ${name}`);
}

await expectScenario('B2-1 initial inside has no delivery', async () => {
  const harness = await createHarness();
  await configureAlert(harness);
  await trade(harness, 110);
  const state = await runtime(harness);
  assert.equal(state.alertStates.AAPL, 'inside');
  assert.equal(deliveries(state).length, 0);
  assert.equal(eventsOf(harness, 'price_alert').length, 0);
});

await expectScenario('B2-2 inside to above creates one pending delivery', async () => {
  const harness = await createHarness();
  await configureAlert(harness);
  await trade(harness, 110);
  harness.events.length = 0;
  await trade(harness, 130, harness.now + 1);
  const state = await runtime(harness);
  assert.equal(deliveries(state).length, 1);
  const delivery = deliveries(state)[0];
  assert.equal(delivery.zone, 'above');
  assert.equal(delivery.status, 'pending');
  assert.match(delivery.triggerId, /^AAPL:\d+$/);
  assert.equal(eventsOf(harness, 'price_alert').length, 1);
  assert.equal(eventsOf(harness, 'alert_delivery_status').at(-1).status, 'pending');
  assert.equal(harness.storage.alarms.at(-1), harness.now);
});

await expectScenario('B2-3 same above zone creates no second trigger', async () => {
  const harness = await createHarness();
  await configureAlert(harness);
  await trade(harness, 110);
  await trade(harness, 130, harness.now + 1);
  const before = await runtime(harness);
  const beforeAlerts = eventsOf(harness, 'price_alert').length;
  await trade(harness, 135, harness.now + 2);
  const after = await runtime(harness);
  assert.deepEqual(after.deliveries, before.deliveries);
  assert.equal(eventsOf(harness, 'price_alert').length, beforeAlerts);
});

await expectScenario('B2-4 above to inside broadcasts alert_reset', async () => {
  const harness = await createHarness();
  await configureAlert(harness);
  await trade(harness, 110);
  await trade(harness, 130, harness.now + 1);
  harness.events.length = 0;
  await trade(harness, 110, harness.now + 2);
  const state = await runtime(harness);
  assert.equal(state.alertStates.AAPL, 'inside');
  assert.equal(deliveries(state).length, 1);
  assert.equal(eventsOf(harness, 'alert_reset').length, 1);
});

await expectScenario('B2-5 inside to below creates a new delivery', async () => {
  const harness = await createHarness();
  await configureAlert(harness);
  await trade(harness, 110);
  await trade(harness, 130, harness.now + 1);
  await trade(harness, 110, harness.now + 2);
  harness.events.length = 0;
  await trade(harness, 90, harness.now + 3);
  const state = await runtime(harness);
  const records = deliveries(state);
  assert.equal(records.length, 2);
  assert.notEqual(records[0].triggerId, records[1].triggerId);
  assert.equal(records[1].zone, 'below');
  assert.equal(records[1].status, 'pending');
  assert.equal(eventsOf(harness, 'price_alert').length, 1);
});

await expectScenario('B2-6 success is pending sending sent', async () => {
  const harness = await createHarness({ outcomes: [{ type: 'success', messageId: 'fake-success' }] });
  await configureAlert(harness);
  await trade(harness, 110);
  await trade(harness, 130, harness.now + 1);
  const triggerId = deliveries(await runtime(harness))[0].triggerId;
  await harness.chat.onAlarm();
  const record = deliveryFor(await runtime(harness), triggerId);
  const statuses = eventsOf(harness, 'alert_delivery_status')
    .filter((event) => event.triggerId === triggerId)
    .map((event) => event.status);
  assert.deepEqual(statuses, ['pending', 'sending', 'sent']);
  assert.equal(record.status, 'sent');
  assert.equal(record.attempts, 1);
  assert.equal(record.messageId, 'fake-success');
});

await expectScenario('B2-7 retryable failure schedules pending retry', async () => {
  const harness = await createHarness({ outcomes: [{ type: 'retryable-error', status: 503 }] });
  await configureAlert(harness);
  await trade(harness, 110);
  await trade(harness, 130, harness.now + 1);
  const triggerId = deliveries(await runtime(harness))[0].triggerId;
  const start = harness.now;
  await harness.chat.onAlarm();
  const record = deliveryFor(await runtime(harness), triggerId);
  assert.equal(record.status, 'pending');
  assert.equal(record.attempts, 1);
  assert.equal(record.nextRetryAt, start + 30_000);
  assert.equal(eventsOf(harness, 'alert_email_error').length, 1);
  assert.equal(eventsOf(harness, 'alert_delivery_status').at(-1).status, 'pending');
});

await expectScenario('B2-8 fifth retryable failure becomes failed', async () => {
  const harness = await createHarness({
    outcomes: Array.from({ length: 5 }, () => ({ type: 'retryable-error', status: 503 })),
  });
  await configureAlert(harness);
  await trade(harness, 110);
  await trade(harness, 130, harness.now + 1);
  const triggerId = deliveries(await runtime(harness))[0].triggerId;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await harness.chat.onAlarm();
    const record = deliveryFor(await runtime(harness), triggerId);
    if (record.status === 'pending') {
      harness.setNow(record.nextRetryAt);
    }
  }
  const record = deliveryFor(await runtime(harness), triggerId);
  assert.equal(record.status, 'failed');
  assert.equal(record.attempts, 5);
  assert.equal(record.completedAt, harness.now);
  const calls = harness.emailCalls;
  await harness.chat.onAlarm();
  assert.equal(harness.emailCalls, calls);
});

await expectScenario('B2-9 permanent failure stops after first attempt', async () => {
  const harness = await createHarness({ outcomes: [{ type: 'permanent-error', status: 400 }] });
  await configureAlert(harness);
  await trade(harness, 110);
  await trade(harness, 130, harness.now + 1);
  const triggerId = deliveries(await runtime(harness))[0].triggerId;
  await harness.chat.onAlarm();
  const record = deliveryFor(await runtime(harness), triggerId);
  assert.equal(record.status, 'failed');
  assert.equal(record.attempts, 1);
  assert.equal(record.nextRetryAt, null);
  assert.equal(harness.emailCalls, 1);
  assert.equal(eventsOf(harness, 'alert_email_error').length, 1);
});

await expectScenario('B2-10 delivery status fields are complete', async () => {
  const harness = await createHarness({ outcomes: [{ type: 'success' }] });
  await configureAlert(harness);
  await trade(harness, 110);
  await trade(harness, 130, harness.now + 1);
  const triggerId = deliveries(await runtime(harness))[0].triggerId;
  await harness.chat.onAlarm();
  const statuses = eventsOf(harness, 'alert_delivery_status')
    .filter((event) => event.triggerId === triggerId);
  for (const status of statuses) {
    assert.equal(status.symbol, 'AAPL');
    assert.equal(status.zone, 'above');
    assert.equal(status.triggerId, triggerId);
    assert.equal(typeof status.attempts, 'number');
    assert.equal(typeof status.triggeredAt, 'number');
    assert.ok(status.nextRetryAt === null || typeof status.nextRetryAt === 'number');
    assert.ok(status.lastError === null || typeof status.lastError === 'string');
  }
});

await expectScenario('B2-11 expired sending recovers same trigger', async () => {
  const storage = new FakeStorage();
  const triggerId = 'AAPL:77';
  await storage.put(ALERT_RUNTIME_STORAGE_KEY, {
    version: 2,
    alertStates: { AAPL: 'above' },
    nextTriggerSequence: 78,
    deliveries: {
      [triggerId]: {
        triggerId,
        symbol: 'AAPL',
        zone: 'above',
        price: 130,
        boundary: 120,
        triggeredAt: 1_000,
        status: 'sending',
        attempts: 2,
        nextRetryAt: null,
        lastError: null,
        lastAttemptAt: 1_000,
        completedAt: null,
        leaseExpiresAt: 1_500,
        messageId: null,
      },
    },
  });
  const harness = await createHarness({ storage, now: 2_000, outcomes: [{ type: 'success' }] });
  const record = deliveryFor(await runtime(harness), triggerId);
  assert.equal(record.triggerId, triggerId);
  assert.equal(record.status, 'sent');
  assert.equal(record.attempts, 3);
  assert.equal(eventsOf(harness, 'price_alert').length, 0);
  assert.equal(harness.emailCalls, 1);
});

await expectScenario('B2-12 boundary changes do not alter delivery snapshot', async () => {
  const harness = await createHarness({ outcomes: [{ type: 'success' }] });
  await configureAlert(harness);
  await trade(harness, 110);
  await trade(harness, 130, harness.now + 1);
  await harness.chat.setAlert('AAPL', 100, 150, true);
  await harness.chat.onAlarm();
  assert.match(harness.emailBodies[0].text, /Hranice: 120 USD/);
});

await expectScenario('B2-13 enabled false does not cancel delivery', async () => {
  const harness = await createHarness({ outcomes: [{ type: 'success' }] });
  await configureAlert(harness);
  await trade(harness, 110);
  await trade(harness, 130, harness.now + 1);
  await harness.chat.setAlertEnabled({ send() {} }, 'AAPL', false);
  await harness.chat.onAlarm();
  const record = deliveries(await runtime(harness))[0];
  assert.equal(record.status, 'sent');
  assert.equal(harness.emailCalls, 1);
});

await expectScenario('B2-14 deleting alert does not cancel delivery', async () => {
  const harness = await createHarness({ outcomes: [{ type: 'success' }] });
  await configureAlert(harness);
  await trade(harness, 110);
  await trade(harness, 130, harness.now + 1);
  await harness.chat.deleteAlert('AAPL');
  await harness.chat.onAlarm();
  const record = deliveries(await runtime(harness))[0];
  assert.equal(record.status, 'sent');
  assert.equal(harness.emailCalls, 1);
});

await expectScenario('B2-15 retention removes terminal records only', async () => {
  const storage = new FakeStorage();
  const now = 10_000_000;
  await storage.put(ALERT_RUNTIME_STORAGE_KEY, {
    version: 2,
    alertStates: {},
    nextTriggerSequence: 4,
    deliveries: {
      sentOld: {
        triggerId: 'sentOld', symbol: 'AAPL', zone: 'above', price: 130, boundary: 120,
        triggeredAt: 1, status: 'sent', attempts: 1, nextRetryAt: null, lastError: null,
        lastAttemptAt: 1, completedAt: now - RETENTION_MS, leaseExpiresAt: null, messageId: 'sent',
      },
      failedOld: {
        triggerId: 'failedOld', symbol: 'AAPL', zone: 'below', price: 90, boundary: 100,
        triggeredAt: 1, status: 'failed', attempts: 5, nextRetryAt: null, lastError: 'failed',
        lastAttemptAt: 1, completedAt: now - RETENTION_MS, leaseExpiresAt: null, messageId: null,
      },
      pending: {
        triggerId: 'pending', symbol: 'AAPL', zone: 'above', price: 130, boundary: 120,
        triggeredAt: 1, status: 'pending', attempts: 1, nextRetryAt: now + 5_000, lastError: 'retry',
        lastAttemptAt: 1, completedAt: null, leaseExpiresAt: null, messageId: null,
      },
      sending: {
        triggerId: 'sending', symbol: 'AAPL', zone: 'below', price: 90, boundary: 100,
        triggeredAt: 1, status: 'sending', attempts: 1, nextRetryAt: null, lastError: null,
        lastAttemptAt: now, completedAt: null, leaseExpiresAt: now + 5_000, messageId: null,
      },
    },
  });
  const harness = await createHarness({ storage, now, outcomes: [], initialize: true });
  const state = await runtime(harness);
  assert.equal(state.deliveries.sentOld, undefined);
  assert.equal(state.deliveries.failedOld, undefined);
  assert.ok(state.deliveries.pending);
  assert.ok(state.deliveries.sending);
  assert.equal(harness.storage.alarms.length, 1);
  assert.equal(harness.storage.alarms[0], now + 5_000);

  const terminalStorage = new FakeStorage();
  await terminalStorage.put(ALERT_RUNTIME_STORAGE_KEY, {
    version: 2,
    alertStates: {},
    nextTriggerSequence: 1,
    deliveries: {
      old: {
        triggerId: 'old', symbol: 'AAPL', zone: 'above', price: 130, boundary: 120,
        triggeredAt: 1, status: 'sent', attempts: 1, nextRetryAt: null, lastError: null,
        lastAttemptAt: 1, completedAt: now - RETENTION_MS, leaseExpiresAt: null, messageId: 'old',
      },
    },
  });
  const terminalHarness = await createHarness({ storage: terminalStorage, now });
  assert.equal((await runtime(terminalHarness)).deliveries.old, undefined);
  assert.equal(terminalHarness.storage.alarms.length, 0);
});

await expectScenario('B2-16 network protection blocks real IO', async () => {
  assert.equal(realFetchCalls, 0);
  assert.equal(finnhubWebSocketConstructions, 0);
  assert.ok(fakeEmailCalls > 0);
});

console.log(`PASS B2 deterministic harness; fake email calls = ${fakeEmailCalls}`);
console.log(`REAL_FETCH_CALLS ${realFetchCalls}`);
console.log(`FINNHUB_WEBSOCKET_CONSTRUCTIONS ${finnhubWebSocketConstructions}`);
console.log('PASS all deterministic B2 scenarios');
