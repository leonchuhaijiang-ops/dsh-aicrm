/**
 * dsh-sales — dock-attach.cjs（2026-10-21 从 dsh-loop/dsh/attach.cjs 移植，逻辑未改）
 * 多模态上传：图片走宿主附件服务（ctx.attachments），文件就地抽文本后拼进提示词。
 *
 * 用户 2026-10-21（m01480）：「在sale插件右侧边增加AI对话框……要支持多模态的文件和图片上传」。
 * 为什么要这一层：
 *   · 图片不能直接塞 base64 给模型——pi-ai 适配器要求消息里是**宿主附件引用**
 *     （{type:'image', attachment:ref}），它自己去 ctx.attachments 读版本、按像素预算缩放；
 *     随手塞 data URI 会被判 UNSUPPORTED_CONTENT。
 *   · 文件（txt/csv/docx/xlsx…）模型看不见字节，只能先把正文抽成文本。
 *     为了不引新依赖，zip 用 node:zlib 自己解（docx/xlsx 都是 zip）。
 *
 * 红线：客户数据只在本机 → 这里只做「把用户自己挑的文件读进来」，不发任何网络请求；
 *      真正出网的只有后面那一次模型调用（跟文本对话同一条通道）。
 */
const zlib = require('node:zlib')

// ---------- 上限（写死，面板上照此提示；改这里等于改契约） ----------
const CAPS = {
  maxImages: 4,
  maxImageBytes: 4 * 1024 * 1024, // 单张解码后
  maxTotalImageBytes: 8 * 1024 * 1024, // 整条消息
  maxFiles: 4,
  maxFileBytes: 8 * 1024 * 1024, // 单个文件原始字节（2026-10-21 由 2MB 放宽：合同/报价 PDF 常超 2MB）
  // 2026-10-21（m02957）：6 万字 → 20 万字。用户传的客户表一抽就是 9.9 万字，6 万会拦腰截断，
  //   模型只能看到前 500 行还以为是全部。当前会话模型窗口 100 万，20 万字（≈10 万 token）留够余量。
  maxTextChars: 200000, // 抽出来后拼进提示词的总字符上限

}

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const TEXT_EXT = ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'xml', 'html', 'htm', 'log', 'srt', 'vtt', 'sql', 'yaml', 'yml', 'ini', 'conf', 'eml']
const OFFICE_EXT = ['docx', 'xlsx']
const PDF_EXT = ['pdf']

function extOf (name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(name || ''))
  return m ? m[1].toLowerCase() : ''
}

/** 这一个上传到底怎么处理：image / text / docx / xlsx / pdf / unsupported */
function kindOf (name, mediaType) {
  const mt = String(mediaType || '').toLowerCase()
  if (IMAGE_TYPES.indexOf(mt) !== -1) return 'image'
  const ext = extOf(name)
  if (TEXT_EXT.indexOf(ext) !== -1) return 'text'
  if (ext === 'docx') return 'docx'
  if (ext === 'xlsx') return 'xlsx'
  if (ext === 'pdf') return 'pdf'
  return 'unsupported'
}

/** 宽松 base64 解码：容忍 data: 前缀、空白、URL-safe 变体；坏串返回 null。 */
function decodeB64 (b64) {
  let s = String(b64 == null ? '' : b64).trim()
  if (!s) return null
  const comma = s.indexOf(',')
  if (/^data:/i.test(s) && comma !== -1) s = s.slice(comma + 1)
  s = s.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/')
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return null
  try { return Buffer.from(s, 'base64') } catch (e) { return null }
}

// ---------- 最小 zip 读取器（够读 docx/xlsx；零依赖） ----------
const SIG_EOCD = 0x06054b50
const SIG_CEN = 0x02014b50
const SIG_LOC = 0x04034b50

function findEocd (buf) {
  const from = Math.max(0, buf.length - 0x10000 - 22)
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i
  }
  return -1
}

/**
 * 读 zip 里指定的条目。
 * @returns {{ok:boolean, entries:Object<string,Buffer>, error?:string}}
 */
