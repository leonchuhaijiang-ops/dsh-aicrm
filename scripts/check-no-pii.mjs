#!/usr/bin/env node
// ============================================================================
// scripts/check-no-pii.mjs — 仓库隐私/品牌自检（发版前必跑，CI 里也跑）
// ============================================================================
// 为什么要有它：这份仓库是公开的。只要有一个真实手机号/邮箱/身份证/API key、
// 一条本机绝对路径、一个内部品牌词混进去，就是一次事故。所以让机器扫，别靠人眼。
//
// 扫什么（仓库根目录递归，排除 node_modules / .git / 常见构建产物；跳过二进制）：
//   · 手机号         1 开头、11 位、第二位 3-9（边界判定，避免误伤长数字）
//   · 邮箱           xxx@domain.tld（example.com / example.org / example.net 等占位域名放行）
//   · 身份证         18 位（含校验位 X）
//   · 疑似 API key   sk-* / Bearer 长 token / ghp_* / github_pat_* / AKIA*
//   · 本机绝对路径   X:\ 或 X:/ 开头的真实路径（同一行带 <占位> / 示例 / 例如 / 比如 / 你的 时放行）
//   · 私有品牌词     内部称呼与内部品牌名（清单见 BLACKLIST，源码里用 Unicode 转义写，
//                    这样扫描器不会自己命中自己）
//
// 命中即打印「文件:行号 [规则] 打码片段」并退出码 1；干净退出码 0。
//
// 用法：
//   node scripts/check-no-pii.mjs
//   node scripts/check-no-pii.mjs --root <目录>    # 扫指定目录（默认仓库根）
//   node scripts/check-no-pii.mjs --help
// ============================================================================
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

// 跳过的目录（依赖、版本库、构建产物、临时自测目录）
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'coverage',
  '.next', '.nuxt', '.cache', '.parcel-cache', 'tmp-setup-test', 'tmp-test',
])
// 跳过的文件（生成的锁文件：里面是整段 base64/哈希，既不是人写的也无法审阅）
const SKIP_FILES = new Set(['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'npm-shrinkwrap.json'])
// 二进制扩展名（先按扩展名跳，再用 NUL 字节兜底判定）
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tif', '.tiff',
  '.xlsx', '.xls', '.xlsm', '.docx', '.doc', '.pptx', '.pdf',
  '.zip', '.gz', '.tgz', '.7z', '.rar', '.tar',
  '.mp3', '.mp4', '.wav', '.webm', '.mov', '.avi',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.so', '.dll', '.exe', '.node', '.wasm', '.bin',
])
const MAX_BYTES = 2 * 1024 * 1024   // 单文件 > 2MB 跳过（语料/文档不可能这么大）

// 私有品牌词黑名单：用 \u 转义写出来，避免本文件被自己扫到。
// 需要新增时就地追加（同样用转义或字符串拼接，别写明文）。
const BLACKLIST = [
  '\u8001\u7236',                    // 内部称呼（老人家）
  '\u5c0f\u6cd3\u661f',              // 内部产品品牌
  '\u77e5\u79be',                    // 内部内容品牌
  '\u521b\u4e16',                    // 内部公司简称
  'x' + 'cy',                        // 内部模型供应商名
  'DeepSeek' + ' Harness-build',     // 本机私有工作区路径片段
  '215' + '55',                      // 本机用户名片段
]

// 邮箱占位域名白名单（文档里写示例地址是正常的）
const EMAIL_ALLOW = /@(example\.(?:com|org|net)|localhost|your-domain\.(?:com|org)|domain\.(?:com|org|net|tld)|[a-z0-9-]+\.tld)$/i

