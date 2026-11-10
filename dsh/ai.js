// 模型出口（唯一）—— 2026-10-12 批次 1
// ============================================================================
// 铁律（doctor 出口⑧ 静态守着）：
//   ① **全插件只有这个文件允许出现 `llm.stream(`** —— 别的文件想调模型，import 这里的 aiStream。
//   ② **只走宿主进程内服务**（`ctx.llm` / ctx.get('llm')），不新增 fetch、不直连 provider、不引 API key
//      → doctor 出口⑥「插件源码零直接出网」保持绿（模型调用经宿主，不算"插件自己出网"）。
//   ③ 任何异常一律返回 `{ok:false, error}`，**绝不抛**：模型面挂了，规则版必须照常出结果（兜底）。
//   ④ 台账 `logs/ai-calls.log` 只记 purpose/模型/耗时/字数/成败 —— **不记客户原文、不记提示词**。
//
// 脱敏在调用方做（见 redact.js；prompt 构造函数里已内置一步 mask）。这里只管"调"。
// ============================================================================
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createMasker, guessIndustry, guessSize, buildTag, autoMask, looksLikeOrg, shortOrg } from './redact.js'
import { searchRag, formatSnippets } from './rag.js'

// 开源版（2026-11）：目录不再写死 —— 由 config.js 解析（环境变量 SALE_DIR > 配置文件 dataDir > 默认目录），
//   台账跟着数据目录走。**不缓存**：设置向导改完目录，下一次调用立刻生效。
import { aiPolicy, resolveDataDir } from './config.js'

export function aiLogPath() { return path.join(resolveDataDir(), 'logs', 'ai-calls.log') }

// 业务背景行：用户在插件设置里填的公司名/产品名，作为一段极简语境附在 system 末尾。
//   - 只作称呼与卖点参考，不覆盖调用方给的 system；
//   - 没填就什么都不加（开源默认状态，零配置也能直接用）；
//   - 每次调用现读配置，改完不用重启。
function brandLine() {
  let prof = {}
  try { prof = (aiPolicy() || {}).profile || {} } catch (e) { prof = {} }
  const parts = []
  const company = String(prof.company || '').trim()
  const product = String(prof.product || '').trim()
  if (company) parts.push('公司：' + company)
  if (product) parts.push('产品：' + product)
  return parts.length ? '【业务背景（用户在插件设置里填写的，称呼与卖点以此为准）】' + parts.join('；') : ''
}

function withBrand(system) {
  const sys = String(system == null ? '' : system).trim()
  const brand = brandLine()
  if (!brand) return sys
  return sys ? sys + '\n' + brand : brand
}
const AI_LOG_MAX = 512 * 1024
const AI_MSG_MAX = 20000        // 单条消息上限（防某条流水长文把上下文撑爆）

// 取 llm 服务：inject 声明了 'llm'，但**仍按可选处理**（宿主没装模型服务时插件必须照常跑）
export function llmOf(ctx) {
  if (!ctx) return null
  try { if (ctx.llm && typeof ctx.llm.stream === 'function') return ctx.llm } catch (e) { /* noop */ }
  try {
    const s = (typeof ctx.get === 'function') ? ctx.get('llm') : undefined
    if (s && typeof s.stream === 'function') return s
  } catch (e) { /* noop */ }
  return null
}

// 取当前对话模型：**每次现读**（用户在 GUI 上换模型，插件要跟着换，不能钉死加载时那一刻）
export function resolveModel(ctx) {
  const pick = (sel) => {
    if (!sel) return null
    const prov = sel.provider || (sel.route && sel.route.provider) || ''
    const mod = sel.model || (sel.route && sel.route.model) || ''
    if (prov && mod) return { provider: prov, model: mod, label: prov + '/' + mod }
    if (mod) return { provider: '', model: mod, label: mod }
    return null
  }
  try {
    const svc = ctx && ctx.agentDefaultModel
    if (svc && typeof svc.currentSelection === 'function') {
      const hit = pick(svc.currentSelection())
      if (hit) return hit
    }
  } catch (e) { /* noop */ }
  try {
    const svc = (ctx && typeof ctx.get === 'function') ? ctx.get('agentDefaultModel') : undefined
    if (svc && typeof svc.currentSelection === 'function') {
      const hit = pick(svc.currentSelection())
      if (hit) return hit
    }
  } catch (e) { /* noop */ }
  return { provider: '', model: '', label: '默认模型' }
}

// ---------------------------------------------------------------------------
// 本地/云端分工（2026-10-12 批次 4）
//   分工表在 `dsh/ai-route.json`（purpose → route），**每次调用现读**：改分工是纯数据，
//   不需要重启 DSH（改插件源码才要重启，铁律 7）。文件缺失/坏了/关掉 → 一律回落云端＝改动前行为。
//   本地档（local）：涉密的简单活。实测 qwen3:8b @ ctx8192：预填充 1.2s、生成 25–30 tok/s。
//   ⚠ 头号坑：Qwen3.5 的隐藏思考链开着时**只出思考、不出正文**（首字 21.7s、正文 0 字），
//     所以本地档**强制 reasoningEffort='off'**，不看调用方传了什么（live/next 传的 'low' 是给云端的）；
//     wire 上由 profile 的 `reasoningEfforts.off: 'none'` 落成 `reasoning_effort:"none"`（实测唯一有效）。
//   ⚠ 本地失败默认**转云端再试一次**（`onLocalFail:'cloud'`），并在结果与台账里明写 `fellBack:'cloud'`，
//     看板上能看到"这次其实是云端答的"；把 `onLocalFail` 改成 `'rule'` 就不转、由调用方回落规则版
//     （要"本地活绝不出机"时用那一档）。
// ---------------------------------------------------------------------------
const AI_ROUTE_FILE = fileURLToPath(new URL('./ai-route.json', import.meta.url))
let _routeCache = { mtime: -1, cfg: null }

// 2026-10-13 批次 5（审计 F9 修）：分工表**读失败/坏 JSON 仍然回落云端**（原行为不变，不能让调用报错），
//   但必须**看得见**——否则「本地档悄悄全变云端」这件事只能在账单里发现。
//   形状：{ at, code, reason }；成功读到一次就清掉；"文件根本没写 model"不算失败（那是合法配置）。
let _routeFileFail = null

export function readAiRoute() {
  try {
    const st = statSync(AI_ROUTE_FILE)
    if (_routeCache.mtime === st.mtimeMs) return _routeCache.cfg
    const cfg = JSON.parse(readFileSync(AI_ROUTE_FILE, 'utf8'))
    _routeCache = { mtime: st.mtimeMs, cfg: (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) ? cfg : null }
    _routeFileFail = null
    return _routeCache.cfg
  } catch (e) {
    _routeCache = { mtime: -1, cfg: null }
    // 只在**失败原因变了**时刷新记录，避免每次调用都盖掉第一次的现场
    const reason = String((e && e.message) || e)
    const code = String((e && e.code) || '')
    const key = code + '|' + reason
    if (!_routeFileFail || _routeFileFail.key !== key) {
      _routeFileFail = { at: new Date().toISOString(), code, reason: reason.slice(0, 200), key }
    }
    return null
  }
}

