# Make an AI use the brain

Three ways an assistant can reach the vault, strongest first. You can use all
three at once; they reinforce each other.

1. **As tools it calls (MCP).** Register the MCP server below and the assistant
   gets `brain_search`, `brain_get`, `brain_sections`, `brain_index` as
   first-class tools. This is the real answer: the model calls a tool instead of
   having to know a shell command. Works in any MCP client (Claude Code, Claude
   Desktop, Cursor, Hermes Agent).
2. **As a shell command.** Any agent with a terminal (Hermes, Claude Code,
   Cursor) can run `python engine\brainctl.py search "query"` directly. No setup
   beyond building the index.
3. **From the instructions.** `AGENTS.md` (which agent harnesses read) and
   `Claude Memory/MEMORY.md` both now point at the index and tell the model to
   search before guessing.

## Prerequisite: build the index once

```
cd C:\Users\Big Daddy\Brain
python engine\brainctl.py index
```

Re-run it after notes change, or let an agent call the `brain_index` tool. The
database lands at `C:\Users\Big Daddy\Brain-index\brain.db`, outside the vault.

## The MCP server

`engine\brain_mcp.py`. Standard MCP over stdio, standard-library Python, no
dependencies, no network. It exposes:

| Tool | What it does |
|---|---|
| `brain_search` | Keyword search; args `query`, optional `section`, `type`, `tag`, `folder`, `limit`. Returns matches with their paths. |
| `brain_get` | Read a note's full markdown by vault path (path-contained to the vault). |
| `brain_sections` | List the section wikis (e.g. `local-ai-master`). |
| `brain_index` | Rebuild the index from the vault or a section. |

Every client uses the same server. Only the registration differs, and they all
share one JSON shape:

```json
{
  "mcpServers": {
    "brain": {
      "command": "python",
      "args": ["C:\\Users\\Big Daddy\\Brain\\engine\\brain_mcp.py"]
    }
  }
}
```

Use the full path to the `python` that has the vault's tools if `python` is not
on PATH (for Hermes that is its bundled Python, see below). Optional environment
overrides, handy inside a server config: `BRAIN_VAULT` (vault root) and
`BRAIN_DB` (main database path).

### Hermes Agent (your main one)

Hermes reads the vault and runs on a terminal, so it can use the brain three
ways, in order of how reliable each is right now:

1. **Shell command (works today, nothing to configure).** Tell Hermes it may run
   `python "C:\Users\Big Daddy\Brain\engine\brainctl.py" search "query"` (and
   `--section local-ai-master` for that wiki). Hermes provisioned its own Python,
   so if `python` is not the right one, use its interpreter:
   `C:\Users\Big Daddy\AppData\Local\hermes\hermes-agent\venv\Scripts\python.exe`.
2. **MCP tool.** Add the JSON block above to Hermes' MCP config (Hermes uses the
   same `mcpServers` shape as every other client). If Hermes exposes a command
   for it, `hermes mcp add brain -- python "C:\Users\Big Daddy\Brain\engine\brain_mcp.py"`;
   otherwise put the block in Hermes' config file (its config lives under
   `%LOCALAPPDATA%\hermes\`). Run `hermes setup` if you are unsure where.
3. **AGENTS.md.** Hermes already reads `AGENTS.md`, which now has a "search index
   and sections" section, so a fresh Hermes session is told the index exists and
   to search it.

Bonus: Hermes already runs Ollama at `127.0.0.1:11434`. That is exactly what
turns on semantic search. `ollama pull nomic-embed-text`, set
`embedding.provider` to `local-http` in `engine\brain.config.json` with endpoint
`http://127.0.0.1:11434/v1/embeddings`, then `python engine\brainctl.py embed`.
See `backend-later.md`.

### Claude Code

```
claude mcp add brain -- python "C:\Users\Big Daddy\Brain\engine\brain_mcp.py"
```

Or drop a `.mcp.json` with the JSON block at a project root. Claude Code already
reads the vault's `CLAUDE.md` / `AGENTS.md` too, so it knows about the CLI even
without the MCP server.

### Claude Desktop

Edit `%APPDATA%\Claude\claude_desktop_config.json`, add the JSON block, restart
Claude Desktop. The `brain` tools appear in the tool menu.

### Cursor

Add the JSON block to `%USERPROFILE%\.cursor\mcp.json` (global) or `.cursor\mcp.json`
in a project. Cursor lists the server under Settings > MCP.

## For terminal agents without MCP: allow the command

If you are relying on way 2 (the shell command) with Claude Code, add
`python engine\brainctl.py` to the allowlist so the search runs without a prompt
each time (the `permissions.allow` list in Claude Code settings). Then a session
that decides to recall just runs it.

## Test it

From a client, ask the assistant to "search my brain for X" and confirm it calls
`brain_search`. From a shell:

```
echo {"jsonrpc":"2.0","id":1,"method":"tools/list"} | python engine\brain_mcp.py
```

should print the four tool names.
