// Tests for the three-stage dispatch in app/lib/brain.js. No real model:
// stage-level wiring (grammar, tool schema, snapshot injection, prefix
// cache-stability) is verified against tools/fake-engine.mjs, the same
// pattern tests/llm.test.js uses; negative-path and call-count assertions
// (Stage 2 validation, "no model call between the tool call and confirm")
// use a small in-process stub llm instead, since those need exact control
// over what the model "returns" that a substring-matching fake server
// cannot give.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DateTime } from 'luxon';

import { openDb } from '../app/lib/db.js';
import { createLlm } from '../app/lib/llm.js';
import * as calendarLib from '../app/lib/google/calendar.js';
import * as gmailLib from '../app/lib/google/gmail.js';
import * as contactsLib from '../app/lib/google/contacts.js';
import * as dates from '../app/lib/dates.js';
import * as scrub from '../app/lib/speech/scrub.js';
import * as memory from '../app/lib/memory.js';
import * as profiles from '../app/lib/profiles.js';
import { INTENTS } from '../app/lib/intents/index.js';
import {
  createBrain, buildDateLine, buildPrefixMessages, buildStage1Messages,
  classifyIntent, resolveZone,
} from '../app/lib/brain.js';
import { scopedDb } from '../app/lib/intents/shared.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_ENGINE = join(HERE, '..', 'tools', 'fake-engine.mjs');
const ZONE = 'America/New_York';
const NOW_ISO = '2026-09-08T16:00:00.000Z'; // noon EDT, Tuesday: Dentist + Soccer practice day

// ---------------------------------------------------------------------------
// fake-engine harness (same shape as tests/llm.test.js)
// ---------------------------------------------------------------------------

