# Web Source Inspector

Web Source Inspector connects a local Vue development page to VS Code or Cursor and opens the original `.vue` template range for a selected element. This package contains the project-local CLI and the Vite, Webpack, and Vue CLI integration entry points.

## Requirements and compatibility

- Consumer projects: Node.js `>=16.20.2`.
- IDE companion: VS Code `>=1.90` or a Cursor build compatible with the same stable Extension API.
- The development server, IDE Extension Host, browser, and source workspace must be on the same machine.

| Component | Supported range |
| --- | --- |
| Vue 2.6 | `>=2.6.0 <2.7.0` |
| Vue 2.7 | `>=2.7.0 <2.8.0` |
| Vue 3 | `>=3.2.0 <4.0.0` |
| Vite | `>=2.9.0 <7.0.0` |
| Webpack | `>=4.0.0 <6.0.0` |
| Vue CLI | 3 through 5 |
| webpack-dev-server | 3.x, or `>=4.7.0 <5.0.0` |

An accepted project must satisfy more than these top-level ranges. The installed Vue plugin, `vue-loader`, Vue compiler, webpack-dev-server, and each package's upstream `peerDependencies` must form a compatible toolchain. Vue 2.6 requires `vue-template-compiler` to have the same full version as the actual `vue` package. Vue 2.7 must resolve `vue/compiler-sfc` from the actual `vue` package anchor; it does not require a separately installed `@vue/compiler-*` package to have an equal full version. Vue 3 requires both `@vue/compiler-sfc` and `@vue/compiler-dom` to exist, each with the same full version as the actual `vue` package. The CLI rejects a detected stack when that evidence is absent or incompatible instead of assuming that any version combination in the ranges works.

`vue-loader` 15, 16, and 17 do not declare an official Vue peer dependency. Missing Vue peer evidence therefore does not block Vue-family detection: the actual `vue/package.json` version determines the Vue family, and the corresponding Vue-family compiler evidence requirements still apply. For Webpack and Vue CLI, the CLI then checks that the `vue-loader` major matches that Vue family and that its webpack peer dependency is satisfied. Vite does not use `vue-loader`.

Raw Webpack watch mode accepts only an exact `http:` browser Origin. An `https:` Origin is unsupported and rejected.

## Install and manage integration

Install the current npm baseline as a development dependency in the Vue project:

```sh
npm install --save-dev web-source-inspector@0.1.0-beta.3
npx web-source-inspector init
```

The only supported integration path is project-local: install this package, then let its workspace-local CLI detect the project, generate an auditable diff, and write supported static configuration only after confirmation. `init` records created or reused ownership in `.web-source-inspector.json`.

The VS Code/Cursor extension is a companion to this flow. It calls the CLI resolved inside the opened workspace, shows the generated diff, and applies it only after confirmation. It never installs npm dependencies automatically. Installing the extension alone cannot enable inspection without a project dependency and project configuration change.

```sh
npx web-source-inspector doctor
npx web-source-inspector remove
```

`doctor` checks the recorded state and attempts recovery for an interrupted transaction. `remove` previews an ownership-aware removal plan and only removes nodes that still match the recorded fingerprint; it does not delete unrelated pre-existing configuration.

## Same-machine Vite IP access

`browserAccess` defaults to `same-machine`, so a Vite project can use a local network-interface IP on the same computer without an explicit plugin option. Source Inspector does not modify `server.host`; the project-owned Vite setting must already allow that interface. The actual listener port and Origin must match exactly, and network changes require a Dev Server restart. Configure `webSourceInspector({ browserAccess: 'loopback' })` to limit browser access to loopback addresses. The IDE Bridge always binds only to `127.0.0.1`. `remoteBrowser` is deprecated and only accepts `false`; phones, other computers, proxies, port forwarding, WSL, Docker, Dev Containers, and Remote SSH are unsupported.

The same workflow is available through the companion extension. Open a trusted local workspace, run **Source Inspector: Enable Project**, review the diff, confirm the plan, and then continue using the project's existing `dev` or `serve` command. In a monorepo, choose the actual Vue application when prompted.

## Select an element

When the development page loads, the browser runtime shows a floating Source Inspector button, bottom-right by default. Click it or press `Alt+Shift+C` to enter selection mode, hover to inspect a candidate, and click to open it in the connected editor. `Esc` exits selection mode. By default, a successful selection is single-shot; `Shift+click` prefers a component call-site candidate and `Alt+click` prefers a nearby control-flow candidate when available.

The floating button is a development-only control. Production builds should not contain the runtime, `data-wsi-*` markers, the local Bridge, or source metadata.

## Initial release boundaries

- Local, trusted workspaces only. Remote SSH, WSL, Dev Containers, Codespaces, remote browsers, and workspace-external source opening are not supported.
- Vue HTML templates only. React, Svelte, SSR/hydration, external template files, Pug, and MDX are outside the first release.
- Third-party package templates are not transformed by default; selection falls back to the call site in user code when possible.
- Canvas and Three.js object-level source selection is not implemented; only the surrounding DOM element can be selected.
- Dynamic or ambiguous build configuration outside the initializer's static AST allowlist is reported and left unchanged.
- Cursor and packaged VSIX compatibility require release smoke testing; API compatibility alone is not treated as verification.

## License

MIT. Third-party notices are included in `THIRD_PARTY_NOTICES.md`.
