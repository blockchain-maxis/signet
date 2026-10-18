import { deflateRawSync, inflateRawSync, crc32 } from 'node:zlib';
import { BindingGenerator } from '@stellar/stellar-sdk';
import { fromSpecJson, STELLAR_SDK_VERSION, type SpecJson } from '@signet/spec';
import { attributeContract, type Attribution } from '../contract-attribution.ts';
import { loadContractSpec, type ContractSpecResult } from './contract-spec.ts';
import { LIMITS, rateLimitDecision, type RateLimitRefusal } from '../rate-limit-policy.ts';
import { logger } from '../logger.ts';
import { GO_SDK_VERSION, generateGoStub } from '../docs/go-stub.ts';

export interface ZipFileEntry {
  path: string;
  content: string | Uint8Array;
}

/**
 * Creates a standard uncompressed or deflated PKZIP 2.0 archive in memory
 * using Node's built-in zlib. Zero third-party dependencies.
 */
export function createZipArchive(files: ZipFileEntry[]): Uint8Array {
  const localHeaders: Buffer[] = [];
  const centralHeaders: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.path, 'utf8');
    const dataBuf =
      typeof file.content === 'string'
        ? Buffer.from(file.content, 'utf8')
        : Buffer.from(file.content);
    const compressed = deflateRawSync(dataBuf);
    const checksum = crc32(dataBuf);

    // Local file header (30 bytes + filename length)
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0); // signature
    local.writeUInt16LE(20, 4); // version needed to extract (2.0)
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 filename encoding
    local.writeUInt16LE(8, 8); // compression: 8 = Deflate
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(checksum, 14); // crc-32
    local.writeUInt32LE(compressed.length, 18); // compressed size
    local.writeUInt32LE(dataBuf.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26); // filename length
    local.writeUInt16LE(0, 28); // extra field length
    nameBuf.copy(local, 30);

    // Central directory header (46 bytes + filename length)
    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0); // signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8); // flags: UTF-8
    central.writeUInt16LE(8, 10); // compression: Deflate
    central.writeUInt16LE(0, 12); // mod time
    central.writeUInt16LE(0, 14); // mod date
    central.writeUInt32LE(checksum, 16); // crc-32
    central.writeUInt32LE(compressed.length, 20); // compressed size
    central.writeUInt32LE(dataBuf.length, 24); // uncompressed size
    central.writeUInt16LE(nameBuf.length, 28); // filename length
    central.writeUInt16LE(0, 30); // extra field length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42); // relative offset of local header
    nameBuf.copy(central, 46);

    localHeaders.push(local, compressed);
    centralHeaders.push(central);
    offset += local.length + compressed.length;
  }

  const centralOffset = offset;
  const centralBuf = Buffer.concat(centralHeaders);
  const centralSize = centralBuf.length;

  // End of central directory record (22 bytes)
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // signature
  end.writeUInt16LE(0, 4); // disk number
  end.writeUInt16LE(0, 6); // start disk
  end.writeUInt16LE(files.length, 8); // total entries on this disk
  end.writeUInt16LE(files.length, 10); // total entries
  end.writeUInt32LE(centralSize, 12); // central directory size
  end.writeUInt32LE(centralOffset, 16); // central directory offset
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localHeaders, centralBuf, end]);
}

/**
 * Parses a zip archive buffer and extracts all entries into a Map of paths to strings.
 */
