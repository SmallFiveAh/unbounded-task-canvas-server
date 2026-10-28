/**
 * 全局常量：与 docs/cloud-auth-and-storage-design.md 及 DDL 保持一致。
 */

export const MINUTE_MS = 60 * 1000;
export const DAY_MS = 24 * 60 * MINUTE_MS;

/** 会话：绝对 30 天 + 滑动 7 天，滑动最多每 5 分钟刷新一次（设计 §3.5） */
export const SESSION_ABSOLUTE_MS = 30 * DAY_MS;
export const SESSION_IDLE_MS = 7 * DAY_MS;
export const SESSION_TOUCH_INTERVAL_MS = 5 * MINUTE_MS;

/** 登录限流：15 分钟窗口，同一桶 5 次即锁定（设计 §3.5） */
export const LOGIN_WINDOW_MS = 15 * MINUTE_MS;
export const LOGIN_MAX_ATTEMPTS = 5;

/** 邮箱令牌有效期 */
export const EMAIL_TOKEN_TTL_MS = {
  verify_email: 24 * 60 * MINUTE_MS,
  reset_password: 15 * MINUTE_MS,
  magic_login: 15 * MINUTE_MS,
  change_email: 24 * 60 * MINUTE_MS,
};

/** 重发验证邮件冷却 */
export const RESEND_COOLDOWN_MS = 60 * 1000;

/** 邮箱令牌最多允许的校验失败次数 */
export const EMAIL_TOKEN_MAX_ATTEMPTS = 5;

/** 单份画布体积上限：设计 §4.6 —— 1.5 MB 告警线，超过即拒绝 */
export const MAX_DOCUMENT_BYTES = Math.floor(1.5 * 1024 * 1024);

/** 迁移：每批最多 20 个任务（设计 §6.1） */
export const MAX_IMPORT_ITEMS = 20;

/** 迁移回滚窗口：7 天（设计 §6.6） */
export const ROLLBACK_WINDOW_MS = 7 * DAY_MS;

/** 任务枚举，与 DDL CHECK 白名单一一对应 */
export const TASK_CATEGORIES = ['work', 'personal', 'project'];
export const TASK_STATUSES = ['todo', 'doing', 'done'];
export const TASK_STATUS_LABELS = {
  待办: 'todo',
  进行中: 'doing',
  已完成: 'done',
};

/** 密码策略 */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;
export const PASSWORD_SALT_BYTES = 16;
export const PASSWORD_HASH_BYTES = 32;
export const DEFAULT_PBKDF2_ITERATIONS = 600000;
/**
 * 常见弱口令（小样本，用于注册时快速拦截；不追求完整性，
 * 真正的防线是长度下限 + 限流）。
 */
export const COMMON_WEAK_PASSWORDS = new Set([
  '1234567890',
  '12345678910',
  'password12',
  'password123',
  'qwertyuiop',
  'qwerty12345',
  'abc1234567',
  'iloveyou12',
  'admin12345',
  '1qaz2wsx3edc',
]);

/** localStorage key 命名空间（设计 §5.5） */
export const LOCAL_DOC_KEY_PREFIX = 'unbounded-canvas:doc:';

/** 画布 schema 版本（对应本地 doc.version） */
export const SCHEMA_VERSION = 1;

/** 列表分页 */
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/** Cookie 名 */
export const SESSION_COOKIE_NAME = '__Host-session';
export const OAUTH_STATE_COOKIE_NAME = '__Host-oauth_state';
export const OAUTH_INTENT_COOKIE_NAME = '__Host-oauth_intent';
export const OAUTH_COOKIE_TTL_SECONDS = 10 * 60;
