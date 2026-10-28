# 无限任务画布 · 认证与云端存储设计

> 状态：**设计稿（未实现）**
> 配套 DDL：[`docs/sql/0001_init.sql`](./sql/0001_init.sql)
> 目标：增加「邮箱登录 / GitHub 登录」两种认证；登录后数据落 Cloudflare D1，未登录继续走 localStorage；两者可平滑切换、可迁移、可回滚。

---

## 0. 先说最重要的一句

这次改造真正的难点**不是建表**，而是一个藏在代码里的架构事实：

> **画布数据的读取目前是同步的。**

`src/pages/CanvasPage.jsx:56` 用 `useMemo(() => loadCanvas(task))` 同步拿到初始文档，然后一次性喂给 `useCanvasDocument`。而云端读取必然是异步的。这意味着「换掉存储实现」这种做法不够——必须引入一次 **bootstrap（引导）阶段**：先确定任务与初始文档，再挂载画布。

设计上因此分两层：

| 层 | 职责 | 是否需要感知云端 |
| --- | --- | --- |
| **存储端口（Port）** | 统一 `listTasks / readDoc / writeDoc / subscribe` 四个动作，内部切换 local / cloud | 是 |
| **画布与列表组件** | 只消费端口，UI 逻辑零改动 | 否 |

有了这层，双模切换对 `useCanvasDocument`、`CanvasTable`、思维导图等 30+ 个组件完全透明。这是「平滑」的技术前提。

---

## 1. 现状勘察

### 1.1 数据流

```
                 ┌──────────────────────────────────────────┐
                 │ src/constants/tasks.js  TASKS（硬编码 6 条）│
                 └───────────────┬──────────────────────────┘
                                 │ buildCanvas() 生成种子
                                 ▼
  TaskListPage ──读──▶ loadCanvas(task) = readCanvas(taskId) ?? createSeedCanvas(task)
                                 │                            ▲
  CanvasPage ──读────────────────┘                            │
       │                                                      │
       └──写──▶ createSaver(120ms 节流) ──▶ writeCanvas ──▶ localStorage
                                                             key: unbounded-canvas:doc:<taskId>
                                                             │
                                              CustomEvent + storage 事件广播
                                                             ▼
                                            任务列表缩略图 / 其它标签页
```

### 1.2 现存持久化资产（迁移对象清单）

| localStorage key | 值结构 | 写入点 | 读取点 |
| --- | --- | --- | --- |
| `unbounded-canvas:doc:<taskId>` | `{ version, nodes[], edges[], tables[], view, updatedAt }` | `canvasStore/doc.js:44 writeCanvas` | `doc.js:23 readCanvas` → `loadCanvas` |
| 无（内存 Map 兜底） | 同上 | `doc.js:70` 配额超限时 | `doc.js:26` |
| 无（硬编码常量） | `TASKS[]` 任务元信息 | — | `TasksListPage.jsx:2`、`CanvasPage.jsx:53` |

### 1.3 现状约束（这些直接决定了表结构设计）

| # | 约束 | 出处 | 影响 |
| --- | --- | --- | --- |
| 1 | 读写是**同步** API | `canvasStore/doc.js` 全篇 | 不可直接替换成 fetch，需引入 bootstrap 态 |
| 2 | 存档按**整篇文档**读、整篇写 | `writeCanvas` 一次性序列化整份 doc | 决定了云端以「文档」为单位落库，而非逐节点行 |
| 3 | 写入以 **120ms 节流** | `constants.js:14 SAVE_DELAY` | 本地够用，直连云端会把 D1 单线程写爆，需分层节流 |
| 4 | 存档本身已有 `version` + 全量 `normalize` 容错 | `normalize.js` | 云端可存 `schema_version`，脏数据兜底逻辑不用重写 |
| 5 | 任务元信息是**常量**，没有「新建任务」流程 | `constants/tasks.js` | 迁移不仅要搬文档，还要把常量 TASKS 变成表行 |

### 1.4 现有文档的数据形状（迁移映射的依据）

```js
// 节点（note / card / list-card / mind 四种形态共用一张表，靠 kind 区分）
{ id, x, y, w, h, minH, contentH, kind, text,
  title?,                    // card、list-card
  items?: [{ text, done }],  // list-card
  parentId?, children?[], collapsed? }  // mind

// 连线
{ id, from, to, fromAnchor?: { rx, ry }, toAnchor?: { rx, ry } }

// 表格
{ id, x, y, rows, cols, cellW, cellH, headerH,
  colWidths: number[], rowHeights: number[], cells: string[rows][cols] }

// 视图
{ x, y, scale }   // scale ∈ [0.2, 5]
```

---

## 2. 目标架构

```
浏览器
  ├── 存储端口 src/data/port（local | hybrid | cloud）
  │      ├── localAdapter  ──▶ localStorage（现状实现，保留）
  │      └── cloudAdapter  ──▶ fetch /api/*
  │
  └── AuthProvider（会话、登录态、迁移引导）

Cloudflare
  ├── Worker（唯一写入通道：鉴权、校验、乐观锁、迁移编排）
  ├── D1（SQLite：users / auth_identities / sessions / tasks / canvas_documents …）
  └── 可选：R2（超大画布）、KV（限流与缓存）
```

| 选型 | 结论 | 理由 |
| --- | --- | --- |
| 计算 | Cloudflare Workers | 与 D1 同平台、免运维；Worker 内可完成 OAuth 换码与密码哈希 |
| 数据库 | **D1** | 用户指定；SQLite 方言，JSON1 函数可用，适合「读整份文档」的负载 |
| 不用 KV 存业务数据 | ✔ | KV 最终一致、无法按条件查询、无事务，做不了任务列表和乐观锁 |
| 不用 R2 存文档（首版） | ✔ | 单份画布 JSON 通常 < 200 KB，D1 单行上限 2 MB 够用；超限再下沉 R2 |
| 不用 Durable Object（首版） | ✔ | 单文档并行编辑才需要；当前无协作需求，用 `revision` 乐观锁即可 |
| Token 存储 | 不落地 | GitHub `access_token` 不用于业务查询，首版**不存**，避免额外的加密与合规负担 |

