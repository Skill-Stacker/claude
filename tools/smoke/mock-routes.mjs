// tools/smoke/mock-routes.mjs: fake handlers for every route app/web calls,
// so the page can be exercised end to end before the real modules behind
// each route exist. wireMocks(app) registers them with app.addRoute();
// run.mjs calls this right after startServer() and before the browser
// connects. Every response shape here matches app/API.md.

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildSilentWavBase64() {
  const sampleRate = 16000;
  const numSamples = 800; // 50 ms of silence
  const dataSize = numSamples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer.toString('base64');
}
const SILENT_WAV_BASE64 = buildSilentWavBase64();

export function wireMocks(app) {
  const { bus, netlog } = app;

  // -- profiles -------------------------------------------------------------

  const profiles = [];
  let nextProfileId = 1;

  app.addRoute('GET', '/api/profiles', (req, res, ctx) => {
    ctx.sendJson(200, { profiles });
  });
  app.addRoute('POST', '/api/profiles', async (req, res, ctx) => {
    const body = (await ctx.readJson()) || {};
    const profile = {
      id: nextProfileId++,
      name: String(body.name || 'Family').trim() || 'Family',
      kind: 'child',
      hasPin: false,
      googleConnected: false,
      unlockedUntil: null,
    };
    profiles.push(profile);
    ctx.sendJson(200, profile);
  });
  app.addRoute('POST', '/api/profiles/pin', async (req, res, ctx) => {
    const body = (await ctx.readJson()) || {};
    const profile = profiles.find((p) => p.id === body.profileId);
    if (!profile) return ctx.sendJson(404, { ok: false, message: 'No such profile.' });
    profile.hasPin = true;
    profile.unlockedUntil = new Date(Date.now() + 15 * 60000).toISOString();
    ctx.sendJson(200, { ok: true });
  });
  app.addRoute('POST', '/api/profiles/unlock', async (req, res, ctx) => {
    const body = (await ctx.readJson()) || {};
    const profile = profiles.find((p) => p.id === body.profileId);
    if (!profile) return ctx.sendJson(404, { ok: false, message: 'No such profile.' });
    if (!/^\d{4,8}$/.test(String(body.pin || ''))) {
      return ctx.sendJson(200, { ok: false, lockedForSeconds: 0 });
    }
    const unlockedUntil = new Date(Date.now() + 15 * 60000).toISOString();
    profile.unlockedUntil = unlockedUntil;
    bus.publish('lock', { profileId: profile.id, unlockedUntil });
    ctx.sendJson(200, { ok: true, unlockedUntil });
  });
  app.addRoute('POST', '/api/profiles/lock', async (req, res, ctx) => {
    const body = (await ctx.readJson()) || {};
    const profile = profiles.find((p) => p.id === body.profileId);
    if (profile) profile.unlockedUntil = null;
    bus.publish('lock', { profileId: body.profileId, unlockedUntil: null });
    ctx.sendJson(200, { ok: true });
  });
  app.addRoute('POST', '/api/profiles/promote', async (req, res, ctx) => {
    const body = (await ctx.readJson()) || {};
    const profile = profiles.find((p) => p.id === body.profileId);
    if (profile) profile.kind = 'adult';
    ctx.sendJson(200, { ok: true });
  });

  // -- firstrun and engine ----------------------------------------------------

  const firstrun = {
    phase: 'preflight',
    steps: [
      { id: 'node', label: 'Node runtime', state: 'pending', received: 0, total: 40000000, percent: 0 },
      { id: 'engine', label: 'Engine', state: 'pending', received: 0, total: 700000000, percent: 0 },
      { id: 'model', label: 'Language model', state: 'pending', received: 0, total: 3500000000, percent: 0 },
      { id: 'tts', label: 'Voice', state: 'pending', received: 0, total: 200000000, percent: 0 },
      { id: 'stt', label: 'Listening', state: 'pending', received: 0, total: 150000000, percent: 0 },
    ],
    free: 40000000000,
    needed: 5000000000,
    gpu: { available: true, detail: 'example graphics card' },
    message: '',
  };
  let firstrunStarted = false;

  async function runFirstrunSequence() {
    firstrun.phase = 'downloading';
    bus.publish('firstrun', firstrun);
    for (const step of firstrun.steps) {
      step.state = 'active';
      for (const p of [40, 100]) {
        step.percent = p;
        step.received = Math.round((p / 100) * step.total);
        bus.publish('firstrun', firstrun);
        await sleep(12);
      }
      step.state = 'done';
      bus.publish('firstrun', firstrun);
    }
    firstrun.phase = 'verifying';
    bus.publish('firstrun', firstrun);
    await sleep(40);
    firstrun.phase = 'ready';
    bus.publish('firstrun', firstrun);

    bus.publish('engine', { state: 'starting', port: app.port, guidance: null, lastLog: null, gpu: firstrun.gpu });
    await sleep(30);
    bus.publish('engine', { state: 'loading', port: app.port, guidance: null, lastLog: null, gpu: firstrun.gpu });
    await sleep(30);
    bus.publish('engine', { state: 'ready', port: app.port, guidance: null, lastLog: null, gpu: firstrun.gpu });
  }

  app.addRoute('GET', '/api/firstrun', (req, res, ctx) => {
    ctx.sendJson(200, firstrun);
  });
  app.addRoute('POST', '/api/firstrun/start', (req, res, ctx) => {
    if (!firstrunStarted) {
      firstrunStarted = true;
      runFirstrunSequence();
    }
    ctx.sendJson(200, firstrun);
  });
  app.addRoute('POST', '/api/firstrun/retry', (req, res, ctx) => {
    firstrunStarted = true;
    runFirstrunSequence();
    ctx.sendJson(200, firstrun);
  });

  // -- chat and confirm -------------------------------------------------------

  let nextConfirmId = 1;

  app.addRoute('POST', '/api/chat', async (req, res, ctx) => {
    const body = (await ctx.readJson()) || {};
    const sse = ctx.sseStart();
    const text = String(body.text || '');
    const reply = 'You said: ' + text;
    const words = reply.split(' ');
    const startedAt = Date.now();

    sse.send('intent', { intent: body.mode || 'scout' });
    await sleep(20);
    if (sse.closed) return;

    sse.send('source', { kind: 'calendar', asOf: new Date().toISOString() });

    for (const word of words) {
      if (sse.closed) return;
      sse.send('delta', { content: (word === words[0] ? '' : ' ') + word });
      await sleep(8);
    }

    const wantsConfirm = /add/i.test(text) && /calendar/i.test(text);
    if (wantsConfirm) {
      if (sse.closed) return;
      sse.send('confirm', {
        confirmId: 'confirm-' + nextConfirmId++,
        sentence: 'Add "' + text.replace(/^add\s+/i, '') + '" to your calendar?',
        action: 'create_event',
        details: { needsPin: false },
      });
    }

    if (sse.closed) return;
    sse.send('done', { finishReason: 'stop', elapsedMs: Date.now() - startedAt, tokens: words.length });
    sse.end();
  });

  app.addRoute('POST', '/api/confirm', async (req, res, ctx) => {
    const body = (await ctx.readJson()) || {};
    if (body.answer === 'yes') {
      ctx.sendJson(200, {
        ok: true,
        result: { id: 'evt-1' },
        message: 'Added to your calendar.',
        url: 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=Example',
      });
    } else {
      ctx.sendJson(200, { ok: true, result: null, message: 'Okay, not doing that.' });
    }
  });

  app.addRoute('POST', '/api/session/new', async (req, res, ctx) => {
    await ctx.readJson();
    ctx.sendJson(200, { ok: true });
  });
  app.addRoute('GET', '/api/session/memory', (req, res, ctx) => {
    ctx.sendJson(200, { memory: '' });
  });

  // -- brief ------------------------------------------------------------------

  app.addRoute('GET', '/api/brief', (req, res, ctx) => {
    const now = new Date();
    const later = new Date(now.getTime() + 3 * 3600000);
    ctx.sendJson(200, {
      greeting: 'Good day.',
      events: [{ title: 'Team sync', start: later.toISOString(), allDay: false }],
      unread: 2,
      reminders: [{ id: 1, text: 'Pick up the mail' }],
      asOf: now.toISOString(),
    });
  });

  // -- google connect and data --------------------------------------------

  app.addRoute('GET', '/api/google/status', (req, res, ctx) => {
    ctx.sendJson(200, {
      gmail: { connected: false, address: null, lastChecked: null, backfillComplete: false, error: null },
      calendar: { connected: false, lastChecked: null, staleMinutes: null, error: null },
    });
  });
  app.addRoute('POST', '/api/google/gmail/verify', async (req, res, ctx) => {
    const body = (await ctx.readJson()) || {};
    netlog.record({ kind: 'imap', host: 'imap.gmail.com', purpose: 'checked your Gmail sign-in', bytes: 512, ok: true });
    if (!body.appPassword || String(body.appPassword).length !== 16) {
      return ctx.sendJson(200, {
        ok: false,
        kind: 'auth',
        message: 'Gmail did not accept that app password.',
        question: 'Did you copy all 16 letters, with no spaces?',
      });
    }
    ctx.sendJson(200, { ok: true, folders: ['INBOX', 'Sent', 'Drafts'] });
  });
  app.addRoute('POST', '/api/google/gmail/save', async (req, res, ctx) => {
    await ctx.readJson();
    ctx.sendJson(200, { ok: true });
  });
  app.addRoute('POST', '/api/google/gmail/disconnect', async (req, res, ctx) => {
    await ctx.readJson();
    ctx.sendJson(200, { ok: true });
  });
  app.addRoute('POST', '/api/google/calendar/verify', async (req, res, ctx) => {
    const body = (await ctx.readJson()) || {};
    netlog.record({ kind: 'https', host: 'calendar.google.com', purpose: 'checked your calendar address', bytes: 2048, ok: true });
    if (!body.icsUrl) {
      return ctx.sendJson(200, { ok: false, kind: 'invalid', message: 'That did not look like a calendar address.' });
    }
    ctx.sendJson(200, { ok: true, upcoming: 5, calendarName: 'Family' });
  });
  app.addRoute('POST', '/api/google/calendar/save', async (req, res, ctx) => {
    await ctx.readJson();
    ctx.sendJson(200, { ok: true });
  });
  app.addRoute('POST', '/api/google/calendar/disconnect', async (req, res, ctx) => {
    await ctx.readJson();
    ctx.sendJson(200, { ok: true });
  });
  app.addRoute('POST', '/api/google/sync', async (req, res, ctx) => {
    const body = (await ctx.readJson()) || {};
    const what = body.what || 'both';
    ctx.sendJson(200, { ok: true });
    bus.publish('sync', { what, phase: 'start', done: 0, total: 1, message: 'Checking now' });
    await sleep(30);
    bus.publish('sync', { what, phase: 'done', done: 1, total: 1, message: 'Up to date.' });
  });

  app.addRoute('GET', '/api/calendar/events', (req, res, ctx) => {
    const now = new Date();
    const start = new Date(now.getTime() + 2 * 3600000);
    const end = new Date(start.getTime() + 3600000);
    ctx.sendJson(200, {
      asOf: now.toISOString(),
      events: [{ id: 'e1', title: 'Soccer practice', start: start.toISOString(), end: end.toISOString(), allDay: false, location: 'Field 3' }],
    });
  });

  app.addRoute('GET', '/api/mail/threads', (req, res, ctx) => {
    const now = new Date();
    ctx.sendJson(200, {
      asOf: now.toISOString(),
      threads: [{ id: 't1', subject: 'Welcome to Scout', from: 'family@example.com', date: now.toISOString(), unread: true, snippet: 'Hello' }],
    });
  });
  app.addRoute('GET', '/api/mail/thread', (req, res, ctx) => {
    const now = new Date();
    ctx.sendJson(200, {
      messages: [{ from: 'family@example.com', date: now.toISOString(), subject: 'Welcome to Scout', body: 'Hello there, glad you connected Gmail.' }],
    });
  });

  // -- contacts and reminders --------------------------------------------

  const contactsByProfile = new Map();
  let nextContactId = 1;
  function contactsFor(profileId) {
    if (!contactsByProfile.has(profileId)) contactsByProfile.set(profileId, []);
    return contactsByProfile.get(profileId);
  }
  app.addRoute('GET', '/api/contacts', (req, res, ctx) => {
    const profileId = Number(ctx.query.get('profileId'));
    ctx.sendJson(200, { contacts: contactsFor(profileId) });
  });
  app.addRoute('POST', '/api/contacts', async (req, res, ctx) => {
    const body = (await ctx.readJson()) || {};
    const contact = { id: nextContactId++, name: body.name, address: body.address };
    contactsFor(body.profileId).push(contact);
    ctx.sendJson(200, contact);
  });
  app.addRoute('POST', '/api/contacts/remove', async (req, res, ctx) => {
    const body = (await ctx.readJson()) || {};
    const list = contactsFor(body.profileId);
    const idx = list.findIndex((c) => c.id === body.id || c.address === body.address);
    if (idx !== -1) list.splice(idx, 1);
    ctx.sendJson(200, { ok: true });
  });

  app.addRoute('GET', '/api/reminders', (req, res, ctx) => {
    ctx.sendJson(200, { reminders: [] });
  });
  app.addRoute('POST', '/api/reminders/done', async (req, res, ctx) => {
    await ctx.readJson();
    ctx.sendJson(200, { ok: true });
  });

  // -- voice ------------------------------------------------------------------

  app.addRoute('GET', '/api/voices', (req, res, ctx) => {
    ctx.sendJson(200, {
      voices: [
        { id: 'kokoro-friendly', label: 'Friendly', grade: 'default' },
        { id: 'kokoro-calm', label: 'Calm', grade: 'soft' },
      ],
      default: 'kokoro-friendly',
    });
  });
  app.addRoute('GET', '/api/stt/engines', (req, res, ctx) => {
    ctx.sendJson(200, {
      engines: [
        { id: 'sherpa', label: 'Sherpa (default)' },
        { id: 'whisper', label: 'Whisper' },
      ],
      current: 'sherpa',
    });
  });
  app.addRoute('POST', '/api/stt/engine', async (req, res, ctx) => {
    const body = (await ctx.readJson()) || {};
    ctx.sendJson(200, { ok: true, current: body.engine });
  });
  app.addRoute('POST', '/api/tts', async (req, res, ctx) => {
    const body = (await ctx.readJson()) || {};
    const sse = ctx.sseStart();
    sse.send('chunk', { seq: 0, wavBase64: SILENT_WAV_BASE64, text: String(body.text || '') });
    if (sse.closed) return;
    sse.send('done', {});
    sse.end();
  });

  // -- studio -------------------------------------------------------------

  let monitorWatching = false;
  const monitorTimer = setInterval(() => {
    if (!monitorWatching) return;
    bus.publish('monitor', {
      cpu: 10 + Math.round(Math.random() * 10),
      ram: { used: 4200000000, total: 16000000000 },
      disk: { free: 118000000000 },
      gpu: null,
    });
  }, 2000);
  monitorTimer.unref();

  app.addRoute('GET', '/api/monitor', (req, res, ctx) => {
    ctx.sendJson(200, { cpu: 12, ram: { used: 4200000000, total: 16000000000 }, disk: { free: 118000000000 }, gpu: null });
  });
  app.addRoute('POST', '/api/monitor/watch', async (req, res, ctx) => {
    const body = (await ctx.readJson()) || {};
    monitorWatching = !!body.on;
    ctx.sendJson(200, { ok: true });
  });

  // -- a few netlog entries so "What Scout Just Did" has something to show

  netlog.record({ kind: 'https', host: 'calendar.google.com', purpose: 'checked your calendar', bytes: 4096, ok: true });
  netlog.record({ kind: 'imap', host: 'imap.gmail.com', purpose: 'checked your mail', bytes: 8192, ok: true });
  netlog.record({ kind: 'https', host: 'myaccount.google.com', purpose: 'checked your app password', bytes: 0, ok: false, detail: 'timed out' });
}
