#!/usr/bin/env node
/**
 * 数据隔断检查：保证「工具」与「数据」在物理上分开。
 *
 *   npm run check-no-data
 *
 * 两类检查，任一命中即失败（退出码 1）：
 *   1. git 已跟踪的文件里出现数据/配置/日志扩展名 → 说明有东西被强行提交进仓库；
 *   2. 仓库工作区内（不含 node_modules/.git）直接放着 Excel/CSV/合同/备份 → 说明数据目录被放进了仓库。
 *
 * 用途：CI 与本地都能跑。CI 里跑它，是为了防「钩子被跳过」或「有人改 .gitignore」。
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATA_EXT = /\.(xlsx|xls|xlsm|xlsb|csv|tsv|docx|doc|log|bak)$/i
const DATA_NAME = /^(sales\.config\.json|\.env(\..+)?)$/i
const SKIP_DIRS = new Set(['node_modules', '.git', '.github', 'dist', 'build', 'coverage'])

const problems = []

// 1) git 跟踪面
let tracked = []
try {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
  tracked = out.split('\0').filter(Boolean)
} catch {
  console.log('[WARN] 不是 git 仓库（或没装 git），跳过「已跟踪文件」检查。')
}

for (const f of tracked) {
  if (DATA_EXT.test(f) || DATA_NAME.test(path.basename(f))) {
    problems.push(`已跟踪的数据/配置文件：${f}`)
  }
}

// 2) 工作区物理面
function walk(dir, rel = '') {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name)
      continue
    }
    if (!e.isFile()) continue
    const r = rel ? `${rel}/${e.name}` : e.name
    if (DATA_EXT.test(e.name) || DATA_NAME.test(e.name)) {
      // 允许 4 份示例语料的 .md/.json；这里只挡数据类扩展名
      let size = 0
      try { size = statSync(path.join(dir, e.name)).size } catch {}
      problems.push(`仓库工作区内有数据类文件：${r}（${size} 字节）`)
    }
  }
}
walk(ROOT, '')

if (problems.length) {
  console.error('✗ 数据隔断检查未通过：')
  for (const p of problems) console.error('  · ' + p)
  console.error('')
  console.error('  处理方式：把数据目录移到仓库外面（看板「⚙ 设置」或 docs/install.md 第 3 节），')
  console.error('  不要让本仓库变成数据存放地。')
  process.exit(1)
}

console.log(`[OK] 数据隔断检查通过（已跟踪 ${tracked.length} 个文件；工作区无数据类文件）。`)
