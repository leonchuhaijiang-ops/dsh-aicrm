// 集成冒烟（CI 也跑）：不启动 DSH，用假 ctx 加载 dsh/index.js，走 HTTP 路由验证
// 「未配置 → 写配置 → 初始化数据目录 → 看板读数据 → 写跟进 → 模型探活」整条闭环。
// 用法：node scripts/smoke.mjs        （需要本仓库已 npm install；不需要 DSH 宿主）
// 退出码：0 全过 / 1 有失败。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sales-smoke-'))
const dataDir = path.join(tmp, 'my-sales-data')
const cfgFile = path.join(tmp, 'sales.config.json')
process.env.DSH_SALES_CONFIG = cfgFile
delete process.env.SALE_DIR

// 1) 桩：@deepseek-ai/dsh-tools（只为让 import 通过；宿主里由运行时包供给）
const stubDir = path.join(ROOT, 'node_modules', '@deepseek-ai', 'dsh-tools')
fs.mkdirSync(stubDir, { recursive: true })
fs.writeFileSync(path.join(stubDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-tools', version: '0.0.0-stub', type: 'module', main: 'index.js', exports: { '.': './index.js' } }))
fs.writeFileSync(path.join(stubDir, 'index.js'), 'export function defineTool(spec) { return spec }\n')

let pass = 0
let fail = 0
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log('  [OK] ' + msg) }
  else { fail++; console.log('  [FAIL] ' + msg + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))) }
}

const mod = await import('file://' + path.join(ROOT, 'dsh/index.js').replace(/\\/g, '/'))
console.log('模块导出:', Object.keys(mod).join(', '))

// 2) 假 ctx
const tools = []
let route = null
const shell = {
  resolve: (req) => req,
  execute: async (spec) => {
    const r = spawnSync(spec.command, { shell: true, cwd: spec.workdir, input: spec.stdin, encoding: 'utf8', timeout: 60000 })
    return { result: async () => ({ exitCode: r.status, stdout: { text: r.stdout || '' }, stderr: { text: r.stderr || '' } }) }
  },
}
const services = {
  shell,
  sandboxPolicy: { resolve: (o) => ({ mode: (o && o.mode) || 'danger-full-access' }) },
  llm: { stream: () => ({ async *[Symbol.asyncIterator]() { yield { type: 'text-delta', text: 'ok' } } }) },
  agentDefaultModel: { currentSelection: () => ({ provider: 'stub-provider', model: 'stub-model' }) },
}
const ctx = {
  shell,
  sandboxPolicy: services.sandboxPolicy,
  get: (id) => services[id],
  tools: { register: (t) => { tools.push(t); return () => {} } },
  webServer: { register: (r) => { route = r; return () => {} } },
}
const dispose = mod.apply(ctx, {})
console.log('注册工具数:', tools.length, '| 路由:', route && route.path)
ok(route && route.kind === 'prefix' && route.path === '/sales', '路由已注册 /sales')
ok(tools.length === 16, '注册 16 个工具（含 sales_profile）', tools.length)

// 3) 假 req/res
async function call(method, url, body) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  const req = {
    method,
    url,
    headers: {},
    async *[Symbol.asyncIterator]() { if (payload) yield Buffer.from(payload) },
    on: () => {},
  }
  const out = { code: 0, headers: null, body: '' }
  const res = {
    writeHead: (code, headers) => { out.code = code; out.headers = headers },
    write: (s) => { out.body += String(s) },
    end: (s) => { if (s !== undefined) out.body += String(s) },
  }
  await route.handler(req, res)
  let json = null
  try { json = JSON.parse(out.body) } catch (e) { json = null }
  return { code: out.code, json, raw: out.body }
}

console.log('\n[1] 未配置时：/sales/config')
let r = await call('GET', '/sales/config')
ok(r.code === 200 && r.json && r.json.data && r.json.data.configured === false, '未配置 → configured:false', r.json)
ok(r.json && r.json.data && typeof r.json.data.defaultDataDir === 'string' && path.isAbsolute(r.json.data.defaultDataDir), '默认目录是绝对路径', r.json && r.json.data.defaultDataDir)

