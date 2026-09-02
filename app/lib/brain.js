// The three-stage dispatch: Stage 0 (dates, in code), Stage 1 (intent
// classification, one small model call over a closed enum), Stage 2 (slot
// extraction, one model tool call, validated in code), Stage 3 (the
// deterministic action, then either a narrated model reply grounded in the
// code-computed data, a code-built sentence, or a confirmation). See
// CLAUDE.md's "Dispatch design" section for the exact contract this
// implements.
//
// createBrain(deps) is the whole surface chat-routes.js needs:
//
//   const brain = createBrain({ db, llm, calendar, gmail, gmailSession,
//     contacts, dates, scrub, memory, profiles, lockManager, verifyPin,
//     settings });
//   await brain.dispatch({ profileId, text, mode, history, paths, signal, onEvent });
//   await brain.distillSession({ profileId, paths });
//
// `onEvent(type, data)` is called for every SSE event this turn produces, in
// order: 'intent' (scout mode only), then any of 'delta' / 'source' /
// 'confirm' / 'error', ending with exactly one 'done'. chat-routes.js maps
// these straight onto the SSE stream described in API.md.

import { DateTime } from 'luxon';

import { INTENTS, registry, buildStage1SystemPrompt } from './intents/index.js';
import { validateSlots, toolDefFor, googleConnection, NOT_CONNECTED_TEXT, LOCKED_TEXT } from './intents/shared.js';
import { createConfirmManager } from './confirm.js';

const STAGE1_SYSTEM_PROMPT = buildStage1SystemPrompt();
const STAGE1_HISTORY_TURNS = 4; // last 2 exchanges, enough to read a bare "yes" or "send it"
const STAGE2_MAX_TOKENS = 300;
const NARRATION_MAX_TOKENS = 900;
const LENGTH_CUTOFF_TEXT = "Sorry, that got cut off. Want me to try again, or ask it a shorter way?";

const NARRATION_RULE =
  'Only state a calendar or email fact that appears in the data above. If you are not sure, say so instead of guessing. ' +
  'Answer in one or two short spoken sentences.';

const MODE_PROMPTS = {
  homework:
    "You help {{name}} with homework. Walk through the steps and explain the reasoning, rather than just handing over the final answer, unless {{name}} asks for that directly. Keep it encouraging and age appropriate. Plain words, unpack any jargon, never an em dash.",
  message:
    "You help {{name}} write a short message or note, the kind sent to a teacher or a friend. If it is not clear what it needs to say, ask first, then write a short, clear draft in {{name}}'s own voice. You do not send anything yourself, only draft the words.",
  summarize:
    "You summarize text {{name}} gives you into a few short, plain sentences, keeping the important facts and dropping the rest. If {{name}} has not given you anything to summarize yet, ask for it.",
  study:
    "You help {{name}} study by asking short quiz questions, one at a time, about the topic they name, checking the answer, and explaining briefly when they get one wrong. Keep it encouraging, plain words.",
  story:
    "You tell a short, original, age-appropriate story when {{name}} asks for one, a few paragraphs, with a clear beginning, middle and end. Nothing scary or violent.",
};

// ---------------------------------------------------------------------------
// Small pure helpers, exported for direct testing.
// ---------------------------------------------------------------------------

