/**
 * dsh-sales — dock.js
 * 右侧 AI 对话框的「服务端半」（2026-10-21，用户 m01480 / m02018）。
 *
 * 用户原话（m01480）：「在sale插件右侧边增加AI对话框，用于管理和输入跟进信息，
 *   不用再回到DSH的界面对话去操作了，模型可选，要支持多模态的文件和图片上传。」
 * m02018 又明确：「我要修改的就是sale，跟loop没关系，loop已经停用……现在先做好sale」
 *   → 所以这一层落在 dsh-sales，而不是之前那版 dsh-loop 的侧栏（loop 已停用）。
 *
 * 为什么要有这一层（不是把 llm 直接暴露给浏览器）：
 *   · 图片必须经宿主附件服务变成 durable 引用（见 dock-attach.cjs），浏览器没法自己造；
 *   · 模型厂是唯一放行的出网口，出网面必须收敛在宿主进程里一处，便于 /sales/egress 自证；
 *   · 写客户表**绝不**由这里直接落盘 —— 这里只回一段可确认的 action JSON，
 *     面板拿它出确认卡，爹点确认后仍走 `sales_log` 模型工具（= 数据层写入口，带写锁+表头断言+变更留痕）。
 *
 * 红线：本文件不发任何网络请求，只调宿主 llm；客户数据只发给模型厂商（唯一出口），且按最小必要给。
 */
import { randomUUID } from 'node:crypto'
import { llmOf, resolveModel, resolveAiRoute, streamChat } from './ai.js'
import attach from './dock-attach.cjs'

const REASONING_FALLBACK = 'off'
// 2026-10-21（用户 m05130「感觉这个AI助手没有上下文记忆」）：窗口 12→20 条、单条 4000→8000 字。
//   12 条 ≈ 6 轮，且长回答被切掉后半段 —— 表现就是"刚说过的事它不记得"。
const MAX_HISTORY = 20
const MAX_TEXT = 8000
const MAX_CTX = 6000        // 面板塞进来的「当前客户档案」上限
const DIGEST_MAX = 2500     // 「今日实况」每轮都附，压到 2500 字，别让它把历史挤成配角
const SCREEN_MAX = 800      // 「你正看着这一页」的屏幕快照上限（2026-10-21 夜协议 v2）
const TOOLNOTE_MAX = 3500   // 单次工具结果贴回的上限（超出截断并标注）
// 附件正文缓存：表格/合同这类文件，模型只在"上传那一轮"看过；下一轮它手里只剩一句"我传过表了"。
//   用户的用法正是「先丢一张导出表，再一句句让它干活」→ 必须跨轮记住那份表。
//   只放内存（不出网、不落盘客户文件），每个面板一条，最多留 20 个面板。
const FILE_CACHE_MAX = 120000   // 单个文件正文缓存上限（字）
const FILE_CACHE = new Map()    // panelId → { at, names, text, chars }
const FILE_HINT_RE = /(这张表|那份表|这个表|那张表|上面|刚才|上一轮|上回|导出|附件|文件|表格|表里|清单|名单|这批)/

// 2026-10-21 夜（m06146 用户：「约束太紧了，要充分体现智能性，就像 DSH 的对话框一样」）：
//   —— 提示词从 1934 字砍到 ~1200 字，只留**必要性**约束（数据真实、写库必须确认、终态要有据、不承诺效果）；
//   工具细节下沉到 DOCK_TOOLS 的 desc（单一真源），反问改成**有门槛**的两类（疑问 / 重大决策）。
//   原则：能查的自己查、能判断的自己判断、先给结论；普通单条跟进直接出确认卡，不许反问。
export const DOCK_SYSTEM = [
  '你是你（一人公司老板，做工程前期咨询/可研/设计院生意）的销售助手，住在 sale 看板左侧。',
  '你的活：① 管理和录入跟进信息；② 回答客户、今天该跟谁、怎么跟。数据基础=客户表＝主表（客户ID/公司/联系人/手机/等级/状态/SOP阶段/下次跟进/备注）+流水表（日期/方式/类型/内容/反应/下一步），两张表合称「客户表」、是唯一数据基础；只说「客户表」，别叫「底表」、别说成只有主表。',
  '【要数据】正文后给一个 ```json：{"calls":[{"tool":"sales_view","args":{"phone":"<电话1>"}}]}，插件本地查完贴回：',
  'sales_view(phone) 档案+流水｜sales_search(q) 找客户｜sales_today() 今日任务｜sales_tasks() 任务池｜sales_brief() 简报｜sales_summary() 总览｜sales_cadence() 节奏｜sales_sop(phone) 话术｜sales_contract_list() 合同。',
  // 2026-11-11（用户 m02149「客户识别以手机号码为标准，ID不要」）：对外一律手机号。
  //   提示词里不再出现客户ID；插件在本地按手机号认人，认不到才反问。
  '客户一律用**手机号**认（11 位）：查档案、记跟进、点名结论都写 phone，不要写客户ID、也不要在回复里念客户ID。',
  '查得到就用；查不到就照实说没有。你提到的人，插件已按手机号在本机认好，在【本次提到的客户】给手机号——预查好，直接用，**不许再反问「是哪个客户」**；同一手机号对上多个客户时才反问一句。',
  // 2026-10-22（用户 m02146「你要把跟进客户的电话展现出来」）：模型拿到的都是占位符（<电话1> 之类），
  //   提示词里没说过这回事 → 它以为真号被藏了，不敢写、绕开话题。占位符是可原样输出的，回填由插件做。
  '客户名/公司/手机/微信在本机已换成占位符（如 <电话1>、<单位2|咨询公司>）：要展示就**原样写占位符**，插件自动回填真名真号；看到占位符不许说「查不到/看不到」。',
  '列「谁该打/跟谁」时每条**必带手机号**（没有就写「无手机号」）；你要电话就逐个给全，不许省略。',
  '你发图时：先一句说清图里的关键信息（金额/日期/条目/方向），再回答他那句话；看不清就说看不清，别猜、别扯别的。',
  // 2026-10-22（用户 m02366「都修」）：开场一律用库里的原文，模型只许挑/删、不许改写（措辞别飘）。
  '要「开场/第一句话」时：插件给了【开场原文】就照那句说（可删客套、可截短），**不许改写、不许另写**；没给才按档案自己开口。',
  // 2026-10-28（用户 m03015「要同步更新到面板显示上」）：写完要一句话交代改了哪几项，不许让他自己刷新/重复确认。
  '写完库只交代一句：写了哪条、阶段/下次跟进/状态各改成什么，并说「看板已同步」；不许让你自己点刷新，也不许让他重复确认同一件事。',
  // 2026-10-28（用户 m03151）：两种活分开——录入跟进 vs 问这个客户怎么跟。插件会先判并贴【意图】，照它办。
  '先分清你在干嘛：贴的是「打了电话/客户说/聊了」→ 他在录入，直接整理成写卡；问「怎么跟/怎么说/下一步」→ 只给判断+下一步+开场，别出写卡。插件已判并贴【意图】，照它办，别自己改判。',
  '这是同一场持续对话（上文都在，文件插件会贴回）——绝不许说「我没收到文件」，别让你重发。',
  '【写库】只能这两种，插件出确认卡、你点确认才落：',
  '{"action":"log","args":{"phone":"<电话1>","method":"电话","type":"高意向跟进","what":"聊了什么","react":"反应","nextAction":"下一步","nextDate":"YYYY-MM-DD"}}',
  '{"action":"settle","args":{"phone":"<电话1>","kind":"沉默等需求|暂缓|无法联系|推进终止|成交签约","anchor":"日期或信号","stuckAt":"段位"}}',
  // 2026-11-11（用户 m02105/m02128）：跟进的**九要素**——记一笔在助手输入框完成，用户没说的一律留空，
  //   确认卡会显示「已填 N/9」，人可以在卡上补；绝不替用户编日期/反应/下一步。
  '一条跟进尽量凑齐九要素（缺的可以留空，卡上会显示「已填 N/9」让你补）：手机号、沟通内容(≥8字)、日期、方式、类型、阶段、对方反应、下一步动作、下次跟进时间。',
  '用户没说的要素**一律留空**，不许猜日期、猜反应、猜下一步；只把他说过的、以及插件贴给你的事实写进卡里。what 用他的原话概括，别加工成汇报腔。',
  // 2026-11-11（用户 m02105②「面板不要显示我给出命令的过程」）：看板只留结论与卡，过程别复述。
  '看板只显示你的结论和确认卡：**不要复述你的检索步骤、工具调用、JSON、命令过程**，也不要说「我先查一下」；查完直接给结论。',
  '类型只能是 首触/试用回访/高意向跟进/老客服务/客户反馈/策略调整/放弃跟进/数据整理；状态是 跟进中/挂起/重点跟进/挂起冷备/已闭环/待首触；阶段是 SOP 段。三者别混：类型是这一次干了什么，状态是客户现在停在哪，阶段是走到 SOP 哪一段。',
  // 2026-10-29（用户 m03421：写卡「方式：会议」→ 点确认才报「方式不合法」）：方式枚举要写在提示词里，
  //   别让模型到了写库才被拒；口语词插件会自动归一（会议→上门、视频会议→电话），但它最好一次写对。
  '方式只能写 电话/微信/上门/短信/合同/官网申请/其他（开会=上门、视频/线上会议=电话，插件会自动归一，别自己造词）。',
  // 2026-10-29（用户 m03535「跟进记录不对应 sop」）：模型以前不传 stage 时，插件把记录一律压在客户
  //   当前阶段下（做了演示也挂在「需求挖掘」），面板看着像记错人。现在插件按 what 判段，模型别抢着填。
  'stage 一般别传：插件按 what 判这一段（演示→产品演示、报价→方案报价、签约→成交签约）；只有你确定该落到某段时才写 stage。',
  '写一次客户表=回写主表状态+追加一条流水（客户表的两张表永远一致，由插件一个写入口保证）；不确定的字段别写。终态（挂起/挂起冷备/已闭环）要有结论或锚点，否则会拒——拒了就是没写，照实说。一条回答最多 2 张写卡。',
  '【只有两种情况才反问】正文后给：{"action":"ask","args":{"q":"…","options":["A","B"],"why":"为什么问"}}（2~4 个可点选项）',
  '一是真有疑问：插件没给手机号、自己也查不到、要写库却缺手机号/结论/锚点、和上一轮明确指令冲突。',
  '二是重大决策：一次要动多个客户、清排期/归档/作废这类不可逆的事、要重新激活挂起冷备或主动跟进已闭环、要花大钱的批量活。',
  '其余一律自己查、自己判断、先给结论——**可查的东西不许反问，信息够就不许反问**；普通单条跟进直接出确认卡。',
  '【口径】挂起冷备/已闭环不主动催（2026-10-19）；不承诺效果、不编案例数据；引政策要说文号与版本，不确定标「待核实」。中文短句，先结论后理由。',
].join('\n')

