import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ModelPicker } from './ModelPicker';
import { RuntimeEditor } from './RuntimeEditor';
import { assertDocument, type Document } from './domain';
import { runtimeSchemaFixture } from './test-support';

function elements(value: ReactNode): ReactElement<any>[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!isValidElement<{ children?: ReactNode }>(value)) return [];
  return [value, ...elements(value.props.children)];
}

function document(harness: string, provider: string): Document {
  return {
    name: 'runtime-review',
    graph: {
      profile: 'full',
      initialInput: { kind: 'null' },
      policy: {},
      root: {
        kind: 'seq',
        name: 'run',
        children: [
          { kind: 'step', name: 'worker', worker: 'agent.worker@1' },
          { kind: 'verifier', name: 'delivery', worker: 'builtin.git-delivery.pr@1' },
        ],
      },
    },
    runtime: {
      harness,
      provider,
      size: 'small',
      nodes: {
        worker: {
          kind: 'agent',
          model: 'custom-original',
          effort: 'high',
          connections: { tools: ['TOKEN'] },
        },
        delivery: { kind: 'git_delivery', connections: { github: ['GH_TOKEN'] } },
      },
    },
  };
}

test('each new preset selection reaches the runtime binding through the rendered picker callback', () => {
  for (const [harness, provider, model] of [
    ['codex', 'openai', 'gpt-6-astra'],
    ['codex', 'openrouter', 'openai/gpt-6-astra'],
    ['codex', 'bedrock', 'openai.gpt-6-astra'],
    ['claude', 'anthropic', 'claude-fable-5-1'],
    ['claude', 'openrouter', 'anthropic/claude-fable-5.1'],
    ['claude', 'bedrock', 'global.anthropic.claude-fable-5-1'],
  ]) {
    const doc = document(harness, provider);
    const before = structuredClone(doc);
    const edits: Document[] = [];
    const view = RuntimeEditor({
      document: doc,
      schema: {},
      edit: (next) => edits.push(next),
      openJson: () => {},
    });
    const pickers = elements(view).filter((element) => element.type === ModelPicker);
    assert.equal(pickers.length, 1, 'delivery must not have a model picker');

    // Render establishes React's hook context; exercise the actual select callback and its
    // RuntimeEditor parent callback without a browser, network, or model invocation.
    function SelectPreset() {
      const picker = ModelPicker(pickers[0].props);
      const controls = elements(picker);
      assert.ok(
        controls.some((element) => element.type === 'option' && element.props.value === model)
      );
      const select = controls.find((element) => element.type === 'select')!;
      select.props.onChange({ target: { value: model } });
      return picker;
    }
    renderToStaticMarkup(createElement(SelectPreset));
    assert.equal(edits.length, 1);
    assert.equal(edits[0].runtime.nodes.worker.model, model);
    assert.deepEqual(
      edits[0].runtime.nodes.worker.connections,
      before.runtime.nodes.worker.connections
    );
    assert.equal(edits[0].runtime.nodes.worker.effort, 'high');
    assert.deepEqual(edits[0].runtime.nodes.delivery, before.runtime.nodes.delivery);
    assert.deepEqual(doc, before);
  }
});

test('runtime model editing does not offer implicit conversion of unknown or missing bindings', () => {
  for (const missing of [false, true]) {
    const doc = document('codex', 'openai');
    if (missing) delete doc.runtime.nodes.worker;
    else
      doc.runtime.nodes.worker = {
        kind: 'future_worker',
        model: 'opaque',
        settings: { version: 2 },
      };
    assertDocument(doc);
    const before = structuredClone(doc);
    const view = RuntimeEditor({ document: doc, schema: {}, edit: () => {}, openJson: () => {} });
    assert.equal(elements(view).filter((element) => element.type === ModelPicker).length, 0);
    assert.deepEqual(doc, before);
  }
});

function crossVendor(): Document {
  const doc = document('codex', 'openai');
  doc.graph.root.children.splice(1, 0, {
    kind: 'verifier',
    name: 'reviewer',
    worker: 'agent.reviewer@1',
  });
  doc.runtime.nodes.reviewer = {
    kind: 'agent',
    lane: { harness: 'claude', provider: 'anthropic' },
    model: 'review-model',
  };
  return doc;
}

