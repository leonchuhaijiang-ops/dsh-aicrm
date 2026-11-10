// AI-CRM客资管理系统 - Host 端（正式插件版）
// 本地私有插件（dsh-sales），数据以 <SALE_DIR>（默认 <数据目录>）下的 Excel 为唯一事实源。
// 结构:
//   - SALES_TOOL_COUNT(15) 个模型工具 (sales_tasks / sales_view / sales_log / sales_sop / sales_summary / sales_next /
//     sales_live / sales_plan / sales_settle / sales_brief / sales_enterprise / sales_flywheel / sales_campaign /
//     sales_digest / sales_contract) 经 ctx.tools.register 注册，
//     同步调用 sales-lib.js（shell.execute 前台，直接返回数据，不经后台 job 轮询——正式插件环境无动态 harness）。
//   - HTTP 端点 (kind: 'prefix', path: /sales/*) 供 client 半 fetch 调用；**当前 40 个 case**（SALES_ROUTE_CASE_COUNT；
//     2026-10-09.4 起 = 原 22 个 + 本机语音转写桥 4 个：speech / speechprepare / transcribe / livecheck；2026-10-12 起
//     + 模型面 1 个：ai；2026-10-13 起 + 六分类页 3 个：standard / custom / pending；2026-10-15 起
//     + 合同台账 1 个：contract；2026-10-21 起 + 四类节奏 1 个：cadence + 右侧对话框 1 个：assistant；
//     2026-10-21 夜起 + 写库预览 2 个：logplan / settleplan；此数**不含** switch 的 default）。方法: POST /sales/<method> body=json；GET 只允许读方法
//     （写方法 settle/enterprise/flywheel/campaign 非 POST → 405，载荷带写意图（settle 恒真 / facts / by+to / referral）→ 403，见下方 B1 加固；
//       2026-10-09.4 起 transcribe/speechprepare/livecheck 也走「只收 POST」）。
// 沙箱: 不再写死模式；每次调用现取宿主/会话策略（见 makeRunner）。
// 数据出口闸（2026-09-17 用户拍板 C 档）：
//   - 关会话遥测由部署层负责（各 profile 的 cordis.patch.yml 里 disabled 掉 session-telemetry-otel；
//     web 端另由 restart-dsh.bat 加 DSH_TELEMETRY_MODE=DISABLED 双保险，桌面端是快捷方式启动、
//     够不着那两道 env，所以桌面端**只靠 patch**）；本插件只做"自证"——/sales/egress 暴露
//     运行时 ctx.get('sessionTelemetry') 是否被加载。
//   - 本插件在 ctx.tools.guard 上挂一道全局闸门：拦"把客户数据送出本机"的工具调用（判定见 egress-guard.js）。
//   - 模型面口径（2026-10-12 用户拍板「A，执行」= A′ 档）：**发模型的东西先脱敏、回来再回填**。
//     实现：本插件的 AI 功能（sales_live / sales_clienttip / POST /sales/ai）在**构造提示词时**就把
//     姓名/手机/公司/微信昵称换成带标签的占位符（<客户1|设计院总工>、<单位1|市政交通>），模型返回后
//     unmask 回真名；台账只记 purpose/模型/耗时/字数。脱敏与回填都在 dsh/redact.js（纯函数，可单测）。
//     残留口子（如实声明，不假装干净）：① 通话转写等**自由文本里客户自述的姓名/公司**遮不住；
//     ② AI 助手**对话面**（14 个工具的原始结果）仍是 C 档原样进模型——那条路要脱敏，用户的问答里就会出现
//     占位符（工具结果就是模型的输入），属于另一个决定，等用户拍板再动（见《销售数据标准》）。
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { assessCall, logPreview, MODE as GUARD_MODE, RULES as GUARD_RULES, injectEgressTools, noteEgressToolDiscover, egressToolDiscover, NETWORK_TOOLS as GUARD_NET_TOOLS, SHELL_TOOLS as GUARD_SHELL_TOOLS } from './egress-guard.js'
import { aiStream, aiStatus, aiRouteStatus, resolveAiRoute, warmLocalRoute, buildLivePrompt, buildClientTipPrompt, buildNextPrompt, buildBriefPrompt, buildDigestPrompt, checkNumbers, checkCitations, aiLogPath } from './ai.js'
// 开源版（2026-11）：数据目录 / 模型通道全部可配置，解析与落盘都在 ./config.js（不依赖任何环境变量也能跑）。
import { resolveDataDir, isConfigured, salesLibPath, dataDirExists, saveConfig, readConfig, aiPolicy, configStatus, PLUGIN_ROOT, DEFAULT_DATA_DIR } from './config.js'
// 批次 3（2026-10-12）：本地词法 RAG —— 只做"本机检索"，不联网、不写盘；/sales/egress 回显语料就绪状态
import { ragStatus } from './rag.js'
// 2026-10-15 合同台账：合同初审提示词复用**同一套脱敏**（createMasker + autoMask），
//   只发这次审核真正要用的字段（最小必要），回来 unmask 回填真名 —— 与 AI 面口径一致。
import { createMasker, autoMask } from './redact.js'
// 2026-10-21 右侧 AI 对话框（m01480）：dock.js = 组装/调模型/抽确认卡；dock-attach.cjs = 图片与文件的多模态入口
import * as dock from './dock.js'
// 2026-10-21 晚（m03070）曾试过把面板的话投进宿主真实会话（agentdock.js）。
//   2026-10-21 夜（m03706）用户明确否决：「不要调用dsh的对话框做来回的桥接，我要sale插件自己具备这个能力。」
//   → 桥接通道整体下线（agentdock.js 不再 import、不再注册路由、面板不再发 action:'agent'）。
//   改成**插件自己具备**：dock.js 直连模型 + 插件侧「查数据」小回路（模型给 lookup/search 动作 →
//   插件在本地 sales-lib 查完贴回去 → 模型再答），写库仍由用户点确认后走 cmdLog 写入口。
// 2026-10-13 批次 5（审计 F12 自证）：闸门"能外传"工具名的字面基础集（运行期并入的见 /sales/egress.guardToolsRuntime）。
//   数组元素形状 { name } 是 import 绑定的只读快照，拍平一次即可（不在任何热路径上）。
const GUARD_BASE_TOOLS = [...GUARD_NET_TOOLS, ...GUARD_SHELL_TOOLS].map((n) => ({ name: n }))

// 2026-10-13 批次 5（审计 F14）：工具数 / HTTP case 数**单一事实源**。
//   原来头注与 cordis.patch.yml 各写一份（13 个工具 / 27 个 case），改代码不同步 → 文档漂移。
//   现在头注从这里生成，cordis.patch.yml 的注释要改时以这两条为准（注册循环与 switch 才是最终事实）。
const SALES_TOOL_COUNT = 15
const SALES_ROUTE_CASE_COUNT = 40

export const name = 'sales'
// 2026-09-14 修正（两个都是上一版"加固"引入的回归，已止血）：
//   ① webServer 是**必需**服务（看板 HTTP 端点）——摘掉它 → 路由注册被 try/catch 吞掉 → 看板 POST 405；
//   ② sandboxPolicy 也是 shell.execute 解析请求的**必需**输入——摘掉它 → policy=undefined → 工具执行报"内部执行异常"。
//   （原来只有"加载时写死 danger-full-access"这一个毛病，现在改成**每次调用现取**、仍在 inject 里声明。）
// 2026-10-12（模型面 A′ 档）：inject 追加 'llm'（宿主进程内模型服务）与 'agentDefaultModel'（当前对话模型）。
//   为什么敢写进 inject：这两个服务由宿主核心提供（feasi 插件已经这么用、在跑），不是可选的第三方 bundle；
//   即便如此，ai.js 仍按**可选**处理（取不到就返回 {ok:false}，规则版照常出结果），不会让插件 pending。
export const inject = ['tools', 'shell', 'webServer', 'sandboxPolicy', 'llm', 'agentDefaultModel']

// 2026-10-08 审计 B7（旧 P2-7）：目录原来硬编码。换机 / 回滚 / 双环境并存时无处可调。
// 开源版（2026-11）：目录解析统一收到 dsh/config.js —— 环境变量 SALE_DIR > 配置文件 dataDir > 默认目录。
//   **每次现取**（不缓存）：首次设置向导写完配置后，同一进程里的后续调用立刻跟上；/sales/egress 回显实际 workdir。
function dataDir() { return resolveDataDir() }
function logPath(name) { return path.join(dataDir(), 'logs', name) }
const ERR_MAX = 20
const CONTRACT_DESTRUCTIVE = { sign: 1, void: 1, archive: 1 }
const CONTRACT_READ_ACTIONS = { list: 1, get: 1, templates: 1, download: 1, review: 1 }
function contractHttpAudit(action, args) {
  try {
    const line = JSON.stringify({
      at: new Date().toISOString(), via: 'http', action,
      合同ID: String((args && (args.合同ID || args.id)) || '').slice(0, 60),
      confirm: args && args.confirm === true,
    })
    const auditFile = logPath('contract-http.log')
    if (existsSync(auditFile) && statSync(auditFile).size > 512 * 1024) {
      try { renameSync(auditFile, auditFile + '.1') } catch (e) { writeFileSync(auditFile, '', 'utf8') }
    }
    appendFileSync(auditFile, line + '\n', 'utf8')
  } catch (e) { /* 审计失败不阻断业务，但进插件错误环 */ noteError('contract.audit', String((e && e.message) || e)) }
}
const LIVE_CHECK_MAX = 256 * 1024
const LIVE_CHECK_KEYS = [
  'where', 'step', 'ok', 'phase', 'api', 'provider', 'catalog', 'ready', 'sources',
  'err', 'notice', 'hint', 'micErr', 'secure', 'devices', 'ua',
  'seg', 'sec', 'bytes', 'peak', 'silent', 'ms', 'textLen', 'text', 'gen', 'busy',
  'lines', 'cues', 'stageOpen', 'customer', 'note',
]
// 插件版本指纹（每次改 dsh/*.js 都要同步换新值；doctor 靠它区分「宿主还是旧插件」和「真故障」）：
//   因为 /sales/summary 的数据来自 sales-lib.js（每次现跑、改了立刻生效，不需要重启），
//   只有插件模块自身（路由 / 工具 schema / 看板 UI）必须重启才生效。
//   demo-2026-09-29 → merge-2026-09-29（取消「价值传递」段，并入「产品演示」）
//   merge-2026-09-29 → desktop-2026-09-29（迁到桌面端 profile，dsh 0.2.0-rc.1）
//   → desktop-fixbtn-2026-09-29（桌面端：看板标题栏压在窗口拖动区里 → 按钮点不着，已避让）
//   → sop-touch-2026-09-29（SOP 新增第 2 段「客户触达」，6 段 → 7 段漏斗；首次直接触达自动推进）
//   → action-engine-2026-09-29（行动引擎：sales_next 作战卡 + sales_plan 今日队列；剔除「最后登陆时间」维度）
//   → action-engine-ui-2026-09-29（看板：队列按优先级编号、批量触达池挪到最后、去掉说明废话）
//   → action-engine-clean-2026-09-29（看板不再提示用量快照状态——"这个不提示"，只留在数据层）
//   → action-engine-nodock-2026-09-29（撤掉聊天框上方总览条——用户："信息提示条也不用"）
//   → audit-2026-09-29（智能体团队审计后的加固：R-3 通道限定、枚举单一事实源、工具描述补「挂起」）
//   → quota-2026-09-29（用户定：电话清单每日上限 25 条，其中首次触达保底 10 条）
//   → quota-split-2026-09-29（用户定：队列在面板上分「首次触达 / 今日跟进」两块）
//   → theme-2026-09-29（看板配色令牌化 + 科技简约：修浅色主题白底看不见的字；禁硬编码语义色）
//   → focus-2026-09-29（新增「重点跟进」状态 + 独立分区：不提醒、每日自看，夹在待定跟进与挂起冷备之间）
//   → result-brief-2026-10-08（结果层 8 值派生 + sales_settle 点名结论 + sales_brief 每日工作台 + 看板结果标签）
//   → result-enterprise-2026-10-08（D3：sales_enterprise 候选盘点/单客户推进建议/企业级台账 + settle 批量点名）
//   → flywheel-2026-10-08（D4：sales_flywheel 13 环飞轮体检 + 成交后/转介绍 2 环 + 【介绍】转介绍留痕）
//   → campaign-2026-10-08（D5：sales_campaign 周战役三批（电话20+微信20+培育轻触达20，互不占额度）+ sales_digest 周复盘）
//   → 2026.10.08.1（全系统审计修复轮：修 A1/A3/A4/A5/A2/A10~A20 + 插件面 B1~B14：
//        HTTP 写面 405/403 三闸、egress 注册面自证、环缓冲错误日志、clampInt、R-8 身份外泄规则（闸门 8 条）、
//        看板说明文字收口；同时把版本号改为可比较的 YYYY.MM.DD.N 形式 —— 见仓库根 CHANGELOG.md）
//   → 2026.10.08.2（热修：package.json 的 dsh.client.inject 误写成服务名 ["slots"] → 看板入口点开空白；
//        已还原为 []（包名依赖边），并在 doctor 加「插件客户端清单合法」静态检查防复发）
//   → 2026.10.08.3（临时诊断版：.2 重启后用户仍报「一点反应都没有」→ client.js 加 sales-diag
//        分步埋点（apply:enter / entry:component-render / overlay:component-render / open-board:event /
//        window.error / unhandledrejection）＋槽位没挂上时的兜底面板，用来定位真正根因；定位后删除）
//        .3 读数（实测）：apply:enter slots=true → entry:component-render → overlay:component-render →
//        open-board:event boardReady=true ×24，**看板组件确实挂载了、点击事件确实派发了，但界面无变化**
//        → 根因在组件内部（open 状态或渲染/可见性），不在槽位注册）
//   → 2026.10.08.4（临时诊断版续：client.js 加 entry:click / overlay:listener-on / overlay:onOpen /
//        overlay:open-change / overlay:dom（看板根节点 #sales-board-root 的 rect/display/visibility/父层），
//        用来区分「open 没置上」还是「DOM 进去了但不可见」；定位后连同 .3 埋点一起删除）
//        .4 读数（实测）：overlay:onOpen → overlay:open-change open=true → **overlay:dom missing=true**
//        （组件确实挂载、open 确实置上了，但 #sales-board-root 没进 DOM）；之后再点击只剩模块级
//        open-board:event、**没有第二次 overlay:onOpen** → 组件那一条贡献被卸载/弃用了。
//        另外同一会话里 `window.error` 抓到 18 条 `Uncaught SyntaxError: Unexpected token ','`（app 启动时）。
//   → 2026.10.08.5（临时诊断版三：把环形缓冲 40→300 并按「同一步骤」聚合（一次点击被 3 个模块实例写 3 条，
//        早期步骤会被挤掉）；window.error 补 file/line/col/stack；BoardErrorBoundary 把捕获到的异常写进
//        诊断 `boundary:catch`（msg+stack+componentStack）并把出错文本改成 fixed 定位（原来是普通 div，
//        槽位容器没尺寸时同样看不见）；overlay:dom 补 errText/slotErrors/bodyLen；监听器 cleanup 记
//        `overlay:listener-off`（区分「组件被卸载」与「事件没到」）。定位后整块删除）
//   → 2026.10.08.6（临时诊断版四 + **首个真修复**：诊断记录加 `inst`（模块评估实例号，实测一次会话
//        `apply:enter` 出现 3 次）；新增 `safeEffect(name, fn)` 把组件里每个 effect 体包起来 —— 宿主渲染器对
//        「条目内抛出的错误」会 reportEntryError 并 abdicate（弃用）该条目，React 随即卸载整棵子树
//        （用户看到「一点反应都没有」），而我们的 BoardErrorBoundary 在 BoardInner 的子树里、接不到
//        BoardInner 自身 effect 抛的错 → 现在 catch 后记 `effect:throw` 并**吃掉**，不再 rethrow。
//        首要嫌疑：:471 的 `ctx.interval(silentRefresh, 30000)` 定时器 effect）
//   → 2026.10.08.7（**真修复 + 清理**：实机读数（localStorage `sales-diag` 56 条）定案根因 =
//        `dsh-sales/dsh/client.js` 末尾 `exports.inject = ['slots']` **漏了 'timer'**，而看板 `[open]` 那个定时器
//        effect 调 `ctx.interval(...)`（内部 `ctx.get('timer')`）→ 抛
//        `cannot get property "timer" without inject`（埋点原文：`effect:throw name="interval"`）
//        → 逃出我们的边界 → 宿主 abdicate 整条贡献 → 面板一点反应都没有。
//        该回归由 2026.10.08.1（审计 B14「收窄 inject」）引入，.2 改错了字段（package.json 的
//        `dsh.client.inject` 是**包名依赖边**，必须保持 []）所以没修好。
//        修：`exports.inject = ['slots', 'timer']`（并把「为什么必须声明 timer」写死在注释里）；定时器 effect
//        再兜一层 try/catch（宿主真不提供 timer 就退回浏览器 setInterval）。
//        清：删除 .3~.6 全部临时埋点（DIAG_KEY/diag/diagTail/mountDiagFallback/模块级 window 监听/`entry:*`/
//        `overlay:*`）、`id="sales-board-root"`、apply/applyImpl 拆分；只留 `safeEffect` 与「条目内抛错会被
//        宿主弃用」的定案注释 + 两处 try/catch 错误牌（渲染失败时至少看得见原文）。
//        实机复验：用户重启后点入口，面板正常开关（`overlay:dom` 实测 x=231 y=40 w=1305 h=689, inDoc=true）
//  2026.10.09.1：新增「通话记录台」Host 半 —— 模型工具 `sales_live`（第 14 个工具）+ 只读 `POST /sales/live`；
//        HTTP 面仍恒只读（不进 HTTP_ONLY_POST / HTTP_WRITE_INTENT）。客户端半的 `exports.inject` 补 `'remote'`
//        （`ctx.get('remote').speech` = 本机语音转写唯一入口）、看板今日队列里加 🎧 入口。
//  2026.10.09.2：**修启动崩溃**——通话记录台最初把入口注册进 `conversation.input.activity`，那是宿主的
//        **single 槽**（官方 voice-input 插件占着：同 priority 已有占用者时，后注册者 register 直接抛错）。
//        dsh-sales 在 profile bundles 里排在 voice-input-bundle **之前** → 我注册成功、官方插件反而炸，
//        它的 fiber 变 FAILED，桌面端渲染层抛 `web boot: 1 entry did not activate` → `reportFatal` → 启动即崩。
//        改挂 list 槽 `sidebar.footer.action`（id=sales-live-entry, order 71）。**铁律：single 槽一律不许抢**
//        （现在 `conversation.input.activity` 零注册，selftest 已加"注册名白名单"断言兜底）。代价：拿不到
//        输入框的 inputActions，「落库 / 问 AI 助手」退回"复制到剪贴板"，其余功能不受影响。
//  2026.10.09.3：通话记录台**外观可调**（用户 2026-10-09 要"能调整位置颜色大小"）——标题栏按住即拖、
//        8 向把手拉大小（右下角 ◢ 标示）、🎨 循环 4 套配色（纸白/墨黑/护眼/高对比）、⤢ 复位；
//        位置/大小/配色存 localStorage 键 `sales-live-view`（纯前端偏好，不进任何数据表）。
//        Host 侧无改动，但客户端 bundle 变了，rev 一起走，方便 doctor 认指纹。
//  2026.10.09.4（**修「点开始通话没反应」的真根因 + 转写改走本插件宿主路由**）：
//        取证：官方 voice-input 的客户端半（`@deepseek-ai/dsh-experimental-client-ui-voice-input/lib/client.js`
//        L5817-5846）是在自己的 apply 里 `ctx.remote.$mount(contribution)` 之后才把 `remote.speech` 命名空间挂上的
//        （api-gateway/lib/client.js L1636-1683 `$mount`→`installNamespace`→`createNamespace`；命名空间服务名
//        `remote.<ns>`）。也就是说官方 UI 插件没跑 → `remote.speech` 根本不存在 → 我原来的 `ctx.get('remote').speech`
//        恒 undefined → 点「开始通话」只落一行提示（用户截图那行就是这个分支）。
//        改架构：**转写不再依赖客户端 remote**，走本插件自己的宿主路由直调宿主服务
//        `speechController`（= `@deepseek-ai/dsh-experimental-api-speech-to-text` 的宿主服务，namespace 'speech'，
//        方法 `catalog()` / `prepare(providerId, {downloadSource})` / `cancelPreparation(id)` /
//        `transcribe({audioBase64, providerId, language}, signal)`；其 transcribe 内含 validateWave 严格校验：
//        必须 16kHz 单声道 PCM16、无额外 chunk、RIFF/data 长度自洽）。
//        新增路由（都只读语义、不碰客户表）：`POST /sales/speech`（服务可用性 + 提供方目录 + 录音上限）、
//        `POST /sales/speechprepare`（下载/加载本机模型，等价官方 UI 的「准备」）、
//        `POST /sales/transcribe`（WAV base64 → 文字）；外加 `POST /sales/livecheck`（浏览器半自检回传 →
//        `logs/live-check.log`，只收 LIVE_CHECK_KEYS 白名单字段）。
//        用 `ctx.get('speechController')` 而**不写进 inject**：voice-input 没装时 inject 会让本插件一直 pending
//        （整个看板跟着不挂），ctx.get 取不到就只降级「复制话术」模式。
//  2026.10.09.5（**转写文本归一：修「[object Object]」**）：宿主 `speechController.transcribe()` 的回执是
//        **对象**（`{ text, audioSeconds, inferenceSeconds }`；官方 `speech-to-text` 的 transcriptSchema，
//        sensevoice provider `lib/index.js:442-446`；官方客户端也是取 `result.value.text`，
//        `…-client-ui-voice-input/lib/client.js:5018` 还把 `text === ''` 当"这段没人说话"）。
//        旧代码 `String(text)` 把整个对象串成 `'[object Object]'` → 用户重启后实测：转写框 4 行全是它。
//        现在宿主 `transcriptText(r)` + 客户端 `liveTextOf(v)` 双向归一（字符串 / {text} / {transcript} /
//        {segments:[{text}]} / {results:[…]}），空文本给一行蓝色提示（"这段没听清…"）而不是静默丢弃。
//  2026.10.12.1（**模型面接入（A′ 档）**，用户 m01114「A，执行」）：新增 dsh/ai.js（唯一模型出口
//        aiStream，走宿主 ctx.llm，不新增 fetch）与 dsh/redact.js（字段级脱敏 + 角色/行业标签 + 回填）；
//        inject + 'llm','agentDefaultModel'；HTTP + POST /sales/ai（action=live|clienttip，点击才调、
//        只收 POST）；sales_live 升级为"先规则、再 AI，8 秒硬超时回落规则"；台账 logs/ai-calls.log
//        （只记 purpose/模型/耗时/字数，不记客户原文）；/sales/egress 回显 maskLevel 与模型可用性。
//  2026.10.12.2（**批次 2：只读面接模型**，用户 m01905「精修做」）：POST /sales/ai 再开三个 action
//        （next 作战卡 / brief 今日工作台 / digest 周复盘）——事实全部来自引擎、字段级脱敏、回来回填；
//        多一道**数字回查** checkNumbers（模型文本里每个 2 位以上数字必须能在发给它的事实里原样找到，
//        否则整段作废回落规则版）；看板在「今日任务」页与「汇总统计」页各加一个 🧠 按钮（点击才调）。
// 2026-10-13.2 批次 5（稳健档）：审计 A1 的必修项 —— ai.js F1（回落云端后 provider/model/local/route 元数据错标）、
//   F2（数字回查必须先于 maxChars 截断，否则超长合法答案被判"编造数字"整段回落规则版）、F9（分工表读失败→可见）、
//   egress-guard.js F12（"能外传"工具名原来只认字面常量 → 注册时并入宿主实际工具名，只加不减）。
// 2026-10-13.4 批次 6b（稳定性）：云端档思考档改成现读分工表（默认 off → wire reasoning_effort:'none'），
//   修「会话模型换成 云端网关 后 sale 全部云端 AI 思考链开着 → 16s 满超时、AI 静默降级成规则版」；
//   配套 profile 的 云端网关/deepseek-flash 声明 reasoningEfforts + compat（off→none，wire 实测 898ms 出正文）。
// 2026-10-21（用户 m01480 / m02018）：sale 面板右侧加 AI 对话框（模型可选 + 图片/文件多模态上传）。
//   服务端半在 dsh/dock.js（组装+调模型）与 dsh/dock-attach.cjs（图片走宿主附件服务、文件就地抽文本）；
//   新增 HTTP case `assistant`（= 第 33 个），只产文字 + 一张「可确认的写库动作」，**绝不直接写表**。
const PLUGIN_REV = '2026.10.21.17'