---

## 3. 认证设计

### 3.1 身份模型：把「用户」和「登录方式」拆开

这是整份设计的地基。`users` 只描述「人」，`auth_identities` 描述「他怎么证明自己是这个人」。

```
users 1 ──── N auth_identities      （一个账号可同时绑邮箱密码和 GitHub）
users 1 ──── N sessions             （多设备登录）
users 1 ──── N tasks                （业务数据归属）
tasks 1 ──── 1 canvas_documents     （画布本体）
tasks 1 ──── N canvas_document_revisions
```

为什么不把 `github_id`、`password_hash` 直接放进 `users`：

| 反例 | 后果 |
| --- | --- |
| `users.github_id` + `users.password_hash` | 加第三种登录方式（微信/Passkey）就要加两列 + 改所有查询；「解绑邮箱」变成 `UPDATE users` 而非删一行 |
| 拆成 `auth_identities` | 新增 provider 只需扩 CHECK 白名单；解绑 = 删一行；天然支持「同一个人多种登录方式指向同一账号」 |

### 3.2 邮箱登录

采用 **邮箱 + 密码**，注册后强制验证邮箱；同时预留 `magic_login`（魔法链接）——因为它不增加表，只复用 `email_tokens`。若你更想要「无密码，只发登录链接」，把 `password_hash` 留空即可，表结构无需改动。

```
注册  POST /api/auth/register
      ├─ 规范化邮箱（小写+trim）→ 查 users(email) WHERE deleted_at IS NULL
      ├─ 密码校验（长度 ≥ 10，拒绝常见弱口令）
      ├─ PBKDF2-HMAC-SHA256，600k 次迭代，16B 随机盐
      │   hash 存为 PHC 字符串：pbkdf2-sha256$600000$<salt_b64>$<hash_b64>
      ├─ db.batch([ INSERT users, INSERT auth_identities, INSERT email_tokens ])
      └─ 发送验证邮件（Resend / MailChannels），链接带一次性 token

登录  POST /api/auth/login
      ├─ 限流（login_attempts：邮箱桶 + IP 桶）
      ├─ 取 identity → 常量时间比对 hash（防时序侧信道）
      ├─ 生成 32B 随机 token → sessions.id = sha256(token)
      └─ Set-Cookie: __Host-session（HttpOnly, Secure, SameSite=Lax, Path=/）

重置  POST /api/auth/forgot-password → 一次性 token（15 分钟，单次消费）
```

**为什么用 PBKDF2 而不是 Argon2/bcrypt**：Workers 运行时只能用 WebCrypto，原生实现只有 PBKDF2。600k 次迭代在 Worker 内约百毫秒级（上线前请实测 CPU 时间，若超出套餐 CPU 上限降到 210k 并记录原因）。

**为什么 session 只存哈希**：D1 若泄露，攻击者拿到的是 `sha256(token)`，无法反推 cookie。这张表因此没有任何「可直接冒用」的凭据。

### 3.3 GitHub 登录

GitHub OAuth App **不支持 PKCE**（这一点常被误抄），所以安全边界靠三件事：`state` CSRF 防护、`client_secret` 只存在于 Worker、回调域名白名单。

```
① GET /api/auth/github/start
   ├─ state = 32B 随机（写 __Host-oauth_state cookie，10 分钟，单次）
   └─ 302 → github.com/login/oauth/authorize
            ?client_id=…&scope=read:user user:email&state=…

② GET /api/auth/github/callback?code&state
   ├─ 校验 state 与 cookie 一致（否则 400）
   ├─ POST github.com/login/oauth/access_token（服务端换码，带 client_secret）
   ├─ GET /user → id / login / name / avatar_url
   ├─ GET /user/emails → 取 primary && verified 的那条
   └─ 分支：见 3.4 绑定规则
```

必须申请 `user:email` 权限：GitHub 用户可把邮箱设为私有，不授权就拿不到主邮箱，会导致「同一个人的两种登录方式变成两个账号」。

### 3.4 账号绑定与合并规则（最容易出事故的地方）

| 场景 | 判定依据 | 处理 | 安全等级 |
| --- | --- | --- | --- |
| GitHub 身份已存在 | `auth_identities(provider='github', provider_user_id=id)` 命中 | 直接登录该 user | 高 |
| 身份不存在，但邮箱已有**已验证**账号 | GitHub 返回 primary+verified 邮箱 == `users.email` 且 `email_verified_at IS NOT NULL` | **自动绑定**新 identity 到该 user，写审计日志 | 中（可接受：Two trusted sources 都验证过同一邮箱） |
| 身份不存在，邮箱对应账号**未验证** | 同上但本地未验证 | 不自动绑定；要求先用邮箱登录一次，再在设置页手动绑定 | 高（防止抢注他人邮箱后接管） |
| 身份和邮箱都不存在 | — | 新建 user（`email_verified_at` 直接置为 GitHub 验证时间）+ identity | 高 |
| 已登录用户主动绑定 | `POST /api/auth/github/link` | 追加 identity，`UNIQUE(provider, provider_user_id)` 兜冲突 | 高 |
| 解绑 | `DELETE /api/auth/identities/:id` | 仅当该用户剩余 identity ≥ 1，否则 409 | 高 |

> 关键不变量：**`UNIQUE(provider, provider_user_id)`** 保证了「认错人」不可能双向发生；`users.email` 的「部分唯一索引 + 必须已验证」保证了「抢注」不成立。

