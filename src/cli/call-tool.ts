/**
 * Calls any Silpo MCP tool with the stored token. Useful for debugging and for
 * inspecting response shapes before wiring them into the workflow.
 *
 *   npm run call -- silpo_get_my_shopping_cart
 *   npm run call -- silpo_get_shopping_cart_by_id '{"shoppingCartId":"..."}'
 *   npm run call -- silpo_get_loyalty_info --keys
 *
 * Flags:
 *   --keys   print the structure (keys and types) instead of the values
 */

import { callTool } from '../lib/mcp.ts';

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const [toolName, argsJson] = args.filter((a) => !a.startsWith('--'));

if (!toolName) {
  console.error('Usage: npm run call -- <tool_name> [json-args] [--keys]');
  process.exit(1);
}

/** Replaces values with type descriptions so shapes can be shared safely. */
function shape(value: unknown, depth = 0): unknown {
  if (depth > 6) return '…';
  if (Array.isArray(value)) return value.length ? [shape(value[0], depth + 1), `…(${value.length})`] : [];
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v, depth + 1)]));
  }
  if (typeof value === 'string') return value.length > 40 ? 'string' : `string:${value}`;
  return `${typeof value}:${value}`;
}

const result = await callTool(toolName, argsJson ? JSON.parse(argsJson) : {});
console.log(JSON.stringify(flags.includes('--keys') ? shape(result) : result, null, 2));
