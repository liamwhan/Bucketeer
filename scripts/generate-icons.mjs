import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import * as png2icons from 'png2icons'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const srcPng = join(root, 'Bucketeer.png')
const outDir = join(root, 'build')

mkdirSync(outDir, { recursive: true })

const input = readFileSync(srcPng)

const icns = png2icons.createICNS(input, png2icons.BICUBIC, 0)
if (!icns) {
  throw new Error('png2icons: failed to create ICNS')
}
writeFileSync(join(outDir, 'icon.icns'), icns)

const ico = png2icons.createICO(input, png2icons.BICUBIC2, 0, false, true)
if (!ico) {
  throw new Error('png2icons: failed to create ICO (Windows executable)')
}
writeFileSync(join(outDir, 'icon.ico'), ico)

copyFileSync(srcPng, join(outDir, 'icon.png'))

console.log('Generated build/icon.ico, build/icon.icns, build/icon.png from Bucketeer.png')
