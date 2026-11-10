#!/usr/bin/env node
// ============================================================================
// scripts/backfill-stage.mjs — 给历史跟进记录补「阶段」（默认只看不写）
// ============================================================================
// 背景：老数据（批量导入、早期脚本写入）里有一批跟进记录「阶段」是空的，
//   它们在看板 SOP 面板里落在「其他跟进记录」桶。这个脚本按**确定性的规则**
//   能补的补上，补不了的继续留桶——不猜。
//
// 判段规则（与 lib 的 cmdLog 同一套口径）：
//   1) 只认「类型 → 阶段」硬映射：首触→客户触达、试用回访→产品演示、
//      老客服务→成交签约、放弃跟进→推进终止。这是默认行为。
//   2) 可选 --infer content：再用内容关键词判段（lib 的 inferStageOfFollow）。
//      实测对「数据整理/策略调整」这类批量导入记录很容易误判，**默认不开**。
//   3) 判不出来 → 不改，继续留在「其他跟进记录」桶。
//
// 安全边界：
//   · 默认 dry-run，只打印清单，不写盘；--apply 才写；
//   · --apply 前自动把两张 xlsx 备份到 <数据目录>/backup/backfill-<时间戳>/；
//   · 写入走 lib 的 writeFlow（写锁 + 表头断言 + 原子写 + 变更留痕）；
//   · **只改流水表「阶段」一列**，不动客户主表当前阶段（补历史不该反推漏斗位置）。
//
// 用法：
//   node scripts/backfill-stage.mjs --data-dir /path/to/sales-data            # 预演
//   node scripts/backfill-stage.mjs --data-dir /path/to/sales-data --apply    # 真写
//   node scripts/backfill-stage.mjs --infer content --apply                   # 再开内容关键词
//   node scripts/backfill-stage.mjs --json
// 退出码：成功 0；参数/IO 出错 1；预演发现可补记录时也返回 0（只是提示）。
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
const MASTER_FILE = '销售客户-主表.xlsx'
const FLOW_FILE = '销售客户-流水表.xlsx'

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
function backupDir(dir) {
  const d = new Date()
  const p2 = (n) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`
  const target = path.join(dir, 'backup', 'backfill-' + stamp)
  fs.mkdirSync(target, { recursive: true })
  for (const f of [MASTER_FILE, FLOW_FILE]) {
    const src = path.join(dir, f)
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(target, f))
  }
  return target
}

const HELP = `历史跟进记录补阶段（默认 dry-run）

用法：
  node scripts/backfill-stage.mjs [--data-dir <绝对路径>]                 预演（不写盘）
  node scripts/backfill-stage.mjs [--data-dir <绝对路径>] --apply         真写（先自动备份）
  node scripts/backfill-stage.mjs --infer content                         预演时再启用内容关键词判段
  node scripts/backfill-stage.mjs --json                                  机器可读

规则：
  · 默认只认类型硬映射：首触→客户触达、试用回访→产品演示、
    老客服务→成交签约、放弃跟进→推进终止
  · --infer content 才用内容关键词判段（批量导入记录容易误判，默认不开）
  · 判不出来的一律不改，继续留在看板「其他跟进记录」桶
  · --apply 只改流水表「阶段」列，不动客户主表当前阶段
  · 数据目录解析顺序：--data-dir > SALE_DIR > 配置档 dataDir > ${DEFAULT_DATA_DIR}
`

function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) { console.log(HELP); return 0 }
  const asJson = argv.includes('--json')
  const apply = argv.includes('--apply')
  let infer = 'type'
  let argDir = ''
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--data-dir' || argv[i] === '--dir') { argDir = argv[i + 1] || ''; i++ }
    if (argv[i] === '--infer') { infer = String(argv[i + 1] || 'type').toLowerCase(); i++ }
  }
  if (infer !== 'type' && infer !== 'content') {
    console.error('[错误] --infer 只接受 type 或 content')
    return 1
  }
  const { dir, source } = resolveDataDir(argDir)
  if (!fs.existsSync(dir)) {
    console.error(`[错误] 数据目录不存在：${dir}（来源：${source}）`)
    return 1
  }
  if (!fs.existsSync(path.join(dir, FLOW_FILE))) {
    console.error(`[错误] 没有流水表：${path.join(dir, FLOW_FILE)}`)
    console.error('       先初始化：node scripts/setup.mjs --data-dir "' + dir + '"')
    return 1
  }
  let backup = ''
  if (apply) {
    try { backup = backupDir(dir) } catch (e) {
      console.error('[错误] 备份失败，已中止（不写盘）：' + (e && e.message ? e.message : e))
      return 1
    }
  }
  const mode = apply ? 'apply' : 'dry'
  const r = callLib(dir, { cmd: 'backfillstage', args: [{ mode, infer }] })
  if (!r.data || !r.data.ok) {
    console.error('[错误] 补阶段失败：' + ((r.data && r.data.message) || r.stderr || '未知错误'))
    return 1
  }
  const j = r.data
  if (asJson) { console.log(JSON.stringify(Object.assign({ backup }, j), null, 1)); return 0 }
  console.log('数据目录：' + j.dataDir + '（' + source + '）')
  console.log('模式：' + (apply ? 'apply（已写盘）' : 'dry-run（只看不写）') + '　判段依据：' + (infer === 'content' ? '类型 + 内容关键词' : '类型硬映射'))
  if (backup) console.log('备份：' + backup)
  console.log(`扫描：跟进记录 ${j.scannedFollow} 条（已归段 ${j.alreadyStaged}、空阶段 ${j.blankStage}、认不出 ${j.unknownStage}）`)
  console.log(`可补：${j.fillable} 条（涉及 ${j.customersTouched} 个客户）；留桶：${j.keptUnsorted} 条`)
  const bs = j.byStage || {}
  const keys = Object.keys(bs)
  if (keys.length) console.log('按段：' + keys.map(k => `${k} ${bs[k]}`).join('　'))
  if (j.applied) console.log(`已写入：${j.applied} 条（只改流水「阶段」列，主表当前阶段未动）`)
  if (j.samples && j.samples.length) {
    console.log('\n样例（最多 12 条）：')
    for (const s of j.samples.slice(0, 12)) {
      console.log(`  ${s.日期}  ${s.客户ID}  ${s.原阶段} → ${s.判为}（${s.依据}）  ${String(s.内容 || '').replace(/\s+/g, ' ').slice(0, 40)}`)
    }
  }
  if (!apply && j.fillable > 0) console.log('\n确认无误后加 --apply 真写；预演不会改任何文件。')
  return 0
}

process.exitCode = main()
