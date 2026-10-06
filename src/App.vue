<script setup lang="ts">
import { provide, ref } from 'vue';
import { useOnline } from '@vueuse/core';
import FlagConsole from './components/FlagConsole.vue';
import ReconcileCenter from './components/ReconcileCenter.vue';

const online = useOnline();
const activeTab = ref('flags');
provide('setTab', (key: string) => {
  activeTab.value = key;
});
</script>

<template>
  <a-config-provider>
    <a-layout class="app-shell">
      <a-layout-header class="topbar">
        <div>
          <div class="eyebrow">FEATURE FLAG / PORT 62023</div>
          <h1>功能开关与灰度发布控制台</h1>
        </div>
        <a-space>
          <a-tag :color="online ? 'green' : 'orange'">{{ online ? '控制面在线' : '离线草稿' }}</a-tag>
        </a-space>
      </a-layout-header>
      <a-layout-content class="content">
        <a-tabs v-model:activeKey="activeTab">
          <a-tab-pane key="flags" tab="功能开关">
            <FlagConsole />
          </a-tab-pane>
          <a-tab-pane key="reconcile" tab="分群对账">
            <ReconcileCenter />
          </a-tab-pane>
        </a-tabs>
      </a-layout-content>
    </a-layout>
  </a-config-provider>
</template>

<style>
* { box-sizing: border-box; }
body { margin: 0; background: #f4f6fb; font-family: Inter, "PingFang SC", sans-serif; }
.app-shell { min-height: 100vh; background: transparent; }
.topbar { height: auto; min-height: 88px; display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 16px 32px; color: white; background: linear-gradient(120deg, #111827, #312e81); }
.topbar h1 { color: white; margin: 3px 0; font-size: 25px; }
.eyebrow { color: #a5b4fc; font-size: 11px; letter-spacing: .13em; }
.content { max-width: 1400px; width: 100%; margin: 0 auto; padding: 24px; }
.ant-list-item { cursor: pointer; }
@media (max-width: 720px) { .topbar { padding: 18px; flex-direction: column; align-items: flex-start; } .content { padding: 16px; } }
</style>