function makeRunner(ctx) {
  const shell = ctx.shell
  const sandboxPolicy = (typeof ctx.get === 'function' ? ctx.get('sandboxPolicy') : undefined) ?? ctx.sandboxPolicy
  if (!shell) return null
  return async (cmd, argObj) => {
    // 2026-09-14 定版：本机 Windows ACL 沙箱 grantWrite 不可用（插件原作者注释已载明：Windows ACL 沙箱
    //   grantWrite 问题），所以**必须**显式 danger-full-access；但改成每次调用现取（不再加载时缓存一份），
    //   会话中途改配置也能跟上。显式模式不可用时退回宿主默认，并记日志——绝不再出现"没有策略就崩"。
    let policy
    let policyNote = 'danger-full-access'
    try { policy = sandboxPolicy.resolve({ mode: 'danger-full-access' }) }
    catch (e) {
      policyNote = 'explicit 失败: ' + String(e && e.message || e)
      try { policy = sandboxPolicy.resolve(); policyNote += ' → 退回宿主默认' }
      catch (e2) { policy = undefined; policyNote += ' / 默认也失败: ' + String(e2 && e2.message || e2) }
    }
    // 开源版（2026-11）：数据目录由 ./config.js 解析（环境变量 SALE_DIR > 配置文件 dataDir > 默认目录）。
    //   没配置 / 目录不存在 → 不抛异常、不猜路径，回一条结构化错误，看板据此弹「首次设置」向导。
    const dir = dataDir()
    const dirExists = dataDirExists(dir)
    if (!dir || (!dirExists && cmd !== 'init')) {
      return {
        ok: false,
        code: 'UNCONFIGURED',
        error: '还没有设置数据目录。请在销售看板点「首次设置」，或设置环境变量 SALE_DIR / 写入配置文件后再试。',
        hint: { dataDir: dir || '', defaultDataDir: DEFAULT_DATA_DIR, configFile: configStatus().file },
      }
    }
    const lib = salesLibPath(dir)
    if (!lib) {
      return { ok: false, code: 'NO_LIB', error: '找不到数据层脚本 sales-lib.js（插件 lib/ 或数据目录内都缺失）。' }
    }
    const req = {
      command: 'node "' + lib + '" run --dir "' + dir + '"',
      // init 时目录还不存在 → 用它的父目录当工作目录（shell 的工作目录必须是已存在的真实目录）
      workdir: dirExists ? dir : path.dirname(dir),
      timeoutMs: 30000,
      stdoutMaxBytes: 4 * 1024 * 1024,   // 看板走全量 JSON，默认 64KB 上限会截断 → 半截 JSON
      ...(policy !== undefined ? { sandboxPolicy: policy } : {}),
      stdin: JSON.stringify({ cmd, args: [argObj] }),
    }
    let spec

    try { spec = shell.resolve(req) }
    catch (e) {
      noteError('shell.resolve', 'cmd=' + cmd + ' err=' + String(e && e.message || e) + ' policy=' + (policy ? policy.mode : 'undefined') + ' ' + policyNote)
      return { ok: false, error: 'shell.resolve 失败: ' + String(e && e.message || e) + (policyNote ? ' [' + policyNote + ']' : '') }
    }
    try {
      // 2026-09-29 桌面端迁移（红线：别再写回 shell.run）：
      //   DSH 0.2.0-rc.1 把 `shell.run(spec)` 换成了 `shell.execute(spec)` → `await handle.result()`。
      //   用旧写法在桌面端会抛 TypeError，又被下面的 catch 吞成 `{ok:false,error:'内部执行异常'}`
      //   —— 5 个工具 + 整个看板**静默全坏**，比崩溃更难查。
      //   result 的字段没变：exitCode / signal / stdout.{text,truncated} / stderr.{text}。
      const handle = await shell.execute(spec)
      const result = await handle.result()
      const code = result.exitCode
      const so = result.stdout
      const stdout = (so && typeof so.text === 'string') ? so.text : String(so || '')
      const stderr = (result.stderr && typeof result.stderr.text === 'string') ? result.stderr.text : String(result.stderr || '')
      if (so && so.truncated) {
        noteError('stdout.truncated', 'cmd=' + cmd + ' len=' + stdout.length)
        return { ok: false, error: 'sales-lib 输出被截断，拒绝解析半截 JSON' }
      }
      if (code !== 0) {
        noteError('run.exit', 'cmd=' + cmd + ' exit=' + code + ' stderr=' + stderr.slice(0, 500))
        return { ok: false, error: 'sales-lib 执行失败 (exit ' + code + ')' }   // 细节只进日志，不回浏览器
      }
      let parsed
      try { parsed = JSON.parse(stdout.trim()) } catch (e) {
        noteError('json.parse', 'cmd=' + cmd + ' stdout=' + stdout.slice(0, 500) + ' stderr=' + stderr.slice(0, 300))
        return { ok: false, error: 'sales-lib 返回了非法 JSON' }
      }
      if (parsed && parsed.error) {   // 2026-09-14: 库侧异常形状 {error} 必须当失败（以前被当成正常数据）
        noteError('lib.error', String(parsed.error))
        return { ok: false, error: String(parsed.error) }
      }
      return { ok: true, data: parsed }
    } catch (e) {
      noteError('shell.exec', 'cmd=' + cmd + ' ' + String(e && e.message || e))
      return { ok: false, error: '内部执行异常' }
    }
  }
}

// ---------- 开源版：首次设置 / 示例语料 / 模型探活 ----------
// 示例语料在 <插件根>/templates/营销资料库/（仓库里是原创示例，**不是**任何人的真实营销资料）。
// 只补缺、不覆盖：用户自己的语料永远不会被 setup 冲掉。
function copySeedCorpus(dir) {
  const src = path.join(PLUGIN_ROOT, 'templates', '营销资料库')
  const dst = path.join(dir, '营销资料库')
  const copied = []
  try {
    if (!existsSync(src)) return { ok: true, copied, note: '没有 templates/营销资料库（跳过示例语料）' }
    mkdirSync(dst, { recursive: true })
    for (const name of readdirSync(src)) {
      if (!/\.(md|json)$/i.test(name)) continue
      const to = path.join(dst, name)
      if (existsSync(to)) continue
      copyFileSync(path.join(src, name), to)
      copied.push(name)
    }
    return { ok: true, copied }
  } catch (e) {
    return { ok: false, copied, error: '示例语料复制失败：' + String((e && e.message) || e) }
  }
}

// 模型通道探活：真发一次极短请求（几个 token），只回 ok/模型/耗时/错误，**不回内容**。
//   用途：设置向导里点「测试连接」，让用户当场知道 provider/model 名字写对没有。
async function probeModelChannel(ctx) {
  const t0 = Date.now()
  const r = await aiStream(ctx, {
    purpose: 'config-test',
    system: '你是一个连通性测试。只回复 ok 两个字母。',
    messages: [{ role: 'user', text: 'ping' }],
    timeoutMs: 12000,
    maxChars: 20,
    maxTokens: 16,
  })
  return {
    ok: !!r.ok,
    provider: r.provider || '', model: r.model || '', label: r.label || '',
    route: r.route || '', local: !!r.local,
    ms: (r && r.ms) || (Date.now() - t0),
    textLen: String(r.text || '').length,
    error: r.ok ? '' : String(r.error || '模型没有应答'),
  }
}

// 2026-10-08 审计 B10：参数强转原来只 `Number(x) || dft` —— `'abc'`/`''`/`Infinity` 一路透传进库层。
//   插件层先夹一次（库层 cap()/days 上下限是第二道），避免把 NaN/离谱值当"没给"。
function clampInt(v, lo, hi, dft) {
  const n = Number(v)
  if (!Number.isFinite(n)) return dft
  return Math.min(hi, Math.max(lo, Math.floor(n)))
}

// ---------- 右侧 AI 侧栏的上下文组装（2026-10-21 夜，m03706：插件自己具备，不经宿主对话框） ----------
// 客户档案 → 一段给模型看的文字。同一个函数被两处用：面板选中客户时的 contextText、
// 模型自己发 lookup 动作要档案时贴回去的数据。字段只给这次回答真正用得上的（最小必要）。
function profileTextOf(v) {
  if (!v || !v.ok) return ''
  const p = (v.data && v.data.profile) || null
  if (!p) return ''
  // 2026-10-22 用户（客户信息展示）：**重点展示「最后登陆时间」+ 智写/智算使用情况**。
  //   数据来自主表登录/用量列（平台导入 2026-10-21 起每次带 last 与用量）。口径边界没变：
  //   最后登陆/智写登录次数只做事实展示，不参与判定、不写进话术（销售数据标准 13.1）。
  const u = p.usage || {}
  const fmtWan = (n) => { const x = Number(n) || 0; return x >= 10000 ? (x / 10000).toFixed(1).replace(/\.0$/, '') + '万' : String(x) }
  // 2026-10-22 用户：金额「只展示小数点后两位，单位定为万元」（库里仍存元；与 sales-lib 的 fmtMoneyWan 同口径）
  const fmtMoneyWan = (n) => { const x = Number(String(n == null ? '' : n).replace(/[^\d.\-]/g, '')) || 0; return (Math.round(x * 100) / 100 / 10000).toFixed(2) + ' 万元' }
  const uParts = []
  if (Number(u.zhisuan) > 0) uParts.push('智算 ' + u.zhisuan + ' 次')
  if (Number(u.zxLogin) > 0) uParts.push('智写登录 ' + u.zxLogin + ' 次')
  if (Number(u.zxUsed) > 0) uParts.push('智写消耗 ' + fmtWan(u.zxUsed) + ' 字')
  if (Number(u.zxRemain) > 0) uParts.push('智写剩余 ' + fmtWan(u.zxRemain) + ' 字')
  if (Number(u.zxDone) > 0) uParts.push('生成文章 ' + u.zxDone + ' 篇')
  if (Number(u.zxBuy) > 0) uParts.push('已购 ' + fmtWan(u.zxBuy) + ' 字')
  const lines = [
    '客户ID：' + p.id, '公司：' + (p.company || ''), '联系人：' + (p.name || ''),
    '手机：' + (p.phone || ''), '城市：' + (p.city || ''), '来源：' + (p.source || ''),
    '等级：' + (p.level || '未定级'), '跟进状态：' + (p.status || ''), '触达状态：' + (p.touch || ''),
    'SOP阶段：' + (p.stage || '未标注'), '下次跟进：' + (p.next || '待定') + (p.nextMethod ? '（' + p.nextMethod + '）' : ''),
    '最后登陆：' + (p.lastLogin || '无记录') + '（客户信息重点项；只作事实展示，不据此判定意向、不写进话术）',
    '智写智算：' + (uParts.length ? uParts.join(' · ') : '无用量记录')
      + (p.expire ? '｜到期：' + p.expire : ''),
    '是否购买：' + (p.bought || '') + (Number(p.paid) > 0 ? '（已付 ' + fmtMoneyWan(p.paid) + '）' : ''),
    '备注：' + String(p.note || '').slice(0, 800),
  ]
  // 2026-10-28（用户 m03369）：时间轴升序（老的在上、新的在下）→「最近 N 条」取尾部；原来取头部拿到的是最老的 5 条。
  const flows = Array.isArray(v.data.flow) ? v.data.flow.slice(-5) : []
  if (flows.length) {
    lines.push('最近 ' + flows.length + ' 条流水：')
    for (const f of flows) {
      lines.push('- ' + (f.date || '') + ' / ' + (f.method || '') + ' / ' + (f.type || '') + '：' + String(f.what || '').slice(0, 300)
        + (f.react ? '｜反应：' + String(f.react).slice(0, 120) : '') + (f.next ? '｜下一步：' + String(f.next).slice(0, 120) : ''))
    }
  }
  return lines.join('\n')
}

// 今天的实况摘要：让插件侧栏不看客户表也能答「今天该打谁」。
// 只放 id/名字/动作/为什么，不放手机号（模型要电话也没用，面板上就是可点的）。
// 2026-10-21 夜（m06146）：摘要要「跟着用户眼前那一页走」——他看「停住没锚点」时，摘要先给这一页的数字。
//   只读页名，不查额外数据；页名是面板传上来的（白名单内才认，避免被塞任意字符串进 prompt）。
const DIGEST_SCREENS = {
  tasks: '今日任务 / 逾期 / 临期', overdue: '逾期', upcoming: '临期', unscheduled: '未排期',
  focus: '重点跟进（每天自己看）', pending: '待定跟进（超一周才跟）', cold: '挂起冷备（不跟进）',
  first: '待首触（每天 10 个首触）', standard: '标品成交（每两周服务追踪）', custom: '定制开发',
  contract: '合同台账', enterprise: '企业级', flywheel: '飞轮', campaign: '周战役', sop: 'SOP 话术库',
}
// 2026-10-21（m04728 用户）：「AI助手对话时有个极简的思考过程（可折叠）呈现，不然像是突然冒出来的回复一样，
//   中间过程也不知道大模型是否接收到了指令」。→ 插件自己出一份**步骤轨迹**（不靠模型自述）。
//   2026-10-21 夜（m06146）：从 HTTP 分支里抽出来，chat 与 SSE 两条路共用。
// 2026-10-21 夜（m06146 复验抓到）：侧栏对话的调用台账只记数字、绝不记客户内容。
//   抽成函数是因为流式/非流式共用同一条对话回路——台账必须跟着回路走；
//   原先它写在 HTTP 分支里，结果 SSE（面板默认路径）完全不记账（实测：流式 4 次调用台账 0 条）。
function logDockCall(args, C) {
  try {
    if (existsSync(aiLogPath()) && statSync(aiLogPath()).size > 512 * 1024) {
      // 轮转成 .1（只留一代）：整文件清空在并发两请求同时过阈值时会互相清空、台账丢一段。
      try { renameSync(aiLogPath(), aiLogPath() + '.1') } catch (e) { writeFileSync(aiLogPath(), '', 'utf8') }
    }
    const dres = (C && C.dres) || {}
    const mk = (C && C.mk) || { stats: {} }
    const att = (C && C.attachments) || dres.attachments || {}
    appendFileSync(aiLogPath(), JSON.stringify({
      at: new Date().toISOString(), purpose: 'sales-dock',
      mode: (C && C.mode) || 'chat',
      model: (dres.provider ? dres.provider + '/' : '') + (dres.model || ''),
      ms: Number((C && C.ms) || 0),
      inChars: String((args && args.text) || '').length + String((C && C.contextText) || '').length,
      outChars: String(dres.text || '').length,
      ok: !!dres.ok, error: dres.error || '',
      stopped: !!(C && C.stopped),
      mask: (mk && mk.stats) || {}, hops: ((C && C.hops) || []).length,
      images: att.images || 0,
      files: (att.files && att.files.length) || 0,
      histN: (Array.isArray(args && args.messages) ? args.messages.length : 0),
      digestChars: String((C && C.digest) || '').length,
      fileChars: att.fileChars || 0,
      reusedFileChars: dres.reusedFileChars || 0,
    }) + '\n', 'utf8')
  } catch (e) { /* 台账写失败不影响对话 */ }
}

function dockTraceOf(C, args) {
  const dres = (C && C.dres) || null
  const trace = []
  const digest = (C && C.digest) || ''
  const pre = (C && C.pre) || null
  const contextText = (C && C.contextText) || ''
  const hops = (C && C.hops) || []
  if (digest.length) trace.push('读了今日实况 ' + digest.length.toLocaleString('en-US') + ' 字')
  const histN = (Array.isArray(args && args.messages) ? args.messages.length : 0)
  if (histN > 0) trace.push('带上了上文 ' + histN + ' 条')
  const att = (C && C.attachments) || (dres && dres.attachments)
  if (att) {
    if (att.images) trace.push('附件：图片 ' + att.images + ' 张')
    if (att.files && att.files.length) trace.push('附件：文件 ' + att.files.length + ' 个（读到 ' + Number(att.fileChars || 0).toLocaleString('en-US') + ' 字）')
    if (att.errors && att.errors.length) trace.push('附件没吃进：' + String(att.errors[0]).slice(0, 80))
  }
  if (dres && Number(dres.reusedFileChars || 0) > 0) trace.push('用了上一轮上传的文件 ' + Number(dres.reusedFileChars).toLocaleString('en-US') + ' 字（缓存）')
  if (pre && pre.kind) trace.push(pre.kind === 'phone' ? ('按手机号预查 → ' + (pre.hit ? '命中 ' + pre.hit + ' 个客户' : '库里没有')) : ('按客户ID预查 → ' + (pre.hit ? '拿到档案' : '没查到')))
  for (let hi = 0; hi < hops.length; hi++) {
    const h = hops[hi]
    const q = String((h.args && (h.args.id || h.args.q || h.args.kw || '')) || '').slice(0, 24)
    trace.push('查数据 · ' + String(h.tool || '') + (q ? ' ' + q : '') + ' → ' + (h.found ? '命中' : '没查到'))
  }
  if (contextText) trace.push('带了当前客户档案 ' + String(contextText).length.toLocaleString('en-US') + ' 字')
  if (C && C.writeCards && C.writeCards.length) trace.push('备好 ' + C.writeCards.length + ' 张写库确认卡（等你点确认）')
  if (C && C.askCard) trace.push('模型有疑问，需要你拍一下')
  trace.push('发给 ' + String((dres && dres.provider) || '') + '/' + String((dres && dres.model) || ''))
  if (C && C.stopped) trace.push('你中途按了停止（已生成的部分照常保留）')
  else if (dres && dres.ok) trace.push('回了 ' + String(dres.text || '').length.toLocaleString('en-US') + ' 字 · ' + (Number(dres.ms || 0) / 1000).toFixed(1) + ' 秒')
  return trace
}

