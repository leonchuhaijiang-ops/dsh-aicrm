// 词法 RAG（开源版 2026-11）：把 <数据目录>/营销资料库 下的语料做成词法检索，
// 给 live / clienttip 的提示词补「可引用资料」——模型引用必须落在真实语料上，结尾写「来源：《…》」。
//
// 纪律（别破坏）：
//   ① 零依赖、零出网：只用 node:fs / node:path，绝不 fetch/http/https；
//   ② 只读 营销资料库 下的 .json / .md，**永不读 Excel / 客户表**（语料是营销资料，不含客户数据）；
//   ③ 纯函数式检索：同一 query 同一语料 → 同一结果（排序稳定，便于探针断言）；
//   ④ 进程内缓存按文件 mtime 失效（插件常驻宿主进程，不用每次重扫大 JSON）。
//
// 语料目录（2026-11 开源版）：统一走 dsh/config.js 的解析结果 → <数据目录>/营销资料库。
//   目录不存在 / 被关掉（features.rag=false）都**不抛错**：语料为空，ragStatus() 里明写原因。
import fs from 'node:fs'
import path from 'node:path'
import { resolveDataDir, dataDirSource, aiPolicy } from './config.js'

// 语料目录 = <数据目录>/营销资料库。**每次现取**：设置向导改完目录，下一次检索就跟上。
export function ragDir() { return path.join(resolveDataDir(), '营销资料库') }
export const RAG_LIMITS = {
  limit: 3,            // 默认返回几条资料
  chunks: 400,         // 语料块总量上限（防语料目录被塞爆）
  snippetChars: 300,   // 每条资料进提示词的字数上限
  textChars: 2000,     // 单个 chunk 参与检索的正文上限（语料全文很长，尾巴对关键词没帮助）
  scanChars: 4000      // 片段窗口最多回溯的字数（别为了找一个词扫全文）
}
// 结构化语料（可选）：JSON 数组，元素形如 { 标题, 标签, 摘要, 全文, 点赞量 }。
const STRUCT_FILE = '销售技巧-结构化.json'
// Markdown 语料不再写死文件名：扫描目录下全部 .md（按名字排序，最多 20 个）。
//   用户把自己的营销笔记丢进 营销资料库/ 就能被检索到，不用改源码。
const MD_MAX_FILES = 20
function mdFiles(dir) {
  try { return fs.readdirSync(dir).filter((f) => /\.md$/i.test(f)).sort().slice(0, MD_MAX_FILES) }
  catch (e) { return [] }
}
const CACHE = new Map() // dir -> corpus

// ---------------------------------------------------------------- 分词（中文二元 + 英文单词）
function bigrams(s) {
  const out = new Set()
  const t = String(s || '').toLowerCase()
  if (!t) return out
  for (const m of t.matchAll(/[a-z0-9]{2,}/g)) out.add(m[0])
  const cjk = t.replace(/[^\u4e00-\u9fa5]+/g, '\u0000')
  for (const seg of cjk.split('\u0000')) {
    for (let i = 0; i + 1 < seg.length && i < 400; i++) out.add(seg.slice(i, i + 2))
    if (seg.length === 1) out.add(seg)
  }
  return out
}

