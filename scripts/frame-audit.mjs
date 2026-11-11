#!/usr/bin/env node
// ============================================================================
// scripts/frame-audit.mjs — 历史跟进记录「九要素」缺项审计（只读，不写任何文件）
// ============================================================================
// 解决什么问题：1.3.0 起录入走「九要素」软框架（阶段/沟通内容/对方反应/下一步动作/
//   下次跟进时间…），但历史记录是逐步补出来的，字段经常缺。本脚本统计历史跟进记录
//   缺哪一要素各多少条，并按客户聚合 Top10——用来决定「先补哪一类字段」。
//
// 口径：
//   · 只统计**跟进结果**（lib.isFollowRecord）：【信息变更】/【删除】等留痕是过程信息，
//     本来就没有九要素，不参与统计（变更留痕条数单独计 changes）。
//   · 「缺阶段」= 阶段为空或认不出 → 会被归入「其他跟进记录」桶（不是丢数据）。
//   · 「缺沟通内容」= 空或少于 8 个字符（太短等于没写清聊了什么）。
//   · 一条记录可能同时缺多项，所以「各项相加」会大于「有缺项的记录数」。
//   · 本脚本只报告、不阻断：退出码 0；参数/IO 错误 2。
//
// 用法：
//   node scripts/frame-audit.mjs --data-dir /path/to/sales-data
//   node scripts/frame-audit.mjs --json            # 机器可读
//   node scripts/frame-audit.mjs --help
// 数据目录解析顺序：--data-dir > SALE_DIR > 配置档 dataDir > 默认 <home>/dsh-sales-data
// ============================================================================
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const LIB_ENTRY = path.join(ROOT, 'lib', 'sales-lib.js')

const ENV_DATA_DIR = 'SALE_DIR'
const ENV_CONFIG_FILE = 'DSH_SALES_CONFIG'
const DEFAULT_DATA_DIR = path.join(os.homedir(), 'dsh-sales-data')
const DEFAULT_CONFIG_FILE = path.join(os.homedir(), '.dsh', 'sales.config.json')

// ----- 数据目录解析（与 setup.mjs / doctor.mjs / dsh/config.js 同一套规则） -----

function expandHome(p) {
  const s = String(p == null ? '' : p).trim()
  if (!s) return ''
  if (s === '~' || s === '~/') return os.homedir()
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(os.homedir(), s.slice(2))
  return s
}
function configFilePath() {
  const env = String(process.env[ENV_CONFIG_FILE] || '').trim()
  return env ? path.resolve(expandHome(env)) : DEFAULT_CONFIG_FILE
}
function readConfigFile() {
  const file = configFilePath()
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    return { file, config: (j && typeof j === 'object') ? j : {} }
  } catch (e) {
    return { file, config: {} }
  }
}
function resolveDataDir(argDir) {
  if (argDir) return { dir: path.resolve(expandHome(argDir)), source: '参数 --data-dir' }
  const env = String(process.env[ENV_DATA_DIR] || '').trim()
  if (env) return { dir: path.resolve(expandHome(env)), source: '环境变量 SALE_DIR' }
  const c = readConfigFile()
  const fromCfg = c.config && c.config.dataDir ? String(c.config.dataDir).trim() : ''
  if (fromCfg) return { dir: path.resolve(expandHome(fromCfg)), source: '配置档 ' + c.file }
  return { dir: DEFAULT_DATA_DIR, source: '默认值' }
}

const HELP = `历史跟进记录「九要素」缺项审计（只读）
用法：
  node scripts/frame-audit.mjs [--data-dir <绝对路径>]
  node scripts/frame-audit.mjs [--data-dir <绝对路径>] --json   机器可读输出
  node scripts/frame-audit.mjs --help

口径：
  · 只统计跟进结果（【信息变更】/【删除】等变更留痕不参与，单独计 changes）
  · 缺阶段 = 阶段为空或认不出（会进「其他跟进记录」桶）
  · 缺沟通内容 = 空或少于 8 个字符
  · 一条记录可同时缺多项，各项相加会大于「有缺项的记录数」
数据目录解析顺序：--data-dir > SALE_DIR > 配置档 dataDir > ${DEFAULT_DATA_DIR}
退出码：只报告，恒为 0；参数/IO 错误 2。
`

