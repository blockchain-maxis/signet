import { attributeContract, type Attribution } from '../../contract-attribution.ts';
import {
  encodeCursor,
  ok,
  parseAddress,
  parseCursor,
  parseHandle,
  parseLimit,
  V1Error,
  withV1,
} from './http.ts';
import { NOT_ATTRIBUTED_MESSAGE } from './profile-contract.ts';

export const INVOCATIONS_CACHE_CONTROL = 'public, s-maxage=30, stale-while-revalidate=60';

export interface V1ContractInvocation {
  txHash: string;
  ledger: number;
  createdAt: string;
  sourceAccount: string;
  function: string | null;
  successful: boolean;
}

export interface V1ContractInvocationsMeta {
  nextCursor: string | null;
  total: number | null;
  source: 'database' | 'none';
  countedSince: string | null;
  totalIsFloor: boolean;
}

export interface V1ContractInvocationsResult {
  data: V1ContractInvocation[];
  meta: V1ContractInvocationsMeta;
}

export interface V1ContractInvocationsOptions {
  cursor?: { createdAt: string; id: string } | null;
  limit?: number;
  mine?: boolean;
}

export interface V1ContractInvocationsDeps {
  attribute?: (handle: string, address: string) => Promise<Attribution>;
  prisma?: any;
}

export async function getV1ContractInvocations(
  handle: string,
  address: string,
  options: V1ContractInvocationsOptions = {},
  deps: V1ContractInvocationsDeps = {},
): Promise<V1ContractInvocationsResult> {
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

  const limit = Math.min(100, Math.max(1, options.limit ?? 25));

  if (!process.env.DATABASE_URL && !deps.prisma) {
    return {
      data: [],
      meta: {
        nextCursor: null,
        total: null,
        source: 'none',
        countedSince: null,
        totalIsFloor: false,
      },
    };
  }

  try {
    const prisma = deps.prisma ?? (await import('@signet/db')).prisma;

    const contract = await prisma.contract.findUnique({
      where: { address },
      include: {
        wallet: {
          include: {
            profile: {
              include: {
                wallets: { select: { pubkey: true } },
              },
            },
          },
        },
      },
    });

    if (!contract) {
      return {
        data: [],
        meta: {
          nextCursor: null,
          total: 0,
          source: 'database',
          countedSince: null,
          totalIsFloor: false,
        },
      };
    }

    const snapshot = await prisma.contractSnapshot.findFirst({
      where: { contractId: contract.id },
      orderBy: { capturedAt: 'desc' },
    });

    const countedSince = snapshot?.countedSince ? new Date(snapshot.countedSince).toISOString() : null;
    const totalIsFloor = Boolean(snapshot?.totalIsFloor);

    let walletPubkeys: string[] = [];
    if (options.mine) {
      const profile = await prisma.profile.findUnique({
        where: { handle: handle.toLowerCase() },
        include: { wallets: { select: { pubkey: true } } },
      });
      walletPubkeys = profile?.wallets.map((w: any) => w.pubkey) ?? [];
    }

    const where: any = {
      contractId: contract.id,
      ...(options.mine ? { sourceAccount: { in: walletPubkeys } } : {}),
    };

    if (options.cursor) {
      const cursorDate = new Date(options.cursor.createdAt);
      where.OR = [
        { createdAt: { lt: cursorDate } },
        { createdAt: cursorDate, id: { lt: options.cursor.id } },
      ];
    }

    const [rows, total] = await Promise.all([
      prisma.contractInvocation.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      }),
      prisma.contractInvocation.count({
        where: {
          contractId: contract.id,
          ...(options.mine ? { sourceAccount: { in: walletPubkeys } } : {}),
        },
      }),
    ]);

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor(
            {
              createdAt:
                last.createdAt instanceof Date ? last.createdAt.toISOString() : new Date(last.createdAt).toISOString(),
              id: last.id,
            },
            2,
          )
        : null;

    const data: V1ContractInvocation[] = pageRows.map((r: any) => ({
      txHash: r.txHash,
      ledger: r.ledger,
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : new Date(r.createdAt).toISOString(),
      sourceAccount: r.sourceAccount,
      function: r.function ?? null,
      successful: Boolean(r.successful),
    }));

    return {
      data,
      meta: {
        nextCursor,
        total,
        source: 'database',
        countedSince,
        totalIsFloor,
      },
    };
  } catch {
    return {
      data: [],
      meta: {
        nextCursor: null,
        total: null,
        source: 'none',
        countedSince: null,
        totalIsFloor: false,
      },
    };
  }
}

type Ctx = { params: Promise<{ handle: string; address: string }> };

export function contractInvocationsHandler(deps: V1ContractInvocationsDeps = {}) {
  return (req: Request, ctx: Ctx): Promise<Response> =>
    withV1(
      async (request) => {
        const { handle: rawHandle, address: rawAddress } = await ctx.params;
        const handle = parseHandle(rawHandle);
        const address = parseAddress(rawAddress, 'C');
        const url = new URL(request.url);
        const limit = parseLimit(url.searchParams.get('limit'), 25, 100);
        const rawCursor = url.searchParams.get('cursor');
        const cursor = parseCursor<{ createdAt: string; id: string }>(rawCursor, [1, 2]);
        const mine = url.searchParams.get('mine') === 'true' || url.searchParams.get('mine') === '1';

        const result = await getV1ContractInvocations(
          handle,
          address,
          { cursor, limit, mine },
          deps,
        );
        return ok(result.data, result.meta);
      },
      { cache: INVOCATIONS_CACHE_CONTROL },
    )(req);
}