function zipRead (buf, wanted) {
  const want = new Set((wanted || []).map((x) => String(x)))
  const entries = {}
  try {
    const eocd = findEocd(buf)
    if (eocd < 0) return { ok: false, entries, error: '不是 zip（找不到目录尾）' }
    const count = buf.readUInt16LE(eocd + 10)
    let p = buf.readUInt32LE(eocd + 16)
    for (let i = 0; i < count; i++) {
      if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CEN) break
      const method = buf.readUInt16LE(p + 10)
      const compSize = buf.readUInt32LE(p + 20)
      const nameLen = buf.readUInt16LE(p + 28)
      const extraLen = buf.readUInt16LE(p + 30)
      const cmtLen = buf.readUInt16LE(p + 32)
      const locOff = buf.readUInt32LE(p + 42)
      const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8')
      p = p + 46 + nameLen + extraLen + cmtLen
      if (!want.has(name)) continue
      if (locOff + 30 > buf.length || buf.readUInt32LE(locOff) !== SIG_LOC) continue
      const lNameLen = buf.readUInt16LE(locOff + 26)
      const lExtraLen = buf.readUInt16LE(locOff + 28)
      const start = locOff + 30 + lNameLen + lExtraLen
      const raw = buf.slice(start, start + compSize)
      if (method === 0) entries[name] = raw
      else if (method === 8) entries[name] = zlib.inflateRawSync(raw)
      else continue
    }
    return { ok: true, entries }
  } catch (e) {
    return { ok: false, entries, error: '解压失败：' + String((e && e.message) || e) }
  }
}

function unescapeXml (s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#x([0-9a-fA-F]+);/g, (m, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)) } catch (e) { return m }
    })
    .replace(/&#(\d+);/g, (m, d) => {
      try { return String.fromCodePoint(parseInt(d, 10)) } catch (e) { return m }
    })
    .replace(/&amp;/g, '&')
}

/** docx → 纯文本（段落换行、制表符保留），失败返回 {ok:false} */
function docxText (buf) {
  const z = zipRead(buf, ['word/document.xml'])
  if (!z.ok || !z.entries['word/document.xml']) return { ok: false, text: '', error: z.error || 'docx 里没有 word/document.xml' }
  let xml = z.entries['word/document.xml'].toString('utf8')
  // 先留边界（段落/表格/换行/制表），再整段去标签：
  //   只抽 <w:t> 会丢掉段落换行（实测一段话粘成一行），这里以"结构换行优先"。
  xml = xml.replace(/<w:tab\b[^>]*\/>/g, '\t').replace(/<w:br\b[^>]*\/>/g, '\n')
  xml = xml.replace(/<\/w:p>/g, '\n').replace(/<\/w:tc>/g, '\t').replace(/<\/w:tr>/g, '\n')
  xml = xml.replace(/<[^>]+>/g, '')
  const text = unescapeXml(xml)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { ok: true, text: text }
}

/** xlsx → 纯文本（每行一行、单元格制表符分隔）；只读共享串 + 内联串，够喂模型 */
function xlsxText (buf) {
  const z = zipRead(buf, ['xl/sharedStrings.xml', 'xl/workbook.xml'])
  const all = zipReadAll(buf)
  if (!all.ok) return { ok: false, text: '', error: all.error }
  const shared = []
  const ss = z.entries['xl/sharedStrings.xml']
  if (ss) {
    const xml = ss.toString('utf8')
    const re = /<si>([\s\S]*?)<\/si>/g
    let m
    while ((m = re.exec(xml))) {
      const parts = []
      const tr = /<t(?: [^>]*)?>([\s\S]*?)<\/t>/g
      let t
      while ((t = tr.exec(m[1]))) parts.push(unescapeXml(t[1]))
      shared.push(parts.join(''))
    }
  }
  const sheetNames = Object.keys(all.entries).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => {
    const na = Number((/sheet(\d+)\.xml$/.exec(a) || [])[1] || 0)
    const nb = Number((/sheet(\d+)\.xml$/.exec(b) || [])[1] || 0)
    return na - nb
  })
  if (!sheetNames.length) return { ok: false, text: '', error: 'xlsx 里没有工作表' }
  const out = []
  sheetNames.forEach((n, idx) => {
    const xml = all.entries[n].toString('utf8')
    const lines = []
    const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g
    let r
    while ((r = rowRe.exec(xml))) {
      const cells = []
      const cellRe = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g
      let c
      while ((c = cellRe.exec(r[1]))) {
        const attrs = c[1] || c[3] || ''
        const inner = c[2] || ''
        const t = (/t="([^"]+)"/.exec(attrs) || [])[1] || ''
        const vm = /<v>([\s\S]*?)<\/v>/.exec(inner)
        const v = vm ? unescapeXml(vm[1]) : ''
        if (t === 's') cells.push(shared[Number(v)] || '')
        else if (t === 'inlineStr') {
          const tm = /<t(?: [^>]*)?>([\s\S]*?)<\/t>/.exec(inner)
          cells.push(tm ? unescapeXml(tm[1]) : '')
        } else cells.push(v)
      }
      if (cells.some((x) => String(x).trim() !== '')) lines.push(cells.join('\t'))
    }
    const maxCols = lines.reduce((m, l) => Math.max(m, l.split('\t').length), 0)
    out.push('[工作表 ' + (idx + 1) + ']（' + lines.length + ' 行，' + maxCols + ' 列；第一行通常是表头）')
    out.push(lines.join('\n'))
  })
  return { ok: true, text: out.join('\n') }
}