// 2026-10-22（用户 m01059 截图：AI 气泡里露出 ```json {"calls":…}```、正文还没了）：
//   dres.text 是模型原文（含协议块），dres.blocks.text 才是剥掉协议之后的正文。
//   面板只该给爹看正文；正文真的空（这轮就只查了数据/备了写入卡）时也得说一句话，别丢个空气泡。
function dockShowText(dres, opt) {
  const raw = String((dres && dres.text) || '')
  const blk = (dres && dres.blocks && typeof dres.blocks.text === 'string') ? String(dres.blocks.text) : null
  const txt = (blk !== null ? blk : raw).trim()
  if (txt) return txt
  if (opt && opt.raw) return raw
  const hadProto = /```(?:json)?|"\s*calls\s*"|"\s*action\s*"/.test(raw)
  return hadProto ? '（这一轮只做了查数据/备写入卡，没有正文；要我说点什么就再问一句）' : raw
}

function queueDigestOf(plan, cadence, opt) {
  const out = []
  const screen = String((opt && opt.screen) || '').trim()
  if (DIGEST_SCREENS[screen]) out.push('【你现在看着面板的「' + DIGEST_SCREENS[screen] + '」这一页——回答先扣这一页】')
  const d = (plan && plan.ok && plan.data) ? plan.data : null
  if (d) {
    out.push('今日任务：清单 ' + ((d.list || []).length) + ' 条，已跟 ' + (d.doneToday || 0) + ' 条，还剩 ' + (d.pendingToday || 0) + ' 条（每日上限 ' + (d.daily || 25) + '）')
    out.push('首触配额 ' + (d.firstTouchQuota || 10) + ' 个：今天已跟 ' + (d.firstTouchDone || 0) + '，还没跟 ' + (d.firstTouchPending || 0) + '；首触池还有 ' + (d.firstTouchPool || 0) + ' 个')
    const ft = Array.isArray(d.firstTouch) ? d.firstTouch.filter((x) => !x.done) : []
    // 2026-10-22（用户 m02146）：「把跟进客户的电话展现出来」——以前摘要只给 id/名字/为什么，
    //   模型手里没有号，只好绕。现在每条都带「电话」（脱敏后是 <电话N>，客户端会回填真号）。
    const telOf = (x) => '｜电话 ' + (String((x && x.phone) || '').trim() || '无手机号')
    if (ft.length) {
      out.push('还没跟的首触：')
      for (const x of ft.slice(0, 10)) out.push('- ' + x.id + ' ' + (x.name || '') + telOf(x) + (x.why ? '｜' + x.why : ''))
    }
    const ftSet = {}
    for (const x of (Array.isArray(d.firstTouch) ? d.firstTouch : [])) ftSet[x.id] = 1
    const rest = Array.isArray(d.list) ? d.list.filter((x) => !x.done && !ftSet[x.id]).slice(0, 12) : []
    if (rest.length) {
      out.push('今天还要跟的老客户：')
      for (const x of rest) out.push('- ' + x.id + ' ' + (x.name || '') + telOf(x) + '｜' + (x.action || '') + (x.why ? '｜' + x.why : ''))
    }
  }
  const c = (cadence && cadence.ok && cadence.data) ? cadence.data : null
  if (c) {
    out.push('节奏到点：标品成交服务追踪 ' + (c.standardCount || 0) + ' 个（每两周一次）、待定跟进该跟 ' + (c.pendingCount || 0) + ' 个（超一周才跟）、重点跟进今天没跟 ' + (c.focusCount || 0) + ' 个（不进今日任务，你自己看）、挂起冷备 ' + (c.recallMarked || 0) + ' 个带捞回标记（不跟进）')
  }
  // 2026-10-21 体检（m03962 P2）：原来 out.join('\n').slice(0,4500) 是按字符硬截 ——
  //   正好切在客户名/公司名中间时，模型会读出半个名字，还当成真名照着念。改成**按行**截：能放几行放几行，
  //   放不下就停在一行边界上，末尾标一句「后面还有 N 行没放」。
  // 2026-10-21 夜（m06146）：摘要从 4500 字压到 3500 字——每轮都发，省下来的都是输入 token；
  //   不够的细节让模型用工具现查（比塞满 prompt 准）。
  const lines = out.join('\n').split('\n')
  const CAP = 3500
  let acc = ''
  let cut = 0
  for (let i = 0; i < lines.length; i++) {
    const next = acc ? (acc + '\n' + lines[i]) : lines[i]
    if (next.length > CAP) break
    acc = next
    cut = i + 1
  }
  if (cut < lines.length) acc += '\n…（还有 ' + (lines.length - cut) + ' 行没放进来，问具体客户我会现查）'
  return acc
}

// 2026-10-08 审计 B4：插件级错误环形缓冲（模块级，因为 makeRunner 早于 apply，且要跨 apply 生命周期可见）
const pluginErrors = []
function noteError(tag, msg) {
  const rec = { at: new Date().toISOString(), tag: String(tag || ''), msg: String(msg === undefined || msg === null ? '' : msg).slice(0, 500) }
  pluginErrors.push(rec)
  if (pluginErrors.length > ERR_MAX) pluginErrors.shift()
  try { appendFileSync(logPath('plugin-errors.log'), JSON.stringify(rec) + '\n', 'utf8') } catch (e) {}
  console.error('[sales] ' + rec.tag + ': ' + rec.msg)
}

const textRender = (args, value) => [{ type: 'text', text: JSON.stringify(value, null, 0) }]
const outSchema = { type: 'object', additionalProperties: true }

// ---------- 模型面（A′ 档，2026-10-12） ----------
// 超时/字数按用途分档：现场（通话）等不起 → 硬超时；写完发出去的文案可以慢一点。
// 批次 4 修（2026-10-13 实测）：本地档的超时必须**够它自己把答案生成完**，否则每次都是「白等满超时 →
//   回落云端」，反而更慢。本机 qwen3:8b 实测生成 24.6 tok/s（ctx 8192、85% 显存上 GPU；ctx 2048 时
//   42.6 tok/s 但装不下长提示词）。所以：live 300 tok ≈ 12s → 给 16s；clienttip 600 tok ≈ 25s → 给 30s。
//   next 的 900 tok ≈ 37s 放不进任何合理预算 → 它已在 ai-route.json 里改走云端。
//   2026-10-15 合同初审：900 tok 出风险清单，走云端（ai-route.json routes.contract='cloud'）→ 30s。
const AI_TIMEOUT = { live: 16000, clienttip: 30000, next: 12000, brief: 20000, digest: 20000, contract: 30000 }
// 2026-10-13 批次 6b：**云端档的思考档不再由下面调用点传的 'low' 决定** —— 一律现读 ai-route.json 的
//   `cloud.reasoningEffort`（默认 'off'：云端网关 网关不指定档位＝思考链开着，实测 16s 出不来字；'none' 实测 898ms 出正文）。
//   调用点传的 effort 现在只是**兜底**（分工表没写 cloud 时才用；也没有别的调用方）。改档不用重启。
const AI_MAXCHARS = { live: 600, clienttip: 400, next: 2000, brief: 4000, digest: 4000, contract: 3000 }
// 批次 4：**生成上限**（token）。不传就落 pi-ai 默认 32768 —— 本地档（ctx 8192）会一路生成到把正文挤空。
//   数值按「这段答案本来该多长」定：接话 300 / 文案 600 / 作战卡 900 / 工作台·复盘 1200。
const AI_MAXTOKENS = { live: 300, clienttip: 600, next: 900, brief: 1200, digest: 1200, contract: 900 }
// 批次 1 开 live/clienttip（通话现场 + 整段文案）；批次 2 再挂 next/brief/digest（作战卡/今日工作台/周复盘）。
// 全部都由人点按钮触发、只产文字、绝不写库；模型失败一律回落规则版（用户看到的永远不是空白）。
// 2026-10-15 合同初审（contract）：AI 只是在**规则版之上**补一段说明；AI 不可用/超时/编数字 →
//   一律回落规则版（contract-review.js 的风险清单），绝不让看板空白。
const AI_ACTIONS = { live: 1, clienttip: 1, next: 1, brief: 1, digest: 1, contract: 1 }

// 通话实时话术：规则版先出（永远在），有模型再补一段 AI 接话；AI 失败/超时原样回落，绝不抛。
async function aiLive(ctx, liveData, text, limit) {
  const r = resolveAiRoute(ctx, 'sales-live')
  const p = buildLivePrompt(liveData, text, limit, !!r.local)   // 批次 4 瘦身：本地档资料只取 2 块
  const a = await aiStream(ctx, {
    purpose: 'sales-live', system: p.system, messages: p.messages,
    timeoutMs: AI_TIMEOUT.live, maxChars: AI_MAXCHARS.live, maxTokens: AI_MAXTOKENS.live,
    reasoningEffort: 'low', logPath: aiLogPath(),
  })
  // 批次 3：来源回查——模型还可能顺手编一个资料库里没有的「来源：《…》」，回填前先按本次真发出去的资料摘掉。
  const c = a.ok ? checkCitations(a.text, p.ragBlock) : { text: '', dropped: [] }
  return {
    ok: a.ok, text: a.ok ? p.masker.unmask(c.text) : '', label: a.label, provider: a.provider, model: a.model,
    route: a.route, local: !!a.local, fellBack: a.fellBack || '', firstError: a.firstError || '',
    ms: a.ms, error: a.error || '', timedOut: !!a.timedOut, truncated: !!a.truncated, mask: p.stats,
    ragN: (p.rag || []).length, droppedSources: c.dropped || [],
  }
}

// 微信/短信整段文案（可复制即发）；同样失败回落规则草稿
async function aiClientTip(ctx, tipData) {
  const r = resolveAiRoute(ctx, 'sales-clienttip')
  const p = buildClientTipPrompt(tipData, AI_MAXCHARS.clienttip, !!r.local)
  const a = await aiStream(ctx, {
    purpose: 'sales-clienttip', system: p.system, messages: p.messages,
    timeoutMs: AI_TIMEOUT.clienttip, maxChars: AI_MAXCHARS.clienttip, maxTokens: AI_MAXTOKENS.clienttip,
    logPath: aiLogPath(),
  })
  const c = a.ok ? checkCitations(a.text, p.ragBlock) : { text: '', dropped: [] }
  return {
    ok: a.ok, text: a.ok ? p.masker.unmask(c.text) : '', label: a.label, provider: a.provider, model: a.model,
    route: a.route, local: !!a.local, fellBack: a.fellBack || '', firstError: a.firstError || '',
    ms: a.ms, error: a.error || '', timedOut: !!a.timedOut, truncated: !!a.truncated, mask: p.stats,
    ragN: (p.rag || []).length, droppedSources: c.dropped || [],
  }
}

// ---------- 批次 2（2026-10-12）：只读面接模型（作战卡 / 今日工作台 / 周复盘） ----------
// 与批次 1 同一套纪律（脱敏进、回填出、失败回落规则版），多一道**数字回查**：
//   模型文本里每个 2 位以上数字都必须能在"发给它的事实"里原样找到，否则整段作废回落规则版。
//   为什么这么严：这三段直接给用户当"今天怎么干/下周先打谁"，编一个数就带错一天。
async function aiRead(ctx, prompt, purpose, timeoutMs, maxChars, effort, maxTokens) {
  const a = await aiStream(ctx, {
    purpose, system: prompt.system, messages: prompt.messages,
    timeoutMs, maxChars, reasoningEffort: effort, maxTokens, logPath: aiLogPath(),
  })
  const base = {
    ok: false, text: '', label: a.label, provider: a.provider, model: a.model, ms: a.ms,
    route: a.route, local: !!a.local, fellBack: a.fellBack || '', firstError: a.firstError || '',
    error: a.error || '', timedOut: !!a.timedOut, truncated: !!a.truncated, mask: prompt.stats, badNumbers: [],
  }
  if (!a.ok) return base
  // 2026-10-13 批次 5（审计 F2 修）：数字回查必须跑在**未截断**的全文上（a.textRaw）。
  //   原来查 a.text（已按 maxChars 截断）→ 合法答案里第 maxChars 位之后的数字会被当成"编造的数字"，
  //   整段静默回落规则版（用户只看到规则版，不知道为什么）。a.textRaw 由 ai.js 一并返回。
  const rawForCheck = (typeof a.textRaw === 'string' && a.textRaw) ? a.textRaw : a.text
  const bad = checkNumbers(rawForCheck, prompt.factsText)
  if (bad.length) {
    // text 仍然留一份已截断文本，便于看板/台账看到"被判掉的到底是哪一版"（不作展示用）
    return Object.assign(base, { text: a.text, error: '模型写了引擎事实里没有的数字（' + bad.join('、') + '）：已回落规则版', badNumbers: bad })
  }
  return Object.assign(base, { ok: true, text: prompt.masker.unmask(a.text) })
}

// 客户作战卡（这个客户现在最该做的一件事）
async function aiNext(ctx, nextData) {
  return aiRead(ctx, buildNextPrompt(nextData, AI_MAXCHARS.next), 'sales-next', AI_TIMEOUT.next, AI_MAXCHARS.next, 'low', AI_MAXTOKENS.next)
}

// 今日工作台（今天先打谁）
async function aiBrief(ctx, briefData) {
  return aiRead(ctx, buildBriefPrompt(briefData, AI_MAXCHARS.brief), 'sales-brief', AI_TIMEOUT.brief, AI_MAXCHARS.brief, undefined, AI_MAXTOKENS.brief)
}

// 周复盘（这一周干了什么、卡在哪、下周先打谁）
async function aiDigest(ctx, digestData) {
  return aiRead(ctx, buildDigestPrompt(digestData, AI_MAXCHARS.digest), 'sales-digest', AI_TIMEOUT.digest, AI_MAXCHARS.digest, undefined, AI_MAXTOKENS.digest)
}

// ---------- 2026-10-15 合同台账（第 15 个工具 / 第 32 个 case） ----------
// 生成层（contract-docx.js）与初审层（contract-review.js）是**插件内独立文件**，由另一位实现者交付 →
//   这里一律**惰性 import + try/catch**：文件还没落地/语法坏掉时只让"生成/初审"这两个动作报错，
//   绝不让插件在加载期 failed（静态 import 一个不存在的 ESM = 全套工具与 /sales/* 路由一起消失）。
//   数据面的 9 个动作（list/get/save/status/sign/pay/audit/file/archive/void）仍一律走 run('contract', …)。
async function contractLazy(spec) {
  try {
    const m = await import(spec)
    return (m && (typeof m === 'object' || typeof m === 'function')) ? m : null
  } catch (e) { return null }
}
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
// 生成层取不到时的**只回退 key**（不编"必填字段"——编了会让前端以为校验过了）
const CONTRACT_TEMPLATE_FALLBACK = ['standard', 'enterprise', 'nda']
const CONTRACT_DISCLAIMER = '初审是辅助，不构成法律意见：高风险条款须人工（法务/律师）复核后再签。'

async function contractTemplates() {
  const m = await contractLazy('./contract-docx.js')
  if (m && typeof m.listTemplates === 'function') {
    try {
      const r = m.listTemplates()
      const list = (r && Array.isArray(r.templates)) ? r.templates : (Array.isArray(r) ? r : null)
      if (list && list.length) return { ok: true, zip: (typeof m.zipAvailable === 'function') ? !!m.zipAvailable() : null, templates: list, degraded: false }
    } catch (e) { /* 落到下面的回退 */ }
  }
  return { ok: true, zip: false, templates: CONTRACT_TEMPLATE_FALLBACK.map((k) => ({ key: k })), degraded: true, error: '生成层未就绪（contract-docx.js 取不到）：只回退到模板 key，不能出文件' }
}

// 合同初审提示词：**只发这次审核真正要用的字段**（能不给就不给）——客户ID/客户名不进提示词，
//   对方主体/交付物等自由文本一律走 redact 的 autoMask（出模型前换占位符，回来 unmask 回真名）。
function buildContractPrompt(c, rule, maxChars) {
  const mk = createMasker()
  const d = (c && typeof c === 'object') ? c : {}
  autoMask(mk, d)
  const nodes = Array.isArray(d.付款节点) ? d.付款节点 : []
  const miss = (v) => (v === undefined || v === null || v === '') ? '（缺失）' : v
  const facts = {
    合同类型: miss(d.类型), 我方主体: miss(d.我方主体), 对方主体: miss(d.对方主体),
    对方信用代码: d.对方统一社会信用代码 ? '（已提供，不入提示词）' : '（缺失）',
    金额: miss(d.金额), 税率: miss(d.税率),
    签署日: miss(d.签署日), 生效日: miss(d.生效日), 到期日: miss(d.到期日), 续约: miss(d.续约),
    付款节点: nodes.map((x) => ({ 名称: x && x.名称, 比例: x && x.比例, 日期: x && x.日期, 状态: x && x.状态 })),
    交付物: (d.交付物 && (Array.isArray(d.交付物) ? d.交付物.length : d.交付物)) ? d.交付物 : '（缺失）',
    验收口径: miss(d.验收口径), 试点范围: miss(d.试点范围), 资料权属: miss(d.资料权属),
    部署方式: miss(d.部署方式), 安全要求: miss(d.安全要求), 状态: miss(d.状态),
    规则初审: rule ? {
      结论: miss(rule.结论),
      风险: (Array.isArray(rule.风险) ? rule.风险 : []).map((r) => ({ 级别: r && r.级别, 条款: r && r.条款, 问题: r && r.问题 })),
      待人工: rule.待人工 || [],
    } : '（规则版不可用）',
  }
  const cap = Math.max(600, Math.min(8000, Number(maxChars) || 3000))
  const system = [
    '你是合同法律初审助手，只做**辅助初审**，不出法律意见。事实全部来自引擎台账：缺的字段就写"缺失/待核实"，**不许补编、不许猜**。',
    '输出格式（每项一行，不要表格、不要 markdown 标题）：',
    '①结论：通过 / 有风险 / 待人工（三选一）',
    '②高风险：逐条（没有就写"无"）',
    '③中风险：逐条（没有就写"无"）',
    '④低风险或待核实：逐条（没有就写"无"）',
    '⑤建议动作：一句话',
    '红线：不许承诺效果/中标/通过/胜诉；不许建议由 AI 替代注册人员签章或出设计文件；涉国资监管、招投标的合规事项一律标"待人工确认"。',
  ].join('\n')
  let factsText = mk.mask(JSON.stringify(facts, null, 1))
  let cut = false
  if (factsText.length > cap) { factsText = factsText.slice(0, cap); cut = true }
  const user = '【合同要素与规则初审（引擎整理' + (cut ? '；过长已截断' : '') + '）】\n' + factsText + (cut ? '\n…（后面还有，被截断了，别猜）' : '')
  return {
    system, messages: [{ role: 'user', text: user }], masker: mk, stats: mk.stats,
    factsText: user,   // 数字回查用：模型文本里每个 2 位以上数字都要能在这段里原样找到
    kind: 'contract',
  }
}

// AI 初审（可选加强）：失败/超时/编数字 → aiRead 返回 ok:false，调用方回落规则版
async function aiContract(ctx, contract, rule) {
  const p = buildContractPrompt(contract, rule, AI_MAXCHARS.contract)
  return aiRead(ctx, p, 'contract', AI_TIMEOUT.contract, AI_MAXCHARS.contract, undefined, AI_MAXTOKENS.contract)
}

// 规则初审（contract-review.js 的 reviewContract）：取不到就返回"不可用"，绝不抛
//   2026-10-15 按 lead 口径补：reviewContract 要吃「结构化要素 + **条款正文**」，
//   正文由 W2 的 renderTemplateText({templateKey,data}) 纯文本导出提供（不建 zip）。
//   该导出没到位/返回失败 → 退化为只传结构化字段（条款级项进「待人工」，页面明示「条款级需补正文」）。
async function contractRuleReview(contract) {
  const m = await contractLazy('./contract-review.js')
  const dis = (m && typeof m.REVIEW_DISCLAIMER === 'string' && m.REVIEW_DISCLAIMER) ? m.REVIEW_DISCLAIMER : CONTRACT_DISCLAIMER
  const miss = { ok: false, error: '规则初审不可用（contract-review.js 未就绪）', 结论: '待人工', 风险: [], 待人工: [], 免责: dis, 正文缺失: true, 补正文说明: '条款级需补正文（初审层未就绪）：现在只按结构化要素审，条款级项进「待人工」。' }
  if (!m || typeof m.reviewContract !== 'function') return miss
  // 只按"存在才调"用 renderTemplateText —— 不 hardcode 依赖，也不去自己解析 document.xml
  let text = '', textErr = ''
  try {
    if (typeof m.renderTemplateText === 'function') {
      const t = m.renderTemplateText({ templateKey: String(contract.模板 || contract.templateKey || 'standard'), data: contract })
      if (t && t.ok === true && t.text) text = String(t.text)
      else textErr = String((t && t.error) || 'renderTemplateText 没给出正文')
    } else textErr = 'renderTemplateText 未就绪'
  } catch (e) { textErr = 'renderTemplateText 抛错：' + String(e && e.message || e) }
  const input = Object.assign({}, contract)
  if (text) { input.条款正文 = text; input.正文 = text }
  try {
    const r = m.reviewContract(input)
    if (!r || typeof r !== 'object') return Object.assign({}, miss, { error: '规则初审返回了不可用的形状' })
    return Object.assign({ ok: true }, r, {
      免责: String(r.免责 || dis),
      正文缺失: !text,
      补正文说明: text ? '' : ('条款级需补正文（' + textErr + '）：现在只按结构化要素审，条款级项进「待人工」。'),
    })
  } catch (e) { return Object.assign({}, miss, { error: '规则初审抛错：' + String(e && e.message || e) }) }
}

// 取一份合同（数据面 run('contract',{action:'get'}) 的形状容错：{data:{contract}} / {data:合同} / 合同本体）
async function contractGetOne(run, cid) {
  const r = await run('contract', { action: 'get', 合同ID: cid })
  if (!r || r.ok !== true) return { ok: false, error: String((r && r.error) || '台账读取失败') }
  const d = (r.data && typeof r.data === 'object') ? r.data : r
  const c = (d && d.contract) || ((d && (d.合同ID || d.id)) ? d : null)
  if (!c) return { ok: false, error: '台账里没有这份合同：' + cid }
  return { ok: true, contract: c }
}

// 要素合并：台账记录 + 调用方显式给的「要素」（模板必填字段名如 甲方全称/乙方全称 走这里）
//   用途：条款正文导出（renderTemplateText）与条款级初审要的是模板字段名，台账里未必存得全。
function withElements(contract, a) {
  const extra = (a && a.要素 && typeof a.要素 === 'object') ? a.要素 : {}
  return Object.assign({}, contract, extra)
}

// 生成 .docx：buildContractDocx → saveContractDocx（落在 合同/）→ run('contract',{action:'file'}) 登记 →
//   本机读回字节给看板下载。目录只在本机、文件不出本机（zip 走 dsh-feasi/dsh/ooxml.js 的 fflate，零新依赖）。
async function contractGenerate(run, a) {
  const cid = String((a && a.合同ID) || '').trim()
  if (!cid) return { ok: false, error: '没有合同ID：先把台账存下来（action=save）再出文件' }
  const one = await contractGetOne(run, cid)
  if (!one.ok) return one
  const m = await contractLazy('./contract-docx.js')
  if (!m || typeof m.buildContractDocx !== 'function' || typeof m.saveContractDocx !== 'function') {
    return { ok: false, error: '生成能力不可用：contract-docx.js / fflate 未就绪（模板 key 仍可查：action=templates）' }
  }
  const templateKey = String((a && (a.模板 || a.templateKey)) || 'standard').trim()
  const extra = (a && a.要素 && typeof a.要素 === 'object') ? a.要素 : {}
  const data = Object.assign({}, one.contract, extra)
  // 2026-10-15 字段名兜底（W1 台账字段名 vs W2 模板必填字段名，同义不同名的那几个）：
  //   **只映射方向无关的等价项**；甲方全称/乙方全称这类"谁是谁"的名字**不猜**（猜错方向比报"缺必填"危险得多），
  //   由看板「模板必填」表单显式填（走 a.要素 透传）。缺什么，buildContractDocx 的「缺必填：…」如实报出。
  const alias = {}
  const put = (to, from) => { if (data[to] === undefined || data[to] === '') { const v = data[from]; if (v !== undefined && v !== '') alias[to] = v } }
  put('合同金额', '金额'); put('生效日期', '生效日'); put('到期日期', '到期日'); put('验收标准', '验收口径')
  Object.assign(data, alias)
  const day = String((a && a.日期) || '').trim() || new Date().toISOString().slice(0, 10)
  let built = null
  try {
    built = m.buildContractDocx({ templateKey, data, meta: { 合同ID: cid, 客户ID: one.contract.客户ID, 客户名: one.contract.客户名, 日期: day } })
  } catch (e) { return { ok: false, error: '生成失败：' + String(e && e.message || e) } }
  const buf = built && (built.buffer || built.zip || built.bytes)
  if (!built || built.ok !== true || !buf) return { ok: false, error: String((built && built.error) || '生成失败（没有拿到文件字节）') }
  const dir = path.join(dataDir(), '合同')
  let saved = null
  try {
    saved = await m.saveContractDocx({ dir, 客户ID: one.contract.客户ID, 合同ID: cid, 类型: one.contract.类型 || data.类型, 日期: day, buffer: buf })
  } catch (e) { return { ok: false, error: '写文件失败：' + String(e && e.message || e) } }
  if (!saved || saved.ok !== true || !saved.路径) return { ok: false, error: String((saved && saved.error) || '写文件失败（没有拿到路径）') }
  const reg = await run('contract', { action: 'file', 合同ID: cid, 名: saved.名, 路径: saved.路径, 字节: saved.字节, sha256: saved.sha256 })
  let base64 = ''
  try { base64 = readFileSync(saved.路径).toString('base64') } catch (e) { base64 = '' }
  return { ok: true, data: {
    合同ID: cid, 模板: templateKey, 名: saved.名, 路径: saved.路径, 字节: saved.字节, sha256: String(saved.sha256 || ''),
    部件: Array.isArray(built.部件) ? built.部件 : [], 警告: built.警告 || built.warnings || [],
    已登记: !!(reg && reg.ok), 登记错误: (reg && reg.ok) ? '' : String((reg && reg.error) || ''),
    mime: DOCX_MIME, base64,
  } }
}

// 本机读文件回 base64（台账里的"文件"记录 → 看板落盘；文件不在本机就如实说，不猜）
// 2026-10-21 体检（m03962 P0）：原来只要台账里记了任意路径就 readFileSync+base64 回给调用方 ——
//   配合 action:'file'（路径由调用方给）等于把本机任意文件读出来（客户表也能被这么捞走）。
//   现在只允许 合同/ 目录下的文件，越界一律拒绝。
function pathInContractDir(p) {
  try {
    const abs = path.resolve(String(p || ''))
    const base = path.resolve(path.join(dataDir(), '合同'))
    return abs === base || abs.startsWith(base + path.sep)
  } catch (e) { return false }
}
async function contractDownload(run, a) {
  const cid = String((a && a.合同ID) || '').trim()
  if (!cid) return { ok: false, error: '没有合同ID' }
  const one = await contractGetOne(run, cid)
  if (!one.ok) return one
  const files = Array.isArray(one.contract.文件) ? one.contract.文件 : []
  const want = String((a && a.名) || '').trim()
  const f = want ? files.filter((x) => x && String(x.名 || '') === want).pop() : files[files.length - 1]
  if (!f) return { ok: false, error: want ? ('台账里没有这份文件：' + want) : '台账里还没有生成过文件记录' }
  const p = String(f.路径 || '')
  if (!p || !existsSync(p)) return { ok: false, error: '文件不在本机：' + (p || '(路径为空)') }
  if (!pathInContractDir(p)) return { ok: false, error: '只允许从 sale\\合同\\ 目录取合同文件（这条路径越界了：' + p + '）' }
  try {
    const buf = readFileSync(p)
    return { ok: true, data: { 合同ID: cid, 名: String(f.名 || path.basename(p)), mime: /\.docx$/i.test(p) ? DOCX_MIME : 'application/octet-stream', 字节: buf.length, sha256: String(f.sha256 || ''), base64: buf.toString('base64') } }
  } catch (e) { return { ok: false, error: '读文件失败：' + String(e && e.message || e) } }
}

// 规则初审 + 可选落审计留痕（run('contract',{action:'audit'}) 是唯一写入口，绝不手改 xlsx）
async function contractReviewAction(run, a) {
  const cid = String((a && a.合同ID) || '').trim()
  if (!cid) return { ok: false, error: '没有合同ID：不知道初审哪份合同' }
  const one = await contractGetOne(run, cid)
  if (!one.ok) return one
  const rule = await contractRuleReview(withElements(one.contract, a))
  let 已存 = false
  if (rule.ok && a && a.保存 !== false) {
    const w = await run('contract', { action: 'audit', 合同ID: cid, 模式: String(a.模式 || '规则'), 结论: String(rule.结论 || '待人工'), 风险: rule.风险 || [], 免责: String(rule.免责 || CONTRACT_DISCLAIMER) })
    已存 = !!(w && w.ok)
  }
  return { ok: true, data: { 合同ID: cid, 合同: one.contract, 规则: rule, 风险: rule.风险 || [], 待人工: rule.待人工 || [], 已存, rev: PLUGIN_REV } }
}

// 插件面 4 个动作（templates/generate/review/file+下载）与数据面共用同一个入口：
//   HTTP `case 'contract'` 与工具 sales_contract 都调它 → 两条路行为一致（不会"界面能出文件、模型出不了"）。
async function contractToolAct(run, a) {
  const args = (a && typeof a === 'object') ? a : {}
  const act = String(args.action || '').trim()
  if (act === 'templates') return { ok: true, data: await contractTemplates() }
  if (act === 'generate') return contractGenerate(run, args)
  if (act === 'review') return contractReviewAction(run, args)
  if (act === 'file' && args.下载 === true) return contractDownload(run, args)
  return run('contract', args)
}

// 2026-10-21 体检（m03962 P1）：同一 ctx 上的二次 apply（宿主热重载）会把 15 个工具与 guard
//   再注册一遍，并制造 `duplicate prefix route "/sales"` 噪声。用 WeakSet 认 ctx：真重载会换 ctx
//   （新 fiber），同一个 ctx 的重复 apply 直接跳过（旧注册还在服务）。
const APPLIED_CTX = new WeakSet()
export function apply(ctx, config = {}) {
  if (ctx && APPLIED_CTX.has(ctx)) {
    noteError('apply.duplicate', '同一个 ctx 上第二次 apply（宿主热重载）——跳过重复注册，旧注册继续服务')
    return () => {}
  }
  if (ctx) APPLIED_CTX.add(ctx)
  const run = makeRunner(ctx)
  if (!run) { noteError('shell.missing', '未拿到 shell 服务，插件不注册任何工具/端点（这是异常，请检查 DSH 组合）'); return }

  // ---------- 附件服务子上下文（2026-10-21，用户 m02562「对话框无法准确识别图片」的根因修） ----------
  // 为什么不能直接 ctx.get('attachments')：Cordis 的服务可见性按 fiber 隔离，宿主自己也是用
  //   ctx.inject(['attachments']) 起子上下文才拿到附件服务的（见 dsh-api-session-controller）。
  //   dsh-sales 的 inject 列表没有 attachments（缺服务会让整个插件 pending，不能硬加），
  //   所以这里用 ctx.inject 起一个**可选**子上下文：拿到了就交给 dock 的图片通道，拿不到就降级为
  //   「图片送不进模型、文字照常」——插件装载与其余功能完全不受影响。
  let attachCtx = null
  let attachInjected = false
  let attachWarned = false
  // 2026-10-21 夜（m03962 体检）：实测有两次 apply 起来时 ctx 上没有 inject（日志
  //   plugin-errors.log: `attachments.inject … ctx.inject is not a function`），
  //   导致图片永久降级。改成「懒取 + 只起一次子上下文」：
  //   ① 先看同 fiber 能不能直接拿到服务；② 拿不到且 ctx.inject 可用才起子上下文（只起一次）；
  //   ③ 都没有就返回 null，dock 照常走文字（不影响其余功能）。
  const attachmentsCtx = () => {
    if (attachCtx) return attachCtx
    // ① 三级退让现取（含「借已注入服务的 ctx」这条，2026-10-21 晚实测这条路才通）：见 dock.attachmentsProbe
    try { const svc = dock.attachmentSvc(ctx); if (svc) { attachCtx = svc; return attachCtx } } catch (e) { /* 继续 */ }
    // ② 退让：起一个可选子上下文（宿主版本里 ctx.inject 可用时）
    if (!attachInjected && typeof ctx.inject === 'function') {
      attachInjected = true
      try {
        ctx.inject(['attachments'], (c) => {
          attachCtx = c
          return () => { attachCtx = null }
        })
      } catch (e) {
        attachCtx = null
        if (!attachWarned) { attachWarned = true; noteError('attachments.inject', '附件服务子上下文没起来，图片上传会降级为只发文字：' + String((e && e.message) || e)) }
      }
    }
    return attachCtx
  }
  attachmentsCtx()


  // 2026-10-21 晚（用户：「不能客户跟进处理」）：用户习惯直接甩一串手机号 / 客户ID，就一句话。
  //   模型要自己"决定去查"才行 → 容易问一圈、甚至拿错关键字。这里**在发模型之前**先把消息里的
  //   手机号/客户ID 在本地查出来塞进上下文（一次本地 search/view，不出网），模型一开口就有真数据。
  const preLookupOf = async (txt, mk) => {
    const t = dock.preLookupTarget(txt)
    const phone = t.phone
    const cid = t.cid
    if (!phone && !cid) return { text: '', kind: '', hit: 0 }
    try {
      if (cid) {
        const v = await run('view', cid)
        if (!v || !v.ok || !v.data || !v.data.profile) return { text: '（消息里的客户ID ' + cid + ' 没查到档案，如实告诉你）', kind: 'id', hit: 0 }
        try { autoMask(mk, v.data) } catch (e) {}
        return { text: '【插件已按你消息里的客户ID预查到的档案】\n' + mk.mask(profileTextOf(v)), kind: 'id', hit: 1 }
      }
      const r = await run('search', phone)
      const d = (r && r.data) || {}
      const rows = Array.isArray(d.hits) ? d.hits : []
      if (!rows.length) return { text: '【插件已按你消息里的手机号 ' + phone + ' 查了一遍，库里没有这个客户】', kind: 'phone', hit: 0 }
      try { autoMask(mk, rows) } catch (e) {}
      const lines = rows.slice(0, 3).map((x) => '- ' + (x.id || '') + ' ' + (x.name || '') + (x.company ? '（' + x.company + '）' : '')
        + '｜' + (x.level || '未定级') + '｜' + (x.stage || '未标注') + '｜状态 ' + (x.status || '')
        + (x.next ? '｜下次跟进 ' + x.next : ''))
      return { text: '【插件已按你消息里的手机号 ' + phone + ' 预查到 ' + rows.length + ' 个客户】\n' + mk.mask(lines.join('\n')), kind: 'phone', hit: rows.length }
    } catch (e) {
      return { text: '', kind: '', hit: 0, error: String((e && e.message) || e) }
    }
  }

  // 2026-10-22（用户 m01260）：消息里没有手机号/客户ID 时，也要在**本地、遮罩之前**把人认出来。
  //   原来 preLookupOf 只认手机号/客户ID → 用户写「景德镇东呈工程咨询有限公司 … 催促黄总…」时插件不预查，
  //   而用户原话与实况摘要发模型前都被脱敏成 <单位1|咨询公司>，模型只能反问「是哪个客户」。
  //   现在：有身份线索（公司名/XX总/XX老师）就先跑一次底盘 resolve（只读、不出网），
  //   把「客户ID + 对应占位符」一起贴给模型 —— ID 是内部编号，不是身份信息，可以出模型。
  const preResolveOf = async (txt, mk) => {
    const s = String(txt || '').trim()
    if (s.length < 2) return { text: '', kind: '', hit: 0, topId: '', unique: false }
    const hint = dock.preResolveTargets(s)
    if (!hint.any) return { text: '', kind: '', hit: 0, topId: '', unique: false }
    let r = null
    try { r = await run('resolve', s) } catch (e) { return { text: '', kind: '', hit: 0, topId: '', unique: false, error: String((e && e.message) || e) } }
    const d = (r && r.data) || {}
    const cands = Array.isArray(d.candidates) ? d.candidates : []
    if (!d.ok || !cands.length) {
      return { text: '【插件已在本机解析你这条消息里提到的客户：客户表里没有匹配。不许瞎认，如实说没查到。】', kind: 'resolve', hit: 0, topId: '', unique: false }
    }
    try { autoMask(mk, cands) } catch (e) { /* noop */ }
    // 关键：名字用 mk.mask 出来的**占位符**，与模型在别处看到的一致 → 模型能对上"占位符=哪个客户ID"
    const lines = cands.slice(0, 5).map((x) => '- 客户ID ' + String(x.id || '') + '｜' + mk.mask(String(x.name || ''))
      + (x.contact ? '（联系人 ' + mk.mask(String(x.contact)) + '）' : '')
      + '｜' + String(x.level || '未定级') + (x.stage ? '｜' + x.stage : '') + (x.status ? '｜状态 ' + x.status : '')
      + '｜匹配 ' + String((x.matched || []).join('/') || '') + ' ' + Number(x.score || 0) + ' 分')
    const head = d.unique
      ? '【插件已在本机认出你这条消息说的是客户ID ' + String(d.topId || '') + '（唯一命中）——落库/查档案直接用这个ID，不许再反问"是哪个客户"】'
      : '【插件已在本机解析你这条消息里提到的客户，候选 ' + cands.length + ' 个（分数高者优先；要落库必须用这里的客户ID，别自己编）】'
    // 2026-10-22（用户 m01733）：把唯一命中的真名/联系人留给写卡用（面板上要显示公司名，不能只显示客户ID）
    const top0 = cands[0] || null
    const top = (d.unique && top0)
      ? { id: String(top0.id || ''), name: String(top0.name || ''), contact: String(top0.contact || '') }
      : null
    // 2026-10-22（用户 m02366「都修」）：开场一律用库里的原文——
    //   AI 自己写的「开场」措辞飘（还问过「这些话术是调库生成的吗」）。唯一命中时由模板引擎出一句，
    //   贴给模型的是**原文**，模型只许挑/删、不许改写；多候选时不给（还没认准人）。
    let openLine = ''
    if (d.unique && String(d.topId || '').trim()) {
      try {
        const ob = await run('open', String(d.topId || ''))
        const od = (ob && ob.data) || {}
        if (od && od.ok && od.open) openLine = String(od.open)
      } catch (e) { /* noop：出不来开场就不给，模型只给信息和下一步 */ }
    }
    return {
      text: head + '\n' + lines.join('\n')
        + (openLine
          ? '\n【开场原文（照这句说/照这句发：可以有删减，不许改写、不许另写）】\n' + openLine
          : ''),
      kind: 'resolve', hit: cands.length, topId: String(d.topId || ''), unique: !!d.unique, top, openLine
    }
  }

  // 2026-10-22（用户 m01260）：写库确认卡也要「认人」——
  //   ① 卡里的字段可能带占位符 → 先回填真值（面板要显示真人真名，写库也要落真值）；
  //   ② 模型常常只给「公司名/人名」不给客户ID（过去直接报"没有客户ID，不能写库"），
  //      这时把预解析得到的客户ID补上（唯一命中才补，多候选绝不猜）。
  // 2026-10-22（用户 m01733）：卡上只有客户ID时，面板显示「客户 C-…」，跟旁边 SOP 卡顶部的公司名对不上，
  //   用户以为写错了人（其实是同一个客户）。这里把**客户名/联系人**一并挂到 card.customer 上，
  //   面板统一渲染成「公司名（联系人）· 客户ID」。
  const custNameCache = new Map()
  const custDisplayOf = async (id, pre) => {
    const k = String(id || '').trim()
    if (!k) return null
    if (pre && pre.top && String(pre.top.id || '') === k && String(pre.top.name || '').trim()) {
      return { id: k, name: String(pre.top.name), contact: String(pre.top.contact || '') }
    }
    if (custNameCache.has(k)) return custNameCache.get(k)
    let out = null
    try {
      const r = await run('resolve', k)
      const c = ((r && r.data && r.data.candidates) || [])[0]
      if (c && String(c.id || '').trim() === k) out = { id: k, name: String(c.name || ''), contact: String(c.contact || '') }
    } catch (e) { out = null }
    custNameCache.set(k, out)
    return out
  }
  const repairWriteCard = async (card, mk, pre) => {
    if (!card || typeof card !== 'object') return card
    const out = Object.assign({}, card)
    const src = (card.args && typeof card.args === 'object') ? card.args : {}
    const args = {}
    for (const k of Object.keys(src)) {
      const v = src[k]
      args[k] = (typeof v === 'string' && mk) ? mk.unmask(v) : v
    }
    out.args = args
    const hasId = !!String(args.id || '').trim()
    const errTxt = String(card.error || '')
    const idProblem = !hasId || /客户ID/.test(errTxt)
    if (!card.ok && idProblem && pre && pre.topId) {
      if (card.action === 'settle') {
        out.ok = true
        out.error = ''
        out.repaired = '客户ID按消息线索补上：' + pre.topId
      } else if (String(args.what || '').trim()) {
        out.ok = true
        out.error = ''
        out.repaired = '客户ID按消息线索补上：' + pre.topId
      }
      if (out.ok) args.id = pre.topId
    }
    if (out.ok !== false && String(args.id || '').trim()) {
      try {
        const c = await custDisplayOf(args.id, pre)
        if (c && String(c.name || '').trim()) out.customer = c
      } catch (e) { /* noop：拿不到名字不影响写库 */ }
    }
    // 2026-10-29（用户 m03421 截图：写卡「方式：会议」→ 点了「✅ 确认写入」才报「方式不合法: 会议」）：
    //   卡片必须在**生成时**就跑一遍写库预演（logplan / settleplan —— 与真写同一条 cmdLog/cmdSettle 路径，
    //   只跳过落盘）。预演过了才给「确认写入」按钮；底盘把「会议/面谈/演示」这类口语词归一了的，
    //   直接用归一后的 args 覆盖卡片（并把改动记进 fixed，面板上显示「✎ 插件替你改了…」）；
    //   预演过不了的，卡片退成红字说明（不给他一个注定失败的按钮）。
    if (out.ok !== false && String(args.id || '').trim()) {
      try {
        const plan = await run(card.action === 'settle' ? 'settleplan' : 'logplan', args)
        const pd = (plan && plan.data) || {}
        const pass = !!(plan && plan.ok && pd && pd.ok)
        if (pass) {
          if (Array.isArray(pd.fixed) && pd.fixed.length) {
            out.args = Object.assign({}, args, (pd.args && typeof pd.args === 'object') ? pd.args : {})
            out.fixed = (out.fixed || []).concat(pd.fixed)
          }
          out.planned = true
        } else {
          const msg = String((pd && pd.message) || (plan && plan.error) || '预演没通过')
          out.ok = false
          out.blocked = true
          out.error = msg + '（这张卡没给「确认写入」按钮：把这条改成能写的再试，或直接说「帮我记一条 + 内容」）'
        }
      } catch (e) { /* 预演自己挂了：不拦，真写时再报错（宁可让你点，也不能因为预演失败把卡吞掉） */ }
    }
    return out
  }

  // ---------- 2026-10-21 夜（协议 v2 / m06146）----------
  //   模型能用的**全部只读工具**都走这里（DOCK_TOOLS 是唯一清单，工具名 ↔ 底盘命令一一对应）。
  //   一次回答里可以连着要几个（parseBlocks 已限一轮 3 个），每个结果都压成短文本贴回，超出截断。
  //   写工具（sales_log / sales_settle）**不在**这里执行——它们只产出确认卡，用户点确认才落库。
  const dockLine = (x) => '- ' + String(x.id || '') + ' ' + String(x.name || '')
    + '｜' + String(x.level || '未定级') + (x.stage ? '｜' + x.stage : '') + (x.status ? '｜' + x.status : '')
    // 2026-10-22（用户 m02146）：以前这行不给手机号 → 模型被要求「把跟进客户的电话展现出来」时手里根本没号，
    //   只能绕开话题聊别的。号在这里给全（`mk.mask(note)` 之后变 <电话N> 占位符，模型原样输出、客户端回填真号）。
    + '｜电话 ' + (String(x.phone || '').trim() || '无手机号')
    + (x.next ? '｜下次 ' + x.next : '') + (x.silentDays !== undefined ? '｜静默 ' + x.silentDays + ' 天' : '')
  const dockRows = (rows, n) => (rows || []).slice(0, n || 8).map(dockLine).join('\n')
  const dockCadence = (d) => ['重点跟进（每天看）', '标品成交（每 14 天服务追踪）', '待定跟进（超一周再跟）']
    .map((label, i) => {
      const k = ['focus', 'standard', 'pending'][i]
      const rows = (d && d[k]) || []
      const due = rows.filter((x) => x && x.due).length
      return '· ' + label + '：' + rows.length + ' 个（到点 ' + due + '）\n' + dockRows(rows.filter((x) => x && x.due), 6)
    }).join('\n')
  const dockTasks = (d) => [
    '逾期 ' + Number((d && d.overdueCount) || 0) + ' 个：\n' + dockRows(d && d.overdue, 6),
    '临期（' + Number((d && d.windowDays) || 7) + ' 天内）' + Number((d && d.upcomingCount) || 0) + ' 个：\n' + dockRows(d && d.upcoming, 6),
    '未排期 ' + Number((d && d.unscheduledCount) || 0) + ' 个\n' + dockRows(d && d.unscheduled, 4),
    '今天到期 ' + Number(((d && d.today) || []).length) + ' 个：\n' + dockRows(d && d.today, 6),
    '锚点到点 ' + Number((d && d.anchorDueCount) || 0) + ' 个',
  ].join('\n')
  const dockBrief = (d) => {
    const w = (d && d.watch) || {}, g = (d && d.gaps) || {}, bh = (d && d.blackhole) || {}
    const t = (d && d.todo) || {}
    return [
      '待打：必打 ' + ((t.must || []).length) + ' / 该打 ' + ((t.should || []).length),
      '今天已跟 ' + Number((d && d.doneCount) || 0) + ' 个',
      '红灯：锚点到点 ' + Number(w.anchorDueCount || 0) + '｜停住无锚点 ' + Number(g.stuckNoAnchor || 0) + '｜黑洞 ' + Number(bh.count || 0),
      '异常：无手机 ' + Number(g.noPhone || 0) + '｜未定级 ' + Number(g.unleveled || 0) + '｜未入段 ' + Number(g.notStarted || 0),
      '七天内到期 ' + Number(w.expireIn7 || 0) + ' 个｜静默 ' + Number(w.stallCount || 0) + ' 个',
      '必打前 6：\n' + dockRows(t.must, 6),
    ].join('\n')
  }
  const dockSummary = (d) => {
    const kv = (o) => Object.keys(o || {}).map((k) => k + ' ' + o[k]).join('／')
    return '客户 ' + Number((d && d.total) || 0) + ' 个\n状态：' + kv(d && d.status) + '\n触达：' + kv(d && d.touch) + '\n分类：' + kv(d && d.buckets)
  }
  const dockSop = (d) => {
    const steps = (d && (d.steps || d.sop || d.list)) || []
    const head = (d && (d.stage || d.result || d.query)) ? ('【' + String(d.stage || d.query) + '】\n') : ''
    if (!steps.length) return head + String((d && d.note) || '（没有匹配的话术/步骤）').slice(0, 1200)
    return head + steps.slice(0, 8).map((s, i) => (i + 1) + '. ' + String((s && (s.title || s.name || s.what || s.text)) || '').slice(0, 160)
      + ((s && (s.script || s.say)) ? '\n   话术：' + String(s.script || s.say).slice(0, 200) : '')).join('\n')
  }
  const dockContract = (d) => {
    const rows = (d && (d.list || d.contracts)) || []
    if (!rows.length) return '合同台账里没有合同（线上自助成交不进台账，只留主表/流水）'
    return '合同 ' + rows.length + ' 份：\n' + rows.slice(0, 8).map((c) => '- ' + String((c && (c.合同ID || c.id)) || '') + ' '
      + String((c && (c.客户 || c.name)) || '') + '｜' + String((c && (c.状态 || c.status)) || '') + '｜' + String((c && (c.金额 || c.amount)) || '')).join('\n')
  }
  const dockToolCall = async (call, mk) => {
    const t0 = Date.now()
    const t = dock.dockToolByName(call && call.tool)
    if (!t || t.write) return { ok: false, note: '', error: '不认识的工具：' + String((call && call.tool) || ''), ms: 0 }
    const a0 = (call && call.args) || {}
    // 2026-10-22（用户 m01260）：模型拿到的上下文/工具结果都是占位符，它照着参数里写回 <单位8> 很正常；
    //   这里先回填成真值再查，否则「按占位符搜」必然 0 命中——过去"查不到人"的一大半是这个原因。
    const a = {}
    for (const k of Object.keys(a0)) {
      const v = a0[k]
      a[k] = (typeof v === 'string' && mk) ? mk.unmask(v) : v
    }
    let r = null
    try { r = await run(t.cmd, t.arg(a)) } catch (e) { return { ok: false, note: '', error: String((e && e.message) || e).slice(0, 120), ms: Date.now() - t0 } }
    if (!r || !r.ok) return { ok: false, note: '', error: String((r && r.error) || '查询没跑通').slice(0, 120), ms: Date.now() - t0 }
    const d = r.data || {}
    let note = ''
    try {
      if (t.name === 'sales_view') note = '【客户档案】\n' + profileTextOf(r)
      else if (t.name === 'sales_search') {
        const rows = dock.searchRowsOf(d)
        note = rows.length ? ('【按「' + String(a.q || '') + '」查到 ' + rows.length + ' 个客户（最多 8 个）】\n' + dockRows(rows, 8))
          : ('【按「' + String(a.q || '') + '」没查到匹配的客户】')
      } else if (t.name === 'sales_today') note = '【今日任务】\n' + queueDigestOf(r, null)
      else if (t.name === 'sales_cadence') note = '【四类节奏】\n' + dockCadence(d)
      else if (t.name === 'sales_tasks') note = '【任务池】\n' + dockTasks(d)
      else if (t.name === 'sales_brief') note = '【今日简报】\n' + dockBrief(d)
      else if (t.name === 'sales_summary') note = '【总览】\n' + dockSummary(d)
      else if (t.name === 'sales_sop') note = '【SOP / 话术】\n' + dockSop(d)
      else if (t.name === 'sales_contract_list') note = '【合同台账】\n' + dockContract(d)
      else note = '【' + t.name + '】\n' + JSON.stringify(d).slice(0, 1500)
    } catch (e) { return { ok: false, note: '', error: '结果整理失败: ' + String((e && e.message) || e).slice(0, 80), ms: Date.now() - t0 } }
    if (mk) { try { autoMask(mk, d) } catch (e) { /* noop */ } ; note = mk.mask(note) }
    return { ok: true, note, ms: Date.now() - t0 }
  }

  // ---------- 2026-10-21 夜（m06146）：侧栏 AI 的「一轮对话」= 上下文 + 工具回路 + 结果汇总 ----------
  //   原来这段整个写在 HTTP 的 chat 分支里，SSE 流式没法复用。抽出来以后两条路共用同一套：
  //   · 读工具：模型一次要点几个就查几个（一轮 ≤3、整轮 ≤6），结果贴回去再审，最多 3 轮；
  //   · 写工具：只出确认卡（writeCards），**绝不在这里落库**——用户点确认才走 action:'log'/'settle'；
  //   · 反问：模型要问就出 askCard，面板渲染成「需要你确认」的选项；
  //   · 停止：hooks.shouldStop() 为真时让 ai.js 立刻收流（分块边界），已生成的文字照常返回。
  // 2026-10-22（用户 m01260）：一轮 3 跳/6 次调用经常「还没查完就熄火」——先认人、再查档案、再定方案
  //   就吃满 3 轮；放宽到 4 跳/8 次（都是本地查询，不额外出网，只多几秒）。
  const DOCK_MAX_ROUNDS = 4
  const DOCK_MAX_CALLS = 8
  const DOCK_MAX_PER_ROUND = 3
  const DOCK_BUDGET_MS = 240000
  const dockConverse = async (args, hooks) => {
    const A = args || {}
    const H = hooks || {}
    const mk = createMasker()
    const t0 = Date.now()
    let contextText = ''
    const dcid = String(A.id || '').trim()
    if (dcid) {
      const v = await run('view', dcid)
      if (v.ok && v.data && v.data.profile) {
        const p = v.data.profile
        mk.addPerson(p.name); mk.addOrg(p.company); mk.addPhone(p.phone); mk.addWechat(p.wechat)
        contextText = profileTextOf(v)
      } else if (!v.ok) {
        contextText = '（你选了客户 ' + dcid + '，但档案没读出来：' + String((v && v.error) || '未知原因') + '）'
      }
    }
    let digest = ''
    try {
      const [pr, cr] = await Promise.all([run('plan', {}), run('cadence', {})])
      try { autoMask(mk, pr && pr.data); autoMask(mk, cr && cr.data) } catch (e) { /* noop */ }
      digest = mk.mask(queueDigestOf(pr, cr, { screen: A.screen }))
    } catch (e) {
      digest = '（今日实况摘要这次没生成出来：' + String((e && e.message) || e).slice(0, 80) + '）'
      noteError('assistant.digest', String((e && e.message) || e))
    }
    let pre = { text: '', kind: '', hit: 0 }
    try { pre = await preLookupOf(String(A.text || ''), mk) } catch (e) { pre = { text: '', kind: '', hit: 0 } }
    // 2026-10-28（用户 m03151）：先判用户这一轮在干嘛——录入跟进，还是问「这个客户怎么跟」。
    //   判成什么就把规矩写进提示（intentNote）：录入 → 直接出写卡、别讲策略；咨询 → 只给判断+下一步+开场原文、别出写卡。
    let intent = { kind: '', why: '', score: { log: 0, advise: 0 } }
    try { intent = dock.classifyIntent(String(A.text || '')) } catch (e) { intent = { kind: '', why: '', score: { log: 0, advise: 0 } } }
    const intentNote = intent.kind === 'log'
      ? '【这一轮你在录入跟进，不是在问策略】把这段跟进整理成写卡（action log）：id 用上面给的客户ID；method/type/what 从他的原话取（what 用他的原话精简，别加戏）；日期/反应/下一步/排期他没说就留空，不许编。别回策略、别给开场。'
      : intent.kind === 'advise'
        ? '【这一轮你在问「这个客户怎么跟」，不是录入】只给三样：判断（卡在哪、为什么）+ 下一步动作 + 开场原文（插件给了就照说）；不要出写卡，除非他明确说「记一条/落库」。'
        : ''
    // 2026-10-22（用户 m01260）：手机号/客户ID 没预查到（或者压根没提）时，再用身份解析兜一层
    if (!pre.hit) {
      try {
        const rp = await preResolveOf(String(A.text || ''), mk)
        if (rp && rp.text) pre = rp
      } catch (e) { /* noop */ }
    }
    let dres = null
    let best = null
    // 2026-10-21 夜实测（用户 m06887）：附件回执必须取**第一跳**的——
    //   图片/文件只发第一轮，第二轮起 callArgs.images/files 被清空，若前面还查过数据（工具跳），
    //   最后那一跳的 attachments 就是全 0，面板于是显示「收到 0 张图」而模型其实收到了图。
    let attach0 = null
    let toolNote = ''
    let stopped = false
    const hops = []
    const writeCards = []
    let askCard = null
    let totalCalls = 0
    const deadline = t0 + DOCK_BUDGET_MS
    for (let round = 0; round < DOCK_MAX_ROUNDS; round++) {
      const left = deadline - Date.now()
      if (left < 20000) break
      const callArgs = Object.assign({}, A)
      if (round > 0) { callArgs.text = ''; callArgs.images = []; callArgs.files = [] }   // 附件/图片只发第一轮
      dres = await dock.chat(ctx, callArgs, {
        contextText,
        digest,
        toolNote,
        preNote: (round === 0 ? pre.text : ''),
        intentNote,
        attachCtx: attachmentsCtx(),
        mask: (x) => mk.mask(x),
        unmask: (x) => mk.unmask(x),
        timeoutMs: Math.min(180000, left),
        onDelta: H.onDelta,
        shouldStop: H.shouldStop,
      })
      if (dres && dres.stopped) stopped = true
      if (round === 0 && dres && dres.attachments) attach0 = dres.attachments
      if (!dres || !dres.ok) break
      best = dres
      const blk = dres.blocks || { calls: [], writeCards: [], ask: null }
      if (blk.ask && !askCard) askCard = blk.ask
      const wcs = blk.writeCards || []
      for (let wi = 0; wi < wcs.length && writeCards.length < 2; wi++) writeCards.push(await repairWriteCard(wcs[wi], mk, pre))
      const calls = (blk.calls || []).slice(0, DOCK_MAX_PER_ROUND)
      if (!calls.length) break
      const notes = []
      for (let ci = 0; ci < calls.length; ci++) {
        if (totalCalls >= DOCK_MAX_CALLS) break
        totalCalls++
        const c = calls[ci]
        const r = await dockToolCall(c, mk)
        hops.push({ tool: String(c.tool || ''), args: c.args || {}, found: !!r.ok, error: r.ok ? '' : String(r.error || '').slice(0, 120), ms: r.ms })
        if (H.onTool) { try { H.onTool({ tool: String(c.tool || ''), ok: !!r.ok }) } catch (e) { /* noop */ } }
        notes.push(r.ok ? r.note : ('【' + String(c.tool || '') + ' 没查成】' + String(r.error || '') + '（如实告诉你查不到，别自己编）'))
      }
      if (!notes.length) break
      toolNote = notes.join('\n\n')
      if (H.onRound) { try { H.onRound({ round: round + 1, tools: calls.length }) } catch (e) { /* noop */ } }
    }
    if (!(dres && dres.ok) && best) dres = best
    // 2026-10-28（用户 m03151）：判成「录入跟进」、客户也认出来了，但模型一张写卡都没出 →
    //   插件按用户原话整理一张**待确认**的卡（confirmCard 才落库，绝不自动写）。不这么做的话，
    //   模型答一堆"建议你这么说"，用户还得自己再教一遍「帮我记一条」。
    if (intent.kind === 'log' && !writeCards.length) {
      try {
        const fb = dock.draftLogCard(String(A.text || ''), (pre && pre.topId) || dcid || '')
        if (fb && fb.ok) writeCards.push(fb)
      } catch (e) { /* noop */ }
    }
    // 附件回执统一用第一跳的（见 attach0 注释）；没有附件时它本来就是全 0，不影响
    const attachments = attach0 || (dres && dres.attachments) || null
    const C = { ok: !!(dres && dres.ok), mode: (hooks && hooks.mode) || 'chat', mk, digest, contextText, pre, dres, hops, writeCards, askCard, stopped, toolNote, attachments, ms: Date.now() - t0 }
    logDockCall(A, C)
    return C
  }

  const toolTasks = defineTool({
    name: 'sales_tasks',
    description: 'AI-CRM客资管理系统-今日任务：查待跟进客户清单（逾期、今日到期、未来N天内临期、待定跟进/无排期），按等级排序。数据来自销售Excel。回执里还带**六分类选题池**（定制开发/标品成交/重点跟进/待定跟进/挂起冷备/待首触，每类前 10，终态不进池）——你 2026-10-13 定：选题从这六类里选。',
    parameters: { days: { type: 'number', description: '窗口天数，默认7天(1-90)' } },
    output: { schema: outSchema, render: textRender },
    execute: async (args) => {
      const d = Number(args && args.days)
      const days = Number.isFinite(d) && d > 0 ? Math.min(Math.floor(d), 90) : 7
      return run('tasks', { days, slim: true }) // 精简模式省token；HTTP/看板走完整字段不受影响
    },
  })
  const toolView = defineTool({
    name: 'sales_view',
    description: 'AI-CRM客资管理系统-客户全景：查单个客户完整档案（基本信息+**最后登陆时间**+**智写智算使用情况**+跟进流水+联系人）。最后登陆与用量只作事实展示，不据此判定意向、不写进话术。可传客户ID、公司名或手机号关键字。',
    parameters: { id: { type: 'string', description: '客户ID(如 C-未知-2608-020)或公司名/手机号关键字', required: true } },
    output: { schema: outSchema, render: textRender },
    execute: async (args) => run('view', String(args.id || '').trim()),
  })
  const toolLog = defineTool({
    name: 'sales_log',
    description: 'AI-CRM客资管理系统-记录跟进：把一次客户跟进写进**客户表**（客户表＝主表+流水表：先往流水表追加一条，再回写主表状态；数据写回 Excel）。每次跟进后必须调用。每次跟进都是为了把客户往 SOP 下一段推：有进展就显式传 stage 推进，回执里也会给 nextStage 提示下一段；确实没进展才不传（=停留）。',
    parameters: {
      id: { type: 'string', description: '客户ID', required: true },
      method: { type: 'string', description: '方式: 电话/微信/上门/短信/合同/官网申请/其他' },
      type: { type: 'string', description: '类型: 首触/试用回访/高意向跟进/老客服务/客户反馈/策略调整/放弃跟进/数据整理' },
      stage: { type: 'string', description: 'SOP阶段(可选)：线索获取/客户触达/需求挖掘/产品演示/异议处理/方案报价/成交签约；出口(终态，客户到此有结论)：无法联系/推进终止。传了=把客户推进/回退到该阶段(显式优先)；不传=这次跟进落在客户当前阶段之下(停留)。口径：「线索获取」=线索进池还没跟；「客户触达」=第一次打通/加上微信——待首触客户的首次跟进、以及线索获取客户第一次用直接触达方式(电话/微信/上门/短信/合同)，都会自动落「客户触达」。注：旧名「预约演示」「价值传递」自动归一到「产品演示」，「触达」归一到「客户触达」' },
      date: { type: 'string', description: '跟进日期 YYYY-MM-DD（可选；**不传就留空**——你没明确给日期的，不要自动填今天）' },
      what: { type: 'string', description: '沟通内容(聊了什么/做了什么)' },
      react: { type: 'string', description: '对方反应' },
      nextAction: { type: 'string', description: '下一步动作' },
      nextDate: { type: 'string', description: '下次跟进时间 YYYY-MM-DD。没定下次日期(待定/择机)时传 "待定"（或 clearNext=true）→ 清空排期、客户进「待定跟进」区不再显示到期；**不传本参数 = 保持主表原排期不变**' },
      nextMethod: { type: 'string', description: '下次跟进方式' },
      clearNext: { type: 'boolean', description: '清空下次跟进排期(=改为待定/无日期)，与 nextDate="待定" 等价' },
      status: { type: 'string', description: '跟进状态变更(可选): 跟进中/挂起/重点跟进/挂起冷备/已闭环/待首触（「挂起」=已接触但没定下次时间；「重点跟进」=人工重点盘，**不再提醒跟进**、你每天自己看；「挂起冷备」=先不跟了）。**2026-10-10 起：挂起/挂起冷备/已闭环 必须有据**——该客户已有【结论】流水，或本次同时把阶段推到出口(无法联系/推进终止)；否则直接拒绝（用了它=造"停住没锚点"黑洞）。要点名结论/给锚点请走 sales_settle(kind + anchor)。' },
      level: { type: 'string', description: '客户等级变更(可选): SS/S/A/B/C；传 "-" 表示清空为未定级。**2026-10-13 起等级跟着分类走**——挂起冷备=C/待定跟进=B/重点跟进=A/标品成交=S/定制开发=SS/待首触=不定级：状态或阶段一变，写入口自动把等级归一到该分类的等级（以分类为准），回执里会说明这次归一了什么' },
      name: { type: 'string', description: '你给的人名/联系人(可选): 回写主表「姓名/联系人」，替换「匿名注册」等占位名' },
      company: { type: 'string', description: '公司名(可选): 回写主表「公司」' },
      phone: { type: 'string', description: '手机号(可选): 11 位、1 开头。回写主表「手机」；若该号码已属别的客户会被拒绝(防重复手机)' },
      city: { type: 'string', description: '城市(可选): 回写主表「城市」' },
      wechat: { type: 'string', description: '微信昵称(可选): 回写主表「微信昵称」' },
      expire: { type: 'string', description: '到期时间(可选): YYYY-MM-DD(也接受 Excel 序列号，会自动归一)。回写主表「到期时间」' },
      reg: { type: 'string', description: '注册时间(可选): YYYY-MM-DD(也接受 Excel 序列号，会自动归一)。回写主表「注册时间」' },
      note: { type: 'string', description: '追加到主表备注的一句话(可选)' },
    },
    output: { schema: outSchema, render: textRender },
    execute: async (args) => {
      // 排期语义（2026-09-14 加固 P0）：
      //   给了日期            → 写该日期
      //   nextDate="待定" 等  → 清空排期（客户进「待定跟进」区）
      //   clearNext=true      → 清空排期
      //   什么都没给          → **不传 nextDate 键**，主表排期保持原样
      //   事故根因: 原实现恒传 nextDate:''，而库把"显式空串"当清空 → 每次不带日期的跟进都静默抹掉排期。
      const rawNext = String(args.nextDate === undefined || args.nextDate === null ? '' : args.nextDate).trim()
      const hasNext = rawNext !== ''
      const pendingWord = /^(待定|不定|暂无|无日期|无|null|none|clear|-)$/i.test(rawNext)
      const clearNext = pendingWord || args.clearNext === true || String(args.clearNext || '').trim() === 'true'
      const lvRaw = String(args.level === undefined || args.level === null ? '' : args.level).trim()
      const clean = {
        id: String(args.id || ''), method: String(args.method || ''), type: String(args.type || ''),
        stage: String(args.stage || ''),
        date: String(args.date || '').trim(),
        what: String(args.what || ''), react: String(args.react || ''), nextAction: String(args.nextAction || ''),
        nextMethod: String(args.nextMethod || ''),
        clearNext, status: String(args.status || ''),
        level: lvRaw === '-' ? '\u0000CLEAR' : lvRaw,   // "-" = 请求清空等级（库里识别这个哨兵）
        name: String(args.name || ''), company: String(args.company || ''),
        // 2026-09-14: cmdLog 新增回写字段（手机/城市/微信昵称/到期时间/注册时间）
        phone: String(args.phone === undefined || args.phone === null ? '' : args.phone).trim(),
        city: String(args.city || ''), wechat: String(args.wechat || ''),
        expire: String(args.expire || ''), reg: String(args.reg || ''),
        note: String(args.note || ''),
      }
      if (pendingWord || clearNext) clean.nextDate = ''      // 显式待定 → 传空串（库按显式空串清空）
      else if (hasNext) clean.nextDate = rawNext             // 给了日期 → 照写
      // 没给日期且非待定 → 键不存在，库里 hasOwnProperty 判定为"未提供"，不动主表排期
      return run('log', clean)
    },
  })
  // 2026-09-29 SOP: 单客户 SOP 时间轴（7 段漏斗 + 2 出口，记录挂在对应阶段之下）
  const toolSop = defineTool({
    name: 'sales_sop',
    description: 'AI-CRM客资管理系统-客户SOP时间轴：把该客户的跟进记录按 SOP 阶段分组返回（线索获取→客户触达→需求挖掘→产品演示→异议处理→方案报价→成交签约，外加出口 无法联系/推进终止），并给出当前阶段、结果与下一段。要"这个客户跟到哪一步了/完整 SOP"就用这个。',
    parameters: { id: { type: 'string', description: '客户ID(如 C-未知-2608-020)或公司名/手机号关键字', required: true } },
    output: { schema: outSchema, render: textRender },
    execute: async (args) => run('sop', String(args.id || '').trim()),
  })
  const toolSummary = defineTool({
    name: 'sales_summary',
    description: 'AI-CRM客资管理系统-汇总统计：返回客户总数、跟进状态分布、等级分布、触达状态分布、SOP 阶段分布、流水总数、首访命中分布。',
    parameters: {},
    output: { schema: outSchema, render: textRender },
    execute: async () => run('summary', null),
  })

  // 2026-09-29 行动引擎：单客户作战卡（我下一步该干什么/为什么是今天/怎么说/打不通怎么办）
  const toolNext = defineTool({
    name: 'sales_next',
    description: 'AI-CRM客资管理系统-客户作战卡：这个客户现在最该做的一件事、为什么是今天（带具体数字）、开口怎么说、打不通/说贵/说没需求怎么接。要"下一位客户我怎么跟"就用这个。',
    parameters: { id: { type: 'string', description: '客户ID(如 C-未知-2608-020)或公司名/手机号关键字', required: true } },
    output: { schema: outSchema, render: textRender },
    execute: async (args) => run('next', String(args.id || '').trim()),
  })
  // 2026-10-09 通话中实时话术：客户刚说的话（本机转写文本）→ 现在该接哪句 + 这段透出的推进点
  const toolLive = defineTool({
    name: 'sales_live',
    description: 'AI-CRM客资管理系统-通话实时话术：电话开着外放时，把**客户刚说的话**（本机语音转写文本，最近几十秒）传进来，返回 1-3 条"你现在该接的那句"（按优先级排序，含为什么）+ 客户当前 SOP 阶段该拿到的结果 + 这段话透出的推进点。**2026-10-12 起升级**：规则版照旧先出（永远在），再补一段 `ai`（模型按现场语气改写的可念接话，硬超时 ' + Math.round(AI_TIMEOUT.live / 1000) + ' 秒（本机档与云端同档；整段文案 sales_clienttip 给 ' + Math.round(AI_TIMEOUT.clienttip / 1000) + ' 秒），失败/超时原样回落规则版；发模型的内容已做字段级脱敏、回来回填真名）。通话后要发微信/短信的整段文案用 sales_clienttip。',
    parameters: {
      id: { type: 'string', description: '客户ID(如 C-未知-2608-020)或公司名/手机号关键字（可选：不传就只按话术库给应对）' },
      text: { type: 'string', description: '客户刚说的话（本机转写文本，建议最近 60 秒）', required: true },
      limit: { type: 'number', description: '最多返回几条话术（默认 3，上限 5）' },
    },
    output: { schema: outSchema, render: textRender },
    execute: async (args) => {
      const id = String((args && args.id) || '')
      const text = String((args && args.text) || '')
      const limit = clampInt(args && args.limit, 1, 5, 3)
      const r = await run('live', { id, text, limit })
      if (!r.ok || !text) return r
      // 规则结果一定在；AI 只是加一层（失败就是没有 ai.ok，前端/模型照样有规则版可用）
      const ai = await aiLive(ctx, r.data, text, limit)
      return { ok: true, data: Object.assign({}, r.data, { ai, aiMode: ai.ok ? 'ai' : 'rule' }) }
    },
  })
  // 2026-09-29 行动引擎：今日作战队列（打给谁/为什么/长尾走批量/归属覆盖）
  const toolPlan = defineTool({
    name: 'sales_plan',
    description: 'AI-CRM客资管理系统-今日作战队列：今天该打哪些电话。分两块——**首次触达**（未触达新线索，每日保底 10 条）与**今日跟进**（老客户：到期续费/逾期/停滞/联售/增购），每日合计上限 25 条，每条给动作+为什么+时限；另附长尾批量触达话术（20 个/天，不占电话额度）与"每个客户都有归属"的覆盖情况。每天开工先看这个。**2026-10-13 你定：选题一律从六分类里选**（定制开发/标品成交/重点跟进/待定跟进/挂起冷备/待首触——导航栏六页；"其他"区已取消，全部客户必落一类）。',
    parameters: {},
    output: { schema: outSchema, render: textRender },
    execute: async () => run('plan', null),
  })

  // 2026-10-08 结果层：给客户点名结论（沉默/暂缓/无法联系/推进终止/成交签约）——"每个客户都要有个结果"
  const toolSettle = defineTool({
    name: 'sales_settle',
    description: 'AI-CRM客资管理系统-给客户点名结论（每个客户都要有个结果）：你点名"这个客户沉默不搭理了/这一阶段先跟不动了/联系不上/不做了/成交了"，用这个落一条【结论】留痕并同步两表与状态（自动进结果层）。可单个（id）也可批量（ids，一批同一个结论+锚点，用来清黑洞）。锚点=复查时间或信号（沉默等需求/暂缓**必填**）；堵住"状态挂了却没说为什么"的黑洞。',
    parameters: {
      id: { type: 'string', description: '客户ID(如 C-未知-2608-020)。单个点名必填；批量点名改用 ids' },
      ids: { type: 'array', items: { type: 'string' }, description: '批量点名（可选）: 一串客户ID，同一个结论 + 同一个锚点；上限 50。用于清黑洞——你点名一批"这些先停住/联系不上"' },
      kind: { type: 'string', description: '结论: 沉默等需求(→挂起)/暂缓(→挂起冷备,停在当前段)/无法联系(→挂起冷备+出口)/推进终止(→已闭环+出口)/成交签约(→已闭环+成交)', required: true },
      anchor: { type: 'string', description: '复查锚点: 日期 YYYY-MM-DD 或一个信号(如"客户新项目立项"/"明年3月预算")。沉默等需求/暂缓必填——没有锚点的停住就是黑洞；三个终态结论可不填' },
      stuckAt: { type: 'string', description: '停在哪个 SOP 段(可选，默认取主表当前阶段): 线索获取/客户触达/需求挖掘/产品演示/异议处理/方案报价' },
      note: { type: 'string', description: '补充一句话(可选，写进留痕与主表备注)' },
      date: { type: 'string', description: '发生日期 YYYY-MM-DD(可选，默认今天—留痕日期=发生当天)' },
    },
    output: { schema: outSchema, render: textRender },
    execute: async (args) => run('settle', {
      id: String(args.id || '').trim(), kind: String(args.kind || '').trim(),
      ids: Array.isArray(args.ids) ? args.ids.map(x => String(x || '').trim()).filter(Boolean) : null,
      anchor: String(args.anchor || '').trim(), stuckAt: String(args.stuckAt || '').trim(),
      note: String(args.note || '').trim(), date: String(args.date || '').trim(),
    }),
  })
  // 2026-10-08 AI 每日工作台：三段固定（我已经做完的/今天需要你动手的/需要你点头的1件）+ 飞轮观察 + 数据缺口
  const toolBrief = defineTool({
    name: 'sales_brief',
    description: 'AI-CRM客资管理系统-AI每日工作台：固定三段——①我已经做完的（只从当天留痕取，取不到就是空，不自吹）②今天需要你动手的（T1 前 3 必做 + T2 前 5 该做，带原因/电话/话术）③需要你点头的 1 件；外加飞轮观察（锚点到期/到期30·14·7/段位停滞/用量异常）与数据缺口。**2026-10-13 起另带 pool=六分类选题池**（每类前 5，终态不进池）——你问"今天怎么干/AI 帮我做什么"就用这个。',
    parameters: {},
    output: { schema: outSchema, render: textRender },
    execute: async () => run('brief', null),
  })

  // 2026-10-08 D3 企业级推进：候选盘点（升级/直谈）+ 单客户"一段三件事"建议 + 企业级台账写入（【企业级】k=v）
  const toolEnterprise = defineTool({
    name: 'sales_enterprise',
    description: 'AI-CRM客资管理系统-企业级跟进（智写/智算 → 企业级AI落地延展）：三种用法——①候选盘点（不给 id 或 pool=true）：从客户表里挑"可以谈企业级"的（升级=已付费/有消耗；直谈=机构型或 S/A 级），**只给建议，绝不自动改阶段**；②单客户推进建议（给 id）：这个客户现在走哪条路、下一段是哪段、这一段要做的三件事、该带的材料、话术、还缺哪几项台账信息、真实用量证据；③记台账（给 id + facts）：把聊到的决策人/预算口/资料权属/安全要求/试点范围落成【企业级】留痕（只写流水、不动主表段位）。',
    parameters: {
      id: { type: 'string', description: '客户ID / 公司名 / 手机号 / 微信昵称（可选；不给就是候选盘点）' },
      pool: { type: 'boolean', description: '候选盘点模式（可选；不给 id 时默认就是这个）' },
      facts: { type: 'object', additionalProperties: true, description: '企业级台账（可选，给了就是记账）：只认五项 决策人/预算口/资料权属/安全要求/试点范围，至少一项非空；写【企业级】k=v｜k=v 留痕（只落流水、不动主表）' },
      limit: { type: 'number', description: '候选盘点每类最多返回几条（可选，默认 20，上限 50）' },
      date: { type: 'string', description: '台账发生日期 YYYY-MM-DD（可选，默认今天）' },
    },
    output: { schema: outSchema, render: textRender },
    execute: async (args) => run('enterprise', {
      id: String(args.id || '').trim(),
      pool: !!args.pool,
      facts: (args.facts && typeof args.facts === 'object') ? args.facts : null,
      limit: clampInt(args.limit, 1, 50, 20),
      date: String(args.date || '').trim(),
    }),
  })

  // 2026-10-08 D4 飞轮管理：13 环（标品 7 + 企业级 6）+ 2 个不占阶段的售后环 + 转介绍留痕
  const toolFlywheel = defineTool({
    name: 'sales_flywheel',
    description: 'AI-CRM客资管理系统-飞轮管理（三个不占阶段的售后/转介绍环归这里管）：默认给出 13 段环的飞轮体检——每环现在几个人、累计到过几人、相邻环转化率、停滞几人、平均静默几天、这一环该做的一件事，外加两个售后环（成交后服务=已付费池；转介绍与复购=有【介绍】留痕的客户）与瓶颈环；也可以只问某一环（ring）；还可以记一笔转介绍留痕（by=介绍人 + to=被介绍人，必须成对，挂在被介绍人客户名下，只落流水）。',
    parameters: {
      ring: { type: 'string', description: '只看某一环（可选）: 线索获取/客户触达/需求挖掘/产品演示/异议处理/方案报价/成交签约/企业级机会/决策链摸排/需求与现状勘察/方案与试点设计/商务推进/私有化签约' },
      referral: { type: 'boolean', description: '记一笔转介绍留痕（可选；给了 by/to 也自动走这个模式）' },
      by: { type: 'string', description: '介绍人（转介绍留痕必填；写清谁介绍的）' },
      to: { type: 'string', description: '被介绍人（转介绍留痕必填；写清介绍给谁）' },
      note: { type: 'string', description: '补充一句话（可选，写进【介绍】留痕）' },
      date: { type: 'string', description: '转介绍发生日期 YYYY-MM-DD（可选，默认今天）' },
    },
    output: { schema: outSchema, render: textRender },
    execute: async (args) => run('flywheel', {
      ring: String(args.ring || '').trim(),
      referral: !!args.referral,
      by: String(args.by || '').trim(),
      to: String(args.to || '').trim(),
      note: String(args.note || '').trim(),
      date: String(args.date || '').trim(),
    }),
  })

  // 2026-10-08 D5 周战役 + 周复盘（培育投放并进 campaign，不再单独加 sales_nurture）
  const toolCampaign = defineTool({
    name: 'sales_campaign',
    description: 'AI-CRM客资管理系统-周战役（一周三批、各 20 条，三批互不占额度）：①电话批=brief 队列里 T1/T2 且手机号合法（真打电话）；②微信批=T3 批量触达或无手机号（微信·短信长尾，不占电话额度）；③培育批=培育池（【结论】=暂缓）到点优先、不足才提前一次（标 ahead）。每条带动作、为什么、完整话术与记账示例。**纯派生不写盘**，落实后按条走 sales_log。',
    parameters: {
      phone: { type: 'number', description: '电话批条数上限（可选，默认 20，上限 50）' },
      wechat: { type: 'number', description: '微信批条数上限（可选，默认 20，上限 50；不占电话额度）' },
      nurture: { type: 'number', description: '培育轻触达条数上限（可选，默认 20，上限 50；不催单、不占电话额度）' },
    },
    output: { schema: outSchema, render: textRender },
    execute: async (args) => run('campaign', {
      phone: clampInt(args.phone, 0, 50, 0),
      wechat: clampInt(args.wechat, 0, 50, 0),
      nurture: clampInt(args.nurture, 0, 50, 0),
    }),
  })

  // 2026-10-08 D5 周复盘：把"这段时间到底发生了什么"从两张表现算出来（AI 干数据整理）
  const toolDigest = defineTool({
    name: 'sales_digest',
    description: 'AI-CRM客资管理系统-周复盘（AI 干数据整理）：给一段时间（默认最近 7 天）的两表现算复盘——新增客户/常规跟进条数/真碰过的客户数、按类型与方式分布、推进了段位的客户、结论（【结论】）与清掉的洞、结果八桶、当前黑洞（停住·无锚点）、转介绍（【介绍】成对）与飞轮瓶颈，外加下周战役（电话/微信/培育三批计数与先打的前 3 个）。**只读现算，绝不写盘、不缓存**。',
    parameters: {
      days: { type: 'number', description: '回看天数（可选，默认 7，上限 90；窗口含今天）' },
      date: { type: 'string', description: '窗口结束日 YYYY-MM-DD（可选，默认今天）' },
    },
    output: { schema: outSchema, render: textRender },
    execute: async (args) => run('digest', {
      days: clampInt(args.days, 1, 90, 7),
      date: String(args.date || '').trim(),
    }),
  })

  // 2026-10-15 合同台账（第 15 个工具）：数据面 10 个动作走 run('contract', …)（写锁+表头断言+原子写+变更日志），
  //   templates/generate（出 .docx，落 合同/）/review（规则初审，可落 audit）/file+下载 由插件面自己做。
  const toolContract = defineTool({
    name: 'sales_contract',
    description: 'AI-CRM客资管理系统-合同台账（销售合同全生命周期）：action=list 台账（含到期/红点）｜get 单份｜save 存合同要素｜status 改状态｜sign 签署（默认同时把客户推进到成交签约）｜pay 记付款节点｜audit 落初审留痕｜file 落文件记录（下载=true 时本机读回字节给看板落盘）｜archive 归档｜void 作废（必须写原因）；另 action=templates 列生成模板、generate 生成本机 .docx（zip 走 dsh-feasi/dsh/ooxml.js 的 fflate，零新依赖）、review 规则初审（高风险/中风险/待人工 + 免责）。文件一律只在本机生成、只在本机读取，不出网；写操作只走数据层，绝不手改 xlsx。',
    parameters: {
      action: { type: 'string', description: 'list/get/save/status/sign/pay/audit/file/archive/void/templates/generate/review', required: true },
      合同ID: { type: 'string', description: '合同ID（除 list/templates/save 外都要）' },
      客户ID: { type: 'string', description: 'save/file 用：客户ID' },
      类型: { type: 'string', description: 'save 用：定制开发/标品/企业级/NDA/框架 等' },
      我方主体: { type: 'string', description: 'save 用：我方签约主体' },
      对方主体: { type: 'string', description: 'save 用：对方签约主体' },
      对方统一社会信用代码: { type: 'string', description: 'save 用（可选）' },
      金额: { type: 'number', description: 'save 用（元）' },
      税率: { type: 'number', description: 'save 用（%）' },
      付款节点: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'save 用：[{名称,比例,金额,日期,状态}]' },
      签署日: { type: 'string', description: 'save 用 YYYY-MM-DD' },
      生效日: { type: 'string', description: 'save 用 YYYY-MM-DD' },
      到期日: { type: 'string', description: 'save 用 YYYY-MM-DD' },
      续约: { type: 'string', description: 'save 用：续约/自动续期约定' },
      交付物: { type: 'array', items: { type: 'string' }, description: 'save 用（字符串数组）' },
      验收口径: { type: 'string', description: 'save 用' },
      试点范围: { type: 'string', description: 'save 用' },
      资料权属: { type: 'string', description: 'save 用' },
      部署方式: { type: 'string', description: 'save 用：私有化/公有云 等' },
      安全要求: { type: 'string', description: 'save 用' },
      状态: { type: 'string', description: 'status 用：目标状态（待签/已签/履行中/已完成/已归档/已作废）' },
      节点名: { type: 'string', description: 'pay 用：付款节点名' },
      日期: { type: 'string', description: 'pay/sign/file 用 YYYY-MM-DD（默认今天）' },
      模式: { type: 'string', description: 'audit/review 用：规则 / 规则+AI' },
      结论: { type: 'string', description: 'audit 用：初审结论' },
      风险: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'audit 用：风险清单' },
      免责: { type: 'string', description: 'audit 用：免责声明' },
      备注: { type: 'string', description: 'status/pay/void 用' },
      原因: { type: 'string', description: 'void 用（必填：为什么作废）' },
      名: { type: 'string', description: 'file/pay 用：文件名' },
      路径: { type: 'string', description: 'file 用：本机绝对路径' },
      字节: { type: 'number', description: 'file 用：字节数' },
      sha256: { type: 'string', description: 'file 用：校验值' },
      模板: { type: 'string', description: 'generate 用：模板 key（默认 standard；先 action=templates 查）' },
      要素: { type: 'object', additionalProperties: true, description: 'generate 用：覆盖/补齐合同要素的键值' },
      下载: { type: 'boolean', description: 'file + 下载=true：本机读出文件回 base64（看板落盘用）' },
      保存: { type: 'boolean', description: 'review 用：是否把初审落成 audit 留痕（默认 true）' },
      推进: { type: 'boolean', description: 'sign 用：默认 true = 同时把客户推进到成交签约' },
      limit: { type: 'number', description: 'list 用：最多返回几条' },
    },
    output: { schema: outSchema, render: textRender },
    execute: async (args) => contractToolAct(run, args),
  })

  const disposers = []
  // 2026-10-08 审计 B4：注册面自证——「工具/路由/闸到底挂上没有」原来只靠人眼，现在由 /sales/egress 回显，doctor 可断言。
  let toolsRegistered = 0
  let routeRegistered = false
  let routeWarn = ''
  for (const tool of [toolTasks, toolView, toolLog, toolSop, toolSummary, toolNext, toolLive, toolPlan, toolSettle, toolBrief, toolEnterprise, toolFlywheel, toolCampaign, toolDigest, toolContract]) {
    try {
      disposers.push(ctx.tools.register(tool))
      toolsRegistered++
    } catch (e) {
      noteError('tools.register', String((tool && tool.name) || '?') + ': ' + String(e && e.message || e))
    }
  }

  // ---------- 数据出口闸（全局 guard：模型直调 + subagent/workflow 的子调用都过这条） ----------
  let guardActive = false
  let denialCount = 0
  const denials = []
  // 2026-10-13 批次 5（审计 F12）：注册闸门时并入的"宿主新增 shell 类工具名"（/sales/egress 自证用）。
  const egressToolNames = []
  // 宿主**全部**可见工具名（诊断用，**不**参与 R-1..R-8 判定；见 guard 注册处的长注释）。
  let egressHostVisible = []
  let egressHostSource = ''
  // 执行器类工具名的窄口径：只有名字像"能跑命令/代码"的才并进 SHELL_TOOLS 通道。
  //   为什么不能把 ctx.tools.schemas() 读到的全量名单并进去：SHELL_TOOLS 是"可执行任意命令的通道"，
  //   并进 sales_log 这类写入口后，R-5/R-6/R-7 会反过来审自家写调用（客户数据本身就带 PII → dataish=true，
  //   一条含 UNC 路径的 note 就会被拒）→ 假阳性拦死正常业务。窄口径下今天命中集 ⊆ 基础集 = no-op，
  //   宿主真把 pwsh 改名/新增执行器时才会真的并进新名字（F12 要修的就是这个 fail-open）。
  //   两个踩过的坑：
  //     ① 不能写 `spawn` —— 它会命中宿主自带的 `spawn_teammate`，把它并进 SHELL_TOOLS 后 R-2/R-3
  //        会对团队消息生效 → 复现 2026-09-29 修掉的那次"团队自锁"（委派消息里同时出现 dsh-sales 路径
  //        与 curl/npm 等动词就整条被拒）。下面前缀一律要求 `$` 或 `_-` 边界，故 `spawn_teammate` 不中。
  //     ② 不写裸 `run_`（`run_code` 已足够），避免误吃宿主将来任何 `run_*` 业务工具。
  const EXEC_TOOL_RE = /^(?:pwsh|powershell|bash|zsh|fish|sh|cmd|shell|exec|execute|terminal|command|run_code|code_run|python3?|node|deno|bun|npx|perl|ruby|php)(?:$|[_-])/i
  // 从宿主工具服务里**尽量**取在册工具名，形状未知的部分一律容忍：
  //   ctx.tools.schemas()（宿主公开文档化口，返回 [{name,…}]）/ all()（Map）/ list() / values() / 可迭代 / names 数组 → 都试一遍
  //   返回 {names, ok, reason, source}：ok=false 时 reason 必须区分「宿主没暴露工具目录」与「目录格式不认得」；
  //   （拿不到 = 纯 no-op，保持原字面常量行为，绝不因为"读不到清单"把闸门关掉，也不报错。）
  function buildEgressTools(context) {
    const out = []
    let hit = ''
    let lastErr = ''
    const push = (v) => {
      if (!v) return
      if (typeof v === 'string') { out.push(v); return }
      if (typeof v !== 'object') return
      if (typeof v.name === 'string' && v.name) out.push(v.name)
    }
    let t
    try { t = (context && context.tools) || (context && typeof context.get === 'function' ? context.get('tools') : undefined) } catch (e) { return { names: [], ok: false, reason: '读 tools 服务时抛错：' + String(e && e.message || e), source: '' } }
    if (!t) return { names: [], ok: false, reason: '宿主没有暴露工具目录（context.tools 与 ctx.get("tools") 都取不到）', source: '' }
    // 2026-10-13 三轮：宿主**公开文档化**的枚举口是 ctx.tools.schemas(scope)（@deepseek-ai/dsh-tools README：
    //   "ctx.tools.schemas(scope) returns the visible schemas without the execute functions"）→ 返回
    //   [{name, description, parameters}] 的**数组**，正是本函数认的形状。all/list/values/tools 是历史上猜的
    //   形状（该服务上并不存在），留着只为兼容/其它宿主版本，取不到就试下一个。
    for (const m of ['schemas', 'all', 'list', 'values', 'tools']) {
      try {
        const v = t[m]
        if (typeof v !== 'function') continue
        const r = v.call(t)
        if (!r) continue
        if (Array.isArray(r)) { for (const x of r) push(x) }
        // 2026-10-13 二轮（审计 F12）：迭代器分支必须在 forEach 之前——Map 同时有两者，旧写法先走 forEach
        //   只会拿到 value（`all()` 若返回 Map，一个工具名都取不到 → 静默 no-op）；这里按 [key, value] 取 key。
        else if (typeof r[Symbol.iterator] === 'function') { for (const x of r) { if (Array.isArray(x) && x.length === 2) push(x[0]); else push(x) } }
        else if (typeof r.forEach === 'function') { try { r.forEach((x) => push(x)) } catch (e) { /* 形状不认识 → 试下一个 */ } }
        if (out.length) { hit = m; break }
      } catch (e) { lastErr = m + '：' + String(e && e.message || e) }   // 形状不认识 → 试下一个（留最后一次报错供自证）
    }
    if (!out.length && Array.isArray(t.tools)) for (const x of t.tools) push(x)
    // 去重 + 去掉明显不是工具名的（含空格/换行的说明文字）
    const seen = new Set()
    const clean = []
    for (const n of out) { const s = String(n).trim(); if (!s || /\s/.test(s) || seen.has(s)) continue; seen.add(s); clean.push(s) }
    if (!clean.length) {
      const why = lastErr ? ('；各形状最后一次报错 ' + lastErr) : ''
      return { names: [], ok: false, reason: (out.length ? ('取到 ' + out.length + ' 项但都不像工具名（目录形状不认得）') : '工具目录形状不认得（试过 schemas/all/list/values/tools 与迭代器，都没取到工具名）') + why, source: hit }
    }
    return { names: clean, ok: true, reason: '读到 ' + clean.length + ' 个在册工具名（取自 ' + (hit || 'tools.tools') + '）', source: hit }
  }
  function auditDenial(toolName, exec, a) {
    denialCount++
    const at = new Date().toISOString()
    if (denials.length < 50) denials.push({ at, tool: toolName, rule: a.rule })
    try {
      mkdirSync(path.dirname(logPath('egress-guard.log')), { recursive: true })
      let preview
      try { preview = logPreview(JSON.stringify(exec ? exec.arguments : null)) }
      catch (e) { preview = '(参数无法序列化)' }
      appendFileSync(logPath('egress-guard.log'), JSON.stringify({ at, tool: toolName, rule: a.rule, preview }) + '\n', 'utf8')
    } catch (e) {
      console.error('[sales] 出口闸审计日志写入失败: ' + String(e && e.message || e))   // noteError 会再写 plugin-errors.log，这里避免日志风暴
    }
  }
  try {
    disposers.push(ctx.tools.guard((exec) => {
      const name = (exec && exec.name) ? String(exec.name) : ''
      let argsText
      try {
        const v = exec ? exec.arguments : null
        argsText = (v === undefined || v === null) ? '{}' : JSON.stringify(v)
        if (typeof argsText !== 'string') argsText = '{}'   // 函数/symbol 等，没有可外泄的文本
      } catch (e) {
        argsText = undefined                                // 循环引用等 → fail-closed
      }
      const a = assessCall(name, argsText)
      if (!a.deny) return undefined
      auditDenial(name, exec, a)
      return a.reason
    }))
    // 2026-10-13 批次 5（审计 F12 修）：闸门原来只认字面常量工具名（pwsh/bash/run_code…）。
    //   宿主新增/改名一个 shell 类工具 → R-2/R-6/R-7 的"通道"就不认得它 → 整体放行（fail-open）。
    //   这里把宿主在册工具名**只加不减**地并进 shell 通道；拿不到工具清单时就是纯 no-op（不报错）。
    //   2026-10-13 二轮（审计 F12 自证加强）：no-op 与成功并集必须一眼可判 → 回填 noteEgressToolDiscover。
    //   2026-10-13 三轮（真机实测后的收口）：宿主公开 API 是 ctx.tools.schemas()（见 @deepseek-ai/dsh-tools
    //     README：「ctx.tools.schemas(scope) returns the visible schemas without the execute functions」），
    //     它返回**全部**可见工具（含本插件自己的 14 个 + feasi 等）。**不能全并进 SHELL_TOOLS**——
    //     SHELL_TOOLS 的语义是「能执行任意命令的通道」，把 sales_log 这类工具并进去会让 R-5/R-6/R-7
    //     反过来审自家写入口（写客户数据本身就带 PII → dataish=true，一条含 UNC 路径的 note 就会被拒）。
    //     所以只并**名字像执行器**的那几个（窄口径 EXEC_TOOL_RE）；全量名单只作诊断回显，不参与判定。
    try {
      const disc = buildEgressTools(ctx)
      const execish = disc.names.filter((n) => EXEC_TOOL_RE.test(n))
      const extra = injectEgressTools(execish)
      egressToolNames.push(...extra)
      egressHostVisible = disc.names
      egressHostSource = disc.source
      noteEgressToolDiscover(disc.ok, disc.reason + (disc.ok ? '；执行器类 ' + execish.length + ' 个，本次新并入 ' + extra.length + ' 个' : ''), extra)
    } catch (e) {
      noteEgressToolDiscover(false, '读工具目录时抛错：' + String(e && e.message || e), [])
      noteError('guard.toolnames', String(e && e.message || e))
    }
    guardActive = true
  } catch (e) {
    noteError('guard.register', String(e && e.message || e))
  }

  // ---------- HTTP 端点（client 半 fetch 调用） ----------
  // 方法: GET /sales/<method>?<urlencoded json args> 或 POST /sales/<method> body=原始 JSON
  //
  // 2026-10-08 加固（审计 B1）：HTTP 面**不再允许写**。
  //   背景：D1–D5 把 settle/enterprise/flywheel/campaign 搬上 HTTP 面后，「HTTP 面全只读」的前提失效：
  //   这四个端点既能被 GET 触发、又不校验 Origin、又不经 ctx.tools.guard →
  //   本机任意网页一条简单 GET（无需 CORS 预检、无需读响应）就能改客户表。
  //   现在两道闸：① 写方法只收 POST；② 载荷里只要带写意图（settle 恒写 / facts / by+to / referral）→ 403。
  //   写操作只保留**模型工具**入口（sales_settle / sales_enterprise / sales_flywheel / sales_log …，走 ctx.tools.guard）。
  const HTTP_ONLY_POST = { settle: 1, enterprise: 1, flywheel: 1, campaign: 1,
    // 2026.10.09.4：这三个不是客户表写入，但有副作用或载荷大（转写要收几 MB 音频、准备要下载模型、
    //   自检要落一条诊断日志）→ 只收 POST，避免「任意本机网页一条简单 GET」就能触发。
    transcribe: 1, speechprepare: 1, livecheck: 1,
    // 2026-10-12（模型面 A′ 档）：ai 要花钱（调模型）且有载荷 → 只收 POST；GET 不给缓存（宁可让前端重发）。
    ai: 1,
    // 2026-10-21 右侧 AI 对话框：同样要花钱（调模型）+ 载荷可到几十 MB（图片/文件 base64）→ 只收 POST。
    assistant: 1,
    // 2026-10-15 合同台账：contract 既能写（save/sign/pay/audit/archive/void 走数据层）又有副作用
    //   （generate 会在本机落 .docx、file+下载 会读本机文件）→ 一律只收 POST，任意本机网页一条简单 GET 触发不了。
    //   注意：**不**并进 HTTP_WRITE_INTENT —— 写/读都由 action 决定，按方法名一刀切会把 list/get/templates 也 403 掉。
    contract: 1,
    // 2026-10-21 夜（协议 v2）：写库预览带参数（客户ID/字段），但只读不落盘 → 只收 POST（GET 带 body 不规整）。
    logplan: 1, settleplan: 1,
    // 开源版（2026-11）：配置写入 / 建库 / 模型探活 —— 都有副作用（写配置文件、建目录表、花钱调模型）→ 只收 POST。
    //   demo 会真的往表里写 3 条示例客户（或清除它们）→ 同样只收 POST。
    configset: 1, setup: 1, configtest: 1, demo: 1 }
  const HTTP_WRITE_INTENT = {
    settle: () => true,                                                   // cmdSettle 恒写两表
    enterprise: (a) => !!(a && a.facts),                                  // 带 facts = 台账留痕
    flywheel: (a) => !!(a && (a.referral || a.by || a.to)),               // 转介绍留痕
    campaign: (a) => !!(a && (a.referral || a.by || a.to)),
  }
  // 写意图载荷一律拒绝：写操作只能走模型工具（sales_settle/sales_enterprise/sales_flywheel …），
  //   那条路经 ctx.tools.guard（出口闸 + 审计留痕）；HTTP 面恒只读。
  const httpWriteIntent = (method, args) => {
    const f = HTTP_WRITE_INTENT[method]
    return !!(f && f(args))
  }
  // Origin 白名单：本机回环（浏览器跨站请求一定带 Origin，且我们只服务本机看板）
  const LOOPBACK_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i

  // ---------- 本机语音转写桥（2026.10.09.4） ----------
  //   宿主服务 `speechController`：catalog() / prepare(providerId, opts) / cancelPreparation(id) /
  //   transcribe({audioBase64, providerId?, language?}, signal)。它由 voice-input bundle 的
  //   `api-speech-to-text` 条目提供，**不经客户端 UI**，所以不受「官方 UI 插件没跑」影响。
  //   取不到就只降级（面板仍能定位客户 + 出话术 + 出草稿），并在回执里说清是哪一层缺。
  const speechSvc = () => {
    let svc = null
    try { svc = (typeof ctx.get === 'function') ? ctx.get('speechController') : undefined }
    catch (e) { return { ok: false, error: '宿主取 speechController 抛错：' + String(e && e.message || e) } }
    if (!svc) return { ok: false, error: '宿主没提供语音转写服务（speechController）：设置 → 插件 → 语音输入（本机转写）要启用' }
    let catalog = null
    try { catalog = svc.catalog() } catch (e) { return { ok: false, error: '语音转写服务在、但目录读取失败：' + String(e && e.message || e) } }
    return { ok: true, svc, catalog }
  }
  // 与 speechController 默认 maxAudioBytes(4MB) 对齐：base64 上限 = ceil(4MB/3)*4
  const TRANSCRIBE_MAX_B64 = Math.ceil((4 * 1024 * 1024) / 3) * 4
  // 官方 transcribe 的回执是**对象**：speech-to-text 的 transcriptSchema = { text, audioSeconds, inferenceSeconds }
  // （sensevoice provider lib/index.js:442-446；客户端 UI 也是取 result.value.text）。
  // 所以绝不能 String(整个对象)——2026-10-09 用户实测：那会让转写框显示 4 行「[object Object]」。
  // 这里对 字符串 / {text} / {segments:[{text}]} 都归一，只把纯文本交出去。
  const transcriptText = (r) => {
    if (typeof r === 'string') return r
    if (!r || typeof r !== 'object') return ''
    if (typeof r.text === 'string') return r.text
    if (typeof r.transcript === 'string') return r.transcript
    const segs = Array.isArray(r.segments) ? r.segments : (Array.isArray(r.results) ? r.results : null)
    if (segs) return segs.map((x) => (typeof x === 'string' ? x : (x && typeof x.text === 'string' ? x.text : ''))).filter(Boolean).join(' ')
    return ''
  }

  const route = {
    kind: 'prefix',
    path: '/sales',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost')
        const method = url.pathname.replace(/^\/sales\//, '').replace(/\/+$/, '')
        if (!method) { res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: 'no method' })); return }
        // 2026-10-08 加固(B1)：写方法只收 POST（浏览器简单 GET 不触发预检，是这次的真实攻击面）
        if (HTTP_ONLY_POST[method] && req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: 'method not allowed: ' + method + ' 只接受 POST（写操作请用模型工具）' })); return
        }
        // 2026-10-08 加固(B1)：带 Origin 且不是本机回环 → 403（防跨站简单请求触发副作用）
        const reqOrigin = String((req.headers && req.headers.origin) || '')
        if (reqOrigin && !LOOPBACK_ORIGIN.test(reqOrigin)) {
          res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: 'origin not allowed' })); return
        }
        let args = null
        if (req.method === 'POST') {
          // 2026.10.09.4：转写要收一整段 WAV 的 base64（120 秒 16k 单声道 PCM16 ≈ 3.9MB → base64 ≈ 5.2MB），
          //   其余端点仍按 64KB 卡死（小载荷 = 小攻击面）。
          const maxBody = method === 'transcribe'
            ? 7 * 1024 * 1024
            // 2026-10-21 右侧 AI 对话框：图片 4 张 × 4MB + 文件 4 个 × 2MB，base64 膨胀 4/3 → 给 32MB 上限
            : (method === 'assistant' ? 32 * 1024 * 1024 : 64 * 1024)
          const chunks = []
          let size = 0
          for await (const chunk of req) {
            size += chunk.length
            if (size > maxBody) { res.writeHead(413, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: 'body too large' })); return }
            chunks.push(chunk)
          }
          const raw = Buffer.concat(chunks).toString('utf8').trim()
          if (raw) { try { args = JSON.parse(raw) } catch (e) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: 'bad json body' })); return } }
        } else {
          const q = url.searchParams.get('args')
          if (q) {
            try { args = JSON.parse(q) }
            catch (e) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: 'bad args query' })); return }   // 2026-09-14: 原来静默吞掉→按默认参数执行
          }
        }
        // 2026-10-08 加固(B1)：HTTP 面只读 —— 载荷带写意图直接 403（写走模型工具）
        if (httpWriteIntent(method, args)) {
          res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: '该端点只读：' + method + ' 的写操作请用模型工具 sales_' + method + '（HTTP 面不接受写载荷）' })); return
        }
        // 开源版（2026-11）：还没配置数据目录时，所有「读数据」端点先回一条结构化 UNCONFIGURED，
        //   让看板第一时间弹「首次设置」向导，而不是每个 case 各自拼一句含糊的失败文案。
        //   放行名单：配置类端点（config/configset/setup/configtest）、诊断（egress）、
        //   模型/语音类（assistant/ai/speech/speechprepare/transcribe/livecheck）——它们不读 xlsx。
        const NO_DATADIR_OK = {
          config: 1, configset: 1, setup: 1, configtest: 1, egress: 1,
          assistant: 1, ai: 1, speech: 1, speechprepare: 1, transcribe: 1, livecheck: 1,
        }
        if (!NO_DATADIR_OK[method]) {
          const dd = dataDir()
          if (!dd || !dataDirExists(dd)) {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({
              ok: false,
              code: 'UNCONFIGURED',
              error: '还没有设置数据目录。请在销售看板点「首次设置」，或设置环境变量 SALE_DIR / 写入配置文件后再试。',
              hint: { dataDir: dd || '', defaultDataDir: DEFAULT_DATA_DIR, configFile: configStatus().file },
            }))
            return
          }
        }
        let result
        switch (method) {
          case 'overview': {
            // 2026-09-14: 去掉已下线的 remind（恒 count:0，且是最贵的并发子进程）；补待定区计数
            const [s, t] = await Promise.all([run('summary', null), run('tasks', 7)])
            if (!s.ok || !t.ok) { result = { ok: false, error: 'overview 数据获取失败' } }
            else {
              const sd = s.data, td = t.data
              result = { ok: true, data: {
                total: sd.total, flowCount: sd.flowCount,
                pending: (sd.status['跟进中'] || 0) + (sd.status['待首触'] || 0),
                toContact: sd.status['待首触'] || 0,
                overdue: td.overdueCount || 0,
                highLevel: (sd.level['S'] || 0) + (sd.level['A'] || 0),
                todayCount: (td.today && td.today.length) || 0,
                upcomingCount: td.upcomingCount || 0,
                unscheduledCount: td.unscheduledCount || 0,
                warnings: sd.warningsCount || 0,
                today: td.today, horizon: td.horizon,
              } }
            }
            break
          }
          case 'tasks': {
            const d = Number(args && args.days)
            result = await run('tasks', Number.isFinite(d) && d > 0 ? Math.min(Math.floor(d), 90) : 7)
            break
          }
          case 'summary': result = await run('summary', null); break
          // 2026-10-21 夜实测（用户 m06887）：这条原来只认 args.kw，传 q/keyword 时**不报错、直接回前 20 条**，
          //   看上去像「查到了」其实没按关键字查（模型据此说「没查到」或给出无关客户）。参数名全部认下。
          case 'search': {
            // 2026-10-22（用户 m01260）：空词不再 fail-open 回前 20 条（那会让模型以为"查到了"）。
            const kwS = String((args && (args.kw || args.q || args.keyword || args.text)) || '').trim()
            if (!kwS) { result = { ok: false, error: '查询词为空（不知道要找谁）：给手机号、客户ID、公司名或一句话' }; break }
            result = await run('search', kwS)
            break
          }
          // 2026-10-22（用户 m01260）：身份解析——供侧栏 AI / 外部调用把"一句话"解析成客户ID
          case 'resolve': result = await run('resolve', String((args && (args.q || args.text || args.kw || args.keyword || args.id)) || '')); break
          // 2026-10-22（用户 m02366）：开场原文（模板引擎那句，模型只许挑/删不许改写）
          case 'open': result = await run('open', String((args && (args.id || args.q || args.text || args.kw)) || '')); break
          case 'view': result = await run('view', String((args && args.id) || '')); break
          case 'sop': result = await run('sop', String((args && args.id) || '')); break
          case 'remind': result = await run('remind', null); break
          case 'firstcall': result = await run('firstcall', null); break
          case 'plan': result = await run('plan', null); break
          case 'brief': result = await run('brief', null); break
          case 'settle': result = await run('settle', args || {}); break
          // 2026-10-21 夜（侧栏 AI 协议 v2）：写库差异预览——只读不落盘，供确认卡展示 before→after。
          // 2026-10-21 夜实测（用户 m06887）：run() 永远回 {ok:true,data:<命令结果>}，而 cmdLog/cmdSettle
          //   拒绝时是 {ok:false,message:'缺少客户ID(id)'} → 外层就成了「成功」，面板/探针都看不出失败。
          //   预览两条必须把里层 ok 一起看（与 assistant 的 log/settle 分支同一口径）。
          case 'logplan': {
            const r0 = await run('logplan', args || {})
            const inner = (r0 && r0.data) || null
            result = (inner && inner.ok === false) ? { ok: false, error: String(inner.message || inner.error || '预览失败') } : r0
            break
          }
          case 'settleplan': {
            const r0 = await run('settleplan', args || {})
            const inner = (r0 && r0.data) || null
            result = (inner && inner.ok === false) ? { ok: false, error: String(inner.message || inner.error || '预览失败') } : r0
            break
          }
          case 'enterprise': result = await run('enterprise', args || {}); break
          case 'flywheel': result = await run('flywheel', args || {}); break
          case 'campaign': result = await run('campaign', args || {}); break
          case 'digest': result = await run('digest', args || {}); break
          case 'next': result = await run('next', String((args && args.id) || '')); break
          case 'cold': result = await run('cold', null); break
          case 'focus': result = await run('focus', null); break
          // 2026-10-21 体检（m03962）：数据层早就有 `cadence`（四类跟进节奏汇总），HTTP 面一直缺这个 case
          //   → 面板/后续工具想一次拿齐「重点跟进/标品成交/待定跟进/挂起冷备」就得打四枪。只读，不进 HTTP_ONLY_POST。
          case 'cadence': result = await run('cadence', null); break
          // 2026-10-13 六分类名单页（用户定：顶部导航六类各成一页；只读、不进 HTTP_ONLY_POST）
          case 'standard': result = await run('standard', null); break
          case 'custom': result = await run('custom', null); break
          case 'pending': result = await run('pending', null); break
          case 'first': result = await run('first', Number((args && args.limit) || 0) || 0); break
          case 'tips': result = await run('tips', { q: String((args && args.q) || '') }); break
          case 'clienttip': result = await run('clienttip', { id: String((args && args.id) || '') }); break
          // 2026-10-09 通话中实时话术（只读：转写文本进、话术出；不落盘、不上网）
          case 'live': result = await run('live', { id: String((args && args.id) || ''), text: String((args && args.text) || ''), limit: Number((args && args.limit) || 0) || 3 }); break
          // 2026-10-15 合同台账（第 32 个 case）：插件面 4 个动作 + 数据面 10 个动作共用一个入口
          //   （templates/generate/review/file+下载 由插件自己算，其余原样转给 run('contract', …)）。
          case 'contract': {
            // 2026-10-21 体检（m03962 P0）：合同页要看板可用，所以 HTTP 面必须能写台账；
            //   但 sign/void/archive 这类会改客户段位/不可逆的动作必须带 confirm:true（看板点过确认才传），
            //   每个写动作都落一条本机审计（logs/contract-http.log，只记合同ID/动作/时间）。
            const ca = String((args && args.action) || 'list').trim() || 'list'
            if (CONTRACT_DESTRUCTIVE[ca] && !(args && args.confirm === true)) {
              result = { ok: false, error: '「' + ca + '」会改客户段位或作废合同，必须带 confirm:true（看板上点过确认才会带上）' }
            } else if (!CONTRACT_READ_ACTIONS[ca] && !CONTRACT_WRITE_ACTIONS[ca]) {
              result = { ok: false, error: '不认识的合同动作：' + ca, actions: Object.keys(CONTRACT_READ_ACTIONS).concat(Object.keys(CONTRACT_WRITE_ACTIONS)) }
            } else {
              result = await contractToolAct(run, args || {})
              if (CONTRACT_WRITE_ACTIONS[ca]) contractHttpAudit(ca, args || {})
            }
            break
          }
          case 'egress': {
            // 数据出口自证（2026-09-17）：runtime 真信号，不是静态断言。
            // telemetryLoaded === false 才说明「会话遥测插件没被加载」——这是关遥测的运行时证据。
            let telemetryLoaded = 'unknown'
            try { telemetryLoaded = (typeof ctx.get === 'function' ? ctx.get('sessionTelemetry') : undefined) !== undefined }
            catch (e) { telemetryLoaded = 'error: ' + String(e && e.message || e) }
            // 2026-10-13 批次 5（审计 F9）：分工表读失败时把信号记进 plugin-errors.log（/sales/egress.ai 另带 routeFileOk）
            try { const rs = aiRouteStatus(); if (!rs.ok && rs.failed) noteError('ai.routefile', (rs.failed.code ? rs.failed.code + ': ' : '') + rs.failed.reason) } catch (e) { /* 自证失败不能反过来打断 egress */ }
            // 2026-10-13 二轮（审计 F12 自证加强）：算一次"读宿主工具目录"的结果，给下面 ai 段三个一眼可判的键
            const guardDiscover = (() => { try { const d = egressToolDiscover(); return { ok: !!d.ok, reason: String(d.reason || ''), added: Array.isArray(d.added) ? d.added : [] } } catch (e) { return { ok: false, reason: '自证读取失败：' + String(e && e.message || e), added: [] } } })()
            result = { ok: true, data: {
              plugin: 'dsh-sales',
              pluginRev: PLUGIN_REV,
              guardActive, guardMode: GUARD_MODE,
              // 2026-10-08 审计 B4：注册面 + 插件自身错误自证（原来这些只写宿主 stderr，界面上看不见）
              toolsRegistered, routeRegistered, workdir: dataDir(),
              routeWarn,
              errorCount: pluginErrors.length,
              errors: pluginErrors.slice(-5),
              lastError: pluginErrors.length ? pluginErrors[pluginErrors.length - 1] : null,
              denialCount, denials: denials.slice(-20),
              rules: GUARD_RULES,
              telemetryLoaded,
              maskLevel: 'fields+tags (A′ 档：姓名/手机/公司(含简称)/微信→占位符带角色·行业标签，回来回填；自由文本原样)',
              logPath: logPath('egress-guard.log'),
              // 2026.10.09.4：语音转写服务在不在（宿主侧真信号，探针/doctor 一眼可查）
              speechAvailable: (() => { try { return !!(typeof ctx.get === 'function' && ctx.get('speechController')) } catch (e) { return false } })(),
              // 2026-10-12（A′ 档）：模型服务在不在 + 现在用的哪个模型（不打印任何客户数据）
              ai: Object.assign({}, aiStatus(ctx), {
                // 2026-10-13 批次 5（审计 F12 自证）：闸门实际认得的"能外传"工具名（字面基础集 + 注册时并入的宿主工具名）
                guardToolsBase: GUARD_BASE_TOOLS.map((n) => n.name),
                guardToolsRuntime: egressToolNames,
                // 2026-10-13 二轮（审计 F12 自证加强）：一眼判定这次并集是"干成了"还是"no-op"
                //   discover.ok=false                     → no-op（reason 分「宿主没暴露目录」/「格式不认得」）
                //   ok=true && merged=false                → 目录读到了，但没有新工具名可并
                //   ok=true && merged=true + added[]       → 真并入了 added 里的名字
                guardToolsDiscover: { ok: guardDiscover.ok, reason: guardDiscover.reason },
                guardToolsAdded: guardDiscover.added,
                guardToolsMerged: guardDiscover.added.length > 0,
                // 2026-10-13 三轮：宿主**全部**可见工具名 + 取自哪个 API（诊断用，不参与判定）。
                //   为什么单列：窄口径并集后 added 常常是 0（今天命中集 ⊆ 基础集），只看 added 分不清
                //   「读到了但不用并」与「压根没读到」；这两个键让 F12 的效果一眼可判。
                guardToolsHostVisible: egressHostVisible,
                guardToolsHostSource: egressHostSource,
              }),
              // 2026-10-12（批次 3）：本机词法 RAG 语料就绪状态（只回数量/来源数，不打印任何资料正文）
              rag: ragStatus(),
            } }
            break
          }
          // ---------- 2026.10.09.4 本机语音转写桥（都只读语义：不写客户表、不上网） ----------
          case 'speech': {
            const wr = speechSvc()
            // 批次 4 收尾：看板一进「通话台」就会拉一次本机语音目录（语音已就绪时用户不会按「准备」，
            //   所以这里才是**必走**的读口）→ 顺手把本地模型也预热进显存，等他真开口，模型已经热了。
            //   不阻塞返回、失败不影响语音口径。详见 ai.js 的 warmLocalRoute。
            let warmS = { started: false, reason: '未执行' }
            try { warmS = warmLocalRoute(ctx, aiLogPath()) } catch (e) { warmS = { started: false, reason: String((e && e.message) || e) } }
            result = { ok: true, data: wr.ok
              ? { available: true, error: null, catalog: wr.catalog, warmStarted: !!warmS.started, warmReason: warmS.reason || '' }
              : { available: false, error: wr.error, catalog: null, warmStarted: !!warmS.started, warmReason: warmS.reason || '' } }
            break
          }
          case 'speechprepare': {
            const providerId = String((args && (args.providerId || args.provider)) || '').trim()
            const downloadSource = String((args && args.downloadSource) || '').trim()
            // 预热放在最前面：不管语音模型准备成不成，用户按了这一步就是要开口了，本地模型先热上。
            let warm = { started: false, reason: '未执行' }
            try { warm = warmLocalRoute(ctx, aiLogPath()) } catch (e) { warm = { started: false, reason: String((e && e.message) || e) } }
            const wr = speechSvc()
            if (!wr.ok) { result = { ok: false, error: wr.error, warmStarted: !!warm.started, warmReason: warm.reason || '' }; break }
            try {
              wr.svc.prepare(providerId || undefined, downloadSource ? { downloadSource } : undefined)
              result = { ok: true, data: { started: true, providerId, downloadSource, warmStarted: !!warm.started, warmReason: warm.reason || '' } }
            } catch (e) { result = { ok: false, error: '准备（下载/加载本机模型）失败：' + String(e && e.message || e), warmStarted: !!warm.started, warmReason: warm.reason || '' } }
            break
          }
          case 'transcribe': {
            const wr = speechSvc()
            if (!wr.ok) { result = { ok: false, error: wr.error }; break }
            const b64 = String((args && args.audioBase64) || '')
            if (!b64) { result = { ok: false, error: '没有音频数据（audioBase64 为空）' }; break }
            if (b64.length > TRANSCRIBE_MAX_B64) { result = { ok: false, error: '音频太长：单段上限约 120 秒（把分段调小再试）' }; break }
            const providerId = String((args && (args.providerId || args.provider)) || '').trim()
            const language = String((args && args.language) || '').trim()
            const t0 = Date.now()
            try {
              const ac = new AbortController()
              // 2026-10-21 体检：原来建了 AbortController 却从不 abort、也没有超时 → 浏览器断开后
              //   本机转写继续跑（长音频叠加占 CPU），接口还可能无限等待。现在给一个硬预算。
              const transcribeGuard = setTimeout(() => { try { ac.abort() } catch (e2) {} }, 120000)
              let out = null
              try {
                out = await wr.svc.transcribe({
                  audioBase64: b64,
                  ...(providerId ? { providerId } : {}),
                  ...(language ? { language } : {}),
                }, ac.signal)
              } finally { clearTimeout(transcribeGuard) }
              result = { ok: true, data: {
                text: transcriptText(out),
                ms: Date.now() - t0,
                audioSeconds: (out && typeof out.audioSeconds === 'number') ? out.audioSeconds : undefined,
                inferenceSeconds: (out && typeof out.inferenceSeconds === 'number') ? out.inferenceSeconds : undefined,
              } }
            } catch (e) { result = { ok: false, error: '转写失败：' + String(e && e.message || e) } }
            break
          }
          case 'livecheck': {
            // 浏览器半回传（🧪 自检 / 一次「开始通话」的现场）→ 只写白名单字段的诊断日志
            const raw = (args && typeof args === 'object') ? args : {}
            const rec = { at: new Date().toISOString() }
            for (const k of LIVE_CHECK_KEYS) {
              const v = raw[k]
              if (v === undefined || v === null || v === '') continue
              rec[k] = (typeof v === 'number' || typeof v === 'boolean') ? v : String(v).slice(0, 300)
            }
            try {
              if (existsSync(logPath('live-check.log')) && statSync(logPath('live-check.log')).size > LIVE_CHECK_MAX) writeFileSync(logPath('live-check.log'), '', 'utf8')
              appendFileSync(logPath('live-check.log'), JSON.stringify(rec) + '\n', 'utf8')
              result = { ok: true, data: { logged: true } }
            } catch (e) { result = { ok: false, error: '自检回传写盘失败：' + String(e && e.message || e) } }
            break
          }
          // ---------- 2026-10-12 模型面（A′ 档）：人点按钮才调，只产文字、绝不写库 ----------
          case 'ai': {
            const action = String((args && args.action) || '').trim()
            if (!AI_ACTIONS[action]) {
              result = { ok: false, error: '未知 action：' + (action || '(空)') + '（本批开放：' + Object.keys(AI_ACTIONS).join(' / ') + '）' }
              break
            }
            if (action === 'live') {
              const lid = String((args && args.id) || '').trim()
              const ltext = String((args && args.text) || '').trim()
              const llimit = clampInt(args && args.limit, 1, 5, 3)
              // 两种用法都走这里：① 通话中带刚转写的客户原话（实时接话）；② 看板 SOP/客户卡没有转写文本（基于档案给开场/切入）。
              //    2026-10-12 复核抓到的接线错位：原先"text 为空就拒"会让看板那两个 🧠 按钮**永远失败**（它们只传 id）。
              if (!ltext && !lid) { result = { ok: false, error: '既没有客户（id）也没有转写文本（text）：不知道给谁写话术' }; break }
              const rr = await run('live', { id: lid, text: ltext, limit: llimit })
              if (!rr.ok) { result = rr; break }
              const ai = await aiLive(ctx, rr.data, ltext, llimit)
              result = { ok: true, data: { action, mode: ai.ok ? 'ai' : 'rule', ai, rule: rr.data, rev: PLUGIN_REV } }
              break
            }
            if (action === 'clienttip') {
              const rr = await run('clienttip', { id: String((args && args.id) || '').trim() })
              if (!rr.ok) { result = rr; break }
              const ai = await aiClientTip(ctx, rr.data)
              result = { ok: true, data: { action, mode: ai.ok ? 'ai' : 'rule', ai, rule: rr.data, rev: PLUGIN_REV } }
              break
            }
            // ---------- 批次 2：三个只读面接模型（作战卡 / 今日工作台 / 周复盘）----------
            //   事实全部来自引擎（引擎不说的模型不许说）+ 数字回查（模型编的数字 → 整段作废回落规则版）。
            //   ⚠️ 2026-10-12 用**真引擎数据**冒烟时抓到的形状坑：`live`/`clienttip` 是 `{ok,data:{…}}`，
            //      而只读面这三条（next/brief/digest）是**平铺** `{ok,…}`（没有 data 包装）——
            //      照抄 `rr.data` 会把 `undefined` 当事实喂给模型（不报错、但等于让模型凭空编）。
            //      factsOf 统一取"事实本体"，三条只读面都走它。
            const factsOf = (r) => (r && r.data && typeof r.data === 'object') ? r.data : r
            if (action === 'next') {
              const rr = await run('next', String((args && args.id) || '').trim())
              if (!rr.ok) { result = rr; break }
              const facts = factsOf(rr)
              const ai = await aiNext(ctx, facts)
              result = { ok: true, data: { action, mode: ai.ok ? 'ai' : 'rule', ai, rule: facts, rev: PLUGIN_REV } }
              break
            }
            if (action === 'brief') {
              const rr = await run('brief', null)
              if (!rr.ok) { result = rr; break }
              const facts = factsOf(rr)
              const ai = await aiBrief(ctx, facts)
              result = { ok: true, data: { action, mode: ai.ok ? 'ai' : 'rule', ai, rule: facts, rev: PLUGIN_REV } }
              break
            }
            if (action === 'contract') {
              // 2026-10-15 合同初审（可选 AI 加强）：先跑规则版（永远在），AI 只做增补；
              //   AI 失败/超时/编数字 → ai.ok=false，调用方按 rule 渲染（用户看到的永远不是空白）。
              //   提示词只发这次审核必要字段（redact 脱敏后出网，回来回填）；客户ID/客户名不进提示词。
              const cid = String((args && (args.合同ID || args.id)) || '').trim()
              if (!cid) { result = { ok: false, error: '没有合同ID：不知道复核哪份合同' }; break }
              const one = await contractGetOne(run, cid)
              if (!one.ok) { result = one; break }
              const input = withElements(one.contract, args)
              const rule = await contractRuleReview(input)
              const ai = await aiContract(ctx, input, rule.ok ? rule : null)
              let saved = false
              if (args && args.保存 === true && ai.ok) {
                const w = await run('contract', {
                  action: 'audit', 合同ID: cid, 模式: '规则+AI',
                  结论: String(rule.结论 || '待人工'), 风险: rule.风险 || [],
                  免责: String(rule.免责 || CONTRACT_DISCLAIMER),
                  AI摘要: String(ai.text || '').slice(0, 2000),
                })
                saved = !!(w && w.ok)
              }
              result = { ok: true, data: { action, mode: ai.ok ? 'ai' : 'rule', ai, 规则: rule, 风险: rule.风险 || [], 待人工: rule.待人工 || [], 合同: one.contract, 已存: saved, rev: PLUGIN_REV } }
              break
            }
            {
              const rr = await run('digest', { days: clampInt(args && args.days, 1, 90, 7) })
              if (!rr.ok) { result = rr; break }
              const facts = factsOf(rr)
              const ai = await aiDigest(ctx, facts)
              result = { ok: true, data: { action: 'digest', mode: ai.ok ? 'ai' : 'rule', ai, rule: facts, rev: PLUGIN_REV } }
              break
            }
          }
          // ---------- 2026-10-21 右侧 AI 对话框（用户 m01480 / m02018） ----------
          //   需求原话：「在sale插件右侧边增加AI对话框，用于管理和输入跟进信息，不用再回到DSH的界面对话去操作了，
          //   模型可选，要支持多模态的文件和图片上传。」三条硬约束：
          //   ① 调模型只在本机宿主进程里（出网面收敛一处，/sales/egress 可自证）；
          //   ② 发出去的客户字段先脱敏（A′ 档：姓名/公司/手机/微信→占位符），模型回来 unmask 回填；
          //   ③ **写库必须先经用户确认** —— 模型只回一张 action 卡（{"action":"log","args":{…}}），
          //      面板拿它出确认卡；用户点「确认写入」才回来 action:'log' + confirm:true，
          //      这里才调 cmdLog（= 数据层写入口：写锁 + 表头断言 + 原子写 + 变更留痕）。
          //   2026-10-21 夜（m03706）：用户明确「不要绕回 DSH 对话框桥接」→ 插件自己具备：
          //      聊天回路（digest + lookup/search 本地查数据，最多 3 跳）+ 确认后直接落库。
          case 'assistant': {
            const aAct = String((args && args.action) || 'chat').trim()
            if (aAct === 'models') {
              result = { ok: true, data: Object.assign({ action: 'models' }, await dock.listCatalog(ctx), { status: dock.dockStatus(ctx, attachmentsCtx()), rev: PLUGIN_REV }) }
              break
            }
            // 2026-10-21 晚：图片通道自证（只读、不出网）。用户下次重启后一行 curl 就能看出
            //   附件服务是「直接拿到 / 同 fiber get / 借哪个服务的 ctx 拿到」，还是三级全不通。
            if (aAct === 'diag') {
              let probe = null
              try { probe = dock.attachmentsProbe(ctx) } catch (e) { probe = { error: String((e && e.message) || e) } }
              const svc = (probe && probe.svc) || null
              result = {
                ok: true,
                data: {
                  action: 'diag', rev: PLUGIN_REV,
                  ctxKinds: {
                    get: typeof ctx.get, inject: typeof ctx.inject,
                    llm: !!(ctx.llm), tools: !!(ctx.tools), webServer: !!(ctx.webServer),
                  },
                  attachments: {
                    route: (probe && probe.direct) ? 'direct' : (probe && probe.ownGet) ? 'ownGet' : (probe && probe.borrowed) ? ('borrowed:' + probe.borrowed) : 'none',
                    tries: (probe && probe.tries) || [],
                    hasSaveImages: !!(svc && typeof svc.saveImages === 'function'),
                    hasAdmitEncodedImages: !!(svc && typeof svc.admitEncodedImages === 'function'),
                    keys: svc ? Object.keys(svc).slice(0, 24) : [],
                  },
                  status: dock.dockStatus(ctx, attachmentsCtx()),
                },
              }
              break
            }
            // 写库：用户在面板上点了「确认写入」才走到这里（必须 confirm === true，严格真值）。
            //   仍然只调 cmdLog（= 数据层写入口：写锁 + 表头断言 + 原子写 + 变更留痕），
            //   与模型工具 sales_log 共用同一个 execute，口径不会分叉。
            //   2026-10-21 夜（m03706）：用户要求「sale 插件自己具备这个能力、不要绕回 DSH 对话框」，
            //   所以这里不再往会话输入框里塞 sales_log 指令，而是插件本进程直接落库——但落库前必须他点确认。
            if (aAct === 'log') {
              if (!args || args.confirm !== true) { result = { ok: false, error: '写库要你点确认（confirm:true 才算），面板会先出确认卡' }; break }
              const p = (args.args && typeof args.args === 'object') ? args.args : null
              if (!p || !String(p.id || '').trim()) { result = { ok: false, error: '没有客户ID，不能写库' }; break }
              const w = await toolLog.execute(p)
              // 2026-10-21 夜（m05977 用户实测）：run() 永远回 {ok:true,data:<cmdLog 结果>}，
              //   而 cmdLog 拒绝时是 {ok:false,message:'类型不合法: …'}——包一层就成了「成功」。
              //   于是面板把「没写库」显示成「✅ 已写入流水表 类型不合法: 挂起冷备」，爹以为落了库。
              //   这里必须把里层 ok 一起看：里层失败 = 这次没写，如实报错。
              const raw = (w && w.data) || null
              const innerBad = !!(raw && raw.ok === false)
              result = (w && w.ok && !innerBad)
                ? { ok: true, data: { action: 'log', write: raw, rev: PLUGIN_REV } }
                : { ok: false, error: String((raw && (raw.message || raw.error)) || (w && w.error) || '写库没成功') }
              break
            }
            // 2026-10-21 夜（m06146）：归位（暂缓/冷备/闭环）也走同一个确认卡协议 —— 必须 confirm === true。
            if (aAct === 'settle') {
              if (!args || args.confirm !== true) { result = { ok: false, error: '写库要你点确认（confirm:true 才算），面板会先出确认卡' }; break }
              const p = (args.args && typeof args.args === 'object') ? args.args : null
              if (!p || !String(p.id || '').trim()) { result = { ok: false, error: '没有客户ID，不能归位' }; break }
              let w = null
              try { w = await toolSettle.execute(p) } catch (e) { result = { ok: false, error: String((e && e.message) || e) }; break }
              const rawS = (w && w.data) || null
              const innerBadS = !!(rawS && rawS.ok === false)
              result = (w && w.ok && !innerBadS)
                ? { ok: true, data: { action: 'settle', write: rawS, rev: PLUGIN_REV } }
                : { ok: false, error: String((rawS && (rawS.message || rawS.error)) || (w && w.error) || '归位没成功') }
              break
            }
            if (aAct !== 'chat' && aAct !== 'stream') { result = { ok: false, error: '未知 action：' + aAct + '（本端有 chat / stream / models / diag / log / settle）' }; break }
            // SSE 流式（用户 m06146「像 DSH 对话框一样」）：边生成边推，面板边收边显示；
            //   「停止」= 客户端 AbortController 断连 → req close → dockConverse 的 shouldStop() 变真。
            if (aAct === 'stream') {
              res.writeHead(200, {
                'content-type': 'text/event-stream; charset=utf-8',
                'cache-control': 'no-store',
                connection: 'keep-alive',
                'x-accel-buffering': 'no',
              })
              let sseOpen = true
              let closed = false
              const sse = (ev, data) => {
                if (!sseOpen) return
                try { res.write('event: ' + ev + '\ndata: ' + JSON.stringify(data || {}) + '\n\n') } catch (e) { sseOpen = false }
              }
              req.on('close', () => { closed = true })
              try {
                const Cx = await dockConverse(args, {
                  mode: 'stream',                       // 台账里能分清「流式/非流式」，不复盘时靠猜
                  shouldStop: () => closed,
                  onDelta: (t) => sse('delta', { t: String(t || '') }),
                  onTool: (x) => sse('tool', x),
                  onRound: () => sse('reset', {}),     // 下一轮重新生成正文 → 面板把已收的半截清掉
                })
                const tr = dockTraceOf(Cx, args)      // 2026-10-21 夜：漏传 args 会让「带上了上文 N 条」永远不显示
                sse('done', {
                  ok: Cx.ok,
                  // 2026-10-22（m01059）：给面板的是**剥掉协议块的正文**，不是模型原文
                  text: dockShowText(Cx.dres, { raw: !!Cx.stopped }),
                  error: (Cx.dres && Cx.dres.error) || '',
                  action_card: Cx.writeCards[0] || null,
                  writeCards: Cx.writeCards || [],
                  ask: Cx.askCard || null,
                  stopped: !!Cx.stopped,
                  attachments: Cx.attachments || (Cx.dres && Cx.dres.attachments) || null,
                  provider: (Cx.dres && Cx.dres.provider) || '', model: (Cx.dres && Cx.dres.model) || '',
                  trace: tr, thinking: (Cx.dres && Cx.dres.thinking) || '',
                  toolHops: Cx.hops, ms: Cx.ms, mask: Cx.mk.stats, rev: PLUGIN_REV,
                })
              } catch (e) {
                noteError('assistant.stream', String((e && e.stack) || e))
                sse('error', { message: String((e && e.message) || e).slice(0, 200) })
              }
              try { res.end() } catch (e) { /* noop */ }
              return
            }
            // 2026-10-21 夜（m06146）：上下文 + 工具回路 + 结果汇总都抽到 dockConverse（SSE 复用同一套）。
            //   调用台账也搬进 dockConverse 了（同一个回路只记一次，流式/非流式都覆盖）。
            const C = await dockConverse(args, {})
            const mk = C.mk
            const digest = C.digest
            const contextText = C.contextText
            const pre = C.pre
            const dres = C.dres
            const hops = C.hops
            const writeCard = C.writeCards[0] || null
            const trace = dockTraceOf(C, args)
            result = (dres && dres.ok)
              ? { ok: true, data: {
                action: 'chat', mode: 'ai', text: dockShowText(dres, { raw: !!C.stopped }),
                action_card: writeCard,                 // 第一张写卡（兼容旧面板）
                writeCards: C.writeCards,               // 2026-10-21 夜（m06146）：最多 2 张
                ask: C.askCard || null,                 // 模型要反问时给用户的选项
                stopped: !!C.stopped,                   // 用户中途按了停止
                attachments: C.attachments || dres.attachments, provider: dres.provider, model: dres.model,
                trace, thinking: dres.thinking || '',
                digestChars: digest.length, toolHops: hops,
                reasoningEffort: dres.reasoningEffort || '', ms: dres.ms, mask: mk.stats, rev: PLUGIN_REV,
              } }
              // 失败也不回内部细节：给一句能懂的话 + 附件层面的真实原因（图没读到/文件抽不出字要说清楚）
              : { ok: false, error: String((dres && dres.error) || '模型没答上来'), attachments: (C.attachments || (dres && dres.attachments)) || null, trace, mask: mk.stats }
            break
          }
          // ---------- 开源版（2026-11）：配置 / 首次设置 / 模型探活 ----------
          //   背景：原版把数据目录写死在源码里、模型只跟着会话走。开源版把这两件事变成**配置**：
          //   任何人下载后都能在看板里重新指定自己的数据目录与模型通道，不用改一行代码。
          case 'config': {
            result = { ok: true, data: configStatus() }
            break
          }
          case 'configset': {
            const patch = (args && typeof args === 'object') ? args : {}
            const wantDir = patch.dataDir !== undefined
            const saved = saveConfig({
              ...(wantDir ? { dataDir: String(patch.dataDir || '') } : {}),
              ...(patch.ai && typeof patch.ai === 'object' ? { ai: patch.ai } : {}),
              ...(patch.features && typeof patch.features === 'object' ? { features: patch.features } : {}),
              ...(patch.profile && typeof patch.profile === 'object' ? { profile: patch.profile } : {}),
            })
            if (!saved.ok) { result = { ok: false, error: saved.error || '保存配置失败' }; break }
            const st = configStatus()
            // 给了数据目录但归一后没留下 → 一定是相对路径（会被静默丢弃，必须当面说清）
            if (wantDir && !st.configured) {
              result = { ok: false, error: '数据目录必须是绝对路径（例如 D:/我的销售数据 或 /home/me/sales-data），已保存其它设置。', data: st }
              break
            }
            result = { ok: true, data: st }
            break
          }
          case 'setup': {
            const dir = dataDir()
            if (!dir) { result = { ok: false, code: 'UNCONFIGURED', error: '还没有设置数据目录' }; break }
            const init = await run('init', {})
            if (!init.ok) { result = init; break }
            const seed = copySeedCorpus(dir)
            result = { ok: true, data: { ...init.data, seed, config: configStatus() } }
            break
          }
          case 'configtest': {
            const probe = await probeModelChannel(ctx)
            result = probe.ok ? { ok: true, data: probe } : { ok: false, error: probe.error, data: probe }
            break
          }
          // 示例数据（demo）：给刚初始化完的空看板一点"看得见的内容"，可一键清除。
          //   只认 { mode: 'seed' | 'clean' | 'info' }，默认 seed；写入仍走 lib 的写入口。
          case 'demo': {
            const mode = String((args && args.mode) || 'seed').toLowerCase()
            if (!['seed', 'clean', 'info'].includes(mode)) { result = { ok: false, error: 'mode 只支持 seed / clean / info' }; break }
            const r = await run('demo', { mode })
            result = r.ok ? { ok: true, data: r.data } : r
            break
          }
          default: res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: 'unknown method: ' + method })); return
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(result))
      } catch (e) {
        noteError('route.handler', String(e && e.stack || e))
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: '内部错误' }))   // 2026-09-14: 细节只进日志，不回浏览器
      }
    },
  }

  try {
    const disposeRoute = ctx.webServer.register(route)
    disposers.push(disposeRoute)
    routeRegistered = true
  } catch (e) {
    const msg = String(e && e.message || e)
    // 2026-10-21 夜（m03962 体检）：宿主重启/热重载时偶尔会走第二次 apply，第二次 register 报
    //   `webserver: duplicate prefix route "/sales"`。这是宿主侧「同名前缀只留先注册的那个」的行为，
    //   不是功能坏了（先注册的那个仍在服务）。原来它会污染 errorCount 并让 /sales/egress 长期报红，
    //   现在归类为 routeWarn（在 egress 里单独列出），不当作插件错误。
    if (/duplicate prefix route/i.test(msg)) routeWarn = msg
    else noteError('route.register', msg)
  }

  return () => {
    for (const d of disposers) { try { d() } catch (e) {} }
  }
}
