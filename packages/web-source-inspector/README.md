# Web Source Inspector

Web Source Inspector connects a local Vue development page to VS Code or Cursor and opens the original `.vue` template range for a selected element. This package contains the project-local CLI and the Vite, Webpack, and Vue CLI integration entry points.

## Requirements and compatibility

- Consumer projects: Node.js `>=16.20.2`.
- IDE companion: VS Code `>=1.90` or a Cursor build compatible with the same stable Extension API.
- The development server, IDE Extension Host, browser, and source workspace must be on the same machine.

| Vue | Vite release tuples | Webpack / Vue CLI release tuples |
| --- | --- | --- |
| Vue 2.6 | Initial-release tuple: Vue 2.6.x + Vite 2.x + `vite-plugin-vue2` 2.x + an exact-matching `vue-template-compiler`. Later Vite majors are not implied. | Representative tuple: Vue 2.6.x + Webpack 4 + `vue-loader` 15 + webpack-dev-server 3 + an exact-matching `vue-template-compiler`. Other Webpack 4/5 or Vue CLI 3-5 stacks are considered only when their selected releases are mutually compatible under upstream `peerDependencies`. |
| Vue 2.7 | Initial-release tuple: Vue 2.7.x + Vite 3.x + `@vitejs/plugin-vue2` 2.x, using the SFC compiler shipped by Vue 2.7. Later Vite majors are not implied. | Representative tuple: Vue 2.7.x + Webpack 5 + `vue-loader` 15 + webpack-dev-server `>=4.7 <5`. Vue CLI is considered only when its bundled Webpack, `vue-loader`, and dev-server versions form an upstream-compatible stack. |
| Vue 3.2+ | Planned tuple families: Vite 2 + `@vitejs/plugin-vue` 2; Vite 3 + plugin 3; Vite 4 + plugin 4; Vite 5 + plugin 5; and Vite 6 + a plugin 5 release whose published peer range includes Vite 6. Every tuple also requires a matching `@vue/compiler-sfc`. | Representative tuple: Vue 3.2+ + Webpack 5 + `vue-loader` 17 + webpack-dev-server `>=4.7 <5` + matching `@vue/compiler-sfc`. Webpack 4/5, `vue-loader` 16/17, and Vue CLI combinations are considered only where the selected upstream releases declare a compatible stack. |

Webpack dev-server support is limited to 3.x or `>=4.7 <5`. Raw Webpack watch mode asks for the exact HTTP(S) browser origin. The detector may recognize additional versions inside its implementation ranges, but recognition is not a claim that an arbitrary cross-product is supported. Current automated browser E2E evidence covers Vue 3.5.39 + Vite 6.4.3 + `@vitejs/plugin-vue` 5.2.4, and Vue 3.5.39 + Webpack 5.108.4 + `vue-loader` 17.4.2 + webpack-dev-server 4.15.2. A packaged VSIX has also been installed in Cursor and connected to the loopback Bridge of a Vue 2.7.16 + Vue CLI 3.12.1 + Webpack 4.47.0 + `vue-loader` 15.11.1 project. The final browser-click-to-file-open interaction and other tuples still require separate verification.

## Install and manage integration

This is a beta release for public validation. Install it through the `beta` dist-tag:

```sh
npm install --save-dev web-source-inspector@beta
npx web-source-inspector init
```

`init` detects the framework and bundler, collects any required choices, prints the planned edits, and asks before writing. It only rewrites supported static configuration shapes and records created or reused ownership in `.web-source-inspector.json`.

```sh
npx web-source-inspector doctor
npx web-source-inspector remove
```

`doctor` checks the recorded state and attempts recovery for an interrupted transaction. `remove` previews an ownership-aware removal plan and only removes nodes that still match the recorded fingerprint; it does not delete unrelated pre-existing configuration.

## Same-machine Vite IP access

`browserAccess` defaults to `same-machine`, so a Vite project can use a local network-interface IP on the same computer without an explicit plugin option. `server.host` must permit that interface, the actual listener port and Origin must match exactly, and network changes require a Dev Server restart. Configure `webSourceInspector({ browserAccess: 'loopback' })` to limit browser access to loopback addresses. The IDE Bridge still binds only to `127.0.0.1`. `remoteBrowser` is deprecated and only accepts `false`; phones, other computers, proxies, port forwarding, WSL, Docker, Dev Containers, and Remote SSH are unsupported.

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
