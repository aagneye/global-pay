import { jsonSchemaTransformObject } from 'fastify-type-provider-zod';

type TransformObject = typeof jsonSchemaTransformObject;
type Document = ReturnType<TransformObject>;

/**
 * Builds `components.schemas` from the zod schemas that have an `id`, like `jsonSchemaTransformObject`,
 * then tidies it for client generators:
 * - drops schemas no route uses (the library adds both an input and an output form of every one);
 * - names a request-only schema `X` rather than `XInput`.
 */
export const namedSchemasTransform: TransformObject = (input) => tidyComponents(jsonSchemaTransformObject(input));

export function tidyComponents(document: Document): Document {
  const { components } = document as { components?: { schemas?: Record<string, unknown> } };
  const schemas = components?.schemas ?? {};

  // Everything reachable from the paths, following refs through components.
  const used = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') {
        const name = value.replace('#/components/schemas/', '');
        if (!used.has(name)) {
          used.add(name);
          visit(schemas[name]);
        }
      } else {
        visit(value);
      }
    }
  };
  visit(document.paths);

  const renames = new Map<string, string>();
  for (const name of used) {
    const plain = name.replace(/Input$/, '');
    if (plain !== name && !used.has(plain)) renames.set(name, plain);
  }

  const tidied: Record<string, unknown> = {};
  for (const name of Object.keys(schemas).sort()) {
    if (used.has(name)) tidied[renames.get(name) ?? name] = schemas[name];
  }
  const rewrite = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(rewrite);
    if (!node || typeof node !== 'object') return node;
    return Object.fromEntries(
      Object.entries(node).map(([key, value]) => {
        if (key === '$ref' && typeof value === 'string') {
          const name = value.replace('#/components/schemas/', '');
          return [key, `#/components/schemas/${renames.get(name) ?? name}`];
        }
        return [key, rewrite(value)];
      }),
    );
  };

  return rewrite({
    ...document,
    components: { ...components, schemas: tidied },
  }) as Document;
}