function startFakeEngine({ port, loadMs = 30, tps = 300 } = {}) {
  const args = [FAKE_ENGINE, '--port', String(port), '--load-ms', String(loadMs), '--tps', String(tps)];
  const proc = nodeSpawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    async ready() {
      const deadline = Date.now() + 5000;
      for (;;) {
        try {
          const res = await fetch(`${baseUrl}/health`);
          if (res.status === 200 && (await res.json()).status === 'ok') return;
        } catch { /* not listening yet */ }
        if (Date.now() > deadline) throw new Error('fake-engine never became ready');
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    async stop() {
      proc.kill('SIGTERM');
      await new Promise((r) => proc.once('exit', r));
    },
    async requests() {
      return fetch(`${baseUrl}/__requests`).then((r) => r.json());
    },
  };
}

let nextPort = 8810; // clear of llm.test.js's 8710+ range and the real engine's 8080-8084

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const CAL_WINDOW = { fromUtc: '2026-09-01T00:00:00.000Z', toUtc: '2026-10-15T00:00:00.000Z' };
const familyIcs = readFileSync(join(HERE, 'fixtures', 'calendar', 'family.ics'), 'utf8');

// Writes through scopedDb, exactly as app/lib/google/sync.js does in the
// real app: calendar.js's lastChecked/staleness read a sync_state row with
// no profile_id column of its own (see shared.js's scopedDb comment), and
// brain.js reads that same key through the same per-profile prefix.
function seedCalendar(db, profileId, { nowUtc = '2026-09-08T10:00:00.000Z' } = {}) {
  const instances = calendarLib.parseAndExpand(familyIcs, { ...CAL_WINDOW, calendarName: 'Family' });
  calendarLib.syncCalendar(scopedDb(db, profileId), profileId, instances, { calendarName: 'Family', nowUtc });
}

function tmpProfilesDir() {
  return mkdtempSync(join(tmpdir(), 'stickos-brain-profiles-'));
}

function makeDeps(overrides = {}) {
  const db = openDb(':memory:');
  const profilesDir = tmpProfilesDir();
  const profile = profiles.createProfile(db, { name: 'Alex', kind: 'adult' });
  profiles.setPin(db, profile.id, '1234');
  profiles.ensureProfileDirs(profilesDir, profile);

  const lockManager = profiles.createLockManager({});
  const deps = {
    db,
    calendar: calendarLib,
    gmail: gmailLib,
    contacts: contactsLib,
    dates,
    scrub,
    memory,
    profiles,
    lockManager,
    gmailSession: async () => null,
    verifyPin: () => ({ ok: true }),
    settings: { zone: ZONE },
    now: () => new Date(NOW_ISO),
    paths: { profiles: profilesDir },
    ...overrides,
  };
  return { deps, db, profile, profilesDir, lockManager };
}

function connectGoogle(profilesDir, profile, { calendar = true, gmail = true } = {}) {
  const secrets = {};
  if (calendar) secrets.calendar = { icsUrl: 'https://calendar.google.com/calendar/ical/x/private-y/basic.ics' };
  if (gmail) secrets.gmail = { address: 'me@gmail.com', appPassword: 'xxxx xxxx xxxx xxxx' };
  profiles.writeSecrets(profilesDir, profile, secrets);
}

function collectEvents() {
  const events = [];
  const onEvent = (type, data) => events.push([type, data]);
  return { events, onEvent };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('pure helpers', () => {
  test('buildDateLine: the weekday and date are absolute, never "today"', () => {
    const now = DateTime.fromISO(NOW_ISO, { zone: ZONE });
    const line = buildDateLine(dates, now, ZONE);
    assert.equal(line, 'Today is Tuesday, September 8, 2026. The time is noon in America/New_York.');
  });

  test('buildPrefixMessages is a pure function: identical inputs give byte-identical output', () => {
    const args = {
      memory,
      persona: 'You are Scout, {{name}}\'s assistant.',
      memoryText: '## 2026-09-01\n- likes tea',
      name: 'Alex',
      history: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }],
    };
    const a = buildPrefixMessages(args);
    const b = buildPrefixMessages(args);
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    assert.equal(a[0].role, 'system');
    assert.match(a[0].content, /Alex/);
    assert.equal(a.length, 3);
  });

  test('buildPrefixMessages drops malformed history entries', () => {
    const args = {
      memory, persona: 'P {{name}}', memoryText: '', name: 'Alex',
      history: [{ role: 'user', content: 'ok' }, { role: 'system', content: 'nope' }, { content: 'no role' }, null, 'garbage'],
    };
    const messages = buildPrefixMessages(args);
    assert.equal(messages.length, 2); // system + the one valid user turn
  });

  test('resolveZone: settings.getZone(profileId) wins when present', () => {
    const settings = { getZone: (id) => (id === 7 ? 'Europe/Paris' : null) };
    assert.equal(resolveZone(settings, 7), 'Europe/Paris');
  });

  test('resolveZone: a flat settings.zone string is used when there is no getZone', () => {
    assert.equal(resolveZone({ zone: 'America/Chicago' }, 1), 'America/Chicago');
  });

  test('resolveZone: falls back to the machine zone when settings has neither', () => {
    const zone = resolveZone({}, 1);
    assert.equal(typeof zone, 'string');
    assert.ok(zone.length > 0);
  });

  test('buildStage1Messages: the system prompt lists every intent and ends with the utterance', () => {
    const messages = buildStage1Messages('what is on my calendar today', []);
    assert.equal(messages[0].role, 'system');
    for (const key of INTENTS) assert.match(messages[0].content, new RegExp(key));
    assert.deepEqual(messages[messages.length - 1], { role: 'user', content: 'what is on my calendar today' });
  });
});

// ---------------------------------------------------------------------------
// The llm.current() adapter (app/boot.js wires the engine's client in
// lazily, as { current() }, since it cannot exist before the engine starts)
// ---------------------------------------------------------------------------

describe('llm.current() adapter', () => {
  test('a lazy { current() } llm source is resolved and used normally', async () => {
    const { deps, profile } = makeDeps();
    const stubClient = {
      async intent() { return 'chat'; },
      async chat({ onDelta }) {
        if (onDelta) onDelta({ content: 'Hi there.' });
        return { content: 'Hi there.', finishReason: 'stop', toolCalls: [], usage: null };
      },
      async warm() { return null; },
    };
    const brain = createBrain({ ...deps, llm: { current: () => stubClient } });
    const { events, onEvent } = collectEvents();
    await brain.dispatch({ profileId: profile.id, text: 'hello', onEvent });
    assert.ok(events.some(([t, d]) => t === 'delta' && d.content === 'Hi there.'));
    assert.ok(events.some(([t, d]) => t === 'done' && d.finishReason === 'stop'));
  });

  test('current() returning null (engine still starting) answers plainly instead of crashing', async () => {
    const { deps, profile } = makeDeps();
    const brain = createBrain({ ...deps, llm: { current: () => null } });
    const { events, onEvent } = collectEvents();
    await brain.dispatch({ profileId: profile.id, text: 'hello', onEvent });
    assert.ok(events.some(([t, d]) => t === 'delta' && /warmed up/.test(d.content)));
    assert.ok(events.some(([t, d]) => t === 'done' && d.finishReason === 'not_ready'));
    assert.ok(!events.some(([t]) => t === 'error'));
  });
});

