<p align="center">
  <a href="../README.md">English</a> | <a href="README.zh.md">简体中文</a> | <a href="README.zht.md">繁體中文</a> | 한국어 | <a href="README.de.md">Deutsch</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.it.md">Italiano</a> | <a href="README.da.md">Dansk</a> | <a href="README.ja.md">日本語</a> | <a href="README.pl.md">Polski</a> | <a href="README.ru.md">Русский</a> | <a href="README.bs.md">Bosanski</a> | <a href="README.ar.md">العربية</a> | <a href="README.no.md">Norsk</a> | <a href="README.br.md">Português (Brasil)</a> | <a href="README.th.md">ไทย</a> | <a href="README.tr.md">Türkçe</a> | <a href="README.uk.md">Українська</a> | <a href="README.bn.md">বাংলা</a> | <a href="README.gr.md">Ελληνικά</a> | <a href="README.vi.md">Tiếng Việt</a>
</p>

<p align="center">
  <a href="https://kilo.ai"><img width="250" alt="Kilo Code logo" src="https://github.com/user-attachments/assets/bdb0c174-b9fd-40ad-a47b-f3aab9b54e8d" /></a>
</p>

<p align="center">VS Code에서 AI로 개발하기 위한 오픈 소스 코딩 에이전트입니다.</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=kilocode.Kilo-Code"><img src="https://raster.shields.io/badge/VS_Code_Marketplace-007ACC?style=flat&logo=visualstudiocode&logoColor=white" alt="VS Code Marketplace" height="20"></a>
  <a href="https://x.com/kilocode"><img src="https://raster.shields.io/badge/kilocode-000000?style=flat&logo=x&logoColor=white" alt="X (Twitter)" height="20"></a>
  <a href="https://blog.kilo.ai"><img src="https://raster.shields.io/badge/Blog-555?style=flat&logo=substack&logoColor=white" alt="Blog" height="20"></a>
  <a href="https://kilo.ai/discord"><img src="https://raster.shields.io/badge/Join%20Discord-5865F2?style=flat&logo=discord&logoColor=white" alt="Discord" height="20"></a>
  <a href="https://www.reddit.com/r/kilocode/"><img src="https://raster.shields.io/badge/Join%20r%2Fkilocode-D84315?style=flat&logo=reddit&logoColor=white" alt="Reddit" height="20"></a>
</p>

![Kilo-in-VS-Code-and-CLI](https://github.com/user-attachments/assets/0536ca59-ed81-4512-9e05-d186187a1b52)

---

Kilo Code는 [VS Code](https://kilo.ai/landing/vs-code) 등 작업하는 모든 곳에서 사용할 수 있는 AI 코딩 에이전트입니다. 오픈 소스이며 투명한 가격 정책을 제공합니다. 500개 이상의 모델 중에서 선택하고, 작업 중간에 모델을 전환하며, 추가 요금 없이 모델 제공업체의 요금만 지불합니다. 시작할 때 API 키가 필요하지 않습니다.

### 설치

Kilo를 실행할 위치를 선택하세요.

<details open>
<summary><strong>VS Code</strong></summary>

<br>

[Kilo Code 확장](vscode:extension/kilocode.kilo-code)을 직접 설치하거나 [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=kilocode.Kilo-Code)에서 설치하세요. 계정을 만들면 GPT-5.5, Claude Opus 4.7, Claude Sonnet 4.6, Gemini 3.1 Pro Preview를 포함한 500개 이상의 모델을 제공업체 가격으로 사용할 수 있습니다.

</details>

### Agents

Kilo에는 작업에 따라 전환할 수 있는 특화된 agents가 포함되어 있습니다. 사용자 지정 agents도 만들 수 있습니다.

- **Code** - 기본값입니다. 자연어로 코드를 구현하고 편집합니다.
- **Plan** - 코드가 작성되기 전에 아키텍처를 설계하고 구현 계획을 작성합니다.
- **Ask** - 파일을 변경하지 않고 코드베이스에 대한 질문에 답합니다.
- **Debug** - 문제를 해결하고 추적합니다.
- **Review** - 변경 사항을 검토하고 성능, 보안, 스타일, 테스트 커버리지 문제를 찾아냅니다.

[agents와 사용자 지정 agents](https://kilo.ai/docs/code-with-ai/agents/using-agents)에 대해 더 알아보세요.

### 기능

- 여러 파일에 걸친 자연어 기반 **코드 생성**.
- ghost-text 제안과 Tab 수락을 지원하는 **인라인 자동완성**.
- 에이전트가 자신의 작업을 검토하고 수정하는 **자체 점검**.
- 명령 실행과 웹 자동화를 위한 **터미널 및 브라우저 제어**.
- 에이전트 기능을 확장하는 MCP 서버를 찾고 연결하는 **MCP 마켓플레이스**.
- 지연 시간, 비용, 추론 능력을 작업에 맞출 수 있는 작업 중 전환 지원 **500개 이상의 모델**.


### 문서

설정과 기타 모든 내용은 [문서](https://kilo.ai/docs)를 참조하세요.

### 기여

개발자, 작성자 등 누구나 기여할 수 있습니다. 환경 설정, 코딩 표준, pull request 여는 방법은 [Contributing Guide](/CONTRIBUTING.md)에서 시작하세요. VS Code 확장 릴리스 절차는 [RELEASING.md](../RELEASING.md)를 참조하세요.

참여하기 전에 [Code of Conduct](/CODE_OF_CONDUCT.md)를 읽어 주세요.

### 라이선스

MIT. 저작자 표시와 라이선스 고지를 유지하는 한, 상업적 사용을 포함해 이 코드를 사용, 수정, 배포할 수 있습니다. [License](/LICENSE)를 참조하세요.

### FAQ

<details>
<summary>Kilo CLI는 어디에서 왔나요?</summary>

Kilo CLI는 [OpenCode](https://github.com/anomalyco/opencode)의 fork이며, Kilo agentic engineering 플랫폼에서 작동하도록 강화되었습니다.

</details>

---

**커뮤니티 참여** [Discord](https://kilo.ai/discord) | [X](https://x.com/kilocode) | [Reddit](https://www.reddit.com/r/kilocode/)