// @ts-check
import { defineConfig, fontProviders } from 'astro/config';
import starlight from '@astrojs/starlight';

import { REPO_URL, SITE_TITLE, SITE_TAGLINE } from './src/consts.ts';

// https://astro.build/config
export default defineConfig({
  // Canonical origin. Served at the root of its own subdomain, so no `base` is
  // needed and asset paths stay root-relative. `site` is what lets the sitemap
  // integration emit absolute URLs (without it, sitemap generation is skipped).
  site: 'https://zoetrope.furkankly.dev',
  //
  // Brand type, self-hosted at build time (no runtime font CDN): Space Mono for
  // the display voice (wordmark, headlines) and JetBrains Mono for UI/body and
  // the ASCII flow-graph on the landing (chosen for its solid box-drawing +
  // block-glyph coverage so `╭─┤├╮ ● ◌ ✓ ▓ █` render aligned). Exposed as CSS
  // variables the bespoke landing (`src/pages/index.astro`) and the brand CSS use.
  fonts: [
    {
      provider: fontProviders.google(),
      name: 'Space Mono',
      cssVariable: '--font-display',
      weights: [400, 700],
      styles: ['normal'],
      fallbacks: ['ui-monospace', 'SFMono-Regular', 'monospace'],
    },
    {
      provider: fontProviders.google(),
      name: 'JetBrains Mono',
      cssVariable: '--font-mono',
      weights: [400, 500, 700],
      styles: ['normal'],
      fallbacks: ['ui-monospace', 'SFMono-Regular', 'monospace'],
    },
  ],
  integrations: [
    starlight({
      title: SITE_TITLE,
      tagline: SITE_TAGLINE,
      description: SITE_TAGLINE,
      // src/assets/zoetrope.svg is a detailed flow-graph illustration — great
      // large in the hero, muddy as a tiny header glyph, which is why the header
      // went without a logo for a long time. src/assets/icon.svg is the other
      // thing: a mark drawn to hold at 16px, so it can sit beside the wordmark
      // rather than replace it (`replacesTitle: false` keeps the styled mono
      // title, see `.site-title` in zoetrope.css).
      //
      // Both this and public/favicon.svg are copies of assets/icon.svg at the
      // repo root, put here by `assets/build.sh sync` and compared by
      // `build.sh check` — Astro will not import from outside web/.
      logo: { src: './src/assets/icon.svg', replacesTitle: false },
      favicon: '/favicon.svg',
      social: [{ icon: 'github', label: 'GitHub', href: REPO_URL }],
      // The brand is a dark terminal; default to dark and keep a tidy light mode.
      customCss: ['./src/styles/zoetrope.css'],
      // The in-browser app lives at /app (a standalone Astro page, not a docs
      // route), so surface it as a top-level CTA in the sidebar.
      sidebar: [
        {
          label: 'Start here',
          items: [
            { label: 'What is zoetrope?', link: '/' },
            { label: 'Install', link: '/guides/install/' },
            { label: 'Usage & keys', link: '/guides/usage/' },
          ],
        },
        {
          label: 'Concepts',
          items: [{ label: 'Design & architecture', link: '/guides/design/' }],
        },
        {
          label: 'Try it',
          items: [
            {
              label: 'Open the browser app ↗',
              link: '/app',
              attrs: { target: '_self' },
              badge: { text: 'wasm', variant: 'tip' },
            },
          ],
        },
      ],
      components: {
        // Load the brand display font (Space Mono) on docs pages too, so their
        // headings match the landing. See `src/components/StarlightHead.astro`.
        Head: './src/components/StarlightHead.astro',
      },
    }),
  ],
});