/** 读 zip 里的**全部**条目（xlsx 要先知道有哪些 sheet，没法预先列名） */
function zipReadAll (buf) {
  try {
    const eocd = findEocd(buf)
    if (eocd < 0) return { ok: false, entries: {}, error: '不是 zip（找不到目录尾）' }
    const count = buf.readUInt16LE(eocd + 10)
    let p = buf.readUInt32LE(eocd + 16)
    const names = []
    for (let i = 0; i < count; i++) {
      if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CEN) break
      const nameLen = buf.readUInt16LE(p + 28)
      const extraLen = buf.readUInt16LE(p + 30)
      const cmtLen = buf.readUInt16LE(p + 32)
      names.push(buf.slice(p + 46, p + 46 + nameLen).toString('utf8'))
      p = p + 46 + nameLen + extraLen + cmtLen
    }
    const keep = names.filter((n) => /^xl\/(sharedStrings|workbook)\.xml$/.test(n) || /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    return zipRead(buf, keep)
  } catch (e) {
    return { ok: false, entries: {}, error: '解压失败：' + String((e && e.message) || e) }
  }
}

// ---------- PDF 文字抽取（2026-10-21 新增；零依赖，用户 m02562「常见类型文件」） ----------
// 目的：合同/报价单/甲方来函大多是 PDF。这里只做「把能抽的文字抽出来」：
//   遍历 stream（FlateDecode 就地 inflate）→ 收集 ToUnicode CMap（bfchar/bfrange）→ 扫内容流里的
//   Tj/TJ/'/" 文本操作符 → 按 CMap 回 Unicode。抽不到就明说「多半是扫描件，请截图走图片通道」，
//   绝不假装读到了。
function pdfStreams (buf) {
  const out = []
  const s = buf.toString('latin1')
  let p = 0
  for (;;) {
    const i = s.indexOf('stream', p)
    if (i < 0) break
    if (s.slice(Math.max(0, i - 3), i) === 'end') { p = i + 6; continue }
    let start = i + 6
    if (s[start] === '\r') start++
    if (s[start] === '\n') start++
    const j = s.indexOf('endstream', start)
    if (j < 0) break
    let end = j
    if (s[end - 1] === '\n') end--
    if (s[end - 1] === '\r') end--
    const raw = buf.slice(start, Math.max(start, end))
    let inflated = null
    try { inflated = zlib.inflateSync(raw) } catch (e) { try { inflated = zlib.inflateRawSync(raw) } catch (e2) { inflated = null } }
    out.push({ raw, inflated })
    p = j + 9
  }
  return out
}

function pdfHexToUnicode (hex) {
  let s = ''
  const h = String(hex || '').replace(/[^0-9A-Fa-f]/g, '')
  for (let i = 0; i + 3 < h.length + 1; i += 4) {
    const code = parseInt(h.slice(i, i + 4), 16)
    if (!Number.isFinite(code)) break
    s += String.fromCharCode(code)
  }
  return s
}

function pdfPadCode (n, width) {
  let h = Number(n).toString(16).toUpperCase()
  while (h.length < width) h = '0' + h
  return h
}

