# cpm-install

公开 CPM 引导端点。预期主机 `get.peanut-harness.dev`。故意不含私有产品二进制或凭据。

## 当前行为

`install.sh` 与 `install.ps1` 经 `bootstrap.mjs install` 解析 manifest、按事务原子安装已验证 CLI runtime 到 `CPM_HOME`（默认 `~/.peanut/cpm`），stdout 输出结构化身份 JSON，警告只写 stderr。`releases.json` 为 schema v2 且 stable 为空，因此公共安装仍失败关闭（exit 1，不改项目）。信任锚固定在 `trust-anchors.mjs`（双锚轮换），生产路径不读环境变量；`CPM_TEST_*` 注入仅在 `CPM_TEST_MODE=1` + 本地 manifest 时生效。

已安装 CLI 的 `product resolve` 校验签名 Lite 产品 catalog（`cli/product-catalog.mjs`，`lite-product-v1`）：独立产品信任锚（`cli/product-trust-anchors.mjs`，未签发前为空即全拒）、Host/Core URL+SHA-256+目录包 digest 绑定、禁重定向、同版本不可改写、descriptor 逐字段核对。

`cpm lite install|upgrade|repair` 把 Host 写入 `extensions/peanut-pod-lite-host`、Core 写入 `peanut-plugins/plugins/<id>/<v>`、原子重写 schema v2 `installed.json`（保留 Pro 等其他插件）；Creator 打开工程或无法判定即拒绝，持 Lite `.installed.lock`；激活前失败 unchanged，激活后失败恢复为 recovered，无法证明则 may_have_changed 并保留 `.cpm-transactions` journal。

## 硬规则

- 在有签名 CPM 发行之前，必须保持拒绝安装；bootstrap 及运行时清单模块通过 HTTPS 获取，不依赖本地仓库旁的脚本文件。
- 不要把产品包或密钥放进本仓。
- 本地 tarball 不是 CPM 发行，不能当激活证据。
- 契约：`../peanut-hub/contracts/cpm-directory-packages.md`。
