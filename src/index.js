import { createApp } from './app.js';

/**
 * Cloudflare Worker 入口。
 * 全部业务逻辑在 app.js / 分层模块中，这里只负责导出 fetch handler。
 */
const app = createApp();

export default app;