/** 单个 CMap 文本（beginbfchar/beginbfrange）→ { map, widths } */
function pdfParseCmapText (t) {
  const map = new Map()
  const widths = new Set()
  let m
  const bc = /beginbfchar([\s\S]*?)endbfchar/g
  while ((m = bc.exec(t))) {
    const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g
    let x
    while ((x = re.exec(m[1]))) {
      map.set(x[1].toLowerCase(), pdfHexToUnicode(x[2]))
      widths.add(x[1].length)
    }
  }
  const br = /beginbfrange([\s\S]*?)endbfrange/g
  while ((m = br.exec(t))) {
    const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([\s\S]*?)\])/g
    let x
    while ((x = re.exec(m[1]))) {
      const lo = parseInt(x[1], 16)
      const hi = parseInt(x[2], 16)
      widths.add(x[1].length)
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) continue
      if (x[3] !== undefined) {
        const base = parseInt(x[3], 16)
        for (let c = lo; c <= hi && c - lo < 65536; c++) {
          map.set(pdfPadCode(c, x[1].length).toLowerCase(), String.fromCharCode(base + (c - lo)))
        }
      } else {
        const items = String(x[4] || '').match(/<([0-9A-Fa-f]+)>/g) || []
        items.forEach((it, ix) => {
          const hx = it.replace(/[<>]/g, '')
          if (lo + ix <= hi) map.set(pdfPadCode(lo + ix, x[1].length).toLowerCase(), pdfHexToUnicode(hx))
        })
      }
    }
  }
  return { map, widths: Array.from(widths) }
}

/** 收集整份 PDF 里的 ToUnicode 映射（全局兜底用）：{ map, widths } */
function pdfToUnicode (texts) {
  const all = new Map()
  const widths = new Set()
  for (const t of texts) {
    const cm = pdfParseCmapText(t)
    for (const [k, v] of cm.map) all.set(k, v)
    for (const w of cm.widths) widths.add(w)
  }
  return { map: all, widths: Array.from(widths) }
}

// ---------- 按字体分 CMap（2026-10-21 修：中文与数字常在不同字体里，code 会撞车） ----------
// 例：LibreOffice 导出「人民币 25 万元」——中文走 F1(NotoSerifSC/Identity-H)，数字 25 走 F2(Calibri)，
//   两个 ToUnicode 里 <01> 各指不同字。全局合并会把「25」解成别的（或解成空），
//   所以必须按 /F1 /F2 分别取映射。
function pdfObjectIndex (buf) {
  const s = buf.toString('latin1')
  const objs = new Map()   // objNum -> {head, streamAt (offset in s)}
  const re = /(\d+)\s+0\s+obj\b/g
  let m
  while ((m = re.exec(s))) {
    const num = Number(m[1])
    objs.set(num, { head: m.index + m[0].length })
  }
  return { s, objs }
}

function pdfStreamBytesAt (s, buf, from) {
  const i = s.indexOf('stream', from)
  if (i < 0) return null
  const endobj = s.indexOf('endobj', from)
  if (endobj >= 0 && endobj < i) return null
  let start = i + 6
  if (s[start] === '\r') start++
  if (s[start] === '\n') start++
  const j = s.indexOf('endstream', start)
  if (j < 0) return null
  let end = j
  if (s[end - 1] === '\n') end--
  if (s[end - 1] === '\r') end--
  const raw = buf.slice(start, Math.max(start, end))
  try { return zlib.inflateSync(raw) } catch (e) { try { return zlib.inflateRawSync(raw) } catch (e2) { return raw } }
}

/** /Font << /F1 9 0 R /F2 18 0 R >> 或 /Font 15 0 R（间接）→ { F1:{map,widths}, F2:{...} } */
function pdfFontMaps (buf, globalCm) {
  const { s, objs } = pdfObjectIndex(buf)
  const dictText = (from) => {
    let p = from
    for (let guard = 0; guard < 6; guard++) {
      const i = s.indexOf('<<', p)
      if (i < 0) return ''
      // 配平 << >>（Font 字典里不会嵌套太深）
      let depth = 0
      let j = i
      for (; j < s.length - 1; j++) {
        if (s[j] === '<' && s[j + 1] === '<') { depth++; j++; continue }
        if (s[j] === '>' && s[j + 1] === '>') { depth--; j++; if (depth === 0) break; continue }
      }
      return s.slice(i, j + 1)
    }
    return ''
  }
  const nameToObj = new Map()
  const fr = /\/Font\s*(?:<<|(\d+)\s+0\s+R)/g
  let m
  while ((m = fr.exec(s))) {
    let body = ''
    if (m[1] !== undefined) {
      const h = objs.get(Number(m[1]))
      if (!h) continue
      const endobj = s.indexOf('endobj', h.head)
      body = s.slice(h.head, endobj < 0 ? h.head + 4000 : endobj)
    } else {
      body = dictText(m.index + m[0].length - 2)
    }
    const pair = /\/([A-Za-z0-9_.+-]+)\s+(\d+)\s+0\s+R/g
    let x
    while ((x = pair.exec(body))) {
      if (x[1] === 'Font' || x[1] === 'ProcSet' || x[1] === 'Resources') continue
      nameToObj.set(x[1], Number(x[2]))
    }
  }
  const out = {}
  for (const [fontName, objNum] of nameToObj) {
    const head = objs.get(objNum)
    if (!head) continue
    const endobj = s.indexOf('endobj', head.head)
    const headText = s.slice(head.head, endobj < 0 ? head.head + 3000 : endobj)
    if (!/\/Type\s*\/Font/.test(headText)) continue
    const tu = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(headText)
    if (!tu) continue
    const cmHead = objs.get(Number(tu[1]))
    if (!cmHead) continue
    const bytes = pdfStreamBytesAt(s, buf, cmHead.head)
    if (!bytes) continue
    const cm = pdfParseCmapText(bytes.toString('latin1'))
    if (cm.map.size) out[fontName] = cm
  }
  return out
}


