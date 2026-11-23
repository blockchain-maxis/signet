import { attributeContract, type Attribution } from '../../contract-attribution.ts';
import { describeUpgrades, type WasmVersionRow } from '../../contract-upgrades.ts';
import {
  ok,
  parseAddress,
  parseHandle,
  V1Error,
  withV1,
} from './http.ts';
import { NOT_ATTRIBUTED_MESSAGE } from './profile-contract.ts';

export const VERSIONS_CACHE_CONTROL = 'public, s-maxage=60, stale-while-revalidate=300';

export interface V1ContractWasmVersion {
  wasmHash: string;
  observedAt: string;
  observedLedger: number;
}

export interface V1ContractVersionsMeta {
  source: 'database' | 'none';
  detectionStartsAt: string | null;
  windowSentence: string | null;
  headerNote: string | null;
}

export interface V1ContractVersionsResult {
  data: V1ContractWasmVersion[];
  meta: V1ContractVersionsMeta;
}

export interface V1ContractVersionsDeps {
  attribute?: (handle: string, address: string) => Promise<Attribution>;
  prisma?: any;
}

export async function getV1ContractVersions(
  handle: string,
  address: string,
  deps: V1ContractVersionsDeps = {},
): Promise<V1ContractVersionsResult> {
  const verdict = await (deps.attribute ?? attributeContract)(handle, address);
  switch (verdict.status) {
    case 'invalid':
      throw new V1Error('bad_request', `Invalid C… contract ID "${address}".`, {
        parameter: 'address',
      });
    case 'unavailable':
      throw new V1Error('unavailable', 'Contract attribution is unavailable. Try again later.');
    case 'not-attributed':
      throw new V1Error('not_found', NOT_ATTRIBUTED_MESSAGE);
  }

  if (!process.env.DATABASE_URL && !deps.prisma) {
    return {
      data: [],
      meta: {
        source: 'none',
        detectionStartsAt: null,
        windowSentence: null,
        headerNote: null,
      },
    };
  }

  try {
    const prisma = deps.prisma ?? (await import('@signet/db')).prisma;

    const rows: any[] = await prisma.contractWasmVersion.findMany({
      where: { contract: { address } },
      orderBy: [{ observedAt: 'desc' }, { observedLedger: 'desc' }],
    });

    const wasmRows: WasmVersionRow[] = rows.map((r: any) => ({
      wasmHash: r.wasmHash,
      observedAt: r.observedAt instanceof Date ? r.observedAt.toISOString() : new Date(r.observedAt).toISOString(),
      observedLedger: r.observedLedger,
    }));

    const desc = describeUpgrades(wasmRows);

    const chronological = [...wasmRows].sort((a, b) => {
      const tA = new Date(a.observedAt).getTime();
      const tB = new Date(b.observedAt).getTime();
      if (tA !== tB) return tA - tB;
      return a.observedLedger - b.observedLedger;
    });

    const oldest = chronological[0];
    const detectionStartsAt = oldest
      ? oldest.observedAt instanceof Date
        ? oldest.observedAt.toISOString()
        : String(oldest.observedAt)
      : null;

    const data: V1ContractWasmVersion[] = desc.versions.map((v) => ({
      wasmHash: v.wasmHash,
      observedAt: v.observedAt,
      observedLedger: v.observedLedger,
    }));

    return {
      data,
      meta: {
        source: 'database',
        detectionStartsAt,
        windowSentence: desc.windowSentence,
        headerNote: desc.headerNote,
      },
    };
  } catch {
    return {
      data: [],
      meta: {
        source: 'none',
        detectionStartsAt: null,
        windowSentence: null,
        headerNote: null,
      },
    };
  }
}

type Ctx = { params: Promise<{ handle: string; address: string }> };

export function contractVersionsHandler(deps: V1ContractVersionsDeps = {}) {
  return (req: Request, ctx: Ctx): Promise<Response> =>
    withV1(
      async () => {
        const { handle: rawHandle, address: rawAddress } = await ctx.params;
        const handle = parseHandle(rawHandle);
        const address = parseAddress(rawAddress, 'C');
        const result = await getV1ContractVersions(handle, address, deps);
        return ok(result.data, result.meta);
      },
      { cache: VERSIONS_CACHE_CONTROL },
    )(req);
}
