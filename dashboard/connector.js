(() => {
  'use strict';

  const API = '/api';
  const DASHBOARD_API_KEY_STORAGE_KEY = 'catsco.dashboardApiKey';
  let dashboardApiKeyPromptInFlight = null;

  function getFetchUrl(input) {
    if (typeof input === 'string') return input;
    if (typeof URL !== 'undefined' && input instanceof URL) return input.href;
    if (typeof Request !== 'undefined' && input instanceof Request) return input.url;
    return input?.url || '';
  }

  function isDashboardApiUrl(input) {
    try {
      const raw = getFetchUrl(input);
      if (!raw) return false;
      const url = new URL(raw, window.location.href);
      const apiBase = new URL(API || '/', window.location.href);
      return url.origin === apiBase.origin && url.pathname.startsWith('/api/');
    } catch (_error) {
      return false;
    }
  }

  function getDashboardStoredApiKey() {
    try { return window.sessionStorage.getItem(DASHBOARD_API_KEY_STORAGE_KEY) || ''; } catch (_error) { return ''; }
  }

  function setDashboardStoredApiKey(key) {
    try {
      if (key) window.sessionStorage.setItem(DASHBOARD_API_KEY_STORAGE_KEY, key);
      else window.sessionStorage.removeItem(DASHBOARD_API_KEY_STORAGE_KEY);
    } catch (_error) {}
  }

  function promptForDashboardApiKey(message) {
    if (!dashboardApiKeyPromptInFlight) {
      dashboardApiKeyPromptInFlight = Promise.resolve().then(() => {
        const key = window.prompt(message || '请输入 Dashboard API Key');
        const trimmed = key?.trim() || '';
        if (trimmed) setDashboardStoredApiKey(trimmed);
        return trimmed;
      }).finally(() => {
        dashboardApiKeyPromptInFlight = null;
      });
    }
    return dashboardApiKeyPromptInFlight;
  }

  async function ensureDashboardApiKey(message) {
    return getDashboardStoredApiKey() || promptForDashboardApiKey(message);
  }

  function withDashboardApiKey(input, init) {
    if (!isDashboardApiUrl(input)) return { input, init, dashboardApiKey: '' };
    const key = getDashboardStoredApiKey();
    if (!key) return { input, init, dashboardApiKey: '' };
    const nextInit = { ...(init || {}) };
    const sourceHeaders = nextInit.headers || (typeof Request !== 'undefined' && input instanceof Request ? input.headers : {});
    const headers = new Headers(sourceHeaders || {});
    if (!headers.has('Authorization') && !headers.has('X-API-Key')) headers.set('X-API-Key', key);
    nextInit.headers = headers;
    return { input, init: nextInit, dashboardApiKey: key };
  }

  async function isDashboardAuthFailure(response) {
    if (response.status !== 401 && response.status !== 403 && response.status !== 429) return false;
    try {
      const data = await response.clone().json();
      return data && [
        'dashboard_auth_required',
        'dashboard_auth_invalid',
        'dashboard_auth_rate_limited',
      ].includes(data.code);
    } catch (_error) {
      return false;
    }
  }

  function cloneFetchInput(input) {
    return typeof Request !== 'undefined' && input instanceof Request ? input.clone() : input;
  }

  const nativeFetch = window.fetch.bind(window);
  window.fetch = async function dashboardAuthenticatedFetch(input, init) {
    const firstInput = cloneFetchInput(input);
    const retryInput = cloneFetchInput(input);
    let authRequest = withDashboardApiKey(firstInput, init);
    let response = await nativeFetch(authRequest.input, authRequest.init);
    if (isDashboardApiUrl(input) && await isDashboardAuthFailure(response)) {
      if (response.status === 429) return response;
      if (getDashboardStoredApiKey() === authRequest.dashboardApiKey) setDashboardStoredApiKey('');
      const key = await ensureDashboardApiKey('Dashboard API Key 无效或缺失，请重新输入');
      if (key) {
        authRequest = withDashboardApiKey(retryInput, init);
        response = await nativeFetch(authRequest.input, authRequest.init);
      }
    }
    return response;
  };

  const state = {
    app: {},
    cats: {},
    bootstrap: {},
    services: [],
    update: {},
    refreshInFlight: null,
    loginBusy: false,
    actionBusy: false,
    fullPollTimer: null,
    bootstrapPollTimer: null,
  };

  const $ = (id) => document.getElementById(id);
  const setText = (id, value) => {
    const node = $(id);
    if (node) node.textContent = value == null || value === '' ? '—' : String(value);
  };

  async function request(path, init = {}) {
    const headers = new Headers(init.headers || {});
    headers.set('Accept', 'application/json');
    if (init.body != null) headers.set('Content-Type', 'application/json');
    const response = await fetch(`${API}${path}`, { ...init, headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data?.error || data?.data?.error || `HTTP ${response.status}`;
      const error = new Error(String(message));
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  async function settled(path) {
    try {
      return { ok: true, value: await request(path) };
    } catch (error) {
      return { ok: false, error };
    }
  }

  async function refresh(options = {}) {
    if (state.refreshInFlight && !options.force) return state.refreshInFlight;
    const run = (async () => {
      const [app, cats, bootstrap, services, update] = await Promise.all([
        settled('/status'),
        settled('/cats/status'),
        settled('/cats/bootstrap/status'),
        settled('/services'),
        settled('/update/status'),
      ]);
      if (app.ok) state.app = app.value;
      if (cats.ok) state.cats = cats.value;
      else state.cats = { loadError: cats.error?.message || '无法读取 CatsCo 状态' };
      if (bootstrap.ok) state.bootstrap = bootstrap.value;
      if (services.ok) state.services = Array.isArray(services.value) ? services.value : [];
      if (update.ok) state.update = update.value;
      render();
    })();
    state.refreshInFlight = run;
    try {
      await run;
    } finally {
      if (state.refreshInFlight === run) state.refreshInFlight = null;
    }
  }

  async function refreshBootstrap() {
    const result = await settled('/cats/bootstrap/status');
    if (result.ok) {
      const previous = state.bootstrap.stage;
      state.bootstrap = result.value;
      render();
      if (previous === 'connecting' && result.value.stage !== 'connecting') {
        await refresh({ force: true });
      }
    }
  }

  function connectorService() {
    return state.cats.service || state.services.find((service) => service.name === 'catscompany') || {};
  }

  function deriveView() {
    const cats = state.cats || {};
    const bootstrap = state.bootstrap || {};
    const service = connectorService();
    const bodyState = cats.bodyStatus?.state;
    const ready = Boolean(
      cats.connected
      && cats.chatReady
      && service.status === 'running'
      && cats.bodyStatus?.state !== 'offline',
    );
    if (ready) return { key: 'ready' };
    if (cats.loadError) return { key: 'error', title: '无法读取本地状态', error: cats.loadError };
    if (!cats.connected || cats.authStatus === 'missing' || cats.authStatus === 'invalid' || bootstrap.stage === 'waiting_for_login') {
      return { key: 'auth', error: cats.authError || (bootstrap.stage === 'waiting_for_login' ? bootstrap.error : '') };
    }
    if (bodyState === 'conflict') {
      return {
        key: 'error',
        title: '当前 Agent 正在另一台设备上运行',
        error: '为了避免两台电脑同时接管同一个 Agent，本机暂时没有启动 Connector。请先退出另一台设备，或稍后重试。',
      };
    }
    if (bodyState === 'auth_error') {
      return { key: 'error', title: 'Agent 绑定需要重新确认', error: cats.bodyStatus?.error || '当前账号无法使用这个 Agent。' };
    }
    if (bootstrap.stage === 'error' || service.status === 'error') {
      return {
        key: 'error',
        title: '自动连接未完成',
        error: bootstrap.error || service.lastError || 'Connector 启动失败，请重试。',
      };
    }
    return { key: 'connecting' };
  }

  function render() {
    const view = deriveView();
    const cats = state.cats || {};
    const service = connectorService();
    document.body.dataset.view = view.key;

    const accountName = cats.user?.display_name || cats.user?.username || '—';
    const accountMeta = cats.user?.username || (cats.connected ? `UID ${cats.user?.uid || ''}` : '等待登录');
    const agentName = cats.bot?.name || cats.bot?.username || (cats.botUid ? `Agent ${shortId(cats.botUid)}` : '—');
    const agentMeta = cats.bot?.username || (cats.botUid ? shortId(cats.botUid) : '登录后自动准备');
    const deviceName = cats.device?.name || (cats.device?.deviceId ? '这台电脑' : '—');
    setText('account-name', accountName);
    setText('account-meta', accountMeta);
    setText('agent-name', agentName);
    setText('agent-meta', agentMeta);
    setText('device-name', deviceName);
    setText('device-meta', cats.device?.bodyId ? `设备 ${shortId(cats.device.bodyId)}` : '本地工具与文件');
    setText('app-version', state.app.version || '—');

    $('login-form').hidden = view.key !== 'auth';
    $('progress-list').hidden = view.key !== 'connecting';
    $('error-card').hidden = view.key !== 'error';
    $('webapp-button').hidden = view.key !== 'ready';
    $('retry-button').hidden = view.key !== 'error';
    $('close-hint').hidden = view.key !== 'ready';

    if (view.key === 'auth') renderAuth(view);
    if (view.key === 'connecting') renderConnecting(cats, service);
    if (view.key === 'ready') renderReady(cats);
    if (view.key === 'error') renderError(view);
    renderUpdate();
    syncPolling(view.key);
  }

  function renderAuth(view) {
    setText('status-label', '等待登录 CatsCo');
    setText('hero-title', '登录 CatsCo');
    setText('hero-copy', '无需在本地创建或选择 Bot。登录成功后，CatsCo 会自动准备 Agent 并启动 Connector。');
    setNotice(view.error || '首次使用需要登录 CatsCo 账号。', view.error ? 'error' : 'normal');
    if (view.error) setText('login-error', view.error);
  }

  function renderConnecting(cats, service) {
    setText('status-label', 'Connector 正在启动');
    setText('hero-title', '正在连接这台电脑');
    setText('hero-copy', state.bootstrap.message || '正在同步 Agent 配置并启动 Connector，请稍候。');
    setNotice('请保持 CatsCo Desktop 运行，连接完成后即可关闭此窗口。', 'normal');
    const accountDone = Boolean(cats.connected);
    const agentDone = Boolean(cats.bodyConfigured || cats.botUid);
    const connectorDone = service.status === 'running';
    markStep('account', accountDone ? 'done' : 'active');
    markStep('agent', agentDone ? 'done' : accountDone ? 'active' : '');
    markStep('connector', connectorDone ? 'done' : agentDone ? 'active' : '');
  }

  function renderReady(cats) {
    setText('status-label', 'Connector 正常运行');
    setText('hero-title', '这台电脑已连接');
    setText('hero-copy', 'CatsCo WebApp 可以使用本机 Agent、本地工具和文件。');
    setNotice('连接已建立。关闭此窗口后，Connector 会继续在后台运行。', 'success');
  }

  function renderError(view) {
    setText('status-label', 'Connector 需要处理');
    setText('hero-title', '连接未完成');
    setText('hero-copy', '本地资料没有被删除。处理下面的问题后可以继续重试。');
    setText('error-title', view.title || '自动连接未完成');
    setText('error-copy', view.error || '请重新连接，或展开高级诊断查看日志。');
    setNotice(view.title || 'Connector 连接异常', 'error');
  }

  function markStep(name, status) {
    const item = document.querySelector(`[data-step="${name}"]`);
    if (!item) return;
    item.classList.toggle('active', status === 'active');
    item.classList.toggle('done', status === 'done');
    if (status === 'active') item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
  }

  function setNotice(message, tone) {
    setText('notice-text', message);
    $('notice').className = `notice${tone === 'success' ? ' success' : tone === 'error' ? ' error' : ''}`;
  }

  function renderUpdate() {
    const button = $('update-button');
    const update = state.update || {};
    if (!button) return;
    button.disabled = update.stage === 'checking' || update.stage === 'downloading';
    if (update.stage === 'available') button.textContent = `下载 ${update.availableVersion || '新版本'}`;
    else if (update.stage === 'downloaded') button.textContent = '安装更新';
    else if (update.stage === 'checking') button.textContent = '检查中…';
    else if (update.enabled === false) button.textContent = '开发版本';
    else button.textContent = '检查更新';
  }

  function syncPolling(view) {
    if (state.bootstrapPollTimer) clearInterval(state.bootstrapPollTimer);
    state.bootstrapPollTimer = null;
    if (view === 'connecting') {
      state.bootstrapPollTimer = setInterval(refreshBootstrap, 1200);
    }
    if (!state.fullPollTimer) {
      state.fullPollTimer = setInterval(() => refresh(), view === 'ready' ? 12000 : 6000);
    }
  }

  async function login(event) {
    event.preventDefault();
    if (state.loginBusy) return;
    const account = $('login-account').value.trim();
    const password = $('login-password').value;
    if (!account || !password) return;
    state.loginBusy = true;
    $('login-button').disabled = true;
    $('login-button').textContent = '正在登录…';
    setText('login-error', '');
    try {
      await request('/cats/auth/login', { method: 'POST', body: JSON.stringify({ account, password }) });
      $('login-password').value = '';
      await request('/cats/bootstrap', { method: 'POST', body: JSON.stringify({ trigger: 'login' }) });
      state.bootstrap = { stage: 'connecting', message: '登录成功，正在自动连接这台电脑' };
      await refresh({ force: true });
    } catch (error) {
      setText('login-error', humanError(error));
    } finally {
      state.loginBusy = false;
      $('login-button').disabled = false;
      $('login-button').textContent = '登录并连接';
    }
  }

  async function retry() {
    if (state.actionBusy) return;
    state.actionBusy = true;
    setBusyButtons(true);
    try {
      await request('/cats/bootstrap', { method: 'POST', body: JSON.stringify({ trigger: 'manual' }) });
      state.bootstrap = { stage: 'connecting', message: '正在重新连接这台电脑' };
      render();
      await refreshBootstrap();
      showToast('已开始重新连接');
    } catch (error) {
      showToast(`重新连接失败：${humanError(error)}`);
    } finally {
      state.actionBusy = false;
      setBusyButtons(false);
    }
  }

  async function loadLogs() {
    const output = $('connector-logs');
    output.textContent = '正在读取日志…';
    try {
      const logs = await request('/services/catscompany/logs?lines=120');
      output.textContent = Array.isArray(logs) && logs.length ? logs.join('\n') : '暂时没有 Connector 日志。';
    } catch (error) {
      output.textContent = `日志读取失败：${humanError(error)}`;
    }
  }

  async function logout() {
    if (!window.confirm('退出后，本机 Connector 会停止。确定退出这个 CatsCo 账号吗？')) return;
    try {
      await request('/cats/auth/logout', { method: 'POST', body: '{}' });
      state.cats = {};
      state.bootstrap = { stage: 'waiting_for_login' };
      await refresh({ force: true });
      $('diagnostics').open = false;
    } catch (error) {
      showToast(`退出失败：${humanError(error)}`);
    }
  }

  async function checkUpdate() {
    const stage = state.update?.stage;
    try {
      if (stage === 'available') state.update = await request('/update/download', { method: 'POST', body: '{}' });
      else if (stage === 'downloaded') await request('/update/install', { method: 'POST', body: '{}' });
      else state.update = await request('/update/check', { method: 'POST', body: '{}' });
      renderUpdate();
      showToast(state.update?.message || '更新状态已刷新');
    } catch (error) {
      showToast(`检查更新失败：${humanError(error)}`);
    }
  }

  function setBusyButtons(busy) {
    ['retry-button', 'diagnostic-retry'].forEach((id) => { if ($(id)) $(id).disabled = busy; });
  }

  function humanError(error) {
    const message = String(error?.message || error || '未知错误');
    if (/password mismatch/i.test(message)) return '账号或密码错误，请重试。';
    if (/user not found/i.test(message)) return '没有找到这个 CatsCo 账号。';
    if (/failed to fetch|network/i.test(message)) return '暂时无法连接 CatsCo，请检查网络。';
    return message;
  }

  function shortId(value) {
    const text = String(value || '');
    return text.length > 18 ? `${text.slice(0, 9)}…${text.slice(-5)}` : text;
  }

  let toastTimer;
  function showToast(message) {
    const toast = $('toast');
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 3200);
  }

  $('login-form').addEventListener('submit', login);
  $('refresh-button').addEventListener('click', () => refresh({ force: true }));
  $('retry-button').addEventListener('click', retry);
  $('diagnostic-retry').addEventListener('click', retry);
  $('logs-button').addEventListener('click', loadLogs);
  $('logout-button').addEventListener('click', logout);
  $('update-button').addEventListener('click', checkUpdate);
  $('diagnostics').addEventListener('toggle', () => { if ($('diagnostics').open) void loadLogs(); });

  void refresh({ force: true });
})();
