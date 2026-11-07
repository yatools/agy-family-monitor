<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import Icon from './components/Icon.vue';
import Chart from './components/Chart.vue';
import Settings from './pages/Settings.vue';
import { load, request, ApiError } from './api/client';
import { snapshot, total, demoRules } from './api/demo';
import type { Filters, Snapshot, Rule, AdminSnapshot } from './api/types';
import type { EChartsCoreOption } from 'echarts/core';
import './style.css';

const tabs = [
  { id: 'overview', name: '家庭总览', icon: 'overview' },
  { id: 'members', name: '家庭成员', icon: 'members' },
  { id: 'usage', name: '使用记录', icon: 'usage' },
  { id: 'models', name: '模型分析', icon: 'models' },
  { id: 'alerts', name: '预警中心', icon: 'alerts' },
  { id: 'settings', name: '设置', icon: 'settings' },
];
const descriptions: Record<string, string> = {
  overview: '在同一个地方，看见全家每一份使用。',
  members: '每个人的使用情况，都有清晰的记录。',
  usage: '按时间、成员与模型，查看真实的 Token 明细。',
  models: '了解模型分布与 API 等效费用。',
  alerts: '用绝对用量和成本阈值，保持适度使用。',
  settings: '管理成员、设备、价格与通知偏好。',
};
const route = ref(location.hash.slice(1) || 'overview');
const mobile = ref(false);
const demo = ref(new URLSearchParams(location.search).get('demo') === '1');
const familyTimezone = ref('Asia/Shanghai');
const knownModels = ref<string[]>([]);
const date = (ms: number) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: familyTimezone.value,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(ms);
const range = ref('30');
const filters = ref<Filters>({
  from_date: date(Date.now() - 29 * 86400000),
  to_date: date(Date.now()),
  member_id: '',
  model_id: '',
  source: '',
});
const page = ref(1),
  data = ref<Snapshot>(),
  loading = ref(false),
  error = ref(''),
  unauthorized = ref(false),
  notice = ref(''),
  chartMetric = ref('tokens'),
  memberDetail = ref(''),
  expandedModel = ref('');
const ruleForm = ref({
  scope: 'member',
  member_id: '',
  metric: 'tokens',
  period: 'day',
  value: 1000000,
});
const editingRuleId = ref('');
const editRuleForm = ref({
  scope: 'member',
  member_id: '',
  metric: 'tokens',
  period: 'day',
  value: 1000000,
  enabled: true,
});
let requestVersion = 0;
const visibleTabs = computed(() =>
  tabs.filter((tab) => tab.id !== 'settings' || data.value?.me.role === 'admin'),
);
const adminData = computed<AdminSnapshot | null>(() =>
  data.value?.me.role === 'admin' && data.value.settings
    ? { ...data.value, settings: data.value.settings }
    : null,
);
const activeMemberCount = computed(
  () => data.value?.members.filter((m) => m.status === 'active').length ?? 0,
);
watch([route, () => data.value?.me.role], ([page, role]) => {
  if (page === 'settings' && role === 'member') go('overview');
});
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
const nf = new Intl.NumberFormat('zh-CN');
const number = (v: number | undefined) => nf.format(v ?? 0);
const compact = (v: number | undefined) =>
  v === undefined
    ? '—'
    : v >= 1e6
      ? `${(v / 1e6).toFixed(2)}M`
      : v >= 1e3
        ? `${(v / 1e3).toFixed(1)}K`
        : number(v);
