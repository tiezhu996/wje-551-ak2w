<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { inventoryApi } from '../api/inventory';
import DataTable from '../components/common/DataTable.vue';
import StatusBadge from '../components/common/StatusBadge.vue';
import WarehouseSelector from '../components/common/WarehouseSelector.vue';
import { TransferStatus } from '../constants/enums';
import { PERMISSIONS } from '../constants/permissions';
import { useInventoryStore } from '../stores/inventoryStore';
import type { Inventory } from '../types/inventory';
import { formatDate } from '../utils/format';

const store = useInventoryStore();
const keyword = ref('');
onMounted(async () => { await store.fetchWarehouses(); await store.fetchInventory(); await store.fetchTransfers(); });
async function reload() { await Promise.all([store.fetchInventory({ keyword: keyword.value }), store.fetchTransfers()]); }
async function inbound(row: any) { await inventoryApi.inbound({ warehouseId: row.warehouseId, skuId: row.skuId, skuName: row.skuName, quantity: 10 }); await reload(); }
async function outbound(row: any) { await inventoryApi.outbound({ warehouseId: row.warehouseId, skuId: row.skuId, quantity: 5 }); await reload(); }

function notify(message: string) {
  window.dispatchEvent(new CustomEvent('app-error', { detail: message }));
}

// ---- 调拨单创建弹窗 ----
const transferVisible = ref(false);
const transferSourceId = ref('');
const transferTargetId = ref('');
const transferSkuId = ref('');
const transferQuantity = ref(1);
const submitting = ref(false);
const sourceInventories = ref<Inventory[]>([]);

const targetWarehouses = computed(() => store.warehouses.filter((item) => item.id !== transferSourceId.value));
const selectedSku = computed(() => sourceInventories.value.find((item) => item.skuId === transferSkuId.value));

async function openTransfer() {
  transferSourceId.value = store.currentWarehouseId;
  transferTargetId.value = store.warehouses.find((item) => item.id !== transferSourceId.value)?.id ?? '';
  transferSkuId.value = '';
  transferQuantity.value = 1;
  transferVisible.value = true;
  await loadSourceInventories();
}

async function loadSourceInventories() {
  sourceInventories.value = await inventoryApi.list({ warehouseId: transferSourceId.value }) as unknown as Inventory[];
  if (!sourceInventories.value.some((item) => item.skuId === transferSkuId.value)) transferSkuId.value = sourceInventories.value[0]?.skuId ?? '';
}

async function submitTransfer() {
  if (!transferTargetId.value) return notify('请选择目标仓库');
  if (!transferSkuId.value) return notify('源仓库暂无可用 SKU');
  const quantity = Number(transferQuantity.value);
  if (!Number.isInteger(quantity) || quantity <= 0) return notify('调拨数量必须为正整数');
  if (selectedSku.value && quantity > selectedSku.value.quantity) return notify(`源仓库存不足，当前可用 ${selectedSku.value.quantity}`);
  submitting.value = true;
  try {
    await inventoryApi.transfer({
      sourceWarehouseId: transferSourceId.value,
      targetWarehouseId: transferTargetId.value,
      skuId: transferSkuId.value,
      quantity,
    });
    transferVisible.value = false;
    await reload();
  } catch {
    // 错误提示已由请求拦截器统一弹出
  } finally {
    submitting.value = false;
  }
}

async function receiveTransfer(id: string) {
  try { await inventoryApi.receiveTransfer(id); await reload(); } catch { /* 拦截器已提示 */ }
}
async function cancelTransfer(id: string) {
  try { await inventoryApi.cancelTransfer(id); await reload(); } catch { /* 拦截器已提示 */ }
}
</script>

