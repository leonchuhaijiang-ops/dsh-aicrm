// 📇AICRM客资管理 - Client 端（正式插件版 dsh-sales；成品名与 dsh-flow / dsh-growth 同系列，见 插件系列-UI规范.md）
// 2 个槽位: 侧边栏底部入口(sidebar.footer.action, id=sales-panel) +
//   全屏看板(shell.overlay, id=sales-board)，用 window CustomEvent 桥接开关。
//   2026-09-29 用户定：**聊天框上方的信息提示条不用**（conversation.input.dock 已撤，别再恢复）。
//   侧边栏入口 order=60，位于可研报告工作台(order=80)上方。
// 数据通路: fetch('/sales/'+method) -> Host webServer 前缀路由 -> shell.run(node sales-lib.js run)
// 手写 lazy-CJS bundle 协议 (window.__ModuleLoader__.load)，无构建步骤。
window.__ModuleLoader__.load({
  id: 'dsh-sales',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    // === 插件系列视觉常量（dsh-flow / dsh-sales / dsh-growth 三处逐字相同）===
    var SERIES_GLYPH = '📇';
    var PLUGIN_LABEL = SERIES_GLYPH + 'AICRM客资管理';
    var SERIES_STYLE = {
      GLYPH: SERIES_GLYPH,
      ACCENT: '#2563eb', ACCENT_DARK: '#60a5fa',
      DANGER: '#dc2626', OK: '#16a34a', WARN: '#d97706',
      R_PANEL: 10, R_CTRL: 6, R_BADGE: 8,
      FONT: 'system-ui, "Microsoft YaHei", sans-serif',
      BAR_PAD: '8px 12px', BAR_GAP: 8,
      TAB_PAD: '6px 10px', TAB_GAP: 6,
      CTRL_PAD: '4px 10px', CTRL_FONT: 12, TITLE_FONT: 14
    };

    // === 侧边栏入口排布（2026-10-15 用户："插件面板入口上下排布，叠放。"；UI规范 §9）===
    // 宿主取证（app.asar / dsh-client-ui-renderer，源码原文见 UI规范 §9.0）：
    //   · `sidebar.footer.action` 是 list 槽，渲染进 `[class*="footerActions"]`（宿主该元素 display:flex，
    //     且**不换行**）——所以入口一多只能并排，挤不下就被压成竖排文字。
    //   · 槽锚点是 `<div data-slot="sidebar.footer.action" style="display:contents">`：宿主注释原文
    //     `display:contents keeps the wrapper out of layout`，即锚点不生成盒子、不参与布局；
    //     条目经 SlotErrorBoundary（`render()` 只 `return this.props.children`，无 DOM 包装）→
    //     条目根元素**直接就是** footerActions 的 flex item（宿主**没有**给条目套外层 wrapper）。
    //   · 因此第 2 条规则命中的是那个 display:contents 锚点（display:contents 不生成盒子，设 flex 无效），
    //     真正生效的是第 3 条（DOM 树上的锚点子元素 = 视觉上的 flex item）。第 2 条留着当兜底：
    //     宿主要是哪天改成真盒子包装，它照样生效。
    // 三条规则纯加法、不覆盖宿主规则；宿主若改了类名子串，效果退回横排，不会坏（UI规范 §9 风险）。
    var SERIES_LAYOUT_CSS =
      '[class*="footerActions"]{flex-wrap:wrap;row-gap:2px}'
      + '[class*="footerActions"]>*{flex:0 0 100%;min-width:0}'
      + '[class*="footerActions"] [data-slot]>*{flex:0 0 100%;min-width:0;max-width:100%}';
    // 名称（不含图样）：PLUGIN_LABEL = SERIES_GLYPH + 名称（UI规范 §1：格式一律「图样+代码+名称」）
    var SERIES_ENTRY_TEXT = PLUGIN_LABEL.slice(SERIES_GLYPH.length);
    // 入口根元素样式（三处逐字相同，四个入口共用；UI规范 §9.2 + §9.5）：独占一行 + 单行省略号 + **四件同字级**
    var SERIES_ENTRY_STYLE = {
      display: 'flex', alignItems: 'center', justifyContent: 'flex-start', gap: 8,
      flex: '0 0 100%', width: '100%', minWidth: 0, boxSizing: 'border-box',
      padding: '8px 12px', borderRadius: 6, border: '1px solid transparent',
      fontSize: 13, fontWeight: 600, lineHeight: '18px',
      fontFamily: SERIES_STYLE.FONT, textAlign: 'left',
      background: 'transparent', color: 'inherit', cursor: 'pointer', userSelect: 'none',
      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
    };
    // 图样盒（三处逐字相同；UI规范 §9.5）：固定 18px 宽、居中、不伸缩。
    //   图样**不再单独放大**——旧代码给图样写 fontSize 16，比 GR 大一号，正是用户说的"字体大小样式都不一样"
    var SERIES_GLYPH_STYLE = { width: 18, textAlign: 'center', flex: 'none' };
    // 活动态（面板打开中 / 通话进行中）：系列强调色描边 + 一档淡底
    //   非活动态就是上面的 `1px solid transparent`（描边宽度不跳，行高/行宽一律齐）
    function seriesEntryActiveStyle(dark) {
      var a = dark ? SERIES_STYLE.ACCENT_DARK : SERIES_STYLE.ACCENT;
      return { border: '1px solid ' + a, background: a + '22' };
    }
    var seriesLayoutInjected = false;
    function injectSeriesLayout() {
      if (seriesLayoutInjected) return;
      try {
        if (typeof document === 'undefined' || !document || typeof document.createElement !== 'function') return;
        if (document.getElementById && document.getElementById('dsh-series-layout')) { seriesLayoutInjected = true; return }
        if (document.querySelector && document.querySelector('style#dsh-series-layout')) { seriesLayoutInjected = true; return }
        var st = document.createElement('style');
        st.id = 'dsh-series-layout';
        st.textContent = SERIES_LAYOUT_CSS;
        var host = document.head || document.body;
        if (host && typeof host.appendChild === 'function') { host.appendChild(st); seriesLayoutInjected = true }
      } catch (e) {
        try { console.error('[dsh-sales] 入口排布样式注入失败：' + String(e && e.message || e)) } catch (e2) { /* 忽略 */ }
      }
    }

    // ===== 2026-10-08 事故定案（面板「点了一点反应都没有」的根因，别再犯）=====
    // 1) 宿主渲染器对「槽位条目内抛出的错误」会 reportEntryError 并**弃用(abdicate)该条目**
    //    （`@deepseek-ai/dsh-client-ui-renderer/lib/client.js:790` host.reportEntryError(slotKey, entry, error,
    //     { abdicate: spec.kind !== 'chain' })），React 随即卸载整棵子树 → 用户什么也看不到。
    // 2) 我们自己的 BoardErrorBoundary 挂在 BoardInner 的**子树里**，接不到 BoardInner 自身 useEffect 抛的错
    //    （React 只会从抛错组件往上找祖先边界）→ 每个 effect 必须自己兜住。
    // 3) 真正触发事故的是 `ctx.interval()`：它内部要 `ctx.get('timer')`，而 exports.inject 里漏了 'timer'
    //    → 抛 `cannot get property "timer" without inject`（见文件末尾 exports.inject 的注释）。
    function safeEffect(name, fn) {
      try { return fn() } catch (e) {
        // 只记 console，**绝不往上抛**：宁可这一项功能不生效，也不能让整块看板被宿主弃用
        try { console.error('[sales-board effect:' + name + '] ' + ((e && e.message) || e), e) } catch (_) {}
        return undefined
      }
    }

// 错误边界(2026-09-07): 捕获销售看板渲染错误，显示在面板上而非整个崩掉，便于定位
class BoardErrorBoundary extends React.Component {
  constructor(props){ super(props); this.state={err:null} }
  static getDerivedStateFromError(e){ return {err:e} }
  componentDidCatch(e, info){
    // 2026-10-08 事故：这里的错误**绝不能再往上抛** —— 宿主会把整条贡献 abdicate 掉（整块看板消失，只留空 div）
    try{ console.error('[sales-board error] ' + (e&&e.message||e)) }catch(_){}
  }
  render(){
    if(this.state.err){
      // 2026-10-08：槽位容器可能没尺寸（我们的根节点本来是 position:fixed 撑开的），
      //   所以出错文本也必须自己 fixed 定位，否则同样是「看不见」。
      return React.createElement('div', { style:{ position:'fixed', left:12, top:64, zIndex:2147483599, maxWidth:760, background:'#1b1d22', border:'1px solid #c92a2a', borderRadius:8, padding:16, color:'#ff8787', fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize:12, whiteSpace:'pre-wrap', wordBreak:'break-all' } },
        '[销售看板出错] ' + String((this.state.err && this.state.err.message) || this.state.err))
    }
    return this.props.children
  }
}

// 2026-10-15 合同台账页：把本机读回的 base64 落成文件（浏览器侧下载）。
//   为什么走 base64 而不是给个链接：文件在 合同/ 下（DSH 没有静态文件服务），
//   数据也只能在本机落地——base64 由插件在本机读出来（/sales/contract action=file+下载），不经过任何外网。
function downloadBase64(name, b64, mime) {
  try {
    const bin = window.atob(String(b64 || ''))
    const arr = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
    const blob = new Blob([arr], { type: String(mime || 'application/octet-stream') })
    const url = window.URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = String(name || 'contract.docx')
    a.style.display = 'none'
    document.body.appendChild(a)
    a.click()
    window.setTimeout(() => { try { a.remove(); window.URL.revokeObjectURL(url) } catch (e) {} }, 1500)
    return true
  } catch (e) {
    try { console.error('[sales-board downloadBase64] ' + ((e && e.message) || e), e) } catch (_) {}
    return false
  }
}

function apply(ctx) {
    injectSeriesLayout()
    const slots = ctx.get('slots')
    if (slots === undefined) return
    const { useState, useEffect, useCallback } = React

    function openBoard() { window.dispatchEvent(new CustomEvent('sales:open-board')) }
    function closeBoard() { window.dispatchEvent(new CustomEvent('sales:close-board')) }

    // ===== 2026-09-29 桌面端修复：「按钮看得见、点不着」 =====
    // 根因（实测定案，别再猜）：
    //   Windows 下 layout 会给 frame 加 `padding-top: --dsh-windows-titlebar-height`，
    //   并在那条空白上盖一个 `.frame:before{ -webkit-app-region: drag }`。
    //   **普通流内页面**会被 padding 顶到标题栏下面；但 `shell.overlay` 层是
    //   `position:absolute; inset:0`，它的包含块是 frame 的 **padding box（含 padding）**
    //   → 覆盖层从 y=0 起，正好压在拖动条里。而 Electron 把 `app-region: drag` 区域
    //   当 **OS 非客户区**，盖在上面的页面元素一律收不到点击（与 z-index 无关）。
    //   看板根节点是 `position:fixed; inset:0` → 标题栏（🪟悬浮/✕/页签…）整条点不动。
    //   证据：F12 截图里能看到应用菜单栏「应用 编辑 …」叠在看板标题上。
    // 对策①：整体下移一个 `--dsh-frame-top-clearance`（layout 自己就定义了这个变量，
    //   桌面端 = 标题栏高，macOS = 48px；网页端没有这个变量 → 0，行为与从前一致）。
    // 对策②：自己声明 `-webkit-app-region: no-drag`，万一变量取不到也不会再失灵。
    function frameClearance() {
      try {
        const cs = getComputedStyle(document.documentElement)
        const n = parseFloat(String(cs.getPropertyValue('--dsh-frame-top-clearance') || '').trim())
        if (Number.isFinite(n) && n > 0) return n
        const n2 = parseFloat(String(cs.getPropertyValue('--dsh-windows-titlebar-height') || '').trim())
        return Number.isFinite(n2) && n2 > 0 ? n2 : 0
      } catch (e) { return 0 }
    }
    const CLEARANCE = frameClearance()
    const NO_DRAG = { pointerEvents: 'auto', WebkitAppRegion: 'no-drag' }
    // 2026-10-15 合同页：模板必填清单缓存（**不是 state** —— 点「查模板」时写入，同时 setContractMsg 触发重渲染；
    //   不新增 useState 是为了不打乱探针记录的 hook 序号）
    let contractTplCache = null

    async function fetchData(method, args, opts) {
      try {
        // 去掉 'sales.' 前缀: sales.overview -> /sales/overview
        const path = String(method).replace(/^sales\./, '')
        // 2026-10-21 体检（m03962 P1）：原来没有超时 —— 宿主卡住/网关不回时按钮永远转圈，爹只能重启插件。
        //   默认 300s（AI 问答要留足），普通页面调用给 60s。AbortController 是浏览器原生，不引入依赖。
        const timeoutMs = Number((opts && opts.timeoutMs) || 0) || (path === 'assistant' ? 300000 : 60000)
        const ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null
        const timer = ctl ? setTimeout(function () { try { ctl.abort() } catch (e) {} }, timeoutMs) : null
        let resp
        try {
          resp = await fetch('/sales/' + path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(args || {}),
            signal: ctl ? ctl.signal : undefined,
          })
        } finally { if (timer) clearTimeout(timer) }
        // 2026-09-14 加固: 必须校验 HTTP 状态。宿主重启/未加载时返回的是 SPA 的 HTML，
        //   原来直接 .json() 会抛 "Unexpected token <"，用户只看到一句莫名其妙的 RPC 异常。
        if (!resp.ok) {
          if (resp.status === 413) return { ok: false, error: '附件总量超过服务端上限（HTTP 413）：图片合计 ≤8MB、文件每个 ≤8MB、单次合计 ≤32MB' }
          if (resp.status === 401 || resp.status === 403) return { ok: false, error: '服务拒绝（HTTP ' + resp.status + '）：宿主可能正在重启，或该动作需要确认' }
          return { ok: false, error: '服务返回 HTTP ' + resp.status + '（看板数据未加载，宿主可能正在重启）' }
        }
        const body = await resp.json()
        // 2026-11-10 开源化：任何端点回 code==='UNCONFIGURED'（还没设数据目录）→ 广播一声，
        //   看板收到后立刻切到「首次设置」向导。这里只广播，不改调用方语义（调用方照旧拿 {ok:false,error,code} 显示错误）。
        if (body && body.ok === false && body.code === 'UNCONFIGURED') {
          try { window.dispatchEvent(new CustomEvent('sales:needs-setup')) } catch (e) {}
        }
        if (body && body.ok === false) return { ok: false, error: body.error || body.message || '服务端返回失败', code: body.code || '' }
        if (body && body.ok !== true && body.ok !== undefined) return body
        return body
      } catch (e) {
        const msg = String((e && e.message) || e)
        if (/abort/i.test(msg) || (e && e.name === 'AbortError')) return { ok: false, error: '请求超时（宿主可能卡住或正在重启，稍后重试）' }
        return { ok: false, error: 'RPC异常: ' + msg }
      }
    }

    // ========== 槽位1: 侧边栏底部入口 ==========
    // 2026-10-09 事故加固：**注册本身也要包在 safeEffect 里**。宿主槽位有 single/keyed/list/chain
    //   四种规则，任何一条不合（槽未声明 / single 槽被占 / keyed 缺 key）register 就会抛；
    //   抛出去 = 本插件 entry 的 fiber=FAILED → 渲染层 `web boot: N entries did not activate`
    //   → 宿主 reportFatal → **桌面端启动即崩**。宁可"入口不出现"，也绝不让宿主崩。
    safeEffect('slot-sidebar', () => slots.inject('sidebar.footer.action', () => slots.register(
      { name: 'sidebar.footer.action', id: 'sales-panel', order: 60, label: PLUGIN_LABEL },
      (props) => {
        // 折叠态（宿主把 wide 当 prop 传进来）只显示图样；展开态 = 图样盒（固定 18px）+ 名称
        //   UI规范 §1 图样 / §9.5 四件同字级 / §9.6 折叠态
        // 活动态：看板开合状态在浮层组件内部（React.useState + 监听 sales:open-board），入口拿不到；
        //   按红线不新增 state / hook 顺序，入口常驻非活动态（`1px solid transparent`，与另三件行高一致）
        const wide = !(props && props.wide === false)
        return React.createElement('div', {
          onClick: () => openBoard(),
          title: '打开 ' + PLUGIN_LABEL + '（今日任务 / 汇总统计 / 客户查询 / 跟进提示）',
          style: SERIES_ENTRY_STYLE,
        },
          React.createElement('span', { key: 'g', style: SERIES_GLYPH_STYLE }, SERIES_GLYPH),
          wide ? React.createElement('span', { key: 't', style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, SERIES_ENTRY_TEXT) : null)
      },
    )))

    // ========== 槽位2: 输入框上方总览条 ==========
    // 2026-09-29 用户定：**不要**（原话"聊天框上部的信息提示条也不用"）。
    //   别再加回来——要看今日队列就点侧边栏/看板，别占聊天框上方。

    // ========== 槽位3: 全屏看板 (shell.overlay) ==========
    safeEffect('slot-board', () => slots.inject('shell.overlay', () => slots.register(
      { name: 'shell.overlay', id: 'sales-board', order: 10, label: PLUGIN_LABEL },
      () => {
        // 渲染异常**不要往外抛**（2026-10-08 事故）：抛出去会被宿主 reportEntryError(..., {abdicate:true})
        //   弃用整条贡献、React 卸载整棵子树 → 面板「一点反应都没有」。这里自己渲染一块 fixed 的错误牌，
        //   至少让用户看到错误原文；正常路径下这段 try/catch 一次也不会进。
        try {
          return BoardInner()
        } catch (e) {
          try { console.error('[sales-board render] ' + ((e && e.message) || e), e) } catch (_) {}
          return React.createElement('div', { style: { position: 'fixed', left: 12, top: 64, zIndex: 2147483599, maxWidth: 760, background: '#1b1d22', border: '1px solid #c92a2a', borderRadius: 8, padding: 16, color: '#ff8787', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' } },
            '[销售看板渲染失败] ' + String((e && e.message) || e))
        }
        function BoardInner() {
        const [open, setOpen] = useState(false)
        const [tab, setTab] = useState('tasks')
        const [tasks, setTasks] = useState(null)
        const [summary, setSummary] = useState(null)
        const [firstcall, setFirstcall] = useState(null)
        // 重点跟进 / 挂起冷备 共用同一份列表 state（两页不会同时显示；也避免新增 useState 打乱探针的 hook 序号）
        const [listPage, setListPage] = useState(null)
        const [searchKw, setSearchKw] = useState('')
        const [searchRes, setSearchRes] = useState(null)
        const [guideKw, setGuideKw] = useState('')
        const [guideRes, setGuideRes] = useState(null)
        const [guideFull, setGuideFull] = useState(null)
        const [tipId, setTipId] = useState(null)
        const [tipData, setTipData] = useState(null)
        const [sopId, setSopId] = useState(null)
        const [sopData, setSopData] = useState(null)
        const [loading, setLoading] = useState(false)
        const [err, setErr] = useState(null)

        // ========== 悬浮模式: 全屏遮罩 <-> 可拖动浮窗, 状态与位置记忆在 localStorage ==========
        const [float, setFloat] = useState(() => { try { return localStorage.getItem('sales-board-float') === '1' } catch (e) { return false } })
        const [pos, setPos] = useState(() => {
          try {
            const p = JSON.parse(localStorage.getItem('sales-board-pos') || 'null')
            if (p && typeof p.x === 'number' && typeof p.y === 'number') return p
          } catch (e) {}
          const vw = window.innerWidth, w = Math.min(720, vw - 40)
          return { x: Math.max(12, vw - w - 24), y: 90 }
        })
        const dragRef = React.useRef(null)
        useEffect(() => { try { localStorage.setItem('sales-board-float', float ? '1' : '0') } catch (e) {} }, [float])
        useEffect(() => { try { localStorage.setItem('sales-board-pos', JSON.stringify(pos)) } catch (e) {} }, [pos])
        // 浮窗尺寸: 默认 720 x 62vh, 右下角手柄拖拽调节, 尺寸记忆在 localStorage
        const [size, setSize] = useState(() => {
          try {
            const s = JSON.parse(localStorage.getItem('sales-board-size') || 'null')
            if (s && typeof s.w === 'number' && typeof s.h === 'number') return s
          } catch (e) {}
          const vw = window.innerWidth || 1280, vh = window.innerHeight || 800
          return { w: Math.min(720, vw - 40), h: Math.round(vh * 0.62) }
        })
        useEffect(() => { try { localStorage.setItem('sales-board-size', JSON.stringify(size)) } catch (e) {} }, [size])
        const resizeRef = React.useRef(null)
        // 深色/浅色/护眼 三档主题: 默认深色, 记忆在 localStorage
        //   2026-10-09 用户要求「sale 工作台也加护眼」：护眼=浅绿纸底 + 深绿字 + 蓝强调，
        //   与通话记录台 LV_THEMES.eye 同一套值（久看不累，不改任何业务语义）
        const [theme, setTheme] = useState(() => {
          try { const t = localStorage.getItem('sales-board-theme'); return t === 'light' || t === 'eye' ? t : 'dark' } catch (e) { return 'dark' }
        })
        useEffect(() => { try { localStorage.setItem('sales-board-theme', theme) } catch (e) {} }, [theme])
        // 主题调色板（2026-09-29 令牌化：**语义色一律走这里**，不许再硬编码 hex——
        //   事故：行动行硬编码 #ffd700 → 浅色主题白底黄字，看不见）
        // 科技简约口径：低饱和中性底 + 单一强调蓝；红/橙/绿只在"危险/警告/成功"语义上用，且三档主题都保证对比度
        //   三档的键必须完全一致（2026-10-09 加 eye 时逐键对齐 light 的键全集）
        const THEME = theme === 'eye'
          ? {
            bg: 'rgba(231,240,226,.98)', bgFull: 'rgba(226,236,220,.97)',
            text1: '#1f2a17', text2: '#4c5a42', text3: '#6b7a60',
            border: 'rgba(31,42,23,.16)', borderStrong: 'rgba(31,42,23,.28)',
            rowBg: 'rgba(31,42,23,.05)', rowBgOd: 'rgba(176,37,37,.08)',
            accent: '#2b6cb0', accentBg: 'rgba(43,108,176,.08)', accentBd: 'rgba(43,108,176,.32)', accentTint: 'rgba(43,108,176,.16)',   // 护眼档保持原值：selftest 锁「与通话记录台同一套值」，不并进系列强调色
            gold: '#7a5c00', ok: '#2f7d32', okBg: 'rgba(47,125,50,.10)', warn: '#8a5a00', warnBg: 'rgba(138,90,0,.10)',
            danger: '#b02525', dangerBg: 'rgba(176,37,37,.08)', phone: '#22577a',
            btnFg: '#1f2a17',
            tagColor: '#2f7d32', chipBg: 'rgba(31,42,23,.05)',
          }
          : theme === 'light'
          ? {
            bg: 'rgba(250,251,252,.98)', bgFull: 'rgba(245,247,249,.97)',
            text1: '#12161c', text2: '#5b6472', text3: '#8b95a3',
            border: 'rgba(16,22,32,.12)', borderStrong: 'rgba(16,22,32,.20)',
            rowBg: 'rgba(16,22,32,.035)', rowBgOd: 'rgba(201,42,42,.07)',
            accent: '#2563eb', accentBg: 'rgba(37,99,235,.07)', accentBd: 'rgba(37,99,235,.28)', accentTint: 'rgba(37,99,235,.15)',
            gold: '#9a6700', ok: '#2b8a3e', okBg: 'rgba(43,138,62,.08)', warn: '#a15c00', warnBg: 'rgba(161,92,0,.08)',
            danger: '#c92a2a', dangerBg: 'rgba(201,42,42,.07)', phone: '#1864ab',
            btnFg: '#12161c',
            tagColor: '#2b8a3e', chipBg: 'rgba(16,22,32,.04)',
          }
          : {
            bg: 'rgba(13,15,20,.98)', bgFull: 'rgba(9,11,15,.96)',
            text1: 'var(--text-1, #e6eaf0)', text2: 'var(--text-2, #8b95a3)', text3: 'var(--text-3, #6b7280)',
            border: 'var(--border-weak, rgba(255,255,255,.10))', borderStrong: 'rgba(255,255,255,.18)',
            rowBg: 'rgba(255,255,255,.035)', rowBgOd: 'rgba(255,107,107,.07)',
            accent: '#60a5fa', accentBg: 'rgba(96,165,250,.10)', accentBd: 'rgba(96,165,250,.30)', accentTint: 'rgba(96,165,250,.20)',
            gold: '#ffc078', ok: '#69db7c', okBg: 'rgba(105,219,124,.10)', warn: '#ffc078', warnBg: 'rgba(255,192,120,.10)',
            danger: '#ff8787', dangerBg: 'rgba(255,135,135,.10)', phone: '#74c0fc',
            btnFg: '#e6eaf0',
            tagColor: '#69db7c', chipBg: 'rgba(255,255,255,.05)',
          }
        THEME.blue = THEME.accent   // 兼容既有引用（blue 曾是强调色别名）
        // 企业级 6 段（2026-10-08 双轨 SOP 延伸）：配色单独走金色，跟标品段的蓝一眼分开
        const STAGE_ENT_UI = ['企业级机会', '决策链摸排', '需求与现状勘察', '方案与试点设计', '商务推进', '私有化签约']
        // 透明度调节: 悬浮框默认 50%, 记忆在 localStorage
        const [opacity, setOpacity] = useState(() => {
          try {
            const v = parseFloat(localStorage.getItem('sales-board-opacity') || '')
            if (typeof v === 'number' && v >= 0.2 && v <= 1) return v
          } catch (e) {}
          return 0.6
        })
        useEffect(() => { try { localStorage.setItem('sales-board-opacity', String(opacity)) } catch (e) {} }, [opacity])
        const MIN_W = 360, MIN_H = 320
        const clampN = (x, lo, hi) => Math.min(Math.max(x, lo), Math.max(lo, hi))
        // 四边+四角 8 向拖拽调尺寸: 拖左/上边时窗口位置联动 (对边固定)
        const startResize = useCallback((dir) => (e) => {
          if (e.button !== 0) return
          resizeRef.current = { dir, sx: e.clientX, sy: e.clientY, px: pos.x, py: pos.y, pw: size.w, ph: size.h }
          e.preventDefault(); e.stopPropagation()
        }, [pos, size])
        const RESIZE_HANDLES = [
          { dir: 'n', cursor: 'ns-resize', style: { top: 0, left: 8, right: 8, height: 6 } },
          { dir: 's', cursor: 'ns-resize', style: { bottom: 0, left: 8, right: 8, height: 6 } },
          { dir: 'w', cursor: 'ew-resize', style: { left: 0, top: 8, bottom: 8, width: 6 } },
          { dir: 'e', cursor: 'ew-resize', style: { right: 0, top: 8, bottom: 8, width: 6 } },
          { dir: 'nw', cursor: 'nwse-resize', style: { top: 0, left: 0, width: 12, height: 12 } },
          { dir: 'ne', cursor: 'nesw-resize', style: { top: 0, right: 0, width: 12, height: 12 } },
          { dir: 'sw', cursor: 'nesw-resize', style: { bottom: 0, left: 0, width: 12, height: 12 } },
          { dir: 'se', cursor: 'nwse-resize', style: { bottom: 0, right: 0, width: 12, height: 12 } },
        ]
        const toggleFloat = useCallback(() => {
          setFloat((f) => !f)
          setPos((p) => ({ x: Math.min(Math.max(0, p.x), Math.max(0, window.innerWidth - 180)), y: Math.min(Math.max(0, p.y), Math.max(0, window.innerHeight - 90)) }))
          setSize((s) => ({ w: Math.min(Math.max(360, s.w), Math.max(360, window.innerWidth - 40)), h: Math.min(Math.max(320, s.h), Math.max(320, window.innerHeight - 80)) }))
        }, [])
        const onHeaderMouseDown = useCallback((e) => {
          if (!float || e.button !== 0) return
          if (e.target && e.target.closest && e.target.closest('button,input')) return
          dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y }
          e.preventDefault()
        }, [float, pos])
        useEffect(() => safeEffect('drag-move', () => {
          if (!float) return
          const move = (e) => {
            const d = dragRef.current
            if (!d) return
            setPos({
              x: Math.min(Math.max(0, e.clientX - d.dx), Math.max(0, window.innerWidth - 120)),
              y: Math.min(Math.max(0, e.clientY - d.dy), Math.max(0, window.innerHeight - 50)),
            })
          }
          const up = () => { dragRef.current = null }
          window.addEventListener('mousemove', move)
          window.addEventListener('mouseup', up)
          return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
        }), [float])
        // 四边+四角拖拽调尺寸 (宽≥360 高≥320 不超屏; 拖左/上边时位置联动, 对边固定)
        useEffect(() => safeEffect('drag-resize', () => {
          if (!float) return
          const move = (e) => {
            const d = resizeRef.current
            if (!d) return
            const vw = window.innerWidth, vh = window.innerHeight
            const dx = e.clientX - d.sx, dy = e.clientY - d.sy
            let px = d.px, py = d.py, pw = d.pw, ph = d.ph
            if (d.dir.indexOf('e') >= 0) pw = clampN(d.pw + dx, MIN_W, vw - d.px - 8)
            if (d.dir.indexOf('s') >= 0) ph = clampN(d.ph + dy, MIN_H, vh - d.py - 8)
            if (d.dir.indexOf('w') >= 0) {
              pw = clampN(d.pw - dx, MIN_W, Math.min(vw - 40, d.px + d.pw))
              px = d.px + d.pw - pw
            }
            if (d.dir.indexOf('n') >= 0) {
              ph = clampN(d.ph - dy, MIN_H, Math.min(vh - 80, d.py + d.ph))
              py = d.py + d.ph - ph
            }
            setPos({ x: px, y: py })
            setSize({ w: pw, h: ph })
          }
          const up = () => { resizeRef.current = null }
          window.addEventListener('mousemove', move)
          window.addEventListener('mouseup', up)
          return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
        }), [float])

        const loadTasks = useCallback(() => {
          setLoading(true); setErr(null)
          fetchData('sales.tasks', { days: 7 }).then((r) => { setLoading(false); if (r && r.ok) setTasks(r.data); else setErr((r && r.error) ? String(r.error) : '未知错误') })
        }, [])
        const loadSummary = useCallback(() => {
          setLoading(true); setErr(null)
          fetchData('sales.summary', {}).then((r) => { setLoading(false); if (r && r.ok) setSummary(r.data); else setErr((r && r.error) ? String(r.error) : '未知错误') })
        }, [])
        const loadFirstCall = useCallback(() => {
          setLoading(true); setErr(null)
          fetchData('sales.firstcall', {}).then((r) => { setLoading(false); if (r && r.ok) setFirstcall(r.data); else setErr((r && r.error) ? String(r.error) : '未知错误') })
        }, [])
        // 重点跟进名单(2026-09-29 用户要求独立成页)：/sales/focus → sales-lib 的 focus 命令
        //   口径：人工挑的重点盘，**不提醒跟进**（不进每日队列/逾期/待定），用户每天自己看
        const loadFocus = useCallback(() => {
          setLoading(true); setErr(null)
          fetchData('sales.focus', {}).then((r) => { setLoading(false); if (r && r.ok) setListPage(r.data); else setErr((r && r.error) ? String(r.error) : '未知错误') })
        }, [])
        // 挂起冷备名单(2026-09-24 用户要求独立成页)：/sales/cold → sales-lib 的 cold 命令
        const loadCold = useCallback(() => {
          setLoading(true); setErr(null)
          fetchData('sales.cold', {}).then((r) => { setLoading(false); if (r && r.ok) setListPage(r.data); else setErr((r && r.error) ? String(r.error) : '未知错误') })
        }, [])
        // 六分类名单页(2026-10-13 用户定：待首触/标品成交/定制开发/待定跟进 各成一页)：
        //   /sales/first|standard|custom|pending → sales-lib 的同名命令（只读）
        //   与重点跟进/挂起冷备共用同一份 listPage state（不新增 useState，避免打乱探针的 hook 序号）
        const loadBucketPage = useCallback((name) => {
          setLoading(true); setErr(null)
          fetchData('sales.' + name, {}).then((r) => { setLoading(false); if (r && r.ok) setListPage(r.data); else setErr((r && r.error) ? String(r.error) : '未知错误') })
        }, [])
        const doSearch = useCallback((kw) => {
          const q = (kw || '').trim()
          if (!q) { setSearchRes(null); return }
          setLoading(true); setErr(null)
          fetchData('sales.search', { kw: q }).then((r) => { setLoading(false); if (r && r.ok) setSearchRes(r.data); else setErr((r && r.error) ? String(r.error) : '未知错误') })
        }, [])
        // 销售指导(示例语料综合参考): 搜索式
        const loadTips = useCallback((kw) => {
          const q = (kw || '').trim()
          if (!q) { setGuideRes(null); return }
          setLoading(true); setErr(null)
          fetchData('sales.tips', { q }).then((r) => { setLoading(false); if (r && r.ok) setGuideRes(r.data); else setErr((r && r.error) ? String(r.error) : '未知错误') })
        }, [])
        // 销售指导: 按客户场景联动(跟进提示)
        const loadClientTip = useCallback((id) => {
          if (!id) return
          setTipId(id); setTipData(null)
          fetchData('sales.clienttip', { id }).then((r) => { if (r && r.ok) setTipData(r.data); else setTipData({ ok: false, error: (r && r.error) ? String(r.error) : '未知错误' }) })
        }, [])
        // SOP 时间轴(2026-09-29；2026-10-08 扩 13 段): 按标品 7 段 + 企业级 6 段 + 出口 分组看这个客户跟到哪一步了
        const loadSop = useCallback((id) => {
          if (!id) return
          setSopId(id); setSopData(null)
          fetchData('sales.sop', { id }).then((r) => { if (r && r.ok) setSopData(r.data); else setSopData({ ok: false, error: (r && r.error) ? String(r.error) : '未知错误' }) })
        }, [])

        // 2026-10-12（模型面 A′ 档）：🧠 按钮 —— **点了才调模型**，绝不进 30 秒静默刷新（省钱、不拖卡）。
        //   结果挂在已有的 sopData / tipData 上（**不新增 useState**，避免打乱渲染探针 hookState 的序号）。
        //   服务端已做字段级脱敏 + 回填，这里拿到的就是真名真公司；模型失败/超时 → 服务端回落规则版。
        const aiWhy = (r, a) => ((a && a.error) ? String(a.error) : ((r && r.error) ? String(r.error) : '模型没出结果'))
        const aiWrap = (r) => {
          const a = (r && r.ok && r.data && r.data.ai) || null
          const good = !!(a && a.ok && a.text)
          return { busy: false, text: good ? String(a.text) : '', mode: good ? 'ai' : 'rule', info: (a && (a.label || a.model)) || '', local: !!(a && a.local), fellBack: (a && a.fellBack) || '', ms: (a && a.ms) || 0, error: good ? '' : aiWhy(r, a) }
        }
        const loadSopAi = useCallback((id) => {
          if (!id) return
          setSopData((d) => Object.assign({}, d, { ai: { busy: true, text: '', mode: '', info: '', ms: 0, error: '' } }))
          fetchData('sales.ai', { action: 'live', id }).then((r) => setSopData((d) => Object.assign({}, d, { ai: aiWrap(r) })))
        }, [])
        const loadTipAi = useCallback((id) => {
          if (!id) return
          setTipData((d) => Object.assign({}, d, { ai: { busy: true, text: '', mode: '', info: '', ms: 0, error: '' } }))
          fetchData('sales.ai', { action: 'live', id }).then((r) => setTipData((d) => Object.assign({}, d, { ai: aiWrap(r) })))
        }, [])
        // 2026-10-12 批次 2：只读面也接模型（点按钮才调，不进 30 秒静默刷新；结果挂在已有 state 上，不新增 useState）
        //   ① 今日工作台（tasks 页）：今天先打谁、盯什么风险、要你点头的一件事
        //   ② 周复盘（summary 页）：这一周干了什么、卡在哪、下周先打谁
        //   事实全部来自引擎 + 数字回查（模型编的数字 → 服务端整段作废、回落规则版）
        const loadBriefAi = useCallback(() => {
          setTasks((d) => Object.assign({}, d, { ai: { busy: true, text: '', mode: '', info: '', ms: 0, error: '' } }))
          fetchData('sales.ai', { action: 'brief' }).then((r) => setTasks((d) => Object.assign({}, d, { ai: aiWrap(r) })))
        }, [])
        const loadDigestAi = useCallback(() => {
          setSummary((d) => Object.assign({}, d, { ai: { busy: true, text: '', mode: '', info: '', ms: 0, error: '' } }))
          fetchData('sales.ai', { action: 'digest', days: 7 }).then((r) => setSummary((d) => Object.assign({}, d, { ai: aiWrap(r) })))
        }, [])
        // AI 话术/切入 的统一渲染块（按钮 → 生成中 → 正文 + 复制 + 一句边界说明）
        function aiBlock(ai, onGen, label) {
          const busy = !!(ai && ai.busy)
          const txt = (ai && ai.text) || ''
          const btnStyle = { background: busy ? 'rgba(154,103,0,.10)' : 'rgba(154,103,0,.16)', border: '1px solid rgba(154,103,0,.5)', borderRadius: 6, padding: '3px 8px', color: 'var(--text-1,#fff)', cursor: busy ? 'wait' : 'pointer', fontSize: 12, flexShrink: 0, opacity: busy ? .7 : 1 }
          const rowEl = React.createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
            React.createElement('button', { key: 'go', onClick: busy ? null : onGen, disabled: busy, title: '点了才调模型（约 1–8 秒）；失败自动回落规则版，不会卡住看板', style: btnStyle }, busy ? '🧠 生成中…' : (txt ? label + '（重新生成）' : label)),
            (ai && ai.mode === 'ai') ? React.createElement('span', { key: 'm', style: { fontSize: 10, color: 'var(--ok-color,#2b8a3e)' } }, (ai.local ? '本地模型 ' : '云端模型 ') + (ai.info || '默认') + (ai.fellBack === 'cloud' ? '（本地失败→云端）' : '')) : null,
            (ai && ai.mode === 'rule' && ai.error) ? React.createElement('span', { key: 'e', style: { fontSize: 10, color: 'var(--warn-color,#a15c00)' } }, '规则版（' + ai.error + '）') : null,
            (ai && ai.ms) ? React.createElement('span', { key: 'ms', style: { fontSize: 10, color: 'var(--text-2,#999)' } }, ai.ms + 'ms') : null,
            React.createElement('span', { key: 'sp', style: { flex: 1 } }),
            txt ? React.createElement('button', { key: 'cp', onClick: (e) => aiCopy(txt, e.currentTarget), style: Object.assign({}, btnStyle, { background: 'rgba(64,192,120,.14)', border: '1px solid rgba(64,192,120,.45)' }) }, '📋 复制') : null)
          return React.createElement('div', { key: 'ai', style: { marginTop: 6, padding: '6px 8px', background: 'rgba(154,103,0,.06)', border: '1px dashed rgba(154,103,0,.45)', borderRadius: 6 } },
            rowEl,
            txt ? React.createElement('div', { key: 't', style: { fontSize: 12.5, lineHeight: 1.6, whiteSpace: 'pre-wrap', marginTop: 4, color: 'var(--text-1,#eee)' } }, txt) : null,
            React.createElement('div', { key: 'n', style: { fontSize: 10, color: 'var(--text-2,#999)', marginTop: 4 } }, '发模型前已脱敏（姓名/手机/公司/微信→占位符＋角色·行业标签），回来回填真名；只出文字，绝不写库。'))
        }

        // ===== 2026-11-10 开源化：首次设置向导 + ⚙ 设置面板（hook 一律"只追加"，既有 hook 语义不动）=====
        // 契约（后端 dsh/index.js 已实现，前端只消费）：
        //   /sales/config   → {configured,source,configFile,configExists,configError,dataDir,dataDirExists,defaultDataDir,ai,features,profile}
        //   /sales/configset（部分补丁 {dataDir?,ai?,features?,profile?}）→ 同 config 状态；相对路径会被拒（error 原样上屏）
        //   /sales/setup    → {dataDir,madeDirs,created,kept,seed,config}（幂等，已有文件进 kept）
        //   /sales/configtest → 真发一次极短请求的探测结果（读的是**已保存**配置，所以先保存再测）
        //   /sales/egress   → 只读诊断里的 rag 段（语料块数/目录/开关）
        // 红线：默认值只用后端 defaultDataDir（前端不写死任何本机路径）；后端 error 一律原样显示。
        const [cfg, setCfg] = useState(null)              // 配置状态（null = 还没取到）
        const [cfgErr, setCfgErr] = useState(null)        // 取配置失败的原因（后端 error 原样）
        const [draft, setDraft] = useState(null)          // 向导/设置面板共用的编辑草稿（null = 由 cfg 现算）
        const [wizStep, setWizStep] = useState(0)         // 0 数据目录 / 1 公司与产品 / 2 模型通道
        const [wizOpen, setWizOpen] = useState(false)     // 向导是否展示（由 bootOnce/needs-setup 决定，保存中途不会被"配置已就绪"挤掉）
        const [wizBusy, setWizBusy] = useState(false)     // 向导里的请求进行中
        const [wizMsg, setWizMsg] = useState(null)        // {tone:'ok'|'err'|'info', text}
        const [wizTest, setWizTest] = useState(null)      // 测试连接结果 {ok,route,label,provider,model,ms,local,error}
        const [panelOpen, setPanelOpen] = useState(false) // ⚙ 设置面板开关
        const [panelMsg, setPanelMsg] = useState(null)    // 设置面板回执 {tone,text}
        const [panelTest, setPanelTest] = useState(null)  // 设置面板的测试连接结果
        const [diag, setDiag] = useState(null)            // 只读诊断：/sales/egress 的 rag 段
        const [notice, setNotice] = useState(null)        // 看板内容区顶部的一句话成功回执（初始化完成后）
        const AI_MODES_UI = ['session', 'fixed', 'local']
        const AI_MODE_LABEL = {
          session: '跟随当前会话模型（推荐，不用填 key）',
          fixed: '指定已配置的 provider/model',
          local: '本地模型（Ollama 等，走 DSH 已配置的 provider）',
        }
        const AI_MODE_DESC = {
          session: '看板里的 AI 动作直接用当前会话那个模型；换会话不用改设置。',
          fixed: '给看板钉死一个 provider/model（key 由 DSH 宿主持有，前端不碰密钥）。',
          local: '走 DSH 里已配置的本地 provider（例如 Ollama）：数据不出本机，模型能力有限。',
        }
        const EFFORT_OPTS = [['', '默认（不指定）'], ['off', '关闭思考（最快）'], ['low', '低'], ['medium', '中'], ['high', '高']]
        const SRC_LABEL = { env: '环境变量 SALE_DIR（优先）', config: '配置文件', default: '未设置（用的是默认值）' }
        const TONE = { ok: 'var(--ok-color, #2b8a3e)', err: 'var(--danger-color, #c92a2a)', info: 'var(--text-2, #888)' }

        // ===== 2026-11-11（1.3.0）：手机号认客户 + 客户档案卡 + SOP 归段 =====
        // 契约（后端 dsh/index.js 已实现，前端只消费）：
        //   /sales/profile {action:'get'|'set'|'list'|'draft', phone?, fields?} → {ok,data}
        //     get → {phone, profile:{intro,industry,scale,people,chain,need,product,budget,rival,compliance,strategy}|null,
        //            derived:{name,contact,city,source,level,stage}}
        //   /sales/stagefix {phone, flowId, stage, reason?} → {ok,data:{from,to}}
        //   /sales/ai {purpose:'profile', phone} → {ok,data:{text}}（只出文字，必须点保存才落盘）
        // 口径：跟进记录只在 SOP 展示（区域一不再堆 c.hist）；客户标识一律手机号（不出现 C- 客户ID）。
        const [profiles, setProfiles] = useState({})      // phone → {profile, derived}
        const [profEdit, setProfEdit] = useState(null)    // 档案编辑面板 {phone,name,fields,busy,msg,aiBusy,loading}
        const [stageBusy, setStageBusy] = useState('')    // `${phone}|${flowId}` 正在归段
        const [stageMsg, setStageMsg] = useState(null)    // 归段回执 {tone,text}
        const SOP_STAGES_13 = ['线索获取', '客户触达', '需求挖掘', '产品演示', '异议处理', '方案报价', '成交签约',
          '企业级机会', '决策链摸排', '需求与现状勘察', '方案与试点设计', '商务推进', '私有化签约']
        const SOP_STAGE_FIX = SOP_STAGES_13.concat(['无法联系', '推进终止', '其他跟进记录'])
        const PROFILE_FIELDS_UI = [
          ['intro', '一句话介绍（这家公司/这个客户是什么情况）'],
          ['industry', '行业'], ['scale', '规模'],
          ['people', '决策人'], ['chain', '决策链'],
          ['need', '需求'], ['product', '产品'], ['budget', '预算'],
          ['rival', '竞对'], ['compliance', '合规要求'], ['strategy', '打法策略'],
        ]

        // 静默刷新（不置 loading，数据变了自动跟上）
        // 2026-09-29 修（用户报障「重点跟进未显示黄江」）：原来只刷 tasks/summary/firstcall，
        //   「重点跟进/挂起冷备」页的 listPage 不在轮询里 → 停在该页时永远看旧数据。
        //   这里按**当前页签**一并刷 listPage（两页共用一份 state，不能无条件都刷，会互相覆盖）。
        const silentRefresh = useCallback(() => {
          // 2026-11-10 开源化：配置没就绪（没设数据目录）时**一个数据请求都不发**——
          //   否则 30 秒轮询会不停往 err 里灌「还没有设置数据目录」，首次打开就成了报错页。
          if (!cfg || !cfg.configured || wizOpen) return
          fetchData('sales.tasks', { days: 7 }).then((r) => { if (r && r.ok) setTasks(r.data); else if (r && r.error) setErr(String(r.error)) })
          fetchData('sales.summary', {}).then((r) => { if (r && r.ok) setSummary(r.data); else if (r && r.error) setErr(String(r.error)) })
          fetchData('sales.firstcall', {}).then((r) => { if (r && r.ok) setFirstcall(r.data); else if (r && r.error) setErr(String(r.error)) })
          if (tab === 'focus') fetchData('sales.focus', {}).then((r) => { if (r && r.ok) setListPage(r.data) })
          else if (tab === 'cold') fetchData('sales.cold', {}).then((r) => { if (r && r.ok) setListPage(r.data) })
          // 2026-10-13 六分类新增页：待首触/标品成交/定制开发/待定跟进 也按当前页签静默刷（同一份 listPage）
          else if (tab === 'first' || tab === 'standard' || tab === 'custom' || tab === 'pending') fetchData('sales.' + tab, {}).then((r) => { if (r && r.ok) setListPage(r.data) })
          // 2026-10-15 合同台账页：停在该页时也静默跟上（写动作后已手动重拉；这里只管到点/外部改动）
          else if (tab === 'contract') contractLoad()
        }, [tab, cfg, wizOpen])

        // 2026-10-28（用户 m03015「要同步更新到面板显示上」）：
        //   写库成功后面板**必须立刻重拉**，不能干等 30 秒轮询——轮询只刷 tasks/summary/firstcall + 当前列表页，
        //   **不刷已展开的 SOP 详情**，所以写完跟进后面板还挂着旧排期/旧阶段，爹以为没落上，
        //   就再教一遍、再写一遍（当天 L1124/L1125 两条近似流水就是这么来的）。
        //   这里把「刷当前视图」的事交给 silentRefresh（按页签），再补 SOP / 客户提示两处详情。
        const refreshAfterWrite = useCallback(() => {
          try { silentRefresh() } catch (e) {}
          try { if (sopId) loadSop(sopId) } catch (e) {}
          try { if (tipId) loadClientTip(tipId) } catch (e) {}
          // 2026-11-11（1.3.0）：写库后档案也可能跟着变（阶段/结果/下次跟进），顺手刷一遍档案索引
          try { loadProfiles() } catch (e) {}
        }, [silentRefresh, sopId, tipId])

        useEffect(() => safeEffect('listeners', () => {
          const onOpen = () => {
            try {
              setOpen(true)
              // 2026-11-10 开源化：打开时**先读配置**（bootOnce），配置就绪才发数据请求；
              //   原来直接 loadTasks/loadSummary/loadFirstCall，首次使用（还没设数据目录）会先闪一屏空表 + 红字报错。
              bootOnce()
            }
            catch (e) { try { console.error('[sales-board onOpen] ' + ((e && e.message) || e), e) } catch (_) {} }
          }
          const onClose = () => setOpen(false)
          // 任何数据端点回 code==='UNCONFIGURED'（fetchData 里广播）→ 立刻回到首次设置向导
          const onNeedSetup = () => {
            try { setWizStep(0); setWizMsg(null); setWizTest(null); setOpen(true); bootOnce() }
            catch (e) { try { console.error('[sales-board onNeedSetup] ' + ((e && e.message) || e), e) } catch (_) {} }
          }
          window.addEventListener('sales:open-board', onOpen)
          window.addEventListener('sales:close-board', onClose)
          window.addEventListener('sales:needs-setup', onNeedSetup)
          return () => {
            safeEffect('listeners-off', () => {
              window.removeEventListener('sales:open-board', onOpen)
              window.removeEventListener('sales:close-board', onClose)
              window.removeEventListener('sales:needs-setup', onNeedSetup)
            })
          }
        }), [loadTasks, loadSummary, loadFirstCall, silentRefresh])

        useEffect(() => safeEffect('interval', () => {
          if (!open) return
          if (!cfg || !cfg.configured || wizOpen) return // 未配置/向导展示中：不轮询（没有可刷的数据，只会灌错误）
          // 2026-10-08 事故的根因就在下一行：`ctx.interval()` 内部要 `ctx.get('timer')`，
          //   而 exports.inject 里漏声明 'timer' 时会抛 `cannot get property "timer" without inject`。
          //   effect 里抛出的错会被宿主 reportEntryError(..., {abdicate:true}) 弃用**整条贡献**（面板凭空消失）。
          //   现已把 'timer' 补进 exports.inject（见文件末尾注释）；这里再兜一层，宿主真不提供就退回浏览器定时器。
          let dispose = null
          try { dispose = ctx.interval(silentRefresh, 30000) } catch (e) { dispose = null }
          if (typeof dispose === 'function') return () => safeEffect('interval-dispose', () => dispose())
          const id = window.setInterval(silentRefresh, 30000)
          return () => safeEffect('interval-dispose', () => window.clearInterval(id))
        }), [open, silentRefresh, cfg, wizOpen])

        // ===== 2026-10-15 合同台账页（第 8 个页签，case 32） =====
        // 5 个新 state **必须追加在既有 hook 块的最末尾**（插在中间会让探针的槽位表整体挪位）：
        //   contractList 台账列表 / contractId 当前合同 / contractDraft 生成要素 / contractReview 初审结果（规则+AI）/ contractMsg 一句话回执
        const [contractList, setContractList] = useState(null)
        const [contractId, setContractId] = useState('')
        const [contractDraft, setContractDraft] = useState({ 客户ID: '', 类型: '定制开发', 模板: 'standard', 金额: '', 税率: '', 我方主体: '', 对方主体: '', 对方统一社会信用代码: '', 签署日: '', 生效日: '', 到期日: '', 节点名: '' })
        const [contractReview, setContractReview] = useState(null)
        const [contractMsg, setContractMsg] = useState('')
        // 下面 4 个是**普通函数**（不是 hook）：故意不占 hook 槽位，避免影响探针的 hook 序号表。
        const contractBad = (r) => String((r && r.error) || '未知错误')
        const contractRowsOf = (r) => {
          const d = (r && r.data && typeof r.data === 'object') ? r.data : (r || {})
          if (Array.isArray(d.contracts)) return d.contracts
          if (Array.isArray(d.list)) return d.list
          if (Array.isArray(d)) return d
          return []
        }
        const contractLoad = () => {
          fetchData('sales.contract', { action: 'list' }).then((r) => {
            if (!r || r.ok === false) { setContractMsg('台账读取失败：' + contractBad(r)); return }
            const rows = contractRowsOf(r)
            setContractList(rows)
            setContractMsg(rows.length ? ('台账 ' + rows.length + ' 份合同') : '台账还没有合同：先在下面存一份要素')
          }).catch((e) => setContractMsg('台账读取异常：' + String((e && e.message) || e)))
        }
        // 合同 → 要素草稿（字段名按台账；日期兼容「生效日/生效日期」两种叫法）
        const contractDraftFrom = (c) => {
          if (!c || typeof c !== 'object') return null
          const g = (k) => (c[k] === undefined || c[k] === null) ? '' : String(c[k])
          return {
            客户ID: g('客户ID'), 类型: g('类型') || '定制开发', 模板: g('模板') || 'standard',
            金额: g('金额'), 税率: g('税率'), 我方主体: g('我方主体'), 对方主体: g('对方主体'),
            对方统一社会信用代码: g('对方统一社会信用代码'),
            签署日: g('签署日'), 生效日: g('生效日') || g('生效日期'), 到期日: g('到期日') || g('到期日期'),
            节点名: '',
          }
        }
        const contractPick = (cid) => {
          setContractId(cid)
          setContractReview(null)
          fetchData('sales.contract', { action: 'get', 合同ID: cid }).then((r) => {
            if (!r || r.ok === false) { setContractMsg('读合同失败：' + contractBad(r)); return }
            const d = (r.data && typeof r.data === 'object') ? r.data : {}
            const c = (d && (d.contract || d.合同)) || ((d && (d.合同ID || d.id)) ? d : null)
            setContractReview({ contract: c })
            // 2026-10-21 体检（m03962 P0）：切合同时把要素草稿按当前合同重填。
            //   原来草稿跨合同共享 —— 选了 A 再选 B，A 的金额/主体留在表单里，
            //   一点「存台账/生成」就把 A 的值写到 B 名下（串值）。
            const nd = contractDraftFrom(c)
            if (nd) setContractDraft(nd)
            setContractMsg('已选：' + cid)
          }).catch((e) => setContractMsg('读合同异常：' + String((e && e.message) || e)))
        }
        // 要素透传：**只传非空**。2026-10-21 体检（m03962 P0）：原来 Object.assign({}, contractDraft)
        //   把空串一起传下去，服务端 withElements 用空串覆盖台账真值 → 初审把已填金额/主体误报成「缺」，
        //   生成 docx 也会把要素覆盖成空。方向敏感的甲方/乙方仍不猜，由「模板必填」表单显式填。
        const contractEls = () => {
          const out = {}
          Object.keys(contractDraft).forEach((k) => {
            const v = contractDraft[k]
            if (v !== '' && v !== null && v !== undefined) out[k] = v
          })
          return out
        }
        // 写动作一律走数据层 run('contract', …)（插件路由 → sales-lib 写入口）；看板自己不碰表、不碰文件。
        const contractAct = (args, tip) => {
          setContractMsg(tip + '…')
          fetchData('sales.contract', args).then((r) => {
            if (!r || r.ok === false) { setContractMsg(tip + '失败：' + contractBad(r)); return }
            const d = (r.data && typeof r.data === 'object') ? r.data : {}
            const cid = String((d && d.合同ID) || args.合同ID || '').trim()
            setContractMsg(tip + '完成' + (cid ? '：' + cid : ''))
            if (cid) contractPick(cid)
            contractLoad()
          }).catch((e) => setContractMsg(tip + '异常：' + String((e && e.message) || e)))
        }
        const contractReviewRun = (withAi) => {
          if (!contractId) { setContractMsg('先在台账里选一份合同'); return }
          setContractMsg(withAi ? 'AI 复核中（合同要素会发给模型厂商——唯一放行出口；其余不出本机）…' : '规则初审中…')
          if (withAi) {
            fetchData('sales.ai', { action: 'contract', 合同ID: contractId, 保存: true, 要素: contractEls() }).then((r) => {
              if (!r || r.ok === false) { setContractMsg('AI 复核失败：' + contractBad(r)); return }
              const d = (r.data && typeof r.data === 'object') ? r.data : {}
              setContractReview(d)
              setContractMsg(d.mode === 'ai' ? 'AI 复核完成（已落 audit 留痕）' : 'AI 不可用：已回落规则版（规则清单仍可看）')
            }).catch((e) => setContractMsg('AI 复核异常：' + String((e && e.message) || e)))
            return
          }
          fetchData('sales.contract', { action: 'review', 合同ID: contractId, 保存: true, 要素: contractEls() }).then((r) => {
            if (!r || r.ok === false) { setContractMsg('规则初审失败：' + contractBad(r)); return }
            setContractReview(r.data || {})
            setContractMsg('规则初审完成（已落 audit 留痕）')
          }).catch((e) => setContractMsg('规则初审异常：' + String((e && e.message) || e)))
        }
        const contractGen = () => {
          if (!contractId) { setContractMsg('先在下面存一份合同要素（选客户 → 存台账），再生成 .docx'); return }
          setContractMsg('生成 .docx 中（本机生成、本机落盘）…')
          fetchData('sales.contract', {
            action: 'generate', 合同ID: contractId, 模板: contractDraft.模板,
            // 要素：整个 draft 原样透传（台账字段 + 「查模板」后补的模板必填字段都在里面；
            //   插件侧只做同义兜底，方向敏感的甲方/乙方**不猜**，缺必填会由生成层如实报出）
            要素: contractEls(),
          }).then((r) => {
            if (!r || r.ok === false) { setContractMsg('生成失败：' + contractBad(r)); return }
            const d = (r.data && typeof r.data === 'object') ? r.data : {}
            const okDl = d.base64 ? downloadBase64(d.名 || (contractId + '.docx'), d.base64, d.mime) : false
            setContractMsg('已生成：' + String(d.名 || '') + (okDl ? '（已开始下载）' : '（已在 sale\\合同\\ 落盘）') + (d.已登记 ? '，已登记台账' : '，台账登记失败：' + String(d.登记错误 || '')))
            contractPick(contractId)
          }).catch((e) => setContractMsg('生成异常：' + String((e && e.message) || e)))
        }

        if (!open) return null

        // ============ 2026-11-10 开源化：首次设置向导 + ⚙ 设置面板 ============
        // 这一段全是**普通函数**（不是 hook），只追加在既有逻辑之后，不改任何既有行为。
        //   ① 默认值只来自后端 defaultDataDir（前端不写死任何本机路径）；② 后端 error 一律原样上屏；
        //   ③ 浮层从 CLEARANCE 起 + WebkitAppRegion:'no-drag'（桌面端顶部拖动条不会被盖住）。
        // 渲染闸门：配置没取到 → bootScreen；向导打开 → setupWizard。两者都在数据请求之前 return，
        //   所以首次使用不会先闪一屏空表/UNCONFIGURED 报错。
        if (!cfg) return bootScreen(cfgErr)
        if (wizOpen) return setupWizard(cfg)

        // 绝对路径判定：前端先挡一道（后端还会再挡一次，文案保持一致，避免"前端放行后端报错"的困惑）
        function isAbsDir(p) {
          const s = String(p == null ? '' : p).trim()
          if (!s) return false
          if (/^[A-Za-z]:[\\/]/.test(s)) return true // 盘符绝对路径，例如 D:/x 或 D:\x
          if (s.charAt(0) === '/') return true        // 以 / 开头：macOS / Linux 绝对路径
          if (s.slice(0, 2) === '\\\\') return true   // UNC 共享路径，例如 \\nas\share
          return false
        }
        function absDirHint() {
          return '必须是绝对路径：例如 Windows 是 D:/你的销售数据，macOS/Linux 是 /home/me/sales-data。'
        }

        // 后端配置状态 → 编辑草稿（老配置可能缺 features/profile，一律容错；目录空则回填后端默认值）
        function draftOf(c) {
          const ai = (c && c.ai) || {}
          const loc = ai.local || {}
          const f = (c && c.features) || {}
          const p = (c && c.profile) || {}
          return {
            dataDir: String((c && c.dataDir) || (c && c.defaultDataDir) || ''),
            ai: {
              mode: (ai.mode === 'fixed' || ai.mode === 'local') ? ai.mode : 'session',
              provider: String(ai.provider || ''),
              model: String(ai.model || ''),
              reasoningEffort: String(ai.reasoningEffort || ''),
              local: { provider: String(loc.provider || 'local'), model: String(loc.model || '') },
            },
            features: { rag: !(f.rag === false) },
            profile: { company: String(p.company || ''), product: String(p.product || '') },
          }
        }
        function currentDraft() { return draft || draftOf(cfg) }
        // 只发 ai 的补丁（测试连接用：不带上可能非法的目录，免得"目录被拒"掩盖了模型结果）
        function aiPatchOf(D) {
          const ai = (D && D.ai) || {}
          return { mode: ai.mode, provider: ai.provider, model: ai.model, reasoningEffort: ai.reasoningEffort, local: ai.local }
        }
        // 全量补丁（保存/初始化用）
        function patchOf(D) {
          return { dataDir: D.dataDir, ai: aiPatchOf(D), features: D.features, profile: D.profile }
        }
        function applyCfg(c) {
          if (!c || typeof c !== 'object') return
          setCfg(c)
          setDraft(null) // 配置回填后草稿重新由 cfg 现算，界面显示的是真正落盘的值
        }
        // 读配置：唯一允许无条件发的请求。configured 才拉数据；否则（或 configError）打开向导。
        function bootOnce() {
          fetchData('sales.config', {}).then(function (r) {
            if (r && r.ok && r.data) {
              setCfgErr(null)
              applyCfg(r.data)
              if (!r.data.configured || r.data.configError) {
                setWizOpen(true)
                setWizStep(0)
                setWizMsg(null)
                setWizTest(null)
                return
              }
              // 配置就绪：这才是原来的"打开面板先拉一屏数据"
              try { loadTasks() } catch (e) {}
              try { loadSummary() } catch (e) {}
              try { loadFirstCall() } catch (e) {}
              // 2026-11-11（1.3.0）：档案也先拉一遍（一条 list 请求，按手机号建索引；失败不影响看板）
              try { loadProfiles() } catch (e) {}
            } else {
              // 配置接口读不通（宿主重启/未加载）：**不要伪造一份 cfg**，否则闸门会放行、渲染出一个空看板。
              //   保持 cfg=null → 闸门继续给 bootScreen（含原因 + 重新读取），宿主回来后一键恢复。
              setCfgErr(String((r && r.error) || '读取配置失败（宿主可能正在重启）'))
            }
          }).catch(function (e) {
            setCfgErr(String((e && e.message) || e))
          })
        }

        // 草稿改写（局部更新，保持其它输入框不丢）
        function patchDraft(k, v) {
          setDraft(function (prev) {
            const base = prev || draftOf(cfg)
            const next = Object.assign({}, base)
            next[k] = v
            return next
          })
        }
        function patchAi(k, v) {
          setDraft(function (prev) {
            const base = prev || draftOf(cfg)
            const a2 = Object.assign({}, base.ai)
            a2[k] = v
            return Object.assign({}, base, { ai: a2 })
          })
        }
        function patchLocalAi(k, v) {
          setDraft(function (prev) {
            const base = prev || draftOf(cfg)
            const a2 = Object.assign({}, base.ai)
            const l2 = Object.assign({}, a2.local)
            l2[k] = v
            a2.local = l2
            return Object.assign({}, base, { ai: a2 })
          })
        }
        function patchFeatures(p) {
          setDraft(function (prev) {
            const base = prev || draftOf(cfg)
            return Object.assign({}, base, { features: Object.assign({}, base.features, p) })
          })
        }
        function patchProfile(k, v) {
          setDraft(function (prev) {
            const base = prev || draftOf(cfg)
            const p2 = Object.assign({}, base.profile)
            p2[k] = v
            return Object.assign({}, base, { profile: p2 })
          })
        }

        // 小组件（复用看板既有 CSS 变量，不引任何样式依赖）
        function uiInput() {
          return { background: 'var(--row-bg, rgba(128,128,128,.08))', color: 'var(--text-1, #12161c)', border: '1px solid var(--border-weak, rgba(128,128,128,.35))', borderRadius: 6, padding: '6px 8px', fontSize: 12.5, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box', width: '100%' }
        }
        function uiLabel(text) {
          return React.createElement('div', { style: { fontSize: 11.5, color: 'var(--text-2, #888)', marginBottom: 4 } }, text)
        }
        function uiField(label, control, hint) {
          return React.createElement('div', { style: { marginBottom: 12 } },
            uiLabel(label),
            control,
            hint ? React.createElement('div', { style: { fontSize: 11, color: 'var(--text-3, #999)', lineHeight: 1.65, marginTop: 4 } }, hint) : null)
        }
        function uiMsgEl(m) {
          if (!m) return null
          return React.createElement('div', { style: { fontSize: 12, color: TONE[m.tone] || TONE.info, lineHeight: 1.7, marginTop: 8, wordBreak: 'break-all', whiteSpace: 'pre-wrap' } }, String(m.text == null ? '' : m.text))
        }
        function uiKV(k, v) {
          return React.createElement('div', { key: 'kv-' + k, style: { display: 'flex', gap: 8, padding: '3px 0', fontSize: 11.5, lineHeight: 1.7, borderBottom: '1px dashed var(--border-weak, rgba(128,128,128,.18))' } },
            React.createElement('div', { style: { flex: '0 0 118px', color: 'var(--text-2, #888)' } }, k),
            React.createElement('div', { style: { flex: 1, minWidth: 0, color: 'var(--text-1, #12161c)', wordBreak: 'break-all' } }, v))
        }
        function uiSection(title, children, key) {
          return React.createElement('div', { key: key || ('sec-' + title), style: { marginBottom: 16 } },
            React.createElement('div', { style: { fontSize: 12, fontWeight: 700, color: 'var(--text-1, #12161c)', marginBottom: 8, paddingBottom: 4, borderBottom: '1px solid var(--border-weak, rgba(128,128,128,.25))' } }, title),
            children)
        }
        function uiBtn(text, onClick, primary, disabled) {
          return React.createElement('button', {
            type: 'button',
            onClick: disabled ? function () {} : onClick,
            disabled: !!disabled,
            style: {
              background: primary ? 'var(--accent, #2563eb)' : 'transparent',
              color: primary ? '#fff' : 'var(--btn-fg, #12161c)',
              border: '1px solid ' + (primary ? 'var(--accent-bd, rgba(37,99,235,.55))' : 'var(--border-weak, rgba(128,128,128,.35))'),
              borderRadius: 6, padding: '5px 12px', fontSize: 12, fontWeight: primary ? 600 : 500,
              cursor: disabled ? 'not-allowed' : 'pointer', lineHeight: '18px', opacity: disabled ? 0.55 : 1,
            },
          }, text)
        }
        // 与看板同款的 CSS 变量注入（浮层里复用 --text-1/--accent… 而不是另起一套配色）
        function shellVars() {
          return {
            '--text-1': THEME.text1, '--text-2': THEME.text2, '--text-3': THEME.text3,
            '--border-weak': THEME.border, '--border-strong': THEME.borderStrong,
            '--row-bg': THEME.rowBg, '--row-bg-od': THEME.rowBgOd,
            '--accent': THEME.accent, '--accent-tint': THEME.accentTint, '--accent-bd': THEME.accentBd,
            '--ok-color': THEME.ok, '--danger-color': THEME.danger, '--warn-color': THEME.warn,
            '--btn-fg': THEME.btnFg, '--tag-color': THEME.tagColor, '--chip-bg': THEME.chipBg,
          }
        }
        // 独立全屏壳：桌面端整窗浮层，顶端从 CLEARANCE 起（避开窗口拖动条），并声明 no-drag
        function overlayShell() {
          return Object.assign({
            position: 'fixed', left: 0, right: 0, bottom: 0, top: CLEARANCE, zIndex: 9999,
            display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0,
            background: THEME.bgFull, color: THEME.text1, boxShadow: '0 8px 40px rgba(0,0,0,.28)',
          }, NO_DRAG, shellVars())
        }
        // 看板内部浮层（设置面板）：absolute 铺满内容区，不动拖动条
        function panelShell() {
          return Object.assign({
            position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 60,
            background: THEME.bgFull, color: THEME.text1, display: 'flex', flexDirection: 'column',
            minHeight: 0, WebkitAppRegion: 'no-drag',
          }, shellVars())
        }
        // 只读展示用的两行摘要
        function modelSummary(c) {
          if (!c) return '读取中…'
          const ai = c.ai || {}
          if (ai.mode === 'fixed') return String(ai.provider || '?') + '/' + String(ai.model || '?') + '（指定 provider/model）'
          if (ai.mode === 'local') return String((ai.local && ai.local.provider) || '?') + '/' + String((ai.local && ai.local.model) || '?') + '（本地模型）'
          return '跟随当前会话模型（session）'
        }
        function ragLine() {
          if (!diag) return '读取中…'
          if (diag.error && (diag.chunks === undefined || diag.chunks === null)) return '读取失败：' + String(diag.error)
          if (diag.enabled === false) return '已关闭（可在设置里打开）'
          const n = (diag.chunks === undefined || diag.chunks === null) ? '—' : String(diag.chunks)
          return n + ' 块' + (diag.dir ? ('（语料目录 ' + String(diag.dir) + '）') : '')
        }
        function testLine(t) {
          if (!t) return null
          if (t.ok) {
            const bits = []
            if (t.route) bits.push('通道 ' + String(t.route))
            if (t.label) bits.push(String(t.label))
            if (t.ms !== undefined && t.ms !== null) bits.push(String(t.ms) + 'ms')
            if (t.local) bits.push('本机')
            return React.createElement('div', { style: { fontSize: 11.5, color: TONE.ok, marginTop: 6, wordBreak: 'break-all' } }, '✅ 连接成功：' + (bits.join(' · ') || '模型已应答'))
          }
          return React.createElement('div', { style: { fontSize: 11.5, color: TONE.err, marginTop: 6, wordBreak: 'break-all', whiteSpace: 'pre-wrap' } }, '❌ 连接失败：' + String(t.error || '模型没有应答'))
        }
        // 模型通道三选一（radio，三个模式的字段各不相同）
        function modeRadios() {
          const D = currentDraft()
          return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 } },
            AI_MODES_UI.map(function (m) {
              const on = D.ai.mode === m
              const box = Object.assign({ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '7px 10px', borderRadius: 6, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--accent-bd, rgba(37,99,235,.45))' : 'var(--border-weak, rgba(128,128,128,.35))') }, on ? { background: 'var(--accent-tint, rgba(37,99,235,.12))' } : {})
              return React.createElement('label', { key: 'mode-' + m, style: box },
                React.createElement('input', { type: 'radio', name: 'sales-ai-mode', checked: on, onChange: function () { patchAi({ mode: m }) }, style: { marginTop: 2, accentColor: THEME.blue } }),
                React.createElement('div', { style: { flex: 1, minWidth: 0 } },
                  React.createElement('div', { style: { fontSize: 12.5, fontWeight: on ? 700 : 600 } }, AI_MODE_LABEL[m]),
                  React.createElement('div', { style: { fontSize: 11, color: 'var(--text-2, #888)', lineHeight: 1.6, marginTop: 2 } }, AI_MODE_DESC[m])))
            }))
        }
        function modeFields() {
          const D = currentDraft()
          if (D.ai.mode === 'fixed') {
            return React.createElement('div', {},
              uiField('provider', React.createElement('input', { value: D.ai.provider, placeholder: 'DSH 模型设置里的 provider 名', onChange: function (e) { patchAi({ provider: e.target.value }) }, style: uiInput() })),
              uiField('model', React.createElement('input', { value: D.ai.model, placeholder: '模型 id', onChange: function (e) { patchAi({ model: e.target.value }) }, style: uiInput() })),
              uiField('思考档（可选）', React.createElement('select', { value: D.ai.reasoningEffort, onChange: function (e) { patchAi({ reasoningEffort: e.target.value }) }, style: uiInput() },
                EFFORT_OPTS.map(function (o) { return React.createElement('option', { key: 'eff-' + o[0], value: o[0] }, o[1]) }))))
          }
          if (D.ai.mode === 'local') {
            return React.createElement('div', {},
              uiField('本机 provider', React.createElement('input', { value: D.ai.local.provider, placeholder: 'local', onChange: function (e) { patchLocalAi({ provider: e.target.value }) }, style: uiInput() }), '通常是 local（DSH 里那个本机 provider 的名字）'),
              uiField('本机 model', React.createElement('input', { value: D.ai.local.model, placeholder: '例如 qwen2.5:7b', onChange: function (e) { patchLocalAi({ model: e.target.value }) }, style: uiInput() }), '要和本地模型列表里的名字一致（例如 ollama list 里那个）'))
          }
          return React.createElement('div', { style: { fontSize: 11.5, color: 'var(--text-2, #888)', lineHeight: 1.7, marginBottom: 4 } }, '不用填 provider/model：看板直接用当前会话的模型。')
        }

        // 读配置失败/还没取到：给一个"正在读取 + 失败原因 + 重试"的页，而不是空白或报错表格
        function bootScreen(err) {
          return React.createElement(BoardErrorBoundary, null,
            React.createElement('div', { style: overlayShell(), onClick: function (e) { if (e.target === e.currentTarget) closeBoard() } },
              React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--border-weak, rgba(128,128,128,.25))', flex: '0 0 auto' } },
                React.createElement('span', { style: { fontWeight: 700, fontSize: 13 } }, PLUGIN_LABEL),
                React.createElement('span', { style: { fontSize: 12, color: 'var(--text-2, #888)' } }, '· 首次设置'),
                React.createElement('span', { style: { flex: 1 } }),
                uiBtn('✕', function () { closeBoard() }, false)),
              React.createElement('div', { style: { flex: 1, minHeight: 0, overflow: 'auto', padding: 20 } },
                React.createElement('div', { style: { fontSize: 13, marginBottom: 10 } }, err ? '⚠️ 没能读到看板配置' : '正在读取看板配置…'),
                err ? React.createElement('div', { style: { fontSize: 12.5, color: TONE.err, wordBreak: 'break-all', whiteSpace: 'pre-wrap', marginBottom: 14 } }, String(err)) : null,
                React.createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                  uiBtn(err ? '重新读取' : '刷新', function () { bootOnce() }, false)))))
        }

        // 配置文件读取有问题时的一句话横幅（原样显示后端 configError）
        function cfgErrorBanner(c) {
          if (!c || !c.configError) return null
          return React.createElement('div', { style: { fontSize: 11.5, color: TONE.err, background: 'var(--danger-bg, rgba(201,42,42,.08))', border: '1px solid var(--danger-color, #c92a2a)', borderRadius: 6, padding: '7px 10px', marginBottom: 12, lineHeight: 1.7, wordBreak: 'break-all', whiteSpace: 'pre-wrap' } }, '配置文件读取有问题：' + String(c.configError))
        }
        function wizardValidateDir() {
          const D = currentDraft()
          if (!String(D.dataDir || '').trim()) { setWizMsg({ tone: 'err', text: '请先填数据目录，或点「使用默认目录」。' }); return false }
          if (!isAbsDir(D.dataDir)) { setWizMsg({ tone: 'err', text: absDirHint() }); return false }
          return true
        }
        // 向导：保存设置（不初始化，可以先去测模型）
        function wizardSave() {
          if (!wizardValidateDir()) return
          const D = currentDraft()
          setWizBusy(true)
          setWizMsg({ tone: 'info', text: '正在保存设置…' })
          fetchData('sales.configset', patchOf(D)).then(function (r) {
            setWizBusy(false)
            if (r && r.ok) {
              applyCfg(r.data || cfg)
              setWizMsg({ tone: 'ok', text: '设置已保存。可以点「初始化数据目录并开始」，或先到第三步「测试连接」。' })
            } else {
              setWizMsg({ tone: 'err', text: String((r && r.error) || '保存失败（后端没有返回原因）') })
            }
          }).catch(function (e) {
            setWizBusy(false)
            setWizMsg({ tone: 'err', text: '保存异常：' + String((e && e.message) || e) })
          })
        }
        // 向导：测试模型通道（后端测的是**已保存**的配置，所以先存 ai 补丁再测）
        function wizardTest() {
          const D = currentDraft()
          setWizBusy(true)
          setWizTest(null)
          setWizMsg({ tone: 'info', text: '正在保存模型设置并测试连接…' })
          fetchData('sales.configset', { ai: aiPatchOf(D) }).then(function (r) {
            if (!r || !r.ok) {
              setWizBusy(false)
              setWizMsg({ tone: 'err', text: String((r && r.error) || '模型设置保存失败（后端没有返回原因）') })
              return null
            }
            return fetchData('sales.configtest', {})
          }).then(function (r2) {
            if (r2 === null) return
            setWizBusy(false)
            if (r2 && r2.ok && r2.data) {
              setWizTest(r2.data)
              setWizMsg({ tone: r2.data.ok ? 'ok' : 'err', text: r2.data.ok ? '模型通道可用。' : '模型通道不可用（原因原样显示在下面）。' })
            } else {
              const t = String((r2 && r2.error) || '测试失败（后端没有返回原因）')
              setWizTest({ ok: false, error: t })
              setWizMsg({ tone: 'err', text: t })
            }
          }).catch(function (e) {
            setWizBusy(false)
            const t = '测试异常：' + String((e && e.message) || e)
            setWizTest({ ok: false, error: t })
            setWizMsg({ tone: 'err', text: t })
          })
        }
        // 初始化结果的一句话摘要（目录/建了哪些表/保留了什么/示例语料）
        function setupSummary(d) {
          if (!d) return '无需改动'
          const bits = []
          if (d.madeDirs && d.madeDirs.length) bits.push('新建目录 ' + d.madeDirs.length + ' 个')
          if (d.created && d.created.length) bits.push('新建表 ' + d.created.join('、'))
          if (d.kept && d.kept.length) bits.push('保留已有 ' + d.kept.join('、'))
          const seedN = (d.seed && d.seed.copied && d.seed.copied.length) ? d.seed.copied.length : 0
          if (seedN) bits.push('示例语料 ' + seedN + ' 份')
          if (d.seed && d.seed.error) bits.push('示例语料未复制：' + String(d.seed.error))
          const dir = String(d.dataDir || '')
          return (dir ? '数据目录 ' + dir + '；' : '') + (bits.join('；') || '无需改动')
        }
        // 向导：保存 + 初始化数据目录 → 关向导进看板（成功后不再弹结果页，只在内容区顶部留一行回执）
        function wizardFinish() {
          if (!wizardValidateDir()) return
          const D = currentDraft()
          setWizBusy(true)
          setWizMsg({ tone: 'info', text: '正在保存设置并初始化数据目录…' })
          fetchData('sales.configset', patchOf(D)).then(function (r) {
            if (!r || !r.ok) {
              setWizBusy(false)
              setWizMsg({ tone: 'err', text: String((r && r.error) || '设置保存失败（后端没有返回原因）') })
              return null
            }
            if (r.data) setCfg(r.data)
            return fetchData('sales.setup', {})
          }).then(function (s) {
            if (s === null) return
            setWizBusy(false)
            if (!s || !s.ok || !s.data) {
              setWizMsg({ tone: 'err', text: String((s && s.error) || '初始化失败（后端没有返回原因）') })
              return
            }
            applyCfg(s.data.config || cfg)
            setNotice('初始化完成：' + setupSummary(s.data))
            setWizOpen(false)
            setWizStep(0)
            setWizMsg(null)
            setWizTest(null)
            // 进看板后立刻拉一次总览（不等 30 秒轮询）
            try { loadTasks() } catch (e) {}
            try { loadSummary() } catch (e) {}
            try { loadFirstCall() } catch (e) {}
          }).catch(function (e) {
            setWizBusy(false)
            setWizMsg({ tone: 'err', text: '初始化异常：' + String((e && e.message) || e) })
          })
        }
        // 示例数据（demo）：给刚初始化完的空看板一点"看得见的内容"。
        //   生成/清除都由后端 lib 负责，前端只按 mode 调一次；清除只删它自己生成的 DEMO-xxx。
        function demoRun(mode) {
          return fetchData('sales.demo', { mode: mode })
        }
        function reloadBoard() {
          try { loadTasks() } catch (e) {}
          try { loadSummary() } catch (e) {}
          try { loadFirstCall() } catch (e) {}
        }
        // 向导里的「先生成 3 条示例看看」：保存设置 → 初始化 → 生成示例 → 关向导进看板
        function wizardDemo() {
          if (!wizardValidateDir()) return
          const D = currentDraft()
          setWizBusy(true)
          setWizMsg({ tone: 'info', text: '正在保存设置、初始化数据目录并生成示例客户…' })
          fetchData('sales.configset', patchOf(D)).then(function (r) {
            if (!r || !r.ok) throw new Error(String((r && r.error) || '设置保存失败（后端没有返回原因）'))
            if (r.data) setCfg(r.data)
            return fetchData('sales.setup', {})
          }).then(function (s) {
            if (!s || !s.ok) throw new Error(String((s && s.error) || '初始化失败（后端没有返回原因）'))
            applyCfg(s.data.config || cfg)
            return demoRun('seed')
          }).then(function (d) {
            setWizBusy(false)
            if (!d || !d.ok) {
              setWizMsg({ tone: 'err', text: '数据目录已建好，但示例数据没生成：' + String((d && d.error) || '后端没有返回原因') })
              return
            }
            setNotice('已生成 3 条示例客户（不是真实数据，可一键清除）。在「⚙ 设置 → 示例数据」里清除。')
            setWizOpen(false)
            setWizStep(0)
            setWizMsg(null)
            setWizTest(null)
            reloadBoard()
          }).catch(function (e) {
            setWizBusy(false)
            setWizMsg({ tone: 'err', text: '初始化异常：' + String((e && e.message) || e) })
          })
        }
        function skipWizard() {
          setWizOpen(false)
          setWizMsg(null)
          setCfg(function (prev) { return prev ? Object.assign({}, prev, { configError: '' }) : prev })
        }
        // 首次设置向导（三步：数据目录 / 公司与产品 / 模型通道）
        function setupWizard(c) {
          const D = currentDraft()
          const steps = ['① 数据目录', '② 公司与产品', '③ 模型通道']
          const chips = React.createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 } },
            steps.map(function (s, i) {
              const on = wizStep === i
              const done = wizStep > i
              return React.createElement('div', {
                key: 'st-' + i,
                style: {
                  fontSize: 11.5, padding: '3px 9px', borderRadius: 999,
                  border: '1px solid ' + (on ? 'var(--accent-bd, rgba(37,99,235,.55))' : 'var(--border-weak, rgba(128,128,128,.35))'),
                  background: on ? 'var(--accent-tint, rgba(37,99,235,.15))' : 'transparent',
                  color: on ? 'var(--accent, #2563eb)' : (done ? TONE.ok : 'var(--text-2, #888)'),
                  fontWeight: on ? 700 : 500,
                },
              }, s)
            }))
          let body = null
          if (wizStep === 0) {
            body = React.createElement('div', {},
              uiField('数据目录（绝对路径）',
                React.createElement('input', { value: D.dataDir, placeholder: '例如 D:/我的销售数据（建议直接用下面的默认值）', onChange: function (e) { patchDraft('dataDir', e.target.value) }, style: uiInput() }),
                '销售数据只存在这台电脑的这个目录里；也可以设置环境变量 SALE_DIR（优先于配置文件）。目录不存在会自动创建，已有文件一律保留。'),
              React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: -4, marginBottom: 8 } },
                uiBtn('使用默认目录', function () { patchDraft('dataDir', String(c.defaultDataDir || '')) }, false),
                React.createElement('span', { style: { fontSize: 11, color: 'var(--text-3, #999)', wordBreak: 'break-all' } }, '默认：' + String(c.defaultDataDir || '（后端未提供，请自己填绝对路径）'))))
          } else if (wizStep === 1) {
            body = React.createElement('div', {},
              uiField('公司名（可留空）',
                React.createElement('input', { value: D.profile.company, placeholder: '例如 某某咨询有限公司', onChange: function (e) { patchProfile('company', e.target.value) }, style: uiInput() }),
                '留空则 AI 不注入业务背景，看板照常可用。'),
              uiField('产品名（可留空）',
                React.createElement('input', { value: D.profile.product, placeholder: '例如 AI智写 / AI智算 / 企业级智能体', onChange: function (e) { patchProfile('product', e.target.value) }, style: uiInput() }),
                '只用于看板内的提示与导出抬头，不上传。'))
          } else {
            body = React.createElement('div', {},
              modeRadios(),
              React.createElement('div', { style: { marginBottom: 8 } }, modeFields()),
              React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                uiBtn(wizBusy ? '测试中…' : '测试连接', function () { wizardTest() }, false, wizBusy),
                React.createElement('span', { style: { fontSize: 11, color: 'var(--text-3, #999)' } }, '会先把当前模型设置保存，再真发一次极短请求（几个 token）。')),
              testLine(wizTest))
          }
          const foot = React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', paddingTop: 12, marginTop: 4, borderTop: '1px solid var(--border-weak, rgba(128,128,128,.25))', flex: '0 0 auto' } },
            wizStep > 0 ? uiBtn('← 上一步', function () { setWizStep(wizStep - 1); setWizMsg(null) }, false, wizBusy) : null,
            wizStep < 2 ? uiBtn('下一步 →', function () { if (wizardValidateDir()) { setWizStep(wizStep + 1); setWizMsg(null) } }, false, wizBusy) : null,
            React.createElement('span', { style: { flex: 1 } }),
            (c.configured && c.configError) ? uiBtn('暂时跳过，直接进入看板', function () { skipWizard() }, false, wizBusy) : null,
            wizStep === 2 ? uiBtn('先生成 3 条示例看看', function () { wizardDemo() }, false, wizBusy) : null,
            uiBtn(wizBusy ? '处理中…' : '保存设置', function () { wizardSave() }, false, wizBusy),
            uiBtn(wizBusy ? '处理中…' : '初始化数据目录并开始', function () { wizardFinish() }, true, wizBusy))
          return React.createElement(BoardErrorBoundary, null,
            React.createElement('div', { style: overlayShell() },
              React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--border-weak, rgba(128,128,128,.25))', flex: '0 0 auto' } },
                React.createElement('span', { style: { fontWeight: 700, fontSize: 13 } }, PLUGIN_LABEL),
                React.createElement('span', { style: { fontSize: 12, color: 'var(--text-2, #888)' } }, '· 首次设置'),
                React.createElement('span', { style: { flex: 1 } }),
                uiBtn('✕ 关闭', function () { closeBoard() }, false)),
              React.createElement('div', { style: { flex: 1, minHeight: 0, overflow: 'auto', padding: 20 } },
                React.createElement('div', { style: { maxWidth: 620, margin: '0 auto' } },
                  React.createElement('div', { style: { fontSize: 15, fontWeight: 700, marginBottom: 4 } }, '先把这个看板接到你的数据目录上'),
                  React.createElement('div', { style: { fontSize: 11.5, color: 'var(--text-2, #888)', lineHeight: 1.7, marginBottom: 14 } }, '三步就能开始：填目录 → 填公司与产品（可留空）→ 选模型通道。所有设置只写在这台电脑的配置文件里。'),
                  chips,
                  cfgErrorBanner(c),
                  body,
                  uiMsgEl(wizMsg),
                  foot))))
        }

        // ⚙ 设置面板：回显 + 改设置 + 只读诊断（配置文件路径/来源/目录/当前模型/RAG 块数）
        function openPanel() {
          setPanelOpen(true)
          setPanelMsg(null)
          setPanelTest(null)
          setDraft(draftOf(cfg))
          loadDiag()
        }
        function loadDiag() {
          setDiag(null)
          fetchData('sales.egress', {}).then(function (r) {
            if (r && r.ok && r.data && r.data.rag) setDiag(r.data.rag)
            else setDiag({ error: String((r && r.error) || '读取失败'), enabled: null, chunks: null })
          }).catch(function (e) { setDiag({ error: String((e && e.message) || e), enabled: null, chunks: null }) })
        }
        function panelSave() {
          const D = currentDraft()
          setPanelMsg({ tone: 'info', text: '正在保存…' })
          fetchData('sales.configset', patchOf(D)).then(function (r) {
            if (r && r.ok) {
              applyCfg(r.data || cfg)
              setPanelMsg({ tone: 'ok', text: '已保存。改动即时生效：看板下一次请求就走新设置。' })
              loadDiag()
            } else {
              // 后端 error 原样显示（相对路径会被后端拒，并附带"已保存其它设置"的说明）
              setPanelMsg({ tone: 'err', text: String((r && r.error) || '保存失败（后端没有返回原因）') })
            }
          }).catch(function (e) {
            setPanelMsg({ tone: 'err', text: '保存异常：' + String((e && e.message) || e) })
          })
        }
        function panelTestConn() {
          const D = currentDraft()
          setPanelTest(null)
          setPanelMsg({ tone: 'info', text: '正在保存模型设置并测试连接…' })
          fetchData('sales.configset', { ai: aiPatchOf(D) }).then(function (r) {
            if (!r || !r.ok) {
              setPanelMsg({ tone: 'err', text: String((r && r.error) || '模型设置保存失败（后端没有返回原因）') })
              return null
            }
            return fetchData('sales.configtest', {})
          }).then(function (r2) {
            if (r2 === null) return
            if (r2 && r2.ok && r2.data) {
              setPanelTest(r2.data)
              setPanelMsg({ tone: r2.data.ok ? 'ok' : 'err', text: r2.data.ok ? '模型通道可用。' : '模型通道不可用（原因原样显示在下面）。' })
            } else {
              const t = String((r2 && r2.error) || '测试失败（后端没有返回原因）')
              setPanelTest({ ok: false, error: t })
              setPanelMsg({ tone: 'err', text: t })
            }
          }).catch(function (e) {
            const t = '测试异常：' + String((e && e.message) || e)
            setPanelTest({ ok: false, error: t })
            setPanelMsg({ tone: 'err', text: t })
          })
        }
        function initFromPanel() {
          const D = currentDraft()
          setPanelMsg({ tone: 'info', text: '正在保存设置并初始化数据目录…' })
          fetchData('sales.configset', patchOf(D)).then(function (r) {
            if (!r || !r.ok) {
              setPanelMsg({ tone: 'err', text: String((r && r.error) || '设置保存失败（后端没有返回原因）') })
              return null
            }
            if (r.data) setCfg(r.data)
            return fetchData('sales.setup', {})
          }).then(function (s) {
            if (s === null) return
            if (!s || !s.ok || !s.data) {
              setPanelMsg({ tone: 'err', text: String((s && s.error) || '初始化失败（后端没有返回原因）') })
              return
            }
            applyCfg(s.data.config || cfg)
            setNotice('初始化完成：' + setupSummary(s.data))
            setPanelMsg({ tone: 'ok', text: '初始化完成。' })
            loadDiag()
          }).catch(function (e) {
            setPanelMsg({ tone: 'err', text: '初始化异常：' + String((e && e.message) || e) })
          })
        }
        // 设置面板里的「示例数据」：生成 / 清除（清除只删 DEMO-xxx，真实客户不动）
        function panelDemo(mode) {
          setPanelMsg({ tone: 'info', text: mode === 'clean' ? '正在清除示例数据…' : '正在生成示例客户…' })
          demoRun(mode).then(function (r) {
            if (!r || !r.ok) { setPanelMsg({ tone: 'err', text: String((r && r.error) || '操作失败（后端没有返回原因）') }); return }
            const d = r.data || {}
            let text
            if (mode === 'clean') text = d.changed ? ('已清除示例客户 ' + (d.removed || 0) + ' 条；真实客户没动。') : '没有示例数据需要清除。'
            else text = d.already ? '示例数据已经生成过了，没有重复写入。' : ('已生成示例客户 ' + (d.created || 0) + ' 条。')
            setPanelMsg({ tone: 'ok', text: text })
            reloadBoard()
            loadDiag()
          }).catch(function (e) {
            setPanelMsg({ tone: 'err', text: '操作异常：' + String((e && e.message) || e) })
          })
        }
        function settingsPanel() {
          const D = currentDraft()
          const c = cfg || {}
          const envNote = c.source === 'env'
          const rows = [
            ['配置文件', String(c.configFile || '（未知）')],
            ['生效来源', String(SRC_LABEL[c.source] || c.source || '（未知）')],
            ['数据目录', String(c.dataDir || '（未设置）')],
            ['目录是否存在', c.dataDirExists ? '是' : '否'],
            ['默认目录', String(c.defaultDataDir || '（后端未提供）')],
            ['当前模型', modelSummary(c)],
            ['RAG 语料', ragLine()],
          ]
          const body = React.createElement('div', { style: { flex: 1, minHeight: 0, overflow: 'auto', padding: 20 } },
            React.createElement('div', { style: { maxWidth: 680, margin: '0 auto' } },
              uiSection('数据目录', React.createElement('div', {},
                uiField('数据目录（绝对路径）',
                  React.createElement('input', { value: D.dataDir, placeholder: '绝对路径，例如 D:/我的销售数据', onChange: function (e) { patchDraft('dataDir', e.target.value) }, style: uiInput() }),
                  '改完点底部「保存设置」生效；目录不存在时点「初始化数据目录」会自动建目录和空表。'),
                React.createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
                  uiBtn('使用默认目录', function () { patchDraft('dataDir', String(c.defaultDataDir || '')) }, false),
                  uiBtn('初始化数据目录', function () { initFromPanel() }, false)),
                envNote ? React.createElement('div', { style: { fontSize: 11.5, color: TONE.info, lineHeight: 1.7, marginTop: 8 } }, '环境变量 SALE_DIR 优先：当前生效的数据目录来自环境变量，改配置不会生效；要改请改环境变量后重启 DSH。') : null)),
              uiSection('公司与产品（可留空）', React.createElement('div', {},
                uiField('公司名', React.createElement('input', { value: D.profile.company, placeholder: '例如 某某咨询有限公司', onChange: function (e) { patchProfile('company', e.target.value) }, style: uiInput() })),
                uiField('产品名', React.createElement('input', { value: D.profile.product, placeholder: '例如 AI智写 / AI智算 / 企业级智能体', onChange: function (e) { patchProfile('product', e.target.value) }, style: uiInput() }), '留空则 AI 不注入业务背景。'))),
              uiSection('模型通道', React.createElement('div', {},
                modeRadios(),
                React.createElement('div', { style: { marginBottom: 8 } }, modeFields()),
                React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                  uiBtn('测试连接', function () { panelTestConn() }, false),
                  React.createElement('span', { style: { fontSize: 11, color: 'var(--text-3, #999)' } }, '会先保存模型设置，再真发一次极短请求。')),
                testLine(panelTest))),
              uiSection('功能开关', React.createElement('label', { style: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 12.5, flexWrap: 'wrap' } },
                React.createElement('input', { type: 'checkbox', checked: D.features.rag, onChange: function (e) { patchFeatures({ rag: !!e.target.checked }) }, style: { accentColor: THEME.blue } }),
                React.createElement('span', {}, '启用 RAG（检索本地语料辅助写作）'),
                React.createElement('span', { style: { fontSize: 11, color: 'var(--text-3, #999)' } }, '关闭后 AI 只靠模型自身知识'))),
              uiSection('示例数据', React.createElement('div', {},
                React.createElement('div', { style: { fontSize: 11.5, color: 'var(--text-2, #888)', lineHeight: 1.7, marginBottom: 8 } },
                  '想先看看看板长什么样？可以生成 3 条示例客户（公司名带「示例」字样、电话是示例号段，不是真实数据）。清除只删这 3 条，碰不到你自己录的客户。'),
                React.createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
                  uiBtn('生成示例数据', function () { panelDemo('seed') }, false),
                  uiBtn('清除示例数据', function () { panelDemo('clean') }, false)))),
              uiSection('诊断（只读）', React.createElement('div', {}, rows.map(function (kv) { return uiKV(kv[0], kv[1]) }))),
              uiMsgEl(panelMsg)))
          return React.createElement('div', { key: 'sales-settings-panel', style: panelShell() },
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--border-weak, rgba(128,128,128,.25))', flex: '0 0 auto' } },
              React.createElement('span', { style: { fontWeight: 700, fontSize: 13 } }, '⚙ 设置'),
              React.createElement('span', { style: { fontSize: 11.5, color: 'var(--text-2, #888)' } }, '数据目录 / 模型通道 / RAG / 公司与产品'),
              React.createElement('span', { style: { flex: 1 } }),
              uiBtn('✕', function () { setPanelOpen(false) }, false)),
            body,
            React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '10px 20px', borderTop: '1px solid var(--border-weak, rgba(128,128,128,.25))', flex: '0 0 auto' } },
              uiBtn('保存设置', function () { panelSave() }, true),
              uiBtn('关闭', function () { setPanelOpen(false) }, false)))
        }

        // ===== 2026-11-11（1.3.0）：客户档案卡 + 手机号识别 + SOP 归段 =====
        function phoneKey(p) {
          const m = String(p == null ? '' : p).match(/1\d{10}/)
          if (m) return m[0]
          return String(p == null ? '' : p).replace(/[^0-9]/g, '')
        }
        function profileFieldsFrom(c, rec) {
          const p = (rec && rec.profile) || {}
          const d = (rec && rec.derived) || {}
          const g = (k, fb) => { const v = p[k]; return (v === undefined || v === null) ? String(fb == null ? '' : fb) : String(v) }
          return {
            intro: g('intro', ''),
            industry: g('industry', (c && c.industry) || ''),
            scale: g('scale', (c && c.scale) || ''),
            people: g('people', [d.name, d.contact].filter(Boolean).join(' / ')),
            chain: g('chain', ''),
            need: g('need', (c && c.need) || ''),
            product: g('product', (c && c.product) || ''),
            budget: g('budget', (c && c.budget) || ''),
            rival: g('rival', ''),
            compliance: g('compliance', ''),
            strategy: g('strategy', ''),
          }
        }
        // 档案列表一次取回按手机号建索引（列表接口不支持时就退回"点开档案时单条 get"）
        function loadProfiles() {
          fetchData('profile', { action: 'list' }).then(function (r) {
            if (!r || !r.ok) return
            const d = r.data || {}
            const arr = Array.isArray(d.profiles) ? d.profiles : (Array.isArray(d.list) ? d.list : (Array.isArray(d.items) ? d.items : (Array.isArray(d) ? d : [])))
            const map = {}
            arr.forEach(function (it) {
              if (!it || typeof it !== 'object') return
              const k = phoneKey(it.phone || (it.customer && it.customer.phone) || '')
              if (!k) return
              map[k] = { profile: it.profile || it.fields || null, derived: it.derived || null }
            })
            setProfiles(map)
          }).catch(function () { /* 列不出来不影响看板：点「📝 档案」时单条取 */ })
        }
        function openProfileEdit(c) {
          const k = phoneKey(c && c.phone)
          if (!k) return
          if (profEdit && profEdit.phone === k) { setProfEdit(null); return }
          const rec = profiles[k]
          setProfEdit({ phone: k, name: (c && c.name) || '', customer: c, fields: profileFieldsFrom(c, rec), busy: false, aiBusy: false, loading: !rec, msg: null })
          if (rec) return
          fetchData('profile', { action: 'get', phone: k }).then(function (r) {
            if (!r || !r.ok) {
              setProfEdit(function (p) {
                return (p && p.phone === k) ? Object.assign({}, p, { loading: false, msg: { tone: 'err', text: '档案读取失败：' + String((r && r.error) || '后端没有返回原因') + '（不影响填写，保存时会再写一次）' } }) : p
              })
              return
            }
            const d = r.data || {}
            setProfiles(function (prev) { const n = Object.assign({}, prev); n[k] = { profile: d.profile || null, derived: d.derived || null }; return n })
            setProfEdit(function (p) {
              return (p && p.phone === k) ? Object.assign({}, p, { loading: false, fields: profileFieldsFrom(p.customer || c, { profile: d.profile, derived: d.derived }) }) : p
            })
          }).catch(function (e) {
            setProfEdit(function (p) {
              return (p && p.phone === k) ? Object.assign({}, p, { loading: false, msg: { tone: 'err', text: '档案读取异常：' + String((e && e.message) || e) } }) : p
            })
          })
        }
        function patchProfField(k, v) {
          setProfEdit(function (p) { if (!p) return p; const f = Object.assign({}, p.fields); f[k] = v; return Object.assign({}, p, { fields: f }) })
        }
        function saveProfileEdit() {
          const pe = profEdit
          if (!pe || pe.busy) return
          setProfEdit(Object.assign({}, pe, { busy: true, msg: { tone: 'info', text: '正在保存…' } }))
          fetchData('profile', { action: 'set', phone: pe.phone, fields: pe.fields }).then(function (r) {
            if (!r || !r.ok) {
              setProfEdit(function (p) {
                return (p && p.phone === pe.phone) ? Object.assign({}, p, { busy: false, msg: { tone: 'err', text: '没保存成功：' + String((r && r.error) || '后端没有返回原因') } }) : p
              })
              return
            }
            const d = r.data || {}
            const prof = d.profile || pe.fields
            setProfiles(function (prev) {
              const n = Object.assign({}, prev)
              n[pe.phone] = Object.assign({}, (prev[pe.phone] || {}), { profile: prof })
              return n
            })
            setProfEdit(Object.assign({}, pe, {
              busy: false,
              fields: profileFieldsFrom(pe.customer, { profile: prof, derived: (profiles[pe.phone] || {}).derived }),
              msg: { tone: 'ok', text: '已保存到客户档案（只按手机号关联，不动客户表其它列）' },
            }))
          }).catch(function (e) {
            setProfEdit(function (p) {
              return (p && p.phone === pe.phone) ? Object.assign({}, p, { busy: false, msg: { tone: 'err', text: '保存异常：' + String((e && e.message) || e) } }) : p
            })
          })
        }
        function aiProfileFill() {
          const pe = profEdit
          if (!pe || pe.aiBusy) return
          setProfEdit(Object.assign({}, pe, { aiBusy: true, msg: { tone: 'info', text: 'AI 正在从客户表/流水里提炼档案…' } }))
          fetchData('ai', { purpose: 'profile', phone: pe.phone }).then(function (r) {
            if (!r || !r.ok) {
              setProfEdit(function (p) {
                return (p && p.phone === pe.phone) ? Object.assign({}, p, { aiBusy: false, msg: { tone: 'err', text: 'AI 提炼失败：' + String((r && r.error) || '后端没有返回原因') } }) : p
              })
              return
            }
            const txt = String((r.data && r.data.text) || '').trim()
            if (!txt) {
              setProfEdit(function (p) {
                return (p && p.phone === pe.phone) ? Object.assign({}, p, { aiBusy: false, msg: { tone: 'err', text: 'AI 没给出内容（返回是空的）' } }) : p
              })
              return
            }
            // 模型可能回 JSON（键＝档案字段）→ 按键回填；也可能回一段话 → 整段放进「一句话介绍」。
            let patch = null
            try {
              const s = txt.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
              const o = JSON.parse(s)
              if (o && typeof o === 'object' && !Array.isArray(o)) {
                patch = {}
                PROFILE_FIELDS_UI.forEach(function (f) { if (typeof o[f[0]] === 'string' && o[f[0]].trim()) patch[f[0]] = o[f[0]] })
                if (!Object.keys(patch).length) patch = null
              }
            } catch (e) { patch = null }
            setProfEdit(function (p) {
              if (!p || p.phone !== pe.phone) return p
              const f = Object.assign({}, p.fields)
              if (patch) Object.assign(f, patch)
              else f.intro = (f.intro ? f.intro + '\n' : '') + txt
              return Object.assign({}, p, {
                aiBusy: false,
                fields: f,
                msg: { tone: 'ok', text: patch ? ('已把 AI 提炼的 ' + Object.keys(patch).length + ' 个字段填进表单——还没落盘，确认后再点「保存档案」') : '已把 AI 提炼内容填进「一句话介绍」——还没落盘，改完再点「保存档案」' },
              })
            })
          }).catch(function (e) {
            setProfEdit(function (p) {
              return (p && p.phone === pe.phone) ? Object.assign({}, p, { aiBusy: false, msg: { tone: 'err', text: 'AI 提炼异常：' + String((e && e.message) || e) } }) : p
            })
          })
        }
        function profileLine(label, val) {
          const v = String(val == null ? '' : val).trim()
          if (!v) return null
          return React.createElement('div', { key: 'pl' + label, style: { display: 'flex', gap: 6, fontSize: 11, lineHeight: 1.5 } },
            React.createElement('span', { style: { color: THEME.text3, flexShrink: 0 } }, label),
            React.createElement('span', { style: { color: THEME.text1, wordBreak: 'break-word', overflowWrap: 'anywhere' } }, v))
        }
        // 区域一的档案卡（只读）：intro / 行业·规模·城市·来源 / 决策人与决策链 / 需求 / 产品·预算·竞对·合规·打法
        function profileCard(c) {
          const k = phoneKey(c && c.phone)
          if (!k) {
            return React.createElement('div', { style: { marginTop: 3, fontSize: 11, color: THEME.warn } },
              '⚠ 缺手机号：客户表里补上手机号才能建档/归段（手机号是客户主键）')
          }
          const rec = profiles[k]
          const p = (rec && rec.profile) || {}
          const d = (rec && rec.derived) || {}
          const fallback = [p.industry || (c && c.industry), p.scale || (c && c.scale),
            (c && c.city && c.city !== '未知') ? c.city : '', (c && c.source) || ''].filter(Boolean).join(' · ')
          const lines = [
            p.intro ? React.createElement('div', { key: 'intro', style: { fontSize: 11, lineHeight: 1.55, color: THEME.text1, whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowWrap: 'anywhere' } }, p.intro) : null,
            profileLine('行业/规模/城市/来源', fallback),
            profileLine('决策人', p.people || [d.name, d.contact].filter(Boolean).join(' / ')),
            profileLine('决策链', p.chain),
            profileLine('需求', p.need),
            profileLine('产品', p.product),
            profileLine('预算', p.budget),
            profileLine('竞对', p.rival),
            profileLine('合规', p.compliance),
            profileLine('打法', p.strategy),
          ].filter(Boolean)
          return React.createElement('div', { style: { marginTop: 3, padding: '5px 8px', borderRadius: 6, background: 'rgba(64,192,120,.05)', border: '1px dashed rgba(64,192,120,.3)', display: 'flex', flexDirection: 'column', gap: 2 } },
            React.createElement('div', { style: { fontSize: 10.5, color: THEME.ok, fontWeight: 600 } },
              '📇 档案' + (lines.length ? '' : '（还没有档案：点「📝 档案」建一份，或让 AI 提炼）')),
            lines.length ? React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 1 } }, lines) : null)
        }
        // 档案编辑面板（11 字段 + AI 提炼 + 保存）
        function profileEditPanel(c) {
          const pe = profEdit
          if (!pe || pe.phone !== phoneKey(c && c.phone)) return null
          const ctlStyle = { width: '100%', boxSizing: 'border-box', background: 'var(--row-bg, rgba(128,128,128,.06))', color: THEME.text1, border: '1px solid ' + THEME.border, borderRadius: 6, padding: '3px 6px', fontSize: 11.5, fontFamily: 'inherit', resize: 'vertical' }
          const inputs = PROFILE_FIELDS_UI.map(function (f) {
            const key = f[0], label = f[1]
            const val = String((pe.fields || {})[key] || '')
            const big = key === 'intro' || key === 'need' || key === 'strategy' || key === 'chain'
            return React.createElement('label', { key: key, style: { display: 'flex', flexDirection: 'column', gap: 2 } },
              React.createElement('span', { style: { fontSize: 10.5, color: THEME.text3 } }, label),
              big
                ? React.createElement('textarea', { value: val, rows: 2, onChange: (e) => patchProfField(key, e.target.value), style: ctlStyle })
                : React.createElement('input', { type: 'text', value: val, onChange: (e) => patchProfField(key, e.target.value), style: ctlStyle }))
          })
          const msgColor = pe.msg ? (pe.msg.tone === 'err' ? THEME.danger : (pe.msg.tone === 'ok' ? THEME.ok : THEME.text2)) : THEME.text2
          return React.createElement('div', { style: { marginTop: 4, padding: '8px 10px', background: 'rgba(64,192,120,.06)', borderRadius: 6, border: '1px solid rgba(64,192,120,.35)', fontSize: 12 } },
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, flexWrap: 'wrap' } },
              React.createElement('span', { style: { fontWeight: 700, color: THEME.ok } }, '📝 客户档案 · ' + (pe.name || '') + ' · ' + pe.phone),
              pe.loading ? React.createElement('span', { style: { fontSize: 10.5, color: THEME.text3 } }, '读取中…') : null,
              React.createElement('span', { style: { fontSize: 10.5, color: THEME.text3 } }, '手机号是主键（只读）；这里只写档案，不动客户表其它列')),
            React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 6 } }, inputs),
            pe.msg ? React.createElement('div', { style: { marginTop: 6, fontSize: 11, color: msgColor } }, pe.msg.text) : null,
            React.createElement('div', { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
              React.createElement('button', { onClick: saveProfileEdit, disabled: !!pe.busy, title: '保存到客户档案（按手机号关联）', style: { background: 'rgba(64,192,120,.18)', border: '1px solid rgba(64,192,120,.5)', borderRadius: 6, padding: '4px 10px', cursor: pe.busy ? 'default' : 'pointer', color: THEME.text1, fontSize: 12 } }, pe.busy ? '保存中…' : '💾 保存档案'),
              React.createElement('button', { onClick: aiProfileFill, disabled: !!pe.aiBusy, title: '让 AI 从客户表/流水里提炼一份草稿（只填表单，不落盘）', style: { background: 'rgba(80,120,255,.14)', border: '1px solid rgba(80,120,255,.45)', borderRadius: 6, padding: '4px 10px', cursor: pe.aiBusy ? 'default' : 'pointer', color: THEME.text1, fontSize: 12 } }, pe.aiBusy ? 'AI 提炼中…' : '🧠 AI 提炼（需确认）'),
              React.createElement('button', { onClick: () => setProfEdit(null), style: { background: 'none', border: '1px solid ' + THEME.border, borderRadius: 6, padding: '4px 10px', cursor: 'pointer', color: THEME.text2, fontSize: 12 } }, '关闭')),
            React.createElement('div', { style: { marginTop: 4, fontSize: 10.5, color: THEME.text3 } }, 'AI 提炼只填表单、不自动落盘；确认内容后点「保存档案」才写。'))
        }
        // SOP 归段下拉：13 段 + 出口 + 其他跟进记录；选完立刻调 stagefix，成功后重拉该客户 SOP
        function stageFixSelect(c, rec) {
          const k = phoneKey(c && c.phone)
          const key = k + '|' + String((rec && rec.id) || '')
          const busy = stageBusy === key
          const cur = String((rec && rec.stage) || '')
          const opts = SOP_STAGE_FIX.slice()
          if (cur && opts.indexOf(cur) === -1) opts.unshift(cur)
          return React.createElement('select', {
            key: 'fix' + String((rec && rec.id) || ''),
            value: cur,
            disabled: !k || busy,
            title: k ? '归段：把这条跟进挪进 SOP 的哪一段（选完立刻保存）' : '客户表里没有手机号，没法归段',
            onChange: (e) => stageFix(c, rec, e.target.value),
            style: { flexShrink: 0, fontSize: 10.5, maxWidth: 118, background: 'var(--row-bg, rgba(128,128,128,.06))', color: THEME.text1, border: '1px solid ' + THEME.border, borderRadius: 5, padding: '1px 2px' },
          },
            React.createElement('option', { value: '' }, busy ? '保存中…' : '归段…'),
            opts.map(function (o) { return React.createElement('option', { key: o, value: o }, o) }))
        }
        function stageFix(c, rec, stage) {
          const k = phoneKey(c && c.phone)
          if (!k) { setStageMsg({ tone: 'err', text: '这个客户没有手机号，没法归段' }); return }
          if (!stage) return
          const key = k + '|' + String((rec && rec.id) || '')
          setStageBusy(key); setStageMsg(null)
          fetchData('stagefix', { phone: k, flowId: (rec && rec.id), stage: stage }).then(function (r) {
            setStageBusy('')
            if (!r || !r.ok) {
              setStageMsg({ tone: 'err', text: '归段没成功：' + String((r && r.error) || '后端没有返回原因') })
              return
            }
            const d = r.data || {}
            setStageMsg({ tone: 'ok', text: '已归段：' + String(d.from || '（空）') + ' → ' + String(d.to || stage) })
            try { loadSop(c.id) } catch (e) {}
          }).catch(function (e) {
            setStageBusy('')
            setStageMsg({ tone: 'err', text: '归段异常：' + String((e && e.message) || e) })
          })
        }

        // 2026-10-22 用户：「只展示小数点后两位，单位定为万元」——金额一律走 fmtWan2，
        //   库里存元（累加会有 73296.49999999999 这种浮点尾巴），展示时先按分四舍五入再换算；
        //   数字卡把单位写在卡片标题里（「付款合计（万元）」），数字只留两位小数。
        const fmtWan2 = (v) => {
          const n = Number(String(v == null ? '' : v).replace(/[^\d.\-]/g, ''))
          if (!isFinite(n)) return '0.00'
          return (Math.round(n * 100) / 100 / 10000).toFixed(2)
        }
        // 数字卡（科技简约：平面 + 1px 描边 + 等宽数字，不用投影）
        const Num = (p) => React.createElement('div', { style: { background: THEME.chipBg, border: '1px solid ' + THEME.border, borderRadius: 6, padding: '7px 14px', minWidth: 74, textAlign: 'center' } },
          React.createElement('div', { style: { fontSize: 19, fontWeight: 600, letterSpacing: '-.2px', fontVariantNumeric: 'tabular-nums', color: THEME.text1 } }, String(p.v)),
          React.createElement('div', { style: { fontSize: 11, color: THEME.text2, marginTop: 1 } }, p.k))

        // 意向/用量数据标签：客户信息里**重点展示「最后登陆时间」+ 智写/智算使用情况**（2026-10-22 用户改口径）
        //   2026-09-29 用户曾拍板把「最后登录时间」从展示里剔掉（当时导出表半个月一次、显示/使用都会误判）；
        //   2026-10-21 起平台导入每次都带 last 与用量（用量快照 refreshedAt=2026-10-21），数据够新 → 恢复展示。
        //   口径边界不变：最后登陆 / 智写登录次数**只做事实展示**，不参与判定、优先级、话术（销售数据标准 13.1）。
        function intentTags(c) {
          if (!c) return ''
          const parts = []
          const today = new Date()
          // 2026-09-14 加固: 后端已按 YYYY-MM-DD 归一，这里再兜一层（兼容历史值/Excel 序列号），
          //   避免序列号让「近期登录 / 到期」标签静默消失（与 sales-lib 日期口径同源）
          const daysAgo = (ds) => {
            let s = String(ds == null ? '' : ds).trim()
            if (/^\d{5}$/.test(s)) {
              const n = Number(s)
              const dt = new Date(Date.UTC(1899, 11, 30) + n * 86400000)
              s = dt.getUTCFullYear() + '-' + String(dt.getUTCMonth() + 1).padStart(2, '0') + '-' + String(dt.getUTCDate()).padStart(2, '0')
            }
            const m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/)
            if (!m) return null
            const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
            return Math.floor((today - d) / 86400000)
          }
          const fmtWan = (n) => (Number(n) >= 10000 ? (Number(n) / 10000).toFixed(1).replace(/\.0$/, '') + '万' : String(Number(n) || 0))
          // ① 最后登陆（重点）：今天/昨天/30 天内给"N 天前"，更早直接给日期（别把 200 天算成"200天前"）
          if (c.lastLogin) {
            const ld = daysAgo(c.lastLogin)
            const md = String(c.lastLogin).slice(5)
            if (ld === 0) parts.push('最后登陆 今天')
            else if (ld === 1) parts.push('最后登陆 昨天')
            else if (ld !== null && ld > 1 && ld <= 30) parts.push('最后登陆 ' + md + '（' + ld + '天前）')
            else parts.push('最后登陆 ' + md)
          } else parts.push('最后登陆 无记录')
          // ② 智写/智算使用情况（重点）：智算次数 · 智写消耗/剩余 · 文章篇数 · 已购字数 · 本期增量
          const u = []
          if (c.zhisuan > 0) u.push('智算' + c.zhisuan + '次')
          if (c.zxUsed > 0) u.push('智写' + fmtWan(c.zxUsed) + '字')
          if (c.zxRemain > 0) u.push('余' + fmtWan(c.zxRemain) + '字')
          if (c.zxDone > 0) u.push('文章' + c.zxDone + '篇')
          if (c.zxBuy > 0) u.push('已购' + fmtWan(c.zxBuy) + '字')
          const dl = c.delta || null
          if (dl && Number(dl.dCost) > 0) u.push('本期消耗+' + fmtWan(dl.dCost) + '字')
          if (dl && Number(dl.dArt) > 0) u.push('本期文章+' + dl.dArt)
          parts.push(u.length ? '✍️' + u.join('·') : '✍️未使用')
          // ③ 到期时间（临期提醒：30天内到期标橙）
          if (c.expire) {
            const ed = daysAgo(c.expire)
            if (ed !== null && ed < 0 && ed >= -30) parts.push('⏳' + (-ed) + '天后到期')
            else if (ed !== null && ed >= 0) parts.push('⚠️已到期' + ed + '天')
          }
          if (c.reg) parts.push('注册' + c.reg.slice(5))
          return parts.join(' · ')
        }

        // SOP 阶段徽章(2026-09-29；2026-10-08 扩 13 段): 当前阶段一眼可见
        //   成交/私有化签约=绿；出口(无法联系/推进终止)=红；企业级 6 段=金；标品 1-7 段=蓝
        function stageColor(s) {
          if (s === '成交签约' || s === '私有化签约') return THEME.ok
          if (s === '无法联系' || s === '推进终止') return THEME.danger
          if (STAGE_ENT_UI.indexOf(s) >= 0) return THEME.gold
          return THEME.blue
        }
        function stageTag(c) {
          const s = c && c.stage
          if (!s) return null
          const col = stageColor(s)
          return React.createElement('span', { key: 'stagetag', style: { fontSize: 10, color: col, border: '1px solid ' + col, borderRadius: 4, padding: '0 4px', flexShrink: 0, opacity: .95 } }, s)
        }
        // 结果徽章(2026-10-08 用户定「每个客户都要有个结果」)：只标"需要动手"的结果，
        //   推进中不占位（段位徽章已经说明进度）；停住·无锚点=黑色黑洞，必须显红让他点掉。
        function resultTag(c) {
          const r = c && c.result
          if (!r || r === '推进中') return null
          const map = {
            '停住·无锚点': [THEME.danger, '停住·无锚点'],
            '沉默等需求': [THEME.warn, '沉默·等需求'],
            '暂缓': [THEME.warn, '暂缓'],
            '成交签约': [THEME.ok, '已成交'],
            '无法联系': [THEME.danger, '无法联系'],
            '推进终止': [THEME.danger, '推进终止'],
            '未开始': [THEME.text3, '未开始'],
          }
          const m = map[r]
          if (!m) return null
          const label = (r === '暂缓' && c.anchor) ? '暂缓·' + String(c.anchor).slice(5) : m[1]
          return React.createElement('span', { key: 'resulttag', style: { fontSize: 10, color: m[0], border: '1px solid ' + m[0], borderRadius: 4, padding: '0 4px', flexShrink: 0, opacity: .95 } }, label)
        }
        // 赛道徽章(2026-10-08 用户总体计划：标品→企业级 双轨 + 培育轨)
        //   只标"要换打法"的赛道：标品漏斗是常规盘子、出口已有结果徽章，都不占位。
        //   企业级·直谈/升级=金（走企业级落地那套动作）；信任期=绿（标品已成交，目标换企业级机会）；
        //   培育轨=橙（价值不认可，按节奏发行业简报，不催单）。
        function trackTag(c) {
          const t = c && c.track
          if (!t || t === '标品漏斗' || t === '出口') return null
          const map = {
            '企业级直谈': [THEME.gold, '企业级·直谈'],
            '企业级升级': [THEME.gold, '企业级·升级'],
            '标品信任期': [THEME.ok, '信任期'],
            '培育': [THEME.warn, '培育轨'],
          }
          const m = map[t]
          if (!m) return null
          return React.createElement('span', { key: 'tracktag', style: { fontSize: 10, color: m[0], border: '1px dashed ' + m[0], borderRadius: 4, padding: '0 4px', flexShrink: 0, opacity: .95 } }, m[1])
        }
        // SOP 时间轴面板: 13 段漏斗(每段下挂该段的跟进记录) + 出口段 + 未标注段
        function sopPanel(c) {
          const d = sopData
          const boxStyle = { marginTop: 4, padding: '8px 10px', background: 'rgba(80,120,255,.05)', borderRadius: 6, border: '1px solid rgba(80,120,255,.2)', fontSize: 12 }
          if (!d) return React.createElement('div', { style: boxStyle }, '加载中…')
          if (!d.ok) return React.createElement('div', { style: boxStyle }, 'SOP 加载失败: ' + (d.error || ''))
          const sop = d.sop || {}
          // 2026-11-11（1.3.0）：每条跟进右侧给「归段」下拉——老数据没写阶段的，直接在 SOP 里点一下归位。
          const recLine = (r, i) => React.createElement('div', { key: 'r' + i, style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: THEME.text2, lineHeight: 1.5, paddingLeft: 10 } },
            React.createElement('span', { style: { flex: 1, minWidth: 0, wordBreak: 'break-word', overflowWrap: 'anywhere' } },
              '📋 ' + String(r.date || '').slice(5) + ' ' + (r.what || '')),
            stageFixSelect(c, r))
          const stageBlock = (s) => React.createElement('div', { key: (s.exit ? 'x-' : 'm-') + s.stage, style: { padding: '4px 8px', borderRadius: 6, background: s.current ? 'rgba(80,120,255,.10)' : 'transparent', border: s.current ? '1px solid rgba(80,120,255,.35)' : '1px solid transparent' } },
            React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, fontWeight: s.current ? 700 : 500 } },
              React.createElement('span', { style: { color: s.exit ? THEME.danger : THEME.blue, width: s.exit ? 'auto' : 74, flexShrink: 0 } }, s.exit ? ('出口·' + s.stage) : (s.seq + '. ' + s.stage)),
              React.createElement('span', { style: { fontSize: 10, color: THEME.text2 } }, s.count ? (s.count + ' 条') : '—'),
              s.current ? React.createElement('span', { style: { fontSize: 10, color: THEME.gold } }, '← 当前阶段') : null),
            (s.records || []).map(recLine))
          return React.createElement('div', { style: boxStyle },
            React.createElement('div', { style: { fontWeight: 700, color: THEME.blue, marginBottom: 4 } },
              '📋 ' + (d.name || c.name || '') + ' 的 SOP　' + (sop.progress || '') + ' · 结果：' + (sop.result || '—')),
            React.createElement('div', { style: { fontSize: 11, color: THEME.text2, marginBottom: 6 } },
              (sop.note || '') + (sop.nextStage ? '　下一段：' + sop.nextStage : '') + '　（共 ' + (sop.total || 0) + ' 条跟进' + (sop.coverage ? '：段内 ' + sop.coverage.staged + ' · 其他跟进记录 ' + sop.coverage.unlabeled : '') + '）'),
            // 2026-11-11（1.3.0）：归段回执（成功/失败都就近显示在这张 SOP 卡里，后端 error 原样上屏）
            stageMsg ? React.createElement('div', { style: { fontSize: 11, marginBottom: 4, color: stageMsg.tone === 'err' ? THEME.danger : (stageMsg.tone === 'ok' ? THEME.ok : THEME.text2) } }, stageMsg.text) : null,
            (sop.stages || []).map(stageBlock),
            (sop.exits || []).filter(x => x.count || x.current).map(stageBlock),
            (sop.unlabeled && sop.unlabeled.length) ? React.createElement('div', null,
              React.createElement('div', { style: { fontSize: 12, color: THEME.text2, marginTop: 4 } }, '其他跟进记录（' + sop.unlabeled.length + ' 条）· 待归段，目标 0'),
              React.createElement('div', { style: { fontSize: 10, color: THEME.text2, opacity: .75, paddingLeft: 2 } }, '归不到 13 段/出口的记录放这里（老数据没写阶段，或记录时显式选「其他跟进记录」）'),
              sop.unlabeled.map(recLine)) : null,
            aiBlock(d.ai, () => loadSopAi(c.id), '🧠 AI 话术'))
        }

        function row(c, isOverdue, tipId, tipData, loadClientTip, setTipId) {
          const showTip = tipId === c.id
          const showSop = sopId === c.id
          const rowEl = React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', rowGap: 4, gap: 10, alignItems: 'flex-start', padding: '6px 10px', background: isOverdue ? THEME.rowBgOd : THEME.rowBg, borderRadius: 6, fontSize: 13 } },
            React.createElement('span', { style: { width: 26, flexShrink: 0, textAlign: 'center', fontWeight: 700, color: levelColor(c.level) } }, String(c.level || '?')),
            React.createElement('div', { style: { flex: '1 1 140px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 } },
              React.createElement('span', { style: { display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 } },
                React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, c.name || '(无名称)'),
                stageTag(c), resultTag(c), trackTag(c)),
              React.createElement('span', { style: { fontSize: 11, color: 'var(--text-2,#888)', lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowWrap: 'anywhere' } },
              (c.contact ? c.contact : '') + (c.phone ? '  ' + c.phone : '') + (isOverdue && c.reason ? '  ·  ' + c.reason : (c.city && c.city !== '未知' ? '  ' + c.city : ''))),
              intentTags(c) ? React.createElement('span', { title: intentTags(c), style: { fontSize: 10, color: THEME.tagColor, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowWrap: 'anywhere', opacity: .9 } }, '📊 ' + intentTags(c)) : null,
              // 2026-11-11（1.3.0）：区域一不再堆跟进记录（只在 SOP 里看），换成客户/公司档案卡。
              profileCard(c),
            ),
            React.createElement('span', { style: { fontSize: 11, color: 'var(--text-2,#888)', flexShrink: 0 } }, c.status || ''),
            React.createElement('span', { style: { fontSize: 11, color: isOverdue ? THEME.danger : THEME.text2, flexShrink: 0 } }, isOverdue ? '逾期 ' + (c.next || '') : (c.next || '')),
            // 2026-11-11（1.3.0）：档案入口按手机号走——没有手机号就不给入口，直接标「缺手机号」。
            phoneKey(c.phone)
              ? React.createElement('button', { onClick: () => openProfileEdit(c), title: '客户档案：公司介绍/决策链/需求/预算/竞对/打法（可 AI 提炼，保存才落盘）', style: { background: (profEdit && profEdit.phone === phoneKey(c.phone)) ? 'rgba(64,192,120,.35)' : 'rgba(64,192,120,.12)', border: '1px solid rgba(64,192,120,.45)', borderRadius: 6, padding: '3px 8px', color: THEME.text1, cursor: 'pointer', fontSize: 12, flexShrink: 0 } }, '📝 档案')
              : React.createElement('span', { title: '客户表里没有手机号：补上手机号才能建档/归段', style: { fontSize: 10, color: THEME.warn, border: '1px dashed ' + THEME.warn, borderRadius: 4, padding: '1px 5px', flexShrink: 0 } }, '⚠ 缺手机号'),
            React.createElement('button', { onClick: () => liveLaunch(c), title: '通话记录台：电话开外放 → 本机实时转写 + 该接的话 + 结束自动出跟进记录草稿', style: { background: 'rgba(201,42,42,.12)', border: '1px solid rgba(201,42,42,.45)', borderRadius: 6, padding: '3px 8px', color: THEME.text1, cursor: 'pointer', fontSize: 12, flexShrink: 0 } }, '🎧'),
            copyBtn(c),
            React.createElement('button', { onClick: () => { if (showTip) setTipId(null); else loadClientTip(c.id) }, style: { background: showTip ? 'rgba(80,120,255,.35)' : 'rgba(80,120,255,.12)', border: '1px solid rgba(80,120,255,.4)', borderRadius: 6, padding: '3px 8px', color: THEME.text1, cursor: 'pointer', fontSize: 12, flexShrink: 0 } }, '📖 跟进提示'),
            React.createElement('button', { onClick: () => { if (showSop) setSopId(null); else loadSop(c.id) }, title: '按 SOP 阶段看这个客户的完整跟进轨迹（13 段漏斗 + 出口）', style: { background: showSop ? 'rgba(64,192,120,.35)' : 'rgba(64,192,120,.12)', border: '1px solid rgba(64,192,120,.45)', borderRadius: 6, padding: '3px 8px', color: THEME.text1, cursor: 'pointer', fontSize: 12, flexShrink: 0 } }, '📋 SOP'),
          )
          // 2026-11-11（1.3.0）：档案编辑面板也算一种展开——没展开提示/SOP 时也要让它露出来。
          const showProfEdit = !!(profEdit && profEdit.phone === phoneKey(c.phone))
          if (!showTip && !showSop && !showProfEdit) return rowEl
          const tipEl = !showTip ? null : (tipData && tipData.ok
            ? React.createElement('div', { style: { marginTop: 4, padding: '8px 10px', background: 'rgba(80,120,255,.06)', borderRadius: 6, border: '1px solid rgba(80,120,255,.2)', fontSize: 12 } },
                React.createElement('div', { style: { fontWeight: 700, color: THEME.blue, marginBottom: 4 } }, '📖 跟进提示（' + (tipData.name || c.name) + '，命中 ' + (tipData.hits || 0) + ' 条）'),
                tipData.script ? React.createElement('div', { style: { padding: '8px 10px', background: 'var(--row-bg, rgba(128,128,128,.08))', borderRadius: 6, marginBottom: 6, whiteSpace: 'pre-wrap', color: 'var(--text-1,#eee)', border: '1px solid var(--border-weak,rgba(128,128,128,.2))' } },
                  React.createElement('div', { style: { fontWeight: 700, color: 'var(--gold-color, #9a6700)', marginBottom: 4 } }, '🎯 这次跟进话术'),
                  tipData.script,
                ) : null,
                React.createElement('div', { style: { color: 'var(--text-2,#999)', marginBottom: 6 } }, '适用场景：' + ((tipData.scenes || []).join('、') || '—')),
                React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } }, (tipData.tips || []).map((t) => tipCard(t, true))),
                aiBlock(tipData.ai, () => loadTipAi(c.id), '🧠 AI 切入'),
              )
            : React.createElement('div', { style: { marginTop: 4, padding: '8px 10px', background: 'rgba(128,128,128,.06)', borderRadius: 6, fontSize: 12, color: 'var(--text-2,#999)' } }, tipData ? ('提示加载失败: ' + (tipData.error || '')) : '加载中…'))
          return React.createElement('div', { key: c.id, style: { display: 'flex', flexDirection: 'column', marginBottom: 4 } }, [rowEl, tipEl, showSop ? sopPanel(c) : null, profileEditPanel(c)])
        }
        function firstCallRow(c, idx, tipId, tipData, loadClientTip, setTipId) {
          const showTip = tipId === c.id
          const showSop = sopId === c.id
          const rowEl = React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', rowGap: 4, gap: 10, alignItems: 'flex-start', padding: '6px 10px', background: c.done ? 'rgba(128,128,128,.06)' : (c.rollover ? 'rgba(255,169,77,.08)' : 'rgba(116,192,252,.06)'), borderRadius: 6, fontSize: 13, border: c.done ? '1px solid rgba(128,128,128,.25)' : (c.rollover ? '1px solid rgba(255,169,77,.35)' : '1px solid rgba(116,192,252,.2)'), opacity: c.done ? 0.55 : 1 } },
            React.createElement('div', { style: { width: 20, flexShrink: 0, textAlign: 'center', fontWeight: 700, fontSize: 12, fontVariantNumeric: 'tabular-nums', color: c.done ? THEME.text3 : THEME.gold } }, String((idx === undefined ? 0 : idx) + 1)),
            React.createElement('div', { style: { width: 26, flexShrink: 0, textAlign: 'center', fontWeight: 700, color: levelColor(c.level) } }, String(c.level || '?')),
            React.createElement('div', { style: { flex: '1 1 140px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 } },
              React.createElement('span', { style: { display: 'flex', alignItems: 'center', gap: 5, overflow: 'hidden', whiteSpace: 'nowrap' } },
                React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600, textDecoration: c.done ? 'line-through' : 'none' } }, c.name || '(无名称)'),
                c.done ? React.createElement('span', { style: { marginLeft: 6, fontSize: 10, color: THEME.ok, background: THEME.okBg, borderRadius: 4, padding: '0 4px' } }, '✓ 已跟') : null,
                c.rollover ? React.createElement('span', { style: { marginLeft: 6, fontSize: 10, color: THEME.warn, background: THEME.warnBg, borderRadius: 4, padding: '0 4px' } }, '顺延') : null,
                stageTag(c), resultTag(c), trackTag(c)),
              React.createElement('span', { style: { fontSize: 11, color: 'var(--text-2,#888)', lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowWrap: 'anywhere' } },
                (c.contact && c.contact !== '匿名注册' ? c.contact + ' ' : '') + (c.source || '') + (c.city && c.city !== '未知' ? ' · ' + c.city : '') + (c.rollover ? ' · 原排期 ' + c.scheduled : '')),
              intentTags(c) ? React.createElement('span', { title: intentTags(c), style: { fontSize: 10, color: THEME.tagColor, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowWrap: 'anywhere', opacity: .9 } }, '📊 ' + intentTags(c)) : null,
              (c.action || c.why) ? React.createElement('span', { style: { fontSize: 11, color: c.tier === 'T1' ? THEME.gold : THEME.text2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                '➡️ ' + (c.tier === 'T1' ? '必打 ' : c.tier === 'T2' ? '该打 ' : '') + (c.action || '') + (c.why ? '（' + c.why + '）' : '') + (c.deadline === '今天' ? ' · 今天' : '') + (c.noPhone ? ' · 无电话走微信' : '')) : null,
            ),
            React.createElement('span', { style: { fontSize: 11, color: THEME.accent, flexShrink: 0, border: '1px solid ' + THEME.accentBd, background: THEME.accentBg, borderRadius: 4, padding: '0 5px' } }, '意向' + (c.hits || 0) + '/3'),
            React.createElement('span', { style: { fontSize: 13, fontWeight: 700, color: THEME.phone, flexShrink: 0, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontVariantNumeric: 'tabular-nums', letterSpacing: '.3px' } }, c.phone || '无电话'),
            React.createElement('button', { onClick: () => liveLaunch(c), title: '通话记录台：电话开外放 → 本机实时转写 + 该接的话 + 结束自动出跟进记录草稿', style: { background: 'rgba(201,42,42,.12)', border: '1px solid rgba(201,42,42,.45)', borderRadius: 6, padding: '3px 8px', color: THEME.text1, cursor: 'pointer', fontSize: 12, flexShrink: 0 } }, '🎧'),
            copyBtn(c),
            React.createElement('button', { onClick: () => { if (showTip) setTipId(null); else loadClientTip(c.id) }, style: { background: showTip ? 'rgba(80,120,255,.35)' : 'rgba(80,120,255,.12)', border: '1px solid rgba(80,120,255,.4)', borderRadius: 6, padding: '3px 8px', color: THEME.text1, cursor: 'pointer', fontSize: 12, flexShrink: 0 } }, '📖 跟进提示'),
            React.createElement('button', { onClick: () => { if (showSop) setSopId(null); else loadSop(c.id) }, title: '按 SOP 阶段看这个客户的完整跟进轨迹（13 段漏斗 + 出口）', style: { background: showSop ? 'rgba(64,192,120,.35)' : 'rgba(64,192,120,.12)', border: '1px solid rgba(64,192,120,.45)', borderRadius: 6, padding: '3px 8px', color: THEME.text1, cursor: 'pointer', fontSize: 12, flexShrink: 0 } }, '📋 SOP'),
          )
          // 2026-11-11（1.3.0）：档案编辑面板也算一种展开——没展开提示/SOP 时也要让它露出来。
          const showProfEdit = !!(profEdit && profEdit.phone === phoneKey(c.phone))
          if (!showTip && !showSop && !showProfEdit) return rowEl
          const tipEl = !showTip ? null : (tipData && tipData.ok
            ? React.createElement('div', { style: { marginTop: 4, padding: '8px 10px', background: 'rgba(80,120,255,.06)', borderRadius: 6, border: '1px solid rgba(80,120,255,.2)', fontSize: 12 } },
                React.createElement('div', { style: { fontWeight: 700, color: THEME.blue, marginBottom: 4 } }, '📖 跟进提示（' + (tipData.name || c.name) + '，命中 ' + (tipData.hits || 0) + ' 条）'),
                tipData.script ? React.createElement('div', { style: { padding: '8px 10px', background: 'var(--row-bg, rgba(128,128,128,.08))', borderRadius: 6, marginBottom: 6, whiteSpace: 'pre-wrap', color: 'var(--text-1,#eee)', border: '1px solid var(--border-weak,rgba(128,128,128,.2))' } },
                  React.createElement('div', { style: { fontWeight: 700, color: 'var(--gold-color, #9a6700)', marginBottom: 4 } }, '🎯 这次跟进话术'),
                  tipData.script,
                ) : null,
                React.createElement('div', { style: { color: 'var(--text-2,#999)', marginBottom: 6 } }, '适用场景：' + ((tipData.scenes || []).join('、') || '—')),
                React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } }, (tipData.tips || []).map((t) => tipCard(t, true))),
                aiBlock(tipData.ai, () => loadTipAi(c.id), '🧠 AI 切入'),
              )
            : React.createElement('div', { style: { marginTop: 4, padding: '8px 10px', background: 'rgba(128,128,128,.06)', borderRadius: 6, fontSize: 12, color: 'var(--text-2,#999)' } }, tipData ? ('提示加载失败: ' + (tipData.error || '')) : '加载中…'))
          return React.createElement('div', { key: c.id, style: { display: 'flex', flexDirection: 'column', marginBottom: 4 } }, [rowEl, tipEl, showSop ? sopPanel(c) : null])
        }
        // 销售指导卡片(guides页 + 首访跟进提示共用): 标题+点赞+标签+摘要，点开全文要点
        function remindRow(c) {
          return React.createElement('div', { key: c.id, style: { display: 'flex', flexWrap: 'wrap', rowGap: 4, gap: 10, alignItems: 'flex-start', padding: '6px 10px', background: 'rgba(255,215,0,.07)', borderRadius: 6, fontSize: 13, border: '1px solid rgba(255,215,0,.18)' } },
            React.createElement('span', { style: { width: 26, flexShrink: 0, textAlign: 'center', fontWeight: 700, color: levelColor(c.level) } }, String(c.level || '?')),
            React.createElement('div', { style: { flex: '1 1 140px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 } },
              React.createElement('span', { style: { display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 } },
                React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, c.name || '(无名称)'),
                stageTag(c), resultTag(c), trackTag(c)),
              React.createElement('span', { style: { fontSize: 11, color: 'var(--text-2,#888)', lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowWrap: 'anywhere' } },
                (c.contact ? c.contact : '') + (c.phone ? '  ' + c.phone : '') + (c.note ? '  ·  ' + c.note : '')),
              intentTags(c) ? React.createElement('span', { title: intentTags(c), style: { fontSize: 10, color: 'var(--tag-color, #69db7c)', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowWrap: 'anywhere', opacity: .9 } }, '📊 ' + intentTags(c)) : null,
              // 2026-11-11（1.3.0）：区域一不再堆跟进记录（历史记录统一到「📋 SOP」里看），这里留空。
            ),
            React.createElement('span', { style: { fontSize: 11, color: 'var(--gold-color, #9a6700)', flexShrink: 0 } }, c.remind || ''),
            copyBtn(c),
          )
        }
        // 待定跟进(无排期)行 2026-09-14 用户要求: 跟了但没定下次日期的客户，留在盘子里不沉底
        function pendingRow(c, tipId, tipData, loadClientTip, setTipId) {
          const showTip = tipId === c.id
          const showSop = sopId === c.id
          const sd = (c.silentDays === null || c.silentDays === undefined) ? null : c.silentDays
          const stale = !!c.stale
          const rowEl = React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', rowGap: 4, gap: 10, alignItems: 'flex-start', padding: '6px 10px', background: stale ? 'rgba(255,107,107,.07)' : 'rgba(128,128,128,.06)', borderRadius: 6, fontSize: 13, border: stale ? '1px solid rgba(255,107,107,.3)' : '1px solid rgba(128,128,128,.18)' } },
            React.createElement('span', { style: { width: 26, flexShrink: 0, textAlign: 'center', fontWeight: 700, color: levelColor(c.level) } }, String(c.level || '?')),
            React.createElement('div', { style: { flex: '1 1 140px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 } },
              React.createElement('span', { style: { display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 } },
                React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, c.name || '(无名称)'),
                stageTag(c), resultTag(c), trackTag(c)),
              React.createElement('span', { style: { fontSize: 11, color: 'var(--text-2,#888)', lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowWrap: 'anywhere' } },
                (c.contact ? c.contact : '') + (c.phone ? '  ' + c.phone : '') + (c.lastDate ? '  ·  最后跟进 ' + c.lastDate : '  ·  无流水')),
              intentTags(c) ? React.createElement('span', { title: intentTags(c), style: { fontSize: 10, color: 'var(--tag-color, #69db7c)', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowWrap: 'anywhere', opacity: .9 } }, '📊 ' + intentTags(c)) : null,
              // 2026-11-11（1.3.0）：历史跟进记录只在「📋 SOP」里看，区域一不再重复堆。
            ),
            React.createElement('span', { style: { fontSize: 11, color: stale ? THEME.danger : THEME.text2, flexShrink: 0 } }, stale ? '⚠️ 已静默 ' + sd + ' 天' : (sd === null ? '待定' : '静默 ' + sd + ' 天')),
            copyBtn(c),
            React.createElement('button', { onClick: () => { if (showTip) setTipId(null); else loadClientTip(c.id) }, style: { background: showTip ? 'rgba(80,120,255,.35)' : 'rgba(80,120,255,.12)', border: '1px solid rgba(80,120,255,.4)', borderRadius: 6, padding: '3px 8px', color: THEME.text1, cursor: 'pointer', fontSize: 12, flexShrink: 0 } }, '📖 跟进提示'),
            React.createElement('button', { onClick: () => { if (showSop) setSopId(null); else loadSop(c.id) }, title: '按 SOP 阶段看这个客户的完整跟进轨迹（13 段漏斗 + 出口）', style: { background: showSop ? 'rgba(64,192,120,.35)' : 'rgba(64,192,120,.12)', border: '1px solid rgba(64,192,120,.45)', borderRadius: 6, padding: '3px 8px', color: THEME.text1, cursor: 'pointer', fontSize: 12, flexShrink: 0 } }, '📋 SOP'),
          )
          // 2026-11-11（1.3.0）：档案编辑面板也算一种展开——没展开提示/SOP 时也要让它露出来。
          const showProfEdit = !!(profEdit && profEdit.phone === phoneKey(c.phone))
          if (!showTip && !showSop && !showProfEdit) return rowEl
          const tipEl = !showTip ? null : (tipData && tipData.ok
            ? React.createElement('div', { style: { marginTop: 4, padding: '8px 10px', background: 'rgba(80,120,255,.06)', borderRadius: 6, border: '1px solid rgba(80,120,255,.2)', fontSize: 12 } },
                React.createElement('div', { style: { fontWeight: 700, color: THEME.blue, marginBottom: 4 } }, '📖 跟进提示（' + (tipData.name || c.name) + '，命中 ' + (tipData.hits || 0) + ' 条）'),
                tipData.script ? React.createElement('div', { style: { padding: '8px 10px', background: 'var(--row-bg, rgba(128,128,128,.08))', borderRadius: 6, marginBottom: 6, whiteSpace: 'pre-wrap', color: 'var(--text-1,#eee)', border: '1px solid var(--border-weak,rgba(128,128,128,.2))' } },
                  React.createElement('div', { style: { fontWeight: 700, color: 'var(--gold-color, #9a6700)', marginBottom: 4 } }, '🎯 这次跟进话术'),
                  tipData.script,
                ) : null,
                React.createElement('div', { style: { color: 'var(--text-2,#999)', marginBottom: 6 } }, '适用场景：' + ((tipData.scenes || []).join('、') || '—')),
                React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } }, (tipData.tips || []).map((t) => tipCard(t, true))),
                aiBlock(tipData.ai, () => loadTipAi(c.id), '🧠 AI 切入'),
              )
            : React.createElement('div', { style: { marginTop: 4, padding: '8px 10px', background: 'rgba(128,128,128,.06)', borderRadius: 6, fontSize: 12, color: 'var(--text-2,#999)' } }, tipData ? ('提示加载失败: ' + (tipData.error || '')) : '加载中…'))
          return React.createElement('div', { key: c.id, style: { display: 'flex', flexDirection: 'column', marginBottom: 4 } }, [rowEl, tipEl, showSop ? sopPanel(c) : null])
        }
        // 锚点到期行 2026-10-08 用户定：停住客户的复查锚点到期/临期 → 看板上自己冒出来的红点
        //   与 pendingRow 的区别：右侧显示的是**锚点还有几天/已过几天**（不是静默天数）
        function anchorRow(c, tipId, tipData, loadClientTip, setTipId) {
          const showTip = tipId === c.id
          const showSop = sopId === c.id
          const od = !!c.overdue
          const dueTxt = '锚点 ' + String(c.anchor || '') + (od ? (c.inDays === 0 ? ' · 今天' : ' · 已过 ' + (-c.inDays) + ' 天') : ' · 还有 ' + c.inDays + ' 天')
          const rowEl = React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', rowGap: 4, gap: 10, alignItems: 'flex-start', padding: '6px 10px', background: od ? 'rgba(255,107,107,.09)' : 'rgba(255,192,120,.07)', borderRadius: 6, fontSize: 13, border: od ? '1px solid rgba(255,107,107,.35)' : '1px solid rgba(255,192,120,.3)' } },
            React.createElement('span', { style: { width: 26, flexShrink: 0, textAlign: 'center', fontWeight: 700, color: levelColor(c.level) } }, String(c.level || '?')),
            React.createElement('div', { style: { flex: '1 1 140px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 } },
              React.createElement('span', { style: { display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 } },
                React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, c.name || '(无名称)'),
                stageTag(c), resultTag(c), trackTag(c)),
              React.createElement('span', { style: { fontSize: 11, color: 'var(--text-2,#888)', lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowWrap: 'anywhere' } },
                (c.contact ? c.contact : '') + (c.phone ? '  ' + c.phone : '') + (c.lastDate ? '  ·  最后跟进 ' + c.lastDate : '  ·  无流水')),
              // 2026-11-11（1.3.0）：历史跟进记录只在「📋 SOP」里看，区域一不再重复堆。
            ),
            React.createElement('span', { style: { fontSize: 11, fontWeight: 700, color: od ? THEME.danger : THEME.warn, flexShrink: 0 } }, dueTxt),
            copyBtn(c),
            React.createElement('button', { onClick: () => { if (showTip) setTipId(null); else loadClientTip(c.id) }, style: { background: showTip ? 'rgba(80,120,255,.35)' : 'rgba(80,120,255,.12)', border: '1px solid rgba(80,120,255,.4)', borderRadius: 6, padding: '3px 8px', color: THEME.text1, cursor: 'pointer', fontSize: 12, flexShrink: 0 } }, '📖 跟进提示'),
            React.createElement('button', { onClick: () => { if (showSop) setSopId(null); else loadSop(c.id) }, title: '按 SOP 阶段看这个客户的完整跟进轨迹（13 段漏斗 + 出口）', style: { background: showSop ? 'rgba(64,192,120,.35)' : 'rgba(64,192,120,.12)', border: '1px solid rgba(64,192,120,.45)', borderRadius: 6, padding: '3px 8px', color: THEME.text1, cursor: 'pointer', fontSize: 12, flexShrink: 0 } }, '📋 SOP'),
          )
          // 2026-11-11（1.3.0）：档案编辑面板也算一种展开——没展开提示/SOP 时也要让它露出来。
          const showProfEdit = !!(profEdit && profEdit.phone === phoneKey(c.phone))
          if (!showTip && !showSop && !showProfEdit) return rowEl
          const tipEl = !showTip ? null : (tipData && tipData.ok
            ? React.createElement('div', { style: { marginTop: 4, padding: '8px 10px', background: 'rgba(80,120,255,.06)', borderRadius: 6, border: '1px solid rgba(80,120,255,.2)', fontSize: 12 } },
                React.createElement('div', { style: { fontWeight: 700, color: THEME.blue, marginBottom: 4 } }, '📖 跟进提示（' + (tipData.name || c.name) + '，命中 ' + (tipData.hits || 0) + ' 条）'),
                tipData.script ? React.createElement('div', { style: { padding: '8px 10px', background: 'var(--row-bg, rgba(128,128,128,.08))', borderRadius: 6, marginBottom: 6, whiteSpace: 'pre-wrap', color: 'var(--text-1,#eee)', border: '1px solid var(--border-weak,rgba(128,128,128,.2))' } },
                  React.createElement('div', { style: { fontWeight: 700, color: 'var(--gold-color, #9a6700)', marginBottom: 4 } }, '🎯 这次跟进话术'),
                  tipData.script,
                ) : null,
                React.createElement('div', { style: { color: 'var(--text-2,#999)', marginBottom: 6 } }, '适用场景：' + ((tipData.scenes || []).join('、') || '—')),
                React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } }, (tipData.tips || []).map((t) => tipCard(t, true))),
                aiBlock(tipData.ai, () => loadTipAi(c.id), '🧠 AI 切入'),
              )
            : React.createElement('div', { style: { marginTop: 4, padding: '8px 10px', background: 'rgba(128,128,128,.06)', borderRadius: 6, fontSize: 12, color: 'var(--text-2,#999)' } }, tipData ? ('提示加载失败: ' + (tipData.error || '')) : '加载中…'))
          return React.createElement('div', { key: c.id, style: { display: 'flex', flexDirection: 'column', marginBottom: 4 } }, [rowEl, tipEl, showSop ? sopPanel(c) : null])
        }
        function tipCard(g, compact) {
          const full = guideFull === String(g.序号)
          const show = full ? g.全文 : (g.摘要 || '')
          return React.createElement('div', { key: String(g.序号), style: { padding: '8px 10px', background: 'rgba(128,128,128,.06)', borderRadius: 6, border: '1px solid var(--border-weak,rgba(128,128,128,.15))' } },
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }, onClick: () => setGuideFull(full ? null : String(g.序号)) },
              React.createElement('span', { style: { fontWeight: 600, color: THEME.blue, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, (compact ? '' : '#' + g.序号 + ' ') + g.标题),
              React.createElement('span', { style: { fontSize: 10, color: THEME.gold, flexShrink: 0 } }, '👍' + g.点赞量)),
            React.createElement('div', { style: { fontSize: 11, color: 'var(--text-2,#999)', marginTop: 2 } }, (g.标签 || []).slice(0, 6).join(' · ')),
            React.createElement('div', { style: { fontSize: 12, color: 'var(--text-2,#bbb)', marginTop: 3, cursor: 'pointer', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }, onClick: () => setGuideFull(full ? null : String(g.序号)) }, (full ? '' : '…') + show.slice(0, full ? 2000 : 240)),
          )
        }
        const tday = tasks && tasks.today ? tasks.today : []
        const upc = tasks && tasks.upcoming ? tasks.upcoming : []
        const od = tasks && tasks.overdue ? tasks.overdue : []
        const pend = tasks && tasks.unscheduled ? tasks.unscheduled : []
        // 2026-10-08 用户定：锚点到期的停住客户（挂起/挂起冷备）→ 看板上会自己冒出来的红点
        const ad = tasks && tasks.anchorDue ? tasks.anchorDue : []
        // 2026-10-10 用户「接着做」：状态停住（挂起/挂起冷备/已闭环）却没留结论+锚点的人 —— 五个区都不显示他们
        const sna = tasks && tasks.stopNoAnchor ? tasks.stopNoAnchor : []
        const sm = summary
        const fc = firstcall

        // 六分类页面公共渲染件（2026-10-13）：一份 listPage 六页共用，避免每页重复三十行
        const bucketRows = (list) => React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
          (list || []).map((c) => pendingRow(Object.assign({}, c, { stale: false }), tipId, tipData, loadClientTip, setTipId)))
        const bucketHead = (d, extra) => React.createElement('div', {},
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' } },
            React.createElement('span', { style: { fontSize: 15, fontWeight: 700 } }, ((d && d.bucketLabel) || '名单') + (d && d.level ? '（' + d.level + ' 级）' : '')),
            React.createElement('span', { style: { color: THEME.text2, fontSize: 12 } }, '共 ' + ((d && d.count) || 0) + ' 人')),
          extra ? React.createElement('div', { style: { color: THEME.text2, fontSize: 12, marginBottom: 8 } }, extra) : null,
          d && d.note ? React.createElement('div', { style: { color: THEME.text3, fontSize: 11, marginBottom: 8 } }, d.note) : null)

        // ---------- 2026-10-15 合同台账页（第 8 页签）四段 ----------
        // ①台账（只读展示）②生成 .docx（本机出文件）③法律初审（规则版永远在，AI 可选）④管理动作（全走数据层）
        const contractPage = () => {
          const rows = Array.isArray(contractList) ? contractList : []
          const cur = (contractReview && (contractReview.contract || contractReview.合同)) || null
          const rule = (contractReview && (contractReview.规则 || contractReview.rule)) || null
          const ai = (contractReview && contractReview.ai) || null
          const risks = (rule && Array.isArray(rule.风险)) ? rule.风险 : ((contractReview && Array.isArray(contractReview.风险)) ? contractReview.风险 : [])
          const wait = (rule && Array.isArray(rule.待人工)) ? rule.待人工 : ((contractReview && Array.isArray(contractReview.待人工)) ? contractReview.待人工 : [])
          const inp = { background: 'rgba(128,128,128,.1)', border: '1px solid var(--border-weak,rgba(128,128,128,.3))', borderRadius: 6, padding: '5px 8px', color: 'var(--text-1,#eee)', fontSize: 12 }
          const setD = (k, v) => setContractDraft(Object.assign({}, contractDraft, { [k]: v }))
          const head = (t, extra) => React.createElement('div', { style: { fontSize: 13, fontWeight: 600, margin: '14px 0 8px' } }, t,
            extra ? React.createElement('span', { style: { fontWeight: 400, fontSize: 11, color: 'var(--text-2,#888)', marginLeft: 8 } }, extra) : null)
          // value 一律强制成字符串：draft 里可能没有这个 key（备注/原因/节点日期…），
          //   传 undefined 会让 React 把 input 当"非受控"（告警 + 输入丢失），这里统一兜 0。
          const tin = (k, ph, w) => React.createElement('input', {
            key: k, placeholder: ph,
            value: (contractDraft[k] === undefined || contractDraft[k] === null) ? '' : contractDraft[k],
            onChange: (e) => setD(k, e.target.value),
            style: Object.assign({}, inp, { width: (w || 120) }),
          })
          const field = (label, node) => React.createElement('label', { style: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-2,#999)' } }, label, node)
          const chip = (lv) => {
            const s = String(lv || '')
            const hi = s.indexOf('高') >= 0
            const mid = s.indexOf('中') >= 0
            return { fontSize: 11, padding: '1px 6px', borderRadius: 8, flexShrink: 0,
              background: hi ? 'rgba(214,48,49,.16)' : (mid ? 'rgba(154,103,0,.16)' : 'rgba(128,128,128,.14)'),
              border: '1px solid ' + (hi ? 'rgba(214,48,49,.5)' : (mid ? 'rgba(154,103,0,.5)' : 'var(--border-weak,rgba(128,128,128,.3))')),
              color: hi ? 'var(--danger-color,#d6336c)' : (mid ? 'var(--warn-color,#a15c00)' : 'var(--text-2,#999)') }
          }
          const rowLine = (c) => {
            const cid = String(c.合同ID || c.id || '')
            const red = !!(c.红点 || c.预警 || c.逾期)
            const sel = !!cid && cid === contractId
            return React.createElement('div', {
              key: cid || String(Math.random()),
              onClick: () => { if (cid) contractPick(cid) },
              style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '7px 10px', borderRadius: 6, cursor: cid ? 'pointer' : 'default',
                background: sel ? 'var(--accent-tint, rgba(28,126,214,.15))' : 'var(--row-bg, rgba(128,128,128,.06))',
                border: '1px solid ' + (sel ? 'var(--accent-bd, rgba(28,126,214,.45))' : 'var(--border-weak,rgba(128,128,128,.25))') } },
              red ? chip('高') : null,
              React.createElement('span', { style: { fontSize: 12, fontWeight: 600, color: 'var(--text-1,#eee)' } }, cid || '(无合同ID)'),
              React.createElement('span', { style: { fontSize: 12, color: 'var(--text-1,#ccc)' } }, String(c.客户名 || c.客户ID || '')),
              React.createElement('span', { style: { fontSize: 11, color: 'var(--text-2,#999)' } }, String(c.类型 || '')),
              React.createElement('span', { style: { fontSize: 11, color: 'var(--text-2,#999)' } }, (c.金额 === undefined || c.金额 === '') ? '' : (fmtWan2(c.金额) + ' 万元')),
              React.createElement('span', { style: { fontSize: 11, color: 'var(--text-2,#999)' } }, String(c.状态 || '')),
              React.createElement('span', { style: { fontSize: 11, color: red ? 'var(--danger-color,#d6336c)' : 'var(--text-3,#888)' } }, c.到期日 ? ('到期 ' + c.到期日) : ''),
              sel ? React.createElement('span', { style: { fontSize: 10, color: 'var(--blue-color,#1c7ed6)' } }, '已选') : null,
            )
          }
          return React.createElement('div', {},
            loading ? loadingP() : null,
            React.createElement('div', { style: { fontSize: 12, color: 'var(--text-2,#888)', lineHeight: 1.6, marginBottom: 4 } },
              '合同台账：文件只在本机生成、只在本机读取（不出网）；写操作走数据层（写锁+表头断言+原子写+变更日志），看板不碰表。'),
            contractMsg ? React.createElement('div', { style: { fontSize: 12, color: 'var(--text-1,#ddd)', background: 'rgba(128,128,128,.1)', borderRadius: 6, padding: '6px 8px', margin: '4px 0 8px', wordBreak: 'break-all' } }, contractMsg) : null,

            // ① 台账
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0 8px', flexWrap: 'wrap' } },
              React.createElement('button', { onClick: contractLoad, style: btn(false) }, '🔄 重拉台账'),
              React.createElement('button', {
                onClick: () => fetchData('sales.contract', { action: 'templates' }).then((r) => {
                  const d = (r && r.data) ? r.data : {}
                  if (!r || r.ok === false) { setContractMsg('模板读取失败：' + contractBad(r)); return }
                  const ts = Array.isArray(d.templates) ? d.templates : []
                  const pick = ts.filter((t) => t && String(t.key) === String(contractDraft.模板))[0] || ts[0] || null
                  contractTplCache = pick ? { key: String(pick.key || ''), 名称: String(pick.名称 || pick.key || ''), 必填: Array.isArray(pick.必填) ? pick.必填 : [] } : null
                  setContractMsg('模板：' + ts.map((t) => String((t && (t.key || t.名)) || '')).filter(Boolean).join(' / ')
                    + (contractTplCache ? ('；当前 ' + contractTplCache.key + ' 必填 ' + contractTplCache.必填.length + ' 项 → ② 里补齐') : '')
                    + (d.degraded ? '（生成层未就绪，只回退 key）' : ''))
                }).catch((e) => setContractMsg('模板读取异常：' + String((e && e.message) || e))),
                style: btn(false),
              }, '📋 查模板')),
            head('① 台账', rows.length ? ('共 ' + rows.length + ' 份；点一行选中 → 下面初审/管理') : ''),
            rows.length ? React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 240, overflow: 'auto' } }, rows.map(rowLine))
              : React.createElement('div', { style: { fontSize: 12, color: 'var(--text-2,#888)' } }, '暂无合同（先存要素：客户ID + 类型 → 存台账）。'),

            // ② 生成 .docx
            head('② 生成 .docx', '本机落 sale\\合同\\；模板 key 以「查模板」为准'),
            React.createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
              field('客户ID', tin('客户ID', 'C-…（save 必填）', 170)),
              field('类型', React.createElement('select', { value: contractDraft.类型, onChange: (e) => setD('类型', e.target.value), style: inp },
                ['定制开发', '标品', '企业级', 'NDA', '框架'].map((k) => React.createElement('option', { key: k, value: k }, k)))),
              field('模板', React.createElement('select', { value: contractDraft.模板, onChange: (e) => setD('模板', e.target.value), style: inp },
                ['standard', 'enterprise', 'nda'].map((k) => React.createElement('option', { key: k, value: k }, k)))),
              field('金额', tin('金额', '元', 90)),
              field('税率', tin('税率', '%', 60)),
            ),
            React.createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 } },
              field('我方主体', tin('我方主体', '我方签约主体', 170)),
              field('对方主体', tin('对方主体', '对方签约主体', 170)),
              field('对方信用代码', tin('对方统一社会信用代码', '可选', 170)),
            ),
            React.createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 } },
              field('签署日', tin('签署日', '', 130)),
              field('生效日', tin('生效日', '', 130)),
              field('到期日', tin('到期日', '', 130)),
            ),
            // 模板必填清单（点「查模板」后出现；已有同名 draft 值的会自动带出来）——甲方/乙方这类方向敏感项也在这一批
            contractTplCache && contractTplCache.必填.length ? React.createElement('div', { style: { marginTop: 8 } },
              React.createElement('div', { style: { fontSize: 11, color: 'var(--text-2,#999)', marginBottom: 4 } }, '模板必填（' + contractTplCache.key + '）：'),
              React.createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                contractTplCache.必填.map((f) => field(String(f), tin(String(f), '', 150))))) : null,
            React.createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 } },
              React.createElement('button', {
                onClick: () => {
                  if (!String(contractDraft.客户ID || '').trim()) { setContractMsg('先填客户ID 再存台账'); return }
                  contractAct({ action: 'save', 客户ID: String(contractDraft.客户ID).trim(), 类型: contractDraft.类型, 我方主体: contractDraft.我方主体, 对方主体: contractDraft.对方主体, 对方统一社会信用代码: contractDraft.对方统一社会信用代码, 金额: contractDraft.金额 === '' ? undefined : Number(contractDraft.金额), 税率: contractDraft.税率 === '' ? undefined : Number(contractDraft.税率), 签署日: contractDraft.签署日, 生效日: contractDraft.生效日, 到期日: contractDraft.到期日 }, '存台账')
                },
                style: btn(false),
              }, '💾 存台账'),
              React.createElement('button', { onClick: contractGen, style: btn(false), title: '先生成（本机）→ 再自动下载 .docx；生成前一并登记到台账' }, '📄 生成并下载 .docx'),
              React.createElement('button', {
                onClick: () => {
                  if (!contractId) { setContractMsg('先选一份合同'); return }
                  setContractMsg('取文件…')
                  fetchData('sales.contract', { action: 'file', 合同ID: contractId, 下载: true }).then((r) => {
                    if (!r || r.ok === false) { setContractMsg('取文件失败：' + contractBad(r)); return }
                    const d = (r.data && typeof r.data === 'object') ? r.data : {}
                    const okDl = d.base64 ? downloadBase64(d.名 || (contractId + '.docx'), d.base64, d.mime) : false
                    setContractMsg(okDl ? ('已下载：' + String(d.名 || '')) : '没有拿到文件字节（台账里可能还没有文件记录）')
                  }).catch((e) => setContractMsg('取文件异常：' + String((e && e.message) || e)))
                },
                style: btn(false),
              }, '⬇️ 下载台账里最后一份文件'),
            ),

            // ③ 法律初审
            head('③ 法律初审', cur ? ('当前：' + String(cur.合同ID || contractId)) : '先选一份合同'),
            React.createElement('div', { style: { display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' } },
              React.createElement('button', { onClick: () => contractReviewRun(false), style: btn(false), title: '规则初审（本机算，不出网）：高风险/中风险/待人工 + 免责；结果落 audit 留痕' }, '⚖️ 规则初审'),
              React.createElement('button', { onClick: () => contractReviewRun(true), style: btn(false), title: 'AI 复核：合同要素会发给模型厂商（唯一放行出口，其余不出本机）；失败/编数字自动回落规则版' }, '🧠 AI 复核'),
            ),
            rule ? React.createElement('div', { style: { fontSize: 12, lineHeight: 1.7 } },
              React.createElement('div', {}, '结论：', React.createElement('b', { style: { color: chip(rule.结论).color } }, String(rule.结论 || '待人工')), rule.ok === false && rule.error ? React.createElement('span', { style: { color: 'var(--warn-color,#a15c00)' } }, '（' + String(rule.error) + '）') : null),
              risks.length ? React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 } },
                // 高 / 中 / 低 分区（级别认不出来的落「其他」，绝不吞掉条目）
                [['高', '高风险'], ['中', '中风险'], ['低', '低风险'], ['其他', '其他']].map((g) => {
                  const gs = risks.filter((r) => {
                    const lv = String((r && r.级别) || '')
                    if (g[0] === '其他') return lv.indexOf('高') < 0 && lv.indexOf('中') < 0 && lv.indexOf('低') < 0
                    return lv.indexOf(g[0]) >= 0
                  })
                  if (!gs.length) return null
                  return React.createElement('div', { key: 'g' + g[0] },
                    React.createElement('div', { style: { fontSize: 11, fontWeight: 600, color: chip(g[0]).color, marginTop: 2 } }, g[1] + '（' + gs.length + '）'),
                    gs.map((r, i) => React.createElement('div', { key: g[0] + i, style: { display: 'flex', gap: 6, alignItems: 'flex-start' } },
                      React.createElement('span', { style: chip(r && r.级别) }, String((r && r.级别) || '风险')),
                      React.createElement('span', { style: { color: 'var(--text-1,#ddd)' } }, String((r && r.条款) || '') + '：' + String((r && r.问题) || '')
                        + ((r && r.建议) ? ('（建议：' + r.建议 + '）') : '')
                        + ((r && r.依据) ? ('［依据：' + r.依据 + '］') : ''))))) 
                })) : React.createElement('div', { style: { color: 'var(--text-2,#888)', marginTop: 4 } }, '风险清单：无'),
              wait.length ? React.createElement('div', { style: { color: 'var(--warn-color,#a15c00)', marginTop: 4 } }, '待人工：' + wait.join('；')) : null,
              React.createElement('div', { style: { color: 'var(--text-2,#888)', fontSize: 11, marginTop: 4 } }, String(rule.免责 || '初审是辅助，不构成法律意见：高风险条款须人工（法务/律师）复核后再签。')),
              rule.补正文说明 ? React.createElement('div', { style: { color: 'var(--warn-color,#a15c00)', fontSize: 11, marginTop: 2 } }, String(rule.补正文说明)) : null,
              (rule.ok !== false && contractReview && contractReview.已存) ? React.createElement('div', { style: { color: 'var(--ok-color,#2b8a3e)', fontSize: 11, marginTop: 2 } }, '已落 audit 留痕') : null,
            ) : React.createElement('div', { style: { fontSize: 12, color: 'var(--text-2,#888)' } }, '还没初审：点「规则初审」（本机、不出网）。'),
            React.createElement('div', { style: { marginTop: 8 } }, aiBlock(
              ai ? { busy: false, text: ai.text || '', mode: String((contractReview && contractReview.mode) || (ai.ok ? 'ai' : 'rule')), info: ai.label || '', local: !!ai.local, fellBack: ai.fellBack || '', ms: ai.ms, error: ai.ok ? '' : String(ai.error || '') } : null,
              () => contractReviewRun(true), '🧠 AI 复核')),

            // ④ 管理动作（全走数据层）
            head('④ 管理动作', '签署/改状态/记付款/归档/作废 —— 只写台账，不手改 xlsx'),
            React.createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
              field('状态', React.createElement('select', { value: contractDraft.状态 || '待签', onChange: (e) => setD('状态', e.target.value), style: inp },
                ['待签', '已签', '履行中', '已完成', '已归档', '已作废'].map((k) => React.createElement('option', { key: k, value: k }, k)))),
              tin('备注', '备注（可选）', 160),
              React.createElement('button', { onClick: () => { if (!contractId) { setContractMsg('先选一份合同'); return } contractAct({ action: 'status', 合同ID: contractId, 状态: contractDraft.状态 || '待签', 备注: contractDraft.备注 }, '改状态') }, style: btn(false) }, '改状态'),
              // 2026-10-21 体检（m03962 P0）：sign/archive/void 是**不可逆或会推客户段位**的写操作，
              //   必须二次确认并显式带 确认:true（服务端也要这个值才放行，双保险）。
              React.createElement('button', { onClick: () => { if (!contractId) { setContractMsg('先选一份合同'); return } var day = contractDraft.签署日 || ''; if (typeof window !== 'undefined' && window.confirm && !window.confirm('确认签署这份合同？\n合同：' + contractId + '\n签署日：' + (day || '（空，按今天）') + '\n签署会同时把客户推进到「成交签约」。')) return; contractAct({ action: 'sign', 合同ID: contractId, 日期: day, 推进: true, 确认: true }, '签署') }, style: btn(false), title: '默认同时把客户推进到「成交签约」（会二次确认）' }, '✍️ 签署'),
              React.createElement('button', { onClick: () => { if (!contractId) { setContractMsg('先选一份合同'); return } if (typeof window !== 'undefined' && window.confirm && !window.confirm('确认归档这份合同？\n合同：' + contractId)) return; contractAct({ action: 'archive', 合同ID: contractId, 确认: true }, '归档') }, style: btn(false) }, '📦 归档'),
            ),
            React.createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 } },
              field('付款节点', tin('节点名', '节点名，如「首款 30%」', 170)),
              field('节点日期', tin('节点日期', '', 130)),
              React.createElement('button', { onClick: () => { if (!contractId) { setContractMsg('先选一份合同'); return } if (!String(contractDraft.节点名 || '').trim()) { setContractMsg('先填节点名'); return } if (typeof window !== 'undefined' && window.confirm && !window.confirm('记一笔已收付款？\n合同：' + contractId + '\n节点：' + contractDraft.节点名)) return; contractAct({ action: 'pay', 合同ID: contractId, 节点名: contractDraft.节点名, 日期: contractDraft.节点日期, 状态: '已收', 确认: true }, '记付款') }, style: btn(false) }, '💰 记付款'),
              field('作废原因', tin('原因', '作废必须写原因', 170)),
              React.createElement('button', { onClick: () => { if (!contractId) { setContractMsg('先选一份合同'); return } if (!String(contractDraft.原因 || '').trim()) { setContractMsg('作废必须写原因'); return } if (typeof window !== 'undefined' && window.confirm && !window.confirm('确认作废这份合同？（不可撤销）\n合同：' + contractId + '\n原因：' + contractDraft.原因)) return; contractAct({ action: 'void', 合同ID: contractId, 原因: contractDraft.原因, 确认: true }, '作废') }, style: Object.assign({}, btn(false), { color: 'var(--danger-color,#d6336c)' }) }, '🚫 作废'),
            ),
          )
        }

        const boardStyle = float
          // 浮动窗：位置也钳在标题栏以下，否则拖到最上面标题栏又会「点不着」
          ? { position: 'fixed', left: pos.x, top: Math.max(pos.y, CLEARANCE), width: size.w, height: size.h, zIndex: 9999, ...NO_DRAG, background: THEME.bg, color: THEME.text1, display: 'flex', flexDirection: 'column', fontFamily: SERIES_STYLE.FONT, overflow: 'hidden', borderRadius: SERIES_STYLE.R_PANEL, border: '1px solid ' + THEME.border, boxShadow: '0 12px 32px rgba(0,0,0,.38)', opacity: opacity, '--text-1': THEME.text1, '--text-2': THEME.text2, '--text-3': THEME.text3, '--border-weak': THEME.border, '--tag-color': THEME.tagColor, '--gold-color': THEME.gold, '--blue-color': THEME.blue, '--accent-tint': THEME.accentTint, '--accent-bd': THEME.accentBd, '--btn-fg': THEME.btnFg, '--danger-color': THEME.danger, '--warn-color': THEME.warn, '--ok-color': THEME.ok, '--phone-color': THEME.phone, '--row-bg': THEME.rowBg }
          // 全屏：从标题栏下沿开始（CLEARANCE 在网页端 = 0，行为不变）
          : { position: 'fixed', left: 0, right: 0, bottom: 0, top: CLEARANCE, zIndex: 9999, ...NO_DRAG, background: THEME.bgFull, color: THEME.text1, display: 'flex', flexDirection: 'column', fontFamily: SERIES_STYLE.FONT, overflow: 'hidden', borderRadius: SERIES_STYLE.R_PANEL, border: '1px solid ' + THEME.border, boxShadow: '0 12px 32px rgba(0,0,0,.38)', '--text-1': THEME.text1, '--text-2': THEME.text2, '--text-3': THEME.text3, '--border-weak': THEME.border, '--tag-color': THEME.tagColor, '--gold-color': THEME.gold, '--blue-color': THEME.blue, '--accent-tint': THEME.accentTint, '--accent-bd': THEME.accentBd, '--btn-fg': THEME.btnFg, '--danger-color': THEME.danger, '--warn-color': THEME.warn, '--ok-color': THEME.ok, '--phone-color': THEME.phone, '--row-bg': THEME.rowBg }
        return React.createElement(BoardErrorBoundary, null, React.createElement('div', {
          style: boardStyle,
          onClick: (e) => { if (!float && e.target === e.currentTarget) closeBoard() },
        }, [
          React.createElement('div', { key: 'h', onMouseDown: onHeaderMouseDown, onDoubleClick: (e) => { if (e.target && e.target.closest && e.target.closest('button,input')) return; toggleFloat() }, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--border-weak, rgba(128,128,128,.2))', cursor: float ? 'move' : 'default', userSelect: 'none', flexShrink: 0 } },
            React.createElement('span', { style: { fontSize: 14, fontWeight: 700, fontFamily: SERIES_STYLE.FONT } }, PLUGIN_LABEL),
            React.createElement('button', { onClick: toggleFloat, title: float ? '还原为全屏（也可双击标题栏）' : '悬浮为小窗：标题栏拖位置、四边四角拖大小（双击标题栏切换）', style: btn(false) }, float ? '🖥 还原' : '🪟 悬浮'),
            // 2026-10-15 用户定（原话「这个不独立展示，属于sale插件的内置功能」）：通话记录台从侧边栏下线，
            //   挪进本面板标题栏——同一个 handler（liveLaunch），样式走系列控件 btn(...)，不再用侧边栏那套入口样式。
            React.createElement('button', { onClick: () => liveLaunch(LIVE.customer), title: LIVE.listening ? ('通话记录台（正在录音，已转 ' + LIVE.lines.length + ' 段）') : '通话记录台：电话开外放 → 本机实时转写 + 该接的话 + 结束出跟进记录', style: btn(!!LIVE.listening) }, LIVE_ENTRY_LABEL),
            // 2026-11-10 开源化：设置入口（数据目录 / 模型通道 / RAG / 公司与产品 + 只读诊断）
            React.createElement('button', { onClick: () => openPanel(), title: '设置：数据目录、模型通道、RAG 开关、公司与产品（附只读诊断）', style: btn(!!panelOpen) }, '⚙ 设置'),
            React.createElement('span', { style: { flex: 1 } }),
            React.createElement('button', { onClick: closeBoard, title: '关闭', style: btn(false) }, '✕'),
          ),
          // 2026-10-15 系列化（UI规范 §4 骨架）：标题栏只留「标题 + 开关 + ✕」；页签/工具条另起一行，
          //   与 dsh-flow / dsh-growth 同一骨架（gap:6 / padding:'6px 10px' / 可换行 / 下边框）。
          React.createElement('div', { key: 'tb', style: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', flexWrap: 'wrap', borderBottom: '1px solid var(--border-weak, rgba(128,128,128,.2))', flexShrink: 0 } },
            React.createElement('button', { onClick: () => { setTab('tasks'); loadTasks() }, style: btn(tab === 'tasks') },
              '今日任务',
              // 2026-10-08 用户定：锚点到期 = 红点（在任何页签都看得见，自己冒出来）
              // 2026-10-10：红点 = 锚点到期 + 停住没锚点（后者是前者没素材的根因，一并让他看见）
              (ad.length + sna.length) ? React.createElement('span', { style: { marginLeft: 5, fontSize: 10, fontWeight: 700, color: '#fff', background: THEME.danger, borderRadius: 8, padding: '0 5px' } }, String(ad.length + sna.length)) : null),
            // 2026-10-13 用户定（导航栏六分类，顺序即梯度：SS 最高 → C 最低）：
            //   今日任务 ｜ 待首触(不定级) ｜ 挂起冷备(C) ｜ 待定跟进(B) ｜ 重点跟进(A) ｜ 标品成交(S) ｜ 定制开发(SS) ｜ 合同管理(台账) ｜ 查询指导(=客户查询+销售指导)
            //   六类互斥且穷尽（服务端 bucketOf 算，全部 850 个客户必落一类）；汇总统计从顶部撤下，入口移进「今日任务」页底部
            React.createElement('button', { onClick: () => { setTab('first'); loadBucketPage('first') }, style: btn(tab === 'first') }, '待首触'),
            React.createElement('button', { onClick: () => { setTab('cold'); loadCold() }, style: btn(tab === 'cold') }, '挂起冷备'),
            React.createElement('button', { onClick: () => { setTab('pending'); loadBucketPage('pending') }, style: btn(tab === 'pending') }, '待定跟进'),
            React.createElement('button', { onClick: () => { setTab('focus'); loadFocus() }, style: btn(tab === 'focus') }, '重点跟进'),
            React.createElement('button', { onClick: () => { setTab('standard'); loadBucketPage('standard') }, style: btn(tab === 'standard') }, '标品成交'),
            React.createElement('button', { onClick: () => { setTab('custom'); loadBucketPage('custom') }, style: btn(tab === 'custom') }, '定制开发'),
            // 2026-10-15 新增第 8 页签「合同管理」（台账/生成/初审/管理动作；文件只在本机出、只在本机读）
            React.createElement('button', { onClick: () => { setTab('contract'); contractLoad() }, style: btn(tab === 'contract') }, '合同管理'),
            React.createElement('button', { onClick: () => setTab('query'), style: btn(tab === 'query') }, '查询指导'),
            React.createElement('span', { style: { flex: 1 } }),
            // 2026-09-29 用户要求：手动刷新键（我这边改了数据，不用关面板重开；不动 hook 序号）
            React.createElement('button', { key: 'rf', onClick: () => {
              setErr(null)
              loadTasks(); loadSummary(); loadFirstCall()
              // 2026-10-08 修（用户报障「刷新后无变化」）：展开中的 SOP 面板 / 客户提示也是前端 state，
              //   不重拉就会一直显示旧内容（数据层与插件路由早已是新值）
              if (sopId) loadSop(sopId)
              if (tipId) loadClientTip(tipId)
              // 2026-10-13：六分类页的刷新键也要重拉当前页（原来只有 focus/cold；query 页是前端本地态，不重拉）
              if (tab === 'focus') loadFocus()
              else if (tab === 'cold') loadCold()
              else if (tab === 'first' || tab === 'standard' || tab === 'custom' || tab === 'pending') loadBucketPage(tab)
              else if (tab === 'contract') contractLoad()
            }, title: '重新拉取当前页数据（含已展开的 SOP）', style: btn(false) }, '🔄 刷新'),
            React.createElement('button', { key: 'th', onClick: () => setTheme(t => t === 'dark' ? 'light' : (t === 'light' ? 'eye' : 'dark')), title: '切换主题：深色 / 浅色 / 护眼（会记住）', style: btn(false) }, theme === 'dark' ? '☀️ 浅色' : (theme === 'light' ? '🌿 护眼' : '🌙 深色')),
            float ? React.createElement('label', { key: 'op', style: { display: 'flex', alignItems: 'center', gap: 4, color: 'var(--btn-fg, #12161c)', fontSize: 12, flexShrink: 0 } }, '透明',
              React.createElement('span', { style: { fontSize: 12, minWidth: 32, textAlign: 'right' } }, Math.round(opacity * 100) + '%'),
              React.createElement('input', { type: 'range', min: 20, max: 100, step: 5, value: Math.round(opacity * 100), onChange: (e) => setOpacity(Number(e.target.value) / 100), style: { width: 64, accentColor: THEME.blue } }),
            ) : null,
          ),
          // 2026-10-21（用户 m01480 / m02018）：内容区改成「内容 + AI 对话框」两栏。
          //   2026-10-22（用户 m00521）：AI 对话框从**右侧挪到左侧** —— 老大原话「把AI助手对话框调到由整个面板的右侧调整到左侧」，
          //   所以下面 cw 里第一个子元素就是 AiDock（左侧栏），内容区跟在后边。只换顺序 + 边框朝向，别的逻辑不动。
          //   AiDock 自己带 state，不动本组件的 hook 序号；不写库，只把 sales_log 指令发进对话。
          React.createElement('div', { key: 'cw', style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'row' } },
          // 左侧 AI 对话框（m01480 建于右侧，2026-10-22 m00521 挪到左侧）。curId：把当前展开的 SOP / 跟进提示客户带给 AI，让它看得到这个人的档案
          React.createElement(AiDock, { key: 'aidock', curId: (sopId || tipId || ''), screen: tab, onWritten: refreshAfterWrite, onOpenCustomer: function (id) { try { setSopId(String(id || '')) } catch (e) {} } }),
          React.createElement('div', { key: 'c', style: { flex: 1, minWidth: 0, overflow: 'auto', padding: 16 } },
            // 2026-11-10 开源化：初始化完成后的一句话说回执（可关掉；不放成弹窗，不打断看板操作）
            notice ? React.createElement('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 12, padding: '8px 10px', borderRadius: 6, background: THEME.okBg, border: '1px solid ' + THEME.ok, color: THEME.ok, fontSize: 12.5 } },
              React.createElement('span', { style: { flex: 1, minWidth: 0, wordBreak: 'break-all' } }, '✅ ' + String(notice)),
              React.createElement('button', { onClick: () => setNotice(null), style: btn(false) }, '知道了')) : null,
            err ? React.createElement('div', { style: { color: THEME.danger, marginBottom: 12, fontSize: 13, wordBreak: 'break-all' } }, '⚠️ ' + err) : null,
            tab === 'tasks' ? React.createElement('div', {},
              loading ? loadingP() : null,
              React.createElement('div', { style: { display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap' } },
                React.createElement(Num, { k: '今日待打', v: fc ? (fc.pendingToday !== undefined ? fc.pendingToday : fc.scheduledToday) : '…' }),
                React.createElement(Num, { k: '今日已完成', v: fc ? (fc.doneToday || 0) : '…' }),
                React.createElement(Num, { k: '顺延中', v: fc ? (fc.rolloverCount || 0) : '…' }),
                React.createElement(Num, { k: '行动池余量', v: fc ? fc.remaining : '…' }),
                React.createElement(Num, { k: '批量池', v: fc ? (fc.batchCount || 0) : '…' }),
                React.createElement(Num, { k: '今日到期', v: tday.length }),
                React.createElement(Num, { k: '逾期', v: tasks ? tasks.overdueCount : '…' }),
                React.createElement(Num, { k: '临期(7天)', v: upc.length }),
                React.createElement(Num, { k: '待定(无排期)', v: pend.length }),
                React.createElement(Num, { k: '停住没锚点', v: tasks ? (tasks.stopNoAnchorCount || 0) : '…' }),
              ),
              // 2026-10-12 批次 2：🧠 AI 今日策略（点按钮才调模型；事实全部来自引擎 + 数字回查，失败回落规则版）
              React.createElement('div', { style: { marginBottom: 12 } }, aiBlock((tasks && tasks.ai) || null, loadBriefAi, '🧠 AI 今日策略')),
              // 2026-09-14: 体检警告出口（原来 warnings 只存在 check 里，看板/模型都看不到）
              (sm && sm.warningsCount > 0) ? React.createElement('div', { style: { marginBottom: 10, padding: '6px 10px', background: THEME.warnBg, border: '1px solid ' + THEME.borderStrong, borderRadius: 6, fontSize: 12, color: THEME.warn } },
                '⚠️ 体检警告 ' + sm.warningsCount + ' 条：' + ((sm.warnings || []).join('；') || '') + '（跑 node scripts/doctor.cjs 看详情）') : null,
              // 2026-10-08 用户定：锚点到期的停住客户（挂起/挂起冷备）原来「逾期/今日/临期三块都不显示」
              //   → 单列成会自己冒出来的红点；到期当天起按日期现算，不用人工去翻挂起冷备页
              (ad.length > 0) ? React.createElement('div', { style: { marginBottom: 12, padding: '8px 10px', background: THEME.dangerBg, border: '1px solid rgba(255,107,107,.35)', borderRadius: 6 } },
                React.createElement('div', { title: '这些客户的复查锚点已到期/临近，但状态是挂起/挂起冷备 → 逾期/今日到期/临期三块都不收（buildQueue 也不给它们发卡）。锚点填的是日期才会自动冒出来；只是信号（"客户新项目立项"）的靠 brief 盯。', style: { fontSize: 13, fontWeight: 700, color: THEME.danger, marginBottom: 6 } },
                  '🔔 锚点到期（' + ad.length + '）'),
                React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } }, ad.map((c) => anchorRow(c, tipId, tipData, loadClientTip, setTipId))),
              ) : null,
              // 2026-10-10 用户「接着做」：状态停住了却没留结论+锚点的人（五个区都不显示）→ 他自己冒出来
              //   行内右侧显示静默天数（复用 pendingRow），点开就是话术/SOP；一句 sales_settle 就能清掉一个
              (sna.length > 0) ? React.createElement('div', { style: { marginBottom: 12, padding: '8px 10px', background: 'rgba(255,192,120,.10)', border: '1px solid rgba(255,192,120,.4)', borderRadius: 6 } },
                React.createElement('div', { title: '这些客户状态已经停住（挂起/挂起冷备/已闭环），流水里却没有结论、也没有复查锚点——逾期/今日/临期/待定/锚点到期五块都不显示他们。只有真跟过的人才会列在这里（从没跟过的导入客资不算）。', style: { fontSize: 13, fontWeight: 700, color: THEME.warn, marginBottom: 6 } },
                  '⚫ 停住没锚点（' + sna.length + '）'),
                React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } }, sna.map((c) => pendingRow(c, tipId, tipData, loadClientTip, setTipId))),
              ) : null,
              React.createElement('div', { style: { fontSize: 13, fontWeight: 700, color: THEME.blue, marginBottom: 6 } },
                '📞 今日作战队列 — ' + (fc ? (fc.pendingToday !== undefined ? fc.pendingToday : fc.scheduledToday) : 0) + ' 条待打 / 共 ' + (fc && fc.daily ? fc.daily : 25) +
                (fc && fc.allDone ? ' ✅ 今日已完成' : (fc && fc.doneToday > 0 ? '（✓ 已跟 ' + fc.doneToday + ' 个）' : '')) +
                (fc && fc.rolloverCount > 0 ? '，含顺延 ' + fc.rolloverCount : '')),
              // 2026-09-29 用户定：**看板上不提示用量快照状态**（"这个不提示"）——
              //   快照新鲜度只留在数据层（sales_plan.snapshot / check），需要时由AI 助手在对话里说，别占看板
              // 2026-09-29 用户定：队列**分两块**显示——「首次触达」（未触达新线索，保底 10 条）与「今日跟进」（老客户）
              //   两块各自从 1 开始编号；老数据没有 firstTouch/followUp 时按 action 现分，向后兼容
              (function () {
                const all = (fc && fc.list) ? fc.list : []
                const ft = (fc && fc.firstTouch) ? fc.firstTouch : all.filter((x) => x.action === '首触')
                const fu = (fc && fc.followUp) ? fc.followUp : all.filter((x) => x.action !== '首触')
                const head = (t, n) => React.createElement('div', { style: { fontSize: 12, fontWeight: 700, color: THEME.blue, marginTop: 10, marginBottom: 6 } }, t + '（' + n + '）')
                return React.createElement('div', {},
                  head('🎯 首次触达', ft.length),
                  React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } }, ft.map((c, i) => firstCallRow(c, i, tipId, tipData, loadClientTip, setTipId))),
                  head('🔁 今日跟进', fu.length),
                  React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 14 } }, fu.map((c, i) => firstCallRow(c, i, tipId, tipData, loadClientTip, setTipId))),
                )
              })(),
              React.createElement('div', { style: { fontSize: 12, color: 'var(--text-2, #888)', marginBottom: 6 } }, '⏰ 已逾期 (' + od.length + ')'),
              React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 14 } }, od.map((c) => row(c, true, tipId, tipData, loadClientTip, setTipId))),
              React.createElement('div', { style: { fontSize: 12, color: 'var(--text-2, #888)', marginBottom: 6 } }, '📌 今日到期（' + tday.length + '）'),
              React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } }, tday.map((c) => row(c, false, tipId, tipData, loadClientTip, setTipId))),
              React.createElement('div', { style: { fontSize: 12, color: 'var(--text-2, #888)', marginTop: 14, marginBottom: 6 } }, '📅 即将到期（未来' + (tasks ? tasks.windowDays : 7) + ' 天内 ' + upc.length + '）'),
              React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } }, upc.map((c) => row(c, false, tipId, tipData, loadClientTip, setTipId))),
              // 2026-09-29 用户定：批量触达池放**最后**——长尾不占电话额度，不许挡在优先级前面
              (fc && fc.batchCount) ? React.createElement('div', { style: { marginTop: 16, padding: '8px 10px', background: 'rgba(128,128,128,.06)', borderRadius: 6, border: '1px solid rgba(128,128,128,.2)' } },
                React.createElement('div', { style: { fontSize: 12, fontWeight: 700, color: THEME.blue, marginBottom: 4 } }, '📦 批量触达池（' + fc.batchCount + ' 个 · 不占电话额度）'),
                React.createElement('div', { title: '长尾客户（注册很久、0 使用）：微信/短信批量发，别打电话占额度；有人回复的当天转成电话跟进。', style: { fontSize: 11, color: 'var(--text-2,#888)', marginBottom: 6 } }, '长尾（0 使用）：微信/短信批量发，不占电话额度；回复的当天转电话'),
                React.createElement('div', { style: { fontSize: 11, color: 'var(--text-2,#999)', whiteSpace: 'pre-wrap', marginBottom: 6 } }, fc.batchScript || ''),
                React.createElement('div', { style: { fontSize: 11, color: 'var(--text-2,#888)' } }, (fc.batch || []).slice(0, 12).map((x) => (x.name || x.id) + (x.phone ? '（' + x.phone + '）' : '')).join('、')),
              ) : null,
              // 2026-10-13 用户定：汇总统计从顶部导航撤下，入口放这里
              React.createElement('div', { style: { marginTop: 18, paddingTop: 10, borderTop: '1px solid var(--border-weak,rgba(128,128,128,.25))' } },
                React.createElement('button', { onClick: () => { setTab('summary'); loadSummary() }, style: btn(false) }, '📊 汇总统计（分布/AI 复盘）')),
            ) : null,
            tab === 'first' ? React.createElement('div', {},
              loading ? loadingP() : null,
              bucketHead(listPage, listPage ? ('有手机号 ' + (listPage.withPhone || 0) + ' 个；本页列前 ' + (listPage.listed || 0) + ' 个' + (listPage.truncated ? '（还有 ' + ((listPage.count || 0) - (listPage.listed || 0)) + ' 个没列，先打前面这些）' : '')) : ''),
              bucketRows(listPage && listPage.list),
            ) : null,
            tab === 'cold' ? React.createElement('div', {},
              loading ? loadingP() : null,
              React.createElement('div', { style: { display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap' } },
                React.createElement(Num, { k: '可捞回', v: listPage ? (listPage.activeCount !== undefined ? listPage.activeCount : listPage.count) : '…' }),
                React.createElement(Num, { k: '已结束', v: listPage ? (listPage.endedCount || 0) : '…' }),
                React.createElement(Num, { k: '带★捞回标记', v: listPage ? listPage.recallMarked : '…' }),
              ),
              React.createElement('div', { style: { fontSize: 12, color: THEME.text2, marginBottom: 10 } },
                '挂起冷备 = C 级（最低）：上面是「暂时不跟（可捞回）」，下面是「已结束（已闭环/出口，不复活、不进今日任务）」。★ = 下次大更/新功能上线自动挂回；想重新跟说一句或给个日期。'),
              bucketRows(listPage && listPage.active),
              (listPage && listPage.ended && listPage.ended.length) ? React.createElement('div', { style: { marginTop: 14 } },
                React.createElement('div', { style: { fontSize: 13, fontWeight: 600, color: THEME.text2, marginBottom: 6 } }, '已结束（' + listPage.ended.length + ' 人，不再提醒）'),
                bucketRows(listPage.ended)) : null,
            ) : null,
            tab === 'pending' ? React.createElement('div', {},
              loading ? loadingP() : null,
              bucketHead(listPage, listPage ? ('其中没定下日的 ' + (listPage.noDate || 0) + ' 个（把日子定下来就自动回跟进中）') : ''),
              bucketRows(listPage && listPage.list),
            ) : null,
            tab === 'focus' ? React.createElement('div', {},
              loading ? loadingP() : null,
              bucketHead(listPage, '重点盘 = 人工挑的盘子：不提醒、不进今日队列，每天自己看（移入/移出说一句）'),
              bucketRows(listPage && listPage.list),
            ) : null,
            tab === 'standard' ? React.createElement('div', {},
              loading ? loadingP() : null,
              React.createElement('div', { style: { display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap' } },
                React.createElement(Num, { k: '标品成交', v: listPage ? listPage.count : '…' }),
                React.createElement(Num, { k: '30天内到期', v: listPage ? (listPage.expiring30 || 0) : '…' }),
                React.createElement(Num, { k: '已过期', v: listPage ? (listPage.expired || 0) : '…' }),
                React.createElement(Num, { k: '付款合计（万元）', v: listPage ? fmtWan2(listPage.paidSum || 0) : '…' }),
              ),
              bucketHead(listPage, '成交后服务 + 续费/复购 + 转介绍；按到期时间由近到远排（没到期日的排最后）'),
              bucketRows(listPage && listPage.list),
            ) : null,
            tab === 'custom' ? React.createElement('div', {},
              loading ? loadingP() : null,
              bucketHead(listPage, listPage && listPage.byStage ? ('阶段分布：' + (Object.keys(listPage.byStage).filter(k => listPage.byStage[k]).map(k => k + ' ' + listPage.byStage[k]).join(' · ') || '暂无')) : ''),
              bucketRows(listPage && listPage.list),
            ) : null,
            tab === 'summary' ? React.createElement('div', {},
              loading ? loadingP() : null,
              sm ? React.createElement('div', {},
                React.createElement('div', { style: { display: 'flex', gap: 12, marginBottom: 16 } },
                  React.createElement(Num, { k: '客户总数', v: sm.total }),
                  React.createElement(Num, { k: '跟进记录', v: sm.flowCount }),
                ),
                sectionBar('跟进状态', sm.status),
                sectionBar('客户等级', sm.level),
                sm.stage ? sectionBar('SOP 阶段（13 段漏斗 + 出口）', sm.stage) : null,
                sm.track ? sectionBar('赛道（标品 → 企业级 双轨）', sm.track) : null,
                sectionBar('触达状态', sm.touch),
                sm.hitDist ? sectionBar('首访命中(未触达按4条规则)', sm.hitDist) : null,
                // 2026-10-12 批次 2：🧠 AI 复盘（近 7 天；点按钮才调模型；数字回查不通过的整段回落规则版）
                React.createElement('div', { style: { marginTop: 12 } }, aiBlock((summary && summary.ai) || null, loadDigestAi, '🧠 AI 复盘')),
              ) : React.createElement('div', { style: { color: 'var(--text-2,#888)' } }, '暂无数据'),
            ) : null,
            // 2026-10-15 合同管理页（第 8 页签）：台账列表 ｜ 生成 .docx ｜ 法律初审 ｜ 管理动作
            //   文件只在本机生成/读取；模型只用于可选 AI 复核（合同要素发给模型厂商=唯一放行出口）
            tab === 'contract' ? contractPage() : null,
            // 2026-10-13 用户定：客户查询 + 销售指导合并成一页「查询指导」（上半查客户、下半查话术）
            tab === 'query' ? React.createElement('div', {},
              React.createElement('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 8 } }, '🔍 客户查询'),
              React.createElement('div', { style: { display: 'flex', gap: 8, marginBottom: 12 } },
                React.createElement('input', { placeholder: '公司名/姓名/手机号/客户ID', value: searchKw, onChange: (e) => { setSearchKw(e.target.value); if (!e.target.value.trim()) setSearchRes(null) }, onKeyDown: (e) => { if (e.key === 'Enter') doSearch(searchKw) }, style: { flex: 1, background: 'rgba(128,128,128,.1)', border: '1px solid var(--border-weak,rgba(128,128,128,.3))', borderRadius: 6, padding: '8px 10px', color: 'var(--text-1,#eee)' } }),
                React.createElement('button', { onClick: () => doSearch(searchKw), style: btn(true) }, '搜索'),
              ),
              searchRes ? React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 16 } },
                searchRes.hits && searchRes.hits.length ? searchRes.hits.map((h) => row(h, false, tipId, tipData, loadClientTip, setTipId)) : React.createElement('div', { style: { color: 'var(--text-2,#888)', fontSize: 13 } }, '未找到客户'))
              : null,
              React.createElement('div', { style: { borderTop: '1px solid var(--border-weak,rgba(128,128,128,.25))', margin: '16px 0 12px' } }),
              React.createElement('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 8 } }, '📖 销售指导'),
              React.createElement('div', { style: { display: 'flex', gap: 8, marginBottom: 12 } },
                React.createElement('input', { placeholder: '输入场景/问题：嫌贵、首访破冰、客户不回微信、逼单、议价、复盘…', value: guideKw, onChange: (e) => { setGuideKw(e.target.value); if (!e.target.value.trim()) setGuideRes(null) }, onKeyDown: (e) => { if (e.key === 'Enter') loadTips(guideKw) }, style: { flex: 1, background: 'rgba(128,128,128,.1)', border: '1px solid var(--border-weak,rgba(128,128,128,.3))', borderRadius: 6, padding: '8px 10px', color: 'var(--text-1,#eee)' } }),
                React.createElement('button', { onClick: () => loadTips(guideKw), style: btn(true) }, '查指导'),
              ),
              loading ? loadingP() : null,
              guideRes ? React.createElement('div', {},
                React.createElement('div', { style: { fontSize: 12, color: 'var(--text-2,#888)', marginBottom: 8 } }, '“' + guideRes.q + '” 命中 ' + guideRes.count + ' 篇，推荐最贴切 ' + (guideRes.list ? guideRes.list.length : 0) + ' 篇（点标题/摘要看全文要点）'),
                React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } }, (guideRes.list || []).map((g) => tipCard(g))),
              ) : React.createElement('div', { title: '输入场景或问题，返回最贴切的销售方法/话术（综合指导：策略/流程/话术/异议/心态）。也可以在客户行点「📖 跟进提示」按客户场景直接看。', style: { color: 'var(--text-2,#888)', fontSize: 13, marginTop: 4 } }, '输入场景/问题，返回最贴切的销售方法与话术（也可在客户行点「📖 跟进提示」）'),
            ) : null,
          ),
          // 2026-10-22（m00521）：AI 对话框已挪到本行**最前面**（左侧栏），这里不再放第二个。
          ),
          float ? RESIZE_HANDLES.map((h) => React.createElement('div', {
            key: 'rz-' + h.dir,
            onMouseDown: startResize(h.dir),
            title: '拖动调整大小',
            style: Object.assign({ position: 'absolute', zIndex: 12, touchAction: 'none', cursor: h.cursor }, h.style),
          })) : null,
          float ? React.createElement('div', { key: 'rz-grip', onMouseDown: startResize('se'), title: '拖动调整大小', style: { position: 'absolute', right: 0, bottom: 0, width: 18, height: 18, cursor: 'nwse-resize', zIndex: 13 } },
            React.createElement('div', { style: { position: 'absolute', right: 3, bottom: 3, width: 10, height: 10, borderRight: '2px solid rgba(160,160,160,.8)', borderBottom: '2px solid rgba(160,160,160,.8)', borderBottomRightRadius: 8 } })
          ) : null,
          // 2026-11-10 开源化：⚙ 设置面板（铺满看板内容的内部浮层；不关面板也能看到底下内容不变暗，方便对照）
          panelOpen ? settingsPanel() : null,
        ]))
      }
      },
    )))

    // ========== 槽位4/5: 通话记录台（2026-10-09 用户定：电话开外放 → 本机实时转写 + 该接的话 + 结束出跟进记录）==========
    // 采集/转写改自官方麦克风插件 @deepseek-ai/dsh-experimental-client-ui-voice-input/lib/client.js：
    //   同一个 ctx.remote.speech（只吃 16k 单声道 PCM16 WAV 的 base64，**没有流式协议、没有转写历史**）
    //   → 自己分段 + 串行调用是唯一走法。官方是"说一段插进输入框"，这里是"每段出话术、结束出草稿"。
    // 分段口径（2026-10-09.6，用户要求「以一方说话结束为分隔，转录体现完整对话逻辑」）：
    //   **不按固定秒数切**，用端点检测：一旦这轮有说话，随后静音连续 ≥ LIVE_TAIL_MS 就判"一方说完了"→ 切段转写。
    //   于是**面板一行 = 一次发言**，按时间顺序读下来就是完整对话。
    // 换人判定（2026-10-09.7，用户：「为什么要留秒数，换人说话语义变了就切断」）：
    //   面板上**不再有秒数档**——只有一个内部保底上限 LIVE_MAX_SEG_MS（防有人连说不停撞上 120 秒 / 4MB 上限）。
    //   每一段的 PCM 顺手算一份**轻量声纹**（基频 F0 + 过零率 + 能量），与上一段比对：
    //   嗓音明显变了 → 判"换人"，这一段另起一个说话人回合（面板上交替底色 + 一条「换人」分隔）。
    //   单麦 + SenseVoice 不做说话人分离，所以判不准时**一律按"没换人"处理**（宁可不标，不瞎标）。
    // 隐私三条（说清楚，别含糊）：① 音频只在内存里，转写完立即丢，不落盘、不上云；
    //   ② 转写原文默认只在面板里；**通话一停自动落库**（2026-10-10 用户拍板「要」）＝把那条 `sales_log` 指令
    //      自动发进对话（setDraft→submit），真写两表的仍是AI 助手调 sales_log（经 ctx.tools.guard）；
    //      面板上可以一键关掉（关了就只有草稿，点「落库」才发）。文字仍是你自己看得见的那一条。
    //   ③ 推理在本机 CPU（sherpa-onnx + SenseVoiceSmall int8），模型已在盘，点开始约 1-3 秒就绪。
    const LIVE_SILENCE = 0.012                                  // 有无人声的电平门（RMS）：低于它算环境音
    const LIVE_TAIL_MS = 700                                    // 一方说完后静音 ≥ 它 → 切段（端点检测的"尾"）
    const LIVE_MIN_SPEECH_MS = 320                              // 段内有效说话不足它 → 咳嗽/噪音毛刺，不切
    const LIVE_TICK_MS = 120                                    // 电平采样周期（VAD 判定精度）
    const LIVE_MAX_SEG_MS = 15000                               // 保底：连说不停时最多这么长切一刀（远低于官方 120 秒 / 4MB 上限）
    const LIVE_KEEP_MS = 30 * 60 * 1000                         // 面板只留最近 30 分钟转写（内存保护）
    const LV = { text1: 'var(--text-1, #12161c)', text2: 'var(--text-2, #6b7280)', border: 'var(--border-weak, rgba(128,128,128,.35))', blue: 'var(--blue-color, #1c7ed6)', ok: '#2f9e44', warn: 'var(--warn-color, #a15c00)', danger: 'var(--danger-color, #c92a2a)', chip: 'var(--row-bg, rgba(128,128,128,.08))' }
    const LVBTN = (active) => ({ background: active ? 'var(--accent-tint, rgba(28,126,214,.15))' : 'none', border: '1px solid ' + (active ? 'var(--accent-bd, rgba(28,126,214,.45))' : LV.border), borderRadius: 7, padding: '4px 10px', color: 'var(--btn-fg, #12161c)', cursor: 'pointer', fontSize: 12, fontWeight: active ? 600 : 500 })
    // 面板视觉（2026-10-12 用户「优化通话记录台的 UI 视觉效果」）：一次性注入 scoped CSS
    //   —— 只作用于 .slv-*（前缀隔离，不碰宿主/看板）；悬停、焦点环、按下反馈、滚动条、录音呼吸点
    //   全靠它（内联 style 写不了 :hover/:focus）；纯前端，不碰数据、不改 4 套配色的取值口径。
    const LV_CSS = [
      '.slv-panel ::-webkit-scrollbar{width:10px;height:10px}',
      '.slv-panel ::-webkit-scrollbar-track{background:transparent}',
      '.slv-panel ::-webkit-scrollbar-thumb{background:var(--border-weak,rgba(128,128,128,.35));border-radius:999px;border:3px solid transparent;background-clip:content-box}',
      '.slv-panel ::-webkit-scrollbar-thumb:hover{background:var(--text-2,#6b7280);background-clip:content-box}',
      '.slv-btn{transition:background .12s ease,border-color .12s ease,box-shadow .12s ease,transform .06s ease}',
      '.slv-btn:hover:enabled{background:var(--row-bg,rgba(128,128,128,.10));border-color:var(--text-2,#6b7280)}',
      '.slv-btn:active:enabled{transform:translateY(1px)}',
      '.slv-btn:focus-visible{outline:2px solid var(--blue-color,#1c7ed6);outline-offset:1px}',
      '.slv-btn:disabled{opacity:.42;cursor:not-allowed}',
      '.slv-primary{background:var(--blue-color,#1c7ed6);border-color:var(--blue-color,#1c7ed6);color:#fff;box-shadow:0 1px 2px rgba(0,0,0,.18)}',
      '.slv-primary:hover:enabled{filter:brightness(1.08)}',
      '.slv-primary:disabled{background:var(--row-bg,rgba(128,128,128,.10));color:var(--text-2,#6b7280);border-color:var(--border-weak,rgba(128,128,128,.35));box-shadow:none;filter:none}',
      '.slv-danger{color:var(--danger-color,#c92a2a);border-color:var(--danger-color,#c92a2a)}',
      '.slv-in{transition:border-color .12s ease,box-shadow .12s ease}',
      '.slv-in:hover{border-color:var(--text-2,#6b7280)}',
      '.slv-in:focus{outline:none;border-color:var(--blue-color,#1c7ed6);box-shadow:0 0 0 3px var(--accent-tint,rgba(28,126,214,.15))}',
      '@keyframes slvPulse{0%,100%{opacity:1}50%{opacity:.32}}',
      '.slv-pip{animation:slvPulse 1.5s ease-in-out infinite}',
      '@media (prefers-reduced-motion:reduce){.slv-pip{animation:none}}',
    ].join('\n')
    let lvCssDone = false
    function lvCssOnce() {
      if (lvCssDone) return
      lvCssDone = true
      try {
        const el = document.createElement('style')
        el.textContent = LV_CSS
        ;(document.head || document.body).appendChild(el)
      } catch (e) {}
    }
    // 面板外观（2026-10-09 用户要"能调整位置颜色大小"）：4 套配色 + 位置/大小，记忆在浏览器 localStorage
    //   —— 纯前端偏好，不进任何数据表（"派生事实不落盘"的口径不变）；键名 `sales-live-view`
    const LV_THEMES = {
      paper: { label: '纸白', bg: 'rgba(255,255,255,.98)', text1: '#12161c', text2: '#5b6472', border: 'rgba(16,22,32,.14)', rowBg: 'rgba(16,22,32,.04)', blue: '#1c7ed6', danger: '#c92a2a', warn: '#a15c00', ok: '#2b8a3e', tint: 'rgba(28,126,214,.15)', bd: 'rgba(28,126,214,.45)', btnFg: '#12161c' },
      ink: { label: '墨黑', bg: 'rgba(13,15,20,.97)', text1: '#e6eaf0', text2: '#98a2b3', border: 'rgba(255,255,255,.14)', rowBg: 'rgba(255,255,255,.05)', blue: '#4dabf7', danger: '#ff8787', warn: '#ffc078', ok: '#69db7c', tint: 'rgba(77,171,247,.20)', bd: 'rgba(77,171,247,.45)', btnFg: '#e6eaf0' },
      eye: { label: '护眼', bg: 'rgba(231,240,226,.98)', text1: '#1f2a17', text2: '#4c5a42', border: 'rgba(31,42,23,.20)', rowBg: 'rgba(31,42,23,.05)', blue: '#2b6cb0', danger: '#b02525', warn: '#8a5a00', ok: '#2f7d32', tint: 'rgba(43,108,176,.14)', bd: 'rgba(43,108,176,.42)', btnFg: '#1f2a17' },
      contrast: { label: '高对比', bg: 'rgba(0,0,0,.95)', text1: '#ffffff', text2: '#d0d5dd', border: 'rgba(255,255,255,.35)', rowBg: 'rgba(255,255,255,.10)', blue: '#7cc4ff', danger: '#ff9a9a', warn: '#ffd166', ok: '#8ce99a', tint: 'rgba(124,196,255,.25)', bd: 'rgba(124,196,255,.60)', btnFg: '#ffffff' },
    }
    const LV_VIEW_KEY = 'sales-live-view'
    const LV_MIN_W = 320, LV_MIN_H = 220
    const lvViewDef = () => ({ x: 12, y: 64 + CLEARANCE, w: 470, h: Math.round((window.innerHeight || 900) * 0.72), theme: 'paper', auto: true })
    // 夹回可视区：宽度/高度给下限，位置不许完全跑出屏幕（至少留 90px 能抓回来）
    const lvClamp = (v) => {
      const vw = window.innerWidth || 1280, vh = window.innerHeight || 800
      const w = Math.min(Math.max(LV_MIN_W, Math.round(v.w)), Math.max(LV_MIN_W, vw - 16))
      const h = Math.min(Math.max(LV_MIN_H, Math.round(v.h)), Math.max(LV_MIN_H, vh - 40))
      const x = Math.min(Math.max(-(w - 90), Math.round(v.x)), Math.max(0, vw - 90))
      const y = Math.min(Math.max(0, Math.round(v.y)), Math.max(0, vh - 40))
      return { x: x, y: y, w: w, h: h, theme: LV_THEMES[v.theme] ? v.theme : 'paper', auto: v.auto !== false }
    }
    function lvViewLoad() {
      try {
        const v = JSON.parse(localStorage.getItem(LV_VIEW_KEY) || 'null')
        if (v && typeof v.x === 'number' && typeof v.y === 'number' && typeof v.w === 'number' && typeof v.h === 'number') return lvClamp(v)
      } catch (e) {}
      return lvViewDef()
    }
    function lvViewSave(v) { try { localStorage.setItem(LV_VIEW_KEY, JSON.stringify(v)) } catch (e) {} }
    // 唯一改外观的入口：夹取 → 落 localStorage → 通知面板重渲染
    function lvView(patch) { const v = lvClamp(Object.assign({}, LIVE.view || lvViewDef(), patch)); LIVE.view = v; lvViewSave(v); liveSet({ view: v }) }
    function lvTheme() { return LV_THEMES[(LIVE.view && LIVE.view.theme) || 'paper'] || LV_THEMES.paper }
    function lvThemeNext() {
      const ks = Object.keys(LV_THEMES)
      const next = ks[(ks.indexOf((LIVE.view && LIVE.view.theme) || 'paper') + 1) % ks.length]
      lvView({ theme: next })
      liveSet({ hint: '配色：' + LV_THEMES[next].label + '（位置/大小/配色已记住）' })
    }
    function lvViewReset() { const d = lvViewDef(); LIVE.view = d; lvViewSave(d); liveSet({ view: d, hint: '面板位置/大小/配色已复位到默认' }) }
    const LIVE = {
      view: lvViewLoad(),
      open: false, phase: 'idle', api: '', provider: '', maxBytes: 4 * 1024 * 1024,
      err: '', notice: '', hint: '', customer: null, lines: [], cues: [], moves: [], stageOpen: null,
      listening: false, busy: false, peak: 0, gen: 0, failed: 0, started: 0, draft: '',
      // 2026-10-12（A′ 档）：🧠 生成文案 的结果（{busy,text,mode,info,ms,error}）——挂模块态 + bump 重渲染，
      //   不新增 hook（面板 hook 顺序别动）。httpOnly POST /sales/ai，服务端脱敏+回填。
      ai: null,
      rec: null, stream: null, actx: null, analyser: null, chunks: [], meterId: null,
      speechMs: 0, silentMs: 0, segStart: 0, hot: 0, turn: 0, lastVp: null,
      inputActions: null, sessionId: '', autoSent: false, subs: new Set(),
      testing: false, selfReport: '', bridged: false,
    }
    // 本机转写的两条路（2026-10-09.4）：
    //   ① 浏览器直连 remote.speech —— 只有官方 voice-input UI 插件跑着才有（用户那台没跑，这条是空的）
    //   ② 宿主桥 /sales/speech · /speechprepare · /transcribe —— 只要宿主装了语音服务就通，不看 UI 插件
    //   两条路对外形状统一：{catalog(), prepare(id,opts), transcribe(req)} → {ok, value|error}
    let LIVE_HOST_SPEECH = null    // null=还没问过；true/false=宿主侧到底有没有
    function liveRemoteApi() { try { const r = ctx.get('remote'); return (r && r.speech) || null } catch (e) { return null } }
    function liveHostApi() {
      return {
        host: true,
        catalog: async () => {
          const r = await fetchData('sales.speech', {})
          if (r && r.ok === true && r.data) {
            LIVE_HOST_SPEECH = !!r.data.available
            if (!r.data.available) return { ok: false, error: r.data.error || '宿主没提供语音转写服务' }
            return { ok: true, value: r.data.catalog || {} }
          }
          return { ok: false, error: (r && r.error) || '宿主语音桥没响应' }
        },
        prepare: async (providerId, opts) => {
          const r = await fetchData('sales.speechprepare', Object.assign({ providerId: providerId || '' }, opts || {}))
          return (r && r.ok === true) ? { ok: true, value: r.data } : { ok: false, error: (r && r.error) || '宿主没接上语音模型准备' }
        },
        transcribe: async (req) => {
          const r = await fetchData('sales.transcribe', { audioBase64: (req && req.audioBase64) || '', providerId: (req && req.providerId) || '', language: (req && req.language) || '' })
          return (r && r.ok === true && r.data) ? { ok: true, value: r.data } : { ok: false, error: (r && r.error) || '宿主转写没响应' }
        },
      }
    }
    function liveApi() { return liveRemoteApi() || liveHostApi() }
    // 缺 speech 时缺的是哪一层，只给一句能动手的话（面板不写说明）
    function liveApiMiss() {
      let r = null
      try { r = ctx.get('remote') } catch (e) { r = null }
      return r ? '本机转写没开：设置 → 插件 → 语音输入（本机转写）' : '本机转写服务没挂上：退出桌面端重开'
    }
    function liveErr(e) { return String((e && e.message) || e || '未知错误') }
    function liveSet(patch) { Object.assign(LIVE, patch); for (const fn of Array.from(LIVE.subs)) { try { fn() } catch (e) {} } }
    function liveSub(fn) { LIVE.subs.add(fn); return () => { LIVE.subs.delete(fn) } }
    function liveNow() { const d = new Date(); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0') }
    function liveTrim() { const cut = Date.now() - LIVE_KEEP_MS; LIVE.lines = LIVE.lines.filter((l) => (l.at || 0) >= cut) }
    function liveRecent(n) { return LIVE.lines.slice(-(n || 3)).map((l) => l.text).join('　').slice(-600) }
    function liveCopy(text) { try { navigator.clipboard.writeText(String(text || '')) } catch (e) {} }
    // 拿到会话输入框的动作（insertText/captureInsertion/setDraft/submit）：由**会话作用域**槽位注入 → 见 LiveComposerEntry。
    //   **面板不能自己写库**（HTTP 面恒只读，写意图 403）→ 落库只能"把结构化指令发进对话"，由AI 助手调 sales_log 写两表。
    //   2026-10-10 定案（asar 取证，别再猜）：inputActions 只由官方会话插件 `ctx.uiSession.provide({ props: ['inputActions'] })`
    //   在 **session 作用域**下发；`sidebar.footer.action` 是 `{kind:'list', scope:'root'}`（dsh-client-ui-sidebar 只传 `{wide}`）
    //   → 老代码挂在侧边栏拿不到，一直是"复制到剪贴板"。改挂 `conversation.input.left`（list 槽、scope=session；
    //   **该槽只用来接线，组件渲染 null、不放图标**——2026-10-12 用户「去掉通话记录台的入口图标」）。
    //   官方口径（dsh-client-ui-voice-input：`inputActions.captureInsertion()` → `insertText(text, span)`）：
    //   **span 必须给**——官方实现里 `if (span.draftRev !== this.rev) return false`，漏了 span 直接 TypeError，静默退剪贴板。
    function liveSpan() {
      const ia = LIVE.inputActions
      try { if (ia && typeof ia.captureInsertion === 'function') return ia.captureInsertion() } catch (e) {}
      return undefined
    }
    function liveInsertRaw(text) {
      const ia = LIVE.inputActions
      if (!ia || typeof ia.insertText !== 'function') return false
      const t = String(text || '')
      try { return !!ia.insertText(t, liveSpan()) } catch (e) {}
      try { return !!ia.insertText(t) } catch (e) { return false }   // 兜底：万一某个版本 insertText 不吃 span
    }
    function liveInsert(text, okMsg) {
      let ok = false
      try { ok = liveInsertRaw(text) } catch (e) { ok = false }
      if (!ok) { liveSet({ hint: '输入框没接上（先在输入栏点一下再重试）：文字已复制到剪贴板，粘贴回车一样落库' }); liveCopy(text); return false }
      liveSet({ hint: okMsg || '已插入输入框，回车发送即可' })
      return true
    }
    // 通话一停自动落库（2026-10-10 用户：「要」）：纯函数决定这次怎么走，便于 _check 真跑（别只断言源码里有这行字）。
    //   ① off=面板上关着；② skip=已经发过/没转写/没定位客户（不能瞎写一条没客户的流水）；③ copy=输入框没接上，退剪贴板；
    //   ④ submit=setDraft+submit 自动发进对话（真写表仍走AI 助手 sales_log）；⑤ draft=只有 setDraft（进输入框等点发送）。
    function liveAutoPlan(st) {
      const s = st || {}
      if (!s.on) return { act: 'off', why: '自动落库关着（面板上可开）' }
      if (s.sent) return { act: 'skip', why: '这次通话已经自动发过一条了（不重复写两表）' }
      if (!s.lines) return { act: 'skip', why: '这次没转写到内容（麦克风没拾到人声？）' }
      if (!s.customer) return { act: 'skip', why: '没定位客户：自动落库跳过（草稿留着，选完客户点「落库」）' }
      if (!s.canDraft && !s.canInsert) return { act: 'copy', why: '输入框没接上：记录指令已复制到剪贴板，粘贴回车一样落库' }
      if (s.canDraft && s.canSubmit) return { act: 'submit', why: '自动落库：指令已发进对话' }
      return { act: 'draft', why: '指令已放进输入框，点发送即可落库' }
    }
    function liveAutoSend(text) {
      const ia = LIVE.inputActions
      const canDraft = !!(ia && typeof ia.setDraft === 'function')
      const canInsert = !!(ia && typeof ia.insertText === 'function')
      const canSubmit = !!(ia && typeof ia.submit === 'function')
      const plan = liveAutoPlan({
        on: !!(LIVE.view && LIVE.view.auto), sent: !!LIVE.autoSent, lines: LIVE.lines.length,
        customer: (LIVE.customer && LIVE.customer.id) || '', canDraft: canDraft, canInsert: canInsert, canSubmit: canSubmit,
      })
      const done = (ok, note) => {
        liveCheck({ step: 'autolog', act: plan.act, ok: !!ok, via: LIVE.inputActions ? (LIVE.sessionId || 'input') : 'none', len: String(text || '').length, lines: LIVE.lines.length, id: (LIVE.customer && LIVE.customer.id) || '', note: note || plan.why })
        return plan
      }
      if (plan.act === 'off') return done(false)
      if (plan.act === 'skip') { liveSet({ hint: plan.why }); return done(false) }
      if (plan.act === 'copy') { liveCopy(text); liveSet({ hint: plan.why }); return done(false) }
      let ok = false
      if (plan.act === 'submit') {
        try { ia.setDraft(String(text || '')); ok = !!ia.submit() } catch (e) { ok = false }
      } else {
        try { ia.setDraft(String(text || '')); ok = true } catch (e) { ok = false }
      }
      if (!ok && canInsert) { try { ok = liveInsertRaw(text) } catch (e) { ok = false } }
      if (!ok) liveCopy(text)
      LIVE.autoSent = true
      liveSet({ hint: ok ? plan.why : '自动落库没成：指令已复制到剪贴板，粘贴回车一样落库' })
      return done(ok)
    }
    // 通话中再来一段 → 只读问后端要 1-3 条"现在该接的那句"（sales_live → cmdLive，纯本机规则层、零网络）
    async function liveCues(gen) {
      const text = liveRecent(3)
      if (!text) return
      const r = await fetchData('sales.live', { id: (LIVE.customer && LIVE.customer.id) || '', text, limit: 3 })
      if (gen !== LIVE.gen) return
      if (!r || r.ok !== true || !r.data) { liveSet({ hint: '话术服务没响应：' + ((r && r.error) || '未知') }); return }
      const d = r.data
      const cust = d.id ? Object.assign({}, LIVE.customer || {}, { id: d.id, name: d.name, phone: d.phone, level: d.level, stage: d.stage, status: d.status }) : LIVE.customer
      liveSet({ cues: d.cues || [], moves: d.moves || [], stageOpen: d.stageOpen || null, customer: cust, hint: (d.cues && d.cues.length) ? '' : '这段没听出要接的话（闲聊/听不清都正常，接着听）' })
    }
    function liveAppend(text, turn, changed) { LIVE.lines.push({ at: Date.now(), time: liveNow(), text: String(text).slice(0, 400), turn: turn || 0, changed: !!changed }); liveTrim(); liveSet({ lines: LIVE.lines.slice(), notice: '', failed: 0 }) }
    function liveFail(msg) { const n = (LIVE.failed || 0) + 1; liveSet({ phase: LIVE.listening ? 'recording' : 'idle', failed: n, err: msg + (n >= 3 ? '（连续失败：检查麦克风是否被别的程序占用，或把手机外放音量调大一点）' : '') }) }
    // 🧪 诊断回传（2026-10-09.4）：浏览器半的现场只能靠它带出来（宿主写到 logs/live-check.log）
    //   用户不当测试员 —— 「开始通话」每次成败都会自己留一条；🧪 按钮还能真跑一遍整链
    function liveCheck(fields) { try { fetchData('sales.livecheck', Object.assign({ where: 'panel' }, fields || {})) } catch (e) {} }
    async function liveCatalog() {
      const api = liveApi()
      if (!api) { liveSet({ api: 'missing' }); return null }
      try {
        const r = await api.catalog()
        if (!r || !r.ok) { liveSet({ api: 'error', err: '语音服务不可用：' + liveErr(r && r.error) }); return null }
        const v = r.value || {}
        const pid = (v.selection && v.selection.providerId) || (v.providers && v.providers[0] && v.providers[0].id) || ''
        liveSet({ api: 'ok', provider: pid, maxBytes: Number(v.maxAudioBytes) || LIVE.maxBytes, err: '' })
        return v
      } catch (e) { liveSet({ api: 'error', err: '语音服务调用失败：' + liveErr(e) }); return null }
    }
    async function livePrepare() {
      const api = liveApi(); if (!api) return false
      const cat = await liveCatalog(); if (!cat) return false
      // 就绪口径（官方 provider）：只有 ready / standby 收录音；waking / loading / checking / downloading / unprepared 都不收
      const phaseOf = (c) => {
        const arr = (c && c.providers) || []
        const one = (LIVE.provider ? arr.find((x) => x.id === LIVE.provider) : null) || arr[0]
        return String((one && one.preparation && one.preparation.phase) || '')
      }
      const ready = (ph) => ph === 'ready' || ph === 'standby'
      let ph = phaseOf(cat)
      if (ready(ph)) return true
      if (!ph) { liveSet({ phase: 'idle', err: '语音服务没报出 provider（目录是空的）：设置 → 插件 → 语音输入（本机转写）要启用' }); return false }
      liveSet({ phase: 'preparing', notice: '正在唤醒本机语音模型…（第一次要几十秒）' })
      try {
        const r = await api.prepare(LIVE.provider || undefined)
        if (r && r.ok === false) { liveSet({ phase: 'idle', notice: '', err: '语音模型准备失败：' + liveErr(r.error) }); return false }
      } catch (e) { liveSet({ phase: 'idle', notice: '', err: '语音模型准备失败：' + liveErr(e) }); return false }
      // 官方 prepare() 是「起个后台任务就返回」，不 await 就绪 → 这里自己轮询目录，
      //   否则第一段必然抛 "Prepare the local speech provider before recording"
      let last = ''
      for (let i = 0; i < 60; i++) {
        const c2 = await liveCatalog()
        ph = phaseOf(c2)
        if (ready(ph)) { liveSet({ notice: '', phase: 'idle' }); return true }
        if (ph === 'failed' || ph === 'cancelled') { liveSet({ phase: 'idle', notice: '', err: '语音模型准备失败（' + ph + '）：设置 → 插件 → 语音输入（本机转写）' }); return false }
        if (ph && ph !== last) { last = ph; liveCheck({ step: 'prepare', ok: false, phase: ph, provider: LIVE.provider }) }
        liveSet({ notice: '正在唤醒本机语音模型…' + (ph ? '（' + ph + '）' : '') + ' 已等 ' + (i + 1) + ' 秒' })
        await new Promise((res) => window.setTimeout(res, 1000))
      }
      liveSet({ phase: 'idle', notice: '', err: '语音模型准备超时（等了 60 秒）：设置 → 插件 → 语音输入（本机转写）里先手动准备一次' })
      return false
    }
    function liveMicErr(e) {
      const n = String((e && e.name) || '')
      if (n === 'NotAllowedError' || n === 'SecurityError') return '麦克风权限被拒：系统/应用里允许后再点开始（桌面端：设置 → 隐私 → 麦克风）'
      if (n === 'NotFoundError' || n === 'OverconstrainedError') return '没找到麦克风设备'
      if (n === 'NotReadableError') return '麦克风被别的程序占着（关掉会议/录音软件再试）'
      return '麦克风打不开：' + liveErr(e)
    }
    function liveMeter() {
      const a = LIVE.analyser; if (!a) return
      try {
        const buf = new Uint8Array(a.fftSize)
        a.getByteTimeDomainData(buf)
        let sum = 0
        for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v }
        liveVad(Math.sqrt(sum / buf.length))
      } catch (e) {}
    }
    // 端点检测（2026-10-09.6）：每一拍只做三件事——累计"这轮说了多久"、累计"静音多久"、判断该不该切。
    //   连续 2 拍过门才算开口（挡单拍噪音毛刺）；切段条件 = 说过话 + 静音够长；保底 = 说过话且超过 LIVE_MAX_SEG_MS。
    //   两条都必须 said：纯静音（没人说话/环境底噪）永不切段，不会白停白起录音、也不刷空行。
    function liveVad(rms) {
      if (!LIVE.listening) return
      const now = Date.now()
      if (!LIVE.segStart) LIVE.segStart = now
      LIVE.hot = rms >= LIVE_SILENCE ? (LIVE.hot || 0) + 1 : 0
      if (LIVE.hot >= 2) { LIVE.speechMs += LIVE_TICK_MS; LIVE.silentMs = 0; if (rms > LIVE.peak) LIVE.peak = rms }
      else { LIVE.silentMs += LIVE_TICK_MS }
      const said = LIVE.speechMs >= LIVE_MIN_SPEECH_MS
      const pause = said && LIVE.silentMs >= LIVE_TAIL_MS
      // 保底切也必须"说过话"：否则没人说话时每 15 秒就白停/白起一次录音（纯静音没内容，切了也没用）
      const long = said && (now - LIVE.segStart) >= LIVE_MAX_SEG_MS        // 保底：连说不停最多这么长切一刀（也必须真说过话）
      if (pause || long) liveSegment(pause ? 'pause' : 'long')
    }
    function liveRecStart() {
      try {
        const rec = new MediaRecorder(LIVE.stream)
        LIVE.chunks = []
        rec.ondataavailable = (e) => { if (e.data && e.data.size) LIVE.chunks.push(e.data) }
        LIVE.rec = rec
        rec.start()
      } catch (e) { liveFail('录音启动失败：' + liveErr(e)) }
    }
    function liveRecStop() {
      return new Promise((resolve) => {
        const rec = LIVE.rec
        if (!rec || rec.state === 'inactive') { resolve(null); return }
        const done = () => { const chunks = LIVE.chunks.slice(); LIVE.chunks = []; resolve(chunks.length ? new Blob(chunks, { type: rec.mimeType || 'audio/webm' }) : null) }
        try { rec.addEventListener('stop', done, { once: true }); rec.stop() } catch (e) { resolve(null) }
      })
    }
    // Blob → 16k 单声道 PCM16 WAV 的标准 base64（官方口径：不带 data URL 前缀）
    // 轻量声纹（2026-10-09.7）：只用三个便宜特征判断"前后两段是不是同一个人在说"——
    //   ① 基频 F0（自相关峰值，70~350Hz 人声范围）；② 过零率 ZCR（嗓音亮/闷）；③ 能量 RMS。
    //   不落盘、不上传，只在内存里和**上一段**比一次；样本不足（<0.2 秒 / 有效帧太少）返回 null = 判不了。
    function liveVoicePrint(pcm) {
      if (!pcm || pcm.length < 3200) return null
      const N = 1024, hop = 512, LAG_MIN = 46, LAG_MAX = 229           // 16000/350≈46 … 16000/70≈229
      const M = N - LAG_MAX                                            // 能量与自相关必须用**同一组下标**，否则两者不可比
      const f0s = [], zcrs = []
      let rmsSum = 0, frames = 0
      for (let at = 0; at + N <= pcm.length; at += hop) {
        let e = 0
        for (let i = 0; i < M; i += 2) { const s = pcm[at + i]; e += s * s }
        const rms = Math.sqrt(e / M)
        if (rms < 0.01) continue                                     // 静音帧不进特征（不然算出来的是底噪）
        let zc = 0
        for (let i = 1; i < N; i++) if ((pcm[at + i - 1] < 0) !== (pcm[at + i] < 0)) zc++
        zcrs.push(zc / N); rmsSum += rms; frames++
        let best = -1, bestLag = 0
        for (let lag = LAG_MIN; lag <= LAG_MAX; lag++) {
          let s = 0
          for (let i = 0; i < M; i += 2) s += pcm[at + i] * pcm[at + i + lag]
          if (s > best) { best = s; bestLag = lag }
        }
        if (bestLag && best > 0.6 * e) f0s.push(16000 / bestLag)     // 自相关不够强 = 这帧不算有声（清音/噪音）
      }
      if (frames < 3 || f0s.length < 2) return null
      const med = (a) => { const b = a.slice().sort((x, y) => x - y); return b[b.length >> 1] }
      return { n: frames, f0: med(f0s), zcr: med(zcrs), rms: rmsSum / frames }
    }
    // 判"同一个人"：只认**音高（F0）**和**嗓音亮/闷（ZCR）**这两项，任一项差得明显 → 判换人。
    //   能量（RMS）只作日志诊断、**不进判据**：getUserMedia 开着 autoGainControl，远近/音量会被自动拉平，
    //   拿它当判据只会瞎切。两项都判不了（段太短/太安静）→ 当作没换人。
    function liveSameSpeaker(a, b) {
      if (!a || !b) return true                                     // 判不了 → 当作没换人（宁可不标，不瞎标）
      const rel = (x, y) => Math.abs(x - y) / Math.max(0.0001, Math.min(x, y))
      return !(rel(a.f0, b.f0) > 0.25 || rel(a.zcr, b.zcr) > 0.35)
    }
    async function liveWav(blob) {
      const buf = await blob.arrayBuffer()
      const AC = window.AudioContext || window.webkitAudioContext
      const tmp = new AC()
      let decoded = null
      try { decoded = await tmp.decodeAudioData(buf.slice(0)) } finally { try { tmp.close() } catch (e) {} }
      if (!decoded || !decoded.duration) return null
      const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext
      if (!OAC) throw new Error('这个环境不支持 OfflineAudioContext')
      const off = new OAC(1, Math.max(1, Math.round(decoded.duration * 16000)), 16000)
      const src = off.createBufferSource(); src.buffer = decoded; src.connect(off.destination); src.start(0)
      const out = await off.startRendering()
      const data = out.getChannelData(0)
      const total = 44 + data.length * 2
      if (total > LIVE.maxBytes) return null
      const ab = new ArrayBuffer(total)
      const view = new DataView(ab)
      const put = (at, str) => { for (let i = 0; i < str.length; i++) view.setUint8(at + i, str.charCodeAt(i)) }
      put(0, 'RIFF'); view.setUint32(4, 36 + data.length * 2, true); put(8, 'WAVE'); put(12, 'fmt ')
      view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
      view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
      put(36, 'data'); view.setUint32(40, data.length * 2, true)
      for (let i = 0; i < data.length; i++) { const s = Math.max(-1, Math.min(1, data[i])); view.setInt16(44 + i * 2, Math.round(s * (s < 0 ? 32768 : 32767)), true) }
      return { b64: liveB64(new Uint8Array(ab)), pcm: data }        // pcm 也带回去：顺手算声纹，不用二次解码
    }
    function liveB64(bytes) {
      let s = ''
      for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192))
      return btoa(s)
    }
    // 官方 transcribe 给的是对象 { text, audioSeconds, inferenceSeconds }（也可能走 Remote 包装）。
    // 只取纯文本，绝不对整个对象 String()——那会把「[object Object]」显示给用户（2026-10-09 实测）。
    function liveTextOf(v) {
      if (typeof v === 'string') return v
      if (!v || typeof v !== 'object') return ''
      if (typeof v.text === 'string') return v.text
      if (typeof v.transcript === 'string') return v.transcript
      const segs = Array.isArray(v.segments) ? v.segments : (Array.isArray(v.results) ? v.results : null)
      if (segs) return segs.map((x) => (typeof x === 'string' ? x : (x && typeof x.text === 'string' ? x.text : ''))).filter(Boolean).join(' ')
      return ''
    }
    async function liveTranscribe(blob, gen) {
      liveSet({ phase: 'transcribing' })
      const via = liveRemoteApi() ? 'remote' : 'host'
      let b64 = null, pcm = null
      try { const w = await liveWav(blob); b64 = w && w.b64; pcm = w && w.pcm } catch (e) { liveFail('音频转换失败：' + liveErr(e)); liveCheck({ step: 'wav-fail', via, bytes: blob ? blob.size : 0, err: liveErr(e) }); return }
      if (gen !== LIVE.gen) return
      if (!b64) { liveCheck({ step: 'wav-empty', via, bytes: blob ? blob.size : 0 }); liveSet({ phase: 'recording', err: '这段没转成 WAV（空段或超 4MB 上限）·已跳过' }); return }
      const api = liveApi()
      if (!api) { liveCheck({ step: 'no-api', via }); liveSet({ phase: 'recording', err: '本机转写没接上：' + liveApiMiss() }); return }
      const t0 = Date.now()
      let r = null
      try { r = await api.transcribe({ audioBase64: b64, providerId: LIVE.provider || undefined }) } catch (e) { liveFail('转写调用失败：' + liveErr(e)); liveCheck({ step: 'transcribe-throw', via, bytes: b64.length, err: liveErr(e) }); return }
      if (gen !== LIVE.gen) return
      liveSet({ phase: LIVE.listening ? 'recording' : 'idle', err: '' })
      if (!r || !r.ok) { const em = liveErr(r && r.error); liveFail('转写失败：' + em); liveCheck({ step: 'transcribe-fail', via, bytes: b64.length, ms: Date.now() - t0, err: em }); return }
      const text = liveTextOf(r.value).replace(/\s+/g, ' ').trim()
      liveCheck({ step: 'transcribe-ok', via, ok: true, bytes: b64.length, ms: (r.value && r.value.ms) || (Date.now() - t0), textLen: text.length, text: text.slice(0, 120), provider: LIVE.provider })
      // 官方口径：text === '' 就是「这段没人说话」（client-ui-voice-input client.js:5018 同样判空）。
      // 不能静默丢掉——不然用户说话前点开始、什么都不出现，看起来又像"没反应"。
      if (!text) { liveSet({ phase: LIVE.listening ? 'recording' : 'idle', err: '', hint: '这段没听清（静音或环境噪音）·对着麦克风再说一句' }); return }
      liveSet({ phase: LIVE.listening ? 'recording' : 'idle', err: '', hint: '' })
      // 换人判定（2026-10-09.7）：这一段和上一段比嗓音（判不了/同人 → 算没换）。判"换人"就另起一个回合——
      //   面板上交替底色 + 一条「换人」分隔，读下来就是"你一句我一句"；判不准一律不标，绝不瞎标。
      const vp = liveVoicePrint(pcm)
      const changed = !!(LIVE.lastVp && vp && !liveSameSpeaker(LIVE.lastVp, vp) && LIVE.lines.length)
      if (vp) LIVE.lastVp = vp
      if (changed) { LIVE.turn = (LIVE.turn || 0) + 1; liveCheck({ step: 'turn', note: 'turn=' + LIVE.turn + ' f0=' + Math.round(vp.f0) + ' zcr=' + Math.round(vp.zcr * 1000) / 1000 }) }
      liveAppend(text, LIVE.turn || 0, changed)
      await liveCues(gen)
    }
    // 一段 = 「一方说完」或「说太久保底」→ 停录取这轮的 blob → **立刻接着录** → 转写放后台（串行，迟到结果按 gen 作废）
    //   注意顺序：先 liveRecStart() 再 await 转写——转写那几十~几百毫秒里不至于丢话（这是这次改口径的附赠修）
    async function liveSegment(reason) {
      if (!LIVE.listening || LIVE.busy) return
      LIVE.busy = true
      const gen = LIVE.gen
      const peak = LIVE.peak
      const saidMs = LIVE.speechMs
      // 新一轮的计数从这一刻重新开始（此刻正是新录音的起点）
      LIVE.peak = 0; LIVE.segStart = Date.now(); LIVE.speechMs = 0; LIVE.silentMs = 0; LIVE.hot = 0
      const blob = await liveRecStop()
      if (LIVE.listening && gen === LIVE.gen) liveRecStart()
      try {
        if (blob && peak >= LIVE_SILENCE && blob.size > 2400 && LIVE.listening && gen === LIVE.gen) await liveTranscribe(blob, gen)
      } catch (e) { liveFail('这段处理失败：' + liveErr(e)) }
      if (reason === 'pause' || reason === 'long') liveCheck({ step: 'cut', note: reason, saidMs, bytes: blob ? blob.size : 0, peak: Math.round(peak * 1000) / 1000 })
      LIVE.busy = false
    }
    async function liveStart() {
      if (LIVE.listening) return
      // 每次点「开始通话」都留一条现场（成功/失败都留）→ 有问题我看日志就能定位，不用用户复述
      const V = { step: 'start', via: liveRemoteApi() ? 'remote' : 'host', secure: !!window.isSecureContext }
      if (!window.isSecureContext) { liveCheck(Object.assign(V, { err: 'insecure-context' })); liveSet({ err: '当前不是安全上下文（要 https 或 127.0.0.1），浏览器不给麦克风' }); return }
      if (!liveApi()) { liveCheck(Object.assign(V, { err: 'no-api' })); liveSet({ api: 'missing' }); return }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { liveCheck(Object.assign(V, { err: 'no-getUserMedia' })); liveSet({ err: '这个环境不支持麦克风采集（getUserMedia 缺失）' }); return }
      if (!(await livePrepare())) { liveCheck(Object.assign(V, { err: 'prepare-failed', provider: LIVE.provider, note: LIVE.err })); return }
      let stream = null
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }) }
      catch (e) { liveCheck(Object.assign(V, { err: 'mic:' + String((e && e.name) || 'unknown') })); liveSet({ err: liveMicErr(e) }); return }
      try {
        const AC = window.AudioContext || window.webkitAudioContext
        const actx = new AC()
        const src = actx.createMediaStreamSource(stream)
        const analyser = actx.createAnalyser()
        analyser.fftSize = 2048
        src.connect(analyser)
        LIVE.gen = LIVE.gen + 1
        liveSet({ stream, actx, analyser, listening: true, phase: 'recording', err: '', notice: '', hint: '', failed: 0, started: Date.now(), peak: 0 })
        liveCheck(Object.assign(V, { ok: true, provider: LIVE.provider, phase: 'recording' }))
        try { const tr = stream.getAudioTracks()[0]; if (tr) tr.onended = () => { if (LIVE.listening) liveStop('麦克风断了（设备被拔掉或被别的程序占用）') } } catch (e) {}
        liveRecStart()
        LIVE.meterId = window.setInterval(liveMeter, LIVE_TICK_MS)
        // 不再有"每 N 秒切一刀"的定时器：切段由 liveVad() 按「一方说完」驱动（2026-10-09.6）
      } catch (e) {
        try { stream.getTracks().forEach((t) => t.stop()) } catch (_) {}
        liveCheck(Object.assign(V, { err: 'audio-graph:' + liveErr(e) }))
        liveSet({ err: '录音启动失败：' + liveErr(e), listening: false, phase: 'idle' })
      }
    }
    function liveStop(why) {
      if (LIVE.meterId) { try { window.clearInterval(LIVE.meterId) } catch (e) {} LIVE.meterId = null }
      LIVE.gen = LIVE.gen + 1                                  // 作废在途结果（页面隐藏/切会话/暂停都走这里）
      try { if (LIVE.rec && LIVE.rec.state !== 'inactive') LIVE.rec.stop() } catch (e) {}
      try { if (LIVE.stream) LIVE.stream.getTracks().forEach((t) => t.stop()) } catch (e) {}
      try { if (LIVE.actx) LIVE.actx.close() } catch (e) {}
      LIVE.rec = null; LIVE.stream = null; LIVE.actx = null; LIVE.analyser = null; LIVE.chunks = []; LIVE.busy = false
      LIVE.speechMs = 0; LIVE.silentMs = 0; LIVE.segStart = 0; LIVE.hot = 0
      if (why) liveCheck({ step: 'stop', note: why })
      liveSet({ listening: false, phase: 'idle', notice: why || '', peak: 0 })
    }
    function liveLaunch(c) {
      const cust = c ? { id: c.id, name: c.name, contact: c.contact, phone: c.phone, level: c.level, stage: c.stage, status: c.status } : null
      const same = !!(cust && LIVE.customer && cust.id && cust.id === LIVE.customer.id)
      if (!same) { LIVE.turn = 0; LIVE.lastVp = null; LIVE.autoSent = false }   // 换客户 = 换一场对话：说话人回合从头数，自动落库的"只发一次"也归零
      liveSet({ open: true, customer: cust || LIVE.customer, lines: same ? LIVE.lines : [], cues: [], moves: [], stageOpen: null, draft: same ? LIVE.draft : '', hint: '', err: '' })
    }
    function liveWhat() { return LIVE.lines.map((l) => l.text).join(' ').trim().slice(0, 300) }
    function liveDraftText() {
      const c = LIVE.customer || {}
      const what = liveWhat()
      const cue = LIVE.cues[0]
      const obj = { id: c.id || '', method: '电话', type: '高意向跟进', what: what ? ('电话沟通：' + what) : '' }
      if (cue) obj.react = '客户提到「' + cue.cue + '」'
      const next = (LIVE.stageOpen && LIVE.stageOpen.next) || (LIVE.moves[0] && LIVE.moves[0].action) || ''
      if (next) obj.nextAction = next
      return 'sales_log ' + JSON.stringify(obj)
    }
    function liveEnd() {
      liveStop('')
      const had = LIVE.lines.length > 0
      const text = had ? liveDraftText() : ''
      const auto = !!(LIVE.view && LIVE.view.auto)
      liveSet({ draft: text, hint: had ? (auto ? '通话已结束，正在自动落库…' : '草稿已生成：改完点「落库」，指令进输入框 → 你回车才写表') : '这次没转写到内容（麦克风没拾到人声？）' })
      // 通话一停 → 自动把 `sales_log` 指令发进对话（面板上可关）；关着/没客户/没内容 → 只留草稿（liveAutoPlan 决定）
      if (had) liveAutoSend(text)
      else liveCheck({ step: 'autolog', act: 'skip', ok: false, note: 'no-lines' })
    }
    function liveAskPrompt() {
      const c = LIVE.customer || {}
      return '【通话实时】客户：' + (c.name || '未选客户') + (c.phone ? '（' + c.phone + '）' : '') + '，SOP 阶段：' + (c.stage || '未知') + '，跟进状态：' + (c.status || '未知') +
        '\n客户刚说的话（本机转写，可能有错字）：' + (liveRecent(4) || '（暂无）') +
        '\n请按这段真实对话，给我 2 条我现在最该接的话（口语、直接能说出口），每条一句为什么；最后给一句这次通话该拿到的结论。'
    }
    function liveSettleText(kind, anchor) {
      const c = LIVE.customer || {}
      return 'sales_settle ' + JSON.stringify({ id: c.id || '', kind: kind, anchor: anchor || '' })
    }
    // 🧪 一键自检（2026-10-09.4）：真跑一遍「语音服务 → 麦克风 → 2.5 秒录音 → 16k WAV → 转写」，
    //   结果压在面板上一行 + 落一条 live-check.log（用户不用当测试员，我看日志定位）
    async function liveSelfTest() {
      if (LIVE.testing) return null
      const R = { where: 'selftest', step: 'env', via: liveRemoteApi() ? 'remote' : 'host', secure: !!window.isSecureContext, note: 'maxSeg=' + LIVE_MAX_SEG_MS }
      liveSet({ testing: true, selfReport: '自检中…' })
      const done = (msg) => { liveSet({ testing: false, selfReport: msg }) }
      try {
        try { const ds = await navigator.mediaDevices.enumerateDevices(); R.devices = ds.filter((x) => x.kind === 'audioinput').length } catch (e) { R.devices = -1 }
        R.step = 'catalog'
        const cat = await liveCatalog()
        if (!cat) { R.err = LIVE.err || '语音服务不可用'; liveCheck(R); done('自检没过：' + R.err); return R }
        R.provider = LIVE.provider
        R.catalog = ((cat.providers || []).map((p) => p.id + '=' + ((p.preparation && p.preparation.phase) || '?')).join(' ') || '无 provider') + ' max=' + (cat.maxAudioBytes || '?')
        R.step = 'prepare'
        if (!(await livePrepare())) { R.err = LIVE.err || '模型没就绪'; liveCheck(R); done('自检没过：' + R.err); return R }
        if (LIVE.listening) { R.step = 'skip-mic'; R.note = '正在录音，只查服务那半段'; R.ok = true; liveCheck(R); done('自检：服务通（录音中不动麦克风）'); return R }
        R.step = 'mic'
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { R.err = 'getUserMedia 缺失'; liveCheck(R); done('自检没过：' + R.err); return R }
        let stream = null
        try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }) }
        catch (e) { R.micErr = liveMicErr(e); R.err = R.micErr; liveCheck(R); done('自检没过：' + R.micErr); return R }
        R.step = 'record'
        const rec = new MediaRecorder(stream)
        const chunks = []
        let peak = 0, actx = null
        try {
          const AC = window.AudioContext || window.webkitAudioContext
          actx = new AC()
          const src = actx.createMediaStreamSource(stream)
          const an = actx.createAnalyser(); an.fftSize = 2048; src.connect(an)
          const buf = new Uint8Array(an.fftSize)
          R._meter = window.setInterval(() => { try { an.getByteTimeDomainData(buf); let s = 0; for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; s += v * v } const rms = Math.sqrt(s / buf.length); if (rms > peak) peak = rms } catch (e) {} }, 200)
        } catch (e) {}
        rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data) }
        const stopped = new Promise((res) => { rec.addEventListener('stop', () => res(), { once: true }) })
        rec.start()
        await new Promise((res) => window.setTimeout(res, 2500))
        try { rec.stop() } catch (e) {}
        await stopped
        if (R._meter) window.clearInterval(R._meter)
        try { if (actx) actx.close() } catch (e) {}
        try { stream.getTracks().forEach((t) => t.stop()) } catch (e) {}
        R.peak = Math.round(peak * 1000) / 1000
        const blob = chunks.length ? new Blob(chunks, { type: rec.mimeType || 'audio/webm' }) : null
        R.bytes = blob ? blob.size : 0
        if (!blob) { R.err = '麦克风没产出数据（MediaRecorder）'; liveCheck(R); done('自检没过：' + R.err); return R }
        R.step = 'wav'
        const w = await liveWav(blob)
        const b64 = w && w.b64
        if (!b64) { R.err = 'WAV 转换失败或超上限'; liveCheck(R); done('自检没过：' + R.err); return R }
        const vp0 = liveVoicePrint(w && w.pcm)                          // 声纹能不能算出来（真环境里自己报数，我看日志就知道）
        R.note = 'maxSeg=' + LIVE_MAX_SEG_MS + (vp0 ? ' f0=' + Math.round(vp0.f0) + ' zcr=' + Math.round(vp0.zcr * 1000) / 1000 : ' 声纹算不出（段太短或全程静音）')
        R.sec = Math.round(((b64.length * 3) / 4 / 32000) * 10) / 10
        R.step = 'transcribe'
        const api = liveApi()
        const t0 = Date.now()
        const r = await api.transcribe({ audioBase64: b64, providerId: LIVE.provider || undefined })
        R.ms = Date.now() - t0
        if (!r || !r.ok) { R.err = '转写失败：' + liveErr(r && r.error); liveCheck(R); done('自检没过：' + R.err); return R }
        const text = liveTextOf(r.value).replace(/\s+/g, ' ').trim()
        R.step = 'done'; R.ok = true; R.textLen = text.length; R.text = text.slice(0, 120)
        liveCheck(R)
        done('自检通过：' + (R.peak < LIVE_SILENCE ? '链路通（这段是静音，正常）' : (text ? '听到「' + text.slice(0, 30) + '」' : '链路通、没听清内容')) + ' · ' + R.ms + 'ms')
      } catch (e) {
        R.err = liveErr(e); liveCheck(R); done('自检异常：' + R.err)
      }
      return R
    }
    // 面板（独立浮层：看板没开也能录；hook 全部在 return null 之前，别破坏 hook 顺序）
    function LivePanel() {
      const [, bump] = useState(0)
      const [draft, setDraft] = useState('')
      const [kw, setKw] = useState('')
      const [hits, setHits] = useState(null)
      const [kind, setKind] = useState('沉默等需求')
      const [anchor, setAnchor] = useState('')
      useEffect(() => liveSub(() => bump((x) => x + 1)), [])
      useEffect(() => { setDraft(LIVE.draft || '') }, [LIVE.draft])
      useEffect(() => {
        if (!LIVE.open) return
        // 每次开面板都试一次：失败不写死（api 停在 error/missing 时，重开面板会再探一次，不会一错到底）
        if (LIVE.api === 'ok') return
        liveCatalog().then(async () => {
          // 每次页面装载后第一次开面板 → 留一条现场（走直连还是宿主桥、provider、错误、浏览器这侧能不能采集）
          if (LIVE.bridged) return
          LIVE.bridged = true
          let devices = -1
          try {
            const md = navigator.mediaDevices
            if (md && md.enumerateDevices) {
              const ds = await md.enumerateDevices()
              devices = ds.filter((x) => x.kind === 'audioinput').length
            }
          } catch (e) { devices = -1 }
          liveCheck({ step: 'open', ok: LIVE.api === 'ok', api: LIVE.api, via: liveRemoteApi() ? 'remote' : 'host', provider: LIVE.provider, secure: !!window.isSecureContext, devices, err: LIVE.err || '' })
        })
      }, [LIVE.open])
      // 拖动面板（按住标题栏）+ 8 向拉大小：位置/大小/配色统一走 lvView() → localStorage（纯前端偏好）
      const dragRef = React.useRef(null)
      const resizeRef = React.useRef(null)
      const startDrag = (e) => {
        if (e.button !== 0) return
        if (e.target && e.target.closest && e.target.closest('button,input,select,textarea,a')) return
        const v0 = LIVE.view || lvViewDef()
        dragRef.current = { dx: e.clientX - v0.x, dy: e.clientY - v0.y }
        e.preventDefault()
      }
      const startResize = (dir) => (e) => {
        if (e.button !== 0) return
        const v0 = LIVE.view || lvViewDef()
        resizeRef.current = { dir: dir, sx: e.clientX, sy: e.clientY, x: v0.x, y: v0.y, w: v0.w, h: v0.h }
        e.preventDefault(); e.stopPropagation()
      }
      useEffect(() => safeEffect('live-drag', () => {
        const move = (e) => { const d = dragRef.current; if (!d) return; lvView({ x: e.clientX - d.dx, y: e.clientY - d.dy }) }
        const up = () => { dragRef.current = null }
        window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
        return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
      }), [])
      useEffect(() => safeEffect('live-resize', () => {
        const move = (e) => {
          const d = resizeRef.current; if (!d) return
          const dx = e.clientX - d.sx, dy = e.clientY - d.sy
          let x = d.x, y = d.y, w = d.w, h = d.h
          if (d.dir.indexOf('e') >= 0) w = d.w + dx
          if (d.dir.indexOf('s') >= 0) h = d.h + dy
          if (d.dir.indexOf('w') >= 0) { w = d.w - dx; x = d.x + (d.w - Math.max(LV_MIN_W, w)) }   // 拖左边：右边界不动
          if (d.dir.indexOf('n') >= 0) { h = d.h - dy; y = d.y + (d.h - Math.max(LV_MIN_H, h)) }   // 拖上边：下边界不动
          lvView({ x: x, y: y, w: w, h: h })
        }
        const up = () => { resizeRef.current = null }
        window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
        return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
      }), [])
      // 窗口缩放时重新夹取（否则 fixed 把手会跟面板错位）
      useEffect(() => safeEffect('live-reclamp', () => {
        const on = () => lvView({})
        window.addEventListener('resize', on)
        return () => window.removeEventListener('resize', on)
      }), [])
      if (!LIVE.open) return null
      const c = LIVE.customer || null
      const v = LIVE.view || lvViewDef()
      const T = lvTheme()
      lvCssOnce()
      // 统一零件（视觉一致性）：msg=提示条（左侧色条） btn=按钮（hover/焦点/按下走 .slv-btn） pill=状态胶囊 chip=小标签 card=分组卡
      const msg = (key, col, txt) => React.createElement('div', { key: key, style: { display: 'flex', alignItems: 'flex-start', fontSize: 11.5, lineHeight: 1.5, color: col, background: T.rowBg, borderLeft: '3px solid ' + col, borderRadius: 6, padding: '5px 8px' } }, txt)
      const btn = (key, label, onClick, opt) => React.createElement('button', Object.assign({
        key: key, onClick: onClick, disabled: !!(opt && opt.disabled), title: (opt && opt.title) || undefined,
        className: 'slv-btn' + (opt && opt.kind ? ' slv-' + opt.kind : ''),
      }, { style: Object.assign({}, LVBTN(!!(opt && opt.active)), (opt && opt.style) || {}) }), label)
      const pill = (txt, col, live) => React.createElement('span', { className: live ? 'slv-pip' : undefined, style: { fontSize: 11, fontWeight: 600, color: col, border: '1px solid ' + col, borderRadius: 999, padding: '1px 8px', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' } }, txt)
      const chip = (txt, col) => React.createElement('span', { style: { fontSize: 10, color: col, border: '1px solid ' + col, borderRadius: 4, padding: '0 4px', flexShrink: 0 } }, txt)
      const card = (key, title, right, body, opt) => React.createElement('div', { key: key, style: { border: (opt && opt.dash ? '1px dashed ' : '1px solid ') + T.border, borderRadius: 8, padding: '8px 10px', background: (opt && opt.flat) ? 'transparent' : T.rowBg } },
        React.createElement('div', { key: 'h', style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 } },
          React.createElement('span', { style: { fontSize: 12, fontWeight: 700, letterSpacing: '.01em' } }, title),
          React.createElement('span', { style: { flex: 1 } }), right || null),
        body)
      const doFind = () => {
        const q = (kw || '').trim(); if (!q) return
        fetchData('sales.search', { kw: q }).then((r) => { setHits((r && r.ok && r.data) ? (r.data.hits || []) : []) })
      }
      // 2026-10-12（A′ 档）：🧠 生成文案 —— 点了才调模型（POST /sales/ai，action=clienttip，最多 20 秒）。
      //   模型失败/超时 → 服务端回规则版草稿（cmdClientTip 的 script），这里如实标"规则版（原因）"。
      const aiGen = () => {
        const cid = (LIVE.customer && (LIVE.customer.id || LIVE.customer.name)) || ''
        if (!cid) { liveSet({ hint: '先定位客户（AI 文案要客户档案兜底）' }); return }
        liveSet({ ai: { busy: true, text: '', mode: '', info: '', ms: 0, error: '' } })
        fetchData('sales.ai', { action: 'clienttip', id: cid }).then((r) => {
          const d = (r && r.ok && r.data) || null
          const a = (d && d.ai) || null
          const good = !!(a && a.ok && a.text)
          const ruleText = String((d && d.rule && d.rule.script) || '')
          const why = (a && a.error) || (r && r.error) || '模型没出结果'
          liveSet({ ai: { busy: false, text: good ? String(a.text) : ruleText, mode: good ? 'ai' : 'rule', info: (a && (a.label || a.model)) || '', local: !!(a && a.local), fellBack: (a && a.fellBack) || '', ms: (a && a.ms) || 0, error: good ? '' : why } })
        })
      }
      // 8 向把手用 fixed 定位（不随面板滚动跑位）；右下角那枚画个 ◢ 让人看得见"能拉"
      const handles = [
        ['n', { left: v.x + 10, top: v.y - 4, width: Math.max(20, v.w - 20), height: 8 }, 'ns-resize'],
        ['s', { left: v.x + 10, top: v.y + v.h - 4, width: Math.max(20, v.w - 20), height: 8 }, 'ns-resize'],
        ['w', { left: v.x - 4, top: v.y + 10, width: 8, height: Math.max(20, v.h - 20) }, 'ew-resize'],
        ['e', { left: v.x + v.w - 4, top: v.y + 10, width: 8, height: Math.max(20, v.h - 20) }, 'ew-resize'],
        ['nw', { left: v.x - 4, top: v.y - 4, width: 14, height: 14 }, 'nwse-resize'],
        ['ne', { left: v.x + v.w - 10, top: v.y - 4, width: 14, height: 14 }, 'nesw-resize'],
        ['sw', { left: v.x - 4, top: v.y + v.h - 10, width: 14, height: 14 }, 'nesw-resize'],
        ['se', { left: v.x + v.w - 16, top: v.y + v.h - 16, width: 16, height: 16 }, 'nwse-resize'],
      ].map((hs) => React.createElement('div', { key: 'rz-' + hs[0], onMouseDown: startResize(hs[0]), title: '拖动调整大小', style: Object.assign({ position: 'fixed', zIndex: 2147483601, background: 'transparent' }, hs[1], { cursor: hs[2] }) },
        hs[0] === 'se' ? React.createElement('span', { key: 'g', style: { position: 'absolute', right: 1, bottom: 0, fontSize: 12, lineHeight: 1, color: T.text2, pointerEvents: 'none' } }, '◢') : null))
      return React.createElement('div', { className: 'slv-panel', style: Object.assign({ position: 'fixed', left: v.x, top: v.y, zIndex: 2147483600, width: v.w, height: v.h, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: T.bg, border: '1px solid ' + T.border, borderRadius: 10, boxShadow: '0 16px 40px rgba(0,0,0,.30), 0 2px 8px rgba(0,0,0,.12)', color: T.text1, fontSize: 13, '--text-1': T.text1, '--text-2': T.text2, '--border-weak': T.border, '--row-bg': T.rowBg, '--blue-color': T.blue, '--danger-color': T.danger, '--warn-color': T.warn, '--ok-color': T.ok, '--accent-tint': T.tint, '--accent-bd': T.bd, '--btn-fg': T.btnFg }, NO_DRAG) },
        React.createElement('div', { key: 'hd', onMouseDown: startDrag, title: '按住这里拖动面板（右下角 ◢ 拉大小）', style: { display: 'flex', gap: 8, alignItems: 'center', padding: '8px 10px', background: T.rowBg, borderBottom: '1px solid ' + T.border, cursor: 'move', userSelect: 'none' } },
          React.createElement('div', { key: 'tb', style: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 } },
            React.createElement('span', { style: { fontWeight: 700, fontSize: 13.5, letterSpacing: '.01em', whiteSpace: 'nowrap' } }, '🎧 通话记录台'),
            c ? React.createElement('span', { style: { fontSize: 11.5, color: T.blue, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, (c.name || '') + (c.phone ? ' ' + c.phone : '')) : React.createElement('span', { style: { fontSize: 11.5, color: T.warn, whiteSpace: 'nowrap' } }, '未选客户（也能出应对）')),
          React.createElement('span', { key: 'sp', style: { flex: 1 } }),
          LIVE.listening ? pill('● 录音中 ' + LIVE.lines.length + ' 段', T.danger, true) : pill(LIVE.lines.length ? (LIVE.lines.length + ' 段') : '待命', T.text2),
          btn('th', '🎨 ' + T.label, lvThemeNext, { title: '切换配色：纸白/墨黑/护眼/高对比（会记住）' }),
          btn('rs', '⤢ 复位', lvViewReset, { title: '位置/大小/配色复位到默认' }),
          btn('x', '✕', () => { if (LIVE.listening) liveStop('已停止（面板关了）'); liveSet({ open: false }) }, { title: '关面板（正在录音会停）' })),
        React.createElement('div', { key: 'bd', style: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 } },
        React.createElement('div', { key: 'find', style: { display: 'flex', gap: 6 } },
          React.createElement('input', { className: 'slv-in', value: kw, placeholder: '客户ID / 公司 / 手机号 → 定位客户（通话前先点一下）', onChange: (e) => setKw(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') doFind() }, style: { flex: 1, background: T.bg, border: '1px solid ' + T.border, borderRadius: 7, padding: '6px 9px', color: T.text1, fontSize: 12.5 } }),
          btn('find', '定位', doFind, { style: { padding: '6px 14px' } })),
        hits ? React.createElement('div', { key: 'hits', style: { display: 'flex', flexDirection: 'column', gap: 4 } },
          (hits || []).slice(0, 5).map((h) => btn(h.id, (h.name || '(无名称)') + '　' + (h.level || '') + '　' + (h.stage || '') + '　' + (h.phone || ''), () => { liveLaunch(h); setHits(null) }, { style: { textAlign: 'left' } })),
          (hits && hits.length) ? null : React.createElement('div', { key: 'no', style: { fontSize: 11.5, color: T.text2 } }, '没找到：不选客户也能用（话术照出）')) : null,
        React.createElement('div', { key: 'ctl', style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
          btn('go', LIVE.lines.length ? '▶ 继续' : '🎙 开始通话', () => liveStart(), { disabled: LIVE.listening, kind: 'primary', style: { fontWeight: 600, padding: '6px 14px' } }),
          btn('ps', '⏸ 暂停', () => liveStop('已暂停（点「继续」接着录）'), { disabled: !LIVE.listening }),
          btn('en', '⏹ 结束通话', liveEnd, { disabled: !LIVE.lines.length, kind: 'danger' }),
          btn('st', LIVE.testing ? '🧪 自检中…' : '🧪 自检', () => liveSelfTest(), { disabled: LIVE.testing, title: '真跑一遍整链：语音服务 → 麦克风 → 录 2.5 秒 → 16k WAV → 转写；结果压在这一行并写进 sale\\logs\\live-check.log' }),
          React.createElement('span', { key: 'sp', style: { flex: 1 } }),
          LIVE.turn ? React.createElement('span', { key: 'tn', style: { fontSize: 11, color: T.text2, fontVariantNumeric: 'tabular-nums' } }, '换人 ' + LIVE.turn + ' 次') : null),
        LIVE.api === 'missing' ? msg('m-api', T.warn, liveApiMiss()) : null,
        LIVE.err ? msg('m-err', T.danger, LIVE.err) : null,
        LIVE.notice ? msg('m-ntc', T.text2, LIVE.notice) : null,
        LIVE.hint ? msg('m-hint', T.blue, LIVE.hint) : null,
        LIVE.selfReport ? msg('m-rep', LIVE.selfReport.indexOf('通过') >= 0 ? T.ok : T.warn, LIVE.selfReport) : null,
        card('tr', '实时转写（本机）',
          React.createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
            React.createElement('span', { style: { fontSize: 11, color: T.text2, fontVariantNumeric: 'tabular-nums' } }, LIVE.phase === 'transcribing' ? '识别中…' : (LIVE.lines.length + ' 段')),
            btn('cp', '📋 复制全文', () => liveCopy(LIVE.lines.map((l) => l.time + ' ' + l.text).join('\n')), { disabled: !LIVE.lines.length, style: { fontSize: 11, padding: '2px 8px' } })),
          React.createElement('div', { key: 'trl', style: { maxHeight: 240, minHeight: 84, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 3, background: T.bg, border: '1px solid ' + T.border, borderRadius: 7, padding: '7px 9px' } },
            LIVE.lines.length ? LIVE.lines.slice(-40).map((l, i) => React.createElement('div', { key: 'ln' + i },
              l.changed ? React.createElement('div', { key: 'tnv', style: { fontSize: 10, color: T.text2, textAlign: 'center', letterSpacing: '.08em', margin: '3px 0 1px' } }, '— 换人 —') : null,
              React.createElement('div', { style: { fontSize: 12.5, lineHeight: 1.55, padding: '2px 0 2px 7px', borderLeft: '3px solid ' + ((l.turn || 0) % 2 ? LV.warn : LV.blue) } },
                React.createElement('span', { style: { color: T.text2, marginRight: 6, fontSize: 10.5, fontVariantNumeric: 'tabular-nums' } }, l.time), l.text)))
              : React.createElement('div', { key: 'non', style: { fontSize: 11.5, color: T.text2, lineHeight: 1.6 } }, '点「开始通话」，电话开外放；一方说完自动出一段（静音段跳过），换人另起一段。'))),
        // 2026-10-12（A′ 档）：🧠 AI 文案（模型写 / 规则兜底）——通话后要发微信·短信的整段文字，点了才调。
        //   **卡片常驻**（否则 LIVE.ai 一开始是 null，按钮根本没地方点）；未生成时只有一个按钮。
        card('aic', '🧠 AI 文案（模型写、规则兜底、可复制即发）',
          (LIVE.ai && LIVE.ai.text) ? React.createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
            LIVE.ai.busy ? chip('生成中…', T.blue)
              : (LIVE.ai.mode === 'ai' ? chip((LIVE.ai.local ? '本地模型 ' : '云端模型 ') + (LIVE.ai.info || '默认') + (LIVE.ai.fellBack === 'cloud' ? '（本地失败→云端）' : ''), T.ok) : chip('规则版', T.warn)),
            LIVE.ai.ms ? React.createElement('span', { key: 'ms', style: { fontSize: 10.5, color: T.text2, fontVariantNumeric: 'tabular-nums' } }, LIVE.ai.ms + 'ms') : null,
            btn('cpai', '📋 复制', () => liveCopy(LIVE.ai.text), { style: { fontSize: 11, padding: '1px 8px' } })) : null,
          React.createElement('div', null,
            btn('genai', (LIVE.ai && LIVE.ai.busy) ? '🧠 生成中…（最多 20 秒）' : ((LIVE.ai && LIVE.ai.text) ? '🧠 重新生成' : '🧠 生成文案（微信/短信）'), aiGen, { disabled: !!(LIVE.ai && LIVE.ai.busy), kind: 'primary', style: { fontWeight: 600 } }),
            (LIVE.ai && LIVE.ai.mode === 'rule' && LIVE.ai.error) ? msg('aie', T.warn, '模型没出结果（' + LIVE.ai.error + '）→ 下面是规则版草稿') : null,
            (LIVE.ai && LIVE.ai.text) ? React.createElement('div', { key: 'at', style: { fontSize: 12.5, lineHeight: 1.6, whiteSpace: 'pre-wrap', background: T.bg, border: '1px solid ' + T.border, borderRadius: 7, padding: '7px 9px', marginTop: 6, userSelect: 'text' } }, LIVE.ai.text) : null,
            React.createElement('div', { key: 'an', style: { fontSize: 10, color: T.text2, marginTop: 4 } }, '发模型前已脱敏（姓名/手机/公司/微信→占位符＋角色·行业标签），回来回填真名；只出文字，不写库。'))),
        LIVE.stageOpen ? React.createElement('div', { key: 'so', style: { padding: '8px 10px', background: T.tint, border: '1px solid ' + T.bd, borderRadius: 8 } },
          React.createElement('div', { style: { fontSize: 11, color: T.text2, marginBottom: 2 } }, '本段该拿到的结果：' + (LIVE.stageOpen.stage || '—')),
          React.createElement('div', { style: { fontSize: 13, fontWeight: 700, lineHeight: 1.5 } }, LIVE.stageOpen.say || ''),
          LIVE.stageOpen.next ? React.createElement('div', { style: { fontSize: 11, color: T.text2, marginTop: 3 } }, '推进：' + LIVE.stageOpen.next) : null) : null,
        LIVE.cues.length ? React.createElement('div', { key: 'cues', style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          LIVE.cues.map((q, i) => React.createElement('div', { key: 'q' + i, style: { padding: '7px 9px', background: T.bg, borderRadius: 7, border: '1px solid ' + T.border } },
            React.createElement('div', { key: 'qh', style: { display: 'flex', gap: 6, alignItems: 'center' } },
              chip(q.cue, T.danger),
              q.hot ? React.createElement('span', { key: 'hot', style: { fontSize: 10, color: T.warn } }, '刚说的') : null,
              React.createElement('span', { key: 'sp', style: { flex: 1 } }),
              btn('cp', '📋 复制这句', () => liveCopy(q.say), { style: { fontSize: 11, padding: '1px 8px' } })),
            React.createElement('div', { key: 'say', style: { fontSize: 12.5, fontWeight: 600, marginTop: 3, whiteSpace: 'pre-wrap', lineHeight: 1.55 } }, q.say),
            React.createElement('div', { key: 'why', style: { fontSize: 11, color: T.text2, marginTop: 3, lineHeight: 1.5 } }, q.why || '')))) : null,
        LIVE.moves.length ? React.createElement('div', { key: 'mv', style: { fontSize: 11, color: T.text2, lineHeight: 1.5 } }, '推进点：' + LIVE.moves.map((m) => m.stage + '（' + (m.because || '') + '：' + (m.action || '') + '）').join('；')) : null,
        React.createElement('div', { key: 'ask', style: { display: 'flex', gap: 8, alignItems: 'center' } },
          btn('askb', '🤖 问AI 助手（深度话术）', () => liveInsert(liveAskPrompt(), '已把「客户+最近对话+提问角度」插进输入框，回车问AI 助手'), { style: { fontWeight: 600 } }),
          React.createElement('span', { key: 'w', style: { fontSize: 11, color: LIVE.inputActions ? T.ok : T.warn, lineHeight: 1.4 } }, LIVE.inputActions ? '走会话输入框，不偷偷烧 token' : '输入栏没接上 → 自动复制到剪贴板')),
        card('st', '给客户点名结论（沉默等需求/暂缓 必须给锚点）', null,
          React.createElement('div', null,
            React.createElement('div', { key: 'k', style: { display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6 } },
              ['沉默等需求', '暂缓', '无法联系', '推进终止', '成交签约'].map((k) => btn(k, k, () => setKind(k), { active: kind === k }))),
            React.createElement('div', { key: 'ar', style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
              React.createElement('input', { className: 'slv-in', type: 'date', value: anchor, onChange: (e) => setAnchor(e.target.value), style: { background: T.bg, border: '1px solid ' + T.border, borderRadius: 7, padding: '4px 7px', color: T.text1, fontSize: 12 } }),
              btn('ins', '插入结论指令', () => { if (!c) { liveSet({ hint: '先定位客户再点名结论' }); return } if (!anchor && (kind === '沉默等需求' || kind === '暂缓')) { liveSet({ hint: '这两种结论必须给日期锚点（到期会自动冒红点）' }); return } liveInsert(liveSettleText(kind, anchor), '结论指令已插入输入框，回车落库') }, { style: { fontWeight: 600 } }),
              React.createElement('span', { key: 'ah', style: { fontSize: 11, color: T.text2 } }, '日期锚点到期自动冒红点'))), { dash: true })),
        React.createElement('div', { key: 'df', style: { borderTop: '1px solid ' + T.border, background: T.rowBg, padding: '8px 12px 10px' } },
          React.createElement('div', { key: 'dfh', style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 } },
            React.createElement('span', { style: { fontSize: 12, fontWeight: 700 } }, '跟进记录草稿'),
            React.createElement('span', { style: { flex: 1 } }),
            React.createElement('span', { key: 'dft', title: '口径：方式=电话 / 内容=本次转写 / 类型=高意向跟进', style: { fontSize: 11, color: T.text2 } }, '结束通话自动发这条')),
          React.createElement('textarea', { className: 'slv-in', value: draft, onChange: (e) => setDraft(e.target.value), rows: 4, style: { width: '100%', boxSizing: 'border-box', background: T.bg, border: '1px solid ' + T.border, borderRadius: 7, padding: '6px 8px', color: T.text1, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11.5, lineHeight: 1.55, resize: 'vertical' } }),
          React.createElement('div', { key: 'dfb', style: { display: 'flex', gap: 6, marginTop: 5, alignItems: 'center', flexWrap: 'wrap' } },
            btn('save', '落库（插入输入框）', () => { if (!c) { liveSet({ hint: '先定位客户再落库' }); return } liveInsert(draft, '跟进记录指令已插入输入框，回车落库（两表）') }, { disabled: !draft, kind: 'primary', style: { fontWeight: 600 } }),
            btn('cpd', '📋 复制', () => liveCopy(draft), { disabled: !draft }),
            React.createElement('label', { key: 'au', title: '开：通话一停就把上面这条 sales_log 指令自动发进对话（AI 助手接着调 sales_log 写两表）；关：只生成草稿，你点「落库」才发。写库永远走AI 助手工具，HTTP 面只读。', style: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: T.text2, cursor: 'pointer' } },
              React.createElement('input', { type: 'checkbox', checked: !!(LIVE.view && LIVE.view.auto), onChange: (e) => lvView({ auto: !!e.target.checked }) }),
              '通话一停自动落库'),
            React.createElement('span', { key: 'dh', style: { fontSize: 10.5, color: T.text2 } }, '写库只走AI 助手工具（HTTP 面只读）'))), handles)
    }
    // 🎧 入口（两个注册点）——**绝对不要**注册进 `conversation.input.activity`！
    //   2026-10-09 崩溃定案（我踩的，别再踩）：那个槽位是宿主里的 **single 槽**（官方麦克风插件占用）。
    //   dsh-sales 在 profile bundles 里排在 voice-input-bundle **之前** → 我们先注册成功 → 官方插件随后
    //   `slots.register` 抛 `single slot "conversation.input.activity" already has a registration`
    //   → 它的 fiber = FAILED → 桌面端渲染层 `web boot: 1 entry did not activate`
    //   → app-boot 的 reportFatal → **整个桌面端启动即崩**（两次，08:57:11 / 08:57:21）。
    //   口径：**single 槽只许它的占用者注册**；要加入口就注册到 **list 槽**（下面两个都是 list，多条目安全）。
    //   ① `sidebar.footer.action`（sidebar bundle 声明 `{kind:'list', scope:'root'}`，只传 `{wide}`）= 插件入口在这（sales-panel 一条）；
    //   ② `conversation.input.left`（conversation bundle 声明 `{kind:'list', scope:'session'}`）= **接线在这，但渲染 null（不放图标）**。
    //   2026-10-10 asar 取证定案（别再猜）：inputActions 只由官方会话插件在 **session 作用域** provide
    //   （`ctx.uiSession.provide({ props: ['inputActions'], resolve: () => ({ props: { inputActions: shell.actions } }) })`；
    //   全 asar 只有 `['inputActions']` 与 `['sessionId']` 两处 props）→ root 槽拿不到，会话槽才行。
    //   所以：老代码挂在侧边栏、`liveInsert` 没 span → 一直是"复制到剪贴板"（官方 voice-input 是 `insertText(text, captureInsertion())`）。
    // 通话记录台文案（2026-10-15 用户定「这个不独立展示，属于sale插件的内置功能」）：
    //   侧边栏那条通话记录台注册已删（注册点 5 → 4），改由看板面板标题栏的控件用（见 Board 标题栏 `liveLaunch(LIVE.customer)`）。
    var LIVE_GLYPH = '🎧'
    var LIVE_ENTRY_LABEL = LIVE_GLYPH + '通话记录台'
    // 通话记录台的可见入口在**看板面板标题栏**（2026-10-15 起）。这个会话槽**只用来接线、不画任何东西**：
    //   2026-10-12 用户「去掉通话记录台的入口图标」——输入栏那一行的图标撤掉，返回 null。
    //   渲染期就写（宿主 provide 是异步 resolve 的，只挂 useEffect 会漏掉第一次渲染拿到的那份）；
    //   渲染 null 不影响 props 下发：inputActions / sessionId 照旧每次渲染都接上（自动落库不断线）。
    function LiveComposerEntry(props) {
      const ia = props && props.inputActions
      const sid = props && props.sessionId
      if (ia) LIVE.inputActions = ia
      if (sid) LIVE.sessionId = sid
      useEffect(() => { if (ia) LIVE.inputActions = ia; if (sid) LIVE.sessionId = sid }, [ia, sid])
      return null                 // 不出图标：输入栏那一行保持干净（用户 2026-10-12）
    }
    safeEffect('live-wire-slot', () => slots.inject('conversation.input.left', () => slots.register(
      { name: 'conversation.input.left', id: 'sales-live-wire', order: 30, label: '通话记录台' },
      LiveComposerEntry,
    )))
    safeEffect('live-panel-slot', () => slots.inject('shell.overlay', () => slots.register(
      { name: 'shell.overlay', id: 'sales-live-panel', order: 20, label: 'AI-CRM通话记录台' },
      () => {
        // 渲染异常不往外抛（同看板 2026-10-08 事故口径）：抛出去会被宿主 abdicate 整条贡献
        try { return LivePanel() } catch (e) {
          try { console.error('[sales-live render] ' + liveErr(e), e) } catch (_) {}
          return React.createElement('div', { style: Object.assign({ position: 'fixed', left: 12, top: 64 + CLEARANCE, zIndex: 2147483599, background: '#1b1d22', border: '1px solid #c92a2a', borderRadius: 8, padding: 16, color: '#ff8787', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }, NO_DRAG) },
            '[通话记录台渲染失败] ' + liveErr(e))
        }
      },
    )))

    // 标题栏按钮（2026-09-29 用户报障「字体颜色不清晰，需要加深」）：
    //   ① 文字走专用令牌 --btn-fg（浅色主题 #12161c 深墨 / 深色主题 #e6eaf0 近白），不再用 --text-2 的灰；
    //      （不直接用 --text-1：深色主题的 THEME.text1 本身是 var(--text-1, …)，root 注入会同名自引用，
    //        继承到按钮上会退化成 fallback，只能给工具栏单开一个字面量令牌）
    //   ② 选中态改成 强调色淡底 + 强调色描边 + 加粗，**不再用白字压淡蓝底**（浅色主题下白字几乎看不见）；
    //   底色/描边令牌化（--accent-tint / --accent-bd 由 root 注入），禁硬编码 rgba。
    function btn(active) {
      return {
        background: active ? 'var(--accent-tint, rgba(37,99,235,.15))' : 'none',
        border: '1px solid ' + (active ? 'var(--accent-bd, rgba(37,99,235,.45))' : 'var(--border-weak,rgba(128,128,128,.35))'),
        borderRadius: 6, padding: '4px 10px',
        color: 'var(--btn-fg, #12161c)',
        fontWeight: active ? 600 : 500,
        cursor: 'pointer', fontSize: 12, lineHeight: '18px',
      }
    }
    function loadingP() {
      return React.createElement('div', { style: { color: 'var(--text-2,#888)', fontSize: 13, padding: '8px 0' } }, '加载中…')
    }
    function sectionBar(title, dist) {
      const entries = Object.entries(dist || {})
      const total = entries.reduce((s, [, v]) => s + v, 0) || 1
      return React.createElement('div', { style: { marginBottom: 14 } },
        React.createElement('div', { style: { fontSize: 12, color: 'var(--text-2,#888)', marginBottom: 6 } }, title + ' (' + (total || 0) + ')'),
        React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
          entries.map(([k, v]) => React.createElement('div', { key: k, style: { display: 'flex', alignItems: 'center', gap: 8 } },
            React.createElement('span', { style: { width: 90, fontSize: 12, flexShrink: 0 } }, String(k)),
            React.createElement('div', { style: { flex: 1, height: 14, background: 'rgba(128,128,128,.12)', borderRadius: 4, overflow: 'hidden' } },
              React.createElement('div', { style: { width: String((v / total) * 100) + '%', height: '100%', background: 'var(--blue-color, #1c7ed6)', borderRadius: 3 } })),
            React.createElement('span', { style: { width: 60, fontSize: 12, textAlign: 'right' } }, String(v)),
          ))),
      )
    }
    // 2026-10-12（模型面 A′ 档）：通用复制（AI 话术/文案）。优先 clipboard API，失败退 execCommand
    //   （与 copyPhoneToClipboard 同款兜底；本机 http://127.0.0.1 是安全上下文，正常走 clipboard）。
    function aiCopy(text, btnEl) {
      const target = String(text || '')
      if (!target) return
      const flash = () => {
        if (!btnEl) return
        const old = btnEl.textContent
        btnEl.textContent = '✓ 已复制'
        setTimeout(() => { try { if (btnEl.isConnected) btnEl.textContent = old } catch (e) {} }, 1200)
      }
      const fallback = () => {
        try {
          const ta = document.createElement('textarea')
          ta.value = target
          ta.style.position = 'fixed'
          ta.style.opacity = '0'
          document.body.appendChild(ta)
          ta.focus(); ta.select()
          document.execCommand('copy')
          document.body.removeChild(ta)
          flash()
        } catch (e) { /* 复制失败静默 */ }
      }
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(target).then(flash, fallback); return }
      } catch (e) { /* 退兜底 */ }
      fallback()
    }
    function copyPhoneToClipboard(c, btnEl) {
      // 清洗手机号：只留 ASCII 0-9（去空格/横杠/括号/+86/全角数字/回车换行）
      const raw = String(c.phone || '').trim()
      if (!raw) return
      const target = raw
        .replace(/[\s\u3000]+/g, '')   // 去半角/全角空格
        .replace(/\r|\n/g, '')          // 去回车换行
        .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)) // 全角数字→半角
        .replace(/\D/g, '')             // 剔除非数字（含 - 、+86、( ) 等）
      if (!target) return
      const flash = () => {
        if (!btnEl) return
        const old = btnEl.textContent
        btnEl.textContent = '✓ 已复制'
        btnEl.style.background = 'rgba(64,192,120,.35)'
        setTimeout(() => { if (btnEl.isConnected) { btnEl.textContent = old; btnEl.style.background = 'rgba(64,192,120,.12)' } }, 1200)
      }
      const fallback = () => {
        try {
          const ta = document.createElement('textarea')
          ta.value = target
          ta.style.position = 'fixed'
          ta.style.opacity = '0'
          document.body.appendChild(ta)
          ta.focus(); ta.select()
          document.execCommand('copy')
          document.body.removeChild(ta)
          flash()
        } catch (e) { /* 复制失败静默 */ }
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(target).then(flash, fallback)
      } else fallback()
    }
    function copyBtn(c) {
      if (!c.phone) return null
      return React.createElement('button', {
        onClick: (e) => { e.stopPropagation(); copyPhoneToClipboard(c, e.currentTarget) },
        title: '复制手机号（无格式纯数字）',
        style: {
          background: 'rgba(64,192,120,.12)',
          border: '1px solid rgba(64,192,120,.45)',
          borderRadius: 6, padding: '3px 8px', color: 'var(--text-1, #fff)', cursor: 'pointer', fontSize: 12, flexShrink: 0,
        }
      }, '📋 复制')
    }
    // ========== AI 对话框（2026-10-21 用户 m01480 / m02018 建在右侧；2026-10-22 m00521 挪到左侧） ==========
    //   用户原话：「在sale插件右侧边增加AI对话框，用于管理和输入跟进信息，不用再回到DSH的界面对话去操作了，
    //   模型可选，要支持多模态的文件和图片上传。」（m02018 又定：只做 sale 这一侧，loop 已停用。）
    //   三条边界（改的人先看）：
    //   ① 服务端在 dsh/dock.js（POST /sales/assistant）：调模型、抽图片/文件文本、出确认卡；
    //      本组件只负责收集输入、转 base64、渲染。
    //   ② 上限与后端 dsh/dock-attach.cjs 的 CAPS 一致：图片 4 张 × 4MB、文件 4 个 × 2MB、单条文字 4000 字。
    //   ③ **侧栏不自己写库**：模型给的 {"action":"log",...} 只渲染成确认卡，点确认后把 `sales_log {...store}`
    //      指令用 LIVE.inputActions 发进对话 → 仍由AI 助手调 sales_log（数据层写入口：写锁+表头断言+变更留痕）。
    //      输入栏没接上就退剪贴板，绝不绕过写入口直接改表。
    var AI_DOCK_KEY = 'sales-ai-dock.v1'
    // 2026-10-21（m02562）：文件上限 2MB→8MB（合同/报价 PDF 常超 2MB）；对话要落 localStorage，退出插件不丢。
    var AI_DOCK_LIMIT = { images: 4, imageBytes: 4 * 1024 * 1024, imageTotalBytes: 8 * 1024 * 1024, files: 4, fileBytes: 8 * 1024 * 1024 }
    var AI_DOCK_LOG = AI_DOCK_KEY + '.log'          // 当前这条对话（退出插件后还在）
    var AI_DOCK_ARCH = AI_DOCK_KEY + '.archive'     // 「新开对话」时把旧的收进这里（只留最近 5 段）
    var AI_DOCK_LOG_MAX = 80                        // 最多存 80 条消息，防 localStorage 撑爆
    // 2026-10-21（m05130）：4000→12000。历史里长回答被切掉后半段（行数/列结构/映射样例）＝"它不记得"。
    var AI_DOCK_TEXT_MAX = 12000
    // 面板身份：附件正文要按面板跨轮复用（服务端 FILE_CACHE 用它做 key）。换个浏览器/清缓存就换一个。
    var AI_DOCK_PANEL = AI_DOCK_KEY + '.panel'
    // 2026-11-11（1.3.0）：客户标识**一律用手机号**，不再出现 C- 开头的客户ID。
    //   原「公司名（联系人）· 客户ID」那一版用户看不出是哪个客户（ID 跟旁边 SOP 卡顶部的公司名对不上）；
    //   手机号是客户表的主识别键（同一号码只允许一个客户），面板里也是用户自己熟悉的标识。
    function aiDockCustLabel(card) {
      var a = (card && card.args) || {}
      var c = (card && card.customer) || null
      var phone = String(a.phone || (c && c.phone) || '').trim()
      var name = String((c && c.name) || '').trim()
      var contact = String((c && c.contact) || '').trim()
      var head = name ? (name + (contact ? '（' + contact + '）' : '')) : contact
      if (phone) return (head ? head + ' · ' : '') + phone
      return (head ? head + ' · ' : '') + '缺手机号'
    }
    // 确认卡可编辑（1.3.0）：卡的 9 个可改字段 + 三个下拉的取值域。
    //   手机号只读（改手机号＝换客户，必须走客户表），其它都能在卡上改完再确认。
    var AI_CARD_FIELDS = [
      ['what', '事实（聊了什么/做了什么）', 'textarea'],
      ['date', '日期', 'date'],
      ['method', '方式', 'method'],
      ['type', '类型', 'type'],
      ['stage', '环节', 'stage'],
      ['react', '对方反应', 'text'],
      ['nextAction', '下一步', 'text'],
      ['nextDate', '下次日期', 'date'],
      ['nextMethod', '下次方式', 'method'],
    ]
    var AI_CARD_METHODS = ['电话', '微信', '上门', '短信', '合同', '官网申请', '其他']
    var AI_CARD_TYPES = ['首触', '试用回访', '高意向跟进', '老客服务', '客户反馈', '策略调整', '放弃跟进', '数据整理']
    var AI_CARD_STAGES = ['线索获取', '客户触达', '需求挖掘', '产品演示', '异议处理', '方案报价', '成交签约',
      '企业级机会', '决策链摸排', '需求与现状勘察', '方案与试点设计', '商务推进', '私有化签约',
      '无法联系', '推进终止', '其他跟进记录']
    function aiCardDraftOf(card) {
      var a = (card && card.args) || {}
      var d = {}
      for (var i = 0; i < AI_CARD_FIELDS.length; i++) d[AI_CARD_FIELDS[i][0]] = String(a[AI_CARD_FIELDS[i][0]] || '')
      return d
    }
    function aiCardFilled(d) {
      var n = 0
      for (var i = 0; i < AI_CARD_FIELDS.length; i++) if (String((d || {})[AI_CARD_FIELDS[i][0]] || '').trim()) n++
      return n
    }
    // 回执里手机号打码（1xx****xxxx）：够认出是谁，又不用把整串号码写在对话里。
    function aiDockPhoneMask(p) {
      var s = String(p || '').replace(/[^0-9]/g, '')
      if (!s) return '—'
      if (s.length < 7) return s
      return s.slice(0, 3) + '****' + s.slice(-4)
    }
    function aiDockPanelId() {
      try {
        var v = localStorage.getItem(AI_DOCK_PANEL)
        if (v && typeof v === 'string' && v.length >= 8) return v
        var n = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
        localStorage.setItem(AI_DOCK_PANEL, n)
        return n
      } catch (e) { return 'p-fallback' }
    }
    var AI_DOCK_BUSY_SINCE = 0                      // 本次请求发出的时刻（模块级即可：面板只有一个实例，省掉一个 hook）
    function aiDockLoadMsgs() {
      try {
        var raw = localStorage.getItem(AI_DOCK_LOG)
        var arr = raw ? JSON.parse(raw) : []
        return Array.isArray(arr) ? arr.filter(function (m) { return m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string' }) : []
      } catch (e) { return [] }
    }
    function aiDockSaveMsgs(list) {
      // 2026-10-21 体检（m03962 P2）：localStorage 写满会静默抛异常（QuotaExceededError）→ 对话**再也存不上**
      //   而且用户完全看不出来。三级降级：原样 → 长回答截断 → 只留最近 20 条；最后再失败就把 key 清掉，
      //   保证下一次还有机会写进去（返回 true/false 给调用方，界面上会提示一句）。
      function put(arr) { try { localStorage.setItem(AI_DOCK_LOG, JSON.stringify(arr)); return true } catch (e) { return false } }
      var all = (list || []).slice(-AI_DOCK_LOG_MAX)
      if (put(all)) return true
      // 2026-10-22（m01968）新增一档：先削「放大档」（view）、保对话本身与缩略图。
      //   图多的对话（4 张 × ~300KB）容易把 localStorage 顶掉；削了之后点开还是能看，只是清晰版没了。
      var noView = all.map(function (m) {
        if (!m || !Array.isArray(m.atts)) return m
        return Object.assign({}, m, {
          atts: m.atts.map(function (a) {
            return (a && a.view) ? { kind: a.kind, name: a.name, size: a.size, thumb: a.thumb } : a
          }),
        })
      })
      if (put(noView)) return true
      var clipped = noView.map(function (m) { return (m && typeof m.text === 'string' && m.text.length > AI_DOCK_TEXT_MAX) ? Object.assign({}, m, { text: m.text.slice(0, AI_DOCK_TEXT_MAX) + '\n…（太长，历史里只留前半段）' }) : m })
      if (put(clipped)) return true
      if (put(clipped.slice(-20))) return true
      try { localStorage.removeItem(AI_DOCK_LOG) } catch (e2) {}
      return false
    }
    function aiDockArchive() {      // 「新开对话」= 把当前这条收档（不删！），再开一条空的。删不删由用户自己点「清空」。
      try {
        var cur = aiDockLoadMsgs()
        if (!cur.length) return
        var raw = localStorage.getItem(AI_DOCK_ARCH)
        var arch = raw ? JSON.parse(raw) : []
        if (!Array.isArray(arch)) arch = []
        arch.unshift({ at: new Date().toISOString(), msgs: cur })
        localStorage.setItem(AI_DOCK_ARCH, JSON.stringify(arch.slice(0, 5)))
      } catch (e) {}
    }
    // 2026-10-21 夜（m06146）：SSE 流式读（POST + fetch reader，和 growth 的 ai.stream 同一套写法）。
    //   「停止」= abort 这个 AbortController → 服务端 req close → dockConverse 的 shouldStop() 变真，
    //   模型那边立刻收流，已生成的部分照常落进对话（不会白花钱）。
    var AI_DOCK_ABORT = null
    function aiDockStop() { try { if (AI_DOCK_ABORT) AI_DOCK_ABORT.abort() } catch (e) {} }
    async function aiDockStream(body, h) {
      var H = h || {}
      var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null
      AI_DOCK_ABORT = ctl
      var timer = setTimeout(function () { try { if (ctl) ctl.abort() } catch (e) {} }, 300000)
      var resp
      try {
        resp = await fetch('/sales/assistant', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(Object.assign({ action: 'stream' }, body || {})),
          signal: ctl ? ctl.signal : undefined,
        })
      } catch (e) {
        clearTimeout(timer); AI_DOCK_ABORT = null
        // 2026-10-21 夜（用户 m06887 实测）：点「停止」= abort 这个 fetch → 它抛 AbortError，
        //   原来这里不分青红皂白就报「⚠ 连不上服务（宿主可能正在重启）」——明明是自己按的停止，
        //   害用户以为宿主挂了。停止必须和网络故障分开报：aborted 标记给上层，上层显示「⏹ 已停止」。
        var em = String((e && e.message) || e)
        if ((e && e.name === 'AbortError') || /abort/i.test(em)) return { ok: false, aborted: true, error: '已停止' }
        return { ok: false, error: '连不上服务（宿主可能正在重启）：' + em.slice(0, 80) }
      }
      if (!resp.ok || !resp.body) {
        clearTimeout(timer); AI_DOCK_ABORT = null
        if (resp.status === 413) return { ok: false, error: '附件总量超过上限：图片合计 ≤8MB、文件每个 ≤8MB' }
        if (resp.status === 401 || resp.status === 403) return { ok: false, error: '服务拒绝（HTTP ' + resp.status + '）：宿主可能正在重启' }
        return { ok: false, error: '服务返回 HTTP ' + resp.status }
      }
      var reader = resp.body.getReader()
      var dec = new TextDecoder('utf-8')
      var buf = ''
      var done = null
      var err = null
      try {
        while (true) {
          var rs = await reader.read()
          if (rs.done) break
          buf += dec.decode(rs.value, { stream: true })
          var idx = buf.indexOf('\n\n')
          while (idx >= 0) {
            var frame = buf.slice(0, idx); buf = buf.slice(idx + 2)
            var ev = ''
            var data = ''
            var fl = frame.split('\n')
            for (var i = 0; i < fl.length; i++) {
              if (fl[i].indexOf('event: ') === 0) ev = fl[i].slice(7).trim()
              else if (fl[i].indexOf('data: ') === 0) data += fl[i].slice(6)
            }
            idx = buf.indexOf('\n\n')
            if (!ev) continue
            var obj = null
            try { obj = data ? JSON.parse(data) : {} } catch (e2) { obj = null }
            if (ev === 'delta') { if (H.onDelta) H.onDelta(String((obj && obj.t) || '')) }
            else if (ev === 'tool') { if (H.onTool) H.onTool(obj || {}) }
            else if (ev === 'reset') { if (H.onReset) H.onReset() }
            else if (ev === 'done') done = obj || {}
            else if (ev === 'error') err = String((obj && obj.message) || '流式失败')
          }
        }
      } catch (e) {
        clearTimeout(timer); AI_DOCK_ABORT = null
        var m = String((e && e.message) || e)
        if (/abort/i.test(m) || (e && e.name === 'AbortError')) return { ok: false, aborted: true, error: '已停止' }
        return { ok: false, error: '读流中断：' + m }
      }
      clearTimeout(timer); AI_DOCK_ABORT = null
      if (done) return Object.assign({ ok: done.ok !== false }, done)
      if (err) return { ok: false, error: err }
      return { ok: false, error: '流结束了但没收到结果（宿主可能重启了）' }
    }
    function aiDockHuman(n) {
      var v = Number(n) || 0
      if (v >= 1024 * 1024) return (Math.round(v / 1024 / 102.4) / 10) + 'MB'
      if (v >= 1024) return Math.round(v / 1024) + 'KB'
      return v + 'B'
    }
    function aiDockReadB64(file) {
      return new Promise(function (resolve) {
        try {
          var fr = new FileReader()
          fr.onload = function () { var s = String(fr.result || ''); var i = s.indexOf(','); resolve(i >= 0 ? s.slice(i + 1) : '') }
          fr.onerror = function () { resolve('') }
          fr.readAsDataURL(file)
        } catch (e) { resolve('') }
      })
    }
    // 2026-10-21（m04970）：附件在气泡里得看得见。
    //   用户传了「我们公司后台导出的客户最新信息表」问问题，气泡里只剩一句文字 —— 分不清到底传没传上去、
    //   传的是哪个文件；选中时的 chip 在发出去那一刻就被清空了，事后无从核对。
    //   做法：发送时把附件摘要钉在用户消息上（图片给 56px 缩略图 dataURL，文件给名字+大小），
    //   随对话一起落 localStorage，退出插件再进来、点开历史也都还在。
    // 2026-10-22（用户 m01968「无法放大查看上传的图片」）：原来气泡里只有 56px 缩略图，
    //   点一下是 window.open 一个只有缩略图的小窗 —— 放大还是糊的，Electron 里新窗口还常被拦。
    //   现在一次解码出两档：thumb（56px 缩略图，气泡里显示）+ view（长边 ≤1400px、JPEG 0.82，
    //   点开放大看正文/表格字用），都随对话落 localStorage；两档都设体积上限，超了就当没有。
    function aiDockPics(file) {
      return new Promise(function (resolve) {
        var none = { thumb: '', view: '' }
        try {
          if (!file || !/^image\//.test(String(file.type || ''))) { resolve(none); return }
          var url = URL.createObjectURL(file)
          var img = new Image()
          img.onload = function () {
            try {
              var w = img.naturalWidth || 56, h = img.naturalHeight || 56
              var canvasOf = function (maxEdge) {
                var s = Math.min(1, maxEdge / Math.max(w, h))
                var cw = Math.max(1, Math.round(w * s)), ch = Math.max(1, Math.round(h * s))
                var cv = document.createElement('canvas')
                cv.width = cw; cv.height = ch
                cv.getContext('2d').drawImage(img, 0, 0, cw, ch)
                return cv
              }
              var thumb = ''
              try { thumb = canvasOf(56).toDataURL('image/jpeg', 0.7) } catch (e0) { thumb = '' }
              if (String(thumb || '').length > 12000) thumb = ''
              // 放大档：先长边 1400；太大降到 1000/0.72；还大就放弃（宁可只给缩略图，别把 localStorage 撑爆）
              var view = ''
              var tries = [[1400, 0.82], [1000, 0.72]]
              for (var t = 0; t < tries.length; t++) {
                try { view = canvasOf(tries[t][0]).toDataURL('image/jpeg', tries[t][1]) } catch (e1) { view = '' }
                if (String(view || '').length && String(view).length <= 420000) break
                view = ''
              }
              URL.revokeObjectURL(url)
              resolve({ thumb: thumb, view: view })
            } catch (e) { try { URL.revokeObjectURL(url) } catch (e2) {} resolve(none) }
          }
          img.onerror = function () { try { URL.revokeObjectURL(url) } catch (e) {} resolve(none) }
          img.src = url
        } catch (e) { resolve(none) }
      })
    }
    // 兼容旧调用名（之前只有缩略图）
    function aiDockThumb(file) { return aiDockPics(file).then(function (p) { return p.thumb }) }
    // 发出去的那一刻把附件变成"能落盘、能重画"的摘要（File 对象本身存不进 localStorage）
    async function aiDockAttsOf(imgs, files) {
      var out = []
      for (var i = 0; i < (imgs || []).length; i++) {
        var pics = await aiDockPics(imgs[i].file)
        out.push({ kind: 'image', name: String(imgs[i].name || '图片'), size: Number(imgs[i].size) || 0, thumb: pics.thumb, view: pics.view })
      }
      for (var j = 0; j < (files || []).length; j++) {
        out.push({ kind: 'file', name: String(files[j].name || '文件'), size: Number(files[j].size) || 0 })
      }
      return out
    }
    // 用户气泡下方的附件行（图片=缩略图，文件=📄 名字+大小）
    function AiDockAtts(props) {
      var C = {
        bg: 'var(--row-bg, rgba(128,128,128,.06))', bd: 'var(--border-weak, rgba(128,128,128,.28))',
        t1: 'var(--text-1, #e6eaf0)', t2: 'var(--text-2, #8b95a3)', t3: 'var(--text-3, #6b7280)',
      }
      var list = Array.isArray(props.atts) ? props.atts : []
      if (!list.length) return null
      return React.createElement('div', { 'data-sales-act': 'ai-dock-atts', style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4, maxWidth: '92%', justifyContent: 'flex-end' } },
        list.map(function (a, i) {
          if (a && a.kind === 'image' && a.thumb) {
            var canBig = !!a.view
            return React.createElement('img', {
              key: 'a' + i, src: a.thumb, alt: String(a.name || '图片'),
              title: String(a.name || '') + ' ' + aiDockHuman(a.size) + (canBig ? '｜点击放大' : '｜（旧对话只有缩略图）'),
              style: { width: 52, height: 52, objectFit: 'cover', borderRadius: 6, border: '1px solid ' + C.bd, cursor: 'zoom-in' },
              onClick: function () {
                // 2026-10-22（m01968）：点开=面板内放大浮层（view 档，长边 1400），不再开只有缩略图的窗口
                if (props.onView) props.onView({ src: a.view || a.thumb, name: String(a.name || '图片'), sharp: canBig })
              },
            })
          }
          return React.createElement('span', { key: 'a' + i, title: String(a.name || ''), style: { fontSize: 11, padding: '2px 7px', borderRadius: 10, border: '1px solid ' + C.bd, background: C.bg, color: C.t2 } },
            '📄 ' + String(a.name || '文件') + ' ' + aiDockHuman(a.size))
        }))
    }
    // 2026-10-22（用户 m01968「无法放大查看上传的图片」）：点缩略图 → 面板内全屏浮层放大。
    //   为什么不 window.open：Electron 里新窗口常被拦，而且原来给的是 56px 缩略图，放大也是糊的。
    //   这里显示的是发送时生成并落盘的 view 档（长边 ≤1400、JPEG 0.82），纯本机 dataURL，不联网。
    //   关法：点任意处 / 点 ✕ / 按 Esc；另有「存到本机」直出文件。
    function AiDockViewer(props) {
      var v = (props && props.view) || {}
      React.useEffect(function () {
        function onKey(e) {
          if (!e) return
          if (e.key === 'Escape' || e.key === 'Esc') { if (props.onClose) props.onClose() }
        }
        try { window.addEventListener('keydown', onKey) } catch (e) {}
        return function () { try { window.removeEventListener('keydown', onKey) } catch (e) {} }
      }, [])
      if (!v.src) return null
      return React.createElement('div', {
        'data-sales-act': 'ai-dock-viewer',
        onClick: function () { if (props.onClose) props.onClose() },
        title: '点任意处或按 Esc 关闭',
        style: { position: 'fixed', left: 0, top: 0, right: 0, bottom: 0, zIndex: 4000, background: 'rgba(0,0,0,.88)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, cursor: 'zoom-out' },
      },
        React.createElement('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, maxWidth: '96vw', maxHeight: '96vh' } },
          React.createElement('img', {
            src: v.src, alt: String(v.name || '图片'),
            style: { maxWidth: '94vw', maxHeight: '84vh', objectFit: 'contain', borderRadius: 6, background: '#0b0d10', boxShadow: '0 8px 36px rgba(0,0,0,.55)' },
          }),
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 12, fontSize: 11.5, color: '#d6dbe4' } },
            React.createElement('span', {}, String(v.name || '图片') + (v.sharp === false ? '（旧对话只有缩略图，放大是糊的）' : '')),
            React.createElement('a', {
              href: v.src, download: String(v.name || 'image.jpg'),
              onClick: function (e) { e.stopPropagation() },
              style: { color: '#9fc2ff', textDecoration: 'none' },
            }, '⬇ 存到本机'),
            React.createElement('span', { style: { opacity: .65 } }, '点任意处 / Esc 关闭'))))
    }
    // 助手这一侧也回一句"到底收到没有"（m04970）：服务端 uploadSummary 有 images/files/fileChars，
    //   直接照实回显，爹一眼能看出是传丢了、还是传上去了只是模型没答到点上。
    function aiDockRxOf(att) {
      try {
        if (!att) return ''
        var bits = []
        if (Number(att.images || 0) > 0) bits.push('图片 ' + Number(att.images) + ' 张')
        var fn = Array.isArray(att.files) ? att.files : []
        if (fn.length) bits.push('文件 ' + fn.length + ' 个（' + fn.join('、') + '）')
        if (!bits.length) return ''
        var chars = Number(att.fileChars || 0)
        return '📎 已收到：' + bits.join(' · ') + (chars ? '，读到 ' + chars + ' 字' : '')
      } catch (e) { return '' }
    }
    // 2026-10-21（m04728 用户）：「AI助手对话时有个极简的思考过程（可折叠）呈现，不然像是突然冒出来的
    //   回复一样，中间过程也不知道大模型是否接收到了指令。」
    //   做法：服务端回 trace（插件自己记的步骤：读实况/附件/查数据几跳/发给哪个模型/回多少字几秒），
    //   模型若自带思考流就再给 thinking。这里只负责**默认折叠的一行**，点开才看细节。
    function AiDockTrace(props) {
      // 调色板是 AiDock 内部局部的 `C`（var 作用域在那层），这里单独取一份，别跨组件借用
      var C = {
        bg: 'var(--row-bg, rgba(128,128,128,.06))', bd: 'var(--border-weak, rgba(128,128,128,.28))',
        t1: 'var(--text-1, #e6eaf0)', t2: 'var(--text-2, #8b95a3)', t3: 'var(--text-3, #6b7280)',
      }
      var open = React.useState(false)
      var isOpen = open[0]
      var setOpen = open[1]
      var steps = Array.isArray(props.trace) ? props.trace : []
      var thinking = String(props.thinking || '')
      if (!steps.length && !thinking) return null
      var head = '💭 思考过程 · ' + (steps.length + (thinking ? 1 : 0)) + ' 步' + (isOpen ? '' : '（点开看）')
      return React.createElement('div', { 'data-sales-act': 'ai-dock-trace', style: { maxWidth: '92%', marginBottom: 4 } },
        React.createElement('div', {
          onClick: function () { setOpen(!isOpen) },
          style: { cursor: 'pointer', fontSize: 10.5, color: C.t3, userSelect: 'none', padding: '1px 2px' },
        }, head),
        isOpen ? React.createElement('div', { style: { marginTop: 3, padding: '5px 8px', borderLeft: '2px solid ' + C.bd, background: C.bg, borderRadius: 4, fontSize: 11, color: C.t2, lineHeight: 1.7 } },
          steps.map(function (s, i) { return React.createElement('div', { key: 't' + i, style: { wordBreak: 'break-word' } }, '· ' + String(s)) }),
          thinking ? React.createElement('div', { style: { marginTop: 5 } },
            React.createElement('div', { style: { color: C.t3, fontSize: 10.5, marginBottom: 2 } }, '模型的思考（原文，已脱敏）：'),
            React.createElement('div', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: C.t2, maxHeight: 180, overflow: 'auto' } }, thinking)) : null) : null)
    }
    // 等待中的那几秒也别是空白：给一句「正在处理 · 已 Xs」，让人知道指令已经发出去了
    function AiDockWaiting(props) {
      var C = { t3: 'var(--text-3, #6b7280)' }
      var tick = React.useState(0)
      var setTick = tick[1]
      React.useEffect(function () {
        if (!props.busy) return undefined
        var id = setInterval(function () { setTick(function (n) { return n + 1 }) }, 1000)
        return function () { clearInterval(id) }
      }, [props.busy])
      if (!props.busy) return null
      var t0 = props.since || Date.now()
      var sec = Math.max(0, Math.round((Date.now() - t0) / 1000))
      // 2026-10-21 夜（m06146）：流式正文边收边显示 + 「停止」按钮（像 DSH 对话框那样能中途掐掉）
      return React.createElement('div', { 'data-sales-act': 'ai-dock-waiting', style: { fontSize: 11, color: C.t3, margin: '2px 0 6px' } },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          React.createElement('span', {}, '⏳ 正在处理… 已 ' + sec + 's' + (props.hint ? '（' + props.hint + '）' : '')),
          React.createElement('button', {
            'data-sales-act': 'ai-dock-stop',
            onClick: function () { if (props.onStop) props.onStop() },
            title: '停止这次回答（已生成的部分会保留）',
            style: { background: 'none', border: '1px solid rgba(201,42,42,.5)', borderRadius: 6, cursor: 'pointer', color: 'var(--danger-color,#c92a2a)', fontSize: 11, padding: '1px 7px' }
          }, '⏹ 停止')),
        props.live ? React.createElement('div', { style: { marginTop: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--text-1,#e6eaf0)', fontSize: 12.5, lineHeight: 1.65 } }, props.live) : null)
    }
    // 模型可选：目录来自 /sales/assistant {action:'models'}（零网络，读宿主本地目录）
    function AiDock(props) {
      var [open, setOpen] = useState(function () { try { return localStorage.getItem(AI_DOCK_KEY + '.open') !== '0' } catch (e) { return true } })
      var [msgs, setMsgsRaw] = useState(aiDockLoadMsgs)
      var [text, setText] = useState('')
      var [busy, setBusy] = useState(false)
      var [imgs, setImgs] = useState([])
      var [files, setFiles] = useState([])
      var [cat, setCat] = useState(null)
      var [pick, setPick] = useState(function () { try { return localStorage.getItem(AI_DOCK_KEY + '.model') || '' } catch (e) { return '' } })
      var [note, setNote] = useState('')
      var [card, setCard] = useState(null)
      // 2026-11-11（1.3.0）：确认卡改成**可编辑**——模型写错的日期/方式/阶段/内容，用户能直接在卡上改，
      //   不用「重新说一遍」。draft 只存这 9 个可改字段；手机号只读（换手机号＝换客户，得走客户表）。
      var [cardDraft, setCardDraft] = useState(null)
      var [ask, setAsk] = useState(null)          // 2026-10-21 夜（m06146）：模型反问 → 面板给选项
      var [live, setLive] = useState('')          // 流式已收到的正文（边生成边显示，像 DSH 对话框）
      var [hint, setHint] = useState('')
      // 2026-10-22（m01968）：点附件缩略图放大看的浮层内容（null = 没打开）
      var [viewer, setViewer] = useState(null)
      var imgRef = React.useRef(null)
      var fileRef = React.useRef(null)
      var listRef = React.useRef(null)
      // 2026-10-21 体检（m03962 P1）：防连点重复发送。busy 是 state，同一次事件循环里改两次都读到旧值
      //   → 连按两下 Enter 会并发两次请求（既重复花钱，回答还会乱序覆盖）。用 ref 做真闸门。
      var busyRef = React.useRef(false)
      // 2026-10-21 夜（m03706）：用户否决了「把面板的话投进 DSH 会话再搬回来」的桥接方案
      //   （「不要调用dsh的对话框做来回的桥接，我要sale插件自己具备这个能力」）→ 面板改回直连模型，
      //   由插件服务端（dock.js + index.js 的查数据回路）自己具备工具能力：能看今日实况、能要客户档案、
      //   能给确认卡写跟进。这里不再有轮询/会话事件，一次请求一个回答。
      // 所有写消息的地方都走这里：内存 + localStorage 一起写（退出插件、重启面板都不丢）
      function setMsgs(next) { setMsgsRaw(next); aiDockSaveMsgs(next) }

      // 2026-11-11（1.3.0）：新确认卡到了 → 把卡里的字段铺进可编辑 draft；卡没了 → draft 一起清掉。
      useEffect(function () {
        if (card && card.ok) setCardDraft(aiCardDraftOf(card))
        else setCardDraft(null)
      }, [card])
      function patchCardDraft(k, v) {
        setCardDraft(function (prev) { var n = Object.assign({}, prev || {}); n[k] = v; return n })
      }

      useEffect(function () { try { localStorage.setItem(AI_DOCK_KEY + '.open', open ? '1' : '0') } catch (e) {} }, [open])
      useEffect(function () {
        if (!open || cat) return
        var alive = true
        fetchData('assistant', { action: 'models' }).then(function (r) {
          if (!alive) return
          if (r && r.ok === true && r.data) setCat(r.data)
          else setCat({ providers: [], errors: [(r && r.error) || '模型目录读不出来'] })
        })
        return function () { alive = false }
      }, [open])
      useEffect(function () { if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight }, [msgs.length, busy])

      function pickValue(m) { return (m.provider ? m.provider + '|' : '|') + m.model }
      function onPick(e) {
        var v = String(e.target.value || '')
        setPick(v)
        try { localStorage.setItem(AI_DOCK_KEY + '.model', v) } catch (e2) {}
      }
      // quiet=true 时只返回提示文字、不写 setNote（粘附件时要合并图片/文件两边的提示，2026-10-22 m01846）
      function addImgs(list, quiet) {
        var arr = Array.prototype.slice.call(list || [])
        var acc = imgs.slice()
        var msgsOut = []
        // 2026-10-21 体检（m03962 P1）：服务端总量上限是 8MB，前端原来只查单张 4MB → 4 张 3.9MB 能选上，
        //   发出去服务端整批退回，爹只看到「读不了」还白等一次。这里在选的时候就按总量拦。
        var total = acc.reduce(function (s, x) { return s + (Number(x.size) || 0) }, 0)
        for (var i = 0; i < arr.length; i++) {
          var f = arr[i]
          if (!/^image\//.test(String(f.type || ''))) { msgsOut.push(f.name + '：不是图片'); continue }
          if (acc.length >= AI_DOCK_LIMIT.images) { msgsOut.push('图片最多 ' + AI_DOCK_LIMIT.images + ' 张'); break }
          if (f.size > AI_DOCK_LIMIT.imageBytes) { msgsOut.push(f.name + '：' + aiDockHuman(f.size) + ' 超过 4MB'); continue }
          if (total + f.size > AI_DOCK_LIMIT.imageTotalBytes) { msgsOut.push('图片合计超过 8MB（' + f.name + ' 加不进来）'); continue }
          acc.push({ name: f.name, mediaType: f.type || 'image/png', size: f.size, file: f })
          total += Number(f.size) || 0
        }
        setImgs(acc); if (!quiet) setNote(msgsOut.join('；'))
        if (imgRef.current) imgRef.current.value = ''
        return msgsOut.join('；')
      }
      function addFiles(list, quiet) {
        var arr = Array.prototype.slice.call(list || [])
        var acc = files.slice()
        var out = []
        for (var i = 0; i < arr.length; i++) {
          var f = arr[i]
          if (acc.length >= AI_DOCK_LIMIT.files) { out.push('文件最多 ' + AI_DOCK_LIMIT.files + ' 个'); break }
          if (f.size > AI_DOCK_LIMIT.fileBytes) { out.push(f.name + '：' + aiDockHuman(f.size) + ' 超过 8MB'); continue }
          acc.push({ name: f.name, mediaType: f.type || '', size: f.size, file: f })
        }
        setFiles(acc); if (!quiet) setNote(out.join('；'))
        if (fileRef.current) fileRef.current.value = ''
        return out.join('；')
      }
      // 2026-10-22（用户 m01846「要支持文件和图片能CTRL+V一键复制进去」）：
      //   截图/复制图片/在资源管理器里复制文件 → 在输入框里直接 Ctrl+V 就挂成附件，不用再点「📎 图片/文件」。
      //   两条边界：① 纯文字粘贴照旧走浏览器默认（不 preventDefault）；② 剪贴板里只有「文件路径文本」时
      //   浏览器读不到本机文件（安全限制），这时不拦、也不假报成功，只用原来的按钮选。
      function pasteStamp() {
        var d = new Date()
        var p = function (n) { return (n < 10 ? '0' : '') + n }
        return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
      }
      // 截图从剪贴板出来时没有文件名（Chromium 给 "image.png"），补一个能认出来的名字，气泡与 chip 上才看得懂
      function pastedName(f, idx, stamp) {
        var nm = String((f && f.name) || '')
        if (nm && nm !== 'image.png' && nm !== 'blob') return nm
        var ext = 'png'
        var t = String((f && f.type) || '')
        if (/jpeg/.test(t)) ext = 'jpg'; else if (/webp/.test(t)) ext = 'webp'; else if (/gif/.test(t)) ext = 'gif'
        return '粘贴图片-' + stamp + (idx ? '-' + idx : '') + '.' + ext
      }
      function renameFile(f, nm) {
        try { return new File([f], nm, { type: f.type || 'image/png', lastModified: Number(f.lastModified) || Date.now() }) } catch (e) { return f }
      }
      // 从网页/Word/邮件里复制图片时，剪贴板里常常没有 File，只有 text/html 里的 <img src="data:image/…">。
      //   这种也当粘贴图片接住（否则爹会以为「粘了没反应」）。
      function dataUrlToFile(url, sub, idx, stamp) {
        try {
          var bin = atob(String(url).split(',')[1] || '')
          var u8 = new Uint8Array(bin.length)
          for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
          var ext = /jpe?g/.test(sub) ? 'jpg' : String(sub || 'png')
          return new File([u8], '粘贴图片-' + stamp + (idx ? '-' + idx : '') + '.' + ext, { type: 'image/' + (sub || 'png') })
        } catch (e) { return null }
      }
      // 从粘贴事件里挑附件；有附件就返回 true（调用方负责 preventDefault）
      function takePaste(dt) {
        if (!dt) return false
        var got = []
        try {
          var items = dt.items || []
          for (var i = 0; i < items.length; i++) {
            var it = items[i]
            if (!it || it.kind !== 'file') continue
            var f = it.getAsFile ? it.getAsFile() : null
            if (f) got.push(f)
          }
        } catch (e) {}
        if (!got.length && dt.files && dt.files.length) got = Array.prototype.slice.call(dt.files)
        var stamp = pasteStamp()
        if (!got.length) {
          var html = ''
          try { html = String(dt.getData ? dt.getData('text/html') : '') || '' } catch (e3) {}
          if (html) {
            var re = /<img[^>]+src=["'](data:image\/([a-z0-9.+-]+);base64,[A-Za-z0-9+/=\s]+)["']/gi
            var m3
            while ((m3 = re.exec(html))) {
              var f3 = dataUrlToFile(m3[1], m3[2], got.length + 1, stamp)
              if (f3) got.push(f3)
              if (got.length >= AI_DOCK_LIMIT.images) break
            }
          }
        }
        if (!got.length) return false
        var imgsIn = [], filesIn = []
        for (var j = 0; j < got.length; j++) {
          var fj = got[j]
          if (/^image\//.test(String(fj.type || ''))) imgsIn.push(renameFile(fj, pastedName(fj, j + 1, stamp)))
          else filesIn.push(fj)
        }
        var notes = []
        if (imgsIn.length) { var n1 = addImgs(imgsIn, true); if (n1) notes.push(n1) }
        if (filesIn.length) { var n2 = addFiles(filesIn, true); if (n2) notes.push(n2) }
        if (notes.length) setNote(notes.join('；'))
        else {
          var bits = []
          if (imgsIn.length) bits.push('图片 ' + imgsIn.length + ' 张')
          if (filesIn.length) bits.push('文件 ' + filesIn.length + ' 个')
          setNote(''); setHint('已粘贴：' + bits.join('、') + '（直接发送即可）')
        }
        return true
      }
      function onPasteFiles(e) {
        var dt = e && (e.clipboardData || e.originalEvent && e.originalEvent.clipboardData)
        if (!dt) return
        if (takePaste(dt)) { e.preventDefault() }
      }
      // 直连模型（2026-10-21 夜 m06146 起走 SSE 流式）：边生成边显示；模型要数据时服务端在本地查完接着生成，
      //   面板只看到「🔎 查数据 · sales_view」这样的进度行。停止 = abort，已生成的部分保留并标「已停止」。
      async function sendChat(t, nextMsgs, keepImgs, keepFiles) {
        // 2026-10-21（m05130）：历史窗口 11→21 条（服务端再按 20 截）。单条不再 4000 字截断（落盘上限已 12000），
        //   附件正文由服务端按 panelId 缓存跨轮复用——上一轮上传的表，下一轮不用重传也能接着用。
        var history = nextMsgs.slice(-21, -1).filter(function (m) { return !m.receipt }).map(function (m) { return { role: m.role === 'user' ? 'user' : 'assistant', text: m.text } })
        var body = { action: 'stream', text: t, messages: history, panelId: aiDockPanelId(), id: (props && props.curId) || '', screen: String((props && props.screen) || '') }
        if (pick) { var pp2 = pick.split('|'); body.provider = pp2[0] || ''; body.model = pp2[1] || '' }
        try {
          if (keepImgs.length) {
            body.images = []
            for (var i2 = 0; i2 < keepImgs.length; i2++) body.images.push({ name: keepImgs[i2].name, mediaType: keepImgs[i2].mediaType, b64: await aiDockReadB64(keepImgs[i2].file) })
          }
          if (keepFiles.length) {
            body.files = []
            for (var j2 = 0; j2 < keepFiles.length; j2++) body.files.push({ name: keepFiles[j2].name, mediaType: keepFiles[j2].mediaType, b64: await aiDockReadB64(keepFiles[j2].file) })
          }
        } catch (e) { busyRef.current = false; setBusy(false); setNote('读附件失败：' + String((e && e.message) || e)); return }
        setLive('')
        var acc = ''
        var r
        try {
          r = await aiDockStream(body, {
            onDelta: function (x) { acc += x; setLive(acc) },
            onTool: function (x) { setHint('🔎 正在查：' + String((x && x.tool) || '') + ((x && x.ok === false) ? '（没查到）' : '')) },
            onReset: function () { acc = ''; setLive(''); setHint('') },
          })
        } finally { busyRef.current = false; setBusy(false); setLive(''); AI_DOCK_BUSY_SINCE = 0 }
        if (!r || r.ok !== true) {
          var why = (r && r.error) || '请求失败'
          // 停止：不算错，把已经生成的部分留在对话里（DSH 对话框也是这样）
          if (r && r.aborted) {
            // 停止是用户自己的动作，不是故障：不清空已生成的部分，也不当错误报（m06887）。
            //   连「重试」都给他——停完想接着问，点一下就重发，不用重新打字/重传附件。
            setMsgs(nextMsgs.concat([{ role: 'assistant', text: (acc ? acc + '\n\n' : '') + '⏹ 已停止（这次没答完）' + (acc ? '' : '：模型那边刚接到指令就断了，什么都没生成'), stopped: true, trace: [], retry: { t: t, keepImgs: keepImgs, keepFiles: keepFiles } }]))
            return
          }
          var att = (r && r.attachments) || null
          var extra = (att && att.errors && att.errors.length) ? '\n' + att.errors.join('\n') : ''
          setMsgs(nextMsgs.concat([{ role: 'assistant', text: '⚠️ ' + why + extra, err: true, trace: (r && r.trace) || [], retry: { t: t, keepImgs: keepImgs, keepFiles: keepFiles } }]))
          setImgs(keepImgs); setFiles(keepFiles)   // 失败就把附件退回去，别让爹重挑
          return
        }
        var d = r.data || r
        var pend = (d.attachments && d.attachments.errors && d.attachments.errors.length) ? '\n（附件提示：' + d.attachments.errors.join('；') + '）' : ''
        var cards = Array.isArray(d.writeCards) ? d.writeCards : (d.action_card ? [d.action_card] : [])
        setMsgs(nextMsgs.concat([{ role: 'assistant', text: String(d.text || '') + pend + (d.stopped ? '\n\n⏹（中途停止）' : ''), model: (d.provider ? d.provider + '/' : '') + (d.model || ''), trace: d.trace || [], thinking: d.thinking || '', rx: aiDockRxOf(d.attachments) }]))
        setCard(cards[0] || null)
        setAsk(d.ask || null)
      }
      // 重试（失败气泡上那颗按钮）：把上一轮的原话和附件重新发一次
      async function retry(m) {
        if (busyRef.current || !m || !m.retry) return
        var rb = m.retry
        busyRef.current = true; AI_DOCK_BUSY_SINCE = Date.now(); setBusy(true); setNote('')
        var nm = msgs.concat([{ role: 'user', text: '(重试) ' + String(rb.t || '') }])
        setMsgs(nm)
        await sendChat(rb.t, nm, rb.keepImgs || [], rb.keepFiles || [])
      }
      async function send() {
        if (busy || busyRef.current) return
        var t = String(text || '').trim()
        if (!t && !imgs.length && !files.length) { setNote('说一句话，或者传图片/文件'); return }
        // 图片闸门（2026-10-21）：选的模型不吃图就先拦住——发过去会被适配器投影成占位文字，等于白问。
        if (imgs.length && pickedModel && !(pickedModel.supportsImage || (Array.isArray(pickedModel.input) && pickedModel.input.indexOf('image') !== -1))) {
          setNote('这个模型不看图（只吃文字）' + (pickedModel.noVisionNote ? '——' + pickedModel.noVisionNote : '') + '。请在上面模型下拉里换一个带「🖼 看图」的' + (imageModels.length ? '（例如 ' + imageModels.slice(0, 3).join('、') + '）' : '') + '；不带图的话现在就能发。')
          return
        }
        busyRef.current = true
        AI_DOCK_BUSY_SINCE = Date.now()
        setBusy(true); setNote('')
        var shown = t || ('（上传了 ' + (imgs.length + files.length) + ' 个附件）')
        // 附件摘要钉在消息上（m04970）：气泡里看得见、退出插件再进来也还在
        var atts = await aiDockAttsOf(imgs, files)
        var nextMsgs = msgs.concat([{ role: 'user', text: shown, atts: atts }])
        var keepImgs = imgs, keepFiles = files
        setMsgs(nextMsgs); setText(''); setCard(null); setAsk(null); setHint(''); setImgs([]); setFiles([])
        await sendChat(t, nextMsgs, keepImgs, keepFiles)
      }
      // 2026-10-22（用户 m01060「重新打开插件后，落库记录也没了」）：
      //   写库回执原来只走 setHint（瞬时提示，不进消息、不落 localStorage）→ 退出/重开插件就消失，
      //   爹以为没落库。现在把回执当成一条助手消息写进对话并落盘；receipt:true 的消息**不进**发给模型的历史
      //   （它不是模型说的话，别污染上下文），渲染上也单独上色，一眼看出这是「系统回执」不是 AI 在说话。
      function appendReceipt(txt, isErr) {
        var rec = { role: 'assistant', text: String(txt || ''), receipt: true }
        if (isErr) rec.err = true
        setMsgs(msgs.concat([rec]))
      }
      // 确认卡：用户点了「确认写入」才走到这里，插件本进程直接调 cmdLog 落库（数据层写入口）。
      //   2026-10-21 夜（m03706）：不再往 DSH 对话输入框里塞 sales_log 指令 —— 用户要求插件自己具备。
      async function confirmCard() {
        if (!card || !card.ok) return
        if (busyRef.current) return
        // 2026-11-11（1.3.0）：提交**卡面上编辑后**的字段（cardDraft 覆盖模型原值），
        //   模型给的其它键（status/level 等）照旧带上，不丢。
        var submitArgs = Object.assign({}, (card && card.args) || {}, cardDraft || {})
        if (typeof window !== 'undefined' && window.confirm && !window.confirm('确认把这条跟进写进客户表（主表+流水表）？\n客户 ' + aiDockCustLabel(card) + '\n内容：' + String((submitArgs.what) || ''))) return
        busyRef.current = true
        AI_DOCK_BUSY_SINCE = Date.now()
        setHint('正在写入…')
        var r
        try { r = await fetchData('assistant', { action: 'log', confirm: true, args: submitArgs }) } finally { busyRef.current = false }
        if (r && r.ok === true && !(r.data && r.data.write && r.data.write.ok === false)) {
          // 2026-10-21 体检（m03962 P1）：写库回执字段是 cmdLog 的（stage/stageFrom/autoAdvanced/levelSynced/message），
          //   原来读的是不存在的 write.nextStage/write.levelNote → 永远只显示「已写入流水表」，
          //   阶段到底推没推、等级有没有归一，爹都看不到。改成照实回显 + 服务端 message 一并带上。
          var w = (r.data && r.data.write) || {}
          var argsW = submitArgs
          var bits = []
          if (w.stage) bits.push('阶段：' + String(w.stageFrom || '?') + ' → ' + String(w.stage) + (w.stageNote ? '（' + String(w.stageNote) + '）' : ''))
          if (w.autoAdvanced && w.nextStage) bits.push('可推进到：' + String(w.nextStage))
          if (w.levelSynced) bits.push('等级已归一：' + String(w.levelSynced))
          // 2026-10-28（用户 m03015）：回执只说「阶段」不够——他真正要核的是**下次跟进**有没有落上，
          //   不写清楚就得自己去面板找（然后发现面板还是旧值，越发觉得助手蠢）。
          if (argsW.nextDate || argsW.nextMethod) bits.push('下次跟进：' + String(argsW.nextDate || '未定') + (argsW.nextMethod ? '（' + String(argsW.nextMethod) + '）' : ''))
          if (argsW.status) bits.push('状态：' + String(argsW.status))
          if (argsW.level) bits.push('等级：' + String(argsW.level))
          if (w.duplicated) bits.push('这条跟进已存在，本次只补主表回写')
          var receipt = '✅ 已写进客户表（主表+流水表）· 手机 ' + aiDockPhoneMask(argsW.phone || (card.customer && card.customer.phone)) + (bits.length ? '\n' + bits.join('\n') : '') + (w.message ? '\n' + String(w.message) : '')
          // 2026-10-28（用户 m03015）：写完立刻把看板 / SOP 详情重拉一遍，并在回执里说一声，
          //   不用用户再教一句「要同步更新到面板显示上」。
          var refreshed = false
          if (props && typeof props.onWritten === 'function') {
            try { props.onWritten(w, argsW); refreshed = true } catch (e) {
              try { console.error('[sales-board onWritten] ' + ((e && e.message) || e), e) } catch (_) {}
            }
          }
          receipt += refreshed ? '\n🔄 看板已同步刷新（排期/阶段/静默天数就是新值）' : '\n（看板没自动刷新：点右上角 🔄 刷新一下）'
          setHint(receipt)
          appendReceipt(receipt)          // m01060：回执进对话并落盘，重开插件还在
          setCard(null)
          return
        }
        // 2026-10-21 夜（m05977）：写库没成的时候必须说清「一张表都没动」——
        //   上一版把里层失败当成成功显示 ✅，用户以为落了库，还得自己回来问「主表没落吗」。
        var msg = String((r && r.error) || ((r && r.data && r.data.write && (r.data.write.message || r.data.write.error)) || '未知原因'))
        var failTxt = '❌ 这次客户表没写进去：' + msg + '\n（客户表＝主表+流水表，两处都没动；改好内容再发一次就行）'
        setHint('')
        setNote(failTxt)
        appendReceipt(failTxt, true)       // m01060：失败回执同样留痕，别让爹事后查不到
      }
      var C = {
        bg: 'var(--row-bg, rgba(128,128,128,.06))', bd: 'var(--border-weak, rgba(128,128,128,.28))',
        t1: 'var(--text-1, #e6eaf0)', t2: 'var(--text-2, #8b95a3)', t3: 'var(--text-3, #6b7280)',
        acc: 'var(--blue-color, #1c7ed6)', danger: 'var(--danger-color, #c92a2a)', ok: 'var(--ok-color, #2f9e44)',
      }
      if (!open) {
        return React.createElement('div', { 'data-sales-act': 'ai-dock', style: { flex: '0 0 34px', borderRight: '1px solid ' + C.bd, display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 10, gap: 8, background: C.bg } },
          React.createElement('button', { onClick: function () { setOpen(true) }, title: '打开 AI 助手（模型可选 / 可传图片和文件）', style: { background: 'none', border: '1px solid ' + C.bd, borderRadius: 6, cursor: 'pointer', color: C.t1, fontSize: 15, padding: '3px 6px' } }, '🤖'),
          React.createElement('div', { style: { writingMode: 'vertical-rl', fontSize: 11, color: C.t2, letterSpacing: 1 } }, 'AI 助手'))
      }
      var providers = (cat && cat.providers) || []
      var modelOptions = []
      modelOptions.push(React.createElement('option', { key: '__cur', value: '' }, '跟随当前会话' + (cat && cat.current && cat.current.text ? '（' + cat.current.text + '）' : '')))
      var imageModels = []
      for (var pi = 0; pi < providers.length; pi++) {
        var p = providers[pi]
        // 2026-10-21 体检（m03962 P2）：provider 的 models 可能缺（宿主某个 provider 没回目录），
        //   原来直接 p.models.map 会在渲染时整块崩（白屏只剩错误边界）。缺就当空数组。
        var mlist = (p && Array.isArray(p.models)) ? p.models : []
        var opts = mlist.map(function (m) {
          // 2026-10-21 修：宿主的模态字段是 inputModalities（dock.js 已映射成 supportsImage）——
          //   这行以前永远不打标，爹就分不清哪个模型能看图。
          if (m.supportsImage || (Array.isArray(m.input) && m.input.indexOf('image') !== -1)) imageModels.push((p.id || '') + '/' + m.id)
          // 2026-10-21 夜（m06887 实测）：有的模型 profile 里写着 image，实际看不见图（见 dock.js 的 KNOWN_NO_VISION）
          //   → 目录这边会带 noVisionNote，下拉里标「不看图·实测」，别让爹选了它还以为图能看。
          var canSee = m.supportsImage || (Array.isArray(m.input) && m.input.indexOf('image') !== -1)
          var tag = m.noVisionNote ? ' （不看图·实测）' : (canSee ? ' 🖼 看图' : ' （不看图）')
          return React.createElement('option', { key: p.id + '/' + m.id, value: (p.id || '') + '|' + m.id, title: m.noVisionNote || '' }, (m.name || m.id) + tag)
        })
        modelOptions.push(React.createElement('optgroup', { key: 'g' + p.id, label: p.name || p.id }, opts))
      }
      var pickedModel = null
      if (pick) {
        var pk = pick.split('|')
        for (var qi = 0; qi < providers.length; qi++) {
          var qm = (providers[qi] && Array.isArray(providers[qi].models)) ? providers[qi].models : []
          for (var qj = 0; qj < qm.length; qj++) {
            if (providers[qi].id === pk[0] && qm[qj].id === pk[1]) pickedModel = qm[qj]
          }
        }
      }
      // 2026-10-21（m05793）：模型回的是 Markdown（**加粗**、`代码`、- 列表、1. 编号、# 标题），
      //   以前把星号原样吐出来（用户截图里满屏 **会同步，而且一定两边一起写。**），看着像 bug。
      //   这里只认四种最轻的语法，不引第三方库、不解析 HTML（防注入）：行内只做 **粗体** 与 `代码`。
      function aiDockInline(s, k) {
        var out = [], re = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g, last = 0, mt, n = 0
        while ((mt = re.exec(s)) !== null) {
          if (mt.index > last) out.push(s.slice(last, mt.index))
          var tok = mt[0]
          if (tok.slice(0, 2) === '**') out.push(React.createElement('strong', { key: (k || '') + 'b' + (n++), style: { fontWeight: 700, color: C.t1 } }, tok.slice(2, -2)))
          else out.push(React.createElement('code', { key: (k || '') + 'c' + (n++), style: { fontFamily: 'ui-monospace,Consolas,monospace', fontSize: 11.5, padding: '0 3px', borderRadius: 3, background: 'rgba(128,128,128,.18)' } }, tok.slice(1, -1)))
          last = mt.index + tok.length
        }
        if (last < s.length) out.push(s.slice(last))
        return out
      }
      function aiDockRich(text, k) {
        return String(text == null ? '' : text).split('\n').map(function (ln, ix) {
          var key = (k || '') + 'n' + ix
          var head = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(ln)
          if (head) return React.createElement('div', { key: key, style: { fontWeight: 700, fontSize: 13, margin: '5px 0 2px', color: C.t1 } }, aiDockInline(head[2], key + '_'))
          var li = /^(\s*)[-*]\s+(.*)$/.exec(ln)
          if (li) return React.createElement('div', { key: key, style: { display: 'flex', gap: 4, paddingLeft: 4 + Math.min(li[1].length, 8) * 3 } },
            React.createElement('span', { style: { color: C.t3 } }, '•'),
            React.createElement('span', { style: { flex: 1 } }, aiDockInline(li[2], key + '_')))
          var ol = /^(\s*)(\d+)[.、)]\s+(.*)$/.exec(ln)
          if (ol) return React.createElement('div', { key: key, style: { display: 'flex', gap: 4, paddingLeft: 4 } },
            React.createElement('span', { style: { color: C.t3, minWidth: 14 } }, ol[2] + '.'),
            React.createElement('span', { style: { flex: 1 } }, aiDockInline(ol[3], key + '_')))
          return React.createElement('div', { key: key, style: ln ? null : { height: 6 } }, aiDockInline(ln, key + '_'))
        })
      }
      var msgNodes = msgs.length === 0
        ? React.createElement('div', { style: { fontSize: 12.5, color: C.t2, lineHeight: 1.8 } },
          React.createElement('div', { style: { fontWeight: 700, color: C.t1, marginBottom: 6 } }, '🤖 我可以帮你：'),
          React.createElement('div', {}, '· 今天该打谁、怎么开口（我看得到看板里的客户档案）'),
          React.createElement('div', {}, '· 聊完把跟进录进去 —— 我出确认卡，你点一下才写库'),
          React.createElement('div', {}, '· 传微信截图/名片/合同照片，我照着念；传 docx/xlsx/pdf/csv/txt，我读正文'),
          React.createElement('div', { style: { marginTop: 6, color: C.t3, fontSize: 11.5 } }, '对话会自动留着（退出插件不丢）；清空和「新开」都只由你点。图片/文件都能直接 Ctrl+V 粘贴；图片 ≤4 张（每张 ≤4MB），文件 ≤4 个（每个 ≤8MB）'))
        : msgs.map(function (m, i) {
          if (m.role === 'tool') {
            return React.createElement('div', { key: 'm' + i, style: { fontSize: 10.5, color: C.t3, fontFamily: 'ui-monospace,Consolas,monospace', margin: '0 0 6px 2px', wordBreak: 'break-all', whiteSpace: 'pre-wrap' } }, m.text)
          }
          var me = m.role === 'user'
          return React.createElement('div', { key: 'm' + i, style: { marginBottom: 8, display: 'flex', flexDirection: 'column', alignItems: me ? 'flex-end' : 'flex-start' } },
            // 2026-10-21（m04728）：助手消息上面挂一行可折叠的「思考过程」（默认收起）
            (!me && (m.trace || m.thinking)) ? React.createElement(AiDockTrace, { trace: m.trace, thinking: m.thinking }) : null,
            React.createElement('div', { style: { maxWidth: '92%', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12.5, lineHeight: 1.65, padding: '6px 9px', borderRadius: 8, border: '1px solid ' + (m.err ? 'rgba(201,42,42,.45)' : (m.receipt ? 'rgba(47,158,68,.45)' : C.bd)), background: me ? 'var(--accent-tint, rgba(37,99,235,.15))' : (m.err ? 'rgba(201,42,42,.08)' : (m.receipt ? 'rgba(47,158,68,.08)' : C.bg)), color: m.err ? C.danger : C.t1 } },
              // m01060：系统回执（写库成功/失败）按纯文本画，别让 markdown 渲染把「流水 L1113」这类东西弄花
              (me || m.err || m.pending || m.receipt) ? m.text : aiDockRich(m.text, 'm' + i)),
            // m04970：用户消息下面把附件画出来（图片缩略图 / 文件名字+大小）
            me ? React.createElement(AiDockAtts, { atts: m.atts, onView: function (v) { setViewer(v) } }) : null,
            // m04970：助手这条回「收到几个附件、读到多少字」，传丢没传丢一眼看出来
            (!me && m.rx) ? React.createElement('div', { style: { fontSize: 10.5, color: C.t3, marginTop: 2 } }, m.rx) : null,
            (!me && m.model) ? React.createElement('div', { style: { fontSize: 10.5, color: C.t3, marginTop: 2 } }, m.model) : null,
            // 2026-10-21 夜（m06887）：停止后的气泡也要有「重试」——停完想接着问，点一下重发，不用重打字/重选附件。
            //   停止不是错误（m.err 为假），所以不能跟失败气泡共用那个判断：单独认 m.stopped。
            (!me && (m.err || m.stopped) && m.retry) ? React.createElement('button', { 'data-sales-act': 'ai-dock-retry', onClick: function () { retry(m) }, title: '把上一次的话和附件重新发一遍', style: { background: 'none', border: '1px solid ' + C.bd, borderRadius: 6, cursor: 'pointer', color: C.t2, fontSize: 11, padding: '1px 7px', marginTop: 3 } }, '↻ 重试') : null)
        })
      var chips = []
      for (var ii = 0; ii < imgs.length; ii++) {
        (function (ix) {
          chips.push(React.createElement('span', { key: 'i' + ix, style: { fontSize: 11, padding: '2px 6px', borderRadius: 10, border: '1px solid ' + C.bd, color: C.t2 } },
            '🖼 ' + imgs[ix].name + ' ' + aiDockHuman(imgs[ix].size),
            React.createElement('button', { onClick: function () { setImgs(imgs.filter(function (_, k) { return k !== ix })) }, style: { background: 'none', border: 'none', cursor: 'pointer', color: C.t2, marginLeft: 4 } }, '✕')))
        })(ii)
      }
      for (var fi = 0; fi < files.length; fi++) {
        (function (ix) {
          chips.push(React.createElement('span', { key: 'f' + ix, style: { fontSize: 11, padding: '2px 6px', borderRadius: 10, border: '1px solid ' + C.bd, color: C.t2 } },
            '📄 ' + files[ix].name + ' ' + aiDockHuman(files[ix].size),
            React.createElement('button', { onClick: function () { setFiles(files.filter(function (_, k) { return k !== ix })) }, style: { background: 'none', border: 'none', cursor: 'pointer', color: C.t2, marginLeft: 4 } }, '✕')))
        })(fi)
      }
      // 2026-10-21 夜（m06146）：模型反问卡 —— 只在「真有歧义 / 需要用户拍板」时出现，2~4 个可点选项，
      //   点一下就把选项文案填进输入框（不直接发，爹还能改），避免模型自说自话替爹决定。
      var askNode = (ask && Array.isArray(ask.options) && ask.options.length)
        ? React.createElement('div', { 'data-sales-act': 'ai-dock-ask', style: { margin: '0 0 8px', padding: '8px 10px', border: '1px solid ' + C.acc, borderRadius: 8, background: 'rgba(37,99,235,.08)' } },
          React.createElement('div', { style: { fontSize: 12, color: C.t1, fontWeight: 700, marginBottom: 3 } }, '❓ ' + String(ask.q || '需要你确认一下')),
          ask.why ? React.createElement('div', { style: { fontSize: 11, color: C.t2, marginBottom: 5 } }, String(ask.why)) : null,
          React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4 } },
            ask.options.map(function (o, k) {
              var label = String(typeof o === 'string' ? o : ((o && o.label) || ''))
              return React.createElement('button', {
                key: 'ask' + k,
                'data-sales-act': 'ai-dock-ask-opt',
                onClick: function () { setAsk(null); setText(label) },
                title: '点一下填进输入框（不直接发，你可以再改）',
                style: { background: 'rgba(37,99,235,.16)', border: '1px solid ' + C.acc, borderRadius: 12, cursor: 'pointer', color: C.t1, fontSize: 11.5, padding: '3px 9px' }
              }, label)
            }),
            React.createElement('button', { onClick: function () { setAsk(null) }, style: { background: 'none', border: '1px solid ' + C.bd, borderRadius: 12, cursor: 'pointer', color: C.t2, fontSize: 11.5, padding: '3px 9px' } }, '不用了')),
          ) : null
      // 2026-11-11（1.3.0）：卡面上的字段全部可改（手机号只读），改完点「确认写入」才落库。
      var cd = cardDraft || ((card && card.ok) ? aiCardDraftOf(card) : {})
      var cardCtlStyle = { background: C.bg, color: C.t1, border: '1px solid ' + C.bd, borderRadius: 6, padding: '2px 5px', fontSize: 11.5, fontFamily: 'inherit', width: '100%', boxSizing: 'border-box' }
      function aiCardInput(f) {
        var key = f[0], label = f[1], kind = f[2]
        var val = String(cd[key] || '')
        var onCh = function (e) { patchCardDraft(key, e.target.value) }
        var ctl
        if (kind === 'textarea') {
          ctl = React.createElement('textarea', { value: val, rows: 3, onChange: onCh, style: Object.assign({}, cardCtlStyle, { resize: 'vertical', lineHeight: 1.5 }) })
        } else if (kind === 'date') {
          ctl = React.createElement('input', { type: 'date', value: val, onChange: onCh, style: cardCtlStyle })
        } else if (kind === 'method' || kind === 'type' || kind === 'stage') {
          var opts = kind === 'method' ? AI_CARD_METHODS : (kind === 'type' ? AI_CARD_TYPES : AI_CARD_STAGES)
          var extra = (val && opts.indexOf(val) === -1) ? React.createElement('option', { value: val }, val + '（模型原值）') : null
          ctl = React.createElement('select', { value: val, onChange: onCh, style: cardCtlStyle },
            React.createElement('option', { value: '' }, '（不指定）'),
            extra,
            opts.map(function (o) { return React.createElement('option', { key: o, value: o }, o) }))
        } else {
          ctl = React.createElement('input', { type: 'text', value: val, onChange: onCh, style: cardCtlStyle })
        }
        return React.createElement('label', { key: key, style: { display: 'flex', flexDirection: 'column', gap: 2 } },
          React.createElement('span', { style: { fontSize: 10.5, color: C.t3 } }, label), ctl)
      }
      var cardNode = (card && card.ok)
        ? React.createElement('div', { style: { margin: '0 0 8px', padding: '8px 10px', border: '1px solid ' + C.acc, borderRadius: 8, background: 'var(--accent-bg, rgba(37,99,235,.08))' } },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 } },
            React.createElement('span', { style: { fontSize: 12, fontWeight: 700, color: C.t1, flexShrink: 0 } }, '📝 要写一条跟进（点确认才落库）'),
            React.createElement('span', { title: '就这 9 项可改；没填的可以留空', style: { fontSize: 10.5, color: aiCardFilled(cd) >= AI_CARD_FIELDS.length ? C.ok : C.t3, border: '1px solid ' + C.bd, borderRadius: 10, padding: '0 6px', flexShrink: 0 } }, '已填 ' + aiCardFilled(cd) + '/' + AI_CARD_FIELDS.length + '（未填可留空）')),
          React.createElement('div', { style: { fontSize: 11.5, color: C.t2, lineHeight: 1.6, wordBreak: 'break-all', marginBottom: 5 } }, '客户 ' + aiDockCustLabel(card)),
          React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 6 } },
            React.createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
              React.createElement('span', { style: { fontSize: 10.5, color: C.t3 } }, '客户手机号（只读：换手机号＝换客户，请在客户表里改）'),
              React.createElement('input', { type: 'text', value: String(cd.phone || (card.args && card.args.phone) || (card.customer && card.customer.phone) || ''), readOnly: true, style: Object.assign({}, cardCtlStyle, { opacity: .75, cursor: 'not-allowed' }) })),
            AI_CARD_FIELDS.map(aiCardInput)),
          (card.fixed && card.fixed.length)
            ? React.createElement('div', { style: { fontSize: 11, color: C.t3, lineHeight: 1.55, marginBottom: 6, whiteSpace: 'pre-wrap' } },
              '✎ 插件替你改了 ' + card.fixed.length + ' 处：\n' + card.fixed.join('\n'))
            : null,
          React.createElement('div', { style: { display: 'flex', gap: 8 } },
            React.createElement('button', { onClick: confirmCard, style: { background: 'var(--accent-tint, rgba(37,99,235,.16))', border: '1px solid ' + C.acc, borderRadius: 6, padding: '4px 10px', cursor: 'pointer', color: C.t1, fontSize: 12 } }, '✅ 确认写入'),
            React.createElement('button', { onClick: function () { setCard(null) }, style: { background: 'none', border: '1px solid ' + C.bd, borderRadius: 6, padding: '4px 10px', cursor: 'pointer', color: C.t2, fontSize: 12 } }, '先不写')))
        : (card && !card.ok)
          // 2026-10-29（用户 m03421）：写卡在生成时已经跑过一遍写库预演 —— 过不了的卡不再给「确认写入」按钮，
          //   免得用户点了才吃「方式不合法」这种错。
          ? React.createElement('div', { style: { margin: '0 0 8px', padding: '6px 9px', border: '1px solid rgba(201,42,42,.45)', borderRadius: 8, background: 'rgba(201,42,42,.08)', color: C.danger, fontSize: 11.5, whiteSpace: 'pre-wrap' } },
            (card.blocked ? '⚠️ 这条暂时写不进去：' : '⚠️ 模型给的写入卡不能用：') + String(card.error || '格式不对'))
          : null
      // 2026-10-22（用户 m00521）：对话框在面板**左侧**了 → 分隔线改画右边（borderRight），原来在右侧时画的是 borderLeft。
      return React.createElement('div', { 'data-sales-act': 'ai-dock', style: { flex: '0 0 380px', width: 380, minWidth: 300, borderRight: '1px solid ' + C.bd, display: 'flex', flexDirection: 'column', minHeight: 0, background: C.bg } },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', borderBottom: '1px solid ' + C.bd } },
          React.createElement('span', { style: { fontSize: 13, fontWeight: 700, color: C.t1, flexShrink: 0 } }, '🤖 AI 助手'),
          React.createElement('span', { title: 'sale 插件自己实现：能看今日实况、能查客户档案、能出确认卡写跟进（不经 DSH 对话框）', style: { fontSize: 10, color: C.ok, border: '1px solid rgba(47,158,68,.5)', borderRadius: 10, padding: '1px 6px', flexShrink: 0 } }, '插件自带'),
          React.createElement('select', { value: pick, onChange: onPick, title: '选模型（只影响侧栏这一次对话，不改全局默认）', style: { flex: 1, minWidth: 0, fontSize: 11.5, background: 'transparent', color: C.t1, border: '1px solid ' + C.bd, borderRadius: 6, padding: '2px 4px' } }, modelOptions),
          React.createElement('button', {
            'data-sales-act': 'ai-dock-new',
            onClick: function () {
              if (!msgs.length) { setCard(null); setHint(''); setNote(''); return }
              if (typeof window !== 'undefined' && window.confirm && !window.confirm('新开一条对话？现在这条会收进存档（不删），随时能找回旧内容。')) return
              aiDockArchive(); setMsgs([]); setCard(null); setHint(''); setNote(''); setBusy(false)
              setHint('已新开一条（上一条收进存档，不删；随时能找回旧内容）')
            },
            title: '新开一条对话（当前这条收进存档，不删）',
            style: { background: 'none', border: '1px solid ' + C.bd, borderRadius: 6, cursor: 'pointer', color: C.t2, fontSize: 11, padding: '2px 6px' }
          }, '＋ 新开'),
          React.createElement('button', {
            'data-sales-act': 'ai-dock-clear',
            onClick: function () {
              if (typeof window !== 'undefined' && window.confirm && !window.confirm('清空当前这条对话？清掉就没了（存档里的不受影响）。')) return
              setMsgs([]); setCard(null); setHint(''); setNote(''); setBusy(false)
            },
            title: '清空当前对话（要你确认；不写库）',
            style: { background: 'none', border: '1px solid ' + C.bd, borderRadius: 6, cursor: 'pointer', color: C.t2, fontSize: 11, padding: '2px 6px' }
          }, '清空'),
          // 2026-10-22（m00521）：侧栏在左边 → 收起方向也是往左（‹），别再用向右的箭头骗人
          React.createElement('button', { onClick: function () { setOpen(false) }, title: '收起侧栏（收进左边窄条）', style: { background: 'none', border: '1px solid ' + C.bd, borderRadius: 6, cursor: 'pointer', color: C.t2, fontSize: 11, padding: '2px 6px' } }, '‹')),
        React.createElement('div', { ref: listRef, style: { flex: 1, minHeight: 0, overflowY: 'auto', padding: 10 } }, msgNodes,
          // 2026-10-21（m04728）：等待中也说一句，别让人对着空白猜「发出去了没有」
          React.createElement(AiDockWaiting, { busy: busy, since: AI_DOCK_BUSY_SINCE, hint: hint, live: live, onStop: aiDockStop })),
        (cardNode || askNode || hint || note) ? React.createElement('div', { style: { padding: '0 10px 6px' } },
          askNode || null,
          cardNode || null,
          hint ? React.createElement('div', { style: { fontSize: 11, color: C.ok, marginBottom: 4 } }, hint) : null,
          note ? React.createElement('div', { style: { fontSize: 11, color: C.danger, marginBottom: 4 } }, note) : null) : null,
        React.createElement('div', { onPaste: onPasteFiles, style: { borderTop: '1px solid ' + C.bd, padding: 8, display: 'flex', flexDirection: 'column', gap: 6 } },
          chips.length ? React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4 } }, chips) : null,
          React.createElement('textarea', {
            value: text, rows: 3, placeholder: '说点什么…（例：帮我给孙晨写个开场 / 这次电话聊完了，帮我记一条）',
            onChange: function (e) { setText(e.target.value) },
            onKeyDown: function (e) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send() } },
            style: { width: '100%', boxSizing: 'border-box', resize: 'vertical', minHeight: 54, fontSize: 12.5, lineHeight: 1.6, color: C.t1, background: 'transparent', border: '1px solid ' + C.bd, borderRadius: 6, padding: '6px 8px', outline: 'none' },
          }),
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            React.createElement('input', { ref: imgRef, type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', multiple: true, style: { display: 'none' }, onChange: function (e) { addImgs(e.target.files) } }),
            React.createElement('button', { onClick: function () { if (imgRef.current) imgRef.current.click() }, style: { background: 'none', border: '1px solid ' + C.bd, borderRadius: 6, cursor: 'pointer', color: C.t2, fontSize: 11.5, padding: '3px 8px' } }, '📎 图片'),
            React.createElement('input', { ref: fileRef, type: 'file', accept: '.txt,.md,.markdown,.csv,.tsv,.json,.jsonl,.xml,.html,.log,.srt,.vtt,.yaml,.yml,.sql,.docx,.xlsx,.pdf,.eml,text/plain', multiple: true, style: { display: 'none' }, onChange: function (e) { addFiles(e.target.files) } }),
            React.createElement('button', { onClick: function () { if (fileRef.current) fileRef.current.click() }, style: { background: 'none', border: '1px solid ' + C.bd, borderRadius: 6, cursor: 'pointer', color: C.t2, fontSize: 11.5, padding: '3px 8px' } }, '📎 文件'),
            React.createElement('div', { style: { flex: 1 } }),
            React.createElement('button', { onClick: send, disabled: busy, style: { background: 'var(--accent-tint, rgba(37,99,235,.16))', border: '1px solid ' + C.acc, borderRadius: 6, padding: '4px 12px', cursor: busy ? 'wait' : 'pointer', color: C.t1, fontSize: 12, opacity: busy ? 0.6 : 1 } }, busy ? '想…' : '发送'),
          ),
          React.createElement('div', { style: { fontSize: 10.5, color: C.t3 } }, 'Ctrl+Enter 发送 · 图片/文件可直接 Ctrl+V 粘贴 · 写库要你点确认 · 客户数据只发给模型厂商')),
        // 2026-10-22（m01968）：点附件缩略图 → 面板内放大浮层（不联网、不上传，纯本机 dataURL）
        viewer ? React.createElement(AiDockViewer, { view: viewer, onClose: function () { setViewer(null) } }) : null)
    }
    // 组件外的辅助函数：拿不到 THEME 对象，只能用 root 上注入的 CSS 变量（fallback 给浅色可读的值）
    function levelColor(l) {
      if (l === 'S') return 'var(--gold-color, #9a6700)'
      if (l === 'A') return 'var(--danger-color, #c92a2a)'
      if (l === 'B') return 'var(--warn-color, #a15c00)'
      if (l === 'C') return 'var(--blue-color, #1c7ed6)'
      return 'var(--text-2, #6b7280)'
    }
}

    exports.apply = apply
    // 2026-09-14 加固: 必须声明 slots —— apply 里用 ctx.get('slots') 取槽位服务，
    //   原来只声明 timer，一旦 slots 的激活顺序靠后就会 `if (slots === undefined) return`，
    //   整个销售 UI（侧边栏入口 + 看板）静默不注册、零日志，极难定位。
    // 2026-10-08 事故定案（**别再收窄这一行**）：审计那轮把这里从 ['slots','timer'] 收成 ['slots']，
    //   理由是「'timer' 只是 apply 内的局部变量名、服务从未被使用」——**判断错了**：看板 `[open]` 那个
    //   定时器 effect 里调的是 `ctx.interval(silentRefresh, 30000)`，而 Cordis 的定时器服务名就叫 **timer**
    //   （内部 `ctx.get('timer')`）。实机症状链（2026-10-08 用户报「点入口面板打不开」）：
    //     点入口 → 组件挂载、open 置 true → 该 effect 抛 `cannot get property "timer" without inject`
    //     → 错误逃出我们的 BoardErrorBoundary（它挂在子树里，接不到本组件自身 effect 的错）
    //     → 宿主 `dsh-client-ui-renderer/lib/client.js:790` reportEntryError(..., { abdicate:true })
    //       **弃用整条贡献** → React 卸载整棵子树 → 面板「一点反应都没有」，之后点击只剩模块级监听在响。
    //   localStorage 埋点实据：`effect:throw name="interval" msg="cannot get property \"timer\" without inject"`。
    //   → **只要还在用 ctx.interval，就必须声明 'timer'**（另见组件里那个 effect 的 try/catch 兜底）。
    // 两个 inject 不是一回事，别互相"对齐"：
    //   · package.json 的 dsh.client.inject = **包名依赖边**（保持 []；写 ["slots"] 会去等一个不存在的包，
    //     本插件的客户端行永不 materialize —— 2026.10.08.2 那笔就白改了）；
    //   · 这里 exports.inject = **Cordis 服务声明**（用到哪些服务就写哪些）。
    // 2026-10-09 通话记录台再加 'remote'：面板里 `ctx.get('remote').speech`（本机语音转写）是唯一入口，
    //   与官方麦克风插件同款注入。漏了它 = 取不到 speech → 面板只剩"定位客户 + 复制话术"，别的都正常。
    exports.inject = ['slots', 'timer', 'remote']
    return module.exports
  }
})