// 分工表读取状态（给 /sales/egress 自证用；只含错误元信息，不含客户数据）
export function aiRouteStatus() {
  const cfg = readAiRoute()
  return {
    file: AI_ROUTE_FILE,
    ok: !!cfg && !_routeFileFail,
    failed: _routeFileFail ? { at: _routeFileFail.at, code: _routeFileFail.code, reason: _routeFileFail.reason } : null,
    enabled: !!(cfg && cfg.enabled !== false),
  }
}

// 云端档的「思考档」（2026-10-13 批次 6b，wire 实测）：不指定档位时 云端网关 网关默认**思考链开着**，
//   1500 字提示词的 sale 调用实测 16s 都出不来字（timedOut=true、outChars=0）；而显式
//   `reasoning_effort:'none'` 实测 898ms 出正文、reasoning_content 为空（真关思考）。
//   ⇒ sale 的云端档默认 'off'（档位映射写在 profile 的 云端网关/deepseek-flash：off → none）。
//   **现读 ai-route.json**（改档不用重启）：`cloud.reasoningEffort` 全局默认，`cloud.perPurpose`
//   可按 purpose 覆盖（想让某个动作多想一点就写 {"sales-next":"low"}）。
function cloudEffort(cfg, purpose) {
  const c = (cfg && typeof cfg.cloud === 'object' && cfg.cloud) || {}
  const per = (c.perPurpose && typeof c.perPurpose === 'object') ? c.perPurpose : {}
  const v = per[String(purpose || '')] || c.reasoningEffort
  return v ? String(v) : ''
}

// purpose → 该走哪条路。返回 {provider, model, label, local, effort, route}
//   local:false 时 provider/model 就是当前会话模型（resolveModel 现读），与改动前完全一致；
//   effort 是**云端档的思考档**（现读分工表，见 cloudEffort）。
export function resolveAiRoute(ctx, purpose) {
  const cfg = readAiRoute()
  const cloud = () => { const r = resolveModel(ctx); return { ...r, local: false, effort: cloudEffort(cfg, purpose) || undefined, route: 'cloud' } }
  // 开源版：先看用户在「设置」里选的模型通道（sales.config.json）。
  //   fixed = 钉死一个 provider/model（用户在 DSH 里已配好的任意 provider，key 由宿主持有）；
  //   local = 走本机 Ollama provider（数据不出机，模型能力有限）；
  //   session（默认）= 跟随当前会话模型，保持与改动前完全一致的行为。
  const pol = aiPolicy()
  if (pol.mode === 'fixed' && pol.provider && pol.model) {
    return { provider: pol.provider, model: pol.model, label: pol.provider + '/' + pol.model, local: false, effort: pol.reasoningEffort || cloudEffort(cfg, purpose) || undefined, route: 'fixed' }
  }
  if (pol.mode === 'local' && pol.local && pol.local.provider && pol.local.model) {
    return { provider: pol.local.provider, model: pol.local.model, label: pol.local.provider + '/' + pol.local.model, local: true, effort: 'off', route: 'local' }
  }
  if (!cfg || cfg.enabled === false) return cloud()
  const want = cfg.routes && typeof cfg.routes === 'object' ? cfg.routes[String(purpose || '')] : ''
  if (String(want || '') !== 'local') return cloud()
  const loc = (cfg.local && typeof cfg.local === 'object') ? cfg.local : {}
  const provider = String(loc.provider || 'local')
  const model = String(loc.model || '')
  if (!model) return cloud()   // 分工表说要本地却没写模型 → 宁可走云端，也不让调用报错
  return { provider, model, label: provider + '/' + model, local: true, effort: String(loc.reasoningEffort || 'off'), route: 'local' }
}

export function aiAvailable(ctx) { return !!llmOf(ctx) }

// 模型面自证（/sales/egress 与探针用）：连同"分工表现在长什么样"一起回显（只读，不含客户数据）
export function aiStatus(ctx) {
  const cfg = readAiRoute()
  const rs = aiRouteStatus()
  const pol = aiPolicy()
  return {
    llm: !!llmOf(ctx), model: resolveModel(ctx).label, logPath: aiLogPath(),
    // 开源版：用户在看板「设置」里选的模型通道（session/fixed/local）
    channel: { mode: pol.mode, provider: pol.provider, model: pol.model, label: pol.label, file: pol.file },
    // 2026-10-13 批次 5（审计 F9）：分工表读失败 → 这里 routeFileOk=false + routeFileError 带原因，
    //   运维/doctor 一眼看得出「本地档为什么全走云端了」。
    routeFileOk: rs.ok,
    routeFileError: rs.failed,
    route: {
      enabled: !!(cfg && cfg.enabled !== false),
      file: AI_ROUTE_FILE,
      local: (cfg && cfg.local) || null,
      routes: (cfg && cfg.routes) || {},
      cloud: (cfg && cfg.cloud) || null,
      onLocalFail: (cfg && cfg.onLocalFail) || 'cloud',
    },
  }
}

function logCall(rec, logPath) {
  try {
    const f = logPath || aiLogPath()
    mkdirSync(path.dirname(f), { recursive: true })
    if (existsSync(f) && statSync(f).size > AI_LOG_MAX) writeFileSync(f, '', 'utf8')
    appendFileSync(f, JSON.stringify(rec) + '\n', 'utf8')
  } catch (e) { /* 台账失败不能影响功能 */ }
}

function pluginMessage(role, text, provider, model) {
  const content = [{ type: 'text', text: String(text == null ? '' : text) }]
  if (role === 'assistant') return { id: 'sales-' + randomUUID(), role: 'assistant', content, source: { kind: 'model', provider, model } }
  return { id: 'sales-' + randomUUID(), role: 'user', content, source: { kind: 'plugin', plugin: 'dsh-sales' } }
}

