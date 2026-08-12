/**
 * Deployment-specific values.
 *
 * The defaults here are placeholders so the repository stays free of anyone's
 * instance. Real values live in `.secrets/n8n.json` (gitignored) and override
 * these at build time:
 *
 * ```json
 * {
 *   "baseUrl": "https://your-instance.app.n8n.cloud",
 *   "tables": { "oauthState": "...", "sessions": "...", "plans": "..." }
 * }
 * ```
 *
 * Table ids come from n8n (Overview → Data tables) and are visible in the URL of
 * each table. Recreating a table changes its id.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OVERRIDE_FILE = resolve(ROOT, '.secrets/n8n.json');

export interface DeploymentConfig {
  /** Public HTTPS base of the n8n instance; the OAuth redirect is built from it. */
  baseUrl: string;
  tables: {
    oauthState: string;
    sessions: string;
    plans: string;
  };
}

export const PLACEHOLDERS: DeploymentConfig = {
  baseUrl: 'https://your-instance.app.n8n.cloud',
  tables: {
    oauthState: 'REPLACE_WITH_OAUTH_STATE_TABLE_ID',
    sessions: 'REPLACE_WITH_SESSIONS_TABLE_ID',
    plans: 'REPLACE_WITH_PLANS_TABLE_ID',
  },
};

function load(): DeploymentConfig {
  if (!existsSync(OVERRIDE_FILE)) return PLACEHOLDERS;
  const override = JSON.parse(readFileSync(OVERRIDE_FILE, 'utf8')) as Partial<DeploymentConfig>;
  return {
    baseUrl: override.baseUrl ?? PLACEHOLDERS.baseUrl,
    tables: { ...PLACEHOLDERS.tables, ...(override.tables ?? {}) },
  };
}

/** Real values when `.secrets/n8n.json` exists, placeholders otherwise. */
export const deployment = load();

export const hasDeployment = existsSync(OVERRIDE_FILE);

/**
 * Rewrites a placeholder build into a deployable one.
 *
 * The tracked `workflows/*.json` are always built from placeholders, so the
 * repository never carries anyone's instance and the working tree stays clean
 * after a rebuild. The personalised copy is written to `.secrets/workflows/`.
 */
export function personalise(json: string): string {
  let out = json.split(PLACEHOLDERS.baseUrl).join(deployment.baseUrl);
  for (const key of Object.keys(PLACEHOLDERS.tables) as Array<keyof DeploymentConfig['tables']>) {
    out = out.split(PLACEHOLDERS.tables[key]).join(deployment.tables[key]);
  }
  return out;
}
