import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';

import { isLoopbackAddress } from './session';

export type BrowserAccessMode = 'loopback' | 'same-machine';

export interface BrowserAddressSnapshot {
  readonly addresses: readonly string[];
}

export interface BrowserAddressSnapshotOptions {
  readonly addresses?: readonly string[];
  readonly networkInterfaces?: () => {
    readonly [interfaceName: string]: readonly { readonly address: string }[] | undefined;
  };
}

export type BrowserAddressAuthorization =
  | {
    readonly allowed: true;
    readonly normalizedAddress: string;
    readonly loopback: boolean;
  }
  | {
    readonly allowed: false;
  };

export interface BrowserAddressPolicy {
  readonly mode: BrowserAccessMode;
  readonly snapshot: BrowserAddressSnapshot;
  authorize(remoteAddress: string | null | undefined): BrowserAddressAuthorization;
}

export interface BrowserAddressPolicyOptions {
  readonly mode: BrowserAccessMode;
  readonly snapshot?: BrowserAddressSnapshot;
}

export interface BrowserOriginAuthorizationOptions {
  readonly mode: BrowserAccessMode;
  readonly normalizedRemoteAddress: string;
  readonly remoteAddressLoopback: boolean;
  readonly origin: string;
  readonly allowedOrigins: readonly string[];
}

const REJECTED_ADDRESS_AUTHORIZATION: BrowserAddressAuthorization = Object.freeze({
  allowed: false
});

function createFrozenSnapshot(addresses: readonly string[]): BrowserAddressSnapshot {
  return Object.freeze({
    addresses: Object.freeze([...addresses])
  });
}

const EMPTY_BROWSER_ADDRESS_SNAPSHOT = createFrozenSnapshot([]);

function normalizeIPv4Address(value: string): string | null {
  if (isIP(value) !== 4) {
    return null;
  }
  const octets = value.split('.');
  if (octets.length !== 4) {
    return null;
  }
  const normalizedOctets: string[] = [];
  for (const octet of octets) {
    if (!/^\d+$/.test(octet)) {
      return null;
    }
    const numericOctet = Number(octet);
    if (!Number.isInteger(numericOctet) || numericOctet < 0 || numericOctet > 255) {
      return null;
    }
    normalizedOctets.push(String(numericOctet));
  }
  return normalizedOctets.join('.');
}

function parseIPv6Words(value: string): readonly number[] | null {
  const compressedParts = value.split('::');
  if (compressedParts.length > 2) {
    return null;
  }
  const hasCompression = compressedParts.length === 2;
  const leadingGroups = compressedParts[0]
    ? compressedParts[0].split(':')
    : [];
  const trailingGroups = hasCompression && compressedParts[1]
    ? compressedParts[1].split(':')
    : [];
  const groups = [...leadingGroups, ...trailingGroups];
  const words: number[] = [];
  let leadingWordCount = 0;

  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const group = groups[groupIndex];
    if (group === undefined || group.length === 0) {
      return null;
    }
    if (group.includes('.')) {
      if (groupIndex !== groups.length - 1) {
        return null;
      }
      const normalizedIPv4 = normalizeIPv4Address(group);
      if (normalizedIPv4 === null) {
        return null;
      }
      const octets = normalizedIPv4.split('.').map(Number);
      const firstOctet = octets[0];
      const secondOctet = octets[1];
      const thirdOctet = octets[2];
      const fourthOctet = octets[3];
      if (
        firstOctet === undefined
        || secondOctet === undefined
        || thirdOctet === undefined
        || fourthOctet === undefined
      ) {
        return null;
      }
      words.push(firstOctet * 256 + secondOctet, thirdOctet * 256 + fourthOctet);
    } else {
      if (!/^[\da-fA-F]{1,4}$/.test(group)) {
        return null;
      }
      words.push(Number.parseInt(group, 16));
    }
    if (groupIndex < leadingGroups.length) {
      leadingWordCount = words.length;
    }
  }

  if (!hasCompression) {
    return words.length === 8 ? words : null;
  }
  const missingWordCount = 8 - words.length;
  if (missingWordCount < 1) {
    return null;
  }
  return [
    ...words.slice(0, leadingWordCount),
    ...new Array<number>(missingWordCount).fill(0),
    ...words.slice(leadingWordCount)
  ];
}

function formatIPv6Words(words: readonly number[]): string {
  let longestZeroStart = -1;
  let longestZeroLength = 0;
  let currentZeroStart = -1;

  for (let wordIndex = 0; wordIndex <= words.length; wordIndex += 1) {
    if (wordIndex < words.length && words[wordIndex] === 0) {
      if (currentZeroStart === -1) {
        currentZeroStart = wordIndex;
      }
      continue;
    }
    if (currentZeroStart !== -1) {
      const currentZeroLength = wordIndex - currentZeroStart;
      if (currentZeroLength >= 2 && currentZeroLength > longestZeroLength) {
        longestZeroStart = currentZeroStart;
        longestZeroLength = currentZeroLength;
      }
      currentZeroStart = -1;
    }
  }

  const groups = words.map((word) => word.toString(16));
  if (longestZeroStart === -1) {
    return groups.join(':');
  }
  const leading = groups.slice(0, longestZeroStart).join(':');
  const trailing = groups.slice(longestZeroStart + longestZeroLength).join(':');
  if (!leading) {
    return `::${trailing}`;
  }
  if (!trailing) {
    return `${leading}::`;
  }
  return `${leading}::${trailing}`;
}