// 单次尝试：把 llm.stream 的 chunk 收成一段文本；带硬超时（超时主动 return() 取消流）
async function attemptOnce(llm, route, opts, usePurpose, timeoutMs) {
  let text = ''
  // 2026-10-21（m04728）：把模型的思考流也收下来（pi-ai 的 chunk 类型是 `reasoning-delta`，字段 .text；
  //   已在 asar 源码 `dsh-llm-pi-ai/lib/index.js` 的 thinking_delta 分支核对）。
  //   用户要「极简的思考过程（可折叠）」——模型愿意出思考就展示；reasoning_effort=none 时这里为空，
  //   面板另有插件自己的步骤轨迹（实况/附件/查数据/模型/耗时），不靠模型自述。
  let reasoning = ''
  let finishKind = ''
  let timedOut = false
  let streamErr = ''
  // purpose 是 DSH 计费/台账的既有字段（dsh-bill 读 options.purpose）——但**老宿主可能不认**，
  //   所以第一次失败会自动去掉它重试（见 aiStream）。
  const req = {
    provider: route.provider || undefined,
    model: route.model || undefined,
    messages: opts.messages.map((m) => pluginMessage(m.role === 'assistant' ? 'assistant' : 'user', m.text, route.provider, route.model)),
    ...(opts.system ? { system: String(opts.system) } : {}),
    ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
    // 批次 4：显式给生成上限。不传就会落 pi-ai 默认 32768 → 本地模型会一路生成到 ctx 满
    //（实测：ctx 8192 时正文被挤空、只出思考链）。数值来自 index.js 的 AI_MAXTOKENS（按用途分档）。
    ...(Number(opts.maxTokens) > 0 ? { maxTokens: Number(opts.maxTokens) } : {}),
    ...(usePurpose && opts.purpose ? { purpose: String(opts.purpose) } : {}),
  }
  let stream
  try { stream = llm.stream(req) } catch (e) { return { ok: false, text: '', error: 'llm.stream 调用失败: ' + String((e && e.message) || e) } }
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') return { ok: false, text: '', error: 'llm.stream 没有返回可迭代流' }
  const it = stream[Symbol.asyncIterator]()
  let timer = null
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('__TIMEOUT__'), Math.max(1000, timeoutMs || 8000)) })
  try {
    for (;;) {
      const step = await Promise.race([it.next(), timeout])
      if (step === '__TIMEOUT__') {
        timedOut = true
        // 取消但**绝不 await**（2026-10-12 探针抓到：流挂在 await 里时 it.return() 永不 settle → 现场卡死）
        try { if (typeof it.return === 'function') { const p = it.return(); if (p && typeof p.then === 'function') p.then(() => {}, () => {}) } } catch (e) { /* noop */ }
        break
      }
      if (!step || step.done) break
      const chunk = step.value
      if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      if (chunk && chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') reasoning += chunk.text
      if (chunk && chunk.type === 'finish') {
        const r = chunk.reason || {}
        if (r.kind) finishKind = String(r.kind)
        if (r.kind === 'error' || r.kind === 'aborted') {
          const detail = (r.failure && (r.failure.message || r.failure.code)) || r.kind
          streamErr = '模型调用失败(' + detail + ')'
        }
      }
    }
  } catch (e) {
    streamErr = streamErr || ('流中断: ' + String((e && e.message) || e))
  } finally { if (timer) clearTimeout(timer) }
  return { ok: !streamErr && !timedOut, text, reasoning, error: streamErr, timedOut, finishKind }
}

// 思考档位是**跟 provider 能力绑定**的可选项，不是所有 provider 都吃（2026-10-13 批次 6 稳定性修）。
//   事故现场：会话模型从 `deepseek-account/deepseek-flash` 换成 `云端网关/deepseek-flash` 后，sale 的
//   **全部云端动作 1ms 内硬失败**，台账只留一行 ok:false：
//     `模型调用失败(provider "云端网关" model "deepseek-flash" does not support reasoning effort "low")`
//   —— pi-ai 对没声明 `compat.supportsReasoningEffort` 的 provider 遇到档位直接抛，整发请求作废，
//   sale 静默回落规则版（用户看到的是「AI 那段没了」，看不出是失败）。
//   修法：碰到这条错就**去掉档位重试一次**——不支持的 provider 走它自己的默认档，支持的仍吃 'low'
//   的低思考收益。失败一发只花 1ms，代价可忽略；换来的是「换 provider/换会话模型不会打哑 sale」。
function effortUnsupported(err) { return /does not support reasoning effort/i.test(String(err || '')) }
async function attemptWithEffortFallback(llm, active, req, hasPurpose, timeoutMs) {
  let r = await attemptOnce(llm, active, req, hasPurpose, timeoutMs)
  if (!r.ok && req && req.reasoningEffort && effortUnsupported(r.error)) {
    const retry = { ...req }
    delete retry.reasoningEffort
    const r2 = await attemptOnce(llm, active, retry, false, timeoutMs)
    r2.effortDropped = true
    r2.effortDroppedFrom = String(req.reasoningEffort)
    if (!r2.ok) r2.unsupportedEffortError = String(r.error || '')
    return r2
  }
  return r
}

// 本地档的熔断状态（模块级、进程内）：本地端点没起（Ollama 关了 / 端口不通 / provider 配废）时，
//   失败一次就冷却一段时间，免得**每次**调用都先白等一个超时（live 8s、clienttip 20s）再回落。
//   冷却时长读 ai-route.json 的 localCooldownMs（默认 120000；设 0 = 关掉熔断，每次都先试本地）。
let localDeadUntil = 0
let localDeadReason = ''

// 本地跳预热（批次 4 收尾）：Ollama 默认 5 分钟就把模型从显存卸掉，用户用 live 是一阵一阵的 —— 隔久了
//   下一发就要吃 8–10s 冷启动、撞 live 的 8s 预算（实测三连：冷→超时回落云端 / 热→本地 5.6s 出话术 / 又冷→又超时）。
//   后台预热（不阻塞、不等结果；成功就清掉熔断，让下一发立刻能真的走本地），触发点两处：
//     ① 看板进「通话台」就会拉一次本机语音目录（index.js 的 case 'speech'）——语音就绪时用户不会按
//        「准备」（client.js 的 livePrepare 只在没就绪时才调 prepare），所以预热必须挂在这个**必走**的读口上；
//        同时 speechprepare（真按了准备按钮）也预一手。
//     ② 本地一跳真失败时兜底：这次认栽走云端，同时把模型拉进显存，下一发就是热的。
const WARM_TIMEOUT_MS = 60000   // 加载 8–10s，给足；别把"还没加载完"误判成"本地废了"
const WARM_THROTTLE_MS = 60000  // 刚热过就别反复打（通话台轮询目录时每秒都会打到这里）
let warmInFlight = false
let lastWarmOkAt = 0
export function warmLocalRoute(ctx, logPath) {
  const route = resolveAiRoute(ctx, 'sales-live')
  if (!route.local) return { started: false, reason: '分工表里没有本地档' }
  if (warmInFlight) return { started: false, reason: '预热已在跑' }
  if (Date.now() - lastWarmOkAt < WARM_THROTTLE_MS) return { started: false, reason: '刚预热过（模型还在显存）' }
  const llm = llmOf(ctx)
  if (!llm) return { started: false, reason: '宿主没有模型服务' }
  warmInFlight = true
  const t0 = Date.now()
  const done = (r) => {
    warmInFlight = false
    const ok = !!(r && r.ok)
    if (ok) { lastWarmOkAt = Date.now(); localDeadUntil = 0; localDeadReason = '' }   // 热起来了 → 解熔断，下一发立刻回本地
    try {
      logCall({
        at: new Date().toISOString(), purpose: 'local-warm', route: 'local', provider: route.provider, model: route.model,
        ms: Date.now() - t0, inChars: 4, outChars: 0, ok,
        ...(ok ? {} : { error: String((r && r.error) || '预热失败').slice(0, 120) }),
      }, logPath)
    } catch (e) { /* 台账写不进去不影响主流程 */ }
  }
  try {
    Promise.resolve(attemptOnce(llm, route, { messages: [{ role: 'user', text: '预热' }], reasoningEffort: route.effort, maxTokens: 1 }, false, WARM_TIMEOUT_MS))
      .then(done, (e) => done({ ok: false, error: String((e && e.message) || e) }))
  } catch (e) { done({ ok: false, error: String((e && e.message) || e) }) }
  return { started: true, provider: route.provider, model: route.model, reason: '' }
}

