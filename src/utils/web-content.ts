import axios, { AxiosRequestConfig } from 'axios';
import { URL } from 'url';
import { HttpProxyEndpoint, resolveSystemProxy, systemProxyToHttpEndpoint } from './system-proxy';

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; XiaoBaCLI/1.0; +https://github.com/buildsense-ai/XiaoBa-CLI)';
const MAX_HTML_BYTES = 1_000_000;
const MAX_REDIRECTS = 5;
const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;
const PAGE_CACHE_TTL_MS = 10 * 60 * 1000;

export type SearchFreshness = 'any' | 'day' | 'week' | 'month' | 'year';
export type SearchProvider = 'bing' | 'duckduckgo' | 'baidu' | 'google';

const SEARCH_PROVIDER_VALUES: SearchProvider[] = ['bing', 'duckduckgo', 'baidu', 'google'];
const DEFAULT_SEARCH_PROVIDERS: SearchProvider[] = ['bing', 'duckduckgo'];

export interface WebSearchItem {
  title: string;
  url: string;
  snippet?: string;
}

export interface WebSearchResponse {
  query: string;
  provider: SearchProvider | null;
  via_proxy: boolean;
  results: WebSearchItem[];
}

export interface ReadPageFindHit {
  text: string;
}

export interface ReadPageResponse {
  url: string;
  final_url: string;
  title: string;
  site_name: string;
  summary: string;
  text: string;
  find_hits?: ReadPageFindHit[];
  truncated?: boolean;
}

export interface SearchWebOptions {
  query: string;
  limit: number;
  freshness: SearchFreshness;
  allowedDomains?: string[];
  timeoutMs?: number;
}

export interface ReadWebPageOptions {
  url: string;
  find?: string;
  maxChars: number;
  timeoutMs?: number;
}

interface SearchProviderRequest {
  query: string;
  limit: number;
  freshness: SearchFreshness;
  allowedDomains: string[];
  timeoutMs?: number;
}

type TextResponse = {
  text: string;
  finalUrl: string;
  headers: Record<string, any>;
  viaProxy: boolean;
};

const searchCache = new Map<string, { expiresAt: number; value: WebSearchResponse }>();
const pageCache = new Map<string, { expiresAt: number; value: ReadPageResponse }>();

export async function searchWeb(options: SearchWebOptions): Promise<WebSearchResponse> {
  const limit = clamp(options.limit, 1, 10);
  const freshness = normalizeFreshness(options.freshness);
  const allowedDomains = normalizeDomains(options.allowedDomains);
  const query = options.query.trim();
  const providers = resolveSearchProviders();
  const cacheKey = JSON.stringify(['search', providers, query, allowedDomains, freshness, limit]);
  const cached = getCached(searchCache, cacheKey);
  if (cached) return cached;

  let lastError: unknown;
  let sawEmptyResult = false;
  for (const provider of providers) {
    try {
      const result = await searchWithProvider(provider, {
        query,
        limit,
        freshness,
        allowedDomains,
        timeoutMs: options.timeoutMs,
      });
      if (result.results.length > 0) {
        setCached(searchCache, cacheKey, result, SEARCH_CACHE_TTL_MS);
        return result;
      }
      sawEmptyResult = true;
    } catch (error) {
      lastError = error;
    }
  }

  if (sawEmptyResult) {
    const empty = { query, provider: null, via_proxy: false, results: [] };
    setCached(searchCache, cacheKey, empty, SEARCH_CACHE_TTL_MS);
    return empty;
  }

  throw lastError || new Error('All configured search providers failed');
}

