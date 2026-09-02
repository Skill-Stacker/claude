# StickOS v3 / Scout: conventions for anyone (human or agent) working in this repo

StickOS is a voice-first personal assistant that runs from a USB stick for beginners. The full design is in the plan this repo was built from; the short version of the rules that bite is below. Read this before writing code, copy, or launcher scripts.

## Product rules
- Everything runs from the stick. Nothing is installed on the host. First run downloads what it needs; after that it works offline except for Gmail and Calendar.
- No accounts, no telemetry, no cloud AI keys, no Google Cloud project. Gmail is reached with a Google App Password over IMAP/SMTP. Calendar is read from the secret iCal address and written through a prefilled calendar.google.com link. Every outbound call this software makes is logged to the "What Scout just did" panel and badged "leaves this machine" in the UI.
- The assistant is named Scout. Plain words. Say "at home", never "your own house". Never claim GPT-4 class or any speed number that was not measured on real hardware.
- Writes (create event, send mail) require a code-built confirmation sentence and an explicit "yes" from the human in the next turn. Code reports success or failure; the model never does. There is no delete intent.

## Code rules
- Plain Node 22+ ESM. No TypeScript, no bundler, no build step for the app. Vanilla JS and CSS in the browser. Vendored npm packages only when a hand-written version would be materially worse (mail, ICS, dates, speech engines).
- Bind 127.0.0.1 only. Every mutating route and the mic WebSocket first frame require the per-launch token from `app/lib/security.js`. Same-origin CORS. Path containment on every file route. Port checks are real bind attempts, never "did something answer HTTP".
- The app server prefers port 47300 and walks to 47304 only on EADDRINUSE. llamafile walks 8080 to 8084 underneath, invisible to the browser.
- Every downloaded file is size-checked, sha256-checked, and (for GGUF) magic-byte-checked, before every spawn, not just after download. Downloads resume with Range and stage as `<name>.incomplete`.
- `node:sqlite` for the cache (no better-sqlite3, no FTS5). All calls go through `app/lib/db.js`.
- Dates are resolved in code (chrono-node against real "now" in the calendar's zone, luxon for arithmetic). The model never computes a date. Times and dates are turned into words before Kokoro sees them.
- Tool schemas for the model are flat: no `$ref`, no `pattern`, no nesting deeper than one object. llama.cpp fails open on those. Always validate returned arguments in code. llama.cpp's `tool_choice` is `{"type":"tool","name":"..."}`, not the OpenAI shape.
- Every request to the engine sends `chat_template_kwargs: {"enable_thinking": false}`.
- Tests use `node:test` (`npm test`). Headless browser checks live in `tools/smoke/` and use the preinstalled Chromium at `/opt/pw-browsers`.

## Writing rules (code comments, UI copy, README, commit messages)
- Never use an em dash (U+2014) anywhere. Use a comma, a period, or parentheses.
- Never put `<?` or `?>` in any file that ends up inside the installer page (the live page is served as PHP and will execute it). Never put `</script>` in a payload without escaping it as `<\/script>`.
- Keep spoken copy short. Spell out money and big numbers. Do not write "A I"; bare "AI" is pronounced correctly. A lone capital A reads as "uh".

## Launcher (cmd.exe and bash) traps, all measured on real machines
- Never `set` a variable and read it with `%VAR%` inside the same `( ... )` block; use `:subroutine` and `call`.
- `\"` is not an escape in cmd. `start "" "exe" "arg"` with a second quoted argument launches nothing and exits 0; write a helper `.cmd` to `tmp\` and start that.
- A trailing backslash before a closing quote escapes the quote.
- Call `%SystemRoot%\System32\timeout.exe` explicitly (GNU timeout can shadow it). `wmic` is gone on current Windows 11. `.ps1` files do not run under the default Restricted policy; use `powershell -NoProfile -Command` inline.
- `Start Button.bat` is CRLF. Everything else is LF.
- On macOS nothing executes off an exFAT stick. Copy binaries to `~/Library/Application Support/StickOS/bin`, verify, `chmod +x`, strip quarantine, spawn from there.
- A fake-capacity USB stick corrupts the start of files larger than about 512 MB with the right size and the wrong bytes. Re-verify every asset after all downloads finish.

## Layout
```
payload/            the small files the installer writes to the USB (launchers, README, settings)
app/server.js       the app server
app/lib/            server modules (security, net, downloads, engine, brain, intents, speech, google, db, profiles, memory, monitor, netlog, studio)
app/web/            the single-page UI (desktop shell, lamp, voice, chat, windows)
tools/              build-release, build-installer, smoke tests
tests/              node:test units and fixtures
```
Runtime-only, never committed: `bin/`, `models/`, `voices/`, `data/`, `sessions/`, `memory.md`, `state/`, `chats/`.