// 2026-10-21 夜（协议 v2）：插件暴露给模型的**工具面**——每个都对应底盘上已有的一个命令，
//   写成"文字 JSON 协议"而不是 provider 原生 tool-calling（跨模型一致，不依赖适配器能力）。
//   write:true 的工具**永远不由循环执行**：只产出 confirmation 卡（先跑 logplan/settleplan 出预览）。
export const DOCK_TOOLS = [
  { name: 'sales_view', desc: '客户档案 + 流水 + SOP（给 11 位手机号）', write: false, cmd: 'view', arg: (a) => String((a && (a.phone || a.id)) || '') },
  { name: 'sales_search', desc: '按姓名/公司/手机/微信找客户', write: false, cmd: 'search', arg: (a) => String((a && (a.q || a.kw)) || '') },
  { name: 'sales_today', desc: '今日任务队列（必打/首触/该打）', write: false, cmd: 'plan', arg: () => null },
  { name: 'sales_tasks', desc: '任务池（逾期/临期/未排期/待定）', write: false, cmd: 'tasks', arg: () => null },
  { name: 'sales_brief', desc: '今日简报（盘点+异常+优先级）', write: false, cmd: 'brief', arg: () => null },
  { name: 'sales_summary', desc: '总览（客户/流水/分类/触达）', write: false, cmd: 'summary', arg: () => null },
  { name: 'sales_cadence', desc: '四类跟进节奏到点清单', write: false, cmd: 'cadence', arg: () => null },
  { name: 'sales_sop', desc: '某客户的 SOP 进度与话术（给 11 位手机号）', write: false, cmd: 'sop', arg: (a) => String((a && (a.phone || a.id || a.q || a.query)) || '') },
  { name: 'sales_contract_list', desc: '合同台账清单', write: false, cmd: 'contract', arg: () => ({ action: 'list' }) },
  { name: 'sales_log', desc: '记一条跟进（须确认；先用 logplan 出预览；九要素：phone/what/date/method/type/stage/react/nextAction/nextDate）', write: true, planCmd: 'logplan', writeCmd: 'log' },
  { name: 'sales_settle', desc: '点名结论/转终态（须确认；先用 settleplan 出预览）', write: true, planCmd: 'settleplan', writeCmd: 'settle' },
]
export function dockToolByName(name) {
  const n = String(name == null ? '' : name).trim()
  for (const t of DOCK_TOOLS) if (t.name === n) return t
  return null
}
// 老格式（action:lookup/search）与工具名的对应，v1 兼容用
const LEGACY_TOOL = { lookup: 'sales_view', search: 'sales_search' }


/**
 * 2026-10-21 晚（用户「不能客户跟进处理」）：sales-lib 的 search 返回 {keyword,count,hits}，
 *   调用方原来只认「数组」或 `.list` → `.hits` 被当成没结果，模型于是回「没查到匹配客户」。
 *   形状归一集中在这里，index.js 与探针共用同一份判定。
 */
export function searchRowsOf(data) {
  const d = data || {}
  if (Array.isArray(d)) return d
  if (Array.isArray(d.hits)) return d.hits
  if (Array.isArray(d.list)) return d.list
  if (Array.isArray(d.rows)) return d.rows
  return []
}

/**
 * 从用户一句话里认出「要查谁」：11 位手机号，或客户ID（C-xx-xxxx-NNN）。
 *   认出来就由插件**发模型之前**先在本地查好（一次 search/view，不出网），模型不用自己决定去查。
 */