<template>
  <section>
    <div class="page-title">
      <h2>库存管理</h2>
      <div>
        <button v-permission="PERMISSIONS.INVENTORY_WRITE" class="btn secondary" @click="openTransfer">调拨</button>
        <button class="btn secondary">盘点</button>
      </div>
    </div>
    <div class="toolbar">
      <WarehouseSelector v-model="store.currentWarehouseId" @change="reload" />
      <input v-model="keyword" placeholder="SKU 搜索" @input="reload" />
    </div>
    <DataTable :columns="[{key:'skuId',title:'SKU 编码'},{key:'skuName',title:'SKU 名称'},{key:'quantity',title:'当前数量'},{key:'safetyStock',title:'安全库存'},{key:'alertLevel',title:'预警级别'},{key:'updatedAt',title:'最后更新时间'}]" :data="store.inventories as any">
      <template #alertLevel="{ row }"><StatusBadge :value="row.alertLevel" /></template>
      <template #updatedAt="{ row }">{{ formatDate(row.updatedAt) }}</template>
      <template #actions="{ row }">
        <button v-permission="PERMISSIONS.INVENTORY_WRITE" class="mini" @click="inbound(row)">入库+10</button>
        <button v-permission="PERMISSIONS.INVENTORY_WRITE" class="mini" @click="outbound(row)">出库-5</button>
      </template>
    </DataTable>

    <h3 class="records-title">调拨记录（仓库间待接收单）</h3>
    <DataTable :columns="[{key:'sourceWarehouseName',title:'源仓库'},{key:'targetWarehouseName',title:'目标仓库'},{key:'skuId',title:'SKU 编码'},{key:'skuName',title:'SKU 名称'},{key:'quantity',title:'数量'},{key:'status',title:'状态'},{key:'createdAt',title:'创建时间'}]" :data="store.transfers as any">
      <template #status="{ row }"><StatusBadge :value="row.status" /></template>
      <template #createdAt="{ row }">{{ formatDate(row.createdAt) }}</template>
      <template #actions="{ row }">
        <template v-if="row.status === TransferStatus.PENDING_RECEIPT">
          <button v-permission="PERMISSIONS.INVENTORY_WRITE" class="mini receive" @click="receiveTransfer(row.id)">目标仓接收</button>
          <button v-permission="PERMISSIONS.INVENTORY_WRITE" class="mini cancel" @click="cancelTransfer(row.id)">源仓撤销</button>
        </template>
      </template>
    </DataTable>

    <div v-if="transferVisible" class="modal-mask" @click.self="transferVisible = false">
      <div class="modal">
        <h3>创建调拨单</h3>
        <p class="hint">提交后立即从源仓扣减库存并进入在途，目标仓确认接收后才增加库存；接收前源仓可撤销。</p>
        <label>
          源仓库
          <select v-model="transferSourceId" @change="loadSourceInventories">
            <option v-for="warehouse in store.warehouses" :key="warehouse.id" :value="warehouse.id">{{ warehouse.name }}</option>
          </select>
        </label>
        <label>
          目标仓库
          <select v-model="transferTargetId">
            <option v-for="warehouse in targetWarehouses" :key="warehouse.id" :value="warehouse.id">{{ warehouse.name }}</option>
          </select>
        </label>
        <label>
          SKU
          <select v-model="transferSkuId">
            <option v-for="item in sourceInventories" :key="item.skuId" :value="item.skuId">{{ item.skuId }}（{{ item.skuName }}，可用 {{ item.quantity }}）</option>
          </select>
        </label>
        <label>
          调拨数量
          <input v-model.number="transferQuantity" type="number" min="1" :max="selectedSku?.quantity" />
        </label>
        <div class="modal-actions">
          <button class="btn secondary" @click="transferVisible = false">取消</button>
          <button class="btn" :disabled="submitting" @click="submitTransfer">{{ submitting ? '提交中...' : '提交调拨' }}</button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.mini { margin-right:6px; border:0; border-radius:5px; padding:5px 8px; background:#e1e8d0; cursor:pointer; }
.mini.receive { background:#cfe6d6; color:#17613a; font-weight:700; }
.mini.cancel { background:#f0ded8; color:#8a3d28; }
.records-title { margin:26px 0 12px; font-size:18px; }
.modal-mask { position:fixed; inset:0; background:rgba(23,36,31,.45); display:flex; align-items:center; justify-content:center; z-index:20; }
.modal { width:420px; background:#fbfcf7; border:1px solid #dbe1e6; border-radius:10px; padding:22px; display:grid; gap:14px; }
.modal h3 { margin:0; }
.modal .hint { margin:0; font-size:12px; color:#657068; line-height:1.6; }
.modal label { display:grid; gap:6px; font-size:13px; font-weight:700; color:#44524b; }
.modal-actions { display:flex; justify-content:flex-end; gap:10px; margin-top:4px; }
.btn:disabled { opacity:.6; cursor:not-allowed; }
</style>
