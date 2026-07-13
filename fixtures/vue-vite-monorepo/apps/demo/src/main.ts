import { createApp } from 'vue';
import { WorkspaceBanner } from '@web-source-inspector/fixture-monorepo-ui';

createApp(WorkspaceBanner, { label: 'Workspace 源码包' }).mount('#app');
