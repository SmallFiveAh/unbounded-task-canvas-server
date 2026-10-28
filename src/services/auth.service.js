import {
  EMAIL_TOKEN_MAX_ATTEMPTS,
  EMAIL_TOKEN_TTL_MS,
  LOGIN_MAX_ATTEMPTS,
  LOGIN_WINDOW_MS,
  RESEND_COOLDOWN_MS,
} from '../config/constants.js';
import { randomToken, sha256Hex } from '../lib/crypto.js';
import { normalizeEmail } from '../lib/email.js';
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
  tooManyRequests,
  unauthorized,
} from '../lib/errors.js';
import { assertPasswordStrength, DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from '../lib/passwords.js';
import { toIdentityDto, toUserDto } from '../lib/serializers.js';
import { secondsUntilWindowEnd, windowStart } from '../lib/time.js';
import { uuidv7 } from '../lib/uuid.js';
import { sendPasswordResetEmail, sendVerificationEmail } from './email.service.js';
import { createSession, revokeAllSessions, revokeSession } from './session.service.js';

const MIN_TOKEN_LENGTH = 16;

async function issueEmailToken(ctx, { userId, email, purpose, ip }) {
  const now = Date.now();
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);

  await ctx.repos.emailTokens.invalidateOutstanding(email, purpose, now);
  await ctx.repos.emailTokens.insertStatement({
    id: uuidv7(now),
    user_id: userId ?? null,
    email,
    purpose,
    token_hash: tokenHash,
    expires_at: now + EMAIL_TOKEN_TTL_MS[purpose],
    created_at: now,
    requested_ip_hash: ip ? await sha256Hex(`${ctx.config.security.ipHashSalt}:${ip}`) : null,
  }).run();

  return token;
}

async function consumeEmailToken(ctx, { token, purpose }) {
  if (typeof token !== 'string' || token.length < MIN_TOKEN_LENGTH) {
    throw badRequest('INVALID_TOKEN', '链接无效或已过期');
  }

  const now = Date.now();
  const row = await ctx.repos.emailTokens.findByHash(await sha256Hex(token));

  if (!row || row.purpose !== purpose) {
    throw badRequest('INVALID_TOKEN', '链接无效或已过期');
  }
  if (row.consumed_at != null) {
    throw badRequest('TOKEN_ALREADY_USED', '链接已被使用，请重新申请');
  }
  if (row.expires_at <= now) {
    throw badRequest('TOKEN_EXPIRED', '链接已过期，请重新申请');
  }
  if (row.attempts >= EMAIL_TOKEN_MAX_ATTEMPTS) {
    throw badRequest('TOKEN_LOCKED', '尝试次数过多，请重新申请');
  }

  const { meta } = await ctx.repos.emailTokens.consume(row.id, now);
  if (meta?.changes !== 1) {
    throw badRequest('TOKEN_ALREADY_USED', '链接已被使用，请重新申请');
  }

  return row;
}

/**
 * 注册：邮箱 + 密码。邮箱未验证前禁止登录（设计 §3.2）。
 */
export async function register(ctx, input) {
  const email = normalizeEmail(input.email);
  assertPasswordStrength(input.password);

  const existing = await ctx.repos.users.findLiveByEmail(email);
  if (existing) {
    throw conflict('EMAIL_TAKEN', '该邮箱已注册');
  }

  const now = Date.now();
  const userId = uuidv7(now);
  const identityId = uuidv7(now);
  const passwordHash = await hashPassword(input.password, {
    iterations: ctx.config.password.iterations,
  });
  const displayName = input.displayName?.trim() || email.split('@')[0];

  const verificationToken = randomToken(32);
  const tokenHash = await sha256Hex(verificationToken);

  const userRow = {
    id: userId,
    email,
    email_verified_at: null,
    display_name: displayName,
    avatar_url: null,
    locale: 'zh-CN',
    status: 'active',
    created_at: now,
    updated_at: now,
  };

  try {
    await ctx.db.batch([
      ctx.repos.users.insertStatement(userRow),
      ctx.repos.identities.insertStatement({
        id: identityId,
        user_id: userId,
        provider: 'email',
        provider_user_id: email,
        provider_email: email,
        password_hash: passwordHash,
        linked_at: now,
      }),
      ctx.repos.emailTokens.insertStatement({
        id: uuidv7(now),
        user_id: userId,
        email,
        purpose: 'verify_email',
        token_hash: tokenHash,
        expires_at: now + EMAIL_TOKEN_TTL_MS.verify_email,
        created_at: now,
      }),
    ]);
  } catch (error) {
    if (String(error?.message ?? '').includes('UNIQUE')) {
      throw conflict('EMAIL_TAKEN', '该邮箱已注册');
    }
    throw error;
  }

  const emailSent = await sendVerificationEmail(ctx, { email, token: verificationToken });

  return {
    user: toUserDto(userRow),
    verification: {
      sent: emailSent,
      required: true,
      // 仅开发环境（console 通道）返回，便于本地联调
      ...(ctx.config.email.provider === 'console' && !ctx.config.isProduction
        ? { devToken: verificationToken }
        : {}),
    },
  };
}