function pdfLiteral (src, i) {
  // src[i] === '(' → 读到配对的 ')'，处理转义与嵌套括号（开头的 '(' 不算正文）
  let depth = 0
  const bytes = []
  let p = i + 1
  for (; p < src.length; p++) {
    const c = src[p]
    if (c === '\\') {
      const n = src[p + 1]
      p++
      if (n === 'n') bytes.push(10)
      else if (n === 'r') bytes.push(13)
      else if (n === 't') bytes.push(9)
      else if (n === 'b') bytes.push(8)
      else if (n === 'f') bytes.push(12)
      else if (n === '\n') { /* 续行 */ }
      else if (n === '\r') { if (src[p + 1] === '\n') p++ }
      else if (n >= '0' && n <= '7') {
        let oct = n
        for (let k = 0; k < 2 && src[p + 1] >= '0' && src[p + 1] <= '7'; k++) { p++; oct += src[p] }
        bytes.push(parseInt(oct, 8) & 0xff)
      } else bytes.push(src.charCodeAt(p) & 0xff)
      continue
    }
    if (c === '(') { depth++; bytes.push(0x28); continue }
    if (c === ')') { if (depth === 0) { p++; break } depth--; bytes.push(0x29); continue }
    bytes.push(c.charCodeAt(0) & 0xff)
  }
  return { bytes: Buffer.from(bytes), next: p }
}

function pdfDecodeBytes (bytes, cm) {
  if (!bytes || !bytes.length) return ''
  const map = cm && cm.map
  if (map && map.size) {
    const two = cm.widths.some((w) => w >= 4)
    const one = cm.widths.some((w) => w <= 2)
    let s = ''
    if (two) {
      for (let i = 0; i + 1 < bytes.length; i += 2) {
        const key = pdfPadCode((bytes[i] << 8) | bytes[i + 1], 4).toLowerCase()
        s += map.has(key) ? map.get(key) : ''
      }
      if (s) return s
    }
    if (one) {
      for (let i = 0; i < bytes.length; i++) {
        const key = pdfPadCode(bytes[i], 2).toLowerCase()
        s += map.has(key) ? map.get(key) : ''
      }
      if (s) return s
    }
  }
  // 没 CMap：先试 UTF-16BE（带 BOM 或无 BOM 但偶数长度且高字节为 0 的常见中文），再退 UTF-8/Latin-1
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const b = bytes.slice(2); const swapped = Buffer.alloc(b.length - (b.length % 2))
    for (let i = 0; i + 1 < b.length; i += 2) { swapped[i] = b[i + 1]; swapped[i + 1] = b[i] }
    return swapped.toString('utf16le')
  }
  const utf8 = bytes.toString('utf8')
  if (!/\uFFFD/.test(utf8)) return utf8
  return bytes.toString('latin1')
}

