# 无限任务画布 · 服务接口文档

Dashboard 后端服务接口说明（Cloudflare Workers + D1 + Hono）。

- 适用于当前仓库 `unbounded-task-canvas-server`
- 设计依据：[cloud-auth-and-storage-design.md](./cloud-auth-and-storage-design.md)
- 数据库结构：[0001_init.sql](./sql/0001_init.sql)

---

## 目录

1. [快速开始](#1-快速开始)
2. [环境变量](#2-环境变量)
3. [通用约定](#3-通用约定)
4. [接口总览](#4-接口总览)
5. [健康检查](#5-健康检查)
6. [认证接口](#6-认证接口)
7. [当前用户](#7-当前用户)
8. [任务接口](#8-任务接口)
9. [画布文档接口](#9-画布文档接口)
10. [本地数据迁移](#10-本地数据迁移)
11. [数据结构](#11-数据结构)
12. [错误码速查](#12-错误码速查)
13. [前端接入示例](#13-前端接入示例)
14. [部署与运维](#14-部署与运维)

---

## 1. 快速开始

### 1.1 环境要求

- Node.js >= 20
- npm
- Cloudflare 账号（部署时需要）

### 1.2 安装依赖

```bash
npm install
```

### 1.3 初始化数据库

```bash
# 本地 D1（wrangler dev 使用）
npm run db:init:local

# 线上 D1
npm run db:init
```

### 1.4 本地开发

```bash
npm run dev
# 默认地址：http://localhost:8787
```

`.dev.vars` 存放本地密钥（已在 `.gitignore` 中）：

```
GITHUB_CLIENT_SECRET = "..."
RESEND_API_KEY = ""
IP_HASH_SALT = "local-dev-ip-hash-salt"
```

### 1.5 质量校验

```bash
npm run lint    # ESLint
npm run test    # Vitest（10 个文件 / 42 个用例）
npm run build   # wrangler dry-run 打包
```

### 1.6 Base URL

| 环境 | Base URL |
| --- | --- |
| 本地 | `http://localhost:8787` |
| 线上 | `https://<worker-name>.<subdomain>.workers.dev` |

所有接口都在 `/api` 下。

---

## 2. 环境变量

`wrangler.toml` 的 `[vars]` 与 `wrangler secret put` 均可提供。空字符串视为「未配置」。

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `ENVIRONMENT` | 否 | `development` | `production` 时启用 HSTS、Secure Cookie 等 |
| `APP_ORIGIN` | 推荐 | `http://localhost:5173` | 前端地址；用于邮件链接与 OAuth 回跳 |
| `ALLOWED_ORIGINS` | 否 | 空 | 逗号分隔的额外跨域来源 |
| `PBKDF2_ITERATIONS` | 否 | `600000` | 密码哈希迭代次数 |
| `EMAIL_PROVIDER` | 否 | `console` | `console` / `resend` / `mailchannels` |
| `EMAIL_FROM` | 否 | `no-reply@example.com` | 发件人 |
| `GITHUB_CLIENT_ID` | GitHub 登录必填 | 空 | OAuth App Client ID |
| `GITHUB_CLIENT_SECRET` | GitHub 登录必填 | 空 | **Secret**，不要写进仓库 |
| `GITHUB_REDIRECT_URI` | 推荐 | 空 | 必须与 GitHub OAuth App 的回调地址一致 |
| `RESEND_API_KEY` | `resend` 通道必填 | 空 | **Secret** |
| `IP_HASH_SALT` | 否 | 回退到 `GITHUB_CLIENT_SECRET` | IP 哈希盐，建议单独配置 |
| `SESSION_COOKIE_NAME` | 否 | `__Host-session` | 覆盖后若不以 `__Host-` 开头，非生产环境会放宽 Secure |

线上设置密钥：

```bash
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put IP_HASH_SALT
```

---

## 3. 通用约定

### 3.1 请求与响应

- 请求体：`Content-Type: application/json`
- 成功响应：`Content-Type: application/json`，除 `204`、`304` 外都有 JSON body
- 时间字段：**毫秒时间戳（number）**，唯一例外是 `GET /api/health` 的 `time`（ISO 8601 字符串）
- 资源 ID：UUIDv7 字符串
- 所有请求体/查询参数使用 `.strict()` 校验，**多传未知字段会返回 `422 VALIDATION_FAILED`**

### 3.2 认证方式

登录成功后由服务端下发 HttpOnly Cookie：

```
Set-Cookie: __Host-session=<token>; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000
```

- 会话：绝对有效期 **30 天**，空闲有效期 **7 天**；活跃会话每 5 分钟最多续期一次
- 服务端只存 `sha256(token)`，Cookie 中的明文不可反查
- 前端请求必须带 `credentials: 'include'`
- Cookie 失效/被撤销时，服务端会自动下发清除 Cookie

需要登录的接口在未登录时返回：

```json
{
  "error": { "code": "UNAUTHENTICATED", "message": "请先登录" },
  "requestId": "..."
}
```

### 3.3 CSRF / 跨域

- 主要防线：`SameSite=Lax`
- 第二道防线：所有 `POST / PUT / PATCH / DELETE` 会校验 `Origin`（缺失时回退 `Referer`）；只允许 `APP_ORIGIN` 与 `ALLOWED_ORIGINS` 中的来源
- 非浏览器客户端（curl / 服务端调用）不带 `Origin` 时放行
- CORS 预检 `OPTIONS` 返回 `204`，允许头：`Content-Type, If-Match, If-None-Match, X-Requested-With`
- 跨域响应头会暴露 `ETag`、`X-Request-Id`

### 3.4 请求追踪与安全头

每个响应都带：

| 响应头 | 说明 |
| --- | --- |
| `X-Request-Id` | 请求 ID（取 `CF-Ray`，否则随机 UUID） |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `no-referrer` |
| `Cache-Control` | `no-store`（文档接口除外） |

### 3.5 错误结构

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "请求参数不合法",
    "details": [{ "path": "email", "message": "邮箱格式不正确" }]
  },
  "requestId": "8f3c..."
}
```

- `error.code` 稳定，可用于程序判断
- `error.message` 面向用户，可能调整
- `details` 可选，结构随错误码变化
- 5xx 不泄漏内部堆栈

### 3.6 限流

| 场景 | 规则 | 响应 |
| --- | --- | --- |
| 登录 | 邮箱桶 + IP 桶，各自 15 分钟窗口内最多 5 次失败 | `429 LOGIN_RATE_LIMITED`，带 `Retry-After` 秒数 |
| 重发验证邮件 | 同一邮箱 60 秒冷却 | `429 RESEND_COOLDOWN` |
| 邮箱令牌 | 最多校验 5 次 | `400 TOKEN_LOCKED` |

### 3.7 幂等与乐观锁（画布）

- `GET /api/tasks/:id/document` 返回 `ETag: "<revision>"` 与 `Cache-Control: no-cache, must-revalidate`
- 带 `If-None-Match: "<revision>"` 且版本一致时返回 `304`（无 body）
- `PUT /api/tasks/:id/document` **必须**带 `If-Match: "<revision>"`：
  - 缺失 → `428 IF_MATCH_REQUIRED`
  - 格式非法 → `400 INVALID_IF_MATCH`
  - 版本过期 → `409 REVISION_CONFLICT`，`details` 带服务端最新文档
  - 内容哈希未变化 → 直接返回 `{ "ok": true, "skipped": true }`，不产生新版本、不判定冲突

### 3.8 分页

任务列表使用 keyset 分页：

- 请求：`cursor`（上一页返回的 `nextCursor`）、`limit`（1–100，默认 20）
- 响应：`{ items: Task[], nextCursor: string | null }`
- `nextCursor` 为 `null` 表示没有下一页
- 勿自行构造 `cursor`；非法游标返回 `400 INVALID_CURSOR`

---

## 4. 接口总览

| 方法 | 路径 | 登录 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/health` | 否 | 健康检查 |
| POST | `/api/auth/register` | 否 | 邮箱注册（需验证邮箱） |
| POST | `/api/auth/login` | 否 | 邮箱密码登录 |
| POST | `/api/auth/logout` | 否 | 退出登录（幂等） |
| GET | `/api/auth/session` | 否 | 查询当前会话 |
| POST | `/api/auth/verify-email` | 否 | 消费邮箱验证令牌 |
| POST | `/api/auth/resend-verification` | 否 | 重发验证邮件 |
| POST | `/api/auth/forgot-password` | 否 | 发起找回密码 |
| POST | `/api/auth/reset-password` | 否 | 重置密码 |
| DELETE | `/api/auth/identities/:id` | 是 | 解绑登录方式 |
| GET | `/api/auth/github/start` | 条件 | 发起 GitHub OAuth（整页跳转） |
| POST | `/api/auth/github/link` | 是 | 获取 GitHub 绑定授权地址 |
| GET | `/api/auth/github/callback` | 否 | GitHub OAuth 回调 |
| GET | `/api/me` | 是 | 用户资料 + 登录方式 |
| GET | `/api/tasks` | 是 | 任务列表 |
| POST | `/api/tasks` | 是 | 创建任务 |
| PATCH | `/api/tasks/:id` | 是 | 更新任务 |
| DELETE | `/api/tasks/:id` | 是 | 删除任务（软删除） |
| GET | `/api/tasks/:id/document` | 是 | 获取画布文档 |
| PUT | `/api/tasks/:id/document` | 是 | 保存画布文档（乐观锁） |
| POST | `/api/migrate/import` | 是 | 导入本地存档 |
| POST | `/api/migrate/rollback/:batchId` | 是 | 回滚导入批次 |

> 所有任务/文档/迁移接口的 SQL 都带 `owner_id` 条件；访问他人资源统一返回 `404`，不泄漏是否存在。

---

## 5. 健康检查

### GET /api/health

不需要登录，也不依赖 D1 绑定（未配置时仍返回 200）。

**响应 200**

```json
{
  "ok": true,
  "database": "ok",
  "time": "2026-10-28T08:00:00.000Z"
}
```

`database` 取值：`ok` | `error` | `unavailable`（未绑定 `DB`）。

```bash
curl http://localhost:8787/api/health
```

---

## 6. 认证接口

### 6.1 注册

`POST /api/auth/register`

**请求**

```json
{
  "email": "user@example.com",
  "password": "S3cure-passw0rd",
  "displayName": "小伍"
}
```

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `email` | string | 是 | 合法邮箱，≤254，自动去空格转小写 |
| `password` | string | 是 | 10–128 位，且不在常见弱口令表 |
| `displayName` | string | 否 | ≤60，默认取邮箱 @ 前部分 |

**响应 201**

```json
{
  "user": {
    "id": "0192f0...",
    "email": "user@example.com",
    "emailVerified": false,
    "displayName": "小伍",
    "avatarUrl": null,
    "locale": "zh-CN",
    "status": "active",
    "createdAt": 1793197800000,
    "updatedAt": 1793197800000,
    "lastLoginAt": null
  },
  "verification": {
    "sent": true,
    "required": true
  }
}
```

开发环境（`EMAIL_PROVIDER=console` 且非 production）会额外返回 `verification.devToken`，可直接用于联调：

```json
{ "verification": { "sent": false, "required": true, "devToken": "..." } }
```

> 注册后**必须验证邮箱才能登录**。

**错误**

| 状态 | code | 场景 |
| --- | --- | --- |
| 409 | `EMAIL_TAKEN` | 邮箱已注册 |
| 422 | `VALIDATION_FAILED` | 字段缺失/格式错误/多传字段 |
| 422 | `WEAK_PASSWORD` | 密码属于常见弱口令（长度/格式问题由 `VALIDATION_FAILED` 返回） |
| 400 | `INVALID_JSON` | body 不是合法 JSON |

### 6.2 登录

`POST /api/auth/login`

```json
{ "email": "user@example.com", "password": "S3cure-passw0rd" }
```

**响应 200**（同时下发 `Set-Cookie`）

```json
{
  "user": { "...": "User" },
  "session": {
    "expiresAt": 1795790000000,
    "idleExpiresAt": 1793800000000
  }
}
```

**错误**

| 状态 | code | 场景 |
| --- | --- | --- |
| 401 | `INVALID_CREDENTIALS` | 邮箱不存在或密码错误（统一模糊提示） |
| 403 | `EMAIL_NOT_VERIFIED` | 邮箱未验证 |
| 403 | `ACCOUNT_UNAVAILABLE` | 账号被禁用/删除 |
| 429 | `LOGIN_RATE_LIMITED` | 触发邮箱桶或 IP 桶限流（带 `Retry-After`） |

```bash
curl -i -c cookies.txt -X POST http://localhost:8787/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"user@example.com","password":"S3cure-passw0rd"}'
```

### 6.3 退出登录

`POST /api/auth/logout`

- 无请求体；未登录也返回 `204`（幂等）
- 会撤销当前会话并清除 Cookie

**响应 204**（无 body）

### 6.4 查询当前会话

`GET /api/auth/session`

**响应 200**

```json
{ "user": { "...": "User" }, "session": { "expiresAt": 0, "idleExpiresAt": 0 } }
```

未登录返回 `401 UNAUTHENTICATED`。

### 6.5 验证邮箱

`POST /api/auth/verify-email`

```json
{ "token": "邮件里的 token" }
```

**响应 200**

```json
{ "verified": true, "email": "user@example.com" }
```

**错误**

| 状态 | code | 场景 |
| --- | --- | --- |
| 400 | `INVALID_TOKEN` | token 不存在或用途不符 |
| 400 | `TOKEN_ALREADY_USED` | 已被消费 |
| 400 | `TOKEN_EXPIRED` | 超过 24 小时 |
| 400 | `TOKEN_LOCKED` | 失败次数达到 5 次 |
| 404 | `USER_NOT_FOUND` | 账号已不存在 |

### 6.6 重发验证邮件

`POST /api/auth/resend-verification`

```json
{ "email": "user@example.com" }
```

**响应 202**

```json
{ "accepted": true }
```

开发环境可能带 `devToken`。无论邮箱是否存在都返回 `202`（防账号枚举）；已注册且未验证才会真正发信。

| 状态 | code | 场景 |
| --- | --- | --- |
| 429 | `RESEND_COOLDOWN` | 60 秒内重复请求 |

### 6.7 忘记密码

`POST /api/auth/forgot-password`

```json
{ "email": "user@example.com" }
```

**响应 202**

```json
{ "accepted": true }
```

同样防枚举；仅对「已注册且邮箱已验证」的账号发送 15 分钟有效链接。开发环境可能带 `devToken`。

### 6.8 重置密码

`POST /api/auth/reset-password`

```json
{ "token": "邮件里的 token", "password": "New-passw0rd" }
```

**响应 200**

```json
{ "reset": true }
```

- 成功后**撤销该用户全部会话**，需要重新登录
- 密码规则同注册

| 状态 | code | 场景 |
| --- | --- | --- |
| 400 | `INVALID_TOKEN` / `TOKEN_EXPIRED` / `TOKEN_ALREADY_USED` / `TOKEN_LOCKED` | 令牌问题 |
| 422 | `WEAK_PASSWORD` | 新密码属于常见弱口令 |
| 400 | `IDENTITY_NOT_FOUND` | 该邮箱没有密码登录方式（如纯 GitHub 账号） |
| 404 | `USER_NOT_FOUND` | 账号不存在 |

### 6.9 解绑登录方式

`DELETE /api/auth/identities/:id`（需登录）

`:id` 取自 `GET /api/me` 的 `identities[].id`。

**响应 200**

```json
{ "unlinked": true }
```

| 状态 | code | 场景 |
| --- | --- | --- |
| 404 | `IDENTITY_NOT_FOUND` | 不存在或不属于当前用户 |
| 409 | `LAST_IDENTITY` | 只剩一种登录方式，不允许解绑 |

### 6.10 GitHub 登录 / 绑定

#### GET /api/auth/github/start

浏览器**整页跳转**入口。

| 查询参数 | 说明 |
| --- | --- |
| `mode` | `login`（默认）/ `link` |
| `redirect` | 成功后回跳的站内相对路径，默认 `/`；仅接受以 `/` 开头且不以 `//` 开头、不含 `\` 的路径 |

- `mode=link` 需要已登录，否则 `401 UNAUTHENTICATED`
- 未配置 `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` → `422 GITHUB_NOT_CONFIGURED`
- 服务端会设置一次性 Cookie：`__Host-oauth_state`、`__Host-oauth_intent`（10 分钟）
- 成功返回 `302` 跳转到 `https://github.com/login/oauth/authorize?...`

```
scope = read:user user:email
```

#### POST /api/auth/github/link

供 SPA 自行控制跳转（需登录）。

```json
{ "redirect": "/settings" }
```

**响应 200**

```json
{
  "authorizeUrl": "https://github.com/login/oauth/authorize?...",
  "expiresIn": 600
}
```

同时下发两个一次性 Cookie。前端随后执行 `window.location.href = authorizeUrl`。

> 该接口的请求体是必填 JSON，没有 `redirect` 时也要发送 `{}`，否则会返回 `400 INVALID_JSON`。

#### GET /api/auth/github/callback

GitHub 回调地址，需与 `GITHUB_REDIRECT_URI` 完全一致。

- 成功：`302` 回跳 `APP_ORIGIN + redirect`；登录模式会同时下发会话 Cookie
- 失败：
  - `4xx`（state/code/intent 问题）以 JSON 错误返回，便于排查
  - `5xx`（GitHub 上游故障）`302` 回跳 `${APP_ORIGIN}/login?error=<CODE>`

绑定矩阵（服务端行为）：

| 情况 | 行为 |
| --- | --- |
| GitHub 身份已绑当前用户 | 幂等成功 |
| GitHub 身份已绑其他用户 | `409 IDENTITY_ALREADY_LINKED` |
| 未绑定，但 GitHub 邮箱命中已注册且**已验证**账号 | 自动关联到该账号 |
| 未绑定，GitHub 邮箱命中**未验证**账号 | `409 ACCOUNT_UNVERIFIED`（防抢注接管） |
| 未绑定且邮箱不存在 | 新建账号（邮箱视为已验证） |
| 拿不到已验证邮箱 | `409 GITHUB_EMAIL_REQUIRED` |

| 状态 | code |
| --- | --- |
| 400 | `OAUTH_STATE_MISMATCH` / `OAUTH_CODE_MISSING` / `OAUTH_INTENT_MISSING` |
| 401 | `UNAUTHENTICATED` |
| 409 | `IDENTITY_ALREADY_LINKED` / `GITHUB_EMAIL_REQUIRED` / `ACCOUNT_UNVERIFIED` |
| 403 | `ACCOUNT_UNAVAILABLE` |
| 422 | `GITHUB_NOT_CONFIGURED` |
| 502 | `GITHUB_UPSTREAM_ERROR` / `GITHUB_TOKEN_EXCHANGE_FAILED` / `GITHUB_PROFILE_FAILED` |

---

## 7. 当前用户

### GET /api/me（需登录）

**响应 200**

```json
{
  "user": {
    "id": "0192f0...",
    "email": "user@example.com",
    "emailVerified": true,
    "displayName": "小伍",
    "avatarUrl": null,
    "locale": "zh-CN",
    "status": "active",
    "createdAt": 1793197800000,
    "updatedAt": 1793197800000,
    "lastLoginAt": 1793197800000
  },
  "identities": [
    {
      "id": "0192f1...",
      "provider": "email",
      "providerEmail": "user@example.com",
      "providerUsername": null,
      "linkedAt": 1793197800000,
      "lastUsedAt": 1793197800000
    },
    {
      "id": "0192f2...",
      "provider": "github",
      "providerEmail": "user@example.com",
      "providerUsername": "octocat",
      "linkedAt": 1793197900000,
      "lastUsedAt": 1793197900000
    }
  ]
}
```

---

## 8. 任务接口

所有任务接口都需要登录。

### 8.1 任务列表

`GET /api/tasks`

| 查询参数 | 类型 | 说明 |
| --- | --- | --- |
| `category` | `work` \| `personal` \| `project` | 可选 |
| `status` | `todo` \| `doing` \| `done` | 可选 |
| `q` | string（≤100） | 标题模糊搜索 |
| `cursor` | string（≤512） | 上一页 `nextCursor` |
| `limit` | number | 1–100，默认 20 |

**响应 200**

```json
{
  "items": [
    {
      "id": "0192f0...",
      "legacyId": null,
      "title": "整理季度评审",
      "category": "work",
      "status": "doing",
      "progress": 40,
      "createdAt": 1793197800000,
      "updatedAt": 1793197800000,
      "nodeCount": 12,
      "tableCount": 1,
      "revision": 3
    }
  ],
  "nextCursor": null
}
```

```bash
curl -b cookies.txt 'http://localhost:8787/api/tasks?status=doing&limit=20'
```

### 8.2 创建任务

`POST /api/tasks`

```json
{
  "title": "整理季度评审",
  "category": "work",
  "status": "todo",
  "progress": 0,
  "legacyId": null
}
```

| 字段 | 必填 | 默认 | 约束 |
| --- | --- | --- | --- |
| `title` | 是 | — | 1–200 |
| `category` | 否 | `work` | 枚举 |
| `status` | 否 | `todo` | 枚举 |
| `progress` | 否 | `0` | 0–100 整数 |
| `legacyId` | 否 | `null` | 1–64；同一用户下唯一 |

**响应 201**：Task 对象（新任务自带空文档，`revision = 1`）。

| 状态 | code | 场景 |
| --- | --- | --- |
| 409 | `LEGACY_ID_TAKEN` | 该用户下 `legacyId` 已存在 |

### 8.3 更新任务

`PATCH /api/tasks/:id`

```json
{ "status": "done", "progress": 100 }
```

- 至少提供一个字段：`title` / `category` / `status` / `progress`
- `legacyId` 不可修改

**响应 200**：更新后的 Task。

| 状态 | code |
| --- | --- |
| 404 | `TASK_NOT_FOUND` |
| 422 | `VALIDATION_FAILED` |

### 8.4 删除任务

`DELETE /api/tasks/:id`

- 软删除，删除后列表不可见、文档不可再访问
- **响应 204**

| 状态 | code |
| --- | --- |
| 404 | `TASK_NOT_FOUND` |

---

## 9. 画布文档接口

### 9.1 获取文档

`GET /api/tasks/:id/document`（需登录）

**响应 200**

响应头：

```
ETag: "3"
Cache-Control: no-cache, must-revalidate
```

body：

```json
{
  "version": 1,
  "revision": 3,
  "nodes": [{ "id": "n1", "type": "task", "x": 0, "y": 0 }],
  "edges": [{ "id": "e1", "from": "n1", "to": "n2" }],
  "tables": [],
  "view": { "x": 0, "y": 0, "scale": 1 },
  "updatedAt": 1793197800000
}
```

- `If-None-Match: "3"` 且版本一致 → `304`（无 body）
- 任务存在但尚无文档时，服务端会**自动创建空文档**（`revision = 1`）

| 状态 | code |
| --- | --- |
| 404 | `TASK_NOT_FOUND` |

### 9.2 保存文档

`PUT /api/tasks/:id/document`（需登录）

**请求头**

```
If-Match: "3"
Content-Type: application/json
```

**请求体**

```json
{
  "version": 1,
  "nodes": [{ "id": "n1", "type": "task", "x": 0, "y": 0 }],
  "edges": [],
  "tables": [],
  "view": { "x": 0, "y": 0, "scale": 1 },
  "updatedAt": 1793197800000,
  "deviceId": "web-1"
}
```

| 字段 | 必填 | 约束 |
| --- | --- | --- |
| `nodes` | 是 | 数组，≤5000 |
| `edges` | 是 | 数组，≤20000 |
| `tables` | 是 | 数组，≤2000 |
| `view` | 否 | `{x,y,scale}` 或 `null`；`scale` 会被限制在 0.2–5 |
| `version` | 否 | 1–1000 |
| `updatedAt` | 否 | 客户端时间仅作参考，服务端以接收时间落库 |
| `deviceId` | 否 | ≤64，写入审计字段 |

**响应 200**

```json
{
  "ok": true,
  "skipped": false,
  "revision": 4,
  "updatedAt": 1793197810000,
  "contentHash": "sha256:..."
}
```

响应头带新的 `ETag: "4"`。

| 状态 | code | 说明 |
| --- | --- | --- |
| 428 | `IF_MATCH_REQUIRED` | 未带 `If-Match` |
| 400 | `INVALID_IF_MATCH` | `If-Match` 不是 `"<revision>"` |
| 409 | `REVISION_CONFLICT` | 版本已过期，`details` 见下 |
| 413 | `DOCUMENT_TOO_LARGE` | 序列化后超过 1.5 MB |
| 404 | `TASK_NOT_FOUND` | 任务不存在或不属于当前用户 |

冲突响应示例：

```json
{
  "error": {
    "code": "REVISION_CONFLICT",
    "message": "画布已在其它位置被修改，请先合并",
    "details": {
      "baseRevision": 3,
      "serverRevision": 5,
      "document": { "version": 1, "revision": 5, "nodes": [], "edges": [], "tables": [], "view": null, "updatedAt": 1793197820000 }
    }
  },
  "requestId": "..."
}
```

体积超限响应示例：

```json
{
  "error": {
    "code": "DOCUMENT_TOO_LARGE",
    "message": "画布体积超过 1.5 MB 上限，请精简后再保存",
    "details": { "sizeBytes": 1572865, "limitBytes": 1572864 }
  },
  "requestId": "..."
}
```

保存示例：

```bash
curl -i -b cookies.txt -X PUT \
  http://localhost:8787/api/tasks/0192f0.../document \
  -H 'Content-Type: application/json' \
  -H 'If-Match: "3"' \
  --data-binary @doc.json
```

> 注意：`putDocument` 会在内容哈希与当前一致时返回 `skipped: true`，此时即使 `If-Match` 落后也不报 409 —— 这是幂等重放保护。

---

## 10. 本地数据迁移

本地存档 key 必须以 `unbounded-canvas:doc:` 开头，例如：

```
unbounded-canvas:doc:local-task-42
```

其中 `local-task-42` 会作为 `tasks.legacy_id` 写入（用于与本地任务对应）。

### 10.1 导入

`POST /api/migrate/import`（需登录）

```json
{
  "clientId": "web-local-20261028",
  "source": "localStorage-v1",
  "items": [
    {
      "localKey": "unbounded-canvas:doc:local-task-42",
      "task": {
        "title": "本地任务 A",
        "category": "work",
        "status": "进行中",
        "progress": 30,
        "updatedAt": "2026-10-20"
      },
      "document": {
        "version": 1,
        "nodes": [],
        "edges": [],
        "tables": [],
        "view": null,
        "updatedAt": 1793197800000
      }
    },
    {
      "localKey": "unbounded-canvas:doc:local-task-43",
      "task": { "title": "只有任务的存档" },
      "document": null
    }
  ]
}
```

| 字段 | 必填 | 约束 |
| --- | --- | --- |
| `clientId` | 是 | 1–64，标识一次迁移来源 |
| `source` | 否 | ≤32，默认 `localStorage-v1` |
| `items` | 是 | 1–20 条/批 |

单条结构：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `localKey` | 是 | 1–200，必须是 `unbounded-canvas:doc:` 前缀 |
| `task` | 否 | `{title?,category?,status?,progress?,updatedAt?}` |
| `document` | 否 | `{version?,nodes?,edges?,tables?,view?,updatedAt?}` |

- `status` 支持英文枚举或中文标签：`待办`→`todo`、`进行中`→`doing`、`已完成`→`done`；无法识别回退 `todo`
- `updatedAt` 支持毫秒数字或字符串；纯日期字符串按 **Asia/Shanghai** 解析
- 单条非法/损坏只影响自身，返回 `skipped_invalid`，不阻断整批
- 每批最多 20 条，前端需分批调用

**响应 200**

```json
{
  "batchId": "0192f3...",
  "status": "committed",
  "itemTotal": 2,
  "itemImported": 2,
  "itemSkipped": 0,
  "results": [
    {
      "localKey": "unbounded-canvas:doc:local-task-42",
      "taskId": "0192f4...",
      "outcome": "created"
    },
    {
      "localKey": "unbounded-canvas:doc:local-task-43",
      "taskId": "0192f5...",
      "outcome": "created_seed"
    }
  ]
}
```

单条失败示例：

```json
{
  "localKey": "bad-key",
  "outcome": "skipped_invalid",
  "reason": "只能导入 unbounded-canvas:doc: 命名空间下的存档"
}
```

```json
{
  "localKey": "unbounded-canvas:doc:local-task-44",
  "outcome": "skipped_invalid",
  "issues": [{ "path": "task.progress", "message": "Number must be less than or equal to 100" }]
}
```

#### outcome 对照表

| outcome | 计数 | 含义 | 回滚行为 |
| --- | --- | --- | --- |
| `created` | 计入 imported | 新建任务 + 写入本地文档 | 删除该任务 |
| `created_seed` | 计入 imported | 新建任务，但本地无文档，写入空文档 | 删除该任务 |
| `updated` | 计入 imported | 本地较新，覆盖云端；旧云端版存入历史 | 用历史版本还原 |
| `conflict_kept_both` | 计入 imported | 时间相同但内容不同，云端为主，本地版存入历史 | 保留原样 |
| `skipped_equal` | 计入 skipped | 内容完全一致 | 保留原样 |
| `skipped_older` | 计入 skipped | 云端更新时间更晚 | 保留原样 |
| `pulled` | 计入 skipped | 云端有文档、本地无文档，只建立绑定关系 | 保留原样 |
| `skipped_invalid` | 计入 skipped | 条目非法/损坏/超出体积/命名空间错误 | — |

> 如果批次因系统级错误中断，返回 `500 MIGRATION_INTERRUPTED`，`details` 里带 `batchId` 与已完成的结果；直接重试是安全的（重复条目会命中幂等逻辑）。

### 10.2 回滚

`POST /api/migrate/rollback/:batchId`（需登录）

无请求体。

**响应 200**

```json
{
  "batchId": "0192f3...",
  "status": "rolled_back",
  "deleted": 2,
  "restored": 1,
  "untouched": 5
}
```

- `deleted`：删除了多少个由本批创建的任务
- `restored`：用迁移前的历史版本还原了多少个被覆盖的文档
- `untouched`：其余条目数量（跳过/保留/冲突留档）

| 状态 | code | 场景 |
| --- | --- | --- |
| 404 | `BATCH_NOT_FOUND` | 批次不存在或不属于当前用户 |
| 409 | `BATCH_ALREADY_ROLLED_BACK` | 已回滚过 |
| 409 | `ROLLBACK_WINDOW_EXPIRED` | 超过批次开始后 7 天 |

```bash
curl -b cookies.txt -X POST \
  http://localhost:8787/api/migrate/rollback/0192f3...
```

---

## 11. 数据结构

### User

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | UUIDv7 |
| `email` | string | 小写 |
| `emailVerified` | boolean | 是否已验证 |
| `displayName` | string | 可为空串 |
| `avatarUrl` | string \| null | 头像 |
| `locale` | string | 默认 `zh-CN` |
| `status` | string | `active` 等 |
| `createdAt` | number | 毫秒 |
| `updatedAt` | number | 毫秒 |
| `lastLoginAt` | number \| null | 毫秒 |

### Identity

| 字段 | 类型 |
| --- | --- |
| `id` | string |
| `provider` | `email` \| `github` |
| `providerEmail` | string \| null |
| `providerUsername` | string \| null |
| `linkedAt` | number |
| `lastUsedAt` | number \| null |

### Task

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | UUIDv7 |
| `legacyId` | string \| null | 本地任务 ID |
| `title` | string | |
| `category` | `work` \| `personal` \| `project` | |
| `status` | `todo` \| `doing` \| `done` | |
| `progress` | number | 0–100 |
| `createdAt` / `updatedAt` | number | 毫秒 |
| `nodeCount` | number | 节点数 |
| `tableCount` | number | 表格数 |
| `revision` | number \| null | 文档版本 |

### Document

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `version` | number | schema 版本 |
| `revision` | number | 乐观锁版本，从 1 开始 |
| `nodes` | object[] | |
| `edges` | object[] | |
| `tables` | object[] | |
| `view` | `{x,y,scale}` \| null | 视口 |
| `updatedAt` | number | 毫秒 |

### Session

| 字段 | 类型 |
| --- | --- |
| `expiresAt` | number |
| `idleExpiresAt` | number |

---

## 12. 错误码速查

| HTTP | code | 说明 |
| --- | --- | --- |
| 400 | `INVALID_JSON` | 请求体不是合法 JSON |
| 400 | `INVALID_IF_MATCH` | `If-Match` 格式非法 |
| 400 | `INVALID_CURSOR` | 分页游标非法 |
| 400 | `INVALID_TOKEN` | 邮箱令牌无效 |
| 400 | `TOKEN_EXPIRED` / `TOKEN_ALREADY_USED` / `TOKEN_LOCKED` | 邮箱令牌过期/已用/锁定 |
| 400 | `IDENTITY_NOT_FOUND` | 重置密码时该邮箱无密码登录方式 |
| 400 | `OAUTH_STATE_MISMATCH` | OAuth state 校验失败 |
| 400 | `OAUTH_CODE_MISSING` | 回调缺 code |
| 400 | `OAUTH_INTENT_MISSING` | 一次性 Cookie 丢失/过期 |
| 401 | `UNAUTHENTICATED` | 未登录 |
| 401 | `INVALID_CREDENTIALS` | 登录失败 |
| 403 | `ORIGIN_NOT_ALLOWED` | 来源不在白名单 |
| 403 | `EMAIL_NOT_VERIFIED` | 邮箱未验证 |
| 403 | `ACCOUNT_UNAVAILABLE` | 账号不可用 |
| 404 | `TASK_NOT_FOUND` | 任务不存在或无权访问 |
| 404 | `DOCUMENT_NOT_FOUND` | 文档不存在 |
| 404 | `USER_NOT_FOUND` | 用户不存在 |
| 404 | `IDENTITY_NOT_FOUND` | 登录方式不存在 |
| 404 | `BATCH_NOT_FOUND` | 迁移批次不存在 |
| 404 | `NOT_FOUND` | 接口不存在 |
| 409 | `EMAIL_TAKEN` | 邮箱已注册 |
| 409 | `LEGACY_ID_TAKEN` | 本地任务 ID 冲突 |
| 409 | `REVISION_CONFLICT` | 画布版本冲突 |
| 409 | `LAST_IDENTITY` | 不允许解绑最后一种登录方式 |
| 409 | `IDENTITY_ALREADY_LINKED` | GitHub 已绑其他账号 |
| 409 | `GITHUB_EMAIL_REQUIRED` | 无法获取 GitHub 已验证邮箱 |
| 409 | `ACCOUNT_UNVERIFIED` | 目标邮箱账号未验证 |
| 409 | `BATCH_ALREADY_ROLLED_BACK` | 批次已回滚 |
| 409 | `ROLLBACK_WINDOW_EXPIRED` | 超出 7 天回滚窗口 |
| 413 | `DOCUMENT_TOO_LARGE` | 文档超过 1.5 MB |
| 422 | `VALIDATION_FAILED` | 参数校验失败（`details` 为字段级错误） |
| 422 | `WEAK_PASSWORD` | 密码不合规 |
| 422 | `INVALID_LOCAL_KEY` | 迁移 key 前缀错误 |
| 422 | `GITHUB_NOT_CONFIGURED` | GitHub 未配置 |
| 428 | `IF_MATCH_REQUIRED` | 保存文档缺 `If-Match` |
| 429 | `LOGIN_RATE_LIMITED` | 登录限流 |
| 429 | `RESEND_COOLDOWN` | 重发验证邮件过快 |
| 500 | `INTERNAL_ERROR` | 未预期错误 |
| 500 | `DATABASE_NOT_CONFIGURED` | D1 绑定 `DB` 缺失 |
| 500 | `MIGRATION_INTERRUPTED` | 迁移中断（`details.batchId`） |
| 502 | `GITHUB_UPSTREAM_ERROR` | GitHub 不可达 |
| 502 | `GITHUB_TOKEN_EXCHANGE_FAILED` | 换 token 失败 |
| 502 | `GITHUB_PROFILE_FAILED` | 拉取 GitHub 资料失败 |
| 502 | `EMAIL_NOT_CONFIGURED` | 邮件通道缺密钥 |
| 502 | `EMAIL_DELIVERY_FAILED` | 邮件发送失败 |
| 502 | `EMAIL_PROVIDER_UNKNOWN` | 未知邮件通道 |

---

## 13. 前端接入示例

### 13.1 统一请求封装

```js
const API_BASE = 'http://localhost:8787';

export class ApiError extends Error {
  constructor(status, payload) {
    super(payload?.error?.message ?? `HTTP ${status}`);
    this.status = status;
    this.code = payload?.error?.code ?? 'UNKNOWN';
    this.details = payload?.error?.details;
    this.requestId = payload?.requestId;
  }
}

export async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    credentials: 'include',
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (response.status === 204 || response.status === 304) return null;

  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, payload);
  return payload;
}
```

### 13.2 登录与启动检查

```js
try {
  const { user } = await api('/api/auth/session');
  // 已登录
} catch (err) {
  if (err.status === 401) location.href = '/login';
  else throw err;
}
```

### 13.3 画布读取与保存

```js
let revision = null;

async function loadDocument(taskId) {
  const response = await fetch(`${API_BASE}/api/tasks/${taskId}/document`, {
    credentials: 'include',
    headers: revision ? { 'If-None-Match': `"${revision}"` } : {},
  });
  if (response.status === 304) return null; // 本地缓存仍有效
  if (!response.ok) throw new ApiError(response.status, await response.json());
  revision = response.headers.get('ETag').replaceAll('"', '');
  return response.json();
}

async function saveDocument(taskId, doc) {
  try {
    const result = await api(`/api/tasks/${taskId}/document`, {
      method: 'PUT',
      headers: { 'If-Match': `"${revision}"` },
      body: doc,
    });
    revision = String(result.revision);
    return result;
  } catch (err) {
    if (err.status === 428) {
      // 未拿到版本号，先重新拉取
      await loadDocument(taskId);
    }
    if (err.code === 'REVISION_CONFLICT') {
      // err.details.document 是服务端最新版本，提示用户合并
      return { conflict: true, server: err.details.document };
    }
    throw err;
  }
}
```

### 13.4 本地迁移（分批 + 失败重试）

```js
function readLocalItems() {
  const items = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (!key?.startsWith('unbounded-canvas:doc:')) continue;
    const doc = JSON.parse(localStorage.getItem(key) || 'null');
    const task = JSON.parse(localStorage.getItem(`unbounded-canvas:task:${key.split(':').pop()}`) || 'null');
    items.push({ localKey: key, task, document: doc });
  }
  return items;
}

async function migrateAll() {
  const all = readLocalItems();
  const batchIdList = [];

  for (let i = 0; i < all.length; i += 20) {
    const items = all.slice(i, i + 20);
    const result = await api('/api/migrate/import', {
      method: 'POST',
      body: { clientId: `web-${Date.now()}`, source: 'localStorage-v1', items },
    });
    batchIdList.push(result.batchId);
    // results 中 outcome=skipped_invalid 的条目可提示用户手动处理
  }

  return batchIdList;
}
```

> 迁移是幂等的：同一 `localKey` 重复导入不会创建重复任务。7 天内可用 `POST /api/migrate/rollback/:batchId` 回退。

---

## 14. 部署与运维

### 14.1 上线前检查

1. `wrangler.toml`
   - `database_id` 指向线上 D1
   - `ENVIRONMENT = "production"`
   - `APP_ORIGIN`、`ALLOWED_ORIGINS` 改为线上前端域名
   - `GITHUB_REDIRECT_URI` 改为线上回调地址（并与 GitHub OAuth App 保持一致）
   - `EMAIL_PROVIDER` 改为 `resend` 或 `mailchannels`
2. 写入密钥
   ```bash
   npx wrangler secret put GITHUB_CLIENT_SECRET
   npx wrangler secret put RESEND_API_KEY
   npx wrangler secret put IP_HASH_SALT
   ```
3. 初始化线上库
   ```bash
   npm run db:init
   ```
4. 发布
   ```bash
   npm run build   # 先做 dry-run 校验
   npm run deploy
   ```

### 14.2 发布后验证

```bash
curl https://<worker-domain>/api/health
```

期望 `database` 为 `ok`。

### 14.3 本地排障

| 现象 | 原因/处理 |
| --- | --- |
| `DATABASE_NOT_CONFIGURED` | `wrangler.toml` 未绑定 `[[d1_databases]]` 或未执行 `db:init:local` |
| 登录一直 `429` | 本地所有请求共用 `127.0.0.1` 的 IP 桶；可 `wrangler d1 execute unbounded-task-canvas --local --command "DELETE FROM login_attempts;"` |
| 注册返回 `verification.sent=false` | `EMAIL_PROVIDER=console` 只打印链接，同时会返回 `devToken` |
| GitHub 授权后报 `GITHUB_NOT_CONFIGURED` | `GITHUB_CLIENT_ID` 或 `GITHUB_CLIENT_SECRET` 未设置 |
| 前端跨域拿不到 Cookie | 需要 `credentials: 'include'`，且前端 Origin 必须在 `APP_ORIGIN`/`ALLOWED_ORIGINS` 中 |
| `__Host-` Cookie 本地不生效 | 使用 `http://localhost`（浏览器将 localhost 视为安全上下文） |

---

## 附：接口速记

```
GET    /api/health
POST   /api/auth/register
POST   /api/auth/login
POST   /api/auth/logout
GET    /api/auth/session
POST   /api/auth/verify-email
POST   /api/auth/resend-verification
POST   /api/auth/forgot-password
POST   /api/auth/reset-password
DELETE /api/auth/identities/:id
GET    /api/auth/github/start
POST   /api/auth/github/link
GET    /api/auth/github/callback
GET    /api/me
GET    /api/tasks
POST   /api/tasks
PATCH  /api/tasks/:id
DELETE /api/tasks/:id
GET    /api/tasks/:id/document
PUT    /api/tasks/:id/document
POST   /api/migrate/import
POST   /api/migrate/rollback/:batchId
```
