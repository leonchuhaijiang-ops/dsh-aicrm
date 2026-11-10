// 客户面脱敏（A′ 档）—— 2026-10-12 用户拍板「A，执行」
// ============================================================================
// 口径（写死在代码里，改口径先改这里 + 《销售数据标准》）：
//   A′ = **字段级脱敏**（档案里的 姓名/联系人、手机、公司、微信昵称）+ **角色/行业标签** + **输出回填**。
//   - 发模型前：把可识别身份的字面量换成占位符 <客户1|设计院总工>、<单位1|市政交通>、<电话1>、<微信1>；
//   - 占位符**带标签**：标签是"干什么的"（角色/行业/规模/等级/阶段），不是"是谁"——
//     完全裸的 <客户1> 会让模型写不出"孙工""王院长"这类得体称呼、也丢了行业语域（用户 m01110 问的就是这个）。
//   - 模型回来后：unmask() 把占位符换回真值，用户看到的永远是真人真名。
//   - **遮不住的地方（如实声明，不假装干净）**：通话转写等自由文本里客户自述的姓名/公司。
//     这里只做"字面量替换 + 手机号正则"，不做任何语义猜测——猜错比不遮更坏。
//
// 纯函数、零依赖、不读盘、不出网：可单测（selftest 有往返断言；探针看 stats）。
// ============================================================================

// 手机号：中国大陆 11 位（1 开头、第二位 3-9）。自由文本里出现的一律脱敏（身份信息）。
const PHONE_RE = /\b1[3-9]\d{9}\b/g
// 占位符回填：容忍模型把标签丢了或加了空格（`<客户1>` / `<客户 1 | 设计院总工>`）
const TOKEN_RE = /<\s*(客户|单位|电话|微信)\s*(\d+)\s*(?:\|[^>]*)?>/g
// 裸占位符（模型常常把尖括号吃掉，写成「客户1您好」）——只在回填阶段兜底；
//   负向先行断言防误伤正文（"电话1小时前" 不许被换成手机号）。
const BARE_RE = /(客户|单位|电话|微信)\s*(\d+)(?![年月日时分秒个号人条次])/g

// 行业类别：从公司名**派生类别**（不是留名字）。
//   为什么允许：公司名里的"设计院/研究院/咨询/评估"是行业语域，模型靠它才说对话；
//   我们只交出类别词，不交出可识别名称。
const INDUSTRY_HINTS = [
  [/设计院|设计集团|勘察设计|规划设计|设计研究/, '设计院'],
  [/研究院|研究所/, '研究院'],
  [/咨询/, '咨询公司'],
  [/评估/, '评估机构'],
  [/园林|绿化|景观/, '园林景观'],
  [/市政|交通/, '市政交通'],
  [/工程/, '工程公司'],
  [/科技|信息|软件|数据/, '科技公司'],
  [/集团/, '集团'],
]
export function guessIndustry(company) {
  const s = String(company == null ? '' : company)
  if (!s) return ''
  for (const [re, name] of INDUSTRY_HINTS) if (re.test(s)) return name
  return ''
}

// 规模提示：只在能确定的地方给（"约300人"/"15人写报告"这类原话里的数字），拿不到就不给。
export function guessSize(text) {
  const m = /(?:约|近|大概|差不多)?\s*(\d{1,4})\s*(?:多)?\s*人/.exec(String(text == null ? '' : text))
  return m ? ('约' + m[1] + '人') : ''
}

// 公司简称：自由文本里常写简称（"已通知客户(星桥智造李维)"里的"星桥智造"），全称遮不住它。
//   规则：去掉括号注释 → 去掉法人后缀 → 再去掉行业词尾，剩下的长度 ≥4 才当简称用（太短会误伤普通词）。
export function shortOrg(company) {
  const full = String(company == null ? '' : company).trim()
  if (full.length < 5) return ''
  let s = full.replace(/[（(【\[][^）)】\]]*[)）】\]]/g, '')
  s = s.replace(/(股份有限公司|有限责任公司|有限公司|公司|集团|研究院|设计院|事务所|中心|大学|学院|厂|局)$/g, '')
  s = s.replace(/(科技|咨询|工程|评估|设计|建设|运营|管理|服务|实业|发展|投资|信息|技术)$/g, '')
  s = s.trim()
  return (s.length >= 4 && s.length < full.length) ? s : ''
}

// 标签拼装：角色/行业/规模/等级/阶段 —— 全是我们自己档案里的类别字段，最多取 2 段
export function buildTag(o) {
  const parts = []
  const push = (v) => { const s = String(v == null ? '' : v).trim(); if (s && parts.indexOf(s) < 0) parts.push(s) }
  if (o) {
    push(o.role)
    if (o.industry && o.size) push(o.industry + '·' + o.size)
    else { push(o.industry); push(o.size) }
    push(o.level ? (o.level + '级') : '')
    push(o.stage)
  }
  return parts.slice(0, 2).join('·').slice(0, 40)
}