function cleanTitle(s) {
  const t = String(s || '').replace(/#[^\s#]+/g, ' ').replace(/\s+/g, ' ').trim()
  // 有些条目的"标题"其实是整段视频文案（实测 200+ 字）：来源里塞这么长会把提示词撑肿，截断即可
  return t.length > 40 ? (t.slice(0, 40) + '…') : t
}
function plain(s) {
  return String(s || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/[*_>`|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
function uniq(arr) { return [...new Set(arr)] }

// ---------------------------------------------------------------- 语料装载
function mdChunks(dir, file) {
  const full = path.join(dir, file)
  let raw = ''
  try { raw = fs.readFileSync(full, 'utf8') } catch (e) { return [] }
  const name = file.replace(/\.md$/, '')
  const chunks = []
  const parts = String(raw).split(/^(#{1,6})\s+(.+)$/m)
  // split 后形如 [前言, '#', '标题', 正文, '##', '标题2', 正文2, ...]
  let head = name
  let body = parts[0] || ''
  for (let i = 1; i < parts.length; i += 3) {
    const title = String(parts[i + 1] || '').trim()
    const text = plain(parts[i + 2] || '')
    const pre = plain(body)
    if (pre) chunks.push({ 来源: `《${name}》`, 标题: name, 文本: pre })
    head = title || head
    if (text) chunks.push({ 来源: `《${name}·${head}》`, 标题: `${name}·${head}`, 文本: text })
    body = ''
  }
  const tail = plain(body)
  if (tail) chunks.push({ 来源: `《${name}》`, 标题: name, 文本: tail })
  return chunks
}

function structChunks(dir) {
  const full = path.join(dir, STRUCT_FILE)
  let arr = null
  try { arr = JSON.parse(fs.readFileSync(full, 'utf8')) } catch (e) { return [] }
  if (!Array.isArray(arr)) return []
  return arr.map((e) => {
    const 标题 = cleanTitle(e['标题'])
    const 标签 = Array.isArray(e['标签']) ? e['标签'].join(' ') : ''
    const 全文 = plain(e['全文'])
    const 摘要 = plain(e['摘要'])
    return {
      来源: `《${标题}》`,
      标题,
      标签,
      摘要,
      文本: 全文.slice(0, RAG_LIMITS.textChars),
      热度: Number(e['点赞量'] || 0)
    }
  }).filter((c) => c.标题 && c.文本)
}

function mtimeKey(dir, files) {
  return files.map((f) => {
    try { return `${f}:${fs.statSync(path.join(dir, f)).mtimeMs}:${fs.statSync(path.join(dir, f)).size}` } catch (e) { return `${f}:0` }
  }).join('|')
}

export function loadCorpus(dir = ragDir()) {
  const mds = mdFiles(dir)
  const files = [STRUCT_FILE, ...mds]
  // features.rag=false（设置里关掉）→ 语料恒为空；key 里带标记，关/开后立刻生效
  const ragOn = !!aiPolicy().rag
  const key = (ragOn ? '' : 'OFF|') + mtimeKey(dir, files)
  const hit = CACHE.get(dir)
  if (hit && hit.key === key) return hit.corpus

  let chunks = []
  const sources = []
  if (ragOn) {
    try {
      chunks = structChunks(dir)
      if (chunks.length) sources.push(`${STRUCT_FILE}（${chunks.length} 篇）`)
    } catch (e) { /* 坏文件不该拖垮插件：下面按空语料处理 */ }
    for (const f of mds) {
      const cs = mdChunks(dir, f)
      if (cs.length) { chunks.push(...cs); sources.push(`${f}（${cs.length} 段）`) }
    }
  }
  chunks = chunks.slice(0, RAG_LIMITS.chunks).map((c, i) => {
    const 文本 = String(c.文本 || '')
    const titleBg = bigrams(`${c.标题 || ''} ${c.标签 || ''}`)
    const bg = bigrams(`${c.标题 || ''} ${c.摘要 || ''} ${文本}`)
    const heat = Number(c.热度 || 0)
    return {
      id: i,
      来源: c.来源,
      标题: c.标题,
      标签: c.标签 || '',
      摘要: String(c.摘要 || '').slice(0, RAG_LIMITS.snippetChars),
      文本,
      bg,
      titleBg,
      // 点赞量只做轻微加权（3 万赞 ≈ 1.06 倍），别让"热门"盖过"对题"
      weight: 1 + Math.min(Math.log10(1 + heat) / 40, 0.15)
    }
  })

  // df / idf
  const df = new Map()
  for (const c of chunks) for (const bg of c.bg) df.set(bg, (df.get(bg) || 0) + 1)
  const N = Math.max(chunks.length, 1)
  const idf = new Map()
  for (const [bg, n] of df) idf.set(bg, Math.log(1 + N / (1 + n)) + 0.5)

  const corpus = { ok: chunks.length > 0, dir, key, chunks, df, idf, sources, ragEnabled: ragOn, builtAt: new Date().toISOString() }
  CACHE.set(dir, { key, corpus })
  return corpus
}

export function ragStatus(dir = ragDir()) {
  const pol = aiPolicy()
  const c = loadCorpus(dir)
  const cached = CACHE.has(dir)
  return {
    ok: !!c.ok,
    dir: c.dir,
    // 目录哪来的：'env'（SALE_DIR）/ 'config'（设置里写的）/ 'default'（默认目录）
    dirSource: dataDirSource(),
    enabled: !!pol.rag,
    warn: pol.rag ? '' : 'RAG 已在设置里关闭（features.rag=false）',
    chunks: c.chunks.length,
    sources: c.sources,
    cached,
    builtAt: c.builtAt,
    error: c.ok ? '' : (pol.rag ? '语料为空：营销资料库 里还没有可检索的 .md / .json（目录不存在或格式不对）' : '')
  }
}

// ---------------------------------------------------------------- 检索
function window(text, q, cap) {
  const t = String(text || '')
  if (t.length <= cap) return t
  let bestAt = 0
  let bestHit = -1
  const scan = Math.min(t.length, RAG_LIMITS.scanChars)
  for (let at = 0; at < scan; at += 60) {
    const seg = t.slice(at, at + cap)
    let hit = 0
    for (const bg of q) if (seg.includes(bg)) hit++
    if (hit > bestHit) { bestHit = hit; bestAt = at }
  }
  return (bestAt > 0 ? '…' : '') + t.slice(bestAt, bestAt + cap)
}

export function searchRag(query, opts = {}) {
  const limit = Math.max(1, Math.min(Number(opts.limit) || RAG_LIMITS.limit, 8))
  const minScore = Number(opts.minScore || 0)
  const corpus = loadCorpus(opts.dir || ragDir())
  if (!corpus.ok) return []
  const q = bigrams(query)
  if (!q.size) return []
  const scored = []
  for (const c of corpus.chunks) {
    let score = 0
    let hit = 0
    for (const bg of q) {
      if (c.bg.has(bg)) {
        const w = corpus.idf.get(bg) || 0.5
        score += w
        hit++
        if (c.titleBg.has(bg)) score += w * 1.5 // 标题/标签命中更值钱
      }
    }
    if (!hit) continue
    score = (score / Math.sqrt(1 + c.文本.length / 400)) * c.weight
    scored.push({ c, score })
  }
  scored.sort((a, b) => (b.score - a.score) || (a.c.id - b.c.id))
  return scored
    .filter((s) => s.score > minScore)
    .slice(0, limit)
    .map((s) => ({
      来源: s.c.来源,
      标题: s.c.标题,
      片段: window(s.c.摘要 || s.c.文本, q, RAG_LIMITS.snippetChars),
      得分: Math.round(s.score * 1000) / 1000
    }))
}

// 给提示词用的一句话（探针也会断言这个格式）
export function formatSnippets(hits) {
  const list = Array.isArray(hits) ? hits : []
  if (!list.length) return ''
  return list.map((h, i) => `【资料${i + 1}】${h.片段}\n（来源：${h.来源}）`).join('\n')
}
