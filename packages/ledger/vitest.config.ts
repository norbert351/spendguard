import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
  },
  // Top-level vite SSR externalization — this is what vite-node honors when
  // deciding whether to pull a bare import into the module graph. node:sqlite
  // is experimental (Node 22) and not yet in vite-node's builtin list, so we
  // must force it external or vite tries to load bare `sqlite`.
  ssr: {
    external: ['node:sqlite', 'node:crypto'],
  },
});