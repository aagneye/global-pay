import type { PageCursor } from '../../ports/repositories.js';

/** `where` for rows after `after` in (createdAt, id) order: how the workers page through a list. */
export function afterCursor(after: PageCursor | undefined) {
  return after ? { OR: [{ createdAt: { gt: after.createdAt } }, { createdAt: after.createdAt, id: { gt: after.id } }] } : {};
}