const RULES = [
  {
    id: 'phone',
    label: '手机号',
    re: /(?<![0-9])1[3-9][0-9]{9}(?![0-9])/g,
    hint: '把真实号码换成占位（如 138****0000），示例里不要出现完整号码',
  },
  {
    id: 'email',
    label: '邮箱地址',
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    filter: (m) => !EMAIL_ALLOW.test(m),
    hint: '个人邮箱换成 you@example.com 这类占位地址',
  },
  {
    id: 'idcard',
    label: '身份证号',
    re: /(?<![0-9A-Za-z])[1-9][0-9]{5}(?:19|20)[0-9]{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12][0-9]|3[01])[0-9]{3}[0-9Xx](?![0-9A-Za-z])/g,
    hint: '删掉，仓库里任何情况下都不该出现真实身份证号',
  },
  {
    id: 'secret',
    label: '疑似 API 密钥',
    re: /(?:sk-[A-Za-z0-9]{16,}|Bearer\s+[A-Za-z0-9._-]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})/g,
    hint: '密钥只放本机环境变量，绝不进仓库；若已泄露请立刻吊销',
  },
  {
    id: 'winpath',
    label: '本机绝对路径',
    re: /(?<![A-Za-z0-9+.\-])[A-Za-z]:[\\/][^\s"'`<>|]{1,}/g,
    lineAllow: /<|示例|例如|比如|你的|占位|USERPROFILE|LOCALAPPDATA/i,
    hint: '文档里的路径写成占位样式，如 <你的数据目录>/sales-data 或 C:\\示例\\数据',
  },
  {
    id: 'brand',
    label: '私有品牌词',
    // 逐行做不区分大小写的包含判断（不用正则，词表来自 BLACKLIST）
    scanLine(line, push) {
      const low = line.toLowerCase()
      for (const w of BLACKLIST) {
        const idx = low.indexOf(w.toLowerCase())
        if (idx >= 0) push(w)
      }
    },
    hint: '换成中性称呼（如「团队」「内部产品」），公开仓库不许出现内部品牌/称呼',
  },
]

// ----- 参数 ----------------------------------------------------------------

function parseArgs(argv) {
  const out = { root: ROOT, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') out.help = true
    else if (a === '--root') {
      const v = argv[++i]
      if (!v || v.startsWith('--')) throw new Error('--root 后面要跟一个目录路径')
      out.root = path.resolve(v)
    } else if (a.startsWith('--root=')) {
      out.root = path.resolve(a.slice('--root='.length))
    } else {
      throw new Error('不认识的参数：' + a + '（可用 --root / --help）')
    }
  }
  return out
}

function printHelp() {
  console.log(`仓库隐私/品牌自检

用法：
  node scripts/check-no-pii.mjs                扫仓库根目录
  node scripts/check-no-pii.mjs --root <目录>  扫指定目录
  node scripts/check-no-pii.mjs --help

规则：手机号 / 邮箱 / 身份证 / 疑似 API key / 本机绝对路径 / 私有品牌词。
命中退出码 1；干净退出码 0。`)
}

// ----- 扫描 ----------------------------------------------------------------

function walk(dir, out, stats) {
  let ents = []
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch (e) {
    stats.errors.push('目录读不了：' + dir + '（' + String((e && e.message) || e) + '）')
    return
  }
  for (const ent of ents) {
    const abs = path.join(dir, ent.name)
    if (ent.isSymbolicLink()) { stats.skipped++; continue }
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) { stats.skipped++; continue }
      walk(abs, out, stats)
      continue
    }
    if (!ent.isFile()) { stats.skipped++; continue }
    if (SKIP_FILES.has(ent.name)) { stats.skipped++; continue }
    if (BINARY_EXT.has(path.extname(ent.name).toLowerCase())) { stats.skipped++; continue }
    out.push(abs)
  }
}