export function readZipEntries(buffer: Uint8Array): Map<string, string> {
  const buf = Buffer.from(buffer);
  const entries = new Map<string, string>();

  let eocdOffset = buf.length - 22;
  while (eocdOffset >= 0) {
    if (buf.readUInt32LE(eocdOffset) === 0x06054b50) break;
    eocdOffset--;
  }
  if (eocdOffset < 0) {
    throw new Error('Not a valid zip archive');
  }

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  let cur = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (buf.readUInt32LE(cur) !== 0x02014b50) {
      throw new Error(`Corrupt central directory entry at offset ${cur}`);
    }
    const method = buf.readUInt16LE(cur + 10);
    const compressedSize = buf.readUInt32LE(cur + 20);
    const nameLen = buf.readUInt16LE(cur + 28);
    const extraLen = buf.readUInt16LE(cur + 30);
    const commentLen = buf.readUInt16LE(cur + 32);
    const localHeaderOffset = buf.readUInt32LE(cur + 42);

    const name = buf.toString('utf8', cur + 46, cur + 46 + nameLen);
    cur += 46 + nameLen + extraLen + commentLen;

    if (buf.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new Error(`Corrupt local header at offset ${localHeaderOffset}`);
    }
    const localNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataOffset = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const rawData = buf.subarray(dataOffset, dataOffset + compressedSize);

    let content: Buffer;
    if (method === 0) {
      content = Buffer.from(rawData);
    } else if (method === 8) {
      content = inflateRawSync(rawData);
    } else {
      throw new Error(`Unsupported compression method: ${method}`);
    }

    entries.set(name, content.toString('utf8'));
  }

  return entries;
}

/**
 * Builds the customized README by prepending contract provenance and upgrade warnings.
 */
export function buildStubReadme(options: {
  contractName: string;
  contractAddress: string;
  network: string;
  wasmHash: string;
  generatorVersion: string;
  generatedAt?: string;
  baseReadme?: string;
}): string {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const header = [
    `# ${options.contractName} Client Stub`,
    '',
    `- **Contract Address:** \`${options.contractAddress}\``,
    `- **Network:** \`${options.network}\``,
    `- **WASM Hash:** \`${options.wasmHash}\``,
    `- **Generated At:** \`${generatedAt}\``,
    `- **Generator Version:** \`@stellar/stellar-sdk@${options.generatorVersion}\``,
    '',
    `> **Warning:** This client stub is generated from and tied to WASM hash \`${options.wasmHash}\`. If the contract is upgraded on-chain, this stub must be regenerated to reflect any interface changes.`,
    '',
    '---',
    '',
  ].join('\n');

  return header + (options.baseReadme ?? '');
}

export interface GenerateStubResult {
  zipBuffer: Uint8Array;
  wasmHash: string;
  generatorVersion: string;
  files: Record<string, string>;
}

/**
 * Reconstructs contract.Spec from SpecJson.entriesXdr, invokes BindingGenerator,
 * prepends the README metadata, and returns the zip archive buffer and file mapping.
 */
export function generateTsClientStub(
  specJson: SpecJson,
  meta: {
    contractName?: string;
    address: string;
    network: string;
    wasmHash?: string;
  },
): GenerateStubResult {
  if (!specJson.entriesXdr || specJson.entriesXdr.length === 0) {
    throw new Error('Contract spec has no entries');
  }

  const spec = fromSpecJson(specJson).spec;
  const contractName = (meta.contractName || 'contract').trim() || 'contract';
  const wasmHash = meta.wasmHash || specJson.wasmHash || '';
  const generatorVersion = specJson.sdkVersion || STELLAR_SDK_VERSION;

  const generator = BindingGenerator.fromSpec(spec);
  const generated = generator.generate({ contractName });

  const finalReadme = buildStubReadme({
    contractName,
    contractAddress: meta.address,
    network: meta.network,
    wasmHash,
    generatorVersion,
    baseReadme: generated.readme,
  });

  const fileMap: Record<string, string> = {
    'package.json': generated.packageJson,
    'tsconfig.json': generated.tsConfig,
    'README.md': finalReadme,
    '.gitignore': generated.gitignore,
    'src/index.ts': generated.index,
    'src/client.ts': generated.client,
  };

  if (generated.types && generated.types.trim().length > 0) {
    fileMap['src/types.ts'] = generated.types;
  }

  const filesToZip: ZipFileEntry[] = Object.entries(fileMap).map(([path, content]) => ({
    path,
    content,
  }));

  const zipBuffer = createZipArchive(filesToZip);

  return {
    zipBuffer,
    wasmHash,
    generatorVersion,
    files: fileMap,
  };
}

