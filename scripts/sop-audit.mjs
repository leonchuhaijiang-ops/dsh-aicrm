#!/usr/bin/env node
// ============================================================================
// scripts/sop-audit.mjs — 全库 SOP 归位审计（只读，不写任何文件）
// ============================================================================
// 解决什么问题：客户一多，就会有人问「这个客户的跟进记录怎么没进 SOP？」
//   本脚本把**每一个有跟进记录的客户**都过一遍，逐客户核对：
//     跟进记录条数 = 落在 13 段/出口的条数 + 落在「其他跟进记录」桶的条数
//   两者对不上 = 有记录被吞了（bug），直接列出客户 ID。
//   顺带列出「有记录、但主表当前阶段为空」的客户——这类客户补一次带 stage 的
//   跟进即可把当前阶段推上去，不算丢数据。
//   1.3.0 起另外给出：待归段记录数、待归段客户 Top10（按桶条数）、未进漏斗客户数+示例。
//
// 口径（与看板 SOP 面板、sales_sop 工具完全一致，都走 lib 的 buildSop）：
//   · 【信息变更】/【删除】墓碑是过程留痕，不进 SOP，单独计 changes；
//   · 阶段为空 / 认不出的记录 → 「其他跟进记录」桶（不是丢失）。
//
// 用法：
//   node scripts/sop-audit.mjs --data-dir /path/to/sales-data
//   node scripts/sop-audit.mjs --problems        # 只看对不上的客户
//   node scripts/sop-audit.mjs --json            # 机器可读
// 退出码：全部有归宿 0；发现对不上 1；参数/IO 出错 2。
// ============================================================================
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const LIB_ENTRY = path.join(ROOT, 'lib', 'sales-lib.js')

const ENV_DATA_DIR = 'SALE_DIR'
const ENV_CONFIG_FILE = 'DSH_SALES_CONFIG'
const DEFAULT_DATA_DIR = path.join(os.homedir(), 'dsh-sales-data')
const DEFAULT_CONFIG_FILE = path.join(os.homedir(), '.dsh', 'sales.config.json')

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
function callLib(dir, payload) {
  const r = spawnSync(process.execPath, [LIB_ENTRY, 'run', '--dir', dir], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  })
  const out = String(r.stdout || '').trim()
  let data = null
  try { data = out ? JSON.parse(out) : null } catch (e) { data = null }
  return { code: r.status, data, stderr: String(r.stderr || '').trim() }
}

const HELP = `全库 SOP 归位审计（只读）

用法：
  node scripts/sop-audit.mjs [--data-dir <绝对路径>]
  node scripts/sop-audit.mjs [--data-dir <绝对路径>] --problems   只看对不上的客户
  node scripts/sop-audit.mjs --json                                机器可读输出

口径：
  · 每个有跟进记录的客户：跟进条数 = 段内（13 段 + 出口）+ 其他跟进记录桶
  · 【信息变更】留痕单独计 changes，不进 SOP（面板也不渲染）
  · 数据目录解析顺序：--data-dir > SALE_DIR > 配置档 dataDir > ${DEFAULT_DATA_DIR}
`

function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) { console.log(HELP); return 0 }
  const asJson = argv.includes('--json')
  const onlyProblems = argv.includes('--problems')
  let argDir = ''
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--data-dir' || argv[i] === '--dir') { argDir = argv[i + 1] || ''; i++ }
  }
  const { dir, source } = resolveDataDir(argDir)
  if (!fs.existsSync(dir)) {
    console.error(`[错误] 数据目录不存在：${dir}（来源：${source}）`)
    return 2
  }
  const r = callLib(dir, { cmd: 'sopaudit', args: [{}] })
  if (!r.data || !r.data.ok) {
    console.error('[错误] 审计失败：' + ((r.data && r.data.message) || r.stderr || '未知错误'))
    return 2
  }
  const j = r.data
  const t = j.totals || {}
  const customers = Array.isArray(j.customers) ? j.customers : []
  const bucket = customers.filter(c => c.unlabeled > 0).sort((a, b) => (b.unlabeled - a.unlabeled) || (b.follows - a.follows))
  const noCurrent = customers.filter(c => c.noCurrent)
  // 1.3.0 新增视图：待归段（其他跟进记录桶）与「有记录但主表阶段为空」的客户
  const view = {
    unlabeledTotal: t.unlabeled || 0,
    unlabeledCustomers: bucket.length,
    unlabeledTop: bucket.slice(0, 10).map(c => ({ id: c.id, name: c.name, follows: c.follows, staged: c.staged, unlabeled: c.unlabeled })),
    noCurrentCount: typeof t.noCurrentCount === 'number' ? t.noCurrentCount : noCurrent.length,
    noCurrentTop: noCurrent.slice(0, 10).map(c => ({ id: c.id, name: c.name, follows: c.follows, currentStage: c.currentStage || '' })),
  }
  if (asJson) { console.log(JSON.stringify(Object.assign({}, j, view), null, 1)); return t.ok ? 0 : 1 }
  console.log('数据目录：' + j.dataDir + '（' + source + '）')
  console.log(`口径：有跟进记录的客户 ${t.customersWithRecords} 个（另有 ${t.changeOnlyCustomers} 个客户只有【信息变更】留痕、无跟进结果）`)
  console.log(`记录：跟进 ${t.follows} 条 = 段内 ${t.staged} + 其他跟进记录 ${t.unlabeled}（变更留痕 ${t.changes} 条另计）`)
  console.log(`[待归段] ${view.unlabeledTotal} 条记录没有阶段（阶段为空或认不出，进「其他跟进记录」桶；分布在 ${view.unlabeledCustomers} 个客户）`)
  console.log(t.ok
    ? '[结果] 全部有归宿：没有记录被吞，也没有记录挂在不存在的客户上 ✓'
    : `[结果] 有 ${t.badCount} 个客户的记录数对不上（见下）✗`)
  console.log(`[未进漏斗] 有跟进记录但主表当前阶段为空的客户 ${view.noCurrentCount} 个` +
    (noCurrent.length ? `（示例：${noCurrent.slice(0, 5).map(c => String(c.name || c.id).slice(0, 16)).join('、')}）` : '') +
    '：补一次带 stage 的跟进即可把当前阶段推上去（不算丢数据）')
  if (!t.ok && j.bad.length) {
    console.log('\n对不上的客户：')
    for (const c of j.bad) console.log(`  ${c.id}  ${c.name}  跟进${c.follows} 段内${c.staged} 桶${c.unlabeled}`)
  }
  if (!onlyProblems && bucket.length) {
    console.log(`\n待归段客户 Top${Math.min(10, bucket.length)}（按「其他跟进记录」桶条数）：`)
    for (const c of bucket.slice(0, 10)) console.log(`  ${c.id}  ${String(c.name || '').slice(0, 22)}  跟进${c.follows} 段内${c.staged} 桶${c.unlabeled}`)
    console.log('  （想让它们进段：补一条带 stage 的跟进；历史记录不会硬猜阶段，详见 docs/tools.md）')
  }
  return t.ok ? 0 : 1
}

process.exitCode = main()
