import { createMcpHandler } from '../lib/shared/mcp-handler.js';

export default createMcpHandler(
  'https://api.respan.ai',
  '/.well-known/oauth-protected-resource',
  'platform',
);