console.log('\n[2] 未配置时：看板拉数据应给 UNCONFIGURED 而不是崩')
r = await call('GET', '/sales/overview')
ok(r.code === 200 && r.json && r.json.ok === false && r.json.code === 'UNCONFIGURED', 'overview 返回 code:UNCONFIGURED', r.json)

console.log('\n[3] 相对路径应被拒绝')
r = await call('POST', '/sales/configset', { dataDir: 'my-sales-data' })
ok(r.json && r.json.ok === false && /绝对路径/.test(r.json.error || ''), '相对路径 → 明确报错', r.json)

console.log('\n[4] 写合法配置')
r = await call('POST', '/sales/configset', { dataDir, ai: { mode: 'session' }, features: { rag: true }, profile: { company: '示例科技', product: '示例 CRM' } })
ok(r.json && r.json.ok === true && r.json.data.configured === true, 'configset 成功', r.json && r.json.error)
ok(fs.existsSync(cfgFile), '配置文件已写入 ' + cfgFile)
const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
ok(cfg.dataDir === dataDir, '配置里 dataDir 正确', cfg.dataDir)

console.log('\n[5] 初始化数据目录 /sales/setup')
r = await call('POST', '/sales/setup', {})
ok(r.json && r.json.ok === true, 'setup 成功', r.json && r.json.error)
const setup = (r.json && r.json.data) || {}
ok(fs.existsSync(path.join(dataDir, '销售客户-主表.xlsx')), '主表已创建')
ok(fs.existsSync(path.join(dataDir, '销售客户-流水表.xlsx')), '流水表已创建')
ok(fs.existsSync(path.join(dataDir, 'logs')) && fs.existsSync(path.join(dataDir, '合同')), '目录骨架已建')
ok(setup.seed && setup.seed.ok !== false, '示例语料复制结果: ' + JSON.stringify(setup.seed))

console.log('\n[6] 幂等：再 setup 一次不覆盖')
r = await call('POST', '/sales/setup', {})
ok(r.json && r.json.ok === true && Array.isArray(r.json.data.kept) && r.json.data.kept.length >= 2, '第二次 setup → kept 非空', r.json && r.json.data && r.json.data.kept)

console.log('\n[7] 已配置时：看板读数据')
r = await call('GET', '/sales/config')
ok(r.json && r.json.data.configured === true && r.json.data.dataDirExists === true, 'config → configured+exists', r.json && r.json.data)
r = await call('GET', '/sales/overview')
ok(r.json && r.json.ok === true && r.json.data && r.json.data.total === 0, 'overview 读到空库', r.json && (r.json.error || r.json.data))
r = await call('GET', '/sales/summary')
ok(r.json && r.json.ok === true && r.json.data && r.json.data.total === 0, 'summary total=0', r.json && r.json.error)

console.log('\n[8] 写读闭环：sales_log 工具（首触，写流水 + 主表）')
const toolLog = tools.find((t) => t && (t.name === 'sales_log' || (t.id && String(t.id).includes('log'))))
ok(!!toolLog, '找到 sales_log 工具', tools.map((t) => t && t.name))
let cid = null
if (toolLog) {
  // 手工造一条客户行：直接调数据层 add
  const lib = path.join(ROOT, 'lib', 'sales-lib.js')
  const add = spawnSync(process.execPath, [lib, 'run', '--dir', dataDir], {
    input: JSON.stringify({ cmd: 'add', args: [{ company: '测试客户A', name: '张工', phone: '1' + '3800000000', level: 'B', status: '待首触', stage: '线索获取' }] }),
    encoding: 'utf8',
  })
  let addJson = null
  try { addJson = JSON.parse(add.stdout) } catch (e) {}
  ok(addJson && addJson.ok === true, '数据层 add 建了一条客户', (addJson && (addJson.message || addJson.error)) || add.stderr.slice(0, 200))
  cid = addJson && ((addJson.data && (addJson.data.id || addJson.data.customerId)) || addJson.id)
  if (cid) {
    const w = await toolLog.execute({ id: cid, date: '2026-11-10', type: '首触', method: '电话', what: '冒烟测试：打通一次', react: '有意向', stage: '客户触达' })
    ok(w && w.ok === true, 'sales_log 写入成功', w && (w.error || (w.data && w.data.ok === false && w.data.message)))
  }
  r = await call('GET', '/sales/summary')
  ok(r.json && r.json.ok === true && r.json.data && r.json.data.total >= 1, '写完 summary total>=1', r.json && r.json.data && r.json.data.total)
}

