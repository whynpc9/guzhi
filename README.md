# Wengu

Wengu is a local CLI for building a derived retrieval index from Markdown wiki repositories.

The CLI supports a local PGlite catalog by default, PostgreSQL catalog storage, and a Milvus vector index with either PGlite or PostgreSQL as the metadata catalog. It includes tolerant Markdown/frontmatter parsing, keyword search, optional OpenAI-compatible embeddings, and commands that are useful to agents:

- `wengu init`
- `wengu sync`
- `wengu search`
- `wengu resolve`
- `wengu links`
- `wengu status`
- `wengu doctor`
- `wengu config show`

The repository is the source of truth. `.wengu/` is a disposable derived index.

Storage backends can be selected in `wengu.toml` or through global flags:

```sh
wengu --storage-backend pglite sync
wengu --storage-backend postgres --storage-url postgres://wengu:wengu@localhost:55432/wengu sync
wengu --storage-backend milvus --milvus-address localhost:19530 sync
```

Docker-backed PostgreSQL and Milvus smoke tests are available with:

```sh
npm run test:docker
```
