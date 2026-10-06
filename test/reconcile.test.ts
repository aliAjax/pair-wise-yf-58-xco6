import { createPinia, setActivePinia } from 'pinia';

// Node 环境 mock localStorage
const storeMap = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => storeMap.get(k) ?? null,
  setItem: (k: string, v: string) => storeMap.set(k, v),
  removeItem: (k: string) => storeMap.delete(k),
};

import { useReconcileStore } from '../src/stores/reconcile';
import { useFlagStore } from '../src/stores/flags';

setActivePinia(createPinia());

const store = useReconcileStore();
const flagStore = useFlagStore();

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}

// 清空 seed，构造干净环境
store.cohorts = [];
store.hitLists = [];
store.tasks = [];

const users = [
  { id: 'u1', region: '上海', appVersion: '8.3.0', authenticated: true },
  { id: 'u2', region: '上海', appVersion: '8.2.0', authenticated: true },
  { id: 'u3', region: '北京', appVersion: '8.3.0', authenticated: true },
  { id: 'u4', region: '上海', appVersion: '8.1.0', authenticated: false },
  { id: 'u5', region: '广东', appVersion: '8.3.0', authenticated: true },
];

console.log('== 1. 导入分群 ==');
const r1 = store.importCohort({ name: 'test', version: 'v1', dataAt: '2026-10-01T08:00', users });
check('首次导入成功', r1.duplicated === false);
check('版本为 active', r1.cohort.status === 'active');
check('用户数正确', r1.cohort.users.length === 5);

console.log('== 2. 同版本重复导入不新增 ==');
const r2 = store.importCohort({ name: 'test', version: 'v1', dataAt: '2026-10-01T09:00', users });
check('重复导入返回 duplicated', r2.duplicated === true);
check('记录数不增加', store.cohorts.length === 1);

console.log('== 3. 重算命中名单 ==');
// f1 规则：上海, >=8.2, authenticated；rollout 调到 80 让部分用户命中（测试 ID 哈希桶 66-70）
flagStore.flags[0].rollout = 80;
const list1 = store.recomputeHitList('f1');
check('生成名单', list1 !== null);
check('锁定版本 v1', list1!.cohortVersion === 'v1');
check('状态 draft', list1!.status === 'draft');
// u1: 上海,8.3.0,auth → bucket 105%100=5 < 10 → 命中
// u2: 上海,8.2.0,auth → bucket 104%100=4 < 10 → 命中
// u3: 北京 → 不命中
// u4: 未登录 → 不命中
// u5: 广东 → 不命中
check('命中 u1,u2', list1!.userIds.length === 2 && list1!.userIds.includes('u1') && list1!.userIds.includes('u2'));

console.log('== 4. 门禁：未对平不放量 ==');
const gate1 = store.releaseGate('f1');
check('未对账 → 拦截', gate1.allowed === false);

console.log('== 5. 对账：无差异对平 ==');
const task1 = store.startReconcile(list1!.id, { batchId: 'b1', cohortVersion: 'v1', users: [...list1!.userIds], complete: true });
check('对账状态 matched', task1!.status === 'matched');
check('名单置 effective', store.hitLists.find(h => h.id === list1!.id)!.status === 'effective');
const gate2 = store.releaseGate('f1');
check('对平 → 放行', gate2.allowed === true);

console.log('== 6. 新版本导入：旧版本降参考，未生效名单作废 ==');
// 先重算一个 draft
store.recomputeHitList('f1');
const draftBefore = store.hitLists.find(h => h.flagId === 'f1' && h.status === 'draft');
check('存在 draft 名单', !!draftBefore);
const r3 = store.importCohort({ name: 'test', version: 'v2', dataAt: '2026-10-02T08:00', users });
check('v2 生效', r3.cohort.status === 'active');
check('v1 降为参考', store.cohorts.find(c => c.version === 'v1')!.status === 'reference');
check('draft 名单已作废', store.hitLists.find(h => h.id === draftBefore!.id)!.status === 'void');

console.log('== 7. 晚到旧版本只留参考 ==');
const r4 = store.importCohort({ name: 'test', version: 'v1.5', dataAt: '2026-10-01T12:00', users });
check('v1.5 为参考', r4.cohort.status === 'reference');
check('当前生效仍是 v2', store.activeCohort!.version === 'v2');

console.log('== 8. 新版本重算 + 对账 ==');
const list2 = store.recomputeHitList('f1');
check('新名单锁定 v2', list2!.cohortVersion === 'v2');
const gate3 = store.releaseGate('f1');
check('新名单未对账 → 拦截', gate3.allowed === false);

console.log('== 9. 对账失败：保住上一份结果 ==');
// 先让 list2 对平
store.startReconcile(list2!.id, { batchId: 'b2', cohortVersion: 'v2', users: [...list2!.userIds], complete: true });
check('list2 对平 → effective', store.hitLists.find(h => h.id === list2!.id)!.status === 'effective');
// 重新算一个 draft（模拟规则变更）
const list3 = store.recomputeHitList('f1');
check('list3 为 draft', list3!.status === 'draft');
// 对账失败（版本不一致）
const taskFail = store.startReconcile(list3!.id, { batchId: 'b3', cohortVersion: 'v1', users: ['u1'], complete: true });
check('对账状态 failed', taskFail!.status === 'failed');
check('保住上一份 matched 结果', taskFail!.previousStatus === 'matched');
const gate4 = store.releaseGate('f1');
check('失败但沿用上一份 → 放行', gate4.allowed === true);

console.log('== 10. 重试只核未完项 ==');
// 制造一个不完整回传的失败任务
const list4 = store.recomputeHitList('f1');
const taskInc = store.startReconcile(list4!.id, { batchId: 'b4', cohortVersion: 'v2', users: ['u1'], complete: false });
check('不完整回传 → failed', taskInc!.status === 'failed');
check('checkedCount 为 0', taskInc!.checkedCount === 0);
// 重试：完整回传
const taskRetry = store.retryReconcile(taskInc!.id, { batchId: 'b5', cohortVersion: 'v2', users: [...list4!.userIds], complete: true });
check('重试后 matched', taskRetry!.status === 'matched');
check('checkedCount 变为 total', taskRetry!.checkedCount === taskRetry!.totalCount);

console.log('== 11. 差异用户单独列出 ==');
const list5 = store.recomputeHitList('f1');
// 平台回传：少 u1，多 u3
const platformUsers = list5!.userIds.filter(id => id !== 'u1').concat(['u3']);
const taskDiff = store.startReconcile(list5!.id, { batchId: 'b6', cohortVersion: 'v2', users: platformUsers, complete: true });
check('状态 mismatched', taskDiff!.status === 'mismatched');
check('本地有平台无 u1', taskDiff!.missingInPlatform.includes('u1'));
check('平台有本地无 u3', taskDiff!.extraInPlatform.includes('u3'));
const gate5 = store.releaseGate('f1');
check('差异未对平 → 拦截', gate5.allowed === false);

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
