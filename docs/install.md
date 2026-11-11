# 安装与初始化

> 本文假设你已经有 **DeepSeek Harness（DSH）桌面端**。dsh-sales 是 DSH 的插件，不是一个能单独双击运行的软件：它注册模型工具、HTTP 路由和一个看板，全部跑在 DSH 宿主进程里。

## 0. 前提

| 项 | 要求 | 说明 |
|---|---|---|
| DSH | 桌面端 0.2.x（或同版本的 web profile） | 插件依赖 DSH 的 `@deepseek-ai/dsh-tools`，由宿主运行时提供 |
| Node.js | **≥ 20** | `package.json` 的 `engines` 要求；`npm run doctor` 会检查 |
| 系统 | Windows / macOS / Linux 均可 | 路径解析全部走 `node:path`，没有写死任何盘符 |
| 磁盘 | 一个你自己选的**数据目录** | Excel 表、合同、日志都在这里；建议不要放在同步盘里（见 [docs/privacy.md](./privacy.md)） |

## 1. 获取代码

```bash
git clone <本仓库地址> dsh-sales
cd dsh-sales
npm install          # 运行时依赖只有两个：xlsx；fflate 仅用于压缩 .docx（缺失也能跑）
```

> **不要**在插件目录里手放 `node_modules/@deepseek-ai/dsh-tools`。这个包必须由 DSH 宿主在运行时供给；本地放一份副本会遮蔽运行时版本，症状是插件在「插件」面板里显示**启用失败**，而宿主日志里看不出原因。

## 2. 装进 DSH

1. 打开 DSH 桌面端 → 侧边栏「**插件**」→「**添加插件**」。
2. 选择「**本地插件目录**」，指向刚才 clone 出来的 `dsh-sales` 仓库根目录（就是有 `package.json` 和 `cordis.patch.yml` 的那一层）。
3. 安装完成后，**从托盘完全退出 DSH 再重新启动**。运行中的宿主不会热加载新的 bundle。

重启后能确认它真的装上了，看三处：

- 「插件」面板里 `dsh-sales` 处于**已启用**；
- 侧边栏底部出现一个销售入口按钮；
- 对 DSH 说「今天该给谁打电话」，模型能调用 `sales_plan` 工具（说明 16 个工具已注册）。

### 2.1 进阶：把插件目录写成 profile 的本地依赖

如果你在同一台机器上维护多个 profile、或要做自动化装配，也可以把本仓库作为**本地依赖**写进该 profile 的 `package.json`：

```json
{
  "dependencies": {
    "dsh-sales": "link:<本仓库的绝对路径>"
  }
}
```

三条注意：

- `peerDependencies` 里的 `@deepseek-ai/dsh-tools` **必须保留**——DSH 靠它决定是否用运行时包供给（删掉的症状是「启用失败」且日志里看不出原因）；
- 插件目录里**不要**出现 `node_modules/@deepseek-ai/dsh-tools` 副本或链接，会遮蔽运行时版本；
- 改完 profile 配置必须**托盘退出再重启**，热加载不生效。

普通用户用上面的图形界面安装即可，不必手改 profile。

## 3. 初始化数据目录

两种方式，任选一种，效果相同（都是幂等的，重复跑不会覆盖已有客户数据）。

### 3.1 命令行（推荐，可脚本化）

```bash
# 先干跑看一眼它准备做什么，不落盘
node scripts/setup.mjs --data-dir "/home/you/sales-data" --check

# 确认无误再真建
node scripts/setup.mjs --data-dir "/home/you/sales-data" --yes
```

Windows 示例：

```bash
node scripts/setup.mjs --data-dir "D:/我的销售数据" --yes   # 示例路径
```

它会做四件事：

1. 建目录骨架 `营销资料库/`、`合同/`、`logs/`、`快照/`；
2. 建两张空表（`销售客户-主表.xlsx` 含「客户主表」31 列 + 「联系人」5 列；`销售客户-流水表.xlsx` 含「跟进流水」11 列）；
3. 把仓库里 `templates/营销资料库/` 的示例语料复制进你的 `营销资料库/`（**只补缺，不覆盖**你改过的文件）；
4. 写配置档（默认 `<home>/.dsh/sales.config.json`，记录 `dataDir`、模型通道、RAG 开关、公司/产品名）。

### 3.2 看板里的首次设置向导

如果你跳过命令行，第一次打开看板时会自动进入三步向导：

1. **数据目录**：填一个绝对路径，或点「使用默认位置」（默认 `<home>/dsh-sales-data`）。相对路径会被拒绝。
2. **模型通道**：默认 `session`（跟随当前会话模型，零配置、不要 API key）；也可以选 `fixed` / `local`，点「测试连接」会真发一次极短的模型请求，失败不阻止保存。
3. **确认**：先保存配置，再建目录和空表，最后显示「创建了什么 + 示例语料条数」，点「进入看板」。

装好之后，看板标题栏的「**⚙ 设置**」按钮可以随时改数据目录、模型通道、RAG 开关和公司/产品名。

## 4. 装完先自检

