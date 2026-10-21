// Serverless Framework v3 plugin wrapper (CommonJS so require() works).
// Usage in a project's serverless.yml:
//   plugins:
//     - osls-console
const http = require('node:http');

class ServerlessConsoleOss {
  constructor(serverless, options, { log } = {}) {
    this.serverless = serverless;
    this.options = options || {};
    this.log = log ?? { notice: s => console.log(s), error: s => console.error(s) };
    this.commands = {
      console: {
        usage: 'Start a local dashboard (osls-console) for this project',
        lifecycleEvents: ['run'],
        options: {
          port: { usage: 'Port to serve on (default 3124)', type: 'string' },
          profile: { usage: 'AWS profile to use', type: 'string' },
          price: { usage: 'Lambda GB-second price in USD (default: us-east-1)', type: 'string' },
        },
      },
    };
    this.hooks = { 'console:run': this.run.bind(this) };
  }

  async run() {
    const opts = this.options;
    if (opts.profile) process.env.AWS_PROFILE = opts.profile;
    const { buildApp } = await import('./server.js');
    const { loadProject } = await import('./config.js');
    const project = await loadProject((this.serverless && this.serverless.config && this.serverless.config.serviceDir) || process.cwd());
    const price = opts.price != null ? Number(opts.price) : undefined;
    if (price != null && !(price > 0)) throw new Error('console.price must be a positive number (USD per GB-second).');
    const app = buildApp({ project, pricePerGbSecond: price });
    const server = http.createServer(app);
    const port = Number(opts.port || 3124);
    await new Promise((resolve, reject) => {
      server.listen(port, '127.0.0.1', () => {
        this.log.notice('osls-console -> http://localhost:' + port);
        resolve();
      });
      server.on('error', reject);
    });
    return new Promise(() => {}); // keep the framework process alive while serving
  }
}

module.exports = ServerlessConsoleOss;

