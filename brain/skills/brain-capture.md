---
name: brain-capture
description: Capture a working session as a curated dated note in Sessions/, then refresh the index
metadata:
  type: skill
  tags: [brain, sessions, memory, process]
---

# Brain capture

Capture the current session as a dated note in `Sessions/`: a curated record of
decisions, reasoning, and open threads, not a transcript. Refreshed from the
vault's original session-capture skill and pointed at the new index.

## When to use

- End of a productive session, or before switching to unrelated work.
- When something was decided or discovered that a future session will need.

## What gets captured

Always: decisions and why, facts that cost time to find, verbatim quotes worth
keeping, open threads. Optionally: problems solved with the path, tools verified
working, dead ends. Never: chronological play-by-play, tool logs, invented
decisions, routine operations with no insight.

## File

`Sessions/YYYY-MM-DD <Descriptive Title>.md`, Title Case, dated when the work
happened (check file mtimes, do not trust injected dates in resumed sessions).
File in `Ventures/<name>/` instead only when the note is a primary source about
that venture.

Frontmatter:

```markdown
---
title: <Short title>
type: session
date: <YYYY-MM-DD>
tags: [session, <venture if any>, <topic>]
---
```

## Workflow

1. Check `Sessions/` for an existing note on this date/topic. Update rather than
   duplicate. Use `brainctl.py search "<topic>" --type session` to find it.
2. Draft the note following the structure above. Link to memory and venture hubs
   with `[[wikilinks]]` rather than copying their content.
3. Propose memory promotions. If the session revealed a durable fact, ask before
   writing it to `Claude Memory/`: "This session revealed X. Add it to Claude
   Memory as a [user/feedback/project/reference] note?" Never auto-write memory.
4. Save the note.
5. Refresh the index so the note is findable: `python engine/brainctl.py index`.
6. If the note is meant for Josh to read, render it (`tools\render-brain.cmd`)
   and hand him the HTML path, not the `.md`.

## Anti-patterns

- Capturing every minor interaction. Only sessions with substance.
- Writing "we discussed X" without capturing what was decided.
- Copying memory content into session notes instead of linking.
- Using today's date for a retroactive capture without checking mtimes.
