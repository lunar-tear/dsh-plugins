[English](README.en.md) | 中文

# dsh-markdown-preview

一个常驻在对话旁边的 Markdown 预览。点击会话标题栏里的开关，右侧会滑出一个抽屉，显示工作区中的某个 Markdown
文件，并用 GUI 自带的渲染器渲染——因此 TeX/KaTeX 数学公式、带高亮的围栏代码、表格、任务列表、脚注和链接的表现
与聊天中完全一致——而且文档里的**本地图片能真正渲染出来**，这是单靠聊天渲染器做不到的。

两部分都是纯 JavaScript。没有构建步骤，不需要 `node_modules`，也不会往 DSH 检出目录里添加任何东西。

## 使用方法

**点击文件即可打开。** 有两种方式，最终都会落到面板里：

- **正文提及**——写在收尾消息里的 `docs/implementation_plan.md`——现在会打开面板，而不是打开 Host 编辑器
  （见下文）；
- 消息点名 Markdown 文件时，其下方出现的 **chips 行**：`docs/` 显示为弱化色，
  `implementation_plan.md` 显示为粗体。只有工作区确认存在的文件才会被列出，所以点开任何一个 chip 都有内容；
  模型从别的检出目录里引用过来的路径不会进入这一行，免得成为一次点了没反应的死点击。

面板以**对话为作用域**：它只列出你正在看的这个对话提到过的内容，切换对话时面板也随之切换。文件列表由 chips
渲染器按会话记录——它是唯一同时拿到消息中的路径和这些消息所属会话的地方——因此新会话在渲染的那一刻，用自己的
列表就是正确的。工作区文件列表仍然会被拉取，但只用于确认这些路径确实存在；它绝不会被当作可供浏览的地方。如果
一个文件都没被点名，面板会如实说明，而不是随便打开一个对话中从未提及的文档。

面板是一个侧边栏——占**视口的 45%**，宽到足以容纳带表格和图表的正文，同时对话仍然可读，并且它会记住你拖动后的
宽度（上限为视口宽度减去 240px 的条带）。在面板内部，**文档是主角**：文件列表只是一个旁栏，最高占**面板高度的
20%**，并在这一范围内滚动，因此展开它绝不会把 Markdown 挤成底部的一条细带——无论展开与否，文档都保有约 80%
的空间。

**当对话点名某个文档时，它会自动打开。** 只要会话确实在运行，它点名的 Markdown 文件——也就是 agent 刚写好的
计划——无需点击就会打开面板，就像 Antigravity 里弹出的计划面板那样。这个门槛很重要：进入一个早已点名过文档的旧
对话不会弹出任何东西，你明确做出的选择绝不会被抢走，关闭面板只是把*那个*文件从*那个*会话里关掉，而新点名的文件
依然会自动打开。文件列表顶部的开关可以关掉这一行为。

打开面板还会**收起框架自带的右栏**（详情面板）：两个面板争抢同一条边缘，结果谁也读不清。

1. 也可以点击会话标题栏里的预览开关（会话工具按钮旁边那个带文档的面板图标）——面板会在右侧打开。
2. 文件会**跟随对话**：消息提到的每一个 `.md` 路径都会成为候选，最终显示其中最新的、且确实能解析到的那一个。
   所以当你和 agent 聊到 `docs/design/overview.md` 时，它就会出现。
3. 抽屉标题栏里的下拉菜单提供：
   - **对话里提到过** —— 本对话中提到过的路径，最新的排在前面。
   - **工作区里的 Markdown** —— 工作区中最新的 Markdown 文件（有界遍历：最多 6 层、4000 个条目，跳过点号目录、
     `node_modules`/`dist`/`build`/`vendor`/`venv` 以及符号链接）。
   - 一个文本框，可填入任意相对于工作区的路径（`docs/design/overview.md`）。
4. 左边缘的拖拽把手可以调整抽屉宽度（320–900 px）。🔄 按钮会强制立即重新读取；除此之外，抽屉每 2.5 s 重新校验
   一次文件，只有内容变化时才重新渲染。

**也可以用链接直接打开某篇文档。** 加上 `?preview=` 查询参数即可：

```text
http://127.0.0.1:3080/?preview=docs%2Fplan.md
```

