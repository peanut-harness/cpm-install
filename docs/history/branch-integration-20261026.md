# 分支归并与清理留档

仓库：`cpm-install`。记录日期：2026-10-26。

用户已授权清理除 QA 外已合并的本地和远端分支，各仓库只保留 `main`；历史留档保存在本文，不创建备份分支或标签。

清理核对基线：`0c7de877da705a03e458f250f45f6e39c2767250`。下表各提交均已核实是该 main 的祖先；删除分支名称不会删除这些提交或其文件历史。

## 当前代码与历史实现的边界

普通增量已按此前验收结论合入 main；仅删除已合并分支的名称，不改运行源码或扩大既有产品验收结论。

## 已归并的分支名称与提交

以下为清理前冻结清单，不是仍在使用的分支。`refs/heads/` 表示本地分支，`refs/remotes/origin/` 表示 origin 对应分支。main 本身保留。

| 原分支引用 | 最后提交 | 清理范围 |
| --- | --- | --- |
| `refs/heads/cleanup/remove-legacy-ai-config` | `4e41385fdea41fdbc2e6304dc13497d1afe12e4a` | 删除已合并分支名称 |
| `refs/heads/main` | `0c7de877da705a03e458f250f45f6e39c2767250` | 保留 main |
| `refs/heads/sc028wang-friendly-train` | `4e41385fdea41fdbc2e6304dc13497d1afe12e4a` | 删除已合并分支名称 |
| `refs/remotes/origin/main` | `0c7de877da705a03e458f250f45f6e39c2767250` | 保留 main |

## 查看历史

使用上表的完整提交 SHA 查看历史及原文件；无需保留同名分支：

```sh
git show <commit>
git show <commit>:<repository-relative-path>
git log main -- <repository-relative-path>
```

本记录证明历史归并及清理范围，不替代原任务的运行验收。远端分支是否清理完成，以清理后的远端分支列表回读为准；GitHub Actions 未核实。