// 右侧 AI 对话框（2026-10-21，用户 m01480）专用：调用方自己拼好多模态 req（含 {type:'image',attachment} 块），
//   这里只负责「把流收成一段文字 + 超时/取消 + onDelta 回调」。
//   为什么放在 ai.js 而不是 dock.js：**模型出口唯一是红线**（脱敏/超时/台账/降级都在插件侧统一一处），
//   probe-sales-ai 的静态断言会扫「除 ai.js 以外还有谁碰 llm.stream(」——所以 dock.js 不许直接调。
//   注意超时取消**绝不 await**（2026-10-12 探针抓到：流挂在 await 里时 it.return() 永不 settle → 现场卡死）。
export async function streamChat(ctx, req, opts = {}) {
  const t0 = Date.now()
  const llm = llmOf(ctx)
  if (!llm) return { ok: false, text: '', error: 'no-llm', ms: 0 }
  const timeoutMs = Math.max(10000, Number(opts.timeoutMs) || 180000)
  const onDelta = typeof opts.onDelta === 'function' ? opts.onDelta : null
  // 2026-10-21 夜（协议 v2）：「停止」按钮——调用方给 shouldStop()，每收一块问一次，
  //   真了就立刻断流返回已收到的文字（同样不 await 它的 return()，与超时同一条纪律）。
  const shouldStop = typeof opts.shouldStop === 'function' ? opts.shouldStop : null
  let stopped = false
  let text = ''
  let reasoning = ''   // 2026-10-21（m04728）：思考流（dock 用它做可折叠的「思考过程」）
  let finishKind = ''
  let timedOut = false
  let streamErr = ''
  let stream
  try { stream = llm.stream(req) } catch (e) { return { ok: false, text: '', error: 'llm.stream 调用失败: ' + String((e && e.message) || e), ms: Date.now() - t0 } }
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') return { ok: false, text: '', error: 'llm.stream 没有返回可迭代流', ms: Date.now() - t0 }
  const it = stream[Symbol.asyncIterator]()
  let timer = null
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('__TIMEOUT__'), timeoutMs) })
  try {
    for (;;) {
      const step = await Promise.race([it.next(), timeout])
      if (step === '__TIMEOUT__') {
        timedOut = true
        try { if (typeof it.return === 'function') { const p = it.return(); if (p && typeof p.then === 'function') p.then(() => {}, () => {}) } } catch (e) { /* noop */ }
        break
      }
      if (!step || step.done) break
      if (shouldStop) {
        let stop = false
        try { stop = shouldStop() === true } catch (e) { stop = false }
        if (stop) {
          stopped = true
          try { if (typeof it.return === 'function') { const p = it.return(); if (p && typeof p.then === 'function') p.then(() => {}, () => {}) } } catch (e) { /* noop */ }
          break
        }
      }
      const chunk = step.value
      if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        text += chunk.text
        if (onDelta) { try { onDelta(chunk.text) } catch (e) { /* noop */ } }
      }
      if (chunk && chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') reasoning += chunk.text
      if (chunk && chunk.type === 'finish') {
        const r = chunk.reason || {}
        if (r.kind) finishKind = String(r.kind)
        if (r.kind === 'error' || r.kind === 'aborted') {
          const detail = (r.failure && (r.failure.message || r.failure.code)) || r.kind
          streamErr = '模型调用失败(' + detail + ')'
        }
      }
    }
  } catch (e) {
    streamErr = streamErr || ('流中断: ' + String((e && e.message) || e))
  } finally { if (timer) clearTimeout(timer) }
  return {
    ok: !streamErr && !timedOut,
    text,
    ...(reasoning.trim() ? { thinking: reasoning.trim() } : {}),
    error: timedOut ? ('模型超时（' + timeoutMs + 'ms）') : streamErr,
    timedOut,
    stopped,
    finishKind,
    ms: Date.now() - t0,
  }
}

