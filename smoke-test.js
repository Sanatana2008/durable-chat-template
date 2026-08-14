const ws = new WebSocket('ws://127.0.0.1:8787/parties/chat/stocks');
const messages = [];
const waiters = [];
const deliveryStatuses = [];
let finished = false;

const allowedTypes = new Set([
  'status',
  'symbols',
  'snapshot',
  'alerts',
  'alert_delivery_status',
  'alert_command_ack',
  'alert_error',
]);

function fail(reason) {
  if (finished) {
    return;
  }

  finished = true;
  console.log(`FAIL ${reason}`);
  ws.close();
  process.exitCode = 1;
}

function send(message) {
  console.log('SEND', JSON.stringify(message));
  ws.send(JSON.stringify(message));
}

function validateMessage(message) {
  if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
    fail('received a non-object payload');
    return false;
  }

  if (message.type === 'price_alert' || message.type === 'alert_reset' || message.type === 'alert_email_error') {
    fail(`forbidden payload type ${message.type}`);
    return false;
  }

  if (!allowedTypes.has(message.type)) {
    fail(`unexpected payload type ${message.type}`);
    return false;
  }

  if (message.type === 'alert_delivery_status') {
    if (
      typeof message.symbol !== 'string' ||
      (message.zone !== 'below' && message.zone !== 'above') ||
      typeof message.triggerId !== 'string' ||
      !['pending', 'sending', 'sent', 'failed'].includes(message.status) ||
      !Number.isInteger(message.attempts) ||
      (message.nextRetryAt !== null && typeof message.nextRetryAt !== 'number') ||
      (message.lastError !== null && typeof message.lastError !== 'string') ||
      typeof message.triggeredAt !== 'number'
    ) {
      fail(`invalid alert_delivery_status payload ${JSON.stringify(message)}`);
      return false;
    }

    deliveryStatuses.push(message);
  }

  return true;
}

function takeMessage(predicate, description, timeoutMs = 4000) {
  const index = messages.findIndex(predicate);
  if (index >= 0) {
    return Promise.resolve(messages.splice(index, 1)[0]);
  }

  return new Promise((resolve, reject) => {
    const waiter = {
      predicate,
      description,
      resolve,
      reject,
      timer: setTimeout(() => {
        const waiterIndex = waiters.indexOf(waiter);
        if (waiterIndex >= 0) {
          waiters.splice(waiterIndex, 1);
        }
        reject(new Error(`${description}: timeout after ${timeoutMs}ms`));
      }, timeoutMs),
    };
    waiters.push(waiter);
  });
}

function alertState(message) {
  if (message.type !== 'alerts' || !Array.isArray(message.alerts)) {
    return undefined;
  }

  const alert = message.alerts.find((candidate) => candidate && candidate.symbol === 'AAPL');
  return alert
    ? { below: alert.below, above: alert.above, enabled: alert.enabled }
    : undefined;
}

async function expectAlert(expected, description) {
  await takeMessage(
    (candidate) => JSON.stringify(alertState(candidate)) === JSON.stringify(expected),
    description,
  );
}

async function expectAck(requestId, command) {
  const message = await takeMessage(
    (candidate) => candidate.type === 'alert_command_ack' && candidate.requestId === requestId,
    `ACK ${requestId}`,
  );

  if (message.command !== command || message.symbol !== 'AAPL') {
    throw new Error(`ACK ${requestId}: unexpected payload ${JSON.stringify(message)}`);
  }
}

async function expectAlertCommand(message, expectedAlert, description) {
  await Promise.all([
    expectAck(message.requestId, message.type),
    expectAlert(expectedAlert, `${description} alerts broadcast`),
  ]);
}

async function expectError(requestId, code, description) {
  const message = await takeMessage(
    (candidate) => candidate.type === 'alert_error' && candidate.requestId === requestId,
    description,
  );

  if (message.code !== code) {
    throw new Error(`${description}: expected code ${code}, got ${JSON.stringify(message)}`);
  }
}