function pdfCollectItems (src, cm, items, fontMaps) {
  // 按「位置」收集文本片段（跨内容流共用同一份 items），最后统一重排拼行。
  //   为什么必须重排：PDF 内容流里文本片段的出现顺序 ≠ 阅读顺序（LibreOffice/Word 导出常见
  //   「先写后面那段、再回头写数字」，而且 CJK 与数字常分在不同内容流里）。
  let i = 0
  let pending = []
  let curX = 0
  let curY = 0
  let curCm = cm
  const flush = () => {
    let s = ''
    for (const p of pending) {
      if (p.num !== undefined) { if (p.num < -120) s += ' '; continue }
      if (p.name !== undefined) continue
      s += pdfDecodeBytes(p.bytes, curCm)
    }
    pending = []
    if (s) items.push({ x: curX, y: curY, text: s })
    return s
  }
  const numsOf = () => pending.filter((p) => p.num !== undefined).map((p) => p.num)
  const lastName = () => {
    for (let k = pending.length - 1; k >= 0; k--) if (pending[k].name !== undefined) return pending[k].name
    return ''
  }
  while (i < src.length) {
    const c = src[i]
    if (c === '/') {
      const m = /^\/([A-Za-z0-9_.+-]+)/.exec(src.slice(i, i + 64))
      if (m) { pending.push({ name: m[1] }); i += m[0].length; continue }
      i++
      continue
    }
    if (c === '(') {
      const r = pdfLiteral(src, i)
      pending.push({ bytes: r.bytes })
      i = r.next
      continue
    }
    if (c === '<' && src[i + 1] !== '<') {
      const j = src.indexOf('>', i)
      if (j < 0) break
      const hex = src.slice(i + 1, j).replace(/[^0-9A-Fa-f]/g, '')
      const bytes = Buffer.alloc(Math.floor(hex.length / 2))
      for (let k = 0; k + 1 < hex.length; k += 2) bytes[k / 2] = parseInt(hex.slice(k, k + 2), 16)
      pending.push({ bytes })
      i = j + 1
      continue
    }
    if ((c >= '0' && c <= '9') || c === '-' || c === '.') {
      const m = /^-?\d+(?:\.\d+)?/.exec(src.slice(i, i + 24))
      if (m) { pending.push({ num: Number(m[0]) }); i += m[0].length; continue }
      i++
      continue
    }
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === "'" || c === '"' || c === '*') {
      const m = /^[A-Za-z'"*]+/.exec(src.slice(i, i + 8))
      const op = m ? m[0] : c
      i += op.length
      if (op === 'Tf') {
        // 切字体：中文与数字可能各用一套 CMap（code 会撞车），必须跟着字体换映射
        const nm = lastName()
        curCm = (fontMaps && nm && fontMaps[nm]) ? fontMaps[nm] : cm
        pending = []
      } else if (op === 'Tj' || op === 'TJ') {
        flush()
      } else if (op === "'" || op === '"') {
        flush(); curY -= 14
      } else if (op === 'Tm') {
        const ns = numsOf()
        if (ns.length >= 6) { curX = ns[4]; curY = ns[5] } else curY -= 14
        pending = []
      } else if (op === 'Td' || op === 'TD') {
        const ns = numsOf()
        if (ns.length >= 2) { curX += ns[0]; curY += ns[1] } else curY -= 14
        pending = []
      } else if (op === 'T*') {
        curY -= 14
        pending = []
      } else if (op === 'BT') {
        curX = 0; curY = 0
        pending = []
      }
      continue
    }
    i++
  }
  flush()
}

function pdfLayout (items) {
  if (!items.length) return ''
  // 同一行判定：y 差 ≤ 2（PDF 单位）；一行内按 x 升序，段间按需补空格
  const rows = []
  for (const it of items) {
    const row = rows.find((r) => Math.abs(r.y - it.y) <= 2)
    if (row) row.parts.push(it); else rows.push({ y: it.y, parts: [it] })
  }
  rows.sort((a, b) => b.y - a.y)
  const lines = []
  for (const row of rows) {
    row.parts.sort((a, b) => a.x - b.x)
    let line = ''
    for (const p of row.parts) {
      if (line && p.x > 0 && !/[\s]$/.test(line) && !/^[\s，。、；：）】]/.test(p.text)) line += ' '
      line += p.text
    }
    lines.push(line.replace(/\s+$/, ''))
  }
  return lines.join('\n')
}

/** 这看起来像不像「页面内容流」（避免把字体/图片等二进制流当文本解析，抽出一堆 NUL） */
function pdfLooksLikeContent (t) {
  if (!t || t.length < 8) return false
  if (!/(^|[\s>\])}\)])BT[\s]/.test(t)) return false
  if (!/(\bTj\b|\bTJ\b)/.test(t)) return false
  let bad = 0
  const n = Math.min(t.length, 20000)
  for (let i = 0; i < n; i++) {
    const c = t.charCodeAt(i)
    if (c === 0 || (c < 9 && c !== 32) || (c > 13 && c < 32)) bad++
  }
  return bad / n < 0.05
}