// 主入口：aiStream(ctx, {purpose, system, messages, timeoutMs, maxChars, reasoningEffort, logPath})
//   messages: [{role:'user'|'assistant', text}] 或 直接给一段字符串
//   返回：{ok, text, provider, model, label, ms, inChars, outChars, error, timedOut, truncated}
export async function aiStream(ctx, opts = {}) {
  const t0 = Date.now()
  // 本地/云端分工（见 resolveAiRoute）：本地档强制关思考链。
  // 本地档失败后去哪：按 ai-route.json 的 `onLocalFail`（默认 'cloud'）**转云端再试一次，并在结果与台账里
  // 明写 `fellBack:'cloud'`**——绝不静默换道（看板上能看到"这次其实是云端答的"）；改成 'rule' 就不转，
  // 由调用方回落规则版（要"本地活绝不出机"时用这一档）。
  const route = resolveAiRoute(ctx, opts.purpose)
  // 熔断：本地端点刚失败过 → 冷却期内直接按云端走（不重复白等超时）。localCooldownMs=0 关掉熔断。
  const coolRaw = Number((readAiRoute() || {}).localCooldownMs)
  const coolMs = Number.isFinite(coolRaw) && coolRaw >= 0 ? coolRaw : 120000
  const skipLocal = !!route.local && Date.now() < localDeadUntil
  // 云端档的思考档现读分工表（cloudEffort）：skipLocal 与普通云端两处都取同一个值，免得
  //   「本地熔断后转云端」偷用调用方传的 'low'（那会把思考链打开 → 又撞满超时）。
  const cloudEffortNow = cloudEffort(readAiRoute(), opts.purpose)
  const active0 = skipLocal ? { ...resolveModel(ctx), local: false, effort: cloudEffortNow || undefined, route: 'cloud' } : route
  const effort = active0.local ? active0.effort : (cloudEffortNow || opts.reasoningEffort)
  const msgs = (Array.isArray(opts.messages) ? opts.messages : [{ role: 'user', text: String(opts.messages == null ? '' : opts.messages) }])
    .filter((m) => m && String(m.text == null ? '' : m.text).trim())
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', text: String(m.text).slice(0, AI_MSG_MAX) }))
  const sysWithBrand = withBrand(opts.system)
  const inChars = msgs.reduce((n, m) => n + m.text.length, 0) + sysWithBrand.length
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 8000
  const maxChars = Number(opts.maxChars) > 0 ? Number(opts.maxChars) : 400
  // 2026-10-13 批次 5（审计 F1 修）：原来这里先 const base = { provider: route.provider … local: !!route.local }，
  //   而 route 是「本地/云端分工表要走的档」，不是**本次真正跑的那档**。本地失败回落云端后，
  //   旧写法只在 out 末尾用 active.* 覆盖 provider/model/label/route/local，base 里的派生字段（以及漏覆盖时的回退）
  //   会把「云端答的」标成本地 provider/model。现在 base 只保留与档位无关的 inChars，档位字段一律逐字段取 active。
  const llm = llmOf(ctx)
  // 注意：这两条早退发生在 `let active = active0` **之前**，所以只能用 active0（用 active 会撞 TDZ
  //   ReferenceError——「宿主没有模型服务」这条本来要给人看的提示会变成崩）。
  if (!llm) {
    logCall({ at: new Date().toISOString(), purpose: opts.purpose || '', model: active0.label, ms: Date.now() - t0, inChars, outChars: 0, ok: false, error: 'no-llm' }, opts.logPath)
    return { ok: false, provider: active0.provider, model: active0.model, label: active0.label, route: active0.route, local: !!active0.local, inChars, fellBack: '', text: '', textRaw: '', outChars: 0, ms: Date.now() - t0, error: '宿主没有模型服务（llm）：功能不可用，已回落规则结果' }
  }
  if (!msgs.length) return { ok: false, provider: active0.provider, model: active0.model, label: active0.label, route: active0.route, local: !!active0.local, inChars, fellBack: '', text: '', textRaw: '', outChars: 0, ms: Date.now() - t0, error: '空请求' }

  let last = { ok: false, text: '', error: '未执行' }
  let active = active0
  let fellBack = skipLocal ? 'cloud' : ''
  let firstError = skipLocal ? ('本地熔断中（' + (localDeadReason || '上次本地调用失败') + '）') : ''
  // 生成上限只钉**本地档**：云端一律走 pi-ai 自己的默认（实测：给云端 live 档钉 300 会把思考链算进上限 →
  //   正文被挤空，报「模型返回空文本」）。本地档必须钉，否则会一路生成到 ctx 满（见 attemptOnce 注释）。
  const localMax = (r) => (r && r.local ? opts.maxTokens : 0)
  for (let i = 0; i < 2; i++) {   // 失败最多重试 1 次（第 1 次带 purpose，第 2 次去掉 purpose 防老宿主不认这个字段）
    last = await attemptWithEffortFallback(llm, active, { ...opts, system: sysWithBrand, messages: msgs, reasoningEffort: effort, maxTokens: localMax(active) }, i === 0, timeoutMs)
    if (last.ok && String(last.text).trim()) break
    if (last.ok && !String(last.text).trim()) { last.error = '模型返回空文本'; last.ok = false }
    if (i === 0 && last.timedOut) break          // 超时不再重试（现场等不起）
  }
  // 本地档失败 → 去处只有两种（plan ③），且必须留痕：
  if (!(last.ok && String(last.text || '').trim()) && route.local && !skipLocal) {
    firstError = String(last.error || '') || (last.timedOut ? '本地超时（' + timeoutMs + 'ms）没出字' : '本地返回空文本')
    // 本地失败先记一笔熔断（冷却期内后面的调用直接走云端，不再白等一遍超时）
    localDeadUntil = Date.now() + coolMs
    localDeadReason = firstError
    // 兜底预热：这次失败很可能是"模型被 Ollama 卸出显存了"（冷启动），后台打一发把模型拉回来，
    //   成功即解熔断 —— 这些都不占调用方的等待时间（不 await）。
    try { warmLocalRoute(ctx, opts.logPath) } catch (e) { /* 预热失败不影响本次回落 */ }
    const onFail = (readAiRoute() || {}).onLocalFail === 'rule' ? 'rule' : 'cloud'
    const cl = { ...resolveModel(ctx), local: false, effort: cloudEffortNow || undefined, route: 'cloud' }
    if (onFail === 'cloud' && cl.provider && cl.model) {
      active = cl
      fellBack = 'cloud'
      for (let i = 0; i < 2; i++) {
        last = await attemptWithEffortFallback(llm, active, { ...opts, system: sysWithBrand, messages: msgs, reasoningEffort: cloudEffortNow || opts.reasoningEffort, maxTokens: 0 }, i === 0, timeoutMs)
        if (last.ok && String(last.text).trim()) break
        if (last.ok && !String(last.text).trim()) { last.error = '模型返回空文本'; last.ok = false }
        if (i === 0 && last.timedOut) break
      }
    } else {
      fellBack = 'rule'
    }
  }
  // 2026-10-13 批次 5（审计 F1 修）：档位字段**一律取 active**（本次真跑的那档），不再从 base 继承；
  //   回落云端时 provider/model/label/route/local 全部是云端的真实值，看板/台账不会再把云端答案标成本地。
  const textRaw = String(last.text || '').trim()
  let text = textRaw
  let truncated = false
  if (text.length > maxChars) { text = text.slice(0, maxChars); truncated = true }
  const out = {
    ok: !!last.ok && !!text,
    provider: active.provider, model: active.model, label: active.label, route: active.route, local: !!active.local,
    inChars,
    fellBack,
    ...(firstError ? { firstError } : {}),
    text,
    // 2026-10-13 批次 5（审计 F2 修）：截断**之前**的全文给调用方做数字回查（checkNumbers）。
    //   否则超长合法答案里第 maxChars 位之后的数字会被判成"编造的数字"→ 整段静默回落规则版。
    textRaw,
    outChars: text.length,
    // 2026-10-21（m04728）：模型自述的思考（可能为空——reasoning_effort=none 时 provider 就不发）。
    //   只给面板做「可折叠思考过程」用；调用台账仍只记字数，不记内容。
    ...(String(last.reasoning || '').trim() ? { thinking: String(last.reasoning).trim().slice(0, 4000) } : {}),
    ms: Date.now() - t0,
    finishKind: last.finishKind || '',
    truncated,
    // 2026-10-13 批次 6：provider 不认思考档、靠「去掉档位重试」才成功 → 必须留证（不是静默降级）
    ...(last.effortDropped ? { effortDropped: true, effortDroppedFrom: last.effortDroppedFrom || '' } : {}),
    timedOut: !!last.timedOut,
    error: last.ok ? '' : (firstError ? '本地失败(' + firstError + ')，回落云端后仍失败(' + String(last.error || '模型调用失败') + ')' : String(last.error || '模型调用失败')),
  }
  logCall({
    at: new Date().toISOString(), purpose: opts.purpose || '', route: active.route, provider: active.provider, model: active.model,
    ms: out.ms, inChars, outChars: out.outChars, ok: out.ok, timedOut: out.timedOut, truncated,
    ...(fellBack ? { fellBack } : {}),
    ...(last.effortDropped ? { effortDropped: true } : {}),
    ...(firstError ? { firstError: firstError.slice(0, 120) } : {}),
    ...(out.error ? { error: out.error.slice(0, 120) } : {}),
  }, opts.logPath)
  return out
}

