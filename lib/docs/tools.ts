import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { fetchDocEntries, searchDocs } from './search.js';

export function registerDocTools(server: McpServer): void {
  server.tool(
    'docs_search',
    'Search Respan documentation. Returns a list of relevant documentation pages based on your query. Use this to find guides, integration docs, API references, and more.',
    {
      query: z.string().describe('Search query — describe what you want to learn about (e.g. "openai tracing", "evaluators", "langchain integration")'),
      max_results: z.number().optional().default(10).describe('Maximum number of results to return (default: 10)'),
    },
    async ({ query, max_results }) => {
      const entries = await fetchDocEntries();
      const results = searchDocs(entries, query);
      const limited = results.slice(0, max_results || 10);

      if (limited.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `No documentation pages found for "${query}". Try broader terms.`,
            },
          ],
        };
      }

      const formatted = limited
        .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url.replace(/\.mdx$/, '')}${r.description ? `\n   ${r.description}` : ''}`)
        .join('\n\n');

      return {
        content: [
          {
            type: 'text' as const,
            text: `Found ${limited.length} result${limited.length > 1 ? 's' : ''} for "${query}":\n\n${formatted}`,
          },
        ],
      };
    },
  );
}