### 3.5 会话与请求安全

| 项 | 方案 |
| --- | --- |
| Cookie | `__Host-session`，HttpOnly + Secure + SameSite=Lax + Path=/（`__Host-` 前缀强制 Secure 且禁 Domain，防子域覆盖） |
| 有效期 | 绝对 30 天（`expires_at`）+ 滑动 7 天（`idle_expires_at`，每 5 分钟最多刷新一次） |
| CSRF | SameSite=Lax 为主；所有非 GET 请求额外校验 `Origin`/`Referer` 同源 |
| 鉴权 | Worker 统一中间件解析 cookie → 查 sessions（带 `idle_expires_at > now AND revoked_at IS NULL`）→ 注入 `ctx.userId` |
| 越权 | **所有业务 SQL 必须带 `owner_id = ctx.userId`**，集中在一个 DAL（`src/server/db/*.js`），路由层不得拼 SQL |
| 限流 | Cloudflare Rate Limiting 绑定（IP）+ `login_attempts`（邮箱维度，15 分钟窗口，5 次锁定） |

### 3.6 接口清单

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/register` | 邮箱注册 |
| POST | `/api/auth/login` | 邮箱登录 |
| POST | `/api/auth/logout` | 撤销当前 session |
| GET | `/api/auth/session` | 当前会话（401 表示未登录） |
| POST | `/api/auth/verify-email` | 消费验证 token |
| POST | `/api/auth/resend-verification` | 重发（60s 冷却） |
| POST | `/api/auth/forgot-password` / `reset-password` | 重置密码 |
| GET | `/api/auth/github/start` / `callback` | OAuth 流程 |
| POST | `/api/auth/github/link` | 已登录绑定 |
| DELETE | `/api/auth/identities/:id` | 解绑（保留最后一种） |
| GET | `/api/me` | 用户资料 + 已绑身份 |
| GET | `/api/tasks` | 任务列表（`?category=&q=&cursor=`） |
| POST / PATCH / DELETE | `/api/tasks[/:id]` | 任务增改软删 |
| GET | `/api/tasks/:id/document` | 取画布（响应头 `ETag: "<revision>"`） |
| PUT | `/api/tasks/:id/document` | 存画布，必须带 `If-Match: "<revision>"` |
| POST | `/api/migrate/import` | 批量导入本地存档（幂等） |
| POST | `/api/migrate/rollback/:batchId` | 回滚某次导入 |

---

## 4. 数据表设计

### 4.1 关系总览

```
                    ┌──────────────┐
                    │    users     │◀──── 账号主体，业务数据的唯一归属者
                    └──┬───┬───┬───┘
        ┌──────────────┘   │   └──────────────┐
        │ 1:N              │ 1:N              │ 1:N
        ▼                  ▼                  ▼
┌────────────────┐  ┌────────────┐   ┌──────────────────┐
│auth_identities │  │  sessions  │   │      tasks       │
│ (邮箱/GitHub)  │  │ (多设备)    │   │  (业务主表)       │
└────────────────┘  └────────────┘   └──┬────────────┬──┘
                                        │ 1:1        │ 1:N
                                        ▼            ▼
                          ┌──────────────────┐  ┌───────────────────────────┐
                          │ canvas_documents │  │ canvas_document_revisions │
                          └──────────────────┘  └───────────────────────────┘

  users 1:N import_batches 1:N import_items ──N:1──▶ tasks
  users 1:N local_doc_links ──N:1──▶ tasks     （本地 key ↔ 云端任务的绑定）
  users 1:1 user_settings
  email_tokens / login_attempts 独立表，以 email 为业务键
