import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import type { RunDetail } from './run-history';

export async function createViteTestServer(t: TestContext) {
  const server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true },
  });
  t.after(() => server.close());
  return server;
}

// Shaped like the served schema_for!(RuntimePlan): root oneOf variants, each with a harness
// const and a provider $ref into $defs.
export const runtimeSchemaFixture = () => {
  const variant = (harness: string, provider: string) => ({
    type: 'object',
    additionalProperties: false,
    required: ['harness', 'provider', 'size', 'nodes'],
    properties: {
      harness: { type: 'string', const: harness },
      provider: { $ref: `#/$defs/${provider}` },
      size: { $ref: '#/$defs/RunSize' },
      nodes: { type: 'object' },
    },
  });
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'RuntimePlan',
    oneOf: [
      variant('copilot', 'CopilotProvider'),
      variant('codex', 'CodexProvider'),
      variant('claude', 'ClaudeProvider'),
    ],
    $defs: {
      CopilotProvider: { type: 'string', enum: ['github'] },
      CodexProvider: { type: 'string', enum: ['openai', 'openrouter', 'gateway', 'bedrock'] },
      ClaudeProvider: { type: 'string', enum: ['anthropic', 'openrouter', 'gateway', 'bedrock'] },
      RunSize: { type: 'string', enum: ['small', 'medium', 'large'] },
    },
  };
};

export const runDetailFixture = (runId = 'run/selected'): RunDetail => ({
  version: 1,
  projectionVersion: 1,
  runId,
  title: 'Review a change',
  phase: 'running',
  cursor: 'v2:0',
  historyAvailable: true,
  graph: {
    profile: 'openengine.graph.full/v1',
    initialInput: { kind: 'null' },
    policy: {},
    root: { kind: 'seq', name: 'run', children: [] },
  },
  runtime: { harness: 'codex', provider: 'openai', size: 'small', nodes: {} },
  initialInput: null,
  history: { initialCursor: 'v2:0', cursor: 'v2:0', complete: false, limitations: [] },
});
