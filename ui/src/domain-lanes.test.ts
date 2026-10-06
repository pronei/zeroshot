import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertDocument,
  effectiveLane,
  effectiveLanes,
  hasNodeLanes,
  setNodeLane,
  setRuntimeField,
  type Document,
} from './domain';

// A Codex run whose reviewer runs on Claude Code, with a delivery node that has no lane.
function fixture(): Document {
  return {
    name: 'cross-vendor',
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
          { kind: 'verifier', name: 'deliver', worker: 'builtin.git-delivery.pr@1' },
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
          effort: 'high',
          future: { kept: ['as', 'written'] },
        },
        deliver: { kind: 'git_delivery', connections: { github: ['GH_TOKEN'] } },
      },
    },
  };
}

function withoutLanes(): Document {
  const document = fixture();
  delete document.runtime.nodes.reviewer.lane;
  return document;
}

const hasLane = (document: Document, name: string) =>
  Object.hasOwn(document.runtime.nodes[name], 'lane');

test('an agent node runs on its own lane, else the run-level pair; delivery nodes have none', () => {
  const { runtime } = fixture();
  assert.deepEqual(effectiveLane(runtime, 'reviewer'), {
    harness: 'claude',
    provider: 'anthropic',
  });
  assert.deepEqual(effectiveLane(runtime, 'worker'), { harness: 'codex', provider: 'openai' });
  assert.equal(effectiveLane(runtime, 'deliver'), undefined);
  assert.equal(effectiveLane(runtime, 'run'), undefined);
  assert.equal(effectiveLane(runtime, 'missing'), undefined);
});

test('a new run-level harness clears the provider and every lane; other fields stay', () => {
  const document = fixture(),
    before = structuredClone(document);
  const next = setRuntimeField(document, 'harness', 'claude');
  assert.equal(next.runtime.harness, 'claude');
  assert.equal(next.runtime.provider, '');
  for (const name of ['worker', 'reviewer', 'deliver']) assert.equal(hasLane(next, name), false);
  const reviewer = structuredClone(before.runtime.nodes.reviewer);
  delete reviewer.lane;
  assert.deepEqual(next.runtime.nodes, { ...before.runtime.nodes, reviewer });
  assert.deepEqual(document, before);
  assertDocument(next);
  // Choosing the current harness again is not a change.
  assert.deepEqual(setRuntimeField(document, 'harness', 'codex'), document);
});

test('run-level provider and size changes keep every lane', () => {
  for (const [key, value] of [
    ['provider', 'openrouter'],
    ['size', 'large'],
  ] as const) {
    const document = fixture(),
      before = structuredClone(document);
    const next = setRuntimeField(document, key, value);
    assert.equal(next.runtime[key], value);
    assert.deepEqual(next.runtime.nodes, before.runtime.nodes);
    assert.deepEqual(document, before);
  }
});

test('a document without lanes changes only the edited run-level field', () => {
  for (const [key, value] of [
    ['provider', 'openrouter'],
    ['size', 'large'],
  ] as const) {
    const document = withoutLanes();
    const expected = { ...document, runtime: { ...document.runtime, [key]: value } };
    const next = setRuntimeField(document, key, value);
    assert.deepEqual(next, expected);
    assert.equal(JSON.stringify(next), JSON.stringify(expected));
  }
  const document = withoutLanes();
  const next = setRuntimeField(document, 'harness', 'claude');
  assert.equal(
    JSON.stringify(next),
    JSON.stringify({
      ...document,
      runtime: { ...document.runtime, harness: 'claude', provider: '' },
    })
  );
});

test('setting and removing a node lane keeps other binding fields and never mutates its input', () => {
  const document = withoutLanes(),
    before = structuredClone(document);
  const lane = { harness: 'claude', provider: '' };
  const set = setNodeLane(document, 'worker', lane);
  lane.provider = 'changed after the edit';
  assert.deepEqual(set.runtime.nodes.worker, {
    ...before.runtime.nodes.worker,
    lane: { harness: 'claude', provider: '' },
  });
  assert.deepEqual(document, before);
  assertDocument(set);

  const setBefore = structuredClone(set);
  const removed = setNodeLane(set, 'worker', undefined);
  assert.equal(hasLane(removed, 'worker'), false);
  assert.equal(JSON.stringify(removed), JSON.stringify(before));
  assert.deepEqual(set, setBefore);

  const reviewer = setNodeLane(fixture(), 'reviewer', undefined).runtime.nodes.reviewer;
  assert.deepEqual(reviewer, {
    kind: 'agent',
    model: 'review-model',
    effort: 'high',
    future: { kept: ['as', 'written'] },
  });
});

test('only agent nodes can carry a lane', () => {
  const document = fixture(),
    before = structuredClone(document);
  for (const name of ['deliver', 'run', 'missing'])
    assert.throws(
      () => setNodeLane(document, name, { harness: 'claude', provider: 'anthropic' }),
      /Only an agent node/
    );
  assert.deepEqual(document, before);
});

test('profile validation accepts a lane only as an object with a harness and text provider', () => {
  const imported = (lane: unknown) => {
    const document = JSON.parse(JSON.stringify(fixture()));
    document.runtime.nodes.reviewer.lane = lane;
    return document;
  };
  assertDocument(fixture());
  assertDocument(imported({ harness: 'claude', provider: '' }));
  for (const lane of [null, 'claude/anthropic', 7, true, ['claude', 'anthropic']])
    assert.throws(
      () => assertDocument(imported(lane)),
      /^Error: lane for reviewer must be an object with a harness and provider\.$/
    );
  for (const lane of [{ provider: 'anthropic' }, { harness: 7, provider: 'anthropic' }])
    assert.throws(
      () => assertDocument(imported(lane)),
      /^Error: lane harness for reviewer must be nonempty text\.$/
    );
  assert.throws(
    () => assertDocument(imported({ harness: '', provider: 'anthropic' })),
    /lane harness for reviewer must be nonempty text/
  );
  for (const lane of [{ harness: 'claude' }, { harness: 'claude', provider: null }])
    assert.throws(
      () => assertDocument(imported(lane)),
      /^Error: lane provider for reviewer must be text\.$/
    );
});

test('history lists every agent node lane in graph order only when a node carries one', () => {
  assert.equal(hasNodeLanes(fixture().runtime), true);
  assert.equal(hasNodeLanes(withoutLanes().runtime), false);
  assert.deepEqual(effectiveLanes(fixture()), [
    { name: 'worker', lane: { harness: 'codex', provider: 'openai' } },
    { name: 'reviewer', lane: { harness: 'claude', provider: 'anthropic' } },
  ]);
});
