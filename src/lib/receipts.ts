import { supabase } from './supabase'

const BUCKET = 'receipts'
const MAX_EDGE = 1600

/** Downscale phone photos to keep uploads small; PDFs and small images pass through. */
async function prepare(file: File): Promise<{ blob: Blob; ext: string; type: string }> {
  if (file.type === 'application/pdf') return { blob: file, ext: 'pdf', type: file.type }
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * scale)
    canvas.height = Math.round(bitmap.height * scale)
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.82))
    if (blob) return { blob, ext: 'jpg', type: 'image/jpeg' }
  } catch {
    // Browser can't decode it (e.g. HEIC on desktop) — upload the original.
  }
  const ext = (file.name.split('.').pop() ?? 'jpg').toLowerCase()
  return { blob: file, ext: ext === 'jpeg' ? 'jpg' : ext, type: file.type }
}

/** Uploads into the group's folder and returns the storage path to save on the expense. */
export async function uploadReceipt(code: string, file: File): Promise<string> {
  const { blob, ext, type } = await prepare(file)
  if (blob.size > 5 * 1024 * 1024) throw new Error('That file is over 5 MB.')
  const path = `${code}/${crypto.randomUUID()}.${ext}`
  const { error } = await supabase.storage.from(BUCKET).upload(path, blob, { contentType: type })
  if (error) throw new Error(error.message)
  return path
}

export const receiptUrl = (path: string) => supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl

export const isPdf = (path: string) => path.endsWith('.pdf')