export function preLookupTarget(text) {
  const s = String(text == null ? '' : text)
  const phone = (s.match(/(^|\D)(1[3-9]\d{9})(?!\d)/) || [])[2] || ''
  const cid = (s.match(/C-[\w\u4e00-\u9fa5]+-[\w\u4e00-\u9fa5]+-[\w\u4e00-\u9fa5]+/) || [])[0] || ''
  return { phone, cid, kind: cid ? 'id' : (phone ? 'phone' : '') }
}
// 2026-10-22（用户 m01260）：消息里没手机号/客户ID时，也值得在本机解析一次——
//   只要出现「XX公司/XX设计院/XX总/XX老师」这类身份线索，就把话交给底盘的 resolve 命令认人。
//   为什么必须在**遮罩之前**做：摘要与用户原话发模型前都会脱敏，模型看到的是 <单位1|咨询公司>，
//   它没法靠自己猜出是哪家；插件在本地认好了，只要把「客户ID」贴给模型就行（ID 不是身份信息）。
const PRE_ORG_RE = /[\u4e00-\u9fa5A-Za-z0-9（）()]{2,30}?(?:股份有限公司|有限责任公司|有限公司|公司|集团|设计院|研究院|事务所|中心|大学|学院|厂|局)/g
const PRE_PERSON_RE = /[\u4e00-\u9fa5]{1,3}(?:老师|总|经理|主任|院长|所长|先生|女士)/g
export function preResolveTargets(text) {
  const s = String(text == null ? '' : text)
  const orgs = (s.match(PRE_ORG_RE) || []).slice(0, 4)
  const people = (s.match(PRE_PERSON_RE) || []).slice(0, 4)
  return { orgs, people, any: !!(orgs.length || people.length) }
}

// 2026-10-28（用户 m03151）：「这个助手要能自动识别两个工作：一种是我在录入跟进信息；一种是我要询问这个客户怎么跟。」
//   为什么要本地判、不交给模型猜：
//     ① 模型看到的是**脱敏后**的原话 + 一大段「今日实况」摘要，很容易把「录入」当提问（回一堆策略、一张卡都不出），
//        也容易把「提问」当录入（照着档案凭空造一条跟进）；
//     ② 判完把意图**明确写进提示**（intentNote），比让它从上下文里猜稳得多；
//     ③ 判成「录入」但它还是没出卡时，插件按用户原话整理一张**待确认**的卡（仍然要点确认才落库，绝不自动写）。
//   判定只看措辞，不看情绪：有"打了电话/客户说/聊了…"这类事实词 → 录入；有"怎么跟/怎么说/话术/下一步…" → 咨询。
const INTENT_LOG_CMD_RE = /(帮我记|记一条|记一下|补一条|录入|记进|落库|写一条|写进|记下来|存一下|记录一下)/
const INTENT_LOG_WORD_RE = /(打了电话|电话打通|打通了|通了电话|没接|无人接听|加了微信|加微信|发了微信|发微信|微信聊|上门|到访|见面|聊了|沟通了|跟进了|回访了|客户说|客户反馈|客户提到|对方说|回复说|说月底|说下周|报价|签约|成交|试用|方案|合同|催了|答应|同意|拒绝了|要了方案|嫌贵|价格高)/g
const INTENT_ADVISE_RE = /(怎么跟|怎么打|怎么说|说什么|怎么谈|怎么聊|话术|开场|下一步|该不该|要不要|值不值得|怎么推进|怎么破|怎么办|为啥不回|为什么不回|多久跟|什么时候跟|跟进建议|怎么催|催一下|如何跟进|怎么开口|能不能跟)/g
const INTENT_ASK_RE = /[?？]|吗\s*$|呢\s*$|如何|是不是|能不能/

export function classifyIntent(text) {
  const s = String(text == null ? '' : text).trim()
  if (!s) return { kind: '', why: '空消息', score: { log: 0, advise: 0 } }
  let log = 0
  let advise = 0
  const why = []
  const cmd = INTENT_LOG_CMD_RE.test(s)
  if (cmd) { log += 4; why.push('记一条') }
  const lw = s.match(INTENT_LOG_WORD_RE) || []
  if (lw.length) { log += Math.min(6, 2 * lw.length); why.push('事实词:' + lw.slice(0, 3).join('/')) }
  const aw = s.match(INTENT_ADVISE_RE) || []
  if (aw.length) { advise += Math.min(8, 3 * aw.length); why.push('征询词:' + aw.slice(0, 3).join('/')) }
  if (!cmd && INTENT_ASK_RE.test(s)) { advise += 2; why.push('问句') }
  // 「客户说价格高，怎么谈？」这种：事实词与征询词同现 → 征询优先（他在问办法，不是让我记）
  const kind = (advise >= 3 && advise >= log) ? 'advise' : (log >= 3 ? 'log' : '')
  return { kind, why: why.join('、'), score: { log, advise } }
}

// 「录入跟进」的兜底整理：模型一张卡都没出时，插件按用户原话拼一张**待确认**的写卡。
//   只有用户点了确认才会落库（走 confirmCard→assistant log），所以这里宁可粗、不要编：
//   他没说的字段一律留空（日期/反应/下一步/排期都不猜）。
const INTENT_METHOD_RE = /(电话|微信|上门|短信|合同|官网申请)/
const INTENT_TYPE_RULES = [
  [/试用|演示|POC/i, '试用回访'],
  [/老客|续费|续签/, '老客服务'],
  [/投诉|不满意|抱怨|反馈/, '客户反馈'],
  [/首触|第一次联系|第一次打/, '首触'],
  [/不跟|放弃|不做了|没需求了/, '放弃跟进'],
]
// target 可以是旧式「客户ID 字符串」，也可以是 { phone, id }（1.3.0 起优先手机号）。
export function draftLogCard(text, target) {
  const t = (target && typeof target === 'object') ? target : { id: String(target || '') }
  const phone = String(t.phone || '').trim()
  const cid = String(t.id || '').trim()
  if (!phone && !/^C-/.test(cid)) return null
  let s = String(text == null ? '' : text)
  // 去掉开头那句"帮我记/记一条"，以及手机号/客户ID（那是定位用的，不该写进沟通内容）
  s = s.replace(/^[，,。.\s]*(帮我记一条|帮我记下|帮我记|记一条|记一下|补一条|记录一下|录入一下|写一条)[：:，,。.\s]*/, '')
  s = s.replace(/1[3-9]\d{9}/g, '').replace(/C-[\w\u4e00-\u9fa5]+-[\w\u4e00-\u9fa5]+-[\w\u4e00-\u9fa5]+/g, '')
  s = s.replace(/\s+/g, ' ').replace(/\s+([，。；、,.;：:])/g, '$1').trim()
  if (s.length < 6) return null
  const m = s.match(INTENT_METHOD_RE)
  let type = '高意向跟进'
  for (const [re, t2] of INTENT_TYPE_RULES) { if (re.test(s)) { type = t2; break } }
  const args = { method: m ? m[1] : '', type, what: s.slice(0, 300) }
  if (phone) args.phone = phone; else args.id = cid
  return {
    ok: true,
    action: 'log',
    args,
    fixed: [],
    frame: frameOfArgs(args),
    draftFrom: 'intent',
    note: '（插件按「录入跟进」把这段话整理成了一行：没说日期/反应/下一步就留空，卡上可以补；确认前改也行）',
  }
}

