import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z, type ZodRawShape } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * Deferred tool loading: three meta-tools instead of the whole surface.
 *
 * An MCP client loads every registered tool's description before it can make a
 * call. At 155 tools that is ~58k tokens spent before the first question is
 * asked. Registering three tools instead, and serving the rest as data, cuts
 * that to a few thousand.
 *
 *   1. tool_search   — which tools exist, by group
 *   2. tool_schema   — the argument schema for one tool
 *   3. tool_execute  — run a tool by name
 *
 * The inner tools are never registered with the SDK. They are captured from the
 * same registerXTools() functions the flat surface uses, so the two modes cannot
 * diverge: there is one implementation, exposed two ways.
 *
 * The known failure mode, learned the expensive way on the in-product agent: if
 * the model cannot see that a capability EXISTS, it reports it as impossible
 * rather than searching for it. A group name alone ("there are evaluator tools")
 * never says the words "evaluator_update". The agent solves this by injecting a
 * per-tool catalog into its system prompt. There is no system prompt here — the
 * only text guaranteed to reach the model is a registered tool's description —
 * so tool_search's description carries the group list WITH example tool names,
 * generated from the captured set so it cannot drift.
 */

/** One captured tool: everything needed to describe, validate and run it. */
export interface CapturedTool {
  name: string;
  description: string;
  shape: ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<CallToolResult>;
}

/**
 * A stand-in for McpServer that records `.tool()` calls instead of registering.
 *
 * The tool modules are written against McpServer and stay untouched; they just
 * get handed this instead. Only `.tool()` is exercised by them.
 */
export function captureTools(register: (server: McpServer) => void): Map<string, CapturedTool> {
  const captured = new Map<string, CapturedTool>();
  const recorder = {
    tool(
      name: string,
      description: string,
      shape: ZodRawShape,
      handler: (args: Record<string, unknown>) => Promise<CallToolResult>,
    ) {
      // Last registration wins, matching the SDK's own overwrite behaviour, so
      // hand-written modules keep beating the generated layer as before.
      captured.set(name, { name, description, shape, handler });
    },
  };
  register(recorder as unknown as McpServer);
  return captured;
}

/**
 * Group definitions. `prefixes` are matched against the tool name's first
 * segment; a tool matching none lands in `other` rather than disappearing.
 *
 * The blurb answers "would the tool I need be in here?" — it is the only thing
 * the model reads before choosing a group.
 */
interface GroupSpec {
  key: string;
  prefixes: string[];
  blurb: string;
}