// ---------------------------------------------------------------------------
// Stage 1: intent classification, real grammar round-trip through
// fake-engine, one crafted case per enum value (the same "the value has to
// appear in the message" contract tests/llm.test.js's own intent() tests
// rely on; fake-engine cannot do real language understanding, so this is a
// plumbing check, not an NLU accuracy check).
// ---------------------------------------------------------------------------

describe('Stage 1: intent classification', () => {
  test('every value in the enum round-trips through the real grammar endpoint', async () => {
    const port = nextPort++;
    const fake = startFakeEngine({ port });
    try {
      await fake.ready();
      const llm = createLlm({ baseUrl: fake.baseUrl });
      for (const key of INTENTS) {
        // eslint-disable-next-line no-await-in-loop
        const result = await classifyIntent({ llm, text: key, history: [] });
        assert.equal(result, key);
      }
    } finally {
      await fake.stop();
    }
  });

  test('classifyIntent sends only the short Stage 1 system prompt, not the persona/memory prefix', async () => {
    const port = nextPort++;
    const fake = startFakeEngine({ port });
    try {
      await fake.ready();
      const llm = createLlm({ baseUrl: fake.baseUrl });
      await classifyIntent({ llm, text: 'chat', history: [] });
      const requests = await fake.requests();
      const last = requests[requests.length - 1];
      assert.match(last.body.grammar, /^root ::=/);
      assert.doesNotMatch(last.body.messages[0].content, /Scout/);
    } finally {
      await fake.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Stage 0 (dates, resolved in code) feeding the Stage 2 tool-call prompt,
// and snapshot injection happening only for the intents that actually
// produce one (inspecting fake-engine's /__requests, as the plan calls for).
// Also folds in the prefix-byte-identity check across two real turns.
// ---------------------------------------------------------------------------

describe('Stage 0 into Stage 2, and snapshot injection', () => {
  test('the Stage 2 tool-call prompt carries the code-built date line', async () => {
    const port = nextPort++;
    const fake = startFakeEngine({ port });
    try {
      await fake.ready();
      const { deps, profile, profilesDir } = makeDeps({ llm: createLlm({ baseUrl: fake.baseUrl }) });
      connectGoogle(profilesDir, profile);
      deps.lockManager.unlock(profile.id, 10);
      seedCalendar(deps.db, profile.id);
      const brain = createBrain(deps);
      const { onEvent } = collectEvents();

      await brain.dispatch({ profileId: profile.id, text: 'create_event please add something', onEvent });

      const requests = await fake.requests();
      const toolCallRequest = requests.find((r) => r.body && r.body.tool_choice && r.body.tool_choice.name === 'create_event');
      assert.ok(toolCallRequest, 'expected a Stage 2 tool-call request for create_event');
      const lastUser = toolCallRequest.body.messages[toolCallRequest.body.messages.length - 1].content;
      assert.match(lastUser, /^Today is \w+day, \w+ \d{1,2}, \d{4}\. The time is .+ in America\/New_York\.\n\n/);
      assert.deepEqual(toolCallRequest.body.tools[0].function.parameters, {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'a short title for the event' },
          when_text: { type: 'string', description: 'the day and time the user wants the event, in their own words' },
          location: { type: 'string', description: 'a location, empty string if none was mentioned' },
        },
        required: ['title', 'when_text'],
      });
    } finally {
      await fake.stop();
    }
  });

  test('a matched, data-bearing intent (today_agenda) gets a snapshot block; plain chat does not', async () => {
    const port = nextPort++;
    const fake = startFakeEngine({ port });
    try {
      await fake.ready();
      const { deps, profile, profilesDir } = makeDeps({ llm: createLlm({ baseUrl: fake.baseUrl }) });
      connectGoogle(profilesDir, profile);
      deps.lockManager.unlock(profile.id, 10);
      seedCalendar(deps.db, profile.id);
      const brain = createBrain(deps);

      await brain.dispatch({ profileId: profile.id, text: 'today_agenda', onEvent: () => {} });
      await brain.dispatch({ profileId: profile.id, text: 'chat', onEvent: () => {} });

      const requests = await fake.requests();
      const streamed = requests.filter((r) => r.body && r.body.stream === true);
      assert.equal(streamed.length, 2, 'expected exactly one streaming call per dispatch (today_agenda has no Stage 2 slots)');

      const [todayAgendaReq, chatReq] = streamed;
      const todayAgendaUser = todayAgendaReq.body.messages[todayAgendaReq.body.messages.length - 1].content;
      const chatUser = chatReq.body.messages[chatReq.body.messages.length - 1].content;

      assert.match(todayAgendaUser, /Data:/);
      assert.match(todayAgendaUser, /Dentist/);
      assert.doesNotMatch(chatUser, /Data:/);
    } finally {
      await fake.stop();
    }
  });

  test('prefix bytes (system + prior turns) are identical across two turns in the same session', async () => {
    const port = nextPort++;
    const fake = startFakeEngine({ port });
    try {
      await fake.ready();
      const { deps, profile, profilesDir } = makeDeps({ llm: createLlm({ baseUrl: fake.baseUrl }) });
      connectGoogle(profilesDir, profile);
      deps.lockManager.unlock(profile.id, 10);
      seedCalendar(deps.db, profile.id);
      const brain = createBrain(deps);

      await brain.dispatch({ profileId: profile.id, text: 'chat', history: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }], onEvent: () => {} });
      await brain.dispatch({ profileId: profile.id, text: 'chat', history: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }], onEvent: () => {} });

      const requests = await fake.requests();
      const streamed = requests.filter((r) => r.body && r.body.stream === true && !r.body.tools);
      assert.equal(streamed.length, 2);
      const [first, second] = streamed;
      // Every message except the last (the date line + utterance, which is
      // allowed to vary) must be byte-identical: that is the cached prefix.
      const prefixOf = (req) => req.body.messages.slice(0, -1);
      assert.equal(JSON.stringify(prefixOf(first)), JSON.stringify(prefixOf(second)));
      assert.equal(first.body.cache_prompt, true);
      assert.equal(first.body.id_slot, 0);
    } finally {
      await fake.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Stage 2 validation, and "no model call between the tool call and the
// confirm event". These need exact control over what the tool call
// "returns" (malformed, then well-formed), so a small stub llm stands in
// for the engine rather than fake-engine's substring-matching simulation.
// ---------------------------------------------------------------------------

describe('Stage 2 validation and the confirm event', () => {
  function makeStubLlm({ intentReply, toolArgs }) {
    const calls = [];
    return {
      calls,
      llm: {
        async intent() { return intentReply; },
        async chat(opts) {
          calls.push(opts);
          return {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [{ name: 'create_event', arguments: toolArgs }],
            usage: null,
          };
        },
        async warm() { return null; },
      },
    };
  }

  test('malformed tool arguments fall through to a targeted clarify, no confirm event', async () => {
    const { deps, profile, profilesDir } = makeDeps();
    connectGoogle(profilesDir, profile);
    deps.lockManager.unlock(profile.id, 10);
    const { llm, calls } = makeStubLlm({ intentReply: 'create_event', toolArgs: { title: '', when_text: '' } });
    const brain = createBrain({ ...deps, llm });
    const { events, onEvent } = collectEvents();

    await brain.dispatch({ profileId: profile.id, text: 'add something to my calendar', onEvent });

    assert.equal(calls.length, 1, 'only the Stage 2 tool call should have run');
    assert.ok(events.some(([t, d]) => t === 'delta' && d.content === 'What day and time should I put that on?'));
    assert.ok(events.some(([t, d]) => t === 'done' && d.finishReason === 'clarify'));
    assert.ok(!events.some(([t]) => t === 'confirm'));
  });

  test('valid tool arguments produce a confirm sentence built from those fields, with no model call in between', async () => {
    const { deps, profile, profilesDir } = makeDeps();
    connectGoogle(profilesDir, profile);
    deps.lockManager.unlock(profile.id, 10);
    const { llm, calls } = makeStubLlm({
      intentReply: 'create_event',
      toolArgs: { title: 'Team meeting', when_text: 'next Tuesday at 3', location: '' },
    });
    const brain = createBrain({ ...deps, llm });
    const { events, onEvent } = collectEvents();

    await brain.dispatch({ profileId: profile.id, text: 'add a team meeting next Tuesday at 3', onEvent });

    const confirmEvent = events.find(([t]) => t === 'confirm');
    assert.ok(confirmEvent, 'expected a confirm event');
    const [, data] = confirmEvent;
    assert.equal(data.action, 'create_event');
    assert.match(data.sentence, /Team meeting/);
    assert.match(data.sentence, /Should I go ahead/);
    assert.ok(data.confirmId);

    // Exactly one llm.chat call happened in this whole turn: the Stage 2
    // tool call itself. Building the confirmation sentence from the
    // validated fields, and emitting the confirm event, involved no further
    // call to the model.
    assert.equal(calls.length, 1);

    const doneEvent = events.find(([t]) => t === 'done');
    assert.equal(doneEvent[1].finishReason, 'confirm');
  });
});

// ---------------------------------------------------------------------------
// Connectivity and lock gating
// ---------------------------------------------------------------------------

describe('connectivity and lock gating', () => {
  function stubLlmFor(intentReply) {
    return {
      async intent() { return intentReply; },
      async chat() { return { content: 'unused', finishReason: 'stop', toolCalls: [], usage: null }; },
      async warm() { return null; },
    };
  }

  test('a calendar intent on a profile with no calendar connected answers plainly, no model call for the answer', async () => {
    const { deps, profile } = makeDeps({ llm: stubLlmFor('today_agenda') });
    const brain = createBrain(deps);
    const { events, onEvent } = collectEvents();

    await brain.dispatch({ profileId: profile.id, text: 'what is on my calendar today', onEvent });

    assert.ok(events.some(([t, d]) => t === 'delta' && /calendar connected yet/.test(d.content)));
    assert.ok(events.some(([t, d]) => t === 'done' && d.finishReason === 'stop'));
    assert.ok(!events.some(([t]) => t === 'confirm'));
  });

  test('a gmail intent on a profile with no gmail connected answers plainly', async () => {
    const { deps, profile } = makeDeps({ llm: stubLlmFor('unread_from') });
    const brain = createBrain(deps);
    const { events, onEvent } = collectEvents();

    await brain.dispatch({ profileId: profile.id, text: 'any unread mail from mom', onEvent });

    assert.ok(events.some(([t, d]) => t === 'delta' && /Gmail connected yet/.test(d.content)));
  });

  test('a connected but locked profile answers that Scout is locked and asks to unlock', async () => {
    const { deps, profile, profilesDir } = makeDeps({ llm: stubLlmFor('today_agenda') });
    connectGoogle(profilesDir, profile);
    // deliberately never unlocked
    const brain = createBrain(deps);
    const { events, onEvent } = collectEvents();

    await brain.dispatch({ profileId: profile.id, text: 'what is on my calendar today', onEvent });

    assert.ok(events.some(([t, d]) => t === 'delta' && /locked/.test(d.content)));
    const confirmEvent = events.find(([t]) => t === 'confirm');
    assert.ok(confirmEvent);
    assert.equal(confirmEvent[1].action, 'unlock');
    assert.ok(events.some(([t, d]) => t === 'done' && d.finishReason === 'locked'));
  });

  test('a local-only intent (set_reminder) needs no Google connection at all', async () => {
    const { deps, profile } = makeDeps({ llm: {
      async intent() { return 'set_reminder'; },
      async chat() {
        return { content: '', finishReason: 'tool_calls', toolCalls: [{ name: 'set_reminder', arguments: { text: 'call the plumber', when_text: '' } }], usage: null };
      },
      async warm() { return null; },
    } });
    const brain = createBrain(deps);
    const { events, onEvent } = collectEvents();

    await brain.dispatch({ profileId: profile.id, text: 'remind me to call the plumber', onEvent });

    const confirmEvent = events.find(([t]) => t === 'confirm');
    assert.ok(confirmEvent, 'set_reminder needs no Google connection to reach a confirm');
    assert.equal(confirmEvent[1].action, 'set_reminder');
  });
});
