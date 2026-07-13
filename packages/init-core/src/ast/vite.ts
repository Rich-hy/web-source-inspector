import { parse as babelParse } from '@babel/parser';
import recast from 'recast';
import { digestCanonical } from '../digest';
import type { AstOperation } from '../plan/types';
import type { ConfigModuleKind } from '../types';
import {
  astOperationFingerprint,
  capturePositionAnchors,
  restoreByPositionAnchors,
} from './fingerprint';

type AstNode = Record<string, unknown> & { type: string };

export interface ViteAstTransformResult {
  ok: boolean;
  code: string;
  operations: AstOperation[];
  errorCode?: string;
}

export interface ViteAstRemoveResult extends ViteAstTransformResult {}

const VUE_PLUGIN_PACKAGES = new Set([
  '@vitejs/plugin-vue',
  '@vitejs/plugin-vue2',
  'vite-plugin-vue2',
]);

function parseProgram(source: string): AstNode {
  return recast.parse(source, {
    parser: {
      parse(value: string) {
        return babelParse(value, {
          sourceType: 'unambiguous',
          allowAwaitOutsideFunction: true,
          plugins: [
            'typescript',
            'jsx',
            'decorators-legacy',
            'importAttributes',
            'topLevelAwait',
          ],
        });
      },
    },
  }) as unknown as AstNode;
}

function printProgram(ast: AstNode, source: string): string {
  const lineEnding = source.includes('\r\n') ? '\r\n' : source.includes('\r') ? '\r' : '\n';
  return recast.print(ast as never, { reuseWhitespace: true }).code
    .replace(/\r\n|\r|\n/gu, lineEnding);
}

function programBody(ast: AstNode): AstNode[] {
  const program = ast.program as AstNode | undefined;
  return (program?.body as AstNode[] | undefined) ?? [];
}

function isIdentifier(node: unknown, name?: string): node is AstNode & { name: string } {
  if (typeof node !== 'object' || node === null || (node as AstNode).type !== 'Identifier') {
    return false;
  }
  return name === undefined || (node as { name?: unknown }).name === name;
}

function isStringLiteral(
  node: unknown,
  value?: string,
): node is AstNode & { value: string } {
  if (typeof node !== 'object' || node === null) {
    return false;
  }
  const candidate = node as AstNode & { value?: unknown };
  return (candidate.type === 'StringLiteral' || candidate.type === 'Literal')
    && typeof candidate.value === 'string'
    && (value === undefined || candidate.value === value);
}

function findVariableInitializer(body: AstNode[], name: string): AstNode | undefined {
  for (const statement of body) {
    if (statement.type !== 'VariableDeclaration') {
      continue;
    }
    for (const declaration of (statement.declarations as AstNode[] | undefined) ?? []) {
      if (isIdentifier(declaration.id, name) && typeof declaration.init === 'object' && declaration.init) {
        return declaration.init as AstNode;
      }
    }
  }
  return undefined;
}

function containsReturnInCurrentFunction(
  node: unknown,
  seen = new WeakSet<object>(),
): boolean {
  if (typeof node !== 'object' || node === null || seen.has(node)) {
    return false;
  }
  seen.add(node);
  const candidate = node as AstNode;
  if (candidate.type === 'ReturnStatement') {
    return true;
  }
  if (['ArrowFunctionExpression', 'FunctionDeclaration', 'FunctionExpression', 'ObjectMethod']
    .includes(candidate.type)) {
    return false;
  }
  return Object.entries(candidate).some(([key, value]) => {
    if (['loc', 'start', 'end', 'tokens', 'comments', 'original'].includes(key)) {
      return false;
    }
    return Array.isArray(value)
      ? value.some((item) => containsReturnInCurrentFunction(item, seen))
      : containsReturnInCurrentFunction(value, seen);
  });
}

