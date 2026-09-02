// Server-sent events bus: the one-way channel the browser uses to hear about
// state changes (net-log entries, engine status, and later voice and
// download progress) without polling. GET /api/events subscribes a response
// to it.
//
// Usage:
//   import { createBus } from './bus.js';
//   const bus = createBus();
//   app.get('/api/events', (req, res) => bus.subscribe(res));
//   bus.publish('netlog', entry);
//   bus.close(); // on shutdown

const HEARTBEAT_MS = 15000;

export function createBus() {
  const subscribers = new Set();

  function writeEvent(res, type, data) {
    try {
      res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      return true;
    } catch {
      return false;
    }
  }

  function subscribe(res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    subscribers.add(res);
    writeEvent(res, 'hello', { time: new Date().toISOString() });

    const drop = () => unsubscribe(res);
    res.on('close', drop);
    res.on('error', drop);
  }

  function unsubscribe(res) {
    subscribers.delete(res);
  }

  function publish(type, data) {
    for (const res of subscribers) {
      if (!writeEvent(res, type, data)) unsubscribe(res);
    }
  }

  function size() {
    return subscribers.size;
  }

  const heartbeat = setInterval(() => {
    for (const res of subscribers) {
      try {
        res.write(': ping\n\n');
      } catch {
        unsubscribe(res);
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  function close() {
    clearInterval(heartbeat);
    for (const res of subscribers) {
      try { res.end(); } catch { /* already gone */ }
    }
    subscribers.clear();
  }

  return { subscribe, unsubscribe, publish, size, close };
}
