import specJsonSchema from '../../../../../packages/spec/schema/spec-json.v1.schema.json' with { type: 'json' };

/**
 * OpenAPI 3.1.0 specification and JSON Schema components for API v1.
 *
 * All schemas are pure TypeScript JSON Schema (Draft 2020-12) objects
 * to serve as the single source of truth for the OpenAPI document and
 * response validation in tests.
 */

export interface OpenApiSchema {
  type?: string | string[];
  $ref?: string;
  required?: string[];
  properties?: Record<string, OpenApiSchema>;
  items?: OpenApiSchema;
  enum?: unknown[];
  pattern?: string;
  format?: string;
  minimum?: number;
  maximum?: number;
  description?: string;
  additionalProperties?: boolean | OpenApiSchema;
  [key: string]: unknown;
}

export interface OpenApiResponse {
  description: string;
  headers?: Record<string, unknown>;
  content?: {
    'application/json'?: {
      schema: OpenApiSchema;
    };
    [mimeType: string]: unknown;
  };
}

export interface OpenApiOperation {
  operationId: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: Array<{
    name: string;
    in: 'query' | 'header' | 'path' | 'cookie';
    description?: string;
    required?: boolean;
    schema: OpenApiSchema;
  }>;
  responses: Record<string, OpenApiResponse>;
}

export interface OpenApiPathItem {
  summary?: string;
  description?: string;
  get?: OpenApiOperation;
  post?: OpenApiOperation;
  put?: OpenApiOperation;
  delete?: OpenApiOperation;
  options?: OpenApiOperation;
  head?: OpenApiOperation;
  patch?: OpenApiOperation;
  [key: string]: unknown;
}

export interface OpenApiDocument {
  openapi: string;
  info: {
    title: string;
    version: string;
    description: string;
    license?: {
      name: string;
      url?: string;
    };
  };
  servers: Array<{
    url: string;
    description?: string;
  }>;
  paths: Record<string, OpenApiPathItem>;
  security?: Array<Record<string, string[]>>;
  components: {
    schemas: Record<string, OpenApiSchema>;
  };
}

/** Bundle the canonical schema without copying its fields or requiring clients
 * to fetch an external schema URL. Rebase its local definition references to
 * the component location; the Draft 7 constructs used here also work in 2020-12.
 */
function specJsonComponent(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(specJsonComponent);
  if (!node || typeof node !== 'object') return node;
  return Object.fromEntries(
    Object.entries(node).flatMap(([key, value]) => {
      if (key === '$id' || key === '$schema') return [];
      if (key === '$ref' && typeof value === 'string' && value.startsWith('#/')) {
        return [[key, `#/components/schemas/SpecJson${value.slice(1)}`]];
      }
      return [[key, specJsonComponent(value)]];
    }),
  );
}

/**
 * Standard schemas conforming to JSON Schema 2020-12 / OpenAPI 3.1.
 */
