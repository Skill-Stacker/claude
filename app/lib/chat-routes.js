// Registers the chat and dispatch routes described in app/API.md: POST
// /api/chat (SSE), POST /api/confirm, POST /api/session/new, GET
// /api/session/memory, GET /api/brief, GET /api/reminders, POST
// /api/reminders/done. This file is the thin HTTP/SSE skin over brain.js;
// all of the actual dispatch logic lives there.
//
// Usage:
//   import { wireChat } from './lib/chat-routes.js';
//   wireChat(app, { db, llm, calendar, gmail, gmailSession, contacts, dates,
//     scrub, memory, profiles, lockManager, verifyPin, settings });

import { createBrain, resolveZone } from './brain.js';
import { buildBrief } from './brief.js';
import { listOpen, markDone } from './reminders.js';

const VALID_MODES = new Set(['scout', 'homework', 'message', 'summarize', 'study', 'story']);

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((h) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string')
    .map((h) => ({ role: h.role, content: h.content }));
}

export function wireChat(app, deps) {
  const { db, memory, profiles, settings } = deps;
  const brain = createBrain(deps);

  app.setStatus('brain', () => ({
    intents: brain.INTENTS.length,
    pendingConfirms: brain.confirmManager.size(),
  }));

  // -- POST /api/chat: SSE (intent, delta, source, confirm, done, error) ----
  app.addRoute('POST', '/api/chat', async (req, res, ctx) => {
    let body;
    try {
      body = await ctx.readJson();
    } catch {
      return ctx.sendJson(400, { error: 'invalid json' });
    }
    const profileId = body && body.profileId;
    const text = body && body.text;
    const mode = body && VALID_MODES.has(body.mode) ? body.mode : 'scout';
    const history = sanitizeHistory(body && body.history);

    if (profileId == null || !isNonEmptyString(text)) {
      return ctx.sendJson(400, { error: 'profileId and text are required' });
    }

    const sse = ctx.sseStart();
    const controller = new AbortController();
    const onClose = () => controller.abort();
    req.on('close', onClose);

    try {
      await brain.dispatch({
        profileId,
        text,
        mode,
        history,
        paths: ctx.paths,
        signal: controller.signal,
        onEvent: (type, data) => sse.send(type, data),
      });
    } catch (err) {
      if (!sse.closed) sse.send('error', { kind: 'internal', message: String((err && err.message) || err) });
    } finally {
      req.removeListener('close', onClose);
      sse.end();
    }
  });

  // -- POST /api/confirm ------------------------------------------------------
  app.addRoute('POST', '/api/confirm', async (req, res, ctx) => {
    let body;
    try {
      body = await ctx.readJson();
    } catch {
      return ctx.sendJson(400, { error: 'invalid json' });
    }
    const confirmId = body && body.confirmId;
    const answer = body && body.answer;
    const pin = body && body.pin;
    if (!isNonEmptyString(confirmId) || (answer !== 'yes' && answer !== 'no')) {
      return ctx.sendJson(400, { error: "confirmId and answer ('yes' or 'no') are required" });
    }
    const outcome = await brain.confirmManager.resolve({ confirmId, answer, pin });
    return ctx.sendJson(200, outcome);
  });

  // -- POST /api/session/new ---------------------------------------------------
  app.addRoute('POST', '/api/session/new', async (req, res, ctx) => {
    let body;
    try {
      body = await ctx.readJson();
    } catch {
      return ctx.sendJson(400, { error: 'invalid json' });
    }
    const profileId = body && body.profileId;
    if (profileId == null) return ctx.sendJson(400, { error: 'profileId is required' });

    const profile = profiles.getProfile(db, profileId);
    if (!profile) return ctx.sendJson(404, { error: 'profile not found' });

    let outcome;
    try {
      outcome = await brain.distillSession({ profileId, paths: ctx.paths });
    } catch (err) {
      return ctx.sendJson(500, { error: 'internal', message: String((err && err.message) || err) });
    }

    // Guarantees a new session file regardless of whether distill() itself
    // rotated one (it skips rotation when the prior session was too short
    // to summarize).
    const profileDirPath = profiles.profileDir(ctx.paths.profiles, profile);
    memory.startSession(profileDirPath);

    return ctx.sendJson(200, { ok: true, distilled: !!(outcome && outcome.distilled) });
  });

  // -- GET /api/session/memory --------------------------------------------------
  app.addRoute('GET', '/api/session/memory', async (req, res, ctx) => {
    const profileId = Number(ctx.query.get('profileId'));
    const profile = profiles.getProfile(db, profileId);
    if (!profile) return ctx.sendJson(404, { error: 'profile not found' });
    const profileDirPath = profiles.profileDir(ctx.paths.profiles, profile);
    return ctx.sendJson(200, { memory: memory.loadMemory(profileDirPath) });
  });

  // -- GET /api/brief ------------------------------------------------------------
  app.addRoute('GET', '/api/brief', async (req, res, ctx) => {
    const profileId = Number(ctx.query.get('profileId'));
    const profile = profiles.getProfile(db, profileId);
    if (!profile) return ctx.sendJson(404, { error: 'profile not found' });
    const zone = resolveZone(settings, profileId);
    const brief = buildBrief({ db, profileId, now: new Date(), zone });
    return ctx.sendJson(200, brief);
  });

  // -- GET /api/reminders / POST /api/reminders/done ------------------------------
  app.addRoute('GET', '/api/reminders', async (req, res, ctx) => {
    const profileId = Number(ctx.query.get('profileId'));
    return ctx.sendJson(200, { reminders: listOpen(db, profileId) });
  });

  app.addRoute('POST', '/api/reminders/done', async (req, res, ctx) => {
    let body;
    try {
      body = await ctx.readJson();
    } catch {
      return ctx.sendJson(400, { error: 'invalid json' });
    }
    const id = body && body.id;
    if (id == null) return ctx.sendJson(400, { error: 'id is required' });
    const reminder = markDone(db, id);
    if (!reminder) return ctx.sendJson(404, { error: 'reminder not found' });
    return ctx.sendJson(200, { ok: true, reminder });
  });

  return brain;
}
