import { serializeCookie } from '../lib/cookies.js';
import { randomToken, sha256Hex } from '../lib/crypto.js';

const MAX_USER_AGENT_LENGTH = 200;

async function hashIp(config, ip) {
  if (!ip || ip === 'unknown') return null;
  return sha256Hex(`${config.security.ipHashSalt}:${ip}`);
}

export function sessionCookie(config, token) {
  return serializeCookie(config.cookie.name, token, {
    maxAge: Math.floor(config.session.absoluteMs / 1000),
    httpOnly: true,
    secure: config.cookie.secure,
    sameSite: config.cookie.sameSite,
    path: config.cookie.path,
  });
}

export function clearSessionCookie(config) {
  return serializeCookie(config.cookie.name, '', {
    maxAge: 0,
    expires: new Date(0),
    httpOnly: true,
    secure: config.cookie.secure,
    sameSite: config.cookie.sameSite,
    path: config.cookie.path,
  });
}

/**
 * 创建会话：cookie 里放明文 token，库里只存 sha256(token)。
 * 即使 D1 泄露，攻击者也无法反推出可用凭据（设计 §3.2）。
 */
export async function createSession(ctx, { userId, identityId, ip, userAgent }) {
  const now = Date.now();
  const token = randomToken(32);
  const sessionId = await sha256Hex(token);

  const expiresAt = now + ctx.config.session.absoluteMs;
  const idleExpiresAt = now + ctx.config.session.idleMs;

  await ctx.repos.sessions.insertStatement({
    id: sessionId,
    user_id: userId,
    identity_id: identityId ?? null,
    created_at: now,
    last_seen_at: now,
    expires_at: expiresAt,
    idle_expires_at: idleExpiresAt,
    user_agent: userAgent ? userAgent.slice(0, MAX_USER_AGENT_LENGTH) : null,
    ip_hash: await hashIp(ctx.config, ip),
  }).run();

  return {
    sessionId,
    token,
    cookie: sessionCookie(ctx.config, token),
    expiresAt,
    idleExpiresAt,
  };
}

/**
 * 解析并校验会话：绝对过期 + 滑动过期 + 撤销状态 + 账号状态。
 * 滑动过期每 5 分钟最多续一次，避免每个请求都写 D1。
 */
export async function resolveSession(ctx, token) {
  if (!token) return null;

  const sessionId = await sha256Hex(token);
  const row = await ctx.repos.sessions.findActiveWithUser(sessionId);
  if (!row) return null;

  const now = Date.now();
  const expired =
    row.revoked_at != null ||
    row.expires_at <= now ||
    row.idle_expires_at <= now ||
    row.deleted_at != null ||
    row.status !== 'active';

  if (expired) {
    if (row.revoked_at == null) {
      await ctx.repos.sessions.revoke(sessionId, now);
    }
    return null;
  }

  if (now - row.last_seen_at >= ctx.config.session.touchIntervalMs) {
    await ctx.repos.sessions.touch(sessionId, now, now + ctx.config.session.idleMs);
  }

  return {
    sessionId,
    identityId: row.identity_id,
    userId: row.id,
    expiresAt: row.expires_at,
    idleExpiresAt: Math.max(row.idle_expires_at, now + ctx.config.session.idleMs),
    user: {
      id: row.id,
      email: row.email,
      email_verified_at: row.email_verified_at,
      display_name: row.display_name,
      avatar_url: row.avatar_url,
      locale: row.locale,
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
      last_login_at: row.last_login_at,
      deleted_at: row.deleted_at,
    },
  };
}

export async function revokeSession(ctx, sessionId) {
  if (!sessionId) return;
  await ctx.repos.sessions.revoke(sessionId, Date.now());
}

export async function revokeAllSessions(ctx, userId, exceptSessionId = null) {
  await ctx.repos.sessions.revokeAllForUser(userId, Date.now(), exceptSessionId);
}
