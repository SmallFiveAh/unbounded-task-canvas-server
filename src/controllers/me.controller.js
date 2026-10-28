import { getProfile } from '../services/auth.service.js';

export const meController = {
  async get(c) {
    const profile = await getProfile(c.get('ctx'));
    return c.json(profile);
  },
};
