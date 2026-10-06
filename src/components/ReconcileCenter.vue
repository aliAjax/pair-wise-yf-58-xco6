<script setup lang="ts">
import { computed, ref } from 'vue';
import { useFlagStore } from '../stores/flags';
import { useReconcileStore, type CohortUser, type HitList, type ReconcileTask } from '../stores/reconcile';

const flagStore = useFlagStore();
const store = useReconcileStore();

const flags = computed(() => flagStore.flags);
const activeCohort = computed(() => store.activeCohort);
const referenceCohorts = computed(() => store.referenceCohorts);

// ---- 分群导入 ----
const importForm = ref({ name: '结算页灰度分群', version: 'v2', dataAt: '2026-10-01T08:00', usersText: '' });
const importMsg = ref<{ type: 'success' | 'info' | 'warning'; text: string } | null>(null);

const sampleUsersText = `u1,上海,8.3.0,true
u2,上海,8.2.0,true
u3,北京,8.3.0,true
u4,上海,8.1.0,false
u5,广东,8.3.0,true
u6,上海,8.3.0,true
u7,北京,8.0.0,true
u8,上海,8.3.0,false
u9,上海,8.3.0,true
u10,北京,8.2.0,false`;

function parseUsers(text: string): CohortUser[] {
  const users: CohortUser[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/[,，\s]+/).filter(Boolean);
    if (parts.length < 3) continue;
    users.push({
      id: parts[0],
      region: parts[1],
      appVersion: parts[2],
      authenticated: parts[3] === 'true' || parts[3] === '1' || parts[3] === '是',
    });
  }
  return users;
}

function fillSample() {
  importForm.value.usersText = sampleUsersText;
}

function doImport() {
  const users = parseUsers(importForm.value.usersText);
  if (users.length === 0) {
    importMsg.value = { type: 'warning', text: '未解析到有效用户，请检查格式（每行：id,地区,版本,是否登录）' };
    return;
  }
  const { duplicated } = store.importCohort({
    name: importForm.value.name,
    version: importForm.value.version,
    dataAt: importForm.value.dataAt,
    users,
  });
  if (duplicated) {
    importMsg.value = { type: 'info', text: `版本 ${importForm.value.version} 已存在，同版本重复导入不新增记录` };
  } else {
    importMsg.value = { type: 'success', text: `已导入 ${importForm.value.version}（数据时间 ${importForm.value.dataAt}），旧版本降为参考，未生效名单已作废` };
  }
}

// ---- 命中名单 ----
const selectedFlagId = ref(flagStore.flags[0]?.id ?? '');
const hitLists = computed(() => (selectedFlagId.value ? store.hitListsFor(selectedFlagId.value) : []));

function recompute() {
  if (!selectedFlagId.value) return;
  const list = store.recomputeHitList(selectedFlagId.value);
  if (!list) return;
}

// ---- 平台回传模拟与对账 ----
const reconcileTarget = ref<HitList | null>(null);
const platformMode = ref<'none' | 'minor' | 'major'>('minor');
const platformComplete = ref(true);

function openReconcile(list: HitList) {
  reconcileTarget.value = list;
  platformMode.value = 'minor';
  platformComplete.value = true;
}

/** 模拟平台回传名单：none=与本地一致 / minor=少量差异 / major=较多差异；complete=false=回传不完整 */
function simulatePlatformBatch(list: HitList) {
  let users = [...list.userIds];
  if (platformMode.value !== 'none') {
    const pool = (activeCohort.value?.users ?? []).map((u) => u.id).filter((id) => !users.includes(id));
    const removeCount = platformMode.value === 'minor' ? 2 : 5;
    const addCount = platformMode.value === 'minor' ? 2 : 5;
    users = users.slice(0, Math.max(0, users.length - removeCount));
    users.push(...pool.slice(0, addCount));
  }
  if (!platformComplete.value) {
    users = users.slice(0, Math.ceil(users.length / 2));
  }
  return {
    batchId: `batch-${Date.now()}`,
    cohortVersion: list.cohortVersion,
    users,
    complete: platformComplete.value,
  };
}

function doReconcile() {
  if (!reconcileTarget.value) return;
  const batch = simulatePlatformBatch(reconcileTarget.value);
  store.startReconcile(reconcileTarget.value.id, batch);
  reconcileTarget.value = null;
}

function doRetry(task: ReconcileTask) {
  const list = store.hitLists.find((h) => h.id === task.hitListId);
  if (!list) return;
  // 重试：平台重新回传完整名单，只核没完的
  const batch = simulatePlatformBatch(list);
  store.retryReconcile(task.id, batch);
}

