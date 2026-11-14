---
name: reference-source-author
description: Build a new @ reference source for Reference Anything — a small DSH plugin that lets the user @-mention, and the model read, items from anywhere the user wants (another plugin's data or components, a website or API, a local folder or database, anything). Use when the user wants to @ something that no current source covers, or asks to write, add or connect a reference source.
---

# Write a Reference Anything source

The user describes what they want to `@`. You deliver a working DSH plugin in their profile that:

1. registers a **Host source plugin** the model reaches through the single `reference` tool (`list`, `search`, `read`; images and files are children read with `as: "image"` or `as: "file"`). With `defineReferenceSource` you write only `load` and usually `list`; you write no tools, and
2. usually adds an **`@` menu group** so the user can pick items in the input box.

There is no fixed list of allowed sources. Read what the user asked for, from wherever it lives: another installed plugin's services, Remotes or browser components, a web page or API, files, a database, a command's output. Build exactly that.

## Environment

- DSH profile: `{{profileName}}`, directory `{{profileDir}}`
- DSH version: `{{dshVersion}}` (use it for every `@deepseek-ai/*` package you install)
- Reference Anything version: `{{raVersion}}`
- Reference Anything package directory: `{{raDir}}` (its `lib/reference-source.d.ts` and `lib/sdk.d.ts` are the authoritative types)

## 1. Pin down the source

Settle these before writing code. Ask the user only about what you cannot work out yourself, in one short message:

- **Items**: what one item is, its stable id (must survive restarts without a lookup table; never a credential, a user name or an absolute path; never a path the user could escape with `..`), and its title.
- **Origin**: where the list and the body come from, and whether reading needs network, a login or a running process.
- **Reading**: what `load` returns: the whole object as records (text blocks, chat turns, rows; oldest first), plus children such as attachments.
- **Menu**: whether the user wants an `@` group (default yes) and a shortcut prefix such as `note:`.

To reuse another plugin, find its package under `{{profileDir}}/node_modules` and read its `package.json` `exports` and `lib/**/*.d.ts`. Host services are reached with `inject: ['theirService']` and `ctx.theirService`. Browser services are reached with `ctx.reflect.get('remote.<service>')` or the client service they register.

## 2. Shape

| The user wants | Build |
| --- | --- |
| Only the model reads it | Host half only |
| To pick items with `@` | Host half + Remote + browser half (the example below) |
| Settings the user can change | `ctx.references.defineSettings(sourceId, { schema, defaults })` in the Host half |

Contract rules (break one and the source misbehaves):

- Register with `ctx.references.registerPlugin(defineReferenceSource({ source, load, list }))`; import `defineReferenceSource` and `referenceError` from `dsh-reference-anything/source`.
- `source` is permanent once used: saved references and grants store it. Use lowercase letters, digits and `-`, starting with a letter. The model calls `reference({ source, id, op, args })` with exactly your ids.
- Only the user's `@` grants reading: list and title search work without it, but `read` and searching inside an id need the user to have `@`-mentioned that id. Do not try to work around this.
- `load(id, signal)` returns `{ title, content: [{ role?, text }], children? }` and **throws** when the item is missing or not allowed (`referenceError('NOT_FOUND' | 'SOURCE_DISABLED' | 'UNAUTHORIZED' | 'SOURCE_UNAVAILABLE', message)`). An empty success reads as "the item is empty". Recheck your own switches, folder or account on every call. File content uses `role: 'document'`.
- `list(query, args, call)` returns `{ items: [{ id, title, updatedAt? }] }` and matches metadata only; never put body text in a title.
- Paging, `next` continuation, literal search, revision checks and the `@` preview come from the SDK; you never compute positions.
- Optional children: `children: [{ key, title, kind: 'image' | 'file' | 'text', item? }]` plus `fetch(id, child, maxBytes)` returning bytes; the core saves the file (cap from `files.maxBytes`) and adds pixels for images up to 10 MiB.
- A data source with its own server-side paging may implement the plugin interface directly; then check it with `readAllText` (following `next` must reproduce every record exactly).
- Typert accepts one contribution per package name: use the plugin's own package name, never `dsh-reference-anything`.
- Mount the Host Remote inside `ctx.inject(['typert'], ...)` so the source still works for the model without Typert.
- A browser group inserts with `formatReferenceMention(ref, label)`; `appearance` is only `file`, `folder` or `session`.

## 3. Scaffold

Create `{{pluginRoot}}/<package-name>/`. Name the package `dsh-reference-<thing>` and check the name is not already in `{{profileDir}}/package.json`. Lay it out like the example at the end, renaming the package name, `SERVICE`, `SOURCE_ID`, the patch row id (`reference-<thing>`) and the group id.

Install what the code imports, at the DSH version, into the plugin directory itself:

```sh
npm init -y   # then replace package.json with one shaped like the example's
npm install -D esbuild typescript @deepseek-ai/cordis@{{dshVersion}} @deepseek-ai/dsh-typert-protocol@{{dshVersion}} @deepseek-ai/dsh-typert-registry@{{dshVersion}} @deepseek-ai/dsh-api-remotes@{{dshVersion}} @deepseek-ai/dsh-client-ui-input-trigger@{{dshVersion}} @deepseek-ai/schemastery zod
npm install -D "dsh-reference-anything@link:{{raDir}}"
```

Runtime dependencies the Host half needs (`zod`, `@deepseek-ai/schemastery`, `@deepseek-ai/dsh-typert-protocol`, plus anything for the origin) go in `dependencies`, so they resolve from the plugin's own `node_modules`.

### Build

The Host half is ordinary ESM:

```sh
npx esbuild src/index.ts --bundle --platform=node --format=esm --outfile=lib/index.js --packages=external
```

The browser half must be one CommonJS module wrapped for DSH's browser loader. It may `require` only modules the browser shell provides; bundle everything else (including `dsh-reference-anything/sdk`):

```js
// build-client.mjs
import { build } from 'esbuild'
const shell = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-api-session-controller/client', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-primitives', 'react', 'react-dom', 'react/jsx-runtime', 'scheduler']
await build({
  entryPoints: ['src/client.ts'], outfile: 'lib/client.js', bundle: true, format: 'cjs', platform: 'browser', target: ['es2022'],
  external: shell,
  banner: { js: "window.__ModuleLoader__.load({ id: '<package-name>', factory: (require) => { var module = { exports: {} }; var exports = module.exports;" },
  footer: { js: 'return module.exports; } });' },
})
```

Type-only imports (`import type`) cost nothing at runtime. Run `npx tsc --noEmit` before building.

## 4. Install into the profile

```sh
dsh plugin --profile {{profileName}} add "link:<absolute plugin directory>"
```

Then make sure `{{profileDir}}/package.json` lists the package under `dsh.profile.bundles` (add it if missing, keep the other entries in order). The plugin's own `cordis.patch.yml` inserts its row, so the user can switch it on and off on the plugin page like any other source. Restart DSH (or ask the user to) so the new bundle loads.

Never write account secrets into a patch file. Ask before writing outside the plugin directory and the profile's `package.json`.

## 5. Check it works

1. The plugin page lists the new row as running.
2. The model lists items with `reference({ source: '<id>', op: 'list' })`; after you `@` one, it reads it with `op: 'read'`.
3. Typing `@` shows the group (Settings → Reference Anything lists it with a 插件 badge); picking an item inserts a chip.
4. Switching the row off removes the source from the `reference` tool, the menu and Settings; an old reference then fails with a reason instead of returning empty content.

Report what you built, where it lives, and anything you could not verify.

## Example: notes in one directory

A complete source with a Host half, a Remote and an `@` group.
