// api.js: every call the page makes to the app server goes through here.
// Same origin, always. Every POST carries the per-launch token from
// window.STICKOS_TOKEN (see server.js serveIndex). GET routes need no
// token (they are Host and Origin guarded instead) but sending the header
// on GET too is harmless, so both helpers add it.

const TOKEN = (typeof window !== 'undefined' && window.STICKOS_TOKEN) || '';

function authHeaders(withBody) {
  const headers = { 'x-stickos-token': TOKEN };
  if (withBody) headers['Content-Type'] = 'application/json';
  return headers;
}

async function readJsonBody(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function requestError(res, body) {
  const message = (body && (body.message || body.error)) || `request failed (${res.status})`;
  const err = new Error(message);
  err.status = res.status;
  err.body = body;
  return err;
}

// GET a JSON endpoint. Throws on a non-2xx response; the thrown Error's
// .status and .body carry the server's status code and parsed body (if
// any) so a caller can show a specific message.
export async function getJson(path) {
  const res = await fetch(path, { headers: authHeaders(false), cache: 'no-store' });
  const body = await readJsonBody(res);
  if (!res.ok) throw requestError(res, body);
  return body;
}

// POST a JSON body, get a JSON reply back.
export async function postJson(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: authHeaders(true),
    body: JSON.stringify(body || {}),
  });
  const data = await readJsonBody(res);
  if (!res.ok) throw requestError(res, data);
  return data;
}

// ---------------------------------------------------------------------------
// Server-sent events
// ---------------------------------------------------------------------------

// GET routes that stream SSE (firstrun progress, and later ones) are plain
// EventSource: no body, no custom headers needed, and the browser handles
// reconnects on its own for these short-lived per-window subscriptions.
// `handlers` is a map of event type -> function(data, rawEvent); the two
// special keys `onopen` and `onerror` are wired to the EventSource's own
// open/error hooks. Returns { close() }.
export function sse(path, handlers = {}) {
  const source = new EventSource(path);
  for (const type of Object.keys(handlers)) {
    if (type === 'onopen' || type === 'onerror') continue;
    source.addEventListener(type, (event) => {
      handlers[type](parseEventData(event.data), event);
    });
  }
  if (handlers.onopen) source.addEventListener('open', handlers.onopen);
  if (handlers.onerror) source.onerror = handlers.onerror;
  return {
    close() {
      source.close();
    },
  };
}

function parseEventData(raw) {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// POST a JSON body and read the SSE reply the same request carries back
// (chat, tts). The browser's EventSource cannot POST, so this reads the
// response body as a stream and parses `event:`/`data:` blocks by hand.
// `handlers` maps event type -> function(data). Returns { abort() }; the
// caller's Stop button (or a barge-in) calls abort() to end the request.
export function postSse(path, body, handlers = {}) {
  const controller = new AbortController();

  function dispatch(type, raw) {
    const fn = handlers[type];
    if (!fn) return;
    fn(parseEventData(raw));
  }

  function parseBlock(block) {
    let type = 'message';
    const dataLines = [];
    for (const line of block.split('\n')) {
      const clean = line.endsWith('\r') ? line.slice(0, -1) : line;
      if (clean.startsWith(':')) continue; // comment / heartbeat
      if (clean.startsWith('event:')) type = clean.slice(6).trim();
      else if (clean.startsWith('data:')) dataLines.push(clean.slice(5).replace(/^ /, ''));
    }
    if (!dataLines.length) return;
    dispatch(type, dataLines.join('\n'));
  }

  (async () => {
    let res;
    try {
      res = await fetch(path, {
        method: 'POST',
        headers: authHeaders(true),
        body: JSON.stringify(body || {}),
        signal: controller.signal,
      });
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      if (handlers.onerror) handlers.onerror(err);
      return;
    }
    if (!res.ok || !res.body) {
      const parsed = await readJsonBody(res).catch(() => null);
      if (handlers.onerror) handlers.onerror(requestError(res, parsed));
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let split;
        while ((split = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          if (block.trim()) parseBlock(block);
        }
      }
      if (buffer.trim()) parseBlock(buffer);
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      if (handlers.onerror) handlers.onerror(err);
      return;
    }
    if (handlers.onclose) handlers.onclose();
  })();

  return {
    abort() {
      controller.abort();
    },
  };
}

// ---------------------------------------------------------------------------
// The shared /api/events stream
// ---------------------------------------------------------------------------

// One EventSource for the whole page, since every window that cares about
// live state (netlog, lock countdown, engine, sync, monitor) listens on the
// same bus. Reconnects with backoff 1s, 2s, 4s (capped), and forces a fresh
// connection when the tab comes back into view in case the browser dropped
// it while backgrounded.
function createEventsClient() {
  const listeners = new Map(); // type -> Set(fn)
  let source = null;
  let backoff = 1000;
  const MAX_BACKOFF = 4000;
  let reconnectTimer = null;
  let closed = false;

  function dispatchTo(type, data) {
    const set = listeners.get(type);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(data);
      } catch (err) {
        console.error('stickos: event handler threw for', type, err);
      }
    }
  }

  function wireType(type) {
    if (!source) return;
    source.addEventListener(type, (event) => dispatchTo(type, parseEventData(event.data)));
  }

  function connect() {
    if (closed) return;
    source = new EventSource('/api/events');
    source.addEventListener('hello', () => {
      backoff = 1000;
    });
    source.onerror = () => {
      if (source) source.close();
      source = null;
      if (closed || reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF);
    };
    for (const type of listeners.keys()) wireType(type);
  }

  function on(type, fn) {
    let set = listeners.get(type);
    if (!set) {
      set = new Set();
      listeners.set(type, set);
      wireType(type);
    }
    set.add(fn);
    return () => off(type, fn);
  }

  function off(type, fn) {
    const set = listeners.get(type);
    if (set) set.delete(fn);
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (source && source.readyState !== EventSource.CLOSED) return;
      backoff = 1000;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      connect();
    });
  }

  connect();

  return {
    on,
    off,
    close() {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (source) source.close();
    },
  };
}

export const events = createEventsClient();
