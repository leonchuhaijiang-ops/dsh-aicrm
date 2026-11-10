#!/usr/bin/env node
// ============================================================================
// scripts/setup.mjs — 首次初始化（新用户下载仓库后第一条要跑的命令）
// ============================================================================
// 它做四件事，全部**幂等、绝不覆盖已有数据**：
//   ① 建数据目录骨架：<数据目录>/{营销资料库,合同,logs,快照}
//   ② 建两张空表：直接调 lib/sales-lib.js 的 init 命令，不在这里另抄列名
//        （表头契约 HEADERS_MASTER / HEADERS_FLOW / HEADERS_CONTACT 只有 lib 里一份定义）
//        销售客户-主表.xlsx  → sheet「客户主表」(31 列) + sheet「联系人」(5 列)
//        销售客户-流水表.xlsx → sheet「跟进流水」(11 列)
//   ③ 把 templates/营销资料库/ 下的示例语料复制进 <数据目录>/营销资料库/（只补缺）
//   ④ 写配置档 {version, dataDir, ai, features, profile}（原子写：tmp + rename）
//
// 数据目录解析优先级（与 dsh/config.js 完全同一套规则；本脚本**故意不 import dsh/**，
// 这样脱离 DSH 插件也能单独跑）：
//   --data-dir 参数 > 环境变量 SALE_DIR > 配置档里的 dataDir > 默认 <home>/dsh-sales-data
// 配置档路径：环境变量 DSH_SALES_CONFIG > 默认 <home>/.dsh/sales.config.json
//
// 用法：
//   node scripts/setup.mjs --data-dir /path/to/sales-data --yes
//   node scripts/setup.mjs --check          # 只打印将要做什么，不落盘
//   node scripts/setup.mjs --help
//
// 退出码：成功 0；参数/配置/IO 出错 1。
// ============================================================================
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')                 // 仓库/插件根目录
const TEMPLATE_DIR = path.join(ROOT, 'templates', '营销资料库')

const ENV_DATA_DIR = 'SALE_DIR'
const ENV_CONFIG_FILE = 'DSH_SALES_CONFIG'
const CONFIG_VERSION = 1
const DEFAULT_DATA_DIR = path.join(os.homedir(), 'dsh-sales-data')
const DEFAULT_CONFIG_FILE = path.join(os.homedir(), '.dsh', 'sales.config.json')

// 目录骨架：和 lib/sales-lib.js 的 cmdInit 保持一致。
const SUB_DIRS = ['营销资料库', '合同', 'logs', '快照']
const LIB_ENTRY = path.join(ROOT, 'lib', 'sales-lib.js')

// 两张表不在这里定义列名：建表统一调 lib/sales-lib.js 的 init，
// 列名契约只有那边一份，避免「脚本里抄一份、契约改了没同步」的分叉。
const TABLE_FILES = ['销售客户-主表.xlsx', '销售客户-流水表.xlsx']

// ----- 小工具 --------------------------------------------------------------

function expandHome(p) {
  const s = String(p == null ? '' : p).trim()
  if (!s) return ''
  if (s === '~' || s === '~/') return os.homedir()
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(os.homedir(), s.slice(2))
  return s
}

function configFilePath() {
  const raw = String(process.env[ENV_CONFIG_FILE] || '').trim()
  return raw ? path.resolve(expandHome(raw)) : DEFAULT_CONFIG_FILE
}

function readConfigFile() {
  const file = configFilePath()
  try {
    if (!fs.existsSync(file)) return { file, exists: false, config: null, error: '' }
    const txt = fs.readFileSync(file, 'utf8')
    return { file, exists: true, config: JSON.parse(txt), error: '' }
  } catch (e) {
    return { file, exists: true, config: null, error: String((e && e.message) || e) }
  }
}

