// 合同 .docx 生成层（W2 生成层）
// ============================================================================
// 定位：把「合同模板 + 字段数据」渲染成最小 OOXML 包（5 部件），零新增依赖。
//
// 铁律（与本插件其它模块一致）：
//   ① 只写本地文件，零出网 API；不 import './ai.js'（生成层不碰模型）。
//   ② zip 能力只用 fflate —— 候选路径解析顺序照抄 dsh-feasi/dsh/ooxml.js:22-47，
//      但**代码是本文件自带副本**，不跨包 import dsh-feasi。
//   ③ jszip / mammoth / pdf-parse 在本机已被 pnpm 修剪，禁止使用。
//   ④ 任何异常一律返回 {ok:false,error}，绝不抛：生成失败不能带崩宿主路由。
//
// 冻结接口（W3 调用方按此对接，不得改名）：
//   zipAvailable()                                  → boolean
//   listTemplates()                                 → [{key,名称,必填[]}]
//   buildContractDocx({templateKey,data,meta})      → {ok:true,buffer,部件[]} | {ok:false,error}
//   renderTemplateText({templateKey,data,meta?})    → {ok:true,text} | {ok:false,error}（纯文本，不建 zip）
//   saveContractDocx({dir,客户ID,合同ID,类型,日期,buffer}) → {ok:true,名,路径,字节,sha256} | {ok:false,error}
//   TEMPLATES                                       → 模板常量（数组 + 具名属性双取用，见下）
// ============================================================================
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
// 插件根目录（<repo>/）：开源版把 fflate 声明成本包依赖，装到 <repo>/node_modules/fflate
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/* ======================== fflate 定位（照抄 feasi 解析顺序） ======================== */
// fflate 的候选位置：**按当前 profile 现算**（不写死 profile 名），再用 DSH 安装目录兜底，最后裸 require。
function fflateCandidates() {
  const home = process.env.DSH_HOME || (process.env.USERPROFILE || process.env.HOME
    ? path.join(process.env.USERPROFILE || process.env.HOME, '.dsh') : '')
  const out = []
  // ① 本包自带依赖（package.json 的 dependencies 里有 fflate）：开源版最优先走这条
  out.push(path.join(PLUGIN_ROOT, 'node_modules', 'fflate'))
  if (process.env.DSH_PROFILE_DIR) out.push(path.join(process.env.DSH_PROFILE_DIR, 'node_modules', 'fflate'))
  if (home) {
    out.push(path.join(home, 'profiles', 'node_modules', 'fflate')) // profiles 共享层
    out.push(path.join(home, 'profiles', 'web', 'node_modules', 'fflate')) // 旧网页端（兼容）
    out.push(path.join(home, 'profiles', 'desktop', 'node_modules', 'fflate')) // 桌面端（兼容）
  }
  out.push(path.join(path.dirname(process.execPath), 'node_modules', 'fflate')) // DSH 安装目录兜底
  return out
}

let _fflate // undefined=未探测, null=不可用
function getFFlate() {
  if (_fflate !== undefined) {
    if (!_fflate) throw new Error('fflate 不可用')
    return _fflate
  }
  let lastErr = null
  for (const c of fflateCandidates()) {
    try { const m = require(c); if (m && typeof m.zipSync === 'function') { _fflate = m; return m } } catch (e) { lastErr = e }
  }
  try { const m = require('fflate'); if (m && typeof m.zipSync === 'function') { _fflate = m; return m } } catch (e) { lastErr = e }
  _fflate = null
  throw new Error('fflate 不可用: ' + ((lastErr && lastErr.message) || 'unknown'))
}

// 能力探测：写侧优先用 fflate（压缩），拿不到就走内置零依赖 STORE 实现 → 恒为 true
export function zipAvailable() { return true }

/* ============================== 模板加载 ============================== */
// 模板放插件内 dsh/contract-templates/*.json：只含占位符，无任何真实客户姓名/手机号。
const TEMPLATE_FILES = ['standard.json', 'enterprise.json', 'nda.json']
const TEMPLATE_DIR = new URL('./contract-templates/', import.meta.url)

function loadTemplates() {
  const out = []
  for (const f of TEMPLATE_FILES) {
    try {
      const t = JSON.parse(readFileSync(new URL(f, TEMPLATE_DIR), 'utf8'))
      if (t && t.key && Array.isArray(t.blocks)) out.push(t)
    } catch (e) { /* 单个模板坏掉不影响其余模板可用 */ }
  }
  return out
}

