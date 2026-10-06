import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { assertDocument, type Document } from './domain';
import { LaneFields } from './LaneFields';
import { runtimeSchemaFixture } from './test-support';

function elements(value: ReactNode): ReactElement<any>[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!isValidElement<{ children?: ReactNode }>(value)) return [];
  return [value, ...elements(value.props.children)];
}

function fixture(): Document {
  return {
    name: 'lane-fields',
    graph: {
      profile: 'openengine.graph.full/v1',
      initialInput: { kind: 'null' },
      policy: {},
      root: {
        kind: 'seq',
        name: 'run',
        children: [
          { kind: 'step', name: 'worker', worker: 'agent.worker@1' },
          { kind: 'verifier', name: 'reviewer', worker: 'agent.reviewer@1' },
        ],
      },
    },
    runtime: {
      harness: 'codex',
      provider: 'openai',
      size: 'small',
      nodes: {
        worker: { kind: 'agent', model: 'worker-model', connections: { tools: ['TOKEN'] } },
        reviewer: {
          kind: 'agent',
          lane: { harness: 'claude', provider: 'anthropic' },
          model: 'review-model',
          sessionScope: 'node_instance',
        },
      },
    },
  };
}

const render = (document: Document, name: string) =>
  renderToStaticMarkup(
    createElement(LaneFields, { document, name, schema: runtimeSchemaFixture(), edit: () => {} })
  );
const selects = (html: string) =>
  [...html.matchAll(/<select[^>]*>(.*?)<\/select>/g)].map((match) => match[1]);
const choices = (select: string) =>
  [...select.matchAll(/<option value="([^"]*)"/g)].map((match) => match[1]);
const chosen = (select: string) => select.match(/<option value="([^"]*)" selected=""/)?.[1];

function controls(document: Document, name: string) {
  const edits: { document: Document; key?: string }[] = [];
  const view = LaneFields({
    document,
    name,
    schema: runtimeSchemaFixture(),
    edit: (next, key) => edits.push({ document: next, key }),
  });
  const [harness, provider] = elements(view).filter((element) => element.type === 'select');
  return { harness, provider, edits };
}

test('a node on the run default shows Run default first and no provider control', () => {
  const html = render(fixture(), 'worker');
  const [harness, ...others] = selects(html);
  assert.equal(others.length, 0);
  assert.deepEqual(choices(harness), ['', 'copilot', 'codex', 'claude']);
  assert.match(harness, /<option value="" selected="">Run default<\/option>/);
  assert.match(harness, /<option value="claude">Claude Code<\/option>/);
  assert.match(html, />Harness<\/label>/);
  assert.doesNotMatch(html, />Provider<\/label>/);
});

test("an override selects its harness and offers only that harness's providers", () => {
  const html = render(fixture(), 'reviewer');
  const [harness, provider] = selects(html);
  assert.equal(chosen(harness), 'claude');
  assert.deepEqual(choices(provider), ['', 'anthropic', 'openrouter', 'gateway', 'bedrock']);
  assert.equal(chosen(provider), 'anthropic');
  const labelled = [...html.matchAll(/<label for="([^"]+)">(?:Harness|Provider)<\/label>/g)].map(
    (match) => match[1]
  );
  const ids = [...html.matchAll(/<select[^>]*\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(labelled.length, 2);
  assert.deepEqual(labelled, ids);
});

test('a saved harness or provider outside the schema stays visible instead of reading as the default', () => {
  const document = fixture();
  document.runtime.nodes.reviewer.lane = { harness: 'future-cli', provider: 'future-service' };
  const [harness, provider] = selects(render(document, 'reviewer'));
  assert.equal(chosen(harness), 'future-cli');
  assert.deepEqual(choices(provider), ['', 'future-service']);
  assert.equal(chosen(provider), 'future-service');
});

test('choosing a harness starts an override with an empty provider that the provider select completes', () => {
  const document = fixture(),
    before = structuredClone(document);
  const started = controls(document, 'worker');
  assert.equal(started.provider, undefined);
  started.harness.props.onChange({ target: { value: 'claude' } });
  assert.equal(started.edits.length, 1);
  const [{ document: override, key }] = started.edits;
  assert.equal(key, 'binding.worker.lane.harness');
  assert.deepEqual(override.runtime.nodes.worker, {
    ...before.runtime.nodes.worker,
    lane: { harness: 'claude', provider: '' },
  });
  assertDocument(override);

  const completed = controls(override, 'worker');
  completed.provider.props.onChange({ target: { value: 'anthropic' } });
  const [{ document: complete, key: providerKey }] = completed.edits;
  assert.equal(providerKey, 'binding.worker.lane.provider');
  assert.deepEqual(complete.runtime.nodes.worker.lane, {
    harness: 'claude',
    provider: 'anthropic',
  });
  assert.deepEqual(complete.runtime.nodes.reviewer, before.runtime.nodes.reviewer);
  assert.deepEqual(document, before);
});

test('another harness restarts the override, and Run default removes it', () => {
  const document = fixture(),
    before = structuredClone(document);
  const { harness, edits } = controls(document, 'reviewer');
  harness.props.onChange({ target: { value: 'codex' } });
  harness.props.onChange({ target: { value: '' } });
  const [switched, reset] = edits.map((edit) => edit.document.runtime.nodes.reviewer);
  assert.deepEqual(switched.lane, { harness: 'codex', provider: '' });
  const expected = structuredClone(before.runtime.nodes.reviewer);
  delete expected.lane;
  assert.deepEqual(reset, expected);
  assert.equal(Object.hasOwn(reset, 'lane'), false);
  assert.deepEqual(document, before);
});
