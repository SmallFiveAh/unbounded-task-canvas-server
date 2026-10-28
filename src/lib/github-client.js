import { badGateway } from './errors.js';

const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_API_BASE = 'https://api.github.com';
const USER_AGENT = 'unbounded-task-canvas';
const REQUEST_TIMEOUT_MS = 10000;

function headers(accessToken) {
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': USER_AGENT,
    'X-GitHub-Api-Version': '2022-11-28',
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  };
}

async function request(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch {
    throw badGateway('GITHUB_UPSTREAM_ERROR', 'GitHub 服务暂时不可用');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 服务端换码：client_secret 只存在于 Worker（设计 §3.3）。
 */
export async function exchangeCodeForToken(config, code) {
  const body = new URLSearchParams({
    client_id: config.github.clientId,
    client_secret: config.github.clientSecret,
    code,
    ...(config.github.redirectUri ? { redirect_uri: config.github.redirectUri } : {}),
  });

  const response = await request(GITHUB_TOKEN_URL, {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    throw badGateway('GITHUB_TOKEN_EXCHANGE_FAILED', 'GitHub 授权失败，请重试');
  }

  return { accessToken: payload.access_token, scope: payload.scope ?? '' };
}

export async function fetchGithubProfile(accessToken) {
  const response = await request(`${GITHUB_API_BASE}/user`, { headers: headers(accessToken) });
  if (!response.ok) {
    throw badGateway('GITHUB_PROFILE_FAILED', '读取 GitHub 用户信息失败');
  }

  const profile = await response.json();
  return {
    id: String(profile.id),
    login: profile.login ?? '',
    name: profile.name ?? '',
    avatarUrl: profile.avatar_url ?? null,
    email: profile.email ?? null,
  };
}

/**
 * 取 primary + verified 邮箱。拿不到（未授权 user:email 或邮箱私有）时返回 null，
 * 由上层决定「拒绝自动绑定」而不是猜测。
 */
export async function fetchGithubPrimaryEmail(accessToken, logger) {
  const response = await request(`${GITHUB_API_BASE}/user/emails`, { headers: headers(accessToken) });
  if (!response.ok) {
    logger?.warn('github.emails_unavailable', { status: response.status });
    return null;
  }

  const emails = await response.json().catch(() => []);
  if (!Array.isArray(emails)) return null;

  const primary = emails.find((item) => item.primary && item.verified);
  if (primary) return primary.email.toLowerCase();

  const verified = emails.find((item) => item.verified);
  return verified ? verified.email.toLowerCase() : null;
}
