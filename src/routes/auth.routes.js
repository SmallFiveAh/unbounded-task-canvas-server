import { Hono } from 'hono';
import { authController } from '../controllers/auth.controller.js';
import {
  emailOnlySchema,
  githubLinkSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from '../lib/validation.js';
import { requireAuth } from '../middleware/session.js';
import { validateJson } from '../middleware/validate.js';

export function authRoutes() {
  const router = new Hono();

  router.post('/register', validateJson(registerSchema), authController.register);
  router.post('/login', validateJson(loginSchema), authController.login);
  router.post('/logout', authController.logout);
  router.get('/session', authController.session);

  router.post('/verify-email', validateJson(verifyEmailSchema), authController.verifyEmail);
  router.post('/resend-verification', validateJson(emailOnlySchema), authController.resendVerification);
  router.post('/forgot-password', validateJson(emailOnlySchema), authController.forgotPassword);
  router.post('/reset-password', validateJson(resetPasswordSchema), authController.resetPassword);

  router.delete('/identities/:id', requireAuth(), authController.unlinkIdentity);

  router.get('/github/start', authController.githubStart);
  router.post('/github/link', requireAuth(), validateJson(githubLinkSchema), authController.githubLink);
  router.get('/github/callback', authController.githubCallback);

  return router;
}