/** PDF → 文本。返回 {ok, text, error, note} */
function pdfText (buf) {
  try {
    if (!buf || !buf.length) return { ok: false, text: '', error: 'PDF 是空的' }
    const sig = buf.slice(0, 1024).toString('latin1')
    if (sig.indexOf('%PDF') === -1) return { ok: false, text: '', error: '这不是 PDF 文件（缺 %PDF 头）' }
    const streams = pdfStreams(buf)
    if (!streams.length) return { ok: false, text: '', error: 'PDF 里没找到可读的数据流' }
    const texts = streams.map((s) => (s.inflated ? s.inflated.toString('latin1') : s.raw.toString('latin1')))
    const cm = pdfToUnicode(texts)
    const fontMaps = pdfFontMaps(buf, cm)
    const items = []
    for (const t of texts) {
      if (!pdfLooksLikeContent(t)) continue
      pdfCollectItems(t, cm, items, fontMaps)
    }
    // 跨内容流统一排版（CJK 与数字常分在不同流里，必须一起按坐标重排）
    const text = pdfLayout(items)
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim()
    if (!text) {
      return { ok: false, text: '', error: '这份 PDF 里没抽到文字（多半是扫描件/纯图片 PDF）。可以把页面截图，用「📎 图片」发我，我按图看。' }
    }
    const note = text.length < 40 ? '这份 PDF 只抽到很少的字，可能是扫描件或加密文档；不够的话请截图发我。' : ''
    return { ok: true, text, note }
  } catch (e) {
    return { ok: false, text: '', error: 'PDF 解析失败：' + String((e && e.message) || e) }
  }
}

/** 单个文件 → 文本。返回 {ok, text, error} */
function textOfFile (name, mediaType, bytes) {
  const kind = kindOf(name, mediaType)
  if (kind === 'text') {
    const t = bytes.toString('utf8')
    return { ok: true, text: t, kind }
  }
  if (kind === 'docx') {
    const r = docxText(bytes)
    return { ok: r.ok, text: r.text || '', error: r.error, kind }
  }
  if (kind === 'xlsx') {
    const r = xlsxText(bytes)
    return { ok: r.ok, text: r.text || '', error: r.error, kind }
  }
  if (kind === 'pdf') {
    const r = pdfText(bytes)
    return { ok: r.ok, text: r.text || '', error: r.error, note: r.note, kind }
  }
  return { ok: false, text: '', error: '这类文件读不了（支持：' + TEXT_EXT.concat(OFFICE_EXT, PDF_EXT).join('/') + '，图片走图片通道）', kind }
}

function clipText (s, max) {
  const t = String(s == null ? '' : s)
  if (t.length <= max) return { text: t, clipped: false }
  // 2026-10-21（m02957）：截断不能只留头——表格的合计/尾部往往也在末尾。
  //   改成「头 70% + 尾 30%」，中间明确标出省了多少字，模型才知道自己看到的是不完整的。
  const head = Math.max(0, Math.floor(max * 0.7))
  const tail = Math.max(0, max - head)
  const omitted = t.length - head - tail
  return {
    text: t.slice(0, head) + '\n…（中间省略 ' + omitted + ' 字，原表共 ' + t.length + ' 字；这里给的是开头 ' + head + ' 字 + 结尾 ' + tail + ' 字）…\n' + t.slice(t.length - tail),
    clipped: true,
  }
}

/**
 * 把一次请求里的上传变成「消息内容块 + 提示词里的文件段」。
 * @param {object} o
 * @param {object} o.ctx 插件上下文（用来取 ctx.attachments）
 * @param {Array}  o.images [{name, mediaType, b64}]
 * @param {Array}  o.files  [{name, mediaType, b64}]
 * @returns {Promise<{ok:boolean, blocks:Array, fileSections:Array<{name:string,text:string}>, notes:Array<string>, errors:Array<string>, imageCount:number, fileNames:Array<string>}>}
 */
