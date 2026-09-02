"""Embeddings: the backend-later step that turns on semantic search.

Scaffold-now leaves this inert on purpose. Keyword search works with no
embeddings at all. When you are ready for search-by-meaning, point the config at
a LOCAL embedding server and run `python brainctl.py embed`; that fills the
`embedding` column note by note, and `brainctl.py search --semantic` lights up.

The default provider talks to an OpenAI-compatible `/v1/embeddings` endpoint
over plain stdlib HTTP, so it works with a local llama.cpp server or Ollama with
no pip install and nothing leaving the machine. Set the provider to "none"
(the default) and it stays off, explaining what to do rather than failing loudly
in normal use.

Nothing here calls a cloud service. That is deliberate: the vault's rule is that
memory does not leave the machine, so the only wired provider is a local one.
"""

import json
import os
import struct
import urllib.request


class NotConfigured(SystemExit):
    pass


def load_config():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "brain.config.json")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return {}


class LocalHTTPEmbeddingProvider:
    """OpenAI-compatible /v1/embeddings client (llama.cpp server, Ollama, etc.)."""

    def __init__(self, endpoint, model, api_key=""):
        self.endpoint = endpoint
        self.model = model
        self.api_key = api_key
        self.name = "local-http:%s" % model

    def embed(self, texts):
        payload = json.dumps({"model": self.model, "input": texts}).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = "Bearer %s" % self.api_key
        req = urllib.request.Request(self.endpoint, data=payload, headers=headers)
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        # OpenAI shape: {"data": [{"embedding": [...]}, ...]}
        return [item["embedding"] for item in data["data"]]


def get_provider(config=None):
    config = config or load_config()
    emb = config.get("embedding", {}) if isinstance(config, dict) else {}
    kind = (emb.get("provider") or "none").lower()
    if kind == "none":
        raise NotConfigured(
            "No embedding provider configured. Set embedding.provider in\n"
            "brain.config.json to 'local-http' and give it the endpoint/model of a\n"
            "local embedding server. See docs/backend-later.md."
        )
    if kind in ("local-http", "openai-compatible"):
        endpoint = emb.get("endpoint") or "http://127.0.0.1:8080/v1/embeddings"
        model = emb.get("model") or "nomic-embed-text"
        return LocalHTTPEmbeddingProvider(endpoint, model, emb.get("api_key", ""))
    raise NotConfigured("Unknown embedding provider: %s" % kind)


def pack_vector(vec):
    return struct.pack("<%df" % len(vec), *vec)


def embed_all(db_path, batch_size=16, verbose=True):
    import sqlite3

    provider = get_provider()
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT id, title, description, body FROM notes WHERE embedding IS NULL"
    ).fetchall()
    if verbose:
        print("Embedding %d notes with %s ..." % (len(rows), provider.name))

    done = 0
    for i in range(0, len(rows), batch_size):
        batch = rows[i:i + batch_size]
        texts = [
            ("%s\n%s\n%s" % (r["title"] or "", r["description"] or "", r["body"] or ""))[:8000]
            for r in batch
        ]
        vectors = provider.embed(texts)
        with conn:
            for r, vec in zip(batch, vectors):
                conn.execute(
                    "UPDATE notes SET embedding = ?, embedding_model = ? WHERE id = ?",
                    (pack_vector(vec), provider.name, r["id"]),
                )
        done += len(batch)
        if verbose:
            print("  %d/%d" % (done, len(rows)))
    conn.close()
    if verbose:
        print("Done. Semantic search is now available: brainctl.py search --semantic \"...\"")
    return done


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Fill note embeddings (backend-later step).")
    parser.add_argument("--db", required=True)
    parser.add_argument("--batch-size", type=int, default=16)
    args = parser.parse_args()
    embed_all(args.db, batch_size=args.batch_size)
