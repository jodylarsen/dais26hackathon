import { createApp, lakebase, server } from '@databricks/appkit';
import { setupSampleLakebaseRoutes } from './routes/lakebase/todo-routes';
import { setupVirtueHealthRoutes } from './routes/virtue-health-routes';

createApp({
  plugins: [
    lakebase(),
    server(),
  ],
  async onPluginsReady(appkit) {
    await setupSampleLakebaseRoutes(appkit);
    setupVirtueHealthRoutes(appkit);
  },
}).catch(console.error);