// 常量：既是数组（TEMPLATES.map / find / [0]），也支持按 key 直取（TEMPLATES.standard）
// —— 具名属性设成不可枚举，避免污染 map/JSON 输出。
export const TEMPLATES = loadTemplates()
for (const t of TEMPLATES) {
  try { Object.defineProperty(TEMPLATES, t.key, { value: t, enumerable: false, configurable: true }) } catch (e) { /* noop */ }
}

function getTemplate(key) {
  const k = String(key == null ? '' : key).trim()
  if (!k) return null
  return TEMPLATES.find((t) => t.key === k) || null
}

export function listTemplates() {
  return TEMPLATES.map((t) => ({ key: t.key, 名称: t.名称 || t.key, 必填: [...(t.必填 || [])] }))
}

/* ============================== 小工具 ============================== */
const enc = (s) => new TextEncoder().encode(String(s))

function toU8(b) {
  if (b instanceof Uint8Array) return b
  if (Buffer.isBuffer(b)) return new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
  return new Uint8Array(b)
}

/* ====================== 零依赖 ZIP 写入（STORE，兜底） ======================
 * 为什么要有它：.docx 本质是一个 zip 包。宿主环境里通常有 fflate（DSH 自带），
 *   但本插件要能在任何 Node >= 20 下独立跑通（用户可能没装宿主、也可能依赖被裁剪）。
 *   docx 规范允许条目用「存储（method 0，不压缩）」，Word/WPS/LibreOffice 都能正常打开，
 *   所以我们自己拼一个最小 ZIP：局部文件头 + 中央目录 + EOCD，CRC32 自己算。
 *   有 fflate 时仍优先用它（压缩后体积小），没有就自动走这里，**不报错、不需要安装任何东西**。
 */
function crc32(u8) {
  let crc = 0xFFFFFFFF
  for (let i = 0; i < u8.length; i++) {
    crc ^= u8[i]
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1))
  }
  return (crc ^ 0xFFFFFFFF) >>> 0
}

// 固定时间戳（2026-01-01 00:00:00）：同样内容生成同样字节，便于比对/复现
const ZIP_DOS_TIME = 0
const ZIP_DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1

function makeZipStore(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const name of Object.keys(entries)) {
    const data = toU8(entries[name])
    const nameBuf = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)   // 局部文件头签名
    lh.writeUInt16LE(20, 4)           // 解压所需版本
    lh.writeUInt16LE(0x0800, 6)       // 通用标志位：文件名为 UTF-8
    lh.writeUInt16LE(0, 8)            // 压缩方法：0 = 存储
    lh.writeUInt16LE(ZIP_DOS_TIME, 10)
    lh.writeUInt16LE(ZIP_DOS_DATE, 12)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(data.length, 18) // 压缩后大小
    lh.writeUInt32LE(data.length, 22) // 原始大小
    lh.writeUInt16LE(nameBuf.length, 26)
    lh.writeUInt16LE(0, 28)           // 扩展字段长度
    locals.push(lh, nameBuf, data)

    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)   // 中央目录签名
    ch.writeUInt16LE(20, 4)           // 创建版本
    ch.writeUInt16LE(20, 6)           // 解压所需版本
    ch.writeUInt16LE(0x0800, 8)
    ch.writeUInt16LE(0, 10)
    ch.writeUInt16LE(ZIP_DOS_TIME, 12)
    ch.writeUInt16LE(ZIP_DOS_DATE, 14)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(data.length, 20)
    ch.writeUInt32LE(data.length, 24)
    ch.writeUInt16LE(nameBuf.length, 28)
    ch.writeUInt16LE(0, 30)           // 扩展字段
    ch.writeUInt16LE(0, 32)           // 注释
    ch.writeUInt16LE(0, 34)           // 起始磁盘号
    ch.writeUInt16LE(0, 36)           // 内部属性
    ch.writeUInt32LE(0, 38)           // 外部属性
    ch.writeUInt32LE(offset, 42)      // 局部头偏移
    centrals.push(ch, nameBuf)

    offset += lh.length + nameBuf.length + data.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)   // EOCD 签名
  eocd.writeUInt16LE(0, 4)            // 当前磁盘号
  eocd.writeUInt16LE(0, 6)            // 中央目录起始磁盘号
  eocd.writeUInt16LE(centrals.length / 2, 8)  // 本盘条目数
  eocd.writeUInt16LE(centrals.length / 2, 10) // 总条目数
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)           // 注释长度
  return Buffer.concat([...locals, cd, eocd])
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// 空值判定：null/undefined/空串/纯下划线/【…】/未替换的 {{…}} 都算没填
function isBlank(v) {
  if (v === null || v === undefined) return true
  if (Array.isArray(v)) return v.length === 0
  if (typeof v === 'string') {
    const s = v.trim()
    return s === '' || /^\{\{[^}]*\}\}$/.test(s) || /^【[^】]*】$/.test(s) || /^[＿_\-—]{2,}$/.test(s)
  }
  return false
}