async function recordLoginFailure(ctx, emailBucket, ipBucket, now) {
  const start = windowStart(now, LOGIN_WINDOW_MS);
  await Promise.all([
    ctx.repos.loginAttempts.increment(emailBucket, start),
    ipBucket ? ctx.repos.loginAttempts.increment(ipBucket, start) : Promise.resolve(),
  ]);
}

/**
 * 登录：邮箱桶 + IP 桶双限流，失败统一返回模糊错误码。
 */
export async function login(ctx, input, meta) {
  const email = normalizeEmail(input.email);
  const now = Date.now();
  const start = windowStart(now, LOGIN_WINDOW_MS);
  const emailBucket = `email:${await sha256Hex(email)}`;
  const ipBucket = meta.ip && meta.ip !== 'unknown' ? `ip:${await sha256Hex(meta.ip)}` : null;

  const [emailAttempts, ipAttempts] = await Promise.all([
    ctx.repos.loginAttempts.count(emailBucket, start),
    ipBucket ? ctx.repos.loginAttempts.count(ipBucket, start) : Promise.resolve(0),
  ]);

  if (emailAttempts >= LOGIN_MAX_ATTEMPTS || ipAttempts >= LOGIN_MAX_ATTEMPTS) {
    throw tooManyRequests(
      'LOGIN_RATE_LIMITED',
      '登录尝试过于频繁，请稍后再试',
      { retryAfter: secondsUntilWindowEnd(now, LOGIN_WINDOW_MS) },
      { 'Retry-After': String(secondsUntilWindowEnd(now, LOGIN_WINDOW_MS)) },
    );
  }

  const user = await ctx.repos.users.findLiveByEmail(email);
  if (!user) {
    await verifyPassword(input.password, DUMMY_PASSWORD_HASH);
    await recordLoginFailure(ctx, emailBucket, ipBucket, now);
    throw unauthorized('INVALID_CREDENTIALS', '邮箱或密码错误');
  }

  const identity = await ctx.repos.identities.findByProviderUserId('email', email);
  if (!identity?.password_hash) {
    await verifyPassword(input.password, DUMMY_PASSWORD_HASH);
    await recordLoginFailure(ctx, emailBucket, ipBucket, now);
    throw unauthorized('INVALID_CREDENTIALS', '邮箱或密码错误');
  }

  const passwordValid = await verifyPassword(input.password, identity.password_hash);
  if (!passwordValid) {
    await recordLoginFailure(ctx, emailBucket, ipBucket, now);
    throw unauthorized('INVALID_CREDENTIALS', '邮箱或密码错误');
  }

  if (user.email_verified_at == null) {
    throw forbidden('EMAIL_NOT_VERIFIED', '请先完成邮箱验证');
  }
  if (user.status !== 'active') {
    throw forbidden('ACCOUNT_UNAVAILABLE', '账号当前不可用');
  }

  await ctx.repos.loginAttempts.clear(emailBucket);
  await ctx.repos.users.touchLastLogin(user.id, now);
  await ctx.repos.identities.touchLastUsed(identity.id, now);

  const session = await createSession(ctx, {
    userId: user.id,
    identityId: identity.id,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });

  return {
    user: toUserDto({ ...user, last_login_at: now, updated_at: now }),
    session,
  };
}

export async function logout(ctx) {
  if (ctx.auth) {
    await revokeSession(ctx, ctx.auth.sessionId);
  }
}

