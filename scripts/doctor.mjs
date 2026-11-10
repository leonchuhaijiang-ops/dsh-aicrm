#!/usr/bin/env node
// ============================================================================
// scripts/doctor.mjs — 只读自检（部署/换机/升级后跑一遍，全绿才动手）
// ============================================================================
// 检查项（逐项打印 [OK] / [FAIL]，有失败退出码 1）：
//   ① Node 版本 >= 20
//   ② xlsx 模块可加载
//   ③ 表头契约可读：从 lib/sales-lib.js 源码里提取 HEADERS_MASTER/FLOW/CONTACT
//   ④ 配置档存在且是合法 JSON
//   ⑤ 数据目录已配置（不是"默认目录"兜底）且配置里是绝对路径
//   ⑥ 数据目录存在
//   ⑦ 销售客户-主表.xlsx 存在
//   ⑧ 主表 sheet「客户主表」表头与契约逐字一致（31 列）
//   ⑨ 主表 sheet「联系人」表头与契约逐字一致（5 列）
//   ⑩ 销售客户-流水表.xlsx 存在
//   ⑪ 流水表 sheet「跟进流水」表头与契约逐字一致（11 列）
//   ⑫ logs/ 目录可写（写一个临时文件再删掉）
//   ⑬ 营销资料库/ 有可检索语料（.md/.json/.txt，递归子目录）
//   ⑭ 仓库 templates/营销资料库/ 示例语料完整（3 篇 md + 结构化 json）
//   ⑮ lib/sales-lib.js 语法检查通过（node --check）
//   ⑯ 数据层冒烟：临时目录里跑 node lib/sales-lib.js init + check，均退出 0
//
// 数据目录解析优先级与 setup.mjs / dsh/config.js 一致：
//   --data-dir 参数 > 环境变量 SALE_DIR > 配置档 dataDir > 默认 <home>/dsh-sales-data
// 配置档：环境变量 DSH_SALES_CONFIG > 默认 <home>/.dsh/sales.config.json
//
// 用法：
//   node scripts/doctor.mjs                     # 走 SALE_DIR / 配置档
//   node scripts/doctor.mjs --data-dir <目录>   # 指定目录（不写配置、只读）
//   node scripts/doctor.mjs --help
//
// 本脚本除 ⑫ 的临时探针文件与 ⑯ 的系统临时目录外不写任何东西，用完立即删除。
// ============================================================================
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const TEMPLATE_DIR = path.join(ROOT, 'templates', '营销资料库')
const LIB_FILE = path.join(ROOT, 'lib', 'sales-lib.js')

const ENV_DATA_DIR = 'SALE_DIR'
const ENV_CONFIG_FILE = 'DSH_SALES_CONFIG'
const DEFAULT_DATA_DIR = path.join(os.homedir(), 'dsh-sales-data')
const DEFAULT_CONFIG_FILE = path.join(os.homedir(), '.dsh', 'sales.config.json')
const MASTER_FILE = '销售客户-主表.xlsx'
const FLOW_FILE = '销售客户-流水表.xlsx'
const TEMPLATE_REQUIRED = [
  '企业级 AI 落地要点.md',
  '销售异议处理示例-价格篇.md',
  '设计院与咨询公司客户画像示例.md',
  '销售技巧-结构化.json',
]

// ----- 结果收集 ------------------------------------------------------------

const results = []
function pass(name, detail) { results.push({ ok: true, name, detail: detail || '' }) }
function fail(name, detail, hint) { results.push({ ok: false, name, detail: detail || '', hint: hint || '' }) }

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

function resolveDataDir(argDir, cfg) {
  const cfgRaw = cfg.config && typeof cfg.config === 'object' ? String(cfg.config.dataDir || '').trim() : ''
  const cfgDir = cfgRaw && path.isAbsolute(expandHome(cfgRaw)) ? path.normalize(expandHome(cfgRaw)) : ''
  if (argDir) return { dir: path.resolve(expandHome(argDir)), source: '--data-dir 参数' }
  const envDir = String(process.env[ENV_DATA_DIR] || '').trim()
  if (envDir) return { dir: path.resolve(expandHome(envDir)), source: ENV_DATA_DIR + ' 环境变量' }
  if (cfgDir) return { dir: cfgDir, source: '配置档 dataDir' }
  return { dir: DEFAULT_DATA_DIR, source: '默认目录' }
}

