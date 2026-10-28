import {
  OAUTH_COOKIE_TTL_SECONDS,
  OAUTH_INTENT_COOKIE_NAME,
  OAUTH_STATE_COOKIE_NAME,
} from '../config/constants.js';
import { expireCookie, serializeCookie } from '../lib/cookies.js';
import { base64UrlDecode, base64UrlEncode, constantTimeEqual, randomToken } from '../lib/crypto.js';
import { conflict, badRequest, forbidden, unauthorized, unprocessable } from '../lib/errors.js';
import { exchangeCodeForToken, fetchGithubPrimaryEmail, fetchGithubProfile } from '../lib/github-client.js';
import { toUserDto } from '../lib/serializers.js';
import { uuidv7 } from '../lib/uuid.js';
import { createSession } from './session.service.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function cookieOptions(ctx) {
  return {
    maxAge: OAUTH_COOKIE_TTL_SECONDS,
    httpOnly: true,
    secure: ctx.config.cookie.secure,
    sameSite: 'Lax',
    path: '/',
  };
}

function expiredCookie(ctx, name) {
  return expireCookie(name, cookieOptions(ctx));
}

/** 供 controller 在回调失败时清理一次性 cookie */
export function clearOauthCookies(ctx) {
  return [
    expiredCookie(ctx, OAUTH_STATE_COOKIE_NAME),
    expiredCookie(ctx, OAUTH_INTENT_COOKIE_NAME),
  ];
}

/**
 * 只允许站内相对路径回跳，避免开放重定向。
 */
export function sanitizeRedirect(value, fallback = '/') {
  if (typeof value !== 'string') return fallback;
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return fallback;
  return value;
}

function encodeIntent(intent) {
  return base64UrlEncode(encoder.encode(JSON.stringify(intent)));
}

function decodeIntent(value) {
  try {
    const parsed = JSON.parse(decoder.decode(base64UrlDecode(value)));
    if (!parsed || typeof parsed !== 'object' || typeof parsed.mode !== 'string') return null;
    return {
      mode: parsed.mode === 'link' ? 'link' : 'login',
      userId: typeof parsed.userId === 'string' ? parsed.userId : null,
      redirect: sanitizeRedirect(parsed.redirect),
    };
  } catch {
    return null;
  }
}

function assertGithubConfigured(ctx) {
  if (!ctx.config.github.clientId || !ctx.config.github.clientSecret) {
    throw unprocessable('GITHUB_NOT_CONFIGURED', 'GitHub 登录尚未配置');
  }
}

/**
 * 发起 OAuth：state 防 CSRF，intent cookie 记录「登录还是绑定」以及回跳路径。
 */
export function beginGithubAuth(ctx, { mode = 'login', redirect = '/', userId = null } = {}) {
  assertGithubConfigured(ctx);

  const effectiveMode = mode === 'link' ? 'link' : 'login';
  if (effectiveMode === 'link' && !userId) {
    throw unauthorized('UNAUTHENTICATED', '绑定 GitHub 需要先登录');
  }

  const state = randomToken(32);
  const options = cookieOptions(ctx);

  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', ctx.config.github.clientId);
  url.searchParams.set('scope', ctx.config.github.scope);
  url.searchParams.set('state', state);
  url.searchParams.set('allow_signup', 'true');
  if (ctx.config.github.redirectUri) {
    url.searchParams.set('redirect_uri', ctx.config.github.redirectUri);
  }

  return {
    state,
    authorizeUrl: url.toString(),
    cookies: [
      serializeCookie(OAUTH_STATE_COOKIE_NAME, state, options),
      serializeCookie(
        OAUTH_INTENT_COOKIE_NAME,
        encodeIntent({ mode: effectiveMode, userId, redirect: sanitizeRedirect(redirect) }),
        options,
      ),
    ],
  };
}

function validateState(state, cookies) {
  const expected = cookies[OAUTH_STATE_COOKIE_NAME];
  if (!state || !expected || !constantTimeEqual(state, expected)) {
    throw badRequest('OAUTH_STATE_MISMATCH', '登录状态校验失败，请重新发起 GitHub 登录');
  }
}

async function linkGithubIdentity(ctx, { userId, profile, email, scope, now }) {
  const existing = await ctx.repos.identities.findByProviderUserId('github', profile.id);

  if (existing) {
    if (existing.user_id === userId) {
      await ctx.repos.identities.touchLastUsed(existing.id, now);
      return { identityId: existing.id, linked: true, alreadyLinked: true };
    }
    throw conflict('IDENTITY_ALREADY_LINKED', '该 GitHub 账号已绑定其他账号');
  }

  const identityId = uuidv7(now);
  await ctx.repos.identities.insertStatement({
    id: identityId,
    user_id: userId,
    provider: 'github',
    provider_user_id: profile.id,
    provider_email: email,
    provider_username: profile.login,
    scopes: scope,
    linked_at: now,
    last_used_at: now,
  }).run();

  ctx.logger.info('github.identity_linked', { userId, providerUserId: profile.id });
  return { identityId, linked: true, alreadyLinked: false };
}

