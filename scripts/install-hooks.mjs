#!/usr/bin/env node
/**
 * 启用本仓库自带的 git 钩子（提交前跑隐私扫描 + 数据文件兜底拦截）。
 *
 *   npm run hooks
 *
 * 只改本仓库的 git 配置（core.hooksPath），不动全局配置。
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const hook = path.join(ROOT, '.githooks', 'pre-commit')

if (!existsSync(hook)) {
  console.error('✗ 没找到 .githooks/pre-commit，仓库可能不完整。')
  process.exit(1)
}

try {
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: ROOT, stdio: 'inherit' })
} catch {
  console.error('✗ 设置 core.hooksPath 失败：确认当前目录在一个 git 仓库里。')
  process.exit(1)
}

try {
  chmodSync(hook, 0o755)
} catch {
  // Windows 上 chmod 基本是空操作，失败不影响 git 调用
}

console.log('✓ 已启用提交前检查：.githooks/pre-commit')
console.log('  它会在每次 commit 前跑 node scripts/check-no-pii.mjs，并拦截数据/配置/日志文件。')
