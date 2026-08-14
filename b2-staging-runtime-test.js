import assert from 'node:assert/strict';

const baseUrl = process.env.STAGING_WORKER_URL;
const token = process.env.STAGING_TEST_TOKEN;
const room = process.env.STAGING_ROOM ?? `b2-staging-runtime-${crypto.randomUUID()}`;

if (!baseUrl || !token) {
  throw new Error('Set STAGING_WORKER_URL and STAGING_TEST_TOKEN before running this test.');
}

const workerUrl = new URL(baseUrl);
if (
  workerUrl.protocol !== 'https:' ||
  !workerUrl.hostname.includes('durable-chat-template-b2-staging') ||
  workerUrl.hostname.includes('durable-chat-template.')
) {
  throw new Error('Refusing to run against a non-staging Worker URL.');
}

const events = [];
const ws = new WebSocket(`${workerUrl.origin}/parties/b2-staging-chat/${encodeURIComponent(room)}`);

function control(action, fields = {}) {
  return fetch(`${workerUrl.origin}/__b2-test/control`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'x-b2-staging-room': room,
    },
    body: JSON.stringify({ action, ...fields }),
  }).then(async (response) => {
    if (!response.ok) {
      throw new Error(`Staging control failed with HTTP ${response.status}`);
    }
    return response.json();
  });
}

function waitForEvent(predicate, description, timeoutMs = 30_000) {
  const existing = events.find(predicate);
  if (existing) {
    return Promise.resolve(existing);
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${description}: timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    const interval = setInterval(() => {
      const event = events.find(predicate);
      if (event) {
        clearTimeout(timer);
        clearInterval(interval);
        resolve(event);
      }
    }, 100);
  });
}

ws.addEventListener('message', (event) => {
  events.push(JSON.parse(String(event.data)));
});

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', () => reject(new Error('Staging WebSocket error')), { once: true });
});

await control('set_email_mode', { mode: 'success' });
await control('set_alert', { below: 100, above: 120, enabled: true });
await control('trade', { price: 110, volume: 1, timestamp: Date.now() });
await control('state');

let stateResponse = await control('state');
assert.equal(stateResponse.runtime.alertStates.B2TEST, 'inside');
assert.equal(Object.keys(stateResponse.runtime.deliveries).length, 0);

await control('trade', { price: 130, volume: 1, timestamp: Date.now() });
const pending = await waitForEvent(
  (event) => event.type === 'alert_delivery_status' && event.status === 'pending' && event.symbol === 'B2TEST',
  'pending delivery status',
);
const triggerId = pending.triggerId;
await waitForEvent(
  (event) => event.type === 'price_alert' && event.symbol === 'B2TEST' && event.zone === 'above',
  'above price alert',
);

await waitForEvent(
  (event) => event.type === 'alert_delivery_status' && event.triggerId === triggerId && event.status === 'sending',
  'sending delivery status',
);
await waitForEvent(
  (event) => event.type === 'alert_delivery_status' && event.triggerId === triggerId && event.status === 'sent',
  'sent delivery status',
);

stateResponse = await control('state');
assert.ok(stateResponse.runtime.deliveries[triggerId]);
assert.equal(stateResponse.runtime.deliveries[triggerId].status, 'sent');

await control('set_email_mode', { mode: 'retryable_failure' });
await control('trade', { price: 110, volume: 1, timestamp: Date.now() });
await waitForEvent(
  (event) => event.type === 'alert_reset' && event.symbol === 'B2TEST',
  'alert reset',
);
await control('trade', { price: 130, volume: 1, timestamp: Date.now() });
const initialRetryPending = await waitForEvent(
  (event) => event.type === 'alert_delivery_status' && event.status === 'pending' && event.triggerId !== triggerId,
  'initial retry pending status',
);
const retryTriggerId = initialRetryPending.triggerId;
await waitForEvent(
  (event) => event.type === 'alert_delivery_status' && event.status === 'sending' && event.triggerId === retryTriggerId,
  'retry sending status',
);
const retryPending = await waitForEvent(
  (event) => event.type === 'alert_delivery_status' && event.status === 'pending' && event.triggerId === retryTriggerId && typeof event.nextRetryAt === 'number',
  'scheduled retry pending status',
);
assert.equal(retryPending.attempts, 1);
assert.ok(typeof retryPending.nextRetryAt === 'number');
await waitForEvent(
  (event) => event.type === 'alert_email_error' && event.symbol === 'B2TEST',
  'alert email error',
);

await control('set_email_mode', { mode: 'permanent_failure' });
await control('trade', { price: 110, volume: 1, timestamp: Date.now() });
await waitForEvent(
  (event) => event.type === 'alert_reset' && event.symbol === 'B2TEST',
  'second alert reset',
);
await control('trade', { price: 130, volume: 1, timestamp: Date.now() });
await waitForEvent(
  (event) => event.type === 'alert_delivery_status' && event.status === 'failed' && event.triggerId !== triggerId,
  'permanent failure status',
);

console.log('PASS staging runtime flow');
ws.close();
