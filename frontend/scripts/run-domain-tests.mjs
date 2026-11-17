#!/usr/bin/env node
/**
 * 领域引擎测试运行器：用 esbuild 把 *.test.ts 临时打成 ESM，再交给 node --test。
 * 不新增依赖、不污染源码目录（产物放在系统临时目录，跑完即删）。
 */
import { build } from 'esbuild'
import { mkdtemp, rm, readdir, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { run } from 'node:test'
import { spec } from 'node:test/reporters'

const here = dirname(fileURLToPath(import.meta.url))
const srcDir = join(here, '..', 'src')
const domainDir = join(srcDir, 'domain', 'label-recompute')

async function resolveTs(importPath) {
  const candidates = [importPath, `${importPath}.ts`, join(importPath, 'index.ts'), `${importPath}.js`]
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // 继续尝试下一个候选
    }
  }
  return importPath
}

// 与 vite.config.ts / tsconfig.json 保持一致的 @ → src 别名，并补齐 TS 扩展名解析。
const aliasPlugin = {
  name: 'at-alias',
  setup(buildApi) {
    buildApi.onResolve({ filter: /^@\// }, async (args) => ({
      path: await resolveTs(join(srcDir, args.path.slice(2))),
    }))
    buildApi.onResolve({ filter: /^\.\.?\// }, async (args) => ({
      path: await resolveTs(join(args.resolveDir, args.path)),
    }))
  },
}

const entries = (await readdir(domainDir)).filter((name) => name.endsWith('.test.ts'))
if (entries.length === 0) {
  console.error('未找到 *.test.ts 测试文件')
  process.exit(1)
}

const workdir = await mkdtemp(join(tmpdir(), 'label-recompute-tests-'))
try {
  const bundled = []
  for (const entry of entries) {
    const result = await build({
      entryPoints: [join(domainDir, entry)],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      write: false,
      logLevel: 'silent',
      plugins: [aliasPlugin],
    })
    const outFile = join(workdir, entry.replace(/\.ts$/, '.mjs'))
    await writeFile(outFile, result.outputFiles[0].text)
    bundled.push(outFile)
  }

  let failed = 0
  for (const file of bundled) {
    const stream = run({ files: [file] })
    stream.on('test:fail', () => {
      failed += 1
    })
    stream.compose(spec).pipe(process.stdout)
    await new Promise((resolve) => stream.on('end', resolve))
  }
  process.exitCode = failed === 0 ? 0 : 1
} finally {
  await rm(workdir, { recursive: true, force: true })
}

void pathToFileURL
