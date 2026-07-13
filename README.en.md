# Web Source Inspector

[简体中文](README.md) | **English**

> **Development status:** version 0.1.0 is a local development/release candidate. It has not been published to the npm registry, VS Marketplace, Open VSX, or Cursor Marketplace. Build the npm tarball and VSIX from this repository for local evaluation. Packaged VSIX behavior in VS Code and Cursor still requires release smoke-test evidence for each editor.

Web Source Inspector maps an element in a Vue development page back to its original .vue template range in VS Code or Cursor. It works through project-side Vite or Webpack/Vue CLI integration, rather than attempting to guess source locations from the final DOM.

The system combines a Vue SFC transform, a browser inspector, an in-memory development-server manifest, a local authenticated Bridge, and an IDE extension. The browser only submits an opaque source ID with browser-transport authentication and session metadata; it never receives source paths, source ranges, or IDE Bridge credentials.

## Highlights

- Maps ordinary DOM nodes, component call sites, loops, conditional branches, Slots, Fragments, dynamic components, and Teleport output to trusted Vue template candidates.
- Provides a development-only floating inspector, hover highlighting, Shadow DOM isolation, keyboard shortcuts, and selection-mode event interception.
- Supports a one-time, ownership-aware project setup through the project-local CLI or the VS Code/Cursor extension.
- Preserves existing development commands and only changes recognized static Vite, Webpack, or Vue CLI configuration shapes.
- Keeps HMR generations and stale source-ID tombstones in memory so an outdated ID is not guessed onto a new file or range.
- Uses a loopback-only, authenticated IDE Bridge and revalidates workspace containment before an editor opens a file.

## Scope and compatibility

The current implementation targets Vue 2.6, Vue 2.7, and Vue 3.2+ projects using standard supported configurations of Vite 2–6, Webpack 4/5, or Vue CLI 3/4/5. The exact Vue compiler, bundler plugin, loader, and development-server versions must also be compatible with one another under their upstream peer-dependency rules.

These version ranges are implementation scope, not a claim that every version combination has end-to-end release evidence. The current automated browser evidence covers:

| Environment | Current evidence |
| --- | --- |
| Vue 3.5.39 + Vite 6.4.3 + @vitejs/plugin-vue 5.2.4 | Seven browser E2E cases cover the inspector UI, markers, event isolation, v-for IDs, Teleport, component-call-site selection, and privacy of tooltip/protocol data. |
| Vue 3.5.39 + Webpack 5.108.4 + vue-loader 17.4.2 + webpack-dev-server 4.15.2 | One browser E2E case covers the Loader, Runtime, Webpack Dev Server stream/hello flow, and metadata request. |
| Vue 2.7.16 + Vue CLI 3.12.1 + Webpack 4.47.0 + vue-loader 15.11.1 | A local project has started and restarted successfully; the packaged VSIX was installed in Cursor and connected to its local Bridge. Browser-click-to-file-open verification is still pending. |

See the [capability and verification matrix](docs/capabilities.md) for exact behavior, remaining gaps, and the distinction between implemented functionality, automated coverage, and real editor verification.

### Out of scope for the first release

- React, Svelte, SSR/hydration, independent Rollup integration, Pug, MDX, and external Vue template files.
- Canvas or Three.js object-level selection. The surrounding canvas DOM element can be selected, but a separate adapter is required for rendered objects.
- Remote browsers, WSL, Remote SSH, Dev Containers, Codespaces, and any workflow where the browser, development server, extension host, and source workspace are not on the same machine.
- Opening files outside the trusted local workspace.
- Transforming third-party component templates by default. When possible, selection falls back to the component call site in user code.

## Requirements

- Consumer project: Node.js 16.20.2 or later.
- Repository development: Node.js 20.19.0 or later and pnpm 10 or later.
- Vue 2.6, Vue 2.7, or Vue 3.2+ with a supported bundler configuration.
- VS Code 1.90 or later, or a Cursor build compatible with the same stable Extension API.
- The browser, development server, IDE Extension Host, and source workspace must run on the same local machine.

## Quick start

Because 0.1.0 is not yet available in a registry, first build a local npm tarball from this repository:

~~~powershell
pnpm install
pnpm package:npm
~~~

Install the generated web-source-inspector-0.1.0.tgz in the target Vue project as a development dependency. After a registry release, the equivalent command will be:

~~~powershell
npm install --save-dev web-source-inspector
~~~

### Option 1: enable from the terminal

In the Vue project where the local tarball is installed, run:

~~~powershell
npx web-source-inspector init
~~~

The CLI detects the Vue and bundler setup, previews the planned edits, and waits for confirmation before writing. It only updates supported static configuration shapes. Dynamic or ambiguous configurations receive diagnostics instead of guessed rewrites.

Use the following commands to inspect or safely remove the managed integration later:

~~~powershell
npx web-source-inspector doctor
npx web-source-inspector remove
~~~

### Option 2: enable from VS Code or Cursor

Build the extension VSIX in this repository:

~~~powershell
pnpm package:vsix
~~~

The resulting file is:

~~~text
packages/vscode-extension/web-source-inspector.vsix
~~~

