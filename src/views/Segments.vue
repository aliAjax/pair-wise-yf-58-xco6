<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { message } from 'ant-design-vue';
import { useSegmentStore, type HitList, type ListStatus, type PlanStatus, type ReleasePlan } from '../stores/segments';

const store = useSegmentStore();
const active = computed(() => store.activeSegment);
const current = computed(() => (active.value ? store.currentList(active.value.key) : undefined));
const effective = computed(() => (active.value ? store.effectiveList(active.value.key) : undefined));
const importOpen = ref(false);
const form = reactive({ segmentKey: '', version: 1, dataTime: '', users: '' });

const listStatusText: Record<ListStatus, string> = { pending: '待重算', reconciled: '已对平', mismatch: '有差异', voided: '已作废' };
const listStatusColor: Record<ListStatus, string> = { pending: 'gold', reconciled: 'green', mismatch: 'red', voided: 'default' };
const planStatusText: Record<PlanStatus, string> = { blocked: '未对平·冻结', ready: '已对平·待发布', released: '已放量', superseded: '已作废' };
const planStatusColor: Record<PlanStatus, string> = { blocked: 'red', ready: 'blue', released: 'green', superseded: 'default' };

const importColumns = [
  { title: '版本', key: 'version' },
  { title: '数据时间', dataIndex: 'dataTime', key: 'dataTime' },
  { title: '导入时间', dataIndex: 'importedAt', key: 'importedAt' },
  { title: '平台人数', key: 'count' }
];

function statusOf(key: string): ListStatus { return store.currentList(key)?.status ?? 'pending'; }

function openImport() {
  form.segmentKey = active.value?.key ?? store.segments[0]?.key ?? '';
  form.version = store.latestVersion(form.segmentKey) + 1;
  form.dataTime = '';
  form.users = '';
  importOpen.value = true;
}

function submitImport() {
  const users = form.users.split(/[\s,，、]+/).map((item) => item.trim()).filter(Boolean);
  if (!form.segmentKey || !form.version || !form.dataTime || users.length === 0) {
    message.warning('请完整填写分群、版本、数据时间和平台名单');
    return;
  }
  const result = store.importSegment({ segmentKey: form.segmentKey, version: Number(form.version), dataTime: form.dataTime, users });
  if (!result.created) message.info(`v${form.version} 已导入过，同版本不新增记录`);
  else if (result.arrival === 'late') message.warning(`v${form.version} 晚于当前版本到达，仅留参考，不触发重算`);
  else message.success(`v${form.version} 已导入，未生效名单已作废，请重算对账`);
  importOpen.value = false;
}

function retry() {
  if (!active.value) return;
  const count = store.retryPending(active.value.key);
  message.info(count > 0 ? `已重核 ${count} 份未完名单` : '当前没有未完成的对账');
}

function release(plan: ReleasePlan) {
  if (store.release(plan.id)) message.success(`v${plan.version} 已按对平名单放量 ${plan.rollout}%`);
  else message.error('对账未平，不能放量');
}
</script>