test('per-node rows mark overrides and give each model picker the node lane', () => {
  const doc = crossVendor(),
    before = structuredClone(doc);
  const editor = {
    document: doc,
    schema: runtimeSchemaFixture(),
    edit: () => {},
    openJson: () => {},
  };
  const pickers = elements(RuntimeEditor(editor)).filter((element) => element.type === ModelPicker);
  assert.deepEqual(
    pickers.map(({ props }) => [props.label, props.harness, props.provider]),
    [
      ['Model for worker', 'codex', 'openai'],
      ['Model for reviewer', 'claude', 'anthropic'],
    ]
  );
  const html = renderToStaticMarkup(createElement(RuntimeEditor, editor));
  assert.match(
    html,
    /Default for every node\. A node can override its harness and provider in the inspector\./
  );
  assert.equal(html.match(/Override: /g)?.length, 1);
  assert.match(
    html,
    /<span class="mono">reviewer<\/span><small>Override: Claude Code \/ anthropic<\/small>/
  );
  assert.match(html, /<option value="gpt-6-astra">/);
  assert.match(html, /<option value="claude-fable-5-1">/);

  doc.runtime.nodes.reviewer.lane = { harness: 'claude', provider: '' };
  assert.match(
    renderToStaticMarkup(createElement(RuntimeEditor, editor)),
    /<small>Override: Claude Code \/ no provider<\/small>/
  );
  doc.runtime.nodes.reviewer.lane = before.runtime.nodes.reviewer.lane;
  assert.deepEqual(doc, before);
});

test('run-level harness edits clear node lanes while provider and size edits keep them', () => {
  const doc = crossVendor();
  // The worker keeps the run-level Codex harness and overrides only its provider.
  doc.runtime.nodes.worker.lane = { harness: 'codex', provider: 'openrouter' };
  const before = structuredClone(doc);
  const workerWithoutLane = structuredClone(before.runtime.nodes.worker);
  delete workerWithoutLane.lane;
  const edits: { next: Document; key?: string }[] = [];
  const view = RuntimeEditor({
    document: doc,
    schema: runtimeSchemaFixture(),
    edit: (next, key) => edits.push({ next, key }),
    openJson: () => {},
  });
  const [harness, provider, size] = elements(view).filter((element) => element.type === 'select');
  provider.props.onChange({ target: { value: 'openrouter' } });
  size.props.onChange({ target: { value: 'large' } });
  // A switch to the reviewer's own harness and a switch to an unrelated one both clear its lane,
  // and both clear the worker's provider-only override on the old harness.
  harness.props.onChange({ target: { value: 'claude' } });
  harness.props.onChange({ target: { value: 'copilot' } });
  assert.deepEqual(
    edits.map(({ key }) => key),
    ['runtime.provider', 'runtime.size', 'runtime.harness', 'runtime.harness']
  );
  const [providerEdit, sizeEdit, ...harnessEdits] = edits.map(({ next }) => next);
  assert.equal(providerEdit.runtime.provider, 'openrouter');
  assert.deepEqual(providerEdit.runtime.nodes, before.runtime.nodes);
  assert.equal(sizeEdit.runtime.size, 'large');
  assert.deepEqual(sizeEdit.runtime.nodes, before.runtime.nodes);
  assert.deepEqual(
    harnessEdits.map(({ runtime }) => runtime.harness),
    ['claude', 'copilot']
  );
  for (const harnessEdit of harnessEdits) {
    assert.equal(harnessEdit.runtime.provider, '');
    assert.equal(Object.hasOwn(harnessEdit.runtime.nodes.reviewer, 'lane'), false);
    assert.equal(harnessEdit.runtime.nodes.reviewer.model, 'review-model');
    assert.equal(Object.hasOwn(harnessEdit.runtime.nodes.worker, 'lane'), false);
    assert.deepEqual(harnessEdit.runtime.nodes.worker, workerWithoutLane);
  }
  for (const { next } of edits) assertDocument(next);
  assert.deepEqual(doc, before);
});
