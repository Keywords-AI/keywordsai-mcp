import { createMcpHandler } from '../../lib/shared/mcp-handler.js';

export default createMcpHandler(
  'https://endpoint.respan.ai',
  '/.well-known/oauth-protected-resource/enterprise',
  'enterprise',
);
