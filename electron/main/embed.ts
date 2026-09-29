import { app } from 'electron'
import { join } from 'node:path'

/**
 * Local embeddings.
 *
 * bge-small-en-v1.5 runs in-process through ONNX, so indexing is free, works
 * offline once the model is cached, and needs no second provider key on top of
 * OpenRouter. The model is fetched from Hugging Face the first time and cached
 * under Application Support; that is the only network call Harbor makes to
 * anywhere other than OpenRouter.
 */

export const DIMENSIONS = 384

type Extractor = (
  input: string[],
  opts: { pooling: 'mean'; normalize: boolean }
) => Promise<{ data: Float32Array; dims: number[] }>

let extractor: Promise<Extractor> | null = null

export function isReady(): boolean {
  return extractor !== null
}

async function load(): Promise<Extractor> {
  const { pipeline, env } = await import('@huggingface/transformers')
  env.cacheDir = join(app.getPath('userData'), 'models')
  env.allowLocalModels = false
  return (await pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5', {
    dtype: 'fp32'
  })) as unknown as Extractor
}

/** Vectors come back normalised, so cosine distance is just the dot product. */
export async function embed(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return []
  extractor ??= load()
  const run = await extractor

  const out: Float32Array[] = []
  // Batched, because a whole folder at once exhausts memory on large sources.
  const BATCH = 16
  for (let i = 0; i < texts.length; i += BATCH) {
    const slice = texts.slice(i, i + BATCH)
    const result = await run(slice, { pooling: 'mean', normalize: true })
    for (let j = 0; j < slice.length; j++) {
      out.push(result.data.slice(j * DIMENSIONS, (j + 1) * DIMENSIONS) as Float32Array)
    }
  }
  return out
}

/**
 * bge asks for a short instruction prefix on the query side only; it measurably
 * improves retrieval and costs nothing.
 */
export const asQuery = (text: string): string =>
  `Represent this sentence for searching relevant passages: ${text}`

export const toBuffer = (v: Float32Array): Buffer =>
  Buffer.from(v.buffer, v.byteOffset, v.byteLength)
