<script setup lang="ts">
defineProps<{ label: string }>();
</script>

<template>
  <section class="workspace-banner">
    <p>MONOREPO FIXTURE</p>
    <h1>{{ label }}</h1>
  </section>
</template>

<style scoped>
.workspace-banner { width: min(680px, calc(100% - 32px)); margin: 48px auto; padding-left: 18px; border-left: 4px solid #237653; font-family: "Segoe UI", sans-serif; letter-spacing: 0; }
p { color: #68717d; font-size: 11px; font-weight: 700; }
h1 { color: #20242a; font-size: 24px; }
</style>
