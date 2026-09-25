<p align="center">
  <a href="../README.md">English</a> | <a href="README.zh.md">简体中文</a> | <a href="README.zht.md">繁體中文</a> | <a href="README.ko.md">한국어</a> | <a href="README.de.md">Deutsch</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.it.md">Italiano</a> | <a href="README.da.md">Dansk</a> | <a href="README.ja.md">日本語</a> | Polski | <a href="README.ru.md">Русский</a> | <a href="README.bs.md">Bosanski</a> | <a href="README.ar.md">العربية</a> | <a href="README.no.md">Norsk</a> | <a href="README.br.md">Português (Brasil)</a> | <a href="README.th.md">ไทย</a> | <a href="README.tr.md">Türkçe</a> | <a href="README.uk.md">Українська</a> | <a href="README.bn.md">বাংলা</a> | <a href="README.gr.md">Ελληνικά</a> | <a href="README.vi.md">Tiếng Việt</a>
</p>

<p align="center">
  <a href="https://kilo.ai"><img width="250" alt="Kilo Code logo" src="https://github.com/user-attachments/assets/bdb0c174-b9fd-40ad-a47b-f3aab9b54e8d" /></a>
</p>

<p align="center">Open source'owy agent kodujący do pracy z AI w VS Code.</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=kilocode.Kilo-Code"><img src="https://raster.shields.io/badge/VS_Code_Marketplace-007ACC?style=flat&logo=visualstudiocode&logoColor=white" alt="VS Code Marketplace" height="20"></a>
  <a href="https://x.com/kilocode"><img src="https://raster.shields.io/badge/kilocode-000000?style=flat&logo=x&logoColor=white" alt="X (Twitter)" height="20"></a>
  <a href="https://blog.kilo.ai"><img src="https://raster.shields.io/badge/Blog-555?style=flat&logo=substack&logoColor=white" alt="Blog" height="20"></a>
  <a href="https://kilo.ai/discord"><img src="https://raster.shields.io/badge/Join%20Discord-5865F2?style=flat&logo=discord&logoColor=white" alt="Discord" height="20"></a>
  <a href="https://www.reddit.com/r/kilocode/"><img src="https://raster.shields.io/badge/Join%20r%2Fkilocode-D84315?style=flat&logo=reddit&logoColor=white" alt="Reddit" height="20"></a>
</p>

![Kilo-in-VS-Code-and-CLI](https://github.com/user-attachments/assets/0536ca59-ed81-4512-9e05-d186187a1b52)

---

Kilo Code to agent kodujący z AI, który działa wszędzie tam, gdzie pracujesz: w [VS Code](https://kilo.ai/landing/vs-code). Jest open source i ma otwarte ceny. Wybierasz spośród ponad 500 modeli, przełączasz się między nimi w trakcie zadania i płacisz stawkę dostawcy modelu bez narzutów. Do rozpoczęcia nie są wymagane klucze API.

### Instalacja

Wybierz, gdzie chcesz uruchomić Kilo.

<details open>
<summary><strong>VS Code</strong></summary>

<br>

Zainstaluj bezpośrednio [rozszerzenie Kilo Code](vscode:extension/kilocode.kilo-code) albo pobierz je z [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=kilocode.Kilo-Code). Utwórz konto, a otrzymasz dostęp do ponad 500 modeli, w tym GPT-5.5, Claude Opus 4.7, Claude Sonnet 4.6 i Gemini 3.1 Pro Preview, wszystkie w cenach dostawców.

</details>

### Agents

Kilo zawiera wyspecjalizowane agents, między którymi możesz przełączać się zależnie od zadania. Możesz też tworzyć własne niestandardowe agents.

- **Code** - Domyślny. Implementuje i edytuje kod z języka naturalnego.
- **Plan** - Projektuje architekturę i pisze plany implementacji przed napisaniem kodu.
- **Ask** - Odpowiada na pytania o bazę kodu bez modyfikowania plików.
- **Debug** - Diagnozuje i śledzi problemy.
- **Review** - Przegląda zmiany i wykrywa problemy z wydajnością, bezpieczeństwem, stylem i pokryciem testami.

Dowiedz się więcej o [agents i niestandardowych agents](https://kilo.ai/docs/code-with-ai/agents/using-agents).

### Co robi

- **Generowanie kodu** z języka naturalnego, w wielu plikach.
- **Autouzupełnianie inline** z sugestiami ghost-text i akceptacją przez Tab.
- **Samokontrola**, dzięki której agent sprawdza i poprawia własną pracę.
- **Sterowanie terminalem i przeglądarką** do uruchamiania poleceń i automatyzacji webu.
- **Configuration MCP** do znajdowania i podłączania serwerów MCP rozszerzających możliwości agenta.
- **Ponad 500 modeli** z przełączaniem w trakcie zadania, aby dopasować opóźnienie, koszt i rozumowanie do pracy.


### Dokumentacja

Konfigurację i wszystko inne znajdziesz w [dokumentacji](https://kilo.ai/docs).

### Wkład

Zapraszamy do wkładu programistów, autorów i wszystkich innych. Zacznij od [Contributing Guide](/CONTRIBUTING.md), aby skonfigurować środowisko, poznać standardy kodowania i sposób otwierania pull requestów. Zobacz [RELEASING.md](../RELEASING.md) dla procesu wydawania rozszerzenia VS Code.

Przed zaangażowaniem przeczytaj nasz [Code of Conduct](/CODE_OF_CONDUCT.md).

### Licencja

MIT. Możesz używać, modyfikować i dystrybuować ten kod, również komercyjnie, o ile zachowasz informacje o autorstwie i licencji. Zobacz [License](/LICENSE).

### FAQ

<details>
<summary>Skąd pochodzi Kilo CLI?</summary>

Kilo CLI jest forkiem [OpenCode](https://github.com/anomalyco/opencode), rozszerzonym do działania w platformie agentic engineering Kilo.

</details>

---

**Dołącz do społeczności** [Discord](https://kilo.ai/discord) | [X](https://x.com/kilocode) | [Reddit](https://www.reddit.com/r/kilocode/)