/**
 * 登录态下的 GitHub 身份定位（设计 §3.4 的绑定矩阵）。
 */
async function resolveGithubLogin(ctx, { profile, email, scope, now }) {
  const existing = await ctx.repos.identities.findByProviderUserId('github', profile.id);

  if (existing) {
    const user = await ctx.repos.users.findById(existing.user_id);
    if (!user || user.deleted_at != null || user.status !== 'active') {
      throw forbidden('ACCOUNT_UNAVAILABLE', '账号当前不可用');
    }
    await ctx.repos.users.touchLastLogin(user.id, now);
    await ctx.repos.identities.touchLastUsed(existing.id, now);
    return { user, identityId: existing.id, autoLinked: false };
  }

  if (!email) {
    throw conflict(
      'GITHUB_EMAIL_REQUIRED',
      '未能获取已验证的 GitHub 邮箱，请在 GitHub 授权时允许访问邮箱',
    );
  }

  const userByEmail = await ctx.repos.users.findLiveByEmail(email);

  if (userByEmail) {
    if (userByEmail.email_verified_at == null) {
      // 防止「抢注未验证邮箱后接管账号」
      throw conflict('ACCOUNT_UNVERIFIED', '该邮箱尚未验证，请先用邮箱登录后再绑定 GitHub');
    }
    if (userByEmail.status !== 'active') {
      throw forbidden('ACCOUNT_UNAVAILABLE', '账号当前不可用');
    }

    const identityId = uuidv7(now);
    await ctx.repos.identities.insertStatement({
      id: identityId,
      user_id: userByEmail.id,
      provider: 'github',
      provider_user_id: profile.id,
      provider_email: email,
      provider_username: profile.login,
      scopes: scope,
      linked_at: now,
      last_used_at: now,
    }).run();
    await ctx.repos.users.touchLastLogin(userByEmail.id, now);

    // 审计：两个可信来源（GitHub + 已验证邮箱）指向同一人
    ctx.logger.info('github.identity_auto_linked', {
      userId: userByEmail.id,
      providerUserId: profile.id,
      email,
    });

    return { user: userByEmail, identityId, autoLinked: true };
  }

  const userId = uuidv7(now);
  const identityId = uuidv7(now);
  const displayName = profile.name?.trim() || profile.login || email.split('@')[0];

  await ctx.db.batch([
    ctx.repos.users.insertStatement({
      id: userId,
      email,
      email_verified_at: now, // GitHub 已证明邮箱归属
      display_name: displayName,
      avatar_url: profile.avatarUrl,
      locale: 'zh-CN',
      status: 'active',
      created_at: now,
      updated_at: now,
    }),
    ctx.repos.identities.insertStatement({
      id: identityId,
      user_id: userId,
      provider: 'github',
      provider_user_id: profile.id,
      provider_email: email,
      provider_username: profile.login,
      scopes: scope,
      linked_at: now,
      last_used_at: now,
    }),
  ]);

  const user = await ctx.repos.users.findById(userId);
  return { user, identityId, autoLinked: false };
}

/**
 * 处理 GitHub 回调。返回待设置的 cookie 与回跳路径，
 * HTTP 细节（302 / Set-Cookie）留给 controller。
 */
export async function completeGithubCallback(ctx, { code, state, cookies, meta }) {
  assertGithubConfigured(ctx);

  const intent = decodeIntent(cookies[OAUTH_INTENT_COOKIE_NAME]);
  validateState(state, cookies);

  if (!code) {
    throw badRequest('OAUTH_CODE_MISSING', 'GitHub 未返回授权码');
  }
  if (!intent) {
    throw badRequest('OAUTH_INTENT_MISSING', '登录会话已过期，请重新发起 GitHub 登录');
  }

  const { accessToken, scope } = await exchangeCodeForToken(ctx.config, code);
  const profile = await fetchGithubProfile(accessToken);
  const email = (await fetchGithubPrimaryEmail(accessToken, ctx.logger)) ?? profile.email?.toLowerCase() ?? null;

  const now = Date.now();
  const cookiesToClear = clearOauthCookies(ctx);

  if (intent.mode === 'link') {
    if (!ctx.auth || ctx.auth.userId !== intent.userId) {
      throw unauthorized('UNAUTHENTICATED', '绑定 GitHub 需要先登录');
    }

    const result = await linkGithubIdentity(ctx, {
      userId: ctx.auth.userId,
      profile,
      email,
      scope,
      now,
    });

    return {
      mode: 'link',
      user: toUserDto(ctx.auth.user),
      identityId: result.identityId,
      alreadyLinked: result.alreadyLinked,
      redirectTo: intent.redirect,
      cookiesToClear,
      cookie: null,
    };
  }

  const { user, identityId, autoLinked } = await resolveGithubLogin(ctx, {
    profile,
    email,
    scope,
    now,
  });

  const session = await createSession(ctx, {
    userId: user.id,
    identityId,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });

  return {
    mode: 'login',
    user: toUserDto(user),
    autoLinked,
    session,
    redirectTo: intent.redirect,
    cookiesToClear,
    cookie: session.cookie,
  };
}