function unwrapConfigObject(
  node: AstNode | undefined,
  body: AstNode[],
  seen = new WeakSet<object>(),
): AstNode | undefined {
  if (!node) {
    return undefined;
  }
  if (seen.has(node)) {
    return undefined;
  }
  seen.add(node);
  if (node.type === 'ObjectExpression') {
    return node;
  }
  if (isIdentifier(node)) {
    return unwrapConfigObject(findVariableInitializer(body, node.name), body, seen);
  }
  if (node.type === 'CallExpression') {
    const argumentsList = (node.arguments as AstNode[] | undefined) ?? [];
    if (isIdentifier(node.callee, 'defineConfig') && argumentsList.length === 1) {
      return unwrapConfigObject(argumentsList[0], body, seen);
    }
  }
  if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') {
    const functionBody = node.body as AstNode | undefined;
    if (functionBody?.type === 'ObjectExpression') {
      return functionBody;
    }
    if (functionBody?.type === 'BlockStatement') {
      const statements = (functionBody.body as AstNode[] | undefined) ?? [];
      const returns = statements
        .filter((statement) => statement.type === 'ReturnStatement');
      if (returns.length === 1
        && !statements.some((statement) => statement.type !== 'ReturnStatement'
          && containsReturnInCurrentFunction(statement))) {
        return unwrapConfigObject(returns[0]?.argument as AstNode | undefined, body, seen);
      }
    }
  }
  return undefined;
}

function findExportedConfig(body: AstNode[]): AstNode | undefined {
  for (const statement of body) {
    if (statement.type === 'ExportDefaultDeclaration') {
      return statement.declaration as AstNode | undefined;
    }
    if (statement.type !== 'ExpressionStatement') {
      continue;
    }
    const expression = statement.expression as AstNode | undefined;
    if (expression?.type !== 'AssignmentExpression') {
      continue;
    }
    const left = expression.left as AstNode | undefined;
    if (left?.type !== 'MemberExpression') {
      continue;
    }
    if (left.computed !== true
      && isIdentifier(left.object, 'module')
      && isIdentifier(left.property, 'exports')) {
      return expression.right as AstNode | undefined;
    }
  }
  return undefined;
}

function propertyName(property: AstNode): string | undefined {
  const key = property.key;
  if (isIdentifier(key)) {
    return key.name;
  }
  if (isStringLiteral(key)) {
    return (key as { value: string }).value;
  }
  return undefined;
}

function objectProperties(object: AstNode): AstNode[] | undefined {
  const properties = (object.properties as AstNode[] | undefined) ?? [];
  const names = new Set<string>();
  for (const property of properties) {
    if (!['ObjectMethod', 'ObjectProperty', 'Property'].includes(property.type)
      || property.computed === true) {
      return undefined;
    }
    const name = propertyName(property);
    if (!name || names.has(name)) {
      return undefined;
    }
    names.add(name);
  }
  return properties;
}

function findPluginsArray(config: AstNode, body: AstNode[]): AstNode | undefined {
  for (const property of objectProperties(config) ?? []) {
    if ((property.type === 'ObjectProperty' || property.type === 'Property')
      && propertyName(property) === 'plugins') {
      const value = property.value as AstNode | undefined;
      if (value?.type === 'ArrayExpression') {
        return value;
      }
      if (isIdentifier(value)) {
        const initializer = findVariableInitializer(body, value.name);
        return initializer?.type === 'ArrayExpression' ? initializer : undefined;
      }
    }
  }
  return undefined;
}

