import { badGateway } from '../lib/errors.js';

/**
 * 邮件通道适配器。开发环境（console）只打印链接，不真正发信；
 * 生产可切换 Resend 或 MailChannels。
 */
export async function sendMail(config, logger, message) {
  const provider = config.email.provider;

  if (provider === 'console') {
    logger.info('email.console', {
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
    return { delivered: false, provider };
  }

  if (provider === 'resend') {
    if (!config.email.resendApiKey) {
      throw badGateway('EMAIL_NOT_CONFIGURED', 'RESEND_API_KEY 未配置');
    }

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.email.resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: config.email.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        html: message.html,
      }),
    });

    if (!response.ok) {
      logger.error('email.resend_failed', { status: response.status });
      throw badGateway('EMAIL_DELIVERY_FAILED', '邮件发送失败，请稍后重试');
    }
    return { delivered: true, provider };
  }

  if (provider === 'mailchannels') {
    const response = await fetch('https://api.mailchannels.net/tx/v1/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: message.to }] }],
        from: { email: config.email.from, name: '无限任务画布' },
        subject: message.subject,
        content: [
          { type: 'text/plain', value: message.text },
          { type: 'text/html', value: message.html },
        ],
      }),
    });

    if (!response.ok) {
      logger.error('email.mailchannels_failed', { status: response.status });
      throw badGateway('EMAIL_DELIVERY_FAILED', '邮件发送失败，请稍后重试');
    }
    return { delivered: true, provider };
  }

  throw badGateway('EMAIL_PROVIDER_UNKNOWN', `未知的邮件通道：${provider}`);
}
