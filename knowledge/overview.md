# cpm-install

公开 CPM 引导端点。预期主机 `get.peanut-harness.dev`。故意不含私有产品二进制或凭据。

## 当前行为

`install.sh` 与 `install.ps1` 经 `bootstrap.mjs install` 解析 manifest、按事务原子安装已验证 CLI runtime 到 `CPM_HOME`（默认 `~/.peanut/cpm`），stdout 输出结构化身份 JSON，警告只写 stderr。`releases.json` 为 schema v2 且 stable 为空，因此公共安装仍失败关闭（exit 1，不改项目）。信任锚固定在 `trust-anchors.mjs`（双锚轮换），生产路径不读环境变量；`CPM_TEST_*` 注入仅在 `CPM_TEST_MODE=1` + 本地 manifest 时生效。

## 硬规则

- 在有签名 CPM 发行之前，必须保持拒绝安装；bootstrap 及运行时清单模块通过 HTTPS 获取，不依赖本地仓库旁的脚本文件。
- 不要把产品包或密钥放进本仓。
- 本地 tarball 不是 CPM 发行，不能当激活证据。
- 契约：`../peanut-hub/contracts/cpm-directory-packages.md`。
