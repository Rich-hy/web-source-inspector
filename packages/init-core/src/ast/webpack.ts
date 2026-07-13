import { parse as babelParse } from '@babel/parser';
import recast from 'recast';
import { digestCanonical } from '../digest';
import type { AstOperation } from '../plan/types';
import type { ConfigModuleKind } from '../types';
import {
  astOperationFingerprint,
  capturePositionAnchors,
  restoreByPositionAnchors,
  sameAstStructure,
} from './fingerprint';

type AstNode = Record<string, unknown> & { type: string };

export interface WebpackAstOptions {
  moduleKind: ConfigModuleKind;
  webpackDevServerMajor?: 3 | 4;
  allowedOrigin?: string;
}

export interface WebpackAstTransformResult {
  ok: boolean;
  code: string;
  operations: AstOperation[];
  errorCode?: string;
}

function parseProgram(source: string): AstNode {
  return recast.parse(source, {
    parser: {
      parse(value: string) {
        return babelParse(value, {
          sourceType: 'unambiguous',
          allowAwaitOutsideFunction: true,
          plugins: ['typescript', 'jsx', 'decorators-legacy', 'importAttributes'],
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
  return (((ast.program as AstNode | undefined)?.body as AstNode[] | undefined) ?? []);
}

function isIdentifier(node: unknown, name?: string): node is AstNode & { name: string } {
  return typeof node === 'object' && node !== null
    && (node as AstNode).type === 'Identifier'
    && (name === undefined || (node as { name?: unknown }).name === name);
}

function isStringLiteral(node: unknown, value?: string): node is AstNode & { value: string } {
  if (typeof node !== 'object' || node === null) {
    return false;
  }
  const candidate = node as AstNode & { value?: unknown };
  return (candidate.type === 'StringLiteral' || candidate.type === 'Literal')
    && typeof candidate.value === 'string'
    && (value === undefined || candidate.value === value);
}

function propertyName(property: AstNode): string | undefined {
  return isIdentifier(property.key)
    ? property.key.name
    : isStringLiteral(property.key)
      ? property.key.value
      : undefined;
}

function findVariableInitializer(body: AstNode[], name: string): AstNode | undefined {
  for (const statement of body) {
    if (statement.type !== 'VariableDeclaration') {
      continue;
    }
    for (const declaration of (statement.declarations as AstNode[] | undefined) ?? []) {
      if (isIdentifier(declaration.id, name)
        && typeof declaration.init === 'object' && declaration.init !== null) {
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

function unwrapObject(
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
    return unwrapObject(findVariableInitializer(body, node.name), body, seen);
  }
  if (node.type === 'CallExpression') {
    const argumentsList = (node.arguments as AstNode[] | undefined) ?? [];
    if (isIdentifier(node.callee, 'defineConfig') && argumentsList.length === 1) {
      return unwrapObject(argumentsList[0], body, seen);
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
        return unwrapObject(returns[0]?.argument as AstNode | undefined, body, seen);
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
    const left = expression?.type === 'AssignmentExpression'
      ? expression.left as AstNode | undefined
      : undefined;
    if (left?.type === 'MemberExpression'
      && left.computed !== true
      && isIdentifier(left.object, 'module')
      && isIdentifier(left.property, 'exports')) {
      return expression?.right as AstNode | undefined;
    }
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

function findProperty(object: AstNode, name: string): AstNode | undefined {
  return objectProperties(object)?.find((property) =>
    (property.type === 'ObjectProperty' || property.type === 'Property'
      || property.type === 'ObjectMethod')
    && propertyName(property) === name);
}

function propertyObject(
  object: AstNode,
  body: AstNode[],
  name: string,
): AstNode | undefined {
  const property = findProperty(object, name);
  if (!property) {
    return undefined;
  }
  return unwrapObject(property.value as AstNode | undefined, body);
}

function ensureObjectProperty(
  object: AstNode,
  body: AstNode[],
  name: string,
): { object: AstNode; created: boolean } | undefined {
  const existing = findProperty(object, name);
  if (existing) {
    const value = unwrapObject(existing.value as AstNode | undefined, body);
    return value ? { object: value, created: false } : undefined;
  }
  const value = recast.types.builders.objectExpression([]) as unknown as AstNode;
  (object.properties as AstNode[]).push(recast.types.builders.property(
    'init',
    recast.types.builders.identifier(name),
    value as never,
  ) as unknown as AstNode);
  return { object: value, created: true };
}

function propertyArray(
  object: AstNode,
  body: AstNode[],
  name: string,
): AstNode | undefined {
  const property = findProperty(object, name);
  const value = property?.value as AstNode | undefined;
  if (value?.type === 'ArrayExpression') {
    return value;
  }
  if (isIdentifier(value)) {
    const initializer = findVariableInitializer(body, value.name);
    return initializer?.type === 'ArrayExpression' ? initializer : undefined;
  }
  return undefined;
}

function topLevelBindings(body: AstNode[]): Set<string> {
  const result = new Set<string>();
  for (const statement of body) {
    if (statement.type === 'ImportDeclaration') {
      for (const specifier of (statement.specifiers as AstNode[] | undefined) ?? []) {
        if (isIdentifier(specifier.local)) {
          result.add(specifier.local.name);
        }
      }
    } else if (statement.type === 'VariableDeclaration') {
      for (const declaration of (statement.declarations as AstNode[] | undefined) ?? []) {
        if (isIdentifier(declaration.id)) {
          result.add(declaration.id.name);
        } else if ((declaration.id as AstNode | undefined)?.type === 'ObjectPattern') {
          for (const property of ((declaration.id as AstNode).properties as AstNode[] | undefined) ?? []) {
            if (isIdentifier(property.value)) {
              result.add(property.value.name);
            }
          }
        }
      }
    } else if (['FunctionDeclaration', 'ClassDeclaration'].includes(statement.type)
      && isIdentifier(statement.id)) {
      result.add(statement.id.name);
    }
  }
  return result;
}

function uniqueBinding(body: AstNode[], base: string): string {
  const names = topLevelBindings(body);
  if (!names.has(base)) {
    return base;
  }
  let suffix = 1;
  while (names.has(`${base}Wsi${suffix}`)) {
    suffix += 1;
  }
  return `${base}Wsi${suffix}`;
}

interface NamedBindingResult {
  exported: string;
  binding: string;
  ownership: 'created' | 'reused';
  node: AstNode;
}

function findNamedBindings(body: AstNode[], exported: string): Array<{
  binding: string;
  node: AstNode;
}> {
  const results: Array<{ binding: string; node: AstNode }> = [];
  for (const statement of body) {
    if (statement.type === 'ImportDeclaration'
      && isStringLiteral(statement.source, 'web-source-inspector/webpack')) {
      for (const specifier of (statement.specifiers as AstNode[] | undefined) ?? []) {
        if (specifier.type === 'ImportSpecifier'
          && isIdentifier(specifier.imported, exported)
          && isIdentifier(specifier.local)) {
          results.push({ binding: specifier.local.name, node: specifier });
        }
      }
    }
    if (statement.type === 'VariableDeclaration') {
      for (const declaration of (statement.declarations as AstNode[] | undefined) ?? []) {
        const id = declaration.id as AstNode | undefined;
        const init = declaration.init as AstNode | undefined;
        if (id?.type !== 'ObjectPattern' || init?.type !== 'CallExpression'
          || !isIdentifier(init.callee, 'require')
          || !isStringLiteral((init.arguments as AstNode[] | undefined)?.[0], 'web-source-inspector/webpack')) {
          continue;
        }
        for (const property of (id.properties as AstNode[] | undefined) ?? []) {
          if (propertyName(property) === exported && isIdentifier(property.value)) {
            results.push({ binding: property.value.name, node: property });
          }
        }
      }
    }
  }
  return results;
}

function insertNamedBinding(
  body: AstNode[],
  moduleKind: ConfigModuleKind,
  exported: string,
  binding: string,
): AstNode {
  const builders = recast.types.builders;
  const matchingImport = body.find((statement) =>
    statement.type === 'ImportDeclaration'
    && isStringLiteral(statement.source, 'web-source-inspector/webpack'));
  if (moduleKind !== 'commonjs' && matchingImport) {
    const specifiers = (matchingImport.specifiers as AstNode[] | undefined) ?? [];
    const specifier = builders.importSpecifier(
      builders.identifier(exported),
      builders.identifier(binding),
    ) as unknown as AstNode;
    specifiers.push(specifier);
    matchingImport.specifiers = specifiers;
    return specifier;
  }
  if (moduleKind === 'commonjs') {
    const matchingRequire = body.find((statement) => statement.type === 'VariableDeclaration'
      && ((statement.declarations as AstNode[] | undefined) ?? []).some((declaration) => {
        const init = declaration.init as AstNode | undefined;
        return (declaration.id as AstNode | undefined)?.type === 'ObjectPattern'
          && init?.type === 'CallExpression'
          && isIdentifier(init.callee, 'require')
          && isStringLiteral((init.arguments as AstNode[] | undefined)?.[0], 'web-source-inspector/webpack');
      }));
    if (matchingRequire) {
      const declaration = ((matchingRequire.declarations as AstNode[]).find((candidate) => {
        const init = candidate.init as AstNode | undefined;
        return (candidate.id as AstNode | undefined)?.type === 'ObjectPattern'
          && init?.type === 'CallExpression'
          && isIdentifier(init.callee, 'require')
          && isStringLiteral((init.arguments as AstNode[] | undefined)?.[0], 'web-source-inspector/webpack');
      })) as AstNode;
      const pattern = declaration.id as AstNode;
      const properties = (pattern.properties as AstNode[] | undefined) ?? [];
      const property = builders.property(
        'init',
        builders.identifier(exported),
        builders.identifier(binding),
      ) as unknown as AstNode;
      properties.push(property);
      pattern.properties = properties;
      return property;
    }
    const property = builders.property(
      'init',
      builders.identifier(exported),
      builders.identifier(binding),
    ) as unknown as AstNode;
    body.unshift(builders.variableDeclaration('const', [
      builders.variableDeclarator(
        builders.objectPattern([property as never]),
        builders.callExpression(builders.identifier('require'), [
          builders.stringLiteral('web-source-inspector/webpack'),
        ]),
      ),
    ]) as unknown as AstNode);
    return property;
  }
  const specifier = builders.importSpecifier(
    builders.identifier(exported),
    builders.identifier(binding),
  ) as unknown as AstNode;
  const declaration = builders.importDeclaration(
    [specifier as never],
    builders.stringLiteral('web-source-inspector/webpack'),
  );
  let lastImport = -1;
  body.forEach((statement, index) => {
    if (statement.type === 'ImportDeclaration') {
      lastImport = index;
    }
  });
  body.splice(lastImport + 1, 0, declaration as unknown as AstNode);
  return specifier;
}

function ensureNamedBinding(
  body: AstNode[],
  moduleKind: ConfigModuleKind,
  exported: string,
): NamedBindingResult | undefined {
  const existing = findNamedBindings(body, exported);
  if (existing.length > 1) {
    return undefined;
  }
  if (existing.length === 1) {
    const match = existing[0] as { binding: string; node: AstNode };
    return { exported, binding: match.binding, ownership: 'reused', node: match.node };
  }
  const binding = uniqueBinding(body, exported);
  const node = insertNamedBinding(body, moduleKind, exported, binding);
  return { exported, binding, ownership: 'created', node };
}

function importOperation(binding: NamedBindingResult): AstOperation {
  const legacyFingerprint = digestCanonical([
    'webpack-import',
    binding.exported,
    binding.binding,
  ]);
  return {
    kind: 'import',
    ownership: binding.ownership,
    fingerprint: astOperationFingerprint(
      ['webpack-import', binding.exported, binding.binding],
      binding.node,
    ),
    description: `${binding.ownership === 'created' ? '加入' : '复用'} ${binding.exported} binding。`,
    details: {
      exported: binding.exported,
      binding: binding.binding,
      legacyFingerprint,
      legacyCreatedCompatible: String(exactGeneratedImportNode(
        binding.node,
        binding.exported,
        binding.binding,
      )),
    },
  };
}

function legacyImportFingerprint(exported: string, binding: string): string {
  return digestCanonical(['webpack-import', exported, binding]);
}

function exactGeneratedImportNode(node: AstNode, exported: string, binding: string): boolean {
  if (node.type === 'ImportSpecifier') {
    return isIdentifier(node.imported, exported)
      && isIdentifier(node.local, binding)
      && node.importKind !== 'type';
  }
  return (node.type === 'ObjectProperty' || node.type === 'Property')
    && node.computed !== true
    && propertyName(node) === exported
    && isIdentifier(node.value, binding)
    && node.method !== true
    && node.shorthand !== true
    && node.kind !== 'get'
    && node.kind !== 'set';
}

function operationMatchesNode(
  operation: AstOperation,
  scope: readonly unknown[],
  node: unknown,
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

function packageBindings(body: AstNode[], packageName: string, exported: string): Set<string> {
  const bindings = new Set<string>();
  for (const statement of body) {
    if (statement.type === 'ImportDeclaration' && isStringLiteral(statement.source, packageName)) {
      for (const specifier of (statement.specifiers as AstNode[] | undefined) ?? []) {
        if (specifier.type === 'ImportSpecifier' && isIdentifier(specifier.imported, exported)) {
          if (isIdentifier(specifier.local)) {
            bindings.add(specifier.local.name);
          }
        }
      }
    }
    if (statement.type === 'VariableDeclaration') {
      for (const declaration of (statement.declarations as AstNode[] | undefined) ?? []) {
        const id = declaration.id as AstNode | undefined;
        const init = declaration.init as AstNode | undefined;
        if (id?.type === 'ObjectPattern' && init?.type === 'CallExpression'
          && isIdentifier(init.callee, 'require')
          && isStringLiteral((init.arguments as AstNode[] | undefined)?.[0], packageName)) {
          for (const property of (id.properties as AstNode[] | undefined) ?? []) {
            if (propertyName(property) === exported && isIdentifier(property.value)) {
              bindings.add(property.value.name);
            }
          }
        } else if (isIdentifier(id) && init?.type === 'CallExpression'
          && isIdentifier(init.callee, 'require')
          && (isStringLiteral((init.arguments as AstNode[] | undefined)?.[0], packageName)
            || isStringLiteral(
              (init.arguments as AstNode[] | undefined)?.[0],
              `${packageName}/lib/plugin`,
            ))) {
          bindings.add(id.name);
        }
      }
    }
  }
  return bindings;
}

function newExpressionIndices(elements: unknown[], bindings: ReadonlySet<string>): number[] {
  return elements.flatMap((element, index) => {
    const node = element as AstNode | null;
    return node?.type === 'NewExpression' && isIdentifier(node.callee)
      && bindings.has(node.callee.name) ? [index] : [];
  });
}

function isVueRule(rule: AstNode): boolean {
  const testProperty = findProperty(rule, 'test');
  const test = testProperty?.value as AstNode & { pattern?: unknown } | undefined;
  return Boolean(test
    && ['RegExpLiteral', 'Literal'].includes(test.type)
    && typeof test.pattern === 'string'
    && test.pattern.includes('\\.vue'));
}

function loaderName(element: AstNode | null): string | undefined {
  if (isStringLiteral(element)) {
    return element.value;
  }
  if (element?.type === 'ObjectExpression') {
    const loader = findProperty(element, 'loader')?.value;
    return isStringLiteral(loader) ? loader.value : undefined;
  }
  return undefined;
}

function isInspectorLoader(element: AstNode | null, binding: string): boolean {
  return element?.type === 'MemberExpression'
    && isIdentifier(element.object, binding)
    && isIdentifier(element.property, 'loaderPath')
    && element.computed !== true
    && element.optional !== true;
}

function inspectorPluginMatches(
  node: AstNode,
  binding: string,
  allowedOrigin: string | undefined,
): boolean {
  if (node.type !== 'NewExpression' || !isIdentifier(node.callee, binding)) {
    return false;
  }
  const args = (node.arguments as AstNode[] | undefined) ?? [];
  if (!allowedOrigin) {
    return args.length === 0;
  }
  if (args.length !== 1 || args[0]?.type !== 'ObjectExpression') {
    return false;
  }
  const properties = objectProperties(args[0]);
  if (!properties || properties.length !== 2) {
    return false;
  }
  const transportProperty = properties.find((property) =>
    propertyName(property) === 'browserTransport');
  const originsProperty = properties.find((property) =>
    propertyName(property) === 'allowedOrigins');
  if (!transportProperty
    || !originsProperty
    || !isStringLiteral(transportProperty.value, 'raw')) {
    return false;
  }
  const origins = originsProperty.value as AstNode | undefined;
  const elements = origins?.type === 'ArrayExpression'
    ? (origins.elements as AstNode[] | undefined) ?? []
    : [];
  return elements.length === 1 && isStringLiteral(elements[0], allowedOrigin);
}

function middlewareFactoryCallMatches(
  node: AstNode,
  binding: string,
  _major: 3 | 4,
  compilerParameter: string,
): boolean {
  if (node.type !== 'CallExpression' || !isIdentifier(node.callee, binding)) {
    return false;
  }
  const args = (node.arguments as AstNode[] | undefined) ?? [];
  const compiler = args[0];
  return args.length === 1
    && compiler?.type === 'MemberExpression'
    && isIdentifier(compiler.object, compilerParameter)
    && isIdentifier(compiler.property, 'compiler')
    && compiler.computed !== true;
}

function countMiddlewareFactoryCalls(
  node: unknown,
  binding: string,
  major: 3 | 4,
  compilerParameter: string,
  seen = new WeakSet<object>(),
): number {
  if (typeof node !== 'object' || node === null || seen.has(node)) {
    return 0;
  }
  seen.add(node);
  const candidate = node as AstNode;
  let count = middlewareFactoryCallMatches(
    candidate,
    binding,
    major,
    compilerParameter,
  ) ? 1 : 0;
  for (const [key, value] of Object.entries(candidate)) {
    if (['loc', 'start', 'end', 'tokens', 'comments', 'original'].includes(key)) {
      continue;
    }
    count += Array.isArray(value)
      ? value.reduce<number>(
        (total, item) => total + countMiddlewareFactoryCalls(
          item,
          binding,
          major,
          compilerParameter,
          seen,
        ),
        0,
      )
      : countMiddlewareFactoryCalls(value, binding, major, compilerParameter, seen);
  }
  return count;
}

const WDS_MIDDLEWARE_LOCAL = 'webSourceInspectorMiddleware';

function createWdsHookStatements(
  major: 3 | 4,
  middlewareBinding: string,
  parameters: readonly string[],
): AstNode[] {
  const builders = recast.types.builders;
  const middleware = builders.identifier(WDS_MIDDLEWARE_LOCAL);
  const compilerArgument = builders.memberExpression(
    builders.identifier(parameters[1] as string),
    builders.identifier('compiler'),
  );
  const declaration = builders.variableDeclaration('const', [
    builders.variableDeclarator(
      middleware,
      builders.callExpression(
        builders.identifier(middlewareBinding),
        [compilerArgument],
      ),
    ),
  ]);
  if (major === 3) {
    const app = builders.identifier(parameters[0] as string);
    return [
      declaration as unknown as AstNode,
      builders.ifStatement(middleware, builders.blockStatement([
        builders.expressionStatement(builders.callExpression(
          builders.memberExpression(app, builders.identifier('use')),
          [middleware],
        )),
      ])) as unknown as AstNode,
    ];
  }
  const middlewares = builders.identifier(parameters[0] as string);
  return [
    declaration as unknown as AstNode,
    builders.ifStatement(middleware, builders.blockStatement([
      builders.expressionStatement(builders.callExpression(
        builders.memberExpression(middlewares, builders.identifier('unshift')),
        [builders.objectExpression([
          builders.property('init', builders.identifier('name'), builders.stringLiteral('web-source-inspector')),
          builders.property('init', builders.identifier('middleware'), middleware),
        ])],
      )),
    ])) as unknown as AstNode,
  ];
}

function createWdsHook(major: 3 | 4, middlewareBinding: string): AstNode {
  const builders = recast.types.builders;
  const parameters = major === 3
    ? ['app', 'server']
    : ['middlewares', 'devServer'];
  const statements = createWdsHookStatements(major, middlewareBinding, parameters);
  if (major === 4) {
    statements.push(builders.returnStatement(
      builders.identifier(parameters[0] as string),
    ) as unknown as AstNode);
  }
  return builders.property(
    'init',
    builders.identifier(major === 3 ? 'before' : 'setupMiddlewares'),
    builders.functionExpression(
      null,
      parameters.map((parameter) => builders.identifier(parameter)),
      builders.blockStatement(statements as never[]),
    ),
  ) as unknown as AstNode;
}

function createLegacyWds3Hook(middlewareBinding: string): AstNode {
  const builders = recast.types.builders;
  const app = builders.identifier('app');
  const middleware = builders.identifier(WDS_MIDDLEWARE_LOCAL);
  return builders.property(
    'init',
    builders.identifier('before'),
    builders.functionExpression(
      null,
      ['app', 'server', 'compiler'].map((parameter) => builders.identifier(parameter)),
      builders.blockStatement([
        builders.variableDeclaration('const', [
          builders.variableDeclarator(
            middleware,
            builders.callExpression(builders.identifier(middlewareBinding), [
              builders.identifier('compiler'),
            ]),
          ),
        ]),
        builders.ifStatement(middleware, builders.blockStatement([
          builders.expressionStatement(builders.callExpression(
            builders.memberExpression(app, builders.identifier('use')),
            [middleware],
          )),
        ])),
      ]),
    ),
  ) as unknown as AstNode;
}

type WdsHookShape = 'generated' | 'legacy-generated' | 'static' | 'wrapped';

interface WdsHookInfo {
  shape: WdsHookShape;
  body: AstNode;
  parameters: string[];
}

function isStaticWdsExpression(node: AstNode | null | undefined): boolean {
  if (!node) {
    return false;
  }
  if (isIdentifier(node) || [
    'StringLiteral',
    'NumericLiteral',
    'BooleanLiteral',
    'NullLiteral',
    'Literal',
    'RegExpLiteral',
  ].includes(node.type)) {
    return true;
  }
  if (node.type === 'ObjectExpression') {
    return ((node.properties as AstNode[] | undefined) ?? []).every((property) =>
      (property.type === 'ObjectProperty' || property.type === 'Property')
      && property.computed !== true
      && property.method !== true
      && property.kind !== 'get'
      && property.kind !== 'set'
      && isStaticWdsExpression(property.value as AstNode | undefined));
  }
  if (node.type === 'ArrayExpression') {
    return ((node.elements as Array<AstNode | null> | undefined) ?? []).every((element) =>
      element !== null && element.type !== 'SpreadElement' && isStaticWdsExpression(element));
  }
  if (node.type === 'MemberExpression') {
    return node.optional !== true
      && isStaticWdsExpression(node.object as AstNode | undefined)
      && (node.computed === true
        ? isStaticWdsExpression(node.property as AstNode | undefined)
        : isIdentifier(node.property as AstNode | undefined));
  }
  if (node.type === 'UnaryExpression') {
    return isStaticWdsExpression(node.argument as AstNode | undefined);
  }
  if (node.type === 'TemplateLiteral') {
    return ((node.expressions as AstNode[] | undefined) ?? []).every(isStaticWdsExpression);
  }
  return node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression';
}

function isSafeWdsUserStatement(
  statement: AstNode,
  major: 3 | 4,
  parameter: string,
): boolean {
  const expression = statement.type === 'ExpressionStatement'
    ? statement.expression as AstNode | undefined
    : undefined;
  const callee = expression?.type === 'CallExpression'
    ? expression.callee as AstNode | undefined
    : undefined;
  const argumentsList = expression?.type === 'CallExpression'
    ? (expression.arguments as AstNode[] | undefined) ?? []
    : [];
  const allowedMethods = major === 3 ? ['use'] : ['push', 'unshift'];
  return expression?.type === 'CallExpression'
    && expression.optional !== true
    && callee?.type === 'MemberExpression'
    && callee.computed !== true
    && isIdentifier(callee.object, parameter)
    && isIdentifier(callee.property)
    && allowedMethods.includes(callee.property.name)
    && argumentsList.length === 1
    && argumentsList[0]?.type !== 'SpreadElement'
    && isStaticWdsExpression(argumentsList[0]);
}

function safeWdsUserStatements(
  statements: readonly AstNode[],
  major: 3 | 4,
  parameter: string,
): boolean {
  return statements.length <= 1
    && statements.every((statement) =>
      isSafeWdsUserStatement(statement, major, parameter)
      && !hasIdentifierReference(statement, WDS_MIDDLEWARE_LOCAL, null));
}

function hookFunctionNode(hook: AstNode): AstNode | undefined {
  const functionNode = hook.type === 'ObjectMethod'
    ? hook
    : hook.value as AstNode | undefined;
  return functionNode
    && ['ArrowFunctionExpression', 'FunctionExpression', 'ObjectMethod'].includes(functionNode.type)
    ? functionNode
    : undefined;
}

function analyzeWdsHook(
  hook: AstNode,
  major: 3 | 4,
  middlewareBinding: string,
): WdsHookInfo | undefined {
  // 只接受初始化器生成的 hook，或可证明为空/单 return 的静态 hook。
  if (sameAstStructure(hook, createWdsHook(major, middlewareBinding))) {
    const generatedFunction = hookFunctionNode(hook) as AstNode;
    return {
      shape: 'generated',
      body: generatedFunction.body as AstNode,
      parameters: ((generatedFunction.params as AstNode[]) ?? [])
        .map((parameter) => isIdentifier(parameter) ? parameter.name : ''),
    };
  }
  // 仅识别旧初始化器精确生成的 WDS3 hook，避免迁移用户自定义的三参数逻辑。
  if (major === 3 && sameAstStructure(hook, createLegacyWds3Hook(middlewareBinding))) {
    const generatedFunction = hookFunctionNode(hook) as AstNode;
    return {
      shape: 'legacy-generated',
      body: generatedFunction.body as AstNode,
      parameters: ((generatedFunction.params as AstNode[]) ?? [])
        .map((parameter) => isIdentifier(parameter) ? parameter.name : ''),
    };
  }
  const functionNode = hookFunctionNode(hook);
  const parameters = (functionNode?.params as AstNode[] | undefined) ?? [];
  const validParameterCount = major === 3
    ? parameters.length === 2 || parameters.length === 3
    : parameters.length === 2;
  if (!functionNode
    || functionNode.async === true
    || functionNode.generator === true
    || (functionNode.body as AstNode | undefined)?.type !== 'BlockStatement'
    || !validParameterCount
    || !parameters.every((parameter) => isIdentifier(parameter))) {
    return undefined;
  }
  const parameterNames = parameters.map((parameter) =>
    isIdentifier(parameter) ? parameter.name : '');
  if (new Set(parameterNames).size !== parameterNames.length
    || parameterNames.includes(WDS_MIDDLEWARE_LOCAL)
    || parameterNames.includes(middlewareBinding)) {
    return undefined;
  }
  const body = functionNode.body as AstNode;
  const statements = (body.body as AstNode[] | undefined) ?? [];
  const expectedStatements = createWdsHookStatements(major, middlewareBinding, parameterNames);
  const compilerParameter = parameterNames[1] as string;
  const callCount = countMiddlewareFactoryCalls(
    hook,
    middlewareBinding,
    major,
    compilerParameter,
  );
  if (major === 3) {
    if (safeWdsUserStatements(statements, major, parameterNames[0] as string)
      && callCount === 0) {
      return { shape: 'static', body, parameters: parameterNames };
    }
    const userStatements = statements.slice(expectedStatements.length);
    if (statements.length >= expectedStatements.length
      && safeWdsUserStatements(userStatements, major, parameterNames[0] as string)
      && callCount === 1
      && expectedStatements.every((statement, index) =>
        sameAstStructure(statements[index], statement))) {
      return { shape: 'wrapped', body, parameters: parameterNames };
    }
    return undefined;
  }
  const returnStatement = statements.at(-1);
  if (returnStatement?.type !== 'ReturnStatement'
    || !isIdentifier(returnStatement.argument, parameterNames[0])) {
    return undefined;
  }
  const beforeReturn = statements.slice(0, -1);
  if (safeWdsUserStatements(beforeReturn, major, parameterNames[0] as string)
    && callCount === 0) {
    return { shape: 'static', body, parameters: parameterNames };
  }
  const ownedStart = beforeReturn.length - expectedStatements.length;
  const userStatements = ownedStart >= 0 ? beforeReturn.slice(0, ownedStart) : [];
  if (ownedStart >= 0
    && safeWdsUserStatements(userStatements, major, parameterNames[0] as string)
    && callCount === 1
    && expectedStatements.every((statement, index) =>
      sameAstStructure(beforeReturn[ownedStart + index], statement))) {
    return { shape: 'wrapped', body, parameters: parameterNames };
  }
  return undefined;
}

function wrapStaticWdsHook(
  info: WdsHookInfo,
  major: 3 | 4,
  middlewareBinding: string,
): void {
  const statements = (info.body.body as AstNode[] | undefined) ?? [];
  const ownedStatements = createWdsHookStatements(major, middlewareBinding, info.parameters);
  const insertionIndex = major === 4 ? statements.length - 1 : 0;
  statements.splice(insertionIndex, 0, ...ownedStatements);
  info.body.body = statements;
}

function removeWrappedWdsHook(
  info: WdsHookInfo,
  major: 3 | 4,
  middlewareBinding: string,
): boolean {
  if (info.shape !== 'wrapped') {
    return false;
  }
  const statements = (info.body.body as AstNode[] | undefined) ?? [];
  const ownedStatements = createWdsHookStatements(major, middlewareBinding, info.parameters);
  const insertionIndex = major === 4
    ? statements.length - ownedStatements.length - 1
    : 0;
  if (insertionIndex < 0 || !ownedStatements.every((statement, index) =>
    sameAstStructure(statements[insertionIndex + index], statement))) {
    return false;
  }
  statements.splice(insertionIndex, ownedStatements.length);
  info.body.body = statements;
  return true;
}

export function transformWebpackConfig(
  source: string,
  options: WebpackAstOptions,
): WebpackAstTransformResult {
  let ast: AstNode;
  try {
    ast = parseProgram(source);
  } catch {
    return { ok: false, code: source, operations: [], errorCode: 'CONFIG_PARSE_FAILED' };
  }
  const body = programBody(ast);
  const exported = findExportedConfig(body);
  if (exported?.type === 'ArrayExpression') {
    return { ok: false, code: source, operations: [], errorCode: 'MULTI_COMPILER_UNSUPPORTED' };
  }
  const config = unwrapObject(exported, body);
  const moduleObject = config ? propertyObject(config, body, 'module') : undefined;
  const rules = moduleObject ? propertyArray(moduleObject, body, 'rules') : undefined;
  const plugins = config ? propertyArray(config, body, 'plugins') : undefined;
  if (!config || !moduleObject || !rules || !plugins
    || !objectProperties(config) || !objectProperties(moduleObject)) {
    return { ok: false, code: source, operations: [], errorCode: 'CONFIG_SHAPE_UNSUPPORTED' };
  }
  const rawRuleElements = (rules.elements as Array<AstNode | null> | undefined) ?? [];
  if (rawRuleElements.some((rule) => rule === null || rule.type === 'SpreadElement')) {
    return { ok: false, code: source, operations: [], errorCode: 'CONFIG_SHAPE_UNSUPPORTED' };
  }
  const ruleElements = rawRuleElements as AstNode[];
  const vueRules = ruleElements.filter((rule) => rule.type === 'ObjectExpression' && isVueRule(rule));
  if (vueRules.length !== 1) {
    return { ok: false, code: source, operations: [], errorCode: 'VUE_RULE_NOT_UNIQUE' };
  }
  const vueRule = vueRules[0] as AstNode;
  const use = propertyArray(vueRule, body, 'use');
  if (!use || ((use.elements as Array<AstNode | null> | undefined) ?? []).some((item) =>
    item === null || item.type === 'SpreadElement')) {
    return { ok: false, code: source, operations: [], errorCode: 'VUE_RULE_USE_UNSUPPORTED' };
  }
  const useElements = (use.elements as AstNode[] | undefined) ?? [];
  const vueLoaderIndices = useElements.flatMap((element, index) =>
    loaderName(element) === 'vue-loader' ? [index] : []);
  if (vueLoaderIndices.length !== 1) {
    return { ok: false, code: source, operations: [], errorCode: 'VUE_LOADER_NOT_UNIQUE' };
  }

  const pluginBinding = ensureNamedBinding(
    body,
    options.moduleKind,
    'WebSourceInspectorWebpackPlugin',
  );
  if (!pluginBinding) {
    return { ok: false, code: source, operations: [], errorCode: 'DUPLICATE_INSPECTOR_IMPORT' };
  }
  const operations: AstOperation[] = [importOperation(pluginBinding)];
  const vueLoaderPluginBindings = packageBindings(body, 'vue-loader', 'VueLoaderPlugin');
  const rawPluginElements = (plugins.elements as Array<AstNode | null> | undefined) ?? [];
  if (rawPluginElements.some((plugin) => plugin === null || plugin.type === 'SpreadElement')) {
    return { ok: false, code: source, operations: [], errorCode: 'CONFIG_SHAPE_UNSUPPORTED' };
  }
  const pluginElements = rawPluginElements as AstNode[];
  if (newExpressionIndices(pluginElements, vueLoaderPluginBindings).length !== 1) {
    return { ok: false, code: source, operations: [], errorCode: 'VUE_LOADER_PLUGIN_NOT_FOUND' };
  }

  const existingPlugin = newExpressionIndices(pluginElements, new Set([pluginBinding.binding]));
  if (existingPlugin.length > 1) {
    return { ok: false, code: source, operations: [], errorCode: 'DUPLICATE_INSPECTOR_PLUGIN' };
  }
  const pluginArguments = options.webpackDevServerMajor
    ? []
    : options.allowedOrigin
      ? [recast.types.builders.objectExpression([
        recast.types.builders.property(
          'init',
          recast.types.builders.identifier('browserTransport'),
          recast.types.builders.stringLiteral('raw'),
        ),
        recast.types.builders.property(
          'init',
          recast.types.builders.identifier('allowedOrigins'),
          recast.types.builders.arrayExpression([
            recast.types.builders.stringLiteral(options.allowedOrigin),
          ]),
        ),
      ])]
      : [];
  if (!options.webpackDevServerMajor && !options.allowedOrigin) {
    return { ok: false, code: source, operations: [], errorCode: 'ALLOWED_ORIGIN_REQUIRED' };
  }
  if (existingPlugin.length === 1
    && !inspectorPluginMatches(
      pluginElements[existingPlugin[0] as number] as AstNode,
      pluginBinding.binding,
      options.allowedOrigin,
    )) {
    return { ok: false, code: source, operations: [], errorCode: 'INSPECTOR_PLUGIN_OPTIONS_CONFLICT' };
  }
  let pluginNode = existingPlugin.length === 1
    ? pluginElements[existingPlugin[0] as number] as AstNode
    : undefined;
  if (!pluginNode) {
    pluginNode = recast.types.builders.newExpression(
      recast.types.builders.identifier(pluginBinding.binding),
      pluginArguments,
    ) as unknown as AstNode;
    pluginElements.push(pluginNode);
  }
  plugins.elements = pluginElements;
  const legacyPluginFingerprint = digestCanonical([
    'webpack-plugin',
    pluginBinding.binding,
    options.allowedOrigin ?? null,
  ]);
  const generatedPluginNode = recast.types.builders.newExpression(
    recast.types.builders.identifier(pluginBinding.binding),
    pluginArguments,
  ) as unknown as AstNode;
  operations.push({
    kind: 'plugin',
    ownership: existingPlugin.length === 0 ? 'created' : 'reused',
    fingerprint: astOperationFingerprint(
      ['webpack-plugin', pluginBinding.binding, options.allowedOrigin ?? null],
      pluginNode,
    ),
    description: `${existingPlugin.length === 0 ? '加入' : '复用'} WebSourceInspectorWebpackPlugin。`,
    details: {
      binding: pluginBinding.binding,
      ...(options.allowedOrigin
        ? { allowedOrigin: options.allowedOrigin, browserTransport: 'raw' }
        : {}),
      legacyFingerprint: legacyPluginFingerprint,
      legacyCreatedCompatible: String(sameAstStructure(pluginNode, generatedPluginNode)),
    },
  });

  const inspectorLoaderIndices = useElements.flatMap((element, index) =>
    isInspectorLoader(element, pluginBinding.binding) ? [index] : []);
  if (inspectorLoaderIndices.length > 1) {
    return { ok: false, code: source, operations: [], errorCode: 'DUPLICATE_INSPECTOR_LOADER' };
  }
  const vueLoaderIndex = vueLoaderIndices[0] as number;
  let loaderOwnership: 'created' | 'reused' = 'reused';
  let loaderDetails: Record<string, string> = { binding: pluginBinding.binding };
  let loaderNode: AstNode;
  if (inspectorLoaderIndices.length === 0) {
    loaderNode = recast.types.builders.memberExpression(
      recast.types.builders.identifier(pluginBinding.binding),
      recast.types.builders.identifier('loaderPath'),
    ) as unknown as AstNode;
    useElements.splice(vueLoaderIndex, 0, loaderNode);
    loaderOwnership = 'created';
    loaderDetails = { ...loaderDetails, action: 'inserted-before-vue-loader' };
  } else {
    const inspectorIndex = inspectorLoaderIndices[0] as number;
    loaderNode = useElements[inspectorIndex] as AstNode;
    if (inspectorIndex > vueLoaderIndex) {
      const prePosition = capturePositionAnchors(useElements, inspectorIndex);
      const [loader] = useElements.splice(inspectorIndex, 1);
      useElements.splice(vueLoaderIndex, 0, loader as AstNode);
      const postPosition = capturePositionAnchors(useElements, vueLoaderIndex);
      loaderDetails = {
        ...loaderDetails,
        action: 'moved-before-vue-loader',
        prePrevious: prePosition.previousAnchor,
        preNext: prePosition.nextAnchor,
        postPrevious: postPosition.previousAnchor,
        postNext: postPosition.nextAnchor,
      };
    }
  }
  use.elements = useElements;
  const legacyLoaderFingerprint = digestCanonical(['webpack-loader', pluginBinding.binding]);
  operations.push({
    kind: 'loader',
    ownership: loaderOwnership,
    fingerprint: astOperationFingerprint(
      ['webpack-loader', pluginBinding.binding],
      loaderNode,
    ),
    description: `${loaderOwnership === 'created' ? '加入' : '复用'} Inspector template Loader。`,
    details: {
      ...loaderDetails,
      legacyFingerprint: legacyLoaderFingerprint,
      legacyCreatedCompatible: 'true',
    },
  });

  if (options.webpackDevServerMajor) {
    const middlewareBinding = ensureNamedBinding(
      body,
      options.moduleKind,
      'createWebSourceInspectorBrowserMiddleware',
    );
    if (!middlewareBinding) {
      return { ok: false, code: source, operations: [], errorCode: 'DUPLICATE_INSPECTOR_IMPORT' };
    }
    operations.push(importOperation(middlewareBinding));
    const devServerResult = ensureObjectProperty(config, body, 'devServer');
    const devServer = devServerResult?.object;
    if (!devServer || !objectProperties(devServer)) {
      return { ok: false, code: source, operations: [], errorCode: 'DEV_SERVER_SHAPE_UNSUPPORTED' };
    }
    const hookName = options.webpackDevServerMajor === 3 ? 'before' : 'setupMiddlewares';
    let hook = findProperty(devServer, hookName);
    let hookOwnership: 'created' | 'reused';
    let hookAction: string | undefined;
    let migratedLegacyHookFingerprint: string | undefined;
    if (!hook) {
      hook = createWdsHook(
        options.webpackDevServerMajor,
        middlewareBinding.binding,
      );
      (devServer.properties as AstNode[]).push(hook);
      hookOwnership = 'created';
    } else {
      const hookInfo = analyzeWdsHook(
        hook,
        options.webpackDevServerMajor,
        middlewareBinding.binding,
      );
      if (!hookInfo) {
        return { ok: false, code: source, operations: [], errorCode: 'WDS_HOOK_UNSAFE_TO_WRAP' };
      }
      if (hookInfo.shape === 'legacy-generated') {
        migratedLegacyHookFingerprint = astOperationFingerprint(
          ['webpack-transport-hook', hookName, middlewareBinding.binding],
          hook,
        );
        const properties = devServer.properties as AstNode[];
        const replacement = createWdsHook(
          options.webpackDevServerMajor,
          middlewareBinding.binding,
        );
        properties.splice(properties.indexOf(hook), 1, replacement);
        hook = replacement;
        hookOwnership = 'reused';
      } else if (hookInfo.shape === 'static') {
        wrapStaticWdsHook(hookInfo, options.webpackDevServerMajor, middlewareBinding.binding);
        hookOwnership = 'created';
        hookAction = 'wrapped-static-hook';
      } else {
        hookOwnership = 'reused';
        hookAction = hookInfo.shape === 'wrapped' ? 'wrapped-static-hook' : undefined;
      }
    }
    const legacyHookFingerprint = migratedLegacyHookFingerprint ?? digestCanonical([
      'webpack-transport-hook',
      hookName,
      middlewareBinding.binding,
      'compiler-arg-v1',
    ]);
    operations.push({
      kind: 'transport-hook',
      ownership: hookOwnership,
      fingerprint: astOperationFingerprint(
        ['webpack-transport-hook', hookName, middlewareBinding.binding],
        hook,
      ),
      description: `${hookOwnership === 'created' ? '加入' : '复用'} ${hookName} Browser transport hook。`,
      details: {
        hookName,
        binding: middlewareBinding.binding,
        legacyFingerprint: legacyHookFingerprint,
        legacyCreatedCompatible: String(hookAction !== 'wrapped-static-hook'),
        ...(hookAction ? { action: hookAction } : {}),
        ...(hookAction === 'wrapped-static-hook' ? { hookContainerOwnership: 'reused' } : {}),
        ...(devServerResult.created ? { devServerOwnership: 'created' } : {}),
      },
    });
  }
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
  if (node === ignored || typeof node !== 'object' || node === null || seen.has(node)) {
    return false;
  }
  seen.add(node);
  const candidate = node as AstNode;
  if (isIdentifier(candidate, binding)) {
    return true;
  }
  return Object.entries(candidate).some(([key, value]) => {
    if (['loc', 'start', 'end', 'tokens', 'comments', 'original'].includes(key)) {
      return false;
    }
    return Array.isArray(value)
      ? value.some((item) => hasIdentifierReference(item, binding, ignored, seen))
      : hasIdentifierReference(value, binding, ignored, seen);
  });
}

function removeNamedBinding(
  body: AstNode[],
  exported: string,
  binding: string,
): boolean {
  for (let statementIndex = 0; statementIndex < body.length; statementIndex += 1) {
    const statement = body[statementIndex] as AstNode;
    if (statement.type === 'ImportDeclaration'
      && isStringLiteral(statement.source, 'web-source-inspector/webpack')) {
      const specifiers = (statement.specifiers as AstNode[] | undefined) ?? [];
      const specifierIndex = specifiers.findIndex((specifier) =>
        specifier.type === 'ImportSpecifier'
        && isIdentifier(specifier.imported, exported)
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
      const id = declaration.id as AstNode | undefined;
      const init = declaration.init as AstNode | undefined;
      if (id?.type !== 'ObjectPattern' || init?.type !== 'CallExpression'
        || !isIdentifier(init.callee, 'require')
        || !isStringLiteral((init.arguments as AstNode[] | undefined)?.[0], 'web-source-inspector/webpack')) {
        continue;
      }
      const properties = (id.properties as AstNode[] | undefined) ?? [];
      const propertyIndex = properties.findIndex((property) =>
        propertyName(property) === exported && isIdentifier(property.value, binding));
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

export function removeWebpackIntegration(
  source: string,
  operations: readonly AstOperation[],
): WebpackAstTransformResult {
  let ast: AstNode;
  try {
    ast = parseProgram(source);
  } catch {
    return { ok: false, code: source, operations: [], errorCode: 'CONFIG_PARSE_FAILED' };
  }
  const body = programBody(ast);
  const config = unwrapObject(findExportedConfig(body), body);
  const moduleObject = config ? propertyObject(config, body, 'module') : undefined;
  const rules = moduleObject ? propertyArray(moduleObject, body, 'rules') : undefined;
  const plugins = config ? propertyArray(config, body, 'plugins') : undefined;
  if (!config || !moduleObject || !rules || !plugins
    || !objectProperties(config) || !objectProperties(moduleObject)) {
    return { ok: false, code: source, operations: [], errorCode: 'INTEGRATION_STATE_CONFLICT' };
  }
  const pluginOperation = operations.find((operation) => operation.kind === 'plugin');
  const loaderOperation = operations.find((operation) => operation.kind === 'loader');
  const pluginBinding = pluginOperation?.details?.binding ?? loaderOperation?.details?.binding;
  if (!pluginOperation || !loaderOperation || !pluginBinding) {
    return { ok: false, code: source, operations: [], errorCode: 'INTEGRATION_STATE_CONFLICT' };
  }

  const rawRuleElements = (rules.elements as Array<AstNode | null> | undefined) ?? [];
  if (rawRuleElements.some((rule) => rule === null || rule.type === 'SpreadElement')) {
    return { ok: false, code: source, operations: [], errorCode: 'INTEGRATION_STATE_CONFLICT' };
  }
  const ruleElements = rawRuleElements as AstNode[];
  const vueRules = ruleElements.filter((rule) => rule.type === 'ObjectExpression' && isVueRule(rule));
  const use = vueRules.length === 1 ? propertyArray(vueRules[0] as AstNode, body, 'use') : undefined;
  if (!use) {
    return { ok: false, code: source, operations: [], errorCode: 'INTEGRATION_STATE_CONFLICT' };
  }
  const rawUseElements = (use.elements as Array<AstNode | null> | undefined) ?? [];
  if (rawUseElements.some((element) => element === null || element.type === 'SpreadElement')) {
    return { ok: false, code: source, operations: [], errorCode: 'INTEGRATION_STATE_CONFLICT' };
  }
  const useElements = rawUseElements as AstNode[];
  const loaderIndices = useElements.flatMap((element, index) =>
    isInspectorLoader(element, pluginBinding) ? [index] : []);
  if (loaderIndices.length !== 1) {
    return { ok: false, code: source, operations: [], errorCode: 'INTEGRATION_STATE_CONFLICT' };
  }
  const loaderIndex = loaderIndices[0] as number;
  const loaderNode = useElements[loaderIndex] as AstNode;
  const legacyLoaderFingerprint = digestCanonical(['webpack-loader', pluginBinding]);
  if (!operationMatchesNode(
    loaderOperation,
    ['webpack-loader', pluginBinding],
    loaderNode,
    legacyLoaderFingerprint,
    isInspectorLoader(loaderNode, pluginBinding),
  )) {
    return { ok: false, code: source, operations: [], errorCode: 'INTEGRATION_STATE_CONFLICT' };
  }
  if (loaderOperation.ownership === 'created') {
    useElements.splice(loaderIndex, 1);
  } else if (loaderOperation.details?.action === 'moved-before-vue-loader') {
    const restored = restoreByPositionAnchors(useElements, loaderIndex, loaderOperation.details);
    if (!restored) {
      return { ok: false, code: source, operations: [], errorCode: 'INTEGRATION_STATE_CONFLICT' };
    }
    use.elements = restored;
  } else {
    use.elements = useElements;
  }

  const rawPluginElements = (plugins.elements as Array<AstNode | null> | undefined) ?? [];
  if (rawPluginElements.some((plugin) => plugin === null || plugin.type === 'SpreadElement')) {
    return { ok: false, code: source, operations: [], errorCode: 'INTEGRATION_STATE_CONFLICT' };
  }
  const pluginElements = rawPluginElements as AstNode[];
  const pluginIndices = newExpressionIndices(pluginElements, new Set([pluginBinding]));
  if (pluginIndices.length !== 1
    || !inspectorPluginMatches(
      pluginElements[pluginIndices[0] as number] as AstNode,
      pluginBinding,
      pluginOperation.details?.allowedOrigin,
    )) {
    return { ok: false, code: source, operations: [], errorCode: 'INTEGRATION_STATE_CONFLICT' };
  }
  const pluginNode = pluginElements[pluginIndices[0] as number] as AstNode;
  const legacyPluginFingerprint = digestCanonical([
    'webpack-plugin',
    pluginBinding,
    pluginOperation.details?.allowedOrigin ?? null,
  ]);
  if (!operationMatchesNode(
    pluginOperation,
    ['webpack-plugin', pluginBinding, pluginOperation.details?.allowedOrigin ?? null],
    pluginNode,
    legacyPluginFingerprint,
    inspectorPluginMatches(
      pluginNode,
      pluginBinding,
      pluginOperation.details?.allowedOrigin,
    ),
  )) {
    return { ok: false, code: source, operations: [], errorCode: 'INTEGRATION_STATE_CONFLICT' };
  }
  if (pluginOperation.ownership === 'created') {
    pluginElements.splice(pluginIndices[0] as number, 1);
  }
  plugins.elements = pluginElements;

  const hookOperation = operations.find((operation) => operation.kind === 'transport-hook');
  if (hookOperation) {
    const hookName = hookOperation.details?.hookName;
    const middlewareBinding = hookOperation.details?.binding;
    const devServer = propertyObject(config, body, 'devServer');
    const hook = devServer && hookName ? findProperty(devServer, hookName) : undefined;
    const major = hookName === 'before' ? 3 : hookName === 'setupMiddlewares' ? 4 : undefined;
    const hookInfo = hook && middlewareBinding && major
      ? analyzeWdsHook(hook, major, middlewareBinding)
      : undefined;
    const legacyHookFingerprint = hookName && middlewareBinding
      ? digestCanonical([
        'webpack-transport-hook',
        hookName,
        middlewareBinding,
        'compiler-arg-v1',
      ])
      : '';
    const exactGeneratedHook = hookInfo?.shape === 'generated'
      || hookInfo?.shape === 'legacy-generated'
      || (hookOperation.details?.action === 'wrapped-static-hook'
        && hookInfo?.shape === 'wrapped');
    if (!devServer || !hook || !middlewareBinding || !major || !hookInfo
      || !objectProperties(devServer)
      || !operationMatchesNode(
        hookOperation,
        ['webpack-transport-hook', hookName, middlewareBinding],
        hook,
        legacyHookFingerprint,
        Boolean(exactGeneratedHook),
      )) {
      return { ok: false, code: source, operations: [], errorCode: 'INTEGRATION_STATE_CONFLICT' };
    }
    if (hookOperation.ownership === 'created') {
      if (hookOperation.details?.action === 'wrapped-static-hook') {
        if (!removeWrappedWdsHook(hookInfo, major, middlewareBinding)) {
          return { ok: false, code: source, operations: [], errorCode: 'INTEGRATION_STATE_CONFLICT' };
        }
      } else {
        const properties = devServer.properties as AstNode[];
        properties.splice(properties.indexOf(hook), 1);
      }
    }
    if (hookOperation.details?.devServerOwnership === 'created'
      && (devServer.properties as AstNode[]).length === 0) {
      const configProperties = config.properties as AstNode[];
      const devServerProperty = findProperty(config, 'devServer');
      if (devServerProperty) {
        configProperties.splice(configProperties.indexOf(devServerProperty), 1);
      }
    }
  }

  const importOperations = operations.filter((operation) => operation.kind === 'import');
  for (const operation of importOperations) {
    const exported = operation.details?.exported;
    const binding = operation.details?.binding;
    const matches = exported && binding
      ? findNamedBindings(body, exported).filter((item) => item.binding === binding)
      : [];
    const bindingNode = matches[0]?.node;
    if (!exported || !binding || matches.length !== 1 || !bindingNode
      || !operationMatchesNode(
        operation,
        ['webpack-import', exported, binding],
        bindingNode,
        legacyImportFingerprint(exported, binding),
        exactGeneratedImportNode(bindingNode, exported, binding),
      )) {
      return { ok: false, code: source, operations: [], errorCode: 'INTEGRATION_STATE_CONFLICT' };
    }
    if (operation.ownership === 'created'
      && !removeNamedBinding(body, exported, binding)) {
      return { ok: false, code: source, operations: [], errorCode: 'INTEGRATION_STATE_CONFLICT' };
    }
  }
  return {
    ok: true,
    code: printProgram(ast, source),
    operations: [...operations],
  };
}

interface FunctionBodyInfo {
  body: AstNode;
  parameter: string;
  property: AstNode;
  createdProperty: boolean;
}

function chainWebpackBody(config: AstNode): FunctionBodyInfo | undefined {
  const property = findProperty(config, 'chainWebpack');
  if (!property) {
    const builders = recast.types.builders;
    const parameter = builders.identifier('config');
    const created = builders.property(
      'init',
      builders.identifier('chainWebpack'),
      builders.functionExpression(null, [parameter], builders.blockStatement([])),
    ) as unknown as AstNode;
    (config.properties as AstNode[]).push(created);
    return {
      body: ((created.value as AstNode).body as AstNode),
      parameter: 'config',
      property: created,
      createdProperty: true,
    };
  }
  const functionNode = property.type === 'ObjectMethod'
    ? property
    : property.value as AstNode | undefined;
  const parameters = (functionNode?.params as AstNode[] | undefined) ?? [];
  const functionBody = functionNode?.body as AstNode | undefined;
  if (!functionNode
    || !['ObjectMethod', 'FunctionExpression', 'ArrowFunctionExpression'].includes(functionNode.type)
    || functionBody?.type !== 'BlockStatement'
    || parameters.length < 1
    || !isIdentifier(parameters[0])) {
    return undefined;
  }
  return {
    body: functionBody,
    parameter: parameters[0].name,
    property,
    createdProperty: false,
  };
}

function callMember(object: AstNode, property: string, args: AstNode[]): AstNode {
  const builders = recast.types.builders;
  return builders.callExpression(
    builders.memberExpression(object as never, builders.identifier(property)),
    args as never[],
  ) as unknown as AstNode;
}

function createVueCliLoaderStatement(parameter: string, binding: string): AstNode {
  const builders = recast.types.builders;
  let expression = builders.memberExpression(
    builders.identifier(parameter),
    builders.identifier('module'),
  ) as unknown as AstNode;
  expression = callMember(expression, 'rule', [builders.stringLiteral('vue') as unknown as AstNode]);
  expression = callMember(expression, 'use', [builders.stringLiteral('web-source-inspector') as unknown as AstNode]);
  expression = callMember(expression, 'loader', [builders.memberExpression(
    builders.identifier(binding),
    builders.identifier('loaderPath'),
  ) as unknown as AstNode]);
  expression = callMember(expression, 'before', [builders.stringLiteral('vue-loader') as unknown as AstNode]);
  return builders.expressionStatement(expression as never) as unknown as AstNode;
}

function createVueCliPluginStatement(parameter: string, binding: string): AstNode {
  const builders = recast.types.builders;
  let expression = callMember(builders.identifier(parameter) as unknown as AstNode, 'plugin', [
    builders.stringLiteral('web-source-inspector') as unknown as AstNode,
  ]);
  expression = callMember(expression, 'use', [builders.identifier(binding) as unknown as AstNode]);
  return builders.expressionStatement(expression as never) as unknown as AstNode;
}

function containsString(node: unknown, text: string, seen = new WeakSet<object>()): boolean {
  if (typeof node !== 'object' || node === null || seen.has(node)) {
    return false;
  }
  seen.add(node);
  if (isStringLiteral(node, text)) {
    return true;
  }
  return Object.entries(node as AstNode).some(([key, value]) => {
    if (['loc', 'start', 'end', 'tokens', 'comments', 'original'].includes(key)) {
      return false;
    }
    return Array.isArray(value)
      ? value.some((item) => containsString(item, text, seen))
      : containsString(value, text, seen);
  });
}

function exactChainStatements(
  body: AstNode,
  parameter: string,
  binding: string,
): { loader: AstNode[]; plugin: AstNode[]; unsupported: boolean } {
  const statements = (body.body as AstNode[] | undefined) ?? [];
  const expectedLoader = createVueCliLoaderStatement(parameter, binding);
  const expectedPlugin = createVueCliPluginStatement(parameter, binding);
  const loader = statements.filter((statement) =>
    sameAstStructure(statement, expectedLoader));
  const plugin = statements.filter((statement) =>
    sameAstStructure(statement, expectedPlugin));
  const exactStatements = new Set([...loader, ...plugin]);
  const unsupported = statements.some((statement) =>
    !exactStatements.has(statement)
    && (hasIdentifierReference(statement, binding, null)
      || containsString(statement, 'vue-loader')
      || containsString(statement, 'web-source-inspector')));
  return { loader, plugin, unsupported };
}

export function transformVueCliConfig(
  source: string,
  options: Pick<WebpackAstOptions, 'moduleKind' | 'webpackDevServerMajor'>,
): WebpackAstTransformResult {
  if (!options.webpackDevServerMajor) {
    return { ok: false, code: source, operations: [], errorCode: 'WDS_TRANSPORT_UNSUPPORTED' };
  }
  let ast: AstNode;
  try {
    ast = parseProgram(source);
  } catch {
    return { ok: false, code: source, operations: [], errorCode: 'CONFIG_PARSE_FAILED' };
  }
  const body = programBody(ast);
  const config = unwrapObject(findExportedConfig(body), body);
  if (!config || !objectProperties(config)) {
    return { ok: false, code: source, operations: [], errorCode: 'CONFIG_SHAPE_UNSUPPORTED' };
  }
  const pluginBinding = ensureNamedBinding(
    body,
    options.moduleKind,
    'WebSourceInspectorWebpackPlugin',
  );
  const middlewareBinding = ensureNamedBinding(
    body,
    options.moduleKind,
    'createWebSourceInspectorBrowserMiddleware',
  );
  if (!pluginBinding || !middlewareBinding) {
    return { ok: false, code: source, operations: [], errorCode: 'DUPLICATE_INSPECTOR_IMPORT' };
  }
  const operations: AstOperation[] = [
    importOperation(pluginBinding),
    importOperation(middlewareBinding),
  ];
  const chain = chainWebpackBody(config);
  if (!chain) {
    return { ok: false, code: source, operations: [], errorCode: 'CHAIN_WEBPACK_UNSUPPORTED' };
  }
  const statements = (chain.body.body as AstNode[] | undefined) ?? [];
  const existingChainStatements = exactChainStatements(
    chain.body,
    chain.parameter,
    pluginBinding.binding,
  );
  const loaderStatements = existingChainStatements.loader;
  const pluginStatements = existingChainStatements.plugin;
  if (existingChainStatements.unsupported) {
    return { ok: false, code: source, operations: [], errorCode: 'CHAIN_WEBPACK_UNSUPPORTED' };
  }
  if (loaderStatements.length > 1 || pluginStatements.length > 1) {
    return { ok: false, code: source, operations: [], errorCode: 'DUPLICATE_INSPECTOR_INTEGRATION' };
  }
  if (loaderStatements.length === 0) {
    statements.unshift(createVueCliLoaderStatement(chain.parameter, pluginBinding.binding));
  }
  if (pluginStatements.length === 0) {
    statements.unshift(createVueCliPluginStatement(chain.parameter, pluginBinding.binding));
  }
  chain.body.body = statements;
  const currentChainStatements = exactChainStatements(
    chain.body,
    chain.parameter,
    pluginBinding.binding,
  );
  const currentLoaderStatements = currentChainStatements.loader;
  const currentPluginStatements = currentChainStatements.plugin;
  if (currentChainStatements.unsupported
    || currentLoaderStatements.length !== 1
    || currentPluginStatements.length !== 1) {
    return { ok: false, code: source, operations: [], errorCode: 'DUPLICATE_INSPECTOR_INTEGRATION' };
  }
  const legacyLoaderFingerprint = digestCanonical([
    'vue-cli-loader',
    pluginBinding.binding,
    chain.parameter,
  ]);
  operations.push({
    kind: 'loader',
    ownership: loaderStatements.length === 0 ? 'created' : 'reused',
    fingerprint: astOperationFingerprint(
      ['vue-cli-loader', pluginBinding.binding, chain.parameter],
      currentLoaderStatements[0],
    ),
    description: `${loaderStatements.length === 0 ? '加入' : '复用'} Vue CLI Inspector Loader chain。`,
    details: {
      binding: pluginBinding.binding,
      parameter: chain.parameter,
      legacyFingerprint: legacyLoaderFingerprint,
      legacyCreatedCompatible: 'true',
      ...(chain.createdProperty ? { chainHookOwnership: 'created' } : {}),
    },
  });
  const legacyPluginFingerprint = digestCanonical([
    'vue-cli-plugin',
    pluginBinding.binding,
    chain.parameter,
  ]);
  operations.push({
    kind: 'plugin',
    ownership: pluginStatements.length === 0 ? 'created' : 'reused',
    fingerprint: astOperationFingerprint(
      ['vue-cli-plugin', pluginBinding.binding, chain.parameter],
      currentPluginStatements[0],
    ),
    description: `${pluginStatements.length === 0 ? '加入' : '复用'} Vue CLI Inspector Plugin chain。`,
    details: {
      binding: pluginBinding.binding,
      parameter: chain.parameter,
      legacyFingerprint: legacyPluginFingerprint,
      legacyCreatedCompatible: 'true',
      ...(chain.createdProperty ? { chainHookOwnership: 'created' } : {}),
    },
  });

  const devServerResult = ensureObjectProperty(config, body, 'devServer');
  const devServer = devServerResult?.object;
  if (!devServer || !objectProperties(devServer)) {
    return { ok: false, code: source, operations: [], errorCode: 'DEV_SERVER_SHAPE_UNSUPPORTED' };
  }
  const hookName = options.webpackDevServerMajor === 3 ? 'before' : 'setupMiddlewares';
  let hook = findProperty(devServer, hookName);
  let hookOwnership: 'created' | 'reused';
  let hookAction: string | undefined;
  let migratedLegacyHookFingerprint: string | undefined;
  if (!hook) {
    hook = createWdsHook(
      options.webpackDevServerMajor,
      middlewareBinding.binding,
    );
    (devServer.properties as AstNode[]).push(hook);
    hookOwnership = 'created';
  } else {
    const hookInfo = analyzeWdsHook(
      hook,
      options.webpackDevServerMajor,
      middlewareBinding.binding,
    );
    if (!hookInfo) {
      return { ok: false, code: source, operations: [], errorCode: 'WDS_HOOK_UNSAFE_TO_WRAP' };
    }
    if (hookInfo.shape === 'legacy-generated') {
      migratedLegacyHookFingerprint = astOperationFingerprint(
        ['webpack-transport-hook', hookName, middlewareBinding.binding],
        hook,
      );
      const properties = devServer.properties as AstNode[];
      const replacement = createWdsHook(
        options.webpackDevServerMajor,
        middlewareBinding.binding,
      );
      properties.splice(properties.indexOf(hook), 1, replacement);
      hook = replacement;
      hookOwnership = 'reused';
    } else if (hookInfo.shape === 'static') {
      wrapStaticWdsHook(hookInfo, options.webpackDevServerMajor, middlewareBinding.binding);
      hookOwnership = 'created';
      hookAction = 'wrapped-static-hook';
    } else {
      hookOwnership = 'reused';
      hookAction = hookInfo.shape === 'wrapped' ? 'wrapped-static-hook' : undefined;
    }
  }
  const legacyHookFingerprint = migratedLegacyHookFingerprint ?? digestCanonical([
    'webpack-transport-hook',
    hookName,
    middlewareBinding.binding,
    'compiler-arg-v1',
  ]);
  operations.push({
    kind: 'transport-hook',
    ownership: hookOwnership,
    fingerprint: astOperationFingerprint(
      ['webpack-transport-hook', hookName, middlewareBinding.binding],
      hook,
    ),
    description: `${hookOwnership === 'created' ? '加入' : '复用'} Vue CLI ${hookName} hook。`,
    details: {
      hookName,
      binding: middlewareBinding.binding,
      legacyFingerprint: legacyHookFingerprint,
      legacyCreatedCompatible: String(hookAction !== 'wrapped-static-hook'),
      ...(hookAction ? { action: hookAction } : {}),
      ...(hookAction === 'wrapped-static-hook' ? { hookContainerOwnership: 'reused' } : {}),
      ...(devServerResult.created ? { devServerOwnership: 'created' } : {}),
    },
  });
  return {
    ok: true,
    code: printProgram(ast, source),
    operations,
  };
}

export function removeVueCliIntegration(
  source: string,
  operations: readonly AstOperation[],
): WebpackAstTransformResult {
  let ast: AstNode;
  try {
    ast = parseProgram(source);
  } catch {
    return { ok: false, code: source, operations: [], errorCode: 'CONFIG_PARSE_FAILED' };
  }
  const body = programBody(ast);
  const config = unwrapObject(findExportedConfig(body), body);
  const loaderOperation = operations.find((operation) => operation.kind === 'loader');
  const pluginOperation = operations.find((operation) => operation.kind === 'plugin');
  const pluginBinding = loaderOperation?.details?.binding;
  const parameter = loaderOperation?.details?.parameter;
  if (!config || !objectProperties(config)
    || !loaderOperation || !pluginOperation || !pluginBinding || !parameter) {
    return { ok: false, code: source, operations: [], errorCode: 'INTEGRATION_STATE_CONFLICT' };
  }
  const chain = chainWebpackBody(config);
  if (!chain || chain.createdProperty || chain.parameter !== parameter) {
    return { ok: false, code: source, operations: [], errorCode: 'INTEGRATION_STATE_CONFLICT' };
  }
  const currentChainStatements = exactChainStatements(chain.body, parameter, pluginBinding);
  const loaderStatements = currentChainStatements.loader;
  const pluginStatements = currentChainStatements.plugin;
  if (currentChainStatements.unsupported
    || loaderStatements.length !== 1
    || pluginStatements.length !== 1) {
    return { ok: false, code: source, operations: [], errorCode: 'INTEGRATION_STATE_CONFLICT' };
  }
  const loaderStatement = loaderStatements[0] as AstNode;
  const pluginStatement = pluginStatements[0] as AstNode;
  const legacyLoaderFingerprint = digestCanonical([
    'vue-cli-loader',
    pluginBinding,
    parameter,
  ]);
  const legacyPluginFingerprint = digestCanonical([
    'vue-cli-plugin',
    pluginBinding,
    parameter,
  ]);
  if (!operationMatchesNode(
    loaderOperation,
    ['vue-cli-loader', pluginBinding, parameter],
    loaderStatement,
    legacyLoaderFingerprint,
    sameAstStructure(loaderStatement, createVueCliLoaderStatement(parameter, pluginBinding)),
  ) || !operationMatchesNode(
    pluginOperation,
    ['vue-cli-plugin', pluginBinding, parameter],
    pluginStatement,
    legacyPluginFingerprint,
    sameAstStructure(pluginStatement, createVueCliPluginStatement(parameter, pluginBinding)),
  )) {
    return { ok: false, code: source, operations: [], errorCode: 'INTEGRATION_STATE_CONFLICT' };
  }
  const statements = chain.body.body as AstNode[];
  if (loaderOperation.ownership === 'created') {
    statements.splice(statements.indexOf(loaderStatements[0] as AstNode), 1);
  }
  if (pluginOperation.ownership === 'created') {
    statements.splice(statements.indexOf(pluginStatements[0] as AstNode), 1);
  }
  if (loaderOperation.details?.chainHookOwnership === 'created'
    && pluginOperation.details?.chainHookOwnership === 'created'
    && statements.length === 0) {
    const properties = config.properties as AstNode[];
    properties.splice(properties.indexOf(chain.property), 1);
  }

  const hookOperation = operations.find((operation) => operation.kind === 'transport-hook');
  if (!hookOperation) {
    return { ok: false, code: source, operations: [], errorCode: 'INTEGRATION_STATE_CONFLICT' };
  }
  const devServer = propertyObject(config, body, 'devServer');
  const hookName = hookOperation.details?.hookName;
  const middlewareBinding = hookOperation.details?.binding;
  const hook = devServer && hookName ? findProperty(devServer, hookName) : undefined;
  const major = hookName === 'before' ? 3 : hookName === 'setupMiddlewares' ? 4 : undefined;
  const hookInfo = hook && middlewareBinding && major
    ? analyzeWdsHook(hook, major, middlewareBinding)
    : undefined;
  const legacyHookFingerprint = hookName && middlewareBinding
    ? digestCanonical([
      'webpack-transport-hook',
      hookName,
      middlewareBinding,
      'compiler-arg-v1',
    ])
    : '';
  const exactGeneratedHook = hookInfo?.shape === 'generated'
    || hookInfo?.shape === 'legacy-generated'
    || (hookOperation.details?.action === 'wrapped-static-hook'
      && hookInfo?.shape === 'wrapped');
  if (!devServer || !objectProperties(devServer)
    || !hook || !hookName || !middlewareBinding || !major || !hookInfo
    || !operationMatchesNode(
      hookOperation,
      ['webpack-transport-hook', hookName, middlewareBinding],
      hook,
      legacyHookFingerprint,
      Boolean(exactGeneratedHook),
    )) {
    return { ok: false, code: source, operations: [], errorCode: 'INTEGRATION_STATE_CONFLICT' };
  }
  if (hookOperation.ownership === 'created') {
    if (hookOperation.details?.action === 'wrapped-static-hook') {
      if (!removeWrappedWdsHook(hookInfo, major, middlewareBinding)) {
        return { ok: false, code: source, operations: [], errorCode: 'INTEGRATION_STATE_CONFLICT' };
      }
    } else {
      const properties = devServer.properties as AstNode[];
      properties.splice(properties.indexOf(hook), 1);
    }
  }
  if (hookOperation.details?.devServerOwnership === 'created'
    && (devServer.properties as AstNode[]).length === 0) {
    const properties = config.properties as AstNode[];
    const devServerProperty = findProperty(config, 'devServer');
    if (devServerProperty) {
      properties.splice(properties.indexOf(devServerProperty), 1);
    }
  }

  for (const operation of operations.filter((item) => item.kind === 'import')) {
    const exported = operation.details?.exported;
    const binding = operation.details?.binding;
    const matches = exported && binding
      ? findNamedBindings(body, exported).filter((item) => item.binding === binding)
      : [];
    const bindingNode = matches[0]?.node;
    if (!exported || !binding || matches.length !== 1 || !bindingNode
      || !operationMatchesNode(
        operation,
        ['webpack-import', exported, binding],
        bindingNode,
        legacyImportFingerprint(exported, binding),
        exactGeneratedImportNode(bindingNode, exported, binding),
      )) {
      return { ok: false, code: source, operations: [], errorCode: 'INTEGRATION_STATE_CONFLICT' };
    }
    if (operation.ownership === 'created'
      && !removeNamedBinding(body, exported, binding)) {
      return { ok: false, code: source, operations: [], errorCode: 'INTEGRATION_STATE_CONFLICT' };
    }
  }
  return {
    ok: true,
    code: printProgram(ast, source),
    operations: [...operations],
  };
}
