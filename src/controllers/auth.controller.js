import { OAUTH_INTENT_COOKIE_NAME, OAUTH_STATE_COOKIE_NAME } from '../config/constants.js';
import { appendCookie, expireCookie, parseCookieHeader } from '../lib/cookies.js';
import { unauthorized } from '../lib/errors.js';
import { requestMeta } from '../lib/http.js';
import { toSessionDto, toUserDto } from '../lib/serializers.js';
import * as authService from '../services/auth.service.js';
import * as githubService from '../services/github.service.js';
import { clearSessionCookie } from '../services/session.service.js';

function oauthCookieOptions(ctx) {
  return {
    maxAge: 0,
    expires: new Date(0),
    httpOnly: true,
    secure: ctx.config.cookie.secure,
    sameSite: 'Lax',
    path: '/',
  };
}

export const authController = {
  async register(c) {
    const ctx = c.get('ctx');
    const result = await authService.register(ctx, c.get('body'));
    return c.json(result, 201);
  },

  async login(c) {
    const ctx = c.get('ctx');
    const { user, session } = await authService.login(ctx, c.get('body'), requestMeta(c));
    appendCookie(c, session.cookie);
    return c.json({
      user,
      session: { expiresAt: session.expiresAt, idleExpiresAt: session.idleExpiresAt },
    });
  },

  async logout(c) {
    const ctx = c.get('ctx');
    await authService.logout(ctx);
    appendCookie(c, clearSessionCookie(ctx.config));
    return c.body(null, 204);
  },

  async session(c) {
    const ctx = c.get('ctx');
    if (!ctx.auth) {
      throw unauthorized('UNAUTHENTICATED', '未登录');
    }
    return c.json({
      user: toUserDto(ctx.auth.user),
      session: toSessionDto(ctx.auth),
    });
  },

  async verifyEmail(c) {
    return c.json(await authService.verifyEmail(c.get('ctx'), c.get('body')));
  },

  async resendVerification(c) {
    const result = await authService.resendVerification(c.get('ctx'), c.get('body'), requestMeta(c));
    return c.json(result, 202);
  },

  async forgotPassword(c) {
    const result = await authService.forgotPassword(c.get('ctx'), c.get('body'), requestMeta(c));
    return c.json(result, 202);
  },

  async resetPassword(c) {
    return c.json(await authService.resetPassword(c.get('ctx'), c.get('body')));
  },

  async unlinkIdentity(c) {
    const ctx = c.get('ctx');
    return c.json(await authService.unlinkIdentity(ctx, c.req.param('id')));
  },

  /** GET /api/auth/github/start —— 浏览器整页跳转 */
  async githubStart(c) {
    const ctx = c.get('ctx');
    const mode = c.req.query('mode') === 'link' ? 'link' : 'login';

    if (mode === 'link' && !ctx.auth) {
      throw unauthorized('UNAUTHENTICATED', '绑定 GitHub 需要先登录');
    }

    const started = githubService.beginGithubAuth(ctx, {
      mode,
      redirect: c.req.query('redirect') ?? '/',
      userId: ctx.userId,
    });

    for (const cookie of started.cookies) {
      appendCookie(c, cookie);
    }

    return c.redirect(started.authorizeUrl, 302);
  },

  /** POST /api/auth/github/link —— SPA 先拿授权地址，再自行跳转 */
  async githubLink(c) {
    const ctx = c.get('ctx');
    const started = githubService.beginGithubAuth(ctx, {
      mode: 'link',
      redirect: c.get('body').redirect ?? '/',
      userId: ctx.userId,
    });

    for (const cookie of started.cookies) {
      appendCookie(c, cookie);
    }

    return c.json({ authorizeUrl: started.authorizeUrl, expiresIn: 600 });
  },

  /** GET /api/auth/github/callback —— 设置会话后回跳前端 */
  async githubCallback(c) {
    const ctx = c.get('ctx');
    const cookies = parseCookieHeader(c.req.header('Cookie'));

    try {
      const result = await githubService.completeGithubCallback(ctx, {
        code: c.req.query('code'),
        state: c.req.query('state'),
        cookies,
        meta: requestMeta(c),
      });

      for (const cookie of result.cookiesToClear) {
        appendCookie(c, cookie);
      }
      if (result.cookie) {
        appendCookie(c, result.cookie);
      }

      const target = new URL(result.redirectTo ?? '/', ctx.config.appOrigin);
      return c.redirect(target.toString(), 302);
    } catch (error) {
      const options = oauthCookieOptions(ctx);
      appendCookie(c, expireCookie(OAUTH_STATE_COOKIE_NAME, options));
      appendCookie(c, expireCookie(OAUTH_INTENT_COOKIE_NAME, options));

      // 4xx（state / code / intent 非法）按 API 错误返回，便于排查；5xx 上游故障回跳前端
      if (error?.status && error.status < 500) {
        throw error;
      }

      const code = error?.code ?? 'OAUTH_FAILED';
      ctx.logger.warn('github.callback_failed', { code, message: error?.message });

      const target = new URL('/login', ctx.config.appOrigin);
      target.searchParams.set('error', code);
      return c.redirect(target.toString(), 302);
    }
  },
};