// 从 lib/sales-lib.js 源码里提取表头契约常量（不 import 它：sales-lib 是 CJS，
// 加载时就会解析数据目录，doctor 只想要常量，不想带副作用）。
function readContract() {
  const src = fs.readFileSync(LIB_FILE, 'utf8')
  const pick = (name) => {
    const m = src.match(new RegExp('const\\s+' + name + '\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*;'))
    if (!m) return null
    return Array.from(m[1].matchAll(/'([^']*)'|"([^"]*)"/g), (x) => (x[1] !== undefined ? x[1] : x[2]))
  }
  return {
    master: pick('HEADERS_MASTER'),
    flow: pick('HEADERS_FLOW'),
    contact: pick('HEADERS_CONTACT'),
  }
}

// 数据层 CLI 的约定：stdout 最后一行是一个 JSON 对象。
function parseLastJson(text) {
  const line = String(text || '').trim().split(/\r?\n/).filter(Boolean).pop() || ''
  try { return JSON.parse(line) } catch (e) { return null }
}

// 递归收集语料文件（rag 会递归读子目录，这里口径保持一致）。
function listCorpus(dir, base = dir) {
  const out = []
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.')) continue
    const abs = path.join(dir, ent.name)
    if (ent.isDirectory()) out.push(...listCorpus(abs, base))
    else if (ent.isFile() && /\.(md|json|txt)$/i.test(ent.name)) out.push(path.relative(base, abs))
  }
  return out
}

function diffHeaders(expected, actual) {
  if (expected.length !== actual.length) {
    return '列数不符：契约 ' + expected.length + ' 列，实际 ' + actual.length + ' 列'
  }
  for (let i = 0; i < expected.length; i++) {
    if (expected[i] !== actual[i]) {
      return '第 ' + (i + 1) + ' 列不符：契约「' + expected[i] + '」，实际「' + (actual[i] || '空') + '」'
    }
  }
  return ''
}

function readSheetHeader(X, file, sheetName) {
  const wb = X.readFile(file)
  const sh = wb.Sheets[sheetName]
  if (!sh) return { ok: false, error: '没有 sheet「' + sheetName + '」（现有：' + (wb.SheetNames || []).join('、') + '）' }
  const rows = X.utils.sheet_to_json(sh, { header: 1, defval: '' })
  const header = (rows[0] || []).map((v) => String(v == null ? '' : v).trim())
  return { ok: true, header }
}

// ----- 主流程 --------------------------------------------------------------

