import { sendMail } from '../lib/mailer.js';

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function deliver(ctx, message) {
  try {
    const result = await sendMail(ctx.config, ctx.logger, message);
    return result.delivered;
  } catch (error) {
    // 注册 / 找回密码不应因为邮件通道故障而整体失败
    ctx.logger.warn('email.delivery_failed', { code: error.code ?? 'UNKNOWN', to: message.to });
    return false;
  }
}

export async function sendVerificationEmail(ctx, { email, token }) {
  const link = `${ctx.config.appOrigin}/verify-email?token=${encodeURIComponent(token)}`;

  return deliver(ctx, {
    to: email,
    subject: '验证你的邮箱 · 无限任务画布',
    text: `欢迎使用无限任务画布。\n\n请点击以下链接验证邮箱（24 小时内有效）：\n${link}\n\n如果不是你本人操作，请忽略本邮件。`,
    html: `<p>欢迎使用无限任务画布。</p><p>请点击以下链接验证邮箱（24 小时内有效）：</p><p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p><p>如果不是你本人操作，请忽略本邮件。</p>`,
  });
}

export async function sendPasswordResetEmail(ctx, { email, token }) {
  const link = `${ctx.config.appOrigin}/reset-password?token=${encodeURIComponent(token)}`;

  return deliver(ctx, {
    to: email,
    subject: '重置密码 · 无限任务画布',
    text: `我们收到了重置密码的请求。\n\n请在 15 分钟内打开以下链接完成重置：\n${link}\n\n如果不是你本人操作，请忽略本邮件，你的密码不会改变。`,
    html: `<p>我们收到了重置密码的请求。</p><p>请在 15 分钟内打开以下链接完成重置：</p><p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p><p>如果不是你本人操作，请忽略本邮件，你的密码不会改变。</p>`,
  });
}
