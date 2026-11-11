---
"@trigger.dev/sdk": patch
---

Fix `retry.fetch` not stopping when its abort signal fires. It now throws the abort reason like `fetch` does, instead of retrying the request, and this includes the signal of a `Request` you pass in and a signal that was already aborted.
