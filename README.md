# Agent Resource Manager

Windows-first desktop manager for local and GitHub Agent Skills and independent agent tools. Keep one runtime folder per skill, preserve tools in their original locations, and share registered actions through the desktop and local MCP backend.

**开发预览：v0.3.0-dev.1，尚未公开发行。** 在现有 Skill 管理基础上增加工具登记、受管动作、安装包文件预览、分级卸载、配置导入导出、维护窗口、场景和统一快捷入口。资源保持原位，GUI 与本地 MCP 共用后台；现有功能与数据继续保留。[开发预览说明](docs/RELEASE_v0.3.0-dev.1.md)

efbd候选的100次本地文档原生交互P95为141.3951ms、最大270.7571ms，原200ms P95目标通过；既有6c的1061.8325ms慢样本保留在历史记录。真实中文输入已通过。最新30分钟检查完成61次采样，没有程序异常，但内存收敛未达原定标准；不能将本地P95当作远端速度或完整性能通过。[当前验证范围](CHANGELOG.md#tool-directory-relocation-20261117)

新候选进一步减少说明读取的前置工作：按固定提交仅读取沿途目录和目标文档，不再先列出全仓库；下载、更新和差异核对仍使用完整清单。相关协议、链接安全和回退检查通过，修复后的真实加载延迟及完整内存收敛仍待验证。[本轮修改](CHANGELOG.md#documentation-path-read-20261113)

完整开发源码已同步到 [codex/agent-resource-manager 分支](https://github.com/Zerozero05/Agent_Resource_Manager/tree/codex/agent-resource-manager)，正式分支和既有发行保留。GitHub构建检查与本机原生验收分别记录，源码同步不代表完整验收或新版本发行。[源码与检查记录](CHANGELOG.md#source-ci-exit-20261112)

程序、管理数据、缓存和导出的位置可在设置中查看和调整。全新 v0.3 便携包的管理数据位于包根目录的 `data` 子目录。既有 Skill 与工具保留原位置。本机路径示例见下方使用说明。

最新正式发行版本为 **v0.2.11**，修复说明更新长期停留待办、旧自动文件范围和脚本参数误判，并精简变化页的批量选择。界面使用中文。应用版本以 `package.json` 为界面与打包版本来源。

[公开仓库](https://github.com/Zerozero05/Agent_Resource_Manager) · [v0.2.11 下载与校验](https://github.com/Zerozero05/Agent_Resource_Manager/releases/tag/v0.2.11) · [使用指南](docs/USER_GUIDE.md) · [发行说明](docs/RELEASE_v0.2.11.md)

本版通过183项前端、389项Rust检查及Windows构建；原生变化页、选择快捷键、宽窄分栏和重启保持已验证。便携包、安装器与源码分别提供，附件摘要和验证边界见[发行说明](docs/RELEASE_v0.2.11.md)。

Windows x64 用户可选择便携 ZIP 或安装包；源码 ZIP 用于开发与维护，具体文件和校验摘要以发行页为准。程序需要 Microsoft Edge WebView2 Runtime。

v0.2.11 便携包的 `data-directory.txt` 为 `.`，新使用时把管理数据保存在程序同目录。升级既有安装时保留原数据目录与自定义路径侧文件，不用通用包的默认路径覆盖原设置。安装器与便携包包含同一份已验 EXE；安装器内容已解包核验，安装向导尚未实际运行。

**许可状态：** 项目自身尚未指定开源许可证，公开源码不等于授予 MIT 等额外使用许可；第三方依赖继续遵循各自许可证，详见 [THIRD_PARTY_NOTICES](docs/THIRD_PARTY_NOTICES.txt) 和 [来源记录](docs/SOURCES.md)。

## 能做什么

- 文件页与导出页共用本次 ZIP 选择，相关标签及独立窗口同步；关闭最后一个相关页面或重启后恢复默认，取消保存保留选择，成功导出只清空对应的旧选择。
- 必要文件自动包含；可选包内、可选外部文件分别列出，默认不选。普通环境规则文件可仅在本次携带，命令、目录和凭据等明确说明不能打包的原因。引用默认精简，批量管理需主动展开。
- 导出清单、数量及实际 ZIP 由同一份核验结果生成；可选文件直接在清单选择，提供“仅必要文件”“全选可用可选文件”和“只看将导出文件”。来源变化或已选文件失效会阻止不完整导出。
- 三种主题增强正文、路径、辅助说明和控件边界对比度；禁用按钮保留可读文字，沿用当前背景、字号和缩放。
- 修复说明页保存滚动位置后的标题节点重建，目录跳转和键盘焦点保持稳定。


- 目录开关、Skill 名称及返回入口自然分列；左侧目录先展开目标，再直接定位并柔和高亮，按当前缩放与吸顶栏计算可见区域。
- 必要／可选清单中同一资源只显示一个文件主条目，引用位置、用途和绑定操作可在原行展开；异常直接显示，批量管理与 ZIP 勾选独立。
- 可证明的自动绑定记录自动修复，结果分别说明记录修复、远端就绪、本地补齐预览和保留差异；不覆盖人工映射或本地内容。

- 工作台与业务标签可同窗口左右并排，分界线可拖动；每侧分别滚动，目录在当前业务页左侧展开。
- 可靠的包内路径、已确认根映射及唯一内容对应自动匹配；仅同名的候选集中列出。GitHub选择在当前文件旁打开并定位。
- “存储与空间”显示真实生效路径，可设置默认下载／导出及高级位置；数据库、恢复材料和界面缓存改址需预览、安全保存后重启。

- 默认紧凑列表，每页20／50／100项；全库多关键词搜索，按来源、状态筛选和名称／状态／最近检查排序。紧凑列表纵向随页面滚动，避免嵌套滚动。
- 自定义平铺分类，每项一个主分类；勾选后从行内内容直接批量拖动，支持归类菜单、撤销和分类拖动排序。分类信息仅存管理数据，不移动原文件。
- 收藏入口独立于分类；列表内支持空格、范围选择及仅本页的键盘多选。分类菜单浮动显示，点击外部或Esc关闭。
- “内容一致”明确比较范围与独立的本地／远端检查时间；纯说明更新检查完成后退出待办，真实差异、必要文件问题和检查异常仍保留，本地额外文件和实际待上传修改分别提示。
- 侧栏可收起、展开和拖宽，支持键盘调宽、双击恢复；缩放与侧栏调整自动保存。
- 行内编辑、预览更新／下载和查看详情；详情、导出及操作页使用独立标签，可随时返回工作台，也保留技能库的完整分栏详情视图。
- 拖动标签排序，拖出为 Windows 独立窗口；原生标题栏拖动窗口、边界调整大小，支持移回主窗口。页面目录可收起，定位当前页的说明标题、必要／可选文件、外部依赖和来源区域。
- 切换标签及窗口转移保留本页滚动、折叠、筛选和未完成绑定草稿；附件选择按同一 Skill 在运行内存中共享；共享同一管理数据与任务服务，结果不会因移窗重新执行。布局恢复只恢复导航，不重放文件或远端写入。
- 分别统计本地、远端、已关联Skill与GitHub仓库；点击来源直达本地文件夹或远端分支目录。
- 后台任务独立显示阶段、时间和结果；可继续浏览、阅读其他 Skill 及管理分类收藏，同一写入资源按顺序处理。后台终结记录在既有数据库保留最近100条，可点击返回对应界面。
- 本页多选检查，按来源复用远端读取；下载、更新和提交仍逐项预览、手动应用。
- 扫描单个 Skill 或父目录，预览后原位登记，按真实路径去重。
- 添加多个 GitHub 仓库或目录；支持标准 `SKILL.md` 和可选 `skill-catalog.json`。
- 阅读有安装记录的历史版本／最新版本说明、相对文档和图片；比较基准不冒充历史安装提交，本地 Skill 可离线管理。
- 本地与GitHub文件合并展示，标明位置、远端独有数量和固定提交；必要／可选组可折叠。运行范围长期保存，本次附件勾选用于导出或单独新增下载，保留未选本地文件。
- 对已核实且双向唯一的本地与远端Skill自动关联、合并重复条目；有歧义时保留独立记录供手动核对。
- Codex／Claude Code／Cursor 紧凑连接列表与独立批量选择页；排除已有有效连接，支持当前筛选全选、清空、范围与键盘选择。自动检查入口，按需记录用户确认的实际使用；统一预览断开，高级操作可忽略连接并保留客户端入口。
- 读取索引及README中的依赖、权限、来源验证与局限；独立展示本地声明和本机调用状态。
- 本地 Skill 首次上传可选择仓库、分支和目录；已关联项上传选定修改，下载前先比较，本地缺少 README 不会删除远端说明。
- 上传预览列出本地精简路径；成功提交并独立核验远端内容后，仅删除本次选中且未再修改的可选文件。必要文件和失败项保留，恢复记录指向固定提交。
- 批量核对运行依赖，区分包内缺项、外部能力、参考来源及不确定项；明确完整项自动确认，完整同范围内容一致才建立当前比较基准。本地或离线检查发现文件变化／读取失败时，旧自动核对证据失效，人工文件范围保留。
- 外部依赖分开显示用途、引用类型、本地与已关联 GitHub 固定提交的可用性和实际采用来源；精确路径自动核对，重名候选明确选择，不按文件名猜测。支持搜索、批量改用途／绑定／重新映射／复核；自身链接和包内文件去重，命令不误报缺失文件。
- ZIP 默认包含必要包内文件及明确必要的普通外部资源；可选包内与可选外部文件默认不选，远端独有文件及选定外部资源直接进入最终 ZIP，不新增本地副本、侧文件或临时目录。默认Skill名.zip。
- Ctrl＋Z或侧栏撤销按钮连续撤销本次运行最近20步分类／收藏操作；输入框保留文字撤销，文件操作和显示设置不进入该历史。
- 冷灰日间、分层石墨灰夜间和较低亮度的暖灰绿护眼外观；Ctrl＋滚轮调整80%–160%整体缩放，Ctrl＋0恢复100%，字号独立；主题、字号与缩放在各窗口共用。

## 使用

v0.3 开发预览可从运行包中的 `app\agent-resource-manager.exe` 或启动脚本打开。本机示例安装位置为 `D:\03_github_projects\Agent_Management\Agent_Resource_Manager`，管理数据在其 `data` 子目录；已有入口继续使用同一份数据。旧正式版 v0.2.11 的程序名为 `skill-manager.exe`。

可通过 `--data-dir <绝对路径>` 或 `SKILL_MANAGER_DATA_DIR` 指定数据目录。全新 v0.3 便携包默认将管理数据保存在包根目录下的 `data`，WebView 缓存保存在 `cache/webview`；已有设置或旧库继续按原路径使用。数据目录保存设置、来源、SQLite 状态及必要恢复材料。

也可在程序旁放置 `data-directory.txt`，写入一行数据目录路径。显式启动参数优先于环境变量；常规启动沿用有效的 `storage-paths.json`，没有该配置时再使用该侧文件或默认位置。相对路径以程序所在目录为起点；无效侧文件会明确失败，不静默创建另一套数据。

1. 在 **Skills** 添加本地目录，可多选后预览勾选；保存为“自动导入目录”后，新建 Skill 自动登记，未选项保持忽略。也可仅登记一次，或添加 GitHub 地址。
2. 用列表或卡片查找和管理技能；搜索覆盖全库，空格分隔的关键词可跨名称、用途、仓库和路径匹配。点击名称或“查看”打开详情标签，随时切回工作台；工具栏“详情”保留原分栏阅读方式。视图、每页数量和排序自动保存。
3. 私有仓库先在 **设置** 保存该仓库的细粒度令牌。读取需要 Contents read，提交需要 Contents read/write；令牌仅存系统凭据管理器。
4. 新下载每次先选择默认或自定义位置，核对完整目标目录与文件范围；导出ZIP同样每次选择。已有Skill更新继续沿用原目录。必要组默认展开，可选组默认收起；两组均可切换，收起不丢勾选。必要入口、依赖和许可证保持勾选，README等说明可按需加入；查看预览后应用。更新与提交同样先预览。
5. 本地 Skill 可在行内点击“编辑”；自动模式检测保存变化，手动模式点击右上角“检查”。添加、刷新及读取文件时默认自动识别管理范围；不需要手动配置才能使用 Skill。特殊情况在“更多 → 调整文件范围”处理，已有手动选择保持；文件页只选择本次 ZIP 的可选内容。编辑器路径可在设置填写，留空时打开所在目录。
6. 在 **设置 → 显示设置** 选择明亮／夜间／护眼模式及字号，预览后保存；界面缩放自动保存，也可随时使用Ctrl＋滚轮或Ctrl＋加／减号。
7. 在侧栏分类区创建分类，将行首拖动柄拖到分类中，或勾选后使用“归入分类”。拖动已勾选项携带本页勾选项，拖动其他项只归类该项；可撤销最近一次归类。
8. 在 **客户端** 切换目标工具，用顶部“连接 Skill”搜索并多选。详情区分客户端入口与真实 Skill 目录；C 盘用户入口可以只是指向 D 盘原件的轻量链接，不代表复制了文件。
9. 长操作可在后台继续，侧栏固定的“操作记录”入口先显示简短摘要，明确查看全部或详情才打开复用标签页，不挤占分类。记录可搜索、筛选、查看结果或回到相关 Skill／客户端；目标已在其他窗口时定位该页。取消只在允许的阶段停止；远端提交等已进入写入的阶段等待完成，不自动重放。
10. 用标签栏“移至独立窗口”或把业务标签拖出窗口；在独立窗口用“移回主窗口”返回。Ctrl＋Tab／Ctrl＋Shift＋Tab切换标签，Ctrl＋W关闭当前业务标签；工作台始终保留。关闭一个窗口仅关闭该窗口。v0.2.11 关闭最后一个窗口或“退出全部窗口”会保存并退出；开发版关闭界面保留后台任务，使用“完全退出管理器”协调保存并停止后台。

“选择本页全部 Skill”和“检查所选”仅作用于当前页的勾选项；筛选或翻页会清空选择，不会批量应用更新。

一个仓库可以包含多个Skill。顶部的“远端Skill”统计条目，“GitHub仓库”按仓库地址去重；本地、远端均包含已关联项。来源中的文件夹入口始终打开真实目录，不受外部编辑器设置影响。操作结果通过侧栏固定入口在独立记录页查看，凭据与详情中的关键反馈仍就地显示。

“创建令牌”打开GitHub的细粒度访问令牌页面，预填名称、30天有效期、资源所有者及读取／写入权限；在GitHub仅选择目标仓库，再生成并粘贴回管理器。访问令牌不是SSH公钥，不填写到SSH／Deploy keys表单。创建页面打不开时，可用旁边的“复制创建链接”；反馈在凭据区就地显示。

详细操作、故障与恢复：[用户指南](docs/USER_GUIDE.md)。

### 在 Codex 中调用

在 Codex 的本地工具配置中，将命令指向实际安装位置的 `app\agent-resource-manager.exe`，参数为 `--mcp`。本机已完成工具发现和登记动作调用；其他电脑按自己的安装位置配置。

管理器需要先运行。后台未运行时，查询只返回不可用，不会自行启动。收到任务编号后，用 `task_get` 读取结果，避免重复提交。执行入口更新后，先在本地界面预览变化并重新核对；目录登记与具体动作验证分别显示。

浏览器操控服务使用官方名称 **Playwright MCP**，Codex 服务名为 `playwright`。本机 Codex 已指向 `D:\03_github_projects\Web_Tools\Playwright-MCP`。管理器内的旧登记待通过「工具 → 重新定位目录…」核对。操作步骤见用户指南，先前使用 Browser_Tools 的记录见更新日志。[用户指南](docs/USER_GUIDE.md) · [迁移记录](CHANGELOG.md#browser-underscore-final-20261112)

## 数据和兼容边界

运行文件可包括 `SKILL.md`、调用配置、必要脚本／参考／资源和许可证；不把本地缺少的远端README当作删除请求。README等说明通常可选；执行时真实引用的文件必须保留。静态依赖识别不能代替动态加载、生成文件和外部依赖的实际运行验证。

自动关联要求两端`SKILL.md`中的真实内部`name`相同且双向唯一；在此前提下，还须满足两端目录标识均与内部名一致，或被核对的运行内容逐字节一致。不使用显示名猜测身份；跳过歧义、托管目录及检查失败的来源。合并保留本地ID、路径、连接和文件；关联成功不代表已经确认安装过某个远端提交。

现有目录不自动迁移，系统／插件托管目录默认只读。首次观测两侧内容不同且无安装历史时显示待核对，不猜测哪侧较新；后续按各侧首次观测区分“本地待上传”“远端待下载”“双方变更”，并列出差异文件。观测记录不冒充安装基准，版本号未知仍明确显示。存在本地运行文件修改时阻止直接覆盖，需先通过现有编辑器核对。

检查与提醒仅在程序运行时生效：由应用共用的调度器在启动时、每30分钟及手动检查核对内容；返回窗口焦点时按15秒节流补查本地，不为每个独立窗口重复启动定时检查。独立任务不再因另一个 Skill 的长操作锁住整个界面；同一 Skill 内容或同一远端分支等冲突操作排队。文件字节变化和Skill版本升级的提示在检查后更新，非实时文件监听。只有已关联且在已核对运行范围内的变化才有GitHub待上传提示；每项写入仍需手动应用。

客户端目录连接成功与真实调用已验证分别说明；本机文件连接不代表云端产品已获得访问。Skill版本提示也不代表已经完成管理器升级、文件下载或提交。

必要外部文件保持原位置，只在导出时进入 ZIP；包外普通资源使用 `external/` 路径，已在包内的资源保留相对路径并去重。原 Skill、共享配置和链接不被改写。能准确转换的静态文本引用仅在 ZIP 内改为相对路径；脚本硬编码、动态加载与共享环境仍明确列为环境要求，不冒充可迁移或实际调用通过。凭据、机器私有配置、整个 CODEX_HOME、维护目录和其他 Skill 不自动打包；最终写包统一复用既有私有资源路径检查，不能通过包内路径或远端映射绕过。必要文件确实缺失时拒绝声称完整导出。

本地与 GitHub 的可用性分别记录：未关联、未读取、失败和确实不存在不是同一状态。同一关联仓库、固定提交内可精确定位的必要文件可直接用于 ZIP；这不表示它已经安装到本地，也不推进安装基准。机器绝对路径与重名文件只给候选，由用户明确绑定。批量管理选择与本次导出勾选独立；可选项默认不选，成功导出后清除本次选择。导出只新增所选 ZIP；管理器仍按正常流程保存独立 SQLite 管理状态，不生成另一份 Skill 或导出侧文件。

GitHub 未登录访问受公开请求额度限制；达到限制时保留原文件与状态并显示检查失败，可稍后重试或配置仓库令牌。默认只监视添加URL对应的目录，重新添加URL可以扩大范围。

正式v0.2.11支持Windows，不含内置编辑器、依赖／模型自动安装、MCP服务和跨设备同步。当前v0.3开发版已增加本地MCP及受管工具安装／更新；未登记的Skill依赖或模型不会自动安装。程序升级与Skill更新分开处理。

## 开发

需要 Node.js 24、pnpm 11、Rust stable，以及 Windows MSVC/SDK 和 WebView2。依赖版本由两份锁文件固定。

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm test:ui
cd src-tauri
cargo test --locked
cargo build --release --locked --features custom-protocol
```

`scripts/build.ps1` 支持 Check、Test、Build、Package、Dev；Package 生成 NSIS 安装包。可用 `-DependencyRoot <目录>` 配置单独保存的构建环境。桌面开发入口为 `pnpm tauri dev`。测试只使用合成目录，禁止以用户真实 Skill 或仓库进行破坏性验证。

## 来源与发布

方法参考 [Skillshare](https://github.com/runkids/skillshare) 的单份来源和链接部署、[Skills Manager](https://github.com/xingkongliang/skills-manager) 的列表／详情组织；应用代码独立实现。实际采用范围及构建依赖见 [来源记录](docs/SOURCES.md)。

公开发布前应核对测试结果、兼容范围、项目许可证、依赖许可、候选版本和附件，并取得具体发布确认。本仓库 CI 仅检查，不创建 Release 或标签。

v0.2.2通过294项Rust测试、56项Node测试、TypeScript／Vite、格式与Clippy检查，Windows优化版和NSIS安装包构建通过；25组原生界面／流程验证通过。 目录验收核对真实标题位置及焦点，19组实际管理器界面与6组明确受控来源呈现分开取证；原件与已保存设置保持。

历史验证：v0.2.1通过289项Rust测试、42项Node测试、TypeScript／Vite、格式与Clippy检查，Windows优化版和NSIS安装包构建通过；34组原生界面／流程验证通过。 分阶段绑定实际构建摘要：滚动与转窗、真实迁移／失败恢复、受控GitHub界面和真实协议分别取证。实际16Skill只读核对保留1项真实定制差异，129个源文件未变。未新增依赖下载；安装模板的最小改编与许可见[来源记录](docs/SOURCES.md)。

历史验证：v0.2.0通过265项Rust测试、33项Node测试、TypeScript／Vite、格式与Clippy检查，Windows优化版和NSIS安装包构建通过；33组原生界面／流程验证通过。 分阶段构建对应的验证证据随本地交付保存。另在隔离管理状态中只读核对现有16个Skill：必要包结构均通过，14项远端范围一致、1项纯本地、1项保留真实差异，129个原文件未变。历史安装未知保持未知。本版未新增依赖或改编第三方项目代码，公开发布仍需具体确认。

历史验证：v0.1.9通过240项Rust测试、25项Node测试、TypeScript／Vite、格式与Clippy检查，Windows优化版和NSIS安装包构建通过；58组原生界面／流程验证通过。分阶段证据及真实后端与受控界面响应的区别见本地evidence；没有写入真实私人GitHub仓库。 原生保存对话框视觉、安装向导、真实私有仓库写入、客户端模型调用、其他电脑和实际 VPN 路由未验证。受控 IPC 延迟／失败响应只证明界面处理；线程并发、网络协议及 ZIP 字节另由后端测试证明。读取可协作取消，但当前阻塞请求需返回；关键写入不强行中断。强制终止或断电不能保证尚未提交的界面调整保存。

私有仓库读取、远端文件分组和自动关联已验证；真实私有仓库提交及三个客户端的模型实际调用仍未验证。测试没有修改用户Skill或远端仓库。既有验证历史保留在更新日志中。完整依赖告知随程序分发：[THIRD_PARTY_NOTICES](docs/THIRD_PARTY_NOTICES.txt)。

v0.2.3通过313项Rust测试、62项Node测试、TypeScript／Vite、格式与Clippy检查，Windows优化版和NSIS安装包构建通过；22组原生界面／流程验证通过。 原生导出使用真实业务接口和实际ZIP；保存对话框返回值被替代，延迟用例仅延迟真实回复。三主题核对实际计算颜色及明确标记的缺省状态样例；固定GitHub提交和远端独有改写字节由回环协议测试证明。未验证安装向导、原生保存对话框视觉、真实私库写入、模型调用、其他电脑及实际VPN路径。

## 历史候选 v0.2.9（已并入 v0.2.10）

- 窗口右上角统一“检查／自动或手动”。自动模式使用本地事件和每分钟 GitHub 提交探测；手动模式关闭后台扫描，点击检查只执行一次。
- 多选本地目录，预览登记并记住未选项；自动导入目录支持改名、暂停、移除与批量恢复忽略项。Skill 留在原目录。
- 关联和比较使用同一来源快照；外部上传可被发现，可靠对应才自动关联，歧义保留选择。变化页提供检查摘要和批量重试。
- 修复中文连续句子的模板路径误识别、已绑定仍显示缺失及旧审计缓存；不改变 Skill 原文或伪造调用成功。
- 缓存内容先显示，检查在后台排队；仅对变化范围重新核对。必要／可选／外部／GitHub 独有 ZIP 行为保持。

该候选当时的[Windows 云端检查](https://github.com/Zerozero05/Agent_Resource_Manager/actions/runs/40234426260)已通过：171项前端测试、382项Rust测试（含单次检查空选择字段的入口回归）及构建／静态检查，候选14个文件摘要核对通过。对应源码为 `182c92afe43cc1663a7cb815ad76dd98c7a50283`。最终本机复验确认手动检查不再报错且保持手动，不完整Skill不会导入、补完整后约914 ms自动导入，引用页无原误报；EXE已原位部署，真实17个Skill／139个文件／16个链接及既有资料核对保持。缓存说明129 ms、文件128 ms是单次同机观测，不能代表网络首次读取；真实私库写入与三个客户端实际调用尚未验证。此候选未单独发行，现已并入 v0.2.10。

## 前一候选 v0.2.8

- 选择草稿初始化与事件监听独立，失败后自动恢复；文件页和导出页共用恢复入口，不丢失已选文件。
- 客户端切换与搜索使用统一吸顶头部，入口信息按需展开，标签仅溢出时显示横向滚动条。
- 便携版解压后直接运行同目录的 `skill-manager.exe`；`data-directory.txt` 的 `.` 表示使用程序所在目录中的管理数据，升级时保留原数据及路径配置。
- Windows 云端检查通过后生成候选附件及摘要；真实原生界面验收另行记录。验证状态以对应提交、构建结果及本次候选记录为准。

## 已公开版本 v0.2.7

- 快捷键帮助改为独立浮层，按当前列表／卡片显示真实按键，在所属窗格和视口内翻转、限高与滚动；保留键盘、外点和焦点操作。
- 分类使用八色实心标签，增强文字、色面与背景区别，去掉标签内重复圆点；现有分类、颜色身份与连续撤销保持。
- 夜间参照用户GPT截图采用炭黑／石墨灰，明亮使用浅灰／白色，护眼使用低亮度暖灰米色；正文、辅助文字、控件及原生标题栏分别适配。
- 工作台统一紧凑标题、统计和工具栏，省去重复分类、空用途、未知版本和零连接占位；标签栏预留细横滚槽，任务徽标不再挤压主区；真实内容、搜索筛选和全部操作保留。
- 详情、导出、变化、客户端、设置和操作记录减少重复说明，普通解释按需展开；关键警告、完整路径、真实来源、文件范围与失败恢复保留。
- 保持既有本地／GitHub操作、ZIP必要／可选选择、多标签／分屏、目录跳转、默认／自定义目标、设置与缓存；管理操作保存完成后才启用撤销，避免提前按键无效；不新增依赖或数据迁移。
- 首次公开发行：使用独立公开仓库管理源码和版本，补充下载、许可及校验说明；正式源码排除构建缓存和私有运行资料，程序版本与行为保持不变。

v0.2.7通过351项Rust测试、136项Node测试、TypeScript／Vite、格式与Clippy检查，Windows优化版和NSIS安装包构建通过；93组原生界面／流程验证通过。

同机100个合成Skill、20轮本地切换：首屏检测上界708→612毫秒（含测试工具连接）；说明p50为16.91毫秒，p95为36.47→37.63毫秒；文件页p50为13.36毫秒，p95为48.25→61.98毫秒。按实测增减保留全部数值，不宣称所有指标改善；说明与文件读取各2次，不随20轮切换增长。一次本地样本不代表真实GitHub、VPN、模型或其他电脑的速度。

保留原44项验收门槛并明确新增6项，共50项；三主题、大字号／缩放、640窄窗、320分栏、真实滚轮末项、目录目标与高亮、稳定折叠、摘要复用及默认／自定义选择均在同一最终程序核对。快捷键零业务请求、边缘翻转与键盘滚动，实心分类文字、色面、悬停／选中／拖动以及原生标题栏分别留证。132个构建／测试输入绑定成功日志及debug、优化版和NSIS字节；原生证据明确区分真实业务、受控呈现和系统对话框边界。原16个Skill、129个文件、5分类及成员、收藏、16个客户端入口和全部已保存设置独立读回。

未验证安装向导、系统保存对话框视觉、真实私库写入、模型实际调用、真实GitHub／VPN速度及其他电脑。云端 CI 结果以 [Windows checks 的实际运行](https://github.com/Zerozero05/Agent_Resource_Manager/actions/workflows/check.yml) 为准，不与上述本机验证混用。

## 更新记录

| 版本 | 日期 | 主要变更 |
| --- | --- | --- |
| 后台任务内存（开发中） | 2026-11-27 | 1、连续检查大量 Skill 时，压缩结果写入任务历史后释放缓冲区预留空间。[详情](CHANGELOG.md#completed-task-buffer-20261127) |
| Skill 客户端与工具目录（开发中） | 2026-11-27 | 1、按客户端显示并定位 Skill 入口。[详情](CHANGELOG.md#cc-switch-client-results-and-tool-paths-20261127)<br>2、回执区分成功、失败和待核对，重试限于当前可用的失败项。[详情](CHANGELOG.md#cc-switch-client-results-and-tool-paths-20261127)<br>3、工具列表显示原目录，区分管理入口和能力验证。[详情](CHANGELOG.md#cc-switch-client-results-and-tool-paths-20261127) |
| 窄窗设置分类（开发中） | 2026-11-27 | 1、目录固定在按钮下方，保持表单位置。[详情](CHANGELOG.md#ios27-settings-navigation-20261127)<br>2、保留键盘焦点、轻动效及高对比选中轮廓。[详情](CHANGELOG.md#ios27-settings-navigation-20261127) |
| 浮层与 Skill 阅读（开发中） | 2026-11-25 | 1、统一工作区快捷键、对话框和分段控件的视觉层次。[详情](CHANGELOG.md#ios27-panels-and-skill-reading-20261125)<br>2、Skill 原始元数据可按需展开，正文和目录独立显示。[详情](CHANGELOG.md#ios27-panels-and-skill-reading-20261125) |
| Skill 详情打开（开发中） | 2026-11-25 | 1、本窗口新建详情省去读取空草稿的一次往返。[详情](CHANGELOG.md#fresh-detail-runtime-20261125)<br>2、保留草稿恢复、聚焦与跨窗口转移。[详情](CHANGELOG.md#fresh-detail-runtime-20261125) |
| 后台检查摘要保存（开发中） | 2026-11-25 | 1、仅摘要变更时省去重复合并及复制技能库。[详情](CHANGELOG.md#check-summary-write-20261125)<br>2、保留保存时机、修订及失败处理。[详情](CHANGELOG.md#check-summary-write-20261125) |
| 操作菜单与快捷键（开发中） | 2026-11-25 | 1、统一菜单和快捷键浮层样式，限制极窄窗口下的菜单宽度。[详情](CHANGELOG.md#ios27-anchored-controls-20261125)<br>2、改善展开反馈，淡入遵循动效及对比偏好。[详情](CHANGELOG.md#ios27-anchored-controls-20261125) |
| 本地检查与任务结果（开发中） | 2026-11-25 | 1、无仓库来源时复用成功读取的本地文件清单。[详情](CHANGELOG.md#check-inventory-and-result-memory-20261125)<br>2、生成完整检查结果前释放已用完的后台状态副本。[详情](CHANGELOG.md#check-inventory-and-result-memory-20261125) |
| 自动检查的调度开销（开发中） | 2026-11-24 | 1、在 Skill 自动监视未生效时省去路径清单的定时组装。[详情](CHANGELOG.md#automatic-watch-projection-20261124)<br>2、保留独立的工具版本检查和监视恢复。[详情](CHANGELOG.md#automatic-watch-projection-20261124) |
| 桌面材质与操作反馈（开发中） | 2026-11-24 | 1、调整工具栏、浮层与内容的材质和圆角层次。[详情](CHANGELOG.md#ios27-desktop-material-20261124)<br>2、增加短促且可关闭的操作反馈，保留键盘焦点与高对比显示。[详情](CHANGELOG.md#ios27-desktop-material-20261124) |
| 总览与设置导航（开发中） | 2026-11-24 | 1、整理总览统计与响应式阅读顺序，保留原功能入口。[详情](CHANGELOG.md#desktop-design-refresh-20261124)<br>2、按用途整理设置目录，统一快捷搜索与页面定位，直接进入 GitHub 来源。[详情](CHANGELOG.md#desktop-design-refresh-20261124) |
| Skill 状态保存（开发中） | 2026-11-22 | 1、将当前状态直接写成所需的 JSON，减少全量检查保存时的临时数据。[详情](CHANGELOG.md#stream-skill-state-20261122) |
| 后台检查结果（开发中） | 2026-11-22 | 1、后台 Skill 检查合并完成后只读取一次最新目录，完整结果和完成戳可照常读取。[详情](CHANGELOG.md#check-result-snapshot-20261122) |
| 技能库搜索（开发中） | 2026-11-21 | 1、列表和状态数量共用搜索、来源及分类筛选结果。[详情](CHANGELOG.md#shared-library-filter-20261121) |
| 工具维护状态读取（开发中） | 2026-11-21 | 1、自动维护和工具版本检查直接读取实时暂停状态，省去整库快照。[详情](CHANGELOG.md#live-maintenance-check-20261121) |
| 全局检查的界面同步（开发中） | 2026-11-21 | 1、工具栏只读取任务状态和完成版本，复用已同步的库状态。2、通知未送达时重新读取，操作记录仍可查看完整结果。[详情](CHANGELOG.md#global-check-completion-20261121) |
| 后台检查与窗口导航（开发中） | 2026-11-21 | 1、全局检查复用回滚记录生成摘要。2、窗口跳过内容相同的导航回执，保留同修订号下的转移变化。[详情](CHANGELOG.md#check-summary-and-navigation-20261121) |
| 后台检查的目录和关联（开发中） | 2026-11-21 | 1、无新目录或待关联工作时跳过多余的本地文件读取。[详情](CHANGELOG.md#skip-unused-check-discovery-20261121) |
| 后台任务合并库状态（开发中） | 2026-11-21 | 1、减少保存任务结果时的库状态和记录复制，保留原有冲突与失败处理。[详情](CHANGELOG.md#background-state-merge-20261121) |
| 操作记录保存（开发中） | 2026-11-21 | 1、保存进度时复用已提交且未变动的历史记录，保留原有记录范围和失败处理。[详情](CHANGELOG.md#durable-task-history-20261121) |
| 检查任务的历史内存（开发中） | 2026-11-21 | 1、已完成的检查任务共享内容和顺序完全一致的调度键，减少重复分配并保留历史数据。[详情](CHANGELOG.md#check-task-key-sharing-20261121) |
| 本地说明读取（开发中） | 2026-11-21 | 1、本地说明读取仅复制当前 Skill 的记录，减少锁内工作。[详情](CHANGELOG.md#local-document-worker-20261121) |
| Skill 详情首屏导航（开发中） | 2026-11-21 | 1、说明、文件和来源页签置顶，别名、依赖和空间明细集中到“来源与连接”。[详情](CHANGELOG.md#skill-detail-first-screen-20261121) |
| 说明目录的动效设置（开发中） | 2026-11-21 | 1、说明目录的定位高亮遵循全局动效选择。[详情](CHANGELOG.md#outline-highlight-motion-20261121) |
| 小窗口搜索结果可见性（开发候选） | 2026-11-21 | 1、直接输入搜索词时让视口下方的首条结果进入视野，并保留输入焦点。[详情](CHANGELOG.md#reveal-skill-search-result-20261121) |
| 技能库状态与任务结果（开发候选） | 2026-11-21 | 1、减少状态下拉框的重复排序和计数。[详情](CHANGELOG.md#library-status-and-task-results-20261121)<br>2、普通任务直接使用最新库状态字段，省去重复复制。[详情](CHANGELOG.md#library-status-and-task-results-20261121) |
| 说明渲染与技能库筛选（开发候选） | 2026-11-19 | 1、内容未变时保留已读说明及焦点，手动刷新仍重新读取图片。[详情](CHANGELOG.md#document-render-allocation-20261119)<br>2、空关键词不再构造搜索文本。[详情](CHANGELOG.md#document-render-allocation-20261119) |
| 工作台按需统计（开发候选） | 2026-11-19 | 1、独立说明等标签页不再计算工作台的分类和汇总。[详情](CHANGELOG.md#workbench-only-summary-20261119) |
| Windows 工作流运行环境 | 2026-11-19 | 1、固定支持 Node 24 的检出和 Node 安装组件。[详情](CHANGELOG.md#github-actions-node24-20261119) |
| 启动与数据路径说明 | 2026-11-19 | 1、明确新版启动程序、全新便携包的存储布局及旧库兼容规则。[详情](CHANGELOG.md#startup-guide-paths-20261119) |
| 后台检查与任务历史的内存开销（开发候选） | 2026-11-19 | 1、后台检查省去中间技能库快照。[详情](CHANGELOG.md#background-check-allocation-20261119)<br>2、保存任务历史时直接读取现有资源键，继续兼容原记录格式。[详情](CHANGELOG.md#background-check-allocation-20261119) |
| 说明页与更新准备（开发候选） | 2026-11-19 | 1、打开独立说明页时按需读取导出选择，已开始的选择可继续使用。[详情](CHANGELOG.md#document-export-and-update-preparation-20261119)<br>2、计算候选更新所需空间时，复用已选文件的成员索引。[详情](CHANGELOG.md#document-export-and-update-preparation-20261119) |
| Skill 说明打开速度（开发候选） | 2026-11-18 | 1、读取说明时减少重复状态复制和无关预览处理。[详情](CHANGELOG.md#skill-document-opening-20261118)<br>2、技能排序和快捷入口按需计算。[详情](CHANGELOG.md#skill-document-opening-20261118) |
| 资源搜索焦点（开发候选） | 2026-11-18 | 1、全部资源与工具搜索框聚焦时只显示一圈清晰轮廓。[详情](CHANGELOG.md#resource-search-focus-20261118) |
| 云端安装验收（开发流程） | 2026-11-18 | 1、可在 GitHub 托管的 Windows 虚拟机验收 v0.2.11 到指定候选的静默安装、升级及卸载，仅上传验收报告。[详情](CHANGELOG.md#hosted-installer-validation-20261118)<br>2、卸载验收在原有时限内等待程序文件、登记和快捷方式全部移除。[详情](CHANGELOG.md#hosted-installer-validation-20261118)<br>3、增加云端图形安装向导验收脚本，核对默认目录、可选路径、安装登记和快捷方式。[详情](CHANGELOG.md#hosted-installer-validation-20261118)<br>4、可核对无参数首次启动、实际数据和缓存路径，以及从界面完全退出。[详情](CHANGELOG.md#hosted-installer-validation-20261118) |
| 验收目录与浏览器入口（开发候选） | 2026-11-18 | 1、同步搬迁后的验收脚本路径。[详情](CHANGELOG.md#renamed-qa-paths-edge-20261118)<br>2、已备好新版的隔离视觉数据，主题对比检查通过。[详情](CHANGELOG.md#renamed-qa-paths-edge-20261118)<br>3、Codex 实测 Edge 连接可读，分别记录管理器重定位状态。[详情](CHANGELOG.md#renamed-qa-paths-edge-20261118)<br>4、支持单独核对验收程序与通信程序的摘要。[详情](CHANGELOG.md#renamed-qa-paths-edge-20261118) |
| 标签页草稿恢复（开发候选） | 2026-11-18 | 1、多个标签页恢复时，草稿读取失败后可继续重试，修复部分标签一直停在恢复中的问题。[详情](CHANGELOG.md#workspace-draft-restore-retry-20261118)<br>2、同版便携包和安装包完成离线内容核对。[详情](CHANGELOG.md#workspace-draft-restore-retry-20261118) |
| 标签名称与负载验收（开发候选） | 2026-11-18 | 1、恢复的 Skill 标签显示当前名称而保留原页和阅读位置。[详情](CHANGELOG.md#skill-tab-title-and-mixed-load-evidence-20261118)<br>2、混合负载区分独立时延样本和快速检查，保留原时限。[详情](CHANGELOG.md#skill-tab-title-and-mixed-load-evidence-20261118)<br>3、同一新版安装包和便携包离线核对，图像及动效完成新版预检。[详情](CHANGELOG.md#skill-tab-title-and-mixed-load-evidence-20261118)<br>4、本地检查具备串行统计取样入口，原生验收仍待运行。[详情](CHANGELOG.md#skill-tab-title-and-mixed-load-evidence-20261118)<br>5、补齐下载与更新取样入口；本机已切到同一版本，Agent Reach 登记已重新定位。[详情](CHANGELOG.md#skill-tab-title-and-mixed-load-evidence-20261118)<br>6、三类负载可分段取样并离线核对。[详情](CHANGELOG.md#skill-tab-title-and-mixed-load-evidence-20261118) |
| 首次安装目录与隔离验收（开发候选） | 2026-11-18 | 1、将默认目录同步到 Agent_Management，保留自定义安装及既有升级位置。[详情](CHANGELOG.md#installer-default-path-20261118)<br>2、离线核对安装包、便携包及指定提交源码包，未执行安装或公开发行。[详情](CHANGELOG.md#installer-default-path-20261118)<br>3、对齐图像和窗口验收目录，20 项直接检查通过；原生图像验收尚未运行。[详情](CHANGELOG.md#installer-default-path-20261118)<br>4、对照空闲与真实更新准备期间的说明后端读取，原生界面的结论不变。[详情](CHANGELOG.md#installer-default-path-20261118) |
| 工具用途归类（路径维护） | 2026-11-17 | 1、同步本机网页、桌面自动化及启动动画的三处原生验收路径；保留并行开发成果、管理记录和动作授权，不改程序版本。[详情](CHANGELOG.md#purpose-classification-paths-20261117) |
| 工具目录修复（开发候选） | 2026-11-17 | 1、三类既有工具预览并修复目录。[详情](CHANGELOG.md#tool-directory-relocation-20261117)<br>2、保留记录、策略及历史，重核新位置证据。[详情](CHANGELOG.md#tool-directory-relocation-20261117)<br>3、修正HTTP测试连接模式，原断言通过。[详情](CHANGELOG.md#tool-directory-relocation-20261117)<br>4、记录文档P95与后台样本边界。[详情](CHANGELOG.md#tool-directory-relocation-20261117)<br>5、保留内存收敛未通过的结论。[详情](CHANGELOG.md#tool-directory-relocation-20261117)<br>6、修复显示名与模板路径兼容问题。[详情](CHANGELOG.md#tool-directory-relocation-20261117)<br>7、完成直接回归与短时进程诊断。[详情](CHANGELOG.md#tool-directory-relocation-20261117)<br>8、明确预览Playwright参数路径与共享Node校验变化。[详情](CHANGELOG.md#tool-directory-relocation-20261117)<br>9、新候选通过代表性目录修复原生闭环。[详情](CHANGELOG.md#tool-directory-relocation-20261117) |
| 本机目录整理（说明及路径维护） | 2026-11-16 | 1、本机部署迁入Agent_Management，原目录入口按用户要求退役；同步本地配置及验收脚本中的精确路径，不改保护范围或程序版本。[本次完整记录](CHANGELOG.md#local-project-paths-20261116)<br>2、补齐本轮原生验收的输出、资源与通信程序路径；119项直接边界检查通过，历史构建和验收记录保持原身份，不重编程序。[详情](CHANGELOG.md#local-project-paths-20261116) |
| 下载限速数值范围（开发候选） | 2026-11-15 | 1、下载数字框声明现有1024 MiB/s上界，与后台规则一致，修复原生无障碍接口将无上限控件报告为0–0的问题。[详情](CHANGELOG.md#download-rate-native-range-20261115)<br>2、保留小数速率和0表示不限速；17项直接相关行为检查及类型、生产构建通过，原生限速与固定文件下载已验证，完整负载继续验收。[详情](CHANGELOG.md#download-rate-native-range-20261115)<br>3、更新验收助手按候选表单精确定位同名输入，44项直接检查通过；不改变产品逻辑或性能标准。[详情](CHANGELOG.md#download-rate-native-range-20261115) |
| Skill改名接续与管理记录移除（开发候选） | 2026-11-13 | 1、从详情“更多”或列表单选移除管理记录，保留源文件、GitHub内容和客户端实体入口。[详情](CHANGELOG.md#skill-record-relocation-20261113)<br>2、已记录的同一目录改名后自动接续；历史重复记录可先预览再重新定位，保留原ID、分类、收藏和关联。[详情](CHANGELOG.md#skill-record-relocation-20261113)<br>3、按文件刷新内部名，保留自定义显示名和已知来源版本；导出读取不改变声明记录。同名不猜合并，冲突与既有引用保留核对。[详情](CHANGELOG.md#skill-record-relocation-20261113) |
| GitHub说明按路径读取（内部验证） | 2026-11-13 | 1、说明与图片仅按固定提交读取沿途目录及目标文件，完整包清单另行保留。[详情](CHANGELOG.md#documentation-path-read-20261113)<br>2、保留优先级、回退、安装来源和文件校验，修复可选catalog及说明候选经过链接／子模块祖先时的误阻断。[详情](CHANGELOG.md#documentation-path-read-20261113)<br>3、累计新增10项检查，最终文档12项、凭据边界1项及相关静态检查通过；真实新版延迟和内存收敛待验。[详情](CHANGELOG.md#documentation-path-read-20261113) |
| 候选自检与进程测试夹具 | 2026-11-12 | 1、超时检查使用小型真实原生程序，保留原5秒整体上限、完整摘要和150毫秒超时清理。[详情](CHANGELOG.md#probe-timeout-fixture-20261112)<br>2、停止／退出前再启动无关测试进程，保留其存活断言并按自有句柄清理。[详情](CHANGELOG.md#probe-timeout-fixture-20261112)<br>3、17项候选自检及两项相关精确检查、格式和全目标Clippy通过；生产逻辑未变，完整云端结果另核对。[详情](CHANGELOG.md#probe-timeout-fixture-20261112) |
| 工具启动准备与并发读取（内部验证） | 2026-11-12 | 1、大文件核验和环境准备移出共享锁，启动前仍原子核对最新登记、动作、取消、场景及依赖。[详情](CHANGELOG.md#resource-spawn-preparation-20261112)<br>2、非可取消任务使用启动／释放握手；MCP准备与协议阶段分别记录，保留原取消、退出及结果证据检查。[详情](CHANGELOG.md#resource-spawn-preparation-20261112)<br>3、56项不同的相关Rust检查、格式及全目标Clippy零警告通过；新候选、完整Windows检查与原生性能仍待验证。[详情](CHANGELOG.md#resource-spawn-preparation-20261112) |
| 开发源码同步与检查修复 | 2026-11-12 | 1、405项源码同步到开发分支并逐一核对远端文件内容及模式，正式分支保持。[详情](CHANGELOG.md#source-ci-exit-20261112)<br>2、修正预期拒绝案例遗留的脚本退出状态；原12项断言和真实负向失败验证通过。[详情](CHANGELOG.md#source-ci-exit-20261112)<br>3、修正测试模块的样式导入处理，保留真实组件和生产样式，16项相关检查通过；云端完整检查继续单独核验。[详情](CHANGELOG.md#source-ci-exit-20261112) |
| 任务进度与原生控件（内部验证） | 2026-11-12 | 1、进度通知直接推进任务，仅无通知700ms时补查，保留完整终态结果；45项相关任务及组件检查通过。[详情](CHANGELOG.md#task-events-native-controls-20261112)<br>2、验收助手使用单次原生激活、数值控件优先严格RangeValue接口；75项边界检查及离线编译通过，原生效果待验。[详情](CHANGELOG.md#task-events-native-controls-20261112) |
| 说明读取与中文输入（内部审阅） | 2026-11-12 | 1、读取说明时不复制无关更新预览，其他动作保持完整校验；2项专项和8项直接回归通过。[详情](CHANGELOG.md#document-preview-copy-20261112)<br>2、6c候选文档100次实测P95为148.2598ms，达到原200ms目标；一次1061.8325ms慢样本及附加最大延迟失败保留。[详情](CHANGELOG.md#document-preview-native-20261112)<br>3、真实拼音输入转换及正常退出恢复通过；安装／便携包完成离线内容核对，持续运行与其余原生范围分别记录。[详情](CHANGELOG.md#document-preview-native-20261112) |
| 大清单原生更新与离线包（内部审阅） | 2026-11-12 | 1、4098项实际预览和候选准备完成，原运行文件保持。[详情](CHANGELOG.md#native-update-6a-20261112)<br>2、保留首次说明436.6527ms原目标失败及6样本范围，游戏输入服务已恢复。[详情](CHANGELOG.md#native-update-6a-20261112)<br>3、6a两包离线解包及当前正式数据核对完成，未公开发行。[详情](CHANGELOG.md#native-update-6a-20261112) |
| 浏览器目录与入口收尾（文档同步，未发布） | 2026-11-12 | 1、精确移除旧BrowserTools兼容联接，保留Browser_Tools实体。[本次完整记录](CHANGELOG.md#browser-underscore-final-20261112)<br>2、共享Node更新后通过真实界面重新核对同路径摘要，4个动作及新根路径保持。[本次完整记录](CHANGELOG.md#browser-underscore-final-20261112)<br>3、同ID revision8登记CLI版本实际通过并保存能力证据，页面和登录按任务另验。[本次完整记录](CHANGELOG.md#browser-underscore-final-20261112)<br>4、同步当前说明并保留各历史阶段，不升版本或公开发行。[本次完整记录](CHANGELOG.md#browser-underscore-final-20261112) |
| 更新大清单分页与验收收尾 | 2026-11-12 | 1、更新包选择、预览和差异每页50项，保留全部文件、选择、用途和确认绑定。[详情](CHANGELOG.md#update-inventory-20261112)<br>2、修复验收管道结束后重复写入，保留原超时原因和所有保护。[详情](CHANGELOG.md#update-inventory-20261112)<br>3、82项相关组件、73项传输及4项参数检查通过，6a候选构建和协议核对完成，原生续验待进行。[详情](CHANGELOG.md#update-inventory-20261112)<br>4、保留65版400次本地实测通过及未完成负载证据，真实数据核对一致并恢复程序。[详情](CHANGELOG.md#update-inventory-20261112) |
| Browser_Tools命名与路径适配 | 2026-11-12 | 1、实体采用确认的Browser_Tools名称，配置及现行路径引用同步。[详情](CHANGELOG.md#browser-underscore-20261112)<br>2、52项启动文件适配及独立读回完成，4项CLI检查通过。[详情](CHANGELOG.md#browser-underscore-20261112)<br>3、只修正迁移引入的四个参数拼写，原授权及17张其他表保持。[详情](CHANGELOG.md#browser-underscore-20261112)<br>4、正式后台恢复，管理器登记版本调用成功，旧入口按实际租约暂留。[详情](CHANGELOG.md#browser-underscore-20261112) |
| IME与外观验收脚本适配 | 2026-11-12 | 1、IME支持显式Shift／Ctrl准备选择，保留身份、输入和恢复守卫；37项脚本回归、编译与独立审阅通过。[详情](CHANGELOG.md#native-ime-appearance-followup-20261112)<br>2、外观保存及重开分别使用候选与通信文件摘要，2项直接CLI检查通过。[详情](CHANGELOG.md#native-ime-appearance-followup-20261112)<br>3、Ctrl实际尝试在启动前停止，无实例或按键；桌面`USER_CONTROL`后不继续前台，真实IME仍未验证。[详情](CHANGELOG.md#native-ime-appearance-followup-20261112)<br>4、正式65恢复后台就绪；保留五类缺口，源码材料仅供内部审阅，未提交最终源码或公开发行。[详情](CHANGELOG.md#native-ime-appearance-followup-20261112) |
| 原生重启与明确续传专项 | 2026-11-12 | 1、测试runner分别核对65测量候选与f9通信文件摘要，保留原启动和输入守卫。[详情](CHANGELOG.md#native-download-resume-20261112)<br>2、实际下载部分内容后正常退出、重开并明确续传，原ID、已有前缀、最终上游摘要及ZIP清单核对通过。[详情](CHANGELOG.md#native-download-resume-20261112)<br>3、只聚焦31次采样无输入计时变化；因原已在前台，不能类推Q6异常已修复。[详情](CHANGELOG.md#native-download-resume-20261112)<br>4、关闭续传界面链路这一验收缺口，剩五类事项；未发布或宣称完整性能通过。[详情](CHANGELOG.md#native-download-resume-20261112) |
| 历史写入、维护时钟与动效 | 2026-11-11 | 1、历史快照只实际写入变化行，保留原事务、活跃进度和失败恢复。[详情](CHANGELOG.md#history-clock-followup-20261111)<br>2、维护提示检测独立系统时间／时区变化，隐藏窗口停止探测。[详情](CHANGELOG.md#history-clock-followup-20261111)<br>3、修正显式轻动效被旧规则覆盖，默认系统减少动效保持。[详情](CHANGELOG.md#history-clock-followup-20261111)<br>4、40项历史、49项界面逻辑、61项输入守卫、静态及构建检查通过；根程序更新为65候选、原数据保持，原生与长期验收仍未完成。[详情](CHANGELOG.md#history-clock-followup-20261111) |
| 短流程与内存诊断 | 2026-11-11 | 1、精准区分已核验的Codex通信进程，保留未知进程、窗口与输入保护。[详情](CHANGELOG.md#native-short-followup-20261111)<br>2、补齐单次下载退出、重开及明确续传的专项入口；聚焦后输入变化导致停止，不宣称流程通过。[详情](CHANGELOG.md#native-short-followup-20261111)<br>3、增加无内容、无路径的任务留存字节统计，原缓存字段及只读协议保持。[详情](CHANGELOG.md#native-short-followup-20261111)<br>4、27项守卫、29项功能输入检查、10项相关脚本和4项后端检查分别通过；d4构建、41工具协议及130次受控诊断完成，长期性能仍待验证。[详情](CHANGELOG.md#native-short-followup-20261111) |
| 浏览器工具正式名称 | 2026-11-11 | 1、恢复Playwright MCP／playwright，支持按任务自动调用。[详情](CHANGELOG.md#browser-tool-naming-20261111)<br>2、同步产品名称并通过75项定向检查及构建、协议和离线包核对。[详情](CHANGELOG.md#browser-tool-naming-20261111)<br>3、保留原ID、动作和授权，目录迁移事务保持17张其他表。[详情](CHANGELOG.md#browser-tool-naming-20261111)<br>4、正式后台正常重开为f9dfe387，界面入口核对已保存，真实登记动作调用成功。[详情](CHANGELOG.md#browser-tool-naming-20261111)<br>5、实际改名BrowserTools，同步52项Python启动文件、配置和当前引用，移除已无占用的旧兼容入口。[详情](CHANGELOG.md#browser-tool-naming-20261111) |
| Codex 本机调用接入 | 2026-11-11 | 1、登记正式程序的本机MCP入口并保留其他配置。[详情](CHANGELOG.md#codex-local-integration-20261111)<br>2、真实宿主目录读取及Agent Reach版本查询成功。[详情](CHANGELOG.md#codex-local-integration-20261111)<br>3、增加同一Node入口的预览与显式重核，19项后端及72项相关界面检查通过。[详情](CHANGELOG.md#codex-local-integration-20261111)<br>4、启用179b9d3f并核对新data目录，离线发行包已准备，界面重核待完成。[详情](CHANGELOG.md#codex-local-integration-20261111)<br>5、将浏览器服务恢复为Playwright MCP／playwright，保留原文件位置。[详情](CHANGELOG.md#codex-local-integration-20261111) |
| 正式数据切换与工具接管 | 2026-11-11 | 1、按绑定清单完成10项目录与数据库族迁移，20表数据逻辑核对一致。[详情](CHANGELOG.md#formal-data-cutover-20261111)<br>2、完成新入口真实重开、实际管理数据及界面缓存路径核对。[详情](CHANGELOG.md#formal-data-cutover-20261111)<br>3、保留20个Skill和18条客户端连接，三个既有工具原位登记完成。[详情](CHANGELOG.md#formal-data-cutover-20261111) |
| 仓库改名与目录切换准备 | 2026-11-11 | 1、仓库改名并核对相同身份及既有发行，更新origin和当前链接。[详情](CHANGELOG.md#repository-cutover-preparation-20261111)<br>2、补齐受约束的正式切换入口及测试差异证明，8项执行与12项准备检查通过，实际迁移待正常退出。[详情](CHANGELOG.md#repository-cutover-preparation-20261111)<br>3、通过真实界面正式登记三个既有工具，版本和4／4／0个动作入口已核对。[详情](CHANGELOG.md#repository-cutover-preparation-20261111) |
| 本地可用预览交付 | 2026-11-11 | 1、部署正常候选并指向现有实际管理数据，启动及管理信息核对通过。[详情](CHANGELOG.md#local-usable-preview-20261111)<br>2、原启动脚本转发新版，保留运行窗口供使用，深度优化与正式迁移发行单列。[详情](CHANGELOG.md#local-usable-preview-20261111) |
| 原生验收方法与续接（开发中） | 2026-11-11 | 1、发行文件弹层及中文输入助手补齐原生输入保护，60项相关纯检查及独立审查通过。[详情](CHANGELOG.md#native-methods-20261111)<br>2、两个实际弹层选值通过；检查、下载和更新候选准备期间共18次操作完成，原200ms目标仍有一项超时。[详情](CHANGELOG.md#native-methods-20261111)<br>3、Dragon实际播放、画面、真实窗口交接及退出码0通过，原目录与Codex窗口保持。[详情](CHANGELOG.md#native-methods-20261111)<br>4、独立画面核验保持原循环及判据，16项纯回归通过，真实参考和长期测量待验。[详情](CHANGELOG.md#native-methods-20261111) |
| 自动更新与运行恢复验收（开发中） | 2026-11-10 | 1、实际调度、下载、解包、Node探测和切换闭环通过。[详情](CHANGELOG.md#runtime-acceptance-20261110)<br>2、两种切换后失败均恢复可运行旧入口并保留数据。[详情](CHANGELOG.md#runtime-acceptance-20261110)<br>3、31项相关测试、格式、发布编译及静态检查通过，候选字节保持。[详情](CHANGELOG.md#runtime-acceptance-20261110)<br>4、三阶段实际无参数启动及诊断复制通过，物理中文提交继续待验。[详情](CHANGELOG.md#runtime-acceptance-20261110)<br>5、记录编译临时目录遗漏及后续D盘修正检查。[详情](CHANGELOG.md#runtime-acceptance-20261110)<br>6、d0完成30分钟61点并正常退出，内存收敛失败，继续定位。[详情](CHANGELOG.md#runtime-acceptance-20261110) |
| 迁移演练与内容绑定（开发中） | 2026-11-10 | 1、补齐数据库路径、恢复记录和部署预检保护。[详情](CHANGELOG.md#cutover-rehearsal-20261110)<br>2、受控暂存及原子发布支持中断续跑，34项合成检查和独立复核通过。[详情](CHANGELOG.md#cutover-rehearsal-20261110)<br>3、生成正式内容绑定清单，实际切换仍待入口及前置验收完成。[详情](CHANGELOG.md#cutover-rehearsal-20261110)<br>4、隔离入口准备及11项后台检查通过，真实启动待验。[详情](CHANGELOG.md#cutover-rehearsal-20261110)<br>5、管理器未运行时，Edge公开读取成功，当前安装关键文件与登记配方对应一致。[详情](CHANGELOG.md#cutover-rehearsal-20261110)<br>6、Agent Reach原生命令独立公共读取通过。[详情](CHANGELOG.md#cutover-rehearsal-20261110) |
| 原生选择与证据校正（开发中） | 2026-11-09 | 1、改进原生发行文件选择助手，保留精确选值和输入保护；29项后台检查及助手编译通过。[详情](CHANGELOG.md#native-acceptance-followup-20261109)<br>2、实际外观保存／重开通过，下载和持续运行未完成项按原始记录保留。[详情](CHANGELOG.md#native-acceptance-followup-20261109)<br>3、同步当前d0候选、离线包及迁移边界，未移动正式数据或发布。[详情](CHANGELOG.md#native-acceptance-followup-20261109) |
| 操作记录弹层定位修正（验收继续） | 2026-11-08 | 1、修复侧栏独立后操作摘要打开即关闭的问题，保持原有摘要、全部记录及焦点恢复操作。[详情](CHANGELOG.md#operation-summary-host-20261108)<br>2、16项相关界面回归、类型、生产前端、Windows候选构建及协议检查通过，问题归并、诊断和共享空间真实流程通过。[详情](CHANGELOG.md#operation-summary-host-20261108)<br>3、关联配置往返、取消和冲突预览，以及服务的维护窗口、保活、调用保护和闲置释放通过。[详情](CHANGELOG.md#operation-summary-host-20261108)<br>4、新包独立解包、观察器断开对照及单后台启动保护完成，原生选择与性能缺口继续保留。[详情](CHANGELOG.md#operation-summary-host-20261108)<br>5、合成迁移、中断恢复及旧版保存后的新版重开完成代表数据核对，中间旧版导航差异保持未通过。[详情](CHANGELOG.md#operation-summary-host-20261108)<br>6、独立标准账户中的实际静默首装、升级与卸载通过，临时账户及全部专用资料已按清单清理；当前候选跨窗口草稿往返及统一接口公共网页读取通过，安装向导仍待验。[详情](CHANGELOG.md#operation-summary-host-20261108) |
| 原生阅读与持续检查（验收继续） | 2026-11-08 | 1、修正验收脚本过早读取标签选中状态，实际说明定位及检查／标签往返的位置保持通过。[详情](CHANGELOG.md#native-reading-stability-20261108)<br>2、当前候选完成30分钟61次原生采样并正常退出，保留数值检查通过及内存仍增长的不同结论。[详情](CHANGELOG.md#native-reading-stability-20261108)<br>3、自有窗口内的原生撤销、重做、Ctrl＋K、Space与Esc完整检查通过，管理数据及文件保持；IME和下载／更新联合验收仍待完成。[详情](CHANGELOG.md#native-reading-stability-20261108)<br>4、增加静态观察、动态导航及测量进程回收的内存对照，保留原始趋势；独立调试构建仅作诊断。[详情](CHANGELOG.md#native-reading-stability-20261108) |
| 导入与恢复校验（后台验收通过） | 2026-11-08 | 1、配置预览提前识别重复依赖关系，保留本机身份并在提交时复核。[详情](CHANGELOG.md#configuration-recovery-validation-20261108)<br>2、资源恢复记录按GitHub、npm、PyPI来源核对公开地址边界。[详情](CHANGELOG.md#configuration-recovery-validation-20261108)<br>3、48项后端、64项界面逻辑、全库格式、严格Clippy、Windows构建和协议／离线包核对通过，前台及长期性能待验。[详情](CHANGELOG.md#configuration-recovery-validation-20261108) |
| 状态读取与预览回收（后台验收通过） | 2026-11-08 | 1、状态通知共用一个在途读取，合并后续通知并追读最新状态。[详情](CHANGELOG.md#snapshot-preview-retention-20261108)<br>2、Skill卸载及工具来源预览纳入既有32项回收范围，专属子预览同步回收，保留确认时效与当前状态校验。[详情](CHANGELOG.md#snapshot-preview-retention-20261108)<br>3、49项后端及52项界面逻辑、类型、严格Clippy、生产／Windows构建、协议及离线包核对通过，前台和长期性能继续待验。[详情](CHANGELOG.md#snapshot-preview-retention-20261108) |
| 中断处理与配置保护（开发中） | 2026-11-08 | 1、更新失败恢复原入口后，重新执行限定只读自检并复核文件与记录，按实际结果区分恢复成功、运行待核实和恢复受阻。[详情](CHANGELOG.md#maintenance-recovery-20261108)<br>2、新的定期检查不会自动继续已中断的下载，既有回执保留，由本人重新预览确认。[详情](CHANGELOG.md#maintenance-recovery-20261108)<br>3、配置导入和导出遵守当前动作的敏感参数及模板保存声明，拒绝时保持关联数据与撤销重做历史。[详情](CHANGELOG.md#maintenance-recovery-20261108)<br>4、Skill和工具显示折叠的已保存卸载记录，区分已处理和结果待核对项，再次操作仍从当前内容重新预览。[详情](CHANGELOG.md#maintenance-recovery-20261108) |
| 任务摘要分配与新候选（开发中） | 2026-11-09 | 1、摘要直接生成，减少大路径清单的临时复制；85项任务及26项MCP回归、格式和严格静态检查通过。[详情](CHANGELOG.md#task-summary-allocation-20261109)<br>2、新正常候选d0b6551f完成离线构建、41工具协议和便携／安装包独立内容核对。[详情](CHANGELOG.md#task-summary-allocation-20261109)<br>3、持续运行保留原采样与判据，校准前固定静置两分钟；完整原生及交付验收继续进行。[详情](CHANGELOG.md#task-summary-allocation-20261109) |
| 正常候选前台延迟复核（开发中） | 2026-11-08 | 1、a6候选在1000个Skills和100个工具下完成400项精确前台采样，四类P95为111–153毫秒，通过原200毫秒门槛。[详情](CHANGELOG.md#operation-summary-host-20261108)<br>2、缓存上限经同字节生产实现的10项压力检查核验；下载联合负载、长期内存收敛、中文输入法和完整交付继续待验。[详情](CHANGELOG.md#operation-summary-host-20261108)<br>3、当前a6完成30分钟61点，数值通过但尾段内存仍增长；两个真实窗口最后导航与大小经退出重开保持。[详情](CHANGELOG.md#operation-summary-host-20261108)<br>4、任务摘要减少瞬时大复制，85项任务与26项MCP回归、格式及严格静态检查通过；用户已暂停，新增优化尚未构建候选。[详情](CHANGELOG.md#operation-summary-host-20261108) |
| 工具统一入口与跨窗草稿（开发中） | 2026-11-08 | 1、当前候选通过三项现有工具登记及七项限定动作，实际Edge标签页／当前页面调用成功，自有会话断开后既有Edge和Codex保持。[详情](CHANGELOG.md#task-scheduling-summary-20261108)<br>2、本地添加草稿经独立窗口往返保持，原说明仍可定位，文件保持；鼠标拖动、阅读位置等单独验收。[详情](CHANGELOG.md#task-scheduling-summary-20261108)<br>3、工具登记、版本及状态检查与各平台真实读取分别核对，完整八平台能力继续待验。[详情](CHANGELOG.md#task-scheduling-summary-20261108) |
| 任务列表元数据与后续验收（开发中） | 2026-11-08 | 1、前端列表及后端任务列表／事件省略内部调度键，单任务完整读取、持久历史及调度行为保持。[详情](CHANGELOG.md#task-scheduling-summary-20261108)<br>2、23项相关界面检查、83项任务回归、26项MCP相关回归、类型／前端构建及严格静态检查通过，6bf9bf34候选完成Windows发行构建及stdio检查。[详情](CHANGELOG.md#task-scheduling-summary-20261108)<br>3、前阶段候选完成真实官方npm安装更新、来源重绑及关系影响的限定原生流程。[详情](CHANGELOG.md#task-scheduling-summary-20261108)<br>4、前阶段候选通过任务结果查看、文件失效与恢复、系统打开请求及准确目录窗口核对，默认查看器内容仍未验证。[详情](CHANGELOG.md#task-scheduling-summary-20261108)<br>5、新候选完成130次原生检查，100项列表摘要及完整单任务读取保持，活动内存峰值下降40.90%，约9分钟诊断仍不足以证明内存收敛，旧列表大小失败保留。[详情](CHANGELOG.md#task-scheduling-summary-20261108)<br>6、管理器未运行时，已安装CLI的版本及帮助可直接调用，共享Node依赖和验证边界已记录，完整计划继续验收，尚未发布。[详情](CHANGELOG.md#task-scheduling-summary-20261108)<br>7、6bf9bf34便携包及安装候选已离线生成，程序、许可和包内容核对通过，实际安装与发布仍待完成。[详情](CHANGELOG.md#task-scheduling-summary-20261108) |
| 验收续接与本地打包（开发中） | 2026-11-07 | 1、发布草稿绑定当前10a4d2c3候选，保留c08e4641历史证据。[详情](CHANGELOG.md#acceptance-resume-20261107)<br>2、保留200ms目标，增加用户允许的有限延迟评估与边界检查。[详情](CHANGELOG.md#acceptance-resume-20261107)<br>3、原生下拉保持精确选项和最终值校验，并发观察独立标为诊断，限流及选择失败记录保留。[详情](CHANGELOG.md#acceptance-resume-20261107)<br>4、当前候选完成Windows构建、零警告打包、便携四文件及独立解包核对，真实安装升级仍待验。[详情](CHANGELOG.md#acceptance-resume-20261107)<br>5、修正任务列表累计全库检查快照，72项直接回归及类型检查通过。当前候选的三项原生管理流程、场景操作和手动恢复型维护暂停／恢复通过。冷／热启动对照、四类各100次普通交互及30分钟固定持续运行判据通过，内存收敛目标仍未完成，校准首点扩大容忍范围，原生缓存压力及联合负载等继续验收。[详情](CHANGELOG.md#acceptance-resume-20261107)<br>6、三主题、两档密度和夜间窄窗共八组原生布局断言通过，代表截图已复核，设置保存、系统DPI／IME等单独验收。[详情](CHANGELOG.md#acceptance-resume-20261107)<br>7、原生诊断预览、单Skill按需空间明细及旧结构合成数据库的基本模式只读浏览通过，保留复制、损坏数据库及完整迁移等未覆盖边界。[详情](CHANGELOG.md#acceptance-resume-20261107)<br>8、合成资源安装、缺失文件修复、候选准备及四种分级卸载通过，实际版本切换、其余配置类型及正式迁移等继续验收。[详情](CHANGELOG.md#acceptance-resume-20261107)<br>9、原生参数模板保存、填入、修改及删除通过，一次性参数保留且没有自动执行。偏好、分类及别名备注的真实配置文件往返与取消流程通过，其他导入异常及GitHub负载继续验收。[详情](CHANGELOG.md#acceptance-resume-20261107) |
| Edge当前会话只读核验（开发中） | 2026-11-07 | 1、直接连接器完成公开页面读取及同标签重读，关闭本次创建页面并保留既有连接。[详情](CHANGELOG.md#acceptance-resume-20261107)<br>2、现有Edge工具版本及目录变化已核对，管理器统一入口的实际接管与调用仍待重验。[详情](CHANGELOG.md#acceptance-resume-20261107) |
| 任务刷新与缓存核验（开发中） | 2026-11-03 | 1、相同任务通知不再重复刷新列表，保留真实进度与结果过期反馈。[详情](CHANGELOG.md#task-update-pressure-20261103)<br>2、38项直接相关前端检查、类型检查及前端构建通过。[详情](CHANGELOG.md#task-update-pressure-20261103)<br>3、64MiB实际Rust缓存压力及网络检查10项通过。[详情](CHANGELOG.md#task-update-pressure-20261103)<br>4、复用现有环境，正式数据保持原样。[详情](CHANGELOG.md#task-update-pressure-20261103)<br>5、原生400次交互达标；后台负载超限及下载／更新验收缺口保留，补充输入、结果等待及逐控件查询诊断，修正原生下拉选择助手，实际负载仍受前台窗口条件阻碍；后台并发检查时说明读取P95为4.885ms，不替代原生验收。[详情](CHANGELOG.md#task-update-pressure-20261103) |
| 说明读取开销修正（开发中） | 2026-11-03 | 1、普通说明／文件结果不再无条件生成全库状态，保留状态合并与错误语义。[详情](CHANGELOG.md#document-task-cost-20261103)<br>2、1000条合成Skill后台对照P95由8.816降至5.445ms，仅为debug后端测量，原生性能待验收。[详情](CHANGELOG.md#document-task-cost-20261103)<br>3、82项任务、9项文档、31项缓存与状态检查及严格静态检查通过；离线候选记录见开发进度，完整计划仍未完成。[详情](CHANGELOG.md#document-task-cost-20261103)<br>4、复用现有环境，无新下载、正式数据变更或发布。[详情](CHANGELOG.md#document-task-cost-20261103) |
| 任务结果内存优化（开发中） | 2026-11-03 | 1、任务列表不再序列化完整结果；任务与等待者共享结果，大结果使用现有压缩依赖无损保存，保留完整读取和历史行为。[详情](CHANGELOG.md#task-result-memory-20261103)<br>2、78项任务回归、26项MCP相关回归、严格静态检查和离线构建通过；新候选持续运行在8个样本后受额外输入干扰而停止并正常退出，未完成30分钟验收，旧性能失败保留。[详情](CHANGELOG.md#task-result-memory-20261103)<br>3、补充120次大结果任务轮转与释放检查、14项结果及记录交互检查通过；10轮后台启动诊断完成，均不替代原生整机验收。[详情](CHANGELOG.md#task-result-memory-20261103) |
| 后台负载验收修正（开发中） | 2026-11-03 | 1、修正测试任务登记等待、失效控件观察、GitHub地址格式及下拉框展开方式；11项非桌面检查及助手编译通过，最新下拉框修正待实际流程复测。[详情](CHANGELOG.md#native-load-20261103)<br>2、保留说明打开超限和桌面中断证据；完整负载与稳定性验收尚未完成，程序候选不变。[详情](CHANGELOG.md#native-load-20261103)<br>3、发布草稿补齐实际验收边界，记录失效旧安装登记的影响，未执行安装或改动正式数据。[详情](CHANGELOG.md#native-load-20261103) |
| 原生交互验收（开发中） | 2026-11-02 | 1、同一候选在1000个Skills和100个工具下完成四类各100次原生控件输入采样，P95均低于200毫秒。[详情](CHANGELOG.md#native-input-20261102)<br>2、持续运行未完成，按用户要求先做非桌面检查，下载、更新负载及实际安装升级仍待验收。[详情](CHANGELOG.md#native-input-20261102)<br>3、快捷入口测试同步当前导航与设置数量，闲置边界测试改用真实活动时刻验证599／600秒界限。[详情](CHANGELOG.md#native-input-20261102)<br>4、同步当前候选发行草稿、附件摘要及完整计划验收缺口。[详情](CHANGELOG.md#native-input-20261102)<br>5、后台负载支持独立验收，保留真实任务重叠和响应时间检查；策略与参数拒绝检查通过，实际负载待测。[详情](CHANGELOG.md#native-input-20261102) |
| 当前候选打包（开发中） | 2026-11-02 | 1、最新候选离线生成Windows安装包，独立解包与便携包内容摘要核对通过。[详情](CHANGELOG.md#candidate-package-20261102)<br>2、安装升级及完整性能验收继续待完成。[详情](CHANGELOG.md#candidate-package-20261102) |
| 文件用途布局修正（开发中） | 2026-11-02 | 1、安装文件清单的下拉框留足间距，窄窗口自动换行。[详情](CHANGELOG.md#file-row-layout-20261102)<br>2、81种浏览器布局组合、61项相关交互及原生文件清单截图核对完成，合成安装、修复、候选准备与四种卸载验收通过。完整性能等门槛继续待验收。[详情](CHANGELOG.md#file-row-layout-20261102) |
| 维护设置布局精简（开发中） | 2026-11-02 | 1、暂停时长、操作按钮与每日维护时段分别对齐，保留现有行为。[详情](CHANGELOG.md#maintenance-layout-20261102)<br>2、14项维护交互检查及类型检查通过；尚未替换用户审阅中的测试版。[详情](CHANGELOG.md#maintenance-layout-20261102) |
| 发行源码对应检查（开发中） | 2026-11-02 | 1、核对候选与发行提交关系、实际文件树及工作流身份。[详情](CHANGELOG.md#release-source-20261102)<br>2、修正发行清单遗漏变化路径，12项检查通过；真实发行及完整验收仍待完成。[详情](CHANGELOG.md#release-source-20261102) |
| 独立候选构建（开发中） | 2026-11-02 | 1、复用缓存生成独立Windows候选，保留审阅中的预览。[详情](CHANGELOG.md#detached-candidate-20261102)<br>2、构建和命令接口检查通过，新候选原生界面与性能仍待验收。[详情](CHANGELOG.md#detached-candidate-20261102) |
| 发行包内容核验（开发中） | 2026-11-01 | 1、核验安装器与ZIP实际程序、许可及指南内容和默认数据路径。[详情](CHANGELOG.md#release-payload-20261101)<br>2、11项合成检查及脚本解析通过，真实最终包和向导仍待验收。[详情](CHANGELOG.md#release-payload-20261101) |
| 总览与设置精简（开发中） | 2026-11-01 | 1、移除统计卡和来源重复提示，将近期操作范围并入标题，保留异常反馈。[详情](CHANGELOG.md#ui-simplicity-20261101)<br>2、检查方式按名称、说明和当前值对齐；29项相关检查及前端构建通过，未替换正在查看的测试版。[详情](CHANGELOG.md#ui-simplicity-20261101)<br>3、增加手动后端启动诊断，并行准备界面代码与启动模式；7项启动检查及前端构建通过，原生冷启动仍待完成。[详情](CHANGELOG.md#ui-simplicity-20261101)<br>4、补齐35个前端依赖版本许可，当前Windows及本机前端499项版本覆盖核对通过，最终包仍待验收。[详情](CHANGELOG.md#ui-simplicity-20261101) |
| 统一资源与设置加载（开发中） | 2026-11-01 | 1、增加全部／技能／工具统一查找、分页和详情入口，保留原身份与阅读顺序。[详情](CHANGELOG.md#unified-library-20261101)<br>2、设置首次访问才加载，切组保留草稿，隐藏组暂停相关状态读取。[详情](CHANGELOG.md#unified-library-20261101) |
| 安装包编译与升级保护（开发中） | 2026-11-01 | 1、使用已核对的NSIS组件，在隔离工作目录编译安装包，运行中预览的EXE摘要一致。[详情](CHANGELOG.md#installer-compile-20261101)<br>2、旧版退出检查提前到卸载器调用前，并使用原安装目录；真实升级仍待验收。[详情](CHANGELOG.md#installer-compile-20261101) |
| 资源总览（开发中，未发布） | 2026-11-01 | 1、增加可点击统计、待处理Skill、收藏、任务进度、来源状态、分类分布及近期操作，沿用已有数据和入口。[详情](CHANGELOG.md#dashboard-implementation-20261101)<br>2、接入侧栏、Ctrl＋K及跨窗口导航恢复，复用主题和缓存；相关检查通过，原生布局与性能待验收。[详情](CHANGELOG.md#dashboard-implementation-20261101) |
| UI 组件候选调研（文档） | 2026-11-01 | 1、按新增请求核对9个组件与仪表盘仓库，记录固定版本、实际读取及维护情况。[详情](CHANGELOG.md#dashboard-components-20261101)<br>2、提出真实任务总览与组件接入顺序，保留原完整验收，当前仅研究与方案。[详情](CHANGELOG.md#dashboard-components-20261101) |
| 侧栏稳定与交付准备（开发中，未发布） | 2026-11-01 | 1、统一侧栏两态几何，减少宽屏设置内容跳动。[详情](CHANGELOG.md#sidebar-delivery-review-20261101)<br>2、补修便携路径识别，保留旧库与自定义位置；待运行验证。[详情](CHANGELOG.md#sidebar-delivery-review-20261101)<br>3、补充开发预览说明，明确附件及安装器兼容待办，未发布。[详情](CHANGELOG.md#sidebar-delivery-review-20261101) |
| 生命周期与配置续接（开发中，未发布） | 2026-11-01 | 1、配置往返保留来源与引用，跨表一次提交。[详情](CHANGELOG.md#continuation-lifecycle-20261030)<br>2、每次预览Skill卸载，保护定制与共享内容。[详情](CHANGELOG.md#continuation-lifecycle-20261030)<br>3、候选在最终目录准备，独立核验与切换。[详情](CHANGELOG.md#continuation-lifecycle-20261030)<br>4、系统入口按精确可信归属处理，保留部分失败。[详情](CHANGELOG.md#continuation-lifecycle-20261030)<br>5、24小时来源观察与自动应用许可分开。[详情](CHANGELOG.md#continuation-lifecycle-20261030)<br>6、自动更新逐阶段复核，失败不自动重放。[详情](CHANGELOG.md#continuation-lifecycle-20261030)<br>7、新名称与独立目录兼容旧数据路径。[详情](CHANGELOG.md#continuation-lifecycle-20261030)<br>8、三个现有工具只读接管，不移动原件或登录资料。[详情](CHANGELOG.md#continuation-lifecycle-20261030)<br>9、调用证据绑定实际版本、入口及结果。[详情](CHANGELOG.md#continuation-lifecycle-20261030)<br>10、精简空视图，补齐使用及迁移说明。[详情](CHANGELOG.md#continuation-lifecycle-20261030)<br>11、隔离测试与真实桌面、迁移、性能分别验收。[详情](CHANGELOG.md#continuation-lifecycle-20261030)<br>12、固定Edge MCP调用及取消竞态修复，持续集成验证。[详情](CHANGELOG.md#continuation-lifecycle-20261030)<br>13、真实工具调用、官方npm双版本原生安装更新及退出后的CLI独立运行通过；原生三主题／窄窗验收通过，完整性能与交付继续验收。[详情](CHANGELOG.md#continuation-lifecycle-20261030)<br>14、按固定提交在线参考两份设计资料，优化三主题与四强调色层次、工具与筛选布局、设置行和限速单位、网络失败原地恢复；保留全部功能、字号与缩放。[详情](CHANGELOG.md#online-design-ui-20261101)<br>15、按审阅意见重整九组设置、卡片、标题与外框；保留草稿与全部视图，补齐分类收起和分组独立保存，先提供设计预览。[详情](CHANGELOG.md#workspace-ui-redesign-20261101) |
| 计划执行细节优化（文档，未发布） | 2026-10-30 | 1、原六项及第1–16项保留，第17项排除；本轮只优化计划，不新增建议。[本次完整记录](CHANGELOG.md#plan-execution-details-20261030)<br>2、补清配置关联往返、部分卸载记录及再次确认、实际入口与验收对应。[本次完整记录](CHANGELOG.md#plan-execution-details-20261030)<br>3、全部视觉、性能和保护标准保持，仅核对文档，不改程序或版本。[本次完整记录](CHANGELOG.md#plan-execution-details-20261030) |
| 计划一致性核对（文档，未发布） | 2026-10-30 | 1、原六项及第1–16项全部保留，第17项排除；本轮仅优化计划，不新增建议。[本次完整记录](CHANGELOG.md#plan-consistency-20261030)<br>2、补清配置导入、共享依赖复核、问题证据和空间统计的既有行为，并同步验收。[本次完整记录](CHANGELOG.md#plan-consistency-20261030)<br>3、视觉、速度、稳定性及授权规范保持，仅修改文档，不改程序或版本。[本次完整记录](CHANGELOG.md#plan-consistency-20261030) |
| 结果、诊断与空间明细（开发中，未发布） | 2026-10-30 | 1、结果文件位置随任务记录保存，重启后可核对和打开，不重放任务。[本次完整记录](CHANGELOG.md#maintenance-experience-development-20261030)<br>2、归并同源问题并保留单项状态，按需生成和复制脱敏诊断，不上传。[本次完整记录](CHANGELOG.md#maintenance-experience-development-20261030)<br>3、工具与Skill按需统计空间，未知用途与未读部分明确显示，相关检查、构建与35项程序接口发现通过。[本次完整记录](CHANGELOG.md#maintenance-experience-development-20261030) |
| 场景与闲置释放（开发中，未发布） | 2026-10-30 | 1、场景限制后续调用，手动停用优先，保留已有任务与入口。[本次完整记录](CHANGELOG.md#scenes-idle-development-20261030)<br>2、可安全停止的自有服务按实际活动闲置释放，调用／登录／依赖与明确保活受保护。[本次完整记录](CHANGELOG.md#scenes-idle-development-20261030)<br>3、失败可见且不自动重试，完整Rust577项、前端465项及构建和实际协议检查通过。[本次完整记录](CHANGELOG.md#scenes-idle-development-20261030) |
| 来源健康与重绑（开发中，未发布） | 2026-10-30 | 1、区分来源可访问与能力可用，展示旧新仓库及具体目录／发行文件，预览确认后关联。[本次完整记录](CHANGELOG.md#source-binding-development-20261030)<br>2、保留原安装证据、本地文件及历史说明；重复同源确认不清基线，旧审计保留历史并失效。[本次完整记录](CHANGELOG.md#source-binding-development-20261030)<br>3、实时保存复核并发变化，Agent只开放来源读取和预览；基本模式只读已有信息，完整Rust560项、前端441项及构建检查通过。[本次完整记录](CHANGELOG.md#source-binding-development-20261030) |
| 计划收束（文档，未发布） | 2026-10-30 | 1、统一本轮仅优化计划的范围，原六项及第1–16项保留，第17项排除，不新增功能。[本次完整记录](CHANGELOG.md#plan-final-review-20261030)<br>2、明确手动更新同样保护本地信息，新安装位置满足资源独立使用；同步验证条目。[本次完整记录](CHANGELOG.md#plan-final-review-20261030)<br>3、提前固定内存判据，明确零已知程序错误／警告验收；原视觉与性能标准保持，不改程序或版本。[本次完整记录](CHANGELOG.md#plan-final-review-20261030) |
| 依赖关系与卸载影响（开发中，未发布） | 2026-10-30 | 1、Skill与工具共用双向依赖记录，独立保存，按需读取，显示共享使用及失效引用；关系不授予文件归属。[本次完整记录](CHANGELOG.md#resource-relations-development-20261030)<br>2、卸载前核对使用者及关系版本；失效引用可从目标详情显式解除，保留文件，不连带卸载其他资源。[本次完整记录](CHANGELOG.md#resource-relations-development-20261030)<br>3、GUI共用实时写入方，Agent只读；Rust534项、前端整合及相关修复检查通过，仍未完成正式交付。[本次完整记录](CHANGELOG.md#resource-relations-development-20261030) |
| 计划复核（文档，未发布） | 2026-10-30 | 1、只优化计划；原六项及第1–16项全部保留，第17项排除，既有开发内容保留。[本次完整记录](CHANGELOG.md#plan-scope-review-20261030)<br>2、补清更新切换后失败的安全收尾、切页／移窗保留编辑与确认边界、包含排队和渲染的响应计时，并同步对应验收。[本次完整记录](CHANGELOG.md#plan-scope-review-20261030)<br>3、视觉、性能与数据保护标准不降低，不新增功能、不改程序或版本、不发布。[本次完整记录](CHANGELOG.md#plan-scope-review-20261030) |
| 维护与个人管理（开发中，未发布） | 2026-10-30 | 1、维护暂停／窗口统一约束自动任务，20步撤销重做核对当前历史及并发变化。[完整记录](CHANGELOG.md#management-data-development-20261030)<br>2、Ctrl＋K打开已登记动作参数，提交前复核资源版本，修复详情定位抢占参数焦点。[完整记录](CHANGELOG.md#management-data-development-20261030)<br>3、Skill别名／备注和常用筛选独立保存；保留原名，参与搜索，应用筛选不执行工具或保存显示设置。[完整记录](CHANGELOG.md#management-data-development-20261030)<br>4、后台刷新保留技能库顺序、勾选、焦点与滚动锚点；实际删除转到相邻项，明确重新整理才重新筛选排序。[完整记录](CHANGELOG.md#management-data-development-20261030)<br>5、增加仅保存明确选择非敏感参数的调用模板，套用后仍需核对执行；工具切页与移窗恢复筛选和编辑草稿，隐藏时不刷新。[完整记录](CHANGELOG.md#management-data-development-20261030)<br>6、保留完整计划与正式版；本次检查使用模拟数据，未迁移真实资源、未发布。[完整记录](CHANGELOG.md#management-data-development-20261030) |
| 计划优化（文档，未发布） | 2026-10-28 | 1、按原编号保留六项维护能力及第1–16项，第17项排除；本轮只优化计划及对应记录，不恢复实施。[本次完整记录](CHANGELOG.md#plan-refinement-20261028)<br>2、对应实施阶段与验收，前置共用维护判定，明确暂停时间及提交边界；细化最小安装、固定版本修复、无损更新、重绑证据、配置导入冲突和重做历史。[本次完整记录](CHANGELOG.md#plan-refinement-20261028)<br>3、保持逐次卸载与独立使用要求，联合验收视觉和后台负载；明确配色覆盖、图标原生显示和错误／警告证据，不降低性能指标、不升级程序版本。[本次完整记录](CHANGELOG.md#plan-refinement-20261028) |
| Agent Resource Manager（开发中，未发布） | 2026-10-28 | 1、增加独立资源目录、明确动作与受管进程状态，界面与任务服务共用持久写入方。[完整记录](CHANGELOG.md#resource-manager-development)<br>2、接入最小 ZIP 安装、许可与文件用途归属、每次选择程度的卸载预览和本地确认，未知内容保留。[完整记录](CHANGELOG.md#resource-manager-development)<br>3、增加 Ctrl＋K、三主题强调色、密度与动效选项，保留既有技能入口。[完整记录](CHANGELOG.md#resource-manager-development)<br>4、加入具体备份许可、早期只读基本模式，保护原有资料与设置。[完整记录](CHANGELOG.md#resource-manager-development)<br>5、接入同用户唯一后台与有限 MCP 操作，区分关闭界面与完全退出；保留人工维护确认。[完整记录](CHANGELOG.md#resource-manager-development)<br>6、阶段验证与完整交付分开记录；真实客户端、自动更新、系统集成清理、正式迁移及性能验收尚未完成。[完整记录](CHANGELOG.md#resource-manager-development) |
| v0.2.11（正式发行） | 2026-10-27 | 1、仅说明或管理信息的更新检查完成后归“内容一致”，退出待办；最近检查只记录本轮新变化，真实问题保留对应原因与操作。[完整记录](CHANGELOG.md#v0211-candidate)<br>2、仅在目录清单与新鲜两端一致证据同时成立时，修正 Hatch Pet 的旧自动范围28→23项，保护人工范围和原文件。[完整记录](CHANGELOG.md#v0211-candidate)<br>3、脚本入口与调用参数分开核对，避免把整段命令误报缺失。[完整记录](CHANGELOG.md#v0211-candidate)<br>4、变化页仅在需要时展开批量选择；单项直接重新检查，选择、数量和执行操作分组对齐，窄窗口自动换行。183项前端、389项Rust及原生界面／重启验收通过。[完整记录](CHANGELOG.md#v0211-candidate) |
| v0.2.10（正式发行） | 2026-10-27 | 1、整合 v0.2.8／v0.2.9 的导出与原生关闭修复、自动导入、统一检查及可靠关联。[完整记录](CHANGELOG.md#v0210-release)<br>2、修复中文文件引用与有效绑定误报，保留未知安装历史及本地内容。[完整记录](CHANGELOG.md#v0210-release)<br>3、忽略项逐行显示，目录紧凑对齐并采用检查＋更多菜单，保留批量与键盘操作。[完整记录](CHANGELOG.md#v0210-release)<br>4、沿用三主题、字号与缩放，36组布局检查和174前端／382Rust通过。[完整记录](CHANGELOG.md#v0210-release)<br>5、发布同EXE的便携包与NSIS安装器、源码及校验材料；无数据库迁移，安装向导未测。[完整记录](CHANGELOG.md#v0210-release) |
| v0.2.9（候选，未发布） | 2026-10-26 | 1、增加自动导入目录及忽略项管理，按真实路径去重。[完整记录](CHANGELOG.md#v029-candidate)<br>2、统一全局自动／手动检查及变化页批量操作，同快照发现并关联来源。[完整记录](CHANGELOG.md#v029-candidate)<br>3、修复中文模板路径与有效绑定误报，审计缓存按分析器版本失效。[完整记录](CHANGELOG.md#v029-candidate)<br>4、本地事件防抖、远端提交探测及空轮次去重，保留缓存优先阅读和现有功能。[完整记录](CHANGELOG.md#v029-candidate) |
| v0.2.8（候选，未发布） | 2026-10-26 | 1、修复监听失败阻断导出清单、重试入口不完整及可选文件禁用，保留跨窗共享选择与导出核验。[完整记录](CHANGELOG.md#v028-candidate)<br>2、统一客户端吸顶头部与折叠信息，消除顶部空带和不必要的横向滚动条。[完整记录](CHANGELOG.md#v028-candidate)<br>3、便携版直接提供程序本体及同目录路径配置，保留既有管理数据。[完整记录](CHANGELOG.md#v028-candidate)<br>4、云端 Windows 检查与候选附件分开记录，原生界面验收不由单元测试代替。[完整记录](CHANGELOG.md#v028-candidate) |
| v0.2.7（首次公开发行） | 2026-10-25 | 1、快捷键帮助改为独立浮层，按当前列表／卡片显示真实按键，在所属窗格和视口内翻转、限高与滚动；保留键盘、外点和焦点操作。[本次完整记录](CHANGELOG.md#v027-release)<br>2、分类使用八色实心标签，增强文字、色面与背景区别，去掉标签内重复圆点；现有分类、颜色身份与连续撤销保持。[本次完整记录](CHANGELOG.md#v027-release)<br>3、夜间参照用户GPT截图采用炭黑／石墨灰，明亮使用浅灰／白色，护眼使用低亮度暖灰米色；正文、辅助文字、控件及原生标题栏分别适配。[本次完整记录](CHANGELOG.md#v027-release)<br>4、工作台统一紧凑标题、统计和工具栏，省去重复分类、空用途、未知版本和零连接占位；标签栏预留细横滚槽，任务徽标不再挤压主区；真实内容、搜索筛选和全部操作保留。[本次完整记录](CHANGELOG.md#v027-release)<br>5、详情、导出、变化、客户端、设置和操作记录减少重复说明，普通解释按需展开；关键警告、完整路径、真实来源、文件范围与失败恢复保留。[本次完整记录](CHANGELOG.md#v027-release)<br>6、保持既有本地／GitHub操作、ZIP必要／可选选择、多标签／分屏、目录跳转、默认／自定义目标、设置与缓存；管理操作保存完成后才启用撤销，避免提前按键无效；不新增依赖或数据迁移。[本次完整记录](CHANGELOG.md#v027-release)<br>7、首次公开发行：使用独立公开仓库管理源码和版本，补充下载、许可及校验说明；正式源码排除构建缓存和私有运行资料，程序版本与行为保持不变。[本次完整记录](CHANGELOG.md#v027-release) |
| v0.2.6（候选，未发布） | 2026-10-25 | 1、新增可切换卡片，沿用列表／详情与现有默认视图；三种视图共用筛选、排序、分页、选择与拖动归类。[本次完整记录](CHANGELOG.md#v026-candidate)<br>2、分类增加八组主题适配颜色；旧记录只读默认色，真实分类编辑时原子保存，保留未知字段、收藏及连续撤销。[本次完整记录](CHANGELOG.md#v026-candidate)<br>3、设置目录按实际栏高和当前滚动视口定位，减少留白；客户端详情固定展开／收起位置，名称可跳转并复用详情标签。[本次完整记录](CHANGELOG.md#v026-candidate)<br>4、操作记录默认显示最多五项浮动摘要，明确选择详情才打开记录页；低频忽略连接收进高级操作，原件与客户端入口保持明确。[本次完整记录](CHANGELOG.md#v026-candidate)<br>5、新下载和ZIP导出每次明确选择默认／自定义位置；只读解析不建目录，默认导出在清单证明通过后创建选定目录。[本次完整记录](CHANGELOG.md#v026-candidate)<br>6、紧凑统一工具栏、按需快捷键帮助、大字号与三主题对比；现有文件、来源、预览、恢复、多窗口及缓存语义保持。[本次完整记录](CHANGELOG.md#v026-candidate) |
| v0.2.5（候选，未发布） | 2026-10-25 | 1、六类主状态按当前结果显示，变化页统一计数、原因和下一步操作，保留内部差异与比较依据。[本次完整记录](CHANGELOG.md#v025-candidate)<br>2、客户端紧凑列表、正常分页与统一管理入口；连接选择使用独立标签，支持当前筛选全部、键盘选择、后台逐项结果和跨窗口续接。[本次完整记录](CHANGELOG.md#v025-candidate)<br>3、自动检查和可靠恢复客户端入口；实际使用作为可选用户确认记录，绑定当时文件指纹，变更后提示过期。[本次完整记录](CHANGELOG.md#v025-candidate)<br>4、设置按主题分区，左侧精简目录与准确跳转，管理数据目录统一在保存位置维护；网络字段与诊断结果分别对齐。[本次完整记录](CHANGELOG.md#v025-candidate)<br>5、说明和导出计划按需读取，使用有容量限制的内存缓存、同版本图片及同次扫描复用；凭据或来源变化使读取上下文失效。[本次完整记录](CHANGELOG.md#v025-candidate) |
| v0.2.4（候选，未发布） | 2026-10-25 | 1、文件和导出统一为必要、可选包内、可选外部、环境与参考四组，名称在左、状态与勾选在右。[本次完整记录](CHANGELOG.md#v024-candidate)<br>2、默认自动识别长期管理范围，保留手动及旧确认范围；调整入口下沉，不作为使用 Skill 的前置步骤。[本次完整记录](CHANGELOG.md#v024-candidate)<br>3、操作记录改为独立可搜索标签页，侧栏仅固定一行，保留任务结果、取消与跨窗口返回。[本次完整记录](CHANGELOG.md#v024-candidate)<br>4、强化目录层级和窄屏临时面板，按稳定标识恢复折叠，比较依据移至来源页。[本次完整记录](CHANGELOG.md#v024-candidate) |
| v0.2.3（候选，未发布） | 2026-10-25 | 1、统一文件与导出页选择，跨标签及窗口同步，默认精简且成功后按版本清空。[本次完整记录](CHANGELOG.md#v023-candidate)<br>2、明确必要／可选包内／可选外部／不打包环境信息，普通规则可本次携带。[本次完整记录](CHANGELOG.md#v023-candidate)<br>3、最终清单与 ZIP 同源，来源变化或已选失败时明确阻止，保留固定提交。[本次完整记录](CHANGELOG.md#v023-candidate)<br>4、增强三主题文字、控件及禁用状态对比度。[本次完整记录](CHANGELOG.md#v023-candidate)<br>5、保持说明标题节点稳定，修复保存滚动位置后的目录回退和失焦。[本次完整记录](CHANGELOG.md#v023-candidate) |
| v0.2.2（候选，未发布） | 2026-10-24 | 1、优化全界面层级、标题自然布局与左目录。[本次完整记录](CHANGELOG.md#v022-candidate)<br>2、按缩放及吸顶栏定位标题，直接高亮并保持面板独立。[本次完整记录](CHANGELOG.md#v022-candidate)<br>3、文件主条目合并引用，保留批量操作与必要 ZIP 范围。[本次完整记录](CHANGELOG.md#v022-candidate)<br>4、自动修复可靠记录并明确远端／本地结果边界。[本次完整记录](CHANGELOG.md#v022-candidate) |
| v0.2.1（候选，未发布） | 2026-10-24 | 1、修复固定高度布局压缩长内容，恢复工作台与各业务页的正常滚动。[本次完整记录](CHANGELOG.md#v021-candidate)<br>2、支持工作台左侧与业务页右侧同时显示，分隔线可拖动，焦点与可见状态分开。[本次完整记录](CHANGELOG.md#v021-candidate)<br>3、目录按钮和可折叠目录移到本页左侧，保留每页滚动、草稿及独立窗口操作。[本次完整记录](CHANGELOG.md#v021-candidate)<br>4、GitHub文件选择在当前项旁显示、聚焦并定位，明确加载与失败反馈。[本次完整记录](CHANGELOG.md#v021-candidate)<br>5、可靠路径与唯一内容自动匹配，保留人工绑定、用途、本地优先及可选文件默认不选。[本次完整记录](CHANGELOG.md#v021-candidate)<br>6、增加存储与空间设置、默认下载／导出位置及需重启的数据迁移，原位置保留。[本次完整记录](CHANGELOG.md#v021-candidate)<br>7、统一开发保存位置入口和安装默认位置；系统托管边界单列，本轮验证完成。[本次完整记录](CHANGELOG.md#v021-candidate) |
| v0.2.0（候选，未发布） | 2026-10-24 | 1、详情与操作使用标签页，支持排序、独立原生窗口及移回主窗口。[本次完整记录](CHANGELOG.md#v020-candidate)<br>2、可折叠目录定位当前页，滚动、折叠和未完成草稿随页转移。[本次完整记录](CHANGELOG.md#v020-candidate)<br>3、外部依赖区分用途、引用类型及本地／GitHub证据，精确映射而不猜测重名。[本次完整记录](CHANGELOG.md#v020-candidate)<br>4、增加批量改用途、绑定、重新映射与复核，过期项逐项拒绝并保留草稿。[本次完整记录](CHANGELOG.md#v020-candidate)<br>5、必要文件本地优先、固定提交补齐，选中远端附件直接入ZIP，原件不变。[本次完整记录](CHANGELOG.md#v020-candidate)<br>6、共享任务与管理状态，窗口转移和历史定位不重复执行操作。[本次完整记录](CHANGELOG.md#v020-candidate)<br>7、各窗口共用主题字号缩放，关闭当前窗口与最后保存退出分别处理。[本次完整记录](CHANGELOG.md#v020-candidate)<br>8、统一既有私有资源打包检查，保留原功能与数据；本轮验证完成，公开发布另行确认。[本次完整记录](CHANGELOG.md#v020-candidate) |
| v0.1.9（候选，未发布） | 2026-10-24 | 1、客户端改为标签页和全宽分页列表，顶部搜索与批量连接入口。[本次完整记录](CHANGELOG.md#v019-candidate)<br>2、明确客户端入口与真实目录，链接去重，不迁移原件或复制 Skill。[本次完整记录](CHANGELOG.md#v019-candidate)<br>3、后台任务与冲突资源排队，独立操作可继续，写入阶段保持完整性。[本次完整记录](CHANGELOG.md#v019-candidate)<br>4、操作记录保存阶段与结果，支持返回对应界面，失败写入不自动重放。[本次完整记录](CHANGELOG.md#v019-candidate)<br>5、本地先显示、固定内容缓存复用与网络诊断，私有内容不绕过认证。[本次完整记录](CHANGELOG.md#v019-candidate)<br>6、外部依赖核验实际路径、用途和可用性，历史与环境不持续泛称待核对。[本次完整记录](CHANGELOG.md#v019-candidate)<br>7、必要资源默认进入最终 ZIP，可选文件按勾选，原件不复制迁移，包内静态引用独立转换。[本次完整记录](CHANGELOG.md#v019-candidate)<br>8、保留原数据、分类收藏、撤销、外观缩放与精简恢复；全量验收完成后再汇总结果，公开发布另行确认。[本次完整记录](CHANGELOG.md#v019-candidate) |
| v0.1.8（候选，未发布） | 2026-10-23 | 1、本地首次上传选择仓库、分支和目录，关联上传保留远端未选文件。[本次完整记录](CHANGELOG.md#v018-candidate)<br>2、上传后仅精简本次已验证的可选文件，完整路径预览与固定提交恢复。[本次完整记录](CHANGELOG.md#v018-candidate)<br>3、同源已有客户端链接直接登记，来源、健康和实际调用分开。[本次完整记录](CHANGELOG.md#v018-candidate)<br>4、依赖分级与批量自动核对，文件变化使旧证据失效，当前比较基准不冒充历史安装提交。[本次完整记录](CHANGELOG.md#v018-candidate)<br>5、ZIP默认必要文件，选中远端附件直接入包且不落入本地Skill目录。[本次完整记录](CHANGELOG.md#v018-candidate)<br>6、检查总览、上传结果和恢复入口，保留原设置、分类、收藏和Ctrl＋Z。[本次完整记录](CHANGELOG.md#v018-candidate)<br>7、真实HTTP模拟协议、失败恢复与界面验证，正式发布仍需单独确认。[本次完整记录](CHANGELOG.md#v018-candidate) |
| v0.1.7（候选，未发布） | 2026-10-23 | 1、本地与GitHub文件合并展示，标明位置和读取状态，远端附件可勾选。[本次完整记录](CHANGELOG.md#v017-candidate)<br>2、运行范围与本次附件分离，支持固定提交预览、混合导出及独立新增下载。[本次完整记录](CHANGELOG.md#v017-candidate)<br>3、导出默认使用Skill名，保留本地定制与来源信息。[本次完整记录](CHANGELOG.md#v017-candidate)<br>4、依赖与验证读取索引和README，分别展示来源声明与本机证据。[本次完整记录](CHANGELOG.md#v017-candidate)<br>5、本地先显示、页签内存复用与导出摘要，保留既有界面及用户数据。[本次完整记录](CHANGELOG.md#v017-candidate)<br>6、Ctrl＋Z连续撤销分类和收藏，保护输入框原有文字撤销。[本次完整记录](CHANGELOG.md#v017-candidate) |
| v0.1.6（候选，未发布） | 2026-10-23 | 1、选中行内容可拖动，批量反馈与撤销更明确。[本次完整记录](CHANGELOG.md#v016-candidate)<br>2、分类菜单改为浮动显示，支持外部点击、Esc与键盘操作。[本次完整记录](CHANGELOG.md#v016-candidate)<br>3、“内容一致”增加范围、时间、基准与异常优先级，筛选保持一致。[本次完整记录](CHANGELOG.md#v016-candidate)<br>4、区分本地额外文件与待上传运行修改。[本次完整记录](CHANGELOG.md#v016-candidate)<br>5、增加分类拖动排序和列表键盘多选。[本次完整记录](CHANGELOG.md#v016-candidate)<br>6、收藏入口独立于分类，保留原设置和数据。[本次完整记录](CHANGELOG.md#v016-candidate) |
| v0.1.5（候选，未发布） | 2026-10-23 | 1、自定义单层主分类、计数、排序、拖入／批量菜单及归类撤销。[本次完整记录](CHANGELOG.md#v015-candidate)<br>2、Ctrl＋滚轮、Ctrl＋加减号与Ctrl＋0缩放并自动保存。[本次完整记录](CHANGELOG.md#v015-candidate)<br>3、侧栏收起、拖宽、键盘调整、临时分类面板和恢复布局。[本次完整记录](CHANGELOG.md#v015-candidate)<br>4、补充筛选上下文、空结果提示、三主题及窄窗兼容，保留原功能与数据。[本次完整记录](CHANGELOG.md#v015-candidate) |
| v0.1.4（候选，未发布） | 2026-10-23 | 1、详情文件页及下载／更新／提交弹窗的必要、可选组独立折叠，显示总数与已选数。[本次完整记录](CHANGELOG.md#v014-candidate)<br>2、紧凑列表随页面纵向滚动，文件弹窗取消清单内嵌滚动。[本次完整记录](CHANGELOG.md#v014-candidate)<br>3、核对实际字节与Skill版本变化后提醒，忙时返回焦点排队补查，准确区分待上传范围。[本次完整记录](CHANGELOG.md#v014-candidate)<br>4、护眼主题改为较低亮度的暖灰绿，保留三主题、字号、缩放和原功能。[本次完整记录](CHANGELOG.md#v014-candidate) |
| v0.1.3（候选，未发布） | 2026-10-23 | 1、分开统计本地／远端／已关联Skill与仓库数。[本次完整记录](CHANGELOG.md#v013-candidate)<br>2、来源可直达本地文件夹与远端分支目录。[本次完整记录](CHANGELOG.md#v013-candidate)<br>3、操作消息移至侧栏，支持100条时间状态记录、滚动与清空。[本次完整记录](CHANGELOG.md#v013-candidate)<br>4、运行文件分必要／可选，明确下载、更新和ZIP范围及依赖边界。[本次完整记录](CHANGELOG.md#v013-candidate)<br>5、增加经核实的双向唯一自动关联，保留本地身份与文件。[本次完整记录](CHANGELOG.md#v013-candidate)<br>6、区分首次差异与后续各侧变化，展示差异文件摘要并保留原功能。[本次完整记录](CHANGELOG.md#v013-candidate) |
| v0.1.2（候选，未发布） | 2026-10-23 | 1、增加紧凑列表、20／50／100分页和全库多词搜索。[本次完整记录](CHANGELOG.md#v012-candidate)<br>2、增加来源／状态筛选、排序、行内操作和按需详情抽屉，保留完整详情。[本次完整记录](CHANGELOG.md#v012-candidate)<br>3、增加本页多选检查与视图偏好保存，更新继续逐项预览应用。[本次完整记录](CHANGELOG.md#v012-candidate)<br>4、修复筛选页码、变化跨页定位和文件确认异步错位，补充大库与显示回归。[本次完整记录](CHANGELOG.md#v012-candidate) |
| v0.1.1（候选，未发布） | 2026-10-23 | 1、修复创建令牌链接权限，增加预填与就地提示。[本次完整记录](CHANGELOG.md#v011-candidate)<br>2、修复夜间／护眼统计卡背景，支持程序旁指定数据目录。[本次完整记录](CHANGELOG.md#v011-candidate)<br>3、保留并迁移现有管理记录，补充目录解析和原生界面回归。[本次完整记录](CHANGELOG.md#v011-candidate) |
| v0.1.0（候选，未发布） | 2026-10-23 | 1、实现本地与GitHub来源、远端说明和文件范围管理。[本次完整记录](CHANGELOG.md#v010-candidate)<br>2、实现预览更新、选定提交、客户端链接和导出恢复。[本次完整记录](CHANGELOG.md#v010-candidate)<br>3、增加夜间／护眼模式、字号和缩放设置。[本次完整记录](CHANGELOG.md#v010-candidate)<br>4、增加Windows构建、核心回归和使用说明。[本次完整记录](CHANGELOG.md#v010-candidate) |

[查看全部完整更新记录](CHANGELOG.md)