console.log('\n[8b] 其他跟进记录桶：归不进 SOP 节点的跟进有地方放')
if (toolLog && cid) {
  const toolSop = tools.find((t) => t && t.name === 'sales_sop')
  const wb = await toolLog.execute({ id: cid, date: '2026-11-10', method: '微信', type: '客户反馈', what: '随口聊了聊行业，没有谈到具体环节' , stage: '其他跟进记录' })
  const wbd = (wb && wb.data) || wb || {}
  ok(wbd.ok === true && wbd.stageBucket === '其他跟进记录' && wbd.stage === '', '显式落「其他跟进记录」：阶段留空 + 回执带 stageBucket', wbd)
  const sp = await toolSop.execute({ id: cid })
  const spd = (sp && sp.data) || sp || {}
  ok(!!(spd.sop && spd.sop.unlabeledLabel === '其他跟进记录' && spd.sop.unlabeled.length === 1), 'SOP 返回 unlabeledLabel=其他跟进记录 且收下这 1 条', spd.sop && { label: spd.sop.unlabeledLabel, n: spd.sop.unlabeled.length })
  ok(!!(spd.sop && spd.sop.stages.every((x) => x.count === 0 || x.stage === '客户触达')), '这条记录没把主表当前阶段推走', spd.sop && spd.sop.stages.filter((x) => x.count).map((x) => x.stage))
}

console.log('\n[9] 模型通道状态与探活')
r = await call('GET', '/sales/config')
ok(r.json && r.json.data && r.json.data.ai && r.json.data.ai.mode === 'session', 'ai.mode=session', r.json && r.json.data && r.json.data.ai)
r = await call('POST', '/sales/configtest', {})
ok(r.json && r.json.data && r.json.data.ok === true, 'configtest 走通假 llm', r.json)

console.log('\n[10] /sales/egress 诊断')
r = await call('GET', '/sales/egress')
ok(r.json && r.json.ok === true && r.json.data && r.json.data.workdir === dataDir, 'egress.workdir = 数据目录', r.json && r.json.data && r.json.data.workdir)

console.log('\n[11] RAG 状态（示例语料）')
r = await call('GET', '/sales/egress')
const rag = r.json && r.json.data && r.json.data.rag
ok(rag && rag.ok === true && (rag.chunks || 0) > 0, 'RAG 装载了示例语料: ' + JSON.stringify(rag && { chunks: rag.chunks, sources: rag.sources, enabled: rag.enabled }))

console.log('\n[12] 示例数据 demo：seed → 幂等 → clean 只删自己')
// 口径：demo 只认登记过的 DEMO-001~003；clean 之后总量必须回到 seed 之前（真实数据一条不少）
r = await call('GET', '/sales/summary')
const totalBeforeDemo = (r.json && r.json.data && r.json.data.total) || 0
r = await call('POST', '/sales/demo', { mode: 'seed' })
ok(r.json && r.json.ok === true && r.json.data && r.json.data.created === 3, 'demo seed 生成 3 条示例客户', r.json && (r.json.error || r.json.data))
r = await call('POST', '/sales/demo', { mode: 'seed' })
ok(r.json && r.json.ok === true && r.json.data && r.json.data.already === true, 'demo 重复 seed 幂等（不重复写）', r.json && (r.json.error || r.json.data))
r = await call('GET', '/sales/summary')
ok(r.json && r.json.data && r.json.data.total === totalBeforeDemo + 3, 'seed 后总量 +3', r.json && r.json.data && r.json.data.total)
r = await call('GET', '/sales/demo')
ok(r.code === 405, 'GET /sales/demo 被拒（只收 POST）', r.code)
r = await call('POST', '/sales/demo', { mode: 'clean' })
ok(r.json && r.json.ok === true && r.json.data && r.json.data.removed === 3, 'demo clean 删了 3 条示例', r.json && (r.json.error || r.json.data))
r = await call('GET', '/sales/summary')
ok(r.json && r.json.data && r.json.data.total === totalBeforeDemo, 'clean 后总量回到 seed 前（真实客户没动）', r.json && r.json.data && r.json.data.total)

