const fs = require('node:fs');
const { createApp, PORT, STUDIO_MODE } = require('./server/app');
const { createProjectPaths } = require('./server/config/project-paths');

if (require.main === module){
  const { ENV_FILE_PATH } = createProjectPaths({ studioDir: __dirname });
  if (!fs.existsSync(ENV_FILE_PATH)){
    console.warn('');
    console.warn('[CONFIG] WARNING: .env file not found.');
    console.warn(`[CONFIG] Expected: ${ENV_FILE_PATH}`);
    console.warn('[CONFIG] Copy .env.example to .env and configure it before using Data Vault Studio.');
    console.warn('');
  }

  const app = createApp();
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`Data Vault Studio introspection server listening on http://127.0.0.1:${PORT}`);
    console.log(`Studio mode: ${STUDIO_MODE}`);
    console.log('This server only accepts connections from your own machine.');
    console.log('');
    console.log(`Open the GUI at:  http://127.0.0.1:${PORT}/`);
  });
}

module.exports = { createApp };
