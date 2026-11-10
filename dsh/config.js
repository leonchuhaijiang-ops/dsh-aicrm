// ============================================================================
// dsh/config.js — 配置与数据目录解析（开源版）
// ============================================================================
// 为什么要这个文件：原版把「数据目录」写死在源码里（形如 `process.env.SALE_DIR || '<某个固定绝对路径>'`），
//   换一台机器 / 换一个人用，就得改源码。开源版把它抽成**配置**：
//     ① 数据目录（客户表、流水表、营销资料库、合同、日志都在这一个目录下）
//     ② 模型通道（跟随会话模型 / 指定模型 / 本机 Ollama）
//   两者都能通过「看板首次设置向导」或 `scripts/setup.mjs` 写好，源码里不再出现任何本机路径。
//
// 解析优先级（数据目录）：
//   SALE_DIR（环境变量，最高优先，适合容器/CI/多套数据并存）
//   → 配置文件里的 dataDir（向导写入，正常用户走这条）
//   → 默认目录 <home>/dsh-sales-data（未配置时的建议值，不会自动创建，避免"用着用着冒出个空库"）
//
// 配置文件位置：
//   DSH_SALES_CONFIG（环境变量，可指向任意路径）
//   → <home>/.dsh/sales.config.json（默认）
//   文件权限范围内只存"配置"，**绝不存客户数据**；.gitignore 已排除。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = (() => {
  if (import.meta.dirname) return import.meta.dirname
  const u = String(import.meta.url).replace(/^file:\/\/\/?/, '')
  return path.dirname(decodeURIComponent(u))
})()

// 插件根目录（package.json 所在层）。用来找 lib/sales-lib.js 与 templates/。
export const PLUGIN_ROOT = path.resolve(HERE, '..')
export const ENV_DATA_DIR = 'SALE_DIR'
export const ENV_CONFIG_FILE = 'DSH_SALES_CONFIG'
export const CONFIG_VERSION = 1
export const DEFAULT_DATA_DIR = path.join(os.homedir(), 'dsh-sales-data')
export const CONFIG_FILE = path.join(os.homedir(), '.dsh', 'sales.config.json')

export const AI_MODES = ['session', 'fixed', 'local']
export const REASONING_EFFORTS = ['', 'off', 'low', 'medium', 'high']

function expandHome(p) {
  const s = String(p == null ? '' : p).trim()
  if (!s) return ''
  if (s === '~') return os.homedir()
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(os.homedir(), s.slice(2))
  return s
}

export function configFilePath() {
  const raw = String(process.env[ENV_CONFIG_FILE] || '').trim()
  return raw ? path.resolve(expandHome(raw)) : CONFIG_FILE
}

export function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    dataDir: '',
    ai: {
      // session = 跟随当前会话模型（零配置、零 API key，推荐默认）
      // fixed   = 固定用某个 provider/model（用户在 DSH 里已配好的任意 provider）
      // local   = 本机 Ollama（数据不出机，但小模型能力有限）
      mode: 'session',
      provider: '',
      model: '',
      reasoningEffort: '',
      local: { provider: 'local', model: '' },
    },
    features: { rag: true },
    profile: { company: '', product: '' },
  }
}

function str(v, max) {
  const s = String(v == null ? '' : v).trim()
  return s.length > max ? s.slice(0, max) : s
}

// 把外部输入（配置文件 / HTTP 请求）归一成合法配置；不认识的键丢掉，坏值回落默认。
export function normalizeConfig(raw) {
  const d = defaultConfig()
  const r = (raw && typeof raw === 'object') ? raw : {}
  const ai = (r.ai && typeof r.ai === 'object') ? r.ai : {}
  const feat = (r.features && typeof r.features === 'object') ? r.features : {}
  const prof = (r.profile && typeof r.profile === 'object') ? r.profile : {}
  const loc = (ai.local && typeof ai.local === 'object') ? ai.local : {}
  const mode = AI_MODES.includes(String(ai.mode || '').trim()) ? String(ai.mode).trim() : d.ai.mode
  const effort = REASONING_EFFORTS.includes(String(ai.reasoningEffort == null ? '' : ai.reasoningEffort).trim())
    ? String(ai.reasoningEffort == null ? '' : ai.reasoningEffort).trim()
    : ''
  const dataDirRaw = expandHome(r.dataDir)
  return {
    version: CONFIG_VERSION,
    // 只接受绝对路径：相对路径会随"从哪个目录启动 DSH"漂移，是静默故障源
    dataDir: dataDirRaw && path.isAbsolute(dataDirRaw) ? path.normalize(dataDirRaw) : '',
    ai: {
      mode,
      provider: str(ai.provider, 120),
      model: str(ai.model, 160),
      reasoningEffort: effort,
      local: { provider: str(loc.provider, 120) || d.ai.local.provider, model: str(loc.model, 160) },
    },
    features: { rag: feat.rag === undefined ? true : !!feat.rag },
    profile: { company: str(prof.company, 120), product: str(prof.product, 120) },
  }
}

