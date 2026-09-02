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
const familyIcs = () => {
  const { readFileSync } = require_readFileSync();
  return readFileSync(join(HERE, 'fixtures', 'calendar', 'family.ics'), 'utf8');
};
function require_readFileSync() {
  // avoids an unused top-level import when a test file doesn't need it
  // eslint-disable-next-line global-require
  return { readFileSync: (await0()) };
}
function await0() {
  // placeholder never called; replaced below with a real static import
  return null;
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