export interface ContractStubDeps {
  attribute?: (handle: string, address: string) => Promise<Attribution>;
  loadSpec?: (request: {
    address: string;
    network: string;
    wasmHash: string | null;
  }) => Promise<ContractSpecResult>;
  rateLimiter?: (
    headers: Headers,
    bucket: string,
    max: number,
  ) => Promise<RateLimitRefusal | null>;
}

const defaultDeps: Required<ContractStubDeps> = {
  attribute: attributeContract,
  loadSpec: loadContractSpec,
  rateLimiter: (headers, bucket, max) => rateLimitDecision(headers, bucket, max),
};

type ResolvedStub =
  | { ok: false; response: Response }
  | {
      ok: true;
      spec: SpecJson;
      network: string;
      wasmHash: string;
    };

/**
 * The checks every stub route shares, in order: method, rate limit,
 * attribution, spec lookup, and the 404/503 rules. Either a finished error
 * response or the spec to generate from.
 */
async function resolveStub(
  req: Request,
  params: { handle: string; address: string },
  deps: ContractStubDeps,
  bucket: 'stubTs' | 'stubGo',
): Promise<ResolvedStub> {
  const method = req.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    return {
      ok: false,
      response: Response.json(
        { error: 'Method not allowed' },
        {
          status: 405,
          headers: {
            Allow: 'GET, HEAD',
            'Cache-Control': 'no-store',
          },
        },
      ),
    };
  }

  const rateLimiter = deps.rateLimiter ?? defaultDeps.rateLimiter;
  const refusal = await rateLimiter(req.headers, bucket, LIMITS[bucket]);
  if (refusal) {
    return {
      ok: false,
      response: Response.json(
        { error: 'Too many requests', code: 'rate-limited' },
        {
          status: 429,
          headers: {
            'Retry-After': String(refusal.retryAfter),
            'Cache-Control': 'no-store',
          },
        },
      ),
    };
  }

  const { handle, address } = params;
  const attribute = deps.attribute ?? defaultDeps.attribute;
  const attribution = await attribute(handle, address);

  if (attribution.status === 'not-attributed' || attribution.status === 'invalid') {
    return {
      ok: false,
      response: Response.json(
        { error: 'Contract not found', reason: 'not_attributed' },
        {
          status: 404,
          headers: { 'Cache-Control': 'no-store' },
        },
      ),
    };
  }

  if (attribution.status === 'unavailable') {
    return {
      ok: false,
      response: Response.json(
        { error: 'Attribution unavailable', reason: 'attribution_unavailable' },
        {
          status: 503,
          headers: { 'Cache-Control': 'no-store' },
        },
      ),
    };
  }

  const loadSpec = deps.loadSpec ?? defaultDeps.loadSpec;
  const specResult = await loadSpec({
    address: attribution.contract.address,
    network: attribution.contract.network,
    wasmHash: attribution.contract.wasmHash,
  });

  if (!specResult.ok) {
    const status = specResult.failure.kind === 'unavailable' ? 503 : 404;
    return {
      ok: false,
      response: Response.json(
        {
          error: status === 503 ? 'Spec lookup unavailable' : 'Contract has no interface',
          reason: specResult.failure.kind,
        },
        {
          status,
          headers: { 'Cache-Control': 'no-store' },
        },
      ),
    };
  }

  if (!specResult.spec.entriesXdr || specResult.spec.entriesXdr.length === 0) {
    return {
      ok: false,
      response: Response.json(
        { error: 'Contract has no interface', reason: 'no_interface' },
        {
          status: 404,
          headers: { 'Cache-Control': 'no-store' },
        },
      ),
    };
  }

  return {
    ok: true,
    spec: specResult.spec,
    network: attribution.contract.network,
    wasmHash: specResult.wasmHash || attribution.contract.wasmHash || specResult.spec.wasmHash,
  };
}

