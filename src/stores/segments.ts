import { defineStore } from 'pinia';

export type Arrival = 'current' | 'late';
export type ListStatus = 'pending' | 'reconciled' | 'mismatch' | 'voided';
export type PlanStatus = 'blocked' | 'ready' | 'released' | 'superseded';

export interface SegmentDef { key: string; name: string; threshold: number; pool: string[]; }
export interface SegmentImport { id: string; segmentKey: string; version: number; dataTime: string; importedAt: string; users: string[]; arrival: Arrival; }
export interface HitDiff { onlyLocal: string[]; onlyPlatform: string[]; }
export interface HitList { id: string; segmentKey: string; version: number; importId: string; users: string[]; computedAt: string | null; status: ListStatus; diff: HitDiff | null; attempts: number; }
export interface ReleasePlan { id: string; segmentKey: string; version: number; rollout: number; status: PlanStatus; releasedAt: string | null; releasedListId: string | null; }
export interface ReconAudit { id: string; at: string; action: string; detail: string; }

interface State { segments: SegmentDef[]; imports: SegmentImport[]; hitLists: HitList[]; plans: ReleasePlan[]; audit: ReconAudit[]; activeKey: string; }

export function bucket(userId: string, segmentKey: string): number {
  const text = `${segmentKey}::${userId}`;
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 100;
}

export function localHits(segment: SegmentDef): string[] {
  return segment.pool.filter((id) => bucket(id, segment.key) < segment.threshold);
}

function diffOf(local: string[], platform: string[]): HitDiff {
  return {
    onlyLocal: local.filter((id) => !platform.includes(id)),
    onlyPlatform: platform.filter((id) => !local.includes(id))
  };
}

const now = () => new Date().toLocaleString();
let seq = 0;
const nextId = (prefix: string) => `${prefix}-${Date.now()}-${seq++}`;

function buildSeed(): State {
  const segments: SegmentDef[] = [
    { key: 'vip-shanghai', name: '上海高价值用户', threshold: 40, pool: Array.from({ length: 12 }, (_, i) => `u-${2001 + i}`) },
    { key: 'coupon-new', name: '新客券目标人群', threshold: 50, pool: Array.from({ length: 10 }, (_, i) => `u-${3001 + i}`) }
  ];
  const vipHits = localHits(segments[0]);
  const couponHits = localHits(segments[1]);
  const couponV2Platform = couponHits.slice(1);
  const imports: SegmentImport[] = [
    { id: 'imp-vip-2', segmentKey: 'vip-shanghai', version: 2, dataTime: '2026-10-04T08:00', importedAt: '2026-10-05 09:40', users: vipHits.slice(0, -1), arrival: 'late' },
    { id: 'imp-vip-3', segmentKey: 'vip-shanghai', version: 3, dataTime: '2026-10-05T08:00', importedAt: '2026-10-05 09:10', users: [...vipHits.slice(1), 'u-2099'], arrival: 'current' },
    { id: 'imp-coupon-1', segmentKey: 'coupon-new', version: 1, dataTime: '2026-10-04T06:00', importedAt: '2026-10-04 08:20', users: [...couponHits], arrival: 'current' },
    { id: 'imp-coupon-2', segmentKey: 'coupon-new', version: 2, dataTime: '2026-10-05T06:00', importedAt: '2026-10-05 08:30', users: couponV2Platform, arrival: 'current' }
  ];
  const hitLists: HitList[] = [
    { id: 'hl-vip-3', segmentKey: 'vip-shanghai', version: 3, importId: 'imp-vip-3', users: [], computedAt: null, status: 'pending', diff: null, attempts: 0 },
    { id: 'hl-coupon-1', segmentKey: 'coupon-new', version: 1, importId: 'imp-coupon-1', users: couponHits, computedAt: '2026-10-04 08:25', status: 'reconciled', diff: { onlyLocal: [], onlyPlatform: [] }, attempts: 1 },
    { id: 'hl-coupon-2', segmentKey: 'coupon-new', version: 2, importId: 'imp-coupon-2', users: couponHits, computedAt: '2026-10-05 08:35', status: 'mismatch', diff: diffOf(couponHits, couponV2Platform), attempts: 1 }
  ];
  const plans: ReleasePlan[] = [
    { id: 'rp-vip-3', segmentKey: 'vip-shanghai', version: 3, rollout: 20, status: 'blocked', releasedAt: null, releasedListId: null },
    { id: 'rp-coupon-1', segmentKey: 'coupon-new', version: 1, rollout: 50, status: 'released', releasedAt: '2026-10-04 09:00', releasedListId: 'hl-coupon-1' },
    { id: 'rp-coupon-2', segmentKey: 'coupon-new', version: 2, rollout: 50, status: 'blocked', releasedAt: null, releasedListId: null }
  ];
  const audit: ReconAudit[] = [
    { id: 'ra-5', at: '2026-10-05 09:40', action: '晚到旧版本', detail: 'vip-shanghai v2 晚于 v3 到达，仅留参考，不触发重算' },
    { id: 'ra-4', at: '2026-10-05 09:10', action: '导入分群', detail: 'vip-shanghai v3 数据时间 2026-10-04T08:00，未生效名单已作废，待重算' },
    { id: 'ra-3', at: '2026-10-05 08:35', action: '对账差异', detail: 'coupon-new v2 仅本地 1 人 / 仅平台 0 人，已保留 v1 对平结果' },
    { id: 'ra-2', at: '2026-10-04 09:00', action: '发布放量', detail: 'coupon-new v1 按对平名单放量 50%' },
    { id: 'ra-1', at: '2026-10-04 08:25', action: '对账平', detail: 'coupon-new v1 本地重算与平台回传一致' }
  ];
  return { segments, imports, hitLists, plans, audit, activeKey: 'vip-shanghai' };
}