被链接的文档是按"显式选择"打开的，所以对话自己的跟随不会把它顶掉——适合把一篇方案直接贴给同事，或者自己收藏起来。

**`.html`/`.htm` 路径打开的是画布，而不是文档。** 以 `.html` 或 `.htm` 结尾的路径会在面板里作为**画布**打开：artifact
在一个沙箱化的 `<iframe>` 中运行（`allow-scripts allow-forms allow-modals allow-popups`，响应本身还带有
`Content-Security-Policy: sandbox …`），因此它的脚本跑在不透明源（opaque origin）里，读不到本应用的 cookie、存储或
RPC。画布工具栏提供**重新加载 / 下载 HTML / 新标签打开**。

文件 chips 行和 `?preview=` 深链接同样接受 `.html`/`.htm`；工作区文件列表现在也会在 `.md` 之外列出 `.html`，但它仍然
只用于确认被点名的路径确实存在。

## 效果

![Markdown 预览面板](../docs/preview-panel.png)

面板是 shell 自带的渲染器：公式、代码高亮、表格、任务列表、脚注与聊天里完全一致，文档里的本地图片也会显示。

## 实现方式

| 部分 | 文件 | 作用 |
|---|---|---|
| Host | `index.js` | 三个只读路由：Markdown 文本、图片字节、工作区 `.md` 列表 |
| 浏览器 | `client.js` | 一个 Conversation Definition，负责发布 chips 节点并提供文件列表；一个针对这些 chips 的聊天节点渲染器；标题栏开关；以及 overlay 抽屉 |

渲染复用了 `@deepseek-ai/dsh-client-ui-primitives` 里的 `MarkdownText`——也就是聊天所用的同一个组件——因此这个
插件不拥有自己的 Markdown 管线。数学公式、代码高亮以及其他所有构造都来自 shell。

它填补的唯一空缺是：该渲染器**只接受绝对的 http(s) 图片 URL**，所以文档里的 `![](figure.png)` 会被悄无声息地渲染
成纯文本。插件会把每个本地目标重写到 Host 的图片路由，解析时**相对于文档自身所在目录**
（`docs/design/overview.md` + `../img/a.png` → `docs/img/a.png`）。它无法提供的内容——`~` 路径、逃出工作区的
路径、位于工作区之外的绝对路径——都会按原样保留，这样读者看到的是原始文本或替代文字，而不是一张裂图。

