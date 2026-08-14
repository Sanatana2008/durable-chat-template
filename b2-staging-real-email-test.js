import assert from 'node:assert/strict';

if (process.env.B2_REAL_EMAIL_TEST !== '1') {
  throw new Error('Set B2_REAL_EMAIL_TEST=1 to run the staging real-email test.');
}

const baseUrl = process.env.STAGING_WORKER_URL;
const token = process.env.STAGING_TEST_TOKEN;
const room = `b2-staging-real-email-${crypto.randomUUID()}`;

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
let ws;

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
    const timer = setTimeout(() => reject(new Error(`${description}: timeout after ${timeoutMs}ms`)), timeoutMs);
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

try {
  ws = new WebSocket(`${workerUrl.origin}/parties/b2-staging-chat/${encodeURIComponent(room)}`);
  ws.addEventListener('message', (event) => events.push(JSON.parse(String(event.data))));
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('Staging WebSocket error')), { once: true });
  });

  await control('set_email_mode', { mode: 'real_gmail' });
  await control('set_alert', { below: 100, above: 120, enabled: true });
  await control('trade', { price: 110, volume: 1, timestamp: Date.now() });
  await control('trade', { price: 130, volume: 1, timestamp: Date.now() });

  const pending = await waitForEvent(
    (event) => event.type === 'alert_delivery_status' && event.status === 'pending' && event.symbol === 'B2TEST',
    'pending delivery status',
  );
  const triggerId = pending.triggerId;
  await waitForEvent(
    (event) => event.type === 'alert_delivery_status' && event.triggerId === triggerId && event.status === 'sending',
    'sending delivery status',
  );
  await waitForEvent(
    (event) => event.type === 'alert_delivery_status' && event.triggerId === triggerId && event.status === 'sent',
    'sent delivery status',
  );

  const state = await control('state');
  assert.ok(state.runtime.deliveries[triggerId]);
  assert.equal(state.runtime.deliveries[triggerId].status, 'sent');
  console.log('PASS staging real Gmail flow');
} finally {
  try {
    await control('set_email_mode', { mode: 'success' });
    await control('delete_alert');
  } catch {
    // Preserve the original failure while making a best-effort cleanup request.
  }
  ws?.close();
}