```

### 4.2 表清单与职责

| 表 | 职责 | 关键约束 |
| --- | --- | --- |
| `users` | 账号主体 | `ux_users_email_live`：未删除用户邮箱唯一 |
| `auth_identities` | 登录方式（邮箱密码 / GitHub） | `ux_identities_provider_uid`：身份全局唯一 |
| `sessions` | 会话（存 token 哈希） | 主键即哈希，绝对+滑动双过期 |
| `email_tokens` | 验证 / 重置 / 魔法链接 | `ux_email_tokens_hash`：token 不可重放 |
| `login_attempts` | 登录限流计数 | `(bucket, window_start)` 主键 |
| `tasks` | 任务元信息（取代常量 TASKS） | `(owner_id, id)` 唯一，供文档复合外键 |
| `canvas_documents` | 画布本体（每任务一行） | `revision` 乐观锁 + `content_hash` |
| `canvas_document_revisions` | 覆盖写入的历史版本 | `(task_id, revision)` 主键 |
| `import_batches` / `import_items` | 迁移审计与回滚凭据 | `(batch_id, local_key)` 主键 ⇒ 幂等 |
| `local_doc_links` | 本地 key ↔ 云端任务绑定 | `(user_id, local_key)` 主键 ⇒ 不重复导入 |
| `user_settings` | 主题 / 上次任务 / 侧栏折叠 | 1:1 |

### 4.3 字段定义

#### users

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | TEXT | PK | UUIDv7（时间有序，索引友好） |
| `email` | TEXT | NOT NULL | 规范化小写主邮箱 |
| `email_verified_at` | INTEGER | NULL | Unix ms；NULL = 未验证 |
| `display_name` | TEXT | NOT NULL DEFAULT '' | 昵称，GitHub `name` 兜底 `login` |
| `avatar_url` | TEXT | NULL | GitHub 头像或首字母生成 |
| `locale` | TEXT | DEFAULT 'zh-CN' | 界面语言 |
| `status` | TEXT | CHECK(`active`/`suspended`/`deleted`) | 账号状态 |
| `created_at` / `updated_at` | INTEGER | NOT NULL | ms |
| `last_login_at` | INTEGER | NULL | 「最近登录」展示用 |
| `deleted_at` | INTEGER | NULL | 软删；配合部分唯一索引让邮箱可回收 |

#### auth_identities

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | TEXT | PK | UUIDv7 |
| `user_id` | TEXT | FK → users(id) ON DELETE CASCADE | 归属账号 |
| `provider` | TEXT | CHECK(`email`/`github`) | 登录方式 |
| `provider_user_id` | TEXT | NOT NULL | email：规范化邮箱；github：数字 id 字符串 |
| `provider_email` | TEXT | NULL | 第三方返回邮箱（可能为空） |
| `provider_username` | TEXT | NULL | GitHub login |
| `password_hash` | TEXT | NULL + CHECK(仅 email 可有) | PHC 字符串 |
| `password_updated_at` | INTEGER | NULL | 改密后撤销其它会话 |
| `access_token_ct` | BLOB | NULL | 可选，AES-GCM 密文；首版不用 |
| `refresh_token_ct` | BLOB | NULL | 同上 |
| `scopes` | TEXT | NULL | 已授权 scope |
| `linked_at` / `last_used_at` | INTEGER | — | 绑定时间 / 最近使用 |

#### sessions

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT PK | `sha256(token)` hex，**不存明文** |
| `user_id` | TEXT FK → users(id) CASCADE | 归属 |
| `identity_id` | TEXT FK → auth_identities(id) SET NULL | 本次会话由哪种方式建立（用于「撤销该方式全部会话」） |
| `created_at` / `last_seen_at` | INTEGER | 审计 |
| `expires_at` | INTEGER | 绝对过期（30 天） |
| `idle_expires_at` | INTEGER | 滑动过期（7 天） |
| `user_agent` / `ip_hash` | TEXT | 安全审计，IP 只存哈希 |
| `revoked_at` | INTEGER | 主动登出/改密撤销 |

#### tasks

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | TEXT | PK | UUIDv7，全局唯一（避免多用户都叫 `1` 撞车） |
| `owner_id` | TEXT | FK → users(id) CASCADE | **所有查询第一过滤条件** |
| `legacy_id` | TEXT | NULL | 迁移前的本地 id，保留 `/canvas/1` 旧链接可达 |
| `title` | TEXT | DEFAULT '' | 任务名 |
| `category` | TEXT | CHECK(`work`/`personal`/`project`) | 与 `CATEGORIES` 一致 |
| `status` | TEXT | CHECK(`todo`/`doing`/`done`) | 由中文标签映射而来（见 §6.4） |
| `progress` | INTEGER | CHECK 0–100 | 进度百分比 |
| `created_at` / `updated_at` | INTEGER | NOT NULL | 列表排序依据 |
| `deleted_at` | INTEGER | NULL | 软删（画布可恢复） |

> 现有常量里的 `thumbnail: 'canvas' | 'empty'` **不落库**：它本来就能由「有没有节点」派生，落库会产生两份真相。

#### canvas_documents

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `task_id` | TEXT | PK + 复合 FK (owner_id, task_id) → tasks(owner_id, id) CASCADE | 一任务一文档 |
| `owner_id` | TEXT | NOT NULL | 防御性冗余：应用层写错也挂不到别人任务上 |
| `schema_version` | INTEGER | DEFAULT 1 | 对应本地 `doc.version`，未来结构升级用 |
| `revision` | INTEGER | DEFAULT 1 | 每次成功写入 +1，乐观锁 |
| `content_hash` | TEXT | NOT NULL | 规范化 JSON 的 sha256；相同则跳过写入 |
| `nodes_json` | TEXT | CHECK json_valid | 节点数组 |
| `edges_json` | TEXT | CHECK json_valid | 连线数组 |
| `tables_json` | TEXT | CHECK json_valid | 表格数组 |
| `view_json` | TEXT | CHECK json_valid OR NULL | 视口 `{x,y,scale}` |
| `node_count` / `table_count` | INTEGER | GENERATED STORED | 由 JSON 派生，供列表与统计查询走索引 |
| `size_bytes` | INTEGER | DEFAULT 0 | 体积监控，逼近 2 MB 上限时告警 |
| `created_at` / `updated_at` | INTEGER | NOT NULL | — |
| `updated_by_device` | TEXT | NULL | 冲突排查用 |

#### 其余表

`email_tokens`、`login_attempts`、`canvas_document_revisions`、`import_batches`、`import_items`、`local_doc_links`、`user_settings` 的字段见 DDL 注释，核心点已在 §4.2 列出。

### 4.4 索引设计

| 索引 | 表(列) | 服务的查询 | 为什么需要 |
| --- | --- | --- | --- |
| `ux_users_email_live` | users(email) WHERE deleted_at IS NULL | 登录、注册查重 | 唯一性 + 点查；部分索引让软删账号释放邮箱 |
| `ix_users_created` | users(created_at) | 运营统计新增用户 | 避免全表扫 |
| `ux_identities_provider_uid` | auth_identities(provider, provider_user_id) | GitHub 登录定位账号 | **最关键的唯一性保障**，也顺带是查询索引 |
| `ix_identities_user` | auth_identities(user_id) | 「设置页列出我的登录方式」、级联删除 | 外键列必须有索引 |
| `ix_identities_email` | auth_identities(provider_email) | 排查「同一邮箱多身份」 | 非唯一，仅定位 |
| `ix_sessions_user_live` | sessions(user_id, idle_expires_at) | 「退出所有设备」、会话列表 | 复合索引直接覆盖过滤 |
| `ix_sessions_expiry` | sessions(expires_at) | 定时清理过期会话 | 范围扫描 |
| `ux_email_tokens_hash` | email_tokens(token_hash) | 消费 token（必须点查） | 唯一 + 防重放 |
| `ix_email_tokens_email` | email_tokens(email, purpose, expires_at) | 重发冷却、失效旧 token | 按邮箱+用途定位 |
| `ix_email_tokens_expiry` | email_tokens(expires_at) | 定时清理过期 token | 范围扫描 |
| `ix_login_attempts_window` | login_attempts(window_start) | 清理滑动窗口计数 | 范围删除，避免表膨胀 |
| `ux_tasks_owner_id` | tasks(owner_id, id) | 复合外键父键 | 支撑 `canvas_documents` 的复合 FK |
| `ix_tasks_owner_updated` | tasks(owner_id, updated_at DESC) WHERE deleted_at IS NULL | **任务列表主查询** | 直接命中排序，避免临时表排序 |
| `ix_tasks_owner_status` | tasks(owner_id, status) WHERE deleted_at IS NULL | 按状态筛选 | 低基数但过滤收益明显 |
| `ux_tasks_owner_legacy` | tasks(owner_id, legacy_id) WHERE legacy_id IS NOT NULL | 旧 URL 解析 | 唯一且只在迁移数据上生效 |
| PK `(task_id)` | canvas_documents | 打开画布 | 主键点查 |
| `ix_canvas_docs_owner_updated` | canvas_documents(owner_id, updated_at DESC) | 「最近编辑」、同步概览 | 避免 join 后再排序 |
| `ix_canvas_revisions_created` | canvas_document_revisions(created_at) | 清理旧版本 | 范围删除 |
| `ix_import_batches_user` | import_batches(user_id, started_at DESC) | 迁移历史列表 | — |
| `ix_local_doc_links_task` | local_doc_links(task_id) | 反查「这个任务来自哪个本地 key」 | 回滚时需要 |

> 注意 D1 的 `LIKE`/`GLOB` 模式串上限 50 字节 —— 任务标题搜索不要用 `LIKE '%长关键词%'`，要么客户端内存过滤（现状就是），要么上 FTS5。

### 4.5 为什么不把节点拆成行

| 方案 | 写入成本 | 读取成本 | 冲突粒度 | 适配现有代码 | 结论 |
| --- | --- | --- | --- | --- | --- |
| A. 全量 JSON 单列 | 1 次 UPDATE | 1 次 SELECT | 文档级 | 零改造（存档本来就是整篇） | 简单但单行可能触 2 MB 上限 |
| **B. 分集合 JSON 三列（推荐）** | 1 次 UPDATE | 1 次 SELECT | 文档级 | 极低 | ✅ 拆分降低单值体积；列表页只需 nodes+edges |
| C. nodes/edges/tables 三张明细表 | 每次保存需 diff 全量数组 → 增删改数十行，且要处理 100 参数/语句上限 | 3 次 SELECT + 组装 | 节点级 | 需重写读写层 + 前端 diff | 收益（节点级 SQL 查询）当前用不上 |

选 B 的补充理由：前端已有 `normalize.js` 做整篇校验，JSON 列能原样复用；D1 自带 JSON1，真要按节点查询可以 `json_each(nodes_json)` 或加 `STORED` 生成列，不必现在就付拆表的复杂度。**当出现「跨任务按节点内容搜索」或「协作编辑」需求时再拆**——这是可控的演进点，不是技术债。

### 4.6 平台限制 → 设计约束对照

| D1 限制 | 本设计的应对 |
| --- | --- |
| 单行/单值 ≤ 2 MB | `size_bytes` 监控；> 1.5 MB 时把 `tables_json` 下沉 R2，行内留指针 |
| 单条 SQL ≤ 100 KB | 迁移按**单任务一条 batch**，绝不做「把 100 个任务拼成一条 INSERT」 |
| 单次绑定参数 ≤ 100 | 每个 batch 最多 2 条语句（task + doc，约 20 个参数），安全 |
| 单库单线程、写串行 | 云端保存用 **1 s 防抖 + 空闲/离开时强制提交**，而不是沿用 120 ms |
| 外键恒开启、不可关闭 | 所有引用都写明确 `ON DELETE` 策略，删除顺序由 `batch()` 保证 |
| 无 BigInt（>2^53） | 时间戳用 ms 整数（约 1.7e12），安全 |
| 无实时推送 | 跨设备靠「窗口聚焦 / 可见性变化」时拉取 + `ETag` 比对 |

---

## 5. 本地 ↔ 云端 双模存储

### 5.1 状态机

```
                    ┌─────────────────────────────────────────┐
                    │              anon（未登录）              │
                    │  只读写 localStorage（现状行为，零变化）  │
                    └───────────────┬─────────────────────────┘
                        登录成功      │
                                    ▼
                    ┌─────────────────────────────────────────┐
                    │          bootstrapping（引导）           │
                    │ 拉 /api/auth/session → 决定模式          │
                    └───────────────┬─────────────────────────┘
                                    ▼
                    ┌─────────────────────────────────────────┐
                    │      migrating（仅当存在未导入本地数据）  │
                    │ 逐条导入 + 写 local_doc_links + 可回滚    │
                    └───────────────┬─────────────────────────┘
                     导入完成/用户跳过 │
                                    ▼
      ┌──────────────────────────────────────────────────────────┐
      │                        cloud（登录态）                     │
      │  读：云端为准，写穿本地缓存   写：本地立即写 + 队列上传      │
      └──────────┬───────────────────────────────────┬───────────┘
        断网/请求失败│                         登出（先 flush）│
                 ▼                                   ▼
      ┌────────────────────────┐            ┌──────────────────┐
      │ offline（云端数据缓存）  │            │  anon（本地数据） │
      │ 继续可编辑，队列待重放   │            └──────────────────┘
      └────────────────────────┘
