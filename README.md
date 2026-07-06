# Wengu

Wengu is a local CLI for building a derived retrieval index from Markdown wiki repositories.

The initial implementation focuses on the PGlite backend, tolerant Markdown/frontmatter parsing, keyword search, optional OpenAI-compatible embeddings, and commands that are useful to agents:

- `wengu init`
- `wengu sync`
- `wengu search`
- `wengu resolve`
- `wengu links`
- `wengu status`
- `wengu doctor`
- `wengu config show`

The repository is the source of truth. `.wengu/` is a disposable derived index.