// 数据目录解析：与 dsh/config.js 同优先级。
function resolveDataDir(argDir) {
  const cfg = readConfigFile()
  const cfgRaw = cfg.config && typeof cfg.config === 'object' ? String(cfg.config.dataDir || '').trim() : ''
  const cfgDir = cfgRaw && path.isAbsolute(expandHome(cfgRaw)) ? path.normalize(expandHome(cfgRaw)) : ''
  if (argDir) return { dir: path.resolve(expandHome(argDir)), source: '--data-dir 参数', cfg }
  const envDir = String(process.env[ENV_DATA_DIR] || '').trim()
  if (envDir) return { dir: path.resolve(expandHome(envDir)), source: ENV_DATA_DIR + ' 环境变量', cfg }
  if (cfgDir) return { dir: cfgDir, source: '配置档 dataDir', cfg }
  return { dir: DEFAULT_DATA_DIR, source: '默认目录', cfg }
}

function parseArgs(argv) {
  const out = { dataDir: '', check: false, yes: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') out.help = true
    else if (a === '--check') out.check = true
    else if (a === '--yes' || a === '-y') out.yes = true
    else if (a === '--data-dir') {
      const v = argv[++i]
      if (!v || v.startsWith('--')) throw new Error('--data-dir 后面要跟一个目录路径')
      out.dataDir = v
    } else if (a.startsWith('--data-dir=')) {
      out.dataDir = a.slice('--data-dir='.length)
    } else {
      throw new Error('不认识的参数：' + a + '（可用 --data-dir / --check / --yes / --help）')
    }
  }
  return out
}

// 列目录下所有普通文件（返回相对路径，递归；跳过隐藏文件）。
function listFiles(dir, base = dir) {
  const out = []
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.')) continue
    const abs = path.join(dir, ent.name)
    const rel = path.relative(base, abs)
    if (ent.isDirectory()) out.push(...listFiles(abs, base))
    else if (ent.isFile()) out.push(rel)
  }
  return out.sort()
}

// 建目录骨架 + 两张空表：复用数据层 `node lib/sales-lib.js init --dir <dataDir>`。
// 好处只有一个但很重要：列名契约只由 lib 定义，本脚本不再抄一份。
function runLibInit(dataDir) {
  const res = spawnSync(process.execPath, [LIB_ENTRY, 'init', '--dir', dataDir], { encoding: 'utf8' })
  const out = { created: [], kept: [], error: '' }
  if (res.error) {
    out.error = '调用数据层初始化失败（' + LIB_ENTRY + '）：' + String(res.error.message || res.error)
    return out
  }
  const text = String(res.stdout || '').trim()
  const lastLine = text.split(/\r?\n/).filter(Boolean).pop() || ''
  let parsed = null
  try { parsed = JSON.parse(lastLine) } catch (e) { parsed = null }
  if (res.status !== 0 || !parsed || parsed.ok !== true) {
    const why = (parsed && parsed.error) || String(res.stderr || '').trim() || lastLine || '没有输出'
    out.error = '数据层初始化失败（退出码 ' + res.status + '）：' + why
    return out
  }
  out.created = Array.isArray(parsed.created) ? parsed.created : []
  out.kept = Array.isArray(parsed.kept) ? parsed.kept : []
  return out
}

const C = {
  ok: '[OK]  ',
  made: '[新建]',
  kept: '[跳过]',
  copied: '[复制]',
  wrote: '[写入]',
  warn: '[提醒]',
  bad: '[失败]',
  plan: '[计划]',
}

// ----- 主流程 --------------------------------------------------------------

function printHelp() {
  console.log(`AI-CRM 客资管理系统 · 数据目录初始化

用法：
  node scripts/setup.mjs --data-dir <绝对路径> --yes   初始化指定数据目录
  node scripts/setup.mjs                               用 SALE_DIR / 配置档 / 默认目录
  node scripts/setup.mjs --check                       只预览，不写任何文件
  node scripts/setup.mjs --help                        显示本帮助

数据目录解析优先级：
  --data-dir 参数 > 环境变量 SALE_DIR > 配置档 dataDir > 默认 <home>/dsh-sales-data
配置档：环境变量 DSH_SALES_CONFIG > 默认 <home>/.dsh/sales.config.json

说明：
  · 本脚本永不覆盖已有表、已有语料、已有配置里的其他键（只更新 dataDir）。
  · --yes 仅为兼容无人值守调用（本脚本不会反问任何问题）。
  · 建好的空表：销售客户-主表.xlsx（客户主表 31 列 + 联系人 5 列）、
    销售客户-流水表.xlsx（跟进流水 11 列）。列名是数据契约，别改。`)
}

