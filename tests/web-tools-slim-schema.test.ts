import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSearchTool } from '../src/tools/web-search-tool';
import { ReadPageTool } from '../src/tools/read-page-tool';
import { assertFetchableHttpUrl, resolveSearchProviders } from '../src/utils/web-content';
import { parseProxyEndpoint, systemProxyToHttpEndpoint } from '../src/utils/system-proxy';

test('web_search exposes a compact schema without manual proxy parameters', () => {
  const tool = new WebSearchTool();
  const properties = tool.definition.parameters.properties as Record<string, unknown>;

  assert.deepEqual(Object.keys(properties).sort(), [
    'allowed_domains',
    'freshness',
    'limit',
    'query',
  ]);
  assert.equal('proxy_host' in properties, false);
  assert.equal('domain_allowlist' in properties, false);
});

test('read_page exposes a compact schema without extract modes or manual proxy parameters', () => {
  const tool = new ReadPageTool();
  const properties = tool.definition.parameters.properties as Record<string, unknown>;

  assert.deepEqual(Object.keys(properties).sort(), [
    'find',
    'max_chars',
    'url',
  ]);
  assert.equal('extract_mode' in properties, false);
  assert.equal('proxy_host' in properties, false);
});

test('web content fetch rejects obvious local and private hosts', () => {
  assert.throws(() => assertFetchableHttpUrl('http://localhost:3000'), /local or private host/);
  assert.throws(() => assertFetchableHttpUrl('http://127.0.0.1'), /local or private host/);
  assert.throws(() => assertFetchableHttpUrl('http://192.168.1.10'), /local or private host/);
  assert.doesNotThrow(() => assertFetchableHttpUrl('https://example.com/docs'));
});

test('system proxy endpoints support http proxies and ignore socks for web fallback', () => {
  const http = parseProxyEndpoint('http://127.0.0.1:7890');
  assert.deepEqual(http, { host: '127.0.0.1', port: 7890, scheme: 'http' });
  assert.deepEqual(systemProxyToHttpEndpoint({
    enabled: true,
    source: 'linux_environment',
    platform: 'linux',
    host: '127.0.0.1',
    port: 7890,
    scheme_guess: 'http',
  }), {
    host: '127.0.0.1',
    port: 7890,
    scheme: 'http',
    source: 'linux_environment',
  });
  assert.equal(systemProxyToHttpEndpoint({
    enabled: true,
    source: 'linux_environment',
    platform: 'linux',
    host: '127.0.0.1',
    port: 1080,
    scheme_guess: 'socks5',
  }), null);
});

test('web search providers default to bing and duckduckgo with optional google and baidu', () => {
  assert.deepEqual(resolveSearchProviders(''), ['bing', 'duckduckgo']);
  assert.deepEqual(resolveSearchProviders('google, baidu, bing, nope, google'), ['google', 'baidu', 'bing']);
  assert.deepEqual(resolveSearchProviders('nope'), ['bing', 'duckduckgo']);
});
