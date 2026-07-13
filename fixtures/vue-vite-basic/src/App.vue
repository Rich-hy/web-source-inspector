<script setup lang="ts">
import { computed, ref } from 'vue';
import ItemList from './components/ItemList.vue';
import NoInherit from './components/NoInherit.vue';
import SlotPanel from './components/SlotPanel.vue';

const items = ref([
  { id: 1, title: '编译器映射', status: 'ready' as const },
  { id: 2, title: '浏览器交互', status: 'review' as const },
  { id: 3, title: 'IDE 会话', status: 'blocked' as const }
]);
const activityCount = ref(0);
const showDetails = ref(true);
const showTeleport = ref(false);
const remaining = computed(() => items.value.length);

function removeItem(id: number): void {
  activityCount.value += 1;
  items.value = items.value.filter((item) => item.id !== id);
}
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <div>
        <p class="eyebrow">LOCAL FIXTURE</p>
        <h1>Web Source Inspector</h1>
      </div>
      <div class="topbar-metrics" aria-label="状态摘要">
        <span><strong>{{ remaining }}</strong> 项</span>
        <span data-testid="activity-count"><strong>{{ activityCount }}</strong> 次业务操作</span>
      </div>
    </header>

    <main>
      <section class="command-band" aria-label="操作栏">
        <button type="button" @click="showDetails = !showDetails">
          {{ showDetails ? '隐藏详情' : '显示详情' }}
        </button>
        <button type="button" @click="showTeleport = true">打开 Teleport</button>
        <button type="button" class="secondary" @click="activityCount += 1">业务计数</button>
      </section>

      <div class="workspace-grid">
        <section class="work-section">
          <div class="section-heading">
            <div>
              <p class="eyebrow">SOURCE NODES</p>
              <h2>工作项</h2>
            </div>
            <span class="count-badge">{{ remaining }}</span>
          </div>

          <ItemList :items="items" @remove="removeItem" />

          <p v-if="items.length === 0" class="empty-state">暂无工作项</p>
          <p v-else-if="items.length === 1" class="conditional-note">剩余最后一项</p>
          <p v-else class="conditional-note">当前有 {{ items.length }} 个可定位循环实例</p>
        </section>

        <aside class="detail-section">
          <SlotPanel v-if="showDetails">
            <template #title>
              <h2>组件边界</h2>
            </template>
            <p>Slot 内容由消费方模板声明。</p>
            <component :is="NoInherit" label="多根组件" />
          </SlotPanel>
          <div v-else class="empty-state">详情已隐藏</div>
        </aside>
      </div>
    </main>

    <Teleport to="#teleport-target">
      <div v-if="showTeleport" class="modal-backdrop" @click.self="showTeleport = false">
        <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="teleport-title">
          <header>
            <h2 id="teleport-title">Teleport 内容</h2>
            <button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="showTeleport = false">×</button>
          </header>
          <p>该节点渲染在独立容器中。</p>
          <button type="button" @click="showTeleport = false">确认</button>
        </section>
      </div>
    </Teleport>
  </div>
</template>
