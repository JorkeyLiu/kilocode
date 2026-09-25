<p align="center">
  <a href="../README.md">English</a> | <a href="README.zh.md">简体中文</a> | <a href="README.zht.md">繁體中文</a> | <a href="README.ko.md">한국어</a> | <a href="README.de.md">Deutsch</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.it.md">Italiano</a> | Dansk | <a href="README.ja.md">日本語</a> | <a href="README.pl.md">Polski</a> | <a href="README.ru.md">Русский</a> | <a href="README.bs.md">Bosanski</a> | <a href="README.ar.md">العربية</a> | <a href="README.no.md">Norsk</a> | <a href="README.br.md">Português (Brasil)</a> | <a href="README.th.md">ไทย</a> | <a href="README.tr.md">Türkçe</a> | <a href="README.uk.md">Українська</a> | <a href="README.bn.md">বাংলা</a> | <a href="README.gr.md">Ελληνικά</a> | <a href="README.vi.md">Tiếng Việt</a>
</p>

<p align="center">
  <a href="https://kilo.ai"><img width="250" alt="Kilo Code logo" src="https://github.com/user-attachments/assets/bdb0c174-b9fd-40ad-a47b-f3aab9b54e8d" /></a>
</p>

<p align="center">Den open source-kodeagent til at bygge med AI i VS Code.</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=kilocode.Kilo-Code"><img src="https://raster.shields.io/badge/VS_Code_Marketplace-007ACC?style=flat&logo=visualstudiocode&logoColor=white" alt="VS Code Marketplace" height="20"></a>
  <a href="https://x.com/kilocode"><img src="https://raster.shields.io/badge/kilocode-000000?style=flat&logo=x&logoColor=white" alt="X (Twitter)" height="20"></a>
  <a href="https://blog.kilo.ai"><img src="https://raster.shields.io/badge/Blog-555?style=flat&logo=substack&logoColor=white" alt="Blog" height="20"></a>
  <a href="https://kilo.ai/discord"><img src="https://raster.shields.io/badge/Join%20Discord-5865F2?style=flat&logo=discord&logoColor=white" alt="Discord" height="20"></a>
  <a href="https://www.reddit.com/r/kilocode/"><img src="https://raster.shields.io/badge/Join%20r%2Fkilocode-D84315?style=flat&logo=reddit&logoColor=white" alt="Reddit" height="20"></a>
</p>

![Kilo-in-VS-Code-and-CLI](https://github.com/user-attachments/assets/0536ca59-ed81-4512-9e05-d186187a1b52)

---

Kilo Code er en AI-kodeagent, der møder dig overalt, hvor du arbejder: [VS Code](https://kilo.ai/landing/vs-code). Den er open source med åben prissætning. Du vælger mellem mere end 500 modeller, skifter mellem dem midt i en opgave og betaler modeludbyderens pris uden tillæg. Ingen API-nøgler kræves for at komme i gang.

### Installation

Vælg, hvor du vil køre Kilo.

<details open>
<summary><strong>VS Code</strong></summary>

<br>

Installer [Kilo Code-udvidelsen](vscode:extension/kilocode.kilo-code) direkte, eller hent den fra [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=kilocode.Kilo-Code). Opret en konto, og du får adgang til mere end 500 modeller, herunder GPT-5.5, Claude Opus 4.7, Claude Sonnet 4.6 og Gemini 3.1 Pro Preview, alle til udbyderpris.

</details>

### Agents

Kilo leveres med specialiserede agents, som du kan skifte mellem afhængigt af opgaven. Du kan også bygge dine egne brugerdefinerede agents.

- **Code** - Standard. Implementerer og redigerer kode fra naturligt sprog.
- **Plan** - Designer arkitektur og skriver implementeringsplaner, før der skrives kode.
- **Ask** - Besvarer spørgsmål om din kodebase uden at ændre filer.
- **Debug** - Fejlfinder og sporer problemer.
- **Review** - Gennemgår dine ændringer og finder problemer med ydeevne, sikkerhed, stil og testdækning.

Læs mere om [agents og brugerdefinerede agents](https://kilo.ai/docs/code-with-ai/agents/using-agents).

### Hvad den gør

- **Kodegenerering** fra naturligt sprog på tværs af flere filer.
- **Inline-autocomplete** med ghost-text-forslag og Tab for at acceptere.
- **Selvkontrol**, så agenten gennemgår og retter sit eget arbejde.
- **Terminal- og browserkontrol** til at køre kommandoer og automatisere webben.
- **MCP-markedsplads** til at finde og tilslutte MCP-servere, der udvider agentens muligheder.
- **Mere end 500 modeller** med skift midt i opgaven, så du kan matche latenstid, pris og ræsonnement til arbejdet.


### Dokumentation

For konfiguration og alt andet, se [dokumentationen](https://kilo.ai/docs).

### Bidrag

Bidrag er velkomne fra udviklere, forfattere og alle andre. Start med [Contributing Guide](/CONTRIBUTING.md) for miljøopsætning, kodestandarder og hvordan du åbner en pull request. Se [RELEASING.md](../RELEASING.md) for releaseprocessen for VS Code-udvidelsen.

Læs venligst vores [Code of Conduct](/CODE_OF_CONDUCT.md), før du deltager.

### Licens

MIT. Du kan bruge, ændre og distribuere denne kode, også kommercielt, så længe du beholder attribution og licensmeddelelser. Se [License](/LICENSE).

### FAQ

<details>
<summary>Hvor kommer Kilo CLI fra?</summary>

Kilo CLI er en fork af [OpenCode](https://github.com/anomalyco/opencode), forbedret til at fungere i Kilo agentic engineering-platformen.

</details>

---

**Deltag i fællesskabet** [Discord](https://kilo.ai/discord) | [X](https://x.com/kilocode) | [Reddit](https://www.reddit.com/r/kilocode/)
