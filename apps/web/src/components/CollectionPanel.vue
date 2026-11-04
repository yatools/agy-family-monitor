<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from 'vue';
import { request } from '../api/client';
import type { CollectionConfig, CollectionStatus } from '../api/types';
const props = defineProps<{ collection: CollectionStatus; demo: boolean }>();
const emit = defineEmits<{
  reload: [];
  notice: [message: string];
  changed: [config: CollectionConfig];
}>();
const state = ref(props.collection),
  enabled = ref(props.collection.config.enabled),
  minutes = ref(props.collection.config.interval_seconds / 60),
  dirty = ref(false),
  busy = ref(false);
let timer: ReturnType<typeof setInterval> | undefined;
let lastPoll = 0;
watch(
  () => props.collection,
  (value) => {
    state.value = value;
    if (!dirty.value) {
      enabled.value = value.config.enabled;
      minutes.value = value.config.interval_seconds / 60;
    }
  },
);
const when = (at: number | null) => (at ? new Date(at).toLocaleString('zh-CN') : '尚未采集');
const statuses: Record<string, string> = {
  pending: '等待客户端执行',
  completed: '采集完成',
  failed: '采集未完整完成',
  expired: '已过期，请重试',
};
async function refresh() {
  if (!props.demo) {
    state.value = await request<CollectionStatus>('/collection');
    lastPoll = Date.now();
  }
}
async function act(fn: () => Promise<void>) {
  busy.value = true;
  try {
    await fn();
  } catch (e) {
    emit('notice', e instanceof Error ? e.message : '操作未成功');
  } finally {
    busy.value = false;
  }
}
async function save() {
  await act(async () => {
    const config = { enabled: enabled.value, interval_seconds: minutes.value * 60 };
    if (!props.demo) await request('/collection/settings', 'PUT', config);
    state.value.config = config;
    if (props.demo) {
      for (const device of state.value.devices) {
        device.effective_enabled = config.enabled;
        device.effective_interval_seconds = config.interval_seconds;
      }
    }
    emit('changed', config);
    dirty.value = false;
    emit(
      'notice',
      enabled.value
        ? '自动采集设置已保存，在线客户端约一分钟内生效'
        : '已暂停自动采集；仍可手动采集一次',
    );
    if (!props.demo) {
      await refresh();
      emit('reload');
    }
  });
}
async function run(deviceId?: string) {
  await act(async () => {
    if (props.demo) {
      for (const d of state.value.devices.filter(
        (d) => d.supported && (!deviceId || d.id === deviceId),
      )) {
        d.last_scan_at_ms = Date.now();
        d.last_request = {
          id: crypto.randomUUID(),
          status: 'completed',
          requested_at_ms: Date.now(),
          acknowledged_at_ms: Date.now(),
        };
      }
    } else {
      await request('/collection/run', 'POST', deviceId ? { device_id: deviceId } : {});
      await refresh();
    }
    emit(
      'notice',
      props.demo
        ? '演示采集完成，没有读取真实日志'
        : '已下发一次采集指令，在线客户端约一分钟内执行',
    );
  });
}
onMounted(() => {
  timer = setInterval(() => {
    if (!document.hidden && !busy.value) {
      const waiting = state.value.devices.some(
        (d) =>
          d.last_request?.status === 'pending' ||
          (d.online &&
            d.supported &&
            (d.effective_enabled !== state.value.config.enabled ||
              d.effective_interval_seconds !== state.value.config.interval_seconds)),
      );
      if (waiting || Date.now() - lastPoll >= 60000) void refresh().catch(() => {});
    }
  }, 15000);
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});
</script>
<template>
  <section class="panel setting-section">
    <div class="panel-heading">
      <div>
        <h2>采集频率与开关</h2>
        <p>仅管理员可控制所有成员的采集；默认每 5 分钟一次</p>
      </div>
      <span class="tag" :class="state.config.enabled ? 'green' : 'amber'">{{
        state.config.enabled ? '自动采集中' : '仅手动采集'
      }}</span>
    </div>
    <form class="form-row collection-form" @submit.prevent="save" @input="dirty = true">
      <label
        ><input v-model="enabled" type="checkbox" aria-label="启用自动采集" :disabled="busy" />
        启用自动采集</label
      >
      <label
        >间隔（分钟）<input
          v-model.number="minutes"
          type="number"
          min="1"
          max="60"
          step="1"
          aria-label="自动采集间隔（分钟）"
          required
          :disabled="busy"
      /></label>
      <button class="button primary" :disabled="busy">保存采集设置</button>
      <button
        type="button"
        class="button"
        :disabled="busy || !state.devices.some((d) => d.supported)"
        @click="run()"
      >
        全员手动采集一次
      </button>
    </form>
    <p class="collection-hint">
      关闭自动采集后不再定时读取新用量，仍可手动触发。轻量心跳保留，方便查看在线状态与接收指令；已采集数据会继续补传。离线指令保留
      15 分钟。
    </p>
    <p class="collection-hint">
      设置约一分钟内生效；当前一轮会完成。采集间隔越长，统计与对账越晚更新，监控会等待至少两轮采集，暂停期间不因无新用量发出异常邮件。
    </p>
    <div v-for="device in state.devices" :key="device.id" class="setting-row">
      <div class="grow">
        <strong>{{ device.display_name }} · {{ device.device_label }}</strong
        ><small
          >{{ device.online ? '在线' : '离线' }} · 最近采集：{{ when(device.last_scan_at_ms) }} ·
          待上传 {{ device.pending_events }} 条</small
        ><small>{{
          device.supported
            ? device.effective_enabled === null
              ? '等待同步设置'
              : device.effective_enabled
                ? '客户端自动采集中'
                : '客户端已暂停自动采集'
            : '请升级至 0.3.0，以接收采集控制'
        }}</small
        ><small v-if="device.last_request"
          >{{ statuses[device.last_request.status] }} ·
          {{
            when(device.last_request.acknowledged_at_ms ?? device.last_request.requested_at_ms)
          }}</small
        >
      </div>
      <button
        class="button"
        :disabled="busy || !device.supported || device.last_request?.status === 'pending'"
        @click="run(device.id)"
      >
        手动采集一次
      </button>
    </div>
    <p v-if="!state.devices.length" class="empty-inline">
      绑定新版客户端后，可在此查看采集状态并下发指令。
    </p>
  </section>
</template>
