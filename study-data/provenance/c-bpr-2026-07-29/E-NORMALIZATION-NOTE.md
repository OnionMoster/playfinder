# BPR 复现归档规范化记录

接收的原始归档中的 28 个文件内容在规范化时保持不变。

## 源文件身份

| 接收文件 | SHA-256 |
| --- | --- |
| `C_REPRODUCIBILITY(1).md` | `44971b5a1806b6d4fd6f8a5771bfd4abde8728321cec8286064c8fe5d6365c7a` |
| `C_reproducibility.zip.sha256` | `95bc8656b0bf57dac21d4273bb6c71e9df0e92845c39723a93b77b3839a4dd9d` |
| `C_reproducibility.zip` | `59939307817aa4c77b72ab497ee84fb059af6ea0b6a1faee09259f4a69deadf4` |

接收的 ZIP 内容测试通过，但成员路径使用 Windows 反斜杠，显式 `code` 目录缺少遍历权限，导致标准 macOS `unzip` 报警并生成无法访问的目录；附带哈希文件中的归档名也与接收文件名不符。

## 规范化

保留顶层目录 `C_reproducibility_public/` 及全部文件字节内容，将归档路径改为斜杠，目录权限设为 `0755`、文件权限设为 `0644`，采用声明中的 `C_reproducibility_public_bundle.zip` 文件名并重新计算归档 SHA-256：

`edec033f264de30e1ceae4f8907aea5378779096b38b3f82ff06a6051d7cfe53`

`unzip -t` 未报告错误，解压后 `hashes/CODE_SHA256SUMS` 中十二个 Python 源文件哈希通过。

## 范围与限制

接受的 BPR 排序不变，其 SHA-256 为 `b18a0ee6672d08921d0ba44a6c84034a23f74dac4bcd3c68d94f3030fde0ded0`。归档记录权重文件名、大小和哈希，但不包含大型权重文件；在新机器精确重现 Top-100 仍需获取这些文件。