const GROUPS: GroupSpec[] = [
  { key: 'logs', prefixes: ['log'], blurb: 'Individual LLM request logs: browse, read one in full, count and aggregate.' },
  { key: 'traces', prefixes: ['trace'], blurb: 'Multi-span traces and their span trees.' },
  { key: 'threads', prefixes: ['thread'], blurb: 'Conversation threads grouped by session.' },
  { key: 'customers', prefixes: ['customer', 'end'], blurb: 'Your end users: activity, spend and budgets.' },
  { key: 'pulses', prefixes: ['pulse'], blurb: 'Error groups, incidents and behaviour rollups.' },
  { key: 'dashboard', prefixes: ['dashboard'], blurb: 'Aggregate analytics: cost, latency, quantiles, storage, top models/providers/prompts.' },
  { key: 'scores', prefixes: ['score'], blurb: 'Evaluation scores attached to logs.' },
  { key: 'prompts', prefixes: ['prompt'], blurb: 'Prompt templates: versions, commits and deployment.' },
  { key: 'experiments', prefixes: ['experiment'], blurb: 'Offline experiments over a dataset.' },
  { key: 'datasets', prefixes: ['dataset'], blurb: 'Datasets and the logs inside them.' },
  { key: 'graders', prefixes: ['grader'], blurb: 'Graders: the single scoring units an evaluator is built from.' },
  { key: 'evaluators', prefixes: ['evaluator'], blurb: 'Evaluators: the user-visible grading pipelines composed of graders.' },
  { key: 'monitors', prefixes: ['monitor'], blurb: 'Monitors: watch incoming telemetry and alert when a condition trips.' },
  { key: 'automations', prefixes: ['automation'], blurb: 'Automations: run a task sequence against incoming telemetry (online eval).' },
  { key: 'reports', prefixes: ['report'], blurb: 'Reports: scheduled digests assembled from logs, traces and pulses.' },
  { key: 'annotations', prefixes: ['annotation'], blurb: 'Human annotation items and review queues.' },
  { key: 'notifications', prefixes: ['notification'], blurb: 'Notification methods: Slack, Teams, email, webhook, PagerDuty, SMS.' },
  { key: 'organization', prefixes: ['org'], blurb: 'Your organization, its members and its subscription.' },
  { key: 'api_keys', prefixes: ['api'], blurb: 'API keys and their usage ranking.' },
  { key: 'credits', prefixes: ['credit'], blurb: 'Credit balance and transaction history.' },
  { key: 'limits', prefixes: ['limit'], blurb: 'Spend and rate limit policies, and their current state.' },
  { key: 'integrations', prefixes: ['integration'], blurb: 'Third-party integrations and their status.' },
  { key: 'models', prefixes: ['model'], blurb: 'The model catalog available to your organization.' },
  { key: 'providers', prefixes: ['provider'], blurb: 'LLM provider catalog.' },
  { key: 'webhooks', prefixes: ['webhook'], blurb: 'Outbound webhooks.' },
  { key: 'exports', prefixes: ['export'], blurb: 'Export jobs.' },
  { key: 'docs', prefixes: ['docs'], blurb: 'Search the Respan documentation.' },
];

const OTHER_GROUP = 'other';

function groupOf(toolName: string): string {
  const head = toolName.split('_')[0];
  return GROUPS.find(g => g.prefixes.includes(head))?.key ?? OTHER_GROUP;
}

/** Tools grouped, in GROUPS order, skipping any group that captured nothing. */
function byGroup(tools: Map<string, CapturedTool>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const name of [...tools.keys()].sort()) {
    const key = groupOf(name);
    if (!out.has(key)) out.set(key, []);
    out.get(key)!.push(name);
  }
  // Reorder to GROUPS order so the description reads in a deliberate sequence.
  const ordered = new Map<string, string[]>();
  for (const g of GROUPS) if (out.has(g.key)) ordered.set(g.key, out.get(g.key)!);
  if (out.has(OTHER_GROUP)) ordered.set(OTHER_GROUP, out.get(OTHER_GROUP)!);
  return ordered;
}

/**
 * Example tool names for a group, chosen so the model sees a real name it can
 * recognise. Read-first verbs lead, because that is where most tasks start.
 */
const EXAMPLE_VERB_ORDER = ['_list', '_get', '_search', '_summary', '_create', '_update'];

function examplesFor(names: string[], limit = 3): string[] {
  const picked: string[] = [];
  for (const suffix of EXAMPLE_VERB_ORDER) {
    const hit = names.find(n => n.endsWith(suffix) && !picked.includes(n));
    if (hit) picked.push(hit);
    if (picked.length === limit) return picked;
  }
  for (const n of names) {
    if (!picked.includes(n)) picked.push(n);
    if (picked.length === limit) break;
  }
  return picked;
}

/**
 * tool_search's description: the group catalog, built from the captured tools.
 *
 * Generated rather than written, so adding a tool updates the text that tells
 * the model it exists.
 */
function buildSearchDescription(grouped: Map<string, string[]>, total: number): string {
  const lines = [
    `Find the tools available on this server. ${total} tools exist; they are not loaded upfront, so this is how you discover them.`,
    '',
    'IMPORTANT: every capability below EXISTS and is callable. If a task needs one, call this tool to get its exact name, then tool_execute. A tool you have not loaded yet is never a reason to tell the user something cannot be done.',
    '',
    'Call with a group to list its tools, or with a query to search by keyword across all of them.',
    '',
    'GROUPS:',
  ];
  for (const [key, names] of grouped) {
    const blurb = GROUPS.find(g => g.key === key)?.blurb ?? 'Uncategorized tools.';
    const examples = examplesFor(names);
    const more = names.length - examples.length;
    const tail = more > 0 ? `, +${more} more` : '';
    lines.push(`  ${key} (${names.length}) — ${blurb}`);
    lines.push(`    e.g. ${examples.join(', ')}${tail}`);
  }
  return lines.join('\n');
}