```

要点：**任何状态下 UI 都可编辑**。本地缓存永远先写（保证零延迟与断网可用），云端是异步追赶的一方。这样「切换」不会产生加载失败或数据回退的窗口。

### 5.2 端口化改造

```js
// src/data/port.js —— 唯一对外契约
export const port = {
  mode: 'local' | 'cloud',
  listTasks(opts): Promise<Task[]>,
  readDoc(taskId): Promise<Doc>,                       // local 端 Promise.resolve 立即兑现
  writeDoc(taskId, doc, { baseRevision }): Promise<WriteResult>,
  removeTask(taskId): Promise<void>,
  subscribe(taskId, cb): () => void,                   // local 用事件；cloud 用轮询/聚焦拉取
}
```

`writeDoc` 的返回：

| 结果 | 含义 | 调用方动作 |
| --- | --- | --- |
| `{ ok: true, revision }` | 写入成功 | 更新本地记录的 revision |
| `{ ok: false, reason: 'conflict', server }` | `baseRevision` 已过期 | 进入 §5.3 合并流程 |
| `{ ok: false, reason: 'offline' }` | 网络失败 | 留在 outbox，提示「待同步」 |
| `{ ok: true, skipped: true }` | `content_hash` 相同 | 静默 |

### 5.3 一致性：乐观锁 + 三方合并

**乐观锁**（服务端，CAS 语义，无需显式事务）：

```sql
UPDATE canvas_documents
   SET nodes_json = ?, edges_json = ?, tables_json = ?, view_json = ?,
       content_hash = ?, revision = revision + 1,
       updated_at = ?, updated_by_device = ?
 WHERE task_id = ? AND owner_id = ? AND revision = ?   -- baseRevision