function isExcludedIPv4Address(value: string): boolean {
  const octets = value.split('.').map(Number);
  const firstOctet = octets[0];
  if (firstOctet === undefined) {
    return true;
  }
  return value === '0.0.0.0' || (firstOctet >= 224 && firstOctet <= 239);
}

function isIPv4MappedIPv6(words: readonly number[]): boolean {
  return words.length === 8
    && words[0] === 0
    && words[1] === 0
    && words[2] === 0
    && words[3] === 0
    && words[4] === 0
    && words[5] === 0xffff;
}

function formatMappedIPv4Address(words: readonly number[]): string | null {
  const firstWord = words[6];
  const secondWord = words[7];
  if (firstWord === undefined || secondWord === undefined) {
    return null;
  }
  return [
    firstWord >>> 8,
    firstWord & 0xff,
    secondWord >>> 8,
    secondWord & 0xff
  ].join('.');
}

/** 将 socket 地址收敛为可比较的字面量 IP，排除未指定和多播地址。 */
export function normalizeBrowserAddress(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || /\s/.test(value)) {
    return null;
  }

  const zoneIndex = value.indexOf('%');
  const addressWithoutZone = zoneIndex === -1 ? value : value.slice(0, zoneIndex);
  if (
    zoneIndex !== -1
    && (
      value.indexOf('%', zoneIndex + 1) !== -1
      || zoneIndex === value.length - 1
      || isIP(addressWithoutZone) !== 6
    )
  ) {
    return null;
  }

  const addressFamily = isIP(addressWithoutZone);
  if (addressFamily === 4) {
    if (zoneIndex !== -1) {
      return null;
    }
    const normalizedIPv4 = normalizeIPv4Address(addressWithoutZone);
    return normalizedIPv4 === null || isExcludedIPv4Address(normalizedIPv4)
      ? null
      : normalizedIPv4;
  }
  if (addressFamily !== 6) {
    return null;
  }

  const words = parseIPv6Words(addressWithoutZone);
  if (words === null || words.length !== 8) {
    return null;
  }
  if (isIPv4MappedIPv6(words)) {
    const normalizedMappedIPv4 = formatMappedIPv4Address(words);
    return normalizedMappedIPv4 === null || isExcludedIPv4Address(normalizedMappedIPv4)
      ? null
      : normalizedMappedIPv4;
  }
  if (words.every((word) => word === 0) || (words[0] !== undefined && (words[0] & 0xff00) === 0xff00)) {
    return null;
  }
  return formatIPv6Words(words);
}

/** 快照只在调用时读取一次系统接口，生命周期内不会扩展。 */
export function createBrowserAddressSnapshot(
  options: BrowserAddressSnapshotOptions = {}
): BrowserAddressSnapshot {
  const addressInputs = options.addresses ?? Object.values(
    options.networkInterfaces ? options.networkInterfaces() : networkInterfaces()
  ).flatMap((entries) => entries?.map((entry) => entry.address) ?? []);
  const normalizedAddresses = new Set<string>();
  for (const address of addressInputs) {
    const normalizedAddress = normalizeBrowserAddress(address);
    if (normalizedAddress !== null) {
      normalizedAddresses.add(normalizedAddress);
    }
  }
  return createFrozenSnapshot([...normalizedAddresses].sort());
}

function createAllowedAddressAuthorization(
  normalizedAddress: string,
  loopback: boolean
): BrowserAddressAuthorization {
  return Object.freeze({
    allowed: true,
    normalizedAddress,
    loopback
  });
}

export function createBrowserAddressPolicy(
  options: BrowserAddressPolicyOptions
): BrowserAddressPolicy {
  const mode = options.mode;
  if (mode !== 'loopback' && mode !== 'same-machine') {
    throw new Error('INVALID_BROWSER_ACCESS_MODE');
  }
  const snapshot = options.snapshot ?? EMPTY_BROWSER_ADDRESS_SNAPSHOT;
  const snapshotAddresses = new Set(snapshot.addresses);
  return Object.freeze({
    mode,
    snapshot,
    authorize(remoteAddress: string | null | undefined): BrowserAddressAuthorization {
      const normalizedAddress = normalizeBrowserAddress(remoteAddress);
      if (normalizedAddress === null) {
        return REJECTED_ADDRESS_AUTHORIZATION;
      }
      const loopback = isLoopbackAddress(normalizedAddress);
      if (loopback || (mode === 'same-machine' && snapshotAddresses.has(normalizedAddress))) {
        return createAllowedAddressAuthorization(normalizedAddress, loopback);
      }
      return REJECTED_ADDRESS_AUTHORIZATION;
    }
  });
}

/** Origin 必须同时保留服务端 allowlist 和 socket 地址的精确绑定。 */
export function isBrowserOriginAuthorized(
  options: BrowserOriginAuthorizationOptions
): boolean {
  if (options.mode !== 'loopback' && options.mode !== 'same-machine') {
    return false;
  }
  const normalizedRemoteAddress = normalizeBrowserAddress(options.normalizedRemoteAddress);
  if (normalizedRemoteAddress === null || normalizedRemoteAddress !== options.normalizedRemoteAddress) {
    return false;
  }
  if (options.remoteAddressLoopback !== isLoopbackAddress(normalizedRemoteAddress)) {
    return false;
  }

  let url: URL;
  try {
    url = new URL(options.origin);
  } catch {
    return false;
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.origin !== options.origin
    || !options.allowedOrigins.includes(options.origin)
  ) {
    return false;
  }
  if (options.remoteAddressLoopback) {
    return true;
  }
  if (options.mode !== 'same-machine') {
    return false;
  }

  const hostname = url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname;
  return normalizeBrowserAddress(hostname) === normalizedRemoteAddress;
}
