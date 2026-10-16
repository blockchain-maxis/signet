# Standalone SVG verification (#506)

These images use the committed `blend-pool-v1` spec fixture, passed through
`buildContractGraph`, `layoutContractGraph` and `renderStandaloneSvg` with the
fixture's original address, network and WASM hash. They are test evidence, not
production data or a newly fetched contract snapshot.

- `browser-*.png`: Chromium 151 screenshots of the exported SVG document itself.
- `inkscape-*.png`: Inkscape 1.4.4 rasterizations of those same SVG files using
  `inkscape <file.svg> --export-type=png --export-filename=<output.png>`.

Both explicit themes were opened and visually checked for labels, edges and
complete provenance. Chromium also verified auto mode under both emulated
color schemes, all 36 node elements, and absence of XML parser errors. Inkscape
uses its installed monospace fallback, so glyph rendering differs from Chromium.
