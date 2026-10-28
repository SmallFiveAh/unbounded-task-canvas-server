import { z } from 'zod';
import {
  MAX_IMPORT_ITEMS,
  MAX_PAGE_SIZE,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  TASK_CATEGORIES,
  TASK_STATUSES,
} from '../config/constants.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .refine((value) => EMAIL_PATTERN.test(value), { message: '邮箱格式不正确' });

export const passwordSchema = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);

const displayNameSchema = z.string().trim().max(60);

const jsonObjectSchema = z.record(z.any());

const viewSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    scale: z.number().finite(),
  })
  .strict()
  .nullable();

const documentContentSchema = z.object({
  version: z.number().int().min(1).max(1000).optional(),
  nodes: z.array(jsonObjectSchema).max(5000).optional(),
  edges: z.array(jsonObjectSchema).max(20000).optional(),
  tables: z.array(jsonObjectSchema).max(2000).optional(),
  view: viewSchema.optional(),
  updatedAt: z.number().int().nonnegative().optional(),
});

/* ----------------------------------------------------------------- */
/* 认证                                                              */
/* ----------------------------------------------------------------- */

export const registerSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    displayName: displayNameSchema.optional(),
  })
  .strict();

export const loginSchema = z
  .object({
    email: emailSchema,
    password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  })
  .strict();

export const verifyEmailSchema = z.object({ token: z.string().min(16).max(512) }).strict();

export const emailOnlySchema = z.object({ email: emailSchema }).strict();

export const resetPasswordSchema = z
  .object({ token: z.string().min(16).max(512), password: passwordSchema })
  .strict();

export const githubLinkSchema = z.object({ redirect: z.string().max(512).optional() }).strict();

/* ----------------------------------------------------------------- */
/* 任务                                                              */
/* ----------------------------------------------------------------- */

export const taskListQuerySchema = z
  .object({
    category: z.enum(TASK_CATEGORIES).optional(),
    status: z.enum(TASK_STATUSES).optional(),
    q: z.string().trim().max(100).optional(),
    cursor: z.string().max(512).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(20),
  })
  .strict();

export const taskCreateSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    category: z.enum(TASK_CATEGORIES).default('work'),
    status: z.enum(TASK_STATUSES).default('todo'),
    progress: z.number().int().min(0).max(100).default(0),
    legacyId: z.string().trim().min(1).max(64).nullish(),
  })
  .strict();

export const taskUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    category: z.enum(TASK_CATEGORIES).optional(),
    status: z.enum(TASK_STATUSES).optional(),
    progress: z.number().int().min(0).max(100).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: '至少需要修改一个字段' });

/* ----------------------------------------------------------------- */
/* 画布文档                                                          */
/* ----------------------------------------------------------------- */

export const documentSchema = z
  .object({
    version: z.number().int().min(1).max(1000).optional(),
    nodes: z.array(jsonObjectSchema).max(5000),
    edges: z.array(jsonObjectSchema).max(20000),
    tables: z.array(jsonObjectSchema).max(2000),
    view: viewSchema.optional(),
    updatedAt: z.number().int().nonnegative().optional(),
    deviceId: z.string().trim().max(64).optional(),
  })
  .strict();

/* ----------------------------------------------------------------- */
/* 迁移                                                              */
/* ----------------------------------------------------------------- */

const localTimeSchema = z.union([z.number().int().nonnegative(), z.string().trim().max(32)]);

const localTaskSchema = z
  .object({
    title: z.string().trim().max(200).optional(),
    category: z.enum(TASK_CATEGORIES).optional(),
    status: z.string().trim().max(20).optional(),
    progress: z.number().int().min(0).max(100).optional(),
    updatedAt: localTimeSchema.optional(),
  })
  .strict();

const localDocumentSchema = documentContentSchema
  .extend({ updatedAt: localTimeSchema.optional() })
  .strict();

const migrateItemSchema = z
  .object({
    localKey: z.string().trim().min(1).max(200),
    task: localTaskSchema.nullish(),
    document: localDocumentSchema.nullish(),
  })
  .strict();

export { migrateItemSchema };

export const migrateImportSchema = z
  .object({
    clientId: z.string().trim().min(1).max(64),
    source: z.string().trim().max(32).optional(),
    // 逐条在服务层校验：单条存档损坏只跳过该条，不阻断整批（设计 §6.7）
    items: z.array(z.unknown()).min(1).max(MAX_IMPORT_ITEMS),
  })
  .strict();

/** 把 ZodError 压成前端友好的字段级错误 */
export function formatZodIssues(error) {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
}
