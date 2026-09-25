---
"kilo-code": major
---

BREAKING: Retire the standalone Kilo CLI product. Public `kilo` binary, archive, npm/Homebrew/AUR/Docker installs, install/upgrade scripts, and GitHub Action no longer install or run standalone Kilo; the VS Code extension ships its own private `kilo-serve` backend.

BREAKING: Start fresh canonical session history in the VS Code extension. Existing legacy database and session files are preserved once in a local offline archive with integrity manifest, never migrated or read back. Fresh installs start empty with no archive created. The cutover fails closed when legacy state cannot be verified or archived.
