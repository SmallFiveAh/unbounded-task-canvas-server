/**
 * 结构化日志：Workers 的 console 输出即日志，统一 JSON 方便检索。
 * 严禁把 Cookie、Authorization、密码、token 写入日志。
 */
export function createLogger({ requestId, environment = 'development' } = {}) {
  const write = (level, message, fields = {}) => {
    const payload = {
      level,
      message,
      requestId,
      environment,
      time: new Date().toISOString(),
      ...fields,
    };
    const line = JSON.stringify(payload);
    if (level === 'error') {
      console.error(line);
    } else if (level === 'warn') {
      console.warn(line);
    } else {
      console.log(line);
    }
  };

  return {
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
  };
}