// 2026-10-21 夜（m03706）：lookup/search 是「要插件在本地查数据」，只读；真正写表的动作只有 log。
const WRITE_ACTIONS = { log: 1 }
const LOG_ARG_KEYS = [
  'id', 'date', 'method', 'type', 'what', 'react', 'nextAction', 'nextDate', 'nextMethod',
  'stage', 'level', 'status', 'note', 'phone', 'name', 'company', 'city', 'wechat', 'reg', 'expire',
]
// 2026-10-21 夜（m05977 用户实测）：模型把「跟进状态」当「类型」写进确认卡
//   （type:'挂起冷备' → cmdLog 回「类型不合法: 挂起冷备」，而确认卡还谎报「✅ 已写入流水表」）。
//   模型分不清「类型/状态/阶段」是这场对话里第三次发生，所以不靠提示词，改在面板侧兜住：
//   类型位写错东西就归一到合法类型，并把那个词挪到它真正的家（status / stage）。
const TYPE_NAMES = ['首触', '试用回访', '高意向跟进', '老客服务', '客户反馈', '策略调整', '放弃跟进', '数据整理']
const TYPE_SET = (() => { const s = {}; for (const t of TYPE_NAMES) s[t] = 1; return s })()
const STATUS_NAMES = ['跟进中', '挂起', '重点跟进', '挂起冷备', '已闭环', '待首触']
const STAGE_ALIAS = {
  '线索获取': '线索获取', '客户触达': '客户触达', '需求挖掘': '需求挖掘', '产品演示': '产品演示',
  '异议处理': '异议处理', '方案报价': '方案报价', '成交签约': '成交签约',
  '无法联系': '无法联系', '推进终止': '推进终止',
  // 旧名/口语：与 sales-lib 的 STAGE_ALIAS 同口径
  '预约演示': '产品演示', '价值传递': '产品演示', '触达': '客户触达',
}
/**
 * 把确认卡的参数修正到「类型/状态/阶段各就各位」。
 * 返回 { args, fixed:[...人话] }；fixed 会写进确认卡提示，用户看得见改了什么。
 */
export function normalizeLogArgs(input) {
  const args = Object.assign({}, (input && typeof input === 'object') ? input : {})
  const fixed = []
  const t = String(args.type == null ? '' : args.type).trim()
  if (t && !TYPE_SET[t]) {
    if (STATUS_NAMES.indexOf(t) >= 0) {
      // 「挂起冷备」这种是状态，不是类型：类型补一个如实的「策略调整」，状态按它写
      if (!String(args.status == null ? '' : args.status).trim()) args.status = t
      else if (String(args.status).trim() !== t) fixed.push('类型「' + t + '」看着是状态，但卡里已有状态「' + String(args.status).trim() + '」，以卡里为准')
      args.type = '策略调整'
      fixed.push('类型「' + t + '」是跟进状态不是类型 → 类型按「策略调整」记，状态按「' + t + '」写')
    } else if (STAGE_ALIAS[t]) {
      if (!String(args.stage == null ? '' : args.stage).trim()) args.stage = STAGE_ALIAS[t]
      args.type = '策略调整'
      fixed.push('类型「' + t + '」是 SOP 阶段不是类型 → 阶段按「' + STAGE_ALIAS[t] + '」写，类型按「策略调整」记')
    } else {
      args.type = '策略调整'
      fixed.push('类型「' + t + '」不在可选范围（' + TYPE_NAMES.join('/') + '）→ 按「策略调整」记')
    }
  }
  // 阶段位写错（写成状态/类型）也挪走，别让 cmdLog 再拒一次
  const st = String(args.stage == null ? '' : args.stage).trim()
  if (st && STATUS_NAMES.indexOf(st) >= 0) {
    if (!String(args.status == null ? '' : args.status).trim()) args.status = st
    delete args.stage
    fixed.push('阶段位写成了状态「' + st + '」→ 已挪到状态，阶段不动')
  }
  return { args, fixed }
}

export function dockCaps() { return attach.CAPS }

// 2026-10-21 晚（图片通道最后一公里）：插件自己 fiber 里 `ctx.get('attachments')` 拿不到
//   （实测 /sales/assistant models → status.attachments=false，即使宿主已加载 attachment-local）。
//   但**别的已注入服务的 ctx 在自己的 fiber 里能看到它**——宿主 dsh-llm 就是 `this.ctx.get('attachments')`
//   （app.asar:dsh-llm/lib/index.js 的 fileReadPath），聊天里的图片能进模型就是这条路的证明。
//   所以这里按「直接属性 → 同 fiber get → 借已注入服务的 ctx 去取」三级退让；都拿不到才返回 null（图片降级、文字照发）。
const BORROW_SERVICES = ['llm', 'agentDefaultModel', 'tools', 'webServer', 'shell']
export function attachmentsProbe(ctx) {
  const out = { direct: false, ownGet: false, borrowed: null, tries: [] }
  if (!ctx) return out
  try { if (ctx.attachments) { out.direct = true; out.svc = ctx.attachments; return out } } catch (e) { out.tries.push('direct:' + String((e && e.message) || e)) }
  try {
    if (typeof ctx.get === 'function') {
      const s = ctx.get('attachments')
      if (s) { out.ownGet = true; out.svc = s; return out }
      out.tries.push('ownGet:undefined')
    } else out.tries.push('ownGet:no-get')
  } catch (e) { out.tries.push('ownGet:' + String((e && e.message) || e)) }
  for (const name of BORROW_SERVICES) {
    try {
      const svc = (typeof ctx.get === 'function') ? ctx.get(name) : ctx[name]
      if (!svc) { out.tries.push(name + ':no-service'); continue }
      const c = svc.ctx
      if (!c || typeof c.get !== 'function') { out.tries.push(name + ':no-ctx'); continue }
      const a = c.get('attachments')
      if (a) { out.borrowed = name; out.svc = a; return out }
      out.tries.push(name + ':undefined')
    } catch (e) { out.tries.push(name + ':' + String((e && e.message) || e)) }
  }
  return out
}

export function attachmentSvc(ctx) {
  const p = attachmentsProbe(ctx)
  return p.svc || null
}

// 面板顶上那个「现在用哪个模型/能选哪些」的自证+目录（零网络：只读宿主本地目录）
//   2026-10-21 修：attachments 服务在插件 fiber 里直接 ctx.get 拿不到，必须用 ctx.inject(['attachments'])
//   得到的子上下文；所以由 index.js 把那个上下文当第二个参数传进来。
export function dockStatus(ctx, attachCtx) {
  const m = resolveModel(ctx)
  const llm = llmOf(ctx)
  // attachCtx 可能是「附件服务本身」（index.js 的三级退让取到的），也可能是子上下文/空
  const svc = (attachCtx && (typeof attachCtx.saveImages === 'function' || typeof attachCtx.admitEncodedImages === 'function'))
    ? attachCtx
    : attachmentSvc(attachCtx || ctx)
  return {
    llm: !!llm,
    attachments: !!svc,
    model: m.label,
    provider: m.provider,
    supportsImage: true,          // 图片支持按「这次选的模型」判，见 chat 里的模态闸门
    caps: attach.CAPS,
    maxHistory: MAX_HISTORY,
    maxText: MAX_TEXT,
  }
}

