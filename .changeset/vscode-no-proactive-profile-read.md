---
"kilo-code": patch
---

Stop fetching the Kilo profile/account on VS Code startup and reconnect: connecting no longer triggers a profile network read, matching the custom-providers-only surface where sign-in and account management are unavailable. Profile broadcasts from other instances are still forwarded and manual refresh answers locally. Remove the product Profile panel, command, and route (Settings-only panel; persisted profile panels do not rehydrate). Remove the now-orphan backend `kilo/profile` private fd-carrier capability; authenticated `GET /kilo/profile` remains with unchanged auth scope.
