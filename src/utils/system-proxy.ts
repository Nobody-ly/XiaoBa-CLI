import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type SystemProxySource =
  | 'windows_internet_settings'
  | 'macos_scutil_proxy'
  | 'linux_environment'
  | 'linux_gsettings'
  | 'linux_kde_config'
  | 'none';

export type ProxyScheme = 'http' | 'https' | 'socks5';
export type SupportedProxyScheme = 'http' | 'https';

export interface SystemProxyResolution {
  enabled: boolean;
  source: SystemProxySource;
  platform: string;
  proxy_server?: string;
  host?: string;
  port?: number;
  scheme_guess?: ProxyScheme;
  auto_config_url?: string;
  auto_detect?: boolean;
  bypass?: string;
}

export interface HttpProxyEndpoint {
  host: string;
  port: number;
  scheme: SupportedProxyScheme;
  source: SystemProxySource;
}

const WINDOWS_INTERNET_SETTINGS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

export function resolveSystemProxy(env: NodeJS.ProcessEnv = process.env): SystemProxyResolution {
  if (process.platform === 'win32') return resolveWindowsProxy();
  if (process.platform === 'darwin') return resolveMacProxy();
  if (process.platform === 'linux') return resolveLinuxProxy(env);
  return {
    enabled: false,
    source: 'none',
    platform: process.platform,
  };
}

export function systemProxyToHttpEndpoint(
  resolution: SystemProxyResolution = resolveSystemProxy(),
): HttpProxyEndpoint | null {
  if (!resolution.enabled || !resolution.host || !resolution.port) return null;
  if (resolution.scheme_guess === 'socks5') return null;
  return {
    host: resolution.host,
    port: resolution.port,
    scheme: resolution.scheme_guess === 'https' ? 'https' : 'http',
    source: resolution.source,
  };
}

function resolveWindowsProxy(): SystemProxyResolution {
  try {
    const proxyEnable = queryRegistryValue('ProxyEnable');
    const proxyServer = queryRegistryValue('ProxyServer').trim();
    const proxyOverride = queryRegistryValue('ProxyOverride').trim();
    const autoConfigUrl = queryRegistryValue('AutoConfigURL').trim();
    const autoDetectRaw = queryRegistryValue('AutoDetect').trim();

    const enabled = Number(proxyEnable) === 1;
    const autoDetect = Number(autoDetectRaw) === 1;
    const endpoint = parseProxyEndpoint(proxyServer);

    return {
      enabled,
      source: 'windows_internet_settings',
      platform: process.platform,
      ...(proxyServer ? { proxy_server: proxyServer } : {}),
      ...(endpoint?.host ? { host: endpoint.host } : {}),
      ...(typeof endpoint?.port === 'number' ? { port: endpoint.port } : {}),
      ...(endpoint?.scheme ? { scheme_guess: endpoint.scheme } : {}),
      ...(autoConfigUrl ? { auto_config_url: autoConfigUrl } : {}),
      auto_detect: autoDetect,
      ...(proxyOverride ? { bypass: proxyOverride } : {}),
    };
  } catch {
    return disabled('windows_internet_settings');
  }
}