function importBindings(body: AstNode[], packageNames: ReadonlySet<string>): Set<string> {
  const bindings = new Set<string>();
  for (const statement of body) {
    if (statement.type !== 'ImportDeclaration'
      || !isStringLiteral(statement.source)
      || !packageNames.has((statement.source as { value: string }).value)) {
      continue;
    }
    for (const specifier of (statement.specifiers as AstNode[] | undefined) ?? []) {
      const local = specifier.local;
      if (isIdentifier(local)) {
        bindings.add(local.name);
      }
    }
  }
  for (const statement of body) {
    if (statement.type !== 'VariableDeclaration') {
      continue;
    }
    for (const declaration of (statement.declarations as AstNode[] | undefined) ?? []) {
      const init = declaration.init as AstNode | undefined;
      const directArgument = (init?.arguments as AstNode[] | undefined)?.[0];
      const defaultCall = init?.type === 'MemberExpression'
        ? init.object as AstNode | undefined
        : undefined;
      const defaultArgument = (defaultCall?.arguments as AstNode[] | undefined)?.[0];
      const directRequire = init?.type === 'CallExpression'
        && isIdentifier(init.callee, 'require')
        && isStringLiteral(directArgument);
      const defaultRequire = init?.type === 'MemberExpression'
        && isIdentifier(init.property, 'default')
        && defaultCall?.type === 'CallExpression'
        && isIdentifier(defaultCall.callee, 'require')
        && isStringLiteral(defaultArgument);
      const requiredPackage = directRequire && isStringLiteral(directArgument)
        ? directArgument.value
        : defaultRequire && isStringLiteral(defaultArgument)
          ? defaultArgument.value
          : undefined;
      if (requiredPackage && packageNames.has(requiredPackage) && isIdentifier(declaration.id)) {
        bindings.add(declaration.id.name);
      }
    }
  }
  return bindings;
}

function collectPatternBindings(node: unknown, bindings: Set<string>): void {
  const candidate = node as AstNode | undefined;
  if (isIdentifier(candidate)) {
    bindings.add(candidate.name);
    return;
  }
  if (candidate?.type === 'ObjectPattern' || candidate?.type === 'ArrayPattern') {
    for (const property of ((candidate.properties ?? candidate.elements) as unknown[] | undefined) ?? []) {
      const propertyNode = property as AstNode | null;
      if (propertyNode?.type === 'RestElement') {
        collectPatternBindings(propertyNode.argument, bindings);
      } else if (propertyNode) {
        collectPatternBindings(propertyNode.value ?? propertyNode.argument, bindings);
      }
    }
  }
}

function topLevelBindings(body: AstNode[]): Set<string> {
  const bindings = new Set<string>();
  for (const statement of body) {
    if (statement.type === 'ImportDeclaration') {
      for (const specifier of (statement.specifiers as AstNode[] | undefined) ?? []) {
        collectPatternBindings(specifier.local, bindings);
      }
    } else if (statement.type === 'VariableDeclaration') {
      for (const declaration of (statement.declarations as AstNode[] | undefined) ?? []) {
        collectPatternBindings(declaration.id, bindings);
      }
    } else if (['FunctionDeclaration', 'ClassDeclaration'].includes(statement.type)) {
      collectPatternBindings(statement.id, bindings);
    }
  }
  return bindings;
}

function uniqueInspectorBinding(body: AstNode[]): string {
  const bindings = topLevelBindings(body);
  const base = 'webSourceInspector';
  if (!bindings.has(base)) {
    return base;
  }
  let suffix = 1;
  while (bindings.has(`${base}Wsi${suffix}`)) {
    suffix += 1;
  }
  return `${base}Wsi${suffix}`;
}

interface InspectorBinding {
  binding: string;
  node: AstNode;
}