// ---- 门禁 ----
function gateFor(flagId: string) {
  return store.releaseGate(flagId);
}

const statusColor: Record<string, string> = {
  draft: 'gold',
  effective: 'green',
  void: 'default',
  matched: 'green',
  mismatched: 'red',
  failed: 'orange',
  pending: 'default',
  reconciling: 'blue',
};

function formatTime(iso: string) {
  return new Date(iso).toLocaleString('zh-CN');
}
</script>

<template>
  <div class="reconcile-center">
    <a-alert
      type="info"
      show-icon
      message="对账口径"
      description="分群带版本与数据时间导入；命中名单按当前生效分群版本重算；本地名单与平台回传名单逐人对账，差异用户单独列出，对平前不放量。分群版本变更后，未生效名单作废重算，旧版本仅留参考。"
      class="mb"
    />

    <a-row :gutter="[18, 18]">
      <!-- 左列：分群 + 命中名单 -->
      <a-col :xs="24" :lg="11">
        <a-card title="用户分群（平台导出）" size="small" class="mb">
          <a-form layout="vertical">
            <a-row :gutter="12">
              <a-col :span="12">
                <a-form-item label="分群名称">
                  <a-input v-model:value="importForm.name" />
                </a-form-item>
              </a-col>
              <a-col :span="12">
                <a-form-item label="分群版本">
                  <a-input v-model:value="importForm.version" placeholder="如 v2" />
                </a-form-item>
              </a-col>
            </a-row>
            <a-form-item label="数据时间">
              <a-input v-model:value="importForm.dataAt" placeholder="2026-10-01T08:00" />
            </a-form-item>
            <a-form-item label="用户列表（每行：id,地区,版本,是否登录）">
              <a-textarea v-model:value="importForm.usersText" :rows="5" placeholder="u1,上海,8.3.0,true" />
            </a-form-item>
            <a-space>
              <a-button size="small" @click="fillSample">载入示例用户</a-button>
              <a-button type="primary" size="small" @click="doImport">导入分群</a-button>
            </a-space>
          </a-form>
          <a-alert v-if="importMsg" class="mt" :type="importMsg.type" show-icon :message="importMsg.text" />

          <a-divider>当前生效版本</a-divider>
          <a-descriptions v-if="activeCohort" bordered size="small" :column="2">
            <a-descriptions-item label="分群">{{ activeCohort.name }}</a-descriptions-item>
            <a-descriptions-item label="版本"><a-tag color="blue">{{ activeCohort.version }}</a-tag></a-descriptions-item>
            <a-descriptions-item label="数据时间">{{ activeCohort.dataAt }}</a-descriptions-item>
            <a-descriptions-item label="用户数">{{ activeCohort.users.length }}</a-descriptions-item>
          </a-descriptions>
          <a-empty v-else description="暂无生效分群" />

          <a-divider>历史版本（仅参考）</a-divider>
          <a-list v-if="referenceCohorts.length" size="small" :data-source="referenceCohorts" bordered>
            <template #renderItem="{ item }">
              <a-list-item>
                <a-list-item-meta>
                  <template #title>
                    <a-space>
                      <span>{{ item.name }}</span>
                      <a-tag>{{ item.version }}</a-tag>
                      <a-tag color="default">参考</a-tag>
                    </a-space>
                  </template>
                  <template #description>数据时间 {{ item.dataAt }} · {{ item.users.length }} 人 · 导入于 {{ formatTime(item.importedAt) }}</template>
                </a-list-item-meta>
              </a-list-item>
            </template>
          </a-list>
          <a-empty v-else description="无历史版本" />
        </a-card>

        <a-card title="命中名单（按版本重算）" size="small">
          <a-form layout="vertical">
            <a-form-item label="选择开关">
              <a-select v-model:value="selectedFlagId" :options="flags.map((f) => ({ value: f.id, label: `${f.name}（${f.key}）` }))" />
            </a-form-item>
            <a-button type="primary" block @click="recompute">按当前分群版本重算命中名单</a-button>
          </a-form>
          <a-list v-if="hitLists.length" size="small" :data-source="hitLists" bordered class="mt">
            <template #renderItem="{ item }">
              <a-list-item>
                <a-list-item-meta>
                  <template #title>
                    <a-space>
                      <a-tag :color="statusColor[item.status]">{{ item.status }}</a-tag>
                      <a-tag color="blue">{{ item.cohortVersion }}</a-tag>
                      <span>{{ item.userIds.length }} 人命中</span>
                    </a-space>
                  </template>
                  <template #description>
                    计算于 {{ formatTime(item.computedAt) }}
                    <a v-if="item.status === 'draft'" class="ml" @click="openReconcile(item)">发起对账</a>
                  </template>
                </a-list-item-meta>
              </a-list-item>
            </template>
          </a-list>
          <a-empty v-else description="尚未重算命中名单" />
        </a-card>
      </a-col>

      <!-- 右列：对账任务 + 门禁 -->
      <a-col :xs="24" :lg="13">
        <a-card title="对账任务" size="small" class="mb">
          <a-list v-if="store.tasks.length" size="small" :data-source="store.tasks" bordered>
            <template #renderItem="{ item }">
              <a-list-item>
                <a-list-item-meta>
                  <template #title>
                    <a-space>
                      <a-tag :color="statusColor[item.status]">{{ item.status }}</a-tag>
                      <a-tag color="blue">{{ item.cohortVersion }}</a-tag>
                      <span>本地 {{ item.localCount }} / 平台 {{ item.platformCount }}</span>
                    </a-space>
                  </template>
                  <template #description>
                    <div>批次 {{ item.platformBatchId }} · 核对进度 {{ item.checkedCount }}/{{ item.totalCount }}</div>
                    <div v-if="item.status === 'mismatched' || item.status === 'failed'">
                      <span v-if="item.missingInPlatform.length" class="diff-missing">本地有、平台无：{{ item.missingInPlatform.join('、') }}</span>
                      <span v-if="item.extraInPlatform.length" class="diff-extra">平台有、本地无：{{ item.extraInPlatform.join('、') }}</span>
                    </div>
                    <div v-if="item.status === 'failed' && item.previousStatus" class="prev-result">
                      上一份结果：{{ item.previousStatus }}（本地 {{ item.previousLocalCount }} / 平台 {{ item.previousPlatformCount }}），已保住
                    </div>
                    <div class="task-actions">
                      <a-button v-if="item.status === 'failed'" size="small" type="primary" @click="doRetry(item)">重试（只核未完项）</a-button>
                    </div>
                  </template>
                </a-list-item-meta>
              </a-list-item>
            </template>
          </a-list>
          <a-empty v-else description="暂无对账任务，请在左侧发起对账" />
        </a-card>

        <a-card title="放量门禁（没对平前不放量）" size="small">
          <a-list size="small" :data-source="flags" bordered>
            <template #renderItem="{ item }">
              <a-list-item>
                <a-list-item-meta>
                  <template #title>
                    <a-space>
                      <span>{{ item.name }}</span>
                      <a-tag v-if="gateFor(item.id).allowed" color="green">可放量</a-tag>
                      <a-tag v-else color="red">拦截</a-tag>
                    </a-space>
                  </template>
                  <template #description>
                    <span :class="gateFor(item.id).allowed ? 'gate-ok' : 'gate-blocked'">{{ gateFor(item.id).reason }}</span>
                  </template>
                </a-list-item-meta>
              </a-list-item>
            </template>
          </a-list>
        </a-card>
      </a-col>
    </a-row>

    <!-- 平台回传模拟 -->
    <a-modal
      :open="!!reconcileTarget"
      title="模拟平台回传并对账"
      ok-text="开始对账"
      @ok="doReconcile"
      @update:open="(open: boolean) => { if (!open) reconcileTarget = null; }"
    >
      <a-form layout="vertical">
        <a-form-item label="命中名单版本">
          <a-tag color="blue">{{ reconcileTarget?.cohortVersion }}</a-tag>
          <span class="ml">{{ reconcileTarget?.userIds.length }} 人</span>
        </a-form-item>
        <a-form-item label="平台回传差异">
          <a-radio-group v-model:value="platformMode">
            <a-radio value="none">无差异（对平）</a-radio>
            <a-radio value="minor">少量差异（各 2 人）</a-radio>
            <a-radio value="major">较多差异（各 5 人）</a-radio>
          </a-radio-group>
        </a-form-item>
        <a-form-item label="回传完整性">
          <a-switch v-model:checked="platformComplete" checked-children="完整" un-checked-children="不完整" />
          <span class="ml hint">不完整回传将导致对账失败，可重试只核未完项</span>
        </a-form-item>
      </a-form>
    </a-modal>
  </div>
</template>

<style scoped>
.reconcile-center { padding: 4px 0; }
.mb { margin-bottom: 18px; }
.mt { margin-top: 14px; }
.ml { margin-left: 8px; }
.hint { color: #94a3b8; font-size: 12px; }
.diff-missing { display: block; color: #dc2626; }
.diff-extra { display: block; color: #ea580c; }
.prev-result { color: #2563eb; }
.task-actions { margin-top: 6px; }
.gate-ok { color: #16a34a; font-weight: 600; }
.gate-blocked { color: #dc2626; font-weight: 600; }
</style>
