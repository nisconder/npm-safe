# 合并上游后的核对：core 1.1.2

第三轮修复与上游 `5bc09cc` 的共享安全策略、版本绑定及缓存改进合并后，对**相同十六个固定版本**重新执行离线核对。数值分数、规则命中和完成状态与第三轮最终结果一致；共享策略使两个产品等级按预期改变：

| 版本 / 模式 | 分数 | 第三轮 1.1.1 快照 | 当前 1.1.2 |
| --- | ---: | --- | --- |
| debug 4.4.2 / 深扫 | 75 | suspicious | dangerous：已有 Critical 发现 |
| @walletconnect/ethereum-provider 2.21.1 / 深扫 | 92 | safe，但 partial | unknown：未完成且未建立危险证据 |

当前策略先将任一 Critical 发现或分数低于 50 判为 dangerous；否则，未完成检查或无效分数判为 unknown；剩余完整结果中 80–100 为 safe、50–79 为 suspicious。**已建立的危险优先于未完成状态**，Critical 即使出现在 partial 报告中也保持 dangerous。CI 对不确定结果按失败处理；报告缓存纪元已提升到 3，使此前规则生成的缓存报告重新核对。

已知恶意版本仍为三个深扫阳性：debug 75 dangerous、eslint-config-prettier 74 suspicious、is 77 suspicious；三个旧对照保持 100 safe。十个正常挑战中九个完整深扫均为 safe，Lodash 仍有一个 high 告警；WalletConnect 保留为 partial/unknown，未计入 TN。产品等级 FP 仍为 0/9，高危告警 FP 为 1/9。这些是已知回归与暂定正常挑战结果，不代表总体召回率或总体零误报。

- [当前正常挑战结果](postmerge-2026-10-31.controls.json)：二十次元数据/深扫尝试，深扫九次完整、一次 partial。
- [当前已知回归结果](postmerge-2026-10-31.regression.json)：十二次尝试全部完整。
- 两份公开投影保留完整源码文件哈希、原始结果哈希及逐包状态/规则 ID，省略源码和发现片段。

当前 core 1.1.2 源码指纹为 `af515c67ba4ccfcaab497ed65375659ea4b8fe929ad8399a5fe76c42eb06ae20`。十版本输入 SHA256 仍为 `96c9453c38682b29c81306ccd3baa82c8559b68465316307a47a48c2616c6e5d`，六版本输入仍为 `232e8bf5ba1e61425366331c164535840d3a1e3ab37e41f2ebe355dae1bf2122`。

整合后核心测试 557 项：555 通过、2 跳过、0 失败；评测运行器 7/7，类型检查和构建通过。本次只重新核对检测输出，没有建立新的耗时对照；[第三轮性能表](round3-2026-10-31.md)仍是合并前 core 1.1.1 的冻结测量，不能直接当作当前 1.1.2 的性能结论。三轮历史 JSON、指纹及测量记录均未重写。

复现方式沿用[离线协议](../evaluation.md)。本次是源码整合和本地构建验证，未进行 npm 发布。
