---
"@trigger.dev/sdk": patch
---

Fix `retry.fetch` dropping headers when given a `Request` (as `openapi-fetch` does), a `Headers` object or an array of header pairs, and failing to retry a `Request` that has a body.
