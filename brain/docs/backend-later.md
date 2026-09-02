# Backend later: turning on semantic search

Scaffold now, backend later. The index and keyword search work today. Semantic
search (finding notes by meaning) is built but switched off, because it needs one
thing that is a deliberate later step: a local model that turns text into
vectors. This is the walkthrough for when you want it.

The whole point of doing it this way: you get search-by-meaning like an OB1
vector database, but the vectors are computed by a model running on your own
machine, so memory still never leaves it.

## What you need

A local embedding server that speaks the OpenAI `/v1/embeddings` shape. Two easy
options, both of which you already have the hardware for:

- **Ollama.** `ollama pull nomic-embed-text`, then Ollama serves an
  OpenAI-compatible endpoint at `http://localhost:11434/v1/embeddings`.
- **llama.cpp server.** Run `llama-server` with an embedding model in GGUF
  (for example a `nomic-embed-text` GGUF) and `--embeddings`; it serves
  `http://127.0.0.1:8080/v1/embeddings`.

Either one keeps everything local. No API key, no cloud.

## Steps

1. Start the local embedding server (see above) and note its URL and model name.

2. Edit `engine/brain.config.json`:

   ```json
   "embedding": {
     "provider": "local-http",
     "endpoint": "http://localhost:11434/v1/embeddings",
     "model": "nomic-embed-text",
     "api_key": ""
   }
   ```

   Use the endpoint and model that match your server. For llama.cpp the endpoint
   is usually `http://127.0.0.1:8080/v1/embeddings`.

3. Make sure the index is current, then fill the embeddings:

   ```
   python engine/brainctl.py index
   python engine/brainctl.py embed
   ```

   `embed` only fills notes that do not have a vector yet, so it is safe to
   re-run and it resumes where it left off.

4. Search by meaning:

   ```
   python engine/brainctl.py search "what did I decide about backups" --semantic
   ```

   `stats` will now show embedding coverage, and `--semantic` will rank notes by
   closeness in meaning.

## Keeping it fresh

When you edit a note and re-run `index`, that note's embedding is cleared (the
old vector no longer matches the new text). Running `embed` again refills just
the changed notes. A simple habit: `index` then `embed`, or schedule both.

## If you switch embedding models

Vectors from different models are not comparable. If you change the model, clear
the old vectors first so everything is re-embedded with the new one:

```sql
-- in ~/Brain-index/brain.db
UPDATE notes SET embedding = NULL, embedding_model = NULL;
```

then run `embed` again.

## Why there is no cloud option here

The vault's standing rule is that memory does not leave the machine. A hosted
embedding API would send every note's text to a third party, so the only wired
provider is a local one. If you ever decide to relax that, it is a one-file
change in `brain_embed.py`, but it should be a deliberate decision, not a
default.
