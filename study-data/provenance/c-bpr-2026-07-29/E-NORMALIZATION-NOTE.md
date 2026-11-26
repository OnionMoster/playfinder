# C BPR reproducibility archive normalization

Member C's three received source files remain unchanged in `othermember/C_model/`.
E created the adjacent normalized archive for the final integration evidence
without changing any of the 28 source-file payloads inside C's ZIP.

## Source identity

| Received file | SHA-256 |
|---|---|
| `C_REPRODUCIBILITY(1).md` | `44971b5a1806b6d4fd6f8a5771bfd4abde8728321cec8286064c8fe5d6365c7a` |
| `C_reproducibility.zip.sha256` | `95bc8656b0bf57dac21d4273bb6c71e9df0e92845c39723a93b77b3839a4dd9d` |
| `C_reproducibility.zip` | `59939307817aa4c77b72ab497ee84fb059af6ea0b6a1faee09259f4a69deadf4` |

The received ZIP's content test passed, but it stored Windows backslashes as
archive path separators and recorded the explicit `code` directory without
directory traversal permission. Standard macOS `unzip` therefore returned a
warning status and produced an inaccessible source directory. Its companion
SHA file also named `C_reproducibility_public_bundle.zip`, which did not match
the received filename.

## Normalization performed by E

- retained the top-level directory `C_reproducibility_public/`;
- retained every source file byte-for-byte;
- converted archive member paths to standard forward-slash ZIP paths;
- set directories to mode `0755` and files to mode `0644`;
- used the filename already declared by C:
  `C_reproducibility_public_bundle.zip`;
- regenerated the archive SHA-256 and the external companion documentation.

Normalized archive SHA-256:

`edec033f264de30e1ceae4f8907aea5378779096b38b3f82ff06a6051d7cfe53`

`unzip -t` reports no errors. All twelve Python source hashes in
`hashes/CODE_SHA256SUMS` also pass after extraction.

## Scope and limitation

The accepted BPR ranking is unchanged and remains:

`b18a0ee6672d08921d0ba44a6c84034a23f74dac4bcd3c68d94f3030fde0ded0`

The public archive records checkpoint filenames, sizes, and hashes but does not
bundle the large checkpoint binaries. A new machine still needs controlled
access to those binaries to reproduce the exact Top-100 output.