export const schemas: Record<string, OpenApiSchema> = {
  SpecJson: specJsonComponent(specJsonSchema) as OpenApiSchema,
  Error: {
    type: 'object',
    required: ['code', 'message'],
    properties: {
      code: {
        type: 'string',
        enum: ['bad_request', 'not_found', 'rate_limited', 'unavailable', 'internal'],
        description: 'Standardized Signet API error code.',
      },
      message: {
        type: 'string',
        description: 'Human-readable explanation of the error.',
      },
      details: {
        type: 'object',
        description: 'Optional structured context for the error.',
        additionalProperties: true,
      },
    },
    additionalProperties: false,
  },

  ErrorEnvelope: {
    type: 'object',
    required: ['error'],
    properties: {
      error: {
        $ref: '#/components/schemas/Error',
      },
    },
    additionalProperties: false,
  },

  PageMeta: {
    type: 'object',
    required: ['network', 'source', 'nextCursor', 'truncated', 'cap'],
    properties: {
      network: {
        type: 'string',
        description: "Network context ('testnet' or 'mainnet').",
      },
      source: {
        type: 'string',
        description: "Data layer that answered the query ('database', 'horizon', 'chain', etc.).",
      },
      nextCursor: {
        type: ['string', 'null'],
        description: 'Opaque cursor for fetching the next page, or null if on the last page.',
      },
      truncated: {
        type: 'boolean',
        description: 'True when a query cap bounded the results.',
      },
      cap: {
        type: ['integer', 'null'],
        description: 'The cap limit that caused truncation, or null if unconstrained.',
      },
      total: {
        type: ['integer', 'null'],
        description: 'Exact total count if known, or null.',
      },
    },
    additionalProperties: false,
  },

  Wallet: {
    type: 'object',
    required: ['address', 'primary', 'source', 'attestedAt'],
    properties: {
      address: {
        type: 'string',
        pattern: '^[GC][A-Z2-7]{55}$',
        description: 'Stellar account public key (G...) or contract ID (C...).',
      },
      primary: {
        type: 'boolean',
        description: 'Whether this is the primary wallet for the handle.',
      },
      source: {
        type: 'string',
        description: "Provenance of the wallet link (e.g. 'curated', 'cli_link', 'none').",
      },
      attestedAt: {
        type: ['string', 'null'],
        format: 'date-time',
        description: 'ISO-8601 UTC timestamp when the link was verified, or null.',
      },
      indexingPending: {
        type: 'boolean',
        description: 'True when the indexer has not yet finished scanning the wallet.',
      },
    },
    additionalProperties: false,
  },
  HandleWallet: {
    type: 'object',
    required: ['address', 'isPrimary', 'source', 'linkedAt', 'indexingPending', 'network'],
    properties: {
      address: {
        type: 'string',
        pattern: '^[GC][A-Z2-7]{55}$',
        description: 'Stellar account public key (G...) or contract ID (C...).',
      },
      isPrimary: {
        type: 'boolean',
        description: 'Whether this is the primary wallet for the handle.',
      },
      source: {
        type: 'string',
        description: "Provenance of the wallet link ('onchain', 'cli', 'curated', or 'unknown').",
      },
      linkedAt: {
        type: ['string', 'null'],
        format: 'date-time',
        description: 'ISO-8601 UTC timestamp when the link was attested, or null.',
      },
      indexingPending: {
        type: 'boolean',
        description: 'True when the indexer has not yet finished scanning the wallet.',
      },
      network: {
        type: 'string',
        description: 'Network context.',
      },
    },
    additionalProperties: false,
  },

  Contract: {
    type: 'object',
    required: ['address', 'network', 'handle'],
    properties: {
      address: {
        type: 'string',
        pattern: '^C[A-Z2-7]{55}$',
        description: 'Soroban contract ID (C...).',
      },
      network: {
        type: 'string',
        enum: ['testnet', 'mainnet'],
        description: 'Network the contract is deployed on.',
      },
      handle: {
        type: ['string', 'null'],
        description: 'Handle the contract is bound or attributed to.',
      },
      wasmHash: {
        type: ['string', 'null'],
        pattern: '^[a-f0-9]{64}$',
        description: 'Hex-encoded SHA-256 hash of the contract bytecode.',
      },
      name: {
        type: ['string', 'null'],
        description: 'Contract interface name or title.',
      },
      deployedAt: {
        type: ['string', 'null'],
        format: 'date-time',
        description: 'ISO-8601 UTC timestamp of deployment.',
      },
      deployer: {
        type: ['string', 'null'],
        pattern: '^[GC][A-Z2-7]{55}$',
        description: 'Stellar address of the deployer.',
      },
      attribution: {
        type: ['object', 'null'],
        properties: {
          method: {
            type: 'string',
            enum: ['indexer', 'deployer-check'],
          },
          wallet: {
            type: 'string',
          },
        },
        required: ['method', 'wallet'],
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },

  Operation: {
    type: 'object',
    required: ['id', 'type', 'createdAt', 'txHash', 'successful'],
    properties: {
      id: {
        type: 'string',
        description: 'Unique identifier for the operation.',
      },
      type: {
        type: 'string',
        description: "Operation type (e.g. 'invoke_host_function', 'payment').",
      },
      function: {
        type: ['string', 'null'],
        description: 'Contract function name if an invocation, otherwise null.',
      },
      contract: {
        type: ['string', 'null'],
        pattern: '^C[A-Z2-7]{55}$',
        description: 'Contract address if an invocation, otherwise null.',
      },
      sourceAccount: {
        type: 'string',
        pattern: '^[GC][A-Z2-7]{55}$',
        description: 'Account that initiated or authorized the transaction.',
      },
      createdAt: {
        type: 'string',
        format: 'date-time',
        description: 'ISO-8601 UTC timestamp.',
      },
      txHash: {
        type: 'string',
        description: 'Hex transaction hash.',
      },
      successful: {
        type: 'boolean',
        description: 'Whether the transaction succeeded on-chain.',
      },
    },
    additionalProperties: false,
  },

  Profile: {
    type: 'object',
    required: ['handle', 'primaryWallet', 'network', 'archived', 'counts', 'countsAreLowerBounds'],
    properties: {
      handle: {
        type: 'string',
        pattern: '^[a-z0-9_-]{1,64}$',
        description: 'Unique handle registered on Signet.',
      },
      displayName: {
        type: ['string', 'null'],
        description: 'Display name of the handle owner.',
      },
      bio: {
        type: ['string', 'null'],
        description: 'Public bio or description.',
      },
      avatarUrl: {
        type: ['string', 'null'],
        description: 'Avatar image URL.',
      },
      primaryWallet: {
        type: ['string', 'null'],
        pattern: '^[GC][A-Z2-7]{55}$',
        description:
          'Primary Stellar address bound to this handle, or null when the handle exists but no primary wallet is readable (e.g. an archived registry entry).',
      },
      wallets: {
        type: 'array',
        items: {
          $ref: '#/components/schemas/Wallet',
        },
        description: 'List of associated wallets.',
      },
      joinedAt: {
        type: ['string', 'null'],
        format: 'date-time',
        description: 'ISO-8601 UTC timestamp when the handle was registered.',
      },
      network: {
        type: 'string',
        enum: ['testnet', 'mainnet', 'futurenet', 'local'],
        description: 'Network context.',
      },
      archived: {
        type: 'boolean',
        description: 'Whether the profile is archived.',
      },
      counts: {
        type: 'object',
        required: ['contracts', 'wallets', 'invocations'],
        properties: {
          contracts: { type: 'integer', minimum: 0 },
          wallets: { type: 'integer', minimum: 0 },
          invocations: { type: 'integer', minimum: 0 },
        },
        additionalProperties: false,
      },
      countsAreLowerBounds: {
        type: 'boolean',
        description: 'True if counts are bounded by retention or indexing caps.',
      },
    },
    additionalProperties: false,
  },

  SuccessEnvelope: {
    type: 'object',
    required: ['data'],
    properties: {
      data: {
        type: 'object',
        description: 'Response payload.',
      },
      meta: {
        type: 'object',
        description: 'Optional metadata describing pagination or source layer.',
        additionalProperties: true,
      },
    },
    additionalProperties: false,
  },
};

function specPath(byAddress: boolean): OpenApiPathItem {
  const name = byAddress ? 'address' : 'wasmHash';
  const errorResponse: OpenApiResponse = {
    description:
      'A standard v1 error. Missing contracts and embedded specs have distinct details.reason.',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } },
  };
  return {
    get: {
      operationId: byAddress ? 'getContractSpec' : 'getSpecByHash',
      summary: byAddress
        ? 'Embedded contract specification'
        : 'Embedded specification by WASM hash',
      description: byAddress
        ? 'Public chain data, without an attribution gate or registry fallback. The address mapping is short-lived: public, max-age=300, s-maxage=3600. Missing contracts return no_contract; a contract without an embedded interface returns no_embedded_spec.'
        : 'Read an immutable embedded specification directly by its hash. Public caching for one year with immutable; a missing code entry returns no_wasm.',
      tags: ['Specifications'],
      parameters: [
        {
          name,
          in: 'path',
          required: true,
          schema: { type: 'string', pattern: byAddress ? '^C[A-Z2-7]{55}$' : '^[0-9a-fA-F]{64}$' },
        },
        { name: 'If-None-Match', in: 'header', schema: { type: 'string' } },
      ],
      responses: {
        '200': {
          description: 'The embedded specification. ETag is the quoted WASM hash.',
          headers: {
            ETag: { schema: { type: 'string' } },
            'Cache-Control': { schema: { type: 'string' } },
          },
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['data'],
                additionalProperties: false,
                properties: {
                  data: {
                    type: 'object',
                    additionalProperties: false,
                    required: [
                      ...(byAddress ? ['address'] : []),
                      'network',
                      'wasmHash',
                      'spec',
                      'specSource',
                    ],
                    properties: {
                      ...(byAddress
                        ? { address: { type: 'string', pattern: '^C[A-Z2-7]{55}$' } }
                        : {}),
                      network: { type: 'string' },
                      wasmHash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
                      spec: { $ref: '#/components/schemas/SpecJson' },
                      specSource: { type: 'string', const: 'embedded' },
                    },
                  },
                },
              },
            },
          },
        },
        '304': {
          description: 'If-None-Match matched. Empty body; ETag and Cache-Control retained.',
          headers: {
            ETag: { schema: { type: 'string' } },
            'Cache-Control': { schema: { type: 'string' } },
          },
        },
        '400': errorResponse,
        '404': errorResponse,
        '429': errorResponse,
        '500': errorResponse,
        '503': errorResponse,
      },
    },
  };
}

