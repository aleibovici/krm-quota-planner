import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startScratchServer } from '../test/helpers/scratch-git.mjs';

const e2eDir = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.E2E_PORT || 4791);

const { app, repo } = await startScratchServer({ port, cluster: false });
writeFileSync(join(e2eDir, '.fixture-env.json'), JSON.stringify({ repo, url: app.url }));

const shutdown = () => {
  app.server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
