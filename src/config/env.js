import {
  DEFAULT_PBKDF2_ITERATIONS,
  MAX_DOCUMENT_BYTES,
  SESSION_ABSOLUTE_MS,
  SESSION_COOKIE_NAME,
  SESSION_IDLE_MS,
  SESSION_TOUCH_INTERVAL_MS,
} from './constants.js';

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

function splitList(value) {
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * 读取环境变量：空串 / undefined / null 一律视为「未配置」。
 * 集中在这里做，避免每个字段都写一遍 ?? 与三元。
 */
function pick(env, key, fallback) {
  const value = env[key];
  if (value === undefined || value === null || value === '') return fallback;
  return value;
}

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * 把 Worker 的环境绑定归一化为不可变配置对象。
 * 只做「形状」转换，不做业务校验；缺关键密钥由对应服务在使用时报错。
 */
export function loadConfig(env = {}) {
  const environment = pick(env, 'ENVIRONMENT', 'development');
  const appOrigin = trimTrailingSlash(pick(env, 'APP_ORIGIN', 'http://localhost:5173'));
  const allowedOrigins = new Set([appOrigin, ...splitList(env.ALLOWED_ORIGINS)]);
  const cookieName = pick(env, 'SESSION_COOKIE_NAME', SESSION_COOKIE_NAME);

  const config = {
    environment,
    isProduction: environment === 'production',
    appOrigin,
    allowedOrigins,
    cookie: {
      name: cookieName,
      // __Host- 前缀强制 Secure；覆盖为非 __Host- 名称时（仅本地调试）放宽
      secure: cookieName.startsWith('__Host-') ? true : environment === 'production',
      sameSite: 'Lax',
      path: '/',
    },
    session: {
      absoluteMs: SESSION_ABSOLUTE_MS,
      idleMs: SESSION_IDLE_MS,
      touchIntervalMs: SESSION_TOUCH_INTERVAL_MS,
    },
    password: {
      iterations: toPositiveInt(env.PBKDF2_ITERATIONS, DEFAULT_PBKDF2_ITERATIONS),
    },
    github: {
      clientId: pick(env, 'GITHUB_CLIENT_ID', ''),
      clientSecret: pick(env, 'GITHUB_CLIENT_SECRET', ''),
      redirectUri: pick(env, 'GITHUB_REDIRECT_URI', ''),
      scope: 'read:user user:email',
    },
    email: {
      provider: String(pick(env, 'EMAIL_PROVIDER', 'console')).toLowerCase(),
      from: pick(env, 'EMAIL_FROM', 'no-reply@example.com'),
      resendApiKey: pick(env, 'RESEND_API_KEY', ''),
    },
    security: {
      ipHashSalt: pick(env, 'IP_HASH_SALT', pick(env, 'GITHUB_CLIENT_SECRET', 'insecure-dev-salt')),
    },
    limits: {
      maxDocumentBytes: MAX_DOCUMENT_BYTES,
    },
  };

  return Object.freeze(config);
}