export async function readWebPage(options: ReadWebPageOptions): Promise<ReadPageResponse> {
  const maxChars = clamp(options.maxChars, 500, 12_000);
  const cacheKey = JSON.stringify(['page', options.url, options.find || '', maxChars]);
  const cached = getCached(pageCache, cacheKey);
  if (cached) return cached;

  const response = await requestText(options.url, {
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    responseType: 'text',
    headers: {
      'User-Agent': DEFAULT_USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    transformResponse: [(data) => typeof data === 'string' ? trimToBytes(data, MAX_HTML_BYTES) : ''],
    validateStatus: (status) => status >= 200 && status < 400,
  });

  const contentType = String(response.headers['content-type'] || '');
  const raw = response.text;
  const isHtml = /html|xml/i.test(contentType) || /<html[\s>]/i.test(raw);
  const title = isHtml ? extractTitle(raw) : safeHostname(response.finalUrl) || response.finalUrl;
  const siteName = isHtml ? extractSiteName(raw, response.finalUrl) : (safeHostname(response.finalUrl) || 'unknown');
  const textBody = isHtml ? htmlToText(raw) : normalizeWhitespace(raw);
  const trimmed = truncateAtBoundaryWithFlag(textBody, maxChars);
  const summary = buildSummary(isHtml ? extractDescription(raw) : '', trimmed.text);
  const findHits = buildFindHits(trimmed.text, options.find);
  const value: ReadPageResponse = {
    url: options.url,
    final_url: response.finalUrl,
    title,
    site_name: siteName,
    summary,
    text: trimmed.text,
    ...(findHits.length > 0 ? { find_hits: findHits } : {}),
    ...(trimmed.truncated ? { truncated: true } : {}),
  };
  setCached(pageCache, cacheKey, value, PAGE_CACHE_TTL_MS);
  return value;
}

async function searchWithProvider(
  provider: SearchProvider,
  request: SearchProviderRequest,
): Promise<WebSearchResponse> {
  const effectiveQuery = buildSearchQuery(request.query, request.allowedDomains);
  const searchUrl = buildSearchUrl(provider, effectiveQuery, request.freshness, request.limit);
  const response = await requestText(searchUrl, {
    timeout: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    responseType: 'text',
    headers: {
      'User-Agent': DEFAULT_USER_AGENT,
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    transformResponse: [(data) => typeof data === 'string' ? trimToBytes(data, MAX_HTML_BYTES) : ''],
    validateStatus: (status) => status >= 200 && status < 400,
  });
  const parsed = parseSearchResults(provider, response.text);
  const filtered = filterSearchResultsByDomain(parsed, request.allowedDomains);
  return {
    query: request.query,
    provider,
    via_proxy: response.viaProxy,
    results: filtered.slice(0, request.limit).map(item => ({
      title: item.title,
      url: item.url,
      ...(item.snippet ? { snippet: item.snippet } : {}),
    })),
  };
}

export function resolveSearchProviders(raw = process.env.XIAOBA_WEB_SEARCH_PROVIDERS): SearchProvider[] {
  if (!raw || !raw.trim()) return DEFAULT_SEARCH_PROVIDERS;
  const providers: SearchProvider[] = [];
  const seen = new Set<string>();
  for (const item of raw.split(',')) {
    const provider = item.trim().toLowerCase() as SearchProvider;
    if (!SEARCH_PROVIDER_VALUES.includes(provider) || seen.has(provider)) continue;
    seen.add(provider);
    providers.push(provider);
  }
  return providers.length > 0 ? providers : DEFAULT_SEARCH_PROVIDERS;
}

async function requestText(url: string, baseConfig: AxiosRequestConfig): Promise<TextResponse> {
  assertFetchableHttpUrl(url);
  let directError: unknown;
  try {
    return await requestTextWithRetries(url, baseConfig);
  } catch (error) {
    directError = error;
  }

  const proxy = systemProxyToHttpEndpoint(resolveSystemProxy());
  if (!proxy) throw directError;
  return requestTextWithRetries(url, baseConfig, proxy);
}

async function requestTextWithRetries(
  url: string,
  baseConfig: AxiosRequestConfig,
  proxy?: HttpProxyEndpoint,
): Promise<TextResponse> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await requestTextOnce(url, baseConfig, proxy);
    } catch (error) {
      lastError = error;
      if (!isRetryableNetworkError(error) || attempt === 1) break;
      await delay(250 * (attempt + 1));
    }
  }
  throw lastError;
}

async function requestTextOnce(
  url: string,
  baseConfig: AxiosRequestConfig,
  proxy?: HttpProxyEndpoint,
): Promise<TextResponse> {
  let currentUrl = url;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    assertFetchableHttpUrl(currentUrl);
    const response = await axios.get<string>(currentUrl, buildAxiosRequestConfig(baseConfig, proxy));
    if (isRedirectStatus(response.status)) {
      const location = String(response.headers.location || '');
      if (!location) throw new Error(`Redirect from ${currentUrl} is missing a Location header`);
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    return {
      text: typeof response.data === 'string' ? response.data : '',
      finalUrl: currentUrl,
      headers: response.headers,
      viaProxy: Boolean(proxy),
    };
  }
  throw new Error(`Too many redirects while fetching ${url}`);
}

