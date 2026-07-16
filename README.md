# Web Source Inspector

> 简体中文 | [English](README.en.md)

**一键定位 Vue 页面元素的源码位置**

在浏览器中点击任意元素，自动在 VS Code 或 Cursor 中打开对应的 `.vue` 文件并跳转到准确行。支持 Vite、Webpack 和 Vue CLI 项目。

![Version](https://img.shields.io/badge/npm-0.1.0--beta.3-blue)
![VS Code Extension](https://img.shields.io/badge/vsix-0.1.1-green)

---

## 快速开始

### 环境要求

- **Node.js** ≥ 16.20.2
- **Vue** 2.6 / 2.7 / 3.2+
- **构建工具**：Vite 2.9+ 或 Webpack 4/5（含 Vue CLI）
- **编辑器**：VS Code ≥ 1.90 或 Cursor

> ⚠️ 浏览器、开发服务器和 IDE 必须在同一台电脑上

---

## 三步安装

### 第一步：安装 npm 包

在你的 Vue 项目根目录执行：

```bash
npm install -D web-source-inspector
```

或使用其他包管理器：

```bash
# pnpm
pnpm add -D web-source-inspector

# yarn
yarn add -D web-source-inspector
```

### 第二步：安装 VS Code/Cursor 插件

1. 前往 [GitHub Releases](https://github.com/Rich-hy/web-source-inspector/releases/latest) 页面
2. 下载 `web-source-inspector.vsix` 文件
3. 在 VS Code 或 Cursor 中：
   - 打开扩展面板（`Ctrl+Shift+X` / `Cmd+Shift+X`）
   - 点击右上角 `...` 菜单
   - 选择 **"Install from VSIX..."**
   - 选择下载的 `.vsix` 文件

### 第三步：启用项目

打开你的 Vue 项目，选择以下任一方式启用：

#### 方式 1：使用命令行

```bash
npx web-source-inspector init
```

#### 方式 2：使用 VS Code/Cursor 命令

1. 按 `Ctrl+Shift+P` / `Cmd+Shift+P` 打开命令面板
2. 输入并选择 **"Source Inspector: Enable Project"**
3. 查看配置预览，确认后自动写入

> 💡 工具会自动检测你的构建工具（Vite/Webpack/Vue CLI），只修改必要的配置文件，不会改动你的业务代码。

---

## 开始使用

### 1. 启动开发服务器

像往常一样启动项目：

```bash
npm run dev
# 或
npm run serve
```

### 2. 打开浏览器

访问开发服务器地址（如 `http://localhost:5173`），页面右下角会出现 Inspector 按钮。

### 3. 选择元素

**方式 1：点击按钮**
- 点击页面右下角的 Inspector 按钮
- 鼠标悬停在目标元素上（会高亮显示）
- 点击元素

**方式 2：快捷键**
- 按 `Alt+Shift+C` 进入选择模式
- 悬停并点击目标元素

### 4. 自动打开源码

VS Code/Cursor 会自动打开对应的 `.vue` 文件，并定位到 template 中的具体位置。

### 快捷操作

| 操作 | 说明 |
|------|------|
| `Esc` | 退出选择模式 |
| `点击` | 选择元素并打开源码 |
| `Shift + 点击` | 优先定位到组件调用点 |
| `Alt + 点击` | 优先定位到控制流语句（如 `v-if`） |

---

## 检查和卸载

### 检查项目状态

```bash
npx web-source-inspector doctor
```

该命令会检查：
- 依赖是否正确安装
- 配置是否正确写入
- 构建工具版本是否兼容

### 卸载工具

如果需要移除项目配置：

```bash
npx web-source-inspector remove
```

然后从 `package.json` 中移除依赖：

```bash
npm uninstall web-source-inspector
```

---

## 支持的功能

✅ 普通 DOM 元素、组件、`v-for`、`v-if`、Slot、动态组件、Teleport  
✅ Shadow DOM 内的元素选择和高亮  
✅ 同机网卡 IP 访问（Vite 项目，需配置 `server.host`）  
✅ 多浏览器 Tab 和多 IDE 窗口的会话管理  
✅ HMR 热更新后自动同步 source mapping  

---

## 支持范围

| 类型 | 支持版本 |
|------|---------|
| **Vue** | 2.6.x、2.7.x、3.2+ |
| **Vite** | 2.9.0 ~ 6.x |
| **Webpack** | 4.x、5.x |
| **Vue CLI** | 3.x、4.x、5.x |
| **包管理器** | npm、pnpm、Yarn（node_modules 模式） |

### 当前不支持

- ❌ React、Svelte 等其他框架
- ❌ Pug/MDX 模板语法
- ❌ SSR 服务端渲染
- ❌ WSL、Docker、Remote SSH、Dev Container
- ❌ 其他设备上的远程浏览器
- ❌ Yarn PnP、Bun

---

## 故障排查

### 问题 1：页面没有出现 Inspector 按钮

**可能原因：**
- 项目配置未正确写入
- 开发服务器未重启

**解决方法：**
```bash
# 检查项目状态
npx web-source-inspector doctor

# 如果配置有问题，重新启用
npx web-source-inspector remove
npx web-source-inspector init

# 重启开发服务器
npm run dev
```

### 问题 2：点击元素后 IDE 没有反应

**可能原因：**
- VS Code/Cursor 插件未安装
- IDE 未打开项目工作区
- 工作区不受信任

**解决方法：**
1. 确认插件已安装（扩展面板搜索 "Web Source Inspector"）
2. 确认 IDE 以文件夹方式打开了项目（不是单个文件）
3. 如果提示工作区不受信任，选择"信任此工作区"

### 问题 3：Webpack 项目配置失败

**可能原因：**
- 缺少 `vue-loader`
- Vue 版本与 `vue-loader` 版本不匹配

**解决方法：**
```bash
# 检查诊断信息
npx web-source-inspector doctor

# 根据提示安装缺失的依赖
npm install -D vue-loader
```

更多问题参见 [故障排查文档](docs/troubleshooting.md)。

---

## 同机网卡访问（Vite 项目）

默认情况下，工具允许通过本机 IP 地址访问页面（如 `http://192.168.1.100:5173`），前提是 Vite 配置了网络访问：

```js
// vite.config.js
export default {
  server: {
    host: '0.0.0.0' // 或具体的本机 IP
  }
}
```

如果需要限制为仅回环地址（`localhost`/`127.0.0.1`），可在插件配置中显式指定：

```js
import { webSourceInspector } from 'web-source-inspector/vite'

export default {
  plugins: [
    webSourceInspector({
      browserAccess: 'loopback' // 仅允许 localhost
    })
  ]
}
```

> ⚠️ IDE Bridge 始终只监听 `127.0.0.1`，其他设备无法连接。

---

## 安全说明

- ✅ 浏览器只发送不透明的 `sourceId`，不包含文件路径或源码内容
- ✅ IDE Bridge 只监听本地回环地址（`127.0.0.1`），外部设备无法访问
- ✅ 生产构建（`build`/`production` 模式）自动禁用所有功能，不会注入任何代码
- ✅ IDE 打开文件前会验证路径是否在工作区内，拒绝访问工作区外的文件

**发布前检查：** 请按照 [安全文档](docs/security.md#生产构建核验) 对生产构建产物执行字符串扫描，确保没有残留的调试代码。

如发现安全问题，请参照 [SECURITY.md](SECURITY.md) 进行私下报告。

---

## 文档

- [配置选项](docs/quick-start.md)
- [故障排查](docs/troubleshooting.md)
- [架构设计](docs/architecture.md)
- [安全模型](docs/security.md)
- [能力矩阵](docs/capabilities.md)
- [变更记录](CHANGELOG.md)

---

## 本地开发（贡献者）

如果你想参与项目开发或在本地构建：

```bash
# 环境要求：Node.js >= 20.19.0, pnpm >= 10

# 安装依赖
pnpm install

# 构建所有包
pnpm build

# 启动测试项目
pnpm dev:basic

# 打包 VSIX 插件
pnpm package:vsix
# 产物：packages/vscode-extension/web-source-inspector.vsix

# 运行测试
pnpm test
pnpm test:e2e
```

详细开发指南参见 [本地开发文档](docs/development.md)。

---

## License

[MIT](LICENSE)

第三方依赖许可证详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