function run() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) { printHelp(); return 0 }

  const major = Number(String(process.versions.node).split('.')[0])
  if (major < 20) {
    console.error(C.bad + ' Node 版本太旧：' + process.version + '，本脚本要求 Node >= 20。请先升级 Node.js。')
    return 1
  }

  // 数据目录必须显式给绝对路径：相对路径会随当前工作目录漂移，
  // 各入口把数据写散到不同地方，事后很难找回。
  const rawArg = String(args.dataDir || '').trim()
  const rawEnv = String(process.env[ENV_DATA_DIR] || '').trim()
  if (rawArg && !path.isAbsolute(expandHome(rawArg))) {
    console.error(C.bad + ' --data-dir 必须给绝对路径，收到的是：' + rawArg)
    console.error('       例如：--data-dir "<你的数据目录>"（Windows 绝对路径，或 /home/you/sales-data）')
    return 1
  }
  if (!rawArg && rawEnv && !path.isAbsolute(expandHome(rawEnv))) {
    console.error(C.bad + ' 环境变量 SALE_DIR 必须给绝对路径，收到的是：' + rawEnv)
    console.error('       例如：set SALE_DIR=<你的数据目录>（Windows）或 export SALE_DIR=/home/you/sales-data')
    return 1
  }

  const { dir: dataDir, source, cfg } = resolveDataDir(args.dataDir)
  if (!path.isAbsolute(dataDir)) {
    console.error(C.bad + ' 数据目录必须是绝对路径：' + dataDir)
    return 1
  }
  if (cfg.error) {
    console.error(C.bad + ' 配置档读不出来：' + cfg.file)
    console.error('       原因：' + cfg.error)
    console.error('       请先修好这个 JSON 文件，或把它移走（配置档只存配置、不存客户数据）；')
    console.error('       也可以用环境变量 DSH_SALES_CONFIG 指向另一个配置文件。')
    return 1
  }

  const preview = args.check
  console.log('')
  console.log('AI-CRM 客资管理系统 · 数据目录初始化' + (preview ? '（预览模式，不会写入任何文件）' : ''))
  console.log('─'.repeat(64))
  console.log('数据目录：' + dataDir)
  console.log('解析来源：' + source)
  console.log('配置档　：' + cfg.file + (cfg.exists ? '' : '（还没有，将新建）'))
  console.log('─'.repeat(64))

  const errors = []
  const steps = []

  // ① 目录骨架
  for (const sub of SUB_DIRS) {
    const p = path.join(dataDir, sub)
    const exists = fs.existsSync(p)
    if (!exists) {
      steps.push({ tag: preview ? C.plan : C.made, text: '目录 ' + sub + '/' })
      if (!preview) {
        try { fs.mkdirSync(p, { recursive: true }) } catch (e) {
          errors.push('建目录失败 ' + p + '：' + String((e && e.message) || e))
        }
      }
    } else {
      steps.push({ tag: C.kept, text: '目录 ' + sub + '/（已存在）' })
    }
  }
  if (!preview) {
    try { fs.mkdirSync(dataDir, { recursive: true }) } catch (e) {
      errors.push('建数据目录失败 ' + dataDir + '：' + String((e && e.message) || e))
    }
  }

  // ② 两张空表：交给 lib/sales-lib.js init（它按 HEADERS_* 契约建表，已存在则 kept）
  if (preview) {
    steps.push({
      tag: C.plan,
      text: TABLE_FILES.join(' + ') + '（表头由 lib/sales-lib.js 的契约常量定义）',
    })
  } else {
    const r = runLibInit(dataDir)
    for (const f of r.created) steps.push({ tag: C.made, text: f })
    for (const f of r.kept) steps.push({ tag: C.kept, text: f + '（已存在，不覆盖）' })
    if (r.error) errors.push(r.error)
  }

  // ③ 示例语料（只补缺，不覆盖）
  let corpusFiles = []
  try {
    corpusFiles = listFiles(TEMPLATE_DIR).filter((f) => /\.(md|json)$/i.test(f))
    if (!corpusFiles.length) errors.push('示例语料目录里没有 .md/.json：' + TEMPLATE_DIR)
  } catch (e) {
    errors.push('找不到示例语料目录 templates/营销资料库（安装包可能不完整）：' + String((e && e.message) || e))
  }
  for (const rel of corpusFiles) {
    const src = path.join(TEMPLATE_DIR, rel)
    const dst = path.join(dataDir, '营销资料库', rel)
    if (fs.existsSync(dst)) {
      steps.push({ tag: C.kept, text: '语料 ' + rel + '（已存在，保留你自己的版本）' })
      continue
    }
    steps.push({ tag: preview ? C.plan : C.copied, text: '语料 ' + rel })
    if (!preview) {
      try {
        fs.mkdirSync(path.dirname(dst), { recursive: true })
        fs.copyFileSync(src, dst)
      } catch (e) {
        errors.push('复制语料失败 ' + rel + '：' + String((e && e.message) || e))
      }
    }
  }

  // ④ 配置档（只更新 dataDir，其它已有键原样保留；原子 tmp + rename）
  const nextCfg = buildConfig(cfg.config, dataDir)
  if (preview) {
    steps.push({ tag: C.plan, text: '配置档写入 dataDir（当前 ' + (cfg.exists ? '已存在' : '不存在') + '）' })
  } else {
    const r = writeConfig(nextCfg, cfg.file)
    if (r.ok) steps.push({ tag: C.wrote, text: '配置档 ' + cfg.file })
    else errors.push(r.error)
  }

  for (const s of steps) console.log(s.tag + ' ' + s.text)

  console.log('─'.repeat(64))
  if (errors.length) {
    console.log(C.bad + ' 有 ' + errors.length + ' 个问题：')
    for (const e of errors) console.log('       - ' + e)
    console.log('')
    console.log('修好上面的问题后可以重复运行本脚本（幂等，不会清数据）。')
    return 1
  }

  if (preview) {
    console.log('预览完成：以上是将会执行的动作。去掉 --check 后再跑一次即可真正初始化。')
    return 0
  }

  console.log('初始化完成。下一步：')
  console.log('  1) 打开《销售客户-主表.xlsx》按表头填客户（列名是数据契约，别改）；')
  console.log('  2) 运行 node scripts/doctor.mjs 做一次体检，全绿再开始用；')
  console.log('  3) 在 DSH 里启用本插件后，看板会读这份数据目录（也可用环境变量 SALE_DIR 指定）。')
  console.log('')
  return 0
}