<template>
  <a-config-provider><a-layout class="app-shell">
    <a-layout-header class="topbar">
      <div><div class="eyebrow">SEGMENT RECONCILIATION / PORT 62023</div><h1>用户分群对账与放量</h1></div>
      <a-space>
        <router-link to="/"><a-button>返回开关控制台</a-button></router-link>
        <a-button type="primary" @click="openImport">导入分群数据</a-button>
      </a-space>
    </a-layout-header>
    <a-layout-content class="content">
      <a-row :gutter="[18, 18]">
        <a-col :xs="24" :lg="7">
          <a-card title="用户分群" size="small">
            <a-list :data-source="store.segments" bordered>
              <template #renderItem="{ item }">
                <a-list-item :class="{ selected: item.key === store.activeKey }" @click="store.select(item.key)">
                  <a-list-item-meta>
                    <template #title>
                      <a-space><span>{{ item.name }}</span><a-tag>v{{ store.latestVersion(item.key) }}</a-tag><a-tag :color="listStatusColor[statusOf(item.key)]">{{ listStatusText[statusOf(item.key)] }}</a-tag></a-space>
                    </template>
                    <template #description><code>{{ item.key }}</code> · 候选 {{ item.pool.length }} 人 · 阈值 {{ item.threshold }}%</template>
                  </a-list-item-meta>
                </a-list-item>
              </template>
            </a-list>
          </a-card>
          <a-card title="生效快照" size="small" class="mt">
            <template v-if="effective">
              <a-descriptions bordered :column="1" size="small">
                <a-descriptions-item label="名单版本">v{{ effective.version }}</a-descriptions-item>
                <a-descriptions-item label="命中人数">{{ effective.users.length }}</a-descriptions-item>
                <a-descriptions-item label="对平时间">{{ effective.computedAt }}</a-descriptions-item>
              </a-descriptions>
              <a-alert class="mt" type="success" show-icon message="对账失败时继续沿用此结果，不会被覆盖" />
            </template>
            <a-alert v-else type="warning" show-icon message="暂无对平结果" description="没有任何已对平的名单，放量保持冻结。" />
          </a-card>
        </a-col>
        <a-col :xs="24" :lg="17">
          <template v-if="active">
            <a-alert v-if="current?.status === 'mismatch'" class="mb" type="error" show-icon
              :message="`v${current.version} 对账未平：仅本地 ${current.diff?.onlyLocal.length} 人、仅平台 ${current.diff?.onlyPlatform.length} 人`"
              :description="`放量已冻结${effective ? `，继续沿用 v${effective.version} 的对平结果` : ''}，差异用户已在下方单列。`" />
            <a-alert v-else-if="current?.status === 'pending'" class="mb" type="warning" show-icon
              :message="`v${current.version} 待重算`" description="新版本已导入，未生效的旧名单已作废，请重算并对平后再放量。" />
            <a-alert v-else-if="current?.status === 'reconciled'" class="mb" type="success" show-icon
              :message="`v${current.version} 已对平`" description="本地重算与平台回传一致，可以放量。" />

            <a-card title="平台导入记录" size="small" class="mb">
              <a-table :data-source="store.importsOf(active.key)" :columns="importColumns" :pagination="false" size="small" row-key="id">
                <template #bodyCell="{ column, record }">
                  <template v-if="column.key === 'version'">
                    <a-space><b>v{{ record.version }}</b><a-tag :color="record.arrival === 'late' ? 'orange' : 'blue'">{{ record.arrival === 'late' ? '晚到·仅参考' : '最新版本' }}</a-tag></a-space>
                  </template>
                  <template v-else-if="column.key === 'count'">{{ record.users.length }}</template>
                </template>
              </a-table>
            </a-card>

            <a-card title="命中名单（按同版本重算）" size="small" class="mb">
              <template #extra><a-button size="small" @click="retry">重试未完对账</a-button></template>
              <a-list :data-source="store.listsOf(active.key)">
                <template #renderItem="{ item }">
                  <a-list-item>
                    <div class="list-row">
                      <a-space wrap>
                        <b>v{{ item.version }}</b>
                        <a-tag :color="listStatusColor[(item as HitList).status]">{{ listStatusText[(item as HitList).status] }}</a-tag>
                        <span class="dim">本地 {{ (item as HitList).users.length }} 人</span>
                        <span v-if="(item as HitList).computedAt" class="dim">重算于 {{ (item as HitList).computedAt }} · 第 {{ (item as HitList).attempts }} 次</span>
                        <a-button v-if="(item as HitList).status === 'pending' || (item as HitList).status === 'mismatch'" size="small" type="primary" ghost @click="store.recompute((item as HitList).id)">重算</a-button>
                        <span v-if="(item as HitList).status === 'voided'" class="dim">新版本到达，已作废</span>
                      </a-space>
                      <div v-if="(item as HitList).status === 'mismatch' && (item as HitList).diff" class="diff-box">
                        <div>
                          <b>仅本地命中（{{ (item as HitList).diff!.onlyLocal.length }}）</b>
                          <a-space wrap class="tag-wrap"><a-tag v-for="u in (item as HitList).diff!.onlyLocal" :key="u" color="red">{{ u }}</a-tag><span v-if="!(item as HitList).diff!.onlyLocal.length" class="dim">无</span></a-space>
                        </div>
                        <div>
                          <b>仅平台回传（{{ (item as HitList).diff!.onlyPlatform.length }}）</b>
                          <a-space wrap class="tag-wrap"><a-tag v-for="u in (item as HitList).diff!.onlyPlatform" :key="u" color="orange">{{ u }}</a-tag><span v-if="!(item as HitList).diff!.onlyPlatform.length" class="dim">无</span></a-space>
                        </div>
                      </div>
                    </div>
                  </a-list-item>
                </template>
              </a-list>
            </a-card>

            <a-card title="发布计划（未对平不放量）" size="small" class="mb">
              <a-list :data-source="store.plansOf(active.key)">
                <template #renderItem="{ item }">
                  <a-list-item>
                    <div class="list-row">
                      <a-space>
                        <b>v{{ (item as ReleasePlan).version }} 放量计划</b>
                        <a-tag :color="planStatusColor[(item as ReleasePlan).status]">{{ planStatusText[(item as ReleasePlan).status] }}</a-tag>
                        <span v-if="(item as ReleasePlan).status === 'released'" class="dim">{{ (item as ReleasePlan).releasedAt }} 按名单 {{ (item as ReleasePlan).releasedListId }} 放量</span>
                        <span v-if="(item as ReleasePlan).status === 'superseded'" class="dim">新版本到达，计划作废</span>
                      </a-space>
                      <a-row :gutter="12" align="middle">
                        <a-col :span="14"><a-slider :value="(item as ReleasePlan).rollout" :min="0" :max="100" :step="5" :disabled="(item as ReleasePlan).status === 'released' || (item as ReleasePlan).status === 'superseded'" @change="(value: number) => store.setRollout((item as ReleasePlan).id, value)" /></a-col>
                        <a-col :span="4" class="dim">{{ (item as ReleasePlan).rollout }}%</a-col>
                        <a-col :span="6">
                          <a-tooltip :title="(item as ReleasePlan).status === 'ready' ? '按对平名单放量' : '对账未平，不能放量'">
                            <a-button type="primary" size="small" :disabled="(item as ReleasePlan).status !== 'ready'" @click="release(item as ReleasePlan)">发布放量</a-button>
                          </a-tooltip>
                        </a-col>
                      </a-row>
                    </div>
                  </a-list-item>
                </template>
              </a-list>
            </a-card>

            <a-card title="对账记录" size="small">
              <a-timeline>
                <a-timeline-item v-for="item in store.audit" :key="item.id" :color="item.action.includes('差异') ? 'red' : item.action.includes('晚到') || item.action.includes('作废') ? 'orange' : 'blue'">
                  <b>{{ item.at }} · {{ item.action }}</b>
                  <p>{{ item.detail }}</p>
                </a-timeline-item>
              </a-timeline>
            </a-card>
          </template>
        </a-col>
      </a-row>
    </a-layout-content>
    <a-modal v-model:open="importOpen" title="导入分群数据" ok-text="导入" @ok="submitImport">
      <a-form layout="vertical">
        <a-form-item label="分群" required><a-select v-model:value="form.segmentKey" :options="store.segments.map((s) => ({ value: s.key, label: `${s.name}（${s.key}）` }))" /></a-form-item>
        <a-row :gutter="12">
          <a-col :span="10"><a-form-item label="分群版本" required><a-input-number v-model:value="form.version" :min="1" style="width: 100%" /></a-form-item></a-col>
          <a-col :span="14"><a-form-item label="数据时间" required><a-input v-model:value="form.dataTime" type="datetime-local" /></a-form-item></a-col>
        </a-row>
        <a-form-item label="平台回传名单" required><a-textarea v-model:value="form.users" :rows="5" placeholder="每行一个用户 ID，也支持逗号分隔" /></a-form-item>
        <a-alert type="info" show-icon message="同版本重复导入不会新增记录；晚到的旧版本仅留参考。" />
      </a-form>
    </a-modal>
  </a-layout></a-config-provider>
</template>

<style>
.app-shell { min-height: 100vh; background: transparent; }
.topbar { height: auto; min-height: 88px; display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 16px 32px; color: white; background: linear-gradient(120deg, #111827, #312e81); }
.topbar h1 { color: white; margin: 3px 0; font-size: 25px; }
.eyebrow { color: #a5b4fc; font-size: 11px; letter-spacing: .13em; }
.content { max-width: 1400px; width: 100%; margin: 0 auto; padding: 24px; }
.mb { margin-bottom: 18px; }
.mt { margin-top: 14px; }
.selected { background: #eef2ff; cursor: pointer; }
.ant-list-item { cursor: pointer; }
.list-row { width: 100%; }
.dim { color: #6b7280; font-size: 12px; }
.diff-box { margin-top: 10px; padding: 10px 12px; background: #fff7f5; border: 1px solid #ffd6d0; border-radius: 8px; display: grid; gap: 8px; }
.tag-wrap { margin-left: 8px; }
@media (max-width: 720px) { .topbar { padding: 18px; flex-direction: column; align-items: flex-start; } .content { padding: 16px; } }
</style>
