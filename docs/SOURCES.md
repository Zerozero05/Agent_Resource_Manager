# Sources and dependencies


<a id="desktop-design-refresh-20261124"></a>

## 桌面管理界面参考 — 2026-11-24

公开仓库在 2026-11-24（上海时间）在线核对，下列使用范围为人工阅读后的设计方法。项目继续使用自身 React、TypeScript、CSS、Lucide、Tauri 与 Rust。未安装插件、引入外部代码、运行参考仓库工具，或增加程序依赖。

| 来源 | 固定版本、维护与许可 | 阅读及实际采用 |
| --- | --- | --- |
| Taste Skill · 120,586 Stars | `6c0b5c7`，11 月 23 日主分支提交为赞助信息。11 月 7 日的 `b900a80` 更新 Skill 与系统规范。MIT，未归档。 | 完整审阅 [SKILL.md](https://github.com/Leonxlnx/taste-skill/blob/6c0b5c78f5d31776e2210305abaa210cdc0030bf/skills/taste-skill/SKILL.md) 及 system、layout-v4、copy、copy-voice、sections、motion、perf 引用。采用紧凑分层、边缘对齐、克制色彩、可见焦点和清晰状态。其营销页面规则与 Node 22+ / Chromium 检查器未用于桌面产品。 |
| The Architect · 591 Stars | `cfa739a`，10 月 25 日；已有项目改造入口 10 月 17 日修订，同日发布 v2.6.0。MIT，未归档。 | 读完 [Architect](https://github.com/Hainrixz/the-architect/blob/cfa739a24ee0ea8bbb36a73e404ed9d59236b4ec/skills/architect/SKILL.md)、[已有项目](https://github.com/Hainrixz/the-architect/blob/cfa739a24ee0ea8bbb36a73e404ed9d59236b4ec/commands/architect-brownfield.md)、桌面应用及前端架构、状态、测试与可访问性说明。采用从实际耦合处收拢职责，单份设置元数据，维持现有持久信息和窗口行为。未运行其 Claude Code 插件。 |
| shadcn/ui · 128,855 Stars | `055aa6b`，11 月 23 日；相关表格代码 8 月 7 日有实质修改。MIT，未归档。 | 阅读 React / Next.js / Tailwind 的 [总览页](https://github.com/shadcn-ui/ui/blob/055aa6b7837b1808456a24beb4c97a677864aa82/apps/v4/registry/new-york-v4/blocks/dashboard-01/page.tsx) 和 [统计组件](https://github.com/shadcn-ui/ui/blob/055aa6b7837b1808456a24beb4c97a677864aa82/apps/v4/registry/new-york-v4/blocks/dashboard-01/components/section-cards.tsx)。采用按内容区宽度调整列数，数字保持等宽，摘要通往已有功能入口。 |
| Primer React · 3,941 Stars | `2128032`，11 月 20 日；NavList 9 月 17 日更新。MIT，未归档。 | 阅读 [NavList 源文件](https://github.com/primer/react/blob/2128032dca65a1bd565fe382c2e91c638c6473a4/packages/react/src/NavList/NavList.tsx) 及 [ActionList 指南](https://primer.style/product/components/action-list/guidelines/)。采用具名分组、一个当前位置、可换行标签和清晰的键盘导航。 |

另比较 [Senior Architect](https://github.com/alirezarezvani/claude-skills/blob/ea7b5ab8da93bbba8880152d9ccb8c9979f12252/engineering-team/skills/senior-architect/SKILL.md)，固定 `ea7b5ab`，30,347 Stars、MIT、未归档，11 月 23 日发布 v2.14.16。阅读其主 Skill，运维选型和 Python 分析器超出本轮范围，因此保持现有 Tauri 设计。

### GitHub Actions 运行环境 — 2026-11-19

Windows 检查与发行材料准备固定使用 Node.js 24 版本的官方检出和 Node 安装组件。版本分别为 checkout v7.0.1（`3d3c42e`）和 setup-node v7.1.0（`949feb2`）。两者仅用于托管工作流。 [checkout 固定清单](https://github.com/actions/checkout/blob/3d3c42e5aac5ba805825da76410c181273ba90b1/action.yml) · [setup-node 固定清单](https://github.com/actions/setup-node/blob/949feb2413d6458794dcd2491c4babbbce0c15c1/action.yml)

### 工具目录修复与测试连接模式 — 2026-11-17

目录修复复用本项目既有适配器、预览、目录身份检查、SQLite事务及React组件，无新增依赖或复制第三方代码。测试连接模式依据微软[accept语义](https://learn.microsoft.com/en-us/windows/win32/api/winsock2/nf-winsock2-accept)及[SO_RCVTIMEO适用范围](https://learn.microsoft.com/en-us/windows/win32/winsock/sol-socket-socket-options)核对：接收连接继承监听套接字属性，读取超时作用于阻塞读取。修复仅显式设置合成服务连接模式，保留原时限及全部业务断言；线上文档阅读不等同本轮测试已通过。

### Windows候选依赖许可核对 — 2026-11-01

以当前锁文件和离线Windows normal/build Cargo树（custom-protocol）核对291项Rust依赖，以本机pnpm树核对208项已安装依赖（包括开发测试依赖）。保留历史说明，新增35个前端版本原始许可；34项来自现有包根目录，saxes 6.0.0来自[官方LICENSE](https://github.com/lddubeau/saxes/blob/v6.0.0/LICENSE)，完整文件Git blob为`187f3ba399862022f4e670b2a3a1dbc6d7e6a800`，本地重算一致，包含其上游ISC和MIT声明。

499项精确版本条目齐全，现存包根许可正文均包含在说明中。11项无包根正文的依赖沿用明确记录的上游／父包补充，未重新在线核验全部历史来源。全锁文件另有203项源码未缓存，均未出现在本次Windows树中；pnpm树中本机不存在的条目另记，不安装补齐。核对不是全平台、链接器或法律审计；最终包还需验证所附说明与源码一致。输入摘要、包列表和限制见`outputs/v1-validation/license-coverage-20261101.json`。未下载或执行新依赖。

### 安装包编译来源 — 2026-11-01

在线核对Tauri CLI tauri-cli-v2.12.4的crates/tauri-bundler/src/bundle/windows/nsis/mod.rs（完整读取）、crates/tauri-bundler/src/bundle.rs中二进制恢复实现及crates/tauri-cli/src/interface/mod.rs中本地工具目录选择。前两项分别说明固定资产与摘要，以及关闭binary_patching后仍在每种包结束时重写主程序的实现。直接打包运行中EXE出现os error32，隔离输入打包成功，未修改第三方CLI代码。

NSIS资产来自https://github.com/tauri-apps/binary-releases/releases/tag/nsis-3.13，ZIP由CLI以SHA1 DB14F8AF2EA346B786C6AE19343F61AAF5E09B8E验证，官方API另提供SHA256 ba63dffc4410ee89193e1cb5a41989991bd77c61068da17e3156d136b7b0b3d8；ZIP未另存，不声称独立重算其SHA256。解包后NSIS.exe SHA1为6D45D4E8CCF18FE1FDAC9164058F356102A2ECF2。完整读取并保留COPYING及RestartManager.nsh中的实际宏定义。

插件来自https://github.com/tauri-apps/nsis-tauri-utils/releases/tag/nsis_tauri_utils-v0.5.3，本地SHA256 5ba143b5db4a87d32d6e7802e033330aae56cbceabe0d1e3ba41948385ad4709与官方API一致，CLI固定SHA1亦匹配。LICENSE-MIT请求404后从目录索引确认实际文件为LICENSE_MIT，全文读取blob7e54d8e4c28e943a545c1bef79f8dfdb2a2affe2并纳入说明。NSIS完整COPYING和插件原许可保存在THIRD_PARTY_NOTICES.txt；该文件原依赖清单属于旧版本，正式发布前尚需按当前锁文件重新核对。

上述工具仅用于本地编译。安装器未运行，未检查真实升级、卸载或系统快捷方式；编译结果及哈希位于outputs/v1-validation/installer-build-info-20261101.json。

### 总览实际采用 — 2026-11-01

在下表固定版本基础上，实际采用shadcn/ui dashboard-01及section-cards、shadcn-admin dashboard/index的可点击指标和主次分区组织方法。Dashboard.tsx/dashboard.css以本项目真实状态、既有回调和主题变量独立实现。没有复制示例代码、收入等演示数据或引入第三方依赖。Radix、Mantine、TanStack、Sonner、Recharts和Tremor继续为候选参考，未接入程序。首次总览只有分类数量分布与保留任务记录，不声称拥有完整使用趋势。

<a id="dashboard-components-20261101"></a>
## 总览与 UI 组件候选调研 — 2026-11-01

用户在设计预览后要求补查高星 GitHub 组件与 Dashboard，并列明适用清单。本轮在线读取，没有下载、安装或运行这些项目。下表为本次 API 快照，提交日期使用默认分支实际提交（UTC），不是 pushed_at；许可证为仓库元数据识别，实际采用代码前仍需核对对应完整许可。

| 固定来源 | Stars | 许可 | 默认分支提交 | 最新发行接口返回 |
|---|---:|---|---|---|
| [shadcn-ui/ui](https://github.com/shadcn-ui/ui/tree/c0d63c339d6cd2fc26135590a54cf1f362269451) | 127104 | MIT | 2026-10-31 | shadcn@4.23.0 |
| [mantinedev/mantine](https://github.com/mantinedev/mantine/tree/f2bc7373a4ffc69cf8af7b6577391f782d4e038c) | 31895 | MIT | 2026-10-29 | 9.7.4 |
| [radix-ui/primitives](https://github.com/radix-ui/primitives/tree/eb3a2b7091293e27df8f9ba906632d8daa3d81a3) | 19461 | MIT | 2026-10-14 | 本轮未取得 latest release |
| [tremorlabs/tremor](https://github.com/tremorlabs/tremor/tree/ca4d588f47820ff3d514d37fa4ee08a4222dec11) | 3684 | Apache-2.0 | 2025-10-10 | 本轮未取得 latest release |
| [TanStack/table](https://github.com/TanStack/table/tree/c14e0221b1e656c7bb35e7b3d4cdf188719a3599) | 28537 | MIT | 2026-10-21 | @tanstack/vue-table-devtools@9.3.1 |
| [TanStack/virtual](https://github.com/TanStack/virtual/tree/0a368c76950610227af7a5d3695e53877f9ad914) | 7178 | MIT | 2026-11-01 | @tanstack/virtual-core@3.19.10 |
| [emilkowalski/sonner](https://github.com/emilkowalski/sonner/tree/8e4662b39255120b62138312058f5d77c0139a5e) | 13118 | MIT | 2026-08-10 | v2.0.8 |
| [recharts/recharts](https://github.com/recharts/recharts/tree/d9cde7341efa2070c129c6344684870b085f711c) | 27680 | MIT | 2026-11-01 | v3.10.1 |
| [satnaing/shadcn-admin](https://github.com/satnaing/shadcn-admin/tree/e16c87f213a5ba5e45964e9b67c792105ec74d26) | 16341 | MIT | 2026-06-11 | v2.2.1 |

已完整读取九仓库 README。另完整读取 shadcn-ui/ui 的 apps/v4/registry/bases/radix/blocks/dashboard-01/page.tsx、同目录 components/section-cards.tsx，mantinedev/mantine 的 packages/@mantine/core/src/components/AppShell/AppShell.tsx，emilkowalski/sonner 的 package.json，satnaing/shadcn-admin 的 src/features/dashboard/index.tsx。固定版本对应上表链接。shadcn-admin 的 pushed_at 为2026-09-10，但默认分支实际提交为2026-06-11，不将推送时间当成功能更新。Radix最后提交为格式化流程、Table为CI配置、Virtual为版本发布、Sonner为README更新，分别评价维护质量。

在线补读官方 Radix Popover 文档、TanStack Virtual introduction、shadcn dashboard block 与 Vite 安装说明。TanStack Table latest column-visibility 链接404，后读取 v8 column-visibility 文档；main已为v9，文档只作交互参考，不作版本兼容依据。Table latest release接口返回Vue开发工具9.3.1，不代表React Table版本。两个项目 latest release未取得，不推定没有发行。图表示例数据为演示内容。

建议优先借鉴 shadcn/ui 和 shadcn-admin 的紧凑总览及分区、Radix的弹层焦点/避让、TanStack Table的列显隐与批量交互。Mantine作为设置行和外框参考，Tremor作为视觉参考；Virtual按真实瓶颈选择，Sonner和Recharts按实际需要评估局部引入。当前项目为React19/Tauri/Vite/自有CSS/Lucide，未加入Tailwind或上述组件库。

新增总览候选围绕真实资源统计、待处理项、运行任务、常用资源、来源状态和近期活动组织。现有记录最多100条，不能推导完整历史使用率或七日增长；复用已有快照、任务和缓存，进入总览不另触发全库扫描。研究通过只表示来源可读和适用性判断，组件接入、对比度、原生交互和性能均尚未验证。


<a id="online-ui-review-20261101"></a>
## Online UI review — 2026-11-01

Both repositories were read online through the GitHub connector at fixed commits. They were not cloned, installed, or downloaded as local third-party files. No launcher, detector, hook, live service, command in a Markdown example, or automatic audit from either repository was executed. This is a text-informed source and native UI review, not a successful run of Impeccable. Existing application checks and their results are recorded separately.

**VoltAgent/awesome-design-md:** commit [`fcc70284932276d085f01ef9f83edde90b1258cb`](https://github.com/VoltAgent/awesome-design-md/commit/fcc70284932276d085f01ef9f83edde90b1258cb), committed 2026-10-28; MIT. Fully read:

| Fixed-commit file | UTF-8 bytes | Lines including final empty line |
|---|---:|---:|
| [design-md/linear.app/DESIGN.md](https://github.com/VoltAgent/awesome-design-md/blob/fcc70284932276d085f01ef9f83edde90b1258cb/design-md/linear.app/DESIGN.md) | 24,354 | 549 |
| [design-md/notion/DESIGN.md](https://github.com/VoltAgent/awesome-design-md/blob/fcc70284932276d085f01ef9f83edde90b1258cb/design-md/notion/DESIGN.md) | 35,176 | 822 |
| [design-md/raycast/DESIGN.md](https://github.com/VoltAgent/awesome-design-md/blob/fcc70284932276d085f01ef9f83edde90b1258cb/design-md/raycast/DESIGN.md) | 41,275 | 670 |

Necessary support read in full: LICENSE (1,066 bytes), CONTRIBUTING.md (912 bytes), and the three corresponding directory README.md files (213/209/211 bytes). Root README.md lines 1–92 were read for source context only; it was not treated as a full-file review. Other design documents, external previews and the live brand websites were not read. The design documents describe extracted website observations, mostly marketing pages; they do not establish official desktop product behavior. Adopted methods: surface and text hierarchy, limited primary emphasis, compact toolbars and meaningful category color. Existing themes, typography preferences, functional navigation and confirmations remain authoritative. No copied component code or brand-specific theme was introduced.

**pbakaus/impeccable:** commit [`4f956490f0056ae1ff5ea80372cf56e83c001d3c`](https://github.com/pbakaus/impeccable/commit/4f956490f0056ae1ff5ea80372cf56e83c001d3c), committed 2026-10-31; Apache-2.0. Fully read 23 UTF-8 files, 232,785 bytes:

- AGENTS.md; README.md; LICENSE; [.agents/skills/impeccable/SKILL.md](https://github.com/pbakaus/impeccable/blob/4f956490f0056ae1ff5ea80372cf56e83c001d3c/.agents/skills/impeccable/SKILL.md); [skill/SKILL.src.md](https://github.com/pbakaus/impeccable/blob/4f956490f0056ae1ff5ea80372cf56e83c001d3c/skill/SKILL.src.md).
- Under [skill/reference/](https://github.com/pbakaus/impeccable/tree/4f956490f0056ae1ff5ea80372cf56e83c001d3c/skill/reference): operate.md, mode-operate.md, mode-read.md, audit.md, audit.native.md, critique.md, layout.md, typeset.md, polish.md, harden.md, clarify.md, optimize.md, colorize.md, distill.md, adapt.md, onboard.md, component-review.md and craft-floor.md.

Adopted methods: Operate for management tasks, Read for documentation, task-based grouping, readable existing typography, consistent units, in-place errors and recovery, and measurement before performance claims. The native-only audit was read to distinguish platform assumptions; this Tauri application uses WebView2, so its interface is reviewed as desktop web content. Unrelated live/generate/new-work operations, mobile-specific material, runtime CLI/browser injection implementation and the complete large CLI contract were not read. Generated provider copies were not all re-read. Advice requiring installation, new fonts, unrelated visual direction, compulsory card removal or large animation was not adopted. Reference text does not supersede user requirements or grant file, network or execution authority.

The resulting project-specific choices are summarized in [DESIGN.md](DESIGN.md). UI implementation remains original React/CSS work using existing dependencies.

Skill Manager is an independent implementation. No Skillshare or Skills Manager source code was copied into the application.

## Configuration and lifecycle continuation — 2026-10-30

Configuration reference handling, canonical Skill ownership, staged updates, fixed native probes, exact system-entry removal, and source-scoped version observations extend the existing implementation. No external source code or new dependency version was introduced. The existing windows-sys dependency enables its Registry feature; existing GitHub cache, SQLite writer, process/path controls, React and Lucide remain in use. Fixed probe adapters are limited to the already inspected Agent-Reach and Playwright MCP entry semantics; they do not establish platform availability or approve unverified forks. Native desktop, real tool and full performance acceptance remain separate from isolated test evidence.

Explicit automatic-update grants, per-phase scheduling, resource-side ownership records, multi-version removal and hard-link-aware size accounting are original extensions of those same services. Read-only adoption adapters were checked against the locally installed Agent Reach package metadata and wrapper, Playwright MCP CLI/package metadata, and DragonCodexBoot version/configuration/license files; no third-party application code was copied or run to implement adoption. The package declarations do not prove the provenance of local modifications. Aggregate cache diagnostics expose counts only; native startup, interaction and stability measurements remain separate acceptance work.

The narrow Edge browser connection independently implements the official MCP initialize/tools-call exchange against the already installed Playwright MCP. Its fixed entry binding includes the actual Playwright control bundles; child-only environment filtering prevents inherited configuration or initialization scripts from changing the adopted connection. No third-party implementation code was copied. Existing extension credentials are naturally inherited, never extracted, copied into configuration, or logged. Actual browser/tool results and persistent connection ownership are recorded separately; a successful CLI exit does not establish browser capability.

Package preparation is implemented separately from ZIP extraction. The wheel RECORD and npm exact-version integrity checks are original code based on the package formats and exact upstream metadata. Gzip handling reuses the already locked and cached `flate2` 1.1.10 (MIT OR Apache-2.0), now declared directly; no dependency version or new download was introduced. Synthetic builder tests alone do not prove native installation. The 2026-11-01 isolated native npm acceptance separately completed official 0.0.82 installation, 0.0.83 preparation/verification/switch and original-version preservation; its report binds the candidate bytes. That evidence does not claim Python installation, automatic native updates or browser capability.

## Agent Resource Manager development — 2026-10-28

The resource catalogue, registered action supervision, ZIP ownership/install/removal pipeline, command palette and appearance choices are implemented within the existing application. They reuse its SQLite single writer, task scheduler, path checks, ZIP/SHA-256 facilities, React components and Lucide icons. No new frontend dependency or external application code was added for this slice. The package locks retain the existing dependency versions and notices.

An original app-symbol raster was generated with the available ImageGen tool. No specific Imagen model/version is claimed. The editable design materials and transparent original are retained in the separate development design directory; standard Tauri icon conversion creates the required sizes. Those design materials are not an online runtime dependency. Final visual acceptance and packaged icon integration are recorded separately.

The current Windows development environment uses verified official Rust component archives and Microsoft compiler/SDK packages in the selected development environment. It does not install a global compiler or change the registry. One remaining Rust 1.99 diagnostic reports ordinary MSVC import-library progress as linker output; this matches the [upstream Rust report](https://github.com/rust-lang/rust/issues/161164). The project does not suppress linker diagnostics to claim warning-free validation.

v0.1.4 independently adds collapsible native file groups, unified vertical scrolling, checked byte/version change notices with deferred focus checks, local declared-version display refresh, and a lower-luminance warm gray-green eye theme. It introduces no new external source, copied code or dependency. Ninety Rust tests, eight Node tests, TypeScript/Vite, formatting/Clippy, optimized Windows/NSIS builds, 14 native UI regressions and six focused behaviors passed. Focused tests use private-source reads and installations/edits only under owned work fixtures; no remote writes. The installer wizard and real model invocation remain unverified.

v0.1.3 independently adds distinct skill/repository counts, direct source navigation, bounded sidebar activity history, required/optional runtime classification, verified automatic association and observation-based change summaries, plus bounded in-memory reuse of immutable remote bytes within one check. It introduces no new external reference, copied code or dependency. Existing sources and license notices remain applicable. This unpublished local candidate passed 88 Rust and 8 list/link tests, static/frontend checks, 14 native UI behaviors with synthetic Skills, and 4 private-source read-only/association checks. Optimized Windows and NSIS artifacts were built; the optimized app's startup/data path/debug-port checks passed. The installer wizard, real repository writes and model invocation remain unverified.

v0.1.2 implements the compact library, search/filter/pagination logic, selected-item checks and detail drawer within the existing React/Tauri application. It introduces no new external design/code reference or dependency. Existing method references and dependency licenses below remain applicable.

v0.1.1 uses the [official GitHub fine-grained token URL parameters](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#pre-filling-fine-grained-personal-access-token-details-using-url-parameters) to prefill the creation form. It does not create a token through the GitHub connector or reuse its credentials. The URL permission correction follows the installed Tauri opener plugin's documented scoped command configuration; only explicit HTTP(S) links are allowed.

| Source | Actual use |
| --- | --- |
| [Agent Skills specification](https://agentskills.io/specification) | SKILL.md frontmatter and optional resource layout |
| [Skillshare](https://github.com/runkids/skillshare) | Method reference: one canonical runtime source and explicit client links |
| [Skills Manager](https://github.com/xingkongliang/skills-manager) | Method reference: skill list, details and source/status organization |
| [Tauri 2](https://v2.tauri.app/) | Desktop application framework and dialog/opener plugins |
| [GitHub REST API](https://docs.github.com/en/rest) | Authenticated repository content, trees, commits and references |

Runtime/build dependencies are declared in package.json, pnpm-lock.yaml, Cargo.toml and Cargo.lock. These lockfiles record the actual resolved versions. Their upstream license terms remain applicable; a distribution license inventory is prepared with the candidate artifacts.

`THIRD_PARTY_NOTICES.txt` accompanies both installer and portable distributions. The v0.1.9 inventory includes 689 locked packages (516 Rust and 173 npm), nested notices, Rust standard-library notices, and Microsoft WebView2 SDK 1.0.3800.47 LICENSE/NOTICE. The SDK loader binaries were checked against the matching crate's files. The inventory intentionally includes build/test/other-platform entries; entries without original notice text remain explicitly listed. Resolved cross-platform packages do not all link into the Windows executable. This does not choose the application's own open-source license.

The local build environment used a private adaptation of [mmozeiko's portable MSVC helper](https://gist.github.com/mmozeiko/7f3162ec2988e81e56d5c4e22cde9977), revision `49b58850aa5e5c1e65f090d4651ee76607883e11`, solely to obtain hash-checked Microsoft packages. [lessmsi 2.12.9](https://github.com/activescott/lessmsi/releases/tag/v2.12.9) (MIT) extracts SDK MSI files without installing them. Build helpers and Microsoft tools are not bundled with the application. Microsoft compiler/SDK terms apply separately. No system-installed Visual Studio is required by that local setup.

## v0.1.5 local refinement
Categories, shortcuts and sidebar interactions are implemented within the existing codebase. No new external code adaptation, package or downloaded dependency was introduced. Existing architectural references and license notices remain applicable.

## v0.1.6 local interaction refinement
Selected-row dragging, floating menus, scope explanations, extra-file status, category ordering, keyboard selection and favorites were implemented in the existing codebase. No new package, downloaded dependency or external code adaptation was introduced.

## v0.1.7 file and information refinement
Merged file availability, transient attachment selection, fixed-commit preview/export/download and source dependency/verification presentation reuse this application's existing GitHub, transaction, Markdown and ZIP facilities. No new package, downloaded dependency or external code adaptation was introduced. Source statements remain distinct from local invocation evidence.

## v0.1.8 transfer and verification refinement
First upload, independent fixed-commit verification, optional-file receipts/restoration, existing-client adoption and structured runtime checks are implemented within this codebase. No new dependency, download or external code adaptation was introduced. Codex directory-link behavior was checked against the [official Skill documentation](https://learn.chatgpt.com/docs/build-skills). HTTP tests use an isolated local fake GitHub service, not a real repository. Windows object-lock deletion, dependency classification and transport-race fixes are independent maintenance changes; existing dependency licenses continue to apply.

## v0.1.9 tasks, network and external resources

The task scheduler, persistent navigation history, client layout/batch controls, external resource classification/bindings and ZIP-only reference conversion are independent changes within this application. No new third-party application implementation was copied or adapted. The canonical Skill and external resources stay at their existing locations; test fixtures and development records are distinct from application runtime output.

Transport reuse and proxy support use the existing [reqwest 0.12.28 documentation](https://docs.rs/reqwest/0.12.28/reqwest/). Conditional reads, foreground request scheduling and rate-limit behavior refer to [GitHub's REST best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api). Standard Git blob length/header/object identity follows [Git Internals: Git Objects](https://git-scm.com/book/en/v2/Git-Internals-Git-Objects); SHA-1 is used for Git object compatibility, alongside existing SHA-256 local/content evidence, rather than replacing update safety.

Cargo adds sha1 0.10.7 for Git blob identity and enables reqwest system-proxy/SOCKS features. The lockfile consequently adds windows-registry 0.6.1, system-configuration 0.7.0, system-configuration-sys 0.6.0 and core-foundation 0.9.4. These are normal upstream library dependencies, including other-platform entries; no downloaded source is executed as an external helper. Their original license notices are included in the refreshed distribution inventory. No new frontend package is introduced.

Synthetic HTTP and filesystem checks exercise cache identity/eviction/coalescing, conditional reads, GET-only retries, cancellation, independent fresh upload readback, external originals remaining unchanged and only the chosen ZIP being added. Such tests do not verify a user's actual VPN route, private GitHub writes, model invocation, installer interaction or another computer. Final candidate-wide verification is recorded separately after execution; no benchmark speed claim is inferred from cache design.

## v0.2.0 workspace and dual-source resources

Main-window tabs, normal native-window detach/return, scoped collapsible outlines, in-memory pane drafts and coordinated close behavior are independent changes in the existing React/Tauri application. They reuse its existing window APIs, single live Manager, task service, SQLite, credential store and network transport. No floating-overlay window framework or second application state store was introduced.

Dual-source external evidence, exact fixed-commit repository mappings, explicit ambiguous candidates, role/reference separation and batch management reuse the existing GitHub readers and semantic reference checks. Mixed necessary-resource export reuses the existing ZIP writer and provenance contract. Final package preflight applies the existing private-resource filename/path guard to logical and actual local/remote paths without adding a new content-scanning rule. Original Skill/external files remain unchanged; export resource output is only the chosen ZIP, while normal Manager state retains its existing independent database location.

No new dependency, downloaded package or third-party project code was introduced for v0.2.0. Existing lockfiles and distribution license notices remain applicable; the references above retain their original scope. Synthetic filesystem/HTTP regressions cover reference classification, fixed-commit lookup, optional choices, partial batch failure and protected paths. Final candidate-wide and native multiwindow verification is still in progress; these source records do not claim actual model invocation, real private repository writes, installer execution or another computer's behavior.


## v0.2.1 local changes

Scroll sizing, same-window split focus/visibility, left outline, automatic external mapping and storage lifecycle reuse the existing React, Tauri, Git tree/blob hashing, SQLite and Windows APIs. These application changes are independently implemented for the confirmed requirements, with no new dependency download. New local storage/developer path configuration and verification fixtures are private metadata, excluded from public source and portable archives.

`src-tauri/installer.nsi` adapts the installer template embedded in the already installed Tauri CLI `@tauri-apps/cli-win32-x64-msvc` 2.12.4 (MIT OR Apache-2.0; original SHA256 `a0eea9f8e16a33df772f74499beb886fece8e006b7c16943f4fa84ebbc6ef450`). It retains the standard installer and changes only the initial default directory and missing-D-drive handling before any output directory is created. Explicit `/D=` and the recorded upgrade location take precedence. Upstream: [Tauri NSIS installer template](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.4/crates/tauri-bundler/src/bundle/windows/templates/installer.nsi). The existing Tauri license texts in `THIRD_PARTY_NOTICES.txt` remain included; no network download was needed for this template.

## v0.2.2 local changes

Visual hierarchy, intrinsic header layout, zoom-aware scoped outline navigation, derived reference presentation and automatic-record proof refresh are independently implemented in the existing React/Tauri application. They reuse existing browser geometry, semantic reference identities, task/SQLite state and Git tree/blob verification. No new external code, download or dependency is introduced. Existing upstream references and licenses retain their prior scope. Native UI and protocol tests are reported separately; controlled IPC display scenarios do not establish real private repository writes.


## v0.2.3 export clarity and contrast

Authoritative export manifests, memory-only shared choices, one-time ordinary environment attachments and three-theme contrast are independent changes within the existing application. Existing Tauri events, React state, ZIP, canonical-path and immutable GitHub read facilities are reused. No new external code, package or downloaded dependency was introduced; existing notices remain applicable. Verification distinguishes actual native IPC/ZIP output, synthetic protocol cases, style-only samples and unverified installer/save-dialog visuals.


## v0.2.4 file groups, automatic scope and history
This update is original local work on the existing application: shared resource rows, flat groups, a read-only history view, stable fold identities and automatic local scope evidence. It reuses the existing React/Tauri/Rust dependencies and resource proof/export protocols. No new third-party dependency, downloaded source or adapted external code was introduced. The existing sources and license notices above remain applicable.


## v0.2.5 layout and read performance

The layout uses the user's supplied ChatGPT screenshots as a method reference for compact navigation, consistent hierarchy and aligned actions. No third-party interface source code or screenshot asset is incorporated. Status presentation, client task/usage/repair behavior, settings sections and bounded document reads are independent maintenance of the existing React/Tauri/Rust application. Existing dependencies and license notices remain applicable; no new package, download or adapted project code was introduced.

Performance evidence compares actual isolated native windows with synthetic local Skill folders, exact executable hashes, identical100-Skill/20-round inputs and request counts. File and documentation measurements are reported separately; no private GitHub, real model call or VPN benchmark is inferred.


<a id="v026-method-references"></a>
## v0.2.6 method references — 2026-10-25

Read-only comparison of public repositories informed the following independently implemented UI and compatibility changes. No third-party application source was copied, installed or executed; no new dependency was introduced. Star counts are a point-in-time research snapshot, not a quality guarantee. The existing application framework, runtime ownership, proof and recovery contracts remain authoritative.

| Repository / fixed commit | Upstream license | Method considered / adopted |
| --- | --- | --- |
| [xingkongliang/skills-manager @7a22192](https://github.com/xingkongliang/skills-manager/tree/7a2219219287f4ef4c543fc169ebcc5b0bff085c) | MIT | Compact search/filter toolbar, category chips and card information hierarchy. Independently implement within existing views. |
| [skillsgate/skillsgate @4f33578](https://github.com/skillsgate/skillsgate/tree/4f33578de42c1635d4305a606310e7f812dc6dbd) | MIT | Per-client action clarity and shared-source removal protection scenario. Keep existing link-only disconnect proof. |
| [runkids/skillshare @a5477eb](https://github.com/runkids/skillshare/tree/a5477ebe6b0975c3ecf479b417b4db9ae30e7609) | MIT | Windows directory-link and local-modification preservation methods; existing implementation remains in place. |
| [vercel-labs/skills @a80e4c9](https://github.com/vercel-labs/skills/tree/a80e4c9d12d607631249d4d7d059f835d4b2f13a) | MIT | Client adaptation and explicit source/hash identities; no silent copy fallback adopted. |
| [qufei1993/skills-hub @1647138](https://github.com/qufei1993/skills-hub/tree/1647138a35c7d4cb4808f11f724cbaa77609f0de) | MIT | Card/filter alignment and clear batch-completion feedback. |
| [jiweiyeah/Skills-Manager @bc3c8bd](https://github.com/jiweiyeah/Skills-Manager/tree/bc3c8bd68cfe9a58a80b7c3631a8ed531d950823) | MIT | On-demand heavy views and batch-selection presentation; no extra feature/dependency added. |
| [rohitg00/skillkit @d2e5c34](https://github.com/rohitg00/skillkit/tree/d2e5c346f73325c326820efd3188dcf2b6eb704f) | Apache-2.0 | Evaluated CLI/TUI approach; no direct adoption in this desktop refinement. |
| [lcdzzz/lcdzzz-skill-admin @e5d8103](https://github.com/lcdzzz/lcdzzz-skill-admin/tree/e5d81035a36419de3e50c6547310e8d094473f0b) | MIT | Explicit import paths/conflicts and separate card checkbox/detail actions. Copy synchronization and name-only merging were not adopted. |

The user's reference screenshots informed spacing and action hierarchy. Existing icon/dependency notices remain applicable. Tests use isolated synthetic files; third-party project performance claims are not evidence for this program.


<a id="v027-method-references"></a>
## v0.2.7 method references — 2026-10-25

Read-only source/docs review used the fixed public commits below, together with the user's GPT screenshots. No upstream application source, screenshot asset or dependency was copied, installed or executed. These are methods for independently maintaining this existing application; all prior ownership, source-proof, recovery and data contracts remain.

| Fixed source / upstream license | Method adopted / boundary |
| --- | --- |
| [xingkongliang/skills-manager MySkills.tsx](https://github.com/xingkongliang/skills-manager/blob/7a2219219287f4ef4c543fc169ebcc5b0bff085c/src/views/MySkills.tsx#L1532), MIT | Compact toolbar and colored category hierarchy. Preserve our stable category identities rather than index-dependent colors. |
| [skillsgate/skillsgate home.tsx](https://github.com/skillsgate/skillsgate/blob/4f33578de42c1635d4305a606310e7f812dc6dbd/apps/desktop/src/renderer/routes/home.tsx#L2523), MIT | Considered split-pane and anchored-action presentation. Our independent help also handles viewport collision, focus and zoom. |
| [lcdzzz/lcdzzz-skill-admin main.tsx](https://github.com/lcdzzz/lcdzzz-skill-admin/blob/e5d81035a36419de3e50c6547310e8d094473f0b/src/main.tsx#L788), MIT | Compact card identity and folded roots. Do not adopt copy synchronization or name-only merging. |
| [qufei1993/skills-hub design guidelines](https://github.com/qufei1993/skills-hub/blob/1647138a35c7d4cb4808f11f724cbaa77609f0de/docs/UI-DESIGN-GUIDELINES.zh.md), MIT | Semantic colors, spacing, progressive explanations and avoiding nested decoration/duplicate badges. SkillCard body-portal method reviewed. |
| [jiweiyeah/Skills-Manager index.css](https://github.com/jiweiyeah/Skills-Manager/blob/bc3c8bd68cfe9a58a80b7c3631a8ed531d950823/src/index.css), MIT | Separate page/sidebar/card/popover/foreground roles; do not reuse its palette as a claim of exact GPT colors. |

At the research snapshot: skills-manager 6812 stars/latest commit 10-21/v1.43.0; skillsgate 1405/10-13/desktop-v0.8.1; lcdzzz-skill-admin 2/10-12/v0.0.8; skills-hub 1823/main commit10-16/v1.0.1 (repository pushed10-23); jiweiyeah Skills-Manager1037/latest docs commit09-10/v2.2.0. All five were unarchived and MIT. Activity dates/stars describe only this snapshot, not a maintenance guarantee. Fixed source links above are the implementation evidence.

The supplied GPT image informed dark main #181818, sidebar #1c1a1e and input #363636. The application uses its own semantic light/eye palettes and independent component colors, with actual composed-state contrast verification.


<a id="v028-recovery-ci"></a>
## v0.2.8：恢复与候选构建

- 基于本项目现有选择、租约和窗口协议独立修复，不复制其他管理器代码；生产依赖保持锁定。
- Tauri事件订阅及窗口生命周期接口：[Tauri 2.12.5源码](https://github.com/tauri-apps/tauri/tree/tauri-v2.12.5/crates/tauri/src)。用于核对监听错误传播，恢复与只读追平由本项目实现。
- 云端候选上传复用官方 [actions/upload-artifact v7.0.2](https://github.com/actions/upload-artifact/tree/cf430e030ddbb5b0abf93d22962f4752f3646cd9)，固定精确提交、最小读取权限、7天保留；只生成工作流产物，不创建Release或标签。

- 实际React hooks故障回归使用MIT许可的开发测试依赖[jsdom 30.1.3](https://github.com/jsdom/jsdom/releases/tag/v30.1.3)，配合既有ReactDOM与TypeScript；仅测试环境使用，不进入应用运行包。生产依赖锁定版本保持。

## v0.2.9 本地事件与增量检查

- 固定依赖 [notify 8.2.1](https://github.com/notify-rs/notify/tree/notify-8.2.1)：复用 Windows 原生 ReadDirectoryChangesW，项目自行实现防抖、目录授权范围、代际隔离、单调度和空轮次去重。notify 为 CC0-1.0；notify-types 及依赖保留各自许可。没有复制第三方管理器整套代码或改变已有来源规则。

## Agent Resource Manager：本地后台与 MCP（开发中）

- 按官方 [MCP stdio 传输](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)、[初始化生命周期](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)和[工具协议](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)独立实现有限工具映射及换行 JSON-RPC，不复制第三方服务实现，不暴露通用 Shell 或人工确认接口。
- Windows IPC 依据微软[命名管道访问权限](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights)、[重叠 I/O](https://learn.microsoft.com/en-us/windows/win32/ipc/synchronous-and-overlapped-input-and-output)和 [CancelIoEx](https://learn.microsoft.com/en-us/windows/win32/api/ioapiset/nf-ioapiset-cancelioex)说明独立实现；显式使用锁文件已有的 windows-sys 0.61.2（MIT/Apache-2.0），未下载新版本。
- 托盘及事件循环使用现有 Tauri 2.12.5 的 tray-icon 功能和本机已安装源码核对的 run_return / RunEvent::Exit 接口；保留现有依赖许可。后台停机必须显式执行，不能把进程退出假称 Rust 栈析构已发生。

## Agent Resource Manager：GitHub 发行文件（开发中）

- 依据 GitHub 官方[发行版接口](https://docs.github.com/en/rest/releases/releases)与[发行资产接口](https://docs.github.com/en/rest/releases/assets)独立实现固定版本、资产身份、下载地址及可选 SHA-256 的核对；处理二进制响应与可信重定向。方法参考，未复制第三方管理器代码。
- 复用本项目的 GitHub API、系统凭据、代理、网络门控、任务取消、空间检查和最小 ZIP 安装；流式传输沿用已锁定的 reqwest、sha2 与 zip。未新增生产依赖。合成 HTTP 服务仅存在于测试中，不能给生产下载传入任意地址。
- 跨重启下载记录、只读续传预览与离线完成回执由本项目实现，复用现有SQLite单写入方；核对本机已锁定reqwest 0.12.28的blocking读取超时实现，并以限速合成流验证。未新增外部代码借鉴或依赖。


## Agent Resource Manager：维护、快捷动作与个人信息（开发中）

- 维护时间策略、20步管理重做、快捷动作版本校验、独立别名／备注及常用筛选由本项目实现；复用既有Rust任务服务、SQLite事务、chrono、React和主题变量，没有新增第三方代码或运行依赖。
- 行为测试沿用现有Node、ReactDOM和jsdom；真实组件事件与模拟数据库核对分别保留，不以源码搜索或模拟结果代替原生桌面验收。

- 技能库稳定阅读与相邻身份选择由本项目实现；复用既有分页、会话草稿与CSS缩放换算，React DOM更新前后生命周期用于补偿滚动和焦点，不新增外部代码、图片或依赖。

- 常用调用模板复用本项目动作定义／参数校验、SQLite单写入与任务锁，独立实现按字段记录、绑定失效和准备后明确执行；工具页恢复沿用现有会话草稿与本地共享目录缓存。没有新增第三方代码或依赖，未将任何调用或卸载许可放入恢复草稿。

- 跨资源依赖关系及卸载影响核对由本项目实现，复用现有SQLite事务、实时写入方、任务互斥和React详情区；关系本身不授予文件归属。工具与Skill共用结构化身份，按需展示双向关系，Agent只读，不新增第三方代码、图像或运行依赖。

- 来源健康、旧新来源预览和安装证据保留由本项目实现，复用现有GitHub请求链、固定提交文档读取、SQLite事务、唯一写入方及React详情。未新增第三方代码或依赖；HTTP验证使用现有本地合成服务，远端身份可访问与本地能力可用分别记录。

- 场景、闲置释放、任务结果索引、问题归并、脱敏诊断和空间明细由本项目实现，复用既有单写入方、任务记录、进程归属、关系表、React详情与设置入口。空间和结果检查复用现有路径保护与Windows目录联接依赖；仅在独立测试夹具中验证链接，不新增第三方代码或依赖。

- 条件自动更新、三工具只读适配与调用证据失效由本项目实现，复用现有下载、任务、进程、来源和SQLite事务；没有复制第三方实现代码。性能验收使用现有Windows UIAutomation及DWM接口。管理员宿主的WebView2环境覆盖限制核对了[Microsoft WebView2安全说明](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/security#for-an-elevated-host-app-use-appropriate-override-flags)；不为测试改变系统策略或加入生产调试后门。

## 2026-11-01 官方软件包准备与外框（开发中）

- 固定读取 Agent Reach 官方 GitHub release wheel、PyPI 精确 wheel 元数据，以及 @playwright/mcp / playwright / playwright-core 官方 npm 元数据；已读取的版本、来源URL、许可及摘要在 `outputs/v1-validation/runtime-package-metadata-20261031.json`、`official-prior-runtime-compatibility-20261031.json` 留据。程序自行实现有限wheel RECORD校验、精确依赖闭包、TGZ安全展开和专用目录准备，没有复制第三方管理器代码。元数据检查不等于下载或执行资产。
- 显式使用已在本机缓存及锁文件中的 flate2 1.1.10（MIT/Apache-2.0）读取gzip流；未为本批修改下载新的Rust组件。GNU/PAX tar布局、wheel和npm来源记录各自校验，不将生成运行目录冒称上游发布的ZIP，也不把静态摘要写为运行验证成功。
- 顶部侧栏开关及外框布局依据用户提供的ChatGPT截图调整；复用本项目现有导航、状态、拖宽、页签和React portal。没有复制ChatGPT代码、素材或无关菜单。
- 原生验收复用Windows UIAutomation、DWM和本项目测试夹具。修正新旧程序实际退出按钮的差异，并让测试客户端按驱动进程exit而不是被GUI继承的管道close等待；退出有截止且不强制结束正常测试进程。旧的受阻记录原样保留。

<a id="workspace-ui-review-20261101"></a>
## UI 再审阅：卡片与功能分组 — 2026-11-01

用户选定 ChatGPT 式简洁框架＋Skills Manager 卡片和彩色分类，并要求重点简化设置。继续沿用上节两个设计资料库的固定版本及全文读取证据，另在线完整读完以下 7 个实际界面来源文件，共 154,183 UTF-8 字节／4,491 行（含末尾空行）。没有克隆、保存其源码到本地、下载字体、安装依赖或执行仓库程序。

| 固定仓库／许可 | 完整读取文件 | Git blob SHA |
|---|---|---|
| [xingkongliang/skills-manager @7a221921](https://github.com/xingkongliang/skills-manager/tree/7a2219219287f4ef4c543fc169ebcc5b0bff085c)，MIT | src/views/MySkills.tsx | e1ec916e67fd4f0ee70a1f228807b2fb1d1a1557 |
| 同上 | src/index.css | 5214c78a6cd5c3a176d970ceac6c39ffd6d2db1d |
| 同上 | src/lib/skillTags.ts | eead7384def922a5ae946002d5085eb748a1e430 |
| 同上 | LICENSE | 2ca9080b0ef5639a1205cafb14ec77a4ace980e6 |
| [lcdzzz/lcdzzz-skill-admin @e5d81035](https://github.com/lcdzzz/lcdzzz-skill-admin/tree/e5d81035a36419de3e50c6547310e8d094473f0b)，MIT | src/main.tsx | 731ba0a80042418692e06f2e9a9184b2bcb7ee42 |
| 同上 | src/style.module.css | 3bc38d4baab7e986464722aae4985cc5a6ae4760 |
| 同上 | LICENSE | 2098819dc913c15682f2e66c57bcb7dab9cbc4f3 |

实际采用标题优先、彩色分类、来源／客户端次级信息、选择与详情动作分离的组织方法，在本项目现有组件与回调上独立实现；没有复制组件，也不采用复制同步、按名称合并、按标签位置决定颜色或新拖拽依赖。九组设置采用本项目自身功能划分、受控分组选择和保留挂载，不把仓库外部指令升级为本项目权限。

本次还重新核对 awesome-design-md HEAD 仍为 fcc70284932276d085f01ef9f83edde90b1258cb；Impeccable HEAD 更新为 f5c80432f883a0ee437735305eafc2a9e1bdb7a0。在线比较后者自既用4f956490版本的2次提交，变化在检测器／安装命令及CLI合同，所采用的skill/reference设计引用没有变化，因此继续用已完整阅读的4f956490固定来源。仅核对差异元数据，不宣称阅读或运行新检测器。此前未读的其余设计、品牌现场和外部检查能力仍未读／未运行。

## 安装器品牌兼容核对 — 2026-11-01

沿用已安装 Tauri CLI 2.12.4 的官方安装模板及原有 MIT／Apache-2.0 许可。在本地原生模块中只读提取并完整核对 CheckIfAppIsRunning、IsShortcutTarget、SetShortcutTarget 三个宏，确认进程检查及快捷方式读写语义。在线读取对应 utils.nsh 返回404，本轮依据本机实际嵌入实现核对，未将该请求计为成功阅读全文。

本项目独立增加稳定的历史安装身份、旧名快捷方式的精确目标处理及旧程序退出只读检查。安装器编译和实际升级验证待执行。设计仓库采用范围继续以上述固定版本记录为准。

## 原生验收助手的线程诊断 — 2026-11-07

在线阅读微软官方 [InvokePattern.Invoke](https://learn.microsoft.com/en-us/dotnet/api/system.windows.automation.invokepattern.invoke?view=windowsdesktop-10.0) 和 [UI Automation线程约束](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-threading)，参考提供者调用可能阻塞、无窗口MTA辅助线程及COM对象寿命的说明，独立实现可选的并发观察诊断。未复制第三方程序或引入依赖。诊断仍执行一次真实控件操作并核对动作专属结果，等待输入调用成功返回后才返回样本；单独标注测量方式，不替代原生完整验收或改写历史报告。网页阅读不等于运行微软检查工具。

## 原生测量准备与定位修正 — 2026-11-08

按本项目当前独立侧栏和React Portal结构修复OperationSummary定位，直接复用现有几何计算、组件与交互，没有新增外部组件或依赖。原生选项定位及测量进程内存对照为项目自有验收实现，诊断专用构建和正式候选分别绑定。

进一步在线核对微软官方[AttachThreadInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-attachthreadinput)的队列前提、返回值及线程边界，参考API使用约束补齐一次消息队列初始化和真实调用结果记录。没有复制第三方实现。实际V1MrRX仍收到输入连接拒绝及窗口激活失败，因此不宣称该补充解决了全部前台问题，也不修改系统权限。网页资料审阅、11项策略检查、实际窗口行为及完整性能验收分别记录。

在线核对微软官方[IsEnabledProperty](https://learn.microsoft.com/en-us/dotnet/api/system.windows.automation.automationelement.isenabledproperty?view=windowsdesktop-10.0)与[ComboBox控制类型](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-supportcomboboxcontroltype)，用于区分可用状态默认值、父子状态及选择框的原生接口约束。仅作诊断方法参考，没有据此取消选项可用性断言。新增CDP只读状态对照和同窗口UIA只读观察均为项目自身诊断实现，未引入外部依赖，诊断结果不替代正式候选验收。另阅读虚拟桌面和DWM可见性官方说明，但实际只读探查未取得有效桌面归属结果，不将其记为已排除原因。

## 任务进度与原生数值控件 — 2026-11-12

任务事件复用、无通知补读及订阅释放由本项目实现，沿用现有React与Tauri事件接口，没有引入外部组件或依赖。模拟回归验证读取次数和结果完整性，原生进程内存是否收敛另行验证。

在线阅读微软官方[AutomationElement.SetFocus](https://learn.microsoft.com/en-us/dotnet/api/system.windows.automation.automationelement.setfocus?view=windowsdesktop-9.0)、[SetForegroundWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow)及[Spinner控件接口](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-supportspinnercontroltype)，参考提供者依赖、系统激活限制和可用数值接口。独立调整验收助手的单次原生激活及RangeValue优先路径；不将所有Spinner都假定为支持RangeValue，不移除输入／身份保护，不复制第三方代码。纯边界测试和编译不替代真实桌面行为，也不将网页阅读说成运行微软工具。