/**
 * Modular paths registry. Each endpoint issue (#627 to #646) registers or adds its path.
 */
export const paths: Record<string, OpenApiPathItem> = {
  '/contracts/{address}/spec': specPath(true),
  '/specs/{wasmHash}': specPath(false),
  '/health': {
    get: {
      operationId: 'getHealth',
      summary: 'Deployment health and identity',
      description:
        'The operator probe\'s stable v1 form: per-dependency checks (including whether CLI pairing can work on this deployment), plus which network and API version this deployment serves. A degraded dependency still answers 200 with status "degraded".',
      tags: ['Health'],
      responses: {
        '200': {
          description: 'The health report. 200 even when degraded.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['data'],
                properties: {
                  data: {
                    type: 'object',
                    required: ['status', 'apiVersion', 'network', 'networkPassphrase', 'checks'],
                    properties: {
                      status: { type: 'string', enum: ['ok', 'degraded'] },
                      apiVersion: { type: 'string', const: '1' },
                      network: {
                        type: 'string',
                        description: 'The Stellar network this deployment is configured for.',
                      },
                      networkPassphrase: { type: 'string' },
                      checks: {
                        type: 'object',
                        required: ['db', 'registry', 'nonceStore', 'rateLimitStore', 'pairing'],
                        properties: {
                          db: { type: 'string', enum: ['up', 'down', 'skipped'] },
                          registry: { type: 'string', enum: ['up', 'down', 'skipped'] },
                          nonceStore: { type: 'string', enum: ['up', 'down', 'memory'] },
                          rateLimitStore: { type: 'string', enum: ['up', 'down', 'memory'] },
                          pairing: { type: 'string', enum: ['up', 'down', 'skipped'] },
                        },
                        additionalProperties: false,
                      },
                    },
                    additionalProperties: false,
                  },
                },
                additionalProperties: false,
              },
            },
          },
        },
        '429': {
          description: 'Rate limit exceeded.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorEnvelope' },
            },
          },
        },
        '500': {
          description: 'Internal server error.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorEnvelope' },
            },
          },
        },
      },
    },
  },
  '/registry/stats': {
    get: {
      operationId: 'getRegistryStats',
      summary: 'Public registry and indexer counts',
      description:
        'Public counts for dashboards and ecosystem reports. Any count the deployment cannot compute is null, never 0.',
      tags: ['Registry'],
      responses: {
        '200': {
          description: 'The registry statistics.',
          headers: {
            'Cache-Control': {
              schema: { type: 'string' },
              description: 'public, s-maxage=300',
            },
          },
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['data'],
                properties: {
                  data: {
                    type: 'object',
                    required: [
                      'network',
                      'registryContract',
                      'boundHandles',
                      'indexedWallets',
                      'indexedContracts',
                    ],
                    properties: {
                      network: {
                        type: 'string',
                        description: 'The Stellar network this deployment is configured for.',
                      },
                      registryContract: {
                        type: 'string',
                        description: 'Configured Identity Registry contract address.',
                      },
                      boundHandles: {
                        type: ['integer', 'null'],
                        description: 'Total handles currently bound in the registry, or null if unreadable.',
                      },
                      indexedWallets: {
                        type: ['integer', 'null'],
                        description: 'Total wallets indexed in the database, or null if unavailable.',
                      },
                      indexedContracts: {
                        type: ['integer', 'null'],
                        description: 'Total contracts indexed in the database, or null if unavailable.',
                      },
                    },
                    additionalProperties: false,
                  },
                },
                additionalProperties: false,
              },
            },
          },
        },
        '429': {
          description: 'Rate limit exceeded.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorEnvelope' },
            },
          },
        },
        '500': {
          description: 'Internal server error.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorEnvelope' },
            },
          },
        },
      },
    },
  },
  '/openapi.json': {
    get: {
      operationId: 'getOpenApiDocument',
      summary: 'OpenAPI 3.1 specification for API v1',
      description: 'Returns the complete OpenAPI 3.1 document for Signet API v1.',
      responses: {
        '200': {
          description: 'The OpenAPI 3.1 JSON document.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: true,
              },
            },
          },
        },
        '429': {
          description: 'Rate limit exceeded.',
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/ErrorEnvelope',
              },
            },
          },
        },
        '500': {
          description: 'Internal server error.',
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/ErrorEnvelope',
              },
            },
          },
        },
      },
    },
  },
  '/resolve/{handle}': {
    get: {
      operationId: 'resolveHandle',
      summary: 'Resolve handle against Identity Registry',
      description:
        'Direct registry read with no database: which wallet does the Identity Registry say owns this handle? Returns 404 when unbound, 503 unavailable when unconfigured or simulation errors.',
      tags: ['Registry'],
      parameters: [
        {
          name: 'handle',
          in: 'path',
          required: true,
          description: 'Handle to resolve (case-insensitive).',
          schema: { type: 'string', pattern: '^[a-z0-9_-]{1,32}$' },
        },
      ],
      responses: {
        '200': {
          description: 'The bound wallet information.',
          headers: {
            'Cache-Control': {
              schema: { type: 'string' },
              description: 'public, s-maxage=30',
            },
          },
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['data'],
                properties: {
                  data: {
                    type: 'object',
                    required: ['handle', 'wallet', 'network', 'registryContract'],
                    properties: {
                      handle: {
                        type: 'string',
                        description: 'Resolved handle in canonical lowercase.',
                      },
                      wallet: {
                        type: 'string',
                        description: 'Stellar address (G… or C…) bound to the handle, or empty if archived.',
                      },
                      network: {
                        type: 'string',
                        description: 'The Stellar network this deployment is configured for.',
                      },
                      registryContract: {
                        type: 'string',
                        description: 'Configured Identity Registry contract address.',
                      },
                      archived: {
                        type: 'boolean',
                        description: 'Whether the handle entry is currently archived on chain.',
                      },
                      restorePreamble: {
                        type: 'object',
                        description: 'Restore preamble details from RPC simulation when archived.',
                        additionalProperties: true,
                      },
                    },
                    additionalProperties: false,
                  },
                },
                additionalProperties: false,
              },
            },
          },
        },
        '400': {
          description: 'Malformed handle.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorEnvelope' },
            },
          },
        },
        '404': {
          description: 'Handle is not bound in the registry.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorEnvelope' },
            },
          },
        },
        '429': {
          description: 'Rate limit exceeded.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorEnvelope' },
            },
          },
        },
        '503': {
          description: 'Registry unavailable or unconfigured.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorEnvelope' },
            },
          },
        },
      },
    },
  },
  '/profiles/{handle}': {
    get: {
      operationId: 'getProfile',
      summary: 'Profile for a handle',
      description:
        'Whether the handle exists on this deployment, the wallet it is bound to, and aggregate activity counts. Operations are served by their own paginated endpoint; no reputation score is exposed. `countsAreLowerBounds` is true when a retention window or read cap bounded the counts.',
      tags: ['Profiles'],
      parameters: [
        {
          name: 'handle',
          in: 'path',
          required: true,
          description: 'Handle to look up (case-insensitive).',
          schema: { type: 'string', pattern: '^[a-z0-9_-]{1,32}$' },
        },
      ],
      responses: {
        '200': {
          description: 'The profile.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['data', 'meta'],
                properties: {
                  data: { $ref: '#/components/schemas/Profile' },
                  meta: {
                    type: 'object',
                    required: ['network', 'source'],
                    properties: {
                      network: { type: 'string' },
                      source: {
                        type: 'string',
                        description: "Layer that answered ('database' or 'chain').",
                      },
                    },
                    additionalProperties: false,
                  },
                },
                additionalProperties: false,
              },
            },
          },
        },
        '400': {
          description: 'Invalid handle.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorEnvelope' },
            },
          },
        },
        '404': {
          description: 'No profile for this handle.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorEnvelope' },
            },
          },
        },
        '429': {
          description: 'Rate limit exceeded.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorEnvelope' },
            },
          },
        },
        '500': {
          description: 'Internal server error.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorEnvelope' },
            },
          },
        },
      },
    },
  },
  '/profiles/{handle}/operations': {
    get: {
      operationId: 'getProfileOperations',
      summary: 'Operations for a profile',
      description:
        'Cursor-paginated operations for a profile with completeness metadata. When database is available, exact total is reported; when fallback answered, total is null and cursor stops at cap.',
      tags: ['Profiles'],
      parameters: [
        {
          name: 'handle',
          in: 'path',
          required: true,
          description: 'Handle to look up (case-insensitive).',
          schema: { type: 'string', pattern: '^[a-z0-9_-]{1,32}$' },
        },
        {
          name: 'cursor',
          in: 'query',
          required: false,
          description: 'Opaque pagination cursor from meta.nextCursor.',
          schema: { type: 'string' },
        },
        {
          name: 'limit',
          in: 'query',
          required: false,
          description: 'Number of operations to return (default 25, max 100).',
          schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
        },
      ],
      responses: {
        '200': {
          description: 'Paginated list of operations.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['data', 'meta'],
                properties: {
                  data: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/Operation' },
                  },
                  meta: {
                    type: 'object',
                    required: ['nextCursor', 'total', 'truncated', 'cap', 'source'],
                    properties: {
                      nextCursor: {
                        type: ['string', 'null'],
                        description: 'Opaque cursor for the next page, or null.',
                      },
                      total: {
                        type: ['integer', 'null'],
                        description: 'Exact total count when database answered, otherwise null.',
                      },
                      truncated: {
                        type: 'boolean',
                        description: 'Whether records were capped.',
                      },
                      cap: {
                        type: ['integer', 'null'],
                        description: 'Cap applied to the read, or null.',
                      },
                      source: {
                        type: 'string',
                        description: "Layer that answered ('database' or 'horizon').",
                      },
                    },
                    additionalProperties: false,
                  },
                },
                additionalProperties: false,
              },
            },
          },
        },
        '400': {
          description: 'Invalid handle or pagination parameters.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorEnvelope' },
            },
          },
        },
        '404': {
          description: 'No profile for this handle.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorEnvelope' },
            },
          },
        },
        '429': {
          description: 'Rate limit exceeded.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorEnvelope' },
            },
          },
        },
        '500': {
          description: 'Internal server error.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorEnvelope' },
            },
          },
        },
      },
    },
  },
  '/profiles/{handle}/wallets': {
    get: {
      operationId: 'getHandleWallets',
      summary: 'Wallets linked to a handle',
      description:
        'All wallets attributed to a handle with provenance source and indexing status. Primary wallet is returned first.',
      tags: ['Profiles'],
      parameters: [
        {
          name: 'handle',
          in: 'path',
          required: true,
          description: 'Handle to look up (case-insensitive).',
          schema: { type: 'string', pattern: '^[a-z0-9_-]{1,32}$' },
        },
      ],
      responses: {
        '200': {
          description: 'List of linked wallets.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['data', 'meta'],
                properties: {
                  data: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/HandleWallet' },
                  },
                  meta: {
                    type: 'object',
                    required: ['source'],
                    properties: {
                      source: {
                        type: 'string',
                        description: "Layer that answered ('db' or 'chain').",
                      },
                    },
                    additionalProperties: false,
                  },
                },
                additionalProperties: false,
              },
            },
          },
        },
        '400': {
          description: 'Invalid handle.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorEnvelope' },
            },
          },
        },
        '404': {
          description: 'No profile for this handle.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorEnvelope' },
            },
          },
        },
        '429': {
          description: 'Rate limit exceeded.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorEnvelope' },
            },
          },
        },
        '500': {
          description: 'Internal server error.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorEnvelope' },
            },
          },
        },
      },
    },
  },
};

/**
 * Register or update an OpenAPI path item.
 */
export function registerPath(path: string, item: OpenApiPathItem): void {
  paths[path] = {
    ...paths[path],
    ...item,
  };
}

/**
 * Builds the complete OpenAPI 3.1.0 specification document.
 */
export function getOpenApiDocument(): OpenApiDocument {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Signet API',
      version: '1.0.0',
      description: 'Signet public, read-only API (v1).',
      license: {
        name: 'Apache-2.0',
        url: 'https://www.apache.org/licenses/LICENSE-2.0.html',
      },
    },
    servers: [
      {
        url: '/api/v1',
        description: 'Current deployment',
      },
    ],
    security: [],
    paths,
    components: {
      schemas,
    },
  };
}