console.log('\n[13] 全库 SOP 归位审计 + 历史补阶段（默认不猜）')
const libEntry = path.join(ROOT, 'lib', 'sales-lib.js')
const toolSop13 = tools.find((t) => t && t.name === 'sales_sop')
const runLib = (payload) => {
  const r = spawnSync(process.execPath, [libEntry, 'run', '--dir', dataDir], { input: JSON.stringify(payload), encoding: 'utf8' })
  try { return JSON.parse(String(r.stdout || '').trim()) } catch (e) { return { ok: false, raw: String(r.stdout || '').slice(0, 300), stderr: String(r.stderr || '').slice(0, 300) } }
}
if (toolLog && cid) {
  // 造一条「阶段为空但内容能判出来」的记录：显式落桶 + 正文写"报价"
  await toolLog.execute({ id: cid, date: '2026-11-10', method: '微信', type: '客户反馈', what: '发了报价单和年度框架条款', stage: '其他跟进记录' })
  const sp = await toolSop13.execute({ id: cid })
  const spd = (sp && sp.data) || sp || {}
  const cov = spd.sop && spd.sop.coverage
  ok(!!(cov && cov.follows === cov.staged + cov.unlabeled && cov.ok === true), 'SOP 带 coverage 且 跟进=段内+桶', cov)
  const dry = runLib({ cmd: 'backfillstage', args: [{ mode: 'dry' }] })
  ok(dry.ok === true && dry.infer === 'type' && dry.fillable === 0, '补阶段默认只认类型硬映射（这几条不猜）', { infer: dry.infer, fillable: dry.fillable })
  const dryc = runLib({ cmd: 'backfillstage', args: [{ mode: 'dry', infer: 'content' }] })
  ok(dryc.ok === true && dryc.fillable >= 1, '--infer content 能判出"发了报价单"这条', { fillable: dryc.fillable, byStage: dryc.byStage })
  const ap = runLib({ cmd: 'backfillstage', args: [{ mode: 'apply', infer: 'content' }] })
  ok(ap.ok === true && ap.applied >= 1, 'apply 只写阶段列', { applied: ap.applied })
  const sp2 = await toolSop13.execute({ id: cid })
  const s2 = (sp2 && sp2.data) || sp2 || {}
  const quote = (s2.sop && s2.sop.stages || []).find((x) => x.stage === '方案报价')
  ok(!!(quote && quote.count >= 1), '补完后这条进了「方案报价」段，桶里少一条', { quote: quote && quote.count, cov: s2.sop && s2.sop.coverage })
  const au = runLib({ cmd: 'sopaudit', args: [{}] })
  ok(au.ok === true && au.totals && au.totals.ok === true && au.totals.badCount === 0, '全库审计：所有有记录的客户都归位（0 条丢）', au.totals)
}


