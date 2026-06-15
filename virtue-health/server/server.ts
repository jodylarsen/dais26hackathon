import { analytics, createApp, server } from '@databricks/appkit';
import { setupVirtueHealthRoutes } from './routes/virtue-health-routes';

createApp({
  plugins: [
    analytics({}),
    server(),
  ],
  async onPluginsReady(appkit) {
    setupVirtueHealthRoutes(appkit);
  },
}).catch(console.error);
