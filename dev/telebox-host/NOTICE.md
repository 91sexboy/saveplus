# Vendored TeleBox host files (test fixtures only)

The files in `utils/pluginBase.ts`, `utils/generationContext.ts` and
`utils/htmlEscape.ts` are unmodified copies from TeleBox
(https://github.com/TeleBoxOrg/TeleBox) at commit
`c46437405be459d279821587e48f311f06d53bd4`, licensed under LGPL-2.1-only
(see `LICENSE`).

They are used only by the local development harness so that type checks and
lifecycle tests run against the real plugin base class, plugin validation and
generation context of that host version. They are not part of the shipped
`saveplus.ts` plugin, which imports these modules from the running TeleBox host.

`utils/pathHelpers.ts`, `utils/pluginManager.ts` and `utils/runtimeManager.ts`
are local test doubles that keep the host's exported signatures
(`createDirectoryInAssets`, `createDirectoryInTemp`, `getPrefixes`,
`getGlobalClient`) while letting tests control directories, prefixes and the
client.
