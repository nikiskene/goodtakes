import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readFile, rename, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const manifest = JSON.parse(await readFile(new URL('../src/web/model-files.json', import.meta.url), 'utf8'))
const release = join('models', manifest.revision.slice(0, 12), manifest.name)
const cache = resolve('node_modules/.cache/goodtake-web', release)
const publish = resolve(process.argv[2] ?? 'dist', release)

async function verified(path, checksum) {
  try {
    const hash = createHash('sha256')
    for await (const buffer of createReadStream(path)) hash.update(buffer)
    return hash.digest('hex') === checksum
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

await Promise.all(Object.entries(manifest.files).map(async ([name, checksum]) => {
  const cached = join(cache, name)
  const target = join(publish, name)
  await mkdir(dirname(cached), { recursive: true })
  await mkdir(dirname(target), { recursive: true })
  if (!await verified(cached, checksum)) {
    const pending = cached + '.partial'
    const url = `https://huggingface.co/${manifest.name}/resolve/${manifest.revision}/${name}`
    try {
      await run('curl', ['-fLsS', '--retry', '2', '--connect-timeout', '20', '--max-time', '180', url, '-o', pending])
      if (!await verified(pending, checksum)) throw new Error(`Model checksum mismatch: ${name}`)
      await rename(pending, cached)
    } finally {
      await rm(pending, { force: true })
    }
  }
  await copyFile(cached, target)
}))

console.log(`Published verified browser speech files in ${publish}`)
