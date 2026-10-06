// Harness and provider choices come from the served native schema, schema_for!(RuntimePlan).
// Each oneOf variant names one harness and its provider enum, so a new harness or provider
// reaches the editor without a UI change. Labels only decorate known harness names.
const harnessLabels = new Map([
  ['codex', 'Codex'],
  ['claude', 'Claude Code'],
  ['copilot', 'GitHub Copilot'],
]);

const variants = (schema: any): any[] => schema?.oneOf ?? schema?.anyOf ?? [];
const variantHarness = (variant: any): unknown =>
  variant?.properties?.harness?.const ?? variant?.properties?.harness?.enum?.[0];

export function harnessOptions(schema: any): string[] {
  return variants(schema)
    .map(variantHarness)
    .filter((harness): harness is string => typeof harness === 'string' && harness !== '');
}

export function providerOptions(schema: any, harness: string): string[] {
  const variant = variants(schema).find((v) => variantHarness(v) === harness);
  const reference = variant?.properties?.provider?.$ref?.split('/').pop();
  return (
    (reference ? schema?.$defs?.[reference]?.enum : undefined) ??
    variant?.properties?.provider?.enum ??
    []
  );
}

export const harnessLabel = (harness: string) => harnessLabels.get(harness) ?? harness;
