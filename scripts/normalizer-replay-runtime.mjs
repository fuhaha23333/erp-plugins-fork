import { readFile, mkdir } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import ts from 'typescript'

// Export the EXISTING private factory/timeout helper in the test bundle only.
// Extract the actual user prompt AST rather than maintaining a second prompt copy.
export async function loadReplayRuntime(root) {
  const path = resolve(root, 'src/main/agent/pi-document-client.ts')
  const source = await readFile(path, 'utf8')
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const prompts = []
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'trackedPrompt' &&
        node.arguments[1]?.getText(ast) === 'normalizerAgent') prompts.push(node.arguments[2].getText(ast))
    ts.forEachChild(node, visit)
  }
  visit(ast)
  if (prompts.length !== 1 || !prompts[0].startsWith('`')) throw new Error('production normalizer prompt extraction failed')
  const output = resolve(root, 'tmp/normalizer-replay/runtime.mjs')
  await mkdir(dirname(output), { recursive: true })
  await build({ stdin: { contents: `
    export { createAgent, promptWithTimeout, replayPrompt } from './src/main/agent/pi-document-client';
    export { createPiModelRegistry } from './src/main/agent/model-registry';
    export { loadPiAgentConfig } from './src/main/agent/config';
    export { getExtractionAdapter } from './src/main/businesses/extraction-registry';
  `, resolveDir: root, loader: 'ts' }, outfile: output, bundle: true, packages: 'external', platform: 'node', format: 'esm',
    define: { 'import.meta.env': '{}' }, plugins: [{ name: 'test-only-exports', setup(b) {
      b.onLoad({ filter: /pi-document-client\.ts$/ }, () => ({ loader: 'ts', resolveDir: dirname(path),
        contents: `${source}\nexport { createAgent, promptWithTimeout };\nexport function replayPrompt(pageNumber: number, pageCount: number, pageText: string): string { return ${prompts[0]}; }` }))
    } }] })
  return import(pathToFileURL(output).href)
}