function fmt(v) {
  if (Array.isArray(v)) {
    return v.map((x) => (x && typeof x === 'object' ? Object.values(x).join(' ') : String(x))).join('；')
  }
  if (v && typeof v === 'object') return Object.values(v).join(' ')
  return String(v)
}

// {{字段}} 与 {{字段|默认值}}；缺失且无默认值时**保留原占位符**，让人一眼看到还没填
const PH = /\{\{\s*([^{}]+?)\s*\}\}/g
function fill(text, ctx) {
  return String(text == null ? '' : text).replace(PH, (m, inner) => {
    const parts = String(inner).split('|')
    const key = parts[0].trim()
    const def = parts.slice(1).join('|').trim()
    const v = ctx ? ctx[key] : undefined
    if (!isBlank(v)) return fmt(v)
    return def !== '' ? def : m
  })
}

// 条件块：when:"行业=设计院" / "行业!=平台公司" / "服务范围含私有化"
// 判据缺失时**一律保留**（合规段落宁可多留不可漏），所以没有行业也照出。
function whenOk(when, ctx) {
  if (!when) return true
  const m = String(when).match(/^\s*([^=!]+?)\s*(!=|=|含)\s*(.+?)\s*$/)
  if (!m) return true
  const key = m[1].trim()
  const op = m[2]
  const val = m[3]
  const cur = ctx ? ctx[key] : undefined
  if (isBlank(cur)) return true
  const s = fmt(cur)
  if (op === '=') return s === val
  if (op === '!=') return s !== val
  return s.indexOf(val) >= 0
}

/* ============================== OOXML 渲染 ============================== */
function para(text, style) {
  const ppr = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''
  return `<w:p>${ppr}<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`
}

function cell(text, bold) {
  const rpr = bold ? '<w:rPr><w:b/></w:rPr>' : ''
  return `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr><w:p><w:r>${rpr}<w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p></w:tc>`
}

const TBL_BORDERS = '<w:tblBorders>'
  + '<w:top w:val="single" w:sz="4" w:space="0" w:color="808080"/>'
  + '<w:left w:val="single" w:sz="4" w:space="0" w:color="808080"/>'
  + '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="808080"/>'
  + '<w:right w:val="single" w:sz="4" w:space="0" w:color="808080"/>'
  + '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="808080"/>'
  + '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="808080"/>'
  + '</w:tblBorders>'

