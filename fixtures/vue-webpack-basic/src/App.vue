<script setup>
import { ref } from 'vue';

const count = ref(0);
</script>

<template>
  <main class="webpack-fixture">
    <h1>Webpack Source Inspector</h1>
    <button type="button" @click="count += 1">业务计数 {{ count }}</button>
    <ul>
      <li v-for="item in ['loader', 'runtime', 'bridge']" :key="item">{{ item }}</li>
    </ul>
  </main>
</template>
