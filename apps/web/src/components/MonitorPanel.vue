<script setup lang="ts">
import { ref, watch } from 'vue';
import type { MonitorStatus } from '../api/types';
import { request } from '../api/client';
const props = defineProps<{ monitor: MonitorStatus; admin: boolean; demo: boolean }>();
const emit = defineEmits<{ reload: []; notice: [message: string] }>();
const copyConfig = (value: MonitorStatus['config']): MonitorStatus['config'] =>
  JSON.parse(JSON.stringify(value));
const statusLabels: Record<string, string> = {
  sent: '已提交发送',
  pending: '等待重试',
  sending: '正在发送',
  failed: '发送失败',
  cancelled: '已取消',
};
const form = ref(copyConfig(props.monitor.config)),
  busy = ref(false),
  dirty = ref(false);
watch(
  () => props.monitor.config,
  (value) => {
    if (!dirty.value) form.value = copyConfig(value);
  },
);
const usd = (v: number) => `$${(v / 1e6).toFixed(2)}`;
const when = (v: number) => new Date(v).toLocaleString('zh-CN');
async function act(run: () => Promise<void>) {
  busy.value = true;
  try {
    await run();
  } catch (e) {
    emit('notice', e instanceof Error ? e.message : '操作未成功');
  } finally {
    busy.value = false;
  }
}
async function save() {
  await act(async () => {
    if (!props.demo) await request('/monitor/settings', 'PUT', form.value);
    else {
      Object.assign(props.monitor.config, copyConfig(form.value));
      props.monitor.ready =
        form.value.enabled && props.monitor.bound_members >= form.value.expected_members;
    }
    dirty.value = false;
    emit('notice', '共享额度规则已保存，重新建立校准基线');
    if (!props.demo) emit('reload');
  });
}
async function test() {
  await act(async () => {
    if (props.demo) {
      emit('notice', '演示模式不会发送邮件');
      return;
    }
    const result = await request<{ status: string }>('/monitor/test-email', 'POST');
    emit(
      'notice',
      result.status === 'sent'
        ? 'Cloudflare 已接收测试邮件，请检查收件箱'
        : '发送未成功，已保留在重试队列',
    );
    emit('reload');
  });
}
async function reset() {
  await act(async () => {
    if (!props.demo) await request('/monitor/reset-calibration', 'POST');
    else
      for (const bucket of props.monitor.buckets) {
        bucket.samples = 0;
        bucket.calibrated = false;
        bucket.capacity_micro_usd = bucket.initial_capacity_micro_usd;
      }
    emit('notice', '已重新开始校准，历史记录保留');
    if (!props.demo) emit('reload');
  });
}
async function retry() {
  await act(async () => {
    if (!props.demo) await request('/monitor/retry-email', 'POST');
    emit('notice', '已重新尝试发送失败邮件');
    emit('reload');
  });
}
</script>
<template>
  <section class="panel setting-section monitor-panel">
    <div class="panel-heading">
      <div>
        <h2>共享额度与异常监控</h2>
        <p>六台设备分别采集，服务端合计，对照同一份官方额度</p>
      </div>
      <span class="tag" :class="monitor.ready ? 'green' : 'amber'">{{
        monitor.ready
          ? '监控已启用'
          : `等待绑定 ${monitor.bound_members}/${monitor.config.expected_members}`
      }}</span>
    </div>
    <div class="monitor-summary">
      <span
        ><strong>{{ monitor.online_members }}</strong> 人客户端在线</span
      ><span
        ><strong>{{ monitor.bound_members }}</strong> 人已绑定</span
      ><span>一个共享额度池 · 不累加相同的官方读数</span>
    </div>
    <p class="monitor-explainer">
      将全组同期的 API 等效费用除以官方额度下降比例，估计满额金额。达到
      {{ monitor.config.calibration_samples }}
      个有效样本后，再判断非零用量的金额缺口；重置、补传、读数冲突和价格缺失会暂停校准。
    </p>
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>额度档位</th>
            <th>官方剩余</th>
            <th>初始估值</th>
            <th>校准估值</th>
            <th>样本与状态</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="bucket in monitor.buckets" :key="bucket.id">
            <td>{{ bucket.name }}</td>
            <td>
              {{
                bucket.latest
                  ? `${(bucket.latest.remaining_ppm / 10000).toFixed(1)}%`
                  : '尚无有效读数'
              }}<small v-if="bucket.latest">{{ when(bucket.latest.observed_at_ms) }}</small>
            </td>
            <td>{{ usd(bucket.initial_capacity_micro_usd) }}</td>
            <td>{{ usd(bucket.capacity_micro_usd) }}</td>
            <td>
              <span class="tag" :class="bucket.calibrated ? 'green' : 'neutral'"
                >{{ bucket.calibrated ? '已校准' : '校准中' }} · {{ bucket.samples }} 个样本</span
              >
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p class="monitor-explainer">
      5
      小时和每周是同一消耗的不同限制，金额不能相加。在线只代表客户端正在连接，电脑闲置也可能没有新用量。以上为估算，异常提醒用于核查。
    </p>
    <p v-if="!monitor.buckets.some((b) => b.latest)" class="monitor-explainer">
      请在至少一台成员电脑安装并登录官方 Antigravity CLI，以读取共享额度。所有成员请使用 0.2.0
      客户端；没有额度读数时仍可统计 Token。
    </p>
    <template v-if="admin">
      <div class="setting-row">
        <div class="grow">
          <strong>告警邮件</strong
          ><small v-if="monitor.email.addresses"
            >{{ monitor.email.addresses.from }} → {{ monitor.email.addresses.to }}</small
          ><small v-else>发送地址尚未配置</small>
        </div>
        <span class="tag" :class="monitor.email.configured ? 'green' : 'amber'">{{
          monitor.email.configured ? '已配置' : '待配置'
        }}</span
        ><button
          class="button"
          @click="test"
          :disabled="busy || (!demo && !monitor.email.configured)"
        >
          发送测试邮件
        </button>
      </div>
      <div v-if="monitor.email.delivery?.length" class="monitor-mail-state">
        <span v-for="row in monitor.email.delivery" :key="row.status"
          >{{ statusLabels[row.status] ?? row.status }}：{{ row.count }}</span
        ><button
          v-if="monitor.email.delivery.some((r) => r.status === 'failed')"
          class="text-button"
          @click="retry"
          :disabled="busy"
        >
          重试失败邮件
        </button>
      </div>
      <form class="monitor-form" @submit.prevent="save" @input="dirty = true">
        <label class="monitor-switch"
          ><input type="checkbox" v-model="form.enabled" />启用全员绑定后的自动监控</label
        >
        <label
          >预期人数（含管理员）<input
            type="number"
            min="1"
            max="6"
            v-model.number="form.expected_members"
            required
        /></label>
        <label
          >无新用量等待（分钟）<input
            type="number"
            min="15"
            max="1440"
            v-model.number="form.idle_minutes"
            required
        /></label>
        <label
          >补传等待（分钟）<input
            type="number"
            min="5"
            max="60"
            v-model.number="form.grace_minutes"
            required
        /></label>
        <label
          >缺口比例（%）<input
            type="number"
            min="10"
            max="90"
            v-model.number="form.gap_percent"
            required
        /></label>
        <label
          >最小金额缺口（美元）<input
            type="number"
            min="0.1"
            max="10000"
            step="0.1"
            :value="form.min_gap_micro_usd / 1e6"
            @input="
              form.min_gap_micro_usd = Math.round(
                Number(($event.target as HTMLInputElement).value) * 1e6,
              )
            "
            required
        /></label>
        <label
          >重复邮件间隔（分钟）<input
            type="number"
            min="60"
            max="1440"
            v-model.number="form.cooldown_minutes"
            required
        /></label>
        <label v-for="bucket in monitor.buckets" :key="bucket.id"
          >{{ bucket.name }} 初始美元估值<input
            type="number"
            min="1"
            max="10000"
            step="1"
            :value="form.capacities[bucket.id] / 1e6"
            @input="
              form.capacities[bucket.id] = Math.round(
                Number(($event.target as HTMLInputElement).value) * 1e6,
              )
            "
            required
        /></label>
        <div class="monitor-form-actions">
          <button class="button primary" :disabled="busy">保存监控规则</button
          ><button type="button" class="button" @click="reset" :disabled="busy">重新校准</button>
        </div>
      </form>
    </template>
  </section>