// ---------------- 提示词构造（脱敏在这里做完，绝不把真名交出去） ----------------
const SAY_RULES = [
  '你只说人话，不解释、不加前言后语、不用 markdown、不写"以下是"这类开场。',
  '只能用给定的事实，**不许编造**任何数字、案例、承诺、时间、人名或公司名。',
  '文中的 <客户1|…>、<单位1|…>、<电话1>、<微信1> 是占位符，**原样保留**，不要替换成别的名字。',
  '本地资料库检索到的【可引用资料】可以拿来支撑你说的话；**只有真用了某条资料**，才在那条末尾写 `来源：《…》`（照抄资料里给的来源，不许自己编一个来源），没用就别写。',
].join('\n')

// 批次 3（2026-10-12）：把"这户自己的身份字段"（姓名/公司/手机/微信 + 公司简称）登记成占位符。
//   结构化字段本来遮得住；这一手是给**自由文本**兜底——上一次跟进的沟通内容里会写"已通知客户(星桥智造李维)"
//   这种没边界的真名真公司（正则学不出来），只有先登记成字面量才遮得掉。
function registerCustomer(mk, cust, tag) {
  if (!cust) return
  const t = tag || ''
  if (cust.姓名) mk.addPerson(cust.姓名, t)
  if (cust.微信昵称) mk.addWechat(cust.微信昵称)
  if (cust.手机) mk.addPhone(cust.手机)
  const org = String(cust.公司 || '').trim()
  if (org) {
    mk.addOrg(org, buildTag({ industry: guessIndustry(org) }))
    const short = shortOrg(org)
    if (short) mk.addOrg(short, t)
  }
}

// 通话中实时话术：客户刚说的话 + 该户 SOP 阶段/规则命中 → 1–3 条"现在就能念"的接话 + 本段要拿到的结果
export function buildLivePrompt(live, lastText, limit, ragLean) {
  const mk = createMasker()
  if (live && live.name) (looksLikeOrg(live.name) ? mk.addOrg(live.name, buildTag({ industry: guessIndustry(live.name) })) : mk.addPerson(live.name, buildTag({ level: live.level, stage: live.stage })))
  if (live && live.contact) mk.addPerson(live.contact, buildTag({ level: live.level, stage: live.stage }))
  if (live && live.phone) mk.addPhone(live.phone)
  registerCustomer(mk, live && live.customer, buildTag({ level: live && live.level, stage: live && live.stage }))
  for (const c of ((live && live.candidates) || [])) if (c) mk.addPerson(c)
  const n = Math.max(1, Math.min(3, Number(limit) || 3))
  const facts = {
    客户: { 等级: live.level || '未定级', 状态: live.status || '', 当前SOP阶段: live.stage || '（未归段）', 结果: live.result || '', 进度: live.progress || '' },
    本段该拿到的结果: (live.stageOpen && live.stageOpen.next) || '',
    本段开场参考: (live.stageOpen && live.stageOpen.say) || '',
    规则命中的接话点: (live.cues || []).map((c) => ({ 客户话术命中: c.cue, 为什么: c.why, 规则版参考: c.say, 阶段: c.stage || '' })),
    推进建议: (live.moves || []).map((m) => ({ 建议阶段: m.stage || '', 依据: m.because, 动作: m.action })),
  }
  // 两种用法共用这一条提示词：① 通话现场带客户刚说的话（实时接话）；② 看板点按钮、只有档案（切入/开场）。
  //   2026-10-12：没有转写文本时必须换框架，否则模型会硬编一句"客户刚说的话"来接话（看了档案当录音）。
  const onCall = !!String(lastText || '').trim()
  const system = [
    onCall
      ? '你是可研报告 AI 工具的销售陪练，正在帮销售**电话现场**接话。'
      : '你是可研报告 AI 工具的销售陪练。销售现在**没在通话**，他让你看一眼这个客户的档案与 SOP 阶段，给他一段**现在就能开口/能发出去**的切入话术。',
    SAY_RULES,
    '输出格式（严格照这个来，每项一行）：',
    onCall ? '①接话原文（可直接念出口，20–60 字）｜为什么：一句话' : '①切入原文（可直接开口说/直接发，20–60 字）｜为什么：一句话',
    '（最多 ' + n + ' 条，按优先级；不够好就少给，别凑数）',
    '▶本段该拿到的结果：一句话（' + (onCall ? '这段电话打完，SOP 要往前拿到什么' : '这次触达之后，SOP 要往前拿到什么') + '）',
  ].join('\n')
  // 批次 3（2026-10-12）：本地词法 RAG —— 从 `营销资料库` 检索可引用资料（示例语料 + 企业级要点 + 逼单稿）。
  //   ⚠ 检索用的 query 是**真文本**（客户刚说的话/命中话术），但只在本机内存里算分，**检索结果才是发出去的**；
  //     资料是公开营销语料、不含客户数据，所以进提示词不需要遮（仍过一遍 mask 兜底）。
  const rag = (() => {
    try {
      const q = [
        String(lastText || ''),
        live && live.stage ? String(live.stage) : '',
        (live && live.cues || []).map((c) => c.cue).join(' '),
        live && live.note ? String(live.note) : '',
      ].join(' ')
      // 批次 4 瘦身：本地档（小模型、ctx 8192）只取 2 块资料，省 ~1/3 资料段预填充
      return searchRag(q, ragLean ? { limit: 2 } : {})
    } catch (e) { return [] }
  })()
  const ragBlock = rag.length ? mk.mask(formatSnippets(rag)) : ''
  const user = [
    '【引擎整理的事实】', mk.mask(JSON.stringify(facts, null, 1)),
    '',
    onCall
      ? '【客户刚说的话（本机语音转写，可能不准/有错别字，按大意理解）】'
      : '【没有通话转写：这次不是现场接话，只按上面的档案事实给切入】',
    onCall ? mk.mask(String(lastText).slice(-1200)) : '（销售只点了一下按钮，没有客户原话）',
    ragBlock
      ? ['', '【可引用资料（本地资料库检索，用它说理；用了才标来源）】', ragBlock].join('\n')
      : '',
  ].join('\n')
  return { system, messages: [{ role: 'user', text: user }], masker: mk, stats: mk.stats, rag, ragBlock }
}