function inspectorBindings(body: AstNode[]): InspectorBinding[] {
  const results: InspectorBinding[] = [];
  for (const statement of body) {
    if (statement.type === 'ImportDeclaration'
      && isStringLiteral(statement.source, 'web-source-inspector/vite')) {
      for (const specifier of (statement.specifiers as AstNode[] | undefined) ?? []) {
        if (specifier.type === 'ImportSpecifier'
          && isIdentifier(specifier.imported, 'webSourceInspector')
          && isIdentifier(specifier.local)) {
          results.push({ binding: specifier.local.name, node: specifier });
        }
      }
    }
    if (statement.type === 'VariableDeclaration') {
      for (const declaration of (statement.declarations as AstNode[] | undefined) ?? []) {
        const init = declaration.init as AstNode | undefined;
        const id = declaration.id as AstNode | undefined;
        if (id?.type !== 'ObjectPattern' || init?.type !== 'CallExpression'
          || !isIdentifier(init.callee, 'require')
          || !isStringLiteral((init.arguments as AstNode[] | undefined)?.[0], 'web-source-inspector/vite')) {
          continue;
        }
        for (const property of (id.properties as AstNode[] | undefined) ?? []) {
          if (propertyName(property) === 'webSourceInspector' && isIdentifier(property.value)) {
            results.push({ binding: property.value.name, node: property });
          }
        }
      }
    }
  }
  return results;
}

function callIndices(elements: unknown[], binding: string): number[] {
  return elements.flatMap((element, index) => {
    const node = element as AstNode | null;
    return node?.type === 'CallExpression' && isIdentifier(node.callee, binding)
      ? [index]
      : [];
  });
}

function insertInspectorImport(
  body: AstNode[],
  moduleKind: ConfigModuleKind,
  binding: string,
): AstNode {
  const builders = recast.types.builders;
  if (moduleKind === 'commonjs') {
    const property = builders.property(
      'init',
      builders.identifier('webSourceInspector'),
      builders.identifier(binding),
    ) as unknown as AstNode;
    const declaration = builders.variableDeclaration('const', [
      builders.variableDeclarator(
        builders.objectPattern([property as never]),
        builders.callExpression(builders.identifier('require'), [
          builders.stringLiteral('web-source-inspector/vite'),
        ]),
      ),
    ]);
    body.unshift(declaration as unknown as AstNode);
    return property;
  }
  const specifier = builders.importSpecifier(
    builders.identifier('webSourceInspector'),
    builders.identifier(binding),
  ) as unknown as AstNode;
  const declaration = builders.importDeclaration(
    [specifier as never],
    builders.stringLiteral('web-source-inspector/vite'),
  );
  let lastImport = -1;
  for (let index = body.length - 1; index >= 0; index -= 1) {
    if (body[index]?.type === 'ImportDeclaration') {
      lastImport = index;
      break;
    }
  }
  body.splice(lastImport + 1, 0, declaration as unknown as AstNode);
  return specifier;
}

function legacyImportFingerprint(binding: string): string {
  return digestCanonical(['vite-import', binding, 'web-source-inspector/vite']);
}

function legacyPluginFingerprint(binding: string): string {
  return digestCanonical(['vite-plugin', binding]);
}

function exactGeneratedImportNode(node: AstNode, binding: string): boolean {
  if (node.type === 'ImportSpecifier') {
    return isIdentifier(node.imported, 'webSourceInspector')
      && isIdentifier(node.local, binding)
      && node.importKind !== 'type';
  }
  return (node.type === 'ObjectProperty' || node.type === 'Property')
    && node.computed !== true
    && propertyName(node) === 'webSourceInspector'
    && isIdentifier(node.value, binding)
    && node.method !== true
    && node.shorthand !== true
    && node.kind !== 'get'
    && node.kind !== 'set';
}

function exactGeneratedPluginCall(node: AstNode, binding: string): boolean {
  return node.type === 'CallExpression'
    && isIdentifier(node.callee, binding)
    && ((node.arguments as unknown[] | undefined) ?? []).length === 0
    && node.optional !== true
    && node.typeArguments == null
    && node.typeParameters == null;
}

function operationMatchesNode(
  operation: AstOperation,
  scope: readonly unknown[],
  node: AstNode,
  legacyFingerprint: string,
  exactGeneratedNode: boolean,
): boolean {
  if (operation.fingerprint === astOperationFingerprint(scope, node)) {
    return true;
  }
  return operation.fingerprint === legacyFingerprint
    && operation.ownership === 'reused'
    && exactGeneratedNode;
}