function resolveMacProxy(): SystemProxyResolution {
  try {
    const output = execFileSync('scutil', ['--proxy'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const values = parseKeyValueOutput(output);
    const httpEnabled = values.HTTPEnable === '1';
    const httpsEnabled = values.HTTPSEnable === '1';
    const socksEnabled = values.SOCKSEnable === '1';
    const autoConfigUrl = values.ProxyAutoConfigURLString || '';
    const autoConfigEnabled = values.ProxyAutoConfigEnable === '1';

    const endpoint = httpsEnabled
      ? endpointFromParts(values.HTTPSProxy, values.HTTPSPort, 'http')
      : httpEnabled
        ? endpointFromParts(values.HTTPProxy, values.HTTPPort, 'http')
        : socksEnabled
          ? endpointFromParts(values.SOCKSProxy, values.SOCKSPort, 'socks5')
          : null;

    return {
      enabled: Boolean(endpoint || autoConfigEnabled || autoConfigUrl),
      source: 'macos_scutil_proxy',
      platform: process.platform,
      ...(endpoint ? { proxy_server: `${endpoint.scheme}://${endpoint.host}:${endpoint.port}` } : {}),
      ...(endpoint ? { host: endpoint.host, port: endpoint.port, scheme_guess: endpoint.scheme } : {}),
      ...(autoConfigUrl ? { auto_config_url: autoConfigUrl } : {}),
      auto_detect: autoConfigEnabled,
      ...(values.ExceptionsList ? { bypass: values.ExceptionsList } : {}),
    };
  } catch {
    return disabled('macos_scutil_proxy');
  }
}

function resolveLinuxProxy(env: NodeJS.ProcessEnv): SystemProxyResolution {
  const fromEnv = resolveLinuxEnvironmentProxy(env);
  if (fromEnv.enabled) return fromEnv;

  const fromGsettings = resolveLinuxGsettingsProxy();
  if (fromGsettings.enabled) return fromGsettings;

  const fromKde = resolveLinuxKdeProxy();
  if (fromKde.enabled) return fromKde;

  return disabled('none');
}

function resolveLinuxEnvironmentProxy(env: NodeJS.ProcessEnv): SystemProxyResolution {
  const raw = env.HTTPS_PROXY || env.https_proxy
    || env.HTTP_PROXY || env.http_proxy
    || env.ALL_PROXY || env.all_proxy
    || '';
  const endpoint = parseProxyEndpoint(raw);
  if (!endpoint) return disabled('linux_environment');
  const bypass = env.NO_PROXY || env.no_proxy || '';
  return {
    enabled: true,
    source: 'linux_environment',
    platform: process.platform,
    proxy_server: raw,
    host: endpoint.host,
    port: endpoint.port,
    scheme_guess: endpoint.scheme,
    ...(bypass ? { bypass } : {}),
  };
}

function resolveLinuxGsettingsProxy(): SystemProxyResolution {
  try {
    const mode = unquote(execFileSync('gsettings', ['get', 'org.gnome.system.proxy', 'mode'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim());
    if (mode === 'auto') {
      const autoConfigUrl = unquote(execFileSync('gsettings', ['get', 'org.gnome.system.proxy', 'autoconfig-url'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim());
      return {
        enabled: Boolean(autoConfigUrl),
        source: 'linux_gsettings',
        platform: process.platform,
        ...(autoConfigUrl ? { auto_config_url: autoConfigUrl } : {}),
        auto_detect: Boolean(autoConfigUrl),
      };
    }
    if (mode !== 'manual') return disabled('linux_gsettings');

    const httpsHost = unquote(gsettingsGet('org.gnome.system.proxy.https', 'host'));
    const httpsPort = gsettingsGet('org.gnome.system.proxy.https', 'port');
    const httpHost = unquote(gsettingsGet('org.gnome.system.proxy.http', 'host'));
    const httpPort = gsettingsGet('org.gnome.system.proxy.http', 'port');
    const socksHost = unquote(gsettingsGet('org.gnome.system.proxy.socks', 'host'));
    const socksPort = gsettingsGet('org.gnome.system.proxy.socks', 'port');
    const endpoint = endpointFromParts(httpsHost, httpsPort, 'http')
      || endpointFromParts(httpHost, httpPort, 'http')
      || endpointFromParts(socksHost, socksPort, 'socks5');
    if (!endpoint) return disabled('linux_gsettings');
    return {
      enabled: true,
      source: 'linux_gsettings',
      platform: process.platform,
      proxy_server: `${endpoint.scheme}://${endpoint.host}:${endpoint.port}`,
      host: endpoint.host,
      port: endpoint.port,
      scheme_guess: endpoint.scheme,
    };
  } catch {
    return disabled('linux_gsettings');
  }
}

function resolveLinuxKdeProxy(): SystemProxyResolution {
  try {
    const filePath = path.join(os.homedir(), '.config', 'kioslaverc');
    if (!fs.existsSync(filePath)) return disabled('linux_kde_config');
    const content = fs.readFileSync(filePath, 'utf8');
    const values = parseIniSection(content, 'Proxy Settings');
    const proxyType = values.ProxyType || values.proxyType || '';
    if (!proxyType || proxyType === '0') return disabled('linux_kde_config');
    const raw = values.httpsProxy || values.httpProxy || values.socksProxy || '';
    const endpoint = parseProxyEndpoint(raw);
    if (!endpoint) return disabled('linux_kde_config');
    return {
      enabled: true,
      source: 'linux_kde_config',
      platform: process.platform,
      proxy_server: raw,
      host: endpoint.host,
      port: endpoint.port,
      scheme_guess: endpoint.scheme,
      ...(values.NoProxyFor ? { bypass: values.NoProxyFor } : {}),
    };
  } catch {
    return disabled('linux_kde_config');
  }
}

function queryRegistryValue(valueName: string): string {
  try {
    const output = execFileSync('reg.exe', ['query', WINDOWS_INTERNET_SETTINGS_KEY, '/v', valueName], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseRegistryQueryValue(output, valueName);
  } catch {
    return '';
  }
}

export function parseRegistryQueryValue(output: string, valueName: string): string {
  const lines = String(output || '').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || !line.toLowerCase().startsWith(valueName.toLowerCase())) continue;
    const parts = line.split(/\s{2,}/).filter(Boolean);
    if (parts.length >= 3) return parts.slice(2).join(' ').trim();
  }
  return '';
}

export function parseProxyEndpoint(input: string): { host: string; port: number; scheme: ProxyScheme } | null {
  const value = String(input || '').trim();
  if (!value) return null;

  const firstSegment = value
    .split(';')
    .map(item => item.trim())
    .filter(Boolean)
    .map(item => item.includes('=') ? item.slice(item.indexOf('=') + 1).trim() : item)[0];

  if (!firstSegment) return null;

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(firstSegment)
    ? firstSegment
    : `http://${firstSegment}`;

  try {
    const url = new URL(withScheme);
    const protocol = url.protocol.replace(/:$/, '').toLowerCase();
    const scheme: ProxyScheme = protocol === 'socks5' || protocol === 'socks'
      ? 'socks5'
      : protocol === 'https'
        ? 'https'
        : 'http';
    const port = url.port ? Number(url.port) : defaultProxyPort(scheme);
    if (!url.hostname || !Number.isFinite(port)) return null;
    return {
      host: url.hostname,
      port,
      scheme,
    };
  } catch {
    const match = firstSegment.match(/^([^:]+):(\d{1,5})$/);
    if (!match) return null;
    return {
      host: match[1],
      port: Number(match[2]),
      scheme: 'http',
    };
  }
}

function endpointFromParts(hostValue: string | undefined, portValue: string | undefined, scheme: ProxyScheme) {
  const host = String(hostValue || '').trim();
  const port = Number(String(portValue || '').trim());
  if (!host || !Number.isFinite(port) || port < 1 || port > 65535) return null;
  return { host, port: Math.floor(port), scheme };
}

function parseKeyValueOutput(output: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = line.match(/^\s*([^:]+?)\s*:\s*(.*?)\s*$/);
    if (match) values[match[1].trim()] = match[2].trim();
  }
  return values;
}

function parseIniSection(content: string, sectionName: string): Record<string, string> {
  const values: Record<string, string> = {};
  let inSection = false;
  for (const rawLine of String(content || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const section = line.match(/^\[(.+)]$/);
    if (section) {
      inSection = section[1] === sectionName;
      continue;
    }
    if (!inSection) continue;
    const index = line.indexOf('=');
    if (index === -1) continue;
    values[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return values;
}

function gsettingsGet(schema: string, key: string): string {
  return execFileSync('gsettings', ['get', schema, key], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function unquote(value: string): string {
  return String(value || '').trim().replace(/^['"]|['"]$/g, '');
}

function defaultProxyPort(scheme: ProxyScheme): number {
  if (scheme === 'https') return 443;
  if (scheme === 'socks5') return 1080;
  return 80;
}

function disabled(source: SystemProxySource): SystemProxyResolution {
  return {
    enabled: false,
    source,
    platform: process.platform,
  };
}
