/// <reference types="vite/client" />
export {}

interface ExportMeta {
  title: string
  artist: string
  album: string
  track: string
  year: string
  comment: string
  cover: string | null
}

declare global {
  interface Window {
    api: {
      openDialog(): Promise<string[]>
      decode(path: string): Promise<{ ok: true; name: string; data: Uint8Array } | { ok: false; error: string }>
      pathForFile(f: File): string
      exportBegin(o: {
        format: string
        quality: string
        normalize: boolean
        sampleRate: number
        defaultName: string
        meta?: ExportMeta
        chapters?: { t: number; title: string }[]
        duration?: number
      }): Promise<{ ok?: boolean; canceled?: boolean; error?: string; filePath?: string }>
      exportChunk(b: ArrayBuffer): Promise<boolean>
      exportEnd(): Promise<{ ok: boolean; error?: string; filePath?: string }>
      exportCancel(): Promise<void>
      reveal(p: string): Promise<void>
      projectSave(o: { path: string | null; defaultName: string; text: string }): Promise<{ path?: string; canceled?: boolean; error?: string }>
      projectOpen(p?: string): Promise<{ path?: string; text?: string; canceled?: boolean; error?: string }>
      micAccess(): Promise<boolean>
      recBegin(): Promise<{ path: string }>
      recChunk(b: ArrayBuffer): Promise<void>
      recEnd(sr: number): Promise<{ path?: string; error?: string }>
      recCancel(): Promise<void>
      enhance(path: string, thr: number): Promise<{ ok: boolean; path?: string; error?: string }>
      pickCover(): Promise<{ path: string; dataUrl: string | null } | null>
      readCover(path: string): Promise<string | null>
      autosaveWrite(text: string): Promise<void>
      autosaveRead(): Promise<{ text: string; mtime: number } | null>
      autosaveClear(): Promise<void>
      asrStatus(): Promise<{ installed: boolean; sizeMB: number }>
      asrTranscribe(path: string): Promise<{ ok: true; words: { w: string; s: number; e: number }[]; duration: number } | { ok: false; error: string }>
      onAsrProgress(cb: (d: { phase: 'download' | 'load' | 'transcribe'; pct: number }) => void): () => void
    }
  }
}
