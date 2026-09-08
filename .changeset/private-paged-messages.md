---
"kilo-code": patch
---

Load paged session messages from the private projection first, falling back to one logical service read per page with the existing transient retry preserved.