// 2026-10-21 夜实测（用户 m06887「把各个关节实测跑一下」）：**profile 里写着 input: [text, image] 的模型
//   不一定真能看图**。实测 deepseek-official/deepseek-flash 收下图片后完全无视它（发纯红 PNG 问「什么颜色」，
//   它答了一堆客户名单；换 云端网关/kimi-k2.6 同一张图立刻答「红色」）。宿主的模型元数据是手写的，写错了适配器
//   就不会把图投影成占位文字，而是照样发出去、网关默默丢掉 → 用户只会看到「发了图 AI 没反应」。
//   → 这里维护一份「实测不看图」名单：命中就当纯文字模型（面板标「不看图·实测」，图片闸门当场拦住）。
//   名单随时可删：哪天那个模型真能看图了，删掉对应一行即可。
const KNOWN_NO_VISION = {
  'deepseek-official/deepseek-flash': '2026-10-21 实测：纯红 PNG 问颜色 → 答非所问（profile 里 input 写了 image，实际不认）',
}

function noVisionReason(provider, model) {
  return KNOWN_NO_VISION[String(provider || '') + '/' + String(model || '')] || ''
}

// 这个模型吃不吃图片（宿主 llm.resolveModelInfo 的 inputModalities）
async function modelModalities(llm, provider, model) {
  try {
    if (noVisionReason(provider, model)) return ['text']   // 实测不看图 → 当纯文字模型
    if (!llm || typeof llm.resolveModelInfo !== 'function' || !provider || !model) return null
    const info = await llm.resolveModelInfo(provider, model)
    if (!info) return null
    const mods = Array.isArray(info.inputModalities) ? info.inputModalities
      : (Array.isArray(info.input) ? info.input : null)
    return mods ? mods.map((x) => String(x)) : null
  } catch (e) {
    return null
  }
}

async function reasoningOf(llm, provider, model) {
  try {
    if (!llm || typeof llm.resolveModelInfo !== 'function' || !provider || !model) return null
    const info = await llm.resolveModelInfo(provider, model)
    const r = info && info.reasoning
    if (!r || !Array.isArray(r.efforts) || !r.efforts.length) return { supported: false, ids: [], defaultEffort: undefined }
    return { supported: true, ids: r.efforts.map((e) => String(e && e.id)).filter(Boolean), defaultEffort: r.defaultEffort }
  } catch (e) {
    return null
  }
}

export async function listCatalog(ctx) {
  const llm = llmOf(ctx)
  const cur = resolveModel(ctx)
  const out = { current: { provider: cur.provider, model: cur.model, text: cur.label }, providers: [], errors: [] }
  if (!llm || typeof llm.listProviders !== 'function') {
    out.errors.push('宿主没给 llm 服务（面板只能显示当前模型，不能换）')
    return out
  }
  let list = []
  try { list = await llm.listProviders() } catch (e) {
    out.errors.push('列 provider 失败：' + String((e && e.message) || e))
    return out
  }
  for (const p of (Array.isArray(list) ? list : [])) {
    const id = String((p && (p.id || p.provider)) || '')
    if (!id) continue
    const row = { id, name: String((p && p.name) || id), models: [] }
    try {
      const ms = (typeof llm.listModels === 'function') ? await llm.listModels(id) : []
      row.models = (Array.isArray(ms) ? ms : [])
        .map((m) => {
          // 2026-10-21 修：宿主 llm.listModels 的模态字段叫 inputModalities，不是 input。
          //   原来只读 m.input → 面板上所有模型都显示「不看图」，图片到底能不能发也就判错了。
          const mods = Array.isArray(m && m.inputModalities) ? m.inputModalities
            : (Array.isArray(m && m.input) ? m.input : [])
          let input = mods.map((x) => String(x))
          const mid = String((m && m.id) || '')
          const noSee = noVisionReason(id, mid)
          if (noSee) input = input.filter((x) => x !== 'image')   // 实测不看图 → 面板别再标「🖼 看图」
          return {
            id: mid,
            name: String((m && m.name) || (m && m.id) || ''),
            input,
            supportsImage: input.indexOf('image') !== -1,
            ...(noSee ? { noVisionNote: noSee } : {}),
          }
        })
        .filter((m) => m.id)
    } catch (e) {
      out.errors.push(id + '：' + String((e && (e.message || e.code)) || e))
    }
    if (row.models.length) out.providers.push(row)
  }
  return out
}

// 2026-10-21（m02957 回归）：assistant 消息必须带 source —— pi-ai 的 toPiAssistant() 直接读
//   message.source.replayState，没有 source 就抛 TypeError「Cannot read properties of undefined
//   (reading 'replayState')」，表现是**第二轮开始每轮都失败**（第一轮没有历史所以看不出来）。
//   source 形状照宿主 durable 消息：{kind:'model', provider, model}；不带 replayState 时
//   适配器会自己降级成 provider-neutral 历史，多轮照样能续。
function mkMsg(role, content, model) {
  const m = { id: 'sales-dock-' + randomUUID(), role, content }
  if (role === 'user') m.source = { kind: 'plugin', plugin: 'dsh-sales' }
  else if (role === 'assistant') m.source = { kind: 'model', provider: (model && model.provider) || 'unknown', model: (model && model.model) || 'unknown' }
  return m
}

/**
 * 2026-10-21 夜（协议 v2）：从模型回答里抽出**全部**结构化输出。
 *   返回 { text, calls:[{tool,args}], writeCards:[{ok,action,args,fixed,raw}|{ok:false,...}], ask:{q,options,why}|null }
 *   - calls：只读工具调用（一轮最多 3 个），由 index.js 在本地跑完把结果贴回
 *   - writeCards：写库确认卡（最多 2 张），**永不由循环执行**，交面板渲染确认卡
 *   - ask：反问卡（与写卡不同时出现），门槛见 DOCK_SYSTEM
 *   兼容 v1：{"action":"lookup"|"search"} 等价于 sales_view / sales_search。
 */
const SETTLE_KINDS = ['沉默等需求', '暂缓', '无法联系', '推进终止', '成交签约']
const MAX_CALLS_PER_TURN = 3
const MAX_WRITE_CARDS = 2

