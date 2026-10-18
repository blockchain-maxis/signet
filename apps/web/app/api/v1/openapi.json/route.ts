import { withV1 } from '../../../../lib/api/v1/http.ts';
import { getOpenApiDocument } from '../../../../lib/api/v1/openapi.ts';

const handle = withV1(
  () =>
    new Response(JSON.stringify(getOpenApiDocument(), null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
      },
    }),
  { cache: 'public, max-age=300' },
);

export const GET = handle;
export const OPTIONS = handle;