async function buildUploads (o) {
  const opt = o || {}
  const notes = []
  const errors = []
  const blocks = []
  const fileSections = []
  const fileNames = []
  let imageCount = 0
  let textBudget = CAPS.maxTextChars

  const images = Array.isArray(opt.images) ? opt.images.slice(0, CAPS.maxImages) : []
  if (Array.isArray(opt.images) && opt.images.length > images.length) notes.push('图片最多 ' + CAPS.maxImages + ' 张，多出来的没发')
  const decoded = []
  let totalBytes = 0
  for (const it of images) {
    const name = String((it && it.name) || '图片')
    const mt = String((it && it.mediaType) || '').toLowerCase()
    if (IMAGE_TYPES.indexOf(mt) === -1) { errors.push(name + '：图片格式只收 png/jpg/webp/gif'); continue }
    const buf = decodeB64(it && it.b64)
    if (!buf || !buf.length) { errors.push(name + '：读不出字节（base64 坏了）'); continue }
    if (buf.length > CAPS.maxImageBytes) { errors.push(name + '：单张超过 ' + Math.round(CAPS.maxImageBytes / 1024 / 1024) + 'MB'); continue }
    totalBytes += buf.length
    if (totalBytes > CAPS.maxTotalImageBytes) { errors.push('图片总量超过 ' + Math.round(CAPS.maxTotalImageBytes / 1024 / 1024) + 'MB，后面的没发'); break }
    decoded.push({ name, mediaType: mt, data: buf })
  }
  if (decoded.length) {
    // attachCtx = 宿主 ctx.inject(['attachments']) 起的子上下文（插件 fiber 里直接 ctx.get 拿不到）
    const svc = attachmentsOf(opt.attachCtx || opt.ctx)
    if (!svc || typeof svc.saveImages !== 'function') {
      errors.push('图片没能送进模型：宿主没给附件服务（ctx.attachments）。文字照常可以发。')
    } else {
      try {
        const refs = await svc.saveImages(decoded.map((x) => ({ data: new Uint8Array(x.data), mediaType: x.mediaType })))
        for (const ref of refs) blocks.push({ type: 'image', attachment: ref })
        imageCount = refs.length
      } catch (e) {
        errors.push('图片存附件失败：' + String((e && e.message) || e))
      }
    }
  }

  const files = Array.isArray(opt.files) ? opt.files.slice(0, CAPS.maxFiles) : []
  if (Array.isArray(opt.files) && opt.files.length > files.length) notes.push('文件最多 ' + CAPS.maxFiles + ' 个，多出来的没发')
  for (const it of files) {
    const name = String((it && it.name) || '文件')
    const mt = String((it && it.mediaType) || '').toLowerCase()
    const buf = decodeB64(it && it.b64)
    if (!buf || !buf.length) { errors.push(name + '：读不出字节（base64 坏了）'); continue }
    if (buf.length > CAPS.maxFileBytes) { errors.push(name + '：超过 ' + Math.round(CAPS.maxFileBytes / 1024 / 1024) + 'MB'); continue }
    const r = textOfFile(name, mt, buf)
    if (!r.ok) { errors.push(name + '：' + (r.error || '读不了')); continue }
    const body = String(r.text || '').replace(/\u0000/g, '').trim()
    if (!body) { errors.push(name + '：里面没抽到文字'); continue }
    const cl = clipText(body, Math.max(0, textBudget))
    textBudget -= cl.text.length
    fileSections.push({ name: name, text: cl.text })
    fileNames.push(name)
    if (r.note) notes.push(name + '：' + r.note)
    if (cl.clipped) notes.push(name + '：太长，只取了前面 ' + cl.text.length + ' 字')
    if (textBudget <= 0) { notes.push('文件文本总量到上限了，后面的没拼进去'); break }
  }

  return { ok: errors.length === 0, blocks: blocks, fileSections: fileSections, notes: notes, errors: errors, imageCount: imageCount, fileNames: fileNames }
}

function attachmentsOf (ctx) {
  if (!ctx) return null
  // 直接就是一个服务实例（index.js 的 attachmentsCtx() 现在可能直接返回服务）：认它的方法名
  try {
    if (typeof ctx.saveImages === 'function' || typeof ctx.admitEncodedImages === 'function') return ctx
  } catch (e) { /* 忽略 */ }
  try {
    if (ctx.attachments) return ctx.attachments
    if (typeof ctx.get === 'function') return ctx.get('attachments') || null
  } catch (e) { /* 忽略 */ }
  return null
}

/** 文件段拼成提示词里的一段文字（空文件返回 ''） */
function fileSectionsToText (sections) {
  const list = Array.isArray(sections) ? sections : []
  if (!list.length) return ''
  return list.map((s) => '【上传文件：' + s.name + '】\n' + s.text).join('\n\n')
}

module.exports = {
  CAPS, IMAGE_TYPES, TEXT_EXT, OFFICE_EXT, PDF_EXT,
  extOf, kindOf, decodeB64, zipRead, zipReadAll, docxText, xlsxText, pdfText,
  textOfFile, buildUploads, fileSectionsToText,
}
