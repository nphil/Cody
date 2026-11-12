// Bun script: validate models.yml-shaped objects with ONE installed omp's own
// schema, so a test can tell what that engine accepts instead of trusting a list.
//
//   bun models-yml-schema-probe.mjs <omp package root> '<JSON {name: config}>'
//
// Prints {name: "accept" | "reject: <omp's summary>"} as JSON on stdout.
const [root, rawCases] = process.argv.slice(2);
const { getModelsConfigSchema } = await import(`${root}/src/config/models-config-schema-bundle.ts`);
const schema = getModelsConfigSchema();
const out = {};
for (const [name, config] of Object.entries(JSON.parse(rawCases))) {
  const result = schema(config);
  out[name] = result instanceof Object && "summary" in result ? `reject: ${String(result.summary)}` : "accept";
}
process.stdout.write(JSON.stringify(out));
