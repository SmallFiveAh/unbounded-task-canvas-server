-- ============================================================================
-- 无限任务画布 · Cloudflare D1 初始 Schema
-- ----------------------------------------------------------------------------
-- 方言：SQLite（Cloudflare D1）
-- 约定：
--   · 主键一律 TEXT（UUIDv7 字符串），时间一律 INTEGER（Unix 毫秒，对应 JS Date.now()）
--   · 布尔量用 INTEGER 0/1 并带 CHECK
--   · 枚举用 TEXT + CHECK 白名单，取值与前端常量一一对应
--   · JSON 列用 TEXT 存储，全部带 json_valid() 约束（D1 里 json_extract 遇脏数据
--     会抛 error 9015，必须在写入时就拦住）
--   · D1 的外键约束恒为开启且不可 PRAGMA 关闭，因此所有引用都带显式删除策略
--
-- 注意：D1 单条 SQL 语句上限 100 KB、单次绑定参数上限 100 个、
--       单行/单值上限 2 MB —— 见 docs/cloud-auth-and-storage-design.md §4.6
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 用户
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id                TEXT    PRIMARY KEY,
  email             TEXT    NOT NULL,              -- 规范化：小写 + trim
  email_verified_at INTEGER,                       -- NULL = 未验证
  display_name      TEXT    NOT NULL DEFAULT '',
  avatar_url        TEXT,
  locale            TEXT    NOT NULL DEFAULT 'zh-CN',
  status            TEXT    NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'suspended', 'deleted')),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  last_login_at     INTEGER,
  deleted_at        INTEGER
);

-- 同邮箱只允许一个「未删除」账号；软删后邮箱可被重新注册
CREATE UNIQUE INDEX ux_users_email_live ON users (email) WHERE deleted_at IS NULL;
CREATE INDEX        ix_users_created    ON users (created_at);

-- ---------------------------------------------------------------------------
-- 2. 认证账号（一个用户可挂多种登录方式：邮箱密码 / GitHub / 未来更多）
-- ---------------------------------------------------------------------------
CREATE TABLE auth_identities (
  id                 TEXT    PRIMARY KEY,
  user_id            TEXT    NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider           TEXT    NOT NULL CHECK (provider IN ('email', 'github')),
  -- email   → 规范化邮箱
  -- github  → GitHub 数字 user id 的字符串形式（登录名可改，id 不会变）
  provider_user_id   TEXT    NOT NULL,
  provider_email     TEXT,                          -- 第三方返回的邮箱（可能为空/未验证）
  provider_username  TEXT,                          -- GitHub login / 邮箱登录方式标签
  password_hash      TEXT,                          -- 仅 provider='email'，PHC 格式字符串
  password_updated_at INTEGER,
  access_token_ct    BLOB,                          -- 可选：AES-GCM 密文，仅当需要调 GitHub API
  refresh_token_ct   BLOB,
  scopes             TEXT,
  linked_at          INTEGER NOT NULL,
  last_used_at       INTEGER,
  -- 第三方身份不得携带密码凭据
  CHECK (provider = 'email' OR password_hash IS NULL)
);

-- 同一身份全局唯一：GitHub id 与邮箱各自只对应一个账号
CREATE UNIQUE INDEX ux_identities_provider_uid ON auth_identities (provider, provider_user_id);
CREATE INDEX        ix_identities_user         ON auth_identities (user_id);
CREATE INDEX        ix_identities_email        ON auth_identities (provider_email)
                                                 WHERE provider_email IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. 会话（服务端只存 token 的 SHA-256，泄露库也拿不到可用凭证）
-- ---------------------------------------------------------------------------
CREATE TABLE sessions (
  id              TEXT    PRIMARY KEY,              -- sha256(token) 的 hex
  user_id         TEXT    NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  identity_id     TEXT    REFERENCES auth_identities (id) ON DELETE SET NULL,
  created_at      INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,                 -- 绝对过期（建议 30 天）
  idle_expires_at INTEGER NOT NULL,                 -- 滑动过期（建议 7 天无操作）
  user_agent      TEXT,
  ip_hash         TEXT,                             -- 不存明文 IP
  revoked_at      INTEGER
);

CREATE INDEX ix_sessions_user_live ON sessions (user_id, idle_expires_at);
CREATE INDEX ix_sessions_expiry    ON sessions (expires_at);