/** `contractName` (or `name`) from the query string, else `contract`. */
function requestedContractName(req: Request): string {
  try {
    const url = new URL(req.url);
    const candidate = url.searchParams.get('contractName') || url.searchParams.get('name');
    if (candidate && candidate.trim().length > 0) return candidate.trim();
  } catch {
    // Malformed URL, keep default
  }
  return 'contract';
}

/** A 304 when the client already holds this exact stub, else null. */
function notModified(req: Request, etag: string): Response | null {
  if (req.headers.get('if-none-match') !== etag) return null;
  return new Response(null, {
    status: 304,
    headers: {
      ETag: etag,
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}

function generationFailed(error: unknown, handle: string, address: string): Response {
  logger.error({ error: String(error), handle, address }, 'stub.generateFailed');
  return Response.json(
    { error: 'Failed to generate client stub', reason: 'generation_failed' },
    {
      status: 500,
      headers: { 'Cache-Control': 'no-store' },
    },
  );
}

/**
 * Route logic for GET /p/[handle]/contract/[address]/stub/ts
 *
 * Checks rate limits, verifies attribution, loads spec, enforces 404 rules,
 * evaluates If-None-Match ETag caching, generates TypeScript bindings, and
 * streams the resulting zip archive with Content-Disposition.
 */
export async function handleContractStubTs(
  req: Request,
  params: { handle: string; address: string },
  deps: ContractStubDeps = {},
): Promise<Response> {
  const resolved = await resolveStub(req, params, deps, 'stubTs');
  if (!resolved.ok) return resolved.response;

  const { handle, address } = params;
  const { wasmHash } = resolved;
  const generatorVersion = resolved.spec.sdkVersion || STELLAR_SDK_VERSION;
  const etag = `"${wasmHash}-${generatorVersion}"`;
  const cached = notModified(req, etag);
  if (cached) return cached;

  const contractName = requestedContractName(req);

  try {
    const { zipBuffer } = generateTsClientStub(resolved.spec, {
      contractName,
      address,
      network: resolved.network,
      wasmHash,
    });

    const responseBody =
      req.method.toUpperCase() === 'HEAD' ? null : (zipBuffer as unknown as BodyInit);

    return new Response(responseBody, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${contractName}-client.zip"`,
        ETag: etag,
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch (error) {
    return generationFailed(error, handle, address);
  }
}

/**
 * Route logic for GET /p/[handle]/contract/[address]/stub/go
 *
 * The same checks, caching and rate limiting as the TypeScript stub; the body
 * is the single thin `.go` file from `generateGoStub`.
 */
export async function handleContractStubGo(
  req: Request,
  params: { handle: string; address: string },
  deps: ContractStubDeps = {},
): Promise<Response> {
  const resolved = await resolveStub(req, params, deps, 'stubGo');
  if (!resolved.ok) return resolved.response;

  const { handle, address } = params;
  const { wasmHash } = resolved;
  const etag = `"go-${wasmHash}-${GO_SDK_VERSION}"`;
  const cached = notModified(req, etag);
  if (cached) return cached;

  const contractName = requestedContractName(req);

  try {
    const source = generateGoStub(resolved.spec, {
      contractName,
      address,
      network: resolved.network,
      wasmHash,
    });
    const responseBody = req.method.toUpperCase() === 'HEAD' ? null : source;

    return new Response(responseBody, {
      status: 200,
      headers: {
        'Content-Type': 'text/x-go; charset=utf-8',
        'Content-Disposition': `attachment; filename="${contractName}-client.go"`,
        ETag: etag,
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch (error) {
    return generationFailed(error, handle, address);
  }
}
