# 参与贡献

谢谢愿意花时间。这个项目最需要的是**真实使用场景里的反馈**：哪个页面你每天打开、哪个按钮你从来不点、哪句 AI 输出你会直接删掉重写。

## 欢迎的贡献

- Bug 报告（附复现步骤、期望行为、实际行为）
- 数据层与派生视图的边界用例（空表、超期客户、异常日期、重复手机号、导入脏数据）
- 文档修正（说错了、说不清、示例过期）
- 本地化 / 无障碍 / 性能改进
- 新功能提案（**先开 Issue 讨论**，避免写完不合方向）

## 不接受

- 真实客户数据、真实姓名 / 手机号 / 公司名 / 合同内容（哪怕脱敏了一半）
- 本机绝对路径、API key、token、私有仓库地址
- 让插件自己 `fetch` / 直连模型 provider 的改动（出网只经 DSH 宿主）
- 引入重量级依赖（运行时依赖目前只有 `xlsx`；加依赖请在 Issue 里先说明理由）
- 把「本地优先」改成「默认上云」的改动

## 本地开发

```bash
git clone <本仓库地址> dsh-sales
cd dsh-sales
npm install

# 建一个临时数据目录（不要指向真实客户数据）
node scripts/setup.mjs --data-dir "/tmp/dsh-sales-dev" --yes

# 三条必过检查
npm run syntax        # node --check 各入口文件
npm run check         # 体检 + 隐私扫描（只读，不改数据）
npm run smoke         # 集成冒烟：假 ctx 加载插件，跑真 /sales 路由与数据层

# 装一次提交前钩子（强烈建议）
npm run hooks         # = git config core.hooksPath .githooks
```

> `npm run smoke` 不需要 DSH 宿主、也不调真模型：它用假 ctx 加载 `dsh/index.js`，走真 HTTP 路由与真数据层（未配置 → 写配置 → 相对路径拒绝 → setup 建表 → 幂等 → 读数据 → `sales_log` 写读闭环 → `configtest` 假模型 → egress → RAG）。**首次跑会在 `node_modules` 里造一个 `@deepseek-ai/dsh-tools` 桩**——`node_modules` 已 gitignore，不会进仓库，也不会影响 DSH 里的真实宿主。

在 DSH 里调试：侧边栏「插件」→「添加插件」→「本地插件目录」→ 选仓库根 → 安装 → **托盘退出 DSH 再重启**（运行中改 `client.js` 会把组合包弄坏）。改完代码重复这一步。

> 如果你用 Windows + MSYS/Git Bash：`--data-dir` 请给带盘符的绝对路径（示例：`D:/我的销售数据`）。MSYS 的 `/d/...` 被 Node 解析成 `\d\...`，会在当前盘根目录下多建一层 `d/`。

## 代码地图

| 想改什么 | 去哪个文件 | 先读 |
|---|---|---|
| 模型工具、HTTP 路由、AI 编排 | `dsh/index.js` | [docs/architecture.md](docs/architecture.md) |
| 看板 UI（侧边栏、全屏看板、通话记录台） | `dsh/client.js` | 同上 |
| Excel 读写、SOP 引擎、派生视图 | `lib/sales-lib.js` | [docs/data-model.md](docs/data-model.md) |
| 模型出口 / 超时 / 回落 | `dsh/ai.js` | — |
| 配置解析 | `dsh/config.js` | [docs/configuration.md](docs/configuration.md) |
| 脱敏 | `dsh/redact.js` | [docs/privacy.md](docs/privacy.md) |
| 出网闸门 | `dsh/egress-guard.js` | 同上 |
| 合同生成 / 初审 | `dsh/contract-docx.js` / `dsh/contract-review.js` | 模板在 `dsh/contract-templates/` |

## 三条不许破的线

1. **只有 `dsh/ai.js` 允许出现 `llm.stream(`**。别的文件要调模型，import 它的 `aiStream`。
2. **写 Excel 只走 `lib/sales-lib.js` 的写入口**（`cmdLog` / `cmdAdd` / `writeMaster` / `writeFlow`）：写锁 + 表头断言 + 原子写 + 变更日志都在里面。不要直接 `XLSX.writeFile` 到真实表。
3. **插件代码里不许出现网络请求**（`fetch`、`http.request`、直连 provider）。出网只经 DSH 宿主，这是隐私边界的基础。

## 改数据层时

- 列名是契约。要加/改列，必须同时改：`lib/sales-lib.js` 的 `HEADERS_*`、`scripts/setup.mjs` 的同名常量，然后跑 `npm run doctor` 确认逐字一致。
- 日期一律 `YYYY-MM-DD` 文本；不要写 Excel 序列号、不要写「今天」。
- 派生数据**现算、不缓存**（缓存一定会过期，过期数据比没数据更危险）。
- 写状态时要考虑「挂起态必须有据」的守卫：新增状态值请同步更新守卫与文档。

## 提交前自检

```bash
npm run syntax && npm run check && npm run smoke
```

`check-no-pii` 会扫手机号、邮箱、身份证、疑似 API key、本机绝对路径、私有品牌词。命中就修掉——仓库是公开的，一次泄漏就是一次事故。`smoke` 会真写临时数据目录（默认在系统临时目录下，不碰你的真实数据）。

改动涉及 UI 的，请手动过一遍：

- 首次设置向导（清空配置后打开看板，三步能走完）
- 「⚙ 设置」保存后看板立即生效
- 9 个页签都能打开，空库不白屏
- 记一次跟进 → 今日任务/客户页能看到变化

## 提交信息

建议用简短的祈使句，可带前缀（不强制 Conventional Commits）：

```text
feat: 周战役支持按行业过滤
fix: 未传 nextDate 时不再清空主表排期
docs: 补 lib/package.json 的说明
chore: 升级 xlsx
```

一个提交只做一件事。格式化/重排类改动请单独提交，方便 review。

## PR 清单

- [ ] `npm run syntax && npm run check && npm run smoke` 通过
- [ ] 没有真实客户数据、真实联系人、本机路径、密钥
- [ ] 新行为有文档（README / `docs/`），用户可见的变化记进 `CHANGELOG.md`
- [ ] 破坏性改动在 PR 描述里写明迁移方式
- [ ] 涉及数据层/隐私边界的改动，PR 描述里说清「为什么不会破坏原有边界」

## 报告安全或隐私问题

**不要**在公开 Issue 里贴客户数据或可利用细节。请用仓库的 **Security → Report a vulnerability** 私密通道，或先开一个不含细节的 Issue 说明「有安全问题，需要私聊」。维护者会尽快回复。

## 文档

- 用户文档在 `docs/`，入口是 `README.md`
- 文档里的示例路径一律用 `<你的数据目录>`、`/home/you/sales-data`、`D:/我的销售数据` 这类占位形式，不要写任何真实盘符路径
- 所有文本文件 UTF-8 + LF（`.gitattributes` 已强制）
