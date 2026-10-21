#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import http from 'node:http';
import { loadProject } from './config.js';
import { buildApp } from './server.js';

const argv = process.argv.slice(2);
const flags = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--cwd') flags.cwd = argv[++i];
  else if (a === '--port') flags.port = Number(argv[++i]);
  else if (a === '--profile') flags.profile = argv[++i];
  else if (a === '--host') flags.host = argv[++i];
  else if (a === '--price-gb-second') flags.price = Number(argv[++i]);
  else if (a === '--stage' || a === '-s') process.env.SLS_STAGE = argv[++i];
  else if (a === '--help' || a === '-h') {
    console.log('Usage: osls-console [--cwd <path>] [--port 3124] [--host 127.0.0.1] [--profile <aws-profile>] [--stage <stage>] [--price-gb-second <usd>]');
    process.exit(0);
  } else {
    console.error('Unknown flag: ' + a);
    process.exit(1);
  }
}

const root = path.resolve(flags.cwd ?? process.cwd());
const port = flags.port ?? 3124;

if (flags.price != null && !(flags.price > 0)) {
  console.error('--price-gb-second must be a positive number (USD per GB-second).');
  process.exit(1);
}

if (flags.profile) {
  process.env.AWS_PROFILE = flags.profile;
}

try {
  const project = await loadProject(root);
  const app = buildApp({ project, pricePerGbSecond: flags.price });
  const server = http.createServer(app);
  const host = flags.host ?? '127.0.0.1';
  server.listen(port, host, () => {
    const url = 'http://' + (host === '0.0.0.0' ? '<host-ip>' : host) + ':' + port;
    console.log('');
    console.log('  osls-console ' + '— ' + project.service + ' [' + project.stage + '@' + project.region + ']');
    console.log('  serving ' + url);
    console.log('');
    // Attempt to auto-open the browser (best effort, no hard failure).
    import('node:child_process').then(cp => {
      const { spawn } = cp;
      const plat = process.platform;
      const trySpawn = (cmd, args) => {
        try {
          const p = spawn(cmd, args, { stdio: 'ignore', detached: true });
          p.on('error', () => {}); // best effort only; some hosts have no opener
          p.unref();
        } catch {}
      };
      if (host !== '0.0.0.0') {
        if (plat === 'darwin') trySpawn('open', [url]);
        else if (plat === 'linux') trySpawn('xdg-open', [url]);
        else if (plat === 'win32') trySpawn('cmd', ['/c', 'start', url]);
      }
    });
  });
} catch (err) {
  console.error('osls-console could not start in ' + root);
  console.error('  ' + (err?.message ?? err));
  console.error('');
  console.error('Make sure you are inside a Serverless Framework project (serverless.yml exists and is valid).');
  process.exit(1);
}