const usd = (v: number | null | undefined) =>
  v == null
    ? '待计价'
    : `$${(v / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
const relative = (ms: number | null | undefined) =>
  !ms
    ? '尚未上报'
    : Date.now() - ms < 60000
      ? '刚刚'
      : Date.now() - ms < 3600000
        ? `${Math.floor((Date.now() - ms) / 60000)} 分钟前`
        : Date.now() - ms < 86400000
          ? `${Math.floor((Date.now() - ms) / 3600000)} 小时前`
          : `${Math.floor((Date.now() - ms) / 86400000)} 天前`;
const timestamp = (ms: number) =>
  new Intl.DateTimeFormat('zh-CN', {
    timeZone: data.value?.summary.timezone ?? 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(ms);
const staticModelNames: Record<string, string> = {
  unknown: '未识别模型',
  'gemini-4-argon': 'Gemini 4 Argon',
  'claude-opus-5-5': 'Claude Opus 5.5',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5',
  'claude-opus-4-6': 'Claude Opus 4.6',
  'claude-sonnet-4-6': 'Claude Sonnet 4.6',
  'claude-sonnet-4-5': 'Claude Sonnet 4.5',
  'claude-fable-5-1': 'Claude Fable 5.1',
  'gemini-3.8-flash': 'Gemini 3.8 Flash',
  'gemini-3.8-flash-high': 'Gemini 3.8 Flash (High)',
  'gemini-3.8-flash-medium': 'Gemini 3.8 Flash (Medium)',
  'gemini-3.8-flash-low': 'Gemini 3.8 Flash (Low)',
  'gemini-3.1-pro-preview': 'Gemini 3.1 Pro Preview',
};
const modelDisplayMap = computed(() => {
  const map = new Map<string, string>();
  for (const row of data.value?.models ?? []) {
    if (row.model_display) map.set(row.model_id, row.model_display);
  }
  for (const item of data.value?.usage.items ?? []) {
    if (item.model_display && !map.has(item.model_id)) {
      map.set(item.model_id, item.model_display);
    }
  }
  return map;
});
const modelName = (id: string, display?: string | null) =>
  display || modelDisplayMap.value.get(id) || staticModelNames[id] || id;
const modelList = computed(() => [
  ...new Set([
    ...knownModels.value,
    ...(data.value?.models.map((m) => m.model_id) ?? []),
    ...(data.value?.settings?.prices.map((p) => p.model_id) ?? []),
    ...(filters.value.model_id ? [filters.value.model_id] : []),
  ]),
]);
const models = computed(() => {
  const groups = new Map<
    string,
    {
      id: string;
      display: string | null;
      tokens: number;
      cost: number | null;
      unpriced: number;
      members: number;
      input: number;
      output: number;
      cache: number;
    }
  >();
  for (const row of data.value?.models ?? []) {
    const model = groups.get(row.model_id) ?? {
      id: row.model_id,
      display: row.model_display ?? null,
      tokens: 0,
      cost: null,
      unpriced: 0,
      members: 0,
      input: 0,
      output: 0,
      cache: 0,
    };
    if (!model.display && row.model_display) model.display = row.model_display;
    model.tokens += row.total_tokens;
    model.input += row.input_tokens;
    model.output += row.output_tokens;
    model.cache += row.cache_read_tokens + row.cache_write_tokens;
    if (row.cost_micro_usd !== null) model.cost = (model.cost ?? 0) + row.cost_micro_usd;
    model.unpriced += row.unpriced_tokens;
    model.members++;
    groups.set(row.model_id, model);
  }
  return [...groups.values()].sort((a, b) => b.tokens - a.tokens);
});
const ranking = computed(() =>
  [...(data.value?.members ?? [])].sort((a, b) => b.month.total_tokens - a.month.total_tokens),
);
const unread = computed(
  () =>
    (data.value?.alerts.filter((a) => !a.acknowledged).length ?? 0) +
    (data.value?.monitor.alerts.filter((a) => !a.resolved_at_ms).length ?? 0),
);
const selectedMember = computed(() => data.value?.members.find((m) => m.id === memberDetail.value));
const colors = ['#3d7856', '#92b47b', '#bfcfa7', '#e3bb7b', '#8da9a3'];
const trendOption = computed<EChartsCoreOption>(() => ({
  animation: !matchMedia('(prefers-reduced-motion: reduce)').matches,
  aria: { enabled: true },
  tooltip: {
    trigger: 'axis',
    renderMode: 'richText',
    valueFormatter: (value: unknown) =>
      chartMetric.value === 'cost' ? usd(Number(value)) : number(Number(value)),
  },
  grid: { left: 62, right: 22, top: 24, bottom: 34 },
  xAxis: {
    type: 'category',
    boundaryGap: false,
    data: data.value?.trends.map((r) => r.date.slice(5).replace('-', '.')),
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color: '#8b958b', fontSize: 11, margin: 16 },
  },
  yAxis: {
    type: 'value',
    splitNumber: 4,
    axisLabel: {
      color: '#8b958b',
      fontSize: 11,
      formatter: (value: number) =>
        chartMetric.value === 'cost' ? `$${(value / 1e6).toFixed(0)}` : compact(value),
    },
    splitLine: { lineStyle: { color: '#e9ede5', type: 'dashed' } },
  },
  series: [
    {
      type: 'line',
      smooth: 0.32,
      symbol: 'circle',
      showSymbol: false,
      lineStyle: { width: 2.5, color: '#43835b' },
      itemStyle: { color: '#43835b' },
      areaStyle: {
        color: {
          type: 'linear',
          x: 0,
          y: 0,
          x2: 0,
          y2: 1,
          colorStops: [
            { offset: 0, color: 'rgba(101,156,105,.25)' },
            { offset: 1, color: 'rgba(101,156,105,0)' },
          ],
        },
      },
      data: data.value?.trends.map((r) =>
        chartMetric.value === 'cost' ? r.cost_micro_usd : r.total_tokens,
      ),
    },
  ],
}));
const pieOption = computed<EChartsCoreOption>(() => ({
  animation: !matchMedia('(prefers-reduced-motion: reduce)').matches,
  color: colors,
  aria: { enabled: true },
  tooltip: { trigger: 'item', renderMode: 'richText', formatter: '{b}\n{d}% 的 Token' },
  series: [
    {
      type: 'pie',
      radius: ['58%', '76%'],
      center: ['50%', '49%'],
      padAngle: 3,
      itemStyle: { borderRadius: 5 },
      label: { show: false },
      emphasis: { scaleSize: 5 },
      data: models.value.map((m) => ({ name: modelName(m.id, m.display), value: m.tokens })),
    },
  ],
  graphic: [
    {
      type: 'text',
      left: 'center',
      top: '39%',
      style: {
        text: compact(data.value?.summary.selected.total_tokens ?? 0),
        font: '600 27px sans-serif',
        fill: '#65805f',
      },
    },
    {
      type: 'text',
      left: 'center',
      top: '52%',
      style: { text: '总 Token', font: '12px sans-serif', fill: '#8b958b' },
    },
  ],
}));
function tell(message: string) {
  notice.value = message;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (notice.value = ''), 4500);
}
async function refresh() {
  const version = ++requestVersion;
  loading.value = true;
  error.value = '';
  unauthorized.value = false;
  try {
    const result = demo.value
      ? snapshot(filters.value, page.value, {
          role: new URLSearchParams(location.search).get('role') === 'member' ? 'member' : 'admin',
          setup: new URLSearchParams(location.search).get('setup') === '1',
        })
      : await load(filters.value, page.value);
    if (version === requestVersion) {
      data.value = result;
      knownModels.value = [
        ...new Set([...knownModels.value, ...result.models.map((m) => m.model_id)]),
      ];
      if (familyTimezone.value !== result.summary.timezone) {
        familyTimezone.value = result.summary.timezone;
        changeRange();
      }
    }
  } catch (e) {
    if (version === requestVersion) {
      error.value = e instanceof Error ? e.message : '无法连接服务';
      unauthorized.value = e instanceof ApiError && e.status === 401;
    }
  } finally {
    if (version === requestVersion) loading.value = false;
  }
}
function go(id: string) {
  location.hash = id;
  mobile.value = false;
}
function changeRange() {
  if (range.value === 'custom') return;
  filters.value.to_date = date(Date.now());
  filters.value.from_date =
    range.value === 'month'
      ? `${date(Date.now()).slice(0, 7)}-01`
      : date(Date.now() - (Number(range.value) - 1) * 86400000);
}
function enableDemo() {
  demo.value = !demo.value;
  page.value = 1;
  refresh();
}
async function ack(id: string) {
  try {
    if (!demo.value) await request(`/alerts/${id}/ack`, 'POST');
    const alert = data.value?.alerts.find((a) => a.id === id);
    if (alert) alert.acknowledged = 1;
    tell('预警已标记为已读');
  } catch (e) {
    tell(e instanceof Error ? e.message : '操作失败');
  }
}
async function toggleMyNotifications(enabled: boolean) {
  try {
    if (!demo.value) {
      await request('/preferences', 'PUT', { notifications_enabled: enabled });
    }
    if (data.value) {
      data.value.me.notifications_enabled = enabled ? 1 : 0;
    }
    tell('个人通知偏好已更新');
  } catch (e) {
    tell(e instanceof Error ? e.message : '更新失败');
  }
}
async function saveRules(rules: Rule[]) {
  try {
    const values = rules.map((r) => ({
      id: r.id,
      scope: r.scope,
      member_id: r.scope === 'family' ? null : r.member_id || null,
      metric: r.metric,
      period: r.period,
      threshold_value: r.threshold_value,
      enabled: !!r.enabled,
    }));
    if (!demo.value) await request('/rules', 'PUT', values);
    else {
      demoRules.splice(0, demoRules.length, ...values);
    }
    tell('预警规则已保存');
    await refresh();
  } catch (e) {
    tell(e instanceof Error ? e.message : '保存失败');
  }
}
function addRule() {
  if (!data.value) return;
  const f = ruleForm.value;
  saveRules([
    ...data.value.rules,
    {
      id: crypto.randomUUID(),
      scope: f.scope as Rule['scope'],
      member_id: f.scope === 'family' ? null : f.member_id || null,
      metric: f.metric as Rule['metric'],
      period: f.period as Rule['period'],
      threshold_value: Math.round(f.value * (f.metric === 'cost_micro_usd' ? 1e6 : 1)),
      enabled: true,
    },
  ]);
}
function startEditRule(rule: Rule) {
  editingRuleId.value = rule.id ?? '';
  editRuleForm.value = {
    scope: rule.scope,
    member_id: rule.member_id ?? '',
    metric: rule.metric,
    period: rule.period,
    value:
      rule.metric === 'cost_micro_usd'
        ? Number((rule.threshold_value / 1e6).toFixed(6))
        : rule.threshold_value,
    enabled: !!rule.enabled,
  };
}
async function saveEditRule(id?: string) {
  if (!data.value || !id) return;
  const f = editRuleForm.value;
  const updated = data.value.rules.map((r) =>
    r.id === id
      ? {
          ...r,
          scope: f.scope as Rule['scope'],
          member_id: f.scope === 'family' ? null : f.member_id || null,
          metric: f.metric as Rule['metric'],
          period: f.period as Rule['period'],
          threshold_value: Math.round(f.value * (f.metric === 'cost_micro_usd' ? 1e6 : 1)),
          enabled: !!f.enabled,
        }
      : r,
  );
  editingRuleId.value = '';
  await saveRules(updated);
}
async function deleteRule(id?: string) {
  if (!data.value || !id) return;
  try {
    if (!demo.value) {
      await request(`/rules/${id}`, 'DELETE');
    } else {
      const idx = demoRules.findIndex((r) => r.id === id);
      if (idx >= 0) demoRules.splice(idx, 1);
    }
    if (editingRuleId.value === id) editingRuleId.value = '';
    tell('预警规则已删除');
    await refresh();
  } catch (e) {
    tell(e instanceof Error ? e.message : '删除失败');
  }
}
function usageFor(id: string) {
  filters.value.member_id = id;
  memberDetail.value = '';
  go('usage');
}
function syncRoute() {
  const target = location.hash.slice(1);
  route.value = tabs.some((t) => t.id === target) ? target : 'overview';
}
watch(
  () => ({ ...filters.value }),
  () => {
    page.value = 1;
    refresh();
  },
);
watch(page, () => refresh());
onMounted(() => {
  syncRoute();
  addEventListener('hashchange', syncRoute);
  refresh();
  refreshTimer = setInterval(() => {
    if (!document.hidden && !demo.value && !loading.value && route.value !== 'settings') refresh();
  }, 60000);
});
onBeforeUnmount(() => {
  removeEventListener('hashchange', syncRoute);
  if (noticeTimer) clearTimeout(noticeTimer);
  if (refreshTimer) clearInterval(refreshTimer);
});
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar" :class="{ open: mobile }">
      <a class="brand" href="#overview"
        ><span class="brand-mark"><i></i><i></i><i></i></span
        ><span>Agy<span class="brand-sub">FAMILY MONITOR</span></span></a
      >
      <div class="workspace">
        <span class="workspace-icon"><Icon name="members" :size="19" /></span>
        <div>
          <strong>我们的家庭组</strong
          ><small>{{ activeMemberCount || (data?.members.length ?? '—') }} 位成员 · 共享空间</small>
        </div>
        <span class="workspace-dot"></span>
      </div>
      <span class="nav-label">工作空间</span>
      <nav aria-label="主要导航">
        <a
          v-for="tab in visibleTabs"
          :key="tab.id"
          :href="`#${tab.id}`"
          :class="{ active: route === tab.id }"
          @click="mobile = false"
          :aria-current="route === tab.id ? 'page' : undefined"
          ><Icon :name="tab.icon" /><span>{{ tab.name }}</span
          ><span v-if="tab.id === 'alerts' && unread" class="nav-count">{{ unread }}</span></a
        >
      </nav>
      <div class="sidebar-bottom">
        <div class="privacy-card">
          <Icon name="shield" :size="22" /><strong>用量透明，内容私密</strong>
          <p>只记录用量元数据<br />对话内容始终留在你的设备</p>
        </div>
        <div class="profile">
          <span class="avatar">{{ data?.me.display_name.slice(0, 1) ?? 'A' }}</span>
          <div>
            <strong>{{ data?.me.display_name ?? '家庭成员' }}</strong
            ><small>{{ data?.me.role === 'admin' ? '家庭管理员' : '家庭成员' }}</small>
          </div>
          <span class="profile-status"></span>
        </div>
      </div>
    </aside>
    <button
      v-if="mobile"
      class="sidebar-scrim"
      aria-label="关闭导航"
      @click="mobile = false"
    ></button>
    <main class="main-content">
      <header class="topbar">
        <button class="icon-button mobile-menu" aria-label="打开导航" @click="mobile = true">
          <Icon name="menu" />
        </button>
        <div class="breadcrumb">
          家庭空间 <span>/</span> {{ tabs.find((t) => t.id === route)?.name }}
        </div>
        <div class="top-actions">
          <span class="live-label" :class="{ demo }"
            ><i></i>{{ demo ? '演示数据' : '家庭共享' }}</span
          ><button class="icon-button" aria-label="查看预警" @click="go('alerts')">
            <Icon name="alerts" /><b v-if="unread" class="notification-dot"></b></button
          ><span class="avatar small">{{ data?.me.display_name.slice(0, 1) ?? 'A' }}</span>
        </div>
      </header>
      <div class="content-wrap">
        <div v-if="demo" class="demo-banner">
          <span>演示模式 · 以下为合成数据，不代表真实用量</span
          ><button @click="enableDemo">连接真实服务 <Icon name="arrow" :size="14" /></button>
        </div>
        <div class="page-heading">
          <div>
            <span class="eyebrow">{{
              route === 'overview' ? 'YOUR FAMILY, AT A GLANCE' : 'AGY FAMILY MONITOR'
            }}</span>
            <h1>{{ tabs.find((t) => t.id === route)?.name }}</h1>
            <p>{{ descriptions[route] }}</p>
          </div>
          <button class="button refresh-button" @click="refresh" :disabled="loading">
            <Icon name="refresh" :size="16" :class="{ spinning: loading }" />刷新数据
          </button>
        </div>
        <div v-if="['overview', 'usage', 'models'].includes(route)" class="filter-bar">
          <div class="range-selector">
            <Icon name="clock" :size="16" /><select
              v-model="range"
              @change="changeRange"
              aria-label="日期范围"
            >
              <option value="7">最近 7 天</option>
              <option value="30">最近 30 天</option>
              <option value="month">本月</option>
              <option value="custom">自定义日期</option>
            </select>
          </div>
          <div class="date-fields">
            <input
              type="date"
              v-model="filters.from_date"
              @input="range = 'custom'"
              aria-label="开始日期"
            /><span>—</span
            ><input
              type="date"
              v-model="filters.to_date"
              @input="range = 'custom'"
              aria-label="结束日期"
            />
          </div>
          <span class="filter-spacer"></span
          ><span class="timezone">{{ data?.summary.timezone ?? 'Asia/Shanghai' }}</span>
        </div>
        <div v-if="error" class="empty-state panel">
          <span class="empty-icon"><Icon name="shield" :size="32" /></span>
          <h2>{{ error }}</h2>
          <p>
            {{
              unauthorized
                ? '通过家庭组登录后，即可查看所有成员的用量。'
                : '请联系管理员完成服务设置，或使用演示数据查看全部功能。'
            }}
          </p>
          <div class="form-row">
            <a v-if="unauthorized" class="button primary" href="/cdn-cgi/access/login"
              >登录家庭空间</a
            ><button class="button" @click="refresh">重试连接</button
            ><button class="button primary" v-if="!demo" @click="enableDemo">查看演示</button>
          </div>
        </div>
        <div v-else-if="!data" class="loading-state" role="status">正在读取家庭用量…</div>
        <template v-else>
          <template v-if="route === 'overview'">
            <div class="stat-grid">
              <article class="stat-card featured">
                <div class="stat-label">
                  今日总 Token <span class="stat-icon"><Icon name="token" :size="18" /></span>
                </div>
                <strong>{{ compact(data.summary.today.total_tokens) }}</strong>
                <div class="stat-footer">
                  <span class="status-dot"></span>全组
                  {{ activeMemberCount || data.members.length }} 位成员的总量
                </div>
              </article>
              <article class="stat-card">
                <div class="stat-label">
                  今日估算费用 <span class="stat-icon"><Icon name="dollar" :size="18" /></span>
                </div>
                <strong>{{ usd(data.summary.today.cost_micro_usd) }}</strong>
                <div class="stat-footer">
                  {{
                    data.summary.today.unpriced_tokens
                      ? `${compact(data.summary.today.unpriced_tokens)} Token 待计价`
                      : 'API 等效美元费用'
                  }}
                </div>
              </article>
              <article class="stat-card">
                <div class="stat-label">
                  本周 Token <span class="stat-icon"><Icon name="usage" :size="18" /></span>
                </div>
                <strong>{{ compact(data.summary.week.total_tokens) }}</strong>
                <div class="stat-footer">家庭时区的自然周</div>
              </article>
              <article class="stat-card">
                <div class="stat-label">
                  本月估算费用 <span class="stat-icon"><Icon name="models" :size="18" /></span>
                </div>
                <strong>{{ usd(data.summary.month.cost_micro_usd) }}</strong>
                <div class="stat-footer">
                  {{
                    data.summary.month.unpriced_tokens
                      ? `另有 ${compact(data.summary.month.unpriced_tokens)} Token 待计价`
                      : '包含已匹配价格的使用记录'
                  }}
                </div>
              </article>
            </div>
            <div class="chart-grid">
              <section class="panel">
                <div class="panel-heading">
                  <div>
                    <h2>家庭使用趋势</h2>
                    <p>所选时间范围的每日用量</p>
                  </div>
                  <div class="segmented">
                    <button
                      :class="{ selected: chartMetric === 'tokens' }"
                      @click="chartMetric = 'tokens'"
                    >
                      Token</button
                    ><button
                      :class="{ selected: chartMetric === 'cost' }"
                      @click="chartMetric = 'cost'"
                    >
                      费用
                    </button>
                  </div>
                </div>
                <Chart :option="trendOption" label="家庭每日 Token 或估算费用趋势" />
                <div class="chart-caption">
                  <span
                    ><i></i
                    >{{
                      chartMetric === 'tokens' ? '家庭每日总 Token' : '已计价 API 等效费用'
                    }}</span
                  ><span
                    >合计
                    {{
                      chartMetric === 'tokens'
                        ? compact(data.summary.selected.total_tokens)
                        : usd(data.summary.selected.cost_micro_usd)
                    }}</span
                  >
                </div>
              </section>
              <section class="panel model-panel">
                <div class="panel-heading">
                  <div>
                    <h2>模型使用分布</h2>
                    <p>所选范围 · 按 Token 统计</p>
                  </div>
                  <button class="icon-button" aria-label="查看模型分析" @click="go('models')">
                    <Icon name="arrow" :size="17" />
                  </button>
                </div>
                <Chart :option="pieOption" label="不同模型的 Token 使用占比" />
                <div class="model-legend">
                  <div v-for="(model, i) in models.slice(0, 4)" :key="model.id">
                    <span
                      ><i :style="{ background: colors[i % colors.length] }"></i
                      >{{ modelName(model.id, model.display) }}</span
                    ><strong>{{ compact(model.tokens) }}</strong>
                  </div>
                  <p v-if="!models.length" class="empty-inline">所选时间范围暂无模型记录</p>
                </div>
              </section>
            </div>
            <div class="bottom-grid">
              <section class="panel ranking-panel">
                <div class="panel-heading">
                  <div>
                    <h2>成员用量</h2>
                    <p>本月家庭成员用量排名</p>
                  </div>
                  <button class="text-button" @click="go('members')">
                    全部成员 <Icon name="arrow" :size="14" />
                  </button>
                </div>
                <div class="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>成员</th>
                        <th>今日 Token</th>
                        <th>本月 Token</th>
                        <th>估算费用</th>
                        <th>设备状态</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr
                        v-for="(member, i) in ranking"
                        :key="member.id"
                        class="clickable"
                        @click="memberDetail = member.id"
                      >
                        <td>
                          <div class="member-cell">
                            <span class="rank-number">{{ String(i + 1).padStart(2, '0') }}</span
                            ><span class="avatar" :class="`avatar-${i % 5}`">{{
                              member.display_name.slice(0, 1)
                            }}</span
                            ><strong>{{ member.display_name }}</strong
                            ><span v-if="member.id === data.me.id" class="you-label">你</span>
                          </div>
                        </td>
                        <td>{{ compact(member.today.total_tokens) }}</td>
                        <td>
                          <div class="usage-bar-cell">
                            <span>{{ compact(member.month.total_tokens) }}</span
                            ><i
                              ><b
                                :style="{
                                  width: `${(member.month.total_tokens / Math.max(1, ranking[0]?.month.total_tokens ?? 1)) * 100}%`,
                                }"
                              ></b
                            ></i>
                          </div>
                        </td>
                        <td>{{ usd(member.month.cost_micro_usd) }}</td>
                        <td>
                          <span
                            class="device-state"
                            :class="{
                              online: member.online && member.status === 'active',
                            }"
                            ><i></i
                            >{{
                              member.status !== 'active'
                                ? '已停用'
                                : member.online
                                  ? '在线'
                                  : '离线'
                            }}</span
                          >
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </section>
              <section class="panel recent-alerts">
                <div class="panel-heading">
                  <div>
                    <h2>最近预警</h2>
                    <p>适度使用，及时提醒</p>
                  </div>
                  <span v-if="unread" class="tag amber">{{ unread }} 条未读</span>
                </div>
                <div
                  v-for="alert in data.monitor.alerts.filter((a) => !a.resolved_at_ms).slice(0, 2)"
                  :key="alert.id"
                  class="recent-alert"
                >
                  <span class="alert-mark"><Icon name="alerts" :size="17" /></span>
                  <div>
                    <strong>{{ alert.message }}</strong>
                    <p>{{ timestamp(alert.created_at_ms) }} · 共享额度待核查</p>
                  </div>
                </div>
                <div v-for="alert in data.alerts.slice(0, 3)" :key="alert.id" class="recent-alert">
                  <span class="alert-mark"><Icon name="alerts" :size="17" /></span>
                  <div>
                    <strong>{{ alert.message }}</strong>
                    <p>
                      {{ timestamp(alert.created_at_ms) }} <span>·</span>
                      {{ alert.acknowledged ? '已读' : '未读' }}
                    </p>
                  </div>
                </div>
                <p
                  v-if="!data.alerts.length && !data.monitor.alerts.some((a) => !a.resolved_at_ms)"
                  class="empty-inline"
                >
                  一切正常，暂无预警
                </p>
                <button class="text-button alert-link" @click="go('alerts')">
                  进入预警中心 <Icon name="arrow" :size="14" />
                </button>
              </section>
            </div>
          </template>
          <template v-if="route === 'members'"
            ><div class="section-heading">
              <span>{{ activeMemberCount }} 位活跃成员 <span class="muted">/ 全组共享查看</span></span
              ><button class="text-button" v-if="data.me.role === 'admin'" @click="go('settings')">
                管理成员 <Icon name="arrow" :size="14" /></button
              ><a v-else class="text-button" href="/downloads/AgyFamilyMonitor.exe" download>
                下载 Windows 客户端 <Icon name="arrow" :size="14" />
              </a>
            </div>
            <div class="member-grid">
              <article
                v-for="(member, i) in data.members"
                :key="member.id"
                class="panel member-card"
              >
                <div class="member-card-top">
                  <span class="avatar large" :class="`avatar-${i}`">{{
                    member.display_name.slice(0, 1)
                  }}</span
                  ><span
                    class="tag"
                    :class="
                      member.status !== 'active' ? 'neutral' : member.online ? 'green' : 'neutral'
                    "
                    >{{
                      member.status !== 'active'
                        ? '已停用'
                        : member.online
                          ? 'Agent 在线'
                          : 'Agent 离线'
                    }}</span
                  >
                </div>
                <h2>
                  {{ member.display_name }}
                  <span v-if="member.id === data.me.id" class="you-label">你</span>
                </h2>
                <p class="muted">{{ member.role === 'admin' ? '家庭管理员' : '家庭成员' }}</p>
                <div class="member-card-stat">
                  <span>今日 Token</span><strong>{{ compact(member.today.total_tokens) }}</strong>
                </div>
                <div class="member-card-details">
                  <div>
                    <span>本周 Token</span><strong>{{ compact(member.week.total_tokens) }}</strong>
                  </div>
                  <div>
                    <span>本月 Token</span><strong>{{ compact(member.month.total_tokens) }}</strong>
                  </div>
                  <div>
                    <span>今日费用</span><strong>{{ usd(member.today.cost_micro_usd) }}</strong>
                  </div>
                  <div>
                    <span>本月费用</span><strong>{{ usd(member.month.cost_micro_usd) }}</strong>
                  </div>
                </div>
                <div class="member-card-bottom">
                  <small>上报于{{ relative(member.last_report_ms) }}</small
                  ><button class="text-button" @click="memberDetail = member.id">
                    查看详情 <Icon name="arrow" :size="14" />
                  </button>
                </div>
              </article></div
          ></template>
          <template v-if="route === 'usage'"
            ><section class="panel">
              <div class="panel-heading usage-heading">
                <div>
                  <h2>用量明细</h2>
                  <p>共 {{ number(data.usage.total) }} 条事件 · 保留四类原始计数</p>
                </div>
                <div class="select-filters">
                  <select v-model="filters.member_id" aria-label="筛选成员">
                    <option value="">全部成员</option>
                    <option v-for="m in data.members" :key="m.id" :value="m.id">
                      {{ m.display_name }}
                    </option></select
                  ><select v-model="filters.model_id" aria-label="筛选模型">
                    <option value="">全部模型</option>
                    <option v-for="m in modelList" :key="m" :value="m">
                      {{ modelName(m) }}
                    </option></select
                  ><select v-model="filters.source" aria-label="筛选来源">
                    <option value="">全部来源</option>
                    <option value="antigravity_cli">CLI</option>
                    <option value="antigravity_ide">IDE</option>
                  </select>
                </div>
              </div>
              <div class="table-scroll">
                <table class="usage-table">
                  <thead>
                    <tr>
                      <th>时间</th>
                      <th>成员 / 模型</th>
                      <th>来源</th>
                      <th>Input</th>
                      <th>Output</th>
                      <th>Cache Read</th>
                      <th>Cache Write</th>
                      <th>总 Token</th>
                      <th>估算费用</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="row in data.usage.items" :key="`${row.member_id}-${row.id}`">
                      <td>{{ timestamp(row.occurred_at_ms) }}</td>
                      <td>
                        <strong>{{ row.display_name }}</strong
                        ><small>{{ modelName(row.model_id, row.model_display) }}</small>
                      </td>
                      <td>
                        <span class="source-tag">{{
                          row.source === 'antigravity_cli' ? 'CLI' : 'IDE'
                        }}</span>
                      </td>
                      <td>{{ number(row.input_tokens) }}</td>
                      <td>{{ number(row.output_tokens) }}</td>
                      <td>{{ number(row.cache_read_tokens) }}</td>
                      <td>{{ number(row.cache_write_tokens) }}</td>
                      <td>
                        <strong>{{ number(row.total_tokens) }}</strong>
                      </td>
                      <td>
                        <span
                          :class="{ unpriced: row.cost_micro_usd === null }"
                          :title="row.catalog_version ?? '未匹配到价格'"
                          >{{ usd(row.cost_micro_usd) }}</span
                        >
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div v-if="!data.usage.items.length" class="empty-inline">所选条件下暂无使用记录</div>
              <div class="pagination">
                <span
                  >第 {{ page }} 页，共 {{ Math.max(1, Math.ceil(data.usage.total / 15)) }} 页</span
                >
                <div>
                  <button class="button" :disabled="page <= 1 || loading" @click="page--">
                    上一页</button
                  ><button
                    class="button"
                    :disabled="page * 15 >= data.usage.total || loading"
                    @click="page++"
                  >
                    下一页
                  </button>
                </div>
              </div>
            </section>
            <div class="privacy-note">
              <Icon name="shield" />
              <p>这里仅显示用量统计，不包含提示词、对话正文或原始会话标识。</p>
            </div></template
          >
          <template v-if="route === 'models'"
            ><div class="stat-grid three">
              <article class="stat-card">
                <div class="stat-label">使用的模型</div>
                <strong>{{ models.length }}</strong>
                <div class="stat-footer">所选范围内的模型分类</div>
              </article>
              <article class="stat-card">
                <div class="stat-label">已计价估算费用</div>
                <strong>{{ usd(data.summary.selected.cost_micro_usd) }}</strong>
                <div class="stat-footer">保留价格目录版本</div>
              </article>
              <article class="stat-card">
                <div class="stat-label">未计价 Token</div>
                <strong>{{ compact(data.summary.selected.unpriced_tokens) }}</strong>
                <div class="stat-footer">待补充价格，不视为免费</div>
              </article>
            </div>
            <section class="panel">
              <div class="panel-heading">
                <div>
                  <h2>模型明细</h2>
                  <p>点击模型，展开成员使用分布</p>
                </div>
                <Icon name="models" />
              </div>
              <div class="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>模型</th>
                      <th>Input</th>
                      <th>Output</th>
                      <th>缓存 Token</th>
                      <th>总 Token</th>
                      <th>估算费用</th>
                      <th>成员数</th>
                    </tr>
                  </thead>
                  <tbody>
                    <template v-for="(model, i) in models" :key="model.id"
                      ><tr
                        class="clickable"
                        @click="expandedModel = expandedModel === model.id ? '' : model.id"
                      >
                        <td>
                          <div class="model-cell">
                            <i :style="{ background: colors[i % colors.length] }"></i
                            ><strong>{{ modelName(model.id, model.display) }}</strong>
                          </div>
                        </td>
                        <td>{{ compact(model.input) }}</td>
                        <td>{{ compact(model.output) }}</td>
                        <td>{{ compact(model.cache) }}</td>
                        <td>
                          <strong>{{ compact(model.tokens) }}</strong>
                        </td>
                        <td>
                          {{ usd(model.cost)
                          }}<small v-if="model.unpriced" class="unpriced"
                            >{{ compact(model.unpriced) }} Token 待计价</small
                          >
                        </td>
                        <td>{{ model.members }}</td>
                      </tr>
                      <tr v-if="expandedModel === model.id" class="expanded-row">
                        <td colspan="7">
                          <div
                            class="member-breakdown"
                            v-for="row in data.models.filter((r) => r.model_id === model.id)"
                            :key="row.member_id"
                          >
                            <span>{{
                              data.members.find((m) => m.id === row.member_id)?.display_name ??
                              '成员'
                            }}</span
                            ><strong>{{ number(row.total_tokens) }} Token</strong
                            ><span>{{ usd(row.cost_micro_usd) }}</span>
                          </div>
                        </td>
                      </tr></template
                    >
                  </tbody>
                </table>
              </div>
              <p v-if="!models.length" class="empty-inline">暂无模型使用记录</p>
            </section></template
          >
          <template v-if="route === 'alerts'">
            <section v-if="data.me.role !== 'admin'" class="panel setting-section">
              <div class="panel-heading">
                <div>
                  <h2>客户端与通知偏好</h2>
                  <p>下载本机采集客户端，或管理你自己的预警提醒开关</p>
                </div>
                <a class="button primary" href="/downloads/AgyFamilyMonitor.exe" download>
                  下载客户端 (.exe)
                </a>
              </div>
              <label class="switch-row"
                ><div>
                  <strong>接收我的预警通知</strong>
                  <small>关闭后，系统不再向你发送个人阈值预警提醒</small>
                </div>
                <input
                  type="checkbox"
                  :checked="!!data.me.notifications_enabled"
                  @change="toggleMyNotifications(($event.target as HTMLInputElement).checked)"
              /></label>
            </section>
            <section class="panel setting-section">
              <div class="panel-heading">
                <div>
                  <h2>共享额度异常</h2>
                  <p>
                    官方额度与全组独立日志对照{{
                      data.me.role === 'admin' ? '，邮件发送记录见设置' : ''
                    }}
                  </p>
                </div>
                <span class="tag" :class="data.monitor.ready ? 'green' : 'amber'">{{
                  !data.monitor.collection_active
                    ? '自动采集已暂停'
                    : data.monitor.ready
                      ? '已启用'
                      : '等待全员绑定'
                }}</span>
              </div>
              <div v-for="alert in data.monitor.alerts" :key="alert.id" class="alert-row">
                <div class="grow">
                  <strong>{{ alert.message }}</strong>
                  <p>
                    {{ timestamp(alert.created_at_ms) }} ·
                    {{ alert.resolved_at_ms ? '已恢复' : '待核查' }}
                  </p>
                  <details>
                    <summary>查看对账依据</summary>
                    <p
                      v-for="[key, value] in Object.entries(JSON.parse(alert.details_json))"
                      :key="key"
                    >
                      {{ key }}：{{ value }}
                    </p>
                  </details>
                </div>
                <span class="tag" :class="alert.resolved_at_ms ? 'neutral' : 'amber'">{{
                  alert.resolved_at_ms ? '已恢复' : '异常'
                }}</span>
              </div>
              <p v-if="!data.monitor.alerts.length" class="empty-inline">
                暂无共享额度异常。已绑定 {{ data.monitor.bound_members }} /
                {{ data.monitor.expected_members }} 人。
              </p>
            </section>
            <section class="panel setting-section">
              <div class="panel-heading">
                <div>
                  <h2>预警规则</h2>
                  <p>绝对 Token 和 API 等效费用阈值，与共享额度对账分别判断</p>
                </div>
                <span class="tag">{{ data.rules.filter((r) => r.enabled).length }} 条生效</span>
              </div>
              <template v-for="rule in data.rules" :key="rule.id">
                <form
                  v-if="editingRuleId === rule.id && data.me.role === 'admin'"
                  class="rule-form rule-edit-form"
                  @submit.prevent="saveEditRule(rule.id)"
                >
                  <select v-model="editRuleForm.scope" aria-label="编辑预警范围">
                    <option value="member">每位成员</option>
                    <option value="family">全家庭</option></select
                  ><select
                    v-if="editRuleForm.scope === 'member'"
                    v-model="editRuleForm.member_id"
                    aria-label="编辑预警指定成员"
                  >
                    <option value="">所有成员</option>
                    <option v-for="m in data.members" :value="m.id" :key="m.id">
                      {{ m.display_name }}
                    </option></select
                  ><select v-model="editRuleForm.period" aria-label="编辑预警周期">
                    <option value="day">每日</option>
                    <option value="week">每周</option>
                    <option value="month">每月</option>
                    <option value="rolling_24h">滚动 24 小时</option></select
                  ><select v-model="editRuleForm.metric" aria-label="编辑预警指标">
                    <option value="tokens">Token</option>
                    <option value="cost_micro_usd">美元费用</option></select
                  ><input
                    v-model.number="editRuleForm.value"
                    type="number"
                    :min="editRuleForm.metric === 'tokens' ? 1 : 0.000001"
                    :step="editRuleForm.metric === 'tokens' ? 1 : 0.000001"
                    aria-label="编辑预警阈值"
                    required
                  /><button class="button primary" type="submit">保存</button
                  ><button class="button" type="button" @click="editingRuleId = ''">取消</button>
                </form>
                <div v-else class="rule-row">
                  <span class="rule-icon"
                    ><Icon :name="rule.metric === 'tokens' ? 'token' : 'dollar'"
                  /></span>
                  <div class="grow">
                    <strong
                      >{{
                        rule.scope === 'family'
                          ? '全家庭'
                          : rule.member_id
                            ? data.members.find((m) => m.id === rule.member_id)?.display_name
                            : '每位成员'
                      }}
                      ·
                      {{
                        { day: '每日', week: '每周', month: '每月', rolling_24h: '滚动 24 小时' }[
                          rule.period
                        ]
                      }}</strong
                    ><small
                      >{{
                        rule.metric === 'tokens'
                          ? `${number(rule.threshold_value)} Token`
                          : usd(rule.threshold_value)
                      }}
                      达到后提醒</small
                    >
                  </div>
                  <div v-if="data.me.role === 'admin'" class="row-actions">
                    <button class="text-button" type="button" @click="startEditRule(rule)">
                      编辑
                    </button>
                    <button
                      class="text-button danger-text"
                      type="button"
                      @click="deleteRule(rule.id)"
                    >
                      删除
                    </button>
                    <button
                      class="toggle"
                      :class="{ on: rule.enabled }"
                      :aria-label="rule.enabled ? '停用规则' : '启用规则'"
                      role="switch"
                      :aria-checked="!!rule.enabled"
                      @click="
                        saveRules(
                          data.rules.map((r) =>
                            r.id === rule.id ? { ...r, enabled: !r.enabled } : r,
                          ),
                        )
                      "
                    >
                      <i></i>
                    </button>
                  </div>
                  <span v-else class="tag">{{ rule.enabled ? '生效中' : '已停用' }}</span>
                </div>
              </template>
              <form v-if="data.me.role === 'admin'" class="rule-form" @submit.prevent="addRule">
                <select v-model="ruleForm.scope" aria-label="预警范围">
                  <option value="member">每位成员</option>
                  <option value="family">全家庭</option></select
                ><select
                  v-if="ruleForm.scope === 'member'"
                  v-model="ruleForm.member_id"
                  aria-label="预警指定成员"
                >
                  <option value="">所有成员</option>
                  <option v-for="m in data.members" :value="m.id" :key="m.id">
                    {{ m.display_name }}
                  </option></select
                ><select v-model="ruleForm.period" aria-label="预警周期">
                  <option value="day">每日</option>
                  <option value="week">每周</option>
                  <option value="month">每月</option>
                  <option value="rolling_24h">滚动 24 小时</option></select
                ><select v-model="ruleForm.metric" aria-label="预警指标">
                  <option value="tokens">Token</option>
                  <option value="cost_micro_usd">美元费用</option></select
                ><input
                  v-model.number="ruleForm.value"
                  type="number"
                  :min="ruleForm.metric === 'tokens' ? 1 : 0.000001"
                  :step="ruleForm.metric === 'tokens' ? 1 : 0.000001"
                  aria-label="预警阈值"
                  required
                /><button class="button primary"><Icon name="plus" :size="16" />添加规则</button>
              </form>
              <p v-if="!data.rules.length" class="empty-inline">
                {{
                  data.me.role === 'admin' ? '暂无预警规则，管理员可以在此添加' : '当前暂无预警规则'
                }}
              </p>
            </section>
            <section class="panel">
              <div class="panel-heading">
                <div>
                  <h2>预警记录</h2>
                  <p>每个自然周期，同一规则与成员只提醒一次</p>
                </div>
                <span class="tag amber">{{ unread }} 条未读</span>
              </div>
              <div v-for="alert in data.alerts" :key="alert.id" class="alert-row">
                <span class="alert-mark"><Icon name="alerts" /></span>
                <div class="grow">
                  <strong>{{ alert.message }}</strong>
                  <p>
                    {{ timestamp(alert.created_at_ms) }} · 当前
                    {{
                      (alert.metric ?? data.rules.find((r) => r.id === alert.rule_id)?.metric) ===
                      'cost_micro_usd'
                        ? usd(alert.value)
                        : number(alert.value)
                    }}
                    / 阈值
                    {{
                      (alert.metric ?? data.rules.find((r) => r.id === alert.rule_id)?.metric) ===
                      'cost_micro_usd'
                        ? usd(alert.threshold_value)
                        : number(alert.threshold_value)
                    }}
                  </p>
                </div>
                <span v-if="alert.acknowledged" class="tag neutral"
                  ><Icon name="check" :size="13" />已读</span
                ><button v-else class="button" @click="ack(alert.id)">标记已读</button>
              </div>
              <p v-if="!data.alerts.length" class="empty-inline">暂无触发记录，家庭使用情况良好</p>
            </section></template
          >
          <Settings
            v-if="route === 'settings' && adminData"
            :data="adminData"
            :demo="demo"
            @reload="refresh"
            @notice="tell"
          />
          <footer class="page-footer">
            <span
              ><Icon name="shield" :size="14" />仅采集使用元数据 · API 等效估算，不是官方账单</span
            ><span
              ><i class="status-dot"></i>最近上报：{{ relative(data.summary.last_report_ms) }}</span
            >
          </footer>
        </template>
      </div>
    </main>
    <div v-if="notice" class="toast-message" role="status">
      <Icon name="check" :size="18" />{{ notice
      }}<button class="icon-button" aria-label="关闭消息" @click="notice = ''">
        <Icon name="close" :size="16" />
      </button>
    </div>
    <div v-if="selectedMember" class="modal-scrim" @click.self="memberDetail = ''">
      <section
        class="panel member-modal"
        role="dialog"
        aria-modal="true"
        :aria-label="`${selectedMember.display_name}的用量详情`"
      >
        <div class="panel-heading">
          <div>
            <h2>{{ selectedMember.display_name }}的用量</h2>
            <p>
              {{ selectedMember.email || (selectedMember.role === 'admin' ? '家庭管理员' : '家庭成员') }}
            </p>
          </div>
          <button class="icon-button" aria-label="关闭详情" @click="memberDetail = ''">
            <Icon name="close" />
          </button>
        </div>
        <div class="member-card-details">
          <div>
            <span>今日 Token</span><strong>{{ number(selectedMember.today.total_tokens) }}</strong>
          </div>
          <div>
            <span>本周 Token</span><strong>{{ number(selectedMember.week.total_tokens) }}</strong>
          </div>
          <div>
            <span>本月 Token</span><strong>{{ number(selectedMember.month.total_tokens) }}</strong>
          </div>
          <div>
            <span>本月估算费用</span><strong>{{ usd(selectedMember.month.cost_micro_usd) }}</strong>
          </div>
        </div>
        <div class="detail-counters">
          <span>Input {{ number(selectedMember.month.input_tokens) }}</span
          ><span>Output {{ number(selectedMember.month.output_tokens) }}</span
          ><span>Cache Read {{ number(selectedMember.month.cache_read_tokens) }}</span
          ><span>Cache Write {{ number(selectedMember.month.cache_write_tokens) }}</span>
        </div>
        <div class="modal-footer">
          <span class="muted">最后上报于{{ relative(selectedMember.last_report_ms) }}</span
          ><button class="button primary" @click="usageFor(selectedMember.id)">
            查看使用明细 <Icon name="arrow" :size="16" />
          </button>
        </div>
      </section>
    </div>
  </div>
</template>