async function run() {
  await takeMessage(
    (message) => message.type === 'symbols' && Array.isArray(message.symbols) && message.symbols.includes('AAPL'),
    'symbols payload containing AAPL',
  );
  console.log('PASS setup: symbols payload contains AAPL');

  send({ type: 'set_alert', symbol: 'AAPL', below: 300, above: 320, enabled: true });
  await expectAlert({ below: 300, above: 320, enabled: true }, 'A');
  console.log('PASS A: legacy set_alert creates the default alert');

  const below310 = { type: 'set_alert_boundary', symbol: 'AAPL', boundary: 'below', value: 310, requestId: 'below-310' };
  send(below310);
  await expectAlertCommand(below310, { below: 310, above: 320, enabled: true }, 'B');
  console.log('PASS B: below changed to 310 and above stayed 320');

  const above330 = { type: 'set_alert_boundary', symbol: 'AAPL', boundary: 'above', value: 330, requestId: 'above-330' };
  send(above330);
  await expectAlertCommand(above330, { below: 310, above: 330, enabled: true }, 'C');
  console.log('PASS C: above changed to 330 and below stayed 310');

  const clearBelow = { type: 'set_alert_boundary', symbol: 'AAPL', boundary: 'below', value: null, requestId: 'clear-below' };
  send(clearBelow);
  await expectAlertCommand(clearBelow, { below: null, above: 330, enabled: true }, 'D');
  console.log('PASS D: below cleared and above stayed 330');

  const clearAbove = { type: 'set_alert_boundary', symbol: 'AAPL', boundary: 'above', value: null, requestId: 'clear-above' };
  send(clearAbove);
  await expectAlertCommand(clearAbove, undefined, 'E');
  console.log('PASS E: alert disappeared after clearing above');

  send({ type: 'set_alert', symbol: 'AAPL', below: 300, above: 320, enabled: true });
  await expectAlert({ below: 300, above: 320, enabled: true }, 'F');
  console.log('PASS F: alert recreated with both boundaries');

  const disable = { type: 'set_alert_enabled', symbol: 'AAPL', enabled: false, requestId: 'disable' };
  send(disable);
  await expectAlertCommand(disable, { below: 300, above: 320, enabled: false }, 'G');
  console.log('PASS G: alert disabled and boundaries preserved');

  const enable = { type: 'set_alert_enabled', symbol: 'AAPL', enabled: true, requestId: 'enable' };
  send(enable);
  await expectAlertCommand(enable, { below: 300, above: 320, enabled: true }, 'H');
  console.log('PASS H: alert enabled and boundaries preserved');

  const invalidValue = { type: 'set_alert_boundary', symbol: 'AAPL', boundary: 'below', value: -5, requestId: 'bad-value' };
  send(invalidValue);
  await expectError('bad-value', 'invalid_value', 'I');
  console.log('PASS I: invalid value returned invalid_value');

  const invalidRange = { type: 'set_alert_boundary', symbol: 'AAPL', boundary: 'below', value: 330, requestId: 'bad-range' };
  send(invalidRange);
  await expectError('bad-range', 'invalid_range', 'J');
  console.log('PASS J: invalid range returned invalid_range');

  const unknownSymbol = { type: 'set_alert_boundary', symbol: 'ZZZZ', boundary: 'below', value: 100, requestId: 'bad-symbol' };
  send(unknownSymbol);
  await expectError('bad-symbol', 'unknown_symbol', 'K');
  console.log('PASS K: unknown symbol returned unknown_symbol');

  console.log(`INFO B2 delivery statuses observed: ${deliveryStatuses.length}`);
  finished = true;
  console.log('PASS smoke test');
  ws.close();
  process.exitCode = 0;
}

ws.onopen = () => {
  console.log('OPEN');
  send({ type: 'set_symbols', symbols: ['AAPL'] });
  run().catch((error) => fail(error instanceof Error ? error.message : String(error)));
};

ws.onmessage = (event) => {
  const text = String(event.data);
  console.log('MSG', text);

  let message;
  try {
    message = JSON.parse(text);
  } catch (error) {
    fail(`invalid JSON payload: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  if (!validateMessage(message)) {
    return;
  }

  const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(message));
  if (waiterIndex >= 0) {
    const waiter = waiters.splice(waiterIndex, 1)[0];
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  } else {
    messages.push(message);
  }
};

ws.onerror = () => {
  fail('WebSocket error');
};

ws.onclose = () => {
  console.log('CLOSE');
  if (!finished) {
    fail('WebSocket closed before the smoke test completed');
  }
  process.exit(finished ? 0 : 1);
};

setTimeout(() => {
  if (!finished) {
    fail('TIMEOUT');
    process.exit(1);
  }
}, 15000);
