---
name: brain-recall
description: Search the local index to recall what the vault already knows before answering or writing a new note
metadata:
  type: skill
  tags: [brain, search, memory, process]
---

# Brain recall

Use the local index to check what the vault already knows, instead of relying on
what happens to be loaded into context.

## When to use

- Before answering a question about Josh, a venture, the machine, or a past
  decision. Search first; do not guess from memory that may be stale.
- Before writing a new memory note. The vault's rule is update, do not
  duplicate. Search for an existing note that already covers the fact.
- When picking up a thread ("what did we decide about X"), to find the session
  or memory note that recorded it.

## How

From the vault root:

```
python engine/brainctl.py search "your query"
```

Narrow it when you know the shape of what you want:

```
python engine/brainctl.py search "upload" --type session
python engine/brainctl.py search "pricing" --tag ai-tech-dad
python engine/brainctl.py search "junction" --folder "Claude Memory"
```

Read the notes it points at (the `path` in each result) as the `.md` files; those
are canonical. The index is a finder, not the source of truth.

## Notes

- Keyword search is on now. Semantic search (`--semantic`) is available once the
  backend-later step has run; until then it will tell you so.
- If a search comes up empty and you believe the note exists, the index may be
  stale. Re-run `python engine/brainctl.py index` and search again.
- Wikilinks to notes that do not exist yet are surfaced by `stats` as things
  worth writing. That is a feature of the loose Zettelkasten style, not a list of
  errors to fix.