function parseArgs(argv) {
  const out = { dataDir: '', help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') out.help = true
    else if (a === '--data-dir') {
      const v = argv[++i]
      if (!v || v.startsWith('--')) throw new Error('--data-dir 后面要跟一个目录路径')
      out.dataDir = v
    } else if (a.startsWith('--data-dir=')) {
      out.dataDir = a.slice('--data-dir='.length)
    } else {
      throw new Error('不认识的参数：' + a + '（可用 --data-dir / --help）')
    }
  }
  return out
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(`AI-CRM 客资管理系统 · 自检（只读）

用法：
  node scripts/doctor.mjs                     走 SALE_DIR / 配置档
  node scripts/doctor.mjs --data-dir <目录>   指定数据目录（不写配置、只读）
  node scripts/doctor.mjs --help

数据目录解析优先级：
  --data-dir 参数 > 环境变量 SALE_DIR > 配置档 dataDir > 默认 <home>/dsh-sales-data
配置档：环境变量 DSH_SALES_CONFIG > 默认 <home>/.dsh/sales.config.json

退出码：全绿 0；有 [FAIL] 1。`)
    return 0
  }

  const cfg = readConfigFile()
  const { dir: dataDir, source } = resolveDataDir(args.dataDir, cfg)

  // ① Node 版本
  const major = Number(String(process.versions.node).split('.')[0])
  if (major >= 20) pass('Node 版本 ' + process.version + '（要求 >= 20）')
  else fail('Node 版本 ' + process.version + ' 太旧', '本插件要求 Node >= 20', '升级 Node.js 到 20 或更高版本')

  // ② xlsx
  let X = null
  try {
    X = createRequire(import.meta.url)('xlsx')
    pass('xlsx 模块可用（' + (X.version || '版本未知') + '）')
  } catch (e) {
    fail('xlsx 模块加载失败', String((e && e.message) || e), '在仓库根目录跑 npm install')
  }

  // ③ 表头契约
  let contract = { master: null, flow: null, contact: null }
  try {
    contract = readContract()
    const bad = []
    if (!Array.isArray(contract.master) || contract.master.length !== 31) bad.push('HEADERS_MASTER 不是 31 列')
    if (!Array.isArray(contract.flow) || contract.flow.length !== 11) bad.push('HEADERS_FLOW 不是 11 列')
    if (!Array.isArray(contract.contact) || contract.contact.length !== 5) bad.push('HEADERS_CONTACT 不是 5 列')
    if (bad.length) fail('表头契约可读（lib/sales-lib.js）', bad.join('；'), '确认 lib/sales-lib.js 完整、HEADERS_* 常量未被改动')
    else pass('表头契约可读（31 / 11 / 5 列）')
  } catch (e) {
    fail('表头契约可读（lib/sales-lib.js）', String((e && e.message) || e), '确认 lib/sales-lib.js 存在且完整')
  }
  const contractOk = Array.isArray(contract.master) && Array.isArray(contract.flow) && Array.isArray(contract.contact)

  // ④ 配置档（用 --data-dir / SALE_DIR 时允许没有配置档；只有依赖配置档解析时才必须存在）
  if (!cfg.exists) {
    if (source === '--data-dir 参数' || source === ENV_DATA_DIR + ' 环境变量') {
      pass('未使用配置档（数据目录来自 ' + source + '）')
    } else {
      fail('配置档不存在：' + cfg.file, '', '先跑 node scripts/setup.mjs 初始化（或设置环境变量 DSH_SALES_CONFIG）')
    }
  } else if (cfg.error) {
    fail('配置档无法解析：' + cfg.file, cfg.error, '修好这个 JSON 文件（里面只该有配置，没有客户数据）')
  } else {
    pass('配置档可解析：' + cfg.file)
  }

  // ⑤ 数据目录配置（相对路径不算「已配置」：它会随工作目录漂移）
  const rawArg = String(args.dataDir || '').trim()
  const rawEnv = String(process.env[ENV_DATA_DIR] || '').trim()
  const rawInput = rawArg || rawEnv
  const relInput = rawInput ? !path.isAbsolute(expandHome(rawInput)) : false
  if (relInput) {
    fail('数据目录必须是绝对路径', rawInput, '--data-dir 与 SALE_DIR 都必须是绝对路径，例如 <你的数据目录>')
  } else if (source === '默认目录') {
    fail('数据目录未配置', '当前只能兜底用默认目录 ' + dataDir, '跑 node scripts/setup.mjs --data-dir <绝对路径>，或设置 SALE_DIR')
  } else if (!path.isAbsolute(dataDir)) {
    fail('数据目录不是绝对路径', dataDir, '配置档 dataDir 与 SALE_DIR 都必须是绝对路径')
  } else {
    pass('数据目录已配置（来源：' + source + '）', dataDir)
  }

  // ⑥ 数据目录存在
  let dirExists = false
  try { dirExists = fs.statSync(dataDir).isDirectory() } catch (e) { dirExists = false }
  if (dirExists) pass('数据目录存在', dataDir)
  else fail('数据目录不存在', dataDir, '跑 node scripts/setup.mjs --data-dir "' + dataDir + '"')

  // ⑦ ~ ⑪ 两张表与表头
  const masterPath = path.join(dataDir, MASTER_FILE)
  const flowPath = path.join(dataDir, FLOW_FILE)
  const masterExists = fs.existsSync(masterPath)
  const flowExists = fs.existsSync(flowPath)

  if (masterExists) pass(MASTER_FILE + ' 存在')
  else fail(MASTER_FILE + ' 不存在', masterPath, '跑 node scripts/setup.mjs 建空表（会保留已有数据）')

  if (!masterExists) {
    fail('主表 sheet「客户主表」表头', '主表文件不存在，跳过', '')
    fail('主表 sheet「联系人」表头', '主表文件不存在，跳过', '')
  } else if (!X || !contractOk) {
    fail('主表 sheet「客户主表」表头', 'xlsx 或表头契约不可用，跳过', '')
    fail('主表 sheet「联系人」表头', 'xlsx 或表头契约不可用，跳过', '')
  } else {
    try {
      const r = readSheetHeader(X, masterPath, '客户主表')
      if (!r.ok) fail('主表 sheet「客户主表」表头', r.error, '用 Excel 检查工作表名，别重命名 sheet')
      else {
        const d = diffHeaders(contract.master, r.header)
        if (d) fail('主表 sheet「客户主表」表头与契约一致', d, '列名是数据契约，改回契约列名（可用 setup 生成的新表对照）')
        else pass('主表 sheet「客户主表」表头与契约一致（31 列）')
      }
    } catch (e) {
      fail('主表 sheet「客户主表」表头', '读表失败：' + String((e && e.message) || e), '确认文件是有效的 .xlsx（没被占用/损坏）')
    }
    try {
      const r = readSheetHeader(X, masterPath, '联系人')
      if (!r.ok) fail('主表 sheet「联系人」表头', r.error, '用 Excel 检查工作表名，别重命名 sheet')
      else {
        const d = diffHeaders(contract.contact, r.header)
        if (d) fail('主表 sheet「联系人」表头与契约一致', d, '列名是数据契约，改回契约列名')
        else pass('主表 sheet「联系人」表头与契约一致（5 列）')
      }
    } catch (e) {
      fail('主表 sheet「联系人」表头', '读表失败：' + String((e && e.message) || e), '')
    }
  }

  if (flowExists) pass(FLOW_FILE + ' 存在')
  else fail(FLOW_FILE + ' 不存在', flowPath, '跑 node scripts/setup.mjs 建空表（会保留已有数据）')

  if (!flowExists) fail('流水表 sheet「跟进流水」表头', '流水表文件不存在，跳过', '')
  else if (!X || !contractOk) fail('流水表 sheet「跟进流水」表头', 'xlsx 或表头契约不可用，跳过', '')
  else {
    try {
      const r = readSheetHeader(X, flowPath, '跟进流水')
      if (!r.ok) fail('流水表 sheet「跟进流水」表头', r.error, '用 Excel 检查工作表名，别重命名 sheet')
      else {
        const d = diffHeaders(contract.flow, r.header)
        if (d) fail('流水表 sheet「跟进流水」表头与契约一致', d, '列名是数据契约，改回契约列名')
        else pass('流水表 sheet「跟进流水」表头与契约一致（11 列）')
      }
    } catch (e) {
      fail('流水表 sheet「跟进流水」表头', '读表失败：' + String((e && e.message) || e), '确认文件是有效的 .xlsx（没被占用/损坏）')
    }
  }

  // ⑫ logs 可写
  const logsDir = path.join(dataDir, 'logs')
  const probe = path.join(logsDir, '.doctor-probe-' + process.pid + '.tmp')
  try {
    if (!fs.existsSync(logsDir)) throw new Error('目录不存在：' + logsDir)
    fs.writeFileSync(probe, 'doctor probe\n', 'utf8')
    const back = fs.readFileSync(probe, 'utf8')
    fs.unlinkSync(probe)
    if (!back.includes('doctor probe')) throw new Error('写入后读回内容不一致')
    pass('logs/ 目录可写')
  } catch (e) {
    try { fs.unlinkSync(probe) } catch (e2) { /* noop */ }
    fail('logs/ 目录不可写', String((e && e.message) || e), '检查目录权限，或跑 node scripts/setup.mjs 重建骨架')
  }

  // ⑬ 营销资料库语料（递归子目录）
  const corpusDir = path.join(dataDir, '营销资料库')
  let corpus = []
  try { corpus = listCorpus(corpusDir) } catch (e) { corpus = [] }
  if (corpus.length > 0) pass('营销资料库有 ' + corpus.length + ' 个可检索语料文件')
  else fail('营销资料库没有可检索语料', corpusDir, '跑 node scripts/setup.mjs 会从 templates/ 补示例语料（不会覆盖你的文件）')

  // ⑭ 仓库模板语料
  const missing = []
  for (const f of TEMPLATE_REQUIRED) if (!fs.existsSync(path.join(TEMPLATE_DIR, f))) missing.push(f)
  let tipCount = 0
  try {
    const tips = JSON.parse(fs.readFileSync(path.join(TEMPLATE_DIR, '销售技巧-结构化.json'), 'utf8'))
    if (Array.isArray(tips)) tipCount = tips.length
    else missing.push('销售技巧-结构化.json 不是数组')
  } catch (e) {
    if (!missing.includes('销售技巧-结构化.json')) missing.push('销售技巧-结构化.json 解析失败')
  }
  if (!missing.length && tipCount >= 10) pass('示例语料完整（3 篇 md + 结构化 ' + tipCount + ' 条）')
  else fail('示例语料不完整（templates/营销资料库）', missing.length ? '缺：' + missing.join('、') : '结构化语料不足 10 条（当前 ' + tipCount + ' 条）', '从仓库重新拉取 templates/ 目录')

  // ⑮ lib/sales-lib.js 语法检查（根 package.json 是 ESM，lib/package.json 声明 commonjs）
  const syntax = spawnSync(process.execPath, ['--check', LIB_FILE], { encoding: 'utf8' })
  if (syntax.status === 0) {
    pass('lib/sales-lib.js 语法检查通过（node --check）')
  } else {
    const why = String(syntax.stderr || '').trim().split(/\r?\n/).slice(0, 3).join(' ')
    fail('lib/sales-lib.js 语法检查失败', why, '确认 lib/ 完整，且 lib/package.json 里是 "type": "commonjs"')
  }

  // ⑯ 数据层冒烟：在系统临时目录跑 init + check（不碰用户数据目录，跑完删掉）
  let smokeDir = ''
  try {
    smokeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sales-doctor-'))
    const init = spawnSync(process.execPath, [LIB_FILE, 'init', '--dir', smokeDir], { encoding: 'utf8' })
    const initOut = parseLastJson(init.stdout)
    const chk = spawnSync(process.execPath, [LIB_FILE, 'check', '--dir', smokeDir], { encoding: 'utf8' })
    const chkOut = parseLastJson(chk.stdout)
    const problems = chkOut && Array.isArray(chkOut.problems) ? chkOut.problems : null
    if (init.status === 0 && initOut && initOut.ok === true && chk.status === 0 && chkOut && chkOut.ok === true && problems && problems.length === 0) {
      pass('数据层冒烟通过（临时目录 init + check 退出 0，problems 空）')
    } else {
      const why = [
        'init 退出码 ' + init.status,
        'check 退出码 ' + chk.status,
        problems === null ? 'check 输出不是合法 JSON' : 'problems ' + problems.length + ' 条',
      ].join('；')
      fail('数据层冒烟失败（临时目录 init + check）', why, '确认已在仓库根目录跑 npm install（xlsx），再手动跑 node lib/sales-lib.js check --dir <临时目录> 看完整报错')
    }
  } catch (e) {
    fail('数据层冒烟失败（临时目录 init + check）', String((e && e.message) || e), '确认系统临时目录可写')
  } finally {
    if (smokeDir) { try { fs.rmSync(smokeDir, { recursive: true, force: true }) } catch (e) { /* noop */ } }
  }

  // ----- 打印 -----
  const okCount = results.filter((r) => r.ok).length
  const badCount = results.length - okCount
  console.log('')
  console.log('AI-CRM 客资管理系统 · 自检（只读）')
  console.log('─'.repeat(64))
  console.log('数据目录：' + dataDir)
  console.log('解析来源：' + source)
  console.log('配置档　：' + cfg.file)
  console.log('─'.repeat(64))
  results.forEach((r, i) => {
    const no = String(i + 1).padStart(2, ' ')
    console.log((r.ok ? '[OK]  ' : '[FAIL]') + ' ' + no + '. ' + r.name + (r.detail ? '｜' + r.detail : ''))
    if (!r.ok && r.hint) console.log('         → ' + r.hint)
  })
  console.log('─'.repeat(64))
  console.log('汇总：' + okCount + ' 项通过 / ' + badCount + ' 项失败')
  if (badCount) {
    console.log('')
    console.log('有失败项：按上面每条的 → 提示修好后重跑（本脚本只读，不会自己改数据）。')
    return 1
  }
  console.log('全部通过 ✅ 可以开始用了。')
  return 0
}

let code = 1
try {
  code = main()
} catch (e) {
  console.error('[FAIL] 自检脚本自己出错了：' + String((e && e.message) || e))
  code = 1
}
process.exitCode = code
