import { defineStore } from 'pinia';
import { useFlagStore } from './flags';

/** 用户分群：平台导出的用户包，带版本与数据时间 */
export type CohortStatus = 'active' | 'reference';
export interface CohortUser { id: string; region: string; appVersion: string; authenticated: boolean; }
export interface Cohort {
  id: string;
  name: string;
  version: string;
  dataAt: string;        // 数据时间
  importedAt: string;    // 导入时间
  source: string;
  users: CohortUser[];
  status: CohortStatus;  // active=当前生效，reference=旧版本仅留参考
}

/** 命中名单：本地按分群版本重算的结果 */
export type HitListStatus = 'draft' | 'effective' | 'void';
export interface HitList {
  id: string;
  flagId: string;
  cohortId: string;
  cohortVersion: string;  // 重算时锁定的版本
  userIds: string[];
  computedAt: string;
  status: HitListStatus; // draft=未对平 / effective=已对平生效 / void=版本变更作废
}

/** 对账任务：本地命中名单 vs 平台回传名单 */
export type ReconcileStatus = 'pending' | 'reconciling' | 'matched' | 'mismatched' | 'failed';
export interface ReconcileTask {
  id: string;
  hitListId: string;
  flagId: string;
  cohortVersion: string;
  platformBatchId: string;
  status: ReconcileStatus;
  localCount: number;
  platformCount: number;
  missingInPlatform: string[];  // 本地有、平台无
  extraInPlatform: string[];    // 平台有、本地无
  checkedCount: number;   // 已核对项（重试只核没完的）
  totalCount: number;
  // 上一份结果快照：对账失败时保住，不被覆盖
  previousStatus?: ReconcileStatus;
  previousLocalCount?: number;
  previousPlatformCount?: number;
  previousMissing?: string[];
  previousExtra?: string[];
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

interface State {
  cohorts: Cohort[];
  hitLists: HitList[];
  tasks: ReconcileTask[];
}

/** 版本号解析：支持 v1 / 1.2.0 / 2026-10-01 等形式，按数字段比较 */
function parseVersion(v: string): number[] {
  return v.replace(/^v/i, '').split('.').map((s) => parseInt(s, 10) || 0);
}
function compareVersion(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** 灰度桶：与 flag store 的 simulateHit 保持同一算法 */
function hashBucket(id: string): number {
  return [...id].reduce((sum, c) => sum + c.charCodeAt(0), 0) % 100;
}

/** 按开关规则 + 放量比例判定单个用户是否命中，返回未命中原因（null 表示命中） */
function userMissReason(
  u: CohortUser,
  rules: { region: string; appVersion: string; authenticated: boolean },
  rollout: number,
): string | null {
  if (rules.region !== '全部' && rules.region !== u.region) return `地区不匹配（要求${rules.region}）`;
  if (rules.authenticated && !u.authenticated) return '要求已登录用户';
  const bucket = hashBucket(u.id);
  if (bucket >= rollout) return `灰度桶 ${bucket} ≥ ${rollout}%`;
  return null;
}

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now()}-${seq}`;
}

function seedCohortUsers(): CohortUser[] {
  return [
    { id: 'u1', region: '上海', appVersion: '8.3.0', authenticated: true },
    { id: 'u2', region: '上海', appVersion: '8.2.0', authenticated: true },
    { id: 'u3', region: '北京', appVersion: '8.3.0', authenticated: true },
    { id: 'u4', region: '上海', appVersion: '8.1.0', authenticated: false },
    { id: 'u5', region: '广东', appVersion: '8.3.0', authenticated: true },
    { id: 'u6', region: '上海', appVersion: '8.3.0', authenticated: true },
    { id: 'u7', region: '北京', appVersion: '8.0.0', authenticated: true },
    { id: 'u8', region: '上海', appVersion: '8.3.0', authenticated: false },
  ];
}

function seed(): State {
  const now = new Date().toISOString();
  return {
    cohorts: [
      {
        id: 'c1',
        name: '结算页灰度分群',
        version: 'v1',
        dataAt: '2026-09-28T08:00',
        importedAt: now,
        source: 'platform-export',
        users: seedCohortUsers(),
        status: 'active',
      },
    ],
    hitLists: [],
    tasks: [],
  };
}

export const useReconcileStore = defineStore('reconcile', {
  state: () => {
    const saved = localStorage.getItem('yf58-reconcile-state');
    return saved ? (JSON.parse(saved) as State) : seed();
  },
  getters: {
    activeCohort(state): Cohort | undefined {
      return state.cohorts.find((c) => c.status === 'active');
    },
    referenceCohorts(state): Cohort[] {
      return state.cohorts.filter((c) => c.status === 'reference');
    },
    /** 某开关的全部名单（按计算时间倒序） */
    hitListsFor(state): (flagId: string) => HitList[] {
      return (flagId: string) =>
        state.hitLists
          .filter((h) => h.flagId === flagId)
          .sort((a, b) => (a.computedAt < b.computedAt ? 1 : -1));
    },
    /** 某名单的全部对账任务（按创建时间倒序） */
    tasksFor(state): (hitListId: string) => ReconcileTask[] {
      return (hitListId: string) =>
        state.tasks
          .filter((t) => t.hitListId === hitListId)
          .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    },
    /**
     * 放量门禁：没对平前不放量。
     * 取当前生效版本下最新的名单（重算会作废旧名单，故只看最新一条）：
     *   effective → 放行；draft → 看其任务，matched 放行 / failed 但上一份 matched 沿用放行 / 其余禁止。
     */
    releaseGate(state): (flagId: string) => { allowed: boolean; reason: string; hitList?: HitList; task?: ReconcileTask } {
      return (flagId: string) => {
        const active = state.cohorts.find((c) => c.status === 'active');
        if (!active) return { allowed: false, reason: '暂无生效分群，请先导入分群' };
        const latest = state.hitLists
          .filter((h) => h.flagId === flagId && h.cohortVersion === active.version)
          .sort((a, b) => (a.computedAt < b.computedAt ? 1 : -1))[0];
        if (!latest) return { allowed: false, reason: '尚未按当前分群版本重算命中名单' };
        if (latest.status === 'void') return { allowed: false, reason: '当前名单已作废，请按版本重新重算', hitList: latest };
        if (latest.status === 'effective') {
          const task = state.tasks.find((t) => t.hitListId === latest.id && t.status === 'matched');
          return { allowed: true, reason: '已对平', hitList: latest, task };
        }
        // draft：看其任务
        const task = state.tasks.find((t) => t.hitListId === latest.id);
        if (!task) return { allowed: false, reason: '命中名单未发起对账', hitList: latest };
        if (task.status === 'matched') return { allowed: true, reason: '已对平', hitList: latest, task };
        if (task.status === 'failed' && task.previousStatus === 'matched') {
          return { allowed: true, reason: '对账失败，沿用上一份对平结果', hitList: latest, task };
        }
        if (task.status === 'mismatched') {
          return {
            allowed: false,
            reason: `存在差异用户（本地有 ${task.missingInPlatform.length} 人 / 平台有 ${task.extraInPlatform.length} 人），对平前不放量`,
            hitList: latest,
            task,
          };
        }
        if (task.status === 'failed') return { allowed: false, reason: '对账失败，请重试核对未完项', hitList: latest, task };
        return { allowed: false, reason: '对账进行中', hitList: latest, task };
      };
    },
  },
  actions: {
    persist() {
      localStorage.setItem('yf58-reconcile-state', JSON.stringify(this.$state));
    },
    /**
     * 导入分群。同版本重复导入不新增记录（幂等）；
     * 新版本生效时，旧版本一律降为参考，且未生效名单作废重算；
     * 晚到的旧版本只留参考，不覆盖当前生效版本。
     */
    importCohort(input: { name: string; version: string; dataAt: string; users: CohortUser[]; source?: string }) {
      const existing = this.cohorts.find((c) => c.name === input.name && c.version === input.version);
      if (existing) return { cohort: existing, duplicated: true as const };
      const currentActive = this.cohorts.find((c) => c.name === input.name && c.status === 'active');
      const cohort: Cohort = {
        id: nextId('c'),
        name: input.name,
        version: input.version,
        dataAt: input.dataAt,
        importedAt: new Date().toISOString(),
        source: input.source || 'platform-export',
        users: input.users,
        status: 'reference',
      };
      if (!currentActive || compareVersion(input.version, currentActive.version) > 0) {
        // 新版本生效：旧版本降为参考，未生效名单作废
        this.cohorts.forEach((c) => {
          if (c.name === input.name) c.status = 'reference';
        });
        this.hitLists.forEach((h) => {
          if (h.status === 'draft') h.status = 'void';
        });
        cohort.status = 'active';
      }
      this.cohorts.push(cohort);
      this.persist();
      return { cohort, duplicated: false as const };
    },
    /** 按当前生效分群版本重算某开关的命中名单，锁定版本；作废该开关此前所有未作废名单（含已生效），保证只有一条最新名单。 */
    recomputeHitList(flagId: string) {
      const flagStore = useFlagStore();
      const flag = flagStore.flags.find((f) => f.id === flagId);
      const active = this.activeCohort;
      if (!flag || !active) return null;
      this.hitLists.forEach((h) => {
        if (h.flagId === flagId && h.status !== 'void') h.status = 'void';
      });
      const userIds: string[] = [];
      for (const u of active.users) {
        if (!userMissReason(u, flag.rules, flag.rollout)) userIds.push(u.id);
      }
      const hitList: HitList = {
        id: nextId('h'),
        flagId,
        cohortId: active.id,
        cohortVersion: active.version,
        userIds,
        computedAt: new Date().toISOString(),
        status: 'draft',
      };
      this.hitLists.push(hitList);
      this.persist();
      return hitList;
    },
    /**
     * 发起对账：本地名单 vs 平台回传。
     * 版本不一致 / 回传不完整 → 对账失败，先保住上一份结果（快照），不覆盖。
     * 对平 → 名单置 effective；有差异 → 列出差异用户。
     */
    startReconcile(
      hitListId: string,
      platformBatch: { batchId: string; cohortVersion: string; users: string[]; complete: boolean },
    ) {
      const hitList = this.hitLists.find((h) => h.id === hitListId);
      if (!hitList) return null;
      // 上一份对平结果：同 flag + 同版本下最近一次 matched（含重算前的旧名单），对账失败时保住
      const prev = this.tasks.find(
        (t) => t.flagId === hitList.flagId && t.cohortVersion === hitList.cohortVersion && t.status === 'matched',
      );
      const localSet = new Set(hitList.userIds);
      const platformSet = new Set(platformBatch.users);
      const missing = [...localSet].filter((id) => !platformSet.has(id));
      const extra = [...platformSet].filter((id) => !localSet.has(id));
      const total = new Set([...localSet, ...platformSet]).size;
      let status: ReconcileStatus;
      let checkedCount = 0;
      if (platformBatch.cohortVersion !== hitList.cohortVersion) {
        status = 'failed'; // 版本不一致
      } else if (!platformBatch.complete) {
        status = 'failed'; // 回传不完整
      } else {
        checkedCount = total;
        status = missing.length === 0 && extra.length === 0 ? 'matched' : 'mismatched';
      }
      const now = new Date().toISOString();
      const task: ReconcileTask = {
        id: nextId('t'),
        hitListId,
        flagId: hitList.flagId,
        cohortVersion: hitList.cohortVersion,
        platformBatchId: platformBatch.batchId,
        status,
        localCount: localSet.size,
        platformCount: platformSet.size,
        missingInPlatform: missing,
        extraInPlatform: extra,
        checkedCount,
        totalCount: total,
        previousStatus: prev?.status,
        previousLocalCount: prev?.localCount,
        previousPlatformCount: prev?.platformCount,
        previousMissing: prev?.missingInPlatform,
        previousExtra: prev?.extraInPlatform,
        createdAt: now,
        updatedAt: now,
        finishedAt: status === 'matched' || status === 'mismatched' ? now : undefined,
      };
      this.tasks.unshift(task);
      if (status === 'matched') hitList.status = 'effective';
      this.persist();
      return task;
    },
    /**
     * 重试对账：只核没完的，已核对项不重来。
     * 失败时仍保住上一份结果；对平 → 名单置 effective。
     */
    retryReconcile(
      taskId: string,
      platformBatch: { batchId: string; cohortVersion: string; users: string[]; complete: boolean },
    ) {
      const task = this.tasks.find((t) => t.id === taskId);
      if (!task) return null;
      const hitList = this.hitLists.find((h) => h.id === task.hitListId);
      if (!hitList) return null;
      const localSet = new Set(hitList.userIds);
      const platformSet = new Set(platformBatch.users);
      const missing = [...localSet].filter((id) => !platformSet.has(id));
      const extra = [...platformSet].filter((id) => !localSet.has(id));
      const total = new Set([...localSet, ...platformSet]).size;
      const alreadyChecked = task.checkedCount;
      let status: ReconcileStatus;
      let checkedCount = alreadyChecked;
      if (platformBatch.cohortVersion !== task.cohortVersion) {
        status = 'failed';
      } else if (!platformBatch.complete) {
        status = 'failed';
      } else {
        checkedCount = total;
        status = missing.length === 0 && extra.length === 0 ? 'matched' : 'mismatched';
      }
      task.platformBatchId = platformBatch.batchId;
      task.status = status;
      task.localCount = localSet.size;
      task.platformCount = platformSet.size;
      task.missingInPlatform = missing;
      task.extraInPlatform = extra;
      task.checkedCount = checkedCount;
      task.totalCount = total;
      task.updatedAt = new Date().toISOString();
      if (status === 'matched' || status === 'mismatched') task.finishedAt = new Date().toISOString();
      if (status === 'matched') hitList.status = 'effective';
      this.persist();
      return task;
    },
  },
});
