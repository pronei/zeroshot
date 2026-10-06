import { Field } from './Field';
import { bindingFor, setNodeLane, type Document, type Lane } from './domain';
import { harnessLabel, harnessOptions, providerOptions } from './runtime-schema';

// A saved value outside the schema's choices stays listed, so the select never shows an
// override as the run default or drops its provider from view.
const withSaved = (options: string[], saved?: string) =>
  saved && !options.includes(saved) ? [...options, saved] : options;

/** Harness and provider override for one agent node. "Run default" removes the override. */
export function LaneFields(p: {
  document: Document;
  name: string;
  schema: any;
  edit: (next: Document, key?: string) => void;
}) {
  const lane = bindingFor(p.document.runtime, p.name)?.lane;
  const change = (next: Lane | undefined, field: 'harness' | 'provider') =>
    p.edit(setNodeLane(p.document, p.name, next), `binding.${p.name}.lane.${field}`);
  return (
    <div className="field-row">
      <Field label="Harness">
        <select
          value={lane?.harness ?? ''}
          onChange={(e) =>
            change(
              e.target.value ? { harness: e.target.value, provider: '' } : undefined,
              'harness'
            )
          }
        >
          <option value="">Run default</option>
          {withSaved(harnessOptions(p.schema), lane?.harness).map((harness) => (
            <option key={harness} value={harness}>
              {harnessLabel(harness)}
            </option>
          ))}
        </select>
      </Field>
      {lane && (
        <Field label="Provider">
          <select
            value={lane.provider}
            onChange={(e) => change({ ...lane, provider: e.target.value }, 'provider')}
          >
            <option value="">Choose provider</option>
            {withSaved(providerOptions(p.schema, lane.harness), lane.provider).map((provider) => (
              <option key={provider} value={provider}>
                {provider}
              </option>
            ))}
          </select>
        </Field>
      )}
    </div>
  );
}