</template>
<style scoped>
.monitor-summary {
  display: flex;
  gap: 26px;
  flex-wrap: wrap;
  padding: 4px 26px 14px;
  color: var(--muted);
  font-size: 12px;
}
.monitor-summary strong {
  color: var(--green);
  font-size: 23px;
  margin-right: 5px;
}
.monitor-explainer {
  margin: 0;
  padding: 0 26px 20px;
  font-size: 11px;
  line-height: 1.9;
  color: var(--muted);
}
td small {
  display: block;
  margin-top: 5px;
}
.monitor-form {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 18px;
  padding: 24px 26px;
  border-top: 1px solid var(--line);
}
label {
  font-size: 11px;
  display: flex;
  flex-direction: column;
  gap: 9px;
  color: var(--muted);
}
input:not([type='checkbox']) {
  min-width: 0;
  width: 100%;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 10px;
  color: var(--text);
  background: var(--surface);
}
.monitor-switch {
  grid-column: 1/-1;
  flex-direction: row;
  align-items: center;
}
.monitor-form-actions {
  grid-column: 1/-1;
  display: flex;
  gap: 12px;
}
.monitor-mail-state {
  display: flex;
  gap: 15px;
  flex-wrap: wrap;
  padding: 4px 26px 20px;
  color: var(--muted);
  font-size: 11px;
}
@media (max-width: 760px) {
  .monitor-form {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    padding: 18px;
  }
  .monitor-summary,
  .monitor-explainer,
  .monitor-mail-state {
    padding-left: 18px;
    padding-right: 18px;
  }
  .setting-row {
    flex-wrap: wrap;
  }
}
@media (max-width: 420px) {
  .monitor-form {
    grid-template-columns: 1fr;
  }
}
</style>
