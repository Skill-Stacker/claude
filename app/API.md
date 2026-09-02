# StickOS app server API (the contract between app/web and app/lib)

Everything is same-origin on `http://127.0.0.1:<port>` (47300 to 47304). The page gets the per-launch token as `window.STICKOS_TOKEN` (injected into index.html at serve time). Every POST sends header `x-stickos-token`. Every WebSocket sends `{ "token": "..." }` as its first text frame within 2 seconds. GET routes need no token but are Host and Origin guarded. Modules register routes through `app.addRoute(method, path, handler)` in their own files; `app/boot.js` wires them. Event pushes go through the SSE bus at `GET /api/events` as `event: <type>` with a JSON `data:` line.

## Core (app/server.js, done)
- `GET /` the page. `GET /api/status` `{ app, version, port, pid, uptime, engine, voice, downloads, profile }` where the last four are filled by modules through `app.setStatus(name, fn)`. `GET /api/events` SSE. `GET /api/netlog` `{ entries, description }`. `POST /api/echo`. `WS /ws/mic`.

## Boot and downloads (app/lib/downloads.js + app/lib/firstrun.js)
- `GET /api/firstrun` `{ phase: 'preflight'|'downloading'|'verifying'|'probing'|'starting'|'ready'|'blocked'|'failed', steps: [{ id: 'node'|'engine'|'model'|'tts'|'stt', label, state: 'pending'|'active'|'done'|'failed'|'skipped', received, total, percent, message }], free, needed, gpu: { available, detail }, message }`.
- `POST /api/firstrun/start` begins or resumes downloads; `POST /api/firstrun/retry` after a failure. SSE `firstrun` events carry the same shape as GET.
- SSE `engine` events: `{ state: 'starting'|'loading'|'ready'|'spawn_enoent'|'silent'|'crashed'|'failed'|'stopped', port, guidance, lastLog, gpu }`.

## Chat and dispatch (app/lib/brain.js + app/lib/intents/*.js)
- `POST /api/chat` body `{ profileId, text, mode: 'scout'|'homework'|'message'|'summarize'|'study'|'story', history: [{ role, content }], voice: boolean }`. Response is SSE on the same connection: `event: intent` `{ intent }` once routing is known; `event: delta` `{ content }` repeatedly; `event: source` `{ kind: 'calendar'|'inbox'|'reminders', asOf }` when facts came from a tool; `event: confirm` `{ confirmId, sentence, action: 'create_event'|'send_mail'|'set_reminder'|'open_link', details }` when a write needs a yes; `event: done` `{ finishReason, elapsedMs, tokens }`; `event: error` `{ kind, message }`. Any `Stop` aborts by closing the request.
- `POST /api/confirm` `{ confirmId, answer: 'yes'|'no', pin? }` performs the action in code and returns `{ ok, result, message, url? }` (url for the prefilled calendar link the page opens).
- `POST /api/session/new` `{ profileId }` distills memory and starts a new session. `GET /api/session/memory?profileId=` returns the memory text.

## Voice (app/lib/speech/*.js)
- `WS /ws/mic`: after the token frame, the client sends text `{ "type": "start", "sampleRate": 16000, "profileId": 1 }`, then binary PCM16 little-endian frames while the key is held, then text `{ "type": "stop" }`. The server replies with text frames `{ "type": "partial", "text" }` (when the STT engine streams), `{ "type": "final", "text", "ms" }`, `{ "type": "error", "message" }`. A `{ "type": "cancel" }` from the client discards the utterance.
- `POST /api/tts` `{ text, voice?, profileId }` returns SSE `event: chunk` `{ seq, wavBase64, text }` per sentence (first clause first), then `event: done`. Closing the request stops synthesis. `GET /api/voices` `{ voices: [{ id, label, grade }], default }`. `GET /api/stt/engines` `{ engines, current }`, `POST /api/stt/engine` `{ engine }`.
- The page handles barge-in by stopping playback locally when the mic is pressed and by closing any open `/api/tts` request.

## Profiles and lock (app/lib/profiles.js)
- `GET /api/profiles` `{ profiles: [{ id, name, kind, hasPin, googleConnected, unlockedUntil }] }`. `POST /api/profiles` `{ name }` creates. `POST /api/profiles/pin` `{ profileId, pin, newPin? }`. `POST /api/profiles/unlock` `{ profileId, pin }` returns `{ ok, unlockedUntil }` or `{ ok: false, lockedForSeconds }`. `POST /api/profiles/lock` `{ profileId }`. `POST /api/profiles/promote` `{ profileId, pin }`. SSE `lock` events `{ profileId, unlockedUntil }`.

## Google connect and data (app/lib/google/*.js)
- `GET /api/google/status?profileId=` `{ gmail: { connected, address, lastChecked, backfillComplete, error }, calendar: { connected, lastChecked, staleMinutes, error } }`.
- `POST /api/google/gmail/verify` `{ profileId, address, appPassword }` runs a real IMAP and SMTP login and returns `{ ok, folders }` or `{ ok: false, kind, message, question }`. `POST /api/google/gmail/save` stores the credentials (requires a PIN on the profile). `POST /api/google/gmail/disconnect`.
- `POST /api/google/calendar/verify` `{ profileId, icsUrl }` returns `{ ok, upcoming, calendarName }` or `{ ok: false, kind, message }`. `POST /api/google/calendar/save`, `POST /api/google/calendar/disconnect`.
- `POST /api/google/sync` `{ profileId, what: 'gmail'|'calendar'|'both' }` triggers a sync now; SSE `sync` events `{ what, phase, done, total, message }`.
- `GET /api/calendar/events?profileId=&from=&to=` `{ asOf, events }`. `GET /api/mail/threads?profileId=&limit=` `{ asOf, threads }`. `GET /api/mail/thread?profileId=&id=` `{ messages }`. `GET /api/brief?profileId=` `{ greeting, events, unread, reminders, asOf }`.
- `GET /api/contacts?profileId=`, `POST /api/contacts` `{ profileId, name, address }`, `POST /api/contacts/remove`.
- `GET /api/reminders?profileId=`, `POST /api/reminders/done` `{ id }`.

## Studio (later)
- `GET /api/monitor` `{ cpu, ram: { used, total }, disk: { free }, gpu: null | { name, util, vram } }` and SSE `monitor` every 2 s while the Monitor window is open (`POST /api/monitor/watch` `{ on }`).
- `GET /api/models`, `POST /api/models/download` `{ id }`, `POST /api/models/select` `{ id }` (restarts the engine).
- `POST /api/video/*` and `POST /api/images/*` are defined by their milestones.

## Conventions for handlers
- Handlers receive `(req, res, ctx)` with `ctx = { pathname, query (URLSearchParams), readJson(), sendJson(status, obj), sseStart() -> { send(type, data), end() }, token, bus, netlog, paths, db, origin }`.
- Never trust the model for success: every `result` and `message` in a response comes from code.
- Every outbound call goes through `netlog.record(...)` with a plain-language purpose.
