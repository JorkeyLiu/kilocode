<p align="center">
  <a href="../README.md">English</a> | <a href="README.zh.md">简体中文</a> | <a href="README.zht.md">繁體中文</a> | <a href="README.ko.md">한국어</a> | Deutsch | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.it.md">Italiano</a> | <a href="README.da.md">Dansk</a> | <a href="README.ja.md">日本語</a> | <a href="README.pl.md">Polski</a> | <a href="README.ru.md">Русский</a> | <a href="README.bs.md">Bosanski</a> | <a href="README.ar.md">العربية</a> | <a href="README.no.md">Norsk</a> | <a href="README.br.md">Português (Brasil)</a> | <a href="README.th.md">ไทย</a> | <a href="README.tr.md">Türkçe</a> | <a href="README.uk.md">Українська</a> | <a href="README.bn.md">বাংলা</a> | <a href="README.gr.md">Ελληνικά</a> | <a href="README.vi.md">Tiếng Việt</a>
</p>

<p align="center">
  <a href="https://kilo.ai"><img width="250" alt="Kilo Code logo" src="https://github.com/user-attachments/assets/bdb0c174-b9fd-40ad-a47b-f3aab9b54e8d" /></a>
</p>

<p align="center">Der Open-Source-Coding-Agent zum Entwickeln mit KI in VS Code.</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=kilocode.Kilo-Code"><img src="https://raster.shields.io/badge/VS_Code_Marketplace-007ACC?style=flat&logo=visualstudiocode&logoColor=white" alt="VS Code Marketplace" height="20"></a>
  <a href="https://x.com/kilocode"><img src="https://raster.shields.io/badge/kilocode-000000?style=flat&logo=x&logoColor=white" alt="X (Twitter)" height="20"></a>
  <a href="https://blog.kilo.ai"><img src="https://raster.shields.io/badge/Blog-555?style=flat&logo=substack&logoColor=white" alt="Blog" height="20"></a>
  <a href="https://kilo.ai/discord"><img src="https://raster.shields.io/badge/Join%20Discord-5865F2?style=flat&logo=discord&logoColor=white" alt="Discord" height="20"></a>
  <a href="https://www.reddit.com/r/kilocode/"><img src="https://raster.shields.io/badge/Join%20r%2Fkilocode-D84315?style=flat&logo=reddit&logoColor=white" alt="Reddit" height="20"></a>
</p>

![Kilo-in-VS-Code-and-CLI](https://github.com/user-attachments/assets/0536ca59-ed81-4512-9e05-d186187a1b52)

---

Kilo Code ist ein KI-Coding-Agent, der überall dort arbeitet, wo du arbeitest: [VS Code](https://kilo.ai/landing/vs-code). Es ist Open Source mit transparenter Preisgestaltung. Du wählst aus über 500 Modellen, wechselst sie mitten in einer Aufgabe und zahlst den Tarif des Modellanbieters ohne Aufschlag. Zum Start sind keine API-Schlüssel erforderlich.

### Installation

Wähle aus, wo du Kilo ausführen möchtest.

<details open>
<summary><strong>VS Code</strong></summary>

<br>

Installiere die [Kilo Code-Erweiterung](vscode:extension/kilocode.kilo-code) direkt oder lade sie aus dem [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=kilocode.Kilo-Code). Erstelle ein Konto und erhalte Zugriff auf über 500 Modelle, darunter GPT-5.5, Claude Opus 4.7, Claude Sonnet 4.6 und Gemini 3.1 Pro Preview, alle zu Anbieterpreisen.

</details>

### Agents

Kilo wird mit spezialisierten Agents ausgeliefert, zwischen denen du je nach Aufgabe wechselst. Du kannst auch eigene Agents erstellen.

- **Code** - Standard. Implementiert und bearbeitet Code aus natürlicher Sprache.
- **Plan** - Entwirft Architektur und schreibt Implementierungspläne, bevor Code geschrieben wird.
- **Ask** - Beantwortet Fragen zu deiner Codebasis, ohne Dateien zu ändern.
- **Debug** - Untersucht und verfolgt Probleme.
- **Review** - Prüft deine Änderungen und findet Probleme bei Performance, Sicherheit, Stil und Testabdeckung.

Mehr erfahren über [Agents und benutzerdefinierte Agents](https://kilo.ai/docs/code-with-ai/agents/using-agents).

### Funktionen

- **Codegenerierung** aus natürlicher Sprache über mehrere Dateien hinweg.
- **Inline-Autocomplete** mit Ghost-Text-Vorschlägen und Tab zum Übernehmen.
- **Selbstprüfung**, damit der Agent seine eigene Arbeit prüft und korrigiert.
- **Terminal- und Browsersteuerung**, um Befehle auszuführen und das Web zu automatisieren.
- **MCP-Marktplatz**, um MCP-Server zu finden und einzubinden, die den Agent erweitern.
- **Über 500 Modelle** mit Wechsel während einer Aufgabe, damit du Latenz, Kosten und Reasoning passend zur Aufgabe wählst.


### Dokumentation

Für Konfiguration und alles Weitere lies die [Dokumentation](https://kilo.ai/docs).

### Mitwirken

Beiträge von Entwicklerinnen, Autoren und allen anderen sind willkommen. Beginne mit dem [Contributing Guide](/CONTRIBUTING.md) für Einrichtung, Coding-Standards und Pull Requests. Siehe [RELEASING.md](../RELEASING.md) für den Release-Prozess der VS Code-Erweiterung.

Bitte lies unseren [Code of Conduct](/CODE_OF_CONDUCT.md), bevor du mitwirkst.

### Lizenz

MIT. Du darfst diesen Code verwenden, ändern und verbreiten, auch kommerziell, solange du die Attribution und Lizenzhinweise beibehältst. Siehe [License](/LICENSE).

### FAQ

<details>
<summary>Woher stammt Kilo CLI?</summary>

Kilo CLI ist ein Fork von [OpenCode](https://github.com/anomalyco/opencode). Die CLI-Laufzeit (`kilo-serve`) ist heute eine interne Komponente der VS Code-Erweiterung und wird nicht als eigenständiges Produkt vertrieben.

</details>

---

**Tritt der Community bei** [Discord](https://kilo.ai/discord) | [X](https://x.com/kilocode) | [Reddit](https://www.reddit.com/r/kilocode/)