```

`changes === 1` 表示成功；`changes === 0` 表示版本已变 → 读当前行，写一条 `canvas_document_revisions(reason='conflict')`，返回 409 + 最新文档。

**三方合并**（客户端）：用「上次同步成功时的快照」作 base，比较 local 与 server 各自相对 base 的差异。

| 差异情况 | 处理 | 用户体验 |
| --- | --- | --- |
| 仅一方有改动 | 直接采用改动方 | 无感 |
| 双方改动、且**改动的元素 id 集合不相交** | 按 id 求并集自动合并（nodes / edges / tables 各自 merge） | 无感，仅提示「已合并另一台设备的改动」 |
| 双方改动、**同一元素 id** | 不自动决断，弹「此任务在另一处被修改」三选一：保留云端 / 保留本地 / 两者都留（云端版进 revisions） | 显式选择，绝不静默丢数据 |
| 一方删除元素、另一方修改同一元素 | 以「删除优先 + 备份」处理，把被删版本写进 revisions | 可恢复 |

> 为什么不直接 last-write-wins：画布的「最后一次保存」往往来自刚打开就误触的旧标签页，会静默吞掉另一台设备的半小时工作。宁可多一次弹窗。

### 5.4 离线队列（outbox）

| 项 | 设计 |
| --- | --- |
| 位置 | `unbounded-canvas:v2:outbox:<userId>`（按用户隔离，避免串号） |
| 结构 | `[{ mutationId, taskId, baseRevision, payload, queuedAt }]` |
| 合并 | 同一 `taskId` 只保留最新一条（payload 是全量文档，天然可覆盖） |
| 重放 | `online` 事件 / 页面可见 / 定时 30 s 尝试；成功后移除 |
| 幂等 | `mutationId` 仅用于本地去重；服务端靠 `revision` CAS 天然幂等（重复提交必然 409，再走合并 → 内容相同则 `content_hash` 命中直接跳过） |
| 登出保护 | 登出前 `flush()`；若失败，弹「有 N 处改动未同步，是否放弃？」——**默认不放弃** |

### 5.5 本地 key 命名空间（多账号隔离）

| 场景 | key | 说明 |
| --- | --- | --- |
| 匿名（现状，保持不变） | `unbounded-canvas:doc:<taskId>` | 老数据零迁移代价 |
| 登录态缓存 | `unbounded-canvas:v2:doc:<userId>:<taskId>` | 同一浏览器换账号不串数据 |
| 离线队列 | `unbounded-canvas:v2:outbox:<userId>` | — |
| 迁移提示标记 | `unbounded-canvas:v2:migrated:<userId>` | 仅 UI 用；**权威在服务端 `local_doc_links`** |
| 当前用户指针 | `unbounded-canvas:v2:active-user` | 启动时决定读哪套 key |

> 一条硬规则：**匿名数据永不「原地升级」为某个账号的数据**。登录后是「复制一份到云端 + 打上已导入标记」，原 key 保留（可回退），并在 UI 上标注「此画布已同步到账号，本地副本保留 7 天」。这样多账号共用一台机器时不会互相污染。

### 5.6 受影响的现有文件（改造面评估）

| 文件 | 现状 | 改动 |
| --- | --- | --- |
| `src/utils/canvasStore/doc.js` | 同步读写 localStorage | 抽成 `localAdapter`，保留现有导出做兼容层 |
| `src/utils/canvasStore/index.js` | 统一出口 | 增加 port 与异步版本导出 |
| `src/pages/CanvasPage.jsx:56` | `useMemo(() => loadCanvas(task))` 同步 | 改为 `useCanvasBootstrap(taskId)`：`loading / ready / notfound` 三态 |
| `src/pages/canvas/hooks/useCanvasPersistence.js` | `createSaver` → `writeCanvas` | saver 接收 port；云端模式 1 s 防抖；`flush` 返回 Promise |
| `src/hooks/useCanvasSnapshot.js` | 同步 `loadCanvas` | 异步 + 内存缓存，避免缩略图闪空 |
| `src/pages/TasksListPage.jsx:2` | 直接 import 常量 `TASKS` | 改为 `port.listTasks()`，补 loading / 空态 |
| `src/constants/tasks.js` | 数据源 | 降级为**种子生成器**（`buildSeedTasks()`），仅供迁移与开发 |
| `src/App.jsx` | 无路由、无会话 | 挂 `AuthProvider`；新增 `/login`、`/settings/account`、`/migrate` 视图 |

> 影响面判断：真正需要「动逻辑」的只有 4 个文件（CanvasPage、useCanvasPersistence、useCanvasSnapshot、TasksListPage），其余是适配。画布内部的 30+ 组件零改动——这是端口化的直接收益。

---

## 6. 数据迁移

### 6.1 迁移总览

```
① 登录成功
   └─▶ ② 扫描本地：枚举所有 prefix = 'unbounded-canvas:' 的 key
        （不能只遍历已知 TASKS —— 用户可能留下常量里没有的存档）
   └─▶ ③ 逐条决策（见 6.5 冲突矩阵），生成导入计划
   └─▶ ④ 用户确认（「发现 N 个本地画布，导入到账号？」导入 / 稍后 / 不再提示）
   └─▶ ⑤ 分批提交 POST /api/migrate/import（每批 ≤ 20 个任务，服务端 per-task batch）
        └─ 服务端在一个 import_batch 内：INSERT tasks + canvas_documents + local_doc_links
   └─▶ ⑥ 回写结果：本地打标记、记录 batchId；失败项保留在计划中可重试