// 2026-10-12 批次 2 真数据审读抓到的漏点：**引擎自己的话术里带的联系人真名**（"王老师您好…"）。
//   这类真名只出现在**自由文本**里（brief 每条的 how、作战卡的开口参考），不在任何"姓名/联系人"字段上，
//   所以按 key 登记的 autoMask 抓不到它 → 一个字面量漏出去，提示词里就写着客户真名。
//   这里按"称呼长相"补一道：句首/标点后的「1–3 个汉字 + 称谓」，且后面紧接 您/好/逗号句末。
//   为什么加边界与后缀：不加就会把"客户总共 3 人""项目总监"这类普通词当人名遮掉（把正文打成筛子）。
//   ⚠️ 2026-10-12 批次 3 抓到的坑：事实是 `JSON.stringify` 之后才过 mask 的，**换行在文本里是 `\n` 两个字符**
//   （反斜杠+n）。原来只认"空白/换行/标点"做前导 → "——…——\n陈默您好" 里的 陈默 **前导是字母 n**，两趟自动登记
//   全落空，客户真名就跟着规则版草稿进了提示词（实测 701 陈默）。所以前导额外放行 JSON 转义序列 `\X`。
const CALL_RE = /(^|[\s，。；：、！？\n（(【「『—-]|\\[a-zA-Z"\\/])([\u4e00-\u9fa5]{1,3}(?:老师|总|经理|主任|院长|所长|女士|先生))(?=您|好|，|,|。|！|!|？|\?|\s|$)/g
// 同一类漏点的第二种长相：**全名 + 您好**（"李维您好…"）——引擎自己拼的话术里最常见的开场，
//   没有称谓后缀，CALL_RE 抓不到。这里按"2–4 个汉字 + 您好"学，并挡掉"客户您好"这类通用招呼词
//   （否则会把"客户"两个字当人名全遮掉，正文直接废）。
//   ⚠️ 汉字类里**先挖掉 您/你**（\u60A8 / \u4F60）：不挖的话贪婪的 {2,4} 会把"客户您"整个当名字
//   （探针实测："客户您好" → "<客户1>好"），挖掉后"客户您好"只认到"客户"、再被 GREET_STOP 挡下。
const GREET_RE = /(^|[\s，。；：、！？\n（(【「『—-]|\\[a-zA-Z"\\/])([\u4e00-\u4f5f\u4f61-\u60a7\u60a9-\u9fa5]{2,4})(?=您好|好[，,])/g
const GREET_STOP = /^(客户|您好|大家|各位|亲|老板|我们|你们|您们|你好|贵司)$/

// 一个 masker = 一次请求（一次模型调用）的映射表；**同一次请求内 id 稳定**（模型才分得清谁是谁）
export function createMasker() {
  const kinds = { 客户: [], 单位: [], 电话: [], 微信: [] }   // 每类各自编号：<客户1> <单位1> <电话1> <微信1>

  function add(kind, real, tag) {
    const r = String(real == null ? '' : real).trim()
    const min = kind === '电话' ? 7 : (kind === '单位' ? 4 : 2)   // 单字人名/短名一律不遮，避免把正文打成筛子
    if (r.length < min) return null
    const list = kinds[kind]
    const hit = list.find((x) => x.real === r)
    if (hit) return hit
    const item = { id: list.length + 1, real: r, tag: String(tag || '').trim() }
    list.push(item)
    return item
  }
  const tok = (kind, it) => (kind === '电话' || kind === '微信' || !it.tag)
    ? ('<' + kind + it.id + '>')
    : ('<' + kind + it.id + '|' + it.tag + '>')

  return {
    addPerson: (real, tag) => add('客户', real, tag),
    addOrg: (real, tag) => add('单位', real, tag),
    addPhone: (real) => add('电话', String(real == null ? '' : real).replace(/\D/g, '')),
    addWechat: (real) => add('微信', real),
    get stats() { return { 客户: kinds.客户.length, 单位: kinds.单位.length, 电话: kinds.电话.length, 微信: kinds.微信.length } },
    dump() { return Object.keys(kinds).reduce((acc, k) => { acc[k] = kinds[k].map((x) => ({ id: x.id, tag: x.tag })); return acc }, {}) },

    // 遮：① 已知字面量（长串优先）② 自由文本里剩下的手机号（自动登记）
    mask(text) {
      if (text == null) return ''
      const pairs = []
      for (const kind of ['客户', '单位', '电话', '微信']) for (const it of kinds[kind]) pairs.push([it.real, tok(kind, it)])
      pairs.sort((a, b) => b[0].length - a[0].length)
      let out = String(text)
      // 2026-10-22（用户 m01260 排查抓到）：原来这里是「排序后 split/join 顺序替换」，
      //   前一步插进去的占位符（如 <单位8|咨询公司> 里的「咨询公司」）会被后一步的字面量**再遮一次**，
      //   变成 <单位8|<单位14|咨询公司>> —— 模型看到的是双层乱码，检索自然只能靠猜。
      //   改成一趟正则替换：每个真值只扫原文一次，替换出来的占位符不会被二次处理。
      if (pairs.length) {
        const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const map = new Map(pairs.map(([real, t]) => [real, t]))
        out = out.replace(new RegExp(pairs.map(([real]) => esc(real)).join('|'), 'g'), (m) => (map.has(m) ? map.get(m) : m))
      }
      // 未知手机号：自动登记后替换（同一次请求内 id 稳定）
      out = out.replace(PHONE_RE, (m) => { const it = add('电话', m); return it ? tok('电话', it) : m })
      // 自由文本里的称呼真名（"王老师您好" → "<客户3>您好"）：自动登记，本句与后续文本一起遮住
      out = out.replace(CALL_RE, (full, lead, who) => { const it = add('客户', who); return it ? (lead + tok('客户', it)) : full })
      // 自由文本里的「全名+您好」（"李维您好"）：同上，但挡掉通用招呼词
      out = out.replace(GREET_RE, (full, lead, who) => {
        if (GREET_STOP.test(who)) return full
        const it = add('客户', who)
        return it ? (lead + tok('客户', it)) : full
      })
      return out
    },

    // 回填：占位符（带/不带尖括号）→ 真值。模型把标签改写了也不影响。
    unmask(text) {
      if (text == null) return ''
      const back = (kind, num, fallback) => {
        const it = kinds[kind][Number(num) - 1]
        return it ? it.real : fallback
      }
      let out = String(text).replace(TOKEN_RE, (m, kind, num) => back(kind, num, m))
      out = out.replace(BARE_RE, (m, kind, num) => back(kind, num, m))
      return out
    },
  }
}

// 长得像公司/单位（不是人名）——按长相分流，避免把公司名塞进"客户"占位符
export function looksLikeOrg(s) {
  return /公司|院|中心|所|集团|厂|局|银行|学校|平台$/.test(String(s == null ? '' : s).trim())
}

// 2026-10-12 批次 2：**通用自动登记**——把引擎返回的整棵事实对象里的身份字段塞进 masker。
//   为什么需要它：作战卡/每日工作台/周复盘的事实是引擎拼的大对象（姓名、公司散在各层，
//   还有 firstThree 这种嵌套数组），逐个手写 addXxx 一定会漏 → 漏一个就漏一次客户名。
//   规则：按 **key 名**判类型（姓名/联系人/name → 客户；公司/单位 → 单位；手机/电话 → 电话；微信 → 微信），
//   其余字符串原样过一遍 mask()（顺带把里面出现的手机号自动登记）。
//   注意：**自由文本里的姓名/公司遮不住**（本就不做语义猜测）——这条口子在 CHANGELOG 里如实声明。
export function autoMask(mk, value, depth, seen) {
  if (!mk || value == null) return mk
  if ((depth || 0) > 6) return mk
  if (typeof value === 'string') { mk.mask(value); return mk }
  if (typeof value !== 'object') return mk
  if (Array.isArray(value)) {
    for (const v of value) autoMask(mk, v, (depth || 0) + 1, seen)
    return mk
  }
  if (!seen) seen = new WeakSet()
  if (seen.has(value)) return mk
  seen.add(value)
  for (const k of Object.keys(value)) {
    const v = value[k]
    const key = String(k)
    if (typeof v === 'string') {
      const s = v.trim()
      if (!s) continue
      if (/姓名|联系人|name|名称/.test(key) || key === '客户') {
        if (s.length >= 2) (looksLikeOrg(s) ? mk.addOrg(s, buildTag({ industry: guessIndustry(s) })) : mk.addPerson(s, ''))
      } else if (/公司|单位/.test(key)) {
        if (s.length >= 4) mk.addOrg(s, buildTag({ industry: guessIndustry(s) }))
      } else if (/手机|电话|phone|mobile/i.test(key)) {
        mk.addPhone(s)
      } else if (/微信|wechat/i.test(key)) {
        mk.addWechat(s)
      } else {
        mk.mask(s)                     // 其它文本：至少把里面的手机号登进来
      }
    } else {
      autoMask(mk, v, (depth || 0) + 1, seen)
    }
  }
  return mk
}
