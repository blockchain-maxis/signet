// Marketing layout (signet.dev root).
// Intentionally a passthrough: the marketing route is a single page that composes its
// own chrome — nav in sections/hero.tsx, footer in components/footer.tsx, theming in
// app/globals.css.
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return <main>{children}</main>;
}