```bash
npm run check
```

`npm run check` 展开成两条只读检查；另有一条集成冒烟要单独跑（`npm run smoke`）：

| 命令 | 查什么 |
|---|---|
| `npm run doctor` | 体检（项数随版本增加）：Node 版本、xlsx 可加载、表头契约与 `lib/sales-lib.js` 逐字一致、配置档合法、数据目录已配置且是绝对路径、两张表与三个 sheet 表头对得上、`logs/` 可写、`营销资料库/` 有可检索语料、仓库示例语料完整 |
| `npm run check-no-pii` | 仓库里有没有真实手机号 / 邮箱 / 身份证 / API key / 本机绝对路径 / 私有品牌词；命中即非零退出 |
| `npm run smoke` | 集成冒烟：用假 ctx 加载插件，真跑 `/sales` 路由与数据层（不需要 DSH、不调真模型，数据写在系统临时目录） |

全绿再开始录数据。换机器、升级、迁移目录之后也建议各跑一遍。

## 5. 第一次跑起来是什么样

打开看板（侧边栏底部入口）后：

- **今日任务**页签会告诉你今天该打哪些电话、每条为什么、开口怎么说；
- 空库时它会说「没有客户」，这很正常 —— 先加客户（直接跟模型说「帮我建一个客户」即可）；
- 想先看效果再录数据：跑 `node scripts/demo.mjs`（或看板「⚙ 设置 → 示例数据 → 生成示例数据」）会塞 3 条**明显是示例**的客户，`--clean` / 「清除示例数据」只删这 3 条；
- 内容区**左侧**是 AI 对话框，可以就当前客户追问；
- 标题栏可以切主题（纸白 / 墨黑 / 护眼 / 高对比）；`sales-live-panel` 是通话记录台浮层。

## 6. 升级

```bash
cd dsh-sales
git pull
npm install
npm run check
```

然后托盘退出 DSH、重新启动。**数据目录不会被升级碰到**：数据和代码是分开的，升级只换插件本体。

升级前建议把数据目录整体复制一份（Excel 两张表 + `合同/` + `*.json` 就够）。

## 7. 卸载

在 DSH「插件」面板里禁用或移除 `dsh-sales`，重启宿主即可。**你的数据目录不会被删除**，需要清理由你自己动手。

## 8. 常见问题

**「启用失败」/ 插件装上但工具不出现**

按顺序排查：① 仓库根目录有没有多出 `node_modules/@deepseek-ai/dsh-tools`（有就删掉）；② `package.json` 的 `peerDependencies` 里是否还声明着 `@deepseek-ai/dsh-tools`（不要删）；③ 是否真的重启过宿主；④ DSH 版本是否满足 0.2.x。

**看板打开了但是空白 / 一直转圈**

多半是配置没完成或数据目录不存在：跑 `node scripts/doctor.mjs` 看哪项红；或者打开「⚙ 设置」重新选目录、点保存。

**`npm run doctor` 报「表头与契约不一致」**

说明有人改过列名或删过列。用 Excel 打开那张表，把表头行恢复成 `lib/sales-lib.js` 里 `HEADERS_*` 的原样（列顺序可以不同，**列名必须逐字一致**）。详见 [docs/data-model.md](./data-model.md)。

**模型不回答 / 一直回落到规则版话术**

看板里的 AI 是**可选的增强**：通道不通时所有功能都会退回规则版，照样能用。先查模型通道（`session` 模式要求当前会话本身有可用模型），再看 `<数据目录>/logs/ai-calls.log` 里的失败记录。

**`npm install` 装不上（没网 / 公司代理 / 卡在构建脚本）**

运行时依赖只有 `xlsx` 一个（`fflate` 是可选的 .docx 压缩优化，缺了会自动走内置零依赖写法）。所以：

- 有网但慢：`npm install --registry=https://registry.npmmirror.com`；
- 完全没网：在任一台能装上的机器执行 `npm install`，把 `node_modules/xlsx` 整个目录拷过来即可（`node_modules/` 本来就不进 git）；
- 只想先用起来、不装也能看界面：看板与数据层照常工作，只有「生成合同 .docx」会用到压缩，缺了也能生成。

**示例数据怎么清掉 / 会不会和真实客户混在一起**

示例客户 ID 固定为 `DEMO-001`~`DEMO-003`，公司名带「示例」、电话是示例号段；生成时会在数据目录写一份 `示例数据.json` 记下这三个 ID。清除（`node scripts/demo.mjs --clean` 或「⚙ 设置 → 清除示例数据」）**只删登记过的 ID**，不会碰你自己录的客户。

**数据目录选在哪比较好**

自己机器上的普通目录即可。**不要**放在 OneDrive / iCloud / WPS 云盘 / 网络共享盘里 —— 同步盘会在你写表的同时回写文件，轻则写锁冲突，重则把表改坏。理由见 [docs/privacy.md](./privacy.md)。

---

下一步：[配置说明](./configuration.md) · [数据模型](./data-model.md) · [模型工具清单](./tools.md) · [隐私与数据边界](./privacy.md)