export function transformViteConfig(
  source: string,
  moduleKind: ConfigModuleKind,
): ViteAstTransformResult {
  let ast: AstNode;
  try {
    ast = parseProgram(source);
  } catch {
    return { ok: false, code: source, operations: [], errorCode: 'CONFIG_PARSE_FAILED' };
  }
  const body = programBody(ast);
  const config = unwrapConfigObject(findExportedConfig(body), body);
  const plugins = config && objectProperties(config) ? findPluginsArray(config, body) : undefined;
  const elements = plugins ? ((plugins.elements as unknown[] | undefined) ?? []) : [];
  if (!config || !plugins
    || elements.some((element) => element === null
      || (element as AstNode | undefined)?.type === 'SpreadElement')) {
    return { ok: false, code: source, operations: [], errorCode: 'CONFIG_SHAPE_UNSUPPORTED' };
  }
  const vueBindings = importBindings(body, VUE_PLUGIN_PACKAGES);
  const vueIndex = elements.findIndex((element) => {
    const node = element as AstNode | null;
    return node?.type === 'CallExpression'
      && isIdentifier(node.callee)
      && vueBindings.has(node.callee.name);
  });
  if (vueIndex < 0) {
    return { ok: false, code: source, operations: [], errorCode: 'VITE_VUE_PLUGIN_NOT_FOUND' };
  }

  const operations: AstOperation[] = [];
  const existingBindings = inspectorBindings(body);
  if (existingBindings.length > 1) {
    return { ok: false, code: source, operations: [], errorCode: 'DUPLICATE_INSPECTOR_IMPORT' };
  }
  let bindingResult = existingBindings[0];
  if (!bindingResult) {
    const binding = uniqueInspectorBinding(body);
    const bindingNode = insertInspectorImport(body, moduleKind, binding);
    bindingResult = { binding, node: bindingNode };
    operations.push({
      kind: 'import',
      ownership: 'created',
      fingerprint: astOperationFingerprint(
        ['vite-import', binding, 'web-source-inspector/vite'],
        bindingNode,
      ),
      description: '加入 web-source-inspector/vite import/require。',
      details: {
        binding,
        module: 'web-source-inspector/vite',
        legacyFingerprint: legacyImportFingerprint(binding),
        legacyCreatedCompatible: 'true',
      },
    });
  } else {
    const { binding, node: bindingNode } = bindingResult;
    operations.push({
      kind: 'import',
      ownership: 'reused',
      fingerprint: astOperationFingerprint(
        ['vite-import', binding, 'web-source-inspector/vite'],
        bindingNode,
      ),
      description: '复用现有 web-source-inspector/vite binding。',
      details: {
        binding,
        module: 'web-source-inspector/vite',
        legacyFingerprint: legacyImportFingerprint(binding),
        legacyCreatedCompatible: String(exactGeneratedImportNode(bindingNode, binding)),
      },
    });
  }
  const { binding } = bindingResult;

  const existingCalls = callIndices(elements, binding);
  if (existingCalls.length > 1) {
    return { ok: false, code: source, operations: [], errorCode: 'DUPLICATE_INSPECTOR_PLUGIN' };
  }
  if (existingCalls.length === 1) {
    const existingIndex = existingCalls[0] as number;
    const moved = existingIndex > vueIndex;
    const existingCall = elements[existingIndex] as AstNode;
    const prePosition = moved
      ? capturePositionAnchors(elements, existingIndex)
      : undefined;
    if (moved) {
      const [existingCall] = elements.splice(existingIndex, 1);
      elements.splice(vueIndex, 0, existingCall);
      plugins.elements = elements;
    }
    const postPosition = moved
      ? capturePositionAnchors(elements, vueIndex)
      : undefined;
    operations.push({
      kind: 'plugin',
      ownership: 'reused',
      fingerprint: astOperationFingerprint(
        ['vite-plugin', binding],
        existingCall,
      ),
      description: moved
        ? '将现有 webSourceInspector() 安全移动到 Vue plugin 之前。'
        : '复用现有 webSourceInspector()。',
      details: {
        binding,
        legacyFingerprint: legacyPluginFingerprint(binding),
        legacyCreatedCompatible: String(exactGeneratedPluginCall(existingCall, binding)),
        ...(moved && prePosition && postPosition ? {
          action: 'moved-before-vue',
          prePrevious: prePosition.previousAnchor,
          preNext: prePosition.nextAnchor,
          postPrevious: postPosition.previousAnchor,
          postNext: postPosition.nextAnchor,
        } : {}),
      },
    });
    return {
      ok: true,
      code: moved ? printProgram(ast, source) : source,
      operations,
    };
  }
  const call = recast.types.builders.callExpression(recast.types.builders.identifier(binding), []);
  elements.splice(vueIndex, 0, call);
  plugins.elements = elements;
  operations.push({
    kind: 'plugin',
    ownership: 'created',
    fingerprint: astOperationFingerprint(['vite-plugin', binding], call),
    description: '在 Vue plugin 之前加入 webSourceInspector()。',
    details: {
      binding,
      action: 'inserted-before-vue',
      legacyFingerprint: legacyPluginFingerprint(binding),
      legacyCreatedCompatible: 'true',
    },
  });
  return {
    ok: true,
    code: printProgram(ast, source),
    operations,
  };
}

