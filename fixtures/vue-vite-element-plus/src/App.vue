<script setup lang="ts">
import { ref } from 'vue';

const dialogVisible = ref(false);
const rows = [
  { module: 'transform-vue', level: '精确' },
  { module: 'element-plus', level: '调用点' }
];
</script>

<template>
  <main class="page">
    <header>
      <div>
        <p>THIRD-PARTY FIXTURE</p>
        <h1>Element Plus 调用点</h1>
      </div>
      <el-button type="primary" @click="dialogVisible = true">打开对话框</el-button>
    </header>

    <el-table :data="rows" border>
      <el-table-column prop="module" label="模块" />
      <el-table-column prop="level" label="定位等级" />
    </el-table>

    <el-dialog v-model="dialogVisible" title="第三方组件边界" width="420px">
      <p>内部 DOM 应回退到当前用户模板调用点。</p>
      <template #footer>
        <el-button @click="dialogVisible = false">关闭</el-button>
      </template>
    </el-dialog>
  </main>
</template>

<style scoped>
:global(*) { box-sizing: border-box; letter-spacing: 0; }
:global(body) { margin: 0; background: #f4f6f8; color: #20242a; font-family: "Segoe UI", "Microsoft YaHei", sans-serif; }
.page { width: min(920px, calc(100% - 32px)); margin: 0 auto; padding: 28px 0; }
header { display: flex; align-items: center; justify-content: space-between; gap: 20px; margin-bottom: 24px; }
h1, p { margin: 0; }
h1 { margin-top: 4px; font-size: 24px; }
header p { color: #68717d; font-size: 11px; font-weight: 700; }
@media (max-width: 580px) { header { align-items: flex-start; flex-direction: column; } }
</style>
