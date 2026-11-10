#!/usr/bin/env node
// ============================================================================
// scripts/demo.mjs — 示例数据开关（给刚装好的看板一点"看得见的内容"）
// ============================================================================
// 为什么需要它：新用户装完是空库，看板全空，很容易以为「没装上」。
//   这个脚本塞 3 条**明显是示例**的客户（公司/姓名都带「示例」字样，电话是示例号段），
//   让你 10 秒内看到看板长什么样；不想要了随时 --clean，只删自己生成的那 3 条。
//
// 安全边界（重要）：
//   · 只有显式运行本脚本 / 点看板里的「生成示例数据」才会写入，setup 绝不自动塞；
//   · 生成的客户 ID 固定 DEMO-001~003，并在 <数据目录>/示例数据.json 登记清单；
//   · --clean 只删登记清单里的 ID，**碰不到任何真实客户**；
//   · 写入走 lib 的 writeMaster/writeFlow（写锁 + 表头断言 + 原子写 + 变更留痕）。
//
// 数据目录解析优先级（与 dsh/config.js、scripts/setup.mjs 同一套规则）：
//   --data-dir 参数 > 环境变量 SALE_DIR > 配置档里的 dataDir > 默认 <home>/dsh-sales-data
// 配置档路径：环境变量 DSH_SALES_CONFIG > 默认 <home>/.dsh/sales.config.json
//
// 用法：
//   node scripts/demo.mjs --data-dir /path/to/sales-data     # 生成示例数据
//   node scripts/demo.mjs --data-dir /path/to/sales-data --clean   # 清除示例数据
//   node scripts/demo.mjs --info                             # 只看有没有示例数据
//   node scripts/demo.mjs --help
// 退出码：成功 0；参数/配置/IO 出错 1。
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
    const raw = fs.readFileSync(file, 'utf8')
    const j = JSON.parse(raw)
    return { file, config: (j && typeof j === 'object') ? j : {}, ok: true }
  } catch (e) {
    return { file, config: {}, ok: false, error: e && e.message ? e.message : String(e) }
  }
}

function resolveDataDir(argDir) {
  if (argDir) {
    const s = expandHome(argDir)
    return { dir: path.resolve(s), source: '参数 --data-dir' }
  }
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
  })
  const out = String(r.stdout || '').trim()
  let data = null
  try { data = out ? JSON.parse(out) : null } catch (e) { data = null }
  return { code: r.status, data, stderr: String(r.stderr || '').trim() }
}

const HELP = `示例数据开关（dsh-sales / dsh-aicrm）

用法：
  node scripts/demo.mjs [--data-dir <绝对路径>]           生成 3 条示例客户
  node scripts/demo.mjs [--data-dir <绝对路径>] --clean   清除示例客户（只删它自己生成的）
  node scripts/demo.mjs [--data-dir <绝对路径>] --info    只看有没有示例数据
  node scripts/demo.mjs --json                             机器可读输出

说明：
  · 数据目录解析顺序：--data-dir > SALE_DIR > 配置档 dataDir > ${DEFAULT_DATA_DIR}
  · 示例客户 ID 固定为 DEMO-001 / DEMO-002 / DEMO-003，公司名带「示例」字样
  · 生成与清除都不会动真实客户；清除依据是 <数据目录>/示例数据.json 里的 ID 清单
  · 还没初始化过数据目录的，先跑：node scripts/setup.mjs
`

function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) { console.log(HELP); return 0 }
  const asJson = argv.includes('--json')
  const doClean = argv.includes('--clean')
  const doInfo = argv.includes('--info')
  let argDir = ''
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--data-dir' || argv[i] === '--dir') { argDir = argv[i + 1] || ''; i++ }
  }
  const { dir, source } = resolveDataDir(argDir)
  const mode = doInfo ? 'info' : (doClean ? 'clean' : 'seed')

  if (!fs.existsSync(dir)) {
    console.error(`[错误] 数据目录不存在：${dir}（来源：${source}）`)
    console.error('       先初始化：node scripts/setup.mjs --data-dir "' + dir + '"')
    return 1
  }
  const master = path.join(dir, '销售客户-主表.xlsx')
  if (!fs.existsSync(master)) {
    console.error(`[错误] 这个目录里没有「销售客户-主表.xlsx」：${dir}`)
    console.error('       看起来还没初始化，先跑：node scripts/setup.mjs --data-dir "' + dir + '"')
    return 1
  }

  const r = callLib(dir, { cmd: 'demo', args: [{ mode }] })
  const d = r.data || {}
  if (r.code !== 0 || !d.ok) {
    if (asJson) console.log(JSON.stringify({ ok: false, mode, dataDir: dir, error: (d && d.message) || r.stderr || '执行失败' }))
    else console.error('[错误] ' + ((d && d.message) || r.stderr || '执行失败'))
    return 1
  }

  if (asJson) {
    console.log(JSON.stringify({ ok: true, mode, dataDir: dir, dataDirSource: source, ...d }, null, 2))
    return 0
  }
  const line = '─'.repeat(64)
  if (mode === 'info') {
    console.log(line)
    console.log(`数据目录：${dir}（来源：${source}）`)
    console.log(d.exists ? `示例数据：有 ${d.count} 条 → ${d.ids.join(', ')}` : '示例数据：没有（干净库）')
    console.log(line)
    return 0
  }
  if (mode === 'clean') {
    console.log(line)
    if (!d.changed) console.log('没有示例数据需要清除（本来就是干净的）。')
    else console.log(`已清除示例客户 ${d.removed} 条、示例留痕 ${d.removedFlows} 条；真实客户未动。`)
    console.log(`数据目录：${dir}`)
    console.log(line)
    return 0
  }
  console.log(line)
  if (d.already) console.log('示例数据已经生成过了，这次没有重复写入。')
  else if (d.changed) console.log(`已生成示例客户 ${d.created} 条：${(d.ids || []).join(', ')}`)
  else console.log(String(d.message || '没有新增示例数据。'))
  console.log(`数据目录：${dir}`)
  console.log('打开看板刷新一下就能看到；不想要了运行 --clean 一键清除。')
  console.log(line)
  return 0
}

process.exitCode = main()
