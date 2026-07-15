# Web Source Inspector

Web Source Inspector opens the original Vue template location for an element selected in a local Vite, Webpack, or Vue CLI development page. This extension is the VS Code and Cursor side of the workflow.

## Requirements and compatibility

- VS Code 1.90 or a compatible Cursor version.
- A trusted local workspace.
- Node.js `>=16.20.2` for the project-local `web-source-inspector` CLI.
- `web-source-inspector` installed in the target Vue application, including a nested application in a monorepo.

| Component | Supported range |
| --- | --- |
| Vue 2.6 | `>=2.6.0 <2.7.0` |
| Vue 2.7 | `>=2.7.0 <2.8.0` |
| Vue 3 | `>=3.2.0 <4.0.0` |
| Vite | `>=2.9.0 <7.0.0` |
| Webpack | `>=4.0.0 <6.0.0` |
| Vue CLI | 3 through 5 |
| webpack-dev-server | 3.x, or `>=4.7.0 <5.0.0` |

The extension delegates compatibility decisions to the project-local CLI. It can edit a project only when the installed Vue plugin, `vue-loader`, Vue compiler, webpack-dev-server, and all relevant upstream `peerDependencies` are compatible. Vue 2.6 requires `vue-template-compiler` to have the same full version as the actual `vue` package. Vue 2.7 must resolve `vue/compiler-sfc` from the actual `vue` package anchor; it does not require a separately installed `@vue/compiler-*` package to have an equal full version. Vue 3 requires both `@vue/compiler-sfc` and `@vue/compiler-dom` to exist, each with the same full version as the actual `vue` package. A matching top-level range alone is not sufficient.

`vue-loader` 15, 16, and 17 do not declare an official Vue peer dependency. Missing Vue peer evidence therefore does not block Vue-family detection: the actual `vue/package.json` version determines the Vue family, and the corresponding Vue-family compiler evidence requirements still apply. For Webpack and Vue CLI, the CLI then checks that the `vue-loader` major matches that Vue family and that its webpack peer dependency is satisfied. Vite does not use `vue-loader`.

Raw Webpack watch mode accepts only an exact `http:` browser Origin. An `https:` Origin is unsupported and rejected.

## Usage

1. Install the npm package in the Vue project: `npm install -D web-source-inspector@0.1.0-beta.3`.
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

This is the only supported integration path: project-local npm dependency, workspace-local CLI, reviewable diff, user confirmation, then a static safe configuration edit. The extension does not install npm dependencies and cannot provide a zero-project-change workflow by itself.

For a Vite initialization, the extension resolves the normal required inputs first and then offers a browser access choice. The default permits local network-interface IP access on the same machine and does not add a `browserAccess` answer. It does not modify the project-owned `server.host`; that setting must already allow the interface. Choosing the loopback-only option regenerates the plan with `browserAccess=loopback`; the final apply uses that regenerated plan digest and normalized answers. Cancelling the choice does not apply any edits. The IDE Bridge always binds only to `127.0.0.1`.

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

## Distribution

The npm package and the VSIX have independent versioning, packaging, and publication steps. Updating or installing one does not update the other. A compatible VSIX and the project-local npm package are both required for this workflow; follow the repository release checklist when publishing either artifact.

## Security

Project changes are disabled in untrusted and Remote workspaces. The extension only launches the `web-source-inspector` CLI resolved from code inside a trusted workspace root, passes arguments without a shell, validates its versioned JSON response, displays the plan, and returns the confirmed plan digest.

Runtime source opening uses an authenticated loopback Bridge. Incoming relative paths are resolved with real-path checks and must remain inside both the declared development root and the open workspace. Diagnostics redact the current user's home directory.

## Initial release boundaries

- Remote SSH, WSL, Dev Containers, Codespaces, remote browsers, and untrusted workspace operation are not supported.
- The extension does not install npm dependencies automatically; it reports the project-specific install command. Installing only the extension is not a supported configuration.
- React, Svelte, SSR/hydration, Pug, MDX, external Vue templates, and Canvas/Three.js object-level selection are outside the first release.
- Third-party component internals are not transformed by default; selection may resolve to the user-code call site instead.
- Only build configuration shapes accepted by the project-local CLI can be changed automatically.
- A source build or old VSIX is not release evidence. Packaged VSIX installation and end-to-end opening still require separate VS Code and Cursor smoke verification.

## License

MIT. Bundled dependency notices are included in `THIRD_PARTY_NOTICES.md`.
