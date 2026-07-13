# Web Source Inspector

Web Source Inspector opens the original Vue template location for an element selected in a local Vite, Webpack, or Vue CLI development page. This extension is the VS Code and Cursor side of the workflow.

## Requirements and compatibility

- VS Code 1.90 or a compatible Cursor version.
- A trusted local workspace.
- Node.js `>=16.20.2` for the project-local `web-source-inspector` CLI.
- `web-source-inspector` installed in the target Vue application, including a nested application in a monorepo.

| Vue | Vite release tuples | Webpack / Vue CLI release tuples |
| --- | --- | --- |
| Vue 2.6 | Initial-release tuple: Vue 2.6.x + Vite 2.x + `vite-plugin-vue2` 2.x + exact-matching `vue-template-compiler`. | Representative tuple: Vue 2.6.x + Webpack 4 + `vue-loader` 15 + webpack-dev-server 3. Other Webpack 4/5 or Vue CLI 3-5 stacks are eligible only when the selected upstream releases are peer-compatible. |
| Vue 2.7 | Initial-release tuple: Vue 2.7.x + Vite 3.x + `@vitejs/plugin-vue2` 2.x, using Vue 2.7's SFC compiler. | Representative tuple: Vue 2.7.x + Webpack 5 + `vue-loader` 15 + webpack-dev-server `>=4.7 <5`. Vue CLI is eligible only when its bundled Webpack, loader, and dev-server versions form an upstream-compatible stack. |
| Vue 3.2+ | Planned tuple families: Vite 2/plugin 2, Vite 3/plugin 3, Vite 4/plugin 4, Vite 5/plugin 5, and Vite 6 with an `@vitejs/plugin-vue` 5 release whose published peer range includes Vite 6. | Representative tuple: Vue 3.2+ + Webpack 5 + `vue-loader` 17 + webpack-dev-server `>=4.7 <5`. Webpack 4/5, `vue-loader` 16/17, and Vue CLI are eligible only in combinations allowed by the selected releases' upstream peer ranges. |

Vue and its template compiler must match. Webpack dev-server is limited to 3.x or `>=4.7 <5`. Detector acceptance does not turn these rows into a Cartesian product. Current automated browser E2E evidence covers Vue 3.5.39 + Vite 6.4.3 + `@vitejs/plugin-vue` 5.2.4, and Vue 3.5.39 + Webpack 5.108.4 + `vue-loader` 17.4.2 + webpack-dev-server 4.15.2. The packaged VSIX has been installed in Cursor and connected to the loopback Bridge of a Vue 2.7.16 + Vue CLI 3.12.1 + Webpack 4.47.0 + `vue-loader` 15.11.1 project. VS Code installation, the final browser-click-to-file-open interaction, and every other tuple remain separate release verification.

## Usage

1. Install the npm package in the Vue project: `npm install -D web-source-inspector`.
2. Open the trusted local workspace in VS Code or Cursor.
3. Use the Source Inspector status-bar item or run `Source Inspector: Enable Project`.
4. In a monorepo, select the nested Vue application. Answer any required bundler or origin prompt.
5. Inspect the generated diff and confirm the modal apply step.
6. Continue using the project's existing development command.
7. Wait for the status bar to discover and connect the matching local session.
8. In the browser, click the floating Source Inspector button or press `Alt+Shift+C`, then select an element.

The status bar distinguishes package-not-installed, installed-but-not-enabled, configuration-conflict, waiting-for-dev-server, discovered-session, and connected states. Candidate scanning excludes dependency and build directories, is capped, and is reused for project selection and monorepo status detection.

The same project integration is available from the terminal:

```sh
npx web-source-inspector init
npx web-source-inspector doctor
npx web-source-inspector remove
```

`init` previews and applies supported static edits, `doctor` checks state and interrupted transactions, and `remove` performs fingerprint-checked ownership-aware removal. The extension always calls the project-local CLI, validates its versioned JSON envelope and operation result, and never uses a global package or a second configuration rewriter.

The browser button is bottom-right by default. `Esc` exits selection mode; `Shift+click` prefers a component call site and `Alt+click` prefers a control-flow candidate when available. Successful selection is single-shot by default.

## Commands

- `Source Inspector: Enable Project`
- `Source Inspector: View Integration Plan`
- `Source Inspector: Run Doctor`
- `Source Inspector: Disable Project`
- `Source Inspector: Connect Session`
- `Source Inspector: Choose Session/Tab`
- `Source Inspector: Toggle Browser Select Mode`
- `Source Inspector: Open Last Selection`
- `Source Inspector: Choose Source Candidate`
- `Source Inspector: Show Diagnostics`
- `Source Inspector: Disconnect`

## Security

Project changes are disabled in untrusted and Remote workspaces. The extension only launches the `web-source-inspector` CLI resolved from code inside a trusted workspace root, passes arguments without a shell, validates its versioned JSON response, displays the plan, and returns the confirmed plan digest.

Runtime source opening uses an authenticated loopback Bridge. Incoming relative paths are resolved with real-path checks and must remain inside both the declared development root and the open workspace. Diagnostics redact the current user's home directory.

## Initial release boundaries

- Remote SSH, WSL, Dev Containers, Codespaces, remote browsers, and untrusted workspace operation are not supported.
- The extension does not install npm dependencies automatically; it reports the project-specific install command.
- React, Svelte, SSR/hydration, Pug, MDX, external Vue templates, and Canvas/Three.js object-level selection are outside the first release.
- Third-party component internals are not transformed by default; selection may resolve to the user-code call site instead.
- Only build configuration shapes accepted by the project-local CLI can be changed automatically.
- A source build or old VSIX is not release evidence. Packaged VSIX installation and end-to-end opening still require separate VS Code and Cursor smoke verification.

## License

MIT. Bundled dependency notices are included in `THIRD_PARTY_NOTICES.md`.
