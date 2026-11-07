<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import AddMemberForm from '../components/AddMemberForm.vue';
import CollectionPanel from '../components/CollectionPanel.vue';
import MonitorPanel from '../components/MonitorPanel.vue';
import Icon from '../components/Icon.vue';
import { request } from '../api/client';
import type { AdminSnapshot, CollectionConfig, Member } from '../api/types';
const props = defineProps<{ data: AdminSnapshot; demo: boolean }>();
const emit = defineEmits<{ reload: []; notice: [message: string] }>();
const busy = ref(false),
  code = ref(''),
  selected = ref(props.data.members.find((m) => m.status === 'active')?.id ?? '');
const addMemberAt = ref<'family' | 'binding' | null>(null);
const activeMembers = computed(() => props.data.members.filter((m) => m.status === 'active'));
const ordinaryMembers = computed(() => activeMembers.value.filter((m) => m.role === 'member'));
const bindingMember = computed(() => activeMembers.value.find((m) => m.id === selected.value));
const roleName = (role: Member['role']) => (role === 'admin' ? '管理员' : '普通成员');
function collectionChanged(config: CollectionConfig) {
  if (props.demo) {
    props.data.monitor.collection_active = config.enabled;
    props.data.settings.monitor.collection_active = config.enabled;
  }
}
watch(selected, () => {
  code.value = '';
});
watch(
  () => props.data.members,
  (members) => {
    const active = members.filter((m) => m.status === 'active');
    if (!active.some((m) => m.id === selected.value)) selected.value = active[0]?.id ?? '';
  },
);
const price = ref({
  model_id: '',
  input: 0,
  output: 0,
  read: 0,
  write: 0,
  version: `custom-${new Date().toISOString().slice(0, 10)}`,
  source: '',
  effective: new Date().toISOString().slice(0, 16),
});
const money = (n: number) => `$${(n / 1e6).toLocaleString('en-US', { maximumFractionDigits: 4 })}`;
const history = ref(false);
const visiblePrices = computed(() => {
  if (history.value) return props.data.settings.prices;
  const latest = new Map<string, AdminSnapshot['settings']['prices'][number]>();
  for (const p of [...props.data.settings.prices].sort(
    (a, b) =>
      b.effective_from - a.effective_from ||
      (b.catalog_revision ?? 0) - (a.catalog_revision ?? 0) ||
      b.catalog_version.localeCompare(a.catalog_version),
  )) {
    if (p.effective_from <= Date.now() && !latest.has(p.model_id)) latest.set(p.model_id, p);
  }
  return [
    ...latest.values(),
    ...props.data.settings.prices.filter((p) => p.effective_from > Date.now()),
  ];
});
async function act(action: () => Promise<void>) {
  busy.value = true;
  try {
    await action();
  } catch (e) {
    emit('notice', e instanceof Error ? e.message : '操作未成功，请重试');
  } finally {
    busy.value = false;
  }
}
async function preference() {
  await act(async () => {
    if (!props.demo)
      await request('/preferences', 'PUT', {
        notifications_enabled: props.data.settings.notifications_enabled,
      });
    emit('notice', '通知偏好已保存');
  });
}
async function saveMember(member: Member) {
  const display_name = member.display_name.trim();
  const email = (member.email ?? '').trim().toLowerCase();
  if (!display_name || !email) return;
  await act(async () => {
    if (!props.demo) await request(`/members/${member.id}`, 'PATCH', { display_name, email });
    member.display_name = display_name;
    member.email = email;
    emit('notice', '成员信息已保存');
    if (!props.demo) emit('reload');
  });
}
async function toggleMemberStatus(member: Member) {
  if (member.role === 'admin') return;
  const nextStatus = member.status === 'active' ? 'inactive' : 'active';
  if (
    nextStatus === 'inactive' &&
    !window.confirm(
      '停用后将释放家庭名额，并自动撤销该成员的设备与未使用的绑定码，历史用量统计仍会保留。确认停用？',
    )
  )
    return;
  await act(async () => {
    if (nextStatus === 'active' && activeMembers.value.length >= 6)
      throw new Error('家庭成员人数已达 6 人上限');
    if (!props.demo) await request(`/members/${member.id}`, 'PATCH', { status: nextStatus });
    member.status = nextStatus;
    if (nextStatus === 'inactive') {
      member.online = false;
      member.device_count = 0;
      for (const d of props.data.settings.devices) {
        if (d.member_id === member.id && !d.revoked_at_ms) d.revoked_at_ms = Date.now();
      }
      if (selected.value === member.id) selected.value = activeMembers.value[0]?.id ?? '';
    }
    emit(
      'notice',
      nextStatus === 'inactive'
        ? `已停用成员 ${member.display_name}`
        : `已重新启用成员 ${member.display_name}`,
    );
    if (!props.demo) emit('reload');
  });
}
async function addMember(draft: { display_name: string; email: string }) {
  await act(async () => {
    if (activeMembers.value.length >= 6) throw new Error('家庭成员人数已达 6 人上限');
    const added = props.demo
      ? { id: crypto.randomUUID() }
      : await request<{ id: string }>('/members', 'POST', { ...draft, role: 'member' });
    const empty = {
      total_tokens: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_micro_usd: 0,
      unpriced_tokens: 0,
      events: 0,
    };
    props.data.members.push({
      ...draft,
      id: added.id,
      role: 'member',
      status: 'active',
      notifications_enabled: 1,
      today: { ...empty },
      week: { ...empty },
      month: { ...empty },
      online: false,
      device_count: 0,
      last_report_ms: null,
    });
    selected.value = added.id;
    addMemberAt.value = null;
    emit('notice', `已添加普通成员 ${draft.display_name}，请生成专属绑定码`);
    if (!props.demo) emit('reload');
  });
}
async function enroll() {
  await act(async () => {
    code.value = '';
    if (props.demo) {
      code.value = Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map((x) => x.toString(16).padStart(2, '0'))
        .join('');
    } else {
      code.value = (
        await request<{ code: string }>('/enrollments', 'POST', { member_id: selected.value })
      ).code;
    }
    emit('notice', '绑定码仅本次显示，15 分钟内有效');
  });
}
async function revoke(id: string) {
  if (!window.confirm('撤销后，这台设备将无法继续上传。确认撤销？')) return;
  await act(async () => {
    if (!props.demo) await request(`/devices/${id}`, 'DELETE');
    const device = props.data.settings.devices.find((d) => d.id === id);
    if (device) device.revoked_at_ms = Date.now();
    emit('notice', '设备已撤销');
  });
}
async function saveTimezone() {
  await act(async () => {
    new Intl.DateTimeFormat('zh-CN', { timeZone: props.data.settings.timezone }).format();
    if (!props.demo) await request('/settings', 'PUT', { timezone: props.data.settings.timezone });
    emit('notice', '家庭时区已保存');
    if (!props.demo) emit('reload');
  });
}
async function addPrice() {
  await act(async () => {
    const p = price.value;
    const value = {
      model_id: p.model_id,
      input_price: Math.round(p.input * 1e6),
      output_price: Math.round(p.output * 1e6),
      cache_read_price: Math.round(p.read * 1e6),
      cache_write_price: Math.round(p.write * 1e6),
      effective_from: Date.parse(`${p.effective}Z`),
      catalog_version: p.version,
      source: p.source,
    };
    if (!props.demo) await request('/prices', 'POST', value);
    else props.data.settings.prices.unshift({ ...value, id: crypto.randomUUID() });
    emit('notice', '价格版本已添加，已计价历史保持原版本');
    if (!props.demo) emit('reload');
  });
}
async function reprice() {
  await act(async () => {
    let after = '',
      count = 0;
    if (!props.demo) {
      for (let i = 0; i < 1000; i++) {
        const result = await request<{ updated: number; next_cursor: string; has_more: boolean }>(
          '/reprice',
          'POST',
          { after },
        );
        count += result.updated;
        if (!result.has_more) break;
        after = result.next_cursor;
      }
    }
    emit(
      'notice',
      props.demo ? '演示模式：历史未计价补算操作已验证' : `已补算 ${count} 条未计价事件`,
    );
    if (!props.demo) emit('reload');
  });
}
async function copy() {
  try {
    await navigator.clipboard.writeText(code.value);
    emit('notice', '绑定码已复制');
  } catch {
    emit('notice', '可手动选择并复制下方绑定码');
  }
}
</script>
<template>
  <CollectionPanel
    :collection="data.settings.collection"
    :demo="demo"
    @changed="collectionChanged"
    @reload="emit('reload')"
    @notice="emit('notice', $event)"
  />
  <MonitorPanel
    :monitor="data.settings.monitor"
    :admin="data.me.role === 'admin'"
    :demo="demo"
    @reload="emit('reload')"
    @notice="emit('notice', $event)"
  />
  <section class="panel setting-section">
    <div class="panel-heading">
      <div>
        <h2>Windows 客户端</h2>
        <p>下载同一个 EXE，使用绑定码连接你的电脑</p>
      </div>
      <a
        class="button primary"
        :href="demo ? undefined : '/downloads/AgyFamilyMonitor.exe'"
        :download="!demo"
        @click="demo && emit('notice', '当前是演示模式；请登录实际站点下载客户端')"
        >下载客户端 ↓</a
      >
    </div>
    <label class="switch-row"
      ><span><strong>本地预警通知</strong><small>超过阈值时提醒，站内记录始终保留</small></span
      ><input
        v-model="data.settings.notifications_enabled"
        type="checkbox"
        role="switch"
        @change="preference"
        :disabled="busy"
    /></label>
  </section>
  <template v-if="data.me.role === 'admin'">
    <section class="panel setting-section">
      <div class="panel-heading">
        <div>
          <h2>家庭成员</h2>
          <p>最多 6 位活跃成员，所有成员共享查看家庭用量</p>
        </div>
        <span class="tag">{{ activeMembers.length }} / 6</span>
      </div>
      <div v-for="member in data.members" :key="member.id" class="setting-row">
        <span class="avatar">{{ member.display_name.slice(0, 1) }}</span
        ><input
          v-model="member.display_name"
          aria-label="成员名称"
          maxlength="160"
          :disabled="busy"
        /><input
          v-model="member.email"
          type="email"
          class="member-email-input"
          aria-label="成员邮箱"
          maxlength="254"
          :disabled="busy"
        /><span class="tag">{{ roleName(member.role) }}</span
        ><span v-if="member.status !== 'active'" class="tag neutral">已停用</span>
        <div class="row-actions">
          <button
            class="text-button"
            @click="saveMember(member)"
            :disabled="busy || !member.display_name.trim() || !(member.email ?? '').trim()"
          >
            保存
          </button>
          <button
            v-if="member.role !== 'admin'"
            class="text-button"
            :class="{ 'danger-text': member.status === 'active' }"
            :disabled="busy || (member.status !== 'active' && activeMembers.length >= 6)"
            @click="toggleMemberStatus(member)"
          >
            {{ member.status === 'active' ? '停用' : '启用' }}
          </button>
        </div>
      </div>
      <div class="form-row">
        <button
          class="button primary"
          :disabled="busy || activeMembers.length >= 6"
          @click="addMemberAt = 'family'"
        >
          <Icon name="plus" :size="16" />新增普通成员</button
        ><small class="muted">普通成员可查看全组用量并管理个人通知，不能修改家庭配置。</small>
      </div>
      <AddMemberForm
        v-if="addMemberAt === 'family'"
        :busy="busy"
        @submit="addMember"
        @cancel="addMemberAt = null"
      />
      <p class="muted" style="font-size: 10px; padding: 8px 23px 12px">
        新成员使用添加的邮箱验证码登录，网站仅允许活动成员查看。停用成员后将释放名额并保留历史统计。
      </p>
    </section>
    <section class="panel setting-section">
      <div class="panel-heading">
        <div>
          <h2>设备绑定</h2>
          <p>选择具体成员，生成该成员专属的绑定码</p>
        </div>
        <Icon name="shield" />
      </div>
      <div class="form-row">
        <select v-model="selected" aria-label="绑定成员" :disabled="busy">
          <option v-for="member in activeMembers" :key="member.id" :value="member.id">
            {{ member.display_name }}（{{ roleName(member.role) }}）
          </option></select
        ><button class="button primary" @click="enroll" :disabled="busy || !bindingMember">
          生成绑定码
        </button>
        <button
          class="button"
          :disabled="busy || activeMembers.length >= 6"
          @click="addMemberAt = 'binding'"
        >
          <Icon name="plus" :size="16" />新增普通成员
        </button>
        <small class="muted">15 分钟有效 · 仅能使用一次</small>
      </div>
      <p v-if="!ordinaryMembers.length" class="empty-inline">
        目前只有管理员，还没有普通成员。点击“新增普通成员”填写姓名和登录邮箱，再为其绑定设备。
      </p>
      <AddMemberForm
        v-if="addMemberAt === 'binding'"
        :busy="busy"
        @submit="addMember"
        @cancel="addMemberAt = null"
      />
      <div v-if="code" class="code-box">
        <strong
          >{{ bindingMember?.display_name }}（{{
            bindingMember ? roleName(bindingMember.role) : ''
          }}）的{{ demo ? '演示' : '一次性' }}绑定码</strong
        >
        <small>请只发给这位成员，与同一个 EXE 一起使用；关闭后不再显示。</small>
        <code>{{ code }}</code
        ><button class="text-button" @click="copy">复制绑定码</button>
      </div>
      <div v-for="device in data.settings.devices" :key="device.id" class="setting-row">
        <Icon name="models" />
        <div class="grow">
          <strong>{{ device.device_label }}</strong
          ><small
            >{{ device.display_name }} · {{ device.agent_version ?? '尚未上报版本' }} · 待上传
            {{ device.pending_events ?? 0 }} 条</small
          >
        </div>
        <span class="tag" :class="device.revoked_at_ms ? 'neutral' : 'green'">{{
          device.revoked_at_ms ? '已撤销' : '已绑定'
        }}</span
        ><button
          v-if="!device.revoked_at_ms"
          class="text-button danger-text"
          :disabled="busy"
          @click="revoke(device.id)"
        >
          撤销
        </button>
      </div>
      <p v-if="!data.settings.devices.length" class="empty-inline">还没有绑定设备</p>
    </section>
    <section class="panel setting-section">
      <div class="panel-heading">
        <div>
          <h2>家庭时区</h2>
          <p>今日、本周、本月及预警统一使用此时区</p>
        </div>
        <Icon name="clock" />
      </div>
      <form class="form-row" @submit.prevent="saveTimezone">
        <input
          v-model="data.settings.timezone"
          list="timezones"
          aria-label="家庭时区"
          required
        /><datalist id="timezones">
          <option>Asia/Shanghai</option>
          <option>UTC</option>
          <option>America/New_York</option>
          <option>Europe/London</option></datalist
        ><button class="button" :disabled="busy">保存时区</button>
      </form>
    </section>
    <section class="panel setting-section">
      <div class="panel-heading">
        <div>
          <h2>模型价格</h2>
          <p>美元 / 百万 Token · 新增价格保留历史版本</p>
        </div>
        <button class="button" @click="reprice" :disabled="busy">补算未计价记录</button>
      </div>
      <form class="price-form" @submit.prevent="addPrice">
        <label
          >模型 ID<input v-model="price.model_id" required placeholder="gemini-3.8-flash" /></label
        ><label>版本<input v-model="price.version" required /></label
        ><label
          >Input ($/1M)<input
            v-model.number="price.input"
            type="number"
            min="0"
            step="0.000001"
            required /></label
        ><label
          >Output ($/1M)<input
            v-model.number="price.output"
            type="number"
            min="0"
            step="0.000001"
            required /></label
        ><label
          >Cache Read ($/1M)<input
            v-model.number="price.read"
            type="number"
            min="0"
            step="0.000001"
            required /></label
        ><label
          >Cache Write ($/1M)<input
            v-model.number="price.write"
            type="number"
            min="0"
            step="0.000001"
            required /></label
        ><label
          >生效时间（UTC）<input v-model="price.effective" type="datetime-local" required /></label
        ><label
          >价格来源<input
            v-model="price.source"
            type="url"
            pattern="https://.*"
            placeholder="https://…"
            required /></label
        ><button class="button primary" :disabled="busy">添加价格版本</button>
      </form>
      <label class="form-row"><input type="checkbox" v-model="history" /> 显示历史价格版本</label>
      <p class="empty-inline">
        标准文本推理估算；Claude 缓存写入按 5 分钟档。不含缓存存储、搜索工具或其他附加费。
      </p>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>模型</th>
              <th>Input</th>
              <th>Output</th>
              <th>Cache Read</th>
              <th>Cache Write</th>
              <th>版本 / 来源</th>
              <th>生效状态（UTC）</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in visiblePrices" :key="p.id">
              <td>{{ p.model_id }}</td>
              <td>{{ money(p.input_price) }}</td>
              <td>{{ money(p.output_price) }}</td>
              <td>{{ money(p.cache_read_price) }}</td>
              <td>{{ money(p.cache_write_price) }}</td>
              <td>
                <a :href="p.source" target="_blank" rel="noopener noreferrer"
                  >{{ p.catalog_version }} ↗</a
                >
              </td>
              <td>
                {{ p.effective_from > Date.now() ? '预定生效' : '已生效'
                }}<small>{{
                  p.effective_from
                    ? new Date(p.effective_from).toISOString().slice(0, 10)
                    : '当前参考基线'
                }}</small>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="!data.settings.prices.length" class="empty-inline">
        暂无价格版本。未知价格的 Token 会正常计入，费用保持未计价。
      </p>
    </section>
  </template>
  <section class="privacy-note">
    <Icon name="shield" />
    <p>客户端仅上传脱敏的用量元数据。会话正文、提示词和 Google 凭据始终留在成员的电脑上。</p>
  </section>
</template>