**Mermaid 图表是它自己拆出来渲染的。** 文档里的 `` ```mermaid `` 围栏会在渲染前从 Markdown 源码里拆出来，交给
mermaid 引擎画成真正的图——识别发生在文档源码上，而不是渲染完再去查询 DOM。引擎用的是宿主本来就带着的那份浏览器
构建（harness 的一个文档依赖）：插件先在自身旁边找（`vendor/mermaid.min.js`，宿主有的话由 `install.sh` 复制进来），
再去 harness profile 的模块树里找，最后从正在运行的服务器入口点向上遍历查找。没装引擎时，图表就退化成它本来的那个
代码块。引擎以 `securityLevel: 'strict'` 初始化。每张渲染出来的图都提供**导出 SVG / 导出 PNG**——其中 PNG 按 2x
导出，方便放进幻灯片。

chips 节点的 kind 长度刻意取 50-59 个字符：Chat 视图在锚点序列相同的节点之间通过比较 key 来打破平局，key 的格式
是 `<kind.length>:<kind><id>`，而所有内置 kind 的 key 都以小于 5 的数字开头——所以正是这个长度让 chips 排在点名了
那些文件的消息*下方*。测试对此做了断言。

有两个挂载位置很关键，而且两者都是既有的扩展点，而不是新开的接缝：开关注册到
`conversation.session.header.utilities`（一个会话作用域的列表插槽，因此它按会话挂载，并从 sessions 快照中读取该
会话的工作区根目录），抽屉注册到 `shell.overlay`（一个根作用域的列表插槽，渲染在框架的 overlay 层中，与内置条目
并存）。对话自带的详情栏不受影响。

## 访问模型

只有当文件的**真实**路径（已解析符号链接）位于调用方指定的工作区根目录之内、扩展名在该路由的允许列表中（文本为
`.md/.markdown/.mdown`，图片为 `.png/.jpg/.jpeg/.webp/.gif`）、字节内容与扩展名相符，并且文件大小不超过该路由的
上限（Markdown 为 2 MiB，单张图片为 32 MiB）时，文件才会被提供。`Host` 头必须指向回环地址
（`127.0.0.1`/`localhost`/`[::1]`）——这是防 DNS 重绑定的护栏——浏览器标记为跨站的请求会被拒绝。非浏览器调用方
不会发送这两个头，因而被当作回环调用方信任，这与本地 GUI 其余部分的信任假设一致。如果部署时把 GUI 绑定到非回环
网卡，必须在 `index.js` 中放宽 `loopbackHost`。

## 为什么正文提及是被*包装*而不是被替换

聊天视图会向 `chatFileMentions` 服务询问某个收尾 Turn 的正文词表，而内置的提供者——`ui-deliverables`——会把该
Turn 的变更类工具触碰过的文件做成链接，点击后在 Host 编辑器中打开。对于一个你只想读一读的计划文档来说，这个动作
并不合适。

最规范的做法是再提供一个实现，但 Cordis 不允许：当服务名已被注册时 `ctx.provide` 会抛错。因此这个插件**包装了现有
提供者的 `forClosing`**：本工作区中存在的 Markdown 路径会变成一个可打开面板的提及，其余所有 token 都原样交给原来
的解析器（它的返回值绝不会被覆盖）。包装会随插件一起移除；当该服务不存在或形状不同时，它什么也不做。

如果你更希望所有地方都继续以编辑器作为点击目标，删掉 `client.js` 里 `apply` 末尾的 `installMentionInterception(ctx)`
调用即可；chips 行仍然照常工作。

## 启用 / 停用

有两种接入方式。`../install.sh --link` 会替你完成第一种。

**1. 把目录复制（或软链接）到 harness home，并添加一行配置**——立即生效，无需重启 `dsh web`：

```sh
cp -r markdown-preview ~/.dsh/plugins/dsh-markdown-preview
```

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: markdown-preview
      name: 'file:///home/<you>/.dsh/plugins/dsh-markdown-preview/index.js'
```

**2. 把它作为 profile bundle 安装**——此时那一行配置来自本包自带的 `cordis.patch.yml`，但 bundle 列表是在启动时
读取的，所以这种方式需要重启 `dsh web`：

```sh
dsh plugin --profile web add /path/to/dsh-plugins/markdown-preview
```

不要两种都用：同一个包名存在两个活跃的 Loader 源会报错。

`web` profile 会实时应用用户的 patch 修改，因此增删这一行无需重启 `dsh web` 即可生效；而浏览器那一半的加载或卸载
取决于**页面刷新**。删掉这一行就是全部的关闭开关——开关、抽屉和三个路由会一起消失。

可以从 shell 验证，不需要 GUI token：

```sh
curl -sN --max-time 3 http://127.0.0.1:3080/plugins/events | grep -o '"id":"[^"]*"'   # roster, expect dsh-markdown-preview
curl -s "http://127.0.0.1:3080/plugin/markdown-preview/file?path=README.md&cwd=$PWD" | head -3
curl -s "http://127.0.0.1:3080/plugin/markdown-preview/find?cwd=$PWD" | head -c 200
```

## 修改代码

| 部分 | 改动如何生效 |
|---|---|
| `client.js` | 直接保存即可。Host 会轮询每个被提供 bundle 的 stat（约 500 ms）并推送一个 reload 帧，因此已打开的页面会热替换该插件——不用刷新，也不需要 watcher 进程。 |
| `index.js` | 把该行 URL 上的 `?v=` 查询参数递增一下（patch watcher 会在一秒内应用它），因为 Node 按 URL 缓存 ES 模块——重新插入同一个 URL 只会复用已经加载的模块。重启 `dsh web` 同样可行。 |

## 测试

```sh
node test.mjs
```

无需 harness 即可驱动两部分：浏览器 bundle 走真实的 `__ModuleLoader__.load` 握手，配合一个 React stub 和被 stub
的 `fetch`（提及提取、相对文档的解析、图片重写、插件状态、`apply` 注册、开关、抽屉）；Host 那一半则针对真实文件
运行（穿越与符号链接拒绝、surface-op 门禁、ETag 重新校验、有界列表遍历、跨站与重绑定 Host 的拒绝）。