function buildAxiosRequestConfig(baseConfig: AxiosRequestConfig, proxy?: HttpProxyEndpoint): AxiosRequestConfig {
  return {
    ...baseConfig,
    maxRedirects: 0,
    maxContentLength: MAX_HTML_BYTES,
    ...(proxy ? {
      proxy: {
        protocol: proxy.scheme,
        host: proxy.host,
        port: proxy.port,
      },
    } : {}),
  };
}

export function assertFetchableHttpUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid URL: ${value}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http(s) URLs are supported');
  }
  if (isLocalOrPrivateHostname(parsed.hostname)) {
    throw new Error(`Refusing to fetch local or private host: ${parsed.hostname}`);
  }
  return parsed;
}

function isLocalOrPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (!host || host === 'localhost' || host === '0.0.0.0' || host === '::1' || host.endsWith('.local')) {
    return true;
  }
  if (!host.includes('.') && !host.includes(':')) return true;
  if (isPrivateIpv4(host)) return true;
  if (/^(fc|fd)[0-9a-f]{2}:/i.test(host) || /^fe80:/i.test(host)) return true;
  return false;
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map(part => Number(part));
  if (octets.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = octets;
  return a === 10
    || a === 127
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254);
}

function buildSearchQuery(query: string, allowedDomains: string[]): string {
  if (allowedDomains.length === 0) return query;
  return `(${allowedDomains.map(domain => `site:${domain}`).join(' OR ')}) ${query}`;
}

function buildSearchUrl(provider: SearchProvider, query: string, freshness: SearchFreshness, limit: number): string {
  switch (provider) {
    case 'bing':
      return buildBingSearchUrl(query, limit);
    case 'google':
      return buildGoogleSearchUrl(query, freshness, limit);
    case 'baidu':
      return buildBaiduSearchUrl(query);
    case 'duckduckgo':
    default:
      return buildDuckDuckGoSearchUrl(query, freshness);
  }
}

function parseSearchResults(provider: SearchProvider, html: string): Array<{ title: string; url: string; snippet: string }> {
  switch (provider) {
    case 'bing':
      return parseBingResults(html);
    case 'google':
      return parseGoogleResults(html);
    case 'baidu':
      return parseBaiduResults(html);
    case 'duckduckgo':
    default:
      return parseDuckDuckGoResults(html);
  }
}

function filterSearchResultsByDomain(
  items: Array<{ title: string; url: string; snippet: string }>,
  allowedDomains: string[],
): Array<{ title: string; url: string; snippet: string }> {
  if (allowedDomains.length === 0) return items;
  return items.filter(item => {
    const hostname = safeHostname(item.url);
    return hostname ? allowedDomains.some(domain => hostname === domain || hostname.endsWith(`.${domain}`)) : false;
  });
}

function buildBingSearchUrl(query: string, limit: number): string {
  const url = new URL('https://www.bing.com/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(clamp(limit, 1, 10)));
  return url.toString();
}

function buildGoogleSearchUrl(query: string, freshness: SearchFreshness, limit: number): string {
  const url = new URL('https://www.google.com/search');
  url.searchParams.set('q', query);
  url.searchParams.set('num', String(clamp(limit, 1, 10)));
  const tbs = freshnessToGoogleValue(freshness);
  if (tbs) url.searchParams.set('tbs', tbs);
  return url.toString();
}

function buildBaiduSearchUrl(query: string): string {
  const url = new URL('https://www.baidu.com/s');
  url.searchParams.set('wd', query);
  return url.toString();
}

function buildDuckDuckGoSearchUrl(query: string, freshness: SearchFreshness): string {
  const url = new URL('https://html.duckduckgo.com/html/');
  url.searchParams.set('q', query);
  if (freshness !== 'any') {
    url.searchParams.set('df', freshnessToDuckDuckGoValue(freshness));
  }
  return url.toString();
}

function parseBingResults(html: string): Array<{ title: string; url: string; snippet: string }> {
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  const blockRegex = /<li[^>]+class="[^"]*\bb_algo\b[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  for (const match of html.matchAll(blockRegex)) {
    const block = match[1];
    const linkMatch = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/i)
      || block.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    const url = htmlDecode(linkMatch[1]);
    if (!/^https?:\/\//i.test(url)) continue;
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    results.push({
      title: normalizeWhitespace(htmlDecode(linkMatch[2])),
      url,
      snippet: normalizeWhitespace(htmlDecode(snippetMatch?.[1] || '')),
    });
  }
  return uniqueByUrl(results);
}

function parseGoogleResults(html: string): Array<{ title: string; url: string; snippet: string }> {
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  const anchorRegex = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]{0,1200}?)<\/a>/gi;
  for (const match of html.matchAll(anchorRegex)) {
    const url = decodeGoogleUrl(htmlDecode(match[1]));
    if (!url) continue;
    const titleMatch = match[2].match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
    const title = normalizeWhitespace(htmlDecode(titleMatch?.[1] || match[2]));
    if (!title || /^(cached|similar|translate this page)$/i.test(title)) continue;
    results.push({ title, url, snippet: '' });
  }
  return uniqueByUrl(results);
}

