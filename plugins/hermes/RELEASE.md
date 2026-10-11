# Catalog releases and updates

Current status: version 0.1.1 is available in the Hermes plugin catalog through
[the merged catalog PR](https://github.com/NousResearch/hermes-agent/pull/135490).
The reviewed commit is `3a5c5065b2820d56dd3d8ac8bb259a9424b1476e`.
Users can run `hermes plugins install memoria --yes-deps --enable`, followed by
`hermes memory setup` for the interactive API-key and capture configuration.
See the [installation guide](README.md) for the complete flow.
A separate GitHub release or PyPI/npm package is not required for this directory
distribution.

Catalog installation and the interactive wizard were verified in a fresh
isolated home on October 11, 2026 using a placeholder key. That check confirmed
local setup, not live Cloud authentication.

Cloud API acceptance completed on October 8, 2026: all 13 checks passed, with zero
active test memories remaining. See [CLOUD_ACCEPTANCE.md](CLOUD_ACCEPTANCE.md).
Full natural-language agent conversation acceptance remains separate from these
direct lifecycle/tool-hook checks.

For self-hosted deployments and future plugin updates, deploy the matching API
with `/v1/observe/deduplicated` before updating the plugin.
Repeat live acceptance for a turn that explicitly saves one fact and contains a
second unsaved fact: the explicit record should remain active at T1, the second
fact should be captured, and no translated/paraphrased copy of the first should
appear. The October 8 Cloud report covers 0.1.0, not this new route.
Also verify same-turn store→correct and store→forget, recovery after a pre-write
extraction failure, and a missing branch without an erroneous upgrade diagnosis.
Exercise large and quote-heavy store/update inputs under the host's per-result
and aggregate tool budgets; compact receipts must still supply exclusion IDs,
including when aggregate pressure persists the receipt itself. If extraction
emits a paraphrase despite the prompt, it may insert a duplicate, but must keep
the excluded T1 active.
The API/proxy must preserve `X-Memoria-Observe-Deduplicated` and
`X-Memoria-Observe-Error`; without these markers the plugin conservatively treats
503 as uncertain and unmarked 404 as an unavailable endpoint.

For subsequent releases:

1. Keep the Cloud acceptance current and validate on the final
   supported Hermes build. Test installing/updating/removing the directory in a
   disposable Hermes profile. Keep the user's actual profile unchanged during testing.
2. Review and commit the plugin changes and any CI updates. Publish that reviewed
   commit to `matrixorigin/Memoria`; obtain its **full 40-character SHA**. A SHA
   before this directory exists is not a release pin.
3. Verify `hermes plugins install 'https://github.com/matrixorigin/Memoria#plugins/hermes'
   --ref <SHA>` from a clean profile. Version 0.1.1 uses the directory distribution;
   a PyPI or npm package is not required.
4. Submit a PR to `NousResearch/hermes-agent` updating the existing
   `plugin-catalog/memoria.yaml` entry's SHA, version and pinned documentation URL.
   Use the actual reviewed commit. Confirm the current catalog
   rules and maintainer identity before submitting.
5. After maintainer acceptance, test both `hermes plugins install memoria` in a
   fresh home and `hermes plugins update memoria` in an existing catalog install,
   followed by `hermes memory setup` and `hermes memory status`. Restart the
   conversation before validating writes and recall.

The current reviewed catalog pin (check the upstream entry before preparing an update):

```yaml
name: memoria
repo: https://github.com/matrixorigin/memoria
sha: 3a5c5065b2820d56dd3d8ac8bb259a9424b1476e
subdir: plugins/hermes
version: "0.1.1"
description: >-
  Memoria Cloud memory provider with scoped recall, explicit memory tools and opt-in background capture.
  Disclosure — sends recall queries and explicit memory operations to api.thememoria.ai by default
  (or a configured self-hosted origin). When enabled, auto capture uploads completed user/assistant text
  for fact extraction, excluding tool results and media. A local SQLite outbox stores pending text;
  credentials are resolved through the active Hermes profile's MEMORIA_API_KEY secret.
maintainer: matrixorigin
tier: community
category: memory
requires_hermes: ">=0.21.5"
docs_url: https://github.com/matrixorigin/memoria/blob/3a5c5065b2820d56dd3d8ac8bb259a9424b1476e/plugins/hermes/README.md
readme: true
platforms: [linux, macos]
known_issues:
  - "Development preview: local CLI acceptance passed; Desktop has not been validated and gateway platforms are disabled."
  - "Auto capture is off by default. One-shot CLI exit can interrupt an in-flight capture, leaving an uncertain event requiring manual inspection."
  - "Explicit-write exclusions apply to the current turn only. Auto capture can retain paraphrases, recalled facts from later turns, transient results or operation requests; global semantic deduplication is not guaranteed."
  - "Ambiguous write outcomes are not automatically retried; this plugin does not provide exactly-once capture."
capabilities:
  provides_tools: []
  provides_hooks: []
  provides_middleware: []
  requires_env:
    - MEMORIA_API_KEY
```

Provider-owned tools are registered through the memory manager, rather than the
general plugin tool registry. The catalog declares `MEMORIA_API_KEY`, and the
memory setup schema prompts for it during interactive configuration.

References: [memory providers](https://hermes-agent.nousresearch.com/docs/developer-guide/memory-provider-plugin),
[catalog submission](https://hermes-agent.nousresearch.com/docs/developer-guide/plugins/catalog-submission).
