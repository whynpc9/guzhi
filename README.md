# Wengu（温故）

Wengu 是一个面向 Markdown wiki / llm-wiki 仓库的本地 RAG 基础设施 CLI。它把仓库里的 Markdown、frontmatter、链接关系和 chunk embedding 同步到一套可丢弃的派生索引中，让 agent 可以用结构化命令检索知识，而不是只依赖人工约定的阅读顺序和 `grep`。

核心边界很简单：Markdown 仓库永远是事实源，`.wengu/` 和外部数据库只是派生索引。删除索引后应该可以重新从仓库同步出来。

## 当前能力

- Markdown 文件发现、排除规则、frontmatter 宽容解析。
- 结构感知 chunking、doc-summary chunk、显式 link graph。
- `sync` 全量/增量同步、软删除、同步锁、journal。
- 可选 embedding 队列，支持 OpenAI-compatible `/v1/embeddings`。
- keyword-only 和 hybrid 检索，支持 RRF / Weighted RRF 融合，返回证据类型、tier、facet、可选 explain。
- `resolve` / `links` / `status` / `doctor` / `config show` 等 agent 友好的 CLI 命令。
- 存储后端：
  - `pglite`：默认本地 catalog。
  - `postgres`：PostgreSQL catalog。
  - `milvus`：Milvus 作为外部 chunk 向量索引，catalog 仍由 PGlite 或 PostgreSQL 承担。
- Docker smoke tests 覆盖 PostgreSQL 和 Milvus。

## 安装与开发

```sh
npm install
npm run build
```

开发期可以直接运行：

```sh
npm run dev -- --help
```

构建后 CLI 入口是：

```sh
node dist/cli.js --help
```

## 快速开始

在一个 Markdown wiki 仓库或希望为它维护索引的工作目录中初始化：

```sh
wengu --repo /path/to/wiki init
```

同步索引：

```sh
wengu sync
```

搜索：

```sh
wengu search "主要诊断选择" -k 5 --explain
```

查看状态：

```sh
wengu status
wengu doctor --check-embedding
wengu config show
```

所有命令都可以加 `--json`，供 agent 或脚本稳定消费：

```sh
wengu --json search "ICD-10 编码" -k 3
```

## 配置

Wengu 使用仓库根目录下的 `wengu.toml`。配置来源优先级为：

```text
内置默认值 < wengu.toml < WENGU_* 环境变量 < CLI flag
```

可以用 `wengu config show` 查看每个配置值的最终来源。

本 CLI 仓库中的 `wengu.toml` 用于本地测试，已被 `.gitignore` 忽略。公开发布只保留不含私有路径或内网地址的 `wengu.example.toml`：

```sh
cp wengu.example.toml wengu.toml
```

一个最小配置示例：

```toml
[repo]
root = "."
flavor = "auto"

[storage]
backend = "pglite"
data_dir = ".wengu/db"

[embedding]
provider = "none"

[search]
mode = "keyword"
```

OpenAI-compatible embedding 示例：

```toml
[embedding]
provider = "openai-compatible"
base_url = "http://127.0.0.1:8000/v1/embeddings"
model = "Qwen/Qwen3-Embedding-8B"
dimensions = 4096
batch_size = 64
request_dimensions = false
timeout_ms = 120000
```

如果 provider 需要 API key，可以通过环境变量提供：

```sh
export WENGU_EMBEDDING__API_KEY=...
```

### 搜索融合

`search.mode` 控制检索通道：`keyword`、`vector` 或 `hybrid`。`search.rank_fusion` 控制 hybrid 结果如何融合：

```toml
[search]
mode = "hybrid"
rank_fusion = "rrf"          # rrf | weighted_rrf
rrf_k = 60

[search.rrf_weights]
keyword = 1.0
vector = 1.0
```

默认 `rrf` 保持原有行为，keyword 和 vector 都按 `1 / (rrf_k + rank)` 计分。`weighted_rrf` 会在 RRF 分量外乘以权重：

```text
score = tier * (keyword_weight * keyword_rrf + vector_weight * vector_rrf)
```

例如希望向量召回更强时：

```toml
[search]
rank_fusion = "weighted_rrf"

[search.rrf_weights]
keyword = 0.8
vector = 1.4
```

## 存储后端

### PGlite

默认后端，适合单机、本地、零配置使用：

```toml
[storage]
backend = "pglite"
data_dir = ".wengu/db"
```

也可以用 flag 临时覆盖：

```sh
wengu --storage-backend pglite sync
```

### PostgreSQL

PostgreSQL 后端适合团队共享、较大仓库或希望把 catalog 放进长期服务的场景：

```toml
[storage]
backend = "postgres"
url = "postgres://wengu:wengu@localhost:55432/wengu"
```

命令行覆盖：