```

### 6.2 key → 表映射

| 本地来源 | 云端落点 | 说明 |
| --- | --- | --- |
| `unbounded-canvas:doc:<taskId>` | `canvas_documents`（1 行） | 一份存档 = 一行文档 |
| 同上（若常量里也无此任务） | `tasks`（1 行） | 补建任务元信息，`title` 取首节点文本或「未命名任务」 |
| `constants/tasks.js` 的 `TASKS[]` | `tasks`（N 行） | 每个常量任务一行，`legacy_id` = 原 id |
| 内存 Map 兜底数据 | 不迁移 | 仅存在于会话内，刷新即失，无可迁移实体 |
| `thumbnail: 'canvas'|'empty'` | **不落库** | 由 `node_count` 派生 |
| 视口 `view` | `canvas_documents.view_json` | — |
| 无本地存档的任务 | `canvas_documents` 由 `buildCanvas()` 生成种子后写入 | 保证「打开即有内容」的体验不变 |

### 6.3 字段级映射

#### 任务（`TASKS[]` → `tasks`）

| 源字段 | 目标列 | 转换 |
| --- | --- | --- |
| `id`（'1'…'6'） | `legacy_id` | 原值保留 |
| — | `id` | 生成 UUIDv7（**不能沿用 '1'**：多用户的 `id` 会撞主键） |
| `title` | `title` | 直传 |
| `category` | `category` | 直传（已是 `work/personal/project`） |
| `status`（中文） | `status` | 查表转换，见 6.4 |
| `progress` | `progress` | 直传（0–100 整数） |
| `updatedAt`（`'2026-10-16'`） | `updated_at` | **字符串日期 → 毫秒时间戳**，按 `Asia/Shanghai` 当日 00:00 解释（否则跨时区会差一天） |
| `thumbnail` | — | 丢弃，派生 |
| `canvasElements` | — | 仅用于生成种子文档，不入库 |

#### 文档（`doc` → `canvas_documents`）

| 源字段 | 目标列 | 转换 |
| --- | --- | --- |
| `version` | `schema_version` | 直传（当前恒为 1） |
| `updatedAt` | `updated_at` | ms 直传 |
| `nodes` | `nodes_json` | `JSON.stringify`（字段原样，不拆列） |
| `edges` | `edges_json` | 同上 |
| `tables` | `tables_json` | 同上 |
| `view` | `view_json` | `scale` 需 clamp 到 [0.2, 5]（沿用 `normalize.js` 规则） |
| — | `revision` | 初始 1 |
| — | `content_hash` | 规范化后的 sha256（用 `normalizeDoc` 后的结果计算，保证「内容相同」判定稳定） |

#### 元素字段（node / edge / table）

节点与连线**整体作为 JSON 保留**，逐字段映射只在两处需要显式处理：

| 字段 | 处理 | 原因 |
| --- | --- | --- |
| `kind` | 保留原值（`note-*` / `card-*` / `list-*` / `mind-*` / `accent` / `muted`） | 前端 `normalize` 已做白名单兜底，云端不必重复建模 |
| `minH` / `contentH` | **必须保留** | 丢了 `minH`，刷新后节点再无法缩回原高度（`normalize.js` 里有明确注释） |
| `items[]`（列表卡片待办） | 保留，且保证末尾有一行空行 | 同上，是读档不变量 |
| `children[]`（思维导图） | 保留 | 丢了整棵子树渲染不出来 |
| `cells[][]`（表格） | 保留二维数组（含 `colWidths` / `rowHeights` / `headerH`） | 已被物化成逐行逐列，不能退回归一化尺寸 |

### 6.4 枚举转换

| 源（中文标签） | 目标值 | 备注 |
| --- | --- | --- |
| `待办` | `todo` | 默认值 |
| `进行中` | `doing` | — |
| `已完成` | `done` | — |
| 未知/空 | `todo` | 兜底，不阻断迁移 |

`category` 已是英文 key（`all` 是筛选项，不落库）。

### 6.5 冲突矩阵（本地 vs 云端）

| 本地 | 云端 | 处理 | `import_items.outcome` |
| --- | --- | --- | --- |
| 有文档 | 无 | 新建任务 + 文档 | `created` |
| 无文档（仅种子） | 无 | 生成种子后写入 | `created_seed` |
| 有文档 | 有文档，`content_hash` 相同 | 跳过，仅建 `local_doc_links` | `skipped_equal` |
| 有文档 | 有文档，本地 `updatedAt` **更新** | 覆盖上传；云端旧版入 `revisions(reason='migration')` | `updated` |
| 有文档 | 有文档，本地 **更旧** | 跳过上传，本地归档为「旧副本」 | `skipped_older` |
| 有文档 | 有文档，时间相同但 hash 不同 | 保留两者：云端为主，本地版进 `revisions` | `conflict_kept_both` |
| 无文档 | 有文档（换设备登录） | 拉取到本地缓存，不写 `import_items` | `pulled` |

> 默认策略是「**时间新的赢，但输的一方一定留档**」。迁移是单向且不可重来的操作，任何「静默丢弃」都不可接受。

### 6.6 幂等、可验证、可回滚

| 能力 | 实现 |
| --- | --- |
| **幂等** | `local_doc_links` 主键 `(user_id, local_key)`；重复导入命中则只比对 hash。同一设备重跑迁移不会产生第二份任务 |
| **分批** | 每批 ≤ 20 任务；服务端对每个任务执行 `db.batch([INSERT tasks, INSERT canvas_documents, INSERT local_doc_links])`——三条语句一个事务 |
| **可验证** | 迁移结束后校验：`导入条数 + 跳过条数 = 扫描条数`；抽样比对 `content_hash`；把结果写进 `import_batches` |
| **可回滚** | `POST /api/migrate/rollback/:batchId`：删除该批次 `outcome IN ('created','created_seed')` 的 tasks（级联清文档），把 `updated` 的文档还原到 `revisions` 里那条 `reason='migration'`。回滚窗口建议 7 天 + 二次确认 |
| **迁移后本地处置** | 三档，默认第二档：① 立即清除（省空间但不可逆）② **保留 7 天 + 标记「已同步」**（推荐）③ 永久保留只读副本 |

### 6.7 迁移的边界情况（容易漏的）

| 情况 | 处理 |
| --- | --- |
| 本地存档的 `taskId` 在 `TASKS` 常量里不存在 | 仍要导入：用首节点文本当 `title`，`category='work'`，`updated_at` 取存档 `updatedAt` |
| 存档 JSON 损坏 | 走 `normalizeDoc`；若返回空文档，记为 `skipped` 并在 UI 列出「1 个存档无法解析」，不阻断其它 |
| 同一用户在两台设备都有本地数据 | `client_id` 区分，各自一个 `import_batch`；冲突按 §6.5 时间比较 |
| 导入中途失败（网络/超时） | 批次保持 `pending`；已成功的条目因 `local_doc_links` 已存在而不会重复；重试幂等 |
| 用户先「跳到云端」再回头要导入 | 设置页保留「导入本地画布」入口，随时可补导 |
| 单份文档 > 1.5 MB | 迁移时就拦截并提示，避免撞 D1 单行 2 MB 上限 |

---

## 7. 风险与取舍

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| 120 ms 节流直连云端会打爆 D1 单线程 | 保存失败、体验崩坏 | 云端模式独立节流（1 s 防抖 + 离开前强制 flush），与本地节流解耦 |
| D1 无实时推送 | 多设备看到旧数据 | 聚焦/可见时拉取 + `ETag: revision` 比对；后续可上 Durable Object |
| 单行 2 MB 上限 | 超大画布存不进 | `size_bytes` 监控，1.5 MB 告警，超限的 `tables_json` 下沉 R2 |
| 三方合并有实现复杂度 | 冲突处理出 bug 会丢数据 | 合并前先把两端文档都写入 `revisions`，任何合并结果都可还原 |
| GitHub 邮箱私有 | 同一人分裂成两个账号 | 必须申请 `user:email`；未拿到 verified 邮箱时不做自动绑定 |
| PBKDF2 600k 迭代可能超 Worker CPU 限额 | 登录 500 | 上线前实测，必要时降到 210k 并在代码注释记录理由 |
| 本地数据被「升级」污染多账号 | 数据串号 | 匿名 key 与账号 key 物理隔离，只做复制不做改名 |
| 迁移不可逆 | 用户丢数据 | `import_batches` + `revisions` 双保险，7 天回滚窗口 |

---

## 8. 落地顺序

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| P0 | 建 D1 库、跑 `0001_init.sql`、Worker 骨架 + `/api/auth/session` | 迁移脚本可重复执行，`/api/auth/session` 返回 401 |
| P1 | 邮箱注册/登录/验证/重置 + session 中间件 | 能注册、能登录、越权访问他人任务返回 404 |
| P2 | GitHub OAuth + 绑定/解绑 | 同一人两种登录进入同一账号；解绑最后一种登录被拒 |
| P3 | `tasks` + `canvas_documents` CRUD + 乐观锁 | 用 `curl` 带错 `If-Match` 得到 409 |
| P4 | 端口化改造（`localAdapter` + `cloudAdapter` + bootstrap 三态） | 登录/登出切换，画布与列表行为一致，无闪烁 |
| P5 | 迁移向导（扫描 → 预览 → 导入 → 报告）+ 回滚 | 重复导入不产生重复任务；回滚后云端清空、本地完好 |
| P6 | outbox 离线队列 + 冲突合并 UI | 断网编辑后恢复网络能自动同步；双端改动能合并且不丢元素 |

---

## 附：几个刻意的设计取舍（供评审时快速判断）

1. **画布不做行级建模**——因为读写粒度是「整篇文档」，拆表只会把一次 UPDATE 变成几十次，收益为零。
2. **不存 GitHub access_token**——首版不需要调 GitHub API，不存 = 不用管加密轮换与泄露面。
3. **匿名数据不原地改名**——登录只是「复制到云端」，本地 key 不动，多账号共用电脑才安全。
4. **冲突宁可弹窗**——自动 last-write-wins 在画布这种「长时间离线编辑」场景里等于随机删数据。
5. **`legacy_id` 保留旧 URL**——迁移不该把用户收藏的 `/canvas/1` 变成 404。
