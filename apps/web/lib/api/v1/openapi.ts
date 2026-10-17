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

/**
 * Standard schemas conforming to JSON Schema 2020-12 / OpenAPI 3.1.
 */
export const schemas: Record<string, OpenApiSchema> = {
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
        type: 'string',
        pattern: '^[GC][A-Z2-7]{55}$',
        description: 'Primary Stellar address bound to this handle.',
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
        enum: ['testnet', 'mainnet'],
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

/**
 * Modular paths registry. Each endpoint issue (#627 to #646) registers or adds its path.
 */
export const paths: Record<string, OpenApiPathItem> = {
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
