const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron')
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')
const crypto = require('crypto')

let ffmpegPath = require('ffmpeg-static')
if (app.isPackaged) ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked')

let win = null

// L'app si chiamava "Podcast Editor": se esiste ancora la vecchia cartella dati la si continua a usare,
// così non si perdono il salvataggio automatico e il modello vocale già scaricato.
const legacyUserData = path.join(app.getPath('appData'), 'Podcast Editor')
if (fs.existsSync(legacyUserData)) app.setPath('userData', legacyUserData)

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 840,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0a0f24',
    title: 'Tidycast',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
  if (process.env.VITE_DEV_SERVER_URL) win.loadURL(process.env.VITE_DEV_SERVER_URL)
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

const AUDIO_EXT = ['mp3', 'wav', 'flac', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'wma', 'aif', 'aiff', 'mp4', 'mov', 'mkv', 'webm']

ipcMain.handle('dialog:open', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Importa audio',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'File audio e video', extensions: AUDIO_EXT },
      { name: 'Tutti i file', extensions: ['*'] },
    ],
  })
  return r.canceled ? [] : r.filePaths
})

// Decodifica qualunque formato in PCM 16 bit, 44.1 kHz, stereo.
ipcMain.handle('audio:decode', (_e, filePath) => {
  return new Promise((resolve) => {
    const chunks = []
    let err = ''
    const p = spawn(ffmpegPath, ['-v', 'error', '-i', filePath, '-vn', '-ac', '2', '-ar', '44100', '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1'], { windowsHide: true })
    p.stdout.on('data', (d) => chunks.push(d))
    p.stderr.on('data', (d) => (err += d.toString()))
    p.on('error', (e) => resolve({ ok: false, error: e.message }))
    p.on('close', (code) => {
      const data = Buffer.concat(chunks)
      if (code !== 0 || data.length === 0) {
        resolve({ ok: false, error: err.trim().split('\n').pop() || 'Nessuna traccia audio trovata nel file.' })
      } else {
        resolve({ ok: true, name: path.basename(filePath), data })
      }
    })
  })
})

// ---- Esportazione in streaming: il renderer manda blocchi PCM a ffmpeg ----
let exp = null

const FORMATS = {
  mp3: { label: 'MP3', args: (hq) => ['-c:a', 'libmp3lame', '-b:a', hq ? '256k' : '160k'] },
  wav: { label: 'WAV', args: () => ['-c:a', 'pcm_s16le'] },
  flac: { label: 'FLAC', args: () => ['-c:a', 'flac'] },
  ogg: { label: 'OGG', args: (hq) => ['-c:a', 'libvorbis', '-q:a', hq ? '6' : '4'] },
  m4a: { label: 'M4A (AAC)', args: (hq) => ['-c:a', 'aac', '-b:a', hq ? '256k' : '160k', '-movflags', '+faststart'] },
}

