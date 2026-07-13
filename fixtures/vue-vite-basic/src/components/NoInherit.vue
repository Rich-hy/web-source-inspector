<script setup lang="ts">
defineOptions({ inheritAttrs: false });
defineProps<{ label: string }>();
</script>

<template>
  <span class="no-inherit-label">{{ label }}</span>
  <span class="no-inherit-note">inheritAttrs: false</span>
</template>
