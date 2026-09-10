# cpm-install

公开 CPM 引导端点。预期主机 `get.peanut-harness.dev`。故意不含私有产品二进制或凭据。

## 当前行为

`install.sh` 与 `install.ps1` **失败关闭**：打印尚未发布并 exit 1，不改项目。`releases.json` 的 `releases` 为空。

## 硬规则

- 在有签名 CPM 发行之前，必须保持拒绝安装。
- 不要把产品包或密钥放进本仓。
- 本地 tarball 不是 CPM 发行，不能当激活证据。
- 契约：`../peanut-hub/contracts/cpm-directory-packages.md`。
