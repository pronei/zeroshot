import { Braces } from 'lucide-react';
import {
  allNodes,
  bindingFor,
  clone,
  effectiveLane,
  executable,
  setRuntimeField,
  type Document,
  type RuntimeField,
} from './domain';
import { Field } from './Field';
import { ModelPicker } from './ModelPicker';
import { harnessLabel, harnessOptions, providerOptions } from './runtime-schema';

export function RuntimeEditor(p: {
  document: Document;
  schema: any;
  edit: (next: Document, key?: string) => void;
  openJson: () => void;
}) {
  const doc = p.document;
  const harnesses = harnessOptions(p.schema);
  const providers = providerOptions(p.schema, doc.runtime.harness);
  function runtimeChange(key: RuntimeField, value: string) {
    p.edit(setRuntimeField(doc, key, value), `runtime.${key}`);
  }
  return (
    <>
      <p className="runtime-scope">
        Default for every node. A node can override its harness and provider in the inspector.
      </p>
      <Field label="Harness">
        <select
          value={doc.runtime.harness}
          onChange={(e) => runtimeChange('harness', e.target.value)}
        >
          <option value="">Choose harness</option>
          {harnesses.map((h) => (
            <option key={h} value={h}>
              {harnessLabel(h)}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Provider">
        <select
          value={doc.runtime.provider}
          onChange={(e) => runtimeChange('provider', e.target.value)}
        >
          <option value="">Choose provider</option>
          {providers.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Run size">
        <select value={doc.runtime.size} onChange={(e) => runtimeChange('size', e.target.value)}>
          {(p.schema?.$defs?.RunSize?.enum ?? []).map((s: string) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </Field>
      <div className="section-rule" />
      <div className="section-title">
        Agent models{' '}
        <span className="muted">
          {
            allNodes(doc.graph.root).filter(
              (n) => bindingFor(doc.runtime, n.name)?.kind === 'agent'
            ).length
          }
        </span>
      </div>
      {allNodes(doc.graph.root)
        .filter(executable)
        .map((n) => {
          const binding = bindingFor(doc.runtime, n.name);
          const lane = effectiveLane(doc.runtime, n.name);
          const override =
            binding?.lane &&
            `Override: ${harnessLabel(binding.lane.harness)} / ${binding.lane.provider || 'no provider'}`;
          return (
            <div key={n.name} className="runtime-node">
              <span className="mono">{n.name}</span>
              {binding?.kind === 'git_delivery' ? (
                <small>Git delivery</small>
              ) : binding?.kind === 'agent' && lane ? (
                <>
                  {override && <small>{override}</small>}
                  <ModelPicker
                    compact
                    label={`Model for ${n.name}`}
                    harness={lane.harness}
                    provider={lane.provider}
                    value={binding.model ?? ''}
                    onChange={(value) => {
                      const next = clone(doc);
                      next.runtime.nodes = {
                        ...next.runtime.nodes,
                        [n.name]: {
                          ...bindingFor(next.runtime, n.name),
                          kind: 'agent',
                          model: value,
                        },
                      };
                      p.edit(next, `model.${n.name}`);
                    }}
                  />
                </>
              ) : (
                <small>Choose a worker in the node inspector.</small>
              )}
            </div>
          );
        })}
      <button className="text-button json-link" onClick={p.openJson}>
        <Braces size={15} /> Runtime JSON
      </button>
    </>
  );
}