function tableXml(block, ctx) {
  const header = Array.isArray(block.header) ? block.header.map((h) => fill(h, ctx)) : []
  if (!header.length) return ''
  const src = block.rowsFrom ? ctx[block.rowsFrom] : block.rows
  let rows = []
  if (Array.isArray(src)) {
    rows = src.map((item) => {
      if (Array.isArray(item)) return header.map((_, i) => fill(item[i], ctx))
      if (item && typeof item === 'object') return header.map((h) => fill(item[h], ctx))
      return [fill(item, ctx)]
    })
  }
  const blankCount = Number.isFinite(block.空行) ? Math.max(0, Math.trunc(block.空行)) : 0
  while (rows.length < blankCount) rows.push(header.map(() => ''))
  const head = `<w:tr><w:trPr><w:tblHeader/></w:trPr>${header.map((h) => cell(h, true)).join('')}</w:tr>`
  const body = rows.map((r) => `<w:tr>${header.map((_, i) => cell(r[i], false)).join('')}</w:tr>`).join('')
  return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/>${TBL_BORDERS}<w:tblLayout w:type="autofit"/></w:tblPr>${head}${body}</w:tbl><w:p/>`
}

// 表格取行逻辑（纯文本渲染用）：与 tableXml 同规则，但**不动已验证的 XML 打包路径**，故独立一份。
function tableTextLines(block, ctx) {
  const header = Array.isArray(block.header) ? block.header.map((h) => fill(h, ctx)) : []
  if (!header.length) return []
  const src = block.rowsFrom ? ctx[block.rowsFrom] : block.rows
  let rows = []
  if (Array.isArray(src)) {
    rows = src.map((item) => {
      if (Array.isArray(item)) return header.map((_, i) => fill(item[i], ctx))
      if (item && typeof item === 'object') return header.map((h) => fill(item[h], ctx))
      return [fill(item, ctx)]
    })
  }
  const blankCount = Number.isFinite(block.空行) ? Math.max(0, Math.trunc(block.空行)) : 0
  while (rows.length < blankCount) rows.push(header.map(() => ''))
  const out = [header.join('｜')]
  for (const r of rows) out.push(header.map((_, i) => String(r[i] == null ? '' : r[i])).join('｜'))
  return out
}

// 签署栏固定三行：docx 与纯文本渲染共用同一份文案，避免两处漂移
const SIGN_LINES = [
  '甲方（盖章）：＿＿＿＿＿＿＿＿＿＿　　乙方（盖章）：＿＿＿＿＿＿＿＿＿＿',
  '授权代表（签字）：＿＿＿＿＿＿＿＿　授权代表（签字）：＿＿＿＿＿＿＿＿',
  '日期：＿＿＿＿年＿＿月＿＿日　　　　日期：＿＿＿＿年＿＿月＿＿日'
]

function signXml() {
  return SIGN_LINES.map((l) => para(l, null)).join('')
}

function blocksToXml(blocks, ctx) {
  let body = ''
  for (const b of blocks || []) {
    if (!b || typeof b !== 'object') continue
    if (!whenOk(b.when, ctx)) continue
    if (b.t === 'h1') body += para(fill(b.text, ctx), 'Heading1')
    else if (b.t === 'h2') body += para(fill(b.text, ctx), 'Heading2')
    else if (b.t === 'p') body += para(fill(b.text, ctx), null)
    else if (b.t === 'table') body += tableXml(b, ctx)
    else if (b.t === 'sign') body += signXml()
  }
  return body
}

/* ============================== 固定部件 ============================== */
const PART_CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
  + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Default Extension="xml" ContentType="application/xml"/>'
  + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
  + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
  + '</Types>'

const PART_ROOT_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
  + '</Relationships>'

const PART_DOC_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
  + '</Relationships>'

const PART_STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
  + '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
  + '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:eastAsia="SimSun" w:hAnsi="Times New Roman"/>'
  + '<w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr></w:rPrDefault>'
  + '<w:pPrDefault><w:pPr><w:spacing w:line="360" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
  + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/>'
  + '<w:pPr><w:jc w:val="center"/><w:spacing w:before="240" w:after="240"/></w:pPr>'
  + '<w:rPr><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:qFormat/>'
  + '<w:pPr><w:jc w:val="center"/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr>'
  + '<w:rPr><w:b/><w:sz w:val="30"/><w:szCs w:val="30"/></w:rPr></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:qFormat/>'
  + '<w:pPr><w:spacing w:before="180" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr>'
  + '<w:rPr><w:b/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>'
  + '</w:styles>'

const SECT_PR = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
  + '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>'
  + '</w:sectPr>'

function documentXml(body) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
    + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + '<w:body>' + body + SECT_PR + '</w:body></w:document>'
}

/* ============================== 生成 ============================== */
export function buildContractDocx(opts) {
  try {
    const o = opts && typeof opts === 'object' ? opts : {}
    const t = getTemplate(o.templateKey)
    if (!t) return { ok: false, error: '未知模板：' + String(o.templateKey == null ? '' : o.templateKey) }
    const data = o.data && typeof o.data === 'object' ? o.data : {}
    const meta = o.meta && typeof o.meta === 'object' ? o.meta : {}
    const ctx = { ...meta, ...data }

    const missing = (t.必填 || []).filter((f) => isBlank(data[f]))
    if (missing.length) return { ok: false, error: '缺必填：' + missing.join('、') }

    let body = blocksToXml(t.blocks, ctx)
    if (!/w:pStyle w:val="Heading1"/.test(body)) body = para(meta.标题 || t.名称 || t.key, 'Title') + body

    const entries = {
      '[Content_Types].xml': enc(PART_CONTENT_TYPES),
      '_rels/.rels': enc(PART_ROOT_RELS),
      'word/document.xml': enc(documentXml(body)),
      'word/_rels/document.xml.rels': enc(PART_DOC_RELS),
      'word/styles.xml': enc(PART_STYLES)
    }
    let buffer
    try { buffer = toU8(getFFlate().zipSync(entries, { level: 6 })) }
    catch (e) { buffer = makeZipStore(entries) }   // 没有 fflate（或被裁剪）→ 内置 STORE 写法
    return { ok: true, buffer, 部件: Object.keys(entries), 模板: t.key, 字节: buffer.length }
  } catch (e) {
    const msg = (e && e.message) || String(e)
    return { ok: false, error: '生成失败：' + msg }
  }
}

/* ==================== 纯文本渲染（供 W3 喂 reviewContract） ==================== */
// 冻结接口：renderTemplateText({templateKey, data}) → {ok:true, text} | {ok:false, error}
// 只拼文字：**不建 zip、不碰 fflate、不写盘**。用途是把"条款级正文"交给 reviewContract，
// 否则保密期限/违约金/签署栏这类条款级项只能统一进「待人工」。
// 表的每行按「表头｜单元格｜单元格」展开；表格表头行也展开；签署栏逐行带上。meta 为可选补充。
export function renderTemplateText(opts) {
  try {
    const o = opts && typeof opts === 'object' ? opts : {}
    const t = getTemplate(o.templateKey)
    if (!t) return { ok: false, error: '未知模板：' + String(o.templateKey == null ? '' : o.templateKey) }
    const data = o.data && typeof o.data === 'object' ? o.data : {}
    const meta = o.meta && typeof o.meta === 'object' ? o.meta : {}
    const ctx = { ...meta, ...data }

    const missing = (t.必填 || []).filter((f) => isBlank(data[f]))
    if (missing.length) return { ok: false, error: '缺必填：' + missing.join('、') }

    const lines = []
    for (const b of t.blocks || []) {
      if (!b || typeof b !== 'object') continue
      if (!whenOk(b.when, ctx)) continue
      if (b.t === 'table') lines.push(...tableTextLines(b, ctx))
      else if (b.t === 'sign') lines.push(...SIGN_LINES.map((l) => fill(l, ctx)))
      else if (b.t === 'h1' || b.t === 'h2' || b.t === 'p') lines.push(fill(b.text, ctx))
    }
    const text = lines.map((l) => String(l == null ? '' : l)).filter((l) => l.trim() !== '').join('\n')
    return { ok: true, text, 模板: t.key, 行数: text === '' ? 0 : text.split('\n').length }
  } catch (e) {
    return { ok: false, error: '渲染失败：' + ((e && e.message) || String(e)) }
  }
}

/* ============================== 落盘 ============================== */
function safeName(s) {
  return String(s == null ? '' : s)
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '-')
    .replace(/\.+$/, '')
    .slice(0, 60)
}

function todayStr() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function saveContractDocx(opts) {
  try {
    const o = opts && typeof opts === 'object' ? opts : {}
    if (!o.buffer) return { ok: false, error: '缺少 buffer（请先 buildContractDocx）' }
    const u8 = toU8(o.buffer)
    if (!u8.length) return { ok: false, error: 'buffer 为空' }
    const dir = o.dir ? String(o.dir) : ''
    if (!dir) return { ok: false, error: '缺少 dir' }

    const name = [safeName(o.日期) || todayStr(), safeName(o.类型) || '合同', safeName(o.合同ID) || safeName(o.客户ID) || '未编号'].join('_') + '.docx'
    const base = path.resolve(dir)
    const full = path.join(base, name)
    if (path.dirname(full) !== base) return { ok: false, error: '文件名非法' }
    mkdirSync(base, { recursive: true })
    writeFileSync(full, u8)
    return { ok: true, 名: name, 路径: full, 字节: u8.length, sha256: createHash('sha256').update(u8).digest('hex') }
  } catch (e) {
    return { ok: false, error: '写盘失败：' + ((e && e.message) || String(e)) }
  }
}
