import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';

const app = new Hono();

// Disable caching so freshly-built dist/ files are always served during dev.
app.use('/*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
});

// dist/ → served at root (index.js, koe-worklet.js, ...)
app.use('/*', serveStatic({ root: './dist' }));

// demo/ → served at root (index.html, ...)
app.use('/*', serveStatic({ root: './demo' }));

const port = Number(process.env.PORT) || 3000;
console.log(`\nkoe dev server → http://localhost:${port}\n`);

serve({ fetch: app.fetch, port });