-- ---------------------------------------------------------------------------
-- 4. 邮箱令牌（验证邮箱 / 重置密码 / 魔法链接 / 换绑邮箱 共用一张表）
-- ---------------------------------------------------------------------------
CREATE TABLE email_tokens (
  id           TEXT    PRIMARY KEY,
  user_id      TEXT    REFERENCES users (id) ON DELETE CASCADE,  -- 注册未落库时可为 NULL
  email        TEXT    NOT NULL,
  purpose      TEXT    NOT NULL
                       CHECK (purpose IN ('verify_email', 'reset_password',
                                          'magic_login', 'change_email')),
  token_hash   TEXT    NOT NULL,                    -- sha256(token)
  expires_at   INTEGER NOT NULL,
  consumed_at  INTEGER,
  attempts     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  requested_ip_hash TEXT
);

CREATE UNIQUE INDEX ux_email_tokens_hash  ON email_tokens (token_hash);
CREATE INDEX        ix_email_tokens_email ON email_tokens (email, purpose, expires_at);
CREATE INDEX        ix_email_tokens_expiry ON email_tokens (expires_at);

-- ---------------------------------------------------------------------------
-- 5. 登录限流（按邮箱 / 按 IP 的滚动窗口计数，配合 Rate Limiting 绑定双保险）
-- ---------------------------------------------------------------------------
CREATE TABLE login_attempts (
  bucket       TEXT    NOT NULL,   -- 'email:<sha256>' | 'ip:<sha256>'
  window_start INTEGER NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);
CREATE INDEX ix_login_attempts_window ON login_attempts (window_start);

-- ---------------------------------------------------------------------------
-- 6. 任务（业务数据主表，取代 src/constants/tasks.js 里的硬编码 TASKS）
-- ---------------------------------------------------------------------------
CREATE TABLE tasks (
  id          TEXT    PRIMARY KEY,
  owner_id    TEXT    NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- 迁移前的本地 id（如 '1'…'6'）：保留旧 URL /canvas/1 的可达性
  legacy_id   TEXT,
  title       TEXT    NOT NULL DEFAULT '',
  category    TEXT    NOT NULL DEFAULT 'work'
                      CHECK (category IN ('work', 'personal', 'project')),
  status      TEXT    NOT NULL DEFAULT 'todo'
                      CHECK (status IN ('todo', 'doing', 'done')),
  progress    INTEGER NOT NULL DEFAULT 0
                      CHECK (progress BETWEEN 0 AND 100),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER
);

-- 供画布文档做复合外键（保证文档只能挂在本人的任务上）
CREATE UNIQUE INDEX ux_tasks_owner_id      ON tasks (owner_id, id);
-- 列表页主查询：某人的未删任务按更新倒序
CREATE INDEX        ix_tasks_owner_updated ON tasks (owner_id, updated_at DESC)
                                           WHERE deleted_at IS NULL;
CREATE INDEX        ix_tasks_owner_status  ON tasks (owner_id, status)
                                           WHERE deleted_at IS NULL;
-- 旧 id 在同一个账号内唯一
CREATE UNIQUE INDEX ux_tasks_owner_legacy  ON tasks (owner_id, legacy_id)
                                           WHERE legacy_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 7. 画布文档（一个任务一份；内容以 JSON 列存储，见设计文档 §4.5 的取舍说明）
-- ---------------------------------------------------------------------------
CREATE TABLE canvas_documents (
  task_id        TEXT    NOT NULL,
  owner_id       TEXT    NOT NULL,                  -- 防御性冗余：即使应用层写错也挂不到别人任务上
  schema_version INTEGER NOT NULL DEFAULT 1,        -- 对应本地 doc.version
  revision       INTEGER NOT NULL DEFAULT 1,        -- 乐观锁版本，每次写入 +1
  content_hash   TEXT    NOT NULL,                  -- 规范化后 JSON 的 sha256，用于「内容相同则跳过」
  nodes_json     TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(nodes_json)),
  edges_json     TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(edges_json)),
  tables_json    TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(tables_json)),
  view_json      TEXT             CHECK (view_json IS NULL OR json_valid(view_json)),
  node_count     INTEGER GENERATED ALWAYS AS (json_array_length(nodes_json))    STORED,
  table_count    INTEGER GENERATED ALWAYS AS (json_array_length(tables_json))   STORED,
  size_bytes     INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  updated_by_device TEXT,
  PRIMARY KEY (task_id),
  FOREIGN KEY (owner_id, task_id) REFERENCES tasks (owner_id, id) ON DELETE CASCADE
);

CREATE INDEX ix_canvas_docs_owner_updated ON canvas_documents (owner_id, updated_at DESC);

-- ---------------------------------------------------------------------------
-- 8. 画布历史版本（覆盖式冲突的「后悔药」，只保留最近 N 版）
-- ---------------------------------------------------------------------------
CREATE TABLE canvas_document_revisions (
  task_id      TEXT    NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  revision     INTEGER NOT NULL,
  nodes_json   TEXT    NOT NULL CHECK (json_valid(nodes_json)),
  edges_json   TEXT    NOT NULL CHECK (json_valid(edges_json)),
  tables_json  TEXT    NOT NULL CHECK (json_valid(tables_json)),
  view_json    TEXT             CHECK (view_json IS NULL OR json_valid(view_json)),
  reason       TEXT    NOT NULL DEFAULT 'overwrite'
                       CHECK (reason IN ('overwrite', 'conflict', 'migration', 'manual')),
  created_at   INTEGER NOT NULL,
  created_by_device TEXT,
  PRIMARY KEY (task_id, revision)
);

CREATE INDEX ix_canvas_revisions_created ON canvas_document_revisions (created_at);

-- ---------------------------------------------------------------------------
-- 9. 迁移批次（每次「本地导入云端」的记录，可审计、可回滚）
-- ---------------------------------------------------------------------------
CREATE TABLE import_batches (
  id             TEXT    PRIMARY KEY,
  user_id        TEXT    NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  source         TEXT    NOT NULL DEFAULT 'localStorage-v1',
  client_id      TEXT    NOT NULL,                  -- 设备指纹，区分是哪台机器导入的
  status         TEXT    NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'committed', 'rolled_back')),
  item_total     INTEGER NOT NULL DEFAULT 0,
  item_imported  INTEGER NOT NULL DEFAULT 0,
  item_skipped   INTEGER NOT NULL DEFAULT 0,
  started_at     INTEGER NOT NULL,
  finished_at    INTEGER
);

CREATE INDEX ix_import_batches_user ON import_batches (user_id, started_at DESC);

-- 逐条导入结果：迁移的「凭据」，也是幂等与回滚的依据
CREATE TABLE import_items (
  batch_id        TEXT    NOT NULL REFERENCES import_batches (id) ON DELETE CASCADE,
  local_key       TEXT    NOT NULL,                 -- 原 localStorage key
  task_id         TEXT    REFERENCES tasks (id) ON DELETE SET NULL,
  local_updated_at INTEGER NOT NULL,
  outcome         TEXT    NOT NULL
                          CHECK (outcome IN ('created', 'created_seed', 'updated',
                                             'skipped_equal', 'skipped_older',
                                             'conflict_kept_both', 'pulled')),
  note            TEXT,
  PRIMARY KEY (batch_id, local_key)
);

-- ---------------------------------------------------------------------------
-- 10. 本地 key ↔ 云端任务的绑定表（双模切换 + 迁移幂等的唯一权威）
-- ---------------------------------------------------------------------------
CREATE TABLE local_doc_links (
  user_id           TEXT    NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  local_key         TEXT    NOT NULL,               -- 'unbounded-canvas:doc:1'
  task_id           TEXT    NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  last_content_hash TEXT    NOT NULL,
  imported_revision INTEGER NOT NULL DEFAULT 1,
  imported_at       INTEGER NOT NULL,
  PRIMARY KEY (user_id, local_key)
);

CREATE INDEX ix_local_doc_links_task ON local_doc_links (task_id);

-- ---------------------------------------------------------------------------
-- 11. 用户偏好（取代散落在 localStorage 的界面状态）
-- ---------------------------------------------------------------------------
CREATE TABLE user_settings (
  user_id           TEXT    PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  theme             TEXT    NOT NULL DEFAULT 'system'
                            CHECK (theme IN ('light', 'dark', 'system')),
  last_task_id      TEXT,
  sidebar_collapsed INTEGER NOT NULL DEFAULT 0 CHECK (sidebar_collapsed IN (0, 1)),
  updated_at        INTEGER NOT NULL
);