function parseBaiduResults(html: string): Array<{ title: string; url: string; snippet: string }> {
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  const blockRegex = /<div[^>]+class="[^"]*(?:result|c-container)[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]+class="[^"]*(?:result|c-container)|<\/body>)/gi;
  for (const match of html.matchAll(blockRegex)) {
    const block = match[1];
    const linkMatch = block.match(/<h3[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>/i)
      || block.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    const url = htmlDecode(linkMatch[1]);
    if (!/^https?:\/\//i.test(url)) continue;
    const text = normalizeWhitespace(htmlDecode(block.replace(/<h3[\s\S]*?<\/h3>/i, ' ').replace(/<[^>]+>/g, ' ')));
    results.push({
      title: normalizeWhitespace(htmlDecode(linkMatch[2])),
      url,
      snippet: truncateAtBoundary(text, 180),
    });
  }
  return uniqueByUrl(results);
}

function parseDuckDuckGoResults(html: string): Array<{ title: string; url: string; snippet: string }> {
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  const blockRegex = /<div[^>]*class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
  const fallbackRegex = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]{0,1200}?(?:result__snippet[^>]*>([\s\S]*?)<\/a>|result__snippet[^>]*>([\s\S]*?)<\/div>)?/gi;

  for (const match of html.matchAll(blockRegex)) {
    const block = match[1];
    const linkMatch = block.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    const snippetMatch = block.match(/result__snippet[^>]*>([\s\S]*?)<\//i);
    const url = decodeDuckDuckGoUrl(htmlDecode(linkMatch[1]));
    if (!url) continue;
    results.push({
      title: normalizeWhitespace(htmlDecode(linkMatch[2])),
      url,
      snippet: normalizeWhitespace(htmlDecode(snippetMatch?.[1] || '')),
    });
  }

  if (results.length > 0) return uniqueByUrl(results);

  for (const match of html.matchAll(fallbackRegex)) {
    const url = decodeDuckDuckGoUrl(htmlDecode(match[1]));
    if (!url) continue;
    results.push({
      title: normalizeWhitespace(htmlDecode(match[2])),
      url,
      snippet: normalizeWhitespace(htmlDecode(match[3] || match[4] || '')),
    });
  }

  return uniqueByUrl(results);
}

function uniqueByUrl(items: Array<{ title: string; url: string; snippet: string }>): Array<{ title: string; url: string; snippet: string }> {
  const seen = new Set<string>();
  const unique: Array<{ title: string; url: string; snippet: string }> = [];
  for (const item of items) {
    if (!item.url || seen.has(item.url)) continue;
    seen.add(item.url);
    unique.push(item);
  }
  return unique;
}

function decodeDuckDuckGoUrl(url: string): string | null {
  try {
    const parsed = new URL(url, 'https://duckduckgo.com');
    const uddg = parsed.searchParams.get('uddg');
    const candidate = uddg ? decodeURIComponent(uddg) : parsed.toString();
    return /^https?:\/\//i.test(candidate) ? candidate : null;
  } catch {
    return /^https?:\/\//i.test(url) ? url : null;
  }
}

function decodeGoogleUrl(url: string): string | null {
  try {
    const parsed = new URL(url, 'https://www.google.com');
    if (parsed.pathname === '/url') {
      const candidate = parsed.searchParams.get('q') || parsed.searchParams.get('url') || '';
      return /^https?:\/\//i.test(candidate) ? candidate : null;
    }
    if (parsed.hostname.endsWith('google.com')) return null;
    const candidate = parsed.toString();
    return /^https?:\/\//i.test(candidate) ? candidate : null;
  } catch {
    return /^https?:\/\//i.test(url) ? url : null;
  }
}

function extractTitle(html: string): string {
  const candidates = [
    /<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i,
    /<meta[^>]+name="twitter:title"[^>]+content="([^"]+)"/i,
    /<title[^>]*>([\s\S]*?)<\/title>/i,
  ];
  for (const pattern of candidates) {
    const match = html.match(pattern);
    if (match?.[1]) return normalizeWhitespace(htmlDecode(match[1]));
  }
  return 'Untitled page';
}