/**
 * Words carrying no signal in a tool query. Without this, a natural-language
 * question scores on its filler: "how much did we spend" matched webhook_list,
 * because "we" is a substring of "webhook".
 */
const STOPWORDS = new Set([
  'a', 'all', 'am', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'by', 'can', 'did', 'do',
  'does', 'for', 'from', 'get', 'give', 'has', 'have', 'how', 'i', 'in', 'is', 'it', 'its',
  'many', 'me', 'much', 'my', 'of', 'on', 'or', 'our', 'show', 'that', 'the', 'their',
  'them', 'there', 'they', 'this', 'to', 'us', 'was', 'we', 'were', 'what', 'when', 'where',
  'which', 'who', 'with', 'you', 'your',
]);

/** Query words that map onto the vocabulary the descriptions actually use. */
const SYNONYMS: Record<string, string[]> = {
  spend: ['cost', 'usage', 'billing'],
  spent: ['cost', 'usage', 'billing'],
  money: ['cost', 'credit'],
  price: ['cost'],
  error: ['error', 'failure', 'incident'],
  errors: ['error', 'failure', 'incident'],
  slow: ['latency'],
  speed: ['latency', 'tokens_per_second'],
  alert: ['monitor', 'notification'],
  alerts: ['monitor', 'notification'],
  user: ['customer'],
  users: ['customer'],
  eval: ['evaluator', 'grader', 'score'],
  evals: ['evaluator', 'grader', 'score'],
  test: ['experiment', 'grader'],
  chart: ['dashboard'],
  graph: ['dashboard'],
};

/**
 * Rank tools against a free-text query.
 *
 * Name matches outrank description matches, because a model that half-remembers
 * a tool is usually half-remembering its name.
 */
function searchTools(tools: Map<string, CapturedTool>, query: string): string[] {
  const raw = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length >= 3 && !STOPWORDS.has(t));
  const terms = new Set(raw);
  for (const term of raw) {
    for (const syn of SYNONYMS[term] ?? []) terms.add(syn);
    // Tool names are singular ("evaluator_list"), questions are usually plural
    // ("what evaluators do we have"). Without this the plural only ever matches
    // prose, so a sibling tool that mentions the noun outranks the tool named
    // after it.
    if (term.endsWith('s') && term.length > 3) terms.add(term.slice(0, -1));
  }
  if (terms.size === 0) return [];

  const scored: Array<{ name: string; score: number }> = [];
  for (const tool of tools.values()) {
    const nameParts = new Set(tool.name.toLowerCase().split('_'));
    const description = tool.description.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (nameParts.has(term)) score += 5;
      else if (tool.name.toLowerCase().includes(term)) score += 3;
      else if (new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(description)) {
        score += 1;
      }
    }
    if (score > 0) scored.push({ name: tool.name, score });
  }
  // On a tie, the plainer name wins: prompt_list before prompt_backup_list.
  // A shorter name is the more general tool, which is the better first guess.
  return scored
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.name.split('_').length - b.name.split('_').length ||
        a.name.localeCompare(b.name),
    )
    .map(s => s.name);
}

