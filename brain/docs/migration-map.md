# Migration map: old vault to Open Brain layout

Done 2026-09-02. This records what changed when the brain was re-set-up in the
Open Brain (OB1) style, so nothing is a mystery later.

## What did NOT change

The content and the working folders. Every memory note, session, venture, and
raw capture stayed exactly where it was. `Claude Memory/` did not move (moving it
would break the junction chain that Claude reads memory through, which
`AGENTS.md` rule 4 forbids). `.obsidian/` did not move. The one-way flow
Inbox to Workbench to Outbox to Ventures is unchanged. The note format is
unchanged.

This was the "keep the live pipeline" choice. The migration added a search layer
and tidied the root; it did not reorganize the vault out from under you.

## What was added

- `engine/` - the local search index toolkit.
- `docs/` - this map, plus how search works and how to turn on semantic search.
- `skills/` - plain-text skill packs for agents.
- `README.md` - the Open Brain overview of the vault (the system doc that
  `brain_system_documentation.md` used to be).

## What moved to `_legacy-2026-09-02/`

The old top-level system docs, superseded by `AGENTS.md`, `README.md`, and
`docs/`:

- `brain_system_documentation.md` (its role is now `README.md` plus `AGENTS.md`)
- `brain-session-skill.md` (refreshed as `skills/brain-capture.md`)
- `Hermes Stack Install 2026-07-29 2004.md` (an old install log)
- `atd-seo-meta.zip`, `ai-tech-dad-child.zip` (old archives)

Nothing was deleted. If a legacy doc still has value, lift the useful part into a
proper note and link it; do not just un-archive the whole file.

## How notes map into the database

The index is built FROM the notes; it does not replace them. Each `.md` note
becomes one row in `notes`:

| Markdown | Database column |
|---|---|
| frontmatter `name` (or filename) | `slug` (stable identity) |
| frontmatter `title` / `name` | `title` |
| frontmatter `description` | `description` |
| frontmatter `type` or `metadata.type` | `type` (falls back to the folder's role) |
| frontmatter `tags` or `metadata.tags` | `tags` (and one row each in `note_tags`) |
| the body after the frontmatter | `body` |
| every `[[wikilink]]` in the body | one row in `links` |

`type` keeps the vault's existing vocabulary: `user`, `feedback`, `project`,
`reference` for memory notes, plus `session`, `venture`, and so on inferred from
the folder when a note does not declare one.

## The linking principle is preserved

Loose Zettelkasten, on purpose. A `[[wikilink]]` to a note that does not exist
yet is not a broken row; it is a marker that something is worth writing, and the
index reports those separately (`target_id` is NULL) rather than treating them as
errors. The indexer does not fragment notes or invent links. It reflects what you
wrote.
