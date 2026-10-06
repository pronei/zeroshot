import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessLabel, harnessOptions, providerOptions } from './runtime-schema';
import { runtimeSchemaFixture } from './test-support';

test('harness and provider choices come from the served RuntimePlan schema variants', () => {
  const schema = runtimeSchemaFixture();
  assert.deepEqual(harnessOptions(schema), ['copilot', 'codex', 'claude']);
  assert.deepEqual(providerOptions(schema, 'copilot'), ['github']);
  assert.deepEqual(providerOptions(schema, 'codex'), [
    'openai',
    'openrouter',
    'gateway',
    'bedrock',
  ]);
  assert.deepEqual(providerOptions(schema, 'claude'), [
    'anthropic',
    'openrouter',
    'gateway',
    'bedrock',
  ]);
});

test('an unchosen or unknown harness offers no providers, and a missing schema offers nothing', () => {
  const schema = runtimeSchemaFixture();
  assert.deepEqual(providerOptions(schema, ''), []);
  assert.deepEqual(providerOptions(schema, 'future-cli'), []);
  for (const missing of [undefined, null, {}, { oneOf: [] }]) {
    assert.deepEqual(harnessOptions(missing), []);
    assert.deepEqual(providerOptions(missing, 'codex'), []);
  }
});

test('inline harness enums and provider enums are read like constants and references', () => {
  const schema = {
    anyOf: [
      { properties: { harness: { enum: ['future-cli'] }, provider: { enum: ['future-service'] } } },
      { properties: { provider: { enum: ['orphan'] } } },
    ],
  };
  assert.deepEqual(harnessOptions(schema), ['future-cli']);
  assert.deepEqual(providerOptions(schema, 'future-cli'), ['future-service']);
});

test('known harnesses have product labels and other harness names stay as written', () => {
  assert.equal(harnessLabel('codex'), 'Codex');
  assert.equal(harnessLabel('claude'), 'Claude Code');
  assert.equal(harnessLabel('copilot'), 'GitHub Copilot');
  assert.equal(harnessLabel('future-cli'), 'future-cli');
});