export async function verifyEmail(ctx, { token }) {
  const row = await consumeEmailToken(ctx, { token, purpose: 'verify_email' });

  let userId = row.user_id;
  if (!userId) {
    const user = await ctx.repos.users.findLiveByEmail(row.email);
    userId = user?.id ?? null;
  }
  if (!userId) {
    throw notFound('USER_NOT_FOUND', '账号不存在');
  }

  await ctx.repos.users.markEmailVerified(userId, Date.now());
  return { verified: true, email: row.email };
}

/**
 * 重发验证邮件：60 秒冷却；无论邮箱是否存在都返回 202，避免枚举账号。
 */
export async function resendVerification(ctx, { email }, meta) {
  const normalized = normalizeEmail(email);
  const user = await ctx.repos.users.findLiveByEmail(normalized);

  if (!user || user.email_verified_at != null) {
    return { accepted: true };
  }

  const now = Date.now();
  const latest = await ctx.repos.emailTokens.findLatest(normalized, 'verify_email');
  if (latest && now - latest.created_at < RESEND_COOLDOWN_MS) {
    throw tooManyRequests(
      'RESEND_COOLDOWN',
      '验证邮件刚发送过，请稍后再试',
      { retryAfter: Math.ceil((RESEND_COOLDOWN_MS - (now - latest.created_at)) / 1000) },
    );
  }

  const token = await issueEmailToken(ctx, {
    userId: user.id,
    email: normalized,
    purpose: 'verify_email',
    ip: meta.ip,
  });
  await sendVerificationEmail(ctx, { email: normalized, token });

  return {
    accepted: true,
    ...(ctx.config.email.provider === 'console' && !ctx.config.isProduction ? { devToken: token } : {}),
  };
}

/**
 * 忘记密码：永远返回 202，真实发送逻辑对未注册邮箱静默跳过。
 */
export async function forgotPassword(ctx, { email }, meta) {
  const normalized = normalizeEmail(email);
  const user = await ctx.repos.users.findLiveByEmail(normalized);

  if (!user || user.email_verified_at == null) {
    return { accepted: true };
  }

  const token = await issueEmailToken(ctx, {
    userId: user.id,
    email: normalized,
    purpose: 'reset_password',
    ip: meta.ip,
  });
  await sendPasswordResetEmail(ctx, { email: normalized, token });

  return {
    accepted: true,
    ...(ctx.config.email.provider === 'console' && !ctx.config.isProduction ? { devToken: token } : {}),
  };
}

export async function resetPassword(ctx, { token, password }) {
  assertPasswordStrength(password);

  const row = await consumeEmailToken(ctx, { token, purpose: 'reset_password' });
  const user = row.user_id
    ? await ctx.repos.users.findById(row.user_id)
    : await ctx.repos.users.findLiveByEmail(row.email);

  if (!user || user.deleted_at != null) {
    throw notFound('USER_NOT_FOUND', '账号不存在');
  }

  const identity = await ctx.repos.identities.findByProviderUserId('email', row.email);
  if (!identity) {
    throw badRequest('IDENTITY_NOT_FOUND', '该邮箱未绑定密码登录方式');
  }

  const now = Date.now();
  const passwordHash = await hashPassword(password, { iterations: ctx.config.password.iterations });

  await ctx.repos.identities.updatePassword(identity.id, passwordHash, now);
  // 改密后撤销全部会话，强制重新登录
  await revokeAllSessions(ctx, user.id);
  await ctx.repos.users.touchUpdatedAt(user.id, now);

  return { reset: true };
}

/**
 * 解绑登录方式：必须保留最后一种，否则账号会失去登录入口（设计 §3.4）。
 */
export async function unlinkIdentity(ctx, identityId) {
  const identity = await ctx.repos.identities.findById(identityId);
  if (!identity || identity.user_id !== ctx.userId) {
    throw notFound('IDENTITY_NOT_FOUND', '登录方式不存在');
  }

  const total = await ctx.repos.identities.countByUser(ctx.userId);
  if (total <= 1) {
    throw conflict('LAST_IDENTITY', '至少保留一种登录方式');
  }

  await ctx.repos.identities.deleteByIdForUser(identityId, ctx.userId);
  return { unlinked: true };
}

export async function getProfile(ctx) {
  const identities = await ctx.repos.identities.listByUser(ctx.userId);
  return {
    user: toUserDto(ctx.auth.user),
    identities: identities.map(toIdentityDto),
  };
}