// 微信/短信整段文案：给"能直接复制发出去"的一段话
export function buildClientTipPrompt(tip, maxChars, ragLean) {
  const mk = createMasker()
  const who = tip && tip.name ? String(tip.name) : ''
  if (who) {
    const industry = guessIndustry(who)
    // tip.name 在库里 = 公司名（有公司时）否则姓名：按长相分流，避免把公司名塞进"客户"占位符
    if (/公司|院|中心|所|集团|厂|局|银行|学校|平台$/.test(who)) mk.addOrg(who, buildTag({ industry }))
    else mk.addPerson(who, '')
  }
  // 规则草稿里的开口称呼（buildFollowScript 拼的 "陈默您好…"）：从草稿里学一遍真名，才遮得住
  const script = String((tip && tip.script) || '')
  const m = /^\s*([^\s，,。：:、]{2,6})(?:您好|好[，,])/.exec(script)
  if (m) mk.addPerson(m[1], '')
  registerCustomer(mk, tip && tip.customer, buildTag({ industry: guessIndustry(String((tip && tip.name) || '')) }))
  const size = guessSize(script)
  const facts = {
    客户或单位: who,
    命中规则次数: tip && tip.hits,
    是否已跟进过: !!(tip && tip.hasFlow),
    场景: (tip && tip.scenes) || [],
    知识库要点: ((tip && tip.tips) || []).slice(0, 3).map((t) => ({ 场景: t.场景, 标题: t.标题, 摘要: t.摘要, 关键句: String(t.全文 || '').slice(0, 300) })),
    规则版草稿: script.slice(0, 800),
    规模提示: size || '',
  }
  const cap = Math.max(80, Math.min(600, Number(maxChars) || 220))
  const system = [
    '你是可研报告 AI 工具的销售顾问，在写一条**可以直接复制发给客户**的微信/短信。',
    SAY_RULES,
    '要求：一句自然开口 + 一条具体价值 + 一个轻量的下一步（问时间/给选择），口气像真人，不要群发感。',
    '只输出这段消息正文（' + cap + ' 字以内），不要标题、不要备选、不要解释。',
  ].join('\n')
  // 批次 3：本地词法 RAG（同上：检索用真文本、只在本机算，资料本身是公开语料）
  const rag = (() => {
    try {
      const q = [
        who,
        (tip && tip.hits || []).join(' '),
        (tip && tip.scenes || []).join(' '),
        ((tip && tip.tips) || []).map((t) => `${t.标题 || ''} ${t.摘要 || ''}`).join(' '),
      ].join(' ')
      return searchRag(q, ragLean ? { limit: 2 } : {})
    } catch (e) { return [] }
  })()
  const ragBlock = rag.length ? mk.mask(formatSnippets(rag)) : ''
  const user = [
    '【引擎整理的事实】', mk.mask(JSON.stringify(facts, null, 1)),
    ragBlock
      ? ['', '【可引用资料（本地资料库检索，用它说理；用了才标来源）】', ragBlock].join('\n')
      : '',
  ].join('\n')
  return { system, messages: [{ role: 'user', text: user }], masker: mk, stats: mk.stats, rag, ragBlock }
}

// ============================================================================
// 批次 2（2026-10-12）：作战卡(next) / 每日工作台(brief) / 周复盘(digest)
//   与批次 1 同一套纪律：事实**全部**来自引擎（引擎不说的，模型不许说）、字段级脱敏、
//   回来回填、失败回落规则版。多一道 **数字回查**（见 checkNumbers）：
//   模型文本里每个 2 位以上数字，必须能在"发给它的事实"里原样找到，否则整段作废回落规则版。
//   为什么这么严：这三段会直接给用户当"今天怎么干"，编一个数就带错一天。
// ============================================================================
const NUM_RULE = '文中的每一个 2 位以上数字（金额/条数/天数/字数），必须能在上面的事实里**原样找到**；找不到就别写这个数。'

// 数字回查：返回 text 里"事实里没有"的数字（空数组 = 通过）。
//   单位数（序号 ①、8 折、3 条）不查，避免把正常话术全判成编造；日期（10-09）在事实里也是原样子串，能过。
export function checkNumbers(text, factsText) {
  const bad = []
  const seen = new Set()
  const f = String(factsText || '')
  const re = /\d+(?:\.\d+)?/g
  let m
  while ((m = re.exec(String(text || '')))) {
    const n = m[0]
    if (n.length < 2) continue
    if (f.includes(n)) continue
    if (seen.has(n)) continue
    seen.add(n)
    bad.push(n)
  }
  return bad
}

// 来源回查：模型写的「来源：《…》」必须**照抄**本次真的发给它的资料片段里的来源。
//   为什么需要：SAY_RULES 只是"请它照抄"，模型仍可能顺手编一个像样的文件名/书名（编来源＝假引用，
//   比不写来源更坏——用户会照着去资料库找）。这里在**回填真名之前**（双方都还是遮罩态，比对得齐）
//   把对不上的来源摘掉并记下来。返回 { text, dropped, allowed }。
export function checkCitations(text, ragBlock) {
  const block = String(ragBlock || '')
  const allowed = new Set()
  // 全角/半角冒号都认（模型偶尔写成 来源: ），冒号也可省；《》必须成对——格式不对的本来就不是"来源标注"
  const pick = /来源\s*[：:]?\s*(《[^》]{0,120}》)/g
  let m
  while ((m = pick.exec(block))) allowed.add(m[1])
  if (!allowed.size) return { text: String(text || ''), dropped: [], allowed: 0 }
  const dropped = []
  const out = String(text || '').replace(/来源\s*[：:]?\s*(《[^》]{0,120}》)/g, (full, label) => {
    if (allowed.has(label)) return full
    dropped.push(label)
    return '来源：（本地资料库里没有这条，已移除）'
  })
  return { text: out, dropped, allowed: allowed.size }
}

// 2026-10-12 批次 2 真数据审读抓到的第二个问题：引擎事实里夹着**规则版整段话术**
//   （brief 每条的 how、作战卡的「规则版开口参考」，一条 ~900 字，含示例语料引用与话题标签）。两个坏处：
//   ① 它是模板拼的旧文案——实测对"从没聊过、试用权益都没领"的客户也写"上次聊的事这段效果还不错"，
//      留着模型会照抄这句错话；② 三条就撑爆 maxChars，事实被截成半截 JSON（模型读到坏 JSON）。
//   所以发声前先剪掉这些字段（剪的是"发给模型的那份"；引擎原文仍原样回给看板当规则版）。
const AI_DROP_KEYS = ['how', '规则版开口参考', 'script']
// 顺带按尺寸收一遍：字符串截到 160 字、数组留前 6 条。
//   为什么必须收：brief 的 todo 前 8+8 条就 3.5KB、digest 的 conclusions+nextWeek 4KB，
//   照原样发会把 maxChars 撑爆、事实被砍成**半截 JSON**（模型读到坏的 JSON 只会瞎编）——
//   实测生产上限 1200 字时只发得进一个客户。收完事实全在、模型仍看得懂结构。
const AI_SLIM = { strCap: 160, arrCap: 6, depth: 6 }
function slimForAi(value, depth) {
  if ((depth || 0) > AI_SLIM.depth) return value
  if (typeof value === 'string') return value.length > AI_SLIM.strCap ? (value.slice(0, AI_SLIM.strCap) + '…') : value
  if (Array.isArray(value)) return value.slice(0, AI_SLIM.arrCap).map((v) => slimForAi(v, (depth || 0) + 1))
  if (value && typeof value === 'object') {
    const out = {}
    for (const k of Object.keys(value)) {
      if (AI_DROP_KEYS.includes(String(k))) continue
      out[k] = slimForAi(value[k], (depth || 0) + 1)
    }
    return out
  }
  return value
}