// 2026-11-11（1.3.0，用户 m02105/m02128/m02149）：
//   ① 确认卡一律带 phone（客户识别以手机号为准；id 只留内部兼容，不在面板/提示词出现）；
//   ② 卡上带 frame（九要素已填/缺项）→ 面板显示「已填 N/9」，人可以在卡里补齐；
//   ③ phone/what 缺了照样拒绝（写空卡没意义），其餘要素缺了**只提示不拦**（软框架）。
const FRAME_KEYS = ['phone', 'what', 'date', 'method', 'type', 'stage', 'react', 'nextAction', 'nextDate']
export function frameOfArgs(input) {
  const a = (input && typeof input === 'object') ? input : {}
  const filled = []
  const missing = []
  for (const k of FRAME_KEYS) {
    const v = String(a[k] == null ? '' : a[k]).trim()
    if (v) filled.push(k); else missing.push(k)
  }
  return { filled, missing, total: FRAME_KEYS.length, n: filled.length }
}
function isPhone11(s) { return /^1[3-9]\d{9}$/.test(String(s || '').trim()) }
function buildLogCard(rawArgs) {
  const args = {}
  for (const k of LOG_ARG_KEYS) {
    if (rawArgs[k] !== undefined && rawArgs[k] !== null && String(rawArgs[k]).trim() !== '') args[k] = rawArgs[k]
  }
  const phone = String(args.phone || '').trim()
  const cid = String(args.id || '').trim()
  if (!phone && !cid) return { ok: false, action: 'log', error: '模型给的确认卡没有客户手机号（客户识别以手机号为准），不能写库' }
  if (phone && !isPhone11(phone)) return { ok: false, action: 'log', error: '手机号不是 11 位（应以 1 开头）：' + phone }
  if (cid && !/^C-/.test(cid)) return { ok: false, action: 'log', error: '内部客户编号格式不对（应以 C- 开头）：' + cid }
  if (!String(args.what || '').trim()) return { ok: false, action: 'log', error: '确认卡里没有「沟通内容」(what)，不写空跟进' }
  if (!String(args.method || '').trim()) args.method = '其他'
  // 2026-10-21 夜（m05977）：类型/状态/阶段互相写错是模型的常见病，先归一再用；
  //   归一记录 fixed 带给面板显示，用户能看见「AI 想写的类型被我改成了什么」。
  const nr = normalizeLogArgs(args)
  const fixedArgs = nr.args
  if (!String(fixedArgs.type || '').trim()) fixedArgs.type = '高意向跟进'
  return { ok: true, action: 'log', args: fixedArgs, fixed: nr.fixed, frame: frameOfArgs(fixedArgs) }
}

function buildSettleCard(rawArgs) {
  const args = {}
  for (const k of ['id', 'phone', 'kind', 'anchor', 'stuckAt', 'note', 'date', 'ids']) {
    if (k === 'ids') {
      if (Array.isArray(rawArgs.ids) && rawArgs.ids.length) args.ids = rawArgs.ids.slice(0, 50)
      continue
    }
    if (rawArgs[k] !== undefined && rawArgs[k] !== null && String(rawArgs[k]).trim() !== '') args[k] = rawArgs[k]
  }
  const phone = String(args.phone || '').trim()
  const cid = String(args.id || '').trim()
  const batch = Array.isArray(args.ids) && args.ids.length > 0
  if (!phone && !cid && !batch) return { ok: false, action: 'settle', error: '结论卡没有客户手机号（客户识别以手机号为准），不能写库' }
  if (phone && !isPhone11(phone)) return { ok: false, action: 'settle', error: '手机号不是 11 位（应以 1 开头）：' + phone }
  if (cid && !/^C-/.test(cid)) return { ok: false, action: 'settle', error: '内部客户编号格式不对（应以 C- 开头）：' + cid }
  const kind = String(args.kind || '').trim()
  if (SETTLE_KINDS.indexOf(kind) < 0) return { ok: false, action: 'settle', error: '结论只能是 ' + SETTLE_KINDS.join('/') + '，收到：' + (kind || '(空)') }
  return { ok: true, action: 'settle', args }
}