/** First sentence of a description, trimmed — enough to tell tools apart. */
function summarize(description: string, max = 160): string {
  const firstSentence = /^(.*?[.!?])(\s|$)/.exec(description.trim());
  const text = (firstSentence ? firstSentence[1] : description).trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function textResult(payload: unknown): CallToolResult {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

/**
 * Registers the three meta-tools in place of the full surface.
 *
 * `register` is the same function the flat surface uses, so both modes run the
 * identical handlers.
 */
export function registerDeferredTools(
  server: McpServer,
  register: (server: McpServer) => void,
): void {
  const tools = captureTools(register);
  const grouped = byGroup(tools);
  const groupKeys = [...grouped.keys()];

  server.tool(
    'tool_search',
    buildSearchDescription(grouped, tools.size),
    {
      group: z
        .enum(groupKeys as [string, ...string[]])
        .optional()
        .describe('List every tool in this group. Group names are in this tool\'s description.'),
      query: z
        .string()
        .optional()
        .describe('Search tool names and descriptions by keyword, across all groups. Use when you do not know which group fits.'),
    },
    async ({ group, query }) => {
      if (!group && !query) {
        return textResult({
          groups: groupKeys.map(key => ({
            group: key,
            tool_count: grouped.get(key)!.length,
            description: GROUPS.find(g => g.key === key)?.blurb ?? '',
          })),
          next_step: 'Call tool_search again with a group, or with a query to search by keyword.',
        });
      }
      const names = group ? grouped.get(group)! : searchTools(tools, query!);
      if (names.length === 0) {
        return textResult({
          query,
          tools: [],
          message: `Nothing matched "${query}". Try a broader term, or call tool_search with no arguments to see every group.`,
        });
      }
      return textResult({
        ...(group ? { group } : { query }),
        count: names.length,
        tools: names.map(name => ({ name, summary: summarize(tools.get(name)!.description) })),
        next_step: 'Call tool_schema for a tool\'s arguments, or tool_execute directly if the arguments are obvious.',
      });
    },
  );

  server.tool(
    'tool_schema',
    'Get the full description and JSON Schema for one or more tools found via tool_search. Optional: if you already know a tool\'s arguments, call tool_execute directly.',
    {
      tools: z
        .array(z.string())
        .min(1)
        .describe('Tool names, exactly as returned by tool_search.'),
    },
    async ({ tools: requested }) => {
      const found: unknown[] = [];
      const unknown: string[] = [];
      for (const name of requested) {
        const tool = tools.get(name);
        if (!tool) {
          unknown.push(name);
          continue;
        }
        found.push({
          name: tool.name,
          description: tool.description,
          input_schema: zodToJsonSchema(z.object(tool.shape), { $refStrategy: 'none' }),
        });
      }
      return textResult({
        tools: found,
        ...(unknown.length
          ? {
              unknown_tools: unknown,
              message: 'These names are not registered. Call tool_search to get exact names.',
            }
          : {}),
      });
    },
  );

  server.tool(
    'tool_execute',
    'Run a tool by name. Get names from tool_search and arguments from tool_schema. Arguments are validated before the call, so a mistake comes back as a message naming the bad field rather than a failed request.',
    {
      tool: z.string().describe('Tool name, exactly as returned by tool_search.'),
      args: z
        .record(z.any())
        .optional()
        .describe('Arguments for the tool, matching the schema from tool_schema. Omit for a tool that takes none.'),
    },
    async ({ tool: name, args }) => {
      const tool = tools.get(name);
      if (!tool) {
        // Never a dead end: point at the search that resolves it. Suggest close
        // names first, since a near miss is the common case.
        const close = searchTools(tools, name.replace(/_/g, ' ')).slice(0, 5);
        return textResult({
          error: 'unknown_tool',
          message: `No tool named "${name}". Call tool_search to get exact names.`,
          ...(close.length ? { did_you_mean: close } : {}),
        });
      }
      // Validating here is what makes the missing native schema harmless: the
      // model gets the same class of error it would have got from the SDK.
      const parsed = z.object(tool.shape).safeParse(args ?? {});
      if (!parsed.success) {
        return textResult({
          error: 'invalid_arguments',
          tool: name,
          issues: parsed.error.issues.map(i => ({
            field: i.path.join('.') || '(root)',
            problem: i.message,
          })),
          message: `Call tool_schema({"tools": ["${name}"]}) for the exact argument shape.`,
        });
      }
      return tool.handler(parsed.data as Record<string, unknown>);
    },
  );
}
