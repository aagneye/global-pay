import type { PageCursor } from '../ports/repositories.js';

/**
 * Walks a list in pages across ticks: each tick takes the `limit` items after where the previous one
 * stopped, and starts over once it reaches the end. Items that can't move yet then never keep the rest
 * waiting, however many of them there are.
 */
export class RoundRobin<T> {
  private cursor: PageCursor | undefined;

  constructor(private readonly key: (item: T) => PageCursor) {}

  async next(limit: number, fetch: (after: PageCursor | undefined) => Promise<T[]>): Promise<T[]> {
    let page = await fetch(this.cursor);
    if (page.length === 0 && this.cursor) page = await fetch(undefined);
    const last = page.at(-1);
    this.cursor = page.length >= limit && last ? this.key(last) : undefined;
    return page;
  }
}
