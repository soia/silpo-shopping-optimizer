/**
 * Pre-import checks for the generated workflows.
 *
 * "Valid JSON" is not the same as "will import and run", so this verifies the
 * things that actually break in n8n: dangling connections, orphan nodes, broken
 * JS inside Code nodes, tool names that do not exist on the server, and secrets
 * accidentally baked into the file.
 *
 *   npm run validate
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FILES = ['workflows/telegram-bot.template.json', 'workflows/oauth-callback.template.json'];

interface WorkflowNode {
  name: string;
  type: string;
  parameters: { jsCode?: string };
}

interface Workflow {
  name: string;
  nodes: WorkflowNode[];
  connections: Record<string, { main?: Array<Array<{ node: string }>> }>;
}

const toolDump = JSON.parse(readFileSync(resolve(ROOT, 'data/mcp-tools.json'), 'utf8')) as { tools: Array<{ name: string }> };
const realTools = new Set(toolDump.tools.map((t) => t.name));

let errors = 0;
const fail = (message: string) => {
  console.log(`  FAIL  ${message}`);
  errors++;
};
const pass = (message: string) => console.log(`  ok    ${message}`);

for (const file of FILES) {
  console.log(`\n${file}`);
  const workflow = JSON.parse(readFileSync(resolve(ROOT, file), 'utf8')) as Workflow;
  const names = new Set(workflow.nodes.map((n) => n.name));

  if (!workflow.name || !Array.isArray(workflow.nodes) || typeof workflow.connections !== 'object') {
    fail('missing name, nodes or connections');
  } else {
    pass(`structure valid — ${workflow.nodes.length} nodes`);
  }

  if (names.size !== workflow.nodes.length) fail('duplicate node names');

  let linkCount = 0;
  for (const [from, outputs] of Object.entries(workflow.connections)) {
    if (!names.has(from)) fail(`connection from unknown node "${from}"`);
    for (const branch of outputs.main ?? []) {
      for (const connection of branch ?? []) {
        linkCount++;
        if (!names.has(connection.node)) fail(`"${from}" → unknown node "${connection.node}"`);
      }
    }
  }
  pass(`${linkCount} connections, all targets exist`);

  const targets = new Set(Object.values(workflow.connections).flatMap((o) => (o.main ?? []).flat().map((c) => c.node)));
  const orphans = workflow.nodes.filter((n) => !targets.has(n.name) && !/trigger|webhook/i.test(n.type));
  if (orphans.length) fail(`nodes with no input: ${orphans.map((n) => n.name).join(', ')}`);
  else pass('no orphan nodes');

  for (const node of workflow.nodes.filter((n) => n.type === 'n8n-nodes-base.code')) {
    const jsCode = node.parameters.jsCode ?? '';
    try {
      // n8n runs Code node bodies as an async function — compile it the same way.
      new Function(`return (async () => {\n${jsCode}\n})`);
      pass(`code compiles: ${node.name} (${jsCode.split('\n').length} lines)`);
    } catch (e) {
      fail(`syntax error in "${node.name}": ${(e as Error).message}`);
    }
  }

  const usedTools = new Set<string>();
  for (const node of workflow.nodes) {
    for (const match of (node.parameters.jsCode ?? '').matchAll(/call\(['"](silpo_[a-z_]+)['"]/g)) {
      usedTools.add(match[1]);
    }
  }
  for (const tool of usedTools) {
    if (!realTools.has(tool)) fail(`tool "${tool}" does not exist in tools/list`);
  }
  if (usedTools.size) pass(`${usedTools.size} MCP tools verified against tools/list`);

  const blob = JSON.stringify(workflow);
  const secretPatterns: Array<[RegExp, string]> = [
    [/\d{8,10}:AA[\w-]{30,}/, 'Telegram bot token'],
    [/sk-ant-[\w-]{20,}/, 'Anthropic API key'],
    [/postgres(ql)?:\/\/[^"\s]+:[^"\s]+@/, 'Postgres connection string'],
    [/"access_token"\s*:\s*"[\w.-]{20,}/, 'access token'],
  ];
  const leaks = secretPatterns.filter(([pattern]) => pattern.test(blob));
  if (leaks.length) leaks.forEach(([, label]) => fail(`${label} found in the workflow JSON`));
  else pass('no secrets embedded');
}

console.log(errors ? `\n${errors} problem(s) found\n` : '\nBoth workflows are ready to import\n');
process.exit(errors ? 1 : 0);
