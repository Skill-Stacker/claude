# StickOS v3 / Scout

A personal assistant that lives on a USB stick and talks. Hold a key, ask a question, hear the answer. It runs a small AI model on the computer in front of you, reads your Google Calendar and Gmail without a Google login screen (an App Password and a secret calendar link, set up once), and never needs an account, a subscription, or an install.

This repository is the source. The public installer page at aionastick.ai-tech-dad.com is generated from it.

## For people who just want to use it

Go to the installer page, put the small files on a USB stick, and double-click **Start Button**. The first run downloads about five gigabytes (the AI engine, the model, and the voices) and shows progress in your browser. After that it starts in seconds and works offline, except for mail and calendar.

## For people who want to read or change the code

- `payload/` holds the files the installer writes to the stick.
- `app/` is the Node app server and the browser page. No build step: `npm start` runs it from a normal folder for development.
- `tools/` builds the release zip and the installer page, and runs the headless smoke checks.
- `tests/` are `node --test` units.

Read `CLAUDE.md` first. It lists the rules and the traps that already bit us on real machines.

## What it does not do

It cannot help on a company-managed laptop that blocks USB software, and mail and calendar need a home-style network (most workplace networks block IMAP and SMTP on purpose). It cannot write a brand-new email to a spoken address; it replies to people who already emailed you, or to contacts you typed in. It never deletes anything.

## License

MIT. See `LICENSE`.
