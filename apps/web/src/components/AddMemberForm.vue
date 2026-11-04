<script setup lang="ts">
import { ref, onMounted } from 'vue';
defineProps<{ busy: boolean }>();
const emit = defineEmits<{
  submit: [draft: { display_name: string; email: string }];
  cancel: [];
}>();
const name = ref(''),
  email = ref(''),
  nameInput = ref<HTMLInputElement | null>(null);
onMounted(() => nameInput.value?.focus());
function submit() {
  emit('submit', { display_name: name.value.trim(), email: email.value.trim().toLowerCase() });
}
</script>
<template>
  <form class="member-create-form" @submit.prevent="submit">
    <div>
      <strong>新增普通成员</strong>
      <p>角色固定为普通成员：可以看全组统计，不能查看或修改设置。</p>
    </div>
    <div class="member-create-fields">
      <label
        >成员姓名<input
          ref="nameInput"
          v-model="name"
          aria-label="新成员名称"
          maxlength="160"
          required
          :disabled="busy"
      /></label>
      <label
        >登录邮箱<input
          v-model="email"
          aria-label="新成员邮箱"
          type="email"
          maxlength="254"
          required
          :disabled="busy"
      /></label>
    </div>
    <div class="member-create-actions">
      <button class="button primary" :disabled="busy || !name.trim() || !email.trim()">
        添加普通成员</button
      ><button type="button" class="button" :disabled="busy" @click="emit('cancel')">取消</button>
    </div>
    <small>添加后会自动选中此成员，方便直接生成绑定码。不要填写 Google 密码或 Token。</small>
  </form>
</template>
