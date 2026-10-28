import { AppError } from '../lib/errors.js';
import { documentsRepo } from './documents.repo.js';
import { emailTokensRepo } from './email-tokens.repo.js';
import { identitiesRepo } from './identities.repo.js';
import { importsRepo } from './imports.repo.js';
import { loginAttemptsRepo } from './login-attempts.repo.js';
import { revisionsRepo } from './revisions.repo.js';
import { sessionsRepo } from './sessions.repo.js';
import { tasksRepo } from './tasks.repo.js';
import { usersRepo } from './users.repo.js';

/**
 * 数据访问层统一入口。所有 SQL 只允许出现在 repositories/ 下，
 * 路由与服务层不得直接拼 SQL（设计 §3.5「越权」）。
 */
export function createRepositories(db) {
  if (!db || typeof db.prepare !== 'function') {
    throw new AppError({
      status: 500,
      code: 'DATABASE_NOT_CONFIGURED',
      message: 'D1 数据库绑定 DB 未配置',
    });
  }

  return {
    users: usersRepo(db),
    identities: identitiesRepo(db),
    sessions: sessionsRepo(db),
    emailTokens: emailTokensRepo(db),
    loginAttempts: loginAttemptsRepo(db),
    tasks: tasksRepo(db),
    documents: documentsRepo(db),
    revisions: revisionsRepo(db),
    imports: importsRepo(db),
  };
}
