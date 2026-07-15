import { describe, expect, it } from 'vitest';

import {
  classifyVueFamily,
  classifyWebpackDevServer,
  evaluateRawWebpackOrigin,
  evaluateToolchainCompatibility,
  evaluateVueCompilerCompatibility,
  evaluateWebpackCompatibility,
  evaluatePeerRange,
  parseStrictSemVer,
  satisfiesStrictSemVerRange,
  type PackageCompatibilityFact,
} from './index.js';

function packageFact(
  name: string,
  version: string,
  peerDependencies: Record<string, string> = {},
): PackageCompatibilityFact {
  return { name, version, peerDependencies };
}

describe('toolchain compatibility', () => {
  it('只接受完整严格 SemVer，并保留 peer prerelease 规则', () => {
    expect(parseStrictSemVer('3.5.0-beta.1+build.7')).toMatchObject({
      major: 3,
      minor: 5,
      patch: 0,
      prerelease: ['beta', 1],
      build: ['build', '7'],
    });
    expect(parseStrictSemVer('v3.5.0')).toBeUndefined();
    expect(parseStrictSemVer('3.5')).toBeUndefined();
    expect(parseStrictSemVer(' 3.5.0')).toBeUndefined();
    expect(satisfiesStrictSemVerRange('3.5.0-beta.1', '>=3.2.0 <4.0.0')).toBe(false);
    expect(evaluatePeerRange('>=3.5.0-0 <3.6.0-0', '3.5.0-beta.1').status).toBe('satisfied');
  });

  it('冻结 Vue 和 webpack-dev-server 支持边界', () => {
    expect(classifyVueFamily('2.6.14')).toMatchObject({ status: 'supported', family: 'vue2.6' });
    expect(classifyVueFamily('2.7.16')).toMatchObject({ status: 'supported', family: 'vue2.7' });
    expect(classifyVueFamily('3.2.0')).toMatchObject({ status: 'supported', family: 'vue3' });
    expect(classifyVueFamily('2.8.0').status).toBe('unsupported');
    expect(classifyVueFamily('3.1.9').status).toBe('unsupported');
    expect(classifyVueFamily('4.0.0').status).toBe('unsupported');

    expect(classifyWebpackDevServer('3.11.3')).toMatchObject({ status: 'supported', family: 'wds3' });
    expect(classifyWebpackDevServer('4.6.1').status).toBe('unsupported');
    expect(classifyWebpackDevServer('4.7.0')).toMatchObject({ status: 'supported', family: 'wds4' });
    expect(classifyWebpackDevServer('5.0.0').status).toBe('unsupported');
  });

  it('要求 Vue compiler 与实际 Vue 完整版本一致，并在 Vue 本身不支持时停止级联', () => {
    const mismatch = evaluateVueCompilerCompatibility({
      vue: packageFact('vue', '3.5.0'),
      vueCompilerSfc: packageFact('@vue/compiler-sfc', '3.5.0'),
      vueCompilerDom: packageFact('@vue/compiler-dom', '3.5.1'),
    });
    expect(mismatch).toContainEqual(expect.objectContaining({
      code: 'VUE_COMPILER_VERSION_MISMATCH',
      subject: '@vue/compiler-dom',
      required: '3.5.0',
    }));

    expect(evaluateVueCompilerCompatibility({
      vue: packageFact('vue', '3.1.9'),
    })).toEqual([]);
  });

  it('校验 vue-loader 的 webpack peer，并以主版本映射约束 Vue family', () => {
    const mismatch = evaluateWebpackCompatibility({
      vue: packageFact('vue', '3.5.0'),
      webpack: packageFact('webpack', '5.98.0'),
      vueLoader: packageFact('vue-loader', '17.4.2', {
        webpack: '^4.0.0',
      }),
    });

    expect(mismatch).toContainEqual(expect.objectContaining({
      code: 'PEER_DEPENDENCY_VERSION_MISMATCH',
      subject: 'vue-loader peerDependencies.webpack',
    }));

    expect(evaluateWebpackCompatibility({
      vue: packageFact('vue', '3.5.0'),
      webpack: packageFact('webpack', '5.98.0'),
      // 官方 vue-loader 17 不声明 Vue peer，Vue family 由 16/17 主版本映射保证。
      vueLoader: packageFact('vue-loader', '17.4.2', {
        webpack: '^4.1.0 || ^5.0.0-0',
      }),
    })).toEqual([]);
  });

  it('对 raw watch 保持 HTTP exact Origin 边界', () => {
    expect(evaluateRawWebpackOrigin('http://127.0.0.1:8080')).toEqual([]);
    expect(evaluateRawWebpackOrigin('https://127.0.0.1:8080')).toContainEqual(
      expect.objectContaining({ code: 'RAW_WATCH_HTTPS_UNSUPPORTED' }),
    );
    expect(evaluateRawWebpackOrigin('http://127.0.0.1:8080/path')).toContainEqual(
      expect.objectContaining({ code: 'RAW_WATCH_ORIGIN_INVALID' }),
    );
  });

  it('按固定顺序输出诊断，且不泄漏误传的绝对路径', () => {
    const issues = evaluateToolchainCompatibility({
      node: { nodeVersion: '16.20.1' },
      packageManager: 'bun',
      vue: packageFact('vue', 'C:\\Users\\developer\\workspace\\vue'),
      bundler: 'vite',
      vite: packageFact('vite', '2.8.0'),
      webpackTransport: 'raw-watch',
      rawWebpackOrigin: 'https://127.0.0.1:8080',
    });

    expect(issues.map((issue) => issue.stage)).toEqual([
      'node',
      'package-manager',
      'vue',
      'bundler',
      'transport',
    ]);
    expect(JSON.stringify(issues)).not.toContain('C:\\Users\\developer');
    expect(issues).toContainEqual(expect.objectContaining({
      code: 'VUE_VERSION_INVALID',
      detected: 'invalid',
    }));
  });
});