function extractDescription(html: string): string {
  const candidates = [
    /<meta[^>]+name="description"[^>]+content="([^"]+)"/i,
    /<meta[^>]+property="og:description"[^>]+content="([^"]+)"/i,
  ];
  for (const pattern of candidates) {
    const match = html.match(pattern);
    if (match?.[1]) return normalizeWhitespace(htmlDecode(match[1]));
  }
  return '';
}

function extractSiteName(html: string, url: string): string {
  const candidates = [
    /<meta[^>]+property="og:site_name"[^>]+content="([^"]+)"/i,
    /<meta[^>]+name="application-name"[^>]+content="([^"]+)"/i,
  ];
  for (const pattern of candidates) {
    const match = html.match(pattern);
    if (match?.[1]) return normalizeWhitespace(htmlDecode(match[1]));
  }
  return safeHostname(url) || 'unknown';
}

function htmlToText(html: string): string {
  const withoutScripts = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, ' ');
  const withBreaks = withoutScripts
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr)>/gi, '\n');
  const stripped = withBreaks.replace(/<[^>]+>/g, ' ');
  return normalizeWhitespace(htmlDecode(stripped)).replace(/\n{3,}/g, '\n\n');
}

function buildSummary(description: string, text: string): string {
  if (description) return truncateAtBoundary(description, 400);
  return truncateAtBoundary(text, 400);
}

function buildFindHits(text: string, find?: string): ReadPageFindHit[] {
  const keyword = (find || '').trim();
  if (!keyword) return [];
  const lower = text.toLowerCase();
  const target = keyword.toLowerCase();
  const hits: ReadPageFindHit[] = [];
  let cursor = 0;
  while (hits.length < 5) {
    const index = lower.indexOf(target, cursor);
    if (index === -1) break;
    const start = Math.max(0, index - 80);
    const end = Math.min(text.length, index + keyword.length + 80);
    hits.push({ text: text.slice(start, end).trim() });
    cursor = index + keyword.length;
  }
  return hits;
}

function htmlDecode(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, '/')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r/g, '')
    .replace(/\t/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/[ \f\v]+/g, ' ')
    .replace(/\n{2,}/g, '\n\n')
    .trim();
}

function truncateAtBoundary(text: string, maxChars: number): string {
  return truncateAtBoundaryWithFlag(text, maxChars).text;
}

function truncateAtBoundaryWithFlag(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const slice = text.slice(0, maxChars);
  const boundary = Math.max(
    slice.lastIndexOf('\n\n'),
    slice.lastIndexOf('。'),
    slice.lastIndexOf('. '),
    slice.lastIndexOf('！'),
    slice.lastIndexOf('？'),
  );
  const trimmed = boundary >= Math.floor(maxChars * 0.6) ? slice.slice(0, boundary + 1) : slice;
  return { text: `${trimmed.trim()}…`, truncated: true };
}

function trimToBytes(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length <= maxBytes) return value;
  return buffer.subarray(0, maxBytes).toString('utf8');
}

function safeHostname(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function normalizeFreshness(value: SearchFreshness): SearchFreshness {
  return ['any', 'day', 'week', 'month', 'year'].includes(value) ? value : 'any';
}

function freshnessToDuckDuckGoValue(value: SearchFreshness): string {
  switch (value) {
    case 'day': return 'd';
    case 'week': return 'w';
    case 'month': return 'm';
    case 'year': return 'y';
    default: return '';
  }
}

function freshnessToGoogleValue(value: SearchFreshness): string {
  switch (value) {
    case 'day': return 'qdr:d';
    case 'week': return 'qdr:w';
    case 'month': return 'qdr:m';
    case 'year': return 'qdr:y';
    default: return '';
  }
}

function normalizeDomains(domains?: string[]): string[] {
  if (!Array.isArray(domains)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of domains) {
    const domain = String(raw || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    normalized.push(domain);
    if (normalized.length >= 5) break;
  }
  return normalized;
}

function getCached<T>(cache: Map<string, { expiresAt: number; value: T }>, key: string): T | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function setCached<T>(cache: Map<string, { expiresAt: number; value: T }>, key: string, value: T, ttlMs: number): void {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  if (cache.size > 100) {
    const first = cache.keys().next().value;
    if (first) cache.delete(first);
  }
}

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

function isRetryableNetworkError(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  if (!error.response) return true;
  return [408, 429, 500, 502, 503, 504].includes(error.response.status);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