console.log('\n[14] 1.3.0：手机号认客户 + 档案 + 归段 + AI 提炼')
if (toolLog) {
  // 另建一个客户，全程只用手机号定位（不出现客户ID）
  const phoneB = '1' + '3900000000'
  const addB = runLib({ cmd: 'add', args: [{ company: '测试客户B', name: '李工', phone: phoneB, level: 'B', status: '待首触', stage: '线索获取' }] })
  ok(addB.ok === true, 'add 建客户B（手机号 ' + phoneB + '）', addB && (addB.message || addB.error))
  const wB = await toolLog.execute({ phone: phoneB, date: '2026-11-11', type: '首触', method: '电话', what: '冒烟：按手机号记一笔，客户说下季度有预算', stage: '客户触达' })
  const wBd = (wB && wB.data) || wB || {}
  ok(wBd.ok === true, 'sales_log 只用 phone 就能写入（不需要客户ID）', wBd)
  ok(!!(wBd.frame && wBd.frame.total === 9 && Array.isArray(wBd.frame.missing)), '回执带九要素 frame（缺项清单）', wBd.frame)
  const toolView = tools.find((t) => t && t.name === 'sales_view')
  const vB = await toolView.execute({ phone: phoneB })
  const vBd = (vB && vB.data) || vB || {}
  ok(vBd.found === true && vBd.profile && vBd.profile.phone === phoneB, 'sales_view 按手机号命中，回包带 phone', vBd && { found: vBd.found, phone: vBd.profile && vBd.profile.phone })
  const flowId = (vBd.flow && vBd.flow[0] && vBd.flow[0].id) || ''
  ok(!!flowId, 'view 的 flow 里带流水ID（归段用）', flowId)

  // 客户档案：set → get/list
  r = await call('POST', '/sales/profile', { action: 'set', phone: phoneB, fields: { intro: '做工程前期咨询，主要接政府可研', industry: '咨询公司', budget: '30万内' } })
  ok(r.json && r.json.ok === true && r.json.data && r.json.data.profile && r.json.data.profile.intro.includes('政府可研'), 'profile set 写入档案', r.json && (r.json.error || r.json.data && r.json.data.action))
  r = await call('POST', '/sales/profile', { action: 'get', phone: phoneB })
  const pd = (r.json && r.json.data) || {}
  ok(pd.profile && pd.profile.industry === '咨询公司' && pd.derived && pd.derived.company === '测试客户B', 'profile get 回档案+derived', { industry: pd.profile && pd.profile.industry, derived: pd.derived })
  ok(pd.derived && pd.derived.name === '' && pd.derived.contact === '李工', 'derived.name 留空（避免「李工 / 李工」重复）', pd.derived)
  r = await call('POST', '/sales/profile', { action: 'list' })
  const pl = (r.json && r.json.data) || {}
  ok(Array.isArray(pl.profiles) && pl.profiles.length >= 1 && pl.profiles.every((x) => x.phone && x.profile), 'profile list 回 profiles[{phone,profile,derived}]', pl && { n: pl.profiles && pl.profiles.length })

  // 归段：把桶里的记录改到指定段
  const wc = await toolLog.execute({ phone: phoneB, date: '2026-11-11', method: '微信', type: '客户反馈', what: '聊了聊行业，没谈到具体环节', stage: '其他跟进记录' })
  const wcd = (wc && wc.data) || wc || {}
  ok(wcd.ok === true && wcd.stageBucket === '其他跟进记录', '显式落桶（待归段）', wcd)
  const toolSop14 = tools.find((t) => t && t.name === 'sales_sop')
  const s14 = await toolSop14.execute({ phone: phoneB })
  const s14d = (s14 && s14.data) || s14 || {}
  const bucketId = (s14d.sop && s14d.sop.unlabeled && s14d.sop.unlabeled[0] && s14d.sop.unlabeled[0].id) || ''
  ok(!!bucketId, 'SOP 的桶里能拿到待归段流水ID', bucketId)
  if (bucketId) {
    r = await call('POST', '/sales/stagefix', { phone: phoneB, flowId: bucketId, stage: '需求挖掘' })
    ok(r.json && r.json.ok === true && r.json.data && r.json.data.changed === true && r.json.data.to === '需求挖掘', 'stagefix 把一条归到「需求挖掘」', r.json && (r.json.error || r.json.data))
    const s15 = await toolSop14.execute({ phone: phoneB })
    const s15d = (s15 && s15.data) || s15 || {}
    const need = (s15d.sop && s15d.sop.stages || []).find((x) => x.stage === '需求挖掘')
    ok(!!(need && need.count >= 1 && s15d.sop.coverage.ok === true), '归段后进对应环节，coverage 仍平', { need: need && need.count, cov: s15d.sop && s15d.sop.coverage })
  }

  // AI 提炼档案：只出文字，不落盘
  r = await call('POST', '/sales/ai', { purpose: 'profile', phone: phoneB })
  const ap = (r.json && r.json.data) || {}
  ok(r.json && r.json.ok === true && ap.action === 'profile' && typeof ap.text === 'string', 'AI 提炼返回 text（不直接落盘）', { mode: ap.mode, textLen: (ap.text || '').length, error: ap.error })
  r = await call('GET', '/sales/profile')
  ok(r.code === 405, 'GET /sales/profile 被拒（写接口只收 POST）', r.code)
}

try { dispose && dispose() } catch (e) {}
console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败；临时目录 ' + tmp)
process.exit(fail ? 1 : 0)