// 把现有配置与本次数据目录合并成要写盘的对象；不认识的键原样保留。
function buildConfig(cur, dataDir) {
  const base = cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : {}
  const ai = base.ai && typeof base.ai === 'object' ? base.ai : {}
  const local = ai.local && typeof ai.local === 'object' ? ai.local : {}
  const features = base.features && typeof base.features === 'object' ? base.features : {}
  const profile = base.profile && typeof base.profile === 'object' ? base.profile : {}
  return {
    ...base,
    version: CONFIG_VERSION,
    dataDir,
    ai: {
      ...ai,
      mode: ['session', 'fixed', 'local'].includes(String(ai.mode || '')) ? String(ai.mode) : 'session',
      provider: String(ai.provider || ''),
      model: String(ai.model || ''),
      reasoningEffort: String(ai.reasoningEffort || ''),
      local: { provider: String(local.provider || 'local'), model: String(local.model || '') },
    },
    features: { rag: true, ...features },
    profile: { company: '', product: '', ...profile },
  }
}

function writeConfig(cfg, file) {
  const tmp = file + '.' + process.pid + '.tmp'
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
    fs.renameSync(tmp, file)
    return { ok: true }
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch (e2) { /* noop */ }
    return { ok: false, error: '配置档写不进去 ' + file + '：' + String((e && e.message) || e) }
  }
}

let code = 1
try {
  code = run()
} catch (e) {
  console.error(C.bad + ' ' + String((e && e.message) || e))
  if (/不认识的参数|后面要跟/.test(String((e && e.message) || e))) {
    console.error('       用 --help 看用法。')
  }
}
process.exitCode = code