```sh
wengu --storage-backend postgres \
  --storage-url postgres://wengu:wengu@localhost:55432/wengu \
  sync
```

### Milvus

Milvus 只承担 chunk 向量索引；documents、chunks metadata、links、embedding cache、sync state 等 catalog 仍由 PGlite 或 PostgreSQL 负责。这样 `keyword`、`resolve`、`links`、`status` 等能力不会被绑定到向量库。

PGlite catalog + Milvus vector index：

```toml
[storage]
backend = "milvus"
data_dir = ".wengu/db"
catalog_backend = "pglite"
milvus_address = "localhost:19530"
milvus_collection = "wengu_chunks"

[embedding]
provider = "openai-compatible"
model = "Qwen/Qwen3-Embedding-8B"
dimensions = 4096
```

PostgreSQL catalog + Milvus vector index：

```toml
[storage]
backend = "milvus"
catalog_backend = "postgres"
url = "postgres://wengu:wengu@localhost:55432/wengu"
milvus_address = "localhost:19530"
milvus_collection = "wengu_chunks"
```

`storage.backend = "milvus"` 必须启用 embedding provider，因为 Milvus 后端没有 keyword-only 的意义；keyword 相关能力由 catalog 负责。

## CLI 命令

```sh
wengu init
wengu sync
wengu status
wengu config show
wengu search "<query>"
wengu resolve <slug-or-path>
wengu links <slug-or-path>
wengu doctor
wengu skill install
```

常用同步选项：

```sh
wengu sync --full
wengu sync --no-embed
wengu sync --retry-failed
wengu sync --dry-run
wengu sync --embed-limit 100
```

## 测试

常规测试：

```sh
npm run check
npm test
npm run build
```

Docker-backed PostgreSQL / Milvus smoke tests：

```sh
npm run test:docker
```

该命令会通过 `docker compose` 启动 PostgreSQL、etcd、MinIO 和 Milvus standalone，然后运行 `tests/docker.test.ts`。默认端口：

- PostgreSQL: `localhost:55432`
- Milvus: `localhost:19530`

## 设计原则

- 仓库是唯一事实源；数据库和向量库都是可重建的派生索引。
- 宽容消费 Markdown：坏 frontmatter、断链、未知字段不应阻断 ingest。
- keyword-only 是一等模式；embedding 是增强层。
- 同步应幂等，可中断后重跑。
- 检索结果要对 agent 诚实，显式暴露检索模式和命中证据。
- Wengu 不做 agent runtime、不做知识合成、不做自动写回 Markdown。

## 致谢与关联项目

Wengu 的开发计划吸收了若干 Markdown knowledge-base、agent memory 和检索系统的调研结论。下面这些项目、规范和技术对设计边界有直接影响：

- **Internal domain wiki corpus**：Wengu 的首个真实目标语料来自一个私有领域 wiki。它验证了 Wengu 需要处理手写 Markdown、YAML frontmatter、Obsidian 风格 wikilinks、来源脚注、OCR/转录页、评测语料排除、证据敏感检索等复杂形态。
- **llm-wiki / Hermes 风格 wiki**：提供了“Markdown + frontmatter 是事实源，agent 通过渐进式披露读取知识”的基本形态。Wengu 保留这个形态，只补充可丢弃的关键词/向量检索基础设施。
- **OKF SPEC v0.1（GoogleCloudPlatform/knowledge-catalog）**：影响了 Wengu 的宽容消费模型：未知字段、断链、缺少 index、frontmatter 不完整都不应直接拒绝语料。
- **GBrain（garrytan/gbrain）**：证明了“Markdown 仓库为 system of record，Postgres 为派生检索索引”的路线可行。Wengu 吸收了 content-hash 增量、hybrid 检索、tier boost、per-document pooling、doctor 修复提示和 embedding 配置漂移防御等经验；不吸收 daemon、dream cycle、实体图谱、合成层等重型 agent-brain 能力。
- **EverOS（EverMind-AI/EverOS）**：作为“Markdown 事实源 + 可丢弃派生索引”的独立实现，验证了 Wengu 的方向。Wengu 吸收了删除误判防御、失败队列闭环、错误分类、配置来源显示、原子写 journal、watch 模式双通道等工程教训；不吸收 Reflection/OME 写回 Markdown、强 schema frontmatter、常驻 HTTP daemon、LLM ingest、topic taxonomy 等与 Wengu 边界冲突的设计。
- **PGlite / PostgreSQL / Milvus**：当前后端路线来自计划中的三后端设计。PGlite 提供默认本地 catalog，PostgreSQL 提供共享 catalog，Milvus 只承担外部向量索引而不接管同步状态或链接关系。

这些 acknowledgement 不是依赖声明。Wengu 是独立 CLI；上述项目是路线验证、约束输入和工程经验来源。
