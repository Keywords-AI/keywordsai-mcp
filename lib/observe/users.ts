// lib/observe/users.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuthenticatedClient } from "../shared/client.js";
import { requireClient } from "../shared/client.js";
import { clampPagination, paginationShape } from "../shared/pagination.js";

export function registerUserTools(server: McpServer, client: AuthenticatedClient | null) {
  // --- List Customers ---
  server.tool(
    "customer_list",
    `List customers/users with pagination and sorting.

Retrieves a paginated list of customers who have made API requests through Respan.

QUERY PARAMETERS:
- sort_by: Sort field. Prefix with - for descending order.
  Examples: -total_cost (highest spending first), -number_of_requests (most active first)
- environment: Filter by environment ("prod" or "test")

RESPONSE FIELDS:
- id: Unique internal identifier
- customer_identifier: Your unique identifier for this customer
- email: Customer email (if provided)
- name: Customer name (if provided)
- environment: Environment (prod/test)
- first_seen: First activity timestamp
- last_active_timeframe: Last activity timestamp
- active_days: Number of days with activity
- number_of_requests: Total API requests made
- total_tokens: Total tokens used
- total_cost: Total cost in USD
- average_latency: Average response time in seconds
- average_ttft: Average time to first token in seconds

Use this to identify top users by cost, most active users, or find specific customers.`,
    {
      ...paginationShape("customer_list"),
      sort_by: z.enum([
        "customer_identifier", "-customer_identifier",
        "email", "-email",
        "first_seen", "-first_seen",
        "last_active_timeframe", "-last_active_timeframe",
        "number_of_requests", "-number_of_requests",
        "total_cost", "-total_cost",
        "total_tokens", "-total_tokens",
        "active_days", "-active_days",
        "average_latency", "-average_latency",
        "average_ttft", "-average_ttft"
      ]).optional().describe("Sort field. Prefix with - for descending order. Default: -first_seen"),
      environment: z.enum(["prod", "test"]).optional().describe("Filter by environment: 'prod' or 'test'")
    },
    async ({ page_size, page, sort_by = "-first_seen", environment }) => {
      const c = requireClient(client);
      const pageResult = await c.client.users.listCustomers({
        Authorization: c.auth,
        ...clampPagination("customer_list", { page, page_size }),
        sort_by,
        ...(environment ? { environment } : {}),
      });

      // The Fern SDK returns a Page object with response/rawResponse/data.
      // Extract just the paginated response to avoid triplicated output and leaked HTTP internals.
      const response = (pageResult as any).response ?? (pageResult as any).data ?? pageResult;
      // Strip filters_data metadata to reduce response size
      if (response && typeof response === 'object') delete response.filters_data;
      return { content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }] };
    }
  );

  // --- Get Customer Detail ---
  server.tool(
    "customer_get",
    `Retrieve detailed information about a specific customer including budget usage.

Returns customer profile and budget data:

IDENTIFICATION:
- id: Internal customer ID
- customer_identifier: Your unique identifier for this customer
- email: Customer email (if provided)
- name: Customer name (if provided)
- environment: Environment (prod/test)
- organization_name: Owning organization name

BUDGET & SPENDING:
- period_budget: Budget limit for current period (USD, null if unlimited)
- budget_duration: Budget period type (e.g., "monthly")
- total_period_usage: Spending in current period (USD)
- period_start: Current budget period start
- period_end: Current budget period end (null if ongoing)
- total_budget: Lifetime budget limit (null if unlimited)

OTHER:
- has_write_access: Whether customer has write access
- updated_at: Last update timestamp

NOTE: For usage metrics (requests, tokens, cost, latency), use log_summary with a customer_identifier filter instead.

Use customer_list first to find customer_identifier, then use this for full details.`,
    {
      customer_identifier: z.string().describe("Unique identifier of the customer (from customer_list)"),
      environment: z.enum(["prod", "test"]).optional().describe("Environment: 'prod' or 'test' (default: 'prod')")
    },
    async ({ customer_identifier, environment }) => {
      const c = requireClient(client);
      const data = await c.client.users.retrieveUser({
        Authorization: c.auth,
        customer_identifier,
        ...(environment ? { environment } : {}),
      });

      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );
}