function hasIdentifierReference(
  node: unknown,
  binding: string,
  ignored: unknown,
  seen = new WeakSet<object>(),
): boolean {
  if (node === ignored || typeof node !== 'object' || node === null) {
    return false;
  }
  if (seen.has(node)) {
    return false;
  }
  seen.add(node);
  const candidate = node as AstNode;
  if (isIdentifier(candidate, binding)) {
    return true;
  }
  for (const [key, value] of Object.entries(candidate)) {
    if (['loc', 'start', 'end', 'tokens', 'comments', 'original'].includes(key)) {
      continue;
    }
    if (Array.isArray(value)) {
      if (value.some((item) => hasIdentifierReference(item, binding, ignored, seen))) {
        return true;
      }
    } else if (hasIdentifierReference(value, binding, ignored, seen)) {
      return true;
    }
  }
  return false;
}

function removeInspectorBinding(body: AstNode[], binding: string): boolean {
  for (let statementIndex = 0; statementIndex < body.length; statementIndex += 1) {
    const statement = body[statementIndex] as AstNode;
    if (statement.type === 'ImportDeclaration'
      && isStringLiteral(statement.source, 'web-source-inspector/vite')) {
      const specifiers = (statement.specifiers as AstNode[] | undefined) ?? [];
      const specifierIndex = specifiers.findIndex((specifier) =>
        specifier.type === 'ImportSpecifier'
        && isIdentifier(specifier.imported, 'webSourceInspector')
        && isIdentifier(specifier.local, binding));
      if (specifierIndex < 0) {
        continue;
      }
      const [removed] = specifiers.splice(specifierIndex, 1);
      if (hasIdentifierReference({ type: 'ProgramSlice', body }, binding, statement)) {
        specifiers.splice(specifierIndex, 0, removed as AstNode);
        return false;
      }
      if (specifiers.length === 0) {
        body.splice(statementIndex, 1);
      } else {
        statement.specifiers = specifiers;
      }
      return true;
    }
    if (statement.type !== 'VariableDeclaration') {
      continue;
    }
    const declarations = (statement.declarations as AstNode[] | undefined) ?? [];
    for (let declarationIndex = 0; declarationIndex < declarations.length; declarationIndex += 1) {
      const declaration = declarations[declarationIndex] as AstNode;
      const init = declaration.init as AstNode | undefined;
      const id = declaration.id as AstNode | undefined;
      if (id?.type !== 'ObjectPattern' || init?.type !== 'CallExpression'
        || !isIdentifier(init.callee, 'require')
        || !isStringLiteral((init.arguments as AstNode[] | undefined)?.[0], 'web-source-inspector/vite')) {
        continue;
      }
      const properties = (id.properties as AstNode[] | undefined) ?? [];
      const propertyIndex = properties.findIndex((property) =>
        propertyName(property) === 'webSourceInspector'
        && isIdentifier(property.value, binding));
      if (propertyIndex < 0) {
        continue;
      }
      const [removed] = properties.splice(propertyIndex, 1);
      if (hasIdentifierReference({ type: 'ProgramSlice', body }, binding, declaration)) {
        properties.splice(propertyIndex, 0, removed as AstNode);
        return false;
      }
      if (properties.length === 0) {
        declarations.splice(declarationIndex, 1);
      } else {
        id.properties = properties;
      }
      if (declarations.length === 0) {
        body.splice(statementIndex, 1);
      } else {
        statement.declarations = declarations;
      }
      return true;
    }
  }
  return false;
}

