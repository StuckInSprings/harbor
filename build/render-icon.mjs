import sharp from 'sharp'
import { mkdir } from 'node:fs/promises'
const svg = new URL('./icon.svg', import.meta.url).pathname
const dir = new URL('./icon.iconset/', import.meta.url).pathname
await mkdir(dir, { recursive: true })
for (const base of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    const px = base * scale
    await sharp(svg, { density: 72 * (px / 1024) * 4 }).resize(px, px).png().toFile(`${dir}icon_${base}x${base}${scale === 2 ? '@2x' : ''}.png`)
  }
}
await sharp(svg).resize(256, 256).png().toFile(new URL('./icon-preview.png', import.meta.url).pathname)
console.log('rendered')