ipcMain.handle('export:begin', async (_e, o) => {
  const f = FORMATS[o.format]
  if (!f) return { error: 'Formato non supportato' }
  const r = await dialog.showSaveDialog(win, {
    title: 'Esporta audio',
    defaultPath: `${o.defaultName || 'podcast'}.${o.format}`,
    filters: [{ name: f.label, extensions: [o.format] }],
  })
  if (r.canceled || !r.filePath) return { canceled: true }

  const m = o.meta || {}
  const cover = m.cover && ['mp3', 'm4a', 'flac'].includes(o.format) && fs.existsSync(m.cover) ? m.cover : null
  const args = ['-y', '-v', 'error', '-f', 's16le', '-ar', String(o.sampleRate), '-ac', '2', '-i', 'pipe:0']
  let nIn = 1
  const coverIdx = cover ? nIn++ : -1
  if (cover) args.push('-i', cover)
  // capitoli: file di metadati ffmpeg (solo MP3 e M4A li supportano)
  const chs = (Array.isArray(o.chapters) ? o.chapters : []).filter((c) => Number.isFinite(c.t)).sort((a, b) => a.t - b.t)
  let chapFile = null
  if (chs.length && ['mp3', 'm4a'].includes(o.format)) {
    const esc = (t) => String(t || '').replace(/[\r\n]+/g, ' ').replace(/[=;#\\]/g, (m) => '\\' + m)
    const total = Math.max(1, Math.round((o.duration || chs[chs.length - 1].t + 1) * 1000))
    let txt = ';FFMETADATA1\n'
    chs.forEach((c, i) => {
      const st = Math.round(c.t * 1000)
      const en = i + 1 < chs.length ? Math.round(chs[i + 1].t * 1000) : total
      if (en > st) txt += `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${st}\nEND=${en}\ntitle=${esc(c.title)}\n`
    })
    chapFile = path.join(app.getPath('temp'), `podcast-chapters-${Date.now()}.txt`)
    fs.writeFileSync(chapFile, txt, 'utf8')
    args.push('-i', chapFile, '-map_chapters', String(nIn++))
  }
  if (o.normalize) args.push('-af', 'loudnorm=I=-16:TP=-1.5:LRA=11')
  if (cover) args.push('-map', '0:a', '-map', `${coverIdx}:v`, '-c:v', 'copy', '-disposition:v:0', 'attached_pic')
  if (o.format === 'mp3') args.push('-id3v2_version', '3')
  const tags = { title: m.title, artist: m.artist, album_artist: m.artist, album: m.album, track: m.track, date: m.year, comment: m.comment }
  for (const [k, v] of Object.entries(tags)) if (v && String(v).trim()) args.push('-metadata', `${k}=${String(v).trim()}`)
  if (Object.values(tags).some((v) => v && String(v).trim())) args.push('-metadata', 'genre=Podcast')
  args.push('-ar', String(o.sampleRate), ...f.args(o.quality === 'high'), r.filePath)

  const proc = spawn(ffmpegPath, args, { windowsHide: true })
  let err = ''
  proc.stderr.on('data', (d) => (err += d.toString()))
  proc.stdin.on('error', () => {})
  const done = new Promise((resolve) => {
    proc.on('error', (e) => resolve({ ok: false, error: e.message }))
    proc.on('close', (code) => resolve(code === 0 ? { ok: true, filePath: r.filePath } : { ok: false, error: err.trim().split('\n').pop() || 'Errore di esportazione' }))
  })
  exp = { proc, done, filePath: r.filePath }
  if (chapFile) done.then(() => { try { fs.unlinkSync(chapFile) } catch {} })
  return { ok: true, filePath: r.filePath }
})

ipcMain.handle('export:chunk', (_e, buf) => {
  if (!exp) return false
  const stdin = exp.proc.stdin
  const ok = stdin.write(Buffer.from(buf))
  return ok ? true : new Promise((res) => stdin.once('drain', () => res(true)))
})

ipcMain.handle('export:end', async () => {
  if (!exp) return { ok: false, error: 'Nessuna esportazione attiva' }
  const e = exp
  exp = null
  e.proc.stdin.end()
  return e.done
})

ipcMain.handle('export:cancel', async () => {
  if (!exp) return
  const e = exp
  exp = null
  e.proc.kill()
  await e.done
  try { fs.unlinkSync(e.filePath) } catch {}
})

ipcMain.handle('shell:reveal', (_e, p) => shell.showItemInFolder(p))

// ---- Progetti (.podcast = JSON) ----
ipcMain.handle('project:save', async (_e, o) => {
  let target = o.path
  if (!target) {
    const r = await dialog.showSaveDialog(win, {
      title: 'Salva progetto',
      defaultPath: `${o.defaultName || 'Il mio podcast'}.podcast`,
      filters: [{ name: 'Progetto Tidycast', extensions: ['podcast'] }],
    })
    if (r.canceled || !r.filePath) return { canceled: true }
    target = r.filePath
  }
  try {
    fs.writeFileSync(target, o.text, 'utf8')
    return { path: target }
  } catch (e) {
    return { error: e.message }
  }
})

ipcMain.handle('project:open', async (_e, p) => {
  let target = p
  if (!target) {
    const r = await dialog.showOpenDialog(win, {
      title: 'Apri progetto',
      properties: ['openFile'],
      filters: [{ name: 'Progetto Tidycast', extensions: ['podcast'] }],
    })
    if (r.canceled || !r.filePaths[0]) return { canceled: true }
    target = r.filePaths[0]
  }
  try {
    return { path: target, text: fs.readFileSync(target, 'utf8') }
  } catch (e) {
    return { error: e.message }
  }
})

// Chiude senza perdere nulla: chiede conferma se ci sono modifiche non salvate
app.on('web-contents-created', (_e, wc) => {
  wc.on('will-prevent-unload', (ev) => {
    const choice = dialog.showMessageBoxSync(BrowserWindow.fromWebContents(wc), {
      type: 'question',
      buttons: ['Torna al progetto', 'Esci senza salvare'],
      defaultId: 0,
      cancelId: 0,
      title: 'Modifiche non salvate',
      message: 'Ci sono modifiche non salvate.',
      detail: 'Se esci ora andranno perse.',
    })
    if (choice === 1) {
      ev.preventDefault()
      try { fs.unlinkSync(autosavePath()) } catch {}
    }
  })
})

// ---- Microfono: permessi e registrazione su disco in streaming ----
const { session, systemPreferences } = require('electron')
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'media'))
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => perm === 'media')
})

