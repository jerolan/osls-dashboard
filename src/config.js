import { readFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

/** Resolve and parse a Serverless Framework project's serverless.yml. */
export async function loadProject(root) {
  const file = path.join(root, 'serverless.yml');
  const raw = await readFile(file, 'utf8');
  const yml = YAML.parse(raw);

  const provider = yml?.provider ?? {};
  if (String(provider.name !== undefined ? provider.name : 'aws').toLowerCase() !== 'aws') {
    throw new Error('osls-console only supports AWS for now. (provider.name = ' + (provider.name ?? 'default') + ')');
  }
  const stage = process.env.SLS_STAGE || provider.stage || 'dev';
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || provider.region || 'us-east-1';
  const service = yml?.service?.name ?? yml?.service ?? path.basename(root);

  const functions = [];
  for (const [key, def] of Object.entries(yml?.functions ?? {})) {
    functions.push({
      key,
      declaredName: typeof def === 'object' && def !== null ? (def.name ?? null) : null,
      handler: def?.handler ?? null,
      runtime: def?.runtime ?? provider.runtime ?? null,
      memory: def?.memorySize ?? provider.memorySize ?? 1024,
      timeout: def?.timeout ?? provider.timeout ?? 6,
      events: Array.isArray(def?.events) ? def.events.map(e => Object.keys(e ?? {})?.[0] ?? 'unknown') : [],
    });
  }
  return { root, file, service, stage, region, functions };
}

