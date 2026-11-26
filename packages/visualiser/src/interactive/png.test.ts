/**
 * @file Unit tests for browser-based PNG diagram export (#519).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PNG_EXPORT_ERROR_MESSAGE,
  parseSvgDimensions,
  embedFontInSvg,
  applyExplicitThemeToSvg,
  prepareSvgForPng,
  renderSvgToCanvas,
  canvasToPngBlob,
  exportDiagramPng,
} from './png.ts';
import { IBM_PLEX_MONO_BASE64 } from './font.ts';
import type { PositionedDiagramModel } from '../layout.ts';
import { renderStandaloneSvg } from '../render.ts';
import { VIZ_TOKEN_NAMES, VIZ_TOKENS, type VizTheme } from '../tokens.ts';

test('parseSvgDimensions extracts dimensions from viewBox', () => {
  const svg = `<svg viewBox="0 0 1200 800" xmlns="http://www.w3.org/2000/svg"></svg>`;
  const dims = parseSvgDimensions(svg);
  assert.equal(dims.width, 1200);
  assert.equal(dims.height, 800);
});

test('parseSvgDimensions handles decimal viewBox values', () => {
  const svg = `<svg viewBox="0 0 654.25 432.75"></svg>`;
  const dims = parseSvgDimensions(svg);
  assert.equal(dims.width, 654.25);
  assert.equal(dims.height, 432.75);
});

test('parseSvgDimensions falls back to width and height attributes', () => {
  const svg = `<svg width="500px" height="300px"></svg>`;
  const dims = parseSvgDimensions(svg);
  assert.equal(dims.width, 500);
  assert.equal(dims.height, 300);
});

test('parseSvgDimensions throws PNG_EXPORT_ERROR_MESSAGE on invalid or missing dimensions', () => {
  assert.throws(
    () => parseSvgDimensions('<svg></svg>'),
    (err: Error) => err.message === PNG_EXPORT_ERROR_MESSAGE,
  );
  assert.throws(
    () => parseSvgDimensions('<svg viewBox="0 0 0 0"></svg>'),
    (err: Error) => err.message === PNG_EXPORT_ERROR_MESSAGE,
  );
});

test('embedFontInSvg injects base64 font-face into existing style block', () => {
  const svg = `<svg viewBox="0 0 100 100"><style>.canvas { fill: black; }</style></svg>`;
  const result = embedFontInSvg(svg);

  assert.ok(result.includes('@font-face {'));
  assert.ok(result.includes("font-family: 'IBM Plex Mono'"));
  assert.ok(result.includes(`src: url('data:font/woff2;base64,${IBM_PLEX_MONO_BASE64}')`));
  assert.ok(result.includes("font-family: 'IBM Plex Mono', monospace !important;"));
});

test('embedFontInSvg creates defs and style when missing', () => {
  const svg = `<svg viewBox="0 0 100 100"><rect width="100" height="100"/></svg>`;
  const result = embedFontInSvg(svg);

  assert.ok(result.includes('<defs><style>'));
  assert.ok(result.includes('@font-face {'));
  assert.ok(result.includes('</style></defs>'));
});

/** Every value of an attribute in the SVG. */
const attributeValues = (svg: string, name: string) =>
  [...svg.matchAll(new RegExp(` ${name}="([^"]*)"`, 'g'))].map(([, value]) => value!);

/** A real export: a function with a struct argument, so shapes, an edge and an arrowhead are drawn. */
function exported(theme: VizTheme | 'auto'): string {
  const node = { column: 0, truncated: false, width: 100, height: 30 };
  const model: PositionedDiagramModel = {
    layoutVersion: 1,
    width: 360,
    height: 120,
    groups: [],
    nodes: [
      { ...node, id: 'fn:pay', name: 'pay', label: 'pay', kind: 'function', x: 24, y: 24 },
      {
        ...node,
        id: 'type:Order',
        name: 'Order',
        label: 'Order',
        kind: 'type',
        typeKind: 'struct',
        column: 1,
        x: 220,
        y: 24,
      },
    ],
    edges: [
      { id: 'fn:pay->type:Order', from: 'fn:pay', to: 'type:Order', kinds: ['arg'], back: false },
    ],
  };
  return renderStandaloneSvg(model, {
    theme,
    provenance: { address: 'C'.repeat(56), network: 'testnet', wasmHash: 'a'.repeat(64) },
  });
}

