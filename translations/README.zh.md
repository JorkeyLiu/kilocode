<p align="center">
  <a href="../README.md">English</a> | 简体中文 | <a href="README.zht.md">繁體中文</a> | <a href="README.ko.md">한국어</a> | <a href="README.de.md">Deutsch</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.it.md">Italiano</a> | <a href="README.da.md">Dansk</a> | <a href="README.ja.md">日本語</a> | <a href="README.pl.md">Polski</a> | <a href="README.ru.md">Русский</a> | <a href="README.bs.md">Bosanski</a> | <a href="README.ar.md">العربية</a> | <a href="README.no.md">Norsk</a> | <a href="README.br.md">Português (Brasil)</a> | <a href="README.th.md">ไทย</a> | <a href="README.tr.md">Türkçe</a> | <a href="README.uk.md">Українська</a> | <a href="README.bn.md">বাংলা</a> | <a href="README.gr.md">Ελληνικά</a> | <a href="README.vi.md">Tiếng Việt</a>
</p>

<p align="center">
  <a href="https://kilo.ai"><img width="250" alt="Kilo Code logo" src="https://github.com/user-attachments/assets/bdb0c174-b9fd-40ad-a47b-f3aab9b54e8d" /></a>
</p>

<p align="center">用于在 VS Code 中借助 AI 构建的开源编码代理。</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=kilocode.Kilo-Code"><img src="https://raster.shields.io/badge/VS_Code_Marketplace-007ACC?style=flat&logo=visualstudiocode&logoColor=white" alt="VS Code Marketplace" height="20"></a>
  <a href="https://x.com/kilocode"><img src="https://raster.shields.io/badge/kilocode-000000?style=flat&logo=x&logoColor=white" alt="X (Twitter)" height="20"></a>
  <a href="https://blog.kilo.ai"><img src="https://raster.shields.io/badge/Blog-555?style=flat&logo=substack&logoColor=white" alt="Blog" height="20"></a>
  <a href="https://kilo.ai/discord"><img src="https://raster.shields.io/badge/Join%20Discord-5865F2?style=flat&logo=discord&logoColor=white" alt="Discord" height="20"></a>
  <a href="https://www.reddit.com/r/kilocode/"><img src="https://raster.shields.io/badge/Join%20r%2Fkilocode-D84315?style=flat&logo=reddit&logoColor=white" alt="Reddit" height="20"></a>
</p>

![Kilo-in-VS-Code-and-CLI](https://github.com/user-attachments/assets/0536ca59-ed81-4512-9e05-d186187a1b52)

---

Kilo Code 是一个 AI 编码代理，可以在你工作的任何地方使用：[VS Code](https://kilo.ai/landing/vs-code)。它是开源的，并采用开放定价。你可以从 500 多个模型中选择，在任务中途切换模型，并按模型提供商的价格付费，没有加价。开始使用无需 API 密钥。

### 安装

选择你想运行 Kilo 的位置。

<details open>
<summary><strong>VS Code</strong></summary>

<br>

直接安装 [Kilo Code 扩展](vscode:extension/kilocode.kilo-code)，或从 [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=kilocode.Kilo-Code) 获取。创建账户后，你可以按提供商价格访问 500 多个模型，包括 GPT-5.5、Claude Opus 4.7、Claude Sonnet 4.6 和 Gemini 3.1 Pro Preview。

</details>

### Agents

Kilo 内置了可按任务切换的专用 Agents。你也可以构建自己的自定义 Agents。

- **Code** - 默认模式。根据自然语言实现和编辑代码。
- **Plan** - 在编写任何代码之前设计架构并编写实现计划。
- **Ask** - 回答有关代码库的问题，不修改任何文件。
- **Debug** - 排查并追踪问题。
- **Review** - 审查你的更改，并从性能、安全、风格和测试覆盖率等方面发现问题。

了解更多关于 [agents 和自定义 agents](https://kilo.ai/docs/code-with-ai/agents/using-agents) 的信息。

### 功能

- **代码生成**：基于自然语言跨多个文件生成代码。
- **内联自动补全**：提供 ghost-text 建议，按 Tab 接受。
- **自检**：让代理审查并修正自己的工作。
- **终端和浏览器控制**：运行命令并自动化网页操作。
- **MCP 市场**：查找并连接 MCP 服务器，扩展代理能力。
- **500 多个模型**：支持任务中途切换，让你根据延迟、成本和推理能力匹配任务。


### 文档

关于配置和其他内容，请查看[文档](https://kilo.ai/docs)。

### 贡献

欢迎开发者、写作者以及所有人参与贡献。请先阅读 [Contributing Guide](/CONTRIBUTING.md)，了解环境设置、编码标准以及如何创建 Pull Request。VS Code 扩展 的发布流程请参阅 [RELEASING.md](../RELEASING.md)。

参与前请阅读我们的 [Code of Conduct](/CODE_OF_CONDUCT.md)。

### 许可证

MIT。你可以使用、修改和分发此代码，包括商业用途，只要保留署名和许可证声明。参见 [License](/LICENSE)。

### FAQ

<details>
<summary>Kilo CLI 从哪里来？</summary>

Kilo CLI 是 [OpenCode](https://github.com/anomalyco/opencode) 的一个 fork，并增强为可在 Kilo agentic engineering 平台中使用。

</details>

---

**加入社区** [Discord](https://kilo.ai/discord) | [X](https://x.com/kilocode) | [Reddit](https://www.reddit.com/r/kilocode/)
