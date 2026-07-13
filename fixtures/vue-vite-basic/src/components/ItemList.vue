<script setup lang="ts">
interface WorkItem {
  id: number;
  title: string;
  status: 'ready' | 'review' | 'blocked';
}

defineProps<{ items: WorkItem[] }>();

const emit = defineEmits<{
  remove: [id: number];
}>();
</script>

<template>
  <ul class="work-list" aria-label="工作项">
    <li v-for="item in items" :key="item.id" class="work-row">
      <span class="status-swatch" :data-status="item.status" aria-hidden="true"></span>
      <strong>{{ item.title }}</strong>
      <span class="status-label">{{ item.status }}</span>
      <button class="icon-button danger" type="button" title="删除" aria-label="删除" @click="emit('remove', item.id)">
        ×
      </button>
    </li>
  </ul>
</template>
