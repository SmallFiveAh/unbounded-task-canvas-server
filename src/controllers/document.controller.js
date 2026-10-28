import { matchesEtag, requireBaseRevision, revisionEtag } from '../lib/http.js';
import { getDocument, putDocument } from '../services/document.service.js';

const DOCUMENT_CACHE_CONTROL = 'no-cache, must-revalidate';

export const documentController = {
  /** GET /api/tasks/:id/document —— 支持 ETag + If-None-Match */
  async get(c) {
    const ctx = c.get('ctx');
    const { document, revision } = await getDocument(ctx, c.req.param('id'));

    c.header('ETag', revisionEtag(revision));
    c.header('Cache-Control', DOCUMENT_CACHE_CONTROL);

    if (matchesEtag(c.req.header('If-None-Match'), revision)) {
      return c.body(null, 304);
    }

    return c.json(document);
  },

  /** PUT /api/tasks/:id/document —— 必须携带 If-Match 乐观锁版本 */
  async put(c) {
    const ctx = c.get('ctx');
    const baseRevision = requireBaseRevision(c.req.header('If-Match'));
    const result = await putDocument(ctx, c.req.param('id'), baseRevision, c.get('body'));

    c.header('ETag', revisionEtag(result.revision));
    c.header('Cache-Control', DOCUMENT_CACHE_CONTROL);

    return c.json(result);
  },
};