// 共用打包：事实 → 剪裁/脱敏 → 截断 → 一条 user 消息（factsText 交给调用方做数字回查）
function pack(sysLines, facts, mk, maxChars, kind) {
  const cap = Math.max(600, Math.min(8000, Number(maxChars) || 4000))
  let factsText = mk.mask(JSON.stringify(slimForAi(facts, 0), null, 1))
  let cut = false
  if (factsText.length > cap) { factsText = factsText.slice(0, cap); cut = true }
  const user = [
    '【引擎整理的事实' + (cut ? '（过长，已截断）' : '') + '】',
    factsText + (cut ? '\n…（后面还有事实，被截断了，别猜）' : ''),
  ].join('\n')
  return {
    system: sysLines.concat([SAY_RULES, NUM_RULE]).join('\n'),
    messages: [{ role: 'user', text: user }],
    masker: mk, stats: mk.stats, factsText: user, kind,
  }
}

// ① 客户作战卡：这个客户现在最该做的一件事 + 为什么是今天 + 开口 + 分支怎么接
export function buildNextPrompt(next, maxChars) {
  const mk = createMasker()
  const d = next || {}
  const who = String(d.name || '').trim()
  if (who) (looksLikeOrg(who) ? mk.addOrg(who, buildTag({ industry: guessIndustry(who) })) : mk.addPerson(who, buildTag({ level: d.level, stage: d.stage })))
  if (d.phone) mk.addPhone(d.phone)
  if (d.wechat) mk.addWechat(d.wechat)
  registerCustomer(mk, d.customer, buildTag({ level: d.level, stage: d.stage }))
  const how = String(d.how || '')
  const m = /^\s*([^\s，,。：:、]{2,6})(?:您好|好[，,])/.exec(how)
  if (m) mk.addPerson(m[1], '')
  autoMask(mk, d.lastFlow)
  const facts = {
    客户或单位: who,
    等级: d.level || '未定级', 当前SOP阶段: d.stage || '（未归段）', 跟进状态: d.status || '',
    下次跟进: d.next || '（未排期）',
    引擎给出的作战卡: d.card || null,
    规则版开口参考: how,
    '没接通或客户说贵/说没需求怎么接': d.branch || [],
    上一次跟进: d.lastFlow || null,
  }
  const sys = [
    '你是可研报告 AI 工具的销售顾问。销售问"这个客户现在最该做的一件事"，你要按上面的事实写一张**作战卡**。',
    '输出格式（严格照这个来，每项一行）：',
    '①最该做的一件事：一句话（带明确时间点）',
    '②为什么是今天：一句话（用事实里的数字说话，别编）',
    '③开口怎么说：20–60 字，可以直接念出来',
    '④打不通 / 说贵 / 说没需求怎么接：三条，各一行',
    '⑤这次要拿到什么：一句话',
  ]
  return pack(sys, facts, mk, maxChars, 'next')
}

// ② 每日工作台：今天先打谁、盯什么风险、要用户点头的一件事
export function buildBriefPrompt(brief, maxChars) {
  const mk = createMasker()
  const d = brief || {}
  autoMask(mk, d)
  const todo = d.todo || {}
  // 真数据审读后的事实裁剪：必做/该做各留前 5 条、每条只留决策用得上的字段（引擎的 how/branch
  //   是规则版话术，模型自己会写，留着只会吃光预算、还可能照抄错话）；观察面只留计数 + 停滞前 3 例
  //   （原来整个 watch 1.4KB，其中 flywheel 就 834 字）。
  const item = (x) => {
    const o = (x && typeof x === 'object') ? x : {}
    return { tier: o.tier, id: o.id, name: o.name, level: o.level, stage: o.stage, result: o.result, action: o.action, why: o.why, deadline: o.deadline, score: o.score }
  }
  const w = (d.watch && typeof d.watch === 'object') ? d.watch : {}
  const facts = {
    日期: d.date || '',
    今日已完成条数: d.doneCount || 0,
    今日必做: (todo.must || []).slice(0, 5).map(item),
    今日该做: (todo.should || []).slice(0, 5).map(item),
    需要你点头的一件事: d.askOne || null,
    观察: {
      锚点到期: w.anchorDueCount || 0,
      到期7天内: w.expireIn7 || 0,
      到期14天内: w.expireIn14 || 0,
      到期30天内: w.expireIn30 || 0,
      停滞人数: w.stallCount || 0,
      停滞样例: (w.stall || []).slice(0, 3).map((s) => ({ name: s && s.name, stage: s && s.stage, 静默天数: s && s.silentDays })),
      用量异常: { 突增: w.usageSurge || 0, 零用量: w.usageZero || 0 },
      培育池: { 到点: w.nurtureDue || 0, 池子: w.nurturePool || 0, 节奏天数: w.nurtureCadenceDays || 0 },
      飞轮瓶颈: (w.flywheel && w.flywheel.bottleneck) ? w.flywheel.bottleneck : null,
    },
    是否真实数据齐全: !!(d.snapshot),
  }
  const sys = [
    '你是可研报告 AI 工具的销售教练。销售要一份"今天怎么干"，你按上面的事实写。',
    '输出格式（严格照这个来，每项一行）：',
    '①今天先打这 3 个：按顺序 3 行，每行「序号. 客户/单位 + 一句话为什么是今天」',
    '②今天最该盯的一个风险：一句话（从观察/停住的客户里挑，别编）',
    '③需要你点头的一件事：一句话（没有就写"今天没有要点头的事"）',
    '④一句话提醒：今天最容易做错的一件事',
    '不写前言、不写总结、不写"祝您"。',
  ]
  return pack(sys, facts, mk, maxChars, 'brief')
}

// ③ 周复盘：这一周干了什么、卡在哪、下周先打谁
export function buildDigestPrompt(digest, maxChars) {
  const mk = createMasker()
  const d = digest || {}
  autoMask(mk, d)
  const facts = {
    窗口: [d.from || '', d.to || ''],
    总量: d.totals || null,
    推进段位: d.advanced || null,
    结论与清黑洞: d.conclusions || null,
    现在黑洞: d.blackhole || null,
    培育池: d.nurture || null,
    下周战役: d.nextWeek || null,
  }
  const sys = [
    '你是可研报告 AI 工具的销售教练。这是给销售本人看的**周复盘**，按上面的事实写。',
    '输出格式（严格照这个来，每项一行）：',
    '①这一周干了什么：2–3 句，用事实里的数字',
    '②推进/成交了什么：一句话（没有就写"这周没有推进段位的客户"）',
    '③现在最大的一个瓶颈：一句话 + 一句怎么办',
    '④下周先打哪三个：3 行，每行「序号. 客户/单位 + 为什么先打他」',
    '不写前言、不写鼓励、不写"祝您"。',
  ]
  return pack(sys, facts, mk, maxChars, 'digest')
}