ipcMain.handle('mic:access', async () => {
  if (process.platform === 'darwin') return systemPreferences.askForMediaAccess('microphone')
  return true
})

let rec = null

ipcMain.handle('rec:begin', () => {
  const dir = path.join(app.getPath('documents'), 'Tidycast', 'Registrazioni')
  fs.mkdirSync(dir, { recursive: true })
  const d = new Date()
  const p2 = (n) => String(n).padStart(2, '0')
  const name = `Registrazione ${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}.${p2(d.getMinutes())}.${p2(d.getSeconds())}.wav`
  const fp = path.join(dir, name)
  const fd = fs.openSync(fp, 'w')
  fs.writeSync(fd, Buffer.alloc(44))
  rec = { fd, fp, bytes: 0 }
  return { path: fp }
})

ipcMain.handle('rec:chunk', (_e, buf) => {
  if (!rec) return
  const b = Buffer.from(buf)
  fs.writeSync(rec.fd, b)
  rec.bytes += b.length
})

ipcMain.handle('rec:end', (_e, sr) => {
  if (!rec) return { error: 'Nessuna registrazione attiva' }
  const { fd, fp, bytes } = rec
  rec = null
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + bytes, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20) // PCM
  h.writeUInt16LE(1, 22) // mono
  h.writeUInt32LE(sr, 24)
  h.writeUInt32LE(sr * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(bytes, 40)
  fs.writeSync(fd, h, 0, 44, 0)
  fs.closeSync(fd)
  return { path: fp }
})

ipcMain.handle('rec:cancel', () => {
  if (!rec) return
  const { fd, fp } = rec
  rec = null
  try { fs.closeSync(fd) } catch {}
  try { fs.unlinkSync(fp) } catch {}
})


// ---- Migliora voce: filtra una copia del file (l'originale non viene toccato) ----
ipcMain.handle('audio:enhance', (_e, srcPath, thr) => {
  return new Promise((resolve) => {
    let st
    try { st = fs.statSync(srcPath) } catch (e) { return resolve({ ok: false, error: 'File non trovato' }) }
    const gate = Math.min(0.05, Math.max(0.003, (Number(thr) || 0.01) * 0.8))
    const filter = [
      'highpass=f=80',
      'afftdn=nr=20:nf=-50:tn=1',
      `agate=threshold=${gate.toFixed(4)}:ratio=3:range=0.25:attack=15:release=300`,
      'acompressor=threshold=0.089:ratio=3:attack=15:release=250:makeup=2',
      'alimiter=limit=0.95',
    ].join(',')
    const hash = crypto.createHash('md5').update(`${srcPath}|${st.mtimeMs}|${st.size}|${filter}`).digest('hex').slice(0, 10)
    const dir = path.join(app.getPath('documents'), 'Tidycast', 'Elaborati')
    fs.mkdirSync(dir, { recursive: true })
    const base = path.basename(srcPath).replace(/\.[^.]+$/, '')
    const out = path.join(dir, `${base}-voce-${hash}.wav`)
    if (fs.existsSync(out)) return resolve({ ok: true, path: out })
    const tmp = out.replace(/\.wav$/, '.part.wav')
    let err = ''
    const p = spawn(ffmpegPath, ['-y', '-v', 'error', '-i', srcPath, '-vn', '-ac', '2', '-ar', '44100', '-af', filter, '-c:a', 'pcm_s16le', tmp], { windowsHide: true })
    p.stderr.on('data', (d) => (err += d.toString()))
    p.on('error', (e) => resolve({ ok: false, error: e.message }))
    p.on('close', (code) => {
      if (code !== 0) {
        try { fs.unlinkSync(tmp) } catch {}
        return resolve({ ok: false, error: err.trim().split('\n').pop() || 'Elaborazione non riuscita' })
      }
      fs.renameSync(tmp, out)
      resolve({ ok: true, path: out })
    })
  })
})

