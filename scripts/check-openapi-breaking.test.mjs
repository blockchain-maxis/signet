import assert from 'node:assert/strict';
import test from 'node:test';
import { findBreakingChanges } from './check-openapi-breaking.mjs';

function createBaseSpec() {
  return {
    openapi: '3.1.0',
    info: { title: 'Signet API', version: '1.0.0' },
    paths: {
      '/profiles/{handle}': {
        get: {
          operationId: 'getProfile',
          parameters: [
            {
              name: 'handle',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
            {
              name: 'includeArchived',
              in: 'query',
              required: false,
              schema: { type: 'boolean' },
            },
          ],
          responses: {
            200: {
              description: 'Profile response',
              content: {
                'application/json': {
                  schema: {
                    $ref: '#/components/schemas/Profile',
                  },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Profile: {
          type: 'object',
          required: ['handle', 'role'],
          properties: {
            handle: { type: 'string' },
            role: {
              type: 'string',
              enum: ['user', 'admin'],
            },
            bio: { type: 'string' },
          },
        },
      },
    },
  };
}

test('adding an optional field passes', () => {
  const base = createBaseSpec();
  const head = structuredClone(base);

  // Add optional field to schema
  head.components.schemas.Profile.properties.avatarUrl = {
    type: 'string',
    format: 'uri',
  };

  // Add optional request parameter
  head.paths['/profiles/{handle}'].get.parameters.push({
    name: 'details',
    in: 'query',
    required: false,
    schema: { type: 'boolean' },
  });

  const breaking = findBreakingChanges(base, head);
  assert.equal(breaking.length, 0, `Expected 0 breaking changes, got: ${JSON.stringify(breaking)}`);
});

test('removing a field fails', () => {
  const base = createBaseSpec();
  const head = structuredClone(base);

  // Remove bio property
  delete head.components.schemas.Profile.properties.bio;

  const breaking = findBreakingChanges(base, head);
  assert.ok(breaking.length > 0, 'Expected breaking changes when removing a field');
  assert.ok(
    breaking.some((b) => b.includes('Removed response property "bio"')),
    `Unexpected error messages: ${JSON.stringify(breaking)}`,
  );
});

test('changing string to number fails', () => {
  const base = createBaseSpec();
  const head = structuredClone(base);

  // Change type from string to number
  head.components.schemas.Profile.properties.bio.type = 'number';

  const breaking = findBreakingChanges(base, head);
  assert.ok(breaking.length > 0, 'Expected breaking changes when changing type');
  assert.ok(
    breaking.some((b) => b.includes('Changed property type')),
    `Unexpected error messages: ${JSON.stringify(breaking)}`,
  );
});

test('adding an endpoint passes', () => {
  const base = createBaseSpec();
  const head = structuredClone(base);

  // Add a new endpoint
  head.paths['/profiles/{handle}/wallets'] = {
    get: {
      operationId: 'getWallets',
      parameters: [
        {
          name: 'handle',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        },
      ],
      responses: {
        200: {
          description: 'Wallets list',
          content: {
            'application/json': {
              schema: {
                type: 'array',
                items: { type: 'string' },
              },
            },
          },
        },
      },
    },
  };

  const breaking = findBreakingChanges(base, head);
  assert.equal(breaking.length, 0, `Expected 0 breaking changes, got: ${JSON.stringify(breaking)}`);
});

test('removing a path or operation fails', () => {
  const base = createBaseSpec();
  const headWithoutPath = structuredClone(base);
  delete headWithoutPath.paths['/profiles/{handle}'];

  const breakingPath = findBreakingChanges(base, headWithoutPath);
  assert.ok(breakingPath.some((b) => b.includes('Removed path')));

  const headWithoutOp = structuredClone(base);
  delete headWithoutOp.paths['/profiles/{handle}'].get;

  const breakingOp = findBreakingChanges(base, headWithoutOp);
  assert.ok(breakingOp.some((b) => b.includes('Removed operation GET')));
});

test('adding a new required request parameter fails', () => {
  const base = createBaseSpec();
  const head = structuredClone(base);

  head.paths['/profiles/{handle}'].get.parameters.push({
    name: 'apiKey',
    in: 'header',
    required: true,
    schema: { type: 'string' },
  });

  const breaking = findBreakingChanges(base, head);
  assert.ok(
    breaking.some((b) => b.includes('New required request parameter "apiKey"')),
    `Unexpected error messages: ${JSON.stringify(breaking)}`,
  );
});

test('making an optional parameter required fails', () => {
  const base = createBaseSpec();
  const head = structuredClone(base);

  head.paths['/profiles/{handle}'].get.parameters[1].required = true;

  const breaking = findBreakingChanges(base, head);
  assert.ok(
    breaking.some((b) => b.includes('became required')),
    `Unexpected error messages: ${JSON.stringify(breaking)}`,
  );
});

test('removing an enum value fails', () => {
  const base = createBaseSpec();
  const head = structuredClone(base);

  head.components.schemas.Profile.properties.role.enum = ['user'];

  const breaking = findBreakingChanges(base, head);
  assert.ok(
    breaking.some((b) => b.includes('Removed enum value "admin"')),
    `Unexpected error messages: ${JSON.stringify(breaking)}`,
  );
});

test('newly required response field being added or dropped fails', () => {
  const base = createBaseSpec();

  // 1. Newly required field added
  const headAddedRequired = structuredClone(base);
  headAddedRequired.components.schemas.Profile.required.push('bio');
  const breakingAdded = findBreakingChanges(base, headAddedRequired);
  assert.ok(
    breakingAdded.some((b) => b.includes('Newly required response field "bio"')),
    `Unexpected error messages: ${JSON.stringify(breakingAdded)}`,
  );

  // 2. Required response field dropped
  const headDroppedRequired = structuredClone(base);
  delete headDroppedRequired.components.schemas.Profile.properties.role;
  headDroppedRequired.components.schemas.Profile.required = ['handle'];
  const breakingDropped = findBreakingChanges(base, headDroppedRequired);
  assert.ok(
    breakingDropped.some(
      (b) =>
        b.includes('Removed response property "role"') || b.includes('Required response field'),
    ),
    `Unexpected error messages: ${JSON.stringify(breakingDropped)}`,
  );
});