In VS Code or Cursor, choose **Install from VSIX...**, select that file, reload when prompted, and open the trusted local Vue workspace. Run **Source Inspector: Enable Project**, review the plan and diff, and confirm the change.

The extension invokes the same project-local CLI logic as the terminal workflow. It does not download packages, use a global CLI, or replace the project’s existing dev or serve command.

## Use the inspector

1. Open the target project as a trusted local workspace in VS Code or Cursor.
2. Start the project with its existing development command, such as npm run dev or npm run serve.
3. Let the extension discover and connect to the matching local development session, or choose one manually.
4. In the browser, click the Source Inspector button or press Alt+Shift+C.
5. Hover an element to inspect its candidate, then click it to open the corresponding Vue template range in the connected editor.

Press Esc to leave selection mode. A successful selection exits by default because single-shot mode is enabled. Shift+click prefers a component call-site candidate, while Alt+click prefers a nearby control-flow candidate when available. While selection mode is armed, the runtime intercepts the relevant pointer, click, and context-menu events in the capture phase so normal page behavior is not triggered by a source-selection click.

For advanced Vite options, configuration examples, extension commands, and settings, see the [quick-start guide](docs/quick-start.md).

## How it works

~~~text
Vue SFC
  -> Vite or Webpack/Vue CLI adapter injects DOM and component markers
  -> Browser Runtime selects an opaque sourceId
  -> Development-server in-memory Manifest resolves a trusted relative path and range
  -> Authenticated Bridge on a random 127.0.0.1 port
  -> VS Code/Cursor extension revalidates the workspace and opens the source
~~~

The Inspector is development-only. The Vite adapter creates a session only for a real development server; the Webpack adapter enables itself only in development mode with a usable development transport. A production build must not include the Runtime, source markers, browser events, Manifest, or Bridge.

## Workspace packages

| Package | Responsibility |
| --- | --- |
| <code>@web-source-inspector/protocol</code> | Protocol versioning, message types, limits, error codes, and runtime validation. |
| <code>@web-source-inspector/compiler-core</code> | Source IDs, source records, manifests, digests, and candidate ranking. |
| <code>@web-source-inspector/transform-vue</code> | Vue SFC AST transforms, marker injection, and sourcemaps. |
| <code>@web-source-inspector/runtime</code> | The browser button, highlighting, selection mode, and HMR transport. |
| <code>@web-source-inspector/dev-session-core</code> | Bundler-neutral Browser Router, Bridge, and session lifecycle. |
| <code>@web-source-inspector/vite-plugin</code> | Vite adapter, Runtime injection, and Manifest lifecycle. |
| <code>@web-source-inspector/adapter-webpack</code> | Webpack/Vue CLI plugin, Loader, and browser transport. |
| <code>@web-source-inspector/init-core</code> | Project detection, AST plan/apply/remove, doctor, and transaction recovery. |
| <code>web-source-inspector</code> | The only public npm package, CLI, and Vite/Webpack exports. |
| <code>web-source-inspector-vscode</code> | VS Code/Cursor extension, project enablement, session discovery, and source opening. |

The <code>fixtures/</code> directory contains basic Vite and Webpack Vue applications, an Element Plus fixture, and a monorepo fixture used to exercise integration boundaries.

## Develop locally

Repository development requires Node.js 20.19.0 or later and pnpm 10 or later.

~~~powershell
pnpm install
pnpm build
pnpm dev:basic
~~~

Open the local Vite URL printed by the command. The Inspector button in the lower-right corner lets you check markers, hover behavior, and browser-event isolation. To open a real source file, also package and install the local VSIX:

~~~powershell
pnpm package:vsix
~~~

The resulting extension is <code>packages/vscode-extension/web-source-inspector.vsix</code>. In VS Code or Cursor, use **Install from VSIX...**, reload when prompted, and open this repository or another supported local Vue workspace.

## Useful commands

~~~powershell
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
pnpm package:npm
pnpm package:vsix
~~~

Install Chromium before the first Playwright run if it is not already present:

~~~powershell
pnpm exec playwright install chromium
~~~

These commands cover different evidence layers. Automated checks, package smoke checks, and an actual packaged-VSIX installation are not interchangeable; consult the capability matrix before treating a candidate as ready for release.

## Documentation

The detailed project documentation is currently written in Chinese:

- [Quick start and configuration](docs/quick-start.md)
- [Architecture and key decisions](docs/architecture.md)
- [Protocol](docs/protocol.md)
- [Security model](docs/security.md)
- [Capabilities and verification matrix](docs/capabilities.md)
- [Adapter authoring constraints](docs/adapter-authoring.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Release and VSIX checklist](docs/release.md)
- [Changelog](CHANGELOG.md)
- [Security reporting](SECURITY.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

## Security and production boundary

- The browser transport carries an opaque source ID rather than a local path or source range. The IDE extension independently validates the workspace root, relative path, and realpath containment before opening a file.
- The Bridge listens on loopback only and uses authentication and session metadata to keep browser tabs and connected IDEs isolated.
- Workspace Trust is required. Files outside the trusted workspace are always rejected.
- Inspectors belong only in development builds. Before distributing a consuming project, follow the [production-build verification guidance](docs/security.md#生产构建核验) and check its real output.

To report a security issue privately, follow [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for third-party dependency and distribution information.