export function resolveZone(settings, profileId) {
  try {
    const z = settings && typeof settings.getZone === 'function' ? settings.getZone(profileId) : null;
    if (z) return z;
  } catch {
    // fall through to the machine zone
  }
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

// "Today is <weekday>, <spoken date>. The time is <spoken time> in <zone>."
// The one line every Stage 2/3 user message starts with; the model never
// computes a date, it only ever reads this line.
//
// dates.spokenDate() is deliberately not reused for the date half: it
// collapses a date equal to `now` to the word "today", which reads as
// nonsense in "Today is today, September second." This line needs the
// actual calendar date every time, so it is built directly from the
// reference moment's own fields instead. The time half has no such
// collapsing behavior, so spokenTime() is reused as-is.
export function buildDateLine(dates, now, zone) {
  const dt = now.setZone ? now.setZone(zone) : DateTime.fromJSDate(now, { zone });
  return `Today is ${dt.weekdayLong}, ${dt.monthLong} ${dt.day}, ${dt.year}. The time is ${dates.spokenTime(now, { zone })} in ${zone}.`;
}

// The cache-stable prefix: system (persona + memory, byte-identical until
// the next distillation) followed by this session's prior turns. A pure
// function of its inputs, so two calls with the same persona/memory/history
// produce byte-identical messages.
export function buildPrefixMessages({ memory, persona, memoryText, name, history }) {
  const system = memory.buildSystemPrompt({ persona, memory: memoryText, name });
  const messages = [{ role: 'system', content: system }];
  for (const turn of history || []) {
    if (turn && (turn.role === 'user' || turn.role === 'assistant') && typeof turn.content === 'string') {
      messages.push({ role: turn.role, content: turn.content });
    }
  }
  return messages;
}

export function buildStage1Messages(text, history) {
  const messages = [{ role: 'system', content: STAGE1_SYSTEM_PROMPT }];
  const recent = (history || []).slice(-STAGE1_HISTORY_TURNS);
  for (const turn of recent) {
    if (turn && (turn.role === 'user' || turn.role === 'assistant') && typeof turn.content === 'string') {
      messages.push({ role: turn.role, content: turn.content });
    }
  }
  messages.push({ role: 'user', content: text });
  return messages;
}

function stage2UserContent(dateLine, text) {
  return `${dateLine}\n\n${text}`;
}

function narrationUserContent(dateLine, data, text) {
  return `${dateLine}\n\nData:\n${data}\n\n${NARRATION_RULE}\n\nThe user asked: ${text}`;
}

// ---------------------------------------------------------------------------
// Per-profile session state: the last saved draft and the last message the
// session looked at, so draft_reply and send_confirmed know what they are
// acting on. Purely in-memory, one process, cleared on restart.
// ---------------------------------------------------------------------------

export function createSessionStore() {
  const state = new Map(); // profileId -> { lastDraftId, lastMessageId }

  function entry(profileId) {
    let e = state.get(profileId);
    if (!e) { e = { lastDraftId: null, lastMessageId: null }; state.set(profileId, e); }
    return e;
  }

  return {
    getLastDraft(profileId) { return entry(profileId).lastDraftId; },
    setLastDraft(profileId, draftId) { entry(profileId).lastDraftId = draftId; },
    getLastMessage(profileId) { return entry(profileId).lastMessageId; },
    setLastMessage(profileId, gmMsgid) { entry(profileId).lastMessageId = gmMsgid; },
    clear(profileId) { state.delete(profileId); },
  };
}

// ---------------------------------------------------------------------------
// createBrain
// ---------------------------------------------------------------------------

export function createBrain(deps) {
  const {
    db, llm, calendar, gmail, gmailSession, contacts, dates, scrub, memory, profiles,
    lockManager, verifyPin, settings, now: nowFn = () => new Date(),
  } = deps;

  const confirmManager = createConfirmManager({ db, gmail, gmailSession, verifyPin });
  const session = createSessionStore();

  function currentNow(zone) {
    const jsDate = typeof nowFn === 'function' ? nowFn() : new Date();
    return DateTime.fromJSDate(jsDate, { zone });
  }

  async function recordExchange(profileDirPath, text, assistantText) {
    try {
      memory.appendExchange(profileDirPath, { user: text, assistant: assistantText });
    } catch {
      // a memory-write failure must never break the reply already sent
    }
  }

  async function runPlainChat({ systemPrompt, history, text, emit, signal, profileDirPath, startedAt = Date.now() }) {
    const messages = [{ role: 'system', content: systemPrompt }];
    for (const turn of history || []) {
      if (turn && (turn.role === 'user' || turn.role === 'assistant') && typeof turn.content === 'string') {
        messages.push({ role: turn.role, content: turn.content });
      }
    }
    messages.push({ role: 'user', content: text });

    let full = '';
    const result = await llm.chat({
      messages,
      stream: true,
      maxTokens: NARRATION_MAX_TOKENS,
      signal,
      onDelta: (d) => {
        if (d.content) {
          full += d.content;
          emit('delta', { content: d.content });
        }
      },
    });

    if (result.finishReason === 'length' && !result.content) {
      full = LENGTH_CUTOFF_TEXT;
      emit('delta', { content: full });
    }

    emit('done', { finishReason: result.finishReason, elapsedMs: Date.now() - startedAt, tokens: result.usage ? result.usage.completion_tokens : null });
    if (profileDirPath) await recordExchange(profileDirPath, text, full);
  }

  async function dispatch({ profileId, text, mode = 'scout', history = [], paths, signal, onEvent = () => {} } = {}) {
    const emit = (type, data) => { try { onEvent(type, data); } catch { /* a bad listener must not break dispatch */ } };
    const startedAt = Date.now();

    const profile = profiles.getProfile(db, profileId);
    if (!profile) {
      emit('error', { kind: 'profile', message: 'Unknown profile.' });
      emit('done', { finishReason: 'error', elapsedMs: Date.now() - startedAt });
      return;
    }

    const zone = resolveZone(settings, profileId);
    const now = currentNow(zone);
    const dateLine = buildDateLine(dates, now, zone);

    const persona = memory.loadPersona();
    const profileDirPath = profiles.profileDir(paths.profiles, profile);
    const memoryText = memory.loadMemory(profileDirPath);

    // -- helper modes: plain chat, Stage 1 skipped entirely -----------------
    if (mode && mode !== 'scout') {
      const template = MODE_PROMPTS[mode] || MODE_PROMPTS.message;
      const systemPrompt = template.replaceAll('{{name}}', profile.name);
      try {
        await runPlainChat({ systemPrompt, history, text, emit, signal, profileDirPath, startedAt });
      } catch (err) {
        emit('error', { kind: 'engine', message: String((err && err.message) || err) });
        emit('done', { finishReason: 'error', elapsedMs: Date.now() - startedAt });
      }
      return;
    }

    try {
      // -- Stage 1: intent classification ------------------------------------
      const stage1Messages = buildStage1Messages(text, history);
      const intentKey = await llm.intent({ messages: stage1Messages, enumValues: INTENTS, signal });
      emit('intent', { intent: intentKey });

      const def = registry[intentKey] || registry.chat;

      // -- connectivity and lock gating ---------------------------------------
      if (def.google) {
        const connection = googleConnection(profiles, paths, profile);
        const connected = connection[def.google];
        if (!connected) {
          const answer = NOT_CONNECTED_TEXT[def.google];
          emit('delta', { content: answer });
          emit('done', { finishReason: 'stop', elapsedMs: Date.now() - startedAt });
          await recordExchange(profileDirPath, text, answer);
          return;
        }
        if (lockManager && lockManager.requiresPin && lockManager.requiresPin(profile, paths.profiles) && !lockManager.isUnlocked(profileId)) {
          emit('delta', { content: LOCKED_TEXT });
          emit('confirm', { confirmId: null, sentence: LOCKED_TEXT, action: 'unlock', details: { profileId } });
          emit('done', { finishReason: 'locked', elapsedMs: Date.now() - startedAt });
          await recordExchange(profileDirPath, text, LOCKED_TEXT);
          return;
        }
      }

      // -- chat: no snapshot, no tools, a normal streamed reply ----------------
      if (intentKey === 'chat') {
        const systemPrompt = memory.buildSystemPrompt({ persona, memory: memoryText, name: profile.name });
        await runPlainChat({
          systemPrompt,
          history,
          text: `${dateLine}\n\n${text}`,
          emit,
          signal,
          profileDirPath,
          startedAt,
        });
        return;
      }

      const prefixMessages = buildPrefixMessages({ memory, persona, memoryText, name: profile.name, history });

      // -- Stage 2: slot extraction --------------------------------------------
      let slots = {};
      if (def.needsSlots) {
        const stage2Messages = [...prefixMessages, { role: 'user', content: stage2UserContent(dateLine, text) }];
        const result = await llm.chat({
          messages: stage2Messages,
          tools: [toolDefFor(def)],
          toolChoice: def.key,
          maxTokens: STAGE2_MAX_TOKENS,
          temperature: 0,
          signal,
        });
        const call = result.toolCalls && result.toolCalls[0];
        const raw = call ? call.arguments : null;
        // Every intent module with slots defines its own validate() (trimming
        // and intent-specific checks); validateSlots from shared.js is only
        // the fallback for one that doesn't.
        const finalValidation = typeof def.validate === 'function' ? def.validate(raw || {}) : validateSlots(def.schema, raw || {});
        if (!finalValidation.ok) {
          const question = def.clarify || 'Could you say that a different way?';
          emit('delta', { content: question });
          emit('done', { finishReason: 'clarify', elapsedMs: Date.now() - startedAt });
          await recordExchange(profileDirPath, text, question);
          return;
        }
        slots = finalValidation.slots;
      }

      // -- Stage 3: the deterministic action -----------------------------------
      const ctx = {
        db, calendar, gmail, gmailSession, contacts, dates, scrub,
        profileId, profile, zone, now, slots, utterance: text, session,
      };
      const outcome = await def.run(ctx);

      if (outcome.type === 'clarify') {
        emit('delta', { content: outcome.question });
        emit('done', { finishReason: 'clarify', elapsedMs: Date.now() - startedAt });
        await recordExchange(profileDirPath, text, outcome.question);
        return;
      }

      if (outcome.type === 'say') {
        // Unlike 'narrate', the intent module already owns the whole final
        // sentence here (there is no model output to prefix ahead of), so
        // any "As of my last check..." wording is built into outcome.text
        // by the intent module itself (see shared.js's asOfPrefix), not
        // added again here.
        if (outcome.source) emit('source', outcome.source);
        emit('delta', { content: outcome.text });
        emit('done', { finishReason: 'stop', elapsedMs: Date.now() - startedAt });
        await recordExchange(profileDirPath, text, outcome.text);
        return;
      }

      if (outcome.type === 'confirm') {
        const confirmId = confirmManager.createPending(profileId, {
          action: outcome.action, details: outcome.details, sentence: outcome.sentence,
        });
        emit('confirm', { confirmId, sentence: outcome.sentence, action: outcome.action, details: outcome.details });
        emit('done', { finishReason: 'confirm', elapsedMs: Date.now() - startedAt });
        await recordExchange(profileDirPath, text, outcome.sentence);
        return;
      }

      if (outcome.type === 'narrate') {
        if (outcome.source) emit('source', outcome.source);
        let full = '';
        const calendarPrefix = outcome.source && outcome.source.kind === 'calendar' && outcome.source.asOf
          ? `As of my last check at ${dates.spokenTime(outcome.source.asOf, { zone })}, `
          : '';
        if (calendarPrefix) {
          full += calendarPrefix;
          emit('delta', { content: calendarPrefix });
        }

        const narrationMessages = [...prefixMessages, { role: 'user', content: narrationUserContent(dateLine, outcome.data, text) }];
        const result = await llm.chat({
          messages: narrationMessages,
          stream: true,
          maxTokens: NARRATION_MAX_TOKENS,
          signal,
          onDelta: (d) => {
            if (d.content) {
              full += d.content;
              emit('delta', { content: d.content });
            }
          },
        });

        if (result.finishReason === 'length' && !result.content) {
          emit('delta', { content: LENGTH_CUTOFF_TEXT });
          full += LENGTH_CUTOFF_TEXT;
        }

        emit('done', { finishReason: result.finishReason, elapsedMs: Date.now() - startedAt, tokens: result.usage ? result.usage.completion_tokens : null });
        await recordExchange(profileDirPath, text, full);
        return;
      }

      // Any other/unrecognized outcome shape: fail safe rather than silent.
      emit('error', { kind: 'internal', message: `intent ${def.key} returned an unknown result type` });
      emit('done', { finishReason: 'error', elapsedMs: Date.now() - startedAt });
    } catch (err) {
      if (err && err.name === 'AbortError') {
        emit('done', { finishReason: 'aborted', elapsedMs: Date.now() - startedAt });
        return;
      }
      emit('error', { kind: 'engine', message: String((err && err.message) || err) });
      emit('done', { finishReason: 'error', elapsedMs: Date.now() - startedAt });
    }
  }

  // POST /api/session/new: distill the current session into memory.md with a
  // model summarizer, start a new session file, and re-warm the cache prefix
  // (persona + fresh memory) so the next turn's first request is a cache hit.
  async function distillSession({ profileId, paths }) {
    const profile = profiles.getProfile(db, profileId);
    if (!profile) throw new Error('profile not found');
    const profileDirPath = profiles.profileDir(paths.profiles, profile);

    const summarize = async (transcript) => {
      const result = await llm.chat({
        messages: [
          { role: 'system', content: 'Summarize the conversation below into 3 to 8 short, factual bullet points, one per line starting with "- ". Only include facts actually said, nothing invented.' },
          { role: 'user', content: transcript },
        ],
        maxTokens: 400,
        temperature: 0,
      });
      return result.content;
    };

    const outcome = await memory.distill(profileDirPath, summarize);

    const persona = memory.loadPersona();
    const memoryText = memory.loadMemory(profileDirPath);
    const systemPrompt = memory.buildSystemPrompt({ persona, memory: memoryText, name: profile.name });
    try {
      await llm.warm([{ role: 'system', content: systemPrompt }]);
    } catch {
      // warming is an optimization, never a hard requirement
    }

    session.clear(profileId);
    return outcome;
  }

  return { dispatch, distillSession, confirmManager, session, INTENTS };
}
