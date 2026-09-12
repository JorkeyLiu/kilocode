---
"@kilocode/cli": major
"@kilocode/sdk": major
---

BREAKING: remove the public `POST /kilocode/skill/remove` endpoint and its generated SDK method (`kilocode.removeSkill`, `KilocodeRemoveSkill*`). Settings skill removal continues privately through the `skill/remove` FD op with no behavior change.