export function readConfig() {
  const file = configFilePath()
  let exists = false
  let raw = null
  let error = ''
  try {
    exists = fs.existsSync(file)
    if (exists) raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    error = '配置文件读不出来（按未配置处理）：' + String((e && e.message) || e)
  }
  return { config: normalizeConfig(raw), file, exists, error, rawExists: exists && !error }
}

export function getConfig() { return readConfig().config }

// 浅合并写入（只覆盖传进来的键），原子写：临时文件 + rename，写坏不覆盖好的那份。
export function saveConfig(patch) {
  const cur = getConfig()
  const next = normalizeConfig({
    ...cur,
    ...(patch || {}),
    ai: { ...cur.ai, ...((patch && patch.ai) || {}), local: { ...cur.ai.local, ...((patch && patch.ai && patch.ai.local) || {}) } },
    features: { ...cur.features, ...((patch && patch.features) || {}) },
    profile: { ...cur.profile, ...((patch && patch.profile) || {}) },
  })
  const file = configFilePath()
  const tmp = file + '.' + process.pid + '.tmp'
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
    fs.renameSync(tmp, file)
    return { ok: true, config: next, file }
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch (e2) { /* noop */ }
    return { ok: false, error: '配置写不进去：' + String((e && e.message) || e), config: cur, file }
  }
}

export function dataDirSource() {
  if (String(process.env[ENV_DATA_DIR] || '').trim()) return 'env'
  if (readConfig().config.dataDir) return 'config'
  return 'default'
}

export function resolveDataDir() {
  const envRaw = String(process.env[ENV_DATA_DIR] || '').trim()
  if (envRaw) return path.resolve(expandHome(envRaw))
  const cfgDir = readConfig().config.dataDir
  if (cfgDir) return cfgDir
  return DEFAULT_DATA_DIR
}

// 是否已配置：环境变量给了、或配置文件里写了 dataDir —— 都算。
// 未配置时插件不猜目录、不建空库，而是让看板弹「首次设置」。
export function isConfigured() {
  return dataDirSource() !== 'default'
}

// 数据层脚本位置：开源布局在 <插件根>/lib/sales-lib.js；
// 兼容"数据目录里自带一份 sales-lib.js"的旧布局（迁移期用，找到就用）。
export function salesLibPath(dir) {
  const candidates = [
    path.join(PLUGIN_ROOT, 'lib', 'sales-lib.js'),
    dir ? path.join(dir, 'sales-lib.js') : '',
  ].filter(Boolean)
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c } catch (e) { /* noop */ }
  }
  return ''
}

export function dataDirExists(dir) {
  try { return !!dir && fs.statSync(dir).isDirectory() } catch (e) { return false }
}

// 模型通道：给 ai.js 用。返回"这次调用该走谁"的策略（不碰任何 API key ——
//   key 始终由宿主 DSH 的 provider 配置持有，插件只按 provider/model 名字要模型）。
export function aiPolicy() {
  const cfg = readConfig().config
  const ai = cfg.ai
  const fixed = !!(ai.provider && ai.model)
  return {
    enabled: true,
    mode: ai.mode,
    provider: ai.provider,
    model: ai.model,
    label: fixed ? ai.provider + '/' + ai.model : '',
    reasoningEffort: ai.reasoningEffort,
    local: { provider: ai.local.provider || 'local', model: ai.local.model },
    rag: cfg.features.rag,
    profile: cfg.profile,
    file: readConfig().file,
  }
}

// 看板/向导共用的配置视图：只回"配置是什么样"，不回客户数据。
export function configStatus() {
  const r = readConfig()
  const dir = resolveDataDir()
  const source = dataDirSource()
  return {
    ok: true,
    configured: source !== 'default',
    source,                       // env / config / default
    configFile: r.file,
    configExists: r.exists,
    configError: r.error,
    dataDir: dir,
    dataDirExists: dataDirExists(dir),
    defaultDataDir: DEFAULT_DATA_DIR,
    ai: {
      mode: r.config.ai.mode,
      provider: r.config.ai.provider,
      model: r.config.ai.model,
      reasoningEffort: r.config.ai.reasoningEffort,
      local: r.config.ai.local,
    },
    features: r.config.features,
    profile: r.config.profile,
    rev: 'oss-1',
  }
}