function isProbablyBinary(buf) {
  const n = Math.min(buf.length, 8192)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

function mask(s) {
  const str = String(s)
  if (str.length <= 2) return '*'.repeat(str.length)
  // 保留首字符，其余打码，长度封顶，避免把原始敏感值再打回终端/CI 日志
  return str[0] + '*'.repeat(Math.min(Math.max(str.length - 1, 3), 8))
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) { printHelp(); return 0 }
  if (!fs.existsSync(args.root) || !fs.statSync(args.root).isDirectory()) {
    console.error('[FAIL] 扫描根目录不存在：' + args.root)
    return 1
  }

  const files = []
  const stats = { skipped: 0, errors: [], big: 0 }
  walk(args.root, files, stats)

  const hits = []          // {file, line, rule, label, text}
  let scanned = 0
  for (const file of files) {
    let buf
    try { buf = fs.readFileSync(file) } catch (e) {
      stats.errors.push('文件读不了：' + file + '（' + String((e && e.message) || e) + '）')
      continue
    }
    if (buf.length > MAX_BYTES) { stats.big++; continue }
    if (isProbablyBinary(buf)) { stats.skipped++; continue }
    const text = buf.toString('utf8').replace(/^\uFEFF/, '')
    const lines = text.split(/\r\n|\n|\r/)
    const rel = path.relative(args.root, file) || path.basename(file)
    scanned++
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      for (const rule of RULES) {
        if (rule.scanLine) {
          const found = []
          rule.scanLine(line, (m) => found.push(m))
          for (const m of found) hits.push({ file: rel, line: i + 1, rule: rule.id, label: rule.label, text: m })
          continue
        }
        if (rule.lineAllow && rule.lineAllow.test(line)) continue
        rule.re.lastIndex = 0
        let m
        while ((m = rule.re.exec(line)) !== null) {
          const hit = m[0]
          if (rule.filter && !rule.filter(hit)) continue
          hits.push({ file: rel, line: i + 1, rule: rule.id, label: rule.label, text: hit })
          if (m.index === rule.re.lastIndex) rule.re.lastIndex++   // 零宽匹配防御
        }
      }
    }
  }

  // ----- 输出 -----
  console.log('')
  console.log('隐私/品牌自检（check-no-pii）')
  console.log('─'.repeat(64))
  console.log('扫描根目录：' + args.root)
  console.log('扫描文件　：' + scanned + ' 个文本文件（跳过 ' + stats.skipped + ' 个目录/二进制/锁文件，' + stats.big + ' 个超大文件）')
  console.log('─'.repeat(64))

  if (stats.errors.length) {
    console.log('[WARN] 有 ' + stats.errors.length + ' 个文件/目录没扫到（可能权限问题，别当"干净"）：')
    for (const e of stats.errors.slice(0, 10)) console.log('       - ' + e)
  }

  if (!hits.length) {
    console.log('[OK] 没有命中任何隐私/品牌规则，仓库可以公开。')
    return 0
  }

  // 按规则分组统计
  const byRule = new Map()
  for (const h of hits) byRule.set(h.label, (byRule.get(h.label) || 0) + 1)
  console.log('[FAIL] 命中 ' + hits.length + ' 处：' + Array.from(byRule, ([k, v]) => k + ' ' + v + ' 处').join('、'))
  console.log('')

  const DETAIL_LIMIT = 60
  for (const h of hits.slice(0, DETAIL_LIMIT)) {
    console.log('  ' + h.file + ':' + h.line + '  [' + h.label + '] ' + mask(h.text))
  }
  if (hits.length > DETAIL_LIMIT) {
    console.log('  …（仅显示前 ' + DETAIL_LIMIT + ' 条，共 ' + hits.length + ' 条）')
  }

  console.log('')
  console.log('怎么修：真实信息一律删掉或换占位；示例用 138****0000 / you@example.com / <你的目录>。')
  console.log('误报：确认是占位符后，把该行改成含 < > / 示例 / 例如 / 比如 的写法，或按需调整本脚本规则。')
  for (const rule of RULES) if (byRule.has(rule.label)) console.log('  · ' + rule.label + '：' + rule.hint)
  return 1
}

let code = 1
try {
  code = main()
} catch (e) {
  console.error('[FAIL] 扫描脚本自己出错了：' + String((e && e.message) || e))
  code = 1
}
process.exitCode = code
