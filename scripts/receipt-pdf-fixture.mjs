import { readFile } from 'node:fs/promises'
import { createCanvas, loadImage } from '@napi-rs/canvas'

// A small test-only PDF writer: every page contains the same user-provided
// receipt. Reusing one image XObject keeps the fixture small and deterministic.
export async function createReceiptPdf(imagePath, pageCount = 3) {
  const image = await loadImage(await readFile(imagePath))
  const canvas = createCanvas(image.width, image.height)
  canvas.getContext('2d').drawImage(image, 0, 0)
  const jpeg = await canvas.encode('jpeg', 95)
  const pageIds = Array.from({ length: pageCount }, (_, index) => 4 + index * 2)
  const stream = (data, dictionary = '') => Buffer.concat([
    Buffer.from(`<< ${dictionary} /Length ${data.length} >>\nstream\n`),
    data,
    Buffer.from('\nendstream')
  ])
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>`),
    stream(jpeg, `/Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`)
  ]
  for (const id of pageIds) {
    objects.push(Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${image.width} ${image.height}] /Resources << /XObject << /Receipt 3 0 R >> >> /Contents ${id + 1} 0 R >>`))
    objects.push(stream(Buffer.from(`q ${image.width} 0 0 ${image.height} 0 0 cm /Receipt Do Q`)))
  }
  const chunks = [Buffer.from('%PDF-1.4\n')]
  const offsets = [0]
  let length = chunks[0].length
  objects.forEach((object, index) => {
    offsets.push(length)
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from('\nendobj\n')])
    chunks.push(chunk)
    length += chunk.length
  })
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`))
  return Buffer.concat(chunks)
}