function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) { console.log(HELP); return 0 }

  const asJson = argv.includes('--json')
  let argDir = ''
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--data-dir' || argv[i] === '--dir') {
      const v = argv[i + 1]
      if (!v || v.startsWith('--')) { console.error('[错误] --data-dir 后面要跟一个目录路径'); return 2 }
      argDir = v
      i++
    } else if (argv[i].startsWith('--data-dir=')) {
      argDir = argv[i].slice('--data-dir='.length)
    }
  }

  const { dir, source } = resolveDataDir(argDir)
  if (!dir || !path.isAbsolute(dir)) {
    console.error(`[错误] 数据目录必须是绝对路径：${dir || '(空)'}（来源：${source}）`)
    return 2
  }
  if (!fs.existsSync(dir)) {
    console.error(`[错误] 数据目录不存在：${dir}（来源：${source}）`)
    return 2
  }

  // 让 lib 在 require 时解析到同一个数据目录（lib 加载时就定下 DIR，先设环境变量）
  process.env[ENV_DATA_DIR] = dir

  let lib = null
  try {
    lib = createRequire(import.meta.url)(LIB_ENTRY)
  } catch (e) {
    console.error('[错误] 加载 lib/sales-lib.js 失败：' + String((e && e.message) || e))
    return 2
  }
  if (!lib || typeof lib.readFlow !== 'function' || typeof lib.readMaster !== 'function') {
    console.error('[错误] lib/sales-lib.js 没有导出 readFlow/readMaster，无法审计')
    return 2
  }

  let masterRows = []
  let flowRows = []
  try {
    masterRows = lib.readMaster().rows || []
    flowRows = lib.readFlow().rows || []
  } catch (e) {
    console.error('[错误] 读取数据表失败（文件可能被占用或损坏）：' + String((e && e.message) || e))
    return 2
  }

  const isFollow = typeof lib.isFollowRecord === 'function' ? lib.isFollowRecord : (f) => !lib.isChangeRecord(f)
  const normStage = typeof lib.normStage === 'function' ? lib.normStage : (v) => String(v == null ? '' : v).trim()
  const STAGE_SET = lib.STAGE_SET || {}
  const stageOk = (v) => !!STAGE_SET[normStage(v)]

  // 客户ID → 展示名（公司 > 姓名/联系人 > 客户ID），主表同 ID 重复行只取第一条
  const nameById = new Map()
  for (const c of masterRows) {
    const id = String(c['客户ID'] || '').trim()
    if (!id || nameById.has(id)) continue
    nameById.set(id, String(c['公司'] || c['姓名/联系人'] || id).trim())
  }

  const FIELDS = [
    { key: 'stage', label: '阶段（会进「其他跟进记录」桶）', test: (f) => !stageOk(f['阶段']) },
    { key: 'what', label: '沟通内容（空或 <8 字）', test: (f) => String(f['沟通内容'] || '').trim().length < 8 },
    { key: 'nextAction', label: '下一步动作', test: (f) => !String(f['下一步动作'] || '').trim() },
    { key: 'nextDate', label: '下次跟进时间', test: (f) => !String(f['下次跟进时间'] || '').trim() },
    { key: 'react', label: '对方反应', test: (f) => !String(f['对方反应'] || '').trim() },
  ]

  const follows = flowRows.filter(isFollow)
  const totals = { follows: follows.length, changes: flowRows.length - follows.length }
  for (const fd of FIELDS) totals[fd.key] = 0
  totals.withMissing = 0

  const per = new Map()
  for (const f of follows) {
    const id = String(f['客户ID'] || '').trim()
    if (!per.has(id)) {
      const p = { id, name: nameById.get(id) || id, follows: 0, missing: 0, by: {} }
      for (const fd of FIELDS) p.by[fd.key] = 0
      per.set(id, p)
    }
    const p = per.get(id)
    p.follows++
    let any = false
    for (const fd of FIELDS) {
      if (fd.test(f)) { totals[fd.key]++; p.by[fd.key]++; any = true }
    }
    if (any) { totals.withMissing++; p.missing++ }
  }

  const customers = [...per.values()]
    .sort((a, b) => (b.missing - a.missing) || (b.follows - a.follows) || String(a.id).localeCompare(String(b.id)))
  const top = customers.filter((c) => c.missing > 0).slice(0, 10)

  if (asJson) {
    console.log(JSON.stringify({
      ok: true,
      dataDir: dir,
      source,
      fields: FIELDS.map((fd) => ({ key: fd.key, label: fd.label })),
      totals,
      customers,
      top: top.map((c) => ({ id: c.id, name: c.name, follows: c.follows, missing: c.missing, by: c.by })),
    }, null, 1))
    return 0
  }

  console.log('')
  console.log('AI-CRM 客资管理系统 · 跟进记录九要素缺项审计（只读）')
  console.log('─'.repeat(64))
  console.log('数据目录：' + dir)
  console.log('解析来源：' + source)
  console.log('─'.repeat(64))
  console.log(`跟进记录：${totals.follows} 条（变更留痕 ${totals.changes} 条另计，不进九要素口径）`)
  if (!totals.follows) {
    console.log('还没有跟进记录（新库或还没开始跟进）。')
    console.log('─'.repeat(64))
    return 0
  }
  for (const fd of FIELDS) {
    const n = totals[fd.key]
    const pct = totals.follows ? Math.round((n / totals.follows) * 100) : 0
    console.log(`缺 ${fd.label}：${n} 条（${pct}%）`)
  }
  console.log(`有缺项的记录：${totals.withMissing} 条 / ${totals.follows} 条`)
  console.log('─'.repeat(64))
  if (top.length) {
    console.log(`按客户聚合（缺项记录数最多的前 ${top.length} 个）：`)
    for (const c of top) {
      const detail = FIELDS.filter((fd) => c.by[fd.key] > 0).map((fd) => `${fd.key} ${c.by[fd.key]}`).join('、')
      console.log(`  ${c.id}  ${String(c.name || '').slice(0, 22)}  跟进${c.follows} 缺${c.missing}｜${detail}`)
    }
  } else {
    console.log('没有缺项：历史跟进记录的九要素都齐 ✓')
  }
  console.log('提示：这是软框架，不阻断写库；补历史时优先补「阶段」（决定记录进哪个 SOP 段）。')
  return 0
}

let code = 2
try {
  code = main()
} catch (e) {
  console.error('[错误] 审计脚本自己出错了：' + String((e && e.message) || e))
  code = 2
}
process.exitCode = code