// ---- Copertina dell'episodio ----
function readCover(p) {
  try {
    const b = fs.readFileSync(p)
    const mime = path.extname(p).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg'
    return `data:${mime};base64,${b.toString('base64')}`
  } catch {
    return null
  }
}
ipcMain.handle('cover:pick', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Scegli la copertina',
    properties: ['openFile'],
    filters: [{ name: 'Immagini JPG o PNG', extensions: ['jpg', 'jpeg', 'png'] }],
  })
  if (r.canceled || !r.filePaths[0]) return null
  return { path: r.filePaths[0], dataUrl: readCover(r.filePaths[0]) }
})
ipcMain.handle('cover:read', (_e, p) => readCover(p))

// ---- Salvataggio automatico / recupero ----
const autosavePath = () => path.join(app.getPath('userData'), 'autosave.podcast')
ipcMain.handle('autosave:write', (_e, text) => {
  try { fs.writeFileSync(autosavePath(), text, 'utf8') } catch {}
})
ipcMain.handle('autosave:read', () => {
  try {
    const p = autosavePath()
    return { text: fs.readFileSync(p, 'utf8'), mtime: fs.statSync(p).mtimeMs }
  } catch {
    return null
  }
})
ipcMain.handle('autosave:clear', () => {
  try { fs.unlinkSync(autosavePath()) } catch {}
})


// ---- Trascrizione locale (Whisper, nessun dato lascia il computer) ----
// Il modello si scarica una sola volta in userData/models e poi funziona anche senza internet.
const ASR_MODEL = 'Xenova/whisper-base'
const asrDir = () => path.join(app.getPath('userData'), 'models')
const asrFiles = () => ['encoder_model_quantized.onnx', 'decoder_model_merged_quantized.onnx'].map((f) => path.join(asrDir(), ASR_MODEL, 'onnx', f))
const asrInstalled = () => asrFiles().every((f) => fs.existsSync(f))
let asrPipe = null
const asrSend = (d) => { try { win?.webContents.send('asr:progress', d) } catch {} }

ipcMain.handle('asr:status', () => ({ installed: asrInstalled(), sizeMB: 80 }))

async function asrLoad() {
  if (asrPipe) return asrPipe
  const tf = require('@huggingface/transformers')
  tf.env.cacheDir = asrDir()
  const files = new Map()
  const need = !asrInstalled()
  asrPipe = tf.pipeline('automatic-speech-recognition', ASR_MODEL, {
    dtype: 'q8',
    progress_callback: (d) => {
      if (!need) return
      if (d.status === 'progress' && d.total) {
        files.set(d.file, { l: d.loaded, t: d.total })
        let l = 0, t = 0
        for (const v of files.values()) { l += v.l; t += v.t }
        asrSend({ phase: 'download', pct: t ? l / t : 0 })
      }
    },
  })
  try { return await asrPipe } catch (e) { asrPipe = null; throw e }
}

ipcMain.handle('asr:transcribe', async (_e, srcPath) => {
  try {
    asrSend({ phase: asrInstalled() ? 'load' : 'download', pct: 0 })
    const pipe = await asrLoad()
    asrSend({ phase: 'transcribe', pct: 0 })
    // audio a 16 kHz mono float32
    const audio = await new Promise((resolve, reject) => {
      const chunks = []
      let err = ''
      const p = spawn(ffmpegPath, ['-v', 'error', '-i', srcPath, '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1'], { windowsHide: true })
      p.stdout.on('data', (d) => chunks.push(d))
      p.stderr.on('data', (d) => (err += d.toString()))
      p.on('error', reject)
      p.on('close', (code) => {
        const b = Buffer.concat(chunks)
        if (code !== 0 || !b.length) return reject(new Error(err.trim().split('\n').pop() || 'Audio non leggibile'))
        const ab = new ArrayBuffer(b.length - (b.length % 4))
        new Uint8Array(ab).set(b.subarray(0, ab.byteLength))
        resolve(new Float32Array(ab))
      })
    })
    const dur = audio.length / 16000
    const totalChunks = Math.max(1, Math.ceil(dur / 20))
    let done = 0
    const out = await pipe(audio, {
      language: 'italian',
      task: 'transcribe',
      return_timestamps: 'word',
      chunk_length_s: 30,
      stride_length_s: 5,
      chunk_callback: () => asrSend({ phase: 'transcribe', pct: Math.min(0.97, ++done / totalChunks) }),
    })
    const words = (out.chunks || [])
      .map((c) => ({ w: String(c.text).trim(), s: c.timestamp[0], e: c.timestamp[1] ?? c.timestamp[0] + 0.3 }))
      .filter((w) => w.w && Number.isFinite(w.s))
    asrSend({ phase: 'transcribe', pct: 1 })
    return { ok: true, words, duration: dur }
  } catch (e) {
    return { ok: false, error: String(e.message || e) }
  }
})