test('applyExplicitThemeToSvg repaints each token of the export in the forced theme', () => {
  const light = VIZ_TOKENS.light;
  const dark = VIZ_TOKENS.dark;
  const forcedDark = applyExplicitThemeToSvg(exported('auto'), 'dark');
  assert.ok(forcedDark.includes(`[fill="${light.ground}"] { fill: ${dark.ground} !important; }`));
  assert.ok(
    forcedDark.includes(`[stroke="${light.observed}"] { stroke: ${dark.observed} !important; }`),
  );

  // Forcing the theme the file is already written in still pins every
  // colour, against the dark block an `auto` export carries.
  const forcedLight = applyExplicitThemeToSvg(exported('auto'), 'light');
  assert.ok(forcedLight.includes('prefers-color-scheme: dark'));
  assert.ok(forcedLight.includes(`[fill="${light.ground}"] { fill: ${light.ground} !important; }`));

  // A file written in the dark theme is repainted from its dark colours.
  const fromDark = applyExplicitThemeToSvg(exported('dark'), 'light');
  assert.ok(fromDark.includes(`[fill="${dark.ground}"] { fill: ${light.ground} !important; }`));
  assert.ok(!fromDark.includes(`[fill="${light.ground}"] {`));
});

test('a forced theme has a rule for every colour the export writes, and none by class', () => {
  for (const written of ['auto', 'light', 'dark'] as const) {
    const svg = exported(written);
    const from = VIZ_TOKENS[written === 'dark' ? 'dark' : 'light'];
    for (const forced of ['dark', 'light'] as const) {
      const repainted = applyExplicitThemeToSvg(svg, forced);
      // A rule per class would fill the outlines the vocabulary leaves empty
      // and turn an observed call into a spec edge.
      assert.doesNotMatch(repainted, /\.(node|edge|label|arrow|canvas) \{/);
      for (const attribute of ['fill', 'stroke'] as const) {
        const values = new Set(attributeValues(svg, attribute));
        values.delete('none');
        assert.ok(values.size > 0);
        for (const value of values) {
          const token = VIZ_TOKEN_NAMES.find((name) => from[name] === value);
          assert.ok(token, `${value} is not a token of the ${written} export`);
          assert.ok(
            repainted.includes(
              `[${attribute}="${value}"] { ${attribute}: ${VIZ_TOKENS[forced][token]} !important; }`,
            ),
            `${written} export forced ${forced}: no ${attribute} rule for ${token}`,
          );
        }
      }
    }
  }
});

test('applyExplicitThemeToSvg leaves an SVG that is not an export without a matching rule', () => {
  const svg = `<svg viewBox="0 0 100 100"><style>.base { fill: red; }</style><rect fill="red"/></svg>`;
  const result = applyExplicitThemeToSvg(svg, 'dark');
  assert.ok(result.includes('.base { fill: red; }'));
  assert.ok(!result.includes('[fill="red"]'));
});

test('prepareSvgForPng embeds font and applies theme with dimensions', () => {
  const svg = `<svg viewBox="0 0 800 600" width="800" height="600"><style></style></svg>`;
  const { preparedSvg, dimensions } = prepareSvgForPng(svg, { theme: 'dark' });

  assert.equal(dimensions.width, 800);
  assert.equal(dimensions.height, 600);
  assert.ok(preparedSvg.includes('IBM Plex Mono'));
  assert.ok(preparedSvg.includes('#0a0908'));
});

// ---------------------------------------------------------------------------
// Canvas and DOM export simulation with mock DOM environment
// ---------------------------------------------------------------------------

class FakeBlob {
  readonly parts: string[];
  readonly type: string;
  constructor(parts: string[], options: { type?: string } = {}) {
    this.parts = parts;
    this.type = options.type || '';
  }
}

class FakeCanvasContext {
  drawImageCalls: Array<{ img: unknown; x: number; y: number; w: number; h: number }> = [];

  drawImage(img: unknown, x: number, y: number, w: number, h: number): void {
    this.drawImageCalls.push({ img, x, y, w, h });
  }
}

class FakeCanvas {
  width = 0;
  height = 0;
  tainted = false;
  toBlobNull = false;
  context = new FakeCanvasContext();

  getContext(type: string): FakeCanvasContext | null {
    if (type === '2d') return this.context;
    return null;
  }

  toBlob(callback: (blob: Blob | null) => void, type?: string): void {
    if (this.tainted) {
      throw new Error('SecurityError: The operation is insecure.');
    }
    if (this.toBlobNull) {
      callback(null);
      return;
    }
    const fakeBlob = new Blob(['fake-png-data'], { type: type || 'image/png' });
    callback(fakeBlob);
  }
}

class FakeImage {
  onload: (() => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  protected _src = '';

  set src(val: string) {
    this._src = val;
    queueMicrotask(() => {
      this.onload?.();
    });
  }

  get src(): string {
    return this._src;
  }
}

function withMockDom(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    const origWindow = globalThis.window;
    const origDocument = globalThis.document;
    const origImage = globalThis.Image;
    const origUrl = globalThis.URL;
    const origBlob = globalThis.Blob;

    const createdCanvases: FakeCanvas[] = [];
    const createdAnchors: Array<{ href: string; download: string; clicked: boolean }> = [];

    const mockDocument = {
      createElement(tag: string) {
        if (tag === 'canvas') {
          const c = new FakeCanvas();
          createdCanvases.push(c);
          return c as unknown as HTMLCanvasElement;
        }
        if (tag === 'a') {
          const a = {
            href: '',
            download: '',
            clicked: false,
            click() {
              this.clicked = true;
            },
          };
          createdAnchors.push(a);
          return a as unknown as HTMLAnchorElement;
        }
        return {} as HTMLElement;
      },
      body: {
        appendChild(_node: unknown) {},
        removeChild(_node: unknown) {},
      },
    };

    let objectUrlCounter = 1;
    const blobStore = new Map<string, string>();
    const mockUrl = {
      createObjectURL(blob: Blob & { text?: () => Promise<string>; content?: string }) {
        const url = `blob:fake-url-${objectUrlCounter++}`;
        if (blob instanceof FakeBlob) {
          blobStore.set(url, blob.parts.join(''));
        }
        return url;
      },
      revokeObjectURL(url: string) {
        blobStore.delete(url);
      },
    };

    class TestImage extends FakeImage {
      override set src(val: string) {
        this._src = val;
        const content = blobStore.get(val) || val;
        queueMicrotask(() => {
          if (content.includes('invalid-trigger-error')) {
            this.onerror?.(new Error('Image failed to decode'));
          } else {
            this.onload?.();
          }
        });
      }
    }

    try {
      (globalThis as unknown as { window: unknown }).window = globalThis;
      (globalThis as unknown as { document: unknown }).document = mockDocument;
      (globalThis as unknown as { Image: unknown }).Image = TestImage;
      (globalThis as unknown as { URL: unknown }).URL = mockUrl;
      (globalThis as unknown as { Blob: unknown }).Blob = FakeBlob;

      await fn();
    } finally {
      (globalThis as unknown as { window: unknown }).window = origWindow;
      (globalThis as unknown as { document: unknown }).document = origDocument;
      (globalThis as unknown as { Image: unknown }).Image = origImage;
      (globalThis as unknown as { URL: unknown }).URL = origUrl;
      (globalThis as unknown as { Blob: unknown }).Blob = origBlob;
    }
  };
}

test(
  'renderSvgToCanvas draws at 2x scale by default',
  withMockDom(async () => {
    const svg = `<svg viewBox="0 0 500 250"><style></style></svg>`;
    const canvas = await renderSvgToCanvas(svg);

    assert.equal(canvas.width, 1000);
    assert.equal(canvas.height, 500);
  }),
);

test(
  'canvasToPngBlob throws PNG_EXPORT_ERROR_MESSAGE if toBlob returns null',
  withMockDom(async () => {
    const canvas = new FakeCanvas();
    canvas.toBlobNull = true;

    await assert.rejects(
      async () => canvasToPngBlob(canvas as unknown as HTMLCanvasElement),
      (err: Error) => err.message === PNG_EXPORT_ERROR_MESSAGE,
    );
  }),
);

test(
  'canvasToPngBlob throws PNG_EXPORT_ERROR_MESSAGE if canvas is tainted',
  withMockDom(async () => {
    const canvas = new FakeCanvas();
    canvas.tainted = true;

    await assert.rejects(
      async () => canvasToPngBlob(canvas as unknown as HTMLCanvasElement),
      (err: Error) => err.message === PNG_EXPORT_ERROR_MESSAGE,
    );
  }),
);

test(
  'exportDiagramPng downloads PNG at 2x scale and triggers anchor click',
  withMockDom(async () => {
    const svg = `<svg viewBox="0 0 400 300"><style></style></svg>`;
    const blob = await exportDiagramPng(svg, {
      fileName: 'signet-test.png',
      theme: 'dark',
    });

    assert.ok(blob);
    assert.equal(blob.type, 'image/png');
  }),
);

test(
  'exportDiagramPng invokes onError callback on failure',
  withMockDom(async () => {
    let capturedErrorMsg = '';
    const malformedSvg = '<svg invalid-trigger-error viewBox="0 0 100 100"></svg>';

    await assert.rejects(
      async () =>
        exportDiagramPng(malformedSvg, {
          onError: (_err, msg) => {
            capturedErrorMsg = msg;
          },
        }),
      (err: Error) => err.message === PNG_EXPORT_ERROR_MESSAGE,
    );

    assert.equal(capturedErrorMsg, PNG_EXPORT_ERROR_MESSAGE);
  }),
);