function load(): State { const saved = localStorage.getItem('yf58-segment-state'); return saved ? JSON.parse(saved) as State : buildSeed(); }

export const useSegmentStore = defineStore('segments', {
  state: () => load(),
  getters: {
    activeSegment(state): SegmentDef | undefined { return state.segments.find((item) => item.key === state.activeKey); },
    latestVersion(state) { return (key: string): number => state.imports.filter((item) => item.segmentKey === key).reduce((max, item) => Math.max(max, item.version), 0); },
    importsOf(state) { return (key: string): SegmentImport[] => state.imports.filter((item) => item.segmentKey === key).sort((a, b) => b.version - a.version || b.importedAt.localeCompare(a.importedAt)); },
    listsOf(state) { return (key: string): HitList[] => state.hitLists.filter((item) => item.segmentKey === key).sort((a, b) => b.version - a.version); },
    plansOf(state) { return (key: string): ReleasePlan[] => state.plans.filter((item) => item.segmentKey === key).sort((a, b) => b.version - a.version); },
    currentList(state) { return (key: string): HitList | undefined => state.hitLists.filter((item) => item.segmentKey === key).sort((a, b) => b.version - a.version)[0]; },
    effectiveList(state) {
      return (key: string): HitList | undefined => {
        const released = state.plans
          .filter((item) => item.segmentKey === key && item.status === 'released' && item.releasedListId)
          .sort((a, b) => (b.releasedAt ?? '').localeCompare(a.releasedAt ?? ''))[0];
        if (released) return state.hitLists.find((item) => item.id === released.releasedListId);
        return state.hitLists.filter((item) => item.segmentKey === key && item.status === 'reconciled').sort((a, b) => b.version - a.version)[0];
      };
    }
  },
  actions: {
    persist() { localStorage.setItem('yf58-segment-state', JSON.stringify(this.$state)); },
    logAudit(action: string, detail: string) { this.audit.unshift({ id: nextId('ra'), at: now(), action, detail }); this.persist(); },
    select(key: string) { this.activeKey = key; this.persist(); },
    importSegment(input: { segmentKey: string; version: number; dataTime: string; users: string[] }): { created: boolean; arrival: Arrival } {
      const duplicated = this.imports.find((item) => item.segmentKey === input.segmentKey && item.version === input.version);
      if (duplicated) {
        this.logAudit('重复导入', `${input.segmentKey} v${input.version} 已存在，同版本不新增记录`);
        return { created: false, arrival: duplicated.arrival };
      }
      const latest = this.latestVersion(input.segmentKey);
      const arrival: Arrival = input.version < latest ? 'late' : 'current';
      const record: SegmentImport = { id: nextId('imp'), segmentKey: input.segmentKey, version: input.version, dataTime: input.dataTime, importedAt: now(), users: [...input.users], arrival };
      this.imports.push(record);
      if (arrival === 'late') {
        this.logAudit('晚到旧版本', `${input.segmentKey} v${input.version} 晚于 v${latest} 到达，仅留参考，不触发重算`);
        return { created: true, arrival };
      }
      let voided = 0;
      this.hitLists.forEach((item) => {
        if (item.segmentKey === input.segmentKey && (item.status === 'pending' || item.status === 'mismatch')) { item.status = 'voided'; voided++; }
      });
      this.plans.forEach((item) => {
        if (item.segmentKey === input.segmentKey && (item.status === 'blocked' || item.status === 'ready')) item.status = 'superseded';
      });
      this.hitLists.push({ id: nextId('hl'), segmentKey: input.segmentKey, version: input.version, importId: record.id, users: [], computedAt: null, status: 'pending', diff: null, attempts: 0 });
      const previous = this.plans.filter((item) => item.segmentKey === input.segmentKey).sort((a, b) => b.version - a.version)[0];
      this.plans.push({ id: nextId('rp'), segmentKey: input.segmentKey, version: input.version, rollout: previous?.rollout ?? 0, status: 'blocked', releasedAt: null, releasedListId: null });
      this.logAudit('导入分群', `${input.segmentKey} v${input.version} 数据时间 ${input.dataTime}，作废 ${voided} 份未生效名单，待重算`);
      return { created: true, arrival };
    },
    recompute(listId: string): HitList | null {
      const list = this.hitLists.find((item) => item.id === listId);
      if (!list || (list.status !== 'pending' && list.status !== 'mismatch')) return null;
      const segment = this.segments.find((item) => item.key === list.segmentKey);
      const record = this.imports.find((item) => item.id === list.importId);
      if (!segment || !record) return null;
      const users = localHits(segment);
      const diff = diffOf(users, record.users);
      list.users = users;
      list.diff = diff;
      list.computedAt = now();
      list.attempts++;
      const balanced = diff.onlyLocal.length === 0 && diff.onlyPlatform.length === 0;
      list.status = balanced ? 'reconciled' : 'mismatch';
      if (balanced) {
        const plan = this.plans.find((item) => item.segmentKey === list.segmentKey && item.version === list.version && item.status === 'blocked');
        if (plan) plan.status = 'ready';
        this.logAudit('对账平', `${list.segmentKey} v${list.version} 第 ${list.attempts} 次重算与平台回传一致`);
      } else {
        this.logAudit('对账差异', `${list.segmentKey} v${list.version} 仅本地 ${diff.onlyLocal.length} 人 / 仅平台 ${diff.onlyPlatform.length} 人，已保留上一份对平结果`);
      }
      return list;
    },
    retryPending(key: string): number {
      const targets = this.hitLists.filter((item) => item.segmentKey === key && (item.status === 'pending' || item.status === 'mismatch'));
      targets.forEach((item) => this.recompute(item.id));
      return targets.length;
    },
    setRollout(planId: string, value: number) {
      const plan = this.plans.find((item) => item.id === planId);
      if (!plan || plan.status === 'released' || plan.status === 'superseded') return;
      plan.rollout = value;
      this.persist();
    },
    release(planId: string): boolean {
      const plan = this.plans.find((item) => item.id === planId);
      if (!plan || plan.status !== 'ready') return false;
      const list = this.hitLists.find((item) => item.segmentKey === plan.segmentKey && item.version === plan.version && item.status === 'reconciled');
      if (!list) return false;
      plan.status = 'released';
      plan.releasedAt = now();
      plan.releasedListId = list.id;
      this.logAudit('发布放量', `${plan.segmentKey} v${plan.version} 按对平名单放量 ${plan.rollout}%`);
      return true;
    }
  }
});
