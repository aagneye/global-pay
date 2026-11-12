import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SPEC_PATH, renderOpenApi } from '../scripts/export-openapi.js';
import { tidyComponents } from '../src/shared/openapi.js';

describe('packages/openapi/openapi.json', () => {
  it('matches the routes (run `npm run openapi` after changing one)', async () => {
    expect(readFileSync(SPEC_PATH, 'utf8')).toBe(await renderOpenApi());
  });

  it('gives every operation an ID and every schema a plain name', async () => {
    const spec = JSON.parse(await renderOpenApi());
    const operations = Object.values(spec.paths).flatMap((ops) => Object.values(ops as object));
    const ids = operations.map((op: { operationId?: string }) => op.operationId);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Object.keys(spec.components.schemas).filter((name) => name.endsWith('Input'))).toEqual([]);
  });
});

describe('tidyComponents', () => {
  it('drops unused schemas and renames request-only ones', () => {
    const tidied = tidyComponents({
      paths: {
        '/a': {
          post: {
            requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/AInput' } } } },
            responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/B' } } } } },
          },
        },
      },
      components: {
        schemas: {
          AInput: { type: 'object', properties: { c: { $ref: '#/components/schemas/CInput' } } },
          A: { type: 'object' },
          B: { type: 'object' },
          BInput: { type: 'object' },
          CInput: { type: 'string' },
        },
      },
    } as never) as { components: { schemas: Record<string, unknown> }; paths: unknown };

    expect(Object.keys(tidied.components.schemas)).toEqual(['A', 'B', 'C']);
    expect(JSON.stringify(tidied)).not.toContain('Input');
  });
});
