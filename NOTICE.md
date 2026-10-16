# Attribution

This project derives from `ie3jp/illustrator-mcp-server` (MIT), using the locally installed v1.8.0 source at commit `1814485cfa24787215f0ec515a6853cb293e1e0a` as its starting point. The original copyright notice is retained in LICENSE.

Source: https://github.com/ie3jp/illustrator-mcp-server

The generic script-entry workflow was also informed by `ajfonthemove/illustrator-mcp`, inspected at commit `f1a66590a14c567b62902ff9746343e6a6c7d984`. Its source files, banner and other assets are not included. The trusted-script implementation in this repository uses the primary server's executor and was written for the unified background workflow.

Reference: https://github.com/ajfonthemove/illustrator-mcp

Modifications include background execution policy, native completion receipts and execution recovery, serial execution ownership, trusted-script syntax checks, batch-card tools, installation helpers, tests, and the optional card-making skill.

Third-party dependencies retain their respective licenses and are installed through npm. They are not vendored into this repository.