export function removeViteIntegration(
  source: string,
  operations: readonly AstOperation[],
): ViteAstRemoveResult {
  let ast: AstNode;
  try {
    ast = parseProgram(source);
  } catch {
    return { ok: false, code: source, operations: [], errorCode: 'CONFIG_PARSE_FAILED' };
  }
  const body = programBody(ast);
  const config = unwrapConfigObject(findExportedConfig(body), body);
  const plugins = config && objectProperties(config) ? findPluginsArray(config, body) : undefined;
  const importOperation = operations.find((operation) => operation.kind === 'import');
  const pluginOperation = operations.find((operation) => operation.kind === 'plugin');
  const binding = pluginOperation?.details?.binding ?? importOperation?.details?.binding;
  if (!plugins || !binding || !importOperation || !pluginOperation) {
    return { ok: false, code: source, operations: [], errorCode: 'INTEGRATION_STATE_CONFLICT' };
  }
  const elements = (plugins.elements as unknown[] | undefined) ?? [];
  const indices = callIndices(elements, binding);
  const matchingBindings = inspectorBindings(body).filter((item) => item.binding === binding);
  if (indices.length !== 1 || matchingBindings.length !== 1) {
    return { ok: false, code: source, operations: [], errorCode: 'INTEGRATION_STATE_CONFLICT' };
  }
  const currentIndex = indices[0] as number;
  const pluginNode = elements[currentIndex] as AstNode;
  const bindingNode = (matchingBindings[0] as InspectorBinding).node;
  if (!operationMatchesNode(
    importOperation,
    ['vite-import', binding, 'web-source-inspector/vite'],
    bindingNode,
    legacyImportFingerprint(binding),
    exactGeneratedImportNode(bindingNode, binding),
  ) || !operationMatchesNode(
    pluginOperation,
    ['vite-plugin', binding],
    pluginNode,
    legacyPluginFingerprint(binding),
    exactGeneratedPluginCall(pluginNode, binding),
  )) {
    return { ok: false, code: source, operations: [], errorCode: 'INTEGRATION_STATE_CONFLICT' };
  }
  if (pluginOperation.ownership === 'created') {
    elements.splice(currentIndex, 1);
  } else if (pluginOperation.details?.action === 'moved-before-vue') {
    const restored = restoreByPositionAnchors(elements, currentIndex, pluginOperation.details);
    if (!restored) {
      return { ok: false, code: source, operations: [], errorCode: 'INTEGRATION_STATE_CONFLICT' };
    }
    plugins.elements = restored;
  } else {
    plugins.elements = elements;
  }

  if (importOperation.ownership === 'created'
    && !removeInspectorBinding(body, binding)) {
    return { ok: false, code: source, operations: [], errorCode: 'INTEGRATION_STATE_CONFLICT' };
  }
  return {
    ok: true,
    code: printProgram(ast, source),
    operations: [...operations],
  };
}