export function parseBlocks(text) {
  const s = String(text == null ? '' : text)
  // 2026-10-22（用户 m01059 截图：AI 气泡里露出 ```json {"calls":…}``` 而正文没了）：
  //   正文剥离原来只认「闭合的 ```json 块」，模型偷懒不闭合围栏、或者干脆裸写 {"calls":…} 时，
  //   协议 JSON 就原样漏进气泡。现在三种形态都吃掉，且**只吞协议块**（calls/action），
  //   别把用户正当的代码块/话术块一起吞了。
  const blocks = []
  const fre = /```(?:json)?\s*([\s\S]*?)(?:```|$)/g
  let fm
  while ((fm = fre.exec(s))) {
    const full = String(fm[0] || '')
    blocks.push({ body: String(fm[1] || '').trim(), start: fm.index, end: fm.index + full.length })
    if (!/```\s*$/.test(full)) break          // 匹配到结尾（没有闭合围栏）：本轮结束，否则会空转
    if (!full.length) break
  }
  const bareTrim = s.trim()
  // 裸协议 JSON：整段回答只有一个 {"calls":…} / {"action":…}，没有任何围栏
  if (/^\{\s*"(calls|action)"/.test(bareTrim) && !blocks.length) blocks.push({ body: bareTrim, start: 0, end: s.length })
  const isProto = (b) => /^\{\s*"(calls|action)"/.test(String(b || ''))
  let bodyText = s
  const cut = blocks.filter((b) => isProto(b.body))
  for (let i = cut.length - 1; i >= 0; i--) bodyText = bodyText.slice(0, cut[i].start) + bodyText.slice(cut[i].end)
  bodyText = bodyText.trim()
  if (isProto(bodyText)) bodyText = ''
  // 正文末尾又裸贴一个协议 JSON（没围栏、前面还有正文）：从最后一个 {"calls" / {"action" 起整段试着解析，
  //   解析得通就切掉并当成协议块用；解析不通说明是正儿八经的 JSON，原样留着别吞。
  for (const key of ['{"calls"', '{"action"']) {
    let at = bodyText.lastIndexOf(key)
    while (at >= 0) {
      try {
        const o = JSON.parse(bodyText.slice(at))
        if (o && typeof o === 'object') {
          blocks.push({ body: JSON.stringify(o), start: at, end: bodyText.length })
          bodyText = bodyText.slice(0, at).trim()
        }
        break
      } catch (e) { at = bodyText.lastIndexOf(key, at - 1) }
    }
  }
  const out = { text: bodyText, calls: [], writeCards: [], ask: null }
  for (const blk of blocks) {
    const body = String(blk.body || '')
    if (!body || body[0] !== '{') continue
    let obj = null
    try { obj = JSON.parse(body) } catch (e) { continue }
    if (!obj || typeof obj !== 'object') continue
    // ① 工具调用（可一次多个）
    if (Array.isArray(obj.calls)) {
      for (const c of obj.calls) {
        const t = dockToolByName(c && c.tool)
        if (!t || t.write) continue                       // 写工具不许在循环里跑
        const a = (c && c.args && typeof c.args === 'object') ? c.args : {}
        out.calls.push({ tool: t.name, args: a })
      }
      continue
    }
    const action = String(obj.action || '').trim()
    const rawArgs = (obj.args && typeof obj.args === 'object') ? obj.args : {}
    // ② v1 兼容
    if (action === 'lookup' || action === 'search') {
      const a = action === 'lookup'
        ? { id: String(rawArgs.id || rawArgs.q || '').trim() }
        : { q: String(rawArgs.q || rawArgs.id || '').trim() }
      const t = dockToolByName(LEGACY_TOOL[action])
      if (t && (a.id || a.q)) out.calls.push({ tool: t.name, args: a })
      continue
    }
    // ③ 反问
    if (action === 'ask') {
      if (out.ask) continue
      const q = String(rawArgs.q || rawArgs.question || rawArgs.text || '').trim()
      const options = (Array.isArray(rawArgs.options) ? rawArgs.options : [])
        .map((x) => String(x == null ? '' : x).trim()).filter(Boolean).slice(0, 4)
      if (q || options.length) {
        out.ask = { q: q.slice(0, 300), options, why: String(rawArgs.why || '').trim().slice(0, 200) }
      }
      continue
    }
    // ④ 写库卡
    if (action === 'log') { const c = buildLogCard(rawArgs); if (c) { c.raw = body; out.writeCards.push(c) } continue }
    if (action === 'settle') { const c = buildSettleCard(rawArgs); if (c) { c.raw = body; out.writeCards.push(c) } continue }
  }
  out.calls = out.calls.slice(0, MAX_CALLS_PER_TURN)
  out.writeCards = out.writeCards.slice(0, MAX_WRITE_CARDS)
  if (out.writeCards.length) out.ask = null       // 反问与写卡不同时出现（避免一轮两个"卡"打架）
  return out
}

/**
 * v1 兼容出口（探针/旧调用方）：返回单个动作。
 *   写卡 → {ok,action:'log'|'settle',args,fixed}；只读调用 → {ok:true,action:'lookup'|'search'|'tool',...}
 */
export function parseAction(text) {
  const b = parseBlocks(text)
  if (b.writeCards.length) return b.writeCards[0]
  if (b.calls.length) {
    const c = b.calls[0]
    if (c.tool === 'sales_view') {
      const v = String(c.args.phone || c.args.id || '')
      return v ? { ok: true, action: 'lookup', args: { phone: v, id: v } } : null
    }
    if (c.tool === 'sales_search') return { ok: true, action: 'search', args: { q: String(c.args.q || '') } }
    return { ok: true, action: 'tool', tool: c.tool, args: c.args }
  }
  return null
}

/**
 * 聊天主入口。
 * @param {object} ctx 插件上下文
 * @param {object} args {text, messages:[{role,text}], provider, model, reasoningEffort, images:[{name,mediaType,b64}], files:[{name,mediaType,b64}], id}
 * @param {object} deps {contextText, timeoutMs, onDelta}
 */
export async function chat(ctx, args, deps) {
  const llm = llmOf(ctx)
  if (!llm) return { ok: false, error: '宿主没给 llm 服务：AI 侧栏现在用不了（面板其余功能不受影响）' }
  const o = args || {}
  const d = deps || {}
  // 脱敏/回填由调用方注入（index.js 用 redact.createMasker 做 A′ 档：姓名/公司/手机/微信→占位符，回来回填）。
  //   放在这里而不是内部 import，是为了让 dock.js 保持纯「组装+调模型」，脱敏口径只有一处。
  const mask = (typeof d.mask === 'function') ? d.mask : ((x) => String(x == null ? '' : x))
  const unmask = (typeof d.unmask === 'function') ? d.unmask : ((x) => String(x == null ? '' : x))
  const text = mask(String(o.text == null ? '' : o.text).slice(0, MAX_TEXT))
  // 2026-10-21 修：插件 fiber 里 ctx.attachments 是拿不到的（宿主服务要经 ctx.inject(['attachments'])
  //   才能在子上下文里可见，dsh-sales 的 inject 列表没有它）→ index.js 现在把那个子上下文
  //   通过 deps.attachCtx 传进来；取不到就退回原 ctx（那时 buildUploads 会如实报「宿主没给附件服务」）。
  const up = await attach.buildUploads({ ctx: d.attachCtx || ctx, attachCtx: d.attachCtx || null, images: o.images, files: o.files })
  // 文件正文长度要在**脱敏前**算（面板显示「读了多少字」，脱敏只是换占位符）
  const rawFileText = attach.fileSectionsToText(up.fileSections)
  const fileText = mask(rawFileText)
  if (!text.trim() && !fileText && !up.imageCount && !d.toolNote) {
    return { ok: false, error: '说一句话再发（空的我没什么可回的）', attachments: { errors: up.errors } }
  }

  // 拼这一轮的用户内容：图片块在前（适配器要求 image 块只出现在 user 消息里），文本在后
  const content = []
  for (const b of up.blocks) content.push(b)
  // 附件跨轮记忆（m05130）：这一轮真传了文件 → 把正文存进本面板的缓存；没传但问到表/文件 → 贴回缓存。
  const panelId = String(o.panelId || '').slice(0, 64)
  const cached = panelId ? FILE_CACHE.get(panelId) : null
  if (rawFileText && panelId) {
    FILE_CACHE.set(panelId, {
      at: Date.now(),
      names: (up.fileNames || []).slice(0, 6),
      text: fileText.slice(0, FILE_CACHE_MAX),
      chars: fileText.length,
    })
    if (FILE_CACHE.size > 20) {
      // 只留最近 20 个面板（Map 保序：第一个就是最老的）
      const oldest = FILE_CACHE.keys().next()
      if (oldest && !oldest.done) FILE_CACHE.delete(oldest.value)
    }
  }
  const wantsFile = !rawFileText && !up.imageCount && !!(cached && cached.text) && FILE_HINT_RE.test(String(o.text || ''))
  let cacheUsedChars = 0
  const parts = []
  // 2026-10-21（m05130）：**用户的问题放最前面**。原来「今日实况」5000 字压在最前，模型每轮先读
  //   一份背景摘要、把历史挤到后面，很容易把自己当新会话开场（轮 2 就回了「我只看得到今日实况摘要」）。
  const asked = text.trim() || (d.toolNote ? '（按上面查到的数据继续回答你刚才的问题）' : '（没打字，就看上传的东西帮我办事）')
  parts.push(asked)
  // 2026-10-28（用户 m03151）：这一轮到底是「录入跟进」还是「问这个客户怎么跟」，插件先在本地判，
  //   判完直接写成规矩贴在问题后面——比让模型从脱敏上下文里猜可靠（判据见 classifyIntent）。
  if (d.intentNote) parts.push(String(d.intentNote).slice(0, 600))
  // 2026-10-21 夜（m06146「深度结合进底盘」）：把打卡片当前看的那一页（前 20 条）带上，
  //   这样「这页谁最该打」才答得出来；只是屏幕快照、不是全表，所以给它单独的短预算。
  if (d.screen) parts.push('【你正看着这一页（插件带上来的屏幕快照）】\n' + mask(String(d.screen)).slice(0, SCREEN_MAX))
  // 问题里已经带客户ID/手机号时，实况摘要没必要再占长篇（省 1000+ 字，首 token 更快）
  const digestMax = (d.preNote ? 1200 : DIGEST_MAX)
  if (d.digest) parts.push('【背景资料·今日实况（插件现算，每轮自动附，不代表本轮问题）】\n' + mask(String(d.digest)).slice(0, digestMax))
  // 上一跳模型自己要的数据，由 index.js 在本地查完贴回来（查数据只发生在插件进程内，不出网）
  if (d.toolNote) {
    let tn = mask(String(d.toolNote))
    if (tn.length > TOOLNOTE_MAX) tn = tn.slice(0, TOOLNOTE_MAX) + '\n…（结果太长，已截断；需要细节就缩小范围再查）'
    parts.push('【你上一轮要的查数据结果（插件本地查的）】\n' + tn)
  }
  // 2026-10-21 晚（用户「不能客户跟进处理」）：用户常直接甩一串手机号/客户ID，模型却先反问"是哪个客户"。
  //   插件已在发模型前本地预查（一次 search/view，不出网），这里把结果贴在问题紧后面，模型一开口就有真数据。
  if (d.preNote) parts.push('【插件已按你消息里的手机号/客户ID预查到的客户（本地查的，直接用，别再问是哪个）】\n' + mask(String(d.preNote)).slice(0, 4000))
  if (d.contextText) parts.push('【当前客户档案】\n' + mask(String(d.contextText)).slice(0, MAX_CTX))
  if (fileText) parts.push('【我这一轮上传的文件】\n' + fileText)
  else if (wantsFile) {
    // 跨轮复用：正文原样（已脱敏）贴回，并说清"这是上一轮的、可能不全"
    cacheUsedChars = cached.text.length
    parts.push('【上一轮你上传的文件（插件缓存，可能不全：' + cached.chars.toLocaleString('en-US') + ' 字'
      + (cached.names && cached.names.length ? '，文件名 ' + cached.names.join('、') : '') + '）】\n' + cached.text)
  }
  if (up.imageCount) parts.push('【这一轮我还上传了 ' + up.imageCount + ' 张图片（图在消息内容里，先看清图里是什么：可能是微信截图/名片/合同照片）】')
  content.push({ type: 'text', text: parts.join('\n\n') })

  // 模型档位：面板选了就用面板的（只影响这一次，不改全局默认）。
  //   2026-10-21 挪到历史之前：assistant 历史消息要带 source{provider,model}（否则 pi-ai 第二轮就崩）。
  const def = resolveModel(ctx)
  const provider = (o.provider !== undefined && o.provider !== null && String(o.provider) !== '') ? String(o.provider) : def.provider
  const model = (o.model !== undefined && o.model !== null && String(o.model) !== '') ? String(o.model) : def.model
  if (!model) return { ok: false, error: '拿不到模型档位（当前会话没选模型，agentDefaultModel 也没配）' }
  // 2026-10-21 体检（m03962 P0）：这条通道原来完全绕过 ai-route.json 的分工表——
  //   面板传什么 provider 就用什么，用户「本地档已停用、一律走云端」的口径在这条路上没有代码保证。
  //   现在按分工表兜底：分工表说云端（enabled:false 或缺省）时，任何指向 local 的选择都被拒，
  //   并明确告诉面板怎么换（这不是禁用模型选择，只是不许绕过分工表把客户数据送到本机模型上）。
  const route = resolveAiRoute(ctx, 'sales-dock')
  if (String(provider) === 'local' && !route.local) {
    return { ok: false, error: '本机模型这条通道没开（ai-route.json 的分工表里 sales-dock 不是 local，本地档已停用）——请换成云端模型再发。' }
  }

  // 历史窗口（面板自己维护；这里只做形状归一，不信任客户端的字段）
  const msgs = []
  const hist = Array.isArray(o.messages) ? o.messages.slice(-MAX_HISTORY) : []
  for (const h of hist) {
    const role = (h && h.role === 'assistant') ? 'assistant' : 'user'
    const t = mask(String((h && h.text) || '').slice(0, MAX_TEXT))
    if (!t.trim()) continue
    msgs.push(mkMsg(role, [{ type: 'text', text: t }], { provider, model }))
  }
  msgs.push(mkMsg('user', content))
  // 2026-10-21 修（用户 m02562「对话框无法准确识别图片」）：先判这次选的模型吃不吃图。
  //   宿主的 pi-ai 适配器对纯文本模型会把图片**投影掉**（projectImagesForTextModel）→ 模型只能看到一段
  //   占位文字，于是「看图」永远答不准。与其让它瞎猜，不如当场说清：换一个带 image 的模型再发。
  if (up.imageCount > 0) {
    const mods = await modelModalities(llm, provider, model)
    if (mods && mods.indexOf('image') === -1) {
      const nv = noVisionReason(provider, model)
      return {
        ok: false,
        error: '当前模型 ' + provider + '/' + model + ' 不看图（只吃文字），图片发过去会被丢掉。'
          + (nv ? '\n（这条是实测出来的：' + nv + '）' : '')
          + '\n请在右上角模型下拉里换一个标了「🖼 看图」的模型再发（本轮文字和文件照常能发）。',
        attachments: { images: 0, files: up.fileNames, notes: up.notes, errors: up.errors, fileChars: attach.fileSectionsToText(up.fileSections).length },
        text: '',
        noImageModel: true,
        modalities: mods,
      }
    }
  }
  const timeoutMs = Math.max(10000, Number(d.timeoutMs || 180000))
  const info = await reasoningOf(llm, provider, model)
  const want = (o.reasoningEffort !== undefined && o.reasoningEffort !== null && String(o.reasoningEffort) !== '')
    ? String(o.reasoningEffort) : REASONING_FALLBACK
  const req = { provider, model, messages: msgs, system: DOCK_SYSTEM }
  if (info && info.supported) {
    req.reasoningEffort = info.ids.indexOf(want) !== -1
      ? want
      : (info.defaultEffort && info.ids.indexOf(String(info.defaultEffort)) !== -1 ? String(info.defaultEffort) : info.ids[0])
  }

  const started = Date.now()
  let answer = ''
  // 模型出口唯一：真正的 llm.stream 只在 ai.js（红线，probe-sales-ai 会扫源码）。这里只调 streamChat。
  const st = await streamChat(ctx, req, { timeoutMs, onDelta: d.onDelta, shouldStop: d.shouldStop })
  answer = st.text || ''
  if (!st.ok) {
    return { ok: false, error: st.error || '模型调用失败', text: answer, reusedFileChars: cacheUsedChars, attachments: uploadSummary(up, rawFileText.length) }
  }
  if (!String(answer).trim()) return { ok: false, error: '模型没返回正文（可能思考吃光了额度，重试一次）', text: answer, reusedFileChars: cacheUsedChars, attachments: uploadSummary(up, rawFileText.length) }
  // 回填真名后再抽确认卡：写真库时给的必须是真客户ID/真名，不是占位符
  const finalText = unmask(answer)
  // 2026-10-21 夜（协议 v2）：一次回答里可能同时有「正文 + 多个只读调用 + 1~2 张写卡 + 反问卡」，
  //   所以整包解析（parseBlocks），action 只保留第一张写卡（给 v1 调用方/探针用）。
  const blocks = parseBlocks(finalText)
  return {
    ok: true,
    text: String(finalText),
    provider,
    model,
    reasoningEffort: req.reasoningEffort,
    ms: Date.now() - started,
    action: blocks.writeCards.length ? blocks.writeCards[0] : null,   // v1 兼容
    blocks,                                                          // v2：{text,calls,writeCards,ask}
    stopped: !!st.stopped,
    // 2026-10-21（m04728）：模型自述的思考（脱敏后再给面板折叠展示；空就不给字段）
    ...(st.thinking ? { thinking: mask(String(st.thinking)).slice(0, 3000) } : {}),
    // 2026-10-21（m05130）：这一轮从缓存里复用了上一轮上传的文件正文（面板可显示「用了上次那张表」）
    reusedFileChars: cacheUsedChars,
    attachments: uploadSummary(up, rawFileText.length),
  }
}

function uploadSummary(up, fileChars) {
  return {
    images: up.imageCount,
    files: up.fileNames,
    notes: up.notes,
    errors: up.errors,
    fileChars: Number(fileChars || up.fileChars || 0),
  }
}

// 给测试/面板共用：「这个模型是不是实测不看图」
export { KNOWN_NO_VISION, noVisionReason }